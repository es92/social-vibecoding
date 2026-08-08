// #30 — Settings (BYOK: bring your own Anthropic API key) — and, since the
// settings-modal-to-screen conversion, the whole #settings SCREEN.
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
// LAYOUT (mirrors public/js/admin-console.js — read that file's header for
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

  const Settings = {
    // `devFlowPreference` is the "remember my option" answer from the
    // dev-chat flow picker (#1049): null = ask every time (the default),
    // otherwise 'platform' | 'claude-code' | 'codex'. `externalFlowsAvailable`
    // says whether this deployment can offer the Claude Code / Codex
    // hand-off at all — the server decides, we only render what it reports.
    state: { hasApiKey: false, keyLast4: null, usernodePubkey: null, walletLinkEnabled: false, aiProgressEstimate: false, locale: null, devFlowPreference: null, externalFlowsAvailable: false },
    _walletPollTimer: null,
    _alertsTestTimer: null,
    _walletExpiresAt: null,
    _walletCountdownTimer: null,
    _cliTokens: [],
    _cliTokenCursor: null,
    _cliTokensLoading: false,
    _cliTokenLoadId: 0,
    // #907: machines currently attached to one of this account's sessions.
    _localAgents: [],
    _connectors: [],
    _connectorLoadId: 0,
    _githubLink: null,

    // ── Screen state ─────────────────────────────────────────────────────
    _open: false,
    // Which section is showing (or would show on a viewport crossing).
    _section: 'api-key',
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
    _mediaBound: false,
    _socialPushStateListener: null,
    // True between an open({ chrome: false }) and the syncChrome() that
    // app.js runs inside the screen transition (#979) — _syncChrome is a
    // no-op while it is set, so nothing writes the platform header before
    // the outgoing page has been captured.
    _chromeSuspended: false,

    // The single source of truth in JS for where the sidebar layout starts.
    // Must stay in step with the `md:` classes in index.html's
    // #settings-screen markup (Tailwind's md breakpoint IS 768px) — same
    // discipline as AdminConsole.DESKTOP_MEDIA.
    DESKTOP_MEDIA: '(min-width: 768px)',

    // Sections. Keys are the #settings/<key> hash segments and the
    // [data-settings-section] wrapper values in index.html; `group` is the
    // heading they sit under — in the desktop sidebar AND in the mobile
    // level-1 menu, which share _groupedSections(). Order here IS menu
    // order, and the first VISIBLE entry is the default section.
    //
    // `gate` names the INNER node whose own `hidden` decides whether the
    // section is offered at all — Usernode Wallet (wallet linking enabled),
    // Usernode app (the native bridge's getSettingsState capability) and
    // Admin preview (a real platform admin). Those gates live in
    // _renderWalletSection / _renderUsernodeSection / _renderAdminSection
    // and are read here, never duplicated. Sections with no `gate` are
    // always offered.
    SECTIONS: [
      { key: 'api-key', label: 'Anthropic API key', group: 'AI & agents' },
      // Own section (not folded into 'cli') so the out-of-credits card can
      // deep-link #settings/connectors as one of its three routes; see
      // public/js/credit-options.js.
      { key: 'connectors', label: 'Claude & ChatGPT connectors', group: 'AI & agents' },
      { key: 'app-ai', label: 'App AI permissions', group: 'AI & agents' },
      { key: 'agent-files', label: 'Agent instructions & skills', group: 'AI & agents' },

      { key: 'password', label: 'Password', group: 'Account' },
      { key: 'wallet', label: 'Usernode Wallet', group: 'Account', gate: 'wallet-section' },

      { key: 'language', label: 'Language', group: 'Preferences' },
      { key: 'alerts', label: 'Dev-chat sound & alerts', group: 'Preferences' },
      { key: 'home-panels', label: 'Home screen widgets', group: 'Preferences' },

      { key: 'cli', label: 'CLI & coding-agent access', group: 'Developer' },
      { key: 'dev-console', label: 'Developer console', group: 'Developer' },
      { key: 'experimental', label: 'Experimental', group: 'Developer' },

      { key: 'usernode', label: 'Usernode app', group: 'Usernode app', gate: 'settings-usernode-section' },

      { key: 'admin-preview', label: 'Admin preview', group: 'Admin', gate: 'settings-admin-section' },
    ],

    // The section a bare #settings resolves to on desktop (and the one
    // _writeHash collapses back onto bare #settings). Must be an ungated
    // key, so it is always reachable.
    DEFAULT_SECTION: 'api-key',

    init() {
      // The entry point is the drawer's Settings row, a real anchor to
      // #settings — restoreFromHash → App.navigateToSettings → open().
      // Every control below is bound ONCE, here, by id: the section markup
      // is static in index.html and only ever hidden/shown, never rebuilt
      // (see the "MOVE, DON'T REWRITE" note on #settings-screen).
      document.getElementById('settings-save').addEventListener('click', () => this.save());
      document.getElementById('settings-remove').addEventListener('click', () => this.remove());

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
      const connectorCopy = document.getElementById('connector-url-copy');
      if (connectorCopy) {
        connectorCopy.addEventListener('click', async () => {
          const field = document.getElementById('connector-url');
          if (!field) return;
          try {
            await navigator.clipboard.writeText(field.value);
          } catch {
            // Clipboard permission denied / insecure context: select the
            // text so the user can copy it themselves.
            field.select();
          }
          connectorCopy.textContent = 'Copied';
          setTimeout(() => { connectorCopy.textContent = 'Copy'; }, 1500);
        });
      }

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

      // Experimental "AI progress estimate" toggle. Server-side per-user
      // flag (default OFF) — fire the POST on change so it takes effect
      // on the next coding run without closing the modal; revert the
      // checkbox if the save fails.
      const estimateToggle = document.getElementById('ai-progress-estimate');
      if (estimateToggle) {
        estimateToggle.addEventListener('change', (e) => this._saveAiProgressEstimate(e.target.checked));
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

      // #138 "Dev-chat sound & alerts" toggle. Client-only preference
      // (localStorage, default ON) owned by DevAlerts — we just mirror its
      // checked state and flip the stored flag. Turning it ON is a user
      // gesture, so unlock audio + request notification permission then.
      const alertsToggle = document.getElementById('devchat-alerts-toggle');
      if (alertsToggle) {
        alertsToggle.checked = window.DevAlerts ? DevAlerts.enabled() : true;
        alertsToggle.addEventListener('change', (e) => {
          if (!window.DevAlerts) return;
          DevAlerts.setEnabled(e.target.checked);
          if (e.target.checked) {
            DevAlerts._unlockAudio();
            DevAlerts.requestNotifyPermission();
          }
        });
      }

      // #138 "Send a test alert" — exercises the user's own setup. Fires a
      // demo completion after a short delay so they can stay (hear the
      // chime) or switch away (see the background notification).
      const alertsTest = document.getElementById('devchat-alerts-test');
      if (alertsTest) {
        alertsTest.addEventListener('click', () => {
          if (!window.DevAlerts) return;
          const status = document.getElementById('devchat-alerts-test-status');
          const ms = DevAlerts.testAlert();
          if (!status) return;
          // Visible countdown that ticks down each second (the previous
          // version set the text once and it looked frozen). Guard against
          // rapid re-clicks by clearing any in-flight countdown first; the
          // same id is cleared on close().
          this._clearAlertsTestCountdown();
          status.classList.remove('hidden');
          let remaining = Math.ceil(ms / 1000);
          const render = () => {
            status.textContent = `Alert in ${remaining}s — stay here for the chime, or switch away / background the app for a notification.`;
          };
          render();
          this._alertsTestTimer = setInterval(() => {
            remaining -= 1;
            if (remaining > 0) {
              render();
              return;
            }
            this._clearAlertsTestCountdown();
            status.textContent = 'Sent — you should hear a chime now (or get a notification if you switched away).';
          }, 1000);
        });
      }

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
      // The persistent header banner has its own "Switch back" link
      // for admins who notice they're in preview mode mid-session.
      const bannerOff = document.getElementById('view-as-non-admin-disable');
      if (bannerOff) {
        bannerOff.addEventListener('click', () => {
          localStorage.removeItem('viewAsNonAdmin');
          window.location.reload();
        });
      }

      // No backdrop / Escape dismissal any more: Settings is a screen, not
      // a modal. Leaving it is a real hash navigation (the header back
      // button, the device back gesture) — see handleBack / _exitSettings.

      this.refresh();
    },

    async refresh() {
      try {
        const r = await fetch('/api/auth/me', { credentials: 'same-origin' });
        if (!r.ok) return;
        const j = await r.json();
        this.state.hasApiKey = !!j.user?.hasApiKey;
        this.state.keyLast4 = j.user?.keyLast4 || null;
        this.state.usernodePubkey = j.user?.usernodePubkey || null;
        this.state.walletLinkEnabled = !!j.user?.walletLinkEnabled;
        this.state.aiProgressEstimate = !!j.user?.aiProgressEstimate;
        this.state.locale = j.user?.locale || null;
        this.state.devFlowPreference = j.user?.devFlowPreference || null;
        this.state.externalFlowsAvailable = !!j.user?.externalFlowsAvailable;
        // Same payload the CLI-credentials gate needs, so prime its memo
        // rather than let it issue a second /api/auth/me. (It still
        // fetches on its own when it runs first — the two orders both
        // resolve to the same deployment-constant answer.)
        this._cliAuthPromise = Promise.resolve(j.user?.cliAuthEnabled !== false);
        this._renderIndicator();
        // `walletLinkEnabled` decides whether the Usernode Wallet row is in
        // the menu at all, and it lands here — possibly AFTER a cold-boot
        // deep link has already painted. Re-resolve the menu.
        this._renderWalletSection();
        // The preference lands here too, and Connections may already be
        // painted (a cold-boot deep link to #settings/connectors renders
        // before this resolves). Same reasoning as the wallet row above.
        this._renderDevFlowSection();
        this._renderNavIfOpen();
      } catch {}
    },

    _renderIndicator() {
      const dot = document.getElementById('drawer-byok-dot');
      if (dot) dot.classList.toggle('hidden', !this.state.hasApiKey);
      // Let dev-chat swap its budget indicator for the BYOK badge
      // without having to observe us directly.
      if (window.DevChat && typeof DevChat.renderBudget === 'function') {
        try { DevChat.renderBudget(); } catch {}
      }
    },

    isOpen() { return Settings._open; },

    // Repaint every section's body. Cheap (they're all local state or a
    // small fetch) and it keeps the ONE render path — a section is never
    // rendered lazily on first reveal, so its controls are correct whether
    // the viewer lands on it or switches to it later.
    _renderAllSections() {
      this._renderBody();
      this._refreshSpend();
      this._renderLlmGrants();
      this._loadCliTokens(true);
      this._loadConnectors();
      this._loadGithubLink();
      this._renderAgentFilesSection();
      this._renderWalletSection();
      this._renderDevFlowSection();
      this._renderChangePasswordSection();
      this._renderDevConsoleSection();
      this._renderLanguageSection();
      this._renderHomePanelsSection();
      this._renderExperimentalSection();
      this._renderAdminSection();
      this._renderUsernodeSection();
      this._clearStatus();
    },

    // `section` is the hash's optional second segment (null for bare
    // #settings). Intentionally do NOT auto-focus the API key field: on
    // mobile, focusing an input on open immediately pops the on-screen
    // keyboard, which is jarring when the user just wanted to view
    // settings. The credits-exhausted banner (#463) deep-links straight to
    // #settings/api-key instead of asking for a scroll.
    // `opts.chrome === false` renders WITHOUT touching the platform
    // header (#979): app.js calls this while #settings-screen is still
    // hidden — invisible, so it may run before the screen transition —
    // but the header title / back icon are visible, and writing them
    // early bakes the incoming screen's chrome into the View Transition's
    // snapshot of the page the user is leaving. The caller runs
    // Settings.syncChrome() inside the transition callback instead.
    open(section, opts) {
      Settings._open = true;
      Settings._pushedFromMenu = false;
      Settings._menuScrollTop = 0;
      Settings._chromeSuspended = !!(opts && opts.chrome === false);
      // Per-mount state: the Usernode-app auto-retry is offered once per
      // visit to Settings, not once per document.
      Settings._usernodeAuthRetryUsed = false;
      Settings._ensureMediaListener();
      Settings._renderAllSections();

      const visible = Settings._visibleSections();
      const valid = !!section && visible.some((s) => s.key === section);
      const fallback = visible.some((s) => s.key === Settings._section)
        ? Settings._section
        : (visible[0] ? visible[0].key : 'api-key');

      // On mobile, a bare #settings means the MENU — never a last-visited
      // section resurrected from earlier in this tab. On desktop it keeps
      // meaning the default section, exactly like the admin console.
      if (Settings._isMobile() && !valid) {
        Settings._level = 1;
        Settings._section = fallback;
        Settings._renderNav();
        Settings._renderContent();
        Settings._syncChrome();
        return;
      }
      Settings._level = 2;
      Settings.setSection(valid ? section : fallback, { writeHash: false });
      // Runs after app.js's own setHeaderTitle, so on a mobile deep link the
      // header ends up showing the section's name rather than "Settings".
      Settings._syncChrome();
    },

    // Re-entry while the screen is ALREADY mounted (app.js routes here
    // instead of re-running the whole screen swap — see navigateToSettings).
    // Mirrors AdminConsole.route.
    route(section) {
      const visible = Settings._visibleSections();
      const valid = !!section && visible.some((s) => s.key === section);
      if (!Settings._isMobile()) {
        Settings.setSection(
          valid ? section : (visible[0] ? visible[0].key : 'api-key'),
          { writeHash: false },
        );
        Settings._level = 2;
        Settings._syncChrome();
        return;
      }
      const targetLevel = valid ? 2 : 1;
      // 1→2 push, 2→1 pop, same level (section→section deep link) instant:
      // the kit's fidelity rule is no animation on same-level repaints.
      const type = targetLevel === Settings._level
        ? 'none'
        : (targetLevel === 2 ? 'push' : 'pop');
      if (targetLevel === 2) {
        Settings._menuScrollTop = Settings._level === 1
          ? Settings._scrollTop()
          : Settings._menuScrollTop;
        Settings._section = section;
      } else {
        Settings._pushedFromMenu = false;
      }
      Settings._level = targetLevel;
      Settings._transition(() => {
        Settings._renderNav();
        Settings._renderContent();
        Settings._syncChrome();
        Settings._restoreScroll();
      }, type);
    },

    // The on-screen back arrow AND the platform header's back button both
    // land here (app.js:back-btn). Returns true when the press was consumed
    // — i.e. mobile, inside a section — so the header falls through to
    // navigateHome() everywhere else (all of desktop included).
    handleBack() {
      if (!Settings._open) return false;
      if (!Settings._isMobile() || Settings._level !== 2) return false;
      if (Settings._pushedFromMenu) {
        // We pushed that entry ourselves, so the one below it IS our menu:
        // popping routes back through popstate → restoreFromHash → route(),
        // the same path the device back gesture takes.
        history.back();
        return true;
      }
      // Deep link (bookmark, a prose "Settings → Change password" link):
      // nothing of ours below. REPLACE the entry with the menu rather than
      // pushing one, so back can't bounce the viewer between the section
      // and the menu forever.
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
            Settings._writeHash(Settings._section);
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
    _visibleSections() {
      return Settings.SECTIONS.filter((s) => {
        if (!s.gate) return true;
        const el = document.getElementById(s.gate);
        return !!el && !el.classList.contains('hidden');
      });
    },

    // The visible sections bucketed by `group`, in first-appearance order.
    // Shared by the desktop sidebar and the mobile level-1 menu so the two
    // can never drift into different groupings.
    _groupedSections() {
      const groups = [];
      for (const s of Settings._visibleSections()) {
        const name = s.group || 'Other';
        let g = groups.find((x) => x.name === name);
        if (!g) { g = { name, items: [] }; groups.push(g); }
        g.items.push(s);
      }
      return groups;
    },

    esc(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },

    // Desktop sidebar rows, grouped under headings.
    _navItemsHtml() {
      const active = Settings._section;
      const itemHtml = (s) => {
        const isActive = s.key === active;
        const cls = 'settings-nav-item block w-full text-left rounded-lg px-3 py-2 text-sm font-medium transition-colors '
          + (isActive
            ? 'bg-violet-600/10 text-violet-600 dark:text-violet-400'
            : 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800');
        return `<button type="button" role="tab" aria-selected="${isActive ? 'true' : 'false'}"
          data-settings-nav="${s.key}" class="${cls}">${Settings.esc(s.label)}</button>`;
      };
      return Settings._groupedSections().map((g, i) => `
        <div class="${i === 0 ? '' : 'mt-4 pt-3 border-t border-zinc-200 dark:border-zinc-800'}">
          <div class="px-3 pb-1 text-[11px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">${Settings.esc(g.name)}</div>
          ${g.items.map(itemHtml).join('')}
        </div>`).join('');
    },

    // Mobile level 1: the section menu. A list, not a tab set — so plain
    // buttons in a <nav>, no role="tab"/aria-selected, and the drawer-row
    // idiom from index.html (44px minimum, hairline between rows, chevron
    // on the right), exactly as the admin console's level-1 menu.
    _mobileMenuHtml() {
      const chevron = '<svg class="w-4 h-4 shrink-0 text-zinc-400 dark:text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>';
      const rowHtml = (s) => `
        <button type="button" data-settings-nav="${s.key}"
                class="settings-menu-row flex items-center gap-3 w-full text-left min-h-[44px] px-4 py-2
                       border-b border-zinc-100 dark:border-zinc-800
                       text-zinc-700 dark:text-zinc-200
                       hover:bg-zinc-50 dark:hover:bg-zinc-800/60 transition-colors">
          <span class="flex-1 min-w-0 text-sm font-medium truncate">${Settings.esc(s.label)}</span>
          ${chevron}
        </button>`;
      return Settings._groupedSections().map((g) => `
        <div class="mb-5">
          <div class="px-4 pb-1.5 text-[11px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">${Settings.esc(g.name)}</div>
          <div class="rounded-lg overflow-hidden border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900
                      [&>button:last-child]:border-b-0">
            ${g.items.map(rowHtml).join('')}
          </div>
        </div>`).join('');
    },

    // Paint BOTH nav hosts. These two elements are the only ones this
    // module ever innerHTML-writes — the section wrappers are static
    // markup and are only ever hidden/shown.
    _renderNav() {
      const side = document.getElementById('settings-nav-desktop');
      if (side) {
        side.innerHTML = Settings._navItemsHtml();
        Settings._wireNavButtons(side);
      }
      const menu = document.getElementById('settings-mobile-menu-host');
      if (menu) {
        // Level 2 on a phone must not leave the menu rows above the
        // section; desktop hides the host through its own md:hidden class.
        const showMenu = Settings._isMobile() && Settings._level === 1;
        menu.innerHTML = showMenu ? Settings._mobileMenuHtml() : '';
        if (showMenu) Settings._wireNavButtons(menu);
      }
    },

    // Every [data-settings-nav] control routes through here. On mobile a
    // press is a DRILL-IN (a real hash navigation that pushes history); on
    // desktop it's an in-place sidebar switch.
    _wireNavButtons(root) {
      if (!root) return;
      root.querySelectorAll('[data-settings-nav]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const key = btn.dataset.settingsNav;
          if (Settings._isMobile()) Settings._openSection(key);
          else Settings.setSection(key);
        });
      });
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

    setSection(key, opts) {
      const visible = Settings._visibleSections();
      if (!visible.some((s) => s.key === key)) {
        key = visible[0] ? visible[0].key : 'api-key';
      }
      Settings._section = key;
      if (!opts || opts.writeHash !== false) Settings._writeHash(key);
      Settings._renderNav();
      Settings._renderContent();
    },

    // Section switches update the address without polluting history —
    // replaceState, and only while we're actually on the #settings route
    // (the AdminConsole._writeHash / Leaderboard._setSub pattern).
    // Entering/leaving the screen still gets a real history entry via
    // normal hash navigation.
    //
    // Mobile writes #settings/api-key rather than bare #settings: down here
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
    // level-1 menu, or exactly one section wrapper.
    _renderContent() {
      const host = document.getElementById('settings-section-content');
      const footer = document.getElementById('settings-footer');
      const menuLevel = Settings._isMobile() && Settings._level === 1;
      if (host) {
        host.classList.toggle('hidden', menuLevel);
        host.querySelectorAll('[data-settings-section]').forEach((el) => {
          el.classList.toggle('hidden', menuLevel || el.dataset.settingsSection !== Settings._section);
        });
      }
      if (footer) Settings._syncFooter();
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
      const parent = document.getElementById(
        mobile ? 'settings-content-col' : 'settings-sidebar-col',
      );
      if (parent && footer.parentElement !== parent) parent.appendChild(footer);
      // On a phone it belongs to the MENU level only — a drilled-in section
      // shouldn't end with a Log out button.
      footer.classList.toggle('hidden', mobile && Settings._level === 2);
    },

    _transition(fn, type) {
      if (window.PlatformUI && PlatformUI.transition) PlatformUI.transition(fn, { type: type || 'none' });
      else fn();
    },

    _scrollTop() {
      const el = document.getElementById('settings-screen');
      return el ? el.scrollTop : 0;
    },

    // A pushed screen starts at the top; a pop restores where the menu was.
    _restoreScroll() {
      const el = document.getElementById('settings-screen');
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
      // #1036: the header control is a real anchor — inside a section
      // the chevron pops to the settings menu, so that is its href.
      if (App.setBackIcon) App.setBackIcon(inSection ? 'arrow' : 'home', inSection ? '#settings' : undefined);
      if (!App.setHeaderTitle) return;
      if (inSection) {
        const s = Settings._visibleSections().find((x) => x.key === Settings._section);
        App.setHeaderTitle(s ? s.label : 'Settings');
      } else {
        App.setHeaderTitle('Settings');
      }
    },

    // Re-resolve the menu after late-arriving state: `walletLinkEnabled`
    // lands with refresh()'s /api/auth/me response and the Usernode-app
    // capability with the bridge's async probe, both of which can resolve
    // AFTER a cold-boot deep link has already painted. Without this the
    // menu would be missing those rows until the next navigation.
    _renderNavIfOpen() {
      if (!Settings._open) return;
      Settings._renderNav();
      // A section that just became unavailable must not stay on screen.
      if (!Settings._visibleSections().some((s) => s.key === Settings._section)) {
        Settings.setSection(Settings._section);
      }
    },

    _renderDevConsoleSection() {
      const toggle = document.getElementById('dev-console-always-show');
      if (!toggle) return;
      const mode = window.DevConsole ? DevConsole.getMode() : 'errors-only';
      toggle.checked = mode === 'always';
    },

    _renderExperimentalSection() {
      const toggle = document.getElementById('ai-progress-estimate');
      if (toggle) toggle.checked = !!this.state.aiProgressEstimate;
      const status = document.getElementById('ai-progress-estimate-status');
      if (status) { status.classList.add('hidden'); status.textContent = ''; }
      this._renderLocalAgentsSection();
    },

    // #907: the machines currently attached to one of this account's dev
    // sessions. GET /api/me/local-agents is deliberately NOT part of the CLI
    // token surface — a lease is routing state, not a credential — so unlike
    // the token list above it answers on staging too.
    //
    // The block hides itself outright when nothing is attached. An empty
    // "Local coding agent — none" panel would be noise on every account that
    // has never used the CLI, which is nearly all of them.
    async _renderLocalAgentsSection() {
      const section = document.getElementById('settings-local-agents-section');
      const list = document.getElementById('settings-local-agents-list');
      const status = document.getElementById('settings-local-agents-status');
      if (!section || !list) return;
      if (status) { status.classList.add('hidden'); status.textContent = ''; }

      let agents = [];
      try {
        const query = this._cliTokensDemo() ? '?demo=1' : '';
        const r = await fetch(`/api/me/local-agents${query}`, { credentials: 'same-origin' });
        if (r.ok) {
          const j = await r.json();
          if (Array.isArray(j.agents)) agents = j.agents;
        }
      } catch {}

      this._localAgents = agents;
      section.classList.toggle('hidden', agents.length === 0);
      list.textContent = '';
      for (const agent of agents) {
        list.appendChild(this._localAgentCard(agent));
      }
      if (status && agents.some((a) => a.demo)) {
        status.textContent = 'Demo data — changes are not saved.';
        status.classList.remove('hidden', 'text-red-500', 'text-emerald-500');
      }
    },

    // Built with DOM calls rather than innerHTML: the label is free text the
    // user typed on their own machine and arrives here verbatim.
    _localAgentCard(agent) {
      const card = document.createElement('div');
      card.className = 'rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2';

      const top = document.createElement('div');
      top.className = 'flex items-start justify-between gap-3';
      const text = document.createElement('div');
      text.className = 'min-w-0';

      const title = document.createElement('div');
      title.className = 'text-sm font-medium text-zinc-800 dark:text-zinc-200 truncate';
      title.textContent = agent.label || 'Unnamed machine';

      const where = document.createElement('div');
      where.className = 'text-xs text-zinc-500 dark:text-zinc-400 mt-1 truncate';
      const app = agent.appName || agent.appSlug || 'an app';
      where.textContent = agent.sessionTitle
        ? `${app} · ${agent.sessionTitle}` : String(app);

      const detail = document.createElement('div');
      detail.className = 'text-xs text-zinc-500 dark:text-zinc-400 mt-0.5';
      const seen = Number.isFinite(Date.parse(agent.lastSeenAt))
        ? new Date(agent.lastSeenAt).toLocaleTimeString() : 'unknown';
      detail.textContent = `${agent.runtime || 'claude-code'} · last seen ${seen}`;

      text.append(title, where, detail);
      top.appendChild(text);

      // Demo rows (staging ?demo=1) are fabricated per request and own no
      // lease, so there is nothing for a button to release.
      if (!agent.demo && agent.leaseId) {
        const detach = document.createElement('button');
        detach.type = 'button';
        detach.className = 'shrink-0 rounded border border-zinc-400 dark:border-zinc-600 px-2 py-1 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors';
        detach.textContent = 'Detach';
        detach.addEventListener('click', () => this._detachLocalAgent(agent, detach));
        top.appendChild(detach);
      }
      card.appendChild(top);
      return card;
    },

    // Releasing from here must not need the machine to cooperate: the common
    // case is a laptop that was closed or lost its network, and the whole
    // point is to get the session's turns back without waiting out the lease.
    async _detachLocalAgent(agent, button) {
      const label = agent.label || 'this machine';
      if (!window.confirm(`Detach ${label}?\n\nIts session's coding turns go back to running on Usernode. Anything it already committed stays on the branch.`)) return;
      const status = document.getElementById('settings-local-agents-status');
      button.disabled = true;
      try {
        const r = await fetch(`/api/me/local-agents/${encodeURIComponent(agent.leaseId)}`, {
          method: 'DELETE',
          credentials: 'same-origin',
        });
        // 404 means it already went away (it detached itself, or the sweeper
        // expired it) — the user's intent is satisfied either way.
        if (r.status !== 204 && r.status !== 404) throw new Error('Could not detach that machine.');
        await this._renderLocalAgentsSection();
      } catch (err) {
        button.disabled = false;
        if (status) {
          status.textContent = err.message || 'Could not detach that machine.';
          status.classList.remove('hidden', 'text-emerald-500');
          status.classList.add('text-red-500');
        }
      }
    },

    // #911: one checkbox per home-screen panel, built from
    // GET /api/home-panels's `registry` + `hidden`. Absence from `hidden`
    // means visible, so a fresh account renders every box ticked without
    // any per-user rows existing. Rebuilt (not patched) on each render:
    // the list is two lines of markup and the listeners go with it.
    async _renderHomePanelsSection() {
      const list = document.getElementById('settings-home-panels-list');
      if (!list) return;
      const status = document.getElementById('settings-home-panels-status');
      if (status) { status.classList.add('hidden'); status.textContent = ''; }
      let data = null;
      try {
        const r = await fetch('/api/home-panels', { credentials: 'same-origin' });
        if (r.ok) data = await r.json();
      } catch {}
      const registry = (data && Array.isArray(data.registry)) ? data.registry : [];
      const hidden = (data && Array.isArray(data.hidden)) ? data.hidden : [];
      if (!registry.length) {
        list.innerHTML = '<p class="text-xs text-zinc-500 dark:text-zinc-400">No home screen widgets are available.</p>';
        return;
      }
      const esc = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      // `removable: false` (Discover) renders as a fixed-on, disabled switch
      // with the reason beside it, rather than being hidden from the list:
      // a widget that is silently absent from its own settings row reads as
      // a bug, where a locked one reads as a decision. The server refuses
      // the write too, so this is presentation, not the enforcement.
      //
      // Every other row is offered to EVERY account — notably "Create app",
      // which appears whether or not the viewer currently has app quota,
      // because the widget is on their home screen either way.
      list.innerHTML = registry.map((p) => {
        const fixed = p.removable === false;
        return `
        <label class="flex items-center gap-2 select-none ${fixed ? 'cursor-default' : 'cursor-pointer'}">
          <input type="checkbox" class="un-switch settings-home-panel-toggle"
                 data-panel-key="${esc(p.key)}" ${hidden.includes(p.key) ? '' : 'checked'}
                 ${fixed ? 'disabled' : ''} />
          <span class="text-sm text-zinc-800 dark:text-zinc-200">${esc(p.title || p.key)}</span>
          ${fixed ? '<span class="text-xs text-zinc-500 dark:text-zinc-400">— how you find new apps</span>' : ''}
        </label>`;
      }).join('');
      list.querySelectorAll('.settings-home-panel-toggle').forEach((el) => {
        if (el.disabled) return;
        el.addEventListener('change', () => {
          Settings._saveHomePanelVisibility(el.dataset.panelKey, !el.checked, el);
        });
      });
    },

    async _saveHomePanelVisibility(key, hidden, toggle) {
      const status = document.getElementById('settings-home-panels-status');
      try {
        const r = await fetch(`/api/home-panels/${encodeURIComponent(key)}/visibility`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ hidden: !!hidden }),
        });
        if (!r.ok) throw new Error('save failed');
        // Repaint the home card straight away so returning to the home
        // screen doesn't show the stale state for up to a TTL.
        if (window.HomePanels) {
          try { await HomePanels.ensureLoaded({ force: true }); } catch {}
        }
        if (status) { status.classList.add('hidden'); status.textContent = ''; }
      } catch (err) {
        if (toggle) toggle.checked = !hidden;
        if (status) {
          status.textContent = 'Failed to save — try again.';
          status.classList.remove('hidden', 'text-emerald-500');
          status.classList.add('text-red-500');
        }
      }
    },

    _renderLanguageSection() {
      const select = document.getElementById('settings-locale');
      if (!select) return;
      const value = this.state.locale || '';
      // A saved value outside the curated list (set via the API, or a
      // future wider picker) still needs to render truthfully — inject
      // an option for it so the select doesn't silently show "Auto".
      if (value && ![...select.options].some((o) => o.value === value)) {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = value;
        select.appendChild(opt);
      }
      select.value = value;
      const status = document.getElementById('settings-locale-status');
      if (status) { status.classList.add('hidden'); status.textContent = ''; }
    },

    // "Preferred build flow" (#1049) — the escape hatch for the dev-chat
    // picker's "remember my option" checkbox. Once a user ticks that box the
    // picker stops rendering, so there has to be somewhere to change their
    // mind; Connections is where the GitHub link and the connectors already
    // live, which is exactly the machinery the external flows depend on.
    //
    // The markup is BUILT HERE rather than in frontend/src/Shell.tsx: the
    // shell's body is frozen against tests/fixtures/pre-migration-index.html
    // by tests/shell-markup-parity.test.js (no new elements, no attribute
    // changes), so a new settings control has to be injected at runtime.
    // Idempotent — _renderAllSections and refresh() both call it.
    _renderDevFlowSection() {
      const host = document.querySelector('[data-settings-section="connectors"]');
      if (!host) return;
      let block = document.getElementById('dev-flow-pref-section');
      if (!block) {
        block = document.createElement('div');
        block.id = 'dev-flow-pref-section';
        block.className = 'mt-6 pt-6 border-t border-zinc-200 dark:border-zinc-800';
        block.innerHTML = `
          <h3 class="text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-1">Preferred build flow</h3>
          <p class="text-xs text-zinc-500 dark:text-zinc-500 mb-3 leading-relaxed">
            When you start a proposal, Usernode can ask how you want to build it — here on the
            platform with the Usernode agent, or by handing the work order to your own Claude Code
            or Codex web session. Pick one here to skip the question; choose
            <strong class="font-semibold text-zinc-600 dark:text-zinc-400">Ask me every time</strong>
            to get the picker back.
          </p>
          <select id="settings-dev-flow"
            class="w-full rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500">
            <option value="">Ask me every time</option>
            <option value="platform">Build on Usernode</option>
            <option value="claude-code">Claude Code (claude.ai/code)</option>
            <option value="codex">Codex (chatgpt.com/codex)</option>
          </select>
          <div id="settings-dev-flow-status" class="text-xs mt-2 hidden"></div>
        `;
        // Above the GitHub link block when it exists, so the preference reads
        // as the question and the link below it as one of the answers.
        const anchor = document.getElementById('github-link-section');
        if (anchor) host.insertBefore(block, anchor);
        else host.appendChild(block);
      }
      const select = block.querySelector('#settings-dev-flow');
      if (select && !select.__devFlowWired) {
        select.__devFlowWired = true;
        select.addEventListener('change', (e) => this._saveDevFlow(e.target.value));
      }
      // A deployment without the external flows can still express "always
      // build on Usernode" vs "ask me" — just not the two hand-offs.
      block.querySelectorAll('option[value="claude-code"], option[value="codex"]').forEach((opt) => {
        opt.disabled = !this.state.externalFlowsAvailable;
      });
      if (select) select.value = this.state.devFlowPreference || '';
      const status = block.querySelector('#settings-dev-flow-status');
      if (status) { status.classList.add('hidden'); status.textContent = ''; }
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

    _cliAuthAvailable() {
      if (!this._cliAuthPromise) {
        this._cliAuthPromise = (async () => {
          try {
            const r = await fetch('/api/auth/me', { credentials: 'same-origin' });
            if (!r.ok) return true;
            const j = await r.json();
            return j.user?.cliAuthEnabled !== false;
          } catch { return true; }
        })();
      }
      return this._cliAuthPromise;
    },

    // True when the page carries ?demo=1. The server only honours it in
    // staging (see routes/cli-auth.js), so this is safe to send always.
    _cliTokensDemo() {
      try {
        return new URLSearchParams(window.location.search).get('demo') === '1';
      } catch { return false; }
    },

    // ── Claude & ChatGPT connectors ──────────────────────────────────────
    //
    // Same shape as the CLI-credentials block below: a load-generation
    // guard so a slow response can't repaint stale credential state over a
    // fresh one, and the page's ?demo=1 passed through (mcp_tokens is
    // staging:private, so a staging clone would render an empty panel).

    async _loadConnectors() {
      const section = document.getElementById('connectors-section');
      const list = document.getElementById('connectors-list');
      const status = document.getElementById('connectors-status');
      if (!section || !list || !status) return;

      // The connector URL is derived from the origin the SPA is served
      // from, so a self-hosted fork shows its own.
      const urlField = document.getElementById('connector-url');
      if (urlField) urlField.value = `${window.location.origin}/mcp`;

      this._connectorLoadId = (this._connectorLoadId || 0) + 1;
      const loadId = this._connectorLoadId;
      list.textContent = 'Loading connections…';
      status.classList.add('hidden');

      try {
        const demoQ = this._cliTokensDemo() ? '?demo=1' : '';
        const response = await fetch(`/api/me/connectors${demoQ}`, {
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (loadId !== this._connectorLoadId) return;
        if (response.status === 404) {
          // The connector surface is production-only; hide rather than
          // showing a section that can't work here.
          section.classList.add('hidden');
          return;
        }
        if (!response.ok) throw new Error('Could not load your connections.');
        const data = await response.json();
        if (!data || !Array.isArray(data.connectors)) {
          throw new Error('The connections response was invalid.');
        }
        section.classList.remove('hidden');
        this._connectors = data.connectors;
        this._renderConnectors();
      } catch (err) {
        if (loadId !== this._connectorLoadId) return;
        list.textContent = '';
        status.textContent = err.message || 'Could not load your connections.';
        status.classList.remove('hidden', 'text-emerald-500');
        status.classList.add('text-red-500');
      }
    },

    _renderConnectors() {
      const list = document.getElementById('connectors-list');
      if (!list) return;
      list.textContent = '';
      const connectors = this._connectors || [];
      if (!connectors.length) {
        const empty = document.createElement('p');
        empty.className = 'text-xs text-zinc-500 dark:text-zinc-400';
        empty.textContent = 'No chat products connected yet.';
        list.appendChild(empty);
        return;
      }
      for (const connector of connectors) {
        const card = document.createElement('div');
        card.className = 'rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2';

        const top = document.createElement('div');
        top.className = 'flex items-start justify-between gap-3';
        const text = document.createElement('div');
        text.className = 'min-w-0';
        const title = document.createElement('div');
        title.className = 'text-sm font-medium text-zinc-800 dark:text-zinc-200';
        title.textContent = connector.client_name || 'Connected client';
        const detail = document.createElement('div');
        detail.className = 'text-xs text-zinc-500 dark:text-zinc-400 mt-1';
        const connected = Number.isFinite(Date.parse(connector.connected_at))
          ? new Date(connector.connected_at).toLocaleString() : 'unknown date';
        const used = connector.last_used_at && Number.isFinite(Date.parse(connector.last_used_at))
          ? ` · last used ${new Date(connector.last_used_at).toLocaleString()}`
          : ' · never used';
        detail.textContent = `connected ${connected}${used}`;
        text.append(title, detail);

        const disconnect = document.createElement('button');
        disconnect.type = 'button';
        disconnect.className = 'shrink-0 rounded-md border border-red-400 dark:border-red-700 px-2 py-1 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950 transition-colors';
        disconnect.textContent = 'Disconnect';
        disconnect.addEventListener('click', () => this._disconnectConnector(connector.id, disconnect));

        top.append(text, disconnect);
        card.appendChild(top);
        list.appendChild(card);
      }
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
          throw new Error('Could not disconnect. Try again.');
        }
        await this._loadConnectors();
        if (status) {
          status.textContent = 'Disconnected.';
          status.classList.remove('hidden', 'text-red-500');
          status.classList.add('text-emerald-500');
        }
      } catch (err) {
        if (button) button.disabled = false;
        if (status) {
          status.textContent = err.message || 'Could not disconnect.';
          status.classList.remove('hidden', 'text-emerald-500');
          status.classList.add('text-red-500');
        }
      }
    },

    // ── Verified GitHub account link ─────────────────────────────────────

    async _loadGithubLink() {
      const section = document.getElementById('github-link-section');
      const body = document.getElementById('github-link-body');
      if (!section || !body) return;
      body.textContent = 'Loading…';
      try {
        const demoQ = this._cliTokensDemo() ? '?demo=1' : '';
        const response = await fetch(`/api/me/github${demoQ}`, {
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (response.status === 404 || !response.ok) {
          section.classList.add('hidden');
          return;
        }
        const data = await response.json();
        section.classList.remove('hidden');
        this._githubLink = data || { linked: false };
        this._renderGithubLink();
      } catch {
        section.classList.add('hidden');
      }
    },

    _renderGithubLink() {
      const body = document.getElementById('github-link-body');
      const status = document.getElementById('github-link-status');
      if (!body) return;
      body.textContent = '';
      if (status) status.classList.add('hidden');
      const link = this._githubLink || { linked: false };

      // No OAuth app configured on this deployment: say so plainly rather
      // than offering a button that 404s.
      if (link.available === false) {
        const note = document.createElement('p');
        note.className = 'text-xs text-zinc-500 dark:text-zinc-400';
        note.textContent = 'GitHub linking is not configured on this deployment.';
        body.appendChild(note);
        return;
      }

      if (link.linked) {
        const row = document.createElement('div');
        row.className = 'flex items-center justify-between gap-3 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2';
        const text = document.createElement('div');
        text.className = 'min-w-0';
        const login = document.createElement('div');
        login.className = 'text-sm font-mono text-zinc-800 dark:text-zinc-200';
        login.textContent = link.login || 'linked';
        const when = document.createElement('div');
        when.className = 'text-xs text-zinc-500 dark:text-zinc-400 mt-1';
        when.textContent = link.linkedAt && Number.isFinite(Date.parse(link.linkedAt))
          ? `linked ${new Date(link.linkedAt).toLocaleString()}`
          : 'linked';
        text.append(login, when);
        // The whole point of the identity-only link: say plainly that no
        // credential is held, rather than leaving the user to infer it from
        // the consent screen they saw once. Driven by the server's `access`
        // field so a future shape can render differently instead of this
        // line quietly lying.
        if (link.access === 'identity') {
          const noToken = document.createElement('div');
          noToken.id = 'github-link-no-token';
          noToken.className = 'text-xs text-zinc-500 dark:text-zinc-400 mt-1';
          noToken.textContent = 'Usernode holds no GitHub access token for your account.';
          text.appendChild(noToken);
        }

        const unlink = document.createElement('button');
        unlink.type = 'button';
        unlink.className = 'shrink-0 rounded-md border border-red-400 dark:border-red-700 px-2 py-1 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950 transition-colors';
        unlink.textContent = 'Disconnect';
        unlink.addEventListener('click', () => this._unlinkGithub(unlink));
        row.append(text, unlink);
        body.appendChild(row);
        body.appendChild(this._githubAuditNote());
        return;
      }

      // A full-page navigation, not fetch: the GitHub consent screen has to
      // be shown to the user in a top-level document.
      const connect = document.createElement('a');
      connect.href = '/api/me/github/connect';
      connect.className = 'inline-block rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-medium text-white transition-colors';
      connect.textContent = 'Connect GitHub';
      body.appendChild(connect);
      body.appendChild(this._githubAuditNote());
    },

    // "Don't take our word for it": GitHub's own page lists what every
    // authorized OAuth app can reach, so the claim above is checkable in one
    // click. Deliberately a top-level link (target=_blank + noopener) — the
    // shell is framed, and github.com refuses to be framed.
    _githubAuditNote() {
      const note = document.createElement('p');
      note.id = 'github-link-audit-note';
      note.className = 'text-xs text-zinc-500 dark:text-zinc-500 mt-2';
      note.appendChild(document.createTextNode('You can check what Usernode is allowed to do at '));
      const anchor = document.createElement('a');
      anchor.href = 'https://github.com/settings/applications';
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      anchor.className = 'text-violet-600 dark:text-violet-400 hover:underline';
      anchor.textContent = 'github.com/settings/applications';
      note.appendChild(anchor);
      note.appendChild(document.createTextNode('.'));
      return note;
    },

    async _unlinkGithub(button) {
      const status = document.getElementById('github-link-status');
      if (button) button.disabled = true;
      try {
        const response = await fetch('/api/me/github', {
          method: 'DELETE',
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (!response.ok) throw new Error('Could not disconnect GitHub.');
        await this._loadGithubLink();
      } catch (err) {
        if (button) button.disabled = false;
        if (status) {
          status.textContent = err.message || 'Could not disconnect GitHub.';
          status.classList.remove('hidden', 'text-emerald-500');
          status.classList.add('text-red-500');
        }
      }
    },

    async _loadCliTokens(reset) {
      const section = document.getElementById('cli-tokens-section');
      const list = document.getElementById('cli-tokens-list');
      const more = document.getElementById('cli-tokens-more');
      const status = document.getElementById('cli-tokens-status');
      if (!section || !list || !more || !status) return;

      // Don't ask for a surface this deployment doesn't serve — the 404
      // would be a console error even though the code below handles it.
      // Hiding the section is the same outcome the 404 branch produces,
      // so staging and production differ only in whether the request is
      // made at all.
      if (!(await this._cliAuthAvailable())) {
        section.classList.add('hidden');
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
        list.textContent = 'Loading credentials…';
        more.classList.add('hidden');
        status.classList.add('hidden');
      }
      const loadId = this._cliTokenLoadId;
      this._cliTokensLoading = true;
      more.disabled = true;
      try {
        // The page's ?demo=1 is passed through so the (staging:private,
        // therefore always-empty in a staging clone) credential list has
        // something to render — same pattern as _renderLlmGrants and
        // _renderAgentFilesSection. Strictly a no-op in production.
        const query = this._cliTokenCursor
          ? `?limit=50&cursor=${encodeURIComponent(this._cliTokenCursor)}`
          : '?limit=50';
        const demoQ = this._cliTokensDemo() ? '&demo=1' : '';
        const response = await fetch(`/api/me/cli-tokens${query}${demoQ}`, {
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (loadId !== this._cliTokenLoadId) return;
        if (response.status === 404) {
          section.classList.add('hidden');
          return;
        }
        if (!response.ok) throw new Error('Could not load CLI credentials.');
        const data = await response.json();
        if (!data || !Array.isArray(data.tokens)
            || (data.next_cursor != null && typeof data.next_cursor !== 'string')) {
          throw new Error('The credential list response was invalid.');
        }
        section.classList.remove('hidden');
        this._cliTokens.push(...data.tokens);
        this._cliTokenCursor = data.next_cursor || null;
        this._renderCliTokens();
      } catch (err) {
        if (loadId !== this._cliTokenLoadId) return;
        if (!this._cliTokens.length) list.textContent = '';
        status.textContent = err.message || 'Could not load CLI credentials.';
        status.classList.remove('hidden', 'text-emerald-500');
        status.classList.add('text-red-500');
      } finally {
        if (loadId === this._cliTokenLoadId) {
          this._cliTokensLoading = false;
          more.disabled = false;
        }
      }
    },

    _renderCliTokens() {
      const list = document.getElementById('cli-tokens-list');
      const more = document.getElementById('cli-tokens-more');
      const status = document.getElementById('cli-tokens-status');
      if (!list || !more || !status) return;
      list.textContent = '';
      status.classList.add('hidden');
      if (!this._cliTokens.length) {
        const empty = document.createElement('p');
        empty.className = 'text-xs text-zinc-500 dark:text-zinc-400';
        empty.textContent = 'No CLI credentials.';
        list.appendChild(empty);
      }
      for (const token of this._cliTokens) {
        const card = document.createElement('div');
        card.className = 'rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2';

        const top = document.createElement('div');
        top.className = 'flex items-start justify-between gap-3';
        const text = document.createElement('div');
        text.className = 'min-w-0';
        const title = document.createElement('div');
        title.className = 'text-sm font-mono text-zinc-800 dark:text-zinc-200';
        title.textContent = typeof token.token_hint === 'string'
          ? token.token_hint : 'CLI credential';
        const detail = document.createElement('div');
        detail.className = 'text-xs text-zinc-500 dark:text-zinc-400 mt-1';
        const created = Number.isFinite(Date.parse(token.created_at))
          ? new Date(token.created_at).toLocaleString() : 'unknown date';
        const used = token.last_used_at && Number.isFinite(Date.parse(token.last_used_at))
          ? ` · last used ${new Date(token.last_used_at).toLocaleString()}` : '';
        detail.textContent = `${token.status || 'unknown'} · created ${created}${used}`;
        text.append(title, detail);
        top.appendChild(text);

        // Demo rows (staging ?demo=1) are fabricated server-side and have
        // nothing to revoke — offer no button, same stance as the demo
        // agent-files rows.
        if (token.status === 'valid' && typeof token.id === 'string' && !token.demo) {
          const revoke = document.createElement('button');
          revoke.type = 'button';
          revoke.className = 'shrink-0 rounded border border-red-400 dark:border-red-700 px-2 py-1 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950 transition-colors';
          revoke.textContent = 'Revoke';
          revoke.addEventListener('click', () => this._revokeCliToken(token.id, revoke));
          top.appendChild(revoke);
        }
        card.appendChild(top);
        list.appendChild(card);
      }
      more.classList.toggle('hidden', !this._cliTokenCursor);
      if (this._cliTokensDemo() && this._cliTokens.some((t) => t.demo)) {
        status.textContent = 'Demo data — changes are not saved.';
        status.classList.remove('hidden', 'text-red-500', 'text-emerald-500');
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
        if (response.status !== 204) throw new Error('Could not revoke the credential.');
        if (status) {
          status.textContent = 'Credential revoked.';
          status.classList.remove('hidden', 'text-red-500');
          status.classList.add('text-emerald-500');
        }
        await this._loadCliTokens(true);
      } catch (err) {
        if (status) {
          status.textContent = err.message || 'Could not revoke the credential.';
          status.classList.remove('hidden', 'text-emerald-500');
          status.classList.add('text-red-500');
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
          status.classList.remove('hidden', 'text-emerald-500', 'text-zinc-500');
          status.classList.add('text-red-500');
        }
      };
      try {
        const r = await fetch('/api/me/locale', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ locale: value || null }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return fail(j.error || 'Failed to save.');
        this.state.locale = j.locale || null;
        // Keep the shell's cached user in sync so the bridge's
        // getUserLocale answers (app-view.js) reflect the new value
        // without a re-fetch. Bare `App` — app.js declares it with
        // `const`, so `window.App` is undefined (see _renderAdminSection).
        if (typeof App !== 'undefined' && App.user) App.user.locale = this.state.locale;
        // Live-update any open app iframe (usernode:locale-changed).
        if (window.AppView && typeof AppView.notifyLocaleChanged === 'function') {
          try { AppView.notifyLocaleChanged(this.state.locale); } catch {}
        }
        if (status) {
          status.textContent = '✓ Saved';
          status.classList.remove('hidden', 'text-red-500', 'text-zinc-500');
          status.classList.add('text-emerald-500');
        }
      } catch (err) {
        fail(`Network error: ${err.message}`);
      }
    },

    // Same shape as _saveLocale: POST on change, revert the select and paint
    // the status line on failure, mirror onto App.user so anything reading
    // the cached user (the dev-chat picker) sees the new value immediately.
    async _saveDevFlow(value) {
      const select = document.getElementById('settings-dev-flow');
      const status = document.getElementById('settings-dev-flow-status');
      const fail = (msg) => {
        if (select) select.value = this.state.devFlowPreference || '';
        if (status) {
          status.textContent = msg;
          status.classList.remove('hidden', 'text-emerald-500', 'text-zinc-500');
          status.classList.add('text-red-500');
        }
      };
      try {
        const r = await fetch('/api/me/dev-flow', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ flow: value || null }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return fail(j.error || 'Failed to save.');
        this.state.devFlowPreference = j.flow || null;
        if (typeof App !== 'undefined' && App.user) App.user.devFlowPreference = this.state.devFlowPreference;
        if (status) {
          status.textContent = '✓ Saved';
          status.classList.remove('hidden', 'text-red-500', 'text-zinc-500');
          status.classList.add('text-emerald-500');
        }
      } catch (err) {
        fail(`Network error: ${err.message}`);
      }
    },

    async _saveAiProgressEstimate(enabled) {
      const toggle = document.getElementById('ai-progress-estimate');
      const status = document.getElementById('ai-progress-estimate-status');
      const fail = (msg) => {
        if (toggle) toggle.checked = !!this.state.aiProgressEstimate;
        if (status) {
          status.textContent = msg;
          status.classList.remove('hidden', 'text-emerald-500', 'text-zinc-500');
          status.classList.add('text-red-500');
        }
      };
      try {
        const r = await fetch('/api/me/ai-progress-estimate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ enabled: !!enabled }),
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          return fail(j.error || 'Failed to save.');
        }
        this.state.aiProgressEstimate = !!enabled;
        if (status) { status.classList.add('hidden'); status.textContent = ''; }
      } catch (err) {
        fail(`Network error: ${err.message}`);
      }
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
      if (!section || !toggle) return;
      // Read the bare `App` identifier rather than `window.App` —
      // app.js declares `App` with `const`, which does NOT write to
      // `window` in non-module browser scripts, so `window.App` is
      // undefined. Using the bare identifier matches the rest of the
      // codebase (dev-chat.js etc.). Fallback to `App.user.isAdmin`
      // covers a stale-cached app.js from before `_realIsAdmin` was
      // introduced; safe because a stale app.js can't have applied
      // the mask either, so the live value still reflects the server
      // truth. `??` (not `||`) so an explicit `false` from a current
      // app.js wins over the fallback.
      const realAdmin = (typeof App !== 'undefined' ? App._realIsAdmin : undefined)
        ?? (typeof App !== 'undefined' && !!App.user?.isAdmin);
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
      const input = document.getElementById('settings-api-key');
      if (input) input.value = '';
      this._stopWalletPolling();
      this._clearAlertsTestCountdown();
      this._clearUsernodeAuthStatusRetry();
    },

    // Clear the "Send a test alert" countdown interval (#138). Idempotent —
    // safe to call when none is running (rapid re-clicks, modal close).
    _clearAlertsTestCountdown() {
      if (this._alertsTestTimer) {
        clearInterval(this._alertsTestTimer);
        this._alertsTestTimer = null;
      }
    },

    _renderBody() {
      const display = document.getElementById('settings-key-display');
      const last4 = document.getElementById('settings-key-last4');
      const removeBtn = document.getElementById('settings-remove');
      const saveBtn = document.getElementById('settings-save');
      const input = document.getElementById('settings-api-key');

      if (this.state.hasApiKey) {
        display.classList.remove('hidden');
        last4.textContent = this.state.keyLast4 || '••••';
        removeBtn.classList.remove('hidden');
        input.placeholder = 'Paste a new key to replace';
        saveBtn.textContent = 'Replace';
      } else {
        display.classList.add('hidden');
        removeBtn.classList.add('hidden');
        input.placeholder = 'sk-ant-...';
        saveBtn.textContent = 'Save';
      }
    },

    // #119 — "Today's spend" breakdown in the API-key section. Fetched
    // fresh on every modal open; the block stays hidden while loading,
    // on fetch failure, or when no key is saved, so it never shows
    // stale or irrelevant figures.
    async _refreshSpend() {
      const block = document.getElementById('settings-spend');
      if (!block) return;
      block.classList.add('hidden');
      if (!this.state.hasApiKey) return;
      try {
        const r = await fetch('/api/budget', { credentials: 'same-origin' });
        if (!r.ok) return;
        const b = await r.json();
        document.getElementById('settings-spend-byok').textContent =
          '$' + ((b.byokSpentCents || 0) / 100).toFixed(2);
        document.getElementById('settings-spend-platform').textContent =
          '$' + ((b.spentCents || 0) / 100).toFixed(2) + ' of $' + ((b.limitCents || 0) / 100).toFixed(2);
        block.classList.remove('hidden');
      } catch {}
    },

    _setStatus(text, kind) {
      const el = document.getElementById('settings-status');
      el.textContent = text;
      el.classList.remove('hidden', 'text-red-500', 'text-emerald-500', 'text-zinc-500');
      const cls = kind === 'error' ? 'text-red-500'
                : kind === 'ok' ? 'text-emerald-500'
                : 'text-zinc-500';
      el.classList.add(cls);
    },

    _clearStatus() {
      const el = document.getElementById('settings-status');
      el.classList.add('hidden');
      el.textContent = '';
    },

    async save() {
      const input = document.getElementById('settings-api-key');
      const saveBtn = document.getElementById('settings-save');
      const removeBtn = document.getElementById('settings-remove');
      const key = input.value.trim();
      if (!key) {
        // When replacing but the user hit Save with an empty input,
        // that's almost certainly a misclick — treat as a no-op rather
        // than clearing the existing key.
        this._setStatus('Paste an API key first.', 'error');
        return;
      }

      this._setStatus('Verifying with Anthropic…', 'info');
      saveBtn.disabled = true;
      removeBtn.disabled = true;

      try {
        const r = await fetch('/api/me/api-key', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ key }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          this._setStatus(j.error || 'Failed to save key.', 'error');
          return;
        }
        this.state.hasApiKey = true;
        this.state.keyLast4 = j.keyLast4 || key.slice(-4);
        this._renderIndicator();
        this._setStatus('Saved. Your chats now bill to your Anthropic account.', 'ok');
        input.value = '';
        this._renderBody();
        this._refreshSpend();
        // Settings is a screen now, not a modal — a successful save leaves
        // the success status visible in place instead of navigating away.
      } catch (err) {
        this._setStatus(`Network error: ${err.message}`, 'error');
      } finally {
        saveBtn.disabled = false;
        removeBtn.disabled = false;
      }
    },

    // ── Change password (issue #282) ─────────────────────────────
    _setCpStatus(text, kind) {
      const el = document.getElementById('cp-status');
      if (!el) return;
      el.textContent = text;
      el.classList.remove('hidden', 'text-red-500', 'text-emerald-500', 'text-zinc-500');
      const cls = kind === 'error' ? 'text-red-500' : kind === 'ok' ? 'text-emerald-500' : 'text-zinc-500';
      el.classList.add(cls);
    },

    // Decide whether the wallet option is even offered, then default to
    // the password form. The "Use your wallet instead" link only appears
    // in the Usernode native app (signMessage available) AND when the
    // logged-in account has a linked wallet to prove control of.
    _renderChangePasswordSection() {
      const section = document.getElementById('change-password-section');
      if (!section) return;
      const isNative = !!(window.usernode && window.usernode.isNative);
      this._walletChangeAvailable = isNative && !!this.state.usernodePubkey;
      // Clear any stale field values / status on each open.
      ['cp-current', 'cp-new', 'cp-confirm'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });
      const status = document.getElementById('cp-status');
      if (status) { status.classList.add('hidden'); status.textContent = ''; }
      this._setChangePasswordMode('password');
    },

    _setChangePasswordMode(mode) {
      // In password mode (or when wallet isn't available) show the
      // current-password field + the normal submit, and offer the
      // "use your wallet" link only if it's available. In wallet mode hide
      // the current-password field, swap the submit, and offer the way back.
      const wallet = mode === 'wallet' && this._walletChangeAvailable;
      const show = (id, on) => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('hidden', !on);
      };
      show('cp-current-row', !wallet);
      show('cp-save', !wallet);
      show('cp-wallet-save', wallet);
      // Offer the "switch to wallet" link only in password mode and only
      // when wallet change is available; offer the way back in wallet mode.
      show('cp-wallet-mode', !wallet && this._walletChangeAvailable);
      show('cp-password-mode', wallet);
    },

    async changePasswordWithWallet() {
      const newEl = document.getElementById('cp-new');
      const confirmEl = document.getElementById('cp-confirm');
      const btn = document.getElementById('cp-wallet-save');
      const newPassword = newEl.value;
      const confirm = confirmEl.value;

      if (newPassword.length < 8) { this._setCpStatus('New password must be at least 8 characters.', 'error'); return; }
      if (newPassword !== confirm) { this._setCpStatus('New passwords do not match.', 'error'); return; }
      if (!(window.usernode && window.usernode.isNative) || typeof window.signMessage !== 'function') {
        this._setCpStatus('Wallet signing is only available in the Usernode app.', 'error');
        return;
      }

      btn.disabled = true;
      this._setCpStatus('Verifying identity…', 'info');
      try {
        const pubkey = this.state.usernodePubkey || (window.getNodeAddress ? await window.getNodeAddress() : null);
        if (!pubkey) { this._setCpStatus('Could not read your wallet address.', 'error'); return; }

        // Fresh single-use challenge from the shared wallet-check endpoint.
        const checkRes = await fetch('/api/auth/wallet-check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ pubkey }),
        });
        const checkData = await checkRes.json().catch(() => ({}));
        const challenge = checkData.challenge;
        if (!challenge) { this._setCpStatus('Could not get a challenge from the server.', 'error'); return; }

        const sig = await window.signMessage(challenge);
        const r = await fetch('/api/me/wallet-change-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ publicKey: sig.publicKey, challenge, signature: sig.signature, newPassword }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { this._setCpStatus(j.error || 'Failed to change password.', 'error'); return; }
        newEl.value = '';
        confirmEl.value = '';
        this._setCpStatus('Password changed.', 'ok');
      } catch (err) {
        if (err && err.message && err.message.includes('denied')) {
          this._setCpStatus('Signature request was denied.', 'error');
        } else {
          this._setCpStatus(`Wallet change failed: ${err.message || err}`, 'error');
        }
      } finally {
        btn.disabled = false;
      }
    },

    async changePassword() {
      const currentEl = document.getElementById('cp-current');
      const newEl = document.getElementById('cp-new');
      const confirmEl = document.getElementById('cp-confirm');
      const btn = document.getElementById('cp-save');
      const currentPassword = currentEl.value;
      const newPassword = newEl.value;
      const confirm = confirmEl.value;

      if (!currentPassword) { this._setCpStatus('Enter your current password.', 'error'); return; }
      if (newPassword.length < 8) { this._setCpStatus('New password must be at least 8 characters.', 'error'); return; }
      if (newPassword !== confirm) { this._setCpStatus('New passwords do not match.', 'error'); return; }

      btn.disabled = true;
      this._setCpStatus('Saving…', 'info');
      try {
        const r = await fetch('/api/me/password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ currentPassword, newPassword }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { this._setCpStatus(j.error || 'Failed to change password.', 'error'); return; }
        currentEl.value = '';
        newEl.value = '';
        confirmEl.value = '';
        this._setCpStatus('Password changed.', 'ok');
      } catch (err) {
        this._setCpStatus(`Network error: ${err.message}`, 'error');
      } finally {
        btn.disabled = false;
      }
    },

    async logout() {
      const btn = document.getElementById('settings-logout');
      if (btn) btn.disabled = true;

      const fail = (error) => {
        if (btn) btn.disabled = false;
        if (window.PlatformUI && PlatformUI.toast) {
          PlatformUI.toast(
            'Could not sign out. Check your connection and try again.',
            { error: true }
          );
        }
        console.warn('[settings] logout failed:', error);
        return false;
      };

      // Close wallet admission before the first asynchronous web cleanup.
      // New native builds also acknowledge their process-wide latch here.
      let nativeTerminal = false;
      try {
        if (window.NativeChrome && NativeChrome.prepareWebLogout) {
          nativeTerminal = await NativeChrome.prepareWebLogout();
        }
      } catch (error) {
        return fail(error);
      }

      try {
        const response = await fetch('/api/auth/logout', {
          method: 'POST', credentials: 'same-origin',
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      } catch (error) {
        // Do not tear down native while the HttpOnly web-session cookie can
        // still restore this participant in the replacement WebView.
        return fail(error);
      }
      // Offline mode (#487): the service worker caches GET /api/* responses
      // per-URL, not per-user — wipe them so the next account on this
      // device can't see this user's cached feed. Belt-and-braces: the SW
      // also clears the API cache when it sees the logout POST above.
      try { await this._clearSwApiCache(); } catch (_) {}
      // Same reasoning for the offline session snapshot (#1021): it is the
      // record that says "this device is signed in", so leaving it behind
      // would let the next offline boot paint the signed-in shell for an
      // account that just logged out.
      try { window.App?.clearSessionSnapshot?.(); } catch (_) {}

      // This must remain the final statement on the native path: successful
      // native logout replaces the WebView, so the old document has no
      // timeout or navigation continuation.
      if (nativeTerminal) {
        // FIXME: if this rejects after web cleanup, add a fail-closed retry UI
        // without resuming normal work in this old document.
        return NativeChrome.commitNativeLogout();
      }

      // Hard navigation on purpose: enterAuthed is one-shot per document
      // in a regular browser or an old app without hard logout.
      window.location.href = '/#login';
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

    async remove() {
      if (!await PlatformUI.confirm({ title: 'Remove your API key?', message: 'Future chats will fall back to the shared daily budget.', confirmLabel: 'Remove', danger: true })) return;
      const removeBtn = document.getElementById('settings-remove');
      removeBtn.disabled = true;
      try {
        const r = await fetch('/api/me/api-key', { method: 'DELETE', credentials: 'same-origin' });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          this._setStatus(j.error || 'Failed to remove key.', 'error');
          return;
        }
        this.state.hasApiKey = false;
        this.state.keyLast4 = null;
        this._renderIndicator();
        this._renderBody();
        this._refreshSpend();
        this._setStatus('Removed.', 'ok');
        setTimeout(() => this.close(), 700);
      } catch (err) {
        this._setStatus(`Network error: ${err.message}`, 'error');
      } finally {
        removeBtn.disabled = false;
      }
    },

    // ── App AI permissions (issue #34) ───────────────────────────
    //
    // Fetched fresh on every modal open. Each active grant renders as
    // a row: app name, $spent / $cap today, a cap editor, the BYOK
    // spillover toggle (only when a key is on file), and Revoke.
    // Revoked grants show a muted badge — re-approving happens via the
    // app's own consent dialog, not from here. In staging previews the
    // page's ?demo=1 is passed through so the (always-empty,
    // staging:private) grant tables still produce a reviewable list.

    async _renderLlmGrants() {
      const list = document.getElementById('llm-grants-list');
      if (!list) return;
      list.innerHTML = '<p class="text-xs text-zinc-500">Loading…</p>';
      const demo = new URLSearchParams(window.location.search).get('demo') === '1';
      let grants = [];
      try {
        const r = await fetch('/api/me/llm-grants' + (demo ? '?demo=1' : ''), { credentials: 'same-origin' });
        if (!r.ok) throw new Error('fetch failed');
        const j = await r.json();
        grants = j.grants || [];
      } catch {
        list.innerHTML = '<p class="text-xs text-red-500">Failed to load app permissions.</p>';
        return;
      }
      if (!grants.length) {
        list.innerHTML = '<p class="text-xs text-zinc-500 dark:text-zinc-500">No apps have asked to use AI yet.</p>';
        return;
      }
      list.innerHTML = '';
      for (const g of grants) list.appendChild(this._llmGrantRow(g));
    },

    _llmGrantRow(g) {
      const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      }[c]));
      const row = document.createElement('div');
      row.className = 'rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-xs';
      const revoked = g.status !== 'active';
      const spent = ((g.spentTodayCents || 0) + (g.byokSpentTodayCents || 0)) / 100;
      const cap = (g.dailyCapCents || 0) / 100;

      if (revoked) {
        row.innerHTML = `
          <div class="flex items-center justify-between gap-2">
            <span class="font-medium text-zinc-500 dark:text-zinc-500 truncate">${esc(g.appName)}</span>
            <span class="shrink-0 rounded px-1.5 py-0.5 bg-zinc-200 dark:bg-zinc-700 text-zinc-500 dark:text-zinc-400">Revoked</span>
          </div>`;
        return row;
      }

      row.innerHTML = `
        <div class="flex items-center justify-between gap-2">
          <span class="font-medium text-zinc-700 dark:text-zinc-300 truncate">${esc(g.appName)}</span>
          <span class="font-mono text-zinc-600 dark:text-zinc-400 shrink-0">$${spent.toFixed(2)} / $${cap.toFixed(2)} today</span>
        </div>
        <div class="flex items-center justify-between gap-2 mt-2 flex-wrap">
          <label class="flex items-center gap-1 text-zinc-600 dark:text-zinc-400">
            Cap $<input data-role="cap" type="number" min="0.01" step="0.01" value="${cap.toFixed(2)}"
              class="w-20 rounded bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-1.5 py-0.5 font-mono text-zinc-900 dark:text-zinc-100" />
          </label>
          ${this.state.hasApiKey || g.allowByok ? `
          <label class="flex items-center gap-1 cursor-pointer select-none text-zinc-600 dark:text-zinc-400">
            <input data-role="byok" type="checkbox" class="accent-violet-500 w-3.5 h-3.5" ${g.allowByok ? 'checked' : ''} />
            Use my own key past the daily budget
          </label>` : ''}
          <button data-role="revoke"
            class="rounded border border-red-400 dark:border-red-700 px-2 py-0.5 font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950 transition-colors">Revoke</button>
        </div>`;

      const status = (text, kind) => this._setLlmGrantsStatus(text, kind);
      const isDemo = g.appId < 0;

      const capInput = row.querySelector('[data-role="cap"]');
      capInput.addEventListener('change', async () => {
        if (isDemo) { status('Demo data — changes are not saved.', 'info'); return; }
        const cents = Math.round(parseFloat(capInput.value) * 100);
        if (!Number.isFinite(cents) || cents <= 0) {
          status('Enter a valid cap (at least $0.01).', 'error');
          return;
        }
        try {
          const r = await fetch(`/api/me/llm-grants/${g.appId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ dailyCapCents: cents }),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) { status(j.error || 'Failed to update cap.', 'error'); return; }
          status('Cap updated.', 'ok');
          this._renderLlmGrants();
        } catch (err) {
          status('Network error: ' + err.message, 'error');
        }
      });

      const byokInput = row.querySelector('[data-role="byok"]');
      if (byokInput) {
        byokInput.addEventListener('change', async () => {
          if (isDemo) { status('Demo data — changes are not saved.', 'info'); return; }
          try {
            const r = await fetch(`/api/me/llm-grants/${g.appId}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({ allowByok: byokInput.checked }),
            });
            const j = await r.json().catch(() => ({}));
            if (!r.ok) {
              byokInput.checked = !byokInput.checked;
              status(j.error || 'Failed to update.', 'error');
              return;
            }
            status(byokInput.checked
              ? 'This app may spill over onto your own key (still capped).'
              : 'Spillover disabled.', 'ok');
          } catch (err) {
            byokInput.checked = !byokInput.checked;
            status('Network error: ' + err.message, 'error');
          }
        });
      }

      row.querySelector('[data-role="revoke"]').addEventListener('click', async () => {
        const ok = await ConfirmModal.show({
          title: `Revoke AI access for "${g.appName}"?`,
          message: 'Its next AI call will fail immediately. The app can ask for access again later.',
          confirmLabel: 'Revoke',
          danger: true,
        });
        if (!ok) return;
        if (isDemo) { status('Demo data — changes are not saved.', 'info'); return; }
        try {
          const r = await fetch(`/api/me/llm-grants/${g.appId}`, {
            method: 'DELETE', credentials: 'same-origin',
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) { status(j.error || 'Failed to revoke.', 'error'); return; }
          status('Revoked.', 'ok');
          this._renderLlmGrants();
        } catch (err) {
          status('Network error: ' + err.message, 'error');
        }
      });

      return row;
    },

    _setLlmGrantsStatus(text, kind) {
      const el = document.getElementById('llm-grants-status');
      if (!el) return;
      el.textContent = text;
      el.classList.remove('hidden', 'text-red-500', 'text-emerald-500', 'text-zinc-500');
      const cls = kind === 'error' ? 'text-red-500' : kind === 'ok' ? 'text-emerald-500' : 'text-zinc-500';
      el.classList.add(cls);
      if (kind === 'ok') setTimeout(() => el.classList.add('hidden'), 3000);
    },

    // ── Agent instructions & skills (#460) ───────────────────────
    // Per-user global files the coding agent loads on every build/scout
    // run this user dispatches. List/upload/delete against
    // /api/me/agent-files; in staging the (staging:private, always empty)
    // table is stood in for by ?demo=1 fabricated rows, passed through
    // from the page URL exactly like the AI-permissions section above.

    _renderAgentFilesSection() {
      this._wireAgentFiles();
      this._hideAgentFilesForm();
      this._loadAgentFiles();
    },

    _agentFilesDemo() {
      return new URLSearchParams(window.location.search).get('demo') === '1';
    },

    // One-time event wiring (the section markup is static in index.html;
    // open() re-runs this, so guard against double-binding).
    _wireAgentFiles() {
      if (this._agentFilesWired) return;
      this._agentFilesWired = true;

      const input = document.getElementById('agent-files-input');
      document.querySelectorAll('[data-agent-files-upload]').forEach((btn) => {
        btn.addEventListener('click', () => {
          this._pendingAgentKind = btn.dataset.agentFilesUpload;
          input.value = '';
          input.click();
        });
      });

      input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        if (!file) return;
        if (file.size > 48 * 1024) {
          this._setAgentFilesStatus(`"${file.name}" is too large — the limit is 48 KB per file.`, 'error');
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          this._pendingAgentFile = {
            kind: this._pendingAgentKind,
            content: String(reader.result || ''),
          };
          this._showAgentFilesForm(file.name);
        };
        reader.onerror = () => this._setAgentFilesStatus('Could not read that file.', 'error');
        reader.readAsText(file);
      });

      document.getElementById('agent-files-cancel').addEventListener('click', () => {
        this._hideAgentFilesForm();
      });
      document.getElementById('agent-files-save').addEventListener('click', () => {
        this._saveAgentFile();
      });
    },

    // Client-side twin of the server's normalizeName — purely a
    // convenience prefill; the server re-normalizes and is authoritative.
    _slugifyAgentFileName(raw) {
      return String(raw || '')
        .trim()
        .replace(/\.(md|txt)$/i, '')
        .toLowerCase()
        .replace(/[\s_.]+/g, '-')
        .replace(/[^a-z0-9-]/g, '')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);
    },

    _showAgentFilesForm(filename) {
      const form = document.getElementById('agent-files-form');
      const title = document.getElementById('agent-files-form-title');
      const nameInput = document.getElementById('agent-files-name');
      const descWrap = document.getElementById('agent-files-desc-wrap');
      const descInput = document.getElementById('agent-files-desc');
      const kind = this._pendingAgentFile?.kind || 'instruction';
      title.textContent = kind === 'skill'
        ? `New skill from "${filename}"`
        : `New instruction file from "${filename}"`;
      nameInput.value = this._slugifyAgentFileName(filename);
      descWrap.classList.toggle('hidden', kind !== 'skill');
      descInput.value = '';
      form.classList.remove('hidden');
      this._setAgentFilesStatus('', 'clear');
    },

    _hideAgentFilesForm() {
      this._pendingAgentFile = null;
      const form = document.getElementById('agent-files-form');
      if (form) form.classList.add('hidden');
    },

    async _saveAgentFile() {
      const pending = this._pendingAgentFile;
      if (!pending) return;
      if (this._agentFilesDemo()) {
        this._setAgentFilesStatus('Demo data — changes are not saved.', 'info');
        this._hideAgentFilesForm();
        return;
      }
      const name = document.getElementById('agent-files-name').value.trim();
      if (!name) {
        this._setAgentFilesStatus('Give the file a name.', 'error');
        return;
      }
      const description = document.getElementById('agent-files-desc').value.trim();
      try {
        const r = await fetch('/api/me/agent-files', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ kind: pending.kind, name, description, content: pending.content }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          this._setAgentFilesStatus(j.error || 'Failed to save the file.', 'error');
          return;
        }
        this._hideAgentFilesForm();
        this._setAgentFilesStatus(`Saved "${j.file?.name || name}" — it applies from your next run.`, 'ok');
        this._loadAgentFiles();
      } catch (err) {
        this._setAgentFilesStatus('Network error: ' + err.message, 'error');
      }
    },

    async _loadAgentFiles() {
      const instrList = document.getElementById('agent-files-instructions-list');
      const skillList = document.getElementById('agent-files-skills-list');
      if (!instrList || !skillList) return;
      instrList.innerHTML = '<p class="text-xs text-zinc-500">Loading…</p>';
      skillList.innerHTML = '';
      const demo = this._agentFilesDemo();
      let files = [];
      try {
        const r = await fetch('/api/me/agent-files' + (demo ? '?demo=1' : ''), { credentials: 'same-origin' });
        if (!r.ok) throw new Error('fetch failed');
        const j = await r.json();
        files = j.files || [];
      } catch {
        instrList.innerHTML = '<p class="text-xs text-red-500">Failed to load your agent files.</p>';
        return;
      }
      const byKind = (kind) => files.filter((f) => f.kind === kind);
      const renderList = (el, list, emptyText) => {
        el.innerHTML = '';
        if (!list.length) {
          el.innerHTML = `<p class="text-xs text-zinc-500 dark:text-zinc-500">${emptyText}</p>`;
          return;
        }
        for (const f of list) el.appendChild(this._agentFileRow(f, demo));
      };
      renderList(instrList, byKind('instruction'),
        'No instruction files yet — upload a markdown file to guide the coding agent on every build you start.');
      renderList(skillList, byKind('skill'),
        'No skills yet — upload a skill file the agent can use while building for you.');
    },

    _agentFileRow(f, demo) {
      const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      }[c]));
      const row = document.createElement('div');
      row.className = 'rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-xs';
      // Stable hook for the #settings/agent-files rendered check — a row
      // that stops rendering should fail checks, not shrink silently.
      row.dataset.agentFile = f.kind || '';
      const kb = Math.max(1, Math.round((f.size_bytes || 0) / 1024));
      row.innerHTML = `
        <div class="flex items-center justify-between gap-2">
          <span class="font-mono font-medium text-zinc-700 dark:text-zinc-300 truncate">${esc(f.name)}</span>
          <span class="shrink-0 flex items-center gap-2">
            <span class="text-zinc-500 dark:text-zinc-500">${kb} KB</span>
            <button data-role="view" class="text-violet-500 hover:text-violet-400 font-medium">View</button>
            <button data-role="delete" class="text-red-600 dark:text-red-400 hover:text-red-500 font-medium">Delete</button>
          </span>
        </div>
        ${f.description ? `<div class="text-zinc-500 dark:text-zinc-500 mt-1 truncate">${esc(f.description)}</div>` : ''}
        <pre data-role="content" class="hidden mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-2 py-1.5 font-mono text-[11px] text-zinc-700 dark:text-zinc-300"></pre>`;

      const viewBtn = row.querySelector('[data-role="view"]');
      const pre = row.querySelector('[data-role="content"]');
      viewBtn.addEventListener('click', async () => {
        if (!pre.classList.contains('hidden')) {
          pre.classList.add('hidden');
          viewBtn.textContent = 'View';
          return;
        }
        if (!pre.textContent) {
          pre.textContent = 'Loading…';
          pre.classList.remove('hidden');
          try {
            const qs = `kind=${encodeURIComponent(f.kind)}&name=${encodeURIComponent(f.name)}` + (demo ? '&demo=1' : '');
            const r = await fetch(`/api/me/agent-files/content?${qs}`, { credentials: 'same-origin' });
            const j = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(j.error || 'fetch failed');
            pre.textContent = j.file?.content || '(empty)';
          } catch (err) {
            pre.textContent = 'Failed to load: ' + err.message;
          }
        } else {
          pre.classList.remove('hidden');
        }
        viewBtn.textContent = 'Hide';
      });

      row.querySelector('[data-role="delete"]').addEventListener('click', async () => {
        const ok = await ConfirmModal.show({
          title: `Delete "${f.name}"?`,
          message: 'The coding agent stops using it from your next run. This cannot be undone.',
          confirmLabel: 'Delete',
          danger: true,
        });
        if (!ok) return;
        if (demo) { this._setAgentFilesStatus('Demo data — changes are not saved.', 'info'); return; }
        try {
          const r = await fetch('/api/me/agent-files', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ kind: f.kind, name: f.name }),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) { this._setAgentFilesStatus(j.error || 'Failed to delete.', 'error'); return; }
          this._setAgentFilesStatus(`Deleted "${f.name}".`, 'ok');
          this._loadAgentFiles();
        } catch (err) {
          this._setAgentFilesStatus('Network error: ' + err.message, 'error');
        }
      });

      return row;
    },

    _setAgentFilesStatus(text, kind) {
      const el = document.getElementById('agent-files-status');
      if (!el) return;
      if (kind === 'clear' || !text) {
        el.classList.add('hidden');
        el.textContent = '';
        return;
      }
      el.textContent = text;
      el.classList.remove('hidden', 'text-red-500', 'text-emerald-500', 'text-zinc-500');
      const cls = kind === 'error' ? 'text-red-500' : kind === 'ok' ? 'text-emerald-500' : 'text-zinc-500';
      el.classList.add(cls);
      if (kind === 'ok') setTimeout(() => el.classList.add('hidden'), 3000);
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
          this._setWalletStatus(j.error || 'Failed to start linking.', 'error');
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
        this._setWalletStatus('Network error: ' + err.message, 'error');
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
            this._setWalletStatus('Wallet linked!', 'ok');
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
          this._setWalletStatus('QR code expired. Try again.', 'error');
          return;
        }
        const m = Math.floor(remaining / 60000);
        const s = Math.floor((remaining % 60000) / 1000);
        label.textContent = 'Expires in ' + m + ':' + String(s).padStart(2, '0');
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
      if (!await PlatformUI.confirm({ title: 'Unlink your Usernode wallet?', confirmLabel: 'Unlink', danger: true })) return;
      try {
        const r = await fetch('/api/me/wallet-link', { method: 'DELETE', credentials: 'same-origin' });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          this._setWalletStatus(j.error || 'Failed to unlink.', 'error');
          return;
        }
        this.state.usernodePubkey = null;
        this._renderWalletSection();
        this._setWalletStatus('Wallet unlinked.', 'ok');
      } catch (err) {
        this._setWalletStatus('Network error: ' + err.message, 'error');
      }
    },

    _setWalletStatus(text, kind) {
      const el = document.getElementById('wallet-status');
      if (!el) return;
      el.textContent = text;
      el.classList.remove('hidden', 'text-red-500', 'text-emerald-500', 'text-zinc-500');
      const cls = kind === 'error' ? 'text-red-500' : kind === 'ok' ? 'text-emerald-500' : 'text-zinc-500';
      el.classList.add(cls);
      if (kind === 'ok') setTimeout(() => el.classList.add('hidden'), 3000);
    },

    // ── "Usernode app" sections (profile-and-settings-to-web migration) ──
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

    // Plain-language reason per bridge failure `kind` (the record from
    // usernode.getLastNativeReadError). Without this the section could only
    // ever say "something went wrong": the bridge's chrome reads resolve
    // null on a timeout, on a native rejection and on a refused privileged
    // handshake alike, which is exactly what made issue #978 impossible to
    // diagnose from the device.
    USERNODE_READ_ERROR_REASONS: {
      'timeout': 'The Usernode app didn’t respond in time. ' +
        'It may still be starting up.',
      'rejected': 'The Usernode app reported an error.',
      'probe-inconclusive': 'The Usernode app hasn’t re-established ' +
        'its secure connection for settings. Reopening the app usually ' +
        'fixes this.',
      'no-transport': 'This screen can’t reach the Usernode app from here.',
      'not-native': 'This screen can’t reach the Usernode app from here.',
    },
    USERNODE_READ_ERROR_FALLBACK: 'The Usernode app returned no settings.',

    async _renderUsernodeSection() {
      const section = document.getElementById('settings-usernode-section');
      if (!section) return;
      const gated = window.NativeChrome &&
        await NativeChrome.has('getSettingsState');
      // This capability probe is async, so the "Usernode app" menu row can
      // only be resolved once it settles — re-render the nav either way.
      if (!gated) {
        section.classList.add('hidden');
        this._renderNavIfOpen();
        return;
      }
      section.classList.remove('hidden');
      this._renderNavIfOpen();
      const token = ++this._usernodeRenderToken;
      if (!this._usernodeState) {
        section.textContent = '';
        section.appendChild(this._unEl('div',
          'mt-6 pt-5 border-t border-zinc-200 dark:border-zinc-700 ' +
          'text-xs text-zinc-500', 'Loading Usernode app settings…'));
      }
      let state = null;
      try {
        state = await window.usernode.getSettingsState();
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
        this._renderUsernodeBody(this._usernodeReadError());
        return;
      }
      this._clearUsernodeAuthStatusRetry();
      this._renderUsernodeBody();
    },

    // Why the snapshot came back empty, straight from the bridge's
    // out-of-band record. null when the bridge is too old to keep one.
    _usernodeReadError() {
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

    _unEl(tag, className, text) {
      const el = document.createElement(tag);
      if (className) el.className = className;
      if (text != null) el.textContent = text;
      return el;
    },

    _unSection(parent, title, description) {
      const box = this._unEl('div',
        'mt-6 pt-5 border-t border-zinc-200 dark:border-zinc-700');
      box.appendChild(this._unEl('h3',
        'text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-1', title));
      if (description) {
        box.appendChild(this._unEl('p',
          'text-xs text-zinc-500 dark:text-zinc-500 mb-3', description));
      }
      parent.appendChild(box);
      return box;
    },

    _unToggle(parent, label, checked, onChange) {
      const wrap = this._unEl('label',
        'flex items-center gap-2 cursor-pointer select-none mt-2');
      const input = this._unEl('input', 'un-switch');
      input.type = 'checkbox';
      input.checked = !!checked;
      input.addEventListener('change', async (e) => {
        input.disabled = true;
        try {
          await onChange(e.target.checked);
        } catch (err) {
          console.warn('[settings] usernode toggle failed:', err);
          input.checked = !e.target.checked;
          if (window.PlatformUI) PlatformUI.toast('Could not save the setting');
        } finally {
          input.disabled = false;
        }
      });
      wrap.appendChild(input);
      wrap.appendChild(this._unEl('span',
        'text-sm text-zinc-800 dark:text-zinc-200', label));
      parent.appendChild(wrap);
      return input;
    },

    _unButton(parent, label, onClick, opts = {}) {
      const btn = this._unEl('button',
        'mt-3 mr-2 rounded-md border px-3 py-1.5 text-xs font-medium ' +
        'transition-colors ' +
        (opts.danger
          ? 'border-red-400 dark:border-red-700 text-red-600 ' +
            'dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950'
          : 'border-zinc-300 dark:border-zinc-700 text-zinc-700 ' +
            'dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800'),
        label);
      btn.type = 'button';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await onClick();
        } catch (err) {
          console.warn('[settings] usernode action failed:', err);
          if (window.PlatformUI) PlatformUI.toast('Action failed');
        } finally {
          btn.disabled = false;
        }
      });
      parent.appendChild(btn);
      return btn;
    },

    _unStatusRow(parent, label, ok, okText, badText) {
      const row = this._unEl('div', 'flex items-center gap-2 mt-1 text-sm');
      const dot = this._unEl('span',
        'w-2 h-2 rounded-full shrink-0 ' +
        (ok ? 'bg-emerald-500' : 'bg-amber-500'));
      row.appendChild(dot);
      row.appendChild(this._unEl('span',
        'text-zinc-800 dark:text-zinc-200', label));
      row.appendChild(this._unEl('span',
        'ml-auto text-xs ' + (ok
          ? 'text-emerald-600 dark:text-emerald-400'
          : 'text-amber-600 dark:text-amber-400'),
        ok ? okText : badText));
      parent.appendChild(row);
    },

    _openNativeScreen(screen, failMsg) {
      if (!window.usernode ||
          typeof window.usernode.openNativeScreen !== 'function') return;
      window.usernode.openNativeScreen(screen).catch((err) => {
        console.warn('[settings] openNativeScreen failed:', err);
        if (window.PlatformUI) PlatformUI.toast(failMsg);
      });
    },

    // Awaits a bridge setter and re-renders the section from the refreshed
    // snapshot it resolves with.
    async _unApply(promise) {
      const state = await promise;
      if (state && typeof state === 'object') {
        this._usernodeState = state;
        this._renderUsernodeBody();
      }
    },

    // ── Terms (thin-shell migration) ──────────────────────────────────
    // The native terms screen is gone; the current published terms and
    // the consent write now live on the session-authed /challenges-api
    // twins of the v4 terms endpoints (src/routes/topochain/mobile.js).
    // Shared by the About & legal section below and profile.js's gated
    // token-allocation notice. `onAccepted` fires after a successful
    // accept so callers can refresh their own terms-gated UI.
    async showTermsSheet(onAccepted) {
      let payload = null;
      try {
        const res = await fetch('/challenges-api/terms/current', {
          credentials: 'same-origin',
        });
        const body = await res.json().catch(() => ({}));
        if (res.status === 404) {
          // No published terms version — nothing to accept.
          if (window.PlatformUI) PlatformUI.toast('No terms to review right now');
          return;
        }
        if (!res.ok || !body.success) {
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        payload = body.data;
      } catch (err) {
        console.warn('[settings] terms fetch failed:', err);
        if (window.PlatformUI) PlatformUI.toast('Could not load the terms');
        return;
      }

      const el = (tag, cls, text) => this._unEl(tag, cls, text);
      const panel = el('div', 'px-4 pb-5');
      panel.appendChild(el('div', 'text-lg font-bold py-3',
        payload.title || 'Terms'));
      const meta = [];
      if (payload.version) meta.push(`Version ${payload.version}`);
      if (payload.published_at) {
        try {
          meta.push('published ' +
            new Date(payload.published_at).toLocaleDateString());
        } catch (_) {}
      }
      if (meta.length) {
        panel.appendChild(el('p',
          'text-xs text-zinc-500 dark:text-zinc-400 mb-2', meta.join(' · ')));
      }
      if (payload.terms_link) {
        const a = el('a',
          'block text-sm text-violet-600 dark:text-violet-400 underline mb-3',
          'Read the full terms');
        a.href = payload.terms_link;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        panel.appendChild(a);
      }

      const accepted = !!(payload.consent && payload.consent.accepted);
      const statusEl = el('p', 'text-sm mb-3 ' + (accepted
        ? 'text-emerald-600 dark:text-emerald-400'
        : 'text-zinc-600 dark:text-zinc-400'),
      accepted
        ? 'You accepted this version' +
          (payload.consent.responded_at
            ? ' on ' + new Date(payload.consent.responded_at).toLocaleDateString()
            : '') + '.'
        : 'You have not accepted this version yet.');
      panel.appendChild(statusEl);

      let sheet = null;
      if (!accepted) {
        const acceptBtn = el('button',
          'w-full rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 ' +
          'text-sm font-medium text-white', 'Accept the terms');
        acceptBtn.addEventListener('click', async () => {
          acceptBtn.disabled = true;
          try {
            const res = await fetch('/challenges-api/terms/consent', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({
                terms_version_id: payload.id,
                status: 'accepted',
              }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok || !body.success) {
              throw new Error(body.error || `HTTP ${res.status}`);
            }
            if (window.PlatformUI) PlatformUI.toast('Terms accepted');
            if (sheet && sheet.dismiss) sheet.dismiss();
            if (typeof onAccepted === 'function') onAccepted();
          } catch (err) {
            console.warn('[settings] terms consent failed:', err);
            if (window.PlatformUI) PlatformUI.toast('Could not record your consent');
            acceptBtn.disabled = false;
          }
        });
        panel.appendChild(acceptBtn);
      }
      const closeBtn = el('button',
        'w-full px-4 py-2 mt-2 text-sm text-zinc-500 dark:text-zinc-400',
      'Close');
      closeBtn.addEventListener('click', () => {
        if (sheet && sheet.dismiss) sheet.dismiss();
      });
      panel.appendChild(closeBtn);

      sheet = window.PlatformUI && PlatformUI.sheet
        ? PlatformUI.sheet({ contentEl: panel })
        : null;
    },

    // `readError` / `loading` only matter when there is NO snapshot: the
    // blocks that need one give way to the error box (or a loading line
    // during a retry), while everything the snapshot has no say over —
    // activity notifications, block production, Terms, the FAQ, the native
    // diagnostics screens — still renders. A failed read used to blank the
    // whole section, turning a transient app hiccup into a dead end.
    _renderUsernodeBody(readError, loading) {
      const section = document.getElementById('settings-usernode-section');
      const s = this._usernodeState;
      if (!section) return;
      section.textContent = '';
      const perms = (s && s.permissions) || {};
      const isAndroid = perms.platform === 'android';

      if (!s) {
        this._renderUsernodeError(section, readError, loading);
      } else {
        // Device permissions — mirrors the native QuickSettingsPanel.
        const permBox = this._unSection(section, 'Usernode app — device permissions',
          'Block production needs the app to wake your device at exact slot times.');
        this._unStatusRow(permBox, isAndroid ? 'Exact alarms' : 'Alarm permissions',
          !!perms.exactAlarmGranted, 'Granted', 'Not granted');
        if (!perms.exactAlarmGranted) {
          this._unButton(permBox, 'Request permissions', () =>
            this._unApply(window.usernode.requestPermissions()));
        }
        if (isAndroid) {
          this._unStatusRow(permBox, 'Battery optimization',
            perms.batteryOptDisabled === true, 'Unrestricted', 'Restricted');
          if (perms.batteryOptDisabled !== true) {
            this._unButton(permBox, 'Open battery settings', () =>
              window.usernode.openBatterySettings());
          }
          if (perms.deviceManufacturer) {
            permBox.appendChild(this._unEl('p',
              'text-xs text-zinc-500 dark:text-zinc-500 mt-2',
              `Device: ${perms.deviceManufacturer}`));
          }
        }
      }
      this._renderSocialPushSection(section);
      // (The iOS keep-alive toggle is gone — thin-shell migration: block
      // production is disabled on iOS and the keep-alive service was
      // deleted from the app.)

      // Node.
      if (s) {
        const nodeBox = this._unSection(section, 'Usernode app — node',
          'The node pauses when the app has been inactive for a while and wakes on your next interaction.');
        this._unToggle(nodeBox, 'Node sleep on inactivity',
          s.nodeSleepEnabled !== false,
          (v) => this._unApply(window.usernode.setNodeSleepEnabled(v)));
      }

      // Block production (onboarding flow alignment): producing blocks is
      // a released capability. The wallet works for dapp transactions
      // either way; this section is the "ask to produce blocks" queue.
      this._renderBpSection(section);

      // Privacy & identity.
      if (s) {
        const privBox = this._unSection(section, 'Usernode app — privacy & identity',
          'Controls for the ZK passport identity flow.');
        this._unToggle(privBox, 'Strict facematch',
          s.facematchStrict !== false,
          (v) => this._unApply(window.usernode.setFacematchStrict(v)));
        this._unButton(privBox, 'Restart ZK challenge', async () => {
          const ok = await PlatformUI.confirm({
            title: 'Restart the ZK challenge?',
            message: 'Your in-progress identity registration will be discarded.',
            confirmLabel: 'Restart',
            danger: true,
          });
          if (!ok) return;
          await window.usernode.resetZkChallenge();
          if (window.PlatformUI) PlatformUI.toast('Challenge state reset');
        }, { danger: true });
      }

      // Diagnostics. The two native screens are reachable whether or not
      // the snapshot loaded — they are exactly what someone debugging a
      // failed read wants — so only the Debug mode toggle is gated.
      const diagBox = this._unSection(section, 'Usernode app — diagnostics',
        'Debugging tools for the app and its embedded node.');
      if (s) {
        this._unToggle(diagBox, 'Debug mode',
          s.debugMode === true,
          (v) => this._unApply(window.usernode.setDebugMode(v)));
      }
      const diagBtns = this._unEl('div');
      this._unButton(diagBtns, 'Device benchmark', () =>
        this._openNativeScreen('benchmark', 'Could not open the benchmark'));
      this._unButton(diagBtns, 'HTTP debug logs', () =>
        this._openNativeScreen('httpLogs', 'Could not open the logs'));
      diagBox.appendChild(diagBtns);

      // About & legal. The build line needs the snapshot; Terms and the FAQ
      // do not (terms are session-authed web routes).
      const aboutBox = this._unSection(section, 'Usernode app — about & legal');
      const bi = (s && s.buildInfo) || {};
      const buildBits = [];
      if (bi.appVersion) {
        buildBits.push(`App ${bi.appVersion}` +
          (bi.buildNumber ? ` (${bi.buildNumber})` : ''));
      }
      if (bi.nodeVersion) buildBits.push(`Node ${bi.nodeVersion}`);
      if (bi.commitHash) buildBits.push(bi.commitHash);
      if (buildBits.length) {
        aboutBox.appendChild(this._unEl('p',
          'text-xs text-zinc-500 dark:text-zinc-400 font-mono',
          buildBits.join(' · ')));
      }
      const termsRow = this._unEl('div');
      // Terms render in a web sheet now (session-authed /challenges-api
      // twins) — the native terms screen is gone. On accept, refresh the
      // usernode snapshot so the label flips without reopening Settings.
      this._unButton(termsRow, (s && s.termsAccepted === false)
        ? 'Review terms (not yet accepted)' : 'Terms', () =>
        this.showTermsSheet(() => this._renderUsernodeSection()));
      aboutBox.appendChild(termsRow);
      this._renderUsernodeFaq(aboutBox, isAndroid, perms.deviceManufacturer);

      // Account (thin-shell migration). Platform login is the only
      // sign-in surface: the native app's credential is provisioned from
      // the web session by the boot handoff (native-chrome.js), so there
      // is no separate "log in to the app" path anymore. The redundant
      // native-only "Log out of the Usernode app" row is gone too
      // (onboarding flow alignment): it was a no-op in practice — the
      // boot handoff would immediately re-authenticate the native side
      // from the still-live web session — and the main "Log out" at the
      // top of this modal already tears down both sides at once. Only
      // the not-yet-authenticated hint remains.
      if (s && s.authStatus !== 'authenticated') {
        const acctBox = this._unSection(section, 'Usernode app — account');
        acctBox.appendChild(this._unEl('p',
          'text-xs text-zinc-500 dark:text-zinc-400',
          'The app signs in automatically with your platform account. ' +
          'If this message persists, try closing and reopening the app.'));
      }
    },

    // The snapshot-failure box: the unchanged headline (so existing reports
    // stay recognisable), the mapped reason, the app's own message, and a
    // retry that stays on this screen. `loading` renders the in-place
    // progress line a retry swaps in, leaving the rest of the section up.
    _renderUsernodeError(parent, readError, loading) {
      const box = this._unEl('div',
        'mt-6 pt-5 border-t border-zinc-200 dark:border-zinc-700');
      box.id = 'settings-usernode-error';
      if (loading) {
        box.appendChild(this._unEl('p', 'text-xs text-zinc-500',
          'Loading Usernode app settings…'));
        parent.appendChild(box);
        return box;
      }
      box.appendChild(this._unEl('p',
        'text-sm font-bold text-red-600 dark:text-red-400',
        'Could not load Usernode app settings.'));
      const kind = readError && readError.kind;
      box.appendChild(this._unEl('p',
        'text-xs text-zinc-500 dark:text-zinc-400 mt-1',
        this.USERNODE_READ_ERROR_REASONS[kind] ||
          this.USERNODE_READ_ERROR_FALLBACK));
      if (readError && readError.message) {
        box.appendChild(this._unEl('p',
          'text-xs font-mono text-zinc-500 dark:text-zinc-500 mt-1 break-words',
          readError.message));
      }
      const retry = this._unButton(box, 'Try again', async () => {
        // Swap this box for the progress line and re-read; the rest of the
        // section (notifications, block production, Terms, FAQ) stays put.
        this._renderUsernodeBody(readError, true);
        await this._renderUsernodeSection();
      });
      retry.id = 'settings-usernode-retry';
      parent.appendChild(box);
      return box;
    },

    _renderSocialPushSection(section) {
      if (this._socialPushStateListener) {
        window.removeEventListener(
          'usernode:social-push-state', this._socialPushStateListener
        );
        this._socialPushStateListener = null;
      }
      if (!window.SocialPush) return;
      const box = this._unSection(section, 'Usernode app — activity notifications',
        'Get a device notification when a dev session or auto-solve run finishes. Notification content is loaded only after you open Social.');
      const holder = this._unEl('div');
      holder.appendChild(this._unEl('p',
        'text-xs text-zinc-500 dark:text-zinc-400', 'Checking status…'));
      box.appendChild(holder);

      const render = (state) => {
        holder.textContent = '';
        if (!state) {
          holder.appendChild(this._unEl('p',
            'text-xs text-zinc-500 dark:text-zinc-400',
            'Notification settings are temporarily unavailable.'));
          return;
        }
        this._unToggle(holder, 'Activity notifications', state.enabled,
          async (enabled) => render(await SocialPush.setEnabled(enabled)));
        let status = 'Off on this device.';
        if (state.deliveryActive) {
          status = 'On — this device is registered for activity notifications.';
        } else if (state.permissionStatus === 'denied') {
          status = 'Notification permission is denied in the device settings.';
        } else if (state.enabled && state.registrationStatus === 'registering') {
          status = 'Enabling notifications…';
        } else if (state.enabled) {
          status = 'Enabled, but delivery is not active yet.';
        }
        holder.appendChild(this._unEl('p',
          'mt-2 text-xs text-zinc-500 dark:text-zinc-400', status));
      };

      const onState = (event) => {
        if (!box.isConnected) return;
        render(event && event.detail);
      };
      this._socialPushStateListener = onState;
      window.addEventListener('usernode:social-push-state', onState);

      SocialPush.isSupported().then((supported) => {
        if (!supported) {
          if (this._socialPushStateListener === onState) {
            window.removeEventListener('usernode:social-push-state', onState);
            this._socialPushStateListener = null;
          }
          box.remove();
          return null;
        }
        return SocialPush.getState();
      }).then((state) => {
        if (box.isConnected) render(state);
      }).catch((err) => {
        console.warn('[settings] social push state failed:', err);
        render(null);
      });
    },

    // Block production queue (onboarding flow alignment). State comes
    // from the session-authed /challenges-api twins; the async load
    // fills the section in place so the rest of the usernode body never
    // waits on it.
    _renderBpSection(section) {
      const box = this._unSection(section, 'Usernode app — block production',
        'Producing blocks earns points. Access is released manually — ask below and an admin will release your keys in batches.');
      const holder = this._unEl('div');
      box.appendChild(holder);

      const note = (text) => {
        holder.appendChild(this._unEl('p',
          'text-xs text-zinc-500 dark:text-zinc-400', text));
      };

      const render = (state) => {
        holder.textContent = '';
        if (!state) return note('Could not check block-production status right now.');
        if (state.bp_released) return note('Released — your node produces blocks when it wins slots.');
        if (state.bp_requested) return note('Request pending — you\u2019ll start producing automatically once an admin releases your keys.');
        if (!state.has_platform_access) return note('Available once your account has platform access.');
        this._unButton(holder, 'Ask to produce blocks', async () => {
          try {
            const res = await fetch('/challenges-api/bp/request', {
              method: 'POST', credentials: 'same-origin',
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data || data.success === false) throw new Error((data && data.error) || 'Request failed');
            if (window.PlatformUI) PlatformUI.toast('Request sent — an admin will release your keys');
            render({ ...state, bp_requested: true });
          } catch (e) {
            if (window.PlatformUI) PlatformUI.toast(e.message || 'Request failed', { error: true });
          }
        });
      };

      note('Checking status\u2026');
      fetch('/challenges-api/bp/state', { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => render(data && data.success !== false ? data.data : null))
        .catch(() => render(null));
    },

    // Static port of the native FaqSection copy (Help & Info tiles).
    _renderUsernodeFaq(parent, isAndroid, deviceManufacturer) {
      const faq = this._unEl('div', 'mt-3');
      faq.appendChild(this._unEl('div',
        'text-xs font-semibold text-zinc-500 dark:text-zinc-400 mb-1',
        'Help & Info'));

      const addTile = (title, paragraphs) => {
        const d = this._unEl('details',
          'rounded-lg border border-zinc-200 dark:border-zinc-800 ' +
          'px-3 py-2 mb-2');
        const sum = this._unEl('summary',
          'text-sm font-medium cursor-pointer select-none', title);
        d.appendChild(sum);
        for (const p of paragraphs) {
          d.appendChild(this._unEl('p',
            'text-xs text-zinc-500 dark:text-zinc-400 mt-2 leading-relaxed',
            p));
        }
        faq.appendChild(d);
        return d;
      };

      addTile('About', [
        'Your device is part of a new network. It verifies, executes, and ' +
        'contributes compute directly to the network, passively in the ' +
        'background - with no central servers, no hidden infra. As long as ' +
        'users keep the app running, the network will continue to operate, ' +
        'peer to peer, with no external dependencies.',
        "We're doing this to enable networks that can be hosted end-to-end " +
        'by their own communities - both for decentralization, and to ' +
        'enable a natural coordination point around participation, where ' +
        'users who help operate and contribute to systems directly realize ' +
        'the benefits from it.',
        'Right now we are in testnet as we validate the core layer: block ' +
        "production, consensus behavior, and network reliability. As these " +
        "stabilize, we'll build upon the unique features of the platform - " +
        'its decentralization, zero knowledge proofs, and sybil-resistant ' +
        'identity - to introduce new activities, coordination mechanisms, ' +
        'and tools for self-hosted, sybil-resistant communities.',
        'Thanks for helping test at this early stage. The app right now is ' +
        'simple, but as we prove out the core functionality, we hope to ' +
        'make possible a new kind of community-owned network, where users ' +
        'can directly run and benefit from the networks they use.',
      ]);

      addTile('What is Block Production?', [
        'This feature automatically wakes your device to produce ' +
        "blockchain blocks when your node wins a slot. Here's how it works:",
        '1. VRF Selection — Each epoch, the network randomly selects which ' +
        'validators will produce blocks using Verifiable Random Function ' +
        '(VRF).',
        '2. Slot Scheduling — When you win slots, the app schedules alarms ' +
        'to wake your device ~1 minute before each slot.',
        '3. Block Production — At slot time, the app monitors your node ' +
        'and ensures the block is produced.',
        '4. Success Tracking — Results are recorded to track your ' +
        'reliability over time.',
      ]);

      const platformParas = isAndroid
        ? [
            "Uses Android's exact alarm system (AlarmManager) to wake your " +
            'device precisely when needed for block production.',
            'Reliability by mode: Default (Event-Driven) 90-95% — ' +
            'battery-efficient, wakes only during slot windows. Keep-Alive ' +
            'Mode 100% — persistent service, higher battery (~5-10%/hr).',
          ]
        : [
            'Uses a combination of background tasks and keep-alive mode to ' +
            'wake your device for block production.',
            'Reliability by mode: Keep-Alive Mode 99% — app stays awake in ' +
            'foreground, requires charger. Background Only 40-60% — iOS ' +
            'controls execution, not guaranteed.',
          ];
      if (isAndroid && deviceManufacturer) {
        platformParas.push(`Device: ${deviceManufacturer}`);
      }
      addTile('Platform & Reliability', platformParas);

      addTile('Understanding VRF & Slots', [
        'VRF (Verifiable Random Function) is how the network fairly ' +
        'selects block producers. At the start of each epoch, the network ' +
        'runs VRF calculations to determine which validators will produce ' +
        'blocks in upcoming slots.',
        'Status meanings — Pending: waiting for epoch transition to start ' +
        'calculations. Calculating: VRF evaluation in progress (takes a ' +
        'few hours). Complete: slot assignments are finalized and ' +
        'scheduled.',
        'When VRF selects your node to produce a block at a specific time, ' +
        'you\'ve "won" that slot. Your responsibility is to have your ' +
        'device awake and connected so the block can be produced.',
        "Why timing matters: each slot has a ~5-seconds window. If your " +
        "device doesn't wake up in time or loses network connectivity, the " +
        'slot is missed and counted as "failed."',
      ]);

      parent.appendChild(faq);
    },
  };

  window.Settings = Settings;
  document.addEventListener('DOMContentLoaded', () => Settings.init());
})();
