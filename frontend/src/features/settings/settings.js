// #30 — Settings (it began as the own-Anthropic-key modal, removed in task
// 2275) — and, since the settings-modal-to-screen conversion, the whole
// #settings SCREEN.
//
// The Settings row in the header drawer is a real anchor to #settings;
// App.restoreFromHash → App.navigateToSettings mounts #settings-screen and
// hands rendering to this module, the same shape as the Challenges /
// Profile / Admin console screens. Users can paste an `sk-ant-...` key; the
// server verifies it with a cheap 1-token call and only then encrypts
// + stores it. Once saved, a small emerald dot appears on the drawer's
// Settings row so the user can tell at a glance that their key is
// active — and so can any other user viewing over their shoulder
// (no secrets leak, just the indicator).
//
// LAYOUT (mirrors features/admin/admin-console.js — read that file's header for
// the reasoning, this is the same shell with different data):
//
//   desktop (md+)          a grouped sidebar of sections + the active
//                          section beside it, switched in place;
//   level 1 (#settings)    below md, the grouped section menu, one tappable
//                          row per section under the same headings;
//   level 2 (#settings/<k>) that one section, full width, with the platform
//                          header's back button flipped to an arrow and its
//                          title set to the section label.
//
// The hash is the single source of truth for WHICH section shows; the level
// is derived from it (bare #settings on mobile = the menu). A menu tap is a
// REAL hash navigation, so it pushes a history entry and the device /
// WebView back gesture pops back to the menu through exactly the same code
// path as the on-screen arrow (see _openSection / handleBack / route).
//
// MOVE, DON'T REWRITE: the section markup is STATIC in index.html and every
// control is bound by id exactly once in init(). The router only toggles
// `hidden` on the [data-settings-section] WRAPPERS — it never rebuilds a
// section, because that would silently detach every listener. Each
// section's own `hidden` (the wallet / usernode / admin-preview capability
// gates) keeps living on the INNER node, which is also how _visibleSections
// derives menu membership without duplicating those gates.
(function () {
  'use strict';

  // Interface text is read from the language catalogs (frontend/locales/en,
  // namespace `settings`) through the global the language runtime publishes:
  // this file is import-free. Always at render time, never at load.
  const tr = (id, values) => PlatformI18n.t(id, values);

  // Short independent facts on one line ("Free · New · verified"). Each part
  // is a whole message; what joins two of them is a message too
  // (settings:list.dot), so a language can use its own separator.
  const dotText = (parts) => {
    const said = parts.filter((part) => typeof part === 'string' && part !== '');
    return said.length ? said.reduce((first, second) => tr('settings:list.dot', { first, second })) : '';
  };

  // ── Status lines ──────────────────────────────────────────────────────
  //
  // Seven sections report the result of the user's last action in a status
  // line, and all seven paint it identically: reveal the node, write the
  // text, swap in one of three colour pairs. This is that paint, and the
  // palette below is the only place those classes are named.
  //
  // The pairs are TOKEN ARRAYS and they are SPREAD into classList, because a
  // DOMTokenList token may not contain whitespace: `classList.add('a b')`
  // throws InvalidCharacterError. Each of these was a SINGLE class when it
  // was written (#1380); #1400's widget-library migration rewrote all seven
  // into `dark:` pairs and left the single-argument `add(cls)` in place, so
  // every status write in this file threw. It read as cosmetic because the
  // text is written FIRST and still landed — what actually broke was the
  // code AFTER the call. changeUsername() is the case that was reported: it
  // painted "Saving…", threw before its fetch was ever issued, and left the
  // button disabled under a message that could never resolve. Keep these
  // arrays, and add a colour by adding a pair here rather than a string at a
  // call site. _wireConnectorNameSpelling's link-status write already spread
  // its pair, which is why that one line kept working.
  const STATUS_PALETTE = {
    error: ['text-red-700', 'dark:text-red-400'],
    ok: ['text-emerald-700', 'dark:text-emerald-400'],
    info: ['text-zinc-500', 'dark:text-zinc-400'],
  };
  const STATUS_PALETTE_CLASSES = [
    'hidden',
    ...STATUS_PALETTE.error, ...STATUS_PALETTE.ok, ...STATUS_PALETTE.info,
  ];

  /** Reveal `el`, write `text`, colour it for `kind` (anything else: info). */
  function paintStatus(el, text, kind) {
    el.textContent = text;
    el.classList.remove(...STATUS_PALETTE_CLASSES);
    el.classList.add(...(STATUS_PALETTE[kind] || STATUS_PALETTE.info));
  }

  // #2119: an OpenRouter key's allowance is named from the reset cadence the
  // server reports for it ('weekly' for company keys carrying the platform
  // allowance, 'daily' for older ones until they are re-limited, whatever
  // OpenRouter says for a personal key, which may be nothing), never from a
  // hard-coded word, so the copy stays truthful for every key it describes.
  //
  // Each sentence that names the allowance has one whole message per cadence
  // OpenRouter is known to report, one for a key with no cadence, and one that
  // carries any other cadence word as the server wrote it. This answers which.
  function limitCadence(reset) {
    const cadence = typeof reset === 'string' ? reset.trim().toLowerCase() : '';
    if (!cadence) return { key: 'none', cadence };
    return { key: ['daily', 'weekly', 'monthly'].includes(cadence) ? cadence : 'other', cadence };
  }

  // ── Post-logout landing (#1524) ───────────────────────────────────────
  //
  // Signing out always ends on the PUBLIC LANDING page, on every surface.
  // `/` with no fragment is the only address that boots the anonymous shell
  // there: App.restoreFromHash treats any other hash (or any `/app/<slug>`
  // path) as a remembered deep link and answers with the bare sign-in form.
  // A bare '/' rather than App._rootUrl() so a leftover `?shot=` / `?signup=`
  // query cannot survive the sign-out either.
  const LANDING_URL = '/';

  // #5281: the Account page's sign-in rows (Username, Email & recovery,
  // Password) each open their own form, one at a time. Username and Password
  // are this module's; Email is React's (sections/email.tsx), so the two
  // owners keep each other closed through this one window event, whose
  // detail is `{ part }`: the part now open, or null for none.
  const ACCOUNT_EDITOR_EVENT = 'usernode:settings-account-editor';
  // Each part's form, its row's Change button, and the field a fresh open
  // puts the cursor in.
  const ACCOUNT_EDITORS = {
    username: { form: 'cu-form', button: 'cu-edit', focus: 'cu-new' },
    password: { form: 'cp-form', button: 'cp-edit', focus: null },
  };

  // A native sign-out whose terminal step fails leaves this document alive
  // with server authority already revoked, so it navigates to the landing
  // page like every other surface. The advisory that used to be toasted here
  // would be destroyed by that navigation, so it is handed to the anonymous
  // boot instead: App.enterAnonymous reads this key once and toasts it.
  const LOGOUT_NOTICE_KEY = 'sv:logout_notice';
  const NATIVE_SHUTDOWN_NOTICE = 'settings:signOut.nativeShutdownNotice';

  // A successful native logout replaces the WebView, so nothing below it in
  // this document normally runs. This bounded net covers the case where the
  // replacement does not arrive: rather than leave a signed-out user looking
  // at the Settings screen forever, land them on the landing page.
  const NATIVE_LOGOUT_SAFETY_MS = 5000;

  // #3915: the net above was armed only once native ANSWERED, so a phone
  // whose app never answered (or answered late) sat on an unchanged Settings
  // screen until the bridge gave up twelve seconds later, and on iOS a person
  // force-quit it first. Once the SERVER has revoked the session this second
  // net is armed the moment the native call is issued, so the page leaves
  // within this bound whatever the app does. It is safe to leave early:
  //
  //   - Nothing can sign back in. /api/auth/logout deleted the web session
  //     and, in the same transaction, revoked the native credential tied to
  //     it (src/routes/auth.js), and its response cleared the cookie.
  //   - Native cleanup does not need this document once it has started: the
  //     app holds its lifecycle queue until it has deleted the WebView's
  //     cookies, storage and cache, then replaces the WebView itself, so a
  //     landing page that arrived first is simply replaced again.
  //   - Native gets a fair chance first. Its whole teardown normally takes a
  //     second or two; eight is several times that. If the app has not even
  //     admitted the call by then, its credential is already revoked server
  //     side, and the app retires it the first time the server refuses it.
  //
  // The offline path (remote revocation FAILED) never arms it: there only
  // native can delete the live cookie, so leaving before native confirms
  // would boot the signed-in shell again.
  const NATIVE_LOGOUT_ISSUED_SAFETY_MS = 8000;

  // What the button says, at rest (the markup's own words, restored after a
  // failure) and while a sign-out is running (#3915). Message ids, read when
  // the button is painted.
  const SIGN_OUT_LABEL = 'settings:screen.signOut';
  const SIGNING_OUT_LABEL = 'settings:signOut.signingOut';

  // How long the sign-out POST may take before it is abandoned. Two budgets,
  // because the two paths fail differently (#2078):
  //
  //   - A capable phone (protocol 2 + `offlineLogout`) has native deleting the
  //     cookie and the durable credential locally, so remote revocation is
  //     best effort. Giving up after two seconds still ends in a real
  //     sign-out, and waiting longer only holds a person on a screen whose
  //     work is already done.
  //   - The ordinary WEB path has no such guarantee: only the server can
  //     revoke a web session, so abandoning the request means the sign-out did
  //     NOT happen and the user is told so. The budget is therefore generous —
  //     far longer than any working round trip, including a slow phone
  //     network — and exists only to stop a request that will never settle
  //     from holding the disabled button forever.
  const OFFLINE_LOGOUT_TIMEOUT_MS = 2000;
  const WEB_LOGOUT_TIMEOUT_MS = 15000;

  // #6479: formatter options in the zone picked in Settings › Language, or
  // unchanged (the device's zone) under Auto or where the runtime predates it.
  // A function rather than an import: this file also runs as a classic script.
  const inZone = (options = {}) => {
    const timeZone = typeof window !== 'undefined' && window.PlatformI18n?.timeZone
      ? window.PlatformI18n.timeZone() : undefined;
    return timeZone ? { ...options, timeZone } : options;
  };

  // ONE WAY TO WRITE AN INSTANT on these pages (phone review #126, 23 Nov
  // 2026): "Nov 23, 2026, 2:04 PM", the date as Linked devices writes it and
  // the time to the minute. A bare `toLocaleString()` wrote
  // "11/23/2026, 2:04:26 PM", seconds and all, beside "Nov 23, 2026".
  const STAMP = { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  const stamp = (value) => new Date(value).toLocaleString(undefined, inZone(STAMP));

  const Settings = {
    // Planted by ./mount.ts, never imported: this file is a classic IIFE that
    // tests/settings-mobile-push.test.js evaluates with vm.runInContext, where
    // an import statement is a syntax error. `_store` is ./settings-nav-store.js
    // (the two nav hosts' descriptors) and `_footerHome` is the placeholder
    // seam #settings-footer leaves behind when _syncFooter moves it. Both stay
    // null in the vm harnesses and during the SSG prerender pass, and every
    // use below goes through `?.` for exactly that reason.
    _store: null,
    _footerHome: null,
    state: { usernodePubkey: null, walletLinkEnabled: false, locale: null, timeZone: null },
    _walletPollTimer: null,
    _alertsTestTimer: null,
    _walletExpiresAt: null,
    _walletCountdownTimer: null,
    _cliTokens: [],
    _cliTokenCursor: null,
    _cliTokensLoading: false,
    _cliTokenLoadId: 0,
    _connectors: [],
    _connectorLoadId: 0,
    _connectorSteps: null,
    _githubLink: null,
    _mobilePushPreferences: null,
    _mobilePushLoading: false,
    _mobilePushSaving: false,
    _mobilePushLoadToken: 0,

    // ── Screen state ─────────────────────────────────────────────────────
    _open: false,
    // #5995: counts behind the menu's rows, reported by the pages' own loads.
    _navStatus: {},
    _navStatusPaint: false,
    // #5997: the pages this viewer pinned to the top of the menu, in their
    // order, and the groups they folded. Read from this device's storage on
    // each open() (_loadNavPrefs); empty until then, so the prerender and a
    // first paint without storage show the menu as it always was.
    _navPrefs: { pinned: [], folded: [] },
    // Which PAGE is showing (or would show on a viewport crossing) — a page
    // key, never a part key (see SECTIONS). It doubles as "last visited in
    // this tab": open() keeps it when it is still a visible page, so
    // returning to Settings lands where you left off.
    //
    // THAT IS WHY THE INITIAL VALUE MATTERS. It was 'api-key', hard-coded
    // here before DEFAULT_SECTION existed, and a bare #settings on a fresh
    // tab therefore resolved to it whatever the registry said — so THE UI
    // OVERHAUL putting Theme first had no effect at all until this moved too.
    // Kept as a literal because DEFAULT_SECTION is declared further down this
    // same object literal; the two are pinned together by
    // tests/settings-screen.test.js.
    _section: 'account',
    // The PART a deep link named, when it is not the first part of its page
    // (#settings/password opens Account and scrolls to Password). Null when
    // the page itself was asked for. Spent by _scrollToAnchor().
    _anchor: null,
    // Counts open() calls, so the nav's filter box can start each visit
    // empty instead of greeting a returning viewer with last week's query.
    _visit: 0,
    // Which level the phone layout is showing: 1 = the section menu,
    // 2 = one section. Kept in sync on desktop too (it is ignored there)
    // so a viewport crossing resolves without guessing.
    _level: 1,
    // True while the level-2 entry we're sitting on was PUSHED by a menu
    // tap during this mount — the only case where history.back() is
    // guaranteed to land on our own menu entry. A deep link (bookmark, a
    // prose "Settings → Change password" link) leaves it false, and back
    // replaces the entry instead of creating a forward one. Per-mount
    // state: open() resets it.
    _pushedFromMenu: false,
    // #settings-screen scrollTop saved on drill-in, restored on the way back.
    _menuScrollTop: 0,
    // A deep-linked section that is registered but not offered YET (#2893):
    // its gate resolves after the route did — the Homeroom app one waits on
    // the native bridge. _renderNavIfOpen spends it once the gate opens,
    // provided the address still names it. open() and close() drop it.
    _pendingSection: null,
    _mediaBound: false,
    _socialPushStateListener: null,
    // True between an open({ chrome: false }) and the syncChrome() that
    // app.js runs inside the screen transition (#979) — _syncChrome is a
    // no-op while it is set, so nothing writes the platform header before
    // the outgoing page has been captured.
    _chromeSuspended: false,

    // The single source of truth in JS for where the sidebar layout starts.
    // Must stay in step with the `lg:` classes in index.html's
    // #settings-screen markup (Tailwind's lg breakpoint IS 1024px) — same
    // discipline as AdminConsole.DESKTOP_MEDIA.
    //
    // 1024, not the shell's 768 (overnight audit W01, 1 Nov 2026): from 768
    // the app's own 212px rail is open too, so at 800 the section list and
    // the pane shared ~560px and the pane was ~260px wide, cutting your own
    // name to "A." and "@.". Below 1024 Settings is the phone's two levels,
    // the list and then the page, each with the column to itself.
    DESKTOP_MEDIA: '(min-width: 1024px)',

    // ── Parts and pages ───────────────────────────────────────────────────
    //
    // Each entry below is a PART: one [data-settings-section] wrapper in
    // ./sections, and the #settings/<key> address that has always reached it.
    // Parts that share a `page` are shown together as ONE row of the nav and
    // one screen of content; a part without `page` is a page of its own,
    // keyed by its own key. Page labels live in PAGES; a one-part page uses
    // its part's label.
    //
    // The settings restructure folded twenty-three rows (seven of them behind
    // a collapsed "Advanced" group, #1554) into a dozen pages a viewer can
    // read without opening anything. Every old address still works: a part
    // key resolves to its page and scrolls to that part (_resolve,
    // _scrollToAnchor), so the out-of-credits card's #settings/cli, the
    // profile editor's #settings/username and every server-written link keep
    // landing on the thing they named.
    //
    // Order here IS menu order and DOM order (./sections/index.tsx renders
    // the wrappers in this sequence, so a page's parts stack the way they are
    // listed). The parts of one page must be contiguous. The group of a page
    // is its first part's group, and the first VISIBLE page is the default.
    //
    // `gate` names the INNER node whose own `hidden` decides whether the part
    // is offered at all — Homeroom Wallet (wallet linking enabled), Language
    // (a saved locale), Homeroom app (the native bridge) and Admin preview (a
    // real platform admin). Those gates live in their _render* methods and
    // are read here, never duplicated. A page is offered while any of its
    // parts is. A gated part that is a page of its own hides exactly one row;
    // one that shares a page (Admin preview, on Developer) hides only its
    // own block, and its address opens that page either way.
    SECTIONS: [
      // ── Account ─────────────────────────────────────────────────────────
      // Who you are and how you sign in, on one page, with Delete account at
      // its foot, apart from everything harmless above it (GitHub's and
      // Apple's placement: easy to find, never next to a routine control).
      { key: 'profile', label: 'settings:nav.part.profile', group: 'settings:nav.group.account', page: 'account' },
      { key: 'username', label: 'settings:nav.part.username', group: 'settings:nav.group.account', page: 'account' },
      { key: 'email', label: 'settings:nav.part.email', group: 'settings:nav.group.account', page: 'account' },
      { key: 'password', label: 'settings:nav.part.password', group: 'settings:nav.group.account', page: 'account' },
      { key: 'delete-account', label: 'settings:nav.part.deleteAccount', group: 'settings:nav.group.account', page: 'account' },
      // GitHub and X, which decide the daily credits and can be shown on the
      // public page. They shared a pane with the chat connectors, which have
      // nothing to do with identity.
      { key: 'linked-accounts', label: 'settings:nav.part.linkedAccounts', group: 'settings:nav.group.account' },
      // #5104: who can message or invite you, and who can find you. Both are
      // about other people reaching your account, so they sit with it. A
      // stateful pane; settings.js binds nothing inside it.
      { key: 'contact-privacy', label: 'settings:nav.part.contactPrivacy', group: 'settings:nav.group.account' },
      // #4938: the phones signed in with the Homeroom app, and Unlink for
      // each; #5974 adds the browsers signed in on the web, with Sign out,
      // under the name Linked devices (the key stays `phones`). Also about
      // who can use your account, so it sits with Privacy. A stateful pane;
      // settings.js binds nothing inside it.
      { key: 'phones', label: 'settings:nav.part.phones', group: 'settings:nav.group.account' },
      { key: 'wallet', label: 'settings:nav.part.wallet', group: 'settings:nav.group.account', gate: 'wallet-section' },

      // ── AI models & usage ───────────────────────────────────────────────
      // #5994 split the old "AI & building" group, which mixed the allowance
      // and the connectors, into this group and the next: each row is faster
      // to find under a heading that says what it is about.
      // The allowance leads: it is the figure most builders open Settings to
      // find. OpenRouter follows it: the included key voice input uses, or a
      // key of your own. The Anthropic key part that came last went in task
      // 2275 (PART_ALIASES sends its old deep link here).
      { key: 'usage', label: 'settings:nav.part.usage', group: 'settings:nav.group.aiModels', page: 'ai' },
      { key: 'openrouter', label: 'settings:nav.part.openrouter', group: 'settings:nav.group.aiModels', page: 'ai' },

      // ── Integrations & automation ───────────────────────────────────────
      // Everything about building from outside Homeroom: the chat connectors
      // (Claude, ChatGPT, Codex) and the CLI credentials. The out-of-credits
      // card deep-links #settings/connectors and #settings/cli; both land on
      // the Connectors & CLI page (public/js/credit-options.js). Connectors leads
      // because the page is keyed by it: a page key that named a LATER part
      // would open the page scrolled past everything above that part.
      { key: 'connectors', label: 'settings:nav.part.connectors', group: 'settings:nav.group.integrations', page: 'connectors' },
      { key: 'cli', label: 'settings:nav.part.cli', group: 'settings:nav.group.integrations', page: 'connectors' },

      // ── Preferences ─────────────────────────────────────────────────────
      // THE UI OVERHAUL moved Theme here out of the hamburger drawer.
      // Appearance is how the shell looks: the theme and, on a desktop, the
      // sidebar beside a running app (both in sections/theme.tsx). #5285
      // took the developer console's switch and the admin preview off it:
      // they are tools for people building and running Homeroom, and next to
      // the theme they read as part of choosing a look. They are the
      // Developer page now, at the end of this group.
      { key: 'theme', label: 'settings:nav.part.theme', group: 'settings:nav.group.preferences', page: 'theme' },
      // #3969: text size and high contrast — the other controls about how
      // the shell reads on this device. Their own page of one part, right
      // after Appearance, so they are visible without opening Appearance
      // first. A stateful pane; settings.js binds nothing inside it (see
      // sections/accessibility.tsx).
      { key: 'accessibility', label: 'settings:nav.part.accessibility', group: 'settings:nav.group.preferences' },
      // Offered to everyone: Auto and the languages Homeroom ships
      // (sections/language.tsx). #1556 had gated it on an already-saved
      // locale while the row could not say what it did.
      { key: 'language', label: 'settings:nav.part.language', group: 'settings:nav.group.preferences' },
      { key: 'alerts', label: 'settings:nav.part.alerts', group: 'settings:nav.group.preferences' },
      // What each app may do: the device access and AI spending you granted,
      // and the apps you blocked. They were split between Preferences and the
      // collapsed Advanced group, which hid two privacy controls from the
      // people they protect.
      { key: 'app-permissions', label: 'settings:nav.part.appPermissions', group: 'settings:nav.group.preferences', page: 'app-permissions' },
      { key: 'app-ai', label: 'settings:nav.part.appAi', group: 'settings:nav.group.preferences', page: 'app-permissions' },
      { key: 'blocked-apps', label: 'settings:nav.part.blockedApps', group: 'settings:nav.group.preferences', page: 'app-permissions' },
      // #5285: the developer tools, off Appearance. The console switch is
      // offered to everyone, so the page always has a row; Admin preview is
      // gated to real admins, and for everyone else its wrapper is empty and
      // the page is the console switch alone. It is never the page's first
      // part, so the page's address and title never depend on the gate. It
      // had a group of its own once, which put an "Admin" heading directly
      // above the footer's own Admin block; it stays in Preferences.
      { key: 'dev-console', label: 'settings:nav.part.devConsole', group: 'settings:nav.group.preferences', page: 'developer' },
      { key: 'admin-preview', label: 'settings:nav.part.adminPreview', group: 'settings:nav.group.preferences', page: 'developer', gate: 'settings-admin-section' },

      // ── Help & about ────────────────────────────────────────────────────
      // Panes you come to read or replay rather than configure. The welcome
      // tour's own Skip promises its row exists (#2255). About is last among
      // them — the Improve panel is where the same facts turn into something
      // to act on (a build in flight, a reload waiting). See sections/about.tsx.
      { key: 'tour', label: 'settings:nav.part.tour', group: 'settings:nav.group.helpAbout' },
      { key: 'usernode', label: 'settings:nav.part.usernode', group: 'settings:nav.group.helpAbout', gate: 'settings-usernode-section' },
      { key: 'about', label: 'settings:nav.part.about', group: 'settings:nav.group.helpAbout' },

      // ── Advanced ────────────────────────────────────────────────────────
      // #5994: the features you switch on to try, at the foot of the menu
      // rather than among the AI rows. Experimental is the page of switches.
      // Unlike #1554's "Advanced", this group is never collapsed for you
      // (see tests/settings-screen.test.js, "a group folds only when the
      // person folds it"): it starts open like the four above it, and folds
      // only if the viewer folds it (#5997).
      { key: 'experimental', label: 'settings:nav.part.experimental', group: 'settings:nav.group.advanced' },
    ],

    // The label of each page that holds more than one part. A page of one
    // part is labelled by that part; the label here is also the title the
    // phone's header shows inside the page.
    PAGES: {
      account: 'settings:nav.page.account',
      ai: 'settings:nav.page.ai',
      connectors: 'settings:nav.page.connectors',
      theme: 'settings:nav.page.theme',
      'app-permissions': 'settings:nav.page.appPermissions',
      developer: 'settings:nav.page.developer',
    },

    // #5995: one muted line under the phone menu's rows whose names do not
    // say what is behind them, keyed by page. Only the few that need it: a
    // line under every row would make each one a heading again. The sidebar
    // shows none; the page it opens says the same thing at its top.
    SUBTITLES: {
      'linked-accounts': 'settings:nav.subtitle.linkedAccounts',
      phones: 'settings:nav.subtitle.phones',
      connectors: 'settings:nav.subtitle.connectors',
    },

    // #5995: a small grey "Beta" label on the rows of features still being
    // tried, keyed by page. Words, not a colour: at most one per row.
    TAGS: {
      experimental: 'settings:nav.tag.beta',
    },

    // #5997: the small glyph before each page's name in both menus, keyed by
    // page. A NAME, not markup: ./settings-nav.tsx maps it to a glyph of
    // @/components/ui/icons (NAV_ICONS), so this file stays plain JS. A page
    // without an entry draws no glyph.
    ICONS: {
      account: 'user',
      'linked-accounts': 'link',
      'contact-privacy': 'shield',
      phones: 'phone',
      wallet: 'wallet',
      ai: 'sparkles',
      connectors: 'terminal',
      theme: 'sun',
      accessibility: 'eye',
      language: 'globe',
      alerts: 'bell',
      'app-permissions': 'lock',
      developer: 'code',
      tour: 'compass',
      usernode: 'window',
      about: 'info',
      experimental: 'bulb',
    },

    // #5997: where this device remembers the menu's pins and folds, each a
    // comma list of keys (page keys in pinned order; group keys, the catalog
    // id's last segment). Per device, like Messages' search
    // (usernode:messages-query): a convenience, not an account setting.
    PINNED_KEY: 'usernode:settings-pinned',
    // #6136: the setup steps a person has ticked, on this device, by account:
    // { "<user id>": { "chatgpt": [1, 2] } }. A convenience, like the two keys
    // here: Homeroom cannot see what happens inside another product.
    CONNECTOR_STEPS_KEY: 'usernode:connector-steps',
    // The longest name a connection can be given: the server's cap (#6137).
    CONNECTOR_LABEL_MAX: 60,
    FOLDED_KEY: 'usernode:settings-folded',

    // #5995: how much is set up behind a row, said in words at its trailing
    // edge ("2 linked"), keyed by page: [message, the counts summed]. The
    // counts come from the lists the pages already load when Settings opens
    // (_setNavStatus); a count never reported, or a zero, shows nothing.
    // Connectors & CLI counts the connected chat apps alone: that list's live
    // rows are active grants, while the CLI list is paged credential history
    // (revoked and expired rows included), so it cannot give a whole count.
    STATUS: {
      'linked-accounts': ['settings:nav.status.linked', ['socialIdentities']],
      phones: ['settings:nav.status.linked', ['phones']],
      connectors: ['settings:nav.status.connected', ['connectors']],
    },

    // Extra words the nav's filter box matches for each part, beyond its own
    // label and its page's. Lower case, space separated: the words people
    // type for a thing, not the words the pane uses for it.
    KEYWORDS: {
      profile: 'settings:nav.keywords.profile',
      username: 'settings:nav.keywords.username',
      email: 'settings:nav.keywords.email',
      password: 'settings:nav.keywords.password',
      'delete-account': 'settings:nav.keywords.deleteAccount',
      'linked-accounts': 'settings:nav.keywords.linkedAccounts',
      'contact-privacy': 'settings:nav.keywords.contactPrivacy',
      phones: 'settings:nav.keywords.phones',
      wallet: 'settings:nav.keywords.wallet',
      usage: 'settings:nav.keywords.usage',
      openrouter: 'settings:nav.keywords.openrouter',
      connectors: 'settings:nav.keywords.connectors',
      cli: 'settings:nav.keywords.cli',
      experimental: 'settings:nav.keywords.experimental',
      theme: 'settings:nav.keywords.theme',
      'dev-console': 'settings:nav.keywords.devConsole',
      accessibility: 'settings:nav.keywords.accessibility',
      language: 'settings:nav.keywords.language',
      alerts: 'settings:nav.keywords.alerts',
      'app-permissions': 'settings:nav.keywords.appPermissions',
      'app-ai': 'settings:nav.keywords.appAi',
      'blocked-apps': 'settings:nav.keywords.blockedApps',
      tour: 'settings:nav.keywords.tour',
      usernode: 'settings:nav.keywords.usernode',
      about: 'settings:nav.keywords.about',
      'admin-preview': 'settings:nav.keywords.adminPreview',
    },

    // Addresses of parts that are gone, and the page or part each opens
    // now. #settings/api-key was the Anthropic key part (task 2275 removed
    // it); links to it still exist in old messages and mail, so it opens the
    // AI usage & models page instead of falling back to the first page.
    PART_ALIASES: Object.freeze({ 'api-key': 'ai', guide: 'tour' }),

    DEFAULT_SECTION: 'account',

    init() {
      // The entry point is the drawer's Settings row, a real anchor to
      // #settings — restoreFromHash → App.navigateToSettings → open().
      // Every control below is bound ONCE, here, by id: the section markup
      // is static in index.html and only ever hidden/shown, never rebuilt
      // (see the "MOVE, DON'T REWRITE" note on #settings-screen).

      // The Homeroom app → connection panel offers wallet recovery only while
      // native admission is refused for want of a seeded wallet
      // (_walletRecoveryAvailable). Admission flipping either way — the
      // recovery dialog succeeding, a sign-out — must repaint that panel
      // without a navigation, and this event is how NativeChrome says so.
      window.addEventListener('usernode:native-session-admission',
        () => this._publishUsernode());

      // The static shell is still under the markup-parity migration guard,
      // so provider copy is normalized at runtime while this hidden section
      // mounts.
      this._normalizeOpenRouterCopy();

      // OpenRouter key (the one voice input uses). Section bindings, guarded
      // on existence so the section degrades cleanly if its markup is absent.
      const orSave = document.getElementById('settings-openrouter-save');
      const orRemove = document.getElementById('settings-openrouter-remove');
      if (orSave) orSave.addEventListener('click', () => this._saveOpenRouterKey());
      if (orRemove) orRemove.addEventListener('click', () => this._removeOpenRouterKey());

      const linkBtn = document.getElementById('wallet-link-btn');
      if (linkBtn) linkBtn.addEventListener('click', () => this._startWalletLink());
      const unlinkBtn = document.getElementById('wallet-unlink-btn');
      if (unlinkBtn) unlinkBtn.addEventListener('click', () => this._unlinkWallet());
      const cancelLink = document.getElementById('wallet-link-cancel');
      if (cancelLink) cancelLink.addEventListener('click', () => this._cancelWalletLink());

      const logoutBtn = document.getElementById('settings-logout');
      if (logoutBtn) logoutBtn.addEventListener('click', () => this.logout());
      const cliMore = document.getElementById('cli-tokens-more');
      if (cliMore) cliMore.addEventListener('click', () => this._loadCliTokens(false));

      // Copy the connector URL — the one thing the user has to carry over
      // into Claude.ai / ChatGPT by hand.
      this._wireCopyControl('connector-url-copy', {
        read: () => {
          const field = document.getElementById('connector-url');
          return field ? field.value : null;
        },
        successMessage: 'settings:connectors.copy.urlCopied',
        failureMessage: 'settings:connectors.copy.urlFailed',
        selectOnFail: () => {
          const field = document.getElementById('connector-url');
          if (field) field.select();
        },
      });

      this._wireConnectorStepCopy();

      // Test the connector: this site's MCP server and this account's own
      // connection. Read-only, and beside Copy rather than replacing it —
      // Copy is the thing the user came here to do.
      const testConnector = document.getElementById('connector-url-test');
      if (testConnector) testConnector.addEventListener('click', () => this._testConnector());

      // Copy the read-only allow rules. Two blocks with identical content and
      // different destinations: the user's PERSONAL ~/.claude/settings.json,
      // which covers every repo on their machine, and the per-repo
      // .claude/settings.json, which is the copy a fresh web container can
      // actually see. Byte-identical content is exactly why the toast names
      // the DESTINATION rather than saying "Copied" (#1290) — the label swap
      // alone cannot tell the two buttons apart, and on a phone the thumb is
      // over it anyway.
      const RULE_BLOCKS = {
        'connector-allow-rules': {
          success: 'settings:connectors.copy.personalRulesCopied',
          failure: 'settings:connectors.copy.personalRulesFailed',
        },
        'connector-repo-allow-rules': {
          success: 'settings:connectors.copy.repoRulesCopied',
          failure: 'settings:connectors.copy.repoRulesFailed',
        },
      };
      for (const id of ['connector-allow-rules', 'connector-repo-allow-rules']) {
        this._wireCopyControl(`${id}-copy`, {
          // Read at CLICK time, not wire time: _wireConnectorNameSpelling()
          // rewrites these blocks in place, and the copy has to be whatever
          // the user is actually looking at.
          read: () => {
            const block = document.getElementById(id);
            return block ? block.textContent : null;
          },
          successMessage: RULE_BLOCKS[id].success,
          failureMessage: RULE_BLOCKS[id].failure,
          selectOnFail: () => {
            const block = document.getElementById(id);
            if (!block || !window.getSelection || !document.createRange) return;
            const range = document.createRange();
            range.selectNodeContents(block);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
          },
        });
      }

      // #1892: the two Codex CLI blocks. Read at click time for the same
      // reason as above: _renderConnectors() swaps the URL placeholder for
      // the live connector URL after this wiring runs.
      const CODEX_BLOCKS = {
        'connector-codex-add': {
          success: 'settings:connectors.copy.codexCommandCopied',
          failure: 'settings:connectors.copy.codexCommandFailed',
        },
        'connector-codex-config': {
          success: 'settings:connectors.copy.codexConfigCopied',
          failure: 'settings:connectors.copy.codexConfigFailed',
        },
      };
      for (const id of Object.keys(CODEX_BLOCKS)) {
        this._wireCopyControl(`${id}-copy`, {
          read: () => {
            const block = document.getElementById(id);
            return block ? block.textContent : null;
          },
          successMessage: CODEX_BLOCKS[id].success,
          failureMessage: CODEX_BLOCKS[id].failure,
          selectOnFail: () => {
            const block = document.getElementById(id);
            if (!block || !window.getSelection || !document.createRange) return;
            const range = document.createRange();
            range.selectNodeContents(block);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
          },
        });
      }

      this._wireConnectorNameSpelling();
      this._wireConnectorStepTicks();

      // #5281: the Account page's sign-in rows. Each row's Change opens its
      // own form under it and Cancel closes it; one is open at a time.
      [['cu-edit', 'username'], ['cp-edit', 'password']].forEach(([id, part]) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', () => this._openAccountEditor(part));
      });
      ['cu-cancel', 'cp-cancel'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', () => this._openAccountEditor(null));
      });
      // The Email part is React-owned (sections/email.tsx) and announces its
      // own opening; close ours when it does, without announcing again.
      window.addEventListener?.(ACCOUNT_EDITOR_EVENT, (e) => {
        if (e && e.detail && e.detail.part === 'email') this._openAccountEditor('email', { announce: false });
      });

      // Change username → POST /api/me/username (and, for an account with no
      // password, POST /api/me/username/code first, #5281).
      const cuSave = document.getElementById('cu-save');
      if (cuSave) cuSave.addEventListener('click', () => this.changeUsername());
      const cuSendCode = document.getElementById('cu-send-code');
      if (cuSendCode) cuSendCode.addEventListener('click', () => this.requestUsernameCode());
      // Enter in any field submits, like the password form's fields do
      // not — this one is two fields and a button, and a rename typed on a
      // phone should not require reaching for the button.
      ['cu-new', 'cu-password', 'cu-code'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) {
          el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); this.changeUsername(); }
          });
        }
      });
      // Change password (issue #282) → POST /api/me/password.
      const cpSave = document.getElementById('cp-save');
      if (cpSave) cpSave.addEventListener('click', () => this.changePassword());

      // Wallet-signed change-password → POST /api/me/wallet-change-password.
      // Only reachable when the wallet-mode link is shown (native + linked).
      const cpWalletSave = document.getElementById('cp-wallet-save');
      if (cpWalletSave) cpWalletSave.addEventListener('click', () => this.changePasswordWithWallet());
      const useWallet = document.getElementById('cp-use-wallet');
      if (useWallet) useWallet.addEventListener('click', (e) => { e.preventDefault(); this._setChangePasswordMode('wallet'); });
      const usePassword = document.getElementById('cp-use-password');
      if (usePassword) usePassword.addEventListener('click', (e) => { e.preventDefault(); this._setChangePasswordMode('password'); });

      // Dev console "always show" toggle. State lives in DevConsole +
      // localStorage; we just mirror it here. Wire change immediately
      // so the icon appears/disappears without needing to close the
      // modal.
      const devConsoleToggle = document.getElementById('dev-console-always-show');
      if (devConsoleToggle) {
        devConsoleToggle.addEventListener('change', (e) => {
          if (!window.DevConsole) return;
          DevConsole.setMode(e.target.checked
            ? DevConsole.MODE_ALWAYS
            : DevConsole.MODE_ERRORS_ONLY);
        });
      }

      // Platform-level language preference (issue #757). Server-side
      // per-user BCP-47 tag (default unset = "Auto"); apps read it via
      // the iframe JWT claim and usernode.getUserLocale(). Fires the
      // POST on change so it takes effect without closing the modal;
      // revert the select if the save fails.
      const localeSelect = document.getElementById('settings-locale');
      if (localeSelect) {
        localeSelect.addEventListener('change', (e) => this._saveLocale(e.target.value));
      }
      // #6479: the time zone times are shown in, beside the language and
      // saved the same way, on change.
      const zoneSelect = document.getElementById('settings-timezone');
      if (zoneSelect) {
        zoneSelect.addEventListener('change', (e) => this._saveTimeZone(e.target.value));
      }

      // "Send a test alert": the server queues a test push for the phone and
      // delays its delivery (services/test-alert.js), so the person can
      // switch away first. The countdown says when it is due.
      const alertsTest = document.getElementById('devchat-alerts-test');
      if (alertsTest) {
        alertsTest.addEventListener('click', async () => {
          if (alertsTest.disabled) return;
          const status = document.getElementById('devchat-alerts-test-status');
          this._clearAlertsTestCountdown();
          alertsTest.disabled = true;
          if (status) {
            status.classList.remove('hidden');
            status.textContent = tr('settings:alerts.test.queueing');
          }
          try {
            const response = await fetch('/api/me/test-alert', {
              method: 'POST',
              credentials: 'same-origin',
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || tr('settings:alerts.test.failed'));
            if (!status) return;
            // A push that was not queued has nothing to count down to: say
            // why at once.
            if (!result.queued) {
              status.textContent = tr(result.reason === 'preference_disabled'
                ? 'settings:alerts.test.after.preferenceDisabled'
                : 'settings:alerts.test.after.unavailable');
              return;
            }
            let remaining = Math.ceil(result.delayMs / 1000);
            const render = () => {
              status.textContent = tr('settings:alerts.test.countdown.queued', { count: remaining });
            };
            render();
            this._alertsTestTimer = setInterval(() => {
              remaining -= 1;
              if (remaining > 0) {
                render();
                return;
              }
              this._clearAlertsTestCountdown();
              status.textContent = tr('settings:alerts.test.after.queued');
            }, 1000);
          } catch (err) {
            if (status) status.textContent = err.message || tr('settings:alerts.test.failed');
          } finally {
            alertsTest.disabled = false;
          }
        });
      }

      // Account-level remote-push categories. These are deliberately
      // separate from the native bridge's per-device Activity notifications
      // switch: every signed-in browser can edit them, while a phone still
      // has to be registered and enabled before any category can deliver.
      document.querySelectorAll(
        '#settings-mobile-push-preferences [data-mobile-push-category]'
      ).forEach((row) => {
        const input = row.querySelector('input[type="checkbox"]');
        const category = row.dataset.mobilePushCategory;
        if (!input || !category) return;
        input.addEventListener('change', () => {
          this._saveMobilePushPreference(category, input.checked);
        });
      });

      // "View as non-admin" admin tool. Mirror state to localStorage
      // and reload — the simplest way to flush every admin-gated
      // render path (home buttons, app-secrets editor, etc.) without
      // having to re-derive each one. See app.js for where the flag
      // is read and applied to App.user.isAdmin.
      const viewAsToggle = document.getElementById('view-as-non-admin');
      if (viewAsToggle) {
        viewAsToggle.addEventListener('change', (e) => {
          if (e.target.checked) {
            localStorage.setItem('viewAsNonAdmin', '1');
          } else {
            localStorage.removeItem('viewAsNonAdmin');
          }
          window.location.reload();
        });
      }
      // The persistent header banner has its own "Switch back" link for
      // admins who notice they're in preview mode mid-session. That banner
      // is a React island now (#1078) and owns its own click handler —
      // binding it from here too would run the reload path twice.

      // No backdrop / Escape dismissal any more: Settings is a screen, not
      // a modal. Leaving it is a real hash navigation (the header back
      // button, the device back gesture) — see handleBack / _exitSettings.

      this.refresh();
    },

    // #1055: the page's ?demo=1 rides along on the /api/auth/me read, so a
    // staging reviewer sees the key-on-file branch of the composer meter and
    // the session-options menu without pasting a real key into a preview.
    // Honoured only in staging (routes/auth.js), so it is safe to send
    // always — same pass-through as _cliTokensDemo below.
    async refresh() {
      try {
        const meDemoQ = this._cliTokensDemo() ? '?demo=1' : '';
        const j = await this._readMe(meDemoQ);
        if (!j) return;
        this.state.usernodePubkey = j.user?.usernodePubkey || null;
        this.state.walletLinkEnabled = !!j.user?.walletLinkEnabled;
        this.state.locale = j.user?.locale || null;
        this.state.timeZone = j.user?.timeZone || null;
        // Same payload the CLI-credentials gate needs, so prime its memo.
        // When the gate runs first it takes its answer from _readMe too
        // (_cliAuthAvailable), so neither order sends a second
        // /api/auth/me; both resolve to the same deployment-constant answer.
        this._cliAuthPromise = Promise.resolve(j.user?.cliAuthEnabled !== false);
        // `walletLinkEnabled` decides whether the Homeroom Wallet row is in
        // the menu at all, and it lands here — possibly AFTER a cold-boot
        // deep link has already painted. Re-resolve the menu.
        this._renderWalletSection();
        // `locale` is what the Language select shows, and it lands here
        // too: a cold-boot deep link to #settings/language paints before
        // this resolves. Same reasoning as the wallet row above.
        this._renderLanguageSection();
        this._renderNavIfOpen();
      } catch {}
    },

    /**
     * The /api/auth/me payload, JOINING the boot read rather than repeating
     * it. Returns the parsed body, or null when there is no usable answer.
     *
     * This runs from init(), which a React layout effect fires at document
     * load on EVERY screen, and the shell reads the state before
     * #settings is ever opened. It just does not need its own request:
     * every field read above is on the same `user` object App.init is
     * fetching 16ms later, and the two were queueing behind each other for
     * ~130ms on the first paint of every screen. See App.bootSession.
     *
     * `?demo=1` still reads for itself, and must: staging answers that
     * request differently (with a fixture key), so the boot's
     * plain answer is the wrong one — not a stale copy of the right one.
     */
    async _readMe(meDemoQ) {
      if (!meDemoQ && typeof window.App?.bootSession === 'function') {
        const boot = await window.App.bootSession();
        if (boot?.user) return { user: boot.user };
        // Answered 401/403. A second ask gets the same answer.
        if (boot?.signedOut) return null;
        // `unknown` — the boot read never landed and the shell is on the
        // snapshot, which carries none of these fields. Read for ourselves;
        // offline the worker answers it from cache, as it always has.
      }
      return this._fetchMe(meDemoQ);
    },

    // The read itself, shared while it is on its way (#6591): refresh() and
    // the CLI-credentials gate ask in the same tick when Settings opens, and
    // each sent its own. Nothing is kept: once the answer lands the next
    // caller asks the server again. The parsed body is shared, so read it
    // and do not write to it.
    _meReads: {},

    _fetchMe(meDemoQ) {
      const running = this._meReads[meDemoQ];
      if (running) return running;
      const read = (async () => {
        const r = await fetch(`/api/auth/me${meDemoQ}`, { credentials: 'same-origin' });
        if (!r.ok) return null;
        return await r.json();
      })();
      this._meReads[meDemoQ] = read;
      const done = () => { if (this._meReads[meDemoQ] === read) delete this._meReads[meDemoQ]; };
      read.then(done, done);
      return read;
    },

    isOpen() { return Settings._open; },

    // The panes are not in the prerendered document any more: the
    // island mounts them on the screen's first reveal (lib/mount-on-reveal.ts,
    // #settings-section-content ships empty like #admin-section-content).
    // Everything below open() reads their ids on its next line, so the
    // interior has to exist BEFORE a single pane renders. The bridge mounts it inside
    // flushSync and returns with the nodes in the document; init() runs in
    // that same flush, so the id-bound listeners are live too. Reached by
    // name, not import: a dozen tests run this file as a script in a `vm`.
    _ensureMounted() {
      try {
        window.UsernodeReact?.mount?.ensure?.('settings-screen');
      } catch (err) { /* an absent bridge is the prerender pass */ }
    },

    // Repaint every section's body. Cheap (they're all local state or a
    // small fetch) and it keeps the ONE render path — a section is never
    // rendered lazily on first reveal, so its controls are correct whether
    // the viewer lands on it or switches to it later.
    _renderAllSections() {
      this._refreshSpend();
      this._refreshOpenRouter();
      this._renderLlmGrants();
      this._renderAppPermissions();
      this._renderNotificationPrefs();
      this._loadCliTokens(true);
      this._loadConnectors();
      this._loadGithubLink();
      this._renderWalletSection();
      this._renderChangeUsernameSection();
      this._renderChangePasswordSection();
      this._renderDevConsoleSection();
      this._renderLanguageSection();
      this._loadMobilePushPreferences();
      this._renderAdminSection();
      this._renderUsernodeSection();
    },

    // `section` is the hash's optional second segment (null for bare
    // #settings). Intentionally do NOT auto-focus any field: on mobile,
    // focusing an input on open immediately pops the on-screen keyboard,
    // which is jarring when the user just wanted to view settings.
    // `opts.chrome === false` renders WITHOUT touching the platform
    // header (#979): app.js calls this while #settings-screen is still
    // hidden — invisible, so it may run before the screen transition —
    // but the header title / back icon are visible, and writing them
    // early bakes the incoming screen's chrome into the View Transition's
    // snapshot of the page the user is leaving. The caller runs
    // Settings.syncChrome() inside the transition callback instead.
    open(section, opts) {
      Settings._ensureMounted();
      Settings._open = true;
      // A new visit starts with an empty filter box: the nav components
      // clear their query whenever this changes (see _renderNav).
      Settings._visit += 1;
      Settings._pushedFromMenu = false;
      Settings._menuScrollTop = 0;
      Settings._chromeSuspended = !!(opts && opts.chrome === false);
      // Per-mount state: the Homeroom-app auto-retry is offered once per
      // visit to Settings, not once per document.
      Settings._usernodeAuthRetryUsed = false;
      Settings._loadNavPrefs();
      Settings._ensureMediaListener();
      Settings._pendingSection = null;
      Settings._renderAllSections();

      const visible = Settings._visiblePages();
      const target = Settings._resolve(section);
      const valid = !!target.page && visible.some((p) => p.key === target.page);
      Settings._notePendingSection(section, valid);
      const fallback = visible.some((p) => p.key === Settings._section)
        ? Settings._section
        : (visible[0] ? visible[0].key : Settings.DEFAULT_SECTION);

      // On mobile, a bare #settings means the MENU — never a last-visited
      // section resurrected from earlier in this tab. On desktop it keeps
      // meaning the default section, exactly like the admin console.
      if (Settings._isMobile() && !valid) {
        Settings._level = 1;
        Settings._section = fallback;
        Settings._anchor = null;
        Settings._renderNav();
        Settings._renderContent();
        Settings._syncChrome();
        return;
      }
      Settings._level = 2;
      Settings._section = valid ? target.page : fallback;
      Settings._anchor = valid ? target.anchor : null;
      Settings.setSection(Settings._section, { writeHash: false, anchor: Settings._anchor });
      // Runs after app.js's own setHeaderTitle, so on a mobile deep link the
      // header ends up showing the section's name rather than "Settings".
      Settings._syncChrome();
    },

    // Re-entry while the screen is ALREADY mounted (app.js routes here
    // instead of re-running the whole screen swap — see navigateToSettings).
    // Mirrors AdminConsole.route.
    //
    // IDEMPOTENT (#1102). A same-document history traversal — the header
    // chevron's history.back(), the device back gesture, browser back/forward
    // — fires BOTH popstate and hashchange, so restoreFromHash runs TWICE in
    // one tick and app.js hands us the SAME section twice. #987 stopped the
    // duplicate replaying the screen ENTRY, but not the in-screen LEVEL
    // change, and this screen's level swap mutates an already-VISIBLE root:
    // the second call resolved the same level, so it asked for 'none', which
    // the kit runs SYNCHRONOUSLY — landing the level swap before the first
    // call's still-pending View Transition had captured the outgoing page.
    // The animation then played the incoming page against a dimmed copy of
    // itself (two menus on screen, the section gone instantly). So resolve
    // the whole target FIRST and bail out when it is already on screen —
    // don't "optimise" this into a repaint, and don't move it below the
    // _transition() call. Browse.route has the same guard for the same
    // reason. A late capability change (a section appearing/disappearing)
    // repaints through refreshMenu(), not through here.
    route(section) {
      Settings._ensureMounted();
      // The Homeroom-app page's demo links (`?bridgediag=`, `?widgeticons=`,
      // `?usernodedemo=`) ride in the hash, and that page is drawn when the
      // screen opens. An address that changes only them, from another
      // Settings page or from another demo, found the page drawn for the
      // address before: with no app, the page itself was not in the menu,
      // so the link fell back to the default page. Drawn again here, before
      // the menu is read, it shows what a fresh load of the address shows.
      // The gate it decides is set synchronously, before its first await.
      if (Settings._usernodeDemoKey !== Settings._usernodeDemo()) {
        Settings._usernodeState = null;
        Settings._renderUsernodeSection();
      }
      const visible = Settings._visiblePages();
      const target = Settings._resolve(section);
      const valid = !!target.page && visible.some((p) => p.key === target.page);
      Settings._notePendingSection(section, valid);
      const mobile = Settings._isMobile();
      // The level, page and part this call WOULD end on. Level 1 keeps
      // whatever page sits behind the menu, so there the level is the whole
      // target. The part is part of the target: #settings/password while
      // Account is already showing is a different request (scroll to it),
      // while the duplicate dispatch of one traversal carries the same one.
      const targetLevel = (!mobile || valid) ? 2 : 1;
      const targetSection = valid
        ? target.page
        : (mobile ? Settings._section : (visible[0] ? visible[0].key : Settings.DEFAULT_SECTION));
      const targetAnchor = valid ? target.anchor : null;
      if (targetLevel === Settings._level && targetSection === Settings._section) {
        // Same page at the same level. Only a different PART makes it a new
        // request; anything else is the duplicate, and it stops here.
        if (targetLevel === 1 || targetAnchor === Settings._anchor) {
          Settings._markRoute('skipped');
          return;
        }
      }
      Settings._markRoute('applied');
      if (!mobile) {
        // setSection() assigns the page and part itself, and decides from the
        // page it replaces whether to start the new one at its top.
        Settings.setSection(targetSection, { writeHash: false, anchor: targetAnchor });
        Settings._level = 2;
        Settings._syncChrome();
        return;
      }
      // 1→2 push, 2→1 pop, same level (section→section deep link) instant:
      // the kit's fidelity rule is no animation on same-level repaints.
      const type = targetLevel === Settings._level
        ? 'none'
        : (targetLevel === 2 ? 'push' : 'pop');
      if (targetLevel === 2) {
        Settings._menuScrollTop = Settings._level === 1
          ? Settings._scrollTop()
          : Settings._menuScrollTop;
        Settings._section = target.page;
        Settings._anchor = targetAnchor;
      } else {
        Settings._pushedFromMenu = false;
        Settings._anchor = null;
      }
      Settings._level = targetLevel;
      Settings._transition(() => {
        Settings._renderNav();
        Settings._renderContent();
        Settings._syncChrome();
        Settings._restoreScroll();
        Settings._scrollToAnchor();
      }, type);
    },

    // The on-screen back arrow AND the platform header's back button both
    // land here (app.js:back-btn). Returns true when the press was consumed
    // — i.e. mobile, inside a section — so the header falls through to
    // navigateHome() everywhere else (all of desktop included).
    handleBack() {
      if (!Settings._open) return false;
      if (!Settings._isMobile() || Settings._level !== 2) return false;
      if (Settings._pushedFromMenu || Settings._entryBelow()) {
        // Something of ours is below this entry, so popping lands on it —
        // routing back through popstate → restoreFromHash → route(), the
        // same path the device back gesture takes.
        //
        // `_pushedFromMenu` is the case where we know exactly what that is:
        // our own menu. It is not the only one (#1565). A link from
        // ELSEWHERE in the app — the profile editor's "Settings → Username",
        // which is where a viewer who wants to rename themselves is sent —
        // pushes an entry too, and what sits below it is the screen the
        // viewer actually came from.
        // Replacing it with the menu stranded them a level deeper than they
        // started: two presses to get back to Profile, the first of which
        // went somewhere they had never been.
        history.back();
        return true;
      }
      // A COLD deep link — a bookmark, a push notification, a reload on the
      // section — really does have nothing of ours below, and back would
      // leave the app. REPLACE the entry with the menu rather than pushing
      // one, so back can't bounce the viewer between the section and the
      // menu forever.
      try { history.replaceState(null, '', '#settings'); } catch { /* non-fatal */ }
      Settings._level = 1;
      Settings._transition(() => {
        Settings._renderNav();
        Settings._renderContent();
        Settings._syncChrome();
        Settings._restoreScroll();
      }, 'pop');
      return true;
    },

    // Did this DOCUMENT put an address below the one on screen? The router
    // is the only thing that can say (see App.previousRoute), and a shell
    // that never answers — the vm harnesses, the prerender pass — is treated
    // as a cold deep link, which is the conservative half: it keeps the
    // viewer inside Settings rather than sending back somewhere that may not
    // exist.
    _entryBelow() {
      try { return window.App?.previousRoute?.() != null; }
      catch { return false; }
    },

    // Where the level-2 chevron POINTS. It has to name the same place
    // handleBack goes, or a native/middle click lands somewhere the plain
    // click does not — and the arrow's href is the platform's fallback
    // answer for "back to where?" (app.js's back-btn handler follows it).
    _upHref() {
      if (Settings._pushedFromMenu || !Settings._entryBelow()) return '#settings';
      // `''` is home; undefined lets setBackIcon fall back to the home href.
      return window.App.previousRoute() || undefined;
    },

    // Below the sidebar breakpoint — i.e. the two-level layout is live.
    // Anything that can't answer (no matchMedia) is treated as desktop, so
    // a browser without it keeps the sidebar rather than a phone layout it
    // never asked for.
    _isMobile() {
      try { return !window.matchMedia(Settings.DESKTOP_MEDIA).matches; }
      catch { return false; }
    },

    // One-time viewport listener: crossing the breakpoint re-resolves the
    // layout in place. Crossing UP renders the active section in the
    // sidebar shell; crossing DOWN keeps that section as level 2 (no menu
    // flash) and writes its explicit hash so the address matches what's on
    // screen. Lazy-bound, like AdminConsole._ensureMediaListener.
    _ensureMediaListener() {
      if (Settings._mediaBound || !window.matchMedia) return;
      try {
        const mql = window.matchMedia(Settings.DESKTOP_MEDIA);
        const onChange = () => {
          if (!Settings._open) return;
          if (!mql.matches && Settings._level !== 1) {
            Settings._writeHash(Settings._anchor || Settings._section);
          }
          Settings._renderNav();
          Settings._renderContent();
          Settings._syncChrome();
        };
        if (mql.addEventListener) mql.addEventListener('change', onChange);
        else if (mql.addListener) mql.addListener(onChange);
        Settings._mediaBound = true;
      } catch { /* no matchMedia — desktop path stands */ }
    },

    // The sections the current viewer may navigate to: everything whose
    // gate node is absent or currently un-hidden. Reading the node rather
    // than re-deriving the condition is what keeps this in step with
    // _renderWalletSection / _renderUsernodeSection / _renderAdminSection.
    //
    // ONE GATE IS READ FROM ITS MODEL (#2893). The Homeroom app gate is
    // decided here, in _renderUsernodeSection, and reaches its node through
    // usernodeSectionStore — which, unlike the nav store, commits on React's
    // next tick rather than synchronously. On the first open of the screen in
    // a document, open() reads the gate straight after that decision, so a
    // deep link to #settings/usernode (the block-production challenge's
    // button) found the node still hidden and fell back to the Settings
    // root. `_usernodeGated` is the value the node is rendered FROM, so once
    // it has been decided it is the truth; before that the node still is.
    _visibleSections() {
      return Settings.SECTIONS.filter((s) => {
        if (!s.gate) return true;
        if (s.gate === 'settings-usernode-section' && typeof Settings._usernodeGated === 'boolean') {
          return Settings._usernodeGated;
        }
        const el = document.getElementById(s.gate);
        return !!el && !el.classList.contains('hidden');
      });
    },

    // The page a part lives on: its `page`, or its own key.
    _pageKey(s) {
      return String((s && (s.page || s.key)) || '');
    },

    // What an address segment asks for: `{ page, anchor }`. A page key opens
    // that page at its top. A part key opens the page the part lives on,
    // scrolled to the part — unless it is that page's FIRST part, whose
    // address simply is the page (#settings/profile → Account at its top;
    // #settings/password → Account, scrolled to Password). Anything unknown
    // is `{ page: null }`, which every caller treats as "not a valid
    // section". A retired address (PART_ALIASES) opens where its part went.
    _resolve(key) {
      const asked = key == null ? '' : String(key);
      const k = Object.prototype.hasOwnProperty.call(Settings.PART_ALIASES, asked)
        ? Settings.PART_ALIASES[asked]
        : asked;
      if (!k) return { page: null, anchor: null };
      const part = Settings.SECTIONS.find((s) => s.key === k);
      if (part) {
        const page = Settings._pageKey(part);
        const first = Settings.SECTIONS.find((s) => Settings._pageKey(s) === page);
        return { page, anchor: first && first.key !== k ? k : null };
      }
      if (Settings.SECTIONS.some((s) => Settings._pageKey(s) === k)) {
        return { page: k, anchor: null };
      }
      return { page: null, anchor: null };
    },

    // The pages the viewer may navigate to, in registry order: every page
    // with at least one visible part. Each carries its label, its group (its
    // first part's) and the parts the viewer can see on it. This is what the
    // nav lists and what open()/route()/setSection() validate against.
    _visiblePages() {
      const pages = [];
      for (const s of Settings._visibleSections()) {
        const key = Settings._pageKey(s);
        let p = pages.find((x) => x.key === key);
        if (!p) {
          p = {
            key,
            label: tr(Settings.PAGES[key] || s.label),
            group: s.group || 'settings:nav.group.other',
            parts: [],
          };
          pages.push(p);
        }
        p.parts.push(s);
      }
      return pages;
    },

    // Remember a deep link to a REGISTERED section that is not offered yet
    // (its gate resolves later), so _renderNavIfOpen can finish the route
    // instead of leaving the viewer on the menu. Anything else clears it.
    _notePendingSection(section, valid) {
      Settings._pendingSection = (!!section && !valid
        && Settings.SECTIONS.some((s) => s.key === section && s.gate)) ? section : null;
    },

    // The visible PAGES bucketed by group, in first-appearance order. Shared
    // by the desktop sidebar and the mobile level-1 menu so the two can never
    // drift into different groupings.
    //
    // #5997: the pages the viewer pinned come first, as a Pinned group in
    // their own order, and leave their usual group rather than showing twice;
    // a group left with no pages is not drawn. A pin whose page is not offered
    // right now (Homeroom Wallet while wallet linking is off) is skipped, and
    // kept, so the page comes back pinned. Each group carries `key` (its
    // catalog id's last segment) and `folded`; Pinned never folds.
    //
    // A group folds only when the viewer folds it. #1554 once shut seven
    // rarely used panes inside a collapsed "Advanced" group BY DEFAULT, two
    // of them privacy controls; that is why every group starts open, and why
    // a fold is the viewer's own choice, remembered on their device.
    _groupedSections() {
      const pages = Settings._visiblePages();
      const prefs = Settings._navPrefs;
      const pinned = [];
      for (const key of prefs.pinned) {
        const p = pages.find((x) => x.key === key);
        if (p && !pinned.includes(p)) pinned.push(p);
      }
      const groups = pinned.length
        ? [{ name: 'settings:nav.group.pinned', key: 'pinned', folded: false, items: pinned }]
        : [];
      for (const p of pages) {
        if (pinned.includes(p)) continue;
        const name = p.group || 'settings:nav.group.other';
        let g = groups.find((x) => x.name === name);
        if (!g) {
          const key = Settings._groupKey(p);
          g = { name, key, folded: prefs.folded.includes(key), items: [] };
          groups.push(g);
        }
        g.items.push(p);
      }
      return groups;
    },

    // A page's own group's key: its catalog id's last segment ('aiModels').
    // A pinned row carries it as `home`, the group an unpin sends it back to.
    _groupKey(p) {
      const name = p.group || 'settings:nav.group.other';
      return name.slice(name.lastIndexOf('.') + 1);
    },

    // #5997: read the pins and folds this device remembers. Storage that is
    // missing or throws (a private window, blocked site data) leaves the menu
    // as it always was for this visit; nothing else depends on it.
    _loadNavPrefs() {
      const read = (key) => {
        try {
          const raw = localStorage.getItem(key);
          return raw ? [...new Set(String(raw).split(',').map((k) => k.trim()).filter(Boolean))] : [];
        } catch {
          return [];
        }
      };
      Settings._navPrefs = { pinned: read(Settings.PINNED_KEY), folded: read(Settings.FOLDED_KEY) };
    },

    // Write one list back and repaint both menus. A write that throws still
    // changes the menu for this visit.
    _saveNavPref(which, list) {
      Settings._navPrefs = { ...Settings._navPrefs, [which]: list };
      const key = which === 'pinned' ? Settings.PINNED_KEY : Settings.FOLDED_KEY;
      try {
        if (list.length) localStorage.setItem(key, list.join(','));
        else localStorage.removeItem(key);
      } catch { /* storage unavailable: the change lasts this visit */ }
      Settings._renderNav();
    },

    // Pin a page (it goes to the bottom of Pinned) or unpin it (it goes back
    // to its place in its group).
    _setPinned(key, on) {
      const list = Settings._navPrefs.pinned.filter((k) => k !== key);
      if (on) list.push(key);
      Settings._saveNavPref('pinned', list);
    },

    // Move a pinned page one place up (step -1) or down (+1) among the pinned
    // pages the viewer can see. It swaps with that neighbour's slot in the
    // stored list, so a pin hidden right now keeps its own place. A no-op at
    // either end.
    _movePinned(key, step) {
      const list = Settings._navPrefs.pinned.slice();
      const offered = new Set(Settings._visiblePages().map((p) => p.key));
      const shown = list.filter((k) => offered.has(k));
      const at = shown.indexOf(key);
      const other = at < 0 ? undefined : shown[at + step];
      if (!other) return;
      const i = list.indexOf(key);
      const j = list.indexOf(other);
      list[i] = other;
      list[j] = key;
      Settings._saveNavPref('pinned', list);
    },

    // Fold a group down to its heading, or open it again.
    _setGroupFolded(group, on) {
      if (group === 'pinned') return;
      const list = Settings._navPrefs.folded.filter((k) => k !== group);
      if (on) list.push(group);
      Settings._saveNavPref('folded', list);
    },

    str(s) {
      return String(s == null ? '' : s);
    },

    // What the nav's filter box matches a page on, and what it can show under
    // a matching row: the page label, then each visible part with its own
    // label and KEYWORDS. Lower-cased here once, so the component only ever
    // compares. A part is listed even when it is the page's only one — the
    // component decides whether its label is worth repeating.
    _filterTerms(p) {
      return {
        terms: Settings.str(p.label).toLowerCase(),
        parts: p.parts.map((s) => ({
          key: s.key,
          label: tr(s.label),
          terms: `${tr(s.label)} ${Settings.KEYWORDS[s.key] ? tr(Settings.KEYWORDS[s.key]) : ''}`.toLowerCase(),
        })),
      };
    },

    // #5995: a page's load reports how many things it lists. Only a success
    // reports; a failed or missing list leaves the row without a count.
    //
    // The repaint is DEFERRED to a microtask, never run inline: a React pane
    // reports from an effect (./sections/linked-phones.tsx), and the nav
    // store flushes synchronously (flushSync), which React refuses inside an
    // effect with a console error. Several reports in one tick paint once.
    _setNavStatus(key, count) {
      const next = Number.isFinite(count) && count >= 0 ? count : null;
      const prev = Object.prototype.hasOwnProperty.call(Settings._navStatus, key) ? Settings._navStatus[key] : null;
      if (next === prev) return;
      if (next === null) delete Settings._navStatus[key];
      else Settings._navStatus[key] = next;
      if (Settings._navStatusPaint) return;
      Settings._navStatusPaint = true;
      Promise.resolve().then(() => {
        Settings._navStatusPaint = false;
        if (Settings._open) Settings._renderNav();
      });
    },

    // The trailing words for a page's row: '' when it counts nothing, when no
    // count has arrived yet, or when the sum is zero. Zero says nothing.
    _navStatusText(pageKey) {
      const entry = Settings.STATUS[pageKey];
      if (!entry) return '';
      const [id, keys] = entry;
      let count = 0;
      for (const k of keys) {
        if (Object.prototype.hasOwnProperty.call(Settings._navStatus, k)) count += Settings._navStatus[k];
      }
      return count > 0 ? tr(id, { count }) : '';
    },

    // The trailing extras both nav hosts draw on a row: a status phrase and a
    // tag. A row with a tag shows only the tag (one thing on a row's edge).
    _navExtras(pageKey) {
      const tag = Settings.TAGS[pageKey] ? tr(Settings.TAGS[pageKey]) : '';
      return { tag, status: tag ? '' : Settings._navStatusText(pageKey) };
    },

    // Desktop sidebar rows, grouped under headings — one row per PAGE.
    //
    // A DESCRIPTOR, not HTML, since #1191 slice 6 conversion 8 —
    // ./settings-nav.tsx is the only writer of #settings-nav-desktop now. The
    // shape is `[{ name, first, items: [{ key, label, active, className,
    // terms, parts }] }]`.
    //
    // `className` is computed HERE rather than in the component on purpose:
    // it is the one class string on this screen that varies with state, it is
    // carried over from the retired _navItemsHtml() character for character
    // (so the rendered attribute cannot drift), and the shaping-stays-in-JS
    // rule is what keeps this module loadable by the vm harnesses. Tailwind's
    // extractor scans frontend/** including .js, so both spellings still
    // compile.
    //
    // The current row wears the lit tokens (#5997), the palette's "where you
    // are", as the project rail's current place does (.dev-ws-place in
    // app.css): the lit tint fills it, the lit line rings it, the lit ink
    // names it, a weight heavier than its neighbours. It was the action
    // accent's 10% wash, which hardly told it from a hovered row.
    //
    // The row itself is the shared ListRow (settings-nav.tsx), which lays it
    // out (a flex row, full width, start-aligned) and sizes its name, so this
    // string holds only what the sidebar adds to it: its inset, the room the
    // pin strip takes at the end, and the state.
    _navView() {
      const active = Settings._section;
      const item = (p) => ({
        key: p.key,
        label: Settings.str(p.label),
        active: p.key === active,
        className: 'settings-nav-item gap-2.5 rounded-lg ps-3 pe-9 py-2 transition-colors '
          + (p.key === active
            ? 'font-semibold bg-[color:var(--lit-tint)] text-[color:var(--lit-ink)] shadow-[inset_0_0_0_1px_var(--lit-line)]'
            : 'font-medium text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800'),
        // #5997: the glyph's name, and whether the viewer pinned the page.
        icon: Settings.ICONS[p.key] || '',
        pinned: Settings._navPrefs.pinned.includes(p.key),
        home: Settings._groupKey(p),
        ...Settings._navExtras(p.key),
        ...Settings._filterTerms(p),
      });
      return Settings._groupedSections().map((g, i) => ({
        name: tr(g.name),
        key: g.key,
        folded: g.folded,
        first: i === 0,
        items: g.items.map(item),
      }));
    },

    // Mobile level 1: the section menu. A list, not a tab set — so plain
    // buttons in a <nav>, no role="tab"/aria-selected, and the drawer-row
    // idiom from index.html (44px minimum, hairline between rows, chevron
    // on the right), exactly as the admin console's level-1 menu. The row
    // classes and the chevron are the component's now (the chevron is
    // ChevronRightIcon, same 24x24 path); the grouping is still this
    // module's, shared with _navView through _groupedSections().
    _menuView() {
      return Settings._groupedSections().map((g) => ({
        name: tr(g.name),
        key: g.key,
        folded: g.folded,
        items: g.items.map((p) => ({
          key: p.key,
          label: Settings.str(p.label),
          subtitle: Settings.SUBTITLES[p.key] ? tr(Settings.SUBTITLES[p.key]) : '',
          icon: Settings.ICONS[p.key] || '',
          pinned: Settings._navPrefs.pinned.includes(p.key),
          home: Settings._groupKey(p),
          ...Settings._navExtras(p.key),
          ...Settings._filterTerms(p),
        })),
      }));
    },

    // Paint BOTH nav hosts. These two elements were the only ones this
    // module ever innerHTML-wrote — the section wrappers are static markup
    // and are only ever hidden/shown.
    _renderNav() {
      // Level 2 on a phone must not leave the menu rows above the section;
      // desktop hides the host through its own md:hidden class. `null` is
      // what the empty-string innerHTML write used to mean.
      const showMenu = Settings._isMobile() && Settings._level === 1;
      Settings._store?.set({
        desktop: Settings._navView(),
        mobile: showMenu ? Settings._menuView() : null,
        visit: Settings._visit,
      });
    },

    // Every [data-settings-nav] control routes through here — the component
    // calls it from onClick, where _wireNavButtons used to re-bind a listener
    // per button after every repaint. On mobile a press is a DRILL-IN (a real
    // hash navigation that pushes history); on desktop it's an in-place
    // sidebar switch.
    _navClick(key) {
      if (Settings._isMobile()) Settings._openSection(key);
      else Settings.setSection(key);
    },

    // Drill-in from a level-1 menu row. A REAL hash navigation so the
    // pushed entry makes the browser / WebView back gesture work for free;
    // restoreFromHash routes it back into route() a tick later. Assigning
    // location.hash preserves the query string, so ?demo=1 survives.
    _openSection(key) {
      Settings._menuScrollTop = Settings._scrollTop();
      Settings._pushedFromMenu = true;
      const target = `#settings/${key}`;
      if (location.hash === target) {
        // Same-value assignment fires no hashchange — route by hand.
        Settings.route(key);
        return;
      }
      location.hash = target;
    },

    // `key` may be a page or a part: a part opens its page scrolled to it
    // (the filter box's matched-part rows, open()'s and route()'s deep links
    // pass `opts.anchor` already resolved). An unknown or unavailable key
    // falls back to the first visible page, as it always has.
    setSection(key, opts) {
      const visible = Settings._visiblePages();
      const target = Settings._resolve(key);
      let page = target.page;
      let anchor = opts && 'anchor' in opts ? opts.anchor : target.anchor;
      if (!page || !visible.some((p) => p.key === page)) {
        page = visible[0] ? visible[0].key : Settings.DEFAULT_SECTION;
        anchor = null;
      }
      const changed = page !== Settings._section;
      Settings._section = page;
      Settings._anchor = anchor || null;
      if (!opts || opts.writeHash !== false) Settings._writeHash(Settings._anchor || page);
      Settings._renderNav();
      Settings._renderContent();
      // A different page starts at its top. Pages are several parts long
      // now, so keeping the old scroll offset across a sidebar switch would
      // open the next page part-way down. A part deep link scrolls to the
      // part instead.
      if (Settings._anchor) Settings._scrollToAnchor();
      else if (changed) Settings._restoreScroll();
    },

    // Section switches update the address without polluting history —
    // replaceState, and only while we're actually on the #settings route
    // (the AdminConsole._writeHash / Leaderboard._setSub pattern).
    // Entering/leaving the screen still gets a real history entry via
    // normal hash navigation.
    //
    // Mobile writes #settings/account rather than bare #settings: down here
    // a bare #settings means the MENU, so the default section needs an
    // explicit segment to stay distinguishable (and deep-linkable) from
    // level 1. Desktop keeps the default → bare #settings mapping.
    _writeHash(key) {
      const target = (key === Settings.DEFAULT_SECTION && !Settings._isMobile())
        ? '#settings'
        : `#settings/${key}`;
      if (location.hash.startsWith(`${target}/`)) return;
      if (location.hash.startsWith('#settings') && location.hash !== target) {
        history.replaceState(null, '', target);
      }
    },

    // The single dispatcher for what goes in the content area: the mobile
    // level-1 menu, or every part wrapper of exactly one page.
    _renderContent() {
      const host = document.getElementById('settings-section-content');
      const footer = document.getElementById('settings-footer');
      const menuLevel = Settings._isMobile() && Settings._level === 1;
      if (host) {
        host.classList.toggle('hidden', menuLevel);
        host.querySelectorAll('[data-settings-section]').forEach((el) => {
          const page = Settings._resolve(el.dataset.settingsSection).page;
          el.classList.toggle('hidden', menuLevel || page !== Settings._section);
        });
      }
      if (footer) Settings._syncFooter();
      // The AI-credit figure in the Usage part renders from a
      // me-scoped fetch and is throttled inside AiCredit, so refreshing it on
      // every section change is cheap and keeps it honest. This is where the
      // hamburger's open-time refresh went when the row moved here.
      // #6493: the AI usage page is the page people open to CHECK the figure,
      // so it fetches fresh rather than waiting out the three-minute throttle.
      if (Settings._section === 'ai' && window.AiCredit?.Budget?.refresh) {
        window.AiCredit.Budget.refresh({ force: true });
      } else if (window.AiCredit?.refreshAll) window.AiCredit.refreshAll();
      // Announce which section is showing. The one listener today is the
      // Theme pane (features/settings/sections/theme.tsx), which re-reads
      // Theme.get() so a mode changed in another tab — or an explicit value
      // that happens to match the OS — is reflected when you come back to it.
      // This replaces the drawer's `usernode:header-menu-open`, which did
      // exactly the same job when the control lived there.
      try {
        window.dispatchEvent(new CustomEvent('usernode:settings-section', {
          detail: { section: Settings._section },
        }));
      } catch (err) { /* ignore */ }
    },

    // Log out sits under the sidebar on desktop and under the level-1 menu
    // on a phone. The phone case needs a real node MOVE: the sidebar column
    // is `display:none` below md and would take the footer with it. Moving
    // the node (never rebuilding it) is what keeps #settings-logout's
    // click handler — bound once in init() — alive.
    _syncFooter() {
      const footer = document.getElementById('settings-footer');
      if (!footer) return;
      const mobile = Settings._isMobile();
      if (mobile) {
        const parent = document.getElementById('settings-content-col');
        if (parent && footer.parentElement !== parent) {
          // Leave a comment in the sidebar column where the footer was, so
          // React's picture of that column's children still describes the
          // document while the node is away (#1191 slice 6, conversion 8 —
          // lib/kit-surface.ts's createPlaceholderHome, the same seam the
          // dialog cards' lift uses). Planted by ./mount.ts; absent in the
          // vm harnesses, where the plain appendChild below is the whole
          // behaviour and always was.
          Settings._footerHome?.lift();
          parent.appendChild(footer);
        }
      } else if (Settings._footerHome) {
        // restore() puts it back where the comment SITS — after
        // #settings-nav-desktop in the sidebar column, i.e. its rendered
        // position — rather than merely inside the right parent.
        Settings._footerHome.restore();
      } else {
        const parent = document.getElementById('settings-sidebar-col');
        if (parent && footer.parentElement !== parent) parent.appendChild(footer);
      }
      // On a phone it belongs to the MENU level only — a drilled-in section
      // shouldn't end with a Log out button.
      footer.classList.toggle('hidden', mobile && Settings._level === 2);
    },

    _transition(fn, type) {
      if (window.PlatformUI && PlatformUI.transition) PlatformUI.transition(fn, { type: type || 'none' });
      else fn();
    },

    // Runtime-only marker recording what the LAST route() call did —
    // 'applied' (it repainted) or 'skipped' (the idempotence guard above
    // bailed out). Nothing reads it at runtime: it exists so the dapp.json
    // checks can assert an ordering that is otherwise only observable
    // mid-animation, exactly like App._entryTransition's data-entered stamp
    // (#977). Because it is written at runtime it is deliberately absent
    // from tests/baselines/shell-markup.json.
    _markRoute(state) {
      const el = document.getElementById('settings-screen');
      if (el) el.setAttribute('data-settings-route', state);
    },

    _scrollTop() {
      const screen = document.getElementById('settings-screen');
      const el = window.PlatformUI?.scrollElement?.(screen) || screen;
      return el ? el.scrollTop : 0;
    },

    // A deep link to a part that is not its page's first: bring it into view
    // once its page is showing. scrollIntoView rather than a scrollTop sum,
    // because the scroller differs by surface (the screen on desktop, the
    // document in the phone's browser-scroller mode) and the browser already
    // knows which one holds the node. Never on the phone's menu level, where
    // the wrappers are not on screen at all.
    _scrollToAnchor() {
      const key = Settings._anchor;
      if (!key || (Settings._isMobile() && Settings._level === 1)) return;
      const el = document.querySelector?.(`[data-settings-section="${key}"]`);
      if (!el || el.classList.contains('hidden')) return;
      // #5281: a link to the Username or Password part (the sign-up step's
      // "add a password later in Settings") wants its form, not just its row.
      if (ACCOUNT_EDITORS[key]) Settings._openAccountEditor(key);
      try { el.scrollIntoView({ block: 'start' }); } catch { /* old engines: no scroll */ }
    },

    // A pushed screen starts at the top; a pop restores where the menu was.
    _restoreScroll() {
      const screen = document.getElementById('settings-screen');
      const el = window.PlatformUI?.scrollElement?.(screen) || screen;
      if (!el) return;
      el.scrollTop = (Settings._isMobile() && Settings._level === 1)
        ? Settings._menuScrollTop
        : 0;
    },

    // Platform-header chrome for the current level: inside a mobile section
    // the header becomes that section's nav bar (arrow + section name),
    // everywhere else it stays "Settings" and the home icon. setHeaderTitle
    // mirrors into document.title, so the native shell's AppBar picks the
    // section name up too.
    // The public half of _syncChrome: clears the suspension a
    // `chrome: false` open() set and applies the chrome for real. app.js
    // calls this INSIDE the screen transition's callback (#979).
    syncChrome() {
      Settings._chromeSuspended = false;
      Settings._syncChrome();
    },

    _syncChrome() {
      if (!window.App || Settings._chromeSuspended) return;
      const inSection = Settings._isMobile() && Settings._level === 2;
      // #1036: the header control is a real anchor — inside a section the
      // chevron pops to whatever is below it, which is the settings menu
      // unless the viewer arrived from elsewhere in the app (#1565, see
      // _upHref), so that is its href.
      //
      // TWO LEVELS, ONE GLYPH. The mobile drill-in's chevron is the only way
      // up a level INSIDE this screen — without it a phone viewer is stranded
      // in a section — and since #2718's review the ROOT draws one too.
      //
      // Level 1 spent two rounds hiding it. That was right while Settings was
      // reached from Home's account row: the row you came from was one tap
      // behind you and a second affordance pointing at it was chrome. The Me
      // tab replaced that row, and `'home'` sends you to a screen the bar's
      // own Home tab already reaches while the tab still lit is Me — so the
      // root's arrow points at #profile, the level it is genuinely under.
      // App._BACK_SLOT['settings-screen'] says the same thing on the screen
      // reveal; this is the second writer, and the later one wins.
      if (App.setBackIcon) App.setBackIcon('arrow', inSection ? Settings._upHref() : '#profile');
      if (!App.setHeaderTitle) return;
      if (inSection) {
        const p = Settings._visiblePages().find((x) => x.key === Settings._section);
        App.setHeaderTitle(p ? p.label : tr('settings:screen.title'));
      } else {
        App.setHeaderTitle(tr('settings:screen.title'));
      }
    },

    // Re-resolve the menu after late-arriving state: `walletLinkEnabled`
    // lands with refresh()'s /api/auth/me response and the Homeroom-app
    // capability with the bridge's async probe, both of which can resolve
    // AFTER a cold-boot deep link has already painted. Without this the
    // menu would be missing those rows until the next navigation.
    _renderNavIfOpen() {
      if (!Settings._open) return;
      // A deep link that arrived before its section's gate opened (#2893):
      // finish it now, once, if the address still asks for that section —
      // a viewer who has since moved elsewhere is not pulled back.
      const want = Settings._pendingSection;
      if (want && Settings._visibleSections().some((s) => s.key === want)) {
        Settings._pendingSection = null;
        const hash = String((typeof location !== 'undefined' && location.hash) || '');
        if (hash === `#settings/${want}` || hash.startsWith(`#settings/${want}?`)) {
          Settings.route(want);
          return;
        }
      }
      Settings._renderNav();
      // A page that just became unavailable must not stay on screen.
      if (!Settings._visiblePages().some((p) => p.key === Settings._section)) {
        Settings.setSection(Settings._section);
      }
    },

    _renderDevConsoleSection() {
      const toggle = document.getElementById('dev-console-always-show');
      if (!toggle) return;
      const mode = window.DevConsole ? DevConsole.getMode() : 'errors-only';
      toggle.checked = mode === 'always';
    },

    // Home sections are permanent (#1801); the old widget visibility
    // settings, menu and endpoint are retired together.

    _renderLanguageSection() {
      const select = document.getElementById('settings-locale');
      if (!select) return;
      const value = this.state.locale || '';
      this._appendLiveLanguages(select);
      this._pruneLiveLanguages(select);
      // A saved value outside the shipped list (chosen when the picker
      // listed more, or set via the API) still needs to render truthfully:
      // inject an option for it, under the language's own name, so the
      // select doesn't silently show "Auto".
      if (value && ![...select.options].some((o) => o.value === value)) {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = window.PlatformI18n?.languageName?.(value) || value;
        select.appendChild(opt);
      }
      select.value = value;
      const status = document.getElementById('settings-locale-status');
      if (status) { status.classList.add('hidden'); status.textContent = ''; }
      this._renderTimeZoneSection();
    },

    // #6479: the Time zone list under the language. The pane renders only
    // the Auto option; the world's zones are added here once, from the
    // browser's own list, labelled "Region / City". A saved zone the list
    // lacks (an older engine) is added too, so the select never reads "Auto"
    // for a zone that is set.
    _renderTimeZoneSection() {
      const select = document.getElementById('settings-timezone');
      if (!select) return;
      const i18n = window.PlatformI18n;
      const label = (zone) => (i18n.timeZoneLabel ? i18n.timeZoneLabel(zone) : zone);
      this._labelTimeZoneAuto();
      if (select.options.length <= 1) {
        let zones = [];
        try { zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []; } catch { zones = []; }
        // The browsers' list leaves UTC out (it is no region's zone), and
        // somebody who keeps their clock in it must be able to pick it.
        const all = [...new Set(['UTC', ...zones])].sort();
        const frag = document.createDocumentFragment();
        for (const zone of all) {
          const opt = document.createElement('option');
          opt.value = zone;
          opt.textContent = label(zone);
          frag.appendChild(opt);
        }
        select.appendChild(frag);
      }
      // A save in flight decides what the list shows when it lands.
      if (this._timeZoneSaving) return;
      const value = this.state.timeZone || '';
      this._ensureTimeZoneOption(select, value);
      select.value = value;
      const status = document.getElementById('settings-timezone-status');
      if (status) { status.classList.add('hidden'); status.textContent = ''; }
    },

    // A zone the list does not offer still shows as itself, never as a blank
    // or as "Auto": one saved from an engine that knew it, or the server's
    // canonical spelling of a pick (its Intl may say Europe/Kiev where this
    // browser listed Europe/Kyiv).
    _ensureTimeZoneOption(select, value) {
      if (!value || [...select.options].some((o) => o.value === value)) return;
      const i18n = window.PlatformI18n;
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = i18n.timeZoneLabel ? i18n.timeZoneLabel(value) : value;
      select.appendChild(opt);
    },

    // The Auto option's words, with the device's zone in them. The option is
    // the pane's own (rendered empty, so the first render is the same on every
    // device); this writes its text, again whenever the language changes,
    // and touches nothing else, so a status line under the list stays.
    _labelTimeZoneAuto() {
      const auto = document.getElementById('settings-timezone')?.options[0];
      if (!auto) return;
      const i18n = window.PlatformI18n;
      const device = i18n.deviceTimeZone ? i18n.deviceTimeZone() : '';
      auto.textContent = i18n.t('settings:timezone.auto', { zone: i18n.timeZoneLabel ? i18n.timeZoneLabel(device) : device });
    },

    // A language the server's translation cache offers that this build's
    // catalogs do not (lib/i18n/runtime.ts getLanguages), under its own name,
    // after the ones the pane lists. The tags it has added are remembered
    // across renders, so a later render can take back exactly what it added:
    // the fresh list may no longer offer a language this page's older one did.
    _appendLiveLanguages(select) {
      // Request 7165: a page in English boots without the server's list of
      // languages, which this pane lists from. Ask for it while Settings is
      // open; `homeroom:languages-changed` draws this again when it arrives.
      if (Settings._open) {
        try { window.PlatformI18n?.ensureLiveLanguages?.(); } catch { /* no runtime: the build's languages stand */ }
      }
      this._liveLanguageTags ||= new Set();
      for (const { tag, name } of window.PlatformI18n?.getLanguages?.() || []) {
        if ([...select.options].some((o) => o.value === tag)) continue;
        const opt = document.createElement('option');
        opt.value = tag;
        opt.textContent = name;
        select.appendChild(opt);
        this._liveLanguageTags.add(tag);
      }
    },

    // Takes back a live-added option the current list no longer names. The
    // pane's own options and the saved value's are never touched.
    _pruneLiveLanguages(select) {
      const offered = new Set([...(window.PlatformI18n?.getLanguages?.() || []).map((l) => l.tag)]);
      for (const tag of this._liveLanguageTags || []) {
        if (offered.has(tag)) continue;
        const opt = [...select.options].find((o) => o.value === tag);
        if (opt) opt.remove();
        this._liveLanguageTags.delete(tag);
      }
    },

    // Does the CLI-credentials surface exist in this deployment?
    //
    // The whole /api/me/cli-tokens + /api/cli/* family is 404'd in a
    // staging preview (routes/cli-auth.js gates it — unreviewed PR code
    // must never mint CLI tokens). The 404 branch in _loadCliTokens
    // already handles that gracefully in JS, but the REQUEST ITSELF is
    // the problem: a failed fetch is an error line in the page console
    // no matter how the app handles it, and the proposal checks fail any
    // route that logs one. So we ask first and skip the fetch entirely.
    //
    // Deployment-constant, so it resolves at most once per page load.
    // Unknown / unreachable / a shell older than the flag all answer
    // TRUE — the behaviour is then exactly what it was before this
    // helper existed, with the 404 branch as the backstop. Only an
    // explicit `false` from the server suppresses the request.
    _cliAuthPromise: null,

    // The answer is a field of the session user, which the shell's boot read
    // already carries, so the gate joins that read (_readMe) and never sends
    // its own (#6591). Opening Settings from a page load ran this before
    // refresh() had primed the memo, and asked /api/auth/me a second time
    // beside the boot's. No answer (signed out, or a failed read) is TRUE,
    // as a status that was not ok always was.
    _cliAuthAvailable() {
      if (!this._cliAuthPromise) {
        this._cliAuthPromise = (async () => {
          try {
            const j = await this._readMe('');
            if (!j) return true;
            return j.user?.cliAuthEnabled !== false;
          } catch { return true; }
        })();
      }
      return this._cliAuthPromise;
    },

    // The two read-only CLI credential fixtures the staging server knows:
    // rows for the everyday review route, or #1609's instruction-rich empty
    // state. All boolean callers use _cliTokensDemo(); the credential fetch
    // also needs the exact value so it can select the right fixture.
    _cliTokensDemoValue() {
      try {
        const flag = new URLSearchParams(window.location.search).get('demo');
        return flag === '1' || flag === 'cli-empty' ? flag : null;
      } catch { return null; }
    },

    _cliTokensDemo() {
      return this._cliTokensDemoValue() !== null;
    },

    // ── Claude & ChatGPT connectors ──────────────────────────────────────
    //
    // Same shape as the CLI-credentials block below: a load-generation
    // guard so a slow response can't repaint stale credential state over a
    // fresh one, and the page's ?demo= flag passed through (mcp_tokens and
    // mcp_connector_hints are both staging:private, so a staging clone would
    // render an empty list and a status line with nothing to say).

    // Wider than _cliTokensDemo above, because this panel has six reviewable
    // states rather than one: `1` is the everyday mixed state and the
    // `connectors-*` values each pin one of the others. Anything else is not
    // passed on. The server only honours any of it in staging.
    _connectorsDemo() {
      try {
        const flag = new URLSearchParams(window.location.search).get('demo');
        if (flag === '1' || (flag && flag.startsWith('connectors-'))) return flag;
        return null;
      } catch { return null; }
    },

    // Pressing Test connection. Read-only, and nothing is kept: every press
    // is a fresh test and the line goes away with the page.
    //
    // The SERVER runs every leg it can. A leg it could not reach over its own
    // public origin comes back 'unknown', and this settles that one with a
    // same-origin fetch — the origin the address field shows is the page's
    // own, which is exactly what a browser here can reach.
    async _testConnector() {
      const btn = document.getElementById('connector-url-test');
      const status = document.getElementById('connector-test-status');
      if (!btn || !status) return;

      // A load-generation guard, like _connectorLoadId: a slow answer must
      // never repaint over a newer test's.
      const runId = (this._connectorTestRun || 0) + 1;
      this._connectorTestRun = runId;
      const current = () => this._connectorTestRun === runId;

      btn.disabled = true;
      btn.textContent = tr('settings:connectors.test.running');
      status.textContent = '';
      status.classList.add('hidden');
      status.classList.remove(...STATUS_PALETTE.error);

      let result = null;
      try {
        const demo = this._connectorsDemo();
        const suffix = demo ? `?demo=${encodeURIComponent(demo)}` : '';
        const response = await fetch(`/api/me/connectors/test${suffix}`, {
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { accept: 'application/json' },
        });
        // Staging, and a deployment with connectors switched off, answer 404
        // through the surface gate.
        if (response.status === 404) result = { code: 'unavailable_here', enabled: false };
        else if (!response.ok) result = { code: 'test_failed' };
        else result = await response.json();
      } catch {
        result = { code: 'test_failed' };
      }
      if (!current()) return;
      if (!result) result = { code: 'test_failed' };

      if (result.discovery === 'unknown' || result.mcp === 'unknown') {
        result = await this._settleConnectorTest(result);
        if (!current()) return;
      }

      const KNOWN = [
        'ok', 'not_connected', 'connection_expired', 'unavailable_here',
        'discovery_failed', 'server_unreachable', 'test_failed',
      ];
      const code = KNOWN.indexOf(result.code) !== -1 ? result.code : 'test_failed';
      const connection = result.connection || {};
      const params = {};
      let id = `settings:connectors.test.result.${code}`;
      if (code === 'ok') {
        // The same product name the Connected list shows, and the same date
        // format it uses.
        params.product = connection.client_name || tr('settings:connectors.test.unknownProduct');
        if (connection.last_used_at) {
          params.lastUsed = stamp(connection.last_used_at);
          id = 'settings:connectors.test.result.okUsed';
        } else {
          id = 'settings:connectors.test.result.ok';
        }
      }

      paintStatus(status, tr(id, params), code === 'ok' ? 'info' : 'error');
      btn.disabled = false;
      btn.textContent = tr('settings:connectors.test.button');
    },

    // The browser's half of a test: only the legs the server reported as
    // 'unknown' are tried, and only against the page's own origin. A network
    // failure here is the one thing the person can act on, so it becomes
    // test_failed rather than a claim about the server.
    async _settleConnectorTest(result) {
      const origin = window.location.origin;
      const probe = async (fn) => {
        try {
          const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout
            ? AbortSignal.timeout(3000)
            : undefined;
          return await fn(signal);
        } catch { return 'unknown'; }
      };

      if (result.discovery === 'unknown') {
        result.discovery = await probe(async (signal) => {
          const headers = { accept: 'application/json' };
          const [resource, issuer] = await Promise.all([
            fetch(`${origin}/.well-known/oauth-protected-resource/mcp`, {
              headers, credentials: 'same-origin', cache: 'no-store', signal,
            }),
            fetch(`${origin}/.well-known/oauth-authorization-server`, {
              headers, credentials: 'same-origin', cache: 'no-store', signal,
            }),
          ]);
          if (!resource.ok || !issuer.ok) return 'failed';
          const [resourceDoc, issuerDoc] = await Promise.all([
            resource.json().catch(() => null),
            issuer.json().catch(() => null),
          ]);
          return resourceDoc && issuerDoc
            && resourceDoc.resource === `${origin}/mcp`
            && issuerDoc.issuer === origin
            ? 'ok'
            : 'failed';
        });
      }

      if (result.mcp === 'unknown') {
        result.mcp = await probe(async (signal) => {
          const response = await fetch(`${origin}/mcp`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            cache: 'no-store',
            body: '{}',
            signal,
          });
          const challenge = (response.headers && response.headers.get
            ? response.headers.get('www-authenticate')
            : '') || '';
          return response.status === 401
            && challenge.startsWith('Bearer')
            && challenge.indexOf('resource_metadata=') !== -1
            ? 'ok'
            : 'failed';
        });
      }

      const connection = result.connection || {};
      if (result.discovery === 'unknown' || result.mcp === 'unknown') {
        result.code = 'test_failed';
      } else {
        result.code = result.discovery === 'failed' ? 'discovery_failed'
          : result.mcp === 'failed' ? 'server_unreachable'
            : !connection.active && !connection.inactive ? 'not_connected'
              : !connection.active ? 'connection_expired'
                : 'ok';
      }
      return result;
    },

    // ── Rewriting the allow rules for a different connector name ─────────
    //
    // The two blocks ship covering `homeroom` and `Homeroom` plus the
    // pre-rename `usernode` and `Usernode`. Anything else — a typo like the `Uesrnode`
    // from #1218, or a name someone simply chose — needs the same rules with
    // that segment, and asking a user to hand-edit six JSON strings is asking
    // for a seventh mistake. So the page does the edit.
    //
    // The rules are rebuilt from the SHAPE of the rendered block rather than
    // from a second template kept here: the prerendered default is parsed
    // once, its tool suffixes are read off it, and a rewrite re-emits those
    // suffixes under the typed segment. A rule added to READ_ONLY_ALLOW_RULES
    // reaches this field with no edit in this file.
    //
    // textContent throughout, never innerHTML — the value being written comes
    // from a text input.
    /**
     * Wire one Copy button (#1290).
     *
     * Three of them live on this screen — the connector URL and the two
     * allow-rule blocks — and before this they were three ad-hoc handlers
     * that each got something wrong: the URL one wrote 'Copied' even when
     * `writeText` had rejected, none of them went through
     * `PlatformUI.copyText` (so an insecure origin or a locked-down webview
     * failed silently instead of taking the execCommand fallback every other
     * copy on the platform gets), none toasted, and none held onto the reset
     * timer, so a second press cut the first press's confirmation short.
     *
     * `read` and `selectOnFail` are called at CLICK time so the source can
     * change under the button — which it does: the name-spelling field
     * rewrites both <pre> blocks in place.
     *
     * textContent only, never innerHTML: these buttons are rendered by
     * Shell.tsx and a glyph would need markup React owns.
     *
     * `successMessage` and `failureMessage` are message ids, read at click
     * time.
     */
    _wireCopyControl(buttonId, { read, successMessage, failureMessage, selectOnFail }) {
      const btn = document.getElementById(buttonId);
      if (!btn) return;
      let resetTimer = null;
      btn.addEventListener('click', async () => {
        const text = read();
        if (text == null) return;
        const ok = window.PlatformUI && PlatformUI.copyText
          ? await PlatformUI.copyText(text)
          : await (async () => {
            try {
              await navigator.clipboard.writeText(text);
              return true;
            } catch {
              return false;
            }
          })();
        if (!ok && selectOnFail) {
          // Leave the text selected so Ctrl/Cmd-C still works.
          try { selectOnFail(); } catch {}
        }
        if (window.PlatformUI && PlatformUI.toast) {
          PlatformUI.toast(tr(ok ? successMessage : failureMessage),
            ok ? {} : { error: true });
        }
        btn.textContent = ok ? tr('core:common.copied') : tr('settings:copyControl.failed');
        if (resetTimer) clearTimeout(resetTimer);
        resetTimer = setTimeout(() => {
          resetTimer = null;
          // The label React rendered for it, in the language now on screen.
          btn.textContent = tr('core:common.copy');
        }, 1500);
      });
    },

    _wireConnectorNameSpelling() {
      const field = document.getElementById('connector-name-spelling');
      if (!field) return;
      const blocks = ['connector-allow-rules', 'connector-repo-allow-rules']
        .map((id) => document.getElementById(id))
        .filter(Boolean);
      if (!blocks.length) return;

      // Captured before anything is written: this is the canonical answer,
      // and the fallback for an empty or unusable field.
      const canonical = blocks[0].textContent;
      let suffixes = [];
      let covered = new Set();
      try {
        const allow = JSON.parse(canonical)?.permissions?.allow || [];
        suffixes = [...new Set(allow.map((rule) => rule.slice(rule.indexOf('__', 5) + 2)))];
        // The spellings the shipped block ALREADY covers, read out of the
        // block itself for the same reason the suffixes are: a second copy
        // of the list here would be the thing that drifts. Typing any of
        // them means there is nothing to rewrite — including the spellings
        // that predate the rename, which a long-connected user is still on.
        covered = new Set(allow.map((rule) => rule.split('__')[1].toLowerCase()));
      } catch {
        suffixes = [];
        covered = new Set();
      }

      const render = () => {
        // Only what a permission rule's server segment can hold. `__` is the
        // separator itself, so a name containing one would silently produce a
        // rule for a different tool — those characters are dropped, not
        // escaped, and the result is shown so the user can see what happened.
        const name = String(field.value || '').trim().replace(/[^A-Za-z0-9.-]/g, '');
        const custom = name && !covered.has(name.toLowerCase()) && suffixes.length;
        const text = custom
          ? JSON.stringify(
            { permissions: { allow: suffixes.map((s) => `mcp__${name}__${s}`) } }, null, 2
          )
          : canonical;
        for (const block of blocks) block.textContent = text;
      };
      field.addEventListener('input', render);
    },

    async _loadConnectors() {
      const section = document.getElementById('connectors-section');
      const status = document.getElementById('connectors-status');
      if (!section || !status) return;

      // The connector URL is derived from the origin the SPA is served
      // from, so a self-hosted fork shows its own.
      const urlField = document.getElementById('connector-url');
      const connectorUrl = `${window.location.origin}/mcp`;
      if (urlField) urlField.value = connectorUrl;

      // The ChatGPT walkthrough states the URL in its own step rather than
      // pointing back at #connector-url. It carries the same derived origin
      // the field shows, filled here the way the Codex blocks below are:
      // the prerendered interior ships a fill-in placeholder, and a fork or
      // a config change cannot leave a stale host behind.
      const stepUrl = document.querySelector('#connectors-section [data-connector-step-url]');
      if (stepUrl) stepUrl.textContent = connectorUrl;

      // The ticks answer from this device alone, so they do not wait on the
      // fetch, and a failed one cannot leave another account's ticks showing.
      this._connectorSteps = this._connectorStepsRead() || this._connectorSteps;
      this._renderConnectorProgress();

      // #1607: the "set it up in <product>" links open a new chat pre-loaded
      // with the job. Built HERE, from the same derived origin the field
      // shows, so a fork or a config change cannot leave a hardcoded URL
      // behind — the rule the written steps already follow by pointing back
      // at #connector-url rather than naming a host.
      //
      // The prompt carries the two things people get wrong: that Homeroom
      // uses dynamic client registration (so there is no client ID or secret
      // to go looking for), and the exact name `homeroom`, which is what
      // Claude Code builds its permission rules from (#1218) and which one
      // account once mistyped, silently missing every rule the platform
      // ships.
      //
      // Deliberately short. It is a query string, and nothing secret is in
      // it: the connector URL is a public endpoint and the authorisation
      // happens through OAuth inside the product, not in this link.
      const chatPrompt = tr('settings:connectors.setupPrompt', { url: connectorUrl });
      const chatLinks = [
        ['connector-open-claude', 'https://claude.ai/new?q='],
        ['connector-open-chatgpt', 'https://chatgpt.com/?q='],
      ];
      for (const [id, base] of chatLinks) {
        const link = document.getElementById(id);
        if (link) link.href = `${base}${encodeURIComponent(chatPrompt)}`;
      }

      // #1892: the Codex CLI blocks ship with a placeholder where the URL
      // goes, for the same reason the steps point at #connector-url instead
      // of naming a host. Swap it for the derived value here, by textContent
      // and never innerHTML. Idempotent: once swapped, the placeholder is
      // gone and a re-render finds nothing to replace.
      const CODEX_URL_PLACEHOLDER = 'https://<your-homeroom-host>/mcp';
      for (const id of ['connector-codex-add', 'connector-codex-config']) {
        const block = document.getElementById(id);
        if (block && block.textContent.includes(CODEX_URL_PLACEHOLDER)) {
          block.textContent = block.textContent.split(CODEX_URL_PLACEHOLDER).join(connectorUrl);
        }
      }

      this._connectorLoadId = (this._connectorLoadId || 0) + 1;
      const loadId = this._connectorLoadId;
      this._publishConnectors({ phase: 'loading', tools: [] });
      status.classList.add('hidden');

      try {
        const demoFlag = this._connectorsDemo();
        const demoQ = demoFlag ? `?demo=${encodeURIComponent(demoFlag)}` : '';
        const response = await fetch(`/api/me/connectors${demoQ}`, {
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (loadId !== this._connectorLoadId) return;
        if (response.status === 404) {
          // The connector surface is production-only; hide rather than
          // showing a section that can't work here.
          section.classList.add('hidden');
          this._setNavStatus('connectors', null);
          return;
        }
        if (!response.ok) throw new Error(tr('settings:connectors.load.failed'));
        const data = await response.json();
        if (!data || !Array.isArray(data.connectors)) {
          throw new Error(tr('settings:connectors.load.invalid'));
        }
        section.classList.remove('hidden');
        this._connectors = data.connectors;
        // Live connections only: an expired row is news on its card, not
        // something this account has connected.
        this._setNavStatus('connectors', data.connectors.filter((c) => this._connectorIsLive(c)).length);
        this._connectorHint = data.hint || null;
        this._renderConnectors();
      } catch (err) {
        if (loadId !== this._connectorLoadId) return;
        // A failed reload says nothing rather than an old count.
        this._setNavStatus('connectors', null);
        this._publishConnectors({ phase: 'idle', tools: [] });
        status.textContent = err.message || tr('settings:connectors.load.failed');
        status.classList.remove('hidden', 'text-emerald-700', 'dark:text-emerald-400');
        status.classList.add('text-red-700', 'dark:text-red-400');
      }
    },

    // A connection still working, as opposed to one whose sign-in ran out and
    // that the server lists so its tool's card can say so (#6134).
    _connectorIsLive(connector) {
      return connector.status !== 'expired';
    },

    // Which card a connection sits on (#6134). Like _connectorFamilies below,
    // this reads a name the client chose, so it only decides where to DRAW a
    // row. Codex has its own card here and stays in the ChatGPT family there:
    // the family decides advice about permission prompts, which Codex shares.
    _connectorTool(name) {
      const lower = String(name || '').toLowerCase();
      if (/claude|anthropic/.test(lower)) return 'claude';
      if (/codex/.test(lower)) return 'codex';
      if (/chatgpt|openai/.test(lower)) return 'chatgpt';
      return 'generic';
    },

    // What a connection was approved for, from the two scopes consent offers
    // (services/mcp-connect-constants.js). An expired one says what it COULD do.
    _connectorCapabilities(connector, expired) {
      const scopes = Array.isArray(connector.scopes) ? connector.scopes : [];
      const read = scopes.includes('usernode:apps:read');
      const write = scopes.includes('usernode:proposals:write');
      if (expired) {
        if (read && write) return tr('settings:connectors.capabilities.expiredReadWrite');
        if (read) return tr('settings:connectors.capabilities.expiredRead');
        return write ? tr('settings:connectors.capabilities.expiredWrite') : null;
      }
      if (read && write) return tr('settings:connectors.capabilities.readWrite');
      if (read) return tr('settings:connectors.capabilities.read');
      return write ? tr('settings:connectors.capabilities.write') : null;
    },

    // One connection's row on its card: one whole line per case of what is
    // known, in the date format this page uses everywhere.
    _connectorRowView(connector) {
      const when = (value) => (value && Number.isFinite(Date.parse(value))
        ? stamp(value) : null);
      const expired = !this._connectorIsLive(connector);
      const connected = when(connector.connected_at);
      const lastUsed = when(connector.last_used_at);
      const ranOut = when(connector.expired_at);
      // Reconnect only where a guide step really signs in again (#6137).
      const reconnect = expired && !!this.CONNECTOR_RECONNECT_STEP[this._connectorTool(connector.client_name)];
      let detail;
      if (reconnect) {
        detail = ranOut
          ? tr('settings:connectors.row.expiredReconnect', { when: ranOut })
          : tr('settings:connectors.row.expiredReconnectUnknownDate');
      } else if (expired) {
        detail = ranOut
          ? tr('settings:connectors.row.expired', { when: ranOut })
          : tr('settings:connectors.row.expiredUnknownDate');
      } else if (lastUsed) detail = tr('settings:connectors.row.lastActive', { lastUsed });
      else if (connected) detail = tr('settings:connectors.row.notUsedYet', { connected });
      else detail = tr('settings:connectors.row.unknownDate');
      // The person's own name for it leads when there is one (#6137), and the
      // tool's name moves to the line under it so the row still says what it is.
      const toolName = connector.client_name || tr('settings:connectors.row.unnamedClient');
      const label = typeof connector.label === 'string' && connector.label.trim() ? connector.label.trim() : null;
      return {
        id: String(connector.id),
        title: label || toolName,
        label,
        toolName,
        detail,
        capabilities: this._connectorCapabilities(connector, expired),
        reconnect,
      };
    },

    // The four cards, in the page's order. A card says its best state: one
    // working connection beside an expired one still reads Working, and the
    // expired row carries its own line.
    _connectorToolViews(connectors) {
      return ['claude', 'chatgpt', 'codex', 'generic'].map((key) => {
        const held = connectors.filter((c) => this._connectorTool(c.client_name) === key);
        const live = held.filter((c) => this._connectorIsLive(c));
        let status = 'none';
        if (live.some((c) => c.last_used_at)) status = 'working';
        else if (live.length) status = 'unused';
        else if (held.length) status = 'attention';
        const connections = held.map((c) => this._connectorRowView(c));
        // Two rows with one name ("Claude" and "Claude") say nothing about
        // which is which (phone review #126): each gets its place in the
        // card after the name, and the line under it its dates.
        const seen = {};
        for (const row of connections) seen[row.title] = (seen[row.title] || 0) + 1;
        const nth = {};
        for (const row of connections) {
          if (seen[row.title] < 2) continue;
          nth[row.title] = (nth[row.title] || 0) + 1;
          row.title = tr('settings:connectors.row.sameName', { name: row.title, number: nth[row.title] });
        }
        return { key, status, connections };
      });
    },

    // Which of the three "stop the prompts" cases apply to what is actually
    // connected. Substring matching on the registered client name, which is
    // attacker-choosable and often just a product name — so this only ever
    // decides what to SHOW, never what to allow, and anything it cannot place
    // falls back to showing every case.
    _connectorFamilies(connectors) {
      let claude = false;
      let chatgpt = false;
      let unknown = false;
      for (const connector of connectors) {
        const name = String(connector.client_name || '').toLowerCase();
        if (/claude|anthropic/.test(name)) claude = true;
        else if (/chatgpt|openai|codex/.test(name)) chatgpt = true;
        else unknown = true;
      }
      return { claude, chatgpt, unknown };
    },

    // The Claude Code cases are hidden only when EVERY connection is a
    // ChatGPT-family one, where they are advice about a file that product
    // does not read. They stay up for a Claude-family name because that name
    // does not distinguish claude.ai chat from Claude Code — both arrive as
    // some spelling of "Claude" — so hiding them there would hide the fix
    // from the surface that needs it.
    _renderConnectorCases(connectors) {
      const { claude, unknown } = this._connectorFamilies(connectors);
      const claudeCode = !connectors.length || unknown || claude;
      for (const id of ['connector-case-cc-local', 'connector-case-cc-web']) {
        const node = document.getElementById(id);
        if (node) node.classList.toggle('hidden', !claudeCode);
      }
    },

    // The read-only tip status. There is no control next to it: arming
    // happens when a chat client opens a session (services/mcp-hint-throttle.js),
    // so "open a new chat" is the reset, and a button here would only be a
    // way to make the connector nag.
    _renderConnectorHint(connectors) {
      const line = document.getElementById('connector-hint-status');
      if (!line) return;
      const hint = this._connectorHint;
      const { claude, unknown } = this._connectorFamilies(connectors);
      // No line at all in two cases: no status to report, and a connection
      // set that is entirely ChatGPT-family. The tip is suppressed for that
      // family — there are no per-call prompts there to stop — so "not shown
      // yet" would read as a promise that one is coming, and a count would
      // report a budget that will never be spent.
      if (!hint || (connectors.length && !claude && !unknown)) {
        line.textContent = '';
        line.classList.add('hidden');
        return;
      }
      const shown = Number(hint.shownThisWindow) || 0;
      const cap = Number(hint.maxPerWindow) || 0;
      const days = Number(hint.windowDays) || 0;

      let text;
      if (!shown) {
        text = tr('settings:connectors.hint.notSentYet');
      } else {
        // Two whole sentences: how often the tip was sent, then why it is not
        // showing now. Each is one message; hint.summaryAndAdvice orders them.
        const summary = Number.isFinite(Date.parse(hint.lastShownAt))
          ? tr('settings:connectors.hint.sent', { count: shown, days, when: stamp(hint.lastShownAt) })
          : tr('settings:connectors.hint.sentWhenUnknown', { count: shown, days });
        let advice;
        // Three different answers to "why am I not seeing it", and they are
        // not interchangeable: the budget is spent (comes back next week),
        // the hour since the last one has not passed (comes back shortly), or
        // neither (open a new conversation). Saying "open a new conversation"
        // during the quiet hour is advice that does not work, which is worse
        // than saying nothing.
        const cooldown = Number(hint.cooldownMinutes) || 0;
        const shownAt = Date.parse(hint.lastShownAt);
        const quietUntil = cooldown && Number.isFinite(shownAt)
          ? shownAt + cooldown * 60 * 1000
          : 0;
        if (cap && shown >= cap) {
          advice = tr('settings:connectors.hint.limitReached', { limit: cap, days });
        } else if (quietUntil > Date.now()) {
          // #1808: a bare "12:20 AM" here can be TOMORROW's. The cooldown
          // runs from the last tip, so one sent late in the evening puts the
          // deadline past midnight, and a reader comparing it to the clock
          // concludes the window has already passed. A day word settles it,
          // and anything further out gets the whole stamp.
          const end = new Date(quietUntil);
          const dayOf = (d) => {
            const z = window.PlatformI18n?.zonedDay ? window.PlatformI18n.zonedDay(d) : null;
            return z ? `${z.year}-${z.month}-${z.day}` : d.toDateString();
          };
          advice = dayOf(end) === dayOf(new Date())
            ? tr('settings:connectors.hint.quietUntilToday', { minutes: cooldown, time: end.toLocaleTimeString(undefined, inZone()) })
            : tr('settings:connectors.hint.quietUntilDate', { minutes: cooldown, when: stamp(end) });
        } else {
          advice = tr('settings:connectors.hint.openNewConversation');
        }
        text = tr('settings:connectors.hint.summaryAndAdvice', { summary, advice });
      }
      line.textContent = text;
      line.classList.remove('hidden');
    },

    // Publish the connector cards. The markup is ./connectors-list.tsx's; the
    // date formats and the sorting onto cards are resolved here, where the
    // payload is.
    _publishConnectors(next) {
      const bridge = (typeof window !== 'undefined' && window.UsernodeReact)
        ? window.UsernodeReact.settingsConnectors : null;
      if (bridge) bridge.publish(next);
    },

    _renderConnectors() {
      const all = this._connectors || [];
      const connectors = all.filter((c) => this._connectorIsLive(c));
      // Two SIBLINGS of the cards, both still this module's: the static "stop
      // the prompts" prose blocks, whose visibility follows which client
      // families are connected, and the read-only tip status. Both are about
      // what is connected now, so an expired row counts for neither.
      this._renderConnectorCases(connectors);
      this._renderConnectorHint(connectors);
      this._publishConnectors({ phase: 'ready', tools: this._connectorToolViews(all) });
    },

    // ── Ticking off the setup steps (#6136) ──────────────────────────────
    //
    // The tick buttons and progress lines are static markup React rendered once
    // (connector-setup-steps.tsx, sections/connectors.tsx), and this module owns
    // their `aria-pressed`, `hidden` and text. Nothing here writes a class: the
    // done look is `group-aria-pressed:` on a constant class string.
    //
    // this._connectorSteps is what the buttons show. Storage only follows it, so
    // ticks still work for the visit where storage throws or nobody is signed in.

    // The stored map, cleaned: positive whole step numbers under the four
    // guides. Unparseable JSON is empty; null means storage itself refused.
    _connectorStepsRead() {
      let raw;
      try { raw = localStorage.getItem(Settings.CONNECTOR_STEPS_KEY); } catch { return null; }
      const clean = Object.create(null);
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch { /* treated as empty */ }
      if (!parsed || typeof parsed !== 'object') return clean;
      for (const account of Object.keys(parsed)) {
        const guides = parsed[account];
        if (!guides || typeof guides !== 'object') continue;
        const kept = Object.create(null);
        for (const guide of ['claude', 'chatgpt', 'codex', 'generic']) {
          if (!Array.isArray(guides[guide])) continue;
          const steps = [...new Set(guides[guide])].filter((n) => Number.isInteger(n) && n > 0);
          if (steps.length) kept[guide] = steps;
        }
        if (Object.keys(kept).length) clean[account] = kept;
      }
      return clean;
    },

    _connectorStepsWrite(map) {
      try {
        if (Object.keys(map).length) localStorage.setItem(Settings.CONNECTOR_STEPS_KEY, JSON.stringify(map));
        else localStorage.removeItem(Settings.CONNECTOR_STEPS_KEY);
      } catch { /* storage unavailable: the ticks last this visit */ }
    },

    // Whose ticks these are. With nobody signed in they live under '' for the
    // visit and are never saved.
    _connectorStepsAccount() {
      const id = typeof App !== 'undefined' && App.user ? App.user.id : null;
      return id == null ? '' : String(id);
    },

    // #6136: the MCP server URL again, from the ChatGPT step that asks for it.
    // Read at click time because _loadConnectors fills the step after this runs.
    _wireConnectorStepCopy() {
      const stepUrl = () => document.querySelector('#connectors-section [data-connector-step-url]');
      this._wireCopyControl('connector-chatgpt-url-copy', {
        read: () => {
          const code = stepUrl();
          return code ? code.textContent : null;
        },
        successMessage: 'settings:connectors.copy.urlCopied',
        failureMessage: 'settings:connectors.copy.urlFailed',
        selectOnFail: () => {
          const code = stepUrl();
          const selection = window.getSelection && window.getSelection();
          if (!code || !selection) return;
          const range = document.createRange();
          range.selectNodeContents(code);
          selection.removeAllRanges();
          selection.addRange(range);
        },
      });
    },

    _wireConnectorStepTicks() {
      const section = document.getElementById('connectors-section');
      if (!section) return;
      section.addEventListener('click', (event) => {
        const tick = event.target && event.target.closest
          ? event.target.closest('[data-connector-step-tick]') : null;
        if (!tick) return;
        const [guide, number] = tick.getAttribute('data-connector-step-tick').split(':');
        const step = Number(number);
        const account = this._connectorStepsAccount();
        const map = this._connectorSteps || (this._connectorSteps = Object.create(null));
        const guides = map[account] || (map[account] = Object.create(null));
        const steps = guides[guide] || [];
        const next = steps.includes(step) ? steps.filter((n) => n !== step) : [...steps, step];
        if (next.length) guides[guide] = next;
        else delete guides[guide];
        if (!Object.keys(guides).length) delete map[account];
        if (account) this._connectorStepsWrite(map);
        this._renderConnectorProgress();
      });
    },

    // Paint every tick and progress line for the account on this device. A
    // stored step above a guide's current total counts for nothing, so a guide
    // that loses a step cannot read "7 of 6".
    _renderConnectorProgress() {
      const guides = (this._connectorSteps || {})[this._connectorStepsAccount()] || {};
      for (const tick of document.querySelectorAll('[data-connector-step-tick]')) {
        const [guide, number] = tick.getAttribute('data-connector-step-tick').split(':');
        const done = (guides[guide] || []).includes(Number(number));
        tick.setAttribute('aria-pressed', done ? 'true' : 'false');
      }
      for (const line of document.querySelectorAll('[data-connector-progress]')) {
        const total = Number(line.getAttribute('data-total')) || 0;
        const done = (guides[line.getAttribute('data-connector-progress')] || [])
          .filter((n) => n <= total).length;
        line.hidden = done === 0;
        line.textContent = done ? tr('settings:connectors.progress.done', { done, total }) : '';
      }
    },

    // Reconnect on an expired row (#6137): the sign-in ran out, but the
    // connector is still set up in the tool, so the first-time walkthrough's
    // early steps are already done. This opens the tool's card and lands on
    // the one step that signs in again: Claude's "Connect" next to the
    // connector, and Codex's `codex mcp login`. Nothing is sent: a new consent
    // can only start from the tool itself.
    //
    // ChatGPT and other agents are left out on purpose. None of ChatGPT's four
    // steps is a sign-in (directory, create, URL, use), and the other-agent
    // guide's OAuth step describes discovery and scopes, not how to start a
    // sign-in again in whatever client someone configured. There is no step to
    // land on, and re-authorisation instructions nobody has checked would be
    // invented. Their expired rows keep the "follow the steps" line and no
    // Reconnect.
    CONNECTOR_RECONNECT_STEP: Object.freeze({ claude: 5, codex: 2 }),

    _reconnectConnector(tool) {
      const step = this.CONNECTOR_RECONNECT_STEP[tool];
      if (!step) return false;
      const card = document.querySelector(`#connector-tool-${tool} details`);
      if (card) card.open = true;
      const tick = document.querySelector(`[data-connector-step-tick="${tool}:${step}"]`);
      const target = (tick && typeof tick.closest === 'function' && tick.closest('li')) || tick || card;
      if (!target) return false;
      if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'center' });
      // Focus follows, so a keyboard or screen-reader user lands on the step
      // too. The tick is the step's one control; focusing it presses nothing.
      if (tick && typeof tick.focus === 'function') tick.focus({ preventScroll: true });
      return true;
    },

    async _disconnectConnector(id, button) {
      const status = document.getElementById('connectors-status');
      if (button) button.disabled = true;
      try {
        const response = await fetch(`/api/me/connectors/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (!response.ok && response.status !== 404) {
          throw new Error(tr('settings:connectors.disconnect.failedRetry'));
        }
        await this._loadConnectors();
        if (status) {
          status.textContent = tr('settings:connectors.disconnect.done');
          status.classList.remove('hidden', 'text-red-700', 'dark:text-red-400');
          status.classList.add('text-emerald-700', 'dark:text-emerald-400');
        }
      } catch (err) {
        if (button) button.disabled = false;
        if (status) {
          status.textContent = err.message || tr('settings:connectors.disconnect.failed');
          status.classList.remove('hidden', 'text-emerald-700', 'dark:text-emerald-400');
          status.classList.add('text-red-700', 'dark:text-red-400');
        }
      }
    },

    // Rename one connection (#6137). Resolves true when the name was saved, so
    // the row's editor closes, and false when it was not, so it stays open with
    // what was typed. An empty name clears it. A ?demo= fixture row is renamed
    // on the page only: no such connection exists for the server to rename.
    async _renameConnector(id, value) {
      const status = document.getElementById('connectors-status');
      const say = (text, ok) => {
        if (!status) return;
        status.textContent = text;
        status.classList.remove('hidden', ...(ok ? ['text-red-700', 'dark:text-red-400'] : ['text-emerald-700', 'dark:text-emerald-400']));
        status.classList.add(...(ok ? ['text-emerald-700', 'dark:text-emerald-400'] : ['text-red-700', 'dark:text-red-400']));
      };
      const label = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
      if (Array.from(label).length > Settings.CONNECTOR_LABEL_MAX) {
        say(tr('settings:connectors.rename.tooLong', { max: Settings.CONNECTOR_LABEL_MAX }), false);
        return false;
      }
      const done = () => say(label ? tr('settings:connectors.rename.done') : tr('settings:connectors.rename.cleared'), true);
      const row = (this._connectors || []).find((c) => String(c.id) === String(id));
      if (row && row.demo) {
        row.label = label || null;
        this._renderConnectors();
        done();
        return true;
      }
      try {
        const response = await fetch(`/api/me/connectors/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: label || null }),
        });
        if (!response.ok) throw new Error(tr('settings:connectors.rename.failedRetry'));
        await this._loadConnectors();
        done();
        return true;
      } catch (err) {
        say(err.message || tr('settings:connectors.rename.failedRetry'), false);
        return false;
      }
    },

    // ── Social account ownership proofs + Layer-1 credits ────────────────

    _socialIdentityDemoQuery() {
      try {
        const demo = new URLSearchParams(window.location.search).get('demo');
        if (demo === '1' || demo === 'identity-connected'
            || demo === 'identity-unverified' || demo === 'identity-legacy'
            || demo === 'identity-x-misconfigured' || demo === 'identity-replacement') {
          return `?demo=${encodeURIComponent(demo)}`;
        }
      } catch { /* ordinary production read */ }
      return '';
    },

    async _loadGithubLink() {
      const section = document.getElementById('github-link-section');
      if (!section) return;
      this._publishSocialIdentity({
        phase: 'loading', message: tr('core:common.loading'), tier: null, providers: [],
      });
      try {
        const response = await fetch(`/api/me/social-identities${this._socialIdentityDemoQuery()}`, {
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (response.status === 404) {
          section.classList.add('hidden');
          this._setNavStatus('socialIdentities', null);
          return;
        }
        if (!response.ok) throw new Error(`Social identity request failed (${response.status})`);
        const data = await response.json();
        if (!data || !data.providers || !data.entitlement) {
          throw new Error('Invalid social identity response');
        }
        section.classList.remove('hidden');
        // Keep the established property/method names: external-agent code
        // calls _loadGithubLink after attribution changes. The value is now
        // the provider-neutral response.
        this._githubLink = data;
        this._setNavStatus('socialIdentities', ['github', 'x']
          .filter((provider) => data.providers[provider] && data.providers[provider].linked).length);
        this._renderGithubLink();
      } catch {
        // A failed reload says nothing rather than an old count.
        this._setNavStatus('socialIdentities', null);
        this._publishSocialIdentity({
          phase: 'error',
          message: tr('settings:socialIdentity.load.failed'),
          tier: null,
          providers: [],
        });
        section.classList.remove('hidden');
      }
    },

    // Keep the connector panel and every profile surface on the same
    // post-mutation truth. The panel reads the provider-neutral status route;
    // the profile editor reads App.user.links, which comes from /api/auth/me.
    async _refreshSocialIdentitySurfaces() {
      await Promise.all([
        this._loadGithubLink(),
        (typeof window !== 'undefined' && window.Profile?._refreshUser)
          ? window.Profile._refreshUser()
          : Promise.resolve(),
      ]);
    },

    _publishSocialIdentity(next) {
      const bridge = (typeof window !== 'undefined' && window.UsernodeReact)
        ? window.UsernodeReact.settingsSocialIdentity : null;
      if (bridge) bridge.publish(next);
    },

    _renderGithubLink() {
      const status = document.getElementById('github-link-status');
      if (status) status.classList.add('hidden');
      const payload = this._githubLink || { providers: {}, entitlement: {} };
      const entitlement = payload.entitlement || {};
      this._publishSocialIdentity({
        phase: 'ready',
        message: null,
        tier: this._socialIdentityTierView(entitlement),
        providers: ['github', 'x'].map((provider) => this._socialIdentityRowView(
          provider,
          payload.providers[provider] || { provider, linked: false, available: false },
          entitlement,
          !!payload.demo,
          payload.providers
        )),
      });
      // A SIBLING of the block, and still this module's: it reports the OAuth
      // result carried in the hash query, which is about the navigation that
      // just happened rather than about the block's contents.
      this._socialIdentityCallbackStatus(status);
    },

    // The head row of the daily-credits list, in its five states. Every one
    // of them is a different answer to "how much can this account spend today,
    // and why", so the wording is decided here, next to the entitlement it
    // reads.
    //
    // #2370: this was a bordered card carrying a title and a sentence — "Layer
    // 1 locked · $0/day", then a paragraph explaining what would unlock it. It
    // is the FIRST ROW of one list now, and the rows under it are the things
    // that change the figure, so the relationship the paragraph described is
    // the layout instead. Three fields rather than two:
    //
    //   title   what this row is ("Signed in" on the ladder, "Your credits"
    //           where there is no ladder to stand on — never "Daily credits",
    //           which is the label the list already sits under)
    //   amount  the figure, or null where there honestly is none
    //   note    one sentence under the list, or null
    //   tone    'warn' for the one state that reports a fault. A locked ladder
    //           is NOT a warning — it is the thing to do next, and the rows
    //           under it say so — so the amber card it used to wear is gone.
    //
    // "Layer 1" is gone on purpose. It is the policy's name for the tier in
    // src/services/limits.js, and a reader has no Layer 0 or Layer 2 to place
    // it against.
    //
    // ONLY the two ladder states say "Signed in · $0 / week". On a deployment
    // whose policy is `legacy` (the default — see IDENTITY_CREDIT_POLICY) or
    // for an account with an administrator override, connecting an account
    // changes nothing about credits, and a list that implied otherwise would
    // be a false promise with a Connect button under it.
    //
    // #4913: the figure is the WEEKLY allowance (`weeklyLimitCents`). #2571
    // switched the per-user daily cap off, but this list went on printing
    // `limitCents`, the daily value nothing applies any more, as "$20 / day"
    // beside a $50 week. An entitlement that carries no weekly figure shows
    // none rather than a guessed one.
    _socialIdentityMoney(cents) {
      const value = Math.max(0, Number(cents) || 0) / 100;
      return tr('settings:socialIdentity.perWeek', { amount: Number.isInteger(value) ? value : value.toFixed(2) });
    },

    _socialIdentityTierView(entitlement) {
      const e = entitlement || {};
      const weekly = Number(e.weeklyLimitCents);
      const amount = e.weeklyLimitCents != null && Number.isFinite(weekly)
        ? this._socialIdentityMoney(weekly)
        : null;
      if (e.entitlementAvailable === false) {
        return {
          tone: 'warn',
          done: false,
          title: tr('settings:socialIdentity.tier.unavailable.title'),
          amount: null,
          note: tr('settings:socialIdentity.tier.unavailable.note'),
        };
      }
      // An administrator's weekly figure for this one account is the
      // override a reader can see, whatever the policy. A daily one changes
      // no figure any more; on the tiered ladder it still lets the account
      // past the identity gate, which is what `tier: 'override'` says there.
      // An account the tiered gate still holds back is on the ladder, weekly
      // figure or not: nothing is granted until it connects.
      if ((e.weeklySource === 'admin_override' && !e.verificationRequired)
        || (e.policy !== 'legacy' && e.tier === 'override')) {
        return {
          tone: 'plain',
          done: true,
          title: tr('settings:socialIdentity.tier.override.title'),
          amount,
          note: tr('settings:socialIdentity.tier.override.note'),
        };
      }
      if (e.policy === 'legacy') {
        return {
          tone: 'plain',
          done: true,
          title: tr('settings:socialIdentity.tier.legacy.title'),
          amount,
          note: tr('settings:socialIdentity.tier.legacy.note'),
        };
      }
      return {
        tone: 'plain',
        done: true,
        title: tr('settings:socialIdentity.tier.signedIn.title'),
        amount: this._socialIdentityMoney(0),
        note: tr('settings:socialIdentity.tier.signedIn.note'),
      };
    },

    // One provider row. Connection, provider verification, public visibility,
    // replacement confirmation and destructive disconnect stay separate.
    _socialIdentityRowView(provider, link, entitlement, demo, others) {
      const name = provider === 'github' ? 'GitHub' : 'X';
      const actionHref = (intent) => demo
        ? null
        : `/api/me/social-identities/${provider}/connect?intent=${intent}`;
      // #2370: `amount` is the row's figure on the ladder, and it is the
      // reason a row is worth tapping — "$10 / day" sits where "Not connected ·
      // connect X to unlock Layer 1" used to. Two rules keep it honest, both
      // from src/services/limits.js ("provider proofs replace one another;
      // they do not stack"):
      //
      //   * an UNLINKED row carries the figure only while the tier is still
      //     locked. Once one provider has unlocked it, a second "$10 / day"
      //     beside a Connect button reads as a further $10.
      //   * of two LINKED rows, only the first carries it, for the same reason.
      //
      // Off the ladder (`legacy`, an override, an unverifiable entitlement)
      // there is no figure at all, because connecting changes no figure.
      const tiered = entitlement.policy === 'tiered' && entitlement.tier !== 'override'
        && entitlement.entitlementAvailable !== false;
      // #4913: what connecting unlocks is the weekly allowance the account
      // is already resolved to (limits.js resolveWeeklyEntitlement): the
      // tiered gate only decides whether it is granted. Not the $10/day
      // TIER_ONE_LIMIT_CENTS literal, which no cap applies since #2571.
      const weekly = Number(entitlement.weeklyLimitCents);
      const unlock = entitlement.weeklyLimitCents != null && Number.isFinite(weekly) && weekly > 0
        ? this._socialIdentityMoney(weekly)
        : null;
      const firstLinked = provider === 'github' || !(others && others.github
        && others.github.linked && !others.github.reconnectRequired);
      let state;
      let amount = null;
      if (link.reconnectRequired) {
        state = {
          tone: 'amber',
          text: tr('settings:socialIdentity.row.reconnectRequired'),
        };
      } else if (link.linked && tiered) {
        state = { tone: 'muted', text: firstLinked ? '' : tr('settings:socialIdentity.row.noExtraCredits') };
        amount = firstLinked ? unlock : null;
      } else if (link.linked) {
        state = { tone: 'muted', text: '' };
      } else if (link.available === false) {
        state = { tone: 'muted', text: tr('settings:socialIdentity.row.notSetUp') };
      } else {
        state = { tone: 'muted', text: tiered && entitlement.verificationRequired ? '' : tr('settings:socialIdentity.row.notConnected') };
        amount = tiered && entitlement.verificationRequired ? unlock : null;
      }
      const offersConnect = (!link.linked || link.reconnectRequired) && link.available !== false;
      return {
        provider,
        name,
        // #2370: the title is the provider and nothing else, in every state, so
        // the list's left edge reads the same before and after connecting. The
        // handle moved to the second line: beside the badge and the chevron it
        // was the first thing a 390px row truncated.
        heading: name,
        handle: link.linked && link.handle ? `@${link.handle}` : null,
        // The leading mark: ticked once this row counts, an empty ring while
        // it is still something to do. A reconnect-needed link is NOT ticked,
        // for the reason the badge below is not "Connected".
        done: !!link.linked && !link.reconnectRequired,
        amount,
        // #1557: the durable half of "did that work?". The OAuth round trip
        // already writes a one-line result into #github-link-status, but that
        // line is transient, xs, and a sibling of this block — come back to
        // Settings a minute later and the only thing distinguishing a
        // connected account from an unconnected one was a sentence about
        // credit tiers. The badge says the state itself, on the row it is
        // about. A reconnect-required link is deliberately NOT "Connected":
        // it is linked for attribution and not yet credit-eligible, which is
        // the distinction the amber state text spells out.
        badge: link.reconnectRequired
          ? { text: tr('settings:socialIdentity.badge.reconnectNeeded'), tone: 'amber' }
          : (link.linked ? { text: tr('settings:socialIdentity.badge.connected'), tone: 'emerald' } : null),
        state,
        linkedAt: link.linkedAt && Number.isFinite(Date.parse(link.linkedAt))
          ? tr('settings:socialIdentity.row.linkedAt', { when: stamp(link.linkedAt) })
          : null,
        noToken: link.linked && link.access === 'identity'
          ? (provider === 'github'
            ? tr('settings:socialIdentity.row.noTokenGithub')
            : tr('settings:socialIdentity.row.noTokenX'))
          : null,
        connect: offersConnect
          ? {
            // The row's own title already says which provider, so the
            // control is the verb alone; `name` keeps the long form for
            // the accessible name (see social-identity.tsx).
            label: link.reconnectRequired ? tr('settings:socialIdentity.action.reconnect') : tr('settings:socialIdentity.action.connect'),
            // A demo fixture gets the control inert rather than absent: the
            // real flow would navigate straight out of the fixture.
            href: actionHref('connect'),
            intent: 'connect',
          }
          : null,
        refresh: link.linked && !link.reconnectRequired && link.available !== false
          ? { label: tr('settings:socialIdentity.action.refreshHandle'), href: actionHref('refresh'), intent: 'refresh' }
          : null,
        replace: link.linked && !link.reconnectRequired && link.available !== false
          ? { label: tr('settings:socialIdentity.action.changeAccount'), href: actionHref('replace'), intent: 'replace' }
          : null,
        visibility: link.linked && !link.reconnectRequired
          ? { checked: link.publicVisible !== false, disabled: !!demo }
          : null,
        pendingReplacement: link.pendingReplacement && link.handle
          ? {
            currentHandle: link.handle,
            replacementHandle: link.pendingReplacement.handle,
            expiresAt: link.pendingReplacement.expiresAt,
            disabled: !!demo,
          }
          : null,
        unlink: link.linked ? { disabled: !!demo } : null,
        strandedNote: link.pendingAttemptAt
          ? tr('settings:socialIdentity.row.strandedAttempt', { provider: name })
          : null,
        diagnostics: link.diagnostics
          ? this._socialIdentityDiagnosticsView(provider, link.diagnostics, demo)
          : null,
      };
    },

    // The admin-only configuration panel (#1291): the credential pair in use,
    // the callback URL the developer app must register, and a live check of
    // the pair. The transient halves — the Copy control's "Copied" flash and
    // the check's in-flight/verdict line — are ./social-identity.tsx's own
    // state: they were local variables closed over by a listener, and they
    // never leave that subtree.
    _socialIdentityDiagnosticsView(provider, diagnostics, demo) {
      const name = provider === 'github' ? 'GitHub' : 'X';
      let source;
      if (diagnostics.credentialSource === 'waitlist') {
        source = tr('settings:socialIdentity.diagnostics.sourceWaitlist', { provider: name });
      } else if (diagnostics.credentialSource === 'dedicated') {
        source = diagnostics.sameAppAsWaitlist
          ? tr('settings:socialIdentity.diagnostics.sourceDedicatedSameApp', { provider: name })
          : tr('settings:socialIdentity.diagnostics.sourceDedicated', { provider: name });
      } else {
        source = tr('settings:socialIdentity.diagnostics.sourceMissing', { provider: name });
      }
      return {
        provider,
        name,
        source,
        callbackUrl: diagnostics.callbackUrl || '',
        warning: tr('settings:socialIdentity.diagnostics.callbackWarning', { provider: name }),
        demo: !!demo,
      };
    },

    // `_socialIdentityAuditNote` / `_githubAuditNote` lived here — the
    // "don't take our word for it" line linking to the provider's own list of
    // authorized apps. It is ./social-identity.tsx's `<AuditNote>` now, with
    // the same top-level-link discipline (target=_blank + noopener), because
    // the shell is framed and neither provider allows being framed.

    _socialIdentityCallbackStatus(status) {
      if (!status) return;
      let result = null;
      let provider = null;
      try {
        const hash = String(window.location.hash || '');
        const query = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '';
        const params = new URLSearchParams(query);
        result = params.get('identity');
        provider = params.get('provider');
      } catch { return; }
      if (!result) return;
      const name = provider === 'x' ? 'X' : 'GitHub';
      // The result the OAuth round trip carried back, as a message id.
      const messages = {
        linked: 'settings:socialIdentity.callback.linked',
        refreshed: 'settings:socialIdentity.callback.refreshed',
        confirm: 'settings:socialIdentity.callback.confirm',
        in_use: 'settings:socialIdentity.callback.inUse',
        different_account: 'settings:socialIdentity.callback.differentAccount',
        conflict: 'settings:socialIdentity.callback.conflict',
        denied: 'settings:socialIdentity.callback.denied',
        // #3044: the provider bounced the trip before any sign-in page because
        // Homeroom's callback address is not the one registered on its OAuth
        // app. Not something the viewer did, and not fixed by retrying.
        callback_mismatch: 'settings:socialIdentity.callback.callbackMismatch',
        error: 'settings:socialIdentity.callback.error',
        account_mismatch: 'settings:socialIdentity.callback.accountMismatch',
      };
      status.textContent = Object.prototype.hasOwnProperty.call(messages, result)
        ? tr(messages[result], { provider: name, origin: window.location.origin })
        : '';
      if (!status.textContent) return;
      status.classList.remove('hidden', 'text-red-700', 'dark:text-red-400', 'text-emerald-700', 'dark:text-emerald-400');
      status.classList.add(...(['linked', 'refreshed', 'confirm'].includes(result)
        ? ['text-emerald-700', 'dark:text-emerald-400']
        : ['text-red-700', 'dark:text-red-400']));
    },

    async _unlinkGithub(button, provider = 'github') {
      const status = document.getElementById('github-link-status');
      const name = provider === 'x' ? 'X' : 'GitHub';
      const confirmed = await PlatformUI.confirm({
        title: tr('settings:socialIdentity.unlink.confirmTitle', { provider: name }),
        message: tr('settings:socialIdentity.unlink.confirmMessage', { provider: name }),
        confirmLabel: tr('settings:socialIdentity.unlink.confirmButton'),
        danger: true,
      });
      if (!confirmed) return;
      if (button) button.disabled = true;
      try {
        const response = await fetch(`/api/me/social-identities/${encodeURIComponent(provider)}`, {
          method: 'DELETE',
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (!response.ok) throw new Error(tr('settings:socialIdentity.unlink.failedProvider', { provider: name }));
        await this._refreshSocialIdentitySurfaces();
      } catch (err) {
        if (button) button.disabled = false;
        if (status) {
          status.textContent = err.message || tr('settings:socialIdentity.unlink.failed');
          status.classList.remove('hidden', 'text-emerald-700', 'dark:text-emerald-400');
          status.classList.add('text-red-700', 'dark:text-red-400');
        }
      }
    },

    // The list host's three states are ./cli-tokens-store.js's phases now, so
    // this reaches the bridge rather than the element.
    _publishCliTokens(next) {
      const bridge = (typeof window !== 'undefined' && window.UsernodeReact)
        ? window.UsernodeReact.settingsCliTokens : null;
      if (bridge) bridge.publish(next);
    },

    async _loadCliTokens(reset) {
      const section = document.getElementById('cli-tokens-section');
      const more = document.getElementById('cli-tokens-more');
      const status = document.getElementById('cli-tokens-status');
      if (!section || !more || !status) return;

      // Don't ask for a surface this deployment doesn't serve — the 404
      // would be a console error even though the code below handles it.
      // Staging disables the real CLI surface, but ?demo=1 is a read-only
      // fixture endpoint specifically meant to make this section reviewable.
      // Let that mock path through while still suppressing every real token
      // request when auth/me advertises cliAuthEnabled=false. The surrounding
      // section remains visible because its local-agent guide is useful even
      // when this deployment cannot list or revoke credentials.
      if (!this._cliTokensDemo() && !(await this._cliAuthAvailable())) {
        return;
      }

      // A reset is authoritative (opening Settings or refreshing after a
      // revocation), so let it supersede an older pagination request. The
      // generation check below prevents that older response/finally block
      // from rendering stale credential state or clearing the new load flag.
      if (!reset && this._cliTokensLoading) return;

      if (reset) {
        this._cliTokenLoadId += 1;
        this._cliTokens = [];
        this._cliTokenCursor = null;
        this._publishCliTokens({ phase: 'loading', tokens: [] });
        more.classList.add('hidden');
        status.classList.add('hidden');
      }
      const loadId = this._cliTokenLoadId;
      this._cliTokensLoading = true;
      more.disabled = true;
      try {
        // The page's ?demo=1 is passed through so the (staging:private,
        // therefore always-empty in a staging clone) credential list has
        // something to render — same pattern as _renderLlmGrants. Strictly a
        // no-op in production.
        const query = this._cliTokenCursor
          ? `?limit=50&cursor=${encodeURIComponent(this._cliTokenCursor)}`
          : '?limit=50';
        const demo = this._cliTokensDemoValue();
        const demoQ = demo ? `&demo=${encodeURIComponent(demo)}` : '';
        const response = await fetch(`/api/me/cli-tokens${query}${demoQ}`, {
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (loadId !== this._cliTokenLoadId) return;
        if (response.status === 404) {
          return;
        }
        if (!response.ok) throw new Error(tr('settings:cliTokens.load.failed'));
        const data = await response.json();
        if (!data || !Array.isArray(data.tokens)
            || (data.next_cursor != null && typeof data.next_cursor !== 'string')) {
          throw new Error(tr('settings:cliTokens.load.invalid'));
        }
        section.classList.remove('hidden');
        this._cliTokens.push(...data.tokens);
        this._cliTokenCursor = data.next_cursor || null;
        this._renderCliTokens();
      } catch (err) {
        if (loadId !== this._cliTokenLoadId) return;
        if (!this._cliTokens.length) this._publishCliTokens({ phase: 'idle', tokens: [] });
        status.textContent = err.message || tr('settings:cliTokens.load.failed');
        status.classList.remove('hidden', 'text-emerald-700', 'dark:text-emerald-400');
        status.classList.add('text-red-700', 'dark:text-red-400');
      } finally {
        if (loadId === this._cliTokenLoadId) {
          this._cliTokensLoading = false;
          more.disabled = false;
        }
      }
    },

    _renderCliTokens() {
      const more = document.getElementById('cli-tokens-more');
      const status = document.getElementById('cli-tokens-status');
      if (!more || !status) return;
      status.classList.add('hidden');
      // The ROWS are ./cli-tokens-list.tsx's — a card each, built here with
      // `document.createElement` until #1191. Every branch it evaluated is
      // resolved here, where the payload and the demo flag live: the two date
      // formats, the status line, and whether a row may be revoked at all (a
      // staging demo row is fabricated server-side and has nothing to revoke).
      this._publishCliTokens({
        phase: 'ready',
        tokens: this._cliTokens.map((token) => {
          // One whole line per combination of what is known. `status` is the
          // server's own word for the credential's state.
          const created = Number.isFinite(Date.parse(token.created_at))
            ? stamp(token.created_at) : null;
          const lastUsed = token.last_used_at && Number.isFinite(Date.parse(token.last_used_at))
            ? stamp(token.last_used_at) : null;
          const state = token.status || tr('settings:cliTokens.row.statusUnknown');
          let detail;
          if (created && lastUsed) detail = tr('settings:cliTokens.row.createdUsed', { status: state, created, lastUsed });
          else if (created) detail = tr('settings:cliTokens.row.created', { status: state, created });
          else if (lastUsed) detail = tr('settings:cliTokens.row.unknownDateUsed', { status: state, lastUsed });
          else detail = tr('settings:cliTokens.row.unknownDate', { status: state });
          return {
            id: typeof token.id === 'string' ? token.id : null,
            hint: typeof token.token_hint === 'string' ? token.token_hint : tr('settings:cliTokens.row.unnamed'),
            detail,
            revocable: token.status === 'valid'
              && typeof token.id === 'string' && !token.demo,
          };
        }),
      });
      // Both SIBLINGS of that host, and both still this module's: the
      // Load-more button follows the keyset cursor, and the status line has
      // three writers (revoke succeeded, revoke failed, demo data).
      more.classList.toggle('hidden', !this._cliTokenCursor);
      if (this._cliTokensDemo() && this._cliTokens.some((t) => t.demo)) {
        status.textContent = tr('settings:cliTokens.demoData');
        status.classList.remove('hidden', 'text-red-700', 'dark:text-red-400', 'text-emerald-700', 'dark:text-emerald-400');
      }
    },

    async _revokeCliToken(id, button) {
      const status = document.getElementById('cli-tokens-status');
      button.disabled = true;
      try {
        const response = await fetch(`/api/me/cli-tokens/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          credentials: 'same-origin',
        });
        if (response.status !== 204) throw new Error(tr('settings:cliTokens.revoke.failed'));
        if (status) {
          status.textContent = tr('settings:cliTokens.revoke.done');
          status.classList.remove('hidden', 'text-red-700', 'dark:text-red-400');
          status.classList.add('text-emerald-700', 'dark:text-emerald-400');
        }
        await this._loadCliTokens(true);
      } catch (err) {
        if (status) {
          status.textContent = err.message || tr('settings:cliTokens.revoke.failed');
          status.classList.remove('hidden', 'text-emerald-700', 'dark:text-emerald-400');
          status.classList.add('text-red-700', 'dark:text-red-400');
        }
        button.disabled = false;
      }
    },

    async _saveLocale(value) {
      const select = document.getElementById('settings-locale');
      const status = document.getElementById('settings-locale-status');
      const fail = (msg) => {
        if (select) select.value = this.state.locale || '';
        if (status) {
          status.textContent = msg;
          status.classList.remove('hidden', 'text-emerald-700', 'dark:text-emerald-400', 'text-zinc-500', 'dark:text-zinc-400');
          status.classList.add('text-red-700', 'dark:text-red-400');
        }
      };
      // The language runtime (frontend/src/lib/i18n) loads the language,
      // then saves, then switches, so a failed save leaves this screen as it
      // was. Its saveAccountLocale is the POST /api/me/locale: it also keeps
      // App.user, this.state.locale and any open app iframe
      // (AppView.notifyLocaleChanged, `usernode:locale-changed`) in step.
      const i18n = window.PlatformI18n;
      let saving = false;
      try {
        const applied = await i18n.changeLanguage(value || null, async (next) => {
          saving = true;
          await i18n.saveAccountLocale(next);
        });
        // A newer choice replaced this one, and reports for itself.
        if (!applied) return;
      } catch (err) {
        return fail(saving ? (err.message || i18n.t('settings:language.saveFailed')) : i18n.t('settings:language.loadFailed'));
      }
      if (status) {
        status.textContent = i18n.t('settings:language.saved');
        status.classList.remove('hidden', 'text-red-700', 'dark:text-red-400', 'text-zinc-500', 'dark:text-zinc-400');
        status.classList.add('text-emerald-700', 'dark:text-emerald-400');
      }
    },

    // One save at a time: the list is disabled until the server answers, so
    // what it shows is always what was stored (a late answer to an earlier
    // pick can no longer land after a later one).
    async _saveTimeZone(value) {
      const select = document.getElementById('settings-timezone');
      const status = document.getElementById('settings-timezone-status');
      const i18n = window.PlatformI18n;
      const paint = (text, ok) => {
        if (!status) return;
        status.textContent = text;
        status.classList.remove('hidden', 'text-red-700', 'dark:text-red-400', 'text-emerald-700', 'dark:text-emerald-400', 'text-zinc-500', 'dark:text-zinc-400');
        status.classList.add(...(ok ? ['text-emerald-700', 'dark:text-emerald-400'] : ['text-red-700', 'dark:text-red-400']));
      };
      if (this._timeZoneSaving) return;
      this._timeZoneSaving = true;
      if (select) select.disabled = true;
      let saved;
      try {
        saved = await i18n.saveAccountTimeZone(value || null);
      } catch {
        if (select) select.value = this.state.timeZone || '';
        return paint(i18n.t('settings:timezone.saveFailed'), false);
      } finally {
        this._timeZoneSaving = false;
        if (select) select.disabled = false;
      }
      this.state.timeZone = saved;
      if (select) {
        this._ensureTimeZoneOption(select, saved);
        select.value = saved || '';
      }
      const zone = saved || (i18n.deviceTimeZone ? i18n.deviceTimeZone() : '');
      paint(i18n.t('settings:timezone.saved', { zone: i18n.timeZoneLabel ? i18n.timeZoneLabel(zone) : zone }), true);
    },

    // Show the admin-preview section only when the server reports the
    // user as a *real* admin. App._realIsAdmin is the un-masked value
    // captured in app.js before the localStorage override gets
    // applied; reading App.user.isAdmin here would be wrong because
    // it reflects the masked state, which would hide the toggle
    // forever once flipped on.
    //
    // Fallback: if `_realIsAdmin` is undefined (e.g. a stale-cached
    // app.js from before that flag was added), fall back to the live
    // `App.user.isAdmin`. Safe because a stale app.js can't have
    // applied the mask either, so the live value still reflects the
    // server truth. `??` (not `||`) so an explicit `false` from a
    // current-cache app.js wins over the fallback.
    _renderAdminSection() {
      const section = document.getElementById('settings-admin-section');
      const toggle = document.getElementById('view-as-non-admin');
      // Read the bare `App` identifier rather than `window.App` —
      // app.js declares `App` with `const`, which does NOT write to
      // `window` in non-module browser scripts, so `window.App` is
      // undefined. Using the bare identifier matches the rest of the
      // codebase. Fallback to `App.user.isAdmin`
      // covers a stale-cached app.js from before `_realIsAdmin` was
      // introduced; safe because a stale app.js can't have applied
      // the mask either, so the live value still reflects the server
      // truth. `??` (not `||`) so an explicit `false` from a current
      // app.js wins over the fallback.
      const realAdmin = (typeof App !== 'undefined' ? App._realIsAdmin : undefined)
        ?? (typeof App !== 'undefined' && !!App.user?.isAdmin);
      if (!section || !toggle) return;
      if (!realAdmin) {
        section.classList.add('hidden');
        return;
      }
      section.classList.remove('hidden');
      toggle.checked = localStorage.getItem('viewAsNonAdmin') === '1';
    },

    // Called by App._exitSettings once the screen is hidden. No section
    // polls, so there is no per-section teardown to run (the admin
    // console's _teardownActiveSection has no analogue here) — just the two
    // lifecycle timers and the never-persisted key field.
    close() {
      Settings._open = false;
      Settings._pushedFromMenu = false;
      Settings._pendingSection = null;
      this._stopWalletPolling();
      this._clearAlertsTestCountdown();
      this._clearUsernodeAuthStatusRetry();
      this._mobilePushLoadToken += 1;
    },

    // Clear the "Send a test alert" countdown interval. Idempotent: safe to
    // call when none is running (rapid re-clicks, modal close).
    _clearAlertsTestCountdown() {
      if (this._alertsTestTimer) {
        clearInterval(this._alertsTestTimer);
        this._alertsTestTimer = null;
      }
    },

    _mobilePushRows() {
      return [...document.querySelectorAll(
        '#settings-mobile-push-preferences [data-mobile-push-category]'
      )];
    },

    _setMobilePushPreferences(preferences) {
      if (!Array.isArray(preferences)) throw new Error(tr('settings:mobilePush.invalidResponse'));
      const next = {};
      for (const preference of preferences) {
        if (!preference || typeof preference.key !== 'string'
            || typeof preference.enabled !== 'boolean') {
          throw new Error(tr('settings:mobilePush.invalidResponse'));
        }
        next[preference.key] = preference.enabled;
      }
      for (const row of this._mobilePushRows()) {
        if (typeof next[row.dataset.mobilePushCategory] !== 'boolean') {
          throw new Error(tr('settings:mobilePush.incompleteResponse'));
        }
      }
      this._mobilePushPreferences = next;
    },

    _renderMobilePushPreferences(message, error) {
      const disabled = this._mobilePushLoading
        || this._mobilePushSaving
        || !this._mobilePushPreferences;
      for (const row of this._mobilePushRows()) {
        const input = row.querySelector('input[type="checkbox"]');
        if (!input) continue;
        const saved = this._mobilePushPreferences?.[row.dataset.mobilePushCategory];
        if (typeof saved === 'boolean') input.checked = saved;
        input.disabled = disabled;
      }
      const status = document.querySelector(
        '#settings-mobile-push-preferences [data-mobile-push-status]'
      );
      if (!status) return;
      status.textContent = message || (disabled ? tr('settings:alerts.push.loading') : tr('settings:mobilePush.saved'));
      status.className = 'text-xs mt-3 ' + (error
        ? 'text-red-700 dark:text-red-400'
        : 'text-zinc-500 dark:text-zinc-400');
    },

    async _loadMobilePushPreferences() {
      const token = ++this._mobilePushLoadToken;
      this._mobilePushLoading = true;
      this._renderMobilePushPreferences(tr('settings:alerts.push.loading'));
      try {
        const response = await fetch('/api/me/mobile-push-preferences', {
          credentials: 'same-origin',
          cache: 'no-store',
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
        if (token !== this._mobilePushLoadToken) return;
        this._setMobilePushPreferences(body.preferences);
        this._mobilePushLoading = false;
        this._renderMobilePushPreferences(tr('settings:mobilePush.saved'));
      } catch (err) {
        if (token !== this._mobilePushLoadToken) return;
        this._mobilePushLoading = false;
        this._mobilePushPreferences = null;
        this._renderMobilePushPreferences(
          tr('settings:mobilePush.loadFailed', { reason: err.message }), true
        );
      }
    },

    async _saveMobilePushPreference(category, enabled) {
      if (!this._mobilePushPreferences || this._mobilePushSaving
          || typeof this._mobilePushPreferences[category] !== 'boolean') {
        this._renderMobilePushPreferences();
        return;
      }
      const previous = this._mobilePushPreferences[category];
      this._mobilePushPreferences[category] = !!enabled;
      this._mobilePushSaving = true;
      this._renderMobilePushPreferences(tr('settings:mobilePush.saving'));
      try {
        const response = await fetch('/api/me/mobile-push-preferences', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          cache: 'no-store',
          body: JSON.stringify({ preferences: { [category]: !!enabled } }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
        this._setMobilePushPreferences(body.preferences);
        this._mobilePushSaving = false;
        this._renderMobilePushPreferences(tr('settings:mobilePush.saved'));
      } catch (err) {
        this._mobilePushPreferences[category] = previous;
        this._mobilePushSaving = false;
        this._renderMobilePushPreferences(tr('settings:mobilePush.saveFailed', { reason: err.message }), true);
        if (window.PlatformUI) PlatformUI.toast(tr('settings:mobilePush.saveFailedToast'));
      }
    },

    // #119 — the spend breakdown on the Usage part: what the platform's
    // allowance paid beside what the viewer's own key paid. Fetched fresh on
    // every open; the block stays hidden while loading, on fetch failure,
    // or when nothing was paid on the viewer's own key this week. That is an
    // app's spend on their own OpenRouter key under a grant that allows it
    // (an Anthropic key before task 2275).
    //
    // #6493: the platform line is the ONE shared allowance
    // (features/header/ai-credit.js `AiCredit.Budget`), so it cannot
    // disagree with the AI credit row above it. /api/budget is still fetched
    // for the own-key figure and the reset boundary only it carries; its
    // snapshot half is adopted into the shared state, and the platform line
    // reads that.
    async _refreshSpend() {
      const block = document.getElementById('settings-spend');
      if (!block) return;
      block.classList.add('hidden');
      try {
        const AiCredit = window.AiCredit;
        const seq = AiCredit?.Budget?._takeTicket ? AiCredit.Budget._takeTicket() : null;
        const r = await fetch('/api/budget', { credentials: 'same-origin' });
        if (!r.ok) return;
        const b = await r.json();
        if (AiCredit?.Budget?.adopt) {
          AiCredit.Budget.adopt(b, seq == null ? undefined : { seq });
        }
        if (!(Number(b.byokSpentCents) > 0)) return;
        document.getElementById('settings-spend-byok').textContent =
          '$' + ((b.byokSpentCents || 0) / 100).toFixed(2);
        Settings._paintSpendPlatform(b);
        // #3230: the weekly reset in the viewer's own clock, UTC on hover.
        const reset = document.getElementById('settings-spend-reset');
        const RT = window.ResetTime;
        if (reset && RT) {
          const cadence = b.capWindow === 'daily' ? 'daily' : 'weekly';
          reset.textContent = tr(cadence === 'daily' ? 'settings:usage.spend.resetsDaily' : 'settings:usage.spend.resetsWeekly', RT.resetMoment(cadence, { at: b.resetsAt }));
          reset.title = RT.resetUtc(cadence, { at: b.resetsAt });
        }
        block.classList.remove('hidden');
      } catch {}
    },

    // #6493: the spend card's platform line, spelled from the shared
    // allowance so it always adds up to the AI credit row's figure.
    // `fallback` is the /api/budget answer on the fetch path; on a live
    // update there is no answer in hand and the shared state is the source.
    _paintSpendPlatform(fallback) {
      const el = document.getElementById('settings-spend-platform');
      if (!el) return;
      const state = window.AiCredit?.Budget?.current?.() || fallback || null;
      if (!state) return;
      el.textContent = tr('settings:usage.spend.platformOfLimit', {
        spent: '$' + ((state.spentCents || 0) / 100).toFixed(2),
        limit: '$' + ((state.limitCents || 0) / 100).toFixed(2),
      });
    },

    // ── OpenRouter key ─────────────────────────────────────────
    _normalizeOpenRouterCopy() {
      const section = document.querySelector('[data-settings-section="openrouter"]');
      if (!section) return;
      const heading = section.querySelector('h3');
      const intro = section.querySelector('p');
      if (heading) heading.textContent = 'OpenRouter';
      // sections/openrouter.tsx renders this same text statically.
      if (intro) intro.textContent = tr('settings:openrouter.intro');
    },

    _setOrStatus(text, kind) {
      const el = document.getElementById('settings-openrouter-status');
      if (!el) return;
      paintStatus(el, text, kind);
    },

    async _refreshOpenRouter() {
      const display = document.getElementById('settings-openrouter-key-display');
      const last4 = document.getElementById('settings-openrouter-key-last4');
      const info = document.getElementById('settings-openrouter-key-info');
      const removeBtn = document.getElementById('settings-openrouter-remove');
      const input = document.getElementById('settings-openrouter-key');
      const saveBtn = document.getElementById('settings-openrouter-save');
      const includedCard = document.getElementById('settings-openrouter-included');
      const includedStatus = document.getElementById('settings-openrouter-included-status');
      const personalControls = document.getElementById('settings-openrouter-personal-controls');
      try {
        // #2568: this read is also what creates an included key for an
        // account that somehow has none (routes/credentials.js).
        const r = await fetch('/api/me/credentials/openrouter', { credentials: 'same-origin' });
        const j = r.ok ? await r.json() : {};
        const managed = j.managed || null;
        const provisioning = j.managedProvisioning || {};
        // #2568: a STATUS line, not a claim card. It says whether the key is
        // there, its last four and its allowance — and, when it is not
        // there, what is standing in the way rather than what to press.
        if (includedCard) includedCard.classList.toggle('hidden', !provisioning.available && !managed);
        if (includedStatus) {
          const managedLast4 = managed && j.source === 'usernode_managed' ? j.last4 : null;
          if (managed?.status === 'active') {
            // The key carries the platform's weekly allowance; a key issued
            // before that policy keeps its own limit until it is re-limited.
            const amount = `$${Number(managed.limitUsd || 0).toFixed(2)}`;
            // One whole sentence per cadence, with and without the key's
            // last four.
            const { key: cadenceKey, cadence } = limitCadence(managed.limitReset);
            const ACTIVE = {
              weekly: ['settings:openrouter.included.activeWeekly', 'settings:openrouter.included.activeWeeklyWithKey'],
              daily: ['settings:openrouter.included.activeDaily', 'settings:openrouter.included.activeDailyWithKey'],
              monthly: ['settings:openrouter.included.activeMonthly', 'settings:openrouter.included.activeMonthlyWithKey'],
              none: ['settings:openrouter.included.activeLimit', 'settings:openrouter.included.activeLimitWithKey'],
              other: ['settings:openrouter.included.activeOther', 'settings:openrouter.included.activeOtherWithKey'],
            };
            includedStatus.textContent = tr(ACTIVE[cadenceKey][managedLast4 ? 1 : 0], {
              amount, cadence, last4: managedLast4,
            });
          } else if (managed?.status === 'disabled') {
            includedStatus.textContent = tr('settings:openrouter.included.blocked');
          } else if (managed?.status === 'deleted') {
            includedStatus.textContent = tr('settings:openrouter.included.deleted');
          } else if (managed?.status === 'needs_review' || managed?.status === 'provisioning') {
            includedStatus.textContent = tr('settings:openrouter.included.needsReview');
          } else if (!provisioning.available) {
            includedStatus.textContent = tr('settings:openrouter.included.notConfigured');
          } else if (provisioning.reason === 'no_allowance') {
            includedStatus.textContent = tr('settings:openrouter.included.noAllowance');
          } else if (provisioning.reason === 'personal_key_configured') {
            includedStatus.textContent = tr('settings:openrouter.included.personalKey');
          } else {
            const { key: cadenceKey, cadence } = limitCadence(provisioning.limitReset);
            includedStatus.textContent = tr({
              weekly: 'settings:openrouter.included.settingUpWeekly',
              daily: 'settings:openrouter.included.settingUpDaily',
              monthly: 'settings:openrouter.included.settingUpMonthly',
              none: 'settings:openrouter.included.settingUpAllowance',
              other: 'settings:openrouter.included.settingUpOther',
            }[cadenceKey], { amount: `$${Number(provisioning.limitUsd || 0).toFixed(2)}`, cadence });
          }
        }
        const managedOwnsCredential = !!managed && managed.status !== 'deleted';
        if (personalControls) personalControls.classList.toggle('hidden', managedOwnsCredential);
        if (j.configured) {
          if (display) display.classList.remove('hidden');
          if (last4) last4.textContent = j.last4 || '••••';
          if (removeBtn) removeBtn.classList.toggle('hidden', managedOwnsCredential);
          if (input) { input.placeholder = tr('settings:openrouter.key.replacePlaceholder'); input.value = ''; }
          if (saveBtn) saveBtn.textContent = tr('settings:openrouter.key.replace');
          if (info && (j.keyInfo || managed)) {
            info.classList.remove('hidden');
            const lim = j.keyInfo?.limit != null ? `$${j.keyInfo.limit}` : '';
            const rem = j.keyInfo?.limitRemaining != null ? `$${j.keyInfo.limitRemaining}` : '';
            const owner = managedOwnsCredential
              ? tr('settings:openrouter.key.ownerManaged')
              : tr('settings:openrouter.key.ownerPersonal');
            // The stored managed-key cadence is authoritative; a personal
            // key's comes from OpenRouter's own key-info.
            const { key: cadenceKey, cadence } = limitCadence((managedOwnsCredential && managed.limitReset) || j.keyInfo?.limitReset);
            const limitLine = tr({
              weekly: 'settings:openrouter.key.limitWeekly',
              daily: 'settings:openrouter.key.limitDaily',
              monthly: 'settings:openrouter.key.limitMonthly',
              none: 'settings:openrouter.key.limitPlain',
              other: 'settings:openrouter.key.limitOther',
              // An unrecognised cadence is the server's own word, capitalised
              // because it starts the fact.
            }[cadenceKey], { limit: lim, cadence: `${cadence.charAt(0).toUpperCase()}${cadence.slice(1)}` });
            info.textContent = lim
              ? dotText([owner, limitLine, tr('settings:openrouter.key.remaining', { remaining: rem })])
              // The key's own label, which may be empty: the separator stays.
              : tr('settings:list.dot', { first: owner, second: j.keyInfo?.label || '' });
          }
        } else {
          if (display) display.classList.add('hidden');
          if (removeBtn) removeBtn.classList.add('hidden');
          if (input) input.placeholder = 'sk-or-...';
          if (saveBtn) saveBtn.textContent = tr('settings:openrouter.personalKey.testAndSave');
          if (info) info.classList.add('hidden');
        }
      } catch {}
    },

    async _saveOpenRouterKey() {
      const input = document.getElementById('settings-openrouter-key');
      const saveBtn = document.getElementById('settings-openrouter-save');
      const key = input?.value?.trim();
      if (!key) { this._setOrStatus(tr('settings:openrouter.key.pasteFirst'), 'error'); return; }
      if (saveBtn) saveBtn.disabled = true;
      this._setOrStatus(tr('settings:openrouter.key.verifying'), 'info');
      try {
        const r = await fetch('/api/me/credentials/openrouter', {
          method: 'PUT', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey: key }),
        });
        const j = await r.json();
        if (!r.ok) { this._setOrStatus(j.error || tr('settings:openrouter.key.saveFailed'), 'error'); return; }
        this._setOrStatus(tr('settings:openrouter.key.saved'), 'ok');
        if (typeof App !== 'undefined' && App.user) App.user.openrouterAvailable = true;
        input.value = '';
        await this._refreshOpenRouter();
      } catch (err) {
        this._setOrStatus(tr('settings:openrouter.key.networkError', { reason: err.message }), 'error');
      } finally {
        if (saveBtn) saveBtn.disabled = false;
      }
    },

    async _removeOpenRouterKey() {
      const removeBtn = document.getElementById('settings-openrouter-remove');
      if (removeBtn) removeBtn.disabled = true;
      try {
        const r = await fetch('/api/me/credentials/openrouter', { method: 'DELETE', credentials: 'same-origin' });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { this._setOrStatus(j.error || tr('settings:openrouter.key.removeFailed'), 'error'); return; }
        this._setOrStatus(tr('settings:openrouter.key.removed'), 'ok');
        if (typeof App !== 'undefined' && App.user) App.user.openrouterAvailable = false;
        await this._refreshOpenRouter();
      } catch {
        this._setOrStatus(tr('settings:openrouter.key.removeFailed'), 'error');
      } finally {
        if (removeBtn) removeBtn.disabled = false;
      }
    },

    // ── Change password (issue #282) ─────────────────────────────
    _setCpStatus(text, kind) {
      const el = document.getElementById('cp-status');
      if (!el) return;
      paintStatus(el, text, kind);
    },

    // Browser-review state for the native-only password-creation link. It
    // changes availability only: the wallet submit path still requires the
    // real native bridge before it can make a request.
    _passwordCreateDemo() {
      return this._demoParam('shot') === 'password-create';
    },

    // Decide whether the wallet option is even offered, then default to
    // the password form. The "Create one" link only appears in the Homeroom
    // native app (signMessage available) AND when the logged-in account has a
    // linked wallet to prove control of, except for the read-only screenshot
    // state that makes this native-only copy reviewable in a browser.
    _renderChangePasswordSection() {
      const section = document.getElementById('change-password-section');
      if (!section) return;
      const isNative = !!(window.usernode && window.usernode.isNative);
      this._walletChangeAvailable = this._passwordCreateDemo()
        || (isNative && !!this.state.usernodePubkey);
      // Clear any stale field values / status on each open.
      ['cp-current', 'cp-new', 'cp-confirm'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });
      const status = document.getElementById('cp-status');
      if (status) { status.classList.add('hidden'); status.textContent = ''; }
      this._setChangePasswordMode('password');
      // #5281: the row reads first, its form closed, except in the
      // password-creation screenshot state, whose words live in the form.
      this._setEditorOpen('password', this._passwordCreateDemo());
    },

    _setChangePasswordMode(mode) {
      // In password mode (or when wallet isn't available) show the
      // current-password field + the normal submit, and offer the
      // password-creation link only if the wallet-backed path is available. In
      // wallet mode hide the current-password field, swap the submit, and offer
      // the way back.
      const wallet = mode === 'wallet' && this._walletChangeAvailable;
      const show = (id, on) => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('hidden', !on);
      };
      // #4595: an account with no password (it signs in with an email code)
      // has no current password to give, and sets its first one without.
      // #4891: and it is offered "Add a password", not "Change password".
      const first = this._noPasswordYet();
      show('cp-current-row', !wallet && !first);
      // #5281: the row's own line and link say the same: "Set" with Change,
      // or "Not set" with Add.
      show('cp-state-set', !first);
      show('cp-state-unset', first);
      show('cp-edit-change', !first);
      show('cp-edit-add', first);
      show('cp-title-change', !first);
      show('cp-title-add', first);
      show('cp-save-change', !first);
      show('cp-save-add', first);
      show('cp-save', !wallet);
      show('cp-wallet-save', wallet);
      // Offer the password-creation link only in password mode and only when
      // wallet change is available; offer the way back in wallet mode.
      show('cp-wallet-mode', !wallet && this._walletChangeAvailable);
      show('cp-password-mode', wallet);
    },

    async changePasswordWithWallet() {
      const newEl = document.getElementById('cp-new');
      const confirmEl = document.getElementById('cp-confirm');
      const btn = document.getElementById('cp-wallet-save');
      const newPassword = newEl.value;
      const confirm = confirmEl.value;

      if (newPassword.length < 8) { this._setCpStatus(tr('settings:password.status.tooShort'), 'error'); return; }
      if (newPassword !== confirm) { this._setCpStatus(tr('settings:password.status.mismatch'), 'error'); return; }
      if (!(window.usernode && window.usernode.isNative) || typeof window.signMessage !== 'function') {
        this._setCpStatus(tr('settings:password.status.walletNativeOnly'), 'error');
        return;
      }

      btn.disabled = true;
      this._setCpStatus(tr('settings:password.status.verifyingIdentity'), 'info');
      try {
        const pubkey = this.state.usernodePubkey || (window.getNodeAddress ? await window.getNodeAddress() : null);
        if (!pubkey) { this._setCpStatus(tr('settings:password.status.noWalletAddress'), 'error'); return; }

        // Fresh single-use challenge from the shared wallet-check endpoint.
        const checkRes = await fetch('/api/auth/wallet-check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ pubkey }),
        });
        const checkData = await checkRes.json().catch(() => ({}));
        const challenge = checkData.challenge;
        if (!challenge) { this._setCpStatus(tr('settings:password.status.noChallenge'), 'error'); return; }

        const sig = await window.signMessage(challenge);
        const r = await fetch('/api/me/wallet-change-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ publicKey: sig.publicKey, challenge, signature: sig.signature, newPassword }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { this._setCpStatus(j.error || tr('settings:password.status.changeFailed'), 'error'); return; }
        newEl.value = '';
        confirmEl.value = '';
        this._setCpStatus(tr('settings:password.status.changed'), 'ok');
      } catch (err) {
        if (err && err.message && err.message.includes('denied')) {
          this._setCpStatus(tr('settings:password.status.signatureDenied'), 'error');
        } else {
          this._setCpStatus(tr('settings:password.status.walletChangeFailed', { reason: String(err.message || err) }), 'error');
        }
      } finally {
        btn.disabled = false;
      }
    },

    _setCuStatus(text, kind) {
      const el = document.getElementById('cu-status');
      if (!el) return;
      paintStatus(el, text, kind);
    },

    // #5281: open one of the Account page's sign-in forms and close the
    // others; null closes them all. `announce: false` is for a change that
    // came FROM the event (the Email part opening itself), so it is not
    // echoed back. Only the forms this module owns are touched by id; the
    // Email part closes itself on the event.
    _openAccountEditor(part, { announce = true } = {}) {
      Object.keys(ACCOUNT_EDITORS).forEach((key) => this._setEditorOpen(key, key === part));
      const focusId = part && ACCOUNT_EDITORS[part] && ACCOUNT_EDITORS[part].focus;
      if (focusId && !Settings._isMobile?.()) {
        // Not on a phone: focusing a field there pops the keyboard over the
        // form the person is about to read.
        try { document.getElementById(focusId)?.focus?.({ preventScroll: true }); } catch { /* ignore */ }
      }
      if (announce) {
        try {
          window.dispatchEvent(new CustomEvent(ACCOUNT_EDITOR_EVENT, { detail: { part: part || null } }));
        } catch { /* the other part simply stays as it is */ }
      }
    },

    // Paint the current handle. Called from the section render and after a
    // rename, so the row is right even after a rename made somewhere else in
    // this tab (or in another one, once /api/auth/me is re-read).
    _paintCurrentUsername() {
      const cur = document.getElementById('cu-current');
      if (!cur) return;
      const name = (typeof App !== 'undefined' && App.user && App.user.username) || '';
      cur.textContent = name ? `@${name}` : '—';
    },

    // Called from _renderAllSections on every open: the row reads first,
    // with its form closed and empty, asking for whichever proof the account
    // has (#5281): its password, or a code emailed to it when it has none.
    // ?shot=username-change opens the form, so the reviewable state includes
    // the words under it.
    _renderChangeUsernameSection() {
      this._paintCurrentUsername();
      const code = this._noPasswordYet();
      const show = (id, on) => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('hidden', !on);
      };
      show('cu-password-row', !code);
      show('cu-code-row', code);
      ['cu-new', 'cu-password', 'cu-code'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });
      const status = document.getElementById('cu-status');
      if (status) { status.classList.add('hidden'); status.textContent = ''; }
      const open = this._demoParam?.('shot') === 'username-change';
      this._setEditorOpen('username', open);
    },

    // One part's form open or shut, with its row's Change button the other
    // way round, and nothing announced: the section renders reset their own
    // part, each in turn, on every open.
    _setEditorOpen(part, open) {
      const { form, button } = ACCOUNT_EDITORS[part];
      const formEl = document.getElementById(form);
      const buttonEl = document.getElementById(button);
      if (formEl) formEl.classList.toggle('hidden', !open);
      if (buttonEl) {
        buttonEl.classList.toggle('hidden', open);
        buttonEl.setAttribute?.('aria-expanded', open ? 'true' : 'false');
      }
    },

    // POST /api/me/username/code (#5281): for an account with no password,
    // a six-digit code to its verified address that confirms the rename.
    // The server refuses it for an account with a password, an admin, and an
    // account with no verified address, and says which.
    async requestUsernameCode() {
      const btn = document.getElementById('cu-send-code');
      if (!btn) return;
      btn.disabled = true;
      try {
        this._setCuStatus(tr('settings:username.status.sendingCode'), 'info');
        const r = await fetch('/api/me/username/code', {
          method: 'POST',
          credentials: 'same-origin',
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { this._setCuStatus(j.error || tr('settings:username.status.codeFailed'), 'error'); return; }
        this._setCuStatus(tr('settings:username.status.codeSent', { email: j.email || '' }), 'ok');
        const codeEl = document.getElementById('cu-code');
        try { codeEl?.focus?.({ preventScroll: true }); } catch { /* ignore */ }
      } catch (err) {
        this._setCuStatus(tr('settings:username.status.networkError', { reason: err.message }), 'error');
      } finally {
        btn.disabled = false;
      }
    },

    // POST /api/me/username. The server is the authority on every rule
    // here (charset, reserved names, availability against the retired
    // ledger, the cooldown, the password or the emailed code, and which of
    // the two this account must give); this only avoids a round-trip for
    // the states the form can see on its own.
    async changeUsername() {
      const nameEl = document.getElementById('cu-new');
      const pwEl = document.getElementById('cu-password');
      const codeEl = document.getElementById('cu-code');
      const btn = document.getElementById('cu-save');
      // #5281: an account with no password confirms with an emailed code.
      const byCode = this._noPasswordYet();
      if (!nameEl || !btn || (byCode ? !codeEl : !pwEl)) return;

      const username = nameEl.value.trim();
      const currentPassword = byCode ? '' : pwEl.value;
      const code = byCode ? codeEl.value.trim() : '';

      if (!username) { this._setCuStatus(tr('settings:username.status.enterNew'), 'error'); return; }
      if (byCode && !code) { this._setCuStatus(tr('settings:username.status.enterCode'), 'error'); return; }
      if (!byCode && !currentPassword) { this._setCuStatus(tr('settings:username.status.enterPassword'), 'error'); return; }

      // Everything that can throw goes INSIDE the try, so `finally` is the
      // only exit and the button cannot be stranded disabled under a
      // "Saving…" that never resolves — the shape of the reported bug, when
      // painting that very line was what threw. `btn.disabled = true` is a
      // property write and cannot.
      btn.disabled = true;
      try {
        this._setCuStatus(tr('settings:username.status.saving'), 'info');
        const r = await fetch('/api/me/username', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(byCode ? { username, code } : { username, currentPassword }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { this._setCuStatus(j.error || tr('settings:username.status.changeFailed'), 'error'); return; }

        nameEl.value = '';
        if (pwEl) pwEl.value = '';
        if (codeEl) codeEl.value = '';

        // The handle is on the drawer row, the identity card and every
        // link this tab is about to build, so App.user has to move with
        // it — a stale copy would keep deep-linking the OLD name, which
        // now resolves through the retired ledger and would quietly
        // redirect on every click.
        if (typeof App !== 'undefined' && App.user) {
          App.user.username = j.username;
          if (typeof App.saveSessionSnapshot === 'function') App.saveSessionSnapshot(App.user);
          try { App.resyncCurrentView(); } catch (_) { /* best effort */ }
        }
        this._paintCurrentUsername();

        this._setCuStatus(
          j.unchanged
            ? tr('settings:username.status.unchanged')
            : tr('settings:username.status.changed', { username: j.username }),
          'ok',
        );
      } catch (err) {
        this._setCuStatus(tr('settings:username.status.networkError', { reason: err.message }), 'error');
      } finally {
        btn.disabled = false;
      }
    },

    _noPasswordYet() {
      return !!(window.App && App.user && App.user.hasPassword === false);
    },

    async changePassword() {
      const currentEl = document.getElementById('cp-current');
      const newEl = document.getElementById('cp-new');
      const confirmEl = document.getElementById('cp-confirm');
      const btn = document.getElementById('cp-save');
      const currentPassword = currentEl.value;
      const newPassword = newEl.value;
      const confirm = confirmEl.value;

      const first = this._noPasswordYet();
      if (!currentPassword && !first) { this._setCpStatus(tr('settings:password.status.enterCurrent'), 'error'); return; }
      if (newPassword.length < 8) { this._setCpStatus(tr('settings:password.status.tooShort'), 'error'); return; }
      if (newPassword !== confirm) { this._setCpStatus(tr('settings:password.status.mismatch'), 'error'); return; }

      btn.disabled = true;
      this._setCpStatus(tr('settings:password.status.saving'), 'info');
      try {
        const r = await fetch('/api/me/password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(first ? { newPassword } : { currentPassword, newPassword }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { this._setCpStatus(j.error || tr('settings:password.status.changeFailed'), 'error'); return; }
        currentEl.value = '';
        newEl.value = '';
        confirmEl.value = '';
        if (j.first && window.App && App.user) {
          App.user.hasPassword = true;
          this._setChangePasswordMode('password');
        }
        this._setCpStatus(j.first ? tr('settings:password.status.set') : tr('settings:password.status.changed'), 'ok');
      } catch (err) {
        this._setCpStatus(tr('settings:password.status.networkError', { reason: err.message }), 'error');
      } finally {
        btn.disabled = false;
      }
    },

    async logout({ accountDeleted = false } = {}) {
      const btn = document.getElementById('settings-logout');
      // #3915: say so the moment it starts. A disabled button that still
      // looked and read exactly like "Sign out" is what made the phone look
      // frozen while the app shut down.
      if (btn) { btn.disabled = true; btn.textContent = tr(SIGNING_OUT_LABEL); }

      const fail = (error) => {
        if (btn) { btn.disabled = false; btn.textContent = tr(SIGN_OUT_LABEL); }
        if (window.PlatformUI && PlatformUI.toast) {
          PlatformUI.toast(
            tr('settings:signOut.failed'),
            { error: true }
          );
        }
        console.warn('[settings] logout failed:', error);
        return false;
      };

      // Close native admission before any asynchronous work, including probes.
      let preflight = { nativeTerminal: false };
      try {
        if (window.NativeChrome && NativeChrome.prepareWebLogout) {
          preflight = NativeChrome.prepareWebLogout() || preflight;
        }
      } catch (error) {
        return fail(error);
      }

      // Older apps cannot delete the HttpOnly cookie locally. Only opt into
      // offline logout when native explicitly guarantees that cleanup.
      let offlineLogout = false;
      if (preflight.nativeTerminal) {
        try {
          const info = await NativeChrome.getInfo();
          offlineLogout = info?.degraded !== true &&
            info?.sessionLifecycleProtocol === 2 &&
            info?.capabilities?.includes('offlineLogout') === true;
        } catch (_) {}
      }
      let webRevoked = false;
      let timeout;
      let controller;
      try {
        if (preflight.webRecoverySettled) await preflight.webRecoverySettled;
        controller = typeof AbortController === 'function' ? new AbortController() : null;
        const request = accountDeleted ? Promise.resolve({ ok: true }) : fetch('/api/auth/logout', {
          method: 'POST', credentials: 'same-origin',
          ...(controller ? { signal: controller.signal } : {}),
        });
        // #2078: BOTH paths are bounded now. The capable-phone budget is
        // short because native owns the cookie, so giving up early still
        // ends in a real sign-out. The ordinary web path has to reach the
        // server — only the server can revoke a web session — so it gets a
        // generous budget instead, one no working request is near. What it
        // must not be is ABSENT: this await used to be bare, with the
        // button already disabled, so a request that never settled left the
        // screen frozen with nothing to press. Running out here throws into
        // the catch below, which for the web path is `fail()` — the toast
        // and the button back, not a sign-out nobody performed.
        const budgetMs = offlineLogout
          ? OFFLINE_LOGOUT_TIMEOUT_MS
          : WEB_LOGOUT_TIMEOUT_MS;
        const response = await Promise.race([
          request,
          new Promise((_, reject) => {
            timeout = setTimeout(() => {
              if (controller) controller.abort();
              reject(new Error('Remote sign-out timed out'));
            }, budgetMs);
          }),
        ]);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        webRevoked = true;
      } catch (error) {
        if (!offlineLogout) return fail(error);
        // Native owns deletion of the cookie and durable credential. Remote
        // revocation remains best effort when the API cannot be reached.
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
      // Offline mode (#487): the service worker caches GET /api/* responses
      // per-URL, not per-user — wipe them so the next account on this
      // device can't see this user's cached feed. Belt-and-braces: the SW
      // also clears the API cache when it sees the logout POST above.
      try { await this._clearSwApiCache(); } catch (_) {}
      // Same reasoning for the offline session snapshot (#1021): it is the
      // record that says "this device is signed in", so leaving it behind
      // would let the next offline boot paint the signed-in shell for an
      // account that just logged out. _dropCachedSession is the wider sweep
      // (#1524): it also clears the shell snapshot and the remembered Improve
      // target, which main.tsx re-applies UNCONDITIONALLY at boot, before the
      // session is known — so leaving them behind paints the previous
      // session's header title and Improve button on the landing page.
      try { window.App?._dropCachedSession?.(); } catch (_) {}

      // Normalise the address BEFORE the terminal native call (#1524). A
      // native sign-out replaces the WebView but the platform keeps whatever
      // URL it was on, so a logout from `#settings` (or from `/app/<slug>`)
      // leaves an address that restoreFromHash reads as a remembered deep
      // link and answers with the sign-in form on the next restore. This runs
      // after remote revocation or an offline-capable native hand-off has
      // been selected.
      //
      // replaceState is safe on both counts that matter here. NATIVE-BRIDGE.md's
      // trust model binds the privileged capability to the executing JS realm,
      // and a same-document History API change retains it; and replaceState
      // fires neither popstate nor hashchange, so no router runs off it.
      try { window.history?.replaceState?.(null, '', LANDING_URL); } catch (_) {}

      // Back into a signed-in document restored whole from the BFCache would
      // otherwise repaint the signed-in shell from memory (#1524). One-shot:
      // this document is on its way out either way.
      try {
        window.addEventListener('pageshow', (event) => {
          if (event && event.persisted) window.location.replace(LANDING_URL);
        }, { once: true });
      } catch (_) {}

      // This must remain the final call on the native path: successful native
      // logout replaces the WebView, so the old document normally runs no
      // continuation work at all. The ONE relaxation (#1524) is navigation to
      // the landing page: on both outcomes below, and (#3915) on a bounded
      // timer armed as the call is issued. It cannot re-admit anyone:
      // App.user is gone, so NativeChrome._webParticipantId() is null and
      // establishCurrentSession() returns without asking the bridge for
      // anything. Nothing else may be added here.
      if (preflight.nativeTerminal) {
        // Whichever exit comes first wins; a later one finds it done.
        let left = false;
        const leave = () => {
          if (left) return;
          left = true;
          window.location.replace(LANDING_URL);
        };
        const armLeave = (ms) => {
          const timer = setTimeout(leave, ms);
          if (timer && typeof timer.unref === 'function') timer.unref();
        };
        // #3915: counted from the call being issued, not answered (no timer
        // can fire before the terminal call on the next line has been made).
        // See NATIVE_LOGOUT_ISSUED_SAFETY_MS for why this is safe only once
        // the server has revoked the session.
        if (webRevoked) armLeave(NATIVE_LOGOUT_ISSUED_SAFETY_MS);
        return NativeChrome.commitNativeLogout().then((result) => {
          // The WebView should already be gone. If it is not, land this
          // document on the public landing page rather than leave a
          // signed-out user on the Settings screen.
          armLeave(NATIVE_LOGOUT_SAFETY_MS);
          return result;
        }, (error) => {
          // If neither boundary completed, do not reload a possibly live
          // cookie or claim the user is signed out. Allow cleanup to retry.
          if (!webRevoked) return fail(error);
          // A rejection leaves the native realm closed and server authority
          // revoked, but this document alive and signed out. Carry the
          // advisory across the navigation (the toast itself would not
          // survive it) and go to the landing page like every other surface.
          try {
            window.sessionStorage?.setItem?.(LOGOUT_NOTICE_KEY, tr(NATIVE_SHUTDOWN_NOTICE));
          } catch (_) {}
          console.warn('[settings] local native shutdown failed:', error);
          left = true;
          window.location.replace(LANDING_URL);
          return false;
        });
      }

      // Hard navigation on purpose: enterAuthed is one-shot per document
      // in a regular browser. `/` boots
      // the anonymous shell on the landing screen — the public app
      // directory a guest normally sees — instead of the bare sign-in
      // form (#1159); the landing header's Sign in CTA keeps re-login one
      // tap away. REPLACE, not assign (#1524): a pushed entry lets Back
      // restore the signed-in document from the BFCache.
      window.location.replace(LANDING_URL);
    },

    // Ask the active service worker to drop its API cache; resolves on ack
    // or after a short timeout so logout never hangs on a wedged worker.
    _clearSwApiCache() {
      const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
      if (!sw) return Promise.resolve();
      return new Promise((resolve) => {
        const timer = setTimeout(resolve, 1000);
        try {
          const channel = new MessageChannel();
          channel.port1.onmessage = () => { clearTimeout(timer); resolve(); };
          sw.postMessage({ type: 'clear-api-cache' }, [channel.port2]);
        } catch (_) {
          clearTimeout(timer);
          resolve();
        }
      });
    },

    // ── App AI permissions (issue #34) ───────────────────────────
    //
    // Fetched fresh on every modal open. Each active grant renders as
    // a row: app name, $spent / $cap today, a cap editor, the BYOK
    // spillover toggle (only when a key is on file), and Revoke.
    // Revoked grants show a muted badge and Re-enable (#1957), which
    // re-grants through the consent dialog's own POST with the cap and
    // BYOK choice the row still carries — before it, the only way back
    // was that dialog, which an app that never asks again never opens.
    // In staging previews the page's ?demo=1 is passed through so the
    // (always-empty, staging:private) grant tables still produce a
    // reviewable list.

    async _renderLlmGrants() {
      const bridge = (typeof window !== 'undefined' && window.UsernodeReact)
        ? window.UsernodeReact.settingsGrants : null;
      if (!bridge) return;
      const publish = bridge.publish;
      publish({ phase: 'loading', grants: [] });
      const demo = new URLSearchParams(window.location.search).get('demo') === '1';
      let grants = [];
      let ownKey = false;
      try {
        const r = await fetch('/api/me/llm-grants' + (demo ? '?demo=1' : ''), { credentials: 'same-origin' });
        if (!r.ok) throw new Error('fetch failed');
        const j = await r.json();
        grants = j.grants || [];
        ownKey = j.hasOwnKey === true;
      } catch {
        publish({ phase: 'error', grants: [] });
        return;
      }
      publish({ phase: 'ready', grants: grants.map((g) => this._grantView(g, ownKey)) });
    },

    // One grant, as DATA. Every branch the row template used to evaluate
    // inline is decided here, beside the demo flag — see the note in
    // ./grants-store.js. `ownKey`: the person has an OpenRouter key of their
    // own (the list's hasOwnKey), which is what "use my own key" spends. The money is
    // pre-formatted for the same reason: cents-to-dollars is this module's
    // rule, not the component's. `appSlug` and `capCents` ride along for
    // Re-enable (#1957): the re-grant endpoint is keyed on slug, and the
    // previous cap is what it restores.
    _grantView(g, ownKey = false) {
      const spentCents = (Number(g.spentTodayCents) || 0) + (Number(g.byokSpentTodayCents) || 0);
      const spent = spentCents / 100;
      const cap = (g.dailyCapCents || 0) / 100;
      return {
        appId: g.appId,
        appName: String(g.appName ?? ''),
        appSlug: String(g.appSlug ?? ''),
        revoked: g.status !== 'active',
        spent: spent.toFixed(2),
        spentCents,
        cap: cap.toFixed(2),
        capValue: cap.toFixed(2),
        capCents: Number(g.dailyCapCents) || 0,
        showByok: !!(ownKey || g.allowByok),
        allowByok: !!g.allowByok,
      };
    },

    // A fabricated staging row. The demo grant tables are staging:private and
    // always empty, so ?demo=1 stands in for them — and those rows must never
    // reach the API.
    _isDemoGrant(appId) { return appId < 0; },

    // ── The row handlers ─────────────────────────────────────────
    //
    // The first three were closures inside the row builder, wired with
    // addEventListener to nodes it had just created. They are methods now,
    // called by name from ./grants-list.tsx, because the component owns the
    // markup and this module owns the writes. Each still reports through
    // _setLlmGrantsStatus and re-renders on success, exactly as before.
    // _onGrantReenable (#1957) is the fourth, written the same way.

    async _onGrantCapChange(appId, value) {
      const status = (t, k) => this._setLlmGrantsStatus(t, k);
      if (this._isDemoGrant(appId)) { status(tr('settings:grants.status.demoData'), 'info'); return; }
      const cents = Math.round(parseFloat(value) * 100);
      if (!Number.isFinite(cents) || cents <= 0) {
        status(tr('settings:grants.status.invalidCap'), 'error');
        return;
      }
      try {
        const r = await fetch(`/api/me/llm-grants/${appId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ dailyCapCents: cents }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { status(j.error || tr('settings:grants.status.capFailed'), 'error'); return; }
        status(tr('settings:grants.status.capUpdated'), 'ok');
        this._renderLlmGrants();
      } catch (err) {
        status(tr('settings:grants.status.networkError', { reason: err.message }), 'error');
      }
    },

    async _onGrantByokChange(appId, checked) {
      const status = (t, k) => this._setLlmGrantsStatus(t, k);
      if (this._isDemoGrant(appId)) { status(tr('settings:grants.status.demoData'), 'info'); return; }
      try {
        const r = await fetch(`/api/me/llm-grants/${appId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ allowByok: checked }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { status(j.error || tr('settings:grants.status.spilloverFailed'), 'error'); return; }
        status(checked ? tr('settings:grants.status.spilloverEnabled') : tr('settings:grants.status.spilloverDisabled'), 'ok');
        // The checkbox is CONTROLLED by the store now, so the failure paths
        // above leave it showing the old value on their own — where the DOM
        // version had to flip `byokInput.checked` back by hand. On success the
        // re-render is what makes the new value stick.
        this._renderLlmGrants();
      } catch (err) {
        status(tr('settings:grants.status.networkError', { reason: err.message }), 'error');
        this._renderLlmGrants();
      }
    },

    async _onGrantRevoke(appId, appName) {
      const status = (t, k) => this._setLlmGrantsStatus(t, k);
      const ok = await ConfirmModal.show({
        title: tr('settings:grants.revoke.confirmTitle', { app: appName }),
        message: tr('settings:grants.revoke.confirmMessage'),
        confirmLabel: tr('settings:grants.revoke.confirmButton'),
        danger: true,
      });
      if (!ok) return;
      if (this._isDemoGrant(appId)) { status(tr('settings:grants.status.demoData'), 'info'); return; }
      try {
        const r = await fetch(`/api/me/llm-grants/${appId}`, {
          method: 'DELETE', credentials: 'same-origin',
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { status(j.error || tr('settings:grants.status.revokeFailed'), 'error'); return; }
        status(tr('settings:grants.status.revoked'), 'ok');
        this._renderLlmGrants();
      } catch (err) {
        status(tr('settings:grants.status.networkError', { reason: err.message }), 'error');
      }
    },

    // The way back from Revoke (#1957). The consent dialog's POST is an
    // upsert keyed on slug that re-activates a revoked row, so re-enabling
    // re-sends the cap and BYOK choice the row still carries and the grant
    // comes back as it was; the active row's controls take over from there.
    // No confirm dialog: this is not destructive, and the row's copy already
    // says what the click restores.
    //
    // If the old cap no longer fits the user's allowance (the ceiling moved
    // since the grant was made), the server refuses it with a 400 that
    // carries no `code` — credit_required and byok_required both do — so
    // retry once at the server's default cap rather than strand the row
    // with no way back, and say so. Anything else is reported verbatim,
    // as the cap editor's errors are.
    async _onGrantReenable(grant) {
      const status = (t, k) => this._setLlmGrantsStatus(t, k);
      if (this._isDemoGrant(grant.appId)) { status(tr('settings:grants.status.demoData'), 'info'); return; }
      const post = (body) => fetch('/api/me/llm-grants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ appSlug: grant.appSlug, allowByok: !!grant.allowByok, ...body }),
      });
      try {
        const withCap = grant.capCents > 0;
        let r = await post(withCap ? { dailyCapCents: grant.capCents } : {});
        let j = await r.json().catch(() => ({}));
        let atDefault = false;
        if (withCap && r.status === 400 && !j.code) {
          r = await post({});
          j = await r.json().catch(() => ({}));
          atDefault = true;
        }
        if (!r.ok) { status(j.error || tr('settings:grants.status.reenableFailed'), 'error'); return; }
        const cap = ((j.grant && j.grant.dailyCapCents) || 0) / 100;
        status(atDefault
          ? tr('settings:grants.status.reenabledAtDefault', { cap: `$${cap.toFixed(2)}` })
          : tr('settings:grants.status.reenabled'), 'ok');
        this._renderLlmGrants();
      } catch (err) {
        status(tr('settings:grants.status.networkError', { reason: err.message }), 'error');
      }
    },

    _setLlmGrantsStatus(text, kind) {
      const el = document.getElementById('llm-grants-status');
      if (!el) return;
      paintStatus(el, text, kind);
      if (kind === 'ok') setTimeout(() => el.classList.add('hidden'), 3000);
    },

    // ── App device permissions (#2219) ───────────────────────────
    //
    // The sibling of the AI-permissions block above, against
    // /api/me/permission-grants. Grants are per (app, capability), so the
    // rows are GROUPED by app here rather than in the component: which
    // shape the list takes is this module's call, and the component
    // renders the answer (see ./app-permissions-list.tsx).
    //
    // Like the AI grants, the table is staging:private and therefore always
    // empty in a clone, so ?demo=1 is passed through for the preview.

    async _renderAppPermissions() {
      const bridge = (typeof window !== 'undefined' && window.UsernodeReact)
        ? window.UsernodeReact.settingsAppPermissions : null;
      if (!bridge) return;
      const publish = bridge.publish;
      publish({ phase: 'loading', apps: [] });
      const demo = new URLSearchParams(window.location.search).get('demo') === '1';
      let grants = [];
      try {
        const r = await fetch('/api/me/permission-grants' + (demo ? '?demo=1' : ''), { credentials: 'same-origin' });
        if (!r.ok) throw new Error('fetch failed');
        const j = await r.json();
        grants = j.grants || [];
      } catch {
        publish({ phase: 'error', apps: [] });
        return;
      }
      publish({ phase: 'ready', apps: this._permissionAppViews(grants) });
    },

    // Grants as DATA, one entry per app. Insertion order is the server's
    // (active apps first, then by name), and the capability order inside an
    // app is the catalogue's, because that is the order the API returns.
    _permissionAppViews(grants) {
      const byApp = new Map();
      for (const g of grants) {
        const appId = g.appId;
        if (!byApp.has(appId)) {
          byApp.set(appId, {
            appId,
            appName: String(g.appName ?? g.appSlug ?? ''),
            appSlug: String(g.appSlug ?? ''),
            items: [],
          });
        }
        const revoked = g.status !== 'active';
        byApp.get(appId).items.push({
          capability: String(g.capability ?? ''),
          label: String(g.label ?? g.capability ?? ''),
          revoked,
          // #6512: the stamp for the row's state. Revoked: when it was
          // revoked. Active: when it was last allowed, which is the row's
          // last change (a re-enable keeps its first-grant date).
          at: (revoked ? g.revokedAt : (g.updatedAt || g.createdAt)) || null,
        });
      }
      return [...byApp.values()];
    },

    _setAppPermissionsStatus(text, kind) {
      const el = document.getElementById('app-permissions-status');
      if (!el) return;
      paintStatus(el, text, kind);
      if (kind === 'ok') setTimeout(() => el.classList.add('hidden'), 3000);
    },

    // ── What apps tell you about (#1374) ─────────────────────────────
    //
    // Two layers, one fetch: the account-wide defaults and every per-app
    // exception. GET /api/me/notification-preferences returns both, because
    // an exception is meaningless without the default it departs from.
    //
    // Like the AI grants above, the table is staging:private and therefore
    // always empty in a clone, so ?demo=1 is passed through for the preview.

    async _renderNotificationPrefs() {
      const bridge = (typeof window !== 'undefined' && window.UsernodeReact)
        ? window.UsernodeReact.settingsNotificationPrefs : null;
      if (!bridge) return;
      const publish = bridge.publish;
      publish({ phase: 'loading', categories: [], apps: [] });
      const demo = new URLSearchParams(window.location.search).get('demo') === '1';
      try {
        const r = await fetch('/api/me/notification-preferences' + (demo ? '?demo=1' : ''),
          { credentials: 'same-origin' });
        if (!r.ok) throw new Error('fetch failed');
        const j = await r.json();
        publish({
          phase: 'ready',
          categories: j.categories || [],
          apps: j.apps || [],
        });
      } catch {
        publish({ phase: 'error', categories: [], apps: [] });
      }
    },

    _setNotificationPrefsStatus(text, kind) {
      const el = document.getElementById('notification-prefs-status');
      if (!el) return;
      paintStatus(el, text, kind);
      if (kind === 'ok') setTimeout(() => el.classList.add('hidden'), 3000);
    },

    // Change the account-wide default for one category. Every app that has
    // no exception of its own follows this immediately; the ones that do
    // keep theirs, which is the whole point of the two layers.
    async _onNotificationDefaultChange(category, enabled) {
      const status = (t, k) => this._setNotificationPrefsStatus(t, k);
      try {
        const r = await fetch('/api/me/notification-preferences', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ preferences: { [category]: enabled } }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { status(j.error || tr('settings:notificationPrefs.status.saveFailed'), 'error'); return; }
        status(tr('settings:notificationPrefs.status.saved'), 'ok');
        this._renderNotificationPrefs();
      } catch (err) {
        status(tr('settings:notificationPrefs.status.networkError', { reason: err.message }), 'error');
      }
    },

    // Drop one app's exceptions so it follows the defaults again.
    //
    // A DELETE rather than writing each category to the default's current
    // value: the app goes back to INHERITING, so it keeps following if a
    // default changes later. Writing the values would freeze them.
    async _onNotificationAppReset(appId, appSlug) {
      const status = (t, k) => this._setNotificationPrefsStatus(t, k);
      if (this._isDemoGrant(appId)) { status(tr('settings:notificationPrefs.status.demoData'), 'info'); return; }
      if (!appSlug) { status(tr('settings:notificationPrefs.status.unknownApp'), 'error'); return; }
      try {
        const r = await fetch(
          `/api/apps/${encodeURIComponent(appSlug)}/notification-preferences`,
          { method: 'DELETE', credentials: 'same-origin' }
        );
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { status(j.error || tr('settings:notificationPrefs.status.resetFailed'), 'error'); return; }
        status(tr('settings:notificationPrefs.status.reset'), 'ok');
        this._renderNotificationPrefs();
      } catch (err) {
        status(tr('settings:notificationPrefs.status.networkError', { reason: err.message }), 'error');
      }
    },

    // Revoke one capability from one app.
    //
    // The copy says NEXT TIME IT OPENS rather than "immediately", and that
    // difference is not hedging: a frame's Permissions Policy is computed
    // from its `allow` attribute at navigation and cannot be narrowed
    // afterwards, so a running app keeps what it already holds until its
    // frame goes. The AI section can honestly promise immediate because its
    // gate is a server-side check on every call.
    //
    // `target` (#6512) is `{ slug, name, permission, isOpen, close }`: the
    // app's name and the permission's label, which the dialog's title says
    // so the question names what is being revoked; whether the app
    // is open in THIS tab (on screen or kept running behind it), and how to
    // close it. The frame store is per tab, so another tab or device is out
    // of reach here. The dialog asks with what is open when it is shown;
    // the close is decided again once the server has taken the permission
    // away, because the app may have been opened while the request was out
    // (its launch could then have used the old grant set). Either way the
    // cached grant set is dropped first (AppView.forgetToken, which tells
    // this browser's other Homeroom tabs too), or reopening the app within
    // a minute would hand the revoked capability back.
    async _onPermissionRevoke(appId, capability, target) {
      const status = (t, k) => this._setAppPermissionsStatus(t, k);
      const isOpen = () => !!(target && typeof target.isOpen === 'function' && target.isOpen());
      const openAtAsk = isOpen();
      const ok = await ConfirmModal.show({
        title: target && target.name && target.permission
          ? tr('settings:appPermissions.revoke.confirmTitleNamed', { permission: target.permission, app: target.name })
          : tr('settings:appPermissions.revoke.confirmTitle'),
        message: openAtAsk
          ? tr('settings:appPermissions.revoke.confirmMessageOpen', { app: target.name })
          : tr('settings:appPermissions.revoke.confirmMessage'),
        confirmLabel: openAtAsk
          ? tr('settings:appPermissions.revoke.confirmButtonClose')
          : tr('settings:appPermissions.revoke.confirmButton'),
        danger: true,
      });
      if (!ok) return;
      if (this._isDemoGrant(appId)) { status(tr('settings:appPermissions.status.demoData'), 'info'); return; }
      try {
        const r = await fetch(
          `/api/me/permission-grants/${appId}/${encodeURIComponent(capability)}`,
          { method: 'DELETE', credentials: 'same-origin' }
        );
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { status(j.error || tr('settings:appPermissions.status.revokeFailed'), 'error'); return; }
        const appView = typeof window !== 'undefined' ? window.AppView : null;
        if (target && target.slug && appView && typeof appView.forgetToken === 'function') {
          appView.forgetToken(target.slug);
        }
        // Asked again now, not at the dialog: see the comment above.
        const closed = isOpen() && typeof target.close === 'function';
        if (closed) target.close();
        status(closed
          ? tr('settings:appPermissions.status.revokedClosed', { app: target.name })
          : tr('settings:appPermissions.status.revoked'), 'ok');
        this._renderAppPermissions();
      } catch (err) {
        status(tr('settings:appPermissions.status.networkError', { reason: err.message }), 'error');
      }
    },

    // Revoke every active capability of one app (#6512 item 4), from the
    // Revoke all button beside its name. There is no bulk endpoint and none
    // is needed: each capability goes through the same DELETE a single
    // revoke uses, one after another, and a failed one does not stop the
    // rest, because taking back three of four is better than stopping at
    // the first refusal. What follows a success is _onPermissionRevoke's:
    // the cached grant set is dropped, then the app is closed if it is open
    // in this tab NOW, since its frame holds whatever was just revoked. A
    // partial result says so as an error, and the list is drawn again so
    // the rows that still show Revoke are the ones still allowed.
    async _onPermissionRevokeAll(appId, capabilities, target) {
      const status = (t, k) => this._setAppPermissionsStatus(t, k);
      const list = Array.isArray(capabilities) ? capabilities.filter(Boolean) : [];
      if (!list.length) return;
      const isOpen = () => !!(target && typeof target.isOpen === 'function' && target.isOpen());
      const name = (target && target.name) || '';
      const openAtAsk = isOpen();
      const ok = await ConfirmModal.show({
        title: tr('settings:appPermissions.revokeAll.confirmTitle', { app: name }),
        message: openAtAsk
          ? tr('settings:appPermissions.revokeAll.confirmMessageOpen', { app: name })
          : tr('settings:appPermissions.revokeAll.confirmMessage'),
        confirmLabel: openAtAsk
          ? tr('settings:appPermissions.revokeAll.confirmButtonClose')
          : tr('settings:appPermissions.revokeAll.confirmButton'),
        danger: true,
      });
      if (!ok) return;
      if (this._isDemoGrant(appId)) { status(tr('settings:appPermissions.status.demoData'), 'info'); return; }
      let revoked = 0;
      let failure = '';
      for (const capability of list) {
        try {
          const r = await fetch(
            `/api/me/permission-grants/${appId}/${encodeURIComponent(capability)}`,
            { method: 'DELETE', credentials: 'same-origin' }
          );
          if (r.ok) { revoked += 1; continue; }
          const j = await r.json().catch(() => ({}));
          failure = j.error || tr('settings:appPermissions.status.revokeFailed');
        } catch (err) {
          failure = tr('settings:appPermissions.status.networkError', { reason: err.message });
        }
      }
      if (!revoked) { status(failure, 'error'); return; }
      const appView = typeof window !== 'undefined' ? window.AppView : null;
      if (target && target.slug && appView && typeof appView.forgetToken === 'function') {
        appView.forgetToken(target.slug);
      }
      const closed = isOpen() && typeof target.close === 'function';
      if (closed) target.close();
      if (revoked < list.length) status(tr('settings:appPermissions.status.revokedSome'), 'error');
      else {
        status(closed
          ? tr('settings:appPermissions.status.revokedAllClosed', { app: name })
          : tr('settings:appPermissions.status.revokedAll'), 'ok');
      }
      this._renderAppPermissions();
    },

    // The way back from Revoke, for the same reason the AI rows grew one
    // (#1957): re-approving otherwise depends on the app asking again, and
    // an app that never asks again never opens the prompt. The grant POST is
    // an upsert keyed on (slug, capability) that re-activates the row, and
    // it re-checks the declaration server-side — so an app that has since
    // dropped the capability from its dapp.json is refused here too, which
    // is the answer we want to show.
    //
    // No confirm dialog: this is not destructive, and the row's copy already
    // says what the click restores.
    async _onPermissionReenable(appId, appSlug, capability) {
      const status = (t, k) => this._setAppPermissionsStatus(t, k);
      if (!appSlug) { status(tr('settings:appPermissions.status.unknownApp'), 'error'); return; }
      // The fabricated ?demo=1 rows name apps that do not exist, so the POST
      // would 404. Same guard the revoke path above has.
      if (this._isDemoGrant(appId)) { status(tr('settings:appPermissions.status.demoData'), 'info'); return; }
      try {
        const r = await fetch('/api/me/permission-grants', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ appSlug, capability }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          status(j.code === 'not_declared'
            ? tr('settings:appPermissions.status.notDeclared')
            : (j.error || tr('settings:appPermissions.status.reenableFailed')), 'error');
          return;
        }
        status(tr('settings:appPermissions.status.reenabled'), 'ok');
        this._renderAppPermissions();
      } catch (err) {
        status(tr('settings:appPermissions.status.networkError', { reason: err.message }), 'error');
      }
    },

    // ── Wallet linking ───────────────────────────────────────────

    _renderWalletSection() {
      const section = document.getElementById('wallet-section');
      if (!section) return;
      if (!this.state.walletLinkEnabled) { section.classList.add('hidden'); return; }
      section.classList.remove('hidden');

      const unlinked = document.getElementById('wallet-unlinked');
      const linking = document.getElementById('wallet-linking');
      const linked = document.getElementById('wallet-linked');
      unlinked.classList.add('hidden');
      linking.classList.add('hidden');
      linked.classList.add('hidden');

      if (this.state.usernodePubkey) {
        linked.classList.remove('hidden');
        const display = document.getElementById('wallet-pubkey-display');
        const pk = this.state.usernodePubkey;
        display.textContent = pk.length > 20 ? pk.slice(0, 10) + '…' + pk.slice(-6) : pk;
        display.title = pk;
      } else if (this._walletPollTimer) {
        linking.classList.remove('hidden');
      } else {
        unlinked.classList.remove('hidden');
      }
    },

    async _startWalletLink() {
      const btn = document.getElementById('wallet-link-btn');
      btn.disabled = true;
      try {
        const r = await fetch('/api/me/wallet-link', {
          method: 'POST', credentials: 'same-origin',
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          this._setWalletStatus(j.error || tr('settings:wallet.status.startFailed'), 'error');
          btn.disabled = false;
          return;
        }
        const qrPayload = JSON.stringify(j.qr);
        this._walletExpiresAt = new Date(j.expiresAt).getTime();

        const container = document.getElementById('wallet-qr-canvas');
        container.innerHTML = '';
        if (window.QRCode) {
          new QRCode(container, {
            text: qrPayload,
            width: 180,
            height: 180,
            colorDark: '#1a1a30',
            colorLight: '#ffffff',
            correctLevel: QRCode.CorrectLevel.L,
          });
        }

        this._startWalletPolling();
        this._startWalletCountdown();
        this._renderWalletSection();
      } catch (err) {
        this._setWalletStatus(tr('settings:wallet.status.networkError', { reason: err.message }), 'error');
        btn.disabled = false;
      }
    },

    _startWalletPolling() {
      this._stopWalletPolling();
      const check = async () => {
        try {
          const r = await fetch('/api/me/wallet-link/status', { credentials: 'same-origin' });
          const j = await r.json();
          if (j.linked) {
            this.state.usernodePubkey = j.pubkey;
            this._stopWalletPolling();
            this._renderWalletSection();
            this._setWalletStatus(tr('settings:wallet.status.linked'), 'ok');
          }
        } catch {}
      };
      check();
      this._walletPollTimer = setInterval(check, 2000);
    },

    _stopWalletPolling() {
      if (this._walletPollTimer) { clearInterval(this._walletPollTimer); this._walletPollTimer = null; }
      if (this._walletCountdownTimer) { clearInterval(this._walletCountdownTimer); this._walletCountdownTimer = null; }
      this._walletExpiresAt = null;
    },

    _startWalletCountdown() {
      if (this._walletCountdownTimer) clearInterval(this._walletCountdownTimer);
      const label = document.getElementById('wallet-link-timer');
      const tick = () => {
        if (!this._walletExpiresAt) { label.textContent = ''; return; }
        const remaining = Math.max(0, this._walletExpiresAt - Date.now());
        if (remaining <= 0) {
          this._cancelWalletLink();
          this._setWalletStatus(tr('settings:wallet.status.qrExpired'), 'error');
          return;
        }
        const m = Math.floor(remaining / 60000);
        const s = Math.floor((remaining % 60000) / 1000);
        label.textContent = tr('settings:wallet.link.expiresIn', { time: m + ':' + String(s).padStart(2, '0') });
      };
      tick();
      this._walletCountdownTimer = setInterval(tick, 1000);
    },

    _cancelWalletLink() {
      this._stopWalletPolling();
      const btn = document.getElementById('wallet-link-btn');
      if (btn) btn.disabled = false;
      this._renderWalletSection();
    },

    async _unlinkWallet() {
      if (!await PlatformUI.confirm({ title: tr('settings:wallet.unlink.confirmTitle'), confirmLabel: tr('settings:wallet.unlink.confirmButton'), danger: true })) return;
      try {
        const r = await fetch('/api/me/wallet-link', { method: 'DELETE', credentials: 'same-origin' });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          this._setWalletStatus(j.error || tr('settings:wallet.status.unlinkFailed'), 'error');
          return;
        }
        this.state.usernodePubkey = null;
        this._renderWalletSection();
        this._setWalletStatus(tr('settings:wallet.status.unlinked'), 'ok');
      } catch (err) {
        this._setWalletStatus(tr('settings:wallet.status.networkError', { reason: err.message }), 'error');
      }
    },

    _setWalletStatus(text, kind) {
      const el = document.getElementById('wallet-status');
      if (!el) return;
      paintStatus(el, text, kind);
      if (kind === 'ok') setTimeout(() => el.classList.add('hidden'), 3000);
    },

    // ── "Homeroom app" sections (profile-and-settings-to-web migration) ──
    //
    // The mobile app's native App Settings absorbed into this modal,
    // rendered from the bridge's getSettingsState snapshot (bridge v3,
    // NATIVE-BRIDGE.md). Capability-gated: hidden on desktop, in child-app
    // iframes, and on old app builds. Every setter resolves the refreshed
    // snapshot, so the section re-renders from a single source of truth.
    // Device benchmark / HTTP debug logs stay native and are reached via
    // openNativeScreen deep-links; terms render in a web sheet backed by
    // the session-authed /challenges-api terms twins (thin-shell
    // migration).

    _usernodeState: null,
    // Bumped per read attempt so only the NEWEST one writes to the DOM:
    // open() can re-render while an earlier 12s read is still in flight,
    // and the manual retry / auth-status retry can overlap with either.
    _usernodeRenderToken: 0,
    _usernodeAuthStatusListener: null,
    // The auth-status re-attempt is once per mount, not a loop.
    _usernodeAuthRetryUsed: false,

    // ── Notification-permission tap state ─────────────────────────────
    // `{ tone, title, text, settings }` — the visible explanation for a
    // tap that could not open an OS prompt. A dead end MUST leave one of
    // these behind; a silent return is the bug this section is fixing.
    _unNotifNotice: null,
    // The pre-render iOS push probe runs once per section mount, so the
    // row decides from the real permission rather than from the
    // `exactAlarmGranted` proxy — and so re-rendering can never loop.
    _unPushProbed: false,
    // Re-entrancy guard: the row and the chip both drive the same ask.
    _unRequestInFlight: false,
    // Tri-state, from NativeChrome.supports(): null = the probe could not
    // say (degraded handshake / no advertised list — issue #978), and an
    // inconclusive answer must never render a dead "Open notification
    // settings" button.
    _unCanOpenNotifSettings: null,

    // Plain-language reason per bridge failure `kind` (the record from
    // usernode.getLastNativeReadError). Without this the section could only
    // ever say "something went wrong": the bridge's chrome reads resolve
    // null on a timeout, on a native rejection and on a refused privileged
    // handshake alike, which is exactly what made issue #978 impossible to
    // diagnose from the device. Message ids, read when the panel is painted.
    USERNODE_READ_ERROR_REASONS: {
      'timeout': 'settings:usernode.readError.timeout',
      'rejected': 'settings:usernode.readError.rejected',
      'probe-inconclusive': 'settings:usernode.readError.probeInconclusive',
      'no-transport': 'settings:usernode.readError.noTransport',
      'not-native': 'settings:usernode.readError.notNative',
      'page-changed': 'settings:usernode.readError.pageChanged',
      'privileged-unavailable': 'settings:usernode.readError.privilegedUnavailable',
    },
    USERNODE_READ_ERROR_FALLBACK: 'settings:usernode.readError.fallback',

    // ── The connection panel ──────────────────────────────────────────
    //
    // Plain-language reason per privileged-handshake `state` (the record
    // from usernode.getBridgeDiagnostics). The remedies are ordered the
    // way the report that prompted this was: force-close and reopen
    // FIRST, reinstall only if that doesn't clear it. Message ids, read
    // when the panel is painted.
    PRIVILEGED_STATE_LABELS: {
      'ready': 'settings:usernode.connection.state.ready',
      'blocked-frame': 'settings:usernode.connection.state.blockedFrame',
      'unsupported': 'settings:usernode.connection.state.unsupported',
      'inconclusive': 'settings:usernode.connection.state.inconclusive',
      'unattached': 'settings:usernode.connection.state.unattached',
      'unknown': 'settings:usernode.connection.state.unknown',
    },
    PRIVILEGED_STATE_REASONS: {
      'ready': 'settings:usernode.connection.reason.ready',
      'blocked-frame': 'settings:usernode.connection.reason.blockedFrame',
      'unsupported': 'settings:usernode.connection.reason.unsupported',
      'inconclusive': 'settings:usernode.connection.reason.inconclusive',
      'unattached': 'settings:usernode.connection.reason.unattached',
      'unknown': 'settings:usernode.connection.reason.unknown',
    },

    // Staging/screenshot hook: `?bridgediag=demo`, in the fragment query
    // (#settings?bridgediag=demo) or the ordinary query string. READ-ONLY
    // — it renders a fixed synthetic snapshot and disables both actions,
    // so it can never touch a real bridge, a real session or any state.
    DEMO_BRIDGE_DIAGNOSTICS: {
      isNative: true,
      isTopFrame: true,
      inIframe: false,
      usesIframeRelay: false,
      hasNativeChannel: true,
      origin: 'https://staging.demo.invalid',
      bridgeVersion: 5,
      capabilities: ['getBridgeInfo', 'getSettingsState', 'logout'],
      appVersion: '0.0.0-demo',
      buildNumber: '0',
      privileged: {
        state: 'blocked-frame',
        code: 'privileged_frame_unauthorized',
        kind: 'privileged-unavailable',
        message: 'Staging demo: privileged bridge is unavailable for this main frame',
        at: 0,
        attempts: 3,
      },
      lastErrors: {
        getSettingsState: {
          method: 'getSettingsState',
          kind: 'privileged-unavailable',
          message: 'Staging demo: privileged bridge is unavailable for this main frame',
          at: 0,
        },
      },
      collectedAt: 0,
    },

    _bridgeDiagDemo() {
      return this._demoParam('bridgediag') === 'demo';
    },

    // ── `?bridgediag=wallet` ──────────────────────────────────────────
    //
    // Screenshot-state deep link for the connection panel's OTHER refusal:
    // the secure connection is fine, but native admission reported
    // `native_session_wallet_pool_exhausted` — no seeded wallet is left for
    // this account. That state used to announce itself as a pop-up (the
    // "Connect your existing wallet" dialog opened on every admission
    // retry); it is a button on this panel now, and this link is how a
    // browser can reach it. Same rules as `?bridgediag=demo`: a fixed
    // snapshot, no bridge call, no writes, and the button renders disabled
    // because there is no real session for it to recover.
    _walletRecoveryDemo() {
      return this._demoParam('bridgediag') === 'wallet';
    },

    DEMO_BRIDGE_DIAGNOSTICS_WALLET: {
      isNative: true,
      isTopFrame: true,
      inIframe: false,
      usesIframeRelay: false,
      hasNativeChannel: true,
      origin: 'https://staging.demo.invalid',
      bridgeVersion: 5,
      capabilities: ['getBridgeInfo', 'getSettingsState', 'logout',
        'establishNativeSession'],
      appVersion: '0.0.0-demo',
      buildNumber: '0',
      privileged: {
        state: 'ready',
        code: null,
        kind: null,
        message: 'Staging demo: no seeded wallet is available for this account',
        at: 0,
        attempts: 1,
      },
      lastErrors: {},
      collectedAt: 0,
    },

    // ── `?widgeticons=demo` ───────────────────────────────────────────
    //
    // Screenshot-state deep link for the widget-icon diagnostics box,
    // same reasoning as `?usernodedemo=ios` above: every value the box
    // reports comes from the iOS widget registry, so on a browser the
    // whole thing is empty and the row cannot be reviewed or captured
    // from any URL. Fixed snapshot — no bridge call, no writes.
    //
    // The snapshot is deliberately the interesting state rather than the
    // healthy one: the capability list "couldn't say" (a degraded
    // getBridgeInfo, which is the failure that made the released shell
    // fix invisible), overridden by a behavioural verdict of `supported`
    // bound to a demo build, with one entry still missing its dark face
    // and one whose marker doesn't match what SV last recorded.
    _widgetIconsDemo() {
      return this._demoParam('widgeticons') === 'demo';
    },

    // Both demo links accept their param in the hash query or the search
    // string, because a hash route carries its own query
    // (`/#settings/usernode?usernodedemo=ios`) while a plain capture URL
    // may put it before the fragment.
    // Every demo link the Homeroom-app page reads, as one string, so a route
    // can tell when an address changed them.
    _usernodeDemo() {
      return ['bridgediag', 'widgeticons', 'usernodedemo']
        .map((name) => this._demoParam(name) || '').join('|');
    },

    _demoParam(name) {
      try {
        const hash = String(window.location.hash || '');
        const q = hash.indexOf('?');
        if (q !== -1) {
          const inHash = new URLSearchParams(hash.slice(q + 1)).get(name);
          if (inHash) return inHash;
        }
        return new URLSearchParams(window.location.search).get(name) || null;
      } catch (_) {
        return null;
      }
    },

    // ── `?usernodedemo=ios` / `=ios-denied` ───────────────────────────
    //
    // Screenshot-state deep link for the device-permissions rows, which
    // otherwise exist ONLY inside the native app: a browser has no
    // `usernode.isNative`, so the whole section is hidden and the row
    // this link exists to pin was unreachable from any URL. Pure UI
    // state — a fixed snapshot, no bridge call, no writes — so it is
    // ungated for the same reason as `?shot=menu-nav` in public/js/app.js.
    //
    // The snapshot deliberately reports `exactAlarmGranted: true` with an
    // un-determined push status, because that combination IS the bug: iOS
    // has no exact alarms, the boolean is a lagging proxy, and a screen
    // that trusts it renders "Granted" with no control at all — which is
    // precisely "tapping it does nothing". The row must still offer the
    // ask. `ios-denied` renders the other dead end (determined-denied,
    // where iOS presents no prompt however often it is asked).
    // `foreground-only` renders an Android build that produces blocks only
    // while it is open: no permission rows, and the note saying so.
    _unDemoMode() {
      const v = this._demoParam('usernodedemo');
      return (v === 'ios' || v === 'ios-denied' || v === 'foreground-only') ? v : null;
    },

    DEMO_FOREGROUND_ONLY_STATE: {
      buildInfo: { appVersion: '0.0.0-demo', buildNumber: '0' },
      debugMode: false,
      facematchStrict: true,
      authStatus: 'authenticated',
      permissions: {
        platform: 'android',
        exactAlarmGranted: false,
        batteryOptDisabled: false,
        deviceManufacturer: null,
        backgroundProduction: false,
      },
    },

    DEMO_USERNODE_STATE: {
      buildInfo: { appVersion: '0.0.0-demo', buildNumber: '0' },
      debugMode: false,
      facematchStrict: true,
      authStatus: 'authenticated',
      permissions: {
        platform: 'ios',
        exactAlarmGranted: true,
        batteryOptDisabled: null,
        deviceManufacturer: null,
      },
    },

    DEMO_WIDGET_ICON_DIAGNOSTICS: {
      mechanism: 'widget',
      registryLoaded: true,
      scheme: 'dark',
      capability: null,
      verdict: 'supported',
      resolved: true,
      build: { appVersion: '0.0.0-demo', buildNumber: '0' },
      confirmTried: true,
      lastHealAt: 0,
      lastHealOutcome: { kind: 'sent', sent: 1 },
      readError: {
        method: 'getBridgeInfo',
        kind: 'timeout',
        message: 'Staging demo: the capability probe did not answer',
        at: 0,
      },
      entries: [
        {
          id: 'demo-1', name: 'Weather', foreign: false, unknownApp: false,
          hasIcon: true, hasIconDark: true,
          recorded: 'tile:5:dual:🌤', desired: 'tile:5:dual:🌤', matches: true,
        },
        {
          id: 'demo-2', name: 'Ledger', foreign: false, unknownApp: false,
          hasIcon: true, hasIconDark: false,
          recorded: 'tile:5:dual:', desired: 'tile:5:dual:', matches: true,
        },
        {
          id: 'demo-3', name: 'Notes', foreign: false, unknownApp: false,
          hasIcon: true, hasIconDark: null,
          recorded: 'tile:5:light:📝', desired: 'tile:5:dual:📝', matches: false,
        },
      ],
    },

    // The snapshot Home keeps of the icon path. Read-only and synchronous
    // — the "Re-check" button below is what performs bridge I/O.
    //
    // Reached through `window.Home` rather than an import: home.js and
    // settings.js are both bundle modules, but Home is the owner of this
    // state and publishes itself as a global for exactly this kind of
    // cross-screen read (see the note above its publication).
    _widgetIconDiagnostics() {
      // The demo's heal timestamp is stamped at read time, not frozen in
      // the literal: a fixed `lastHealAt` would print as "never", and a
      // box that says "never checked" beside "sent 1" reads as a bug in
      // the box rather than a sample of a healthy pass.
      if (this._widgetIconsDemo()) {
        return Object.assign({}, this.DEMO_WIDGET_ICON_DIAGNOSTICS, {
          lastHealAt: Date.now() - 42000,
        });
      }
      const home = window.Home;
      if (!home || typeof home.widgetIconDiagnostics !== 'function') return null;
      try {
        return home.widgetIconDiagnostics();
      } catch (err) {
        console.warn('[settings] widgetIconDiagnostics failed:', err);
        return null;
      }
    },

    // ── Settings → "Homeroom app: widget icons" ──────────────────────
    //
    // Gated on being in the app (or the demo link), NEVER on the
    // capability or the mechanism: this box exists to explain why the
    // widget looks wrong, and every interesting case is one where some
    // part of that chain answered "no". Hiding it on a "no" would hide it
    // exactly when it is wanted — the same mistake the connection panel
    // above was written to undo.

    // #1808: the WHOLE instant, not a time of day. This stamps one
    // diagnostics line ("Last icon check: …") whose only reader is somebody
    // working out whether the widget's icon verdict is stale — and "02:41 PM"
    // with no day cannot answer that. It is a plain `toLocaleString()` rather
    // than the shared helper because a diagnostics line elides nothing and
    // this module cannot import: four test harnesses run its real source
    // through `vm.runInContext` as a classic script, where a top-level
    // `import` is a syntax error.
    _widgetIconTime(ms) {
      try { return new Date(ms).toLocaleString(undefined, inZone()); } catch (_) { return String(ms); }
    },

    // One line per pinned entry: what the widget says it holds, and
    // whether that matches what SV believes it last sent. A mismatch here
    // is the difference between "SV never sent it" and "SV sent it and
    // the app didn't keep it" — which are different bugs in different
    // repositories, and were previously indistinguishable from outside.

    _bridgeDiagnostics() {
      if (this._bridgeDiagDemo()) return this.DEMO_BRIDGE_DIAGNOSTICS;
      if (this._walletRecoveryDemo()) return this.DEMO_BRIDGE_DIAGNOSTICS_WALLET;
      const bridge = window.usernode;
      if (!bridge || typeof bridge.getBridgeDiagnostics !== 'function') {
        return null;
      }
      try {
        return bridge.getBridgeDiagnostics();
      } catch (err) {
        console.warn('[settings] getBridgeDiagnostics failed:', err);
        return null;
      }
    },

    _hasNativeCapability(name) {
      const diag = this._bridgeDiagnostics();
      return !!diag && Array.isArray(diag.capabilities) &&
        diag.capabilities.includes(name);
    },

    // The copyable report. Deliberately assembled from the diagnostics
    // snapshot only — it carries no capability token, no session cookie
    // and no user data, so it is safe to paste into an issue.
    _bridgeDiagnosticsText(diag) {
      const at = (ms) => {
        if (!ms) return 'never';
        try { return new Date(ms).toISOString(); } catch (_) { return String(ms); }
      };
      const lines = [
        'Homeroom bridge diagnostics',
        `collected: ${at(diag.collectedAt)}`,
        `origin: ${diag.origin || 'unknown'}`,
        `native: ${diag.isNative} topFrame: ${diag.isTopFrame} ` +
          `relay: ${diag.usesIframeRelay} channel: ${diag.hasNativeChannel}`,
        `bridge version: ${diag.bridgeVersion}`,
        `app: ${diag.appVersion || 'unknown'} (${diag.buildNumber || '?'})`,
        `capabilities: ${(diag.capabilities || []).join(', ') || 'none'}`,
        `privileged state: ${diag.privileged.state}` +
          (diag.privileged.code ? ` code: ${diag.privileged.code}` : '') +
          (diag.privileged.kind ? ` kind: ${diag.privileged.kind}` : ''),
        `privileged attempts: ${diag.privileged.attempts} ` +
          `last: ${at(diag.privileged.at)}`,
      ];
      if (diag.privileged.message) {
        lines.push(`privileged message: ${diag.privileged.message}`);
      }
      const methods = Object.keys(diag.lastErrors || {});
      lines.push(methods.length
        ? 'last read errors:'
        : 'last read errors: none');
      methods.forEach((method) => {
        const rec = diag.lastErrors[method];
        lines.push(`  ${method}: ${rec.kind}, ${rec.message || 'no message'} ` +
          `(${at(rec.at)})`);
      });
      const readiness = (window.SocialPush &&
        typeof SocialPush.readinessState === 'function')
        ? SocialPush.readinessState()
        : null;
      if (readiness) {
        lines.push(`push readiness: ready=${readiness.ready} ` +
          `attempts=${readiness.attempts} exhausted=${readiness.exhausted}` +
          (readiness.lastError ? ` last=${readiness.lastError}` : ''));
      }
      const session = (window.NativeChrome &&
        typeof NativeChrome.lastSessionFailure === 'function')
        ? NativeChrome.lastSessionFailure()
        : null;
      if (session) {
        lines.push(`last session failure: ${session.stage}, ` +
          `${session.message || 'no message'} (${at(session.at)})`);
      }
      return lines.join('\n');
    },

    // Rendered FIRST inside the Homeroom app section and independent of
    // the settings snapshot: when the handshake is refused there is no
    // snapshot, and this panel is the only thing that can say why.

    // Everything a stuck device can retry from here, in one press: a fresh
    // capability probe, a fresh admission attempt, a fresh readiness
    // budget, then a re-read of the settings snapshot.
    async _retryUsernodeConnection() {
      if (window.NativeChrome) {
        NativeChrome._infoPromise = null;
        try {
          if (typeof NativeChrome.getInfo === 'function') {
            await NativeChrome.getInfo();
          }
          if (typeof NativeChrome.recoverSessionAdmission === 'function') {
            await NativeChrome.recoverSessionAdmission();
          }
        } catch (err) {
          console.warn('[settings] connection retry failed:', err);
        }
      }
      if (window.SocialPush &&
          typeof SocialPush.retryBridgeReadiness === 'function') {
        try { SocialPush.retryBridgeReadiness(); } catch (_) {}
      }
      this._usernodeState = null;
      await this._renderUsernodeSection();
    },

    async _renderUsernodeSection() {
      // Gated on BEING IN THE APP, not on the getSettingsState capability.
      // That probe is itself a casualty of the failures this section now
      // diagnoses — a degraded getBridgeInfo answers "no capabilities", so
      // the section used to disappear exactly when the user needed it most.
      // getBridgeInfo is unprivileged, so `isNative` stays readable on a
      // device whose privileged handshake is refused.
      const bridge = window.usernode;
      // The demo links this drawing follows (see route).
      this._usernodeDemoKey = this._usernodeDemo();
      const demo = this._unDemoMode();
      const gated = this._bridgeDiagDemo() || this._walletRecoveryDemo() ||
        this._widgetIconsDemo() || !!demo ||
        (!!bridge && bridge.isNative === true);
      // The gate resolves asynchronously downstream, so the "Homeroom app"
      // menu row is only settled here — re-render the nav either way.
      if (!gated) {
        this._usernodeGated = false;
        this._publishUsernode();
        this._renderNavIfOpen();
        return;
      }
      this._usernodeGated = true;
      this._publishUsernode();
      this._renderNavIfOpen();
      const token = ++this._usernodeRenderToken;
      // A fresh mount re-probes the real notification permission (below)
      // and drops the previous visit's dead-end notice.
      this._unPushProbed = false;
      this._unNotifNotice = null;
      if (demo) {
        // Fixed snapshot, no bridge call: this link exists to make the
        // notification row reachable from a browser.
        this._usernodeState = demo === 'foreground-only'
          ? this.DEMO_FOREGROUND_ONLY_STATE
          : this.DEMO_USERNODE_STATE;
        this._unPushStatus = demo === 'ios-denied' ? 'denied' : 'undetermined';
        this._unPushProbed = true;
        this._unCanOpenNotifSettings = true;
        this._usernodeLoading = false;
      this._publishUsernode();
        return;
      }
      if (!this._usernodeState) {
        // The in-place progress line, which a retry swaps in while leaving
        // the rest of the section up.
        this._usernodeLoading = true;
        this._publishUsernode();
      }
      let state = null;
      try {
        state = (window.usernode &&
          typeof window.usernode.getSettingsState === 'function')
          ? await window.usernode.getSettingsState()
          : null;
      } catch (err) {
        // Defensive only: the bridge read resolves a fallback rather than
        // rejecting, so the reason arrives through the record below.
        console.warn('[settings] getSettingsState failed:', err);
      }
      // A later attempt already painted — its result is the fresher one.
      if (token !== this._usernodeRenderToken) return;
      if (state) this._usernodeState = state;
      if (!this._usernodeState) {
        // The app may simply still be booting; retry itself once it reports
        // a ready identity, so the section fills in without a tap.
        this._armUsernodeAuthStatusRetry();
        this._usernodeLoading = false;
        this._publishUsernode();
        return;
      }
      this._clearUsernodeAuthStatusRetry();
      this._usernodeLoading = false;
      this._publishUsernode();
      // Both used to be renderers that fetched into their own host and
      // repainted it through a local closure. They fill their slice of the
      // model instead, so the rest of the body never waits on either.
      this._initSocialPush();
      this._initBlockProduction();
      this._probeUnNotifPermission(token);
    },

    // The row's truth, read BEFORE it can mislead.
    //
    // `permissions.exactAlarmGranted` is a lagging proxy on iOS — there
    // are no exact alarms there — and a build that reports it `true`
    // painted "Notifications — Granted" with no control whatsoever, which
    // is exactly the reported "nothing happens at all when I tap it".
    // public/js/native-chrome.js's first-run sheet has always overridden
    // that boolean with the real push status before deciding; this screen
    // never did, which is why #1192 (which only settles the status AFTER a
    // request) did not reach the in-app Settings case.
    //
    // Runs once per mount and only re-renders on a real change, so it
    // cannot loop. Token-guarded like every other write to this section.
    async _probeUnNotifPermission(token) {
      if (this._unPushProbed) return;
      this._unPushProbed = true;
      const nc = window.NativeChrome;
      if (!nc) return;
      let status = this._unPushStatus;
      let canOpen = this._unCanOpenNotifSettings;
      try {
        if (typeof nc.iosPushPermissionStatus === 'function') {
          status = await nc.iosPushPermissionStatus();
        }
        if (typeof nc.supports === 'function') {
          canOpen = await nc.supports('openNotificationSettings');
        }
      } catch (err) {
        // Never fatal: an unreadable probe leaves the row tappable and the
        // ask routed through the bridge, which is the safe default.
        console.warn('[settings] notification permission probe failed:', err);
        return;
      }
      if (token !== this._usernodeRenderToken) return;
      const changed = status !== this._unPushStatus ||
        canOpen !== this._unCanOpenNotifSettings;
      this._unCanOpenNotifSettings = canOpen;
      if (status != null) this._unPushStatus = status;
      if (changed) this._usernodeLoading = false;
      this._publishUsernode();
    },

    // Why the snapshot came back empty, straight from the bridge's
    // out-of-band record. null when the bridge is too old to keep one.
    _usernodeReadError() {
      if (this._bridgeDiagDemo()) {
        return this.DEMO_BRIDGE_DIAGNOSTICS.lastErrors.getSettingsState;
      }
      return (window.NativeChrome &&
        typeof NativeChrome.lastReadError === 'function')
        ? NativeChrome.lastReadError('getSettingsState')
        : null;
    },

    // One re-attempt per mount when the app reports a ready identity: a
    // Settings screen opened during app start-up is the common way to see
    // the read fail, and the app announces readiness on this event
    // (native-chrome.js listens to the same one to start the node).
    _armUsernodeAuthStatusRetry() {
      if (this._usernodeAuthStatusListener) return;
      if (this._usernodeAuthRetryUsed) return;
      const listener = (e) => {
        const d = e && e.detail;
        if (!d || d.phase !== 'ready') return;
        this._usernodeAuthRetryUsed = true;
        this._clearUsernodeAuthStatusRetry();
        this._renderUsernodeSection();
      };
      this._usernodeAuthStatusListener = listener;
      window.addEventListener('usernode:auth-status', listener);
    },

    _clearUsernodeAuthStatusRetry() {
      if (!this._usernodeAuthStatusListener) return;
      window.removeEventListener(
        'usernode:auth-status', this._usernodeAuthStatusListener
      );
      this._usernodeAuthStatusListener = null;
    },





    // `opts.onActivate` turns the row itself into a real control.
    //
    // Without it the row is a plain `div` with no listener, so tapping it
    // is a no-op BY CONSTRUCTION — and the only control was a small chip
    // rendered underneath, conditionally. On a phone the row is what a
    // thumb lands on, so the notifications row now carries the tap and the
    // chip is a second affordance rather than the only one.

    _openNativeScreen(screen, failMsg) {
      if (!window.usernode ||
          typeof window.usernode.openNativeScreen !== 'function') return;
      window.usernode.openNativeScreen(screen).catch((err) => {
        console.warn('[settings] openNativeScreen failed:', err);
        if (window.PlatformUI) {
          PlatformUI.toast(this._nativeActionMessage(err, failMsg));
        }
      });
    },

    // A refused privileged handshake is not "action failed" — nothing the
    // user does on this screen will work until the app re-establishes it,
    // so say that instead of a message that invites another tap. The
    // bridge tags those rejections; see usernodePrivileged in
    // public/usernode-bridge.js.
    _nativeActionMessage(err, fallback) {
      if (err && err.usernodePrivileged === true) {
        return tr('settings:usernode.action.notAccepting');
      }
      return fallback;
    },

    // iOS only: the settled notification-permission status, once this
    // screen has asked for it. Null means "no answer of our own yet", and
    // the row falls back to the snapshot boolean.
    _unPushStatus: null,

    // "Allow notifications" / "Request permissions".
    //
    // Android's returned snapshot IS the answer, so it re-renders straight
    // from it. iOS's is not: the native permission caches settle
    // asynchronously after the OS dialog and some builds resolve
    // requestPermissions() before the user has even answered, so trusting
    // that one read repainted the row as "Not granted" moments after a
    // real grant — and nothing started push registration. Defer to
    // NativeChrome.settleIosPushGrant, which polls for a determined status
    // and kicks SocialPush, so this screen and the first-run sheet
    // complete a grant identically.
    async _unRequestPermissions(isAndroid) {
      if (this._unRequestInFlight) return;
      this._unRequestInFlight = true;
      // Visible acknowledgement BEFORE anything can block: whatever the
      // rest of this does, the tap is never again silent.
      this._unNotifNotice = {
        tone: 'info',
        text: isAndroid
          ? tr('settings:usernode.notif.openingPermissionPrompt')
          : tr('settings:usernode.notif.openingNotificationPrompt'),
      };
      this._usernodeLoading = false;
      this._publishUsernode();
      try {
        await this._runNotifPermissionTap(isAndroid);
      } finally {
        this._unRequestInFlight = false;
        this._usernodeLoading = false;
      this._publishUsernode();
      }
    },

    // Route the tap through the pure decision functions in
    // public/js/native-chrome.js, then route the ANSWER through the second
    // one. Every branch either opens something or leaves a visible notice
    // plus a console.error — there is no path back out of here that looks
    // like nothing happened.
    async _runNotifPermissionTap(isAndroid) {
      const nc = window.NativeChrome;
      const bridge = window.usernode;
      const hasRequest = !!bridge &&
        typeof bridge.requestPermissions === 'function';
      if (this._unDemoMode()) {
        // The browser demo link has no app behind it. Still answers
        // visibly — but this is a preview, not a dead end, so it does not
        // log the diagnostic error the real branches do.
        this._unNotifNotice = {
          tone: 'info',
          text: tr('settings:usernode.notif.preview'),
        };
        return;
      }
      if (!nc || typeof nc.decideNotificationTap !== 'function') {
        // Old bundle: fall back to the plain ask rather than refusing.
        if (!hasRequest) {
          this._unNotifDeadEnd('no-bridge', {
            text: tr('settings:usernode.notif.onlyInApp'),
            settings: false,
          });
          return;
        }
        await this._applyNotifAnswer(isAndroid,
          await bridge.requestPermissions());
        return;
      }
      const plan = nc.decideNotificationTap({
        isNative: !!bridge && bridge.isNative === true,
        hasRequestMethod: hasRequest,
        supported: typeof nc.supports === 'function'
          ? await nc.supports('requestPermissions')
          : null,
        isAndroid,
        pushStatus: this._unPushStatus,
        canOpenSettings: this._unCanOpenNotifSettings === true,
      });
      if (plan.verdict !== 'request') {
        if (plan.verdict === 'already') {
          // Not a failure — say so and stop, rather than calling a method
          // that resolves instantly and shows nothing.
          this._unNotifNotice = {
            tone: 'ok',
            text: tr('settings:usernode.notif.alreadyAllowed'),
          };
          return;
        }
        this._unNotifDeadEnd(plan.verdict, {
          text: this._notifDeadEndText(plan, isAndroid),
          settings: plan.settings === true,
          reason: plan.reason,
        });
        return;
      }
      let next = null;
      try {
        next = await this._unRaceNativeAnswer(bridge.requestPermissions());
      } catch (err) {
        this._unNotifDeadEnd(err && err.usernodeNoAnswer ? 'no-answer' : 'failed', {
          text: err && err.usernodeNoAnswer
            ? tr('settings:usernode.notif.noAnswer')
            : this._nativeActionMessage(err,
                tr('settings:usernode.notif.requestFailed')),
          settings: this._unCanOpenNotifSettings === true,
          reason: err && err.message,
        });
        return;
      }
      await this._applyNotifAnswer(isAndroid, next);
    },

    // What the tap ended up as, once the app answered. `settleIosPushGrant`
    // stays the authority on iOS: the native permission caches settle
    // asynchronously after the OS dialog and some builds resolve
    // requestPermissions() before the user has even answered, so trusting
    // that one read repainted the row as "Not granted" moments after a real
    // grant — and nothing started push registration. It polls for a
    // determined status and kicks SocialPush, so this screen and the
    // first-run sheet complete a grant identically.
    async _applyNotifAnswer(isAndroid, next) {
      if (next && typeof next === 'object') this._usernodeState = next;
      const granted = !!(next && next.granted === true);
      const nc = window.NativeChrome;
      if (!isAndroid && nc && typeof nc.settleIosPushGrant === 'function') {
        const settled = await nc.settleIosPushGrant(granted);
        this._unPushStatus = settled.status || this._unPushStatus;
      }
      const outcome = (nc && typeof nc.decideNotificationOutcome === 'function')
        ? nc.decideNotificationOutcome({
            isAndroid,
            granted: granted || this._unPushStatus === 'granted',
            pushStatus: this._unPushStatus,
            canOpenSettings: this._unCanOpenNotifSettings === true,
          })
        : { verdict: granted ? 'granted' : 'declined', settings: false };
      if (outcome.verdict === 'granted') {
        this._unNotifNotice = {
          tone: 'ok',
          text: isAndroid
            ? tr('settings:usernode.notif.permissionGranted')
            : tr('settings:usernode.notif.nowAllowed'),
        };
        this._usernodeLoading = false;
      this._publishUsernode();
        return;
      }
      this._unNotifDeadEnd(outcome.verdict, {
        text: this._notifDeadEndText(outcome, isAndroid),
        settings: outcome.settings === true,
        reason: outcome.reason,
      });
      this._usernodeLoading = false;
      this._publishUsernode();
    },

    // The bridge's own ceiling for requestPermissions is two minutes,
    // which is the right ceiling for a prompt a user has to read but a
    // terrible one for a native side that never answers: two minutes of a
    // disabled control and no explanation reads as a dead tap. Surface the
    // silence at 20s; a late real answer still applies through the
    // section's normal re-render.
    _UN_NATIVE_ANSWER_MS: 20000,

    _unRaceNativeAnswer(promise) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          const err = new Error('the Homeroom app did not answer in time');
          err.usernodeNoAnswer = true;
          reject(err);
        }, this._UN_NATIVE_ANSWER_MS);
        Promise.resolve(promise).then((value) => {
          clearTimeout(timer);
          if (settled) {
            // The app answered after we gave up — honour it anyway.
            this._applyNotifAnswer(
              (this._usernodeState && this._usernodeState.permissions &&
                this._usernodeState.permissions.platform) === 'android',
              value
            ).catch(() => {});
            return;
          }
          settled = true;
          resolve(value);
        }, (err) => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          reject(err);
        });
      });
    },

    _notifDeadEndText(plan, isAndroid) {
      switch (plan.verdict) {
        case 'no-bridge':
          return tr('settings:usernode.notif.onlyInApp');
        case 'unsupported':
          return tr('settings:usernode.notif.unsupported');
        case 'settings':
          return isAndroid
            ? tr('settings:usernode.notif.deniedAndroid')
            : tr('settings:usernode.notif.deniedIos');
        case 'declined':
          return tr('settings:usernode.notif.declined');
        case 'silent':
          return tr('settings:usernode.notif.silent');
        default:
          return tr('settings:usernode.notif.couldNotOpen');
      }
    },

    // Every dead end lands here: a visible notice AND a console error, so
    // the next report of a dead tap comes with a line in the dev console
    // saying which branch swallowed it.
    _unNotifDeadEnd(kind, opts) {
      const reason = (opts && opts.reason) || '(no reason recorded)';
      console.error(
        `[settings] notification permission dead end (${kind}): ${reason}`
      );
      this._unNotifNotice = {
        tone: 'warn',
        text: (opts && opts.text) || tr('settings:usernode.notif.couldNotOpen'),
        settings: !!(opts && opts.settings),
      };
    },

    // The notice, plus — only when the app positively advertises the
    // capability — a way out of a determined-denied permission. A button
    // that cannot work is worse than no button, so an inconclusive
    // capability probe (null) renders the manual instructions instead.

    // Awaits a bridge setter and re-renders the section from the refreshed
    // snapshot it resolves with.
    async _unApply(promise) {
      const state = await promise;
      if (state && typeof state === 'object') {
        this._usernodeState = state;
        this._usernodeLoading = false;
      this._publishUsernode();
      }
    },

    // ── Terms (thin-shell migration) ──────────────────────────────────
    // The native terms screen is gone; the current published terms and
    // the consent write now live on the session-authed /challenges-api
    // twins of the v4 terms endpoints (src/routes/topochain/mobile.js).
    // Shared by the About & legal section below, profile.js's gated
    // token-allocation notice, and the first-run prompt (issue #1297,
    // ./terms-first-run.js + app.js's ?shot=terms-consent). `onAccepted`
    // fires after a successful accept so callers can refresh their own
    // terms-gated UI.
    //
    // opts (all optional):
    //   firstRun — first-arrival framing: an intro line explaining why
    //     the sheet appeared, plus a Decline button that records
    //     status 'refused' (the upsert on (user, version) means a later
    //     accept from the profile notice still works). A backdrop
    //     dismissal / Close records nothing, so an unanswered prompt
    //     comes back on the next page load.
    //   blocking — the native-app gate (#1328): present a NON-dismissible
    //     centered modal instead of the sheet — no backdrop tap, no
    //     Escape, no Close button. Accept and Decline are the only exits;
    //     a failed POST re-enables them with the overlay still up. Falls
    //     back to the dismissible sheet when the kit modal is unavailable
    //     (better than presenting nothing), and is ignored when the
    //     current version is already accepted (there would be no exit).
    //   onAnswered(status) — fires after ANY successful consent POST
    //     ('accepted' or 'refused'); the first-run trigger uses it to
    //     stop re-checking this document.
    //   onClosed — fires when the overlay is torn down (answered or
    //     quietly dismissed); the trigger uses it to allow a later
    //     re-offer.
    //   payload — a pre-fetched (or fixed) /terms/current data object;
    //     skips the fetch. The first-run trigger passes the payload it
    //     already fetched, and the ?shot=terms-consent /
    //     ?shot=terms-consent-blocking screenshot states pass a fixed one
    //     so the shots do no fetch and no writes.
    _termsSheetOpen: false,
    async showTermsSheet(onAccepted, opts) {
      opts = opts || {};
      // Reentrancy guard (#1361): never lift a second terms overlay over
      // an open one. Return-early, not dismiss-and-replace, so a blocking
      // native modal can never be displaced by a later plain open. The
      // flag clears in the wrapped onClosed below — the kit fires
      // onDismiss on every teardown, programmatic dismiss included.
      if (this._termsSheetOpen) return;
      const firstRun = opts.firstRun === true;
      let payload = opts.payload || null;
      if (!payload) {
        try {
          const res = await fetch('/challenges-api/terms/current', {
            credentials: 'same-origin',
          });
          const body = await res.json().catch(() => ({}));
          if (res.status === 404) {
            // No published terms version — nothing to accept.
            if (window.PlatformUI) PlatformUI.toast(tr('settings:terms.noneToReview'));
            return;
          }
          if (!res.ok || !body.success) {
            throw new Error(body.error || `HTTP ${res.status}`);
          }
          payload = body.data;
        } catch (err) {
          console.warn('[settings] terms fetch failed:', err);
          if (window.PlatformUI) PlatformUI.toast(tr('settings:terms.loadFailed'));
          return;
        }
      }

      // A local element helper. This panel is handed to the kit
      // (PlatformUI.sheet reparents it), so it stays imperative — it was
      // borrowing the usernode section's `_unEl`, which converted with it.
      const el = (tag, cls, text) => {
        const node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text != null) node.textContent = text;
        return node;
      };
      const panel = el('div', 'px-4 pb-5');
      panel.appendChild(el('div', 'text-lg font-bold py-3',
        payload.title || tr('settings:terms.fallbackTitle')));
      if (firstRun) {
        panel.appendChild(el('p',
          'text-sm text-zinc-600 dark:text-zinc-400 mb-2',
          tr('settings:terms.firstRunIntro')));
      }
      const meta = [];
      if (payload.version) meta.push(tr('settings:terms.version', { version: payload.version }));
      if (payload.published_at) {
        try {
          meta.push(tr('settings:terms.published', {
            date: new Date(payload.published_at).toLocaleDateString(undefined, inZone()),
          }));
        } catch (_) {}
      }
      if (meta.length) {
        panel.appendChild(el('p',
          'text-xs text-zinc-500 dark:text-zinc-400 mb-2', dotText(meta)));
      }
      if (payload.terms_link) {
        const a = el('a',
          'block text-sm text-violet-700 dark:text-violet-400 underline mb-3',
          tr('settings:terms.readFull'));
        a.href = payload.terms_link;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        panel.appendChild(a);
      }

      const accepted = !!(payload.consent && payload.consent.accepted);
      // Blocking gate (#1328): meaningless once this version is accepted —
      // a non-dismissible overlay with no consent buttons has no exit.
      const blocking = opts.blocking === true && !accepted;
      const statusEl = el('p', 'text-sm mb-3 ' + (accepted
        ? 'text-emerald-700 dark:text-emerald-400'
        : 'text-zinc-600 dark:text-zinc-400'),
      accepted
        ? (payload.consent.responded_at
          ? tr('settings:terms.acceptedOn', { date: new Date(payload.consent.responded_at).toLocaleDateString(undefined, inZone()) })
          : tr('settings:terms.accepted'))
        : tr('settings:terms.notAccepted'));
      panel.appendChild(statusEl);

      let sheet = null;
      if (!accepted) {
        // Both buttons post through here so a double-click (or a tap on
        // Decline while Accept is in flight) can't file two answers —
        // the endpoint upserts on (user, version) anyway, but disabled
        // buttons are the honest UI. No app_version is sent: that field
        // belongs to the mobile client.
        const consentButtons = [];
        const postConsent = async (status, onOk) => {
          consentButtons.forEach((b) => { b.disabled = true; });
          try {
            const res = await fetch('/challenges-api/terms/consent', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({
                terms_version_id: payload.id,
                status,
              }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok || !body.success) {
              throw new Error(body.error || `HTTP ${res.status}`);
            }
            if (sheet && sheet.dismiss) sheet.dismiss();
            if (typeof opts.onAnswered === 'function') opts.onAnswered(status);
            onOk();
          } catch (err) {
            console.warn('[settings] terms consent failed:', err);
            if (window.PlatformUI) PlatformUI.toast(tr('settings:terms.consentFailed'));
            consentButtons.forEach((b) => { b.disabled = false; });
          }
        };

        const acceptBtn = el('button',
          'w-full rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 ' +
          'text-sm font-medium text-white', tr('settings:terms.accept'));
        acceptBtn.addEventListener('click', () => postConsent('accepted',
          () => {
            if (window.PlatformUI) PlatformUI.toast(tr('settings:terms.acceptedToast'));
            if (typeof onAccepted === 'function') onAccepted();
          }));
        consentButtons.push(acceptBtn);
        panel.appendChild(acceptBtn);

        if (firstRun) {
          // A recorded refusal is what stops the prompt from nagging:
          // status becomes non-null so ./terms-first-run.js never asks
          // again for this version, while the profile notice remains the
          // way back to accepting later.
          const declineBtn = el('button',
            'w-full rounded-lg border border-zinc-300 dark:border-zinc-700 ' +
            'px-4 py-2 mt-2 text-sm font-medium text-zinc-700 ' +
            'dark:text-zinc-200', tr('settings:terms.decline'));
          declineBtn.addEventListener('click', () => postConsent('refused',
            () => {
              if (window.PlatformUI) {
                PlatformUI.toast(
                  tr('settings:terms.declinedToast'));
              }
            }));
          consentButtons.push(declineBtn);
          panel.appendChild(declineBtn);
        }
      }
      if (!blocking) {
        const closeBtn = el('button',
          'w-full px-4 py-2 mt-2 text-sm text-zinc-500 dark:text-zinc-400',
        tr('core:common.close'));
        closeBtn.addEventListener('click', () => {
          if (sheet && sheet.dismiss) sheet.dismiss();
        });
        panel.appendChild(closeBtn);
      }

      // Re-check after the awaits above: a concurrent call could have
      // presented while this one was still fetching /terms/current.
      if (this._termsSheetOpen) return;
      const onClosed = () => {
        Settings._termsSheetOpen = false;
        if (typeof opts.onClosed === 'function') opts.onClosed();
      };
      if (blocking && window.PlatformUI &&
          typeof PlatformUI.modal === 'function') {
        // Non-dismissible modal (#1328): no backdrop tap, no Escape, no
        // Close — Accept/Decline are the only exits, and a failed POST
        // re-enables them with the overlay still up. The programmatic
        // dismiss() in postConsent (on success) is the one way out.
        sheet = PlatformUI.modal({
          contentEl: panel,
          dismissible: false,
          onDismiss: onClosed,
        });
      }
      if (!sheet) {
        // Web — and the degraded-kit fallback for a blocking ask, where
        // the dismissible sheet still beats presenting nothing.
        sheet = window.PlatformUI && PlatformUI.sheet
          ? PlatformUI.sheet({ contentEl: panel, onDismiss: onClosed })
          : null;
      }
      // Only an actually-presented overlay latches — a kit-less boot
      // (sheet null) must keep later opens working.
      this._termsSheetOpen = !!sheet;
    },

    // `readError` / `loading` only matter when there is NO snapshot: the
    // blocks that need one give way to the error box (or a loading line
    // during a retry), while everything the snapshot has no say over —
    // activity notifications, block production, Terms, the FAQ, the native
    // diagnostics screens — still renders. A failed read used to blank the
    // whole section, turning a transient app hiccup into a dead end.
    // ── Homeroom app section: view builders ────────────────────────────
    //
    // #1079: `_renderUsernodeBody` and eight sibling renderers built ~800
    // lines of `document.createElement` into #settings-usernode-section.
    // They are sections/usernode.tsx now, and what is left here is the
    // reading: every bridge call, every fetch, every retry ladder and every
    // staleness token stays exactly where it was, and ends in a publish.

    _publishUsernode() {
      const react = (typeof window !== 'undefined' && window.UsernodeReact)
        ? window.UsernodeReact.settingsUsernode : null;
      if (!react || !react.publish) return;
      react.publish(this._usernodeView());
    },

    /** The whole section, as one plain serialisable model. */
    _usernodeView() {
      const s = this._usernodeState;
      const perms = (s && s.permissions) || {};
      const isAndroid = perms.platform === 'android';
      const demo = this._unDemoMode();
      const canOpenZkIdentity = this._hasNativeCapability('zkIdentityFlow');
      return {
        gated: this._usernodeGated === true,
        connection: this._usernodeConnectionView(),
        body: this._usernodeBodyView(),
        // The demo link renders the permission rows and stops: everything
        // below reads the live bridge, which a browser does not have.
        belowDemoCut: !demo,
        socialPush: this._socialPushView(),
        blockProduction: this._bpView(),
        foregroundOnly: this._unForegroundOnly(),
        privacy: s ? {
          facematch: {
            label: tr('settings:usernode.privacy.strictFacematch'),
            checked: s.facematchStrict !== false,
            action: '_setFacematchStrict',
          },
          open: canOpenZkIdentity ? {
            id: 'settings-usernode-open-zk-identity',
            label: tr('settings:usernode.privacy.openZkIdentity'),
            action: '_openZkIdentityScreen',
          } : null,
          reset: { label: tr('settings:usernode.privacy.restartZkChallenge'), action: '_resetZkChallenge', danger: true },
        } : null,
        widgetIcons: this._widgetIconsView(),
        diagnostics: {
          debugMode: s ? {
            label: tr('settings:usernode.diagnostics.debugMode'), checked: s.debugMode === true, action: '_setDebugMode',
          } : null,
          actions: [
            { label: tr('settings:usernode.diagnostics.deviceBenchmark'), action: '_openBenchmarkScreen' },
            { label: tr('settings:usernode.diagnostics.httpLogs'), action: '_openHttpLogsScreen' },
          ],
        },
        about: { notes: this._usernodeBuildNotes(), actions: [{
          label: (s && s.termsAccepted === false)
            ? tr('settings:usernode.about.reviewTerms') : tr('settings:usernode.about.terms'),
          action: '_openTermsFromUsernode',
        }] },
        account: (s && s.authStatus !== 'authenticated') ? { rows: [], actions: [] } : null,
        isAndroid,
      };
    },

    _usernodeBuildNotes() {
      const bi = (this._usernodeState && this._usernodeState.buildInfo) || {};
      const bits = [];
      if (bi.appVersion) {
        bits.push(bi.buildNumber
          ? tr('settings:usernode.about.appVersionBuild', { version: bi.appVersion, build: bi.buildNumber })
          : tr('settings:usernode.about.appVersion', { version: bi.appVersion }));
      }
      if (bi.nodeVersion) bits.push(tr('settings:usernode.about.nodeVersion', { version: bi.nodeVersion }));
      if (bi.commitHash) bits.push(bi.commitHash);
      return bits.length ? [{ text: dotText(bits), tone: 'mono' }] : [];
    },

    _usernodeConnectionView() {
      const diag = this._bridgeDiagnostics();
      if (!diag) return null;
      const state = (diag.privileged && diag.privileged.state) || 'unknown';
      const bits = [];
      if (diag.appVersion) {
        bits.push(diag.buildNumber
          ? tr('settings:usernode.connection.appVersionBuild', { version: diag.appVersion, build: diag.buildNumber })
          : tr('settings:usernode.connection.appVersion', { version: diag.appVersion }));
      }
      bits.push(tr('settings:usernode.connection.bridgeVersion', { version: diag.bridgeVersion }));
      const demo = !!this._bridgeDiagDemo() || !!this._walletRecoveryDemo();
      return {
        demo: !!this._bridgeDiagDemo() || !!this._walletRecoveryDemo(),
        row: {
          label: tr('settings:usernode.connection.rowLabel'),
          ok: state === 'ready',
          text: tr(state === 'ready'
            ? this.PRIVILEGED_STATE_LABELS.ready
            : (this.PRIVILEGED_STATE_LABELS[state] || 'settings:usernode.connection.state.unavailable')),
        },
        reason: tr(this.PRIVILEGED_STATE_REASONS[state] ||
          this.PRIVILEGED_STATE_REASONS.unknown),
        build: dotText(bits),
        message: (diag.privileged && diag.privileged.message) || null,
        // Read-only hook: the buttons render so the screenshot shows the real
        // panel, but they must not touch a bridge or a session.
        retryDisabled: !!this._bridgeDiagDemo() || !!this._walletRecoveryDemo(),
        // The pre-merge wallet recovery, offered HERE and nowhere else. It
        // was a dialog that opened itself whenever admission failed with
        // `native_session_wallet_pool_exhausted` — several times a session,
        // since admission retries on every online / pageshow /
        // visibilitychange — for what is a minor feature. Now the failure is
        // only recorded (NativeChrome.lastSessionFailure) and this button is
        // the one way in.
        walletRecovery: this._walletRecoveryAvailable() ? {
          id: 'settings-usernode-connect-wallet',
          label: tr('settings:usernode.connection.connectWallet'),
          action: '_openWalletRecovery',
          disabled: demo,
        } : null,
      };
    },

    WALLET_POOL_EXHAUSTED: 'native_session_wallet_pool_exhausted',

    // True when the LAST native admission attempt was refused because no
    // seeded wallet is left for this account and the session is still not
    // admitted — the one state the recovery dialog can do anything about.
    // Clears itself: a successful admission nulls _lastSessionFailure, and
    // `usernode:native-session-admission` (bound in init) republishes the
    // panel so the button goes away without a navigation.
    _walletRecoveryAvailable() {
      if (this._walletRecoveryDemo()) return true;
      const nc = window.NativeChrome;
      if (!nc || typeof nc.lastSessionFailure !== 'function' ||
          typeof nc.isSessionAdmitted !== 'function') return false;
      if (nc.isSessionAdmitted()) return false;
      const failure = nc.lastSessionFailure();
      if (!failure || failure.code !== this.WALLET_POOL_EXHAUSTED) return false;
      const dialogs = window.UsernodeReact && window.UsernodeReact.dialogs;
      return !!(dialogs && dialogs.walletRecovery &&
        typeof dialogs.walletRecovery.open === 'function');
    },

    // The button's action. Opens features/dialogs/wallet-recovery.tsx for the
    // signed-in user; the dialog replays the same admission attempt once the
    // wallet is claimed, and the admission event above repaints this panel.
    _openWalletRecovery() {
      if (this._walletRecoveryDemo()) {
        throw new Error('Staging demo: there is no session to recover here.');
      }
      const dialogs = window.UsernodeReact && window.UsernodeReact.dialogs;
      const dialog = dialogs && dialogs.walletRecovery;
      if (!dialog || typeof dialog.open !== 'function') {
        throw new Error('Wallet recovery is not available on this screen.');
      }
      const raw = window.App && App.user ? App.user.id : null;
      const userId = raw == null ? '' : String(raw);
      if (!/^[1-9][0-9]*$/.test(userId)) {
        throw new Error('Sign in before connecting a wallet.');
      }
      dialog.open({ userId });
    },

    // Older builds omit the field and still produce in the background.
    _unForegroundOnly() {
      const perms = this._usernodeState && this._usernodeState.permissions;
      return !!perms && perms.backgroundProduction === false;
    },

    _usernodeBodyView() {
      const s = this._usernodeState;
      if (!s) {
        if (this._usernodeLoading) return { kind: 'loading' };
        const readError = this._usernodeReadError();
        const kind = readError && readError.kind;
        return {
          kind: 'error',
          reason: tr(this.USERNODE_READ_ERROR_REASONS[kind] ||
            this.USERNODE_READ_ERROR_FALLBACK),
          message: (readError && readError.message) || null,
        };
      }
      const perms = s.permissions || {};
      const isAndroid = perms.platform === 'android';
      // Android's rows here are the exact-alarm and battery permissions, and a
      // build that produces only while open has neither. iOS keeps its
      // notification row.
      if (isAndroid && this._unForegroundOnly()) return null;
      // iOS row truth: `exactAlarmGranted` is a lagging proxy for the
      // notification permission (there are no exact alarms on iOS), so once a
      // request has settled through NativeChrome.settleIosPushGrant that
      // answer is the authority — the same rule the first-run sheet applies.
      const notifOk = !isAndroid && this._unPushStatus != null
        ? this._unPushStatus === 'granted'
        : !!perms.exactAlarmGranted;
      const n = this._unNotifNotice;
      return {
        kind: 'permissions',
        demo: !!this._unDemoMode(),
        heading: tr('settings:usernode.permissions.heading'),
        description: isAndroid
          ? tr('settings:usernode.permissions.descriptionAndroid')
          : tr('settings:usernode.permissions.descriptionIos'),
        // The row IS the control. It used to be an inert div whose only
        // affordance was a chip below, rendered only when the (iOS-meaningless)
        // exactAlarmGranted boolean said "not granted" — so on a build
        // reporting it `true` there was nothing to tap at all.
        row: {
          id: 'settings-notif-row',
          label: isAndroid ? tr('settings:usernode.permissions.exactAlarms') : tr('settings:usernode.permissions.notifications'),
          ok: notifOk,
          text: notifOk ? tr('settings:usernode.permissions.granted') : tr('settings:usernode.permissions.notGranted'),
          // The row's whole accessible name: what it is and what a tap does.
          actionName: isAndroid
            ? tr('settings:usernode.permissions.exactAlarmsActionName')
            : tr('settings:usernode.permissions.notificationsActionName'),
          action: '_requestUsernodePermissions',
        },
        button: notifOk ? null : {
          label: isAndroid ? tr('settings:usernode.permissions.requestPermissions') : tr('settings:usernode.permissions.allowNotifications'),
          action: '_requestUsernodePermissions',
        },
        notice: n ? {
          text: n.text,
          tone: n.tone === 'warn' ? 'warn' : (n.tone === 'ok' ? 'ok' : 'plain'),
          settings: !!(n.settings && this._unCanOpenNotifSettings === true),
        } : null,
        android: isAndroid ? {
          row: {
            label: tr('settings:usernode.permissions.batteryOptimization'),
            ok: perms.batteryOptDisabled === true,
            text: perms.batteryOptDisabled === true
              ? tr('settings:usernode.permissions.batteryUnrestricted')
              : tr('settings:usernode.permissions.batteryRestricted'),
          },
          button: perms.batteryOptDisabled === true ? null : {
            label: tr('settings:usernode.permissions.openBatterySettings'), action: '_openBatterySettings',
          },
          device: perms.deviceManufacturer
            ? tr('settings:usernode.permissions.device', { manufacturer: perms.deviceManufacturer })
            : null,
        } : null,
      };
    },

    _socialPushView() {
      if (!window.SocialPush || this._socialPushSupported === false) {
        return { kind: 'absent' };
      }
      const state = this._socialPushState;
      if (state === undefined) return { kind: 'checking' };
      if (!state) {
        const admissionPending = window.NativeChrome &&
          typeof NativeChrome.isSessionAdmitted === 'function' &&
          !NativeChrome.isSessionAdmitted();
        // "Finishing secure app sign-in…" is a lie once the handshake has been
        // refused — nothing is finishing. Name the state and point at the
        // panel that explains it.
        const diag = this._bridgeDiagnostics();
        const stuck = !!diag && diag.privileged &&
          (diag.privileged.state === 'blocked-frame' ||
           diag.privileged.state === 'unattached');
        const failure = (window.NativeChrome &&
          typeof NativeChrome.lastSessionFailure === 'function')
          ? NativeChrome.lastSessionFailure() : null;
        return {
          kind: 'unavailable',
          reason: stuck
            ? tr('settings:usernode.socialPush.stuck')
            : (admissionPending
              ? tr('settings:usernode.socialPush.finishingSignIn')
              : tr('settings:usernode.socialPush.unavailable')),
          failure: (failure && failure.message) || null,
          retry: !!(admissionPending && window.NativeChrome &&
            typeof NativeChrome.recoverSessionAdmission === 'function'),
        };
      }
      let status = tr('settings:usernode.socialPush.statusOff');
      if (state.deliveryActive) {
        status = tr('settings:usernode.socialPush.statusOn');
      } else if (state.permissionStatus === 'denied') {
        status = tr('settings:usernode.socialPush.statusDenied');
      } else if (state.enabled && state.registrationStatus === 'registering') {
        status = tr('settings:usernode.socialPush.statusEnabling');
      } else if (state.enabled) {
        status = tr('settings:usernode.socialPush.statusNotActive');
      }
      return { kind: 'ready', enabled: !!state.enabled, status };
    },

    _bpView() {
      // The demo link reads no account, and must not offer a live ask.
      if (this._unDemoMode() === 'foreground-only') {
        return { kind: 'note', text: tr('settings:usernode.blockProduction.released') };
      }
      const state = this._bpState;
      if (state === undefined) return { kind: 'checking' };
      if (!state) return { kind: 'note', text: tr('settings:usernode.blockProduction.checkFailed') };
      if (state.bp_released) return { kind: 'note', text: tr('settings:usernode.blockProduction.released') };
      if (state.bp_requested) return { kind: 'note', text: tr('settings:usernode.blockProduction.pending') };
      if (!state.has_platform_access) return { kind: 'note', text: tr('settings:usernode.blockProduction.needsAccess') };
      return { kind: 'ask' };
    },

    _widgetIconsView() {
      const diag = this._widgetIconDiagnostics();
      if (!diag) return null;
      let sending;
      if (diag.resolved === true) sending = tr('settings:usernode.widgetIcons.sending.pair');
      else if (diag.resolved !== false) sending = tr('settings:usernode.widgetIcons.sending.undecided');
      else if (diag.scheme === 'dark') sending = tr('settings:usernode.widgetIcons.sending.singleDark');
      else if (diag.scheme === 'light') sending = tr('settings:usernode.widgetIcons.sending.singleLight');
      else sending = tr('settings:usernode.widgetIcons.sending.singleOther', { scheme: diag.scheme });
      const notes = [
        { text: diag.build
          ? tr('settings:usernode.widgetIcons.verdictBound', {
            version: diag.build.appVersion, build: diag.build.buildNumber || '?',
          })
          : tr('settings:usernode.widgetIcons.verdictUnbound'), tone: 'muted' },
        { text: this._widgetIconLastCheckText(diag), tone: 'muted' },
      ];
      if (diag.readError) {
        notes.push({
          text: tr('settings:usernode.widgetIcons.readError', {
            method: diag.readError.method,
            reason: tr(this.USERNODE_READ_ERROR_REASONS[diag.readError.kind] ||
              this.USERNODE_READ_ERROR_FALLBACK),
          }),
          tone: 'warn',
        });
      }
      return {
        demo: !!this._widgetIconsDemo(),
        rows: [
          { id: 'settings-widget-mechanism-row', label: tr('settings:usernode.widgetIcons.mechanism.label'),
            ok: diag.mechanism === 'widget',
            text: diag.mechanism === 'widget' ? tr('settings:usernode.widgetIcons.mechanism.available')
              : (diag.mechanism
                ? tr('settings:usernode.widgetIcons.mechanism.otherDevice', { mechanism: diag.mechanism })
                : tr('settings:usernode.widgetIcons.mechanism.unavailable')) },
          { id: 'settings-widget-registry-row', label: tr('settings:usernode.widgetIcons.registry.label'),
            ok: diag.registryLoaded === true,
            text: diag.registryLoaded === true
              ? tr('settings:usernode.widgetIcons.registry.loaded', { count: diag.entries.length })
              : tr('settings:usernode.widgetIcons.registry.unreadable') },
          // Tri-state, and the third state is the point: `has()` used to
          // collapse "couldn't say" into "no".
          { id: 'settings-widget-capability-row', label: tr('settings:usernode.widgetIcons.capability.label'),
            ok: diag.capability === true,
            text: diag.capability === true ? tr('settings:usernode.widgetIcons.capability.advertised')
              : (diag.capability === false
                ? tr('settings:usernode.widgetIcons.capability.notAdvertised')
                : tr('settings:usernode.widgetIcons.capability.unknown')) },
          { id: 'settings-widget-verdict-row', label: tr('settings:usernode.widgetIcons.verdict.label'),
            ok: diag.verdict === 'supported',
            text: diag.verdict === 'supported' ? tr('settings:usernode.widgetIcons.verdict.supported')
              : (diag.verdict === 'unsupported'
                ? tr('settings:usernode.widgetIcons.verdict.unsupported')
                : tr('settings:usernode.widgetIcons.verdict.unconfirmed')) },
          { id: 'settings-widget-sending-row', label: tr('settings:usernode.widgetIcons.sending.label'),
            ok: diag.resolved === true, text: sending },
        ],
        notes,
        entries: this._widgetIconEntryViews(diag),
        recheck: !this._widgetIconsDemo(),
      };
    },

    // The "Last icon check" note: when Home last ran its icon pass and what
    // the pass did. Home records the outcome as `{ kind, sent, refused }`
    // (Home._lastHealOutcome), never as text, so each combination of "when"
    // and "what" is one whole message here.
    _widgetIconLastCheckText(diag) {
      const outcome = diag.lastHealOutcome || null;
      const kind = outcome && Object.prototype.hasOwnProperty.call(this.WIDGET_ICON_LAST_CHECK, outcome.kind)
        ? outcome.kind : 'none';
      const [timed, never] = this.WIDGET_ICON_LAST_CHECK[kind];
      const values = {
        count: outcome ? Number(outcome.sent) || 0 : 0,
        refused: outcome ? Number(outcome.refused) || 0 : 0,
      };
      return diag.lastHealAt
        ? tr(timed, { ...values, when: this._widgetIconTime(diag.lastHealAt) })
        : tr(never, values);
    },

    // [checked at a known time, never checked] for each outcome of the pass.
    WIDGET_ICON_LAST_CHECK: {
      none: ['settings:usernode.widgetIcons.lastCheck.at', 'settings:usernode.widgetIcons.lastCheck.never'],
      skippedMechanism: ['settings:usernode.widgetIcons.lastCheck.atSkippedMechanism', 'settings:usernode.widgetIcons.lastCheck.neverSkippedMechanism'],
      skippedBridge: ['settings:usernode.widgetIcons.lastCheck.atSkippedBridge', 'settings:usernode.widgetIcons.lastCheck.neverSkippedBridge'],
      nothing: ['settings:usernode.widgetIcons.lastCheck.atNothing', 'settings:usernode.widgetIcons.lastCheck.neverNothing'],
      sent: ['settings:usernode.widgetIcons.lastCheck.atSent', 'settings:usernode.widgetIcons.lastCheck.neverSent'],
      sentRefused: ['settings:usernode.widgetIcons.lastCheck.atSentRefused', 'settings:usernode.widgetIcons.lastCheck.neverSentRefused'],
    },

    /** Widget entry rows: dot + name + note, as data. */
    _widgetIconEntryViews(diag) {
      if (!diag.entries.length) {
        return [{ key: 'none', ok: true, name: '', note: '',
          empty: tr('settings:usernode.widgetIcons.entry.none') }];
      }
      // Three facts about a pinned shortcut, each a whole message.
      const icon = (v) => tr(v === true ? 'settings:usernode.widgetIcons.entry.iconYes'
        : (v === false ? 'settings:usernode.widgetIcons.entry.iconNo' : 'settings:usernode.widgetIcons.entry.iconUnknown'));
      const dark = (v) => tr(v === true ? 'settings:usernode.widgetIcons.entry.darkYes'
        : (v === false ? 'settings:usernode.widgetIcons.entry.darkNo' : 'settings:usernode.widgetIcons.entry.darkUnknown'));
      return diag.entries.map((entry, i) => ({
        key: String(entry.name || i),
        ok: entry.foreign ? true : (entry.hasIcon !== false && entry.matches),
        name: entry.name,
        note: entry.foreign
          ? tr('settings:usernode.widgetIcons.entry.foreign')
          : (entry.unknownApp
            ? tr('settings:usernode.widgetIcons.entry.appNotLoaded')
            : dotText([
              icon(entry.hasIcon),
              dark(entry.hasIconDark),
              entry.matches
                ? tr('settings:usernode.widgetIcons.entry.sentCurrent')
                : tr('settings:usernode.widgetIcons.entry.sentStale'),
            ])),
        empty: null,
      }));
    },

    // ── Homeroom app section: the named actions the components dispatch ──
    //
    // Each was an inline closure passed to `_unButton` / `_unToggle` /
    // `_unStatusRow`. They are named methods so the view model stays plain
    // serialisable data — the components carry an action STRING, never a
    // function. The disable/toast/re-enable wrapper each one used to repeat
    // lives in sections/usernode-ui.tsx's `useAction`, once.

    async _copyUsernodeDiagnostics() {
      const diag = this._bridgeDiagnostics();
      const text = this._bridgeDiagnosticsText(diag);
      const ok = window.PlatformUI && PlatformUI.copyText
        ? await PlatformUI.copyText(text) : false;
      if (window.PlatformUI && PlatformUI.toast) {
        PlatformUI.toast(ok ? tr('settings:usernode.connection.diagnosticsCopied') : tr('settings:usernode.connection.diagnosticsCopyFailed'),
          ok ? {} : { error: true });
      }
    },

    /** Swap the failure box for the progress line and re-read. */
    async _retryUsernodeRead() {
      this._usernodeLoading = true;
      this._publishUsernode();
      await this._renderUsernodeSection();
    },

    _requestUsernodePermissions() {
      const perms = (this._usernodeState && this._usernodeState.permissions) || {};
      return this._unRequestPermissions(perms.platform === 'android');
    },

    _openBatterySettings() { return window.usernode.openBatterySettings(); },
    _openNotifSettings() { return window.usernode.openNotificationSettings(); },
    _setFacematchStrict(v) { return this._unApply(window.usernode.setFacematchStrict(v)); },
    _setDebugMode(v) { return this._unApply(window.usernode.setDebugMode(v)); },
    _openZkIdentityScreen() {
      return this._openNativeScreen('zkIdentity', tr('settings:usernode.privacy.openZkIdentityFailed'));
    },
    _openBenchmarkScreen() {
      return this._openNativeScreen('benchmark', tr('settings:usernode.diagnostics.openBenchmarkFailed'));
    },
    _openHttpLogsScreen() {
      return this._openNativeScreen('httpLogs', tr('settings:usernode.diagnostics.openLogsFailed'));
    },
    _openTermsFromUsernode() {
      return this.showTermsSheet(() => this._renderUsernodeSection());
    },

    async _resetZkChallenge() {
      const ok = await PlatformUI.confirm({
        title: tr('settings:usernode.privacy.restart.confirmTitle'),
        message: tr('settings:usernode.privacy.restart.confirmMessage'),
        confirmLabel: tr('settings:usernode.privacy.restart.confirmButton'),
        danger: true,
      });
      if (!ok) return;
      await window.usernode.resetZkChallenge();
      if (window.PlatformUI) PlatformUI.toast(tr('settings:usernode.privacy.restart.done'));
    },

    async _recheckWidgetIcons() {
      const home = window.Home;
      if (home && typeof home._refreshWidgetItems === 'function') {
        // Clears the one-attempt-per-load cap so the pass this triggers
        // actually re-sends anything it finds wrong.
        home._iconHealTried = null;
        await home._refreshWidgetItems();
      }
      this._publishUsernode();
    },

    // ── activity notifications ─────────────────────────────────────────
    //
    // The listener and the support probe stay here. What went away is the
    // `box.isConnected` guard on every event and the `box.remove()` on an
    // unsupported build: a publish to an unmounted component is a no-op, and
    // "unsupported" is a model state the rest of the screen can read.

    _initSocialPush() {
      if (this._socialPushStateListener) {
        window.removeEventListener(
          'usernode:social-push-state', this._socialPushStateListener);
        this._socialPushStateListener = null;
      }
      if (!window.SocialPush) { this._socialPushSupported = false; return; }
      const onState = (event) => {
        this._socialPushState = (event && event.detail) || null;
        this._publishUsernode();
      };
      this._socialPushStateListener = onState;
      window.addEventListener('usernode:social-push-state', onState);
      SocialPush.isSupported().then((supported) => {
        this._socialPushSupported = !!supported;
        if (!supported) {
          window.removeEventListener('usernode:social-push-state', onState);
          this._socialPushStateListener = null;
          this._publishUsernode();
          return null;
        }
        return SocialPush.getState();
      }).then((state) => {
        if (this._socialPushSupported) this._socialPushState = state || null;
        this._publishUsernode();
      }).catch((err) => {
        console.warn('[settings] social push state failed:', err);
        this._socialPushState = null;
        this._publishUsernode();
      });
    },

    async _retrySocialPush() {
      await NativeChrome.recoverSessionAdmission();
      if (window.SocialPush &&
          typeof SocialPush.retryBridgeReadiness === 'function') {
        try { SocialPush.retryBridgeReadiness(); } catch (_) {}
      }
      this._socialPushState = await SocialPush.getState();
      this._publishUsernode();
    },

    async _setSocialPushEnabled(enabled) {
      this._socialPushState = await SocialPush.setEnabled(enabled);
      this._publishUsernode();
    },

    // ── block production queue ─────────────────────────────────────────
    //
    // State comes from the session-authed /challenges-api twins; the async
    // load fills its slice in place so the rest of the body never waits on it.

    _initBlockProduction() {
      this._bpState = undefined;
      fetch('/challenges-api/bp/state', { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => { this._bpState = (data && data.success !== false) ? data.data : null; })
        .catch(() => { this._bpState = null; })
        .then(() => this._publishUsernode());
    },

    async _askForBlockProduction() {
      try {
        const res = await fetch('/challenges-api/bp/request', {
          method: 'POST', credentials: 'same-origin',
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data || data.success === false) {
          throw new Error((data && data.error) || tr('settings:usernode.blockProduction.requestFailed'));
        }
        if (window.PlatformUI) PlatformUI.toast(tr('settings:usernode.blockProduction.requestSent'));
        this._bpState = Object.assign({}, this._bpState || {}, { bp_requested: true });
        this._publishUsernode();
        // #2960: the Android "Set up your device" sheet (exact alarms +
        // unrestricted background) waits for exactly this moment. Re-run the
        // first-run trigger now that the account has asked to produce; it
        // re-reads the queue, and on iOS or an already-answered device it
        // presents nothing.
        // `force`: the user just asked, so skip the once-a-day wait.
        if (window.NativeChrome &&
            typeof NativeChrome.maybeShowFirstRunPermissions === 'function') {
          NativeChrome.maybeShowFirstRunPermissions({ force: true });
        }
      } catch (e) {
        if (window.PlatformUI) PlatformUI.toast(e.message || tr('settings:usernode.blockProduction.requestFailed'), { error: true });
      }
    },

    // The snapshot-failure box: the unchanged headline (so existing reports
    // stay recognisable), the mapped reason, the app's own message, and a
    // retry that stays on this screen. `loading` renders the in-place
    // progress line a retry swaps in, leaving the rest of the section up.


    // Block production queue (onboarding flow alignment). State comes
    // from the session-authed /challenges-api twins; the async load
    // fills the section in place so the rest of the usernode body never
    // waits on it.

    // Static port of the native FaqSection copy (Help & Info tiles).
  };

  // Published at module scope, not from the island's effect: app.js,
  // app-view.js and credit-options.js call window.Settings
  // unguarded, and the bundle's entry runs before any of their init()s. The
  // typeof guard is for the SSG prerender pass, which evaluates this whole
  // module graph in Node (#1081 chunk D).
  //
  // Since the module became a lazy chunk, ./facade.js has been window.Settings
  // from the shell's boot: it read /api/auth/me into its `state` and answered
  // isOpen()/close() while this file was still on its way. Take over SHARING
  // that state object — a read still in flight lands in it — and its primed
  // CLI-auth answer, so nothing that consulted the façade observes a reset.
  // A language change (or this namespace's pack arriving after a first,
  // English read) repaints what this module painted from state it still
  // holds: the two navs and the header title, the view models it publishes,
  // and the lines it derives from a payload it kept. A status line that
  // reports the result of one action is not repainted: nothing here remembers
  // which message it showed.
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('homeroom:language-changed', () => {
      if (!Settings._open) return;
      const repaint = (fn) => { try { fn(); } catch (err) { /* a pane that is not mounted */ } };
      repaint(() => Settings._renderNav());
      repaint(() => Settings._syncChrome());
      repaint(() => Settings._normalizeOpenRouterCopy());
      // #6479: the Time zone list's Auto option is written here, not by React.
      repaint(() => Settings._labelTimeZoneAuto());
      repaint(() => { if (Settings._connectors.length) Settings._renderConnectors(); });
      repaint(() => Settings._renderConnectorProgress());
      repaint(() => { if (Settings._githubLink) Settings._renderGithubLink(); });
      repaint(() => { if (Settings._cliTokens.length) Settings._renderCliTokens(); });
      repaint(() => Settings._publishUsernode());
    });
    // The languages the cache offers arrive after boot: the open pane lists them.
    document.addEventListener('homeroom:languages-changed', () => {
      if (!Settings._open) return;
      try { Settings._renderLanguageSection(); } catch { /* a pane that is not mounted */ }
    });
  }

  // #6493: the one shared allowance moved (a fetch anywhere, or a live
  // push). While the spend card is on screen, its platform line follows it —
  // the same figure the AI credit row shows.
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('homeroom:ai-budget-changed', () => {
      const block = document.getElementById('settings-spend');
      if (!block || block.classList.contains('hidden')) return;
      Settings._paintSpendPlatform();
    });
  }

  if (typeof window !== 'undefined') {
    const facade = window.Settings;
    if (facade && facade.__facade) {
      Settings.state = facade.state;
      Settings._cliAuthPromise = facade._cliAuthPromise || null;
    }
    window.Settings = Settings;
  }

  // The first-entry terms prompt lives in ./terms-first-run.js — the ONE
  // boot trigger that auto-presents showTermsSheet (issue #1361 was two
  // parallel implementations of #1297 both riding sv:authed, stacking two
  // sheets at login; the settings.js copy was removed in its fix).

  // init() is called from SettingsScreen's layout effect (../index.tsx), not
  // from DOMContentLoaded. Same moment in practice — the React entry is a
  // deferred module, so it hydrates before DOMContentLoaded fires — but it now
  // happens after the island's own markup is in the document, which is the
  // ordering every id-bound listener below depends on.
})();
