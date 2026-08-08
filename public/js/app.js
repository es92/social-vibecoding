// Top-level `const` doesn't auto-write to `window` in non-module
// scripts, so other modules that read `window.App.…` instead of the
// bare `App.…` identifier silently see `undefined`. Mirror onto
// `window` explicitly so both styles work — the rest of this file
// uses bare `App` because it's already in scope here.
const App = {
  user: null,
  currentApp: null,
  // Top-level mode: 'app' (the running iframe) or 'dev' (#194). The
  // legacy tab names 'group-chat' / 'individual-chat' are normalized to
  // dev sub-tabs by _normalizeTab so old links, notification hrefs, and
  // call sites keep working.
  currentTab: 'app',
  // Active Dev view: 'forum' (the card list, default), 'chat'
  // (full-screen general chat), 'topic' (an issue/proposal discussion
  // open full-screen), or 'sessions' (a dev session open full-screen).
  // Only meaningful while currentTab === 'dev'.
  currentSubTab: 'forum',
  // Tracks whether the dedicated #leaderboard-screen (the Leaderboard
  // screen: Kudos + Topochain + Challenges tabs) is visible. Sibling
  // state to `currentApp`: home / app / leaderboard are the three
  // top-level screens, and they're mutually exclusive. Flipped by
  // navigateToLeaderboard() / _exitLeaderboard() / navigateHome().
  //
  // There is deliberately no separate _inTopochainLeaderboard,
  // _inChallenges or _inTopochainSeasons any more: the Topochain
  // standings and the season challenges are TABS of this screen (see
  // Leaderboard.section), not screens of their own, so one flag covers
  // all three and the sibling navigate* functions have three fewer
  // exits to remember.
  _inLeaderboard: false,
  // Same for the #profile screen (profile-and-settings-to-web migration)
  // — set by navigateToProfile() / _exitProfile() / navigateHome().
  _inProfile: false,
  // Same for the #admin screen (admin & moderation console, #818) — set
  // by navigateToAdminConsole() / _exitAdminConsole() / navigateHome().
  _inAdmin: false,
  // Same for the #settings screen (settings-modal-to-screen conversion)
  // — set by navigateToSettings() / _exitSettings() / navigateHome().
  _inSettings: false,
  // Same for the #apps browse screen (home-screen split: home is "Your
  // apps" only, every other app lives there) — set by
  // navigateToBrowse() / _exitBrowse() / navigateHome().
  _inBrowse: false,

  // Chromeless full-screen mode (#app/<slug>/full): the App tab with the
  // platform header + tab bar hidden, so the embedded app fills the
  // viewport. This is where the edge gate sends credential-less direct
  // visits to an app's own subdomain — the shell still injects the
  // iframe token, refreshes it, and hosts the bridge/LLM-consent flows,
  // so a shared link "just works". The only chrome is a floating
  // "Open in Usernode" pill (see _mountChromelessPill) that switches to
  // the regular #app/<slug>/app view. Driven purely by the hash via
  // restoreFromHash/setChromeless.
  chromeless: false,

  // Set to true while restoreFromHash() is applying a URL (e.g. on
  // popstate/hashchange) so that the navigation helpers it calls
  // (navigateToApp, switchTab, navigateHome) don't push a NEW history
  // entry on top of the one the browser just popped to. Without this
  // guard, "back" would push a forward entry and the user could never
  // actually leave the page.
  _isRestoring: false,

  // ── Display-only session snapshot (#1021) ───────────────────────────
  // A tiny durable record that THIS DEVICE was signed in, written on every
  // successful boot/login and read only when /api/auth/me cannot be
  // reached at all. Without it an offline reload is indistinguishable from
  // a sign-out: `fetch` throws, and the shell drops the user on the
  // landing screen with no way back until the network returns.
  //
  // It is DISPLAY-ONLY and grants nothing. The session cookie remains the
  // sole credential — every request still authenticates normally and the
  // server is free to reject them. All the snapshot decides is which
  // *screen* an offline boot paints, and the moment the network answers
  // again the real /api/auth/me reconciles it (see _reconcileSession).
  // It is cleared on logout, on any answered non-ok /me, and when it ages
  // out, so a stale one can't strand a signed-out device in a signed-in
  // looking shell.
  SESSION_SNAPSHOT_KEY: 'usernode.session.v1',
  SESSION_SNAPSHOT_MAX_AGE_MS: 30 * 24 * 60 * 60 * 1000, // 30 days

  // How long boot waits for /api/auth/me before falling back to the
  // snapshot. Deliberately just past the service worker's own API deadline
  // (API_TIMEOUT_MS) so the SW gets first refusal at answering from cache;
  // this only catches the no-SW / SW-bypassed cases.
  BOOT_SESSION_TIMEOUT_MS: 5000,

  saveSessionSnapshot(user) {
    if (!user || !user.id) return;
    try {
      localStorage.setItem(App.SESSION_SNAPSHOT_KEY, JSON.stringify({
        user, savedAt: Date.now(),
      }));
    } catch (err) { /* private mode / quota — offline boot just degrades */ }
  },

  readSessionSnapshot() {
    try {
      const raw = localStorage.getItem(App.SESSION_SNAPSHOT_KEY);
      if (!raw) return null;
      const snap = JSON.parse(raw);
      if (!snap || !snap.user || !snap.user.id) return null;
      const age = Date.now() - Number(snap.savedAt || 0);
      if (!(age >= 0) || age > App.SESSION_SNAPSHOT_MAX_AGE_MS) {
        App.clearSessionSnapshot();
        return null;
      }
      return snap;
    } catch (err) {
      return null;
    }
  },

  clearSessionSnapshot() {
    try { localStorage.removeItem(App.SESSION_SNAPSHOT_KEY); } catch (err) { /* ignore */ }
  },

  // Ask the service worker to drop the cached API responses of a session
  // that is definitively over. Fire-and-forget: the snapshot has already
  // been cleared, so a worker that never answers changes nothing.
  _dropCachedSession() {
    App.clearSessionSnapshot();
    try {
      navigator.serviceWorker?.controller?.postMessage({ type: 'clear-api-cache' });
    } catch (err) { /* no SW — nothing cached to drop */ }
  },

  // True while the shell is running on the snapshot rather than a verified
  // /api/auth/me. Read by the boot path (skip the session-gated fetches
  // and the events socket) and cleared by _reconcileSession.
  _sessionFromSnapshot: false,

  async init() {
    // FIRST, before any screen paints: the synthetic-inset shot state.
    // Runs here rather than beside the other ?shot= handlers below
    // because it must cover the anonymous shell too (the landing / login
    // / waitlist screens are part of what it reviews) and because a
    // later application would repaint every inset mid-boot.
    App._applySafeAreaShot();

    // Chrome wiring is session-independent and has no re-entry guards
    // (double listeners otherwise), so it runs exactly once per document
    // — BEFORE we know whether a session exists. The anonymous shell
    // needs the popstate/hashchange wiring too (auth screens are
    // hash-routed).
    App.bindEvents();

    // Screenshot-state deep links for the ANONYMOUS shell (`?shot=anon`,
    // `?shot=waitlist-joined`). Captures and proposal checks carry a
    // capture token, so a session always exists for them and
    // restoreFromHash would strip #landing / #waitlist to the home feed —
    // the signed-out screens would be unreachable to every shot. These
    // skip the /api/auth/me fetch so the anonymous shell boots and the
    // fragment picks the screen. Pure UI state: no writes, no env gate, so
    // the "before" side starts working the moment this ships.
    if (App._anonShot()) {
      await App.enterAnonymous();
      return;
    }
    // `?shot=offline` / `?shot=offline-signin` pin the offline state before
    // the boot check runs, so the shot never depends on real connectivity.
    // The signed-out variant boots the anonymous shell directly, exactly
    // as _anonShot does, so it doesn't depend on the capture's session.
    if (App._applyOfflineShot() === 'offline-signin') {
      await App.enterAnonymous();
      return;
    }

    // Boot has THREE outcomes, not two (#1021). The old code collapsed
    // "the server said no" and "the server said nothing" into the same
    // anonymous boot, so a signed-in user who reloaded on a dead network
    // landed on the landing page — signed out, in effect, by a dropped
    // packet.
    //
    //   answered, ok       → the real session; refresh the snapshot.
    //   answered, not ok   → genuinely signed out; drop every cached trace.
    //   never answered     → unknown. Fall back to the snapshot and show
    //                        the signed-in shell in read-only offline mode,
    //                        reconciling as soon as the network returns.
    let res = null;
    try {
      res = await App._fetchSession();
    } catch (err) {
      res = null;
    }

    if (res && res.ok) {
      let user = null;
      try { user = (await res.json()).user; } catch (err) { user = null; }
      if (user) {
        App.enterAuthed(user);
        return;
      }
    } else if (res) {
      // A real answer with a real "no" (401/403). Only reachable online —
      // error responses never enter the SW cache — so this is authoritative.
      App._dropCachedSession();
      await App.enterAnonymous();
      return;
    }

    // No answer at all: offline, captive portal, or a connection that
    // stalled past the deadline. Probe so the strip appears, then decide
    // from the snapshot.
    try { window.Offline?.nudge(); } catch (err) { /* ignore */ }
    const snap = App.readSessionSnapshot();
    if (snap) {
      App._sessionFromSnapshot = true;
      App.enterAuthed(snap.user);
      return;
    }
    // Offline on a device that was never signed in. The anonymous shell
    // shows its own offline state and refuses submits (see auth-screens.js).
    await App.enterAnonymous();
  },

  // /api/auth/me with a deadline. Resolves to the Response, or throws when
  // nothing arrived in time — an open-but-stalled socket must not hold the
  // whole boot, which is what left the reported blank screen.
  async _fetchSession() {
    let timer = null;
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    if (ctrl) timer = setTimeout(() => ctrl.abort(), App.BOOT_SESSION_TIMEOUT_MS);
    try {
      return await fetch('/api/auth/me', ctrl ? { signal: ctrl.signal } : undefined);
    } finally {
      if (timer) clearTimeout(timer);
    }
  },

  // Once connectivity is back, replace the snapshot-derived session with a
  // verified one. Three outcomes again, and each matters:
  //   401/403     → the session really did end while we were away.
  //   another id  → a different user; a full reload is the only way to
  //                 rebuild a shell that was painted for someone else.
  //   same id     → promote to a live session: connect the events socket
  //                 and resync whatever screen is on top.
  async _reconcileSession() {
    if (!App._sessionFromSnapshot) return;
    let res;
    try {
      res = await fetch('/api/auth/me');
    } catch (err) {
      return; // still unreachable — stay on the snapshot.
    }
    if (!res.ok) {
      App._dropCachedSession();
      App._sessionFromSnapshot = false;
      location.reload();
      return;
    }
    let user = null;
    try { user = (await res.json()).user; } catch (err) { user = null; }
    if (!user) return;
    if (String(user.id) !== String(App.user?.id)) {
      App.clearSessionSnapshot();
      location.reload();
      return;
    }
    App._sessionFromSnapshot = false;
    App.user = user;
    App.saveSessionSnapshot(user);
    App.connectEvents();
    if (window.Kudos?.Budget?.init) Kudos.Budget.init();
    if (window.AiCredit?.Budget?.init) AiCredit.Budget.init();
    try { App.resyncCurrentView(); } catch (err) { /* ignore */ }
  },

  // ── Staged boot (fold-auth-pages-into-SPA) ──────────────────────────
  // The SPA now serves anonymous visitors too: landing / login / signup /
  // register / waiting are hash-routed in-SPA screens (auth-screens.js),
  // and login is reload-free — the authed shell boots in place. Three
  // stages:
  //   bindEvents (chrome)  — once per document, session-independent.
  //   enterAnonymous       — no session: show the auth screens.
  //   enterAuthed(user)    — session established: set App.user, then
  //                          either the waiting room (no platform access)
  //                          or the full one-shot authed boot.
  _authedBooted: false,

  async enterAnonymous() {
    if (window.NativeChrome && NativeChrome.enterAnonymous) {
      await NativeChrome.enterAnonymous();
    }
    // Capture the platform SHA this document booted with. The anonymous
    // shell has no drawer (so no stale-version pill), which makes
    // pull-to-refresh its only recovery path after a deploy — and
    // platformMovedOn() needs a boot-time baseline to compare against.
    App.loadVersion();
    if (window.AuthScreens) AuthScreens.enter();
  },

  // True for the anonymous-shell screenshot-state links (see init). Also
  // normalises the fragment for `?shot=waitlist-joined`, which names one
  // specific screen — so the path needs no hash of its own and the shot
  // stays deterministic. AuthScreens._waitlistOnShow reads the same param
  // to paint the post-join state.
  _anonShot() {
    let shot = null;
    try { shot = new URLSearchParams(location.search).get('shot'); } catch (err) { /* ignore */ }
    if (shot !== 'anon' && shot !== 'waitlist-joined') return false;
    if (shot === 'waitlist-joined' &&
        (!location.hash || location.hash === '#')) {
      try { history.replaceState(null, '', location.search + '#waitlist'); } catch (err) { /* ignore */ }
    }
    return true;
  },

  // Screenshot-state deep links for the offline experience (#1021):
  //   ?shot=offline         — the signed-in shell in read-only offline mode
  //                           (the fixed strip above everything).
  //   ?shot=offline-signin  — the signed-out login screen while offline:
  //                           the explanation block, and the credential
  //                           fields greyed out because they cannot work.
  //
  // Both pin connectivity rather than reading it, because the one thing a
  // capture runner and a reviewer's browser always have is a working
  // network — without this the offline UI is literally unphotographable,
  // and the "before" side of the comparison could never be produced.
  // Pure UI state, no writes, so deliberately NOT env-gated (same
  // reasoning as ?shot=menu). Returns the shot name, or null.
  _applyOfflineShot() {
    let shot = null;
    try { shot = new URLSearchParams(location.search).get('shot'); } catch (err) { /* ignore */ }
    if (shot !== 'offline' && shot !== 'offline-signin') return null;
    if (shot === 'offline-signin' && (!location.hash || location.hash === '#')) {
      try { history.replaceState(null, '', location.search + '#login'); } catch (err) { /* ignore */ }
    }
    try { window.Offline?.forceOffline(); } catch (err) { /* ignore */ }
    return shot;
  },

  // Swap the drawer's Profile row between the generic person glyph and the
  // viewer's own picture (#982). Called on sign-in and again after the
  // profile editor saves, so removing a photo puts the glyph back. Both
  // nodes are static in index.html — only which one is `hidden` changes,
  // and the <img> gets no src until there is one, so a user with no
  // picture never issues a request.
  applyUserAvatar() {
    const img = document.getElementById('drawer-avatar');
    const glyph = document.getElementById('drawer-profile-glyph');
    if (!img || !glyph) return;
    const url = App.user && App.user.avatarUrl;
    if (url) {
      img.src = url;
      img.classList.remove('hidden');
      glyph.classList.add('hidden');
    } else {
      img.removeAttribute('src');
      img.classList.add('hidden');
      glyph.classList.remove('hidden');
    }
  },

  enterAuthed(user) {
    App.user = user;
    // "View as non-admin" admin tool. We mask `App.user.isAdmin`
    // for client-side UI gating (admin buttons, retry, delete, lock,
    // app-secrets edit, etc. — see grep for App.user?.isAdmin) so
    // an admin can preview the experience a regular user gets.
    // Server-side `req.user.isAdmin` is unaffected — this is purely
    // visual, not a privilege drop. We stash the real value on
    // App._realIsAdmin so settings.js knows whether to render the
    // toggle, and the body class lets a thin header banner reveal
    // the masked state at all times so the admin doesn't forget
    // they're in preview mode.
    App._realIsAdmin = !!App.user?.isAdmin;
    // View-only admin role (issue #311): mutating controls gate on
    // `canAdminWrite`, view affordances on `isAdmin`. Mask BOTH under the
    // "View as non-admin" preview so the admin sees the true non-admin
    // experience. Server-side gates are unaffected — purely visual.
    App._realCanAdminWrite = !!App.user?.canAdminWrite;
    App._viewAsNonAdmin = App._realIsAdmin
      && localStorage.getItem('viewAsNonAdmin') === '1';
    if (App._viewAsNonAdmin && App.user) {
      App.user.isAdmin = false;
      App.user.canAdminWrite = false;
      App.user.role = 'user';
      document.body.classList.add('is-view-as-non-admin');
    }

    // #982: paint the drawer's Profile row with the viewer's picture.
    App.applyUserAvatar();

    // Remember that this device is signed in, so a later boot that can't
    // reach /api/auth/me still knows which shell to paint (#1021). Skipped
    // when the shell is running FROM the snapshot — re-writing it then
    // would keep refreshing savedAt and an offline device would never age
    // its session out.
    if (!App._sessionFromSnapshot) App.saveSessionSnapshot(App.user);

    // A web session exists (platform access or not). The native login
    // handoff listens for this — wallet provisioning and the node work
    // for waiting-room users too (apps are usable without platform
    // access; only the SV social/build surfaces are gated).
    document.dispatchEvent(new CustomEvent('sv:session', {
      detail: { user: App.user },
    }));

    // Platform-access gate (onboarding flow alignment): a released
    // session boots the full shell; an unreleased one gets the waiting
    // room, which re-calls enterAuthed once /api/auth/me reports access.
    // `=== false` on purpose — an older cached /me without the field
    // must not lock anyone out.
    if (App.user?.hasPlatformAccess === false && window.AuthScreens) {
      AuthScreens.showWaiting();
      return;
    }

    if (App._authedBooted) {
      App.restoreFromHash();
      return;
    }
    App._authedBooted = true;

    if (window.AuthScreens) AuthScreens.hideAll();

    // Header admin/moderation icon — revealed for admins (full or
    // view-only) once App.user is resolved. bindEvents already ran, so
    // the click handler is attached before the button can be seen.
    App.renderAdminButton();
    // On a snapshot-derived boot every one of these is a guaranteed
    // failure: the socket can't open and the budget endpoints can't
    // answer. _reconcileSession runs them the moment the network is back.
    if (!App._sessionFromSnapshot) App.connectEvents();
    App.loadVersion();
    // Header kudos budget badge polls /api/me/kudos-budget once at
    // load and then on a long interval (hourly safety-net for the
    // Monday-UTC rollover). Refreshes opportunistically on every
    // successful give + on the leaderboard screen mount.
    if (!App._sessionFromSnapshot && window.Kudos?.Budget?.init) Kudos.Budget.init();
    // AI-credit status row (#555), same boot shape as the kudos badge:
    // the viewer's own daily allowance. Refreshes again on every drawer
    // open (App.HeaderMenu.open), throttled inside the module.
    if (!App._sessionFromSnapshot && window.AiCredit?.Budget?.init) AiCredit.Budget.init();
    // #1038: seed the live session-state store and arm its adaptive
    // reconcile tick. Same snapshot-boot guard as the meters above — the
    // endpoint is session-gated, so firing it on an offline snapshot boot is
    // a guaranteed 401.
    if (!App._sessionFromSnapshot && window.SessionState) SessionState.start();
    // Session-gated boot fetches (notifications bell, work drawer)
    // defer to this event instead of firing a guaranteed 401 on an
    // anonymous document load.
    document.dispatchEvent(new CustomEvent('sv:authed', {
      detail: { user: App.user },
    }));
    App.restoreFromHash();
    App._applyMenuShot();
    App._applyMenuNavShot();
    App._applyLaunchShot();
    App._applyFeedbackShot();

    // Promote a snapshot-derived shell to a verified session as soon as
    // the connectivity probe reports we're back.
    window.addEventListener('usernode:offline-change', (e) => {
      if (e.detail && e.detail.offline === false) App._reconcileSession();
    });

    // Re-poll the platform version every 10s so the drawer's platform
    // row flips to its "deploying" state within seconds of a deploy
    // signaling start, and to "stale" (a tappable reload) once a new
    // build is live and this tab is behind it. Cheap endpoint — just
    // reads one tiny file off disk on the server.
    setInterval(App.loadVersion, 10_000);
  },

  // Admin / moderation console entry point (#588). Was a header shield
  // icon until the header slim-down moved it into the slide-out drawer as
  // #drawer-row-admin (below Settings). The function keeps its name and
  // its gate — only the element it reveals changed.
  //
  // Gate: `App.user.isAdmin`, which is true for BOTH full platform
  // admins and view-only admins (`admin_readonly`); see
  // middleware/auth.js, where `isAdmin` is the read/visibility flag and
  // `canAdminWrite` is the narrower full-admin mutation gate. A
  // moderation console is a *viewing* surface, so `isAdmin` is the right
  // flag and `canAdminWrite` would wrongly exclude view-only admins.
  // Regular users never see the row. Nothing here consults
  // USERNODE_ENV — the row exists identically in staging and prod.
  //
  // The "View as non-admin" preview reloads the page after masking
  // `App.user.isAdmin` (see settings.js), so this boot-time read is all
  // that's needed to make the row disappear in preview mode too.
  // Screenshot-state deep link `?shot=menu` (#555): opens the slide-out
  // drawer at boot so the status pane — which is only reachable by
  // TAPPING the hamburger — is visible to the before/after screenshots,
  // the "Test this change" button and the dapp.json checks. Pure UI
  // state, no writes, so it is deliberately NOT env-gated: an
  // IS_STAGING-only link would starve the production "before" shot
  // forever, while an ungated one starts working the moment it ships.
  _applyMenuShot() {
    let shot = null;
    try { shot = new URLSearchParams(location.search).get('shot'); } catch (err) { /* ignore */ }
    if (shot !== 'menu') return;
    // One tick after restoreFromHash so the screen it navigated to has
    // painted and the drawer opens over a settled shell. The rows' own
    // fetches repaint their pills in place whenever they land.
    setTimeout(() => {
      try { App.HeaderMenu.open(); } catch (err) { /* ignore */ }
    }, 50);
  },

  // Screenshot-state deep link `?shot=safe-bottom`: paint the whole shell
  // as if it were on a notched phone, so the safe-area treatment is
  // REVIEWABLE. No desktop browser reports a bottom inset and Chrome's
  // device emulation doesn't synthesise one, so without this every
  // before/after capture and every manual check of the home-indicator
  // clearance renders with zero insets — i.e. shows nothing.
  //
  // It writes the KIT's two custom properties rather than our own
  // --platform-safe-* tokens, and that is the whole trick: our tokens are
  // defined as `var(--un-safe-inset-X, env(...))`, so setting the kit
  // property drives the platform utilities AND every `.un-safe-*` kit
  // class (the header included) from one place — the shell shifts as a
  // whole instead of insets appearing in a few places and not others.
  //
  // Pure paint state — nothing is written and no layout code branches on
  // it — so it is deliberately NOT env-gated (same reasoning as
  // ?shot=menu above). It also cannot lie to an app frame: the insets
  // forwarded over the safe-area bridge are read from the hidden
  // env()-valued probe element (AppView._readRootInsets), never from
  // these properties, so an embedded app still receives its real ones.
  //
  // 47/34 are the iPhone 14/15-class status-bar and home-indicator
  // insets in portrait — the frame the captures use (390x844).
  SAFE_AREA_SHOT_INSETS: { top: '47px', bottom: '34px' },

  _applySafeAreaShot() {
    let shot = null;
    try { shot = new URLSearchParams(location.search).get('shot'); } catch (err) { /* ignore */ }
    if (shot !== 'safe-bottom') return;
    try {
      const root = document.documentElement;
      root.style.setProperty('--un-safe-inset-top', App.SAFE_AREA_SHOT_INSETS.top);
      root.style.setProperty('--un-safe-inset-bottom', App.SAFE_AREA_SHOT_INSETS.bottom);
    } catch (err) { /* ignore */ }
  },

  // Screenshot-state deep link `?shot=menu-nav` (#977): open the drawer
  // and TAP a navigation row, so the single-motion rule — the drawer's
  // exit is the only animation, the destination screen is swapped
  // underneath it with no push — is reachable by URL. The defect it
  // fixes lives entirely inside the ~400ms both animations used to
  // overlap, which no still frame and no plain route can reach; the
  // dapp.json checks assert the resulting state (the destination screen
  // carrying data-entered="none", the drawer fully torn down).
  //
  // Ungated for the same reason as ?shot=menu above: pure UI state, no
  // writes, and an env-gated link would starve the production "before"
  // shot forever. The row is a real anchor, so .click() follows its href
  // and the whole hash → restoreFromHash → navigate* path is exercised
  // exactly as a finger would.
  _applyMenuNavShot() {
    let shot = null;
    try { shot = new URLSearchParams(location.search).get('shot'); } catch (err) { /* ignore */ }
    if (shot !== 'menu-nav') return;
    setTimeout(() => {
      try { App.HeaderMenu.open(); } catch (err) { /* ignore */ }
      // After the entrance spring has settled, so the tap lands on a
      // presented drawer rather than one still sliding in.
      setTimeout(() => {
        const row = document.getElementById('drawer-row-leaderboard');
        if (row) row.click();
      }, 200);
    }, 50);
  },

  // Screenshot-state deep link `?shot=app-launching` (#931): paint the app
  // launch surface — icon, name and spinner over the theme background —
  // which otherwise exists only for the few hundred milliseconds between a
  // tap and the app's first paint, and so was invisible to the before/after
  // screenshots and the dapp.json checks. Pure UI state, no app is loaded
  // behind it, not env-gated (same reasoning as ?shot=menu above).
  _applyLaunchShot() {
    let shot = null;
    try { shot = new URLSearchParams(location.search).get('shot'); } catch (err) { /* ignore */ }
    if (shot !== 'app-launching') return;
    // Wait (briefly, and bounded) for the home feed's app list to land, so
    // the cover shows a REAL app's icon and name rather than the stub —
    // Home.load's fetch is in flight while boot finishes. Paints regardless
    // once the budget is spent, which is what keeps the link working against
    // an empty checks database.
    let tries = 0;
    const paint = () => {
      // Bareword, not window.Home: home.js's `const Home` is a lexical
      // top-level binding, not a window property (see AppView._home).
      const ready = typeof Home !== 'undefined' && Array.isArray(Home._apps) && Home._apps.length;
      if (!ready && tries++ < 20) { setTimeout(paint, 50); return; }
      try { AppView.showLaunchCoverShot(); } catch (err) { /* ignore */ }
    };
    setTimeout(paint, 50);
  },

  // Screenshot-state deep links `?shot=feedback` / `?shot=feedback-spent`
  // (#964): open the Send Feedback dialog at boot. The dialog — and with it
  // the new "Put a kudos bounty on this" row — is reachable ONLY by tapping
  // the header speech-bubble or the Dev plus-menu, so without this link the
  // before/after screenshots, the "Test this change" button and the
  // dapp.json checks would all show the home feed instead of the change.
  //
  // `feedback-spent` additionally forces a client-side remaining:0 budget
  // BEFORE opening, so the greyed-out/exhausted state is reviewable without
  // writing kudos rows for a real cloned user (which the staging seed rules
  // forbid). That override is display-only: it never posts, and the server
  // remains the real allowance gate on submit.
  //
  // Pure UI state, no writes, deliberately NOT env-gated — same reasoning as
  // ?shot=menu above: an IS_STAGING-only link would starve the production
  // "before" shot forever.
  _applyFeedbackShot() {
    let shot = null;
    try { shot = new URLSearchParams(location.search).get('shot'); } catch (err) { /* ignore */ }
    if (shot !== 'feedback' && shot !== 'feedback-spent') return;
    const spent = shot === 'feedback-spent';
    // One tick after restoreFromHash so the screen it navigated to has
    // painted and the dialog opens over a settled shell.
    setTimeout(() => {
      try {
        if (spent && window.Kudos?.Budget) {
          const limit = Kudos.Budget.state?.limit || 20;
          // Pin the exhausted figure and stop the hourly poll from
          // replacing it mid-screenshot with the real (unspent) budget.
          Kudos.Budget.state = { given_this_week: limit, remaining: 0, limit };
          Kudos.Budget.refresh = () => Promise.resolve();
        }
        App.openFeedbackModal();
      } catch (err) { /* ignore */ }
    }, 50);
  },

  renderAdminButton() {
    const btn = document.getElementById('drawer-row-admin');
    if (btn) btn.classList.toggle('hidden', !App.user?.isAdmin);
  },

  // Navigate to the full-page admin console (#818): the #admin hash route
  // drives everything — restoreFromHash lands on navigateToAdminConsole,
  // which mounts #admin-screen and hands rendering to AdminConsole
  // (public/js/admin-console.js). The isAdmin re-check keeps a
  // programmatic call from navigating. The drawer row is a real anchor
  // (its href IS the navigation, matching Settings/Challenges/Profile),
  // so this stays the *programmatic* entry point rather than a click
  // handler; the route's own gate inside navigateToAdminConsole is the
  // client-side boundary, and every /api/admin/* is enforced server-side.
  openAdminConsole() {
    if (!App.user?.isAdmin) return;
    location.hash = '#admin';
  },

  // The SHA the currently-loaded client JS was shipped with. Captured on
  // first poll so we can compare against later polls and surface a
  // "platform updated, reload to use new features" hint when the running
  // platform has moved on but this tab hasn't.
  loadedPlatformSha: null,

  async loadVersion() {
    try {
      const res = await fetch('/api/version');
      if (!res.ok) return;
      const info = await res.json();
      if (!App.loadedPlatformSha && info.sha && info.sha !== 'dev') {
        App.loadedPlatformSha = info.sha;
      }
      App.renderPlatformVersionPill(info);
    } catch {}
  },

  // True when /api/version reports a different SHA than the one this
  // document booted with — i.e. the platform redeployed and this tab is
  // running stale client code. Fail-closed (false) on any error: a
  // flaky network must never turn a data refresh into a reload loop.
  async platformMovedOn() {
    try {
      const res = await fetch('/api/version');
      if (!res.ok) return false;
      const info = await res.json();
      if (!info.sha || info.sha === 'dev') return false;
      if (!App.loadedPlatformSha) {
        // No boot baseline (first poll lost a race, or the boot fetch
        // failed) — record what we see and treat this tab as current.
        App.loadedPlatformSha = info.sha;
        return false;
      }
      return info.sha !== App.loadedPlatformSha;
    } catch { return false; }
  },

  // Pull-to-refresh wrapper: run the screen's data refresh, and when the
  // platform has redeployed since this document loaded, upgrade it to a
  // full reload — pull-to-refresh means "get me the latest", and data
  // alone can't deliver new client code. The never-resolving promise
  // keeps the kit's spinner up until the reload tears the page down.
  _refreshOrReload(refresh) {
    return Promise.all([
      Promise.resolve().then(refresh).catch(() => {}),
      App.platformMovedOn(),
    ]).then(([, movedOn]) => {
      if (!movedOn) return undefined;
      location.reload();
      return new Promise(() => {});
    });
  },

  // Four rendering states, all rendered as .drawer-ver text (see
  // public/css/app.css) with modifier classes for the dev / deploying /
  // stale variants — the same text form the per-app version line below
  // it in the drawer footer uses, so the two read as one block.
  //
  // The slot moved out of the header (header slim-down) and then out of
  // the drawer's status pane into #drawer-footer, but kept its id
  // throughout — so every call site is unchanged, as is the trailing
  // refreshDeployDot(), which mirrors the
  // deploying state onto the hamburger (the only place a deploy is
  // visible now without opening the menu).
  renderPlatformVersionPill(info) {
    const slot = document.getElementById('platform-version-pill-slot');
    if (!slot) return;
    // Every path below ends by painting `slot` and syncing the dot.
    const paint = (html) => {
      slot.innerHTML = html;
      App.DrawerStatus.refreshDeployDot();
    };

    const runningSha = info.sha;
    const repoUrl = info.repoUrl || '#';
    const deploy = info.deployProgress;
    const isDeploying = !!(deploy && deploy.deploying);
    const isStale = !isDeploying
      && App.loadedPlatformSha
      && runningSha
      && runningSha !== App.loadedPlatformSha
      && runningSha !== 'dev';

    // The project label ("usernode ·") used to prefix every state here.
    // It's gone: the row this renders into is LABELLED "Platform" in the
    // drawer footer, so repeating the project name was pure redundancy —
    // and it was what pushed "usernode · 1a2b3c4" past the 15rem panel
    // and into truncation. Bare version only. (`info.name` is still
    // served by /api/version; nothing else reads it here.)
    if (!runningSha || runningSha === 'dev') {
      // No GIT_SHA. STAGING PREVIEWS OF THE PLATFORM ARE BUILT WITHOUT
      // ONE, so this is the state a PR tester actually sees — and a row
      // reading "Platform version  dev" told them nothing about which
      // build they were looking at. Name the environment instead when the
      // server reports one, and keep the literal "dev" for a local run
      // (and for a production build missing its SHA, where printing
      // "production" would imply a version we don't actually know).
      const staging = info.env === 'staging';
      const label = staging ? 'staging' : 'dev';
      const tip = staging
        ? 'Staging preview of the platform — built without a commit SHA, so there is no version to link'
        : 'Running outside of a deploy (no GIT_SHA set)';
      paint(`
        <span class="drawer-ver drawer-ver--dev" title="${tip}">${label}</span>`);
      return;
    }

    if (isDeploying) {
      const newShort = (deploy.sha || '').slice(0, 7);
      const oldShort = runningSha.slice(0, 7);
      const elapsed = deploy.startedAt
        ? Math.max(0, Math.floor((Date.now() - new Date(deploy.startedAt).getTime()) / 1000))
        : null;
      const tipParts = [`Deploying ${newShort || 'new build'}`];
      if (oldShort) tipParts.push(`from ${oldShort}`);
      if (elapsed != null) tipParts.push(`${elapsed}s elapsed`);
      const shaLabel = newShort ? `→ ${newShort}` : 'deploying';
      paint(`
        <span class="drawer-ver drawer-ver--deploying" title="${tipParts.join(' · ')}">
          <span class="drawer-ver-spinner" aria-hidden="true"></span>${shaLabel}
        </span>`);
      return;
    }

    if (isStale) {
      const oldShort = App.loadedPlatformSha.slice(0, 7);
      const newShort = runningSha.slice(0, 7);
      paint(`
        <button type="button"
                class="drawer-ver drawer-ver--stale"
                title="Platform updated from ${oldShort} to ${newShort}. Click to reload."
                onclick="location.reload()">${newShort} · reload</button>`);
      return;
    }

    const shortSha = runningSha.slice(0, 7);
    const href = `${repoUrl.replace(/\/$/, '')}/commit/${runningSha}`;
    paint(`
      <a href="${href}" target="_blank" rel="noopener" class="drawer-ver" title="Platform commit ${shortSha}">${shortSha}</a>`);
  },

  // Tiny local HTML-escaper for server-sourced strings interpolated into
  // markup here. Kept on App rather than reaching into app-view.js's
  // helpers since those load conditionally / aren't guaranteed to be in
  // scope. (Its original caller — the project-name prefix on the platform
  // version pill — is gone; kept as the local escaper for this file.)
  _escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  },

  // Per-app redeploy WS handler. Flips affected pills into / out of
  // the yellow + spinner state. Reacts to BOTH the start broadcast
  // (deploying:true → render the deploying pill) and the end
  // broadcast (deploying:false → re-fetch the version so the new
  // SHA shows up). The server emits these from staging.js around
  // every rebuildProduction call, so all entry paths (dev-chat
  // merge, drift poller, manual check-updates) are covered.
  handleAppRedeployStatus(data) {
    if (!data || !data.appSlug) return;
    const slug = data.appSlug;
    const deployProgress = data.deploying
      ? { deploying: true, startedAt: data.startedAt, fromSha: data.fromSha || null }
      : null;

    // NOTE: `AppView` / `Home` are top-level `const` from classic
    // <script>s — they live in the shared script-global lexical env
    // but are NOT properties of `window`, so `window.AppView` would
    // silently short-circuit to false. Use `typeof` instead.
    if (typeof AppView !== 'undefined' && AppView.appData?.slug === slug) {
      if (data.deploying) {
        AppView.applyHeaderDeployProgress(deployProgress);
      } else {
        // Deploy ended — re-pull /api/apps/:slug/version to pick up
        // the new SHA. The trailing `app_version_changed` broadcast
        // (if a SHA actually changed) would also trigger this, but
        // refetching here covers the failure case where the deploy
        // ended without changing the SHA.
        AppView.refreshVersionPill();
      }
    }

    // Home-screen card pill (only if the home screen is visible).
    const homeVisible = document.getElementById('home-screen')
      && !document.getElementById('home-screen').classList.contains('hidden');
    if (homeVisible && typeof Home !== 'undefined') {
      if (data.deploying) {
        // We don't have the row's `version` data on hand here, but
        // the deploying pill hides the SHA anyway, so passing null
        // is correct.
        Home.updateAppCardPill(slug, { deployProgress, version: null });
      } else {
        // Deploy ended — full reload picks up the new version row
        // from /api/apps. Cheap (one query) and avoids manually
        // splicing the new SHA into a single card.
        Home.load();
      }
    }
  },

  eventsWs: null,
  // Shell-injected staging iframe token, captured at script load so SPA
  // history rewrites can't lose it before a (re)connect needs it.
  _bootToken: new URLSearchParams(location.search).get('token'),
  // Set on the very first connect; on every subsequent (re)connect we
  // resync state because the server's broadcast model is fire-and-forget
  // — anything pushed during the disconnect window (a `vote_update
  // merged:true` from a long-running merge, an `app_status` flip, etc.)
  // would otherwise be silently lost. Resync = re-pull whatever the
  // current view depends on; cheap, and it self-bounds to "exactly when
  // we know we might have missed something" rather than a periodic poll.
  _eventsWsHasConnected: false,

  connectEvents() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // Same staging-iframe token fallback as GroupChat._openSocket — the
    // session cookie can be orphaned by a staging redeploy, and the WS
    // handshake can't re-mint it the way HTTP requests do. Prefer the
    // live URL, fall back to the boot-time capture (SPA history rewrites
    // may have stripped the query by now).
    const token = new URLSearchParams(location.search).get('token') || App._bootToken;
    const qs = token ? `?token=${encodeURIComponent(token)}` : '';
    App.eventsWs = new WebSocket(`${proto}//${location.host}/ws/events${qs}`);

    App.eventsWs.onopen = () => {
      const isReconnect = App._eventsWsHasConnected;
      App._eventsWsHasConnected = true;
      console.log(`[ws] Global events ${isReconnect ? 'reconnected' : 'connected'}`);
      // A (re)opened socket proves we're online — clear the offline
      // banner immediately instead of waiting for the slow re-probe loop.
      if (window.Offline) Offline.nudge();
      if (isReconnect) App.resyncCurrentView();
    };

    App.eventsWs.onerror = (err) => {
      console.warn('[ws] Global events error', err);
    };

    App.eventsWs.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        switch (data.type) {
          case 'app_status':
            App.handleAppStatusUpdate(data);
            break;
          case 'session_update':
            App.handleSessionUpdate(data);
            break;
          case 'session_state':
            // #1038: live working state for one session. The store repaints
            // every surface that shows it (cog, board cards, session list)
            // with no refetch at all.
            App.handleSessionState(data);
            break;
          case 'vote_update':
            App.handleVoteUpdate(data);
            break;
          case 'kudos_update':
            // Kudos count changed for some PR — bump cached state +
            // any visible buttons + the leaderboard if open. Delegated
            // to Kudos so app.js stays thin.
            if (window.Kudos) Kudos.applyLiveUpdate(data);
            break;
          case 'session_event':
            App.handleSessionEvent(data);
            break;
          case 'app_update':
            App.handleAppUpdate(data);
            break;
          case 'issue_update':
            App.handleIssueUpdate(data);
            break;
          case 'board_order_update':
            // #613: someone reordered a Dev-board column. refreshDevData
            // re-pulls the board (including the manual order fetched by
            // _loadDevData) and repaints, so every open board converges.
            if (typeof AppView !== 'undefined' && AppView.refreshDevData) {
              AppView.refreshDevData('board-order');
            }
            break;
          case 'session_drafts_changed':
            // #940: another device of THIS user saved or trashed a draft.
            // No-ops unless that session is the one on screen; a dropped
            // socket costs nothing, since opening the session or returning
            // to the tab reconciles anyway.
            if (typeof DevChat !== 'undefined' && DevChat.applyDraftsUpdate) {
              DevChat.applyDraftsUpdate(data.sessionId);
            }
            break;
          case 'notification_new':
            if (window.Notifications) Notifications.handleIncoming(data.notification);
            // A mention/reply/reaction may have arrived for a message in
            // the currently-open chat — reconcile its unread dot.
            window.GroupChat?.reconcileDotsFromNotifications?.();
            break;
          case 'notifications_changed':
            // Server cleared/changed this user's notifications elsewhere
            // (e.g. another tab cast a vote and the PR nudge was dismissed,
            // or this user sent a chat message and reply-clears-all fired).
            // Re-pull so this tab's badge + list stay in sync, then
            // reconcile the in-chat unread dots from the fresh list.
            if (window.Notifications) {
              const r = Notifications.refresh?.();
              if (r && typeof r.then === 'function') {
                r.then(() => window.GroupChat?.reconcileDotsFromNotifications?.());
              } else {
                window.GroupChat?.reconcileDotsFromNotifications?.();
              }
            }
            break;
          case 'app_version_changed':
            // #21: a PR just merged and prod was rebuilt. If the user
            // is currently on this app's App tab, refresh the commit
            // pill in place so they see the new SHA without reloading.
            if (typeof AppView !== 'undefined' && AppView.appData?.slug === data.appSlug) {
              AppView.refreshVersionPill();
            }
            // Home screen: re-pull the apps list so the home-screen
            // pill picks up the new SHA. Cheap; only fires on a real
            // version change.
            if (typeof Home !== 'undefined' && document.getElementById('home-screen')
                && !document.getElementById('home-screen').classList.contains('hidden')) {
              Home.load();
            }
            // #405: the merge that triggered this rebuild also flips the
            // session to 'merged' — advance the open session's header pill +
            // change card to "✓ Merged" if it's the one being viewed.
            if (typeof DevChat !== 'undefined' && DevChat.refreshCurrentSessionStatus
                && DevChat.currentSession && DevChat.currentSession.app_slug === data.appSlug) {
              DevChat.refreshCurrentSessionStatus(DevChat.currentSession.id);
            }
            break;
          case 'app_redeploy_status':
            // Per-app rebuild started/ended. Flip both the header
            // pill (if this app is open) and the home-screen card
            // pill (if visible) into / out of the yellow + spinner
            // state immediately, no extra server round-trip.
            App.handleAppRedeployStatus(data);
            break;
          case 'admin_rollover_status':
            // Bulk container rollover progress (admin-only broadcast — see
            // ws.broadcastToAdmins). Only the admin console's rollover
            // section cares; it no-ops when that section isn't mounted.
            if (window.AdminConsole?.handleRolloverStatus) {
              AdminConsole.handleRolloverStatus(data);
            }
            break;
          case 'admin_staging_reap_status':
            // Stale-staging-preview sweep progress (admin-only broadcast —
            // see ws.broadcastToAdmins). Only the admin console's stale
            // previews section cares; it no-ops when that section isn't
            // mounted.
            if (window.AdminConsole?.handleStagingReapStatus) {
              AdminConsole.handleStagingReapStatus(data);
            }
            break;
        }
      } catch {}
    };

    App.eventsWs.onclose = () => {
      // A dropped global-events socket is the strongest early signal that
      // we've gone offline — nudge the connectivity probe so the offline
      // banner appears without waiting for a browser `offline` event.
      if (window.Offline) Offline.nudge();
      setTimeout(() => App.connectEvents(), 3000);
    };
  },

  // Pull fresh state for whatever the user is currently looking at.
  // Called on WS reconnect (and could also be wired to visibilitychange
  // for tabs that come back from being backgrounded). Each branch maps
  // to a corresponding `case` in onmessage — the rule is simply "if a
  // WS event would have driven this view, refetch the same data here."
  resyncCurrentView() {
    // `Home` and `AppView` are classic-script top-level `const` — they
    // live in the script-global lexical env but are NOT on `window`,
    // so `window.Home` / `window.AppView` would silently be undefined.
    // `Notifications` is explicitly assigned to `window` in
    // notifications.js, so that one is fine.
    if (typeof Home !== 'undefined' && document.getElementById('home-screen') && !document.getElementById('home-screen').classList.contains('hidden')) {
      Home.load();
    }
    if (window.Notifications) Notifications.refresh?.();
    if (window.WorkDrawer) WorkDrawer.refresh?.();
    // #1038: `session_state` is fire-and-forget like every other broadcast,
    // so anything that transitioned during the disconnect window was lost.
    // The reconcile endpoint is the authority — it also clears overrides for
    // sessions that finished while we were away, and detects a platform
    // restart (new bootId) that invalidated all of them.
    if (window.SessionState) SessionState.sync?.();
    // Admin console's container-rollover section: its live table is driven
    // by `admin_rollover_status`, so a dropped socket means missed
    // transitions. The loader no-ops unless that section is mounted.
    if (window.AdminConsole?.isOpen?.()) AdminConsole.loadRollover?.();
    // Same for the stale-previews sweep, driven by
    // `admin_staging_reap_status`. Each loader no-ops unless its own section
    // is the mounted one, so calling both is free.
    if (window.AdminConsole?.isOpen?.()) AdminConsole.loadStagingReap?.();
    App.loadVersion();
    if (App.currentApp && typeof AppView !== 'undefined' && AppView.appData) {
      AppView.refreshVersionPill();
      // Re-fetch tab-specific state. We don't blow away the DOM —
      // these helpers update in place — so scroll positions, drafts,
      // etc. survive the resync.
      if (App.currentTab === 'dev') {
        AppView.refreshDevData('all');
      } else if (App.currentTab === 'app') {
        AppView.refreshToken?.();
      }
    }
  },

  handleAppStatusUpdate(data) {
    // Update home screen card if visible
    const card = document.querySelector(`.app-card[data-slug="${data.slug}"]`);
    if (card) {
      // The tile carries no status dot any more (a launcher icon should
      // read as an app, not a dashboard row), so `data-status` IS the
      // update: it gates the tap-to-open handler and the cursor, and it is
      // what a full re-render reads back. The visible copy — "Spinning
      // up…" / "Error" and the Retry button — comes from the Home.load()
      // below, which every status worth showing already triggers.
      card.dataset.status = data.status;
      // #416: 'error' also triggers a re-pull — the fresh list carries
      // the (server-gated) last_failure_reason for the card tooltip and
      // the "View build log" menu item.
      if (data.status === 'running' || data.status === 'error') {
        Home.load();
      }
    }

    // Update app view if we're looking at this app
    if (App.currentApp === data.slug && App.currentTab === 'app') {
      if (data.status === 'running' && AppView.appData) {
        AppView.appData.status = 'running';
        AppView.appData.url = data.url;
        // The Share drawer row was hidden in openApp() because the app
        // wasn't running yet. Now that we have a URL, surface it.
        const drawerShareRow = document.getElementById('drawer-row-share');
        if (drawerShareRow) drawerShareRow.classList.remove('hidden');
        AppView.refreshToken().then(() => {
          // Re-check the tab — the user may have switched to group/dev
          // chat while refreshToken() was in flight. Without this guard
          // the button gets re-shown on tabs that have no iframe.
          if (App.currentApp !== data.slug || App.currentTab !== 'app') return;
          AppView.renderAppTab();
          if (window.DevConsole) DevConsole.setButtonVisible(true);
        });
      } else if (data.status === 'error' && AppView.appData) {
        // #416: a watched spin-up just failed — flip the App tab to the
        // error state immediately, carrying the broadcast one-line
        // reason so the user isn't left with a bare "Error".
        AppView.appData.status = 'error';
        if (data.errorReason) AppView.appData.errorReason = data.errorReason;
        AppView.renderAppTab();
      }
    }
  },

  // #1038: a pushed session working-state change. The spinner half needs no
  // fetch — SessionState.applyEvent repaints every subscribed surface. The
  // only thing that still warrants a refetch is a LIFECYCLE change
  // (active → paused / promoted / archived), because that changes which rows
  // exist on the board and in the drawer, not just how they're decorated.
  // Debounced so a burst of transitions costs one reload.
  _sessionStatusSeen: Object.create(null),
  _sessionRowsTimer: null,
  handleSessionState(data) {
    if (!window.SessionState || data == null || data.sessionId == null) return;
    const key = String(data.sessionId);
    const prevStatus = App._sessionStatusSeen[key];
    const nextStatus = data.status || null;
    App._sessionStatusSeen[key] = nextStatus;
    SessionState.applyEvent(data);
    if (prevStatus === undefined || prevStatus === nextStatus) return;
    if (App._sessionRowsTimer) return;
    App._sessionRowsTimer = setTimeout(() => {
      App._sessionRowsTimer = null;
      App.refreshHomeProposals();
      if (typeof AppView !== 'undefined' && AppView.refreshDevData) {
        AppView.refreshDevData('session');
      }
    }, 500);
  },

  handleSessionUpdate(data) {
    // #8: behind_main updates patch the dev-chat banner in place
    // without disturbing the surrounding chat view. We dispatch
    // before the broader re-render branches because behind_main
    // events are scoped per-session and don't need a session-list
    // refetch.
    if (data.action === 'behind_main' && typeof data.behindMain === 'number') {
      if (typeof DevChat !== 'undefined' && DevChat.applyBehindMainUpdate) {
        DevChat.applyBehindMainUpdate(data.sessionId, data.behindMain);
      }
      return;
    }
    // #252: sync-with-main lifecycle events drive the dev-chat sync
    // banner's spinner/phase text and terminal feedback. Scoped
    // per-session like behind_main — no list refetch needed.
    if (data.action === 'sync_status') {
      if (typeof DevChat !== 'undefined' && DevChat.applySyncStatusUpdate) {
        DevChat.applySyncStatusUpdate(data);
      }
      return;
    }
    // Refresh session list if we're on the Sessions sub-tab for this app
    if (App.currentApp === data.appSlug && App.currentTab === 'dev'
        && App.currentSubTab === 'sessions') {
      if (AppView.appData) {
        DevChat.loadSessions(AppView.appData.slug).then(() => {
          if (!DevChat.currentSession) DevChat.renderSessionList();
        });
      }
    }
    // Refresh proposals / inline chat vote state on the other dev sub-tabs
    if (App.currentApp === data.appSlug && App.currentTab === 'dev'
        && App.currentSubTab !== 'sessions') {
      AppView.refreshDevData('session');
    }
    // The header cog's drawer tracks session status changes.
    App.refreshHomeProposals();
  },

  handleSessionEvent(data) {
    console.log('[ws] session_event', data.event, data.sessionId, data._seq);
    // #47: the checks badge can change on any open proposal, not just the
    // dev session the viewer happens to have focused — refresh the vote
    // panel + home strip globally before the currentSession early-return.
    if (data.event === 'checks_ready') {
      if (App.currentTab === 'dev' && App.currentSubTab !== 'sessions') {
        AppView.refreshDevData('session');
      }
      App.refreshHomeProposals();
    }
    // #439: an on-demand preview rebuild (Preview-click → ensure-staging)
    // can complete for a session that isn't the focused dev-chat one (e.g. a
    // vote-panel preview), so drive the "spinning back up" overlay globally,
    // before the currentSession gate below. onStagingRebuildResult is a
    // no-op unless a matching pending marker is parked, so this is cheap.
    if (data.event === 'staging_ready') {
      AppView.onStagingRebuildResult(data.sessionId, { url: data.url });
    } else if (data.event === 'staging_failed') {
      AppView.onStagingRebuildResult(data.sessionId, { failed: true, error: data.error });
    }
    if (!DevChat.currentSession || DevChat.currentSession.id !== data.sessionId) return;
    // Dedup by sequence number
    if (data._seq && DevChat._seenSeqs?.has(data._seq)) return;
    if (data._seq) {
      if (!DevChat._seenSeqs) DevChat._seenSeqs = new Set();
      DevChat._seenSeqs.add(data._seq);
      // Deliberately do NOT advance DevChat._lastSeenSeq here. That cursor
      // seeds the resumable GET /events `?since=` replay, and WS + SSE-only
      // events interleave in ONE monotonic seq stream — advancing it from a
      // WS delivery would make the replay skip SSE-only events (suggestions,
      // quick_replies, tokens) that were never actually delivered. Replay
      // overlap is harmless (_seenSeqs dedups it); cursor over-advancement
      // loses events until refresh. Only the SSE channels move the cursor.
    }

    switch (data.event) {
      case 'status': {
        DevChat._deactivateLastStatus();
        // A status line always closes the current streaming bubble (#99 /
        // #394): when the WS is the only channel that delivered the Mayor's
        // phase-1 preamble (POST SSE dropped), seal it here so the phase-2
        // 'mayor_reasoning' summary opens a fresh bubble below the status row
        // instead of overwriting the preamble. Mirrors the POST-SSE and
        // resumable status handlers (dev-chat.js).
        for (let i = DevChat.messages.length - 1; i >= 0; i--) {
          if (DevChat.messages[i].role === 'assistant') { DevChat.messages[i]._finalized = true; break; }
        }
        // Carry the scout spec-preview card fields (#394) so the inline card
        // renders live when the scout's final status arrives via the WS after
        // a POST-SSE drop — parity with the POST-SSE (sessions.js) and
        // resumable (_handleResumedEvent) status handlers.
        // #786: carry quickReplies so a restart-recovery breadcrumb
        // delivered over the WS repaints the pill bar live — the recovery
        // paths broadcast pills on the status event, not 'quick_replies'
        // (that handler attaches to the last ASSISTANT row, which a
        // recovered turn doesn't have).
        DevChat.messages.push({ role: 'system', content: data.text, ccOutput: data.ccOutput, ccSummary: data.ccSummary, specPreview: data.specPreview, specLines: data.specLines, specVersion: data.specVersion, durationMs: data.durationMs, stagingBuild: data.stagingBuild, scoutOutput: data.scoutOutput, quickReplies: data.quickReplies, created_at: new Date().toISOString(), _slug: Math.random().toString(36).slice(2,8), _active: true });
        DevChat.renderMessages();
        DevChat.scrollToBottom();
        break;
      }
      case 'platform_issue_draft':
        // Agent-suggested platform report (human gate) — see dev-chat.js.
        DevChat._pushPlatformIssueDraft(data);
        break;
      case 'billing_switched':
        // #664: the daily free allowance ran out mid-turn and the worker
        // proxy switched the remaining calls onto the user's own key. The
        // server already persisted the matching system row; render the
        // notice live and refresh the meter so the "your key" split shows.
        DevChat.messages.push({ role: 'system', content: data.text, billingSwitch: true, created_at: new Date().toISOString(), _slug: Math.random().toString(36).slice(2,8) });
        DevChat.renderMessages();
        DevChat.scrollToBottom();
        DevChat.refreshBudget();
        break;
      case 'staging_ready':
        DevChat._deactivateLastStatus();
        DevChat.messages.push({ role: 'system', content: 'Staging deployed!', stagingUrl: data.url, created_at: new Date().toISOString(), _slug: Math.random().toString(36).slice(2,8) });
        DevChat.renderMessages();
        DevChat.scrollToBottom();
        if (data.url) {
          DevChat.currentSession.staging_url = data.url;
          // #127: testing guidance rides along with the rebuild broadcast.
          if ('testingMd' in data) DevChat.currentSession.testing_md = data.testingMd;
          if ('testingPath' in data) DevChat.currentSession.testing_path = data.testingPath;
        }
        break;
      case 'staging_failed':
        DevChat._deactivateLastStatus();
        DevChat.messages.push({
          role: 'system',
          content: `Staging build failed: ${data.error || 'unknown error'}`,
          stagingFailed: true,
          stagingErrorName: data.errorName || 'Error',
          stagingMissingKeys: data.missingKeys || [],
          created_at: new Date().toISOString(),
          _slug: Math.random().toString(36).slice(2,8),
        });
        DevChat.renderMessages();
        DevChat.scrollToBottom();
        break;
      case 'pr_created':
      case 'pr_updated':
        if (DevChat.currentSession) {
          if (data.prNumber) DevChat.currentSession.pr_number = data.prNumber;
          if (data.prUrl) DevChat.currentSession.pr_url = data.prUrl;
          if (data.prTitle) {
            DevChat.currentSession.pr_title = data.prTitle;
            // #249: server mirrors pr_title into session_title.
            DevChat.currentSession.session_title = data.prTitle;
          }
          if (typeof DevChat.renderChatView === 'function') DevChat.renderChatView();
        }
        break;
      case 'session_titled':
        // #249: pre-PR display name landed — refresh header/session UI.
        if (DevChat.currentSession && data.sessionTitle) {
          DevChat.currentSession.session_title = data.sessionTitle;
          if (typeof DevChat.renderChatView === 'function') DevChat.renderChatView();
        }
        break;
      case 'visuals_ready':
        // #195: before/after capture finished (it lands after
        // staging_ready, often after the turn's POST SSE is gone) —
        // stash the artifact ids and re-render so the staging card
        // upgrades in place with the media tiles.
        if (DevChat.currentSession && data.visuals) {
          DevChat.currentSession.visuals = data.visuals;
          DevChat.renderMessages();
        }
        break;
      case 'cc_progress':
        DevChat._appendProgressLine(data.text);
        DevChat.scrollToBottom();
        // Also arm the /status polling fallback when cc_progress arrives via
        // WS (e.g. the SSE POST itself died before getting here). Without
        // this, a WS reconnect in the middle of the run could lose every
        // subsequent event and leave the UI stuck with a spinning send
        // button and stale progress.
        if (!DevChat._progressPollTimer && DevChat.isStreaming) {
          DevChat._startProgressPolling(data.sessionId, []);
        }
        break;
      case 'mayor_reasoning': {
        // #394: the Mayor's authoritative full-text reply (phase-1 preamble or
        // phase-2 wrap-up summary). Broadcast on the WS now so the post-spec
        // summary survives a dropped POST SSE — the global-WS 'done' used to
        // tear down streaming before the resumable stream could replay it, so
        // the summary only appeared after a manual refresh. Mirrors
        // DevChat._handleResumedEvent's 'mayor_reasoning' branch. The _seq
        // dedup above already skipped this if the POST SSE delivered it first.
        if (!data.text) break;
        let am = null;
        for (let i = DevChat.messages.length - 1; i >= 0; i--) {
          if (DevChat.messages[i].role === 'assistant') { am = DevChat.messages[i]; break; }
        }
        // No live bubble yet (or the last one is sealed — phase-2 after a
        // status row) → push a fresh bubble. Otherwise reconcile the existing
        // live bubble to the server's authoritative text whenever it differs
        // (the server may have shortened it by scrubbing a fake completion
        // marker), patching the content node in place when present.
        if (!am || am._finalized) {
          DevChat.messages.push({ role: 'assistant', content: data.text, created_at: new Date().toISOString() });
          DevChat.renderMessages();
        } else if (am.content !== data.text) {
          am.content = data.text;
          const displayContent = am.content.replace(/^\[CHAT_ONLY\]\s*/i, '');
          const els = document.querySelectorAll('#dc-messages .dc-msg-assistant .dc-msg-content');
          const el = els[els.length - 1];
          if (el && typeof DevChat._renderStreamingMarkdown === 'function') {
            DevChat._renderStreamingMarkdown(el, displayContent);
          } else {
            DevChat.renderMessages();
          }
        }
        DevChat.scrollToBottom();
        break;
      }
      case 'suggestions': {
        // Q/A suggested-answer chips, no longer SSE-only: they must survive a
        // dropped POST SSE just like mayor_reasoning (#394). Attach to the
        // live assistant bubble — the emit order guarantees mayor_reasoning
        // (WS-handled above) pushed it first. A sealed bubble means a
        // dispatch turn, where suggestions were already dropped server-side —
        // skip rather than mis-attach (same guard as the resumable handler).
        if (!Array.isArray(data.suggestions) || !data.suggestions.length) break;
        let am = null;
        for (let i = DevChat.messages.length - 1; i >= 0; i--) {
          if (DevChat.messages[i].role === 'assistant') { am = DevChat.messages[i]; break; }
        }
        if (am && !am._finalized) {
          am.suggestions = data.suggestions;
          DevChat.renderMessages();
          DevChat.scrollToBottom();
        }
        break;
      }
      case 'quick_replies': {
        // Quick-reply pills ("Build it", …), no longer SSE-only: the phase-2
        // emit rides right behind the wrap-up mayor_reasoning, which a long
        // scout/build turn frequently delivers only via this WS after the
        // POST SSE died. Attach to the latest assistant bubble; the pill bar
        // reads from it, so _renderQuickReplies redraws (hidden while
        // streaming, surfaces when _finishStreaming re-renders).
        if (!Array.isArray(data.replies) || !data.replies.length) break;
        for (let i = DevChat.messages.length - 1; i >= 0; i--) {
          if (DevChat.messages[i].role === 'assistant') {
            DevChat.messages[i].quickReplies = data.replies;
            DevChat._renderQuickReplies();
            break;
          }
        }
        break;
      }
      case 'assistant_message_end': {
        // #394: seal the current assistant bubble so a subsequent
        // 'mayor_reasoning' / token starts a fresh one. Already broadcast on
        // the WS but previously ignored here; mirrors the POST-SSE and
        // resumable handlers (dev-chat.js).
        if (typeof DevChat._flushStreamingFinal === 'function') DevChat._flushStreamingFinal();
        for (let i = DevChat.messages.length - 1; i >= 0; i--) {
          if (DevChat.messages[i].role === 'assistant') { DevChat.messages[i]._finalized = true; break; }
        }
        break;
      }
      case 'done':
        DevChat._deactivateLastStatus();
        DevChat._finishStreaming();
        DevChat.renderMessages();
        // A 'done' arriving on the WS means the primary POST SSE never
        // finished this turn (its own 'done' would have been seq-deduped
        // first) — reconcile the timeline from the DB so anything that rode
        // only the dead stream (chips, pills, a late wrap-up) shows without
        // a manual refresh. See issue #446.
        DevChat._reconcileAfterFallbackDone(data.sessionId);
        break;
      case 'spec_updated':
        // Mayor's dispatch_scout updated the live draft.
        // The accompanying status event already pushed an inline preview
        // card into the chat timeline; we just keep an open spec viewer
        // in sync if the user happens to be looking at the live draft.
        if (typeof DevChat._handleSpecUpdated === 'function') {
          DevChat._handleSpecUpdated(data);
        }
        break;
      // #437: these four are broadcast on the WS (not in SSE_ONLY), so once
      // the WS path is live they MUST be handled here — handleSessionEvent
      // records `data._seq` into _seenSeqs BEFORE this switch, so an
      // unhandled type arriving first on the WS would mark the seq seen and
      // then get the matching POST-SSE / resumable copy deduped-and-swallowed.
      // Mirrors the resumable handlers in dev-chat.js (_handleResumedEvent).
      case 'phase':
        // Toggle the live-status UI between stop-button (interruptible) and
        // spinner (wrap-up). Cheap + idempotent — just swaps the button glyph.
        DevChat._setStreamingUI(true, data.phase);
        break;
      case 'stopping':
        // #889: someone hit Stop on this session (possibly in another tab or
        // on another device). Paint the interim "stopping…" state here too —
        // and note this case is REQUIRED, not decorative: an unhandled type
        // arriving first on the WS marks its _seq seen and gets the matching
        // SSE/resumable copy deduped-and-swallowed (see the comment above).
        DevChat._enterStoppingState({ by: data.by });
        break;
      case 'stopped':
        // The "Stopped by @user." status row was already persisted + emitted
        // server-side via sendStatus, so just tear down the streaming UI.
        DevChat._removeSpinner();
        DevChat._deactivateLastStatus();
        DevChat._finishStreaming();
        break;
      case 'cc_estimate':
        // Experimental AI progress estimate (opt-in, server-gated).
        // `cleared: true` (#891) blanks the guess at the coding run's end.
        DevChat._applyEstimate(data.text, data.remainingSeconds, {
          estimatedAt: data.estimatedAt, cleared: data.cleared,
        });
        break;
      case 'cc_log':
        DevChat.messages.push({ role: 'system', ccLog: data.log, content: 'Claude Code log', created_at: new Date().toISOString() });
        DevChat.renderMessages();
        DevChat.scrollToBottom();
        break;
    }
  },

  handleAppUpdate(data) {
    if (data.action === 'renamed') {
      // Update home card (if visible) and header (if we're on this app).
      const card = document.querySelector(`.app-card[data-slug="${data.slug}"]`);
      if (card) {
        const nameEl = card.querySelector('.font-medium');
        if (nameEl) nameEl.textContent = data.newName;
        // Only letter-fallback tiles track the name; a custom icon
        // (emoji/image from dapp.json) must not be clobbered by a rename.
        const avatar = card.querySelector('[data-icon]') || card.querySelector('div.rounded-xl');
        if (avatar && (avatar.dataset?.icon || 'letter') === 'letter') {
          avatar.textContent = (data.newName || '?').charAt(0).toUpperCase();
        }
      }
      if (App.currentApp === data.slug) {
        App.setHeaderTitle(data.newName);
        if (typeof AppView !== 'undefined' && AppView.applyRename) {
          AppView.applyRename(data.newName);
        }
      }
    } else if (data.action === 'icon_changed') {
      // A deploy reconciled this app's dapp.json icon block (emoji /
      // image / cleared back to the letter). Patch the mounted home
      // tile in place — no full Home.load().
      if (typeof Home !== 'undefined' && Home.updateAppCardIcon) {
        Home.updateAppCardIcon(data.slug, data.iconEmoji, data.iconUrl);
      }
    } else if (data.action === 'lock_changed') {
      // The admin-gated change lock flipped on this app (see
      // POST /api/apps/:slug/lock in routes/apps.js). Refresh the
      // home-card icon and, if the user is currently looking at this
      // app's group chat, refresh the vote panel so the "(locked —
      // also needs an admin yes)" hint appears or disappears in step.
      if (typeof Home !== 'undefined' && Home.updateAppCardLock) {
        Home.updateAppCardLock(data.appSlug, data.locked);
      }
      if (App.currentApp === data.appSlug
          && App.currentTab === 'dev'
          && typeof AppView !== 'undefined' && AppView.refreshDevData) {
        AppView.refreshDevData('lock');
      }
    } else if (data.action === 'visibility_changed') {
      // Visibility flipped (a merged visibility PR's deploy-time
      // reconcile — see services/app-manifest.js). Reload the home grid
      // so badges update and newly-private apps drop out for outsiders;
      // patch the open app's in-memory row so the Members modal and tab
      // gating see the fresh values, and re-render the modal's pills if
      // it's open right now.
      const homeScreen = document.getElementById('home-screen');
      if (typeof Home !== 'undefined' && homeScreen && !homeScreen.classList.contains('hidden')) {
        Home.load();
      }
      if (App.currentApp === data.appSlug
          && typeof AppView !== 'undefined' && AppView.appData) {
        AppView.appData.collab_visibility = data.collabVisibility;
        AppView.appData.view_visibility = data.viewVisibility;
        const membersModal = document.getElementById('members-modal');
        if (membersModal && !membersModal.classList.contains('hidden')
            && AppView._renderMembersVisPills) {
          AppView._membersVis = { collab: data.collabVisibility, view: data.viewVisibility };
          AppView._renderMembersVisPills();
        }
      }
    } else if (data.action === 'governance_changed') {
      // Proposal-approval settings applied (a merged governance PR's
      // deploy-time reconcile — issue #646). Patch the open app's
      // in-memory row and re-render the modal's pills if it's open.
      if (App.currentApp === data.appSlug
          && typeof AppView !== 'undefined' && AppView.appData) {
        AppView.appData.approver_policy = data.approverPolicy;
        AppView.appData.approvals_required = data.approvalsRequired;
        const membersModal = document.getElementById('members-modal');
        if (membersModal && !membersModal.classList.contains('hidden')
            && AppView._renderMembersGovPills) {
          AppView._membersGov = {
            policy: data.approverPolicy === 'invited' ? 'invited' : 'anyone',
            atLeast: data.approvalsRequired != null ? Number(data.approvalsRequired) : null,
          };
          AppView._renderMembersGovPills();
          // The policy flip changes whether the Approvers section shows
          // (its visibility is roster-driven — see _renderApprovers) and
          // the merge may have auto-seeded the creator — refetch.
          if (AppView.loadApprovers) AppView.loadApprovers();
        }
        if (App.currentTab === 'dev' && AppView.refreshDevData) {
          AppView.refreshDevData('governance');
        }
      }
    } else if (data.action === 'admins_changed') {
      // Per-app admin roster applied (a merged admins PR's deploy-time
      // reconcile — issue #788, or a hand-edited dapp.json). Patch the
      // open app's in-memory row and refetch the Members modal's
      // App-admins section if it's open right now.
      if (App.currentApp === data.appSlug
          && typeof AppView !== 'undefined' && AppView.appData) {
        AppView.appData.admin_usernames = Array.isArray(data.admins) ? data.admins : [];
        const membersModal = document.getElementById('members-modal');
        if (membersModal && !membersModal.classList.contains('hidden')
            && AppView.loadAppAdmins) {
          // The applied roster supersedes any in-progress draft — a
          // stale draft would misreport what the app now declares.
          AppView._appAdminsDraft = null;
          AppView.loadAppAdmins();
        }
      }
    }
  },

  // Refresh the relevant dev sub-tab when another user creates, votes on,
  // or closes an issue / governance proposal so everyone sees it live.
  handleIssueUpdate(data) {
    if (App.currentApp === data.appSlug && App.currentTab === 'dev') {
      AppView.refreshDevData('issue');
    }
  },

  // A vote/session event landed that affects the viewer's own work:
  // refresh the header cog's drawer (which took over the home screen's
  // old "Your proposals" / "Your active sessions" strips) and, while the
  // home screen is visible, re-pull the app grid too (Home.load is cheap
  // and already the live-update pattern — its cards carry activity
  // counts that these same events move).
  refreshHomeProposals() {
    if (window.WorkDrawer && WorkDrawer.refresh) WorkDrawer.refresh();
    const homeScreen = document.getElementById('home-screen');
    if (typeof Home !== 'undefined' && homeScreen && !homeScreen.classList.contains('hidden')) {
      Home.load();
    }
  },

  // #1015: a self-app merge no longer latches any platform-wide chrome.
  // The "Platform updating… write actions are paused" banner (and its
  // fetch write-block, 2s version poll, stuck timer and forced reload)
  // existed because a self-app merge restarted the ONE platform
  // container. Blue-green deploys (#1008, scripts/platform-rollout.sh)
  // keep the live color serving until the new one is health-gated and
  // cut over, so there is no downtime to announce and no reason to
  // pause writes. `data.selfHosted` still rides along on these
  // broadcasts (it's a cheap, honest fact) — this handler simply
  // doesn't branch on it, and per-proposal state is carried by the
  // proposal's own badges. A tab left open across a platform deploy is
  // caught up by the drawer's stale-version pill
  // (renderPlatformVersionPill) or by pull-to-refresh (_refreshOrReload).
  handleVoteUpdate(data) {
    // Refresh the proposals tab / inline chat vote state if we're in
    // this app's Dev view.
    if (App.currentApp === data.appSlug && App.currentTab === 'dev') {
      AppView.refreshDevData('vote');
    }
    // #405: advance the OPEN dev session's header pill + change card live
    // (e.g. promoted → merging → merged) when this update is for the session
    // the user is currently looking at. No-op otherwise.
    if (typeof DevChat !== 'undefined' && DevChat.refreshCurrentSessionStatus) {
      DevChat.refreshCurrentSessionStatus(data.sessionId);
    }
    // The header cog's drawer tracks tallies live.
    App.refreshHomeProposals();
    // If merged, refresh the app view
    if (data.merged && App.currentApp === data.appSlug) {
      if (App.currentTab === 'app') {
        AppView.renderAppTab();
      }
      Home.load();
    }
  },

  // Drawer status/version rows (header slim-down): the kudos + AI-credit
  // meters render into #drawer-status-pane, and the platform/app build
  // lines + fork lineage label into #drawer-footer — none of them in the
  // header any more. Their RENDERERS are untouched — every slot kept its
  // id through both moves — so all this owns is the two app-scoped rows'
  // visibility plus the hamburger's amber deploy dot.
  DrawerStatus: {
    // The "App" build row follows the same lifecycle as
    // #drawer-row-github / #drawer-row-share: visible only while an app
    // is open. Called from openApp and from every navigate* that leaves
    // an app behind.
    //
    // The header's App/Dev switch rides the SAME lifecycle, which is why
    // it's owned here rather than in a seventh place: this one call
    // already covers openApp, navigateHome, AppView.close() and all six
    // other-screen navigations (leaderboard, challenges, profile, admin,
    // settings, topochain). It used to be free — the old #app-tabs bar
    // was a child of #app-view and disappeared whenever that did — but a
    // header-resident control has to be hidden explicitly.
    setAppOpen(open) {
      const row = document.getElementById('drawer-row-app-version');
      if (row) row.classList.toggle('hidden', !open);
      // Fork lineage is app-scoped too — closing an app can never leave
      // the previous app's "Forked from" line behind.
      if (!open) App.DrawerStatus.setForkVisible(false);
      // Self-hosted apps (the platform's own row) have no App mode at
      // all — appData.url maps to a slug-derived subdomain that doesn't
      // resolve, so switchTab coerces them to the Dev forum. A switch
      // with one reachable option is noise, so hide the whole control
      // rather than shipping a dead segment. setAppOpen(true) runs after
      // the /api/apps/:slug fetch resolves, so self_hosted is known by
      // the time this reads it.
      const modeSwitch = document.getElementById('app-mode-switch');
      if (modeSwitch) {
        const show = !!open && !window.AppView?.appData?.self_hosted;
        modeSwitch.classList.toggle('hidden', !show);
        // The control materially changes the header's right-group width,
        // which is one of the two inputs to the title's centered-vs-flow
        // decision. The group's ResizeObserver would catch this on its
        // own a frame later; the explicit hook exists so the title
        // doesn't visibly jump.
        window.HeaderLayout?.refresh?.();
      }
      App.DrawerStatus.refreshDeployDot();
    },

    // Driven by AppView.renderForkBadge(): shown only when it actually
    // wrote a badge (i.e. the open app is a fork). `flex`, not the row
    // default, because the row ships `hidden` and Tailwind's `hidden`
    // would otherwise fight an inline display.
    setForkVisible(visible) {
      const row = document.getElementById('drawer-row-app-fork');
      if (!row) return;
      row.classList.toggle('hidden', !visible);
      row.classList.toggle('flex', !!visible);
    },

    // Mirror "a deploy is in flight" onto the hamburger. Read straight
    // off the rendered version lines rather than threading state: their
    // markup is already the single source of truth for the deploying
    // state (renderAppVersionPillHTML / renderPlatformVersionPill both
    // stamp .drawer-ver--deploying on the footer's text form), and both
    // may change independently. Scoped to #drawer-footer — where the two
    // version lines live since the footer split — so a deploying home-tile
    // pill elsewhere in the document can never light this dot.
    refreshDeployDot() {
      const dot = document.getElementById('header-menu-deploy-dot');
      if (!dot) return;
      const deploying = !!document.querySelector(
        '#drawer-footer .drawer-ver--deploying');
      dot.classList.toggle('hidden', !deploying);
    },
  },

  // Slide-out navigation drawer — available at every viewport width
  // (#122). Top to bottom: the kudos/AI-credit status pane, the theme
  // selector directly below it, the native Node/Wallet rows, the four
  // main nav rows (Profile, Leaderboard, Settings, Admin & moderation),
  // and a bottom-anchored footer carrying the platform/app build lines
  // plus GitHub + Share. (Members & visibility moved to the Dev "+"
  // menu — #645.)
  HeaderMenu: {
    _panel: null,

    // ── Presentation state (#977) ───────────────────────────────────
    // The drawer's exit is the ONE motion a sidebar-originated
    // navigation is allowed to show, so App._entryTransition has to be
    // able to ask "is this drawer on screen (or still animating out)?"
    // and "did a link inside it just start this navigation?".
    //
    // _closingAt exists only for the LEGACY (desktop / kit-missing)
    // path: close() strips [data-open] synchronously while the 200ms
    // CSS slide still has to run, so the attribute alone reports the
    // drawer as gone while it is visibly still there. The kit path
    // needs no timestamp — _panel is cleared in the onDismiss teardown,
    // i.e. only once the exit spring has come to rest.
    _closingAt: 0,
    _navArmedAt: 0,
    // Callers waiting for the drawer to be fully gone (close()'s
    // completion promise — see close()).
    _dismissWaiters: [],
    LEGACY_CLOSE_MS: 200,
    // The legacy slide plus a frame of margin.
    CLOSING_WINDOW_MS: 260,
    // Generous, because it is CONSUMED on first read: only a link that
    // produced no navigation at all can leave it to expire.
    NAV_ARM_TTL_MS: 600,
    // Backstop for the completion promise, so a teardown that never
    // fires (a kit that vanished, a superseded handle) can't strand a
    // caller that chained its own presentation behind it.
    DISMISS_SAFETY_MS: 500,

    _now() {
      return (typeof performance !== 'undefined' && performance.now)
        ? performance.now()
        : Date.now();
    },

    // True while the drawer surface is on screen OR still animating out.
    isPresenting() {
      if (App.HeaderMenu._panel) return true;
      const panel = document.getElementById('header-menu-panel');
      if (panel && panel.hasAttribute('data-open')) return true;
      return App.HeaderMenu._closingAt > 0
        && (App.HeaderMenu._now() - App.HeaderMenu._closingAt)
          < App.HeaderMenu.CLOSING_WINDOW_MS;
    },

    // One-shot: a link inside the drawer armed this immediately before
    // close(), and the navigation it triggered is the next thing to ask.
    // Consumed on read so it can never apply to a second navigation.
    consumeNavPending() {
      const at = App.HeaderMenu._navArmedAt;
      if (!at) return false;
      App.HeaderMenu._navArmedAt = 0;
      return (App.HeaderMenu._now() - at) < App.HeaderMenu.NAV_ARM_TTL_MS;
    },

    _resolveDismissWaiters() {
      const waiters = App.HeaderMenu._dismissWaiters;
      if (!waiters.length) return;
      App.HeaderMenu._dismissWaiters = [];
      for (const resolve of waiters) {
        try { resolve(); } catch (err) { /* ignore */ }
      }
    },

    open() {
      const panel = document.getElementById('header-menu-panel');
      const overlay = document.getElementById('header-menu-overlay');
      const btn = document.getElementById('header-menu-btn');
      if (!panel) return;
      // A fresh presentation ends any "still sliding out" window the
      // legacy path was counting down (#977).
      App.HeaderMenu._closingAt = 0;
      // #555: the AI-credit row only ever renders in this drawer, so
      // opening it is exactly when its number matters. The refresh is
      // throttled inside AiCredit, so this is cheap on every open —
      // and it must run BEFORE the touch branch below, which returns.
      if (window.AiCredit?.refreshAll) AiCredit.refreshAll();
      // Touch platforms: present the drawer as a kit side panel — a
      // right-edge slide-in with 1:1 drag-to-dismiss, matching what
      // desktop's CSS slide-over already does positionally (it used to
      // come up from the bottom as a sheet capped at 70vh, which cut the
      // bottom-anchored footer off). The panel element itself is adopted
      // via contentEl — its row listeners ride along — and is restored to
      // <body> (off-screen, as usual) when the panel dismisses. Desktop
      // keeps the right-side slide-over below.
      if (PlatformUI.isTouch()) {
        App.HeaderMenu._renderThemeButtons();
        panel.classList.add('platform-panel-adopted');
        // Assigned right below; captured here so onDismiss can tell its own
        // teardown apart from a newer one's (see the guard).
        let handle = null;
        const kitPanel = PlatformUI.panel({
          contentEl: panel,
          side: 'right',
          onDismiss: () => {
            // The drawer this handle owned has left the screen, so anyone
            // who chained a presentation behind close() may go — resolved
            // BEFORE the ownership guard below, or a superseded teardown
            // would strand them until the safety cap (#977).
            App.HeaderMenu._resolveDismissWaiters();
            // Teardown is deferred behind the exit spring, so a tap on the
            // hamburger during that window can re-adopt the drawer into a
            // NEW kit panel before this fires. Restoring it to <body> then
            // would yank the node straight back out of the panel the user
            // just opened, leaving an empty drawer. Only the CURRENT
            // handle's teardown owns the node.
            if (handle && App.HeaderMenu._panel !== handle) return;
            panel.classList.remove('platform-panel-adopted');
            document.body.appendChild(panel);
            App.HeaderMenu._panel = null;
            // The hamburger's state is not the kit's business, so it is
            // reset here on EVERY exit path (backdrop, Escape, ✕, row
            // navigation) — they all route through the kit dismiss.
            btn.setAttribute('aria-expanded', 'false');
            btn.setAttribute('aria-label', 'Open menu');
          },
        });
        handle = kitPanel;
        if (kitPanel) {
          App.HeaderMenu._panel = kitPanel;
          // The touch path used to return before the aria writes below,
          // leaving the button reading "Open menu" / collapsed while the
          // drawer was open.
          btn.setAttribute('aria-expanded', 'true');
          btn.setAttribute('aria-label', 'Close menu');
          return;
        }
        panel.classList.remove('platform-panel-adopted');
      }
      overlay.classList.remove('hidden');
      // Force a reflow so the transition fires (element was display:none).
      overlay.getBoundingClientRect();
      overlay.setAttribute('data-open', '');
      panel.setAttribute('data-open', '');
      btn.setAttribute('aria-expanded', 'true');
      btn.setAttribute('aria-label', 'Close menu');
      // Reflect the current theme mode every time the drawer opens (covers
      // cross-tab changes and explicit values that happen to match the OS).
      App.HeaderMenu._renderThemeButtons();
      const closeBtn = document.getElementById('header-menu-close');
      if (closeBtn) closeBtn.focus();
    },
    // Order of the three segments in the DOM — also the caret's stop
    // index, so the two can never disagree.
    THEME_MODES: ['light', 'dark', 'system'],

    // Sync the Light/Dark/System segmented control from Theme.get(): the
    // raised active segment, its aria-checked state, and the position of
    // the caret underneath it. Safe to call before Theme/DOM exist
    // (guards both).
    //
    // The caret is moved by writing --theme-caret-index (0|1|2) on the
    // track and letting CSS translate a thirds-width element by
    // index * 100%. Deliberately NOT an offsetLeft measurement: this runs
    // once from open() BEFORE PlatformUI.panel resizes the panel from
    // w-60 to the kit drawer's --un-panel-width, so a pixel read here
    // would be stale the moment the panel presents. Percentages are
    // correct at both widths with no re-measure, and the transition in
    // CSS is what makes the caret slide between segments.
    _renderThemeButtons() {
      if (!window.Theme) return;
      const current = Theme.get();
      document.querySelectorAll('#drawer-theme-track [data-theme-mode]').forEach((b) => {
        const active = b.dataset.themeMode === current;
        b.classList.toggle('theme-seg-active', active);
        b.setAttribute('aria-checked', active ? 'true' : 'false');
      });
      const track = document.getElementById('drawer-theme-track');
      if (track) {
        const idx = Math.max(0, App.HeaderMenu.THEME_MODES.indexOf(current));
        track.style.setProperty('--theme-caret-index', String(idx));
      }
    },
    // Returns a promise that resolves once the drawer is actually GONE —
    // the kit teardown on the touch path, the CSS slide's end on the
    // legacy one, immediately when nothing was open (#977). Callers that
    // present a surface of their own (the Node / Wallet sheets, the Share
    // dialog) chain it so only one surface moves at a time; every other
    // caller can keep ignoring the return value.
    close() {
      if (App.HeaderMenu._panel) {
        const done = App.HeaderMenu._afterDismiss();
        App.HeaderMenu._closingAt = App.HeaderMenu._now();
        App.HeaderMenu._panel.dismiss();
        return done;
      }
      const panel = document.getElementById('header-menu-panel');
      const overlay = document.getElementById('header-menu-overlay');
      const btn = document.getElementById('header-menu-btn');
      if (!panel) return Promise.resolve();
      const wasOpen = panel.hasAttribute('data-open');
      if (wasOpen) App.HeaderMenu._closingAt = App.HeaderMenu._now();
      panel.removeAttribute('data-open');
      overlay.removeAttribute('data-open');
      btn.setAttribute('aria-expanded', 'false');
      btn.setAttribute('aria-label', 'Open menu');
      if (!wasOpen) return Promise.resolve();
      const done = App.HeaderMenu._afterDismiss();
      // Hide overlay after the slide-out transition finishes.
      setTimeout(() => {
        overlay.classList.add('hidden');
        App.HeaderMenu._resolveDismissWaiters();
      }, App.HeaderMenu.LEGACY_CLOSE_MS);
      return done;
    },

    // The completion promise itself: settled by whichever exit path runs,
    // with a hard safety cap so a teardown that never fires can't hang a
    // chained presentation forever.
    _afterDismiss() {
      return new Promise((resolve) => {
        App.HeaderMenu._dismissWaiters.push(resolve);
        setTimeout(resolve, App.HeaderMenu.DISMISS_SAFETY_MS);
      });
    },
    init() {
      const btn = document.getElementById('header-menu-btn');
      if (!btn) return;
      btn.addEventListener('click', () => App.HeaderMenu.open());
      document.getElementById('header-menu-close')
        .addEventListener('click', () => App.HeaderMenu.close());
      document.getElementById('header-menu-overlay')
        .addEventListener('click', () => App.HeaderMenu.close());
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          // Adopted into a kit panel: the kit's own modal-stack handler
          // owns Escape (it dismisses the topmost surface, which may be a
          // modal opened above the drawer). Don't double-handle it.
          if (App.HeaderMenu._panel) return;
          const panel = document.getElementById('header-menu-panel');
          if (panel && panel.hasAttribute('data-open')) App.HeaderMenu.close();
        }
      });
      // Every LINK inside the drawer, in one rule (#977). Two jobs:
      //
      //   1. Arm the single-motion rule. A same-document hash link is
      //      about to navigate the shell, and the drawer's own exit is
      //      the only motion that navigation may show — so stamp
      //      _navArmedAt and let App._entryTransition downgrade the
      //      screen animation to 'none'. External links (the GitHub row,
      //      whose href is an absolute repo URL) animate nothing in this
      //      document, so they only close.
      //   2. Close the drawer for links that never had a handler of
      //      their own: the Kudos meter in the status pane
      //      (#leaderboard/prs, rendered by kudos.js) and the footer's
      //      "Forked from" line (#app/<slug>, rendered by app-view.js)
      //      used to navigate with the drawer left wide open.
      //
      // Registered on the panel element itself, so it rides along when
      // the panel is adopted into the kit drawer — same reason the
      // per-row listeners below survive adoption. Those per-row
      // handlers are now redundant with this one, and harmlessly so:
      // both close paths are idempotent (the kit's dismiss() returns
      // early once closed).
      const drawerPanel = document.getElementById('header-menu-panel');
      if (drawerPanel) {
        drawerPanel.addEventListener('click', (e) => {
          const link = e.target.closest ? e.target.closest('a[href]') : null;
          if (!link || !drawerPanel.contains(link)) return;
          // #1036: a cmd/ctrl/shift/middle click opens the destination
          // in ANOTHER tab — nothing navigates in this document, so
          // there is no screen animation to suppress (arming the flag
          // would leak onto the NEXT real navigation until its TTL) and
          // no reason to tear the drawer down under the user.
          if (window.NavLink && NavLink.isNativeClick(e)) return;
          // getAttribute, not .href: the property resolves to an absolute
          // URL, which would make every in-page hash link look external.
          const href = link.getAttribute('href') || '';
          if (href.startsWith('#')) {
            App.HeaderMenu._navArmedAt = App.HeaderMenu._now();
          }
          App.HeaderMenu.close();
        });
      }
      // Drawer row actions — each closes the menu after triggering its action.
      document.getElementById('drawer-row-github')
        .addEventListener('click', () => App.HeaderMenu.close());
      // Leaderboard (the merged Kudos + Topochain + Challenges screen) —
      // same real-anchor idiom as Profile below: navigation rides the
      // anchor's hash, the click handler here just closes the drawer. The
      // separate Challenges / Topochain-seasons rows that used to sit
      // beside it are gone; they're tabs of this one screen now.
      document.getElementById('drawer-row-leaderboard')
        ?.addEventListener('click', () => App.HeaderMenu.close());
      // Share — a dialog of its own, so it waits for the drawer to be
      // gone rather than fading in across the drawer's exit (#977).
      document.getElementById('drawer-row-share')
        .addEventListener('click', () => {
          Promise.resolve(App.HeaderMenu.close()).then(() => {
            if (window.AppView) AppView.openShareModal();
          });
        });
      // Settings — the #settings screen (settings-modal-to-screen
      // conversion). Same real-anchor idiom as Challenges / Profile above:
      // navigation rides the anchor's hash, this handler just closes the
      // drawer.
      document.getElementById('drawer-row-settings')
        ?.addEventListener('click', () => App.HeaderMenu.close());
      // Admin & moderation — visibility is App.renderAdminButton()'s job
      // (isAdmin gate); navigation rides the anchor's #admin hash, which
      // navigateToAdminConsole re-gates. Same idiom as Settings above.
      document.getElementById('drawer-row-admin')
        ?.addEventListener('click', () => App.HeaderMenu.close());
      // Theme segmented control — a live control, NOT a navigation row: it
      // sets the mode and re-highlights WITHOUT closing the drawer, so the
      // user can see the recolor and switch again.
      if (window.Theme) {
        document.querySelectorAll('#drawer-theme-track [data-theme-mode]').forEach((b) => {
          b.addEventListener('click', () => {
            Theme.set(b.dataset.themeMode);
            App.HeaderMenu._renderThemeButtons();
          });
        });
        // Storage/OS-driven changes (other tab, OS sunset switch) re-highlight too.
        Theme.onChange(() => App.HeaderMenu._renderThemeButtons());
        App.HeaderMenu._renderThemeButtons();
      }
    },
  },

  // Pull-to-refresh on the static full-screen scrollers (element mode —
  // the platform is a fixed shell). The kit no-ops these on desktop.
  // The Dev tab feed's scroller is re-created per render and wires its
  // own PTR in AppView.renderDevView.
  _wirePullToRefresh() {
    const home = document.getElementById('home-screen');
    if (home) {
      PlatformUI.pullToRefresh(home,
        () => App._refreshOrReload(() => Home.load()));
    }
    // The #apps browse screen (home-screen split). Its own scroller and
    // its own fetch, so it must not be routed through Home.load().
    const browse = document.getElementById('browse-screen');
    if (browse) {
      PlatformUI.pullToRefresh(browse,
        () => App._refreshOrReload(() => (window.Browse ? Browse._load() : Promise.resolve())));
    }
    // The Leaderboard screen hosts three panes; refresh whichever is
    // active. The two Topochain panes keep their own event/page state and
    // their own fetches, so they must NOT be routed through
    // Leaderboard._cache.
    const lb = document.getElementById('leaderboard-screen');
    if (lb) {
      PlatformUI.pullToRefresh(lb, () => {
        if (!window.Leaderboard) return Promise.resolve();
        if (Leaderboard.section === 'topochain') {
          if (!window.TopochainLeaderboard) return Promise.resolve();
          return TopochainLeaderboard.loadLeaderboard();
        }
        if (Leaderboard.section === 'challenges') {
          if (!window.TopochainChallenges) return Promise.resolve();
          return TopochainChallenges.loadChallenges();
        }
        Leaderboard._cache.clear();
        return Leaderboard._load();
      });
    }
    const notifList = document.getElementById('notifications-list');
    if (notifList) PlatformUI.pullToRefresh(notifList, () => Notifications.refresh());
  },

  bindEvents() {
    // Note: the "Create new app" entry point lives in the home feed
    // now (see Home.wireCreateButtons) — no static header button to
    // bind here anymore.
    App.HeaderMenu.init();
    App._wirePullToRefresh();
    document.getElementById('create-cancel').addEventListener('click', App.hideCreateModal);
    document.getElementById('create-modal').addEventListener('click', (e) => {
      if (e.target === e.currentTarget || e.target.dataset.modalBackdrop !== undefined) App.hideCreateModal();
    });
    document.getElementById('create-form').addEventListener('submit', App.handleCreateApp);

    // Create / Import mode pills. The active mode lives on
    // #create-card[data-mode="..."] (CSS keys off it for styling); these
    // handlers also flip the submit-button label and the URL block.
    document.querySelectorAll('.create-mode-pill').forEach((pill) => {
      pill.addEventListener('click', () => App.setCreateMode(pill.dataset.modePill));
    });

    // Visibility pills (Who can build / Who can see & use). Two
    // independent segmented controls; collab=public forces view=public
    // (invariant: a publicly-buildable app can't be privately viewed).
    document.querySelectorAll('#create-visibility-block [data-collab-vis]').forEach((pill) => {
      pill.addEventListener('click', () => App.setCreateVisibility('collab', pill.dataset.collabVis));
    });
    document.querySelectorAll('#create-visibility-block [data-view-vis]').forEach((pill) => {
      pill.addEventListener('click', () => App.setCreateVisibility('view', pill.dataset.viewVis));
    });
    App.setCreateVisibility('collab', 'public');

    // Members & visibility modal (close/backdrop; the open entry point
    // is the Dev "+" menu's Members item, wired in AppView._wirePlusMenu).
    const membersClose = document.getElementById('members-close');
    if (membersClose) membersClose.addEventListener('click', () => AppView.hideMembersModal());
    const membersModal = document.getElementById('members-modal');
    if (membersModal) membersModal.addEventListener('click', (e) => {
      // Ignore the trailing ghost click from the tap that opened the modal
      // (see AppView.revealModal) so it can't close it instantly.
      if (window.AppView && AppView.modalDismissGuarded && AppView.modalDismissGuarded(membersModal)) return;
      if (e.target === e.currentTarget || e.target.dataset.modalBackdrop !== undefined) {
        AppView.hideMembersModal();
      }
    });

    // Import flow: explicit "Check" button.
    //
    //   idle ─┬─ Check click ─→ checking ─┬─ ok    (name field reveals,
    //         │                           │        prefilled, Import enables)
    //         │                           └─ error (inline message, retry)
    //         └─ user edits URL after a successful check → back to idle
    //
    // Why explicit Check and not debounced auto-check? Two reasons:
    // (1) "I just invited the bot, click here" is a clear action that
    //     pairs with the inline error text from the server, vs. a
    //     debounced surprise; (2) verifyBotAccess can mutate state by
    //     accepting a pending invitation, and we don't want that firing
    //     on every keystroke.
    const checkBtn = document.getElementById('import-check');
    const importInput = document.getElementById('import-url');
    if (checkBtn) checkBtn.addEventListener('click', App.handleImportCheck);
    if (importInput) {
      importInput.addEventListener('input', () => {
        // Any edit invalidates the previous check; the user must click
        // again. Without this, the user could verify repo A, edit the
        // URL to point at repo B, then submit — the route's own
        // pre-flight catches it, but the UI shouldn't claim "verified"
        // for a URL that hasn't been verified.
        if (App._setImportState) App._setImportState('idle');
      });
    }
    // The header button shows a HOUSE icon and that's what users read
    // it as: "go to home", not "go back one step". So clicking it
    // navigates straight to the home screen, skipping any
    // intermediate tabs/sessions in the history stack.
    //
    // Step-by-step back is still available — it lives on the
    // device/system back button (Flutter delegates to
    // `WebViewController.canGoBack()`, which reads the same browser
    // history this app pushes via updateHash()) and on the browser
    // back arrow on desktop. Both route through the popstate handler
    // installed in init(), which calls restoreFromHash() to rebuild
    // state from the previous URL.
    // The header back button is "home" for every screen — except inside a
    // mobile admin/settings section, where it is that section's back arrow
    // and pops to that screen's section menu (handleBack returns true when
    // it consumed the press). Gating on App._inAdmin / App._inSettings
    // means there is no override state that can go stale.
    //
    // #1036: the button is an <a href> now, so a cmd/ctrl/shift/middle
    // click is the BROWSER's to handle (new tab / new window) — bail out
    // before preventDefault and let it. The guard is the first statement
    // in the callback; the screen-hook chain below it is unchanged.
    document.getElementById('back-btn').addEventListener('click', (e) => {
      if (window.NavLink && NavLink.isNativeClick(e)) return;
      e.preventDefault();
      if (App._inAdmin && window.AdminConsole?.handleBack?.()) return;
      if (App._inSettings && window.Settings?.handleBack?.()) return;
      // Browse's detail level (#apps/<slug>) claims the button as "up to
      // the list"; on the list itself it declines and we leave the screen.
      if (App._inBrowse && window.Browse?.handleBack?.()) return;
      App.navigateHome();
    });

    // Rename modal
    const renameModal = document.getElementById('rename-modal');
    if (renameModal) {
      document.getElementById('rename-cancel').addEventListener('click', AppView.closeRenameModal);
      renameModal.addEventListener('click', (e) => {
        if (e.target === e.currentTarget || e.target.dataset.modalBackdrop !== undefined) AppView.closeRenameModal();
      });
      document.getElementById('rename-form').addEventListener('submit', AppView.submitRename);
    }

    // Propose-to-close-issue modal
    const closeIssueModal = document.getElementById('close-issue-modal');
    if (closeIssueModal) {
      document.getElementById('close-issue-cancel').addEventListener('click', AppView.closeCloseIssueModal);
      closeIssueModal.addEventListener('click', (e) => {
        if (e.target === e.currentTarget || e.target.dataset.modalBackdrop !== undefined) AppView.closeCloseIssueModal();
      });
      document.getElementById('close-issue-form').addEventListener('submit', AppView.submitCloseIssue);
      // cmd+enter / ctrl+enter inside the reason textarea submits, same as
      // the feedback modal. Textareas swallow plain Enter (newline), so we
      // only intercept when the modifier is held; skip while a submit is
      // already in flight (button disabled).
      document.getElementById('close-issue-reason').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          const form = document.getElementById('close-issue-form');
          const submitBtn = document.getElementById('close-issue-submit');
          if (submitBtn?.disabled || !form.checkValidity()) return;
          AppView.submitCloseIssue();
        }
      });
    }

    // Fork modal
    const forkModal = document.getElementById('fork-modal');
    if (forkModal) {
      document.getElementById('fork-cancel').addEventListener('click', AppView.closeForkModal);
      forkModal.addEventListener('click', (e) => {
        // Ignore the trailing ghost-click from the opening tap (see
        // AppView.revealModal / modalDismissGuarded).
        if (AppView.modalDismissGuarded(forkModal)) return;
        if (e.target === e.currentTarget || e.target.dataset.modalBackdrop !== undefined) AppView.closeForkModal();
      });
      document.getElementById('fork-form').addEventListener('submit', AppView.submitFork);
    }

    // Import-a-PR modal (#687) — mirrors the fork modal wiring.
    const importPrModal = document.getElementById('import-pr-modal');
    if (importPrModal) {
      document.getElementById('import-pr-cancel').addEventListener('click', AppView.closeImportPrModal);
      document.getElementById('import-pr-submit').addEventListener('click', AppView.submitImportPr);
      importPrModal.addEventListener('click', (e) => {
        if (AppView.modalDismissGuarded(importPrModal)) return;
        // #846: a backdrop tap must not dismiss the dialog while the import
        // POST is in flight (closeImportPrModal also refuses, this just
        // avoids the wasted work).
        if (AppView._importPrBusy) return;
        if (e.target === e.currentTarget || e.target.dataset.modalBackdrop !== undefined) AppView.closeImportPrModal();
      });
    }

    // Feedback
    const feedbackTitle = document.getElementById('feedback-title');
    const feedbackText = document.getElementById('feedback-text');
    const feedbackBtn = document.getElementById('feedback-submit');
    const feedbackStatus = document.getElementById('feedback-status');
    const feedbackTargetApp = document.getElementById('feedback-target-app');
    const feedbackTargetPlatform = document.getElementById('feedback-target-platform');
    const feedbackCaretApp = document.getElementById('feedback-caret-app');
    const feedbackCaretPlatform = document.getElementById('feedback-caret-platform');

    // Currently selected feedback target ('app' or 'platform'). The
    // "This app" button is only enabled when an app with a repo is open,
    // so this stays 'platform' on home/leaderboard. Reset on each open.
    let feedbackTarget = 'platform';
    // #685: whether the open app announced a usernode.issueState provider
    // from the mounted iframe. Computed on each modal open; the "Include
    // app state" row shows only while this holds AND the target is 'app'.
    let stateAvailable = false;
    const stateRow = document.getElementById('feedback-state-row');
    const stateCheckbox = document.getElementById('feedback-state-checkbox');
    // #964: the opt-in kudos-bounty row. Unlike the state row this shows for
    // BOTH targets — "This app" and "Social Vibecoding Platform" alike file
    // into a repository the platform tracks as an app, so either can carry a
    // bounty.
    const bountyRow = document.getElementById('feedback-bounty-row');
    const bountyCheckbox = document.getElementById('feedback-bounty-checkbox');
    const bountyNote = document.getElementById('feedback-bounty-note');
    // Paint the row from the viewer's live weekly allowance and return it to
    // its unchecked default. Budget state is null only when the first-load
    // fetch failed — show the row enabled with no count rather than hiding a
    // working feature; the server is the real gate.
    const resetBountyRow = () => {
      bountyCheckbox.checked = false;
      const budget = window.Kudos?.Budget?.state || null;
      const remaining = budget ? budget.remaining : null;
      const limit = budget ? budget.limit : null;
      const exhausted = remaining === 0;
      bountyCheckbox.disabled = exhausted;
      bountyRow.classList.toggle('opacity-60', exhausted);
      if (remaining === null) bountyNote.textContent = '';
      else if (exhausted) bountyNote.textContent = `You've used all ${limit} kudos this week — resets Monday 00:00 UTC.`;
      else bountyNote.textContent = `${remaining} of ${limit} kudos left this week`;
      bountyRow.classList.remove('hidden');
    };
    // The selected option uses a darker violet on hover so it keeps its
    // active look; the unselected option uses the neutral zinc hover.
    const activeTargetClasses = ['bg-violet-600', 'text-white', 'border-violet-600', 'hover:bg-violet-500'];
    const inactiveHoverClasses = ['hover:bg-zinc-100', 'dark:hover:bg-zinc-800'];
    const disabledTargetClasses = ['opacity-40', 'cursor-not-allowed'];
    // Toggle the active styling between the two buttons. Enabled/disabled
    // state of the "This app" button is owned by the open handler.
    const setFeedbackTarget = (target) => {
      feedbackTarget = target;
      const onApp = target === 'app';
      feedbackTargetApp.setAttribute('aria-checked', onApp ? 'true' : 'false');
      feedbackTargetPlatform.setAttribute('aria-checked', onApp ? 'false' : 'true');
      activeTargetClasses.forEach((c) => {
        feedbackTargetApp.classList.toggle(c, onApp);
        feedbackTargetPlatform.classList.toggle(c, !onApp);
      });
      // The neutral hover only applies to the unselected option, so the
      // selected one doesn't get its violet overridden on hover.
      inactiveHoverClasses.forEach((c) => {
        feedbackTargetApp.classList.toggle(c, !onApp);
        feedbackTargetPlatform.classList.toggle(c, onApp);
      });
      // Move the caret under the selected option.
      feedbackCaretApp.classList.toggle('hidden', !onApp);
      feedbackCaretPlatform.classList.toggle('hidden', onApp);
      // #685: app state only travels with app-targeted feedback — the
      // shell has no provider of its own, so the row hides on Platform.
      stateRow.classList.toggle('hidden', !(stateAvailable && onApp));
    };
    // Enable or gray-out the "This app" option. When disabled it stays
    // visible (so users see both choices) but isn't clickable/selectable.
    const setAppTargetEnabled = (enabled) => {
      feedbackTargetApp.disabled = !enabled;
      feedbackTargetApp.setAttribute('aria-disabled', enabled ? 'false' : 'true');
      disabledTargetClasses.forEach((c) => feedbackTargetApp.classList.toggle(c, !enabled));
    };
    feedbackTargetApp.addEventListener('click', () => {
      if (!feedbackTargetApp.disabled) setFeedbackTarget('app');
    });
    feedbackTargetPlatform.addEventListener('click', () => setFeedbackTarget('platform'));

    // #556: live title generation. As the user types the description,
    // a debounced POST /api/feedback/title fills the editable Title
    // field. At submit, a user-typed title is always used; an
    // auto-filled one is used only while it still matches the submitted
    // description — a stale fill from a partial description is dropped
    // so the server re-names from the full text (#732).
    // Guards: once the user types in the Title field themselves
    // (titleDirty) auto-fill stops — clearing the field re-arms it;
    // responses landing after a newer request or a takeover are
    // discarded via the sequence counter; a per-open cap plus a minimum
    // description length bound the Haiku spend. All failure modes are
    // silent (null title / network error / 429): an empty field is a
    // fully working state — the server names the issue at submit.
    const TITLE_GEN_DEBOUNCE_MS = 900;
    const TITLE_GEN_MIN_DESC = 12;
    const TITLE_GEN_MAX_PER_OPEN = 8;
    const titleIdlePlaceholder = feedbackTitle.placeholder;
    let titleDirty = false;
    let lastGeneratedFor = '';
    let titleGenSeq = 0;
    let titleGenCount = 0;
    let titleGenTimer = null;

    // Reset on modal open / cancel / successful submit. Bumping the
    // sequence invalidates any in-flight response so it can never fill
    // the field of a later modal session.
    const resetTitleGenState = () => {
      titleDirty = false;
      lastGeneratedFor = '';
      titleGenSeq++;
      titleGenCount = 0;
      if (titleGenTimer) { clearTimeout(titleGenTimer); titleGenTimer = null; }
      feedbackTitle.placeholder = titleIdlePlaceholder;
    };

    const generateTitlePreview = async () => {
      const desc = feedbackText.value.trim();
      if (desc.length < TITLE_GEN_MIN_DESC) return;
      if (titleDirty) return;
      if (desc === lastGeneratedFor) return;
      if (titleGenCount >= TITLE_GEN_MAX_PER_OPEN) return;
      titleGenCount++;
      const seq = ++titleGenSeq;
      feedbackTitle.placeholder = 'Generating title…';
      try {
        const res = await fetch('/api/feedback/title', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ description: desc }),
        });
        const data = res.ok ? await res.json() : {};
        // Stale (a newer request or a reset happened) or the user took
        // the field over mid-flight — drop the result.
        if (seq !== titleGenSeq || titleDirty) return;
        if (data.title) {
          // Programmatic fill — must NOT set titleDirty (dirty is set
          // only from the Title input's own 'input' event below).
          feedbackTitle.value = data.title;
          // Success only: a transient failure retries on the next pause.
          lastGeneratedFor = desc;
        }
      } catch { /* silent — field stays as-is, retried on the next pause */ }
      finally {
        if (seq === titleGenSeq) feedbackTitle.placeholder = titleIdlePlaceholder;
      }
    };

    const scheduleTitlePreview = () => {
      if (titleGenTimer) clearTimeout(titleGenTimer);
      titleGenTimer = setTimeout(() => {
        titleGenTimer = null;
        generateTitlePreview();
      }, TITLE_GEN_DEBOUNCE_MS);
    };
    feedbackText.addEventListener('input', scheduleTitlePreview);
    // Leaving the description flushes the pending debounce immediately —
    // the "type body → title appears → submit" happy path.
    feedbackText.addEventListener('blur', () => {
      if (titleGenTimer) { clearTimeout(titleGenTimer); titleGenTimer = null; }
      generateTitlePreview();
    });
    feedbackTitle.addEventListener('input', () => {
      // Typing marks the field user-owned; clearing it completely
      // re-arms auto-fill for the next description change.
      titleDirty = feedbackTitle.value.trim().length > 0;
    });

    // ── #683: drag-to-select screenshot attachment ─────────────────
    // The button only renders where the Screen Capture API exists
    // (ScreenshotSelect.isSupported()); capture is real screen pixels
    // via public/js/screenshot-select.js. One screenshot per issue: the
    // button is swapped for the thumbnail row while one is attached.
    const screenshotBtn = document.getElementById('feedback-screenshot-btn');
    const screenshotPreview = document.getElementById('feedback-screenshot-preview');
    const screenshotImg = document.getElementById('feedback-screenshot-img');
    const screenshotState = document.getElementById('feedback-screenshot-state');
    const screenshotRemove = document.getElementById('feedback-screenshot-remove');
    const screenshotSupported = typeof ScreenshotSelect !== 'undefined' && ScreenshotSelect.isSupported();
    let screenshotId = null;          // server row id, set once uploaded
    let screenshotUploading = false;  // blocks submit while in flight
    let screenshotObjectUrl = null;

    const showFeedbackNotice = (text, isError) => {
      feedbackStatus.textContent = text;
      feedbackStatus.className = `text-sm mt-2 ${isError ? 'text-red-400' : 'text-zinc-400'}`;
      feedbackStatus.classList.remove('hidden');
    };

    const resetScreenshotState = () => {
      screenshotId = null;
      screenshotUploading = false;
      if (screenshotObjectUrl) { URL.revokeObjectURL(screenshotObjectUrl); screenshotObjectUrl = null; }
      screenshotPreview.classList.add('hidden');
      screenshotPreview.classList.remove('flex');
      screenshotImg.removeAttribute('src');
      screenshotState.textContent = '';
      screenshotBtn.classList.toggle('hidden', !screenshotSupported);
      screenshotBtn.disabled = false;
    };

    screenshotBtn.addEventListener('click', async () => {
      if (screenshotBtn.disabled) return;
      screenshotBtn.disabled = true;
      const modal = document.getElementById('feedback-modal');
      let modalHidden = false;
      try {
        // getDisplayMedia is called synchronously inside start() so the
        // click's transient activation is preserved; the modal hides only
        // once the browser grants the stream (a denied prompt costs the
        // user nothing).
        const { blob } = await ScreenshotSelect.start({
          onCaptureStart: () => { modal.classList.add('hidden'); modalHidden = true; },
        });
        if (modalHidden) modal.classList.remove('hidden');
        // Thumbnail immediately; upload in the background with Submit
        // blocked (screenshotUploading) until the id lands.
        screenshotObjectUrl = URL.createObjectURL(blob);
        screenshotImg.src = screenshotObjectUrl;
        screenshotBtn.classList.add('hidden');
        screenshotPreview.classList.remove('hidden');
        screenshotPreview.classList.add('flex');
        screenshotState.textContent = 'Uploading…';
        screenshotUploading = true;
        try {
          const res = await fetch('/api/feedback/screenshot', {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: blob,
          });
          const data = res.ok ? await res.json() : await res.json().catch(() => ({}));
          if (res.ok && data.id) {
            screenshotId = data.id;
            screenshotState.textContent = '';
          } else {
            resetScreenshotState();
            showFeedbackNotice(data.error || 'Screenshot upload failed', true);
          }
        } catch {
          resetScreenshotState();
          showFeedbackNotice('Screenshot upload failed — network error', true);
        } finally {
          screenshotUploading = false;
        }
      } catch (err) {
        if (modalHidden) modal.classList.remove('hidden');
        screenshotBtn.disabled = false;
        if (err && err.code === 'denied') {
          showFeedbackNotice('Screen capture was declined — nothing was attached.', false);
        } else if (err && err.code === 'register_failed') {
          showFeedbackNotice("Couldn't locate this page in the shared window — keep it fully visible and try again.", true);
        } else if (err && err.code !== 'cancelled') {
          showFeedbackNotice('Screenshot capture failed — please try again.', true);
        }
      }
    });

    screenshotRemove.addEventListener('click', () => {
      // Client-side forget only — the orphaned server row (if the upload
      // already finished) is GC'd by the 24h sweeper.
      resetScreenshotState();
    });

    const submitFeedback = async () => {
      const text = feedbackText.value.trim();
      if (!text) return;
      // Guard against double-submit while the request is in flight, and
      // also against submits after success (the textarea is disabled
      // then, but a stale cmd+enter on a focused button could still
      // land here).
      if (feedbackBtn.disabled) return;
      // #683: a screenshot upload is still in flight — the id isn't known
      // yet, so filing now would silently drop the attachment.
      if (screenshotUploading) {
        showFeedbackNotice('Screenshot is still uploading — one moment…', false);
        return;
      }
      // #732: freeze the title snapshot for this submit — cancel the
      // pending debounce and invalidate any in-flight preview (a Submit
      // click blurs the textarea, which flushes one) so a response
      // generated from a partial description can't rewrite the field
      // mid-submit. A failed submit re-arms normally: the next
      // description input reschedules the debounce.
      if (titleGenTimer) { clearTimeout(titleGenTimer); titleGenTimer = null; }
      titleGenSeq++;
      feedbackTitle.placeholder = titleIdlePlaceholder;
      feedbackBtn.disabled = true; feedbackBtn.textContent = 'Submitting...';
      try {
        // Capture the target + slug at submit time so navigating away
        // while the modal is open can't retarget an in-flight request.
        const target = feedbackTarget;
        const body = { description: text, target };
        // #556: optional user-chosen title — omitted entirely when blank
        // so the server auto-generates one as before. #732: an
        // auto-filled title is trusted only when it was generated from
        // exactly the description being submitted (lastGeneratedFor);
        // a stale fill from a partial description is dropped so the
        // server names the issue from the full text. A title the user
        // typed or edited (titleDirty) is always sent verbatim.
        const customTitle = feedbackTitle.value.trim();
        if (customTitle && (titleDirty || text === lastGeneratedFor)) body.title = customTitle;
        if (target === 'app') body.appSlug = App.currentApp;
        // #964: pledge a kudos bounty on the issue this submit files.
        // Captured at submit time alongside the target, and only when the
        // box is both ticked and enabled — a disabled (allowance-spent)
        // checkbox must never send the flag. The server files the issue
        // regardless of what happens to the bounty.
        const wantBounty = bountyCheckbox.checked && !bountyCheckbox.disabled
          && !bountyRow.classList.contains('hidden');
        if (wantBounty) body.bounty = true;
        // #683: attach the uploaded screenshot — the server appends the
        // embed line and links the row to the filed issue.
        if (screenshotId) body.screenshotId = screenshotId;
        // #685: collect the app's state snapshot at submit time (fresh
        // state, and the modal only overlays the still-running iframe).
        // Never blocks filing: a null (provider gone, error, 5 s
        // timeout) files without state with a non-blocking notice.
        let stateNotice = '';
        const wantState = stateAvailable && target === 'app'
          && !stateRow.classList.contains('hidden') && stateCheckbox.checked;
        if (wantState && typeof AppView !== 'undefined'
            && typeof AppView.collectIssueState === 'function') {
          const pageState = await AppView.collectIssueState();
          if (pageState) {
            body.pageState = pageState.json;
            if (pageState.truncated) body.pageStateTruncated = true;
          } else {
            stateNotice = " Couldn't collect app state — filed without it.";
            showFeedbackNotice("Couldn't collect app state — filing without it…", false);
          }
        }
        const res = await fetch('/api/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (res.ok) {
          // #964: report both outcomes on one line. A declined bounty
          // (allowance ran out between opening and submitting, repo isn't
          // an app the platform can attach one to) never reads as a
          // failure — the issue IS filed, and the bounty can still be added
          // later from the Dev screen's Topics row.
          let bountyNotice = '';
          if (data.bounty) {
            if (data.bounty.placed) {
              bountyNotice = ` — and pledged 1 kudos as a bounty. ${data.bounty.remaining} left this week.`;
              // The drawer's Kudos meter must show the number the user
              // just spent down to, not the one they saw before.
              window.Kudos?.Budget?.refresh?.();
            } else {
              bountyNotice = ` Couldn't add the bounty: ${data.bounty.error || 'the bounty could not be placed'}.`;
            }
          }
          const filedAgainst = (target === 'app'
            ? `Thanks! Filed against ${AppView?.appData?.name || 'this app'}`
            : 'Thanks! Filed against Social Vibecoding');
          // The success variant continues the sentence ("… — and pledged");
          // every other variant ends it before appending.
          feedbackStatus.textContent = (data.bounty?.placed
            ? filedAgainst + bountyNotice
            : `${filedAgainst}.${bountyNotice}`) + stateNotice;
          feedbackStatus.className = 'text-sm mt-2 text-emerald-400';
          feedbackStatus.classList.remove('hidden');
          feedbackText.value = '';
          feedbackTitle.value = '';
          // Discard any in-flight title preview so it can't repopulate
          // the cleared field during the "Thanks!" grace window.
          resetTitleGenState();
          // #683: the screenshot now belongs to the filed issue.
          resetScreenshotState();
          // Lock the textarea and keep the submit button disabled for
          // the 1500ms "Thanks!" grace window so a user can't keep
          // typing (or re-fire cmd+enter) after their feedback has
          // already been filed — fixes #32. Both controls are
          // re-enabled when the modal is reopened below.
          feedbackText.disabled = true;
          feedbackTitle.disabled = true;
          feedbackBtn.textContent = 'Submitted';
          // #125: make the new issue show up in this app's "Open Issues"
          // panel without a reload. The server seeds its issues cache and
          // broadcasts an issue_update (handled in connectEvents) for
          // other clients; this direct refresh covers the submitting tab
          // even if its events socket is momentarily down. Platform-
          // targeted feedback lands in the self-hosted platform app's
          // issue list, so refresh that panel too when it's the one open.
          if (typeof AppView !== 'undefined' && App.currentTab === 'dev'
              && ((target === 'app' && body.appSlug && App.currentApp === body.appSlug)
                || (target === 'platform' && AppView?.appData?.self_hosted))) {
            AppView.refreshDevData('issue');
          }
          setTimeout(() => document.getElementById('feedback-cancel').click(), 1500);
          return;
        }
        feedbackStatus.textContent = data.error || 'Failed to submit';
        feedbackStatus.className = 'text-sm mt-2 text-red-400';
        feedbackStatus.classList.remove('hidden');
      } catch {
        feedbackStatus.textContent = 'Network error';
        feedbackStatus.className = 'text-sm mt-2 text-red-400';
        feedbackStatus.classList.remove('hidden');
      }
      feedbackBtn.disabled = false; feedbackBtn.textContent = 'Submit';
    };

    // Open the Send Feedback modal. Shared by the header feedback button
    // (no opts) and the dev view's plus-menu "New issue" item, which
    // passes { fromDev: true } — see issue #226.
    App.openFeedbackModal = (opts = {}) => {
      document.getElementById('feedback-modal').classList.remove('hidden');
      // Reset any "Submitted" lock from a prior session so a returning
      // user can file another piece of feedback without reloading.
      feedbackText.disabled = false;
      feedbackTitle.disabled = false;
      feedbackBtn.disabled = false; feedbackBtn.textContent = 'Submit';
      feedbackStatus.classList.add('hidden');
      resetTitleGenState();
      // #683: each open starts screenshot-less; the attach button shows
      // only where the Screen Capture API exists.
      resetScreenshotState();

      // "This app" is only selectable when an app with a real repo is
      // open. Otherwise the button stays visible but grayed-out/disabled
      // so users can still see both choices, and we default to platform.
      const appData = (typeof AppView !== 'undefined' && AppView.appData) || null;
      const repoUrl = appData?.repo_url || '';
      const hasRepo = /github\.com\/[^/]+\/[^/]+/.test(repoUrl);
      // An app is "open" whenever its view is mounted — on the running
      // App tab OR the Dev screen. Both `currentApp` and `appData` are
      // cleared together by AppView.close() (on navigateHome /
      // navigateToLeaderboard), so they're never stale on the
      // home/leaderboard screens. This unifies the old fromDev-vs-header
      // split: the dev plus-menu's "New issue" item (currentTab==='dev')
      // and the top-bar Send feedback button now resolve identically, so
      // the header button targets the app whose dev screen is open
      // instead of falling back to "No app open" (#312).
      const appIsOpen = !!App.currentApp && !!appData
        && (App.currentTab === 'app' || App.currentTab === 'dev');
      // The self-hosted platform app is excluded: targeting "this app"
      // would file into the same platform repo via a different
      // credential path and skip the usernode label, so we force the
      // Platform target instead. (Self-hosted apps hide their App tab
      // and land on Dev, so this only ever fires on the dev screen.)
      const canTargetApp = appIsOpen && hasRepo && !appData.self_hosted;
      // #685: "Include app state" — only when the open app registered a
      // state provider AND its announcing frame is still the mounted
      // production iframe (false on the Dev screen, where the App-tab
      // iframe is torn down). Reset to checked on each open; the row's
      // visibility is applied by the setFeedbackTarget call below.
      stateAvailable = canTargetApp
        && typeof AppView !== 'undefined'
        && typeof AppView.issueStateAvailable === 'function'
        && AppView.issueStateAvailable();
      stateCheckbox.checked = true;
      // #964: the bounty row paints from the budget the badge already
      // holds, then a refresh lands the current figure a moment later — a
      // long-lived tab could otherwise show an hour-stale count. Both the
      // immediate paint and the post-refresh repaint reset the checkbox to
      // unchecked, which is the whole point of the row: a pledge is always
      // a deliberate tick, never a side effect of filing feedback.
      resetBountyRow();
      Promise.resolve(window.Kudos?.Budget?.refresh?.()).then(() => {
        // Only if the dialog is still open and untouched by the user.
        const modal = document.getElementById('feedback-modal');
        if (!modal.classList.contains('hidden') && !bountyCheckbox.checked) resetBountyRow();
      }).catch(() => { /* budget unavailable — row stays as painted */ });
      if (canTargetApp) {
        feedbackTargetApp.textContent = appData?.name ? `This app (${appData.name})` : 'This app';
        setAppTargetEnabled(true);
        // Default to the app the user is looking at — most likely intent.
        setFeedbackTarget('app');
      } else {
        // With an app actually open (no repo yet, or self-hosted) keep
        // its name on the grayed label — "No app open" would be wrong
        // there. Only show "No app open" when no app is really open.
        feedbackTargetApp.textContent = appData
          ? (appData.name ? `This app (${appData.name})` : 'This app')
          : 'No app open';
        setAppTargetEnabled(false);
        setFeedbackTarget('platform');
      }

      feedbackText.focus();
    };
    document.getElementById('feedback-btn').addEventListener('click', () => App.openFeedbackModal());
    // Admin/moderation console (#588) is a drawer row now, not a header
    // button — its click handler is wired in HeaderMenu.init() (close the
    // drawer; the anchor's #admin href does the navigating). The row is
    // hidden for non-admins (see renderAdminButton) and
    // navigateToAdminConsole re-checks the flag, so a stray programmatic
    // hash change can't open it either.
    document.getElementById('feedback-cancel').addEventListener('click', () => {
      document.getElementById('feedback-modal').classList.add('hidden');
      feedbackText.value = '';
      feedbackTitle.value = '';
      feedbackText.disabled = false;
      feedbackTitle.disabled = false;
      feedbackBtn.disabled = false; feedbackBtn.textContent = 'Submit';
      feedbackStatus.classList.add('hidden');
      resetTitleGenState();
      // #683: cancelling discards the attachment client-side; an already
      // uploaded (now orphaned) row is GC'd server-side after 24h.
      resetScreenshotState();
      // #964: drop any pledge intent with the rest of the draft.
      bountyCheckbox.checked = false;
    });
    document.getElementById('feedback-modal').addEventListener('click', (e) => {
      if (e.target === e.currentTarget || e.target.dataset.modalBackdrop !== undefined) document.getElementById('feedback-cancel').click();
    });
    feedbackBtn.addEventListener('click', submitFeedback);
    // cmd+enter / ctrl+enter inside the textarea submits — fixes #34.
    // Textareas swallow Enter by default (it inserts a newline), so we
    // only intercept when the modifier key is held.
    feedbackText.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submitFeedback();
      }
    });
    // #556: same shortcut in the optional title input. Plain Enter is
    // NOT intercepted — the natural next step from the title is writing
    // the description, and there's no <form> for Enter to submit.
    feedbackTitle.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submitFeedback();
      }
    });

    // Share modal — opened from the drawer's Share row (wired in
    // HeaderMenu.init). The row's hidden state is managed in openApp /
    // navigateHome (and in handleAppStatus for the creating→running
    // flip), so we only wire the dismiss handlers here.
    const shareClose = document.getElementById('share-close');
    if (shareClose) shareClose.addEventListener('click', () => AppView.closeShareModal());
    const shareModal = document.getElementById('share-modal');
    if (shareModal) shareModal.addEventListener('click', (e) => {
      // Ignore the trailing ghost click from the opening tap (see
      // AppView.revealModal) so it can't close the modal instantly.
      if (window.AppView && AppView.modalDismissGuarded && AppView.modalDismissGuarded(shareModal)) return;
      if (e.target === e.currentTarget || e.target.dataset.modalBackdrop !== undefined) AppView.closeShareModal();
    });
    const shareCopy = document.getElementById('share-copy-btn');
    if (shareCopy) shareCopy.addEventListener('click', () => AppView.copyShareUrl());

    // Header App/Dev switch (#app-mode-switch), successor to the bottom
    // tab bar. Tapping the ALREADY-ACTIVE App segment is a no-op: the
    // switch now sits inches from the icons people tap constantly, and
    // switchTab('app') re-runs renderAppTab(), which replaces
    // #app-content's innerHTML and therefore RELOADS the embedded app —
    // losing whatever the user had on screen inside it. The Dev segment
    // deliberately has no such guard: re-tapping it backs out of a
    // session / chat / topic sub-view to the card list, which is the
    // conventional "tap the active tab to go to its root" behaviour the
    // bottom bar already had.
    //
    // #1036: these segments stay <button role="radio"> — an anchor
    // cannot carry that ARIA role inside a role="radiogroup" — so the
    // new-tab gesture is intercepted by hand (NavLink mechanism B)
    // rather than delegated to an href. The "re-tapping the active App
    // segment is a no-op" guard above applies to the PLAIN click only:
    // a cmd-click on the active segment isn't re-mounting this tab's
    // iframe, so it should still open the app view in a new one.
    document.querySelectorAll('.app-mode-seg').forEach((btn) => {
      const hrefFor = () => (App.currentApp
        ? `#app/${App.currentApp}/${btn.dataset.tab === 'dev' ? 'dev' : 'app'}`
        : null);
      const activate = () => {
        if (btn.dataset.tab === 'app' && App.currentTab === 'app') return;
        App.switchTab(btn.dataset.tab);
      };
      if (window.NavLink) NavLink.wireModified(btn, hrefFor, activate);
      else btn.addEventListener('click', activate);
    });

    // popstate fires on browser/device back when the new history
    // entry was created with pushState; hashchange fires when only the
    // fragment changes (initial load with a deep link, manual edits to
    // the URL bar). Both routes converge on restoreFromHash, which is
    // idempotent — re-applying the same hash is a no-op via the
    // currentApp/currentTab guards inside it.
    window.addEventListener('popstate', () => App.restoreFromHash());
    window.addEventListener('hashchange', () => App.restoreFromHash());
  },

  restoreFromHash() {
    App._isRestoring = true;
    try {
      const rawHash = location.hash.replace('#', '');
      // Fragment-query (#743): a chromeless deep link carries the app's
      // inner path after a `?` INSIDE the fragment
      // (#app/<slug>/full?path=/t/123). Split it off before the segment
      // split so every existing route parses byte-for-byte as before.
      const qIdx = rawHash.indexOf('?');
      let hash = qIdx === -1 ? rawHash : rawHash.slice(0, qIdx);
      const fragQuery = qIdx === -1 ? '' : rawHash.slice(qIdx + 1);

      // ── Anonymous-shell routing (fold-auth-pages-into-SPA) ─────────
      // #landing / #login / #signup / #register[/<code>] / #waiting are
      // in-SPA screens (auth-screens.js). Which set of routes is live
      // depends on the boot stage:
      //   - no session: auth routes render; every other hash is a deep
      //     link — remembered for after login, which is offered first
      //     (parity with the old server redirect: '/' → landing.html,
      //     deeper paths → login.html).
      //   - gated session (waiting room): only #waiting and #landing
      //     (public-app browsing) render; everything else returns to
      //     the waiting room. The server's API 403 remains the actual
      //     security boundary.
      //   - full session: auth hashes are stale (bookmark / back
      //     button) — strip them and land on home.
      if (window.AuthScreens) {
        const authRoute = AuthScreens.routeFromHash(hash);
        const authSeg = hash.split('/')[1] || null;
        if (!App.user) {
          if (authRoute && authRoute !== 'waiting') {
            AuthScreens.show(authRoute, authSeg);
            return;
          }
          if (!hash || authRoute === 'waiting') {
            AuthScreens.show('landing');
            return;
          }
          AuthScreens.rememberDeepLink(location.hash);
          AuthScreens.show('login');
          return;
        }
        if (App.user.hasPlatformAccess === false) {
          if (authRoute === 'landing') {
            AuthScreens.show('landing');
            return;
          }
          // #waitlist stays reachable from the waiting room (a bookmark,
          // the back button) — the screen shows them the "already on the
          // list" note instead of the join form, which beats bouncing them.
          if (authRoute === 'waitlist') {
            AuthScreens.show('waitlist');
            return;
          }
          // The stage-2 waitlist survey stays reachable from the waiting
          // room — a gated account is exactly who "Want in sooner?" is
          // for (the link arrives in the join email).
          if (authRoute === 'more') {
            AuthScreens.show('more', authSeg);
            return;
          }
          if (!authRoute && hash) AuthScreens.rememberDeepLink(location.hash);
          AuthScreens.showWaiting();
          return;
        }
        if (authRoute) {
          AuthScreens.hideAll();
          history.replaceState(null, '', '/');
          hash = '';
        }
      }

      if (!hash) {
        App.setChromeless(false);
        if (App.currentApp) App.navigateHome();
        else if (App._inLeaderboard) App.navigateHome();
        else if (App._inProfile) App.navigateHome();
        else if (App._inAdmin) App.navigateHome();
        else if (App._inSettings) App.navigateHome();
        else if (App._inBrowse) App.navigateHome();
        else {
          // Already on home (no app, no leaderboard). Don't call
          // navigateHome() — that would pushState, AppView.close(),
          // etc., none of which are appropriate when we're already
          // here. But we still want to ensure the page title is
          // correct, since this branch is reached on initial page
          // load and on any popstate/hashchange that resolves to "/".
          // Without this the title can be stuck on a previous app's
          // name if document.title was set elsewhere (e.g. a stale
          // value persisted across a Flutter WebView session).
          App.setHeaderTitle('dApps');
          Home.load();
        }
        return;
      }

      const parts = hash.split('/');
      if (parts[0] === 'create') {
        // #create — deep link that opens the create-app modal over the
        // home feed. Doubles as the addressable route the dapp.json
        // regression test for the mode toggle uses (#748).
        App.setChromeless(false);
        if (App.currentApp || App._inLeaderboard) {
          App.navigateHome();
        } else {
          App.setHeaderTitle('dApps');
          Home.load();
        }
        App.showCreateModal();
        return;
      }
      if (parts[0] === 'leaderboard') {
        App.setChromeless(false);
        // Optional sub-view segment (#leaderboard/history etc.) — pass
        // it through so deep links land on the right tab. Bare
        // #leaderboard keeps whatever tab was last active (the Topochain
        // standings — the primary tab — on first visit). A third segment
        // on the users tab (#leaderboard/users/<username>) deep-links a
        // user profile (#60). #leaderboard/kudos, #leaderboard/topochain
        // and #leaderboard/challenges select a SECTION rather than a
        // Kudos sub-tab; the first two then self-heal their hash
        // (#leaderboard/topochain -> #leaderboard, #leaderboard/kudos ->
        // #leaderboard/prs) through Leaderboard._syncHash.
        const profileUser = parts[1] === 'users' && parts[2]
          ? decodeURIComponent(parts[2])
          : null;
        // #leaderboard/challenges/<eventId>[/<challengeId>] (#982) — the
        // address the profile's completed-challenge rows link to. The
        // event id is part of the path because a challenge id alone is
        // meaningless: the challenge list is fetched per season event, so
        // without it the router would have to guess which event to load.
        // Non-numeric segments resolve to null and the whole target is
        // dropped, leaving a plain #leaderboard/challenges navigation.
        const challengeTarget = parts[1] === 'challenges' && parts[2]
          ? {
            eventId: App._numericSegment(parts[2]),
            challengeId: App._numericSegment(parts[3]),
          }
          : null;
        App.navigateToLeaderboard(parts[1], profileUser, challengeTarget);
        return;
      }
      if (parts[0] === 'challenges') {
        // Legacy address of the retired #challenges screen. Challenges are
        // the Leaderboard screen's third tab now, so this is an ALIAS:
        // rewrite the address in place so a bookmark self-heals to the
        // canonical form, then hand off. The replaceState fires BEFORE the
        // navigate so Leaderboard._syncHash sees a #leaderboard hash and
        // doesn't skip its own sync.
        App.setChromeless(false);
        try {
          history.replaceState(null, '', '#leaderboard/challenges');
        } catch (err) { /* non-fatal: navigation below still works */ }
        App.navigateToLeaderboard('challenges', null);
        return;
      }
      if (parts[0] === 'profile') {
        App.setChromeless(false);
        App.navigateToProfile();
        return;
      }
      if (parts[0] === 'apps') {
        // Browse-all-apps screen (home-screen split). No gate: the list
        // is the visibility-filtered /api/apps payload, and the
        // anonymous-shell branch above already handled a signed-out
        // visitor. An optional second segment (#apps/<slug>) deep-links
        // that app's detail page — the screen's level 2.
        App.setChromeless(false);
        App.navigateToBrowse(parts[1] ? decodeURIComponent(parts[1]) : null);
        return;
      }
      if (parts[0] === 'admin') {
        // Admin & moderation console (#818). Optional section segment
        // (#admin/users etc.) deep-links a menu section; the gate on
        // App.user.isAdmin lives inside navigateToAdminConsole.
        App.setChromeless(false);
        let _adminSection = parts[1] || null;
        // Permanent alias for the renamed Topochain section. The sub-tab
        // (a third segment, owned by AdminTopochain) has to survive the
        // rewrite, otherwise a deep bookmark like #admin/topochain/users
        // would silently land on the section's default tab. Same idiom as
        // the #topochain branch below: rewrite the address BEFORE
        // navigating so the module's own _syncHash sees the canonical
        // prefix, and the bookmark self-heals.
        if (_adminSection === 'topochain') {
          _adminSection = 'seasons';
          try {
            history.replaceState(null, '',
              parts[2] ? `#admin/seasons/${parts[2]}` : '#admin/seasons');
          } catch (err) { /* non-fatal: navigation below still works */ }
        }
        App.navigateToAdminConsole(_adminSection);
        return;
      }
      if (parts[0] === 'settings') {
        // Settings screen (settings-modal-to-screen conversion). Optional
        // section segment (#settings/password etc.) deep-links one section;
        // no extra gate — the anonymous-shell branch above already bounced
        // a signed-out visitor to login and remembered the deep link.
        App.setChromeless(false);
        App.navigateToSettings(parts[1] || null);
        return;
      }
      if (parts[0] === 'topochain') {
        // Topochain public screens (Task 14): #topochain/leaderboard and
        // #topochain/seasons. Both are public reads under /api/v4 — no
        // auth gate, unlike #admin above.
        //
        // Both are now TABS of the Leaderboard screen, so both are
        // ALIASES: rewrite the address in place so a bookmark self-heals
        // to the canonical form, then hand off. 'seasons' -> the
        // challenges tab (its challenge grid; its event hero became that
        // screen's shared event bar); anything else, including a bare
        // #topochain, -> the standings tab, whose canonical address is the
        // BARE #leaderboard now that it is the primary tab (so this is one
        // replaceState, not one here and a second from _syncHash). The
        // replaceState fires BEFORE the navigate so Leaderboard._syncHash
        // sees a #leaderboard hash and doesn't skip its own sync.
        App.setChromeless(false);
        const _tcSection = parts[1] === 'seasons' ? 'challenges' : 'topochain';
        try {
          history.replaceState(null, '',
            _tcSection === 'challenges' ? '#leaderboard/challenges' : '#leaderboard');
        } catch (err) { /* non-fatal: navigation below still works */ }
        App.navigateToLeaderboard(_tcSection, null);
        return;
      }
      if (parts[0] === 'app' && parts[1]) {
        const slug = parts[1];
        // Card-list hashes (#194 revision): app/{slug}/app,
        // app/{slug}/dev (the card list), app/{slug}/dev/chat (general
        // chat), app/{slug}/dev/issues/{n} / dev/proposals/{id} /
        // dev/governance/{id} (full-screen topic views), and
        // app/{slug}/dev/sessions/{id} (session view). The retired
        // dev/settings form (#645) falls through to the card list.
        // Legacy hashes — group-chat, individual-chat[/{sessionId}], and
        // the old dev/chat|issues|proposals sub-tab forms — all map onto
        // the forum so old links and notification hrefs keep working.
        let tab = parts[2] || 'app';
        let subTab = null;
        let ref = null;
        // Chromeless full-screen App view (#app/<slug>/full). Old cached
        // clients that predate this route fall into the final `else`
        // below and get the regular App tab — a graceful degrade.
        const chromeless = tab === 'full';
        if (chromeless) tab = 'app';
        // Inner-path pass-through (#743): `path` is defined as the FINAL
        // fragment-query param — its value is everything after the first
        // `path=`, verbatim in wire encoding (an inner query may carry
        // `&` / `=` / `?`, and the Caddy rescue redirect can't
        // percent-encode placeholders, so no URLSearchParams here).
        // Honored only on the chromeless route; every other route
        // ignores the fragment-query entirely.
        let innerPath = null;
        if (chromeless && fragQuery) {
          const pm = fragQuery.match(/(?:^|&)path=(.*)$/);
          if (pm) innerPath = App._validateInnerPath(pm[1]);
        }
        if (tab === 'dev') {
          const sec = parts[3] || null;
          if (sec === 'sessions' && parts[4]) {
            subTab = 'sessions';
            ref = parseInt(parts[4]) || null;
          } else if (sec === 'chat') {
            // Full-screen general chat (also where legacy group-chat
            // links land — the old Chat sub-tab's original meaning).
            subTab = 'chat';
          } else if (sec === 'issues' && parts[4]) {
            subTab = 'topic';
            ref = { kind: 'issue', id: parseInt(parts[4]) || null };
          } else if (sec === 'proposals' && parts[4]) {
            subTab = 'topic';
            ref = { kind: 'proposal', id: parseInt(parts[4]) || null };
          } else if (sec === 'governance' && parts[4]) {
            subTab = 'topic';
            ref = { kind: 'gov', id: parseInt(parts[4]) || null };
          } else if (sec === 'shared' && parts[4]) {
            // A shared dev session's public discussion page (distinct
            // from dev/sessions/{id}, which is the OWNER's dev chat).
            subTab = 'topic';
            ref = { kind: 'session', id: parseInt(parts[4]) || null };
          } else {
            // dev, dev/issues, dev/proposals, dev/sessions (no id) —
            // all land on the plain card list.
            subTab = 'forum';
          }
        } else if (tab === 'group-chat') {
          tab = 'dev'; subTab = 'chat';
        } else if (tab === 'individual-chat') {
          tab = 'dev';
          subTab = parts[3] ? 'sessions' : 'forum';
          ref = parts[3] ? parseInt(parts[3]) : null;
        } else {
          tab = 'app';
        }
        if (App._inLeaderboard) App._exitLeaderboard();
        if (App._inProfile) App._exitProfile();
        if (App._inAdmin) App._exitAdminConsole();
        if (App._inSettings) App._exitSettings();
        App.setChromeless(chromeless);
        // Stash the validated inner path where renderAppTab / the token
        // refresh read it. Set on EVERY pass (null when absent) so
        // leaving chromeless — e.g. via the pill — clears it without a
        // re-render of the already-mounted iframe.
        const prevInnerPath = typeof AppView !== 'undefined'
          ? (AppView.pendingInnerPath || null) : null;
        if (typeof AppView !== 'undefined') AppView.pendingInnerPath = innerPath;
        if (App.currentApp !== slug) {
          App.navigateToApp(slug, tab, ref, subTab);
          // navigateToApp's synchronous prefix runs AppView.close() when
          // jumping app-to-app, which clears pendingInnerPath — re-stash
          // after the call (renderAppTab only runs once the awaited
          // open() inside it resolves, so this always lands in time).
          if (typeof AppView !== 'undefined') AppView.pendingInnerPath = innerPath;
        } else if (App.currentTab !== tab
            || (tab === 'dev' && App.currentSubTab !== subTab)
            // Same tab + sub-tab but a (possibly different) deep-link
            // target — re-dispatch so the accordion / session moves.
            // switchTab is idempotent, so a same-target re-render is fine.
            || (tab === 'dev' && ref != null)
            // A chromeless hash carrying a DIFFERENT inner path than the
            // one already applied — re-render so the iframe moves (#743).
            || (chromeless && innerPath !== prevInnerPath)) {
          App.switchTab(tab, ref, subTab);
        }
      } else {
        // Unrecognised hash: fall back to the home feed. The screen swap
        // is explicit here because the _exitX helpers are state-only
        // (#979) — without it the screen we were on would stay painted
        // under a "dApps" title.
        App.setChromeless(false);
        if (App._inLeaderboard) App._exitLeaderboard();
        if (App._inProfile) App._exitProfile();
        if (App._inAdmin) App._exitAdminConsole();
        if (App._inSettings) App._exitSettings();
        if (App._inBrowse) App._exitBrowse();
        App._showOnlyScreen('home-screen');
        document.getElementById('back-btn').classList.add('hidden');
        App.setHeaderTitle('dApps');
        Home.load();
      }
    } finally {
      App._isRestoring = false;
    }
  },

  // Client-side mirror of testing-notes.validatePath (see
  // src/services/testing-notes.js) for the chromeless inner path (#743):
  // relative-only (leading `/`, never `//` — protocol-relative), no
  // whitespace/control chars, and none of \ ` ' " < > — the src is
  // interpolated into an innerHTML template in renderAppTab, so the
  // blacklist is attribute-breakout defense on top of the URL-API origin
  // check in AppView.buildAppIframeSrc. Invalid → null (app root, never
  // an error).
  _validateInnerPath(p) {
    if (typeof p !== 'string') return null;
    const path = p.trim();
    if (!path || path.length > 512) return null;
    if (!path.startsWith('/') || path.startsWith('//')) return null;
    if (/[\s\\`'"<>]/.test(path)) return null;
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(path)) return null;
    return path;
  },

  // ── Chromeless full-screen mode ──────────────────────────────────────
  // Hide/show the shared header and mount/unmount the floating "Open in
  // Usernode" pill. Idempotent; only ever driven by restoreFromHash (the
  // mode is hash-addressed, so history back/forward keeps working) plus a
  // defensive clear in navigateHome.
  //
  // The App/Dev switch needs no line of its own any more — it lives
  // INSIDE #platform-header (it used to be the separate #app-tabs bar at
  // the foot of #app-view), so hiding the header hides it too.
  //
  // The bottom safe-area inset needs NO special case here any more
  // (#970). It used to: #app-view carried `un-safe-bottom` for every
  // surface, so chromeless had to strip the class to render truly
  // edge-to-edge. The inset is now surface-dependent
  // (`data-app-surface`, set by AppView._setSurface) and chromeless
  // always lands on the app surface — which reserves nothing and
  // forwards the insets into the app instead. The floating pill still
  // insets itself via env(safe-area-inset-bottom).
  //
  // Hiding the header changes #app-view's rect, so re-broadcast the
  // per-frame insets: the app's top inset is 0 while the header covers
  // it and becomes the real status-bar inset once it doesn't.
  setChromeless(on) {
    const enable = !!on;
    if (App.chromeless === enable) return;
    App.chromeless = enable;
    const header = document.getElementById('platform-header');
    if (header) header.classList.toggle('hidden', enable);
    if (enable) App._mountChromelessPill();
    else App._unmountChromelessPill();
    if (typeof AppView !== 'undefined' && AppView.scheduleSafeAreaBroadcast) {
      AppView.scheduleSafeAreaBroadcast();
    }
  },

  // Floating pill, visually matching the bridge's share-view pill
  // (public/usernode-bridge.js __USERNODE_PLATFORM_LINK__) so users see
  // one consistent affordance. Unlike the bridge pill it is NOT
  // dismissible — in chromeless mode it's the only way into the full
  // platform view. The slug is read at click time so the pill survives
  // app-to-app hash navigation without a remount.
  _mountChromelessPill() {
    if (document.getElementById('chromeless-pill')) return;
    const link = document.createElement('a');
    link.id = 'chromeless-pill';
    link.href = '#';
    link.setAttribute('aria-label', 'Open this app on Usernode');
    link.style.cssText = 'position:fixed;'
      + 'right:calc(12px + env(safe-area-inset-right,0px));'
      + 'bottom:calc(12px + env(safe-area-inset-bottom,0px));'
      + 'z-index:40;display:flex;align-items:center;gap:4px;'
      + 'background:rgba(15,20,32,0.82);color:#e7edf7;border-radius:999px;'
      + 'padding:6px 12px;font:12px/1.2 -apple-system,system-ui,sans-serif;'
      + 'text-decoration:none;box-shadow:0 2px 10px rgba(0,0,0,0.3);opacity:0.85';
    link.addEventListener('mouseenter', () => { link.style.opacity = '1'; });
    link.addEventListener('mouseleave', () => { link.style.opacity = '0.85'; });
    const label = document.createElement('span');
    label.textContent = 'Open in Usernode';
    const glyph = document.createElement('span');
    glyph.textContent = '\u2197'; // ↗ (escaped like the bridge pill's)
    glyph.style.cssText = 'font-size:11px;opacity:0.75';
    glyph.setAttribute('aria-hidden', 'true');
    link.appendChild(label);
    link.appendChild(glyph);
    link.addEventListener('click', (ev) => {
      ev.preventDefault();
      if (App.currentApp) {
        // hashchange → restoreFromHash clears the mode; the already-
        // loaded iframe stays mounted (same app, same tab).
        location.hash = `#app/${App.currentApp}/app`;
      }
    });
    document.body.appendChild(link);
  },

  _unmountChromelessPill() {
    const link = document.getElementById('chromeless-pill');
    if (link && link.parentNode) link.parentNode.removeChild(link);
  },

  // The single decision point for "what animation does entering this
  // screen get?" (#977). Every navigate* method passes the type it WANTS
  // and takes back the type it gets.
  //
  // One rule: a screen swap that begins while the slide-out drawer is on
  // screen — or that a link inside the drawer just started — runs with no
  // animation at all. The drawer's own exit spring is already a motion in
  // flight, and the kit's push/pop is a View Transition over the whole
  // document root: it snapshots the open drawer and parallaxes that
  // snapshot away while the live panel springs the other way, which is
  // the two-competing-motions bug. Cutting the screen swap leaves exactly
  // one motion — the drawer leaving, revealing the destination behind it.
  // (It also matches the kit's own guidance that panels and other
  // high-frequency UI must use type:'none'.)
  //
  // The resolved type is stamped on the screen element as `data-entered`,
  // mirroring the kit's own data-un-vt. Nothing reads it at runtime — it
  // exists so the dapp.json checks can assert an ordering that is
  // otherwise only observable mid-animation.
  _entryTransition(preferred, screenEl) {
    const menu = App.HeaderMenu;
    // consumeNavPending() FIRST and unconditionally — it is one-shot, so
    // letting isPresenting() short-circuit it would leave the flag armed
    // for whatever navigation came next.
    const fromDrawer = !!menu && menu.consumeNavPending();
    const suppress = fromDrawer || (!!menu && menu.isPresenting());
    const type = suppress ? 'none' : preferred;
    if (screenEl && screenEl.setAttribute) screenEl.setAttribute('data-entered', type);
    return type;
  },

  // ── Screen swap — THE ORDERING RULE (issue #979) ────────────────────
  // The mutually exclusive full-screen roots. Exactly one of these is
  // visible at a time (they are `flex-1` siblings in the body column, so
  // two visible roots split the viewport 50/50 — see the #764 note on
  // the zoom transition).
  SCREEN_IDS: ['app-view', 'home-screen', 'browse-screen',
    'leaderboard-screen', 'profile-screen', 'admin-screen',
    'settings-screen'],

  // Reveal `revealId`, hide every other screen root (except any id in
  // `keepAlso`), and hand the header's back chevron back to its default
  // "home" meaning — the incoming module's own chrome sync flips it to
  // 'arrow' afterwards when it owns a level-2 view.
  //
  // *** CALL THIS INSIDE THE PlatformUI.transition CALLBACK, NEVER
  // BEFORE IT. *** A View Transition captures the OUTGOING page at the
  // next rendering opportunity, not at the startViewTransition() call —
  // so every DOM mutation made synchronously after that call, but before
  // the callback runs, is baked into the "previous page" snapshot the
  // animation slides out. That is exactly how the settings animation
  // ended up showing the INCOMING page behind itself (#979): the sibling
  // screens were hidden and the header retitled before the snapshot
  // existed. Same rule for the header title, the back button, and the
  // drawer's app-scoped rows: they are part of the swap, so they belong
  // in the same callback. The kit already documents the analogue for its
  // zoom types ("fn reveals the incoming screen, after conceals the
  // outgoing one" — usernode-native/v1/native.js).
  _showOnlyScreen(revealId, keepAlso) {
    const keep = keepAlso || [];
    for (const id of App.SCREEN_IDS) {
      if (id === revealId || keep.includes(id)) continue;
      const el = document.getElementById(id);
      if (el) el.classList.add('hidden');
    }
    const target = document.getElementById(revealId);
    if (target) target.classList.remove('hidden');
    App.setBackIcon('home');
  },

  // The chrome every platform screen (leaderboard / profile / browse /
  // admin / settings) enters with: the header's back button visible, the
  // drawer's app-scoped rows hidden, the drawer's build/fork footer
  // closed. The per-screen title is set by the caller right after this,
  // so `setHeaderTitle('<Screen>')` stays greppable at each call site.
  // Same ordering rule as _showOnlyScreen: inside the transition
  // callback only.
  _enterScreenChrome() {
    document.getElementById('back-btn').classList.remove('hidden');
    const drg = document.getElementById('drawer-row-github');
    const drs = document.getElementById('drawer-row-share');
    if (drg) drg.classList.add('hidden');
    if (drs) drs.classList.add('hidden');
    App.DrawerStatus.setAppOpen(false);
  },

  // Show the Leaderboard screen. Sibling to navigateToApp/navigateHome —
  // hides home + app, reveals the dedicated #leaderboard-screen, lets
  // the Leaderboard module render the tab strip and hand the standings /
  // challenges panes to TopochainLeaderboard / TopochainChallenges (it
  // renders the Kudos pane into #leaderboard-root itself).
  //
  // `sub` is the hash's second segment: 'prs' | 'users' | 'history'
  // select a Kudos sub-tab, and the SECTION values 'topochain' (the
  // primary standings tab), 'kudos' and 'challenges' select a whole
  // section instead. `profileUser` (#60) opens the per-user PR profile
  // drill-in instead of a plain tab.
  // A hash segment that must be a positive integer id, or nothing. Returns
  // null for anything else (empty, '12abc', '-1', a username) so a
  // hand-typed or truncated address degrades to the plain screen rather
  // than sending NaN into a fetch URL.
  _numericSegment(raw) {
    if (!raw) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  },

  navigateToLeaderboard(sub, profileUser, challengeTarget) {
    // Already mounted: an in-screen change (a tab, the deep-linked
    // section, a user drill-in), not a screen entry — hand it to the
    // module instead of replaying the whole swap. Same idiom as
    // navigateToBrowse / navigateToAdminConsole / navigateToSettings,
    // and load-bearing for the entry animation (#979): a fragment
    // navigation fires BOTH popstate and hashchange, so restoreFromHash
    // runs twice in one tick, and without this guard the second run's
    // mutation lands while the first run's View Transition is still
    // pending — the kit applies it instantly, i.e. BEFORE the outgoing
    // page is captured, which is exactly how the incoming screen ended
    // up painted behind its own entry animation.
    if (App._inLeaderboard && window.Leaderboard?.isOpen?.()) {
      App._routeLeaderboard(sub, profileUser, challengeTarget);
      if (window.Leaderboard?.open) Leaderboard.open();
      return;
    }
    // Same iframe caveat as navigateHome: no animated snapshot over a
    // live App-tab iframe.
    const fromIframe = !!(App.currentApp && App.currentTab === 'app');
    // The app teardown is a VISIBLE mutation (it blanks the drawer's
    // build/fork slots and resets the dev-chat panes), so it rides in the
    // transition callback below; only the flag flips synchronously, since
    // navigateToApp's async tail reads it as "what is on screen now".
    const leavingApp = !!App.currentApp;
    App.currentApp = null;
    if (App._inProfile) App._exitProfile();
    if (App._inAdmin) App._exitAdminConsole();
    if (App._inSettings) App._exitSettings();
    if (App._inBrowse) App._exitBrowse();
    // Screen reveal + chrome, all inside the transition callback so the
    // outgoing page is snapshotted as it actually looked (#979).
    const screen = document.getElementById('leaderboard-screen');
    PlatformUI.transition(() => {
      if (leavingApp) AppView.close();
      App._showOnlyScreen('leaderboard-screen');
      App._enterScreenChrome();
      App.setHeaderTitle('Leaderboard');
    }, { type: App._entryTransition(fromIframe ? 'none' : 'push', screen) });
    App._inLeaderboard = true;
    App._routeLeaderboard(sub, profileUser, challengeTarget);
    if (window.Leaderboard?.open) Leaderboard.open();
  },

  // Apply the deep-linked section / sub-view / user profile before open()
  // renders — _setSection and _setSub both validate their value and no-op
  // on garbage. openProfile must run INSTEAD of _setSub (not after):
  // _setSub clears profile state and would replaceState the profile hash
  // away. When the screen is already open they re-render in place; the
  // open() each caller runs afterwards dedupes the in-flight load.
  _routeLeaderboard(sub, profileUser, challengeTarget) {
    if (profileUser && window.Leaderboard?.openProfile) {
      Leaderboard.openProfile(profileUser);
    } else if ((sub === 'topochain' || sub === 'kudos' || sub === 'challenges')
               && window.Leaderboard?._setSection) {
      // Register the challenge deep link BEFORE the section mounts (#982).
      // Selecting the event first means the pane's very first fetch is
      // already for the right event — ordering it after _setSection would
      // load the default event, then throw that list away and reload.
      if (sub === 'challenges' && challengeTarget
          && window.TopochainChallenges?.openFromHash) {
        TopochainChallenges.openFromHash(
          challengeTarget.eventId, challengeTarget.challengeId
        );
      }
      Leaderboard._setSection(sub);
    } else if (sub && window.Leaderboard?._setSub) {
      Leaderboard._setSub(sub);
    }
  },

  // State-only teardown (#979): hiding #leaderboard-screen is the job of
  // the incoming navigation's _showOnlyScreen call, INSIDE its transition
  // callback — hiding it here would delete the outgoing page before the
  // View Transition has captured it.
  _exitLeaderboard() {
    App._inLeaderboard = false;
    if (window.Leaderboard?.close) Leaderboard.close();
  },

  // navigateToChallenges / _exitChallenges used to live here (the
  // app-as-SV-chrome migration's #challenges screen). Challenges are a TAB
  // of the Leaderboard screen now, so they have no navigate/exit pair of
  // their own: #challenges aliases onto
  // navigateToLeaderboard('challenges') in restoreFromHash, and
  // _exitLeaderboard tears down all three panes.

  // Show the profile screen (profile-and-settings-to-web migration).
  // Sibling to navigateToLeaderboard — hides home + app, reveals the
  // dedicated #profile-screen, lets the Profile module render itself
  // into #profile-root.
  navigateToProfile() {
    // Already mounted: nothing to swap, just re-render in place. Same
    // reason as navigateToLeaderboard's guard above — popstate AND
    // hashchange both reach restoreFromHash, and a second entry run would
    // apply its mutation before the first run's View Transition captured
    // the outgoing page (#979).
    if (App._inProfile && window.Profile?.isOpen?.()) {
      if (window.Profile?.open) Profile.open();
      return;
    }
    const fromIframe = !!(App.currentApp && App.currentTab === 'app');
    const leavingApp = !!App.currentApp;
    App.currentApp = null;
    if (App._inLeaderboard) App._exitLeaderboard();
    if (App._inAdmin) App._exitAdminConsole();
    if (App._inSettings) App._exitSettings();
    if (App._inBrowse) App._exitBrowse();
    const screen = document.getElementById('profile-screen');
    PlatformUI.transition(() => {
      if (leavingApp) AppView.close();
      App._showOnlyScreen('profile-screen');
      App._enterScreenChrome();
      App.setHeaderTitle('Profile');
    }, { type: App._entryTransition(fromIframe ? 'none' : 'push', screen) });
    App._inProfile = true;
    if (window.Profile?.open) Profile.open();
  },

  // State-only (#979) — see _exitLeaderboard.
  _exitProfile() {
    App._inProfile = false;
    if (window.Profile?.close) Profile.close();
  },

  // Show the browse-all-apps screen (#apps). Sibling to
  // navigateToProfile — hides home + app, reveals #browse-screen, lets
  // the Browse module (public/js/browse.js) render into #browse-list.
  //
  // No permission gate: the grid is built from GET /api/apps, which is
  // already visibility-filtered per viewer, and restoreFromHash's
  // anonymous-shell branch bounced a signed-out visitor to login before
  // this can run. The header's back button goes home; the browser/OS back
  // gesture returns here from an app opened out of this grid, because the
  // screen has its own hash entry.
  navigateToBrowse(slug) {
    // Already mounted: this is an in-screen level change (#apps ↔
    // #apps/<slug>, the back button, a hand-typed hash), not a screen
    // entry. Hand it to the module — re-running the screen swap below
    // would re-hide every sibling and replay the entry animation on what
    // is really a level change. Same idiom as navigateToAdminConsole.
    if (App._inBrowse && window.Browse?.isOpen?.()) {
      Browse.route(slug || null);
      return;
    }
    const fromIframe = !!(App.currentApp && App.currentTab === 'app');
    const leavingApp = !!App.currentApp;
    App.currentApp = null;
    if (App._inLeaderboard) App._exitLeaderboard();
    if (App._inProfile) App._exitProfile();
    if (App._inAdmin) App._exitAdminConsole();
    if (App._inSettings) App._exitSettings();
    const screen = document.getElementById('browse-screen');
    App._inBrowse = true;
    // Renders into the still-hidden screen; `chrome: false` holds back its
    // level-dependent title/back-icon so the header only changes inside
    // the transition callback below (#979).
    if (window.Browse?.open) Browse.open(slug || null, { chrome: false });
    PlatformUI.transition(() => {
      if (leavingApp) AppView.close();
      App._showOnlyScreen('browse-screen');
      App._enterScreenChrome();
      App.setHeaderTitle('All apps');
      // Browse owns the header title / back icon for whichever level the
      // slug selected, so its sync runs after setHeaderTitle above.
      if (window.Browse?.syncChrome) Browse.syncChrome();
    }, { type: App._entryTransition(fromIframe ? 'none' : 'push', screen) });
  },

  // State-only (#979) — see _exitLeaderboard. The back chevron the detail
  // level borrowed is handed back by the next screen's _showOnlyScreen.
  _exitBrowse() {
    App._inBrowse = false;
    if (window.Browse?.close) Browse.close();
  },

  // Sections of the admin console that were PUBLIC pages before #860
  // folded them in (/status and /node-status). A signed-in non-admin who
  // follows one of those old links still gets them — everything else in
  // the console, including bare #admin, still bounces a non-admin home.
  // Must stay in sync with the `public: true` flags in
  // AdminConsole.SECTIONS (public/js/admin-console.js).
  ADMIN_PUBLIC_SECTIONS: ['status', 'node'],

  // Show the admin & moderation console (#818, extended by #860). Sibling
  // to navigateToProfile — hides home + app, reveals the dedicated
  // #admin-screen, lets the AdminConsole module render itself into
  // #admin-root. Gate: App.user.isAdmin, which covers BOTH full and
  // view-only admins (see renderAdminButton above) — a hand-typed #admin
  // from a non-admin bails to home. The "View as non-admin" preview masks
  // App.user.isAdmin at boot, so preview mode is covered by the same
  // check. Every /api/admin/* endpoint the page calls is independently
  // enforced server-side.
  //
  // The one exception is PUBLIC MODE: a non-admin asking for #admin/status
  // or #admin/node gets the console mounted with only those two sections
  // in the menu and the header reading "Platform status". The data they
  // see is the same sanitized /api/status payload the old public /status
  // page served them (src/services/status.js redact()), so this widens no
  // boundary — it only keeps the old public URLs working.
  navigateToAdminConsole(section) {
    const isAdmin = !!App.user?.isAdmin;
    const publicMode = !isAdmin && App.ADMIN_PUBLIC_SECTIONS.includes(section);
    if (!isAdmin && !publicMode) {
      App.navigateHome();
      return;
    }
    // Already mounted: this is an in-console navigation (a mobile drill-in,
    // the back button, a hand-typed section hash), not a screen entry. Hand
    // it to the console — re-running the screen swap below would re-hide
    // every sibling screen and replay the entry push animation on what is
    // really a level change inside one screen. Deliberately AFTER the gate
    // above so it can never be used to bypass it.
    if (App._inAdmin && window.AdminConsole?.isOpen?.()) {
      AdminConsole.route(section, { public: publicMode });
      return;
    }
    const fromIframe = !!(App.currentApp && App.currentTab === 'app');
    const leavingApp = !!App.currentApp;
    App.currentApp = null;
    if (App._inLeaderboard) App._exitLeaderboard();
    if (App._inProfile) App._exitProfile();
    if (App._inSettings) App._exitSettings();
    if (App._inBrowse) App._exitBrowse();
    const screen = document.getElementById('admin-screen');
    App._inAdmin = true;
    // Renders into the still-hidden screen; `chrome: false` holds its
    // section title / back arrow back for the callback below (#979).
    if (window.AdminConsole?.open) {
      AdminConsole.open(section, { public: publicMode, chrome: false });
    }
    PlatformUI.transition(() => {
      if (leavingApp) AppView.close();
      App._showOnlyScreen('admin-screen');
      App._enterScreenChrome();
      App.setHeaderTitle(publicMode ? 'Platform status' : 'Admin & moderation');
      if (window.AdminConsole?.syncChrome) AdminConsole.syncChrome();
    }, { type: App._entryTransition(fromIframe ? 'none' : 'push', screen) });
  },

  // State-only (#979) — see _exitLeaderboard. The back chevron the mobile
  // section view borrowed is handed back by the next screen's
  // _showOnlyScreen.
  _exitAdminConsole() {
    App._inAdmin = false;
    if (window.AdminConsole?.close) AdminConsole.close();
  },

  // Show the Settings screen (settings-modal-to-screen conversion). Sibling
  // to navigateToAdminConsole — hides home + app, reveals the dedicated
  // #settings-screen and lets the Settings module (public/js/settings.js)
  // render its sidebar / two-level menu into the static shell in
  // index.html. No permission gate: Settings is every signed-in user's own
  // account surface, and restoreFromHash's anonymous-shell branch already
  // bounced a signed-out visitor to login (remembering the deep link).
  navigateToSettings(section) {
    // Already mounted: this is an in-screen navigation (a mobile drill-in,
    // the back button, a hand-typed section hash), not a screen entry. Hand
    // it to the module — re-running the screen swap below would re-hide
    // every sibling screen and replay the entry push animation on what is
    // really a level change inside one screen.
    if (App._inSettings && window.Settings?.isOpen?.()) {
      Settings.route(section);
      return;
    }
    const fromIframe = !!(App.currentApp && App.currentTab === 'app');
    const leavingApp = !!App.currentApp;
    App.currentApp = null;
    if (App._inLeaderboard) App._exitLeaderboard();
    if (App._inProfile) App._exitProfile();
    if (App._inAdmin) App._exitAdminConsole();
    if (App._inBrowse) App._exitBrowse();
    const screen = document.getElementById('settings-screen');
    App._inSettings = true;
    // Renders every section into the still-hidden screen — invisible, so
    // it may stay synchronous (which keeps Settings.isOpen() truthful for
    // the re-entry guard above). `chrome: false` holds back the one
    // VISIBLE thing it does: writing the header title / back icon, which
    // now happens inside the transition callback (#979).
    if (window.Settings?.open) Settings.open(section, { chrome: false });
    PlatformUI.transition(() => {
      if (leavingApp) AppView.close();
      App._showOnlyScreen('settings-screen');
      App._enterScreenChrome();
      App.setHeaderTitle('Settings');
      // Runs after app.js's own setHeaderTitle, so on a mobile deep link
      // the header ends up showing the section's name rather than
      // "Settings".
      if (window.Settings?.syncChrome) Settings.syncChrome();
    }, { type: App._entryTransition(fromIframe ? 'none' : 'push', screen) });
  },

  // State-only (#979) — see _exitLeaderboard. The back chevron the mobile
  // section view borrowed is handed back by the next screen's
  // _showOnlyScreen.
  _exitSettings() {
    App._inSettings = false;
    if (window.Settings?.close) Settings.close();
  },

  // navigateToTopochainLeaderboard / _exitTopochainLeaderboard used to
  // live here (Task 14, public screens). The Topochain leaderboard is a
  // TAB of the Leaderboard screen now, so it has no navigate/exit pair of
  // its own: #topochain/leaderboard aliases onto
  // navigateToLeaderboard('topochain') in restoreFromHash, and
  // _exitLeaderboard tears down all three panes.
  //
  // Same for navigateToTopochainSeasons / _exitTopochainSeasons: the
  // seasons screen's challenge grid is the Leaderboard screen's third tab
  // and its event hero is that screen's shared event bar, so
  // #topochain/seasons aliases onto navigateToLeaderboard('challenges').

  // Push a new history entry on real screen transitions (entering an
  // app, switching tabs, going home) so the WebView builds a real
  // back stack; replace in-place when only secondary state changes
  // within the same screen (e.g. selecting a different dev-chat
  // session inside the individual-chat tab) — otherwise every session
  // click would add an entry the user has to back through.
  //
  // "Screen" here = `#app/<slug>/<tab>` prefix; the optional 4th
  // segment (session id) is intentionally NOT part of the screen id.
  updateHash() {
    if (App._isRestoring) return;

    let newHash;
    if (App.currentApp) {
      if (App.currentTab === 'dev') {
        if (App.currentSubTab === 'sessions' && DevChat.currentSession) {
          newHash = `#app/${App.currentApp}/dev/sessions/${DevChat.currentSession.id}`;
        } else if (App.currentSubTab === 'chat') {
          newHash = `#app/${App.currentApp}/dev/chat`;
        } else if (App.currentSubTab === 'topic'
            && typeof AppView !== 'undefined' && AppView._devTopic) {
          const t = AppView._devTopic;
          const seg = t.kind === 'issue' ? 'issues'
            : t.kind === 'proposal' ? 'proposals'
            : t.kind === 'session' ? 'shared' : 'governance';
          newHash = `#app/${App.currentApp}/dev/${seg}/${t.id}`;
        } else {
          newHash = `#app/${App.currentApp}/dev`;
        }
      } else {
        // Chromeless mode round-trips through reloads/history via its
        // own hash segment; the regular App tab keeps `/app`. An active
        // inner deep link (#743) rides along as the final fragment param
        // so the post-load hash rewrite doesn't strip it and
        // reload/back/forward reproduce the shared screen.
        const innerPath = (App.chromeless && typeof AppView !== 'undefined'
          && AppView.pendingInnerPath) || null;
        newHash = App.chromeless
          ? `#app/${App.currentApp}/full${innerPath ? `?path=${innerPath}` : ''}`
          : `#app/${App.currentApp}/app`;
      }
    } else {
      // Home: drop the fragment entirely — but keep the query string. In
      // staging previews the shell-injected ?token= lives there, and the
      // WS connects re-read it as an auth fallback (see connectEvents /
      // GroupChat._openSocket).
      newHash = location.pathname + location.search;
    }

    const currentFull = location.hash || '';
    const targetFull = newHash.startsWith('#') ? newHash : '';
    if (currentFull === targetFull) return;

    // Screen ids: every full-screen sub-view (chat, topics, sessions)
    // is its own screen — list ↔ sub-view pushes a history entry, so
    // device/browser back mirrors the in-page back buttons — but which
    // session/topic isn't part of the id (moving between two topics of
    // the same kind replaces in place).
    const SUB_SCREENS = new Set(['sessions', 'chat', 'issues', 'proposals', 'governance', 'shared']);
    const screenIdOf = (h) => {
      // Strip the fragment-query (#743) so #app/x/full?path=/t/1 and
      // #app/x/full are the SAME screen (replace, not a spurious push).
      const segs = String(h || '').replace(/^#/, '').split('?')[0].split('/');
      if (segs[0] === 'app' && segs[2] === 'dev') {
        return SUB_SCREENS.has(segs[3])
          ? segs.slice(0, 4).join('/')
          : segs.slice(0, 3).join('/');
      }
      return segs.slice(0, 3).join('/');
    };
    const sameScreen = screenIdOf(currentFull) === screenIdOf(targetFull);

    if (sameScreen) {
      history.replaceState(null, '', newHash);
    } else {
      history.pushState(null, '', newHash);
    }
  },

  showCreateModal() {
    App.setCreateMode('new');
    document.getElementById('create-modal').classList.remove('hidden');
    document.getElementById('app-name').focus();
  },

  hideCreateModal() {
    document.getElementById('create-modal').classList.add('hidden');
    document.getElementById('create-form').reset();
    document.getElementById('create-error').classList.add('hidden');
    App.setCreateMode('new');
    App._setImportState('idle');
    App.setCreateVisibility('collab', 'public');
  },

  // Visibility state for the create modal. setCreateVisibility('collab',
  // 'public') also forces view='public' and disables the view pills —
  // the one invalid combination (collab public + view private) can never
  // be selected. Defaults match today's behavior (everything public).
  _createVis: { collab: 'public', view: 'public' },

  setCreateVisibility(kind, value) {
    const v = value === 'private' ? 'private' : 'public';
    if (kind === 'collab') {
      App._createVis.collab = v;
      if (v === 'public') App._createVis.view = 'public';
    } else {
      // View can only go private when collab is private.
      App._createVis.view = (App._createVis.collab === 'private') ? v : 'public';
    }
    const block = document.getElementById('create-visibility-block');
    if (!block) return;
    block.querySelectorAll('[data-collab-vis]').forEach((p) => {
      p.classList.toggle('active', p.dataset.collabVis === App._createVis.collab);
    });
    const collabPublic = App._createVis.collab === 'public';
    block.querySelectorAll('[data-view-vis]').forEach((p) => {
      p.classList.toggle('active', p.dataset.viewVis === App._createVis.view);
      p.disabled = collabPublic;
    });
    const hint = document.getElementById('create-vis-hint');
    if (hint) hint.classList.toggle('hidden', !collabPublic);
  },

  // Single source of truth for "which mode is the create modal in". CSS
  // shows/hides the URL block + name field via the data-mode attribute;
  // this helper also flips the title and submit-button label so every
  // entry point (open, cancel, pill click) stays in sync.
  setCreateMode(mode) {
    const m = mode === 'import' ? 'import' : 'new';
    const modal = document.getElementById('create-modal');
    if (!modal) return;
    modal.dataset.mode = m;
    // Mirror onto the card: the native-kit modal adoption lifts the card
    // out of #create-modal while presented, so CSS keyed off the modal
    // root would stop matching (the bug that left the modal stuck in
    // import mode). app.css keys off #create-card instead.
    const card = document.getElementById('create-card');
    if (card) card.dataset.mode = m;
    document.getElementById('create-title').textContent =
      m === 'import' ? 'Import existing app' : 'Create a new app';
    document.getElementById('create-submit').textContent =
      m === 'import' ? 'Import' : 'Create';
    document.getElementById('create-error').classList.add('hidden');
    // Switching back to "new" shouldn't leave a stale check banner
    // around; switching into "import" lands on idle either way.
    App._setImportState('idle');
    // Make the name field required only in "new" mode. In "import" the
    // server-side pre-flight is what gates submission — the name field
    // doesn't even exist in the DOM tree until the check passes.
    const nameEl = document.getElementById('app-name');
    if (nameEl) nameEl.required = (m === 'new');
  },

  // Drive the import sub-state. CSS reveals the name field and submit
  // button only at state="ok"; everything else hides them. Called from
  // every transition so the DOM never gets stuck in a halfway state.
  _setImportState(state) {
    const modal = document.getElementById('create-modal');
    if (!modal) return;
    const s = ['idle', 'checking', 'ok', 'error'].includes(state) ? state : 'idle';
    modal.dataset.importState = s;
    // Mirrored onto the card for the same reason as setCreateMode: the
    // kit modal adoption detaches the card from #create-modal.
    const card = document.getElementById('create-card');
    if (card) card.dataset.importState = s;
    const checkBtn = document.getElementById('import-check');
    const status = document.getElementById('import-status');
    if (checkBtn) {
      checkBtn.disabled = (s === 'checking');
      checkBtn.textContent = s === 'ok' ? 'Re-check' : 'Check';
    }
    if (status) {
      if (s === 'idle') {
        status.textContent = '';
        status.className = 'text-sm mt-2';
      } else if (s === 'checking') {
        status.innerHTML = '<span class="import-spinner"></span>Checking bot access…';
        status.className = 'text-sm mt-2';
      }
      // 'ok' and 'error' branches set their own text in handleImportCheck
      // so the message can include repo name / server error text.
    }
  },

  async handleImportCheck() {
    const url = (document.getElementById('import-url')?.value || '').trim();
    const status = document.getElementById('import-status');
    if (!url) {
      App._setImportState('error');
      if (status) {
        status.textContent = 'Paste a GitHub repo URL first.';
        status.className = 'text-sm mt-2 import-status--err';
      }
      return;
    }

    App._setImportState('checking');
    let res;
    try {
      res = await fetch(`/api/github/verify-access?url=${encodeURIComponent(url)}`);
    } catch {
      App._setImportState('error');
      if (status) {
        status.textContent = 'Network error — try again.';
        status.className = 'text-sm mt-2 import-status--err';
      }
      return;
    }

    let data = {};
    try { data = await res.json(); } catch (_) {}

    if (!res.ok) {
      App._setImportState('error');
      if (status) {
        status.textContent = data.error || `Check failed (HTTP ${res.status}).`;
        status.className = 'text-sm mt-2 import-status--err';
      }
      return;
    }

    App._setImportState('ok');
    if (status) {
      const fullName = data.fullName || `${data.owner}/${data.repo}`;
      status.textContent = `✓ usernode-bot has Write access to ${fullName}.`;
      status.className = 'text-sm mt-2 import-status--ok';
    }
    // Prefill name field — repo name + optional description, capped so
    // we don't blow past the input's visible width. Only fill if the
    // user hasn't already typed something (so re-checks don't clobber
    // a manual edit).
    const nameEl = document.getElementById('app-name');
    if (nameEl && !nameEl.value.trim() && data.name) {
      nameEl.value = data.description
        ? `${data.name} — ${data.description}`.slice(0, 80)
        : data.name;
    }
    if (nameEl) nameEl.focus();
  },

  async handleCreateApp(e) {
    e.preventDefault();
    const modal = document.getElementById('create-modal');
    const mode = modal?.dataset.mode === 'import' ? 'import' : 'new';
    const name = document.getElementById('app-name').value.trim();
    const repoUrl = document.getElementById('import-url')?.value.trim() || '';
    const errorEl = document.getElementById('create-error');
    errorEl.classList.add('hidden');

    if (!name) return;

    // Guard: in import mode, submit is gated behind a successful check.
    // CSS hides the submit button when state !== 'ok', but a determined
    // user could still submit by hitting Enter, so belt-and-braces here.
    // The server runs the pre-flight again on POST anyway.
    if (mode === 'import') {
      if (!repoUrl) return;
      if (modal.dataset.importState !== 'ok') {
        errorEl.textContent = 'Click "Check" to verify bot access first.';
        errorEl.classList.remove('hidden');
        return;
      }
    }

    const body = mode === 'import' ? { name, repoUrl } : { name };
    body.collabVisibility = App._createVis.collab;
    body.viewVisibility = App._createVis.view;

    try {
      const res = await fetch('/api/apps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await res.json();

      if (!res.ok) {
        errorEl.textContent = data.error || 'Failed to create app';
        errorEl.classList.remove('hidden');
        return;
      }

      App.hideCreateModal();
      Home.load();
    } catch {
      errorEl.textContent = 'Network error';
      errorEl.classList.remove('hidden');
    }
  },

  // ── Homescreen zoom transition ─────────────────────────────────────
  // Opening an app expands the app view out of the clicked tile's
  // on-screen rect (iOS-homescreen style) and Back shrinks it into the
  // tile again — the kit's 'zoom-in'/'zoom-out' transition types (#740;
  // this replaced the platform's hand-rolled _zoom* implementation).
  // The kit owns the pitfalls: pinning the LIVE #app-view as a fixed
  // overlay (no View Transition snapshot, so the app-iframe caveat
  // doesn't apply), the opaque --un-zoom-bg surface, exact inline-style
  // restore, and the fallback to push/pop or an instant cut when the
  // tile isn't on screen or the user prefers reduced motion.
  //
  // One pitfall needs a hint from us (#764): #app-view and #home-screen
  // are flex:1 siblings in the body column, so while BOTH are visible
  // (fn reveals app-view, home stays beneath the zoom) they split the
  // height 50/50 and the kit would measure app-view's destination as
  // the bottom half — the zoom then landed there and snapped to full
  // size when `after` hid home. Passing `outEl: #home-screen` lets the
  // kit hide it for the synchronous pre-paint measurement, so the zoom
  // targets app-view's true settled rect (full screen in chromeless
  // mode, the band between header and tab bar otherwise).

  // The home tile for `slug`, or null. A hidden home screen or
  // filtered-away tile yields no element / a 0×0 rect, which the kit
  // rejects — so the old home-visible checks live in the kit now.
  //
  // Scoped to the two authed launcher grids that still render icon TILES —
  // #app-list (home's "Your apps") and #home-featured-list (home's
  // featured row). NOT the anonymous landing directory (#landing-apps),
  // which renders `.app-card[data-slug]` tiles too and lives in this same
  // document after a reload-free login; and NOT #browse-list, which
  // renders app-store `.browse-row` rows rather than tiles, so there is no
  // tile rect to zoom out of there (the kit falls back to a push).
  //
  // Whichever grid the tap came from is the one whose tile is on screen,
  // so a single query across both lands on the right rect.
  _tileFor(slug) {
    try {
      const sel = CSS.escape(slug);
      return document.querySelector(
        `#app-list .app-card[data-slug="${sel}"], `
        + `#home-featured-list .app-card[data-slug="${sel}"]`
      );
    } catch { return null; }
  },

  // The screen the app view is expanding OUT of — home normally, the
  // browse screen when the tap came from there. The kit needs it twice:
  // as `outEl` (hidden for the synchronous pre-paint measurement so the
  // flex-sibling split doesn't skew the destination rect) and in `after`
  // (concealed once the zoom lands). Getting this wrong leaves the
  // outgoing grid painted behind the opened app.
  //
  // It must name whichever screen root is ACTUALLY visible, not just the
  // two launcher grids (#979): since the _exitX helpers became state-only,
  // the settings / admin / profile / leaderboard roots stay visible until
  // the transition callback runs, so opening an app straight out of one of
  // them (a work notification, a deep link) would otherwise leave that
  // root in the flex flow and skew the zoom's destination rect (#764).
  //
  // Read from the DOM rather than the _inX flags on purpose: callers reach
  // here both before and after those flags are cleared (restoreFromHash
  // runs the exits itself), and "which root is on screen" is exactly the
  // question the kit is asking. Home is the fallback — it's the root that
  // ships visible.
  _departingScreen() {
    for (const id of App.SCREEN_IDS) {
      if (id === 'app-view') continue;
      const el = document.getElementById(id);
      if (el && !el.classList.contains('hidden')) return el;
    }
    return document.getElementById('home-screen');
  },

  // Origins we've already asked the browser to connect to this page-load.
  // Preconnect is a hint, not a promise — repeating it per hover is just
  // noise, and one entry per app origin is a handful of strings.
  _preconnected: {},

  // #931: warm the two things a launch would otherwise wait on, on
  // pointerdown/hover — before the click even resolves:
  //
  //   1. The iframe token. AppView._mintToken is single-flight with a 60s
  //      freshness window, so the launch a moment later finds it in hand and
  //      can assign the iframe src synchronously in the tap's own tick.
  //      Deliberately NOT refreshToken(): that writes iframeToken /
  //      iframeTokenSlug, and merely hovering app B must not repoint the
  //      token held for the app that is currently OPEN (a token refresh or
  //      re-render for app A would then build a tokenless src).
  //   2. The TCP+TLS handshake to the app's origin, via preconnect. Every
  //      app lives on its own subdomain, so this is a fresh connection the
  //      first time — the one part of the launch the client can't overlap
  //      with anything else once the request is already out.
  //
  // Best-effort throughout: a miss just means the launch does the work
  // itself, exactly as it did before.
  prewarmApp(slug) {
    if (!slug || !window.AppView) return;
    const rec = AppView.launchRecordFor(slug);
    if (!rec || rec.demo || rec.self_hosted || rec.status !== 'running' || !rec.url) return;
    if (window.Offline && Offline.isOffline()) return;
    try { AppView._mintToken(slug); } catch (err) { /* ignore */ }
    try {
      const origin = new URL(resolveDevHost(rec.url), location.origin).origin;
      if (origin === location.origin || App._preconnected[origin]) return;
      App._preconnected[origin] = true;
      const link = document.createElement('link');
      link.rel = 'preconnect';
      // No `crossorigin`: an iframe DOCUMENT load uses the credentialed
      // connection pool, and a preconnect made with crossorigin (anonymous)
      // warms the *other* pool — the socket would go unused.
      link.href = origin;
      document.head.appendChild(link);
    } catch (err) { /* unparseable url — nothing to warm */ }
  },

  async navigateToApp(slug, tab, ref, subTab) {
    // Clean up whatever app we had mounted. This is a no-op on the first
    // navigation into any app, but without it a direct app-A → app-B
    // jump (e.g. via hash) would carry the previous app's dev-chat
    // session state into the new view.
    //
    // Deliberately NOT deferred into the reveal callback the way the
    // screen navigations defer theirs (#979): restoreFromHash re-stashes
    // AppView.pendingInnerPath immediately after this call *because* this
    // teardown clears it (#743), and the outgoing page here is the other
    // app's, which the incoming app view covers either way.
    if (App.currentApp && App.currentApp !== slug) {
      AppView.close();
    }
    App.currentApp = slug;
    // Resolved BEFORE the _exitX flags are cleared — _departingScreen
    // reads them to name whichever screen root is actually on screen.
    const departing = App._departingScreen();
    if (App._inLeaderboard) App._exitLeaderboard();
    if (App._inProfile) App._exitProfile();
    if (App._inAdmin) App._exitAdminConsole();
    if (App._inSettings) App._exitSettings();
    // Real screen navigation. From a launcher grid (home's "Your apps" /
    // featured row, or the #apps browse screen) the app view expands out
    // of the clicked tile (kit 'zoom-in'); from anywhere else (deep link,
    // history restore, tile off-screen, reduced motion) the kit falls
    // back to its native push.
    //
    // #931: the app frame IS mounted here now — beginLaunch runs inside the
    // reveal callback, so the app's document request goes out before the
    // zoom's first frame and the app loads *during* the animation instead of
    // after it. It mounts behind an opaque cover (the app's own icon and
    // name), so the zoom still animates a stable surface rather than a
    // half-painted iframe, and the cover cross-fades away the moment the
    // frame loads — often mid-zoom. Putting the call inside `fn` rather
    // than before the transition keeps it correct on the `push` fallback
    // too: either way it runs exactly when #app-view is revealed.
    // The departing screen stays visible beneath the zoom (fn reveals,
    // `after` conceals — kit contract).
    // #977: reachable from the drawer too (the footer's "Forked from"
    // link opens the source app), so the zoom goes through the same
    // single-motion gate — 'none' still runs fn + after as one mutation.
    const appViewEl = document.getElementById('app-view');
    PlatformUI.transition(() => {
      document.getElementById('app-view').classList.remove('hidden');
      document.getElementById('back-btn').classList.remove('hidden');
      // Best-effort: returns false (and changes nothing) for anything whose
      // App tab wouldn't be a plain production iframe — self-hosted apps,
      // demo cards, non-running apps, an explicit non-app tab, offline.
      try { AppView.beginLaunch(slug, tab); } catch (err) { /* fall back to the plain path */ }
    }, {
      type: App._entryTransition('zoom-in', appViewEl),
      el: document.getElementById('app-view'),
      fromEl: () => App._tileFor(slug),
      // The outgoing screen: the kit hides it while measuring the
      // destination so the flex-sibling split doesn't skew the target
      // rect (see the comment block above).
      outEl: departing,
      fallback: 'push',
      // Conceal EVERY other screen root, not just `departing`: the _exitX
      // helpers no longer hide theirs (#979), so a screen entered before
      // this app would otherwise stay painted behind it.
      after: () => { App._showOnlyScreen('app-view'); },
    });
    // Intentionally NOT setting the header to `slug` here. Slugs are
    // generated as `${name}-${randomHex}` (see routes/apps.js), so a
    // slug-as-placeholder shows up to users as something like
    // "whiteboard-abc123" — which the Flutter WebView's AppBar then
    // mirrors via document.title. Leaving the previous header title
    // in place during the brief /api/apps/:slug round-trip is much
    // better UX: from home you see "dApps" briefly, then "Whiteboard";
    // from app A to app B you see "App A" briefly, then "App B". The
    // user never sees the raw slug.
    //
    // The display name lands once the await below resolves (see the
    // `AppView.appData?.name` block).

    await AppView.open(slug);

    // The user can navigate away (back to home, into a different app,
    // to the leaderboard) while `AppView.open(slug)` is still resolving
    // its /api/apps/:slug fetch. Without this guard the rest of the
    // setup below would clobber the header title, re-show the
    // GitHub/Share icons, and force-switch the tab on the screen the
    // user has since moved to. `App.currentApp` is updated synchronously
    // at the top of every navigate* method, so it's the canonical
    // "what's actually on screen right now" signal.
    if (App.currentApp !== slug) return;

    // After app data is loaded, swap header to the display name.
    if (AppView.appData?.name) {
      App.setHeaderTitle(AppView.appData.name);
    }

    // Show the GitHub drawer row if app has a repo
    const drg = document.getElementById('drawer-row-github');
    if (drg && AppView.appData?.repo_url) {
      drg.href = AppView.appData.repo_url;
      drg.classList.remove('hidden');
    }
    // Show the Share drawer row only for apps that have a real running
    // URL. Apps in `creating`/`error`/`awaiting_secrets` have no URL to
    // share; the SSE handler re-shows the row when they flip to `running`.
    const drs = document.getElementById('drawer-row-share');
    if (drs && AppView.appData?.status === 'running' && AppView.appData?.url) {
      drs.classList.remove('hidden');
    }
    // Reveal the drawer footer's "App" build row on the same lifecycle.
    // AppView.refreshVersionPill() fills the slot; the fork line is
    // revealed separately by AppView.renderForkBadge().
    App.DrawerStatus.setAppOpen(true);
    // Members & visibility moved from the drawer into the Dev tab's "+"
    // menu (#645) — AppView._plusMenuShowsMembers() is the single gate.
    // The App tab iframes appData.url, which doesn't resolve for the self-
    // hosted platform row (no per-slug subdomain). Land on the Dev forum
    // instead — that's where votes/discussion happen and what users
    // actually want when they open the self-app.
    const defaultTab = AppView.appData?.self_hosted ? 'dev' : 'app';
    App.switchTab(tab || defaultTab, ref, subTab);
  },

  navigateHome() {
    App.setChromeless(false);
    const leavingSlug = App.currentApp;
    // Iframe caveat (spec): View Transitions snapshot the outgoing
    // page, and a live app iframe in that snapshot can flash on iOS
    // Safari. The kit 'zoom-out' transform-animates the LIVE view (no
    // snapshot), so it's iframe-safe; the fallback still cuts
    // instantly when leaving the App tab's iframe.
    const fallbackType = (App.currentApp && App.currentTab === 'app') ? 'none' : 'pop';
    App.currentApp = null;
    if (App._inLeaderboard) App._exitLeaderboard();
    if (App._inProfile) App._exitProfile();
    if (App._inAdmin) App._exitAdminConsole();
    if (App._inSettings) App._exitSettings();
    if (App._inBrowse) App._exitBrowse();
    // Preferred: shrink the app view back into its home tile (kit
    // 'zoom-out': fn reveals home beneath the pinned overlay, `after`
    // hides the app view and clears its content — exactly once on
    // every path, so the shrinking overlay keeps showing the app's
    // content until it lands).
    //
    // The screen the viewer is LEAVING (settings, admin, a grid…) is
    // hidden in `fn`, not in `after` (#979): on the pop fallback `fn` runs
    // after the View Transition captured it, so it still slides away with
    // its own content; and on the real zoom-out there is no snapshot at
    // all, so it must go before the pinned card starts moving or two
    // `flex-1` siblings would split the height behind it ('zoom-out'
    // ignores `outEl`, so the kit can't correct for that). #app-view is
    // the one root kept alive into `after` — that IS the shrinking card.
    const av = document.getElementById('app-view');
    PlatformUI.transition(() => {
      AppView.close();
      App._showOnlyScreen('home-screen', ['app-view']);
      document.getElementById('back-btn').classList.add('hidden');
      const drgH = document.getElementById('drawer-row-github');
      const drsH = document.getElementById('drawer-row-share');
      if (drgH) drgH.classList.add('hidden');
      if (drsH) drsH.classList.add('hidden');
      App.DrawerStatus.setAppOpen(false);
      App.setHeaderTitle('dApps');
    }, {
      type: App._entryTransition('zoom-out', av),
      el: av,
      fromEl: () => (leavingSlug ? App._tileFor(leavingSlug) : null),
      fallback: fallbackType,
      after: () => {
        av.classList.add('hidden');
        const content = document.getElementById('app-content');
        if (content) content.innerHTML = '';
      },
    });
    App.updateHash();
    Home.load();
  },

  // Which affordance the header's single back button presents. 'home' (the
  // default for every screen) shows the house icon and leaves the current
  // screen entirely; 'arrow' shows the chevron and means "up one level
  // inside this screen" — currently only the mobile admin console's
  // section view, which is what #back-icon-arrow in index.html was
  // shipped for. Always reset to 'home' when leaving the screen that
  // asked for the arrow (see _exitAdminConsole).
  //
  // #1036: the control is a real <a href>, so this also owns its TARGET.
  // `href` is where the button would go if pressed — omit it and it
  // defaults to home, which is correct for every state except the three
  // screens that claim the chevron as "up one level" (Browse detail,
  // and the mobile section views of Settings / the Admin console). Those
  // pass their own up-level hash. Because App._showOnlyScreen calls this
  // on EVERY screen change, there is no state in which the href can go
  // stale — same reasoning that makes the icon itself reliable.
  setBackIcon(mode, href) {
    const arrow = mode === 'arrow';
    const home = document.getElementById('back-icon-home');
    const chevron = document.getElementById('back-icon-arrow');
    if (home) home.classList.toggle('hidden', arrow);
    if (chevron) chevron.classList.toggle('hidden', !arrow);
    const btn = document.getElementById('back-btn');
    if (btn) {
      btn.setAttribute('aria-label', arrow ? 'Back' : 'Home');
      const target = href || (window.NavLink ? NavLink.homeHref() : '/');
      btn.setAttribute('href', target);
    }
  },

  // Mirror the visible header text into both the on-screen <h1> and
  // the browser tab title so the OS/window surface reflects the
  // current screen (home → "dApps", app open → app display name,
  // leaderboard → "Kudos leaderboard"). The browser tab title is
  // also used by Notifications._updateTitle() to prepend an unread
  // count "(N) "; we re-invoke it here so a navigation that happens
  // while there are pending notifications keeps the badge.
  //
  // Inside the Flutter WebView, the native AppBar mirrors
  // `document.title`. Flutter's `_refreshPageTitle` only re-reads the
  // title at navigation moments (onPageFinished + onUrlChange). Most
  // of our title sets are *after* a `pushState` (in navigateHome) or
  // *before* one (in navigateToApp, since setHeaderTitle runs before
  // `switchTab → updateHash → pushState`), but the AppBar still ends
  // up one navigation behind in practice — the getTitle() round-trip
  // races with the next JS task, and the result is that the AppBar
  // shows the title that was current at the *previous* pushState.
  // To pin the AppBar to whatever we just set, we also fire-and-forget
  // a `titleChanged` message over the existing Usernode JS channel.
  // The native side handles it by setting `_pageTitle` directly
  // (see lib/features/dapps/dapp_webview_screen.dart). Older app
  // builds that don't know `titleChanged` ignore the message
  // (Flutter logs and drops unknown methods), so this is safe to ship
  // ahead of the Flutter rebuild.
  setHeaderTitle(text) {
    const headerEl = document.getElementById('header-title');
    if (headerEl) headerEl.textContent = text;
    document.title = text;
    // Re-apply the dev-chat status marker ("⏳ thinking / ✅ done",
    // #108) that the plain title assignment above just wiped, then let
    // Notifications re-apply its "(N) " unread prefix outermost.
    if (window.DevChat && typeof DevChat.applyTitleStatus === 'function') {
      DevChat.applyTitleStatus();
    }
    if (window.Notifications && typeof Notifications._updateTitle === 'function') {
      Notifications._updateTitle();
    }
    try {
      if (window.Usernode && typeof window.Usernode.postMessage === 'function') {
        window.Usernode.postMessage(JSON.stringify({
          method: 'titleChanged',
          // Use the final title (with the optional "(N) " unread prefix
          // that Notifications._updateTitle just applied) so the AppBar
          // matches what a desktop browser tab would show.
          value: document.title,
        }));
      }
    } catch (_) {
      // Non-critical — title sync via JS channel is just a fast path
      // for the native shell. Falling back to webview_flutter's
      // onUrlChange path is fine for desktop browsers.
    }
  },

  // Normalize every tab vocabulary onto the forum-era model (#194
  // revision). Returns { tab, subTab, ref } where tab ∈ 'app'|'dev' and
  // subTab ∈ 'forum'|'sessions'. Legacy names (group-chat,
  // individual-chat, and the old dev sub-tabs chat/issues/proposals)
  // keep working at every entry point — old sub-tab refs are converted
  // into typed forum deep links ({ kind: 'issue'|'proposal', id }).
  _normalizeTab(tab, ref, subTab) {
    if (tab === 'group-chat') { tab = 'dev'; subTab = 'chat'; }
    else if (tab === 'individual-chat') { tab = 'dev'; subTab = subTab || 'sessions'; }
    if (tab !== 'dev') return { tab: 'app', subTab: null, ref: null };

    if (subTab === 'sessions') {
      const id = (ref && typeof ref === 'object') ? ref.id : parseInt(ref, 10);
      // No session id → the card list (there is no session-list screen).
      return Number.isInteger(id) && id > 0
        ? { tab: 'dev', subTab: 'sessions', ref: id }
        : { tab: 'dev', subTab: 'forum', ref: null };
    }

    // Full-screen sub-views with no deep-link payload. (The 'settings'
    // sub-page is gone — #645 — so old dev/settings requests fall
    // through to the card list below.)
    if (subTab === 'chat') return { tab: 'dev', subTab: 'chat', ref: null };

    // A typed topic ref — from the 'topic' sub-view itself or the
    // legacy issues/proposals sub-tab vocabulary — opens that topic
    // full-screen; everything else lands on the card list.
    let fref = null;
    if (ref && typeof ref === 'object' && ref.kind && ref.id) {
      fref = { kind: ref.kind, id: ref.id };
    } else if (ref != null && subTab === 'issues') {
      const id = parseInt(ref, 10);
      if (Number.isInteger(id) && id > 0) fref = { kind: 'issue', id };
    } else if (ref != null && subTab === 'proposals') {
      const id = parseInt(ref, 10);
      if (Number.isInteger(id) && id > 0) fref = { kind: 'proposal', id };
    }
    return fref
      ? { tab: 'dev', subTab: 'topic', ref: fref }
      : { tab: 'dev', subTab: 'forum', ref: null };
  },

  // `ref` is the view's deep-link target: a dev-session id for the
  // session view, or { kind: 'issue'|'proposal', id } for a forum card
  // to expand. Ignored on the App tab.
  async switchTab(tab, ref, subTab) {
    const norm = App._normalizeTab(tab, ref, subTab);
    tab = norm.tab;
    subTab = norm.subTab;
    ref = norm.ref;
    // The App tab is hidden for self-hosted apps (its iframe target doesn't
    // resolve — see app-view.js renderAppTab). Coerce any incoming request
    // for it (URL hash, browser back/forward, programmatic) to the Dev
    // forum so we never render an unreachable iframe.
    if (tab === 'app' && AppView.appData?.self_hosted) {
      tab = 'dev';
      subTab = 'forum';
      ref = null;
    }
    // #771: a docked staging preview is pinned to the dev-chat session
    // layout, which every tab switch re-renders or unmounts — close it.
    // (A fullscreen preview keeps floating above the tabs, as before.)
    // open=false first so closeStagingOverlay skips its own chat
    // re-render; the switch repaints the destination view anyway.
    if (typeof AppView !== 'undefined' && AppView._stagingMode === 'docked'
        && AppView.closeStagingOverlay) {
      if (typeof DevChat !== 'undefined' && DevChat.stagingPanel) DevChat.stagingPanel.open = false;
      AppView.closeStagingOverlay();
    }
    // #621: the Dev mode is visible to non-collaborators too, read-only
    // (see AppView.readOnly).
    App.currentTab = tab;
    App.currentSubTab = tab === 'dev' ? (subTab || 'forum') : null;
    document.querySelectorAll('.app-mode-seg').forEach((btn) => {
      const on = btn.dataset.tab === tab;
      btn.classList.toggle('app-mode-seg-active', on);
      // The switch is a radiogroup, so the checked state has to be in
      // the a11y tree too — the raised face alone tells a screen reader
      // nothing. Also what the dapp.json checks assert on.
      btn.setAttribute('aria-checked', on ? 'true' : 'false');
    });

    // Tear down the cross-app active-sessions poll when leaving the
    // Sessions sub-tab. renderDevChatTab will spin it back up on
    // re-entry. Without this the poll keeps firing on the other
    // surfaces even though there's no UI to update.
    const onSessions = tab === 'dev' && App.currentSubTab === 'sessions';
    if (!onSessions && typeof DevChat !== 'undefined' && DevChat.stopActiveSessionsPoll) {
      DevChat.stopActiveSessionsPoll();
      // The title status indicator (#108) is scoped to "user is on the
      // dev-chat tab" — leaving the tab clears it. Re-entering while a
      // run is live re-applies it via openSession's busy check.
      if (DevChat.setTitleStatus) DevChat.setTitleStatus(null);
      // #161: switching away from a still-streaming dev session counts
      // as leaving it — arm its completion notification.
      if (DevChat.isStreaming && DevChat.currentSession && DevChat._setNotifyOnDone) {
        DevChat._setNotifyOnDone(DevChat.currentSession.id, true);
      }
    }

    if (tab === 'app') {
      AppView.renderAppTab();
    } else {
      await AppView.renderDevView(App.currentSubTab, ref);
    }

    // Dev console icon: only meaningful when an iframe is on screen. The
    // App tab mounts the production iframe (when status==='running'); the
    // chat tabs do not. Staging overlay manages its own toggle.
    if (window.DevConsole) {
      const showForApp = tab === 'app' && AppView.appData?.status === 'running';
      DevConsole.setButtonVisible(showForApp);
    }

    // #970: the switch changed which surface is mounted, so #app-view's
    // rect (and therefore the frame's own insets) may have changed.
    if (AppView.scheduleSafeAreaBroadcast) AppView.scheduleSafeAreaBroadcast();

    App.updateHash();
  },

  // Explicit navigation entry point for in-app deep links (e.g. clicking
  // a notification) that must render even when the target route equals
  // the current one. Unlike assigning `location.hash`, this never relies
  // on a `hashchange` event firing — a same-value hash assignment fires
  // nothing, which is why notification clicks to the app/tab you're
  // already viewing used to do nothing. Mirrors restoreFromHash's
  // app/tab dispatch, plus a force-rerender branch for same app+tab.
  openAppTab(slug, tab, opts) {
    if (!slug) return;
    const ref = opts && opts.sessionId != null ? opts.sessionId
      : (opts && opts.ref != null ? opts.ref : null);
    const subTab = (opts && opts.subTab) || null;
    if (App.currentApp !== slug) {
      App.navigateToApp(slug, tab, ref, subTab);
    } else {
      // Same app: switchTab normalizes legacy names, re-renders, and
      // syncs the hash — idempotent when nothing changed, a forced
      // refresh when the target equals the current view.
      App.switchTab(tab, ref, subTab);
    }
  },
};

window.App = App;

// #1038: stale-tab recovery for live session state. A tab that was
// backgrounded (or a laptop that slept, or a phone that locked) can have
// missed every `session_state` push while its socket was frozen, and comes
// back showing a spinner for a turn that finished an hour ago. Reconcile on
// the way back in — throttled by SessionState.FOREGROUND_STALE_MS so
// alt-tabbing doesn't spam the endpoint.
//
// Deliberately global rather than per-screen: the cog is in the header on
// every route, so no single view owns this. Both events matter —
// visibilitychange fires on browser-tab switches, focus on window-to-window
// switches where the tab stays "visible" throughout.
App._foregroundResync = () => {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  if (window.SessionState) SessionState.syncIfStale?.();
};
// Guarded: app.js is loaded into bare vm sandboxes by several unit tests,
// which stub `document` / `window` with only the members they need.
if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('visibilitychange', App._foregroundResync);
}
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('focus', App._foregroundResync);
}

document.addEventListener('DOMContentLoaded', () => App.init());
