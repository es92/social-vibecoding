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
    // `devFlowPreference` is the "remember my option" answer from the
    // dev-chat flow picker (#1049): null = ask every time (the default),
    // otherwise 'platform' | 'claude-code' | 'codex'. `externalFlowsAvailable`
    // says whether this deployment can offer the Claude Code / Codex
    // hand-off at all — the server decides, we only render what it reports.
    state: { hasApiKey: false, demoKey: false, keyLast4: null, usernodePubkey: null, walletLinkEnabled: false, aiProgressEstimate: false, locale: null, devFlowPreference: null, externalFlowsAvailable: false },
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
    _openRouterModels: [],
    _mobilePushPreferences: null,
    _mobilePushLoading: false,
    _mobilePushSaving: false,
    _mobilePushLoadToken: 0,

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
      { key: 'connectors', label: 'Social accounts & connectors', group: 'AI & agents' },
      { key: 'openrouter', label: 'OpenRouter', group: 'AI & agents' },
      { key: 'app-ai', label: 'App AI permissions', group: 'AI & agents' },
      { key: 'agent-files', label: 'Agent instructions & skills', group: 'AI & agents' },

      { key: 'username', label: 'Username', group: 'Account' },
      { key: 'password', label: 'Password', group: 'Account' },
      { key: 'wallet', label: 'Usernode Wallet', group: 'Account', gate: 'wallet-section' },

      { key: 'language', label: 'Language', group: 'Preferences' },
      { key: 'alerts', label: 'Notifications & alerts', group: 'Preferences' },
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

      // The static shell is still under the markup-parity migration guard,
      // so provider copy is normalized at runtime while this hidden section
      // mounts. Users should only see the provider they configured; the
      // worker implementation behind OpenRouter is not a product choice.
      this._normalizeOpenRouterCopy();

      // OpenRouter & Codex (BYOK). Section bindings — all guarded on
      // existence so the section degrades cleanly if the feature flag is
      // off server-side (the section markup stays, the controls no-op).
      const orSave = document.getElementById('settings-openrouter-save');
      const orRemove = document.getElementById('settings-openrouter-remove');
      const orSetDefault = document.getElementById('settings-openrouter-set-default');
      const orModel = document.getElementById('settings-openrouter-model');
      const claudeSetDefault = document.getElementById('settings-claude-set-default');
      if (orSave) orSave.addEventListener('click', () => this._saveOpenRouterKey());
      if (orRemove) orRemove.addEventListener('click', () => this._removeOpenRouterKey());
      if (orSetDefault) orSetDefault.addEventListener('click', () => this._saveOpenRouterDefault());
      if (orModel) orModel.addEventListener('change', () => this._syncOpenRouterModelDetails());
      if (claudeSetDefault) claudeSetDefault.addEventListener('click', () => this._saveClaudeDefault());

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
        successMessage: 'Connector URL copied',
        failureMessage: 'Could not copy the connector URL',
        selectOnFail: () => {
          const field = document.getElementById('connector-url');
          if (field) field.select();
        },
      });

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
          success: 'Copied — paste it into ~/.claude/settings.json',
          failure: 'Could not copy the allow rules',
        },
        'connector-repo-allow-rules': {
          success: 'Copied — commit it as .claude/settings.json in your app repo',
          failure: 'Could not copy the allow rules',
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

      this._wireConnectorNameSpelling();

      // Change password (issue #282) → POST /api/me/password.
      const cuSave = document.getElementById('cu-save');
      if (cuSave) cuSave.addEventListener('click', () => this.changeUsername());
      // Enter in either field submits, like the password form's fields do
      // not — this one is two fields and a button, and a rename typed on a
      // phone should not require reaching for the button.
      ['cu-new', 'cu-password'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) {
          el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); this.changeUsername(); }
          });
        }
      });
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

      // A sign-out the app never acknowledged left a note for the next
      // document; this is that document.
      this._showIncompleteNativeSignOutNotice();

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
        const r = await fetch(`/api/auth/me${meDemoQ}`, { credentials: 'same-origin' });
        if (!r.ok) return;
        const j = await r.json();
        this.state.hasApiKey = !!j.user?.hasApiKey;
        // Staging only, and only under ?demo=1: the key reported above is a
        // fixture, not something anything can be billed to. Carried so the
        // surfaces that branch on "a key is on file" can tell the two apart
        // (DevChat._creditsExhausted is the one that has to).
        this.state.demoKey = !!j.user?.demoKey;
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
      this._refreshOpenRouter();
      this._renderLlmGrants();
      this._loadCliTokens(true);
      this._loadConnectors();
      this._loadGithubLink();
      this._renderAgentFilesSection();
      this._renderWalletSection();
      this._renderDevFlowSection();
      this._renderChangeUsernameSection();
      this._renderChangePasswordSection();
      this._renderDevConsoleSection();
      this._renderLanguageSection();
      this._loadMobilePushPreferences();
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
      const visible = Settings._visibleSections();
      const valid = !!section && visible.some((s) => s.key === section);
      const mobile = Settings._isMobile();
      // The level and section this call WOULD end on. Level 1 keeps whatever
      // section sits behind the menu, so there the level is the whole target.
      const targetLevel = (!mobile || valid) ? 2 : 1;
      const targetSection = valid
        ? section
        : (mobile ? Settings._section : (visible[0] ? visible[0].key : 'api-key'));
      if (targetLevel === Settings._level && targetSection === Settings._section) {
        Settings._markRoute('skipped');
        return;
      }
      Settings._markRoute('applied');
      if (!mobile) {
        Settings.setSection(targetSection, { writeHash: false });
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

    str(s) {
      return String(s == null ? '' : s);
    },

    // Desktop sidebar rows, grouped under headings.
    //
    // A DESCRIPTOR, not HTML, since #1191 slice 6 conversion 8 —
    // ./settings-nav.tsx is the only writer of #settings-nav-desktop now. The
    // shape is `[{ name, first, items: [{ key, label, active, className }] }]`.
    //
    // `className` is computed HERE rather than in the component on purpose:
    // it is the one class string on this screen that varies with state, it is
    // carried over from the retired _navItemsHtml() character for character
    // (so the rendered attribute cannot drift), and the shaping-stays-in-JS
    // rule is what keeps this module loadable by the vm harnesses. Tailwind's
    // extractor scans frontend/** including .js, so both spellings still
    // compile.
    _navView() {
      const active = Settings._section;
      const item = (s) => ({
        key: s.key,
        label: Settings.str(s.label),
        active: s.key === active,
        className: 'settings-nav-item block w-full text-left rounded-lg px-3 py-2 text-sm font-medium transition-colors '
          + (s.key === active
            ? 'bg-violet-600/10 text-violet-600 dark:text-violet-400'
            : 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800'),
      });
      return Settings._groupedSections().map((g, i) => ({
        name: Settings.str(g.name),
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
        name: Settings.str(g.name),
        items: g.items.map((s) => ({ key: s.key, label: Settings.str(s.label) })),
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
    // shell's body is id-pinned against tests/baselines/shell-markup.json
    // by tests/shell-id-inventory.test.js (no undeclared elements, no attribute
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

    // ── Rewriting the allow rules for a different connector name ─────────
    //
    // The two blocks ship covering `usernode` and `Usernode`, the two
    // spellings Usernode can guess. Anything else — a typo like the `Uesrnode`
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
     */
    _wireCopyControl(buttonId, { read, successMessage, failureMessage, selectOnFail }) {
      const btn = document.getElementById(buttonId);
      if (!btn) return;
      // The label React rendered, restored rather than a hardcoded 'Copy'.
      const restLabel = btn.textContent;
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
          PlatformUI.toast(ok ? successMessage : failureMessage,
            ok ? {} : { error: true });
        }
        btn.textContent = ok ? 'Copied' : 'Copy failed';
        if (resetTimer) clearTimeout(resetTimer);
        resetTimer = setTimeout(() => {
          resetTimer = null;
          btn.textContent = restLabel;
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
      try {
        const allow = JSON.parse(canonical)?.permissions?.allow || [];
        suffixes = [...new Set(allow.map((rule) => rule.slice(rule.indexOf('__', 5) + 2)))];
      } catch {
        suffixes = [];
      }

      const render = () => {
        // Only what a permission rule's server segment can hold. `__` is the
        // separator itself, so a name containing one would silently produce a
        // rule for a different tool — those characters are dropped, not
        // escaped, and the result is shown so the user can see what happened.
        const name = String(field.value || '').trim().replace(/[^A-Za-z0-9.-]/g, '');
        const custom = name && name.toLowerCase() !== 'usernode' && suffixes.length;
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
          return;
        }
        if (!response.ok) throw new Error('Could not load your connections.');
        const data = await response.json();
        if (!data || !Array.isArray(data.connectors)) {
          throw new Error('The connections response was invalid.');
        }
        section.classList.remove('hidden');
        this._connectors = data.connectors;
        this._connectorHint = data.hint || null;
        this._renderConnectors();
      } catch (err) {
        if (loadId !== this._connectorLoadId) return;
        list.textContent = '';
        status.textContent = err.message || 'Could not load your connections.';
        status.classList.remove('hidden', 'text-emerald-500');
        status.classList.add('text-red-500');
      }
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
        text = 'Usernode has not sent you this tip in chat yet. It rides along on the first read it answers in a new conversation.';
      } else {
        const when = Number.isFinite(Date.parse(hint.lastShownAt))
          ? new Date(hint.lastShownAt).toLocaleString()
          : 'recently';
        const times = shown === 1 ? 'once' : `${shown} times`;
        text = `Usernode sent you this tip in chat ${times} in the last ${days} days, most recently ${when}. `;
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
          text += `That is the limit of ${cap} per connection per ${days} days; it will come back once the window rolls over.`;
        } else if (quietUntil > Date.now()) {
          text += `It stays quiet for ${cooldown} minutes after each one, so a conversation opened before `
            + `${new Date(quietUntil).toLocaleTimeString()} will not carry it — one opened after that will.`;
        } else {
          text += 'Open a new conversation to see it again.';
        }
      }
      line.textContent = text;
      line.classList.remove('hidden');
    },

    _renderConnectors() {
      const list = document.getElementById('connectors-list');
      if (!list) return;
      list.textContent = '';
      const connectors = this._connectors || [];
      this._renderConnectorCases(connectors);
      this._renderConnectorHint(connectors);
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

    // ── Social account ownership proofs + Layer-1 credits ────────────────

    _socialIdentityDemoQuery() {
      try {
        const demo = new URLSearchParams(window.location.search).get('demo');
        if (demo === '1' || demo === 'identity-connected'
            || demo === 'identity-unverified' || demo === 'identity-legacy'
            || demo === 'identity-x-misconfigured') {
          return `?demo=${encodeURIComponent(demo)}`;
        }
      } catch { /* ordinary production read */ }
      return '';
    },

    async _loadGithubLink() {
      const section = document.getElementById('github-link-section');
      const body = document.getElementById('github-link-body');
      if (!section || !body) return;
      body.textContent = 'Loading…';
      try {
        const response = await fetch(`/api/me/social-identities${this._socialIdentityDemoQuery()}`, {
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (response.status === 404) {
          section.classList.add('hidden');
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
        this._renderGithubLink();
      } catch {
        body.textContent = 'Could not load social accounts. Try again shortly.';
        section.classList.remove('hidden');
      }
    },

    _renderGithubLink() {
      const body = document.getElementById('github-link-body');
      const status = document.getElementById('github-link-status');
      if (!body) return;
      body.textContent = '';
      if (status) status.classList.add('hidden');
      const payload = this._githubLink || { providers: {}, entitlement: {} };
      body.appendChild(this._socialIdentityTierCard(payload.entitlement));
      ['github', 'x'].forEach((provider) => {
        body.appendChild(this._socialIdentityProviderRow(
          provider,
          payload.providers[provider] || { provider, linked: false, available: false },
          payload.entitlement,
          !!payload.demo
        ));
      });
      this._socialIdentityCallbackStatus(status);
    },

    _socialIdentityTierCard(entitlement) {
      const e = entitlement || {};
      const card = document.createElement('div');
      card.className = 'rounded-lg border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-3 py-2 mb-3';
      const title = document.createElement('div');
      title.className = 'text-sm font-semibold text-zinc-800 dark:text-zinc-200';
      const detail = document.createElement('div');
      detail.className = 'text-xs text-zinc-500 dark:text-zinc-400 mt-1';
      const dollars = `$${(Math.max(0, Number(e.limitCents) || 0) / 100).toFixed(2)}/day`;
      if (e.entitlementAvailable === false) {
        title.textContent = 'Daily credit tier temporarily unavailable';
        detail.textContent = 'Usernode could not verify credit eligibility. Platform-funded calls fail closed; your own API key still works.';
      } else if (e.policy === 'legacy') {
        title.textContent = `Current daily allowance: ${dollars}`;
        detail.textContent = 'Social account linking is available, but identity-based credit tiers are not active on this deployment yet.';
      } else if (e.tier === 'override') {
        title.textContent = `Administrator-set allowance: ${dollars}`;
        detail.textContent = 'This account has an explicit administrator override, which takes precedence over identity tiers.';
      } else if (e.verificationRequired) {
        title.textContent = 'Layer 1 locked · $0/day';
        detail.textContent = 'Connect either GitHub or X below to unlock $10.00/day. A second provider does not add another $10.';
        card.className += ' border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/20';
      } else {
        title.textContent = `Layer 1 unlocked · ${dollars}`;
        detail.textContent = 'At least one social account ownership proof is current. Provider tokens are not stored.';
        card.className += ' border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/20';
      }
      card.append(title, detail);
      return card;
    },

    _socialIdentityProviderRow(provider, link, entitlement, demo) {
      const name = provider === 'github' ? 'GitHub' : 'X';
      const wrap = document.createElement('div');
      wrap.className = 'rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2';
      const row = document.createElement('div');
      row.className = 'flex items-start justify-between gap-3';
      const text = document.createElement('div');
      text.className = 'min-w-0';
      const heading = document.createElement('div');
      heading.className = 'text-sm font-semibold text-zinc-800 dark:text-zinc-200';
      heading.textContent = link.linked && link.handle ? `${name} · @${link.handle}` : name;
      const state = document.createElement('div');
      state.className = 'text-xs mt-1';
      if (link.reconnectRequired) {
        state.className += ' text-amber-600 dark:text-amber-400';
        state.textContent = 'Linked for GitHub attribution · reconnect once to make this identity credit-eligible.';
      } else if (link.linked && entitlement.policy === 'tiered') {
        state.className += ' text-emerald-600 dark:text-emerald-400';
        state.textContent = 'Ownership verified · counts toward the single $10/day social tier.';
      } else if (link.linked) {
        state.className += ' text-zinc-500 dark:text-zinc-400';
        state.textContent = 'Ownership verified · identity credit tiers are not active yet.';
      } else if (link.available === false) {
        state.className += ' text-zinc-500 dark:text-zinc-400';
        state.textContent = `${name} linking is not configured on this deployment.`;
      } else {
        state.className += ' text-zinc-500 dark:text-zinc-400';
        state.textContent = entitlement.verificationRequired
          ? `Not connected · connect ${name} to unlock Layer 1.`
          : 'Not connected.';
      }
      text.append(heading, state);
      if (link.linkedAt && Number.isFinite(Date.parse(link.linkedAt))) {
        const when = document.createElement('div');
        when.className = 'text-xs text-zinc-500 dark:text-zinc-500 mt-1';
        when.textContent = `linked ${new Date(link.linkedAt).toLocaleString()}`;
        text.appendChild(when);
      }
      if (link.linked && link.access === 'identity') {
        const noToken = document.createElement('div');
        if (provider === 'github') noToken.id = 'github-link-no-token';
        noToken.className = 'text-xs text-zinc-500 dark:text-zinc-400 mt-1';
        noToken.textContent = provider === 'github'
          ? 'Usernode holds no GitHub access token for your account.'
          : 'Usernode stores no X access token for your account.';
        text.appendChild(noToken);
      }

      const actions = document.createElement('div');
      actions.className = 'shrink-0 flex flex-wrap justify-end gap-2';
      if ((!link.linked || link.reconnectRequired) && link.available !== false) {
        const label = link.reconnectRequired ? 'Reconnect' : `Connect ${name}`;
        if (demo) {
          const disabled = document.createElement('button');
          disabled.type = 'button';
          disabled.disabled = true;
          disabled.className = 'rounded-md bg-violet-600 px-2 py-1 text-xs font-medium text-white opacity-50';
          disabled.textContent = label;
          actions.appendChild(disabled);
        } else {
          const connect = document.createElement('a');
          connect.href = `/api/me/social-identities/${provider}/connect`;
          connect.className = 'rounded-md bg-violet-600 hover:bg-violet-500 px-2 py-1 text-xs font-medium text-white transition-colors';
          connect.textContent = label;
          actions.appendChild(connect);
        }
      }
      if (link.linked) {
        const unlink = document.createElement('button');
        unlink.type = 'button';
        unlink.disabled = demo;
        unlink.className = 'rounded-md border border-red-400 dark:border-red-700 px-2 py-1 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950 disabled:opacity-50 transition-colors';
        unlink.textContent = 'Disconnect';
        if (!demo) unlink.addEventListener('click', () => this._unlinkGithub(unlink, provider));
        actions.appendChild(unlink);
      }
      row.append(text, actions);
      wrap.append(row, this._socialIdentityAuditNote(provider));
      // A provider that rejects our callback address errors on its own page
      // and never redirects back, so the only trace of that failure is the
      // stranded attempt the server spotted (#1291).
      if (link.pendingAttemptAt) {
        const stranded = document.createElement('p');
        stranded.id = `${provider}-link-pending-note`;
        stranded.className = 'text-xs text-amber-600 dark:text-amber-400 mt-2';
        stranded.textContent = `Your last ${name} connection attempt didn't complete. `
          + `If ${name} showed "Something went wrong — You weren't able to give access to the App", `
          + `the platform's callback address isn't registered on the ${name} developer app — `
          + 'an administrator needs to update that app’s settings.';
        wrap.appendChild(stranded);
      }
      if (link.diagnostics) {
        wrap.appendChild(this._socialIdentityDiagnostics(provider, link.diagnostics, demo));
      }
      return wrap;
    },

    // Admin-only configuration panel for a provider whose OAuth setup can
    // fail invisibly on the provider's own page (#1291): names the
    // credential pair in use, the exact callback URL the developer app must
    // register, and a live check of the pair against X's token endpoint.
    _socialIdentityDiagnostics(provider, diagnostics, demo) {
      const name = provider === 'github' ? 'GitHub' : 'X';
      const panel = document.createElement('div');
      panel.id = `${provider}-link-diagnostics`;
      panel.className = 'mt-2 rounded-md border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-2.5 py-2 text-xs';

      const source = document.createElement('div');
      source.className = 'font-medium text-zinc-700 dark:text-zinc-300';
      if (diagnostics.credentialSource === 'waitlist') {
        source.textContent = `Reusing the waitlist ${name} app’s credentials.`;
      } else if (diagnostics.credentialSource === 'dedicated') {
        source.textContent = diagnostics.sameAppAsWaitlist
          ? `Dedicated ${name} credentials — same app as the waitlist pair.`
          : `Dedicated ${name} app credentials.`;
      } else {
        source.textContent = `No complete ${name} credential pair is configured.`;
      }
      panel.appendChild(source);

      const cbRow = document.createElement('div');
      cbRow.className = 'mt-1 flex items-center gap-2 min-w-0';
      const cbLabel = document.createElement('span');
      cbLabel.className = 'text-zinc-500 dark:text-zinc-400 shrink-0';
      cbLabel.textContent = 'Callback URI:';
      const cbCode = document.createElement('code');
      cbCode.className = 'truncate text-zinc-700 dark:text-zinc-300 bg-zinc-100 dark:bg-zinc-800 rounded px-1 py-0.5';
      cbCode.textContent = diagnostics.callbackUrl || '';
      const cbCopy = document.createElement('button');
      cbCopy.type = 'button';
      cbCopy.className = 'shrink-0 rounded border border-zinc-300 dark:border-zinc-600 px-1.5 py-0.5 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors';
      cbCopy.textContent = 'Copy';
      cbCopy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(diagnostics.callbackUrl || '');
          cbCopy.textContent = 'Copied';
          setTimeout(() => { cbCopy.textContent = 'Copy'; }, 1500);
        } catch { /* clipboard unavailable — the address is still visible */ }
      });
      cbRow.append(cbLabel, cbCode, cbCopy);
      panel.appendChild(cbRow);

      const warning = document.createElement('p');
      warning.className = 'mt-1 text-zinc-500 dark:text-zinc-400';
      warning.textContent = `If this address isn’t registered as a callback URI on the ${name} developer app, `
        + `${name} shows "Something went wrong" before sign-in and never redirects back here.`;
      panel.appendChild(warning);

      const checkRow = document.createElement('div');
      checkRow.className = 'mt-2 flex items-start gap-2';
      const checkButton = document.createElement('button');
      checkButton.type = 'button';
      checkButton.id = `${provider}-link-check`;
      checkButton.className = 'shrink-0 rounded-md border border-violet-400 dark:border-violet-700 px-2 py-1 font-medium text-violet-700 dark:text-violet-300 hover:bg-violet-50 dark:hover:bg-violet-950 disabled:opacity-50 transition-colors';
      checkButton.textContent = 'Run configuration check';
      const checkResult = document.createElement('span');
      checkResult.className = 'text-zinc-500 dark:text-zinc-400 pt-1';
      checkButton.addEventListener('click', async () => {
        checkButton.disabled = true;
        checkResult.className = 'text-zinc-500 dark:text-zinc-400 pt-1';
        checkResult.textContent = 'Checking…';
        try {
          let verdict;
          if (demo) {
            verdict = { clientAuth: 'ok' };
          } else {
            const response = await fetch('/api/me/social-identities/x/check', {
              method: 'POST',
              credentials: 'same-origin',
              cache: 'no-store',
            });
            if (!response.ok) throw new Error(`Check failed (${response.status})`);
            verdict = await response.json();
          }
          if (verdict.clientAuth === 'ok') {
            checkResult.className = 'text-emerald-600 dark:text-emerald-400 pt-1';
            checkResult.textContent = `${name} accepted the platform’s client credentials. `
              + `If connecting still fails on ${name}’s own page, the callback address above `
              + `is not registered on the ${name} app.`;
          } else if (verdict.clientAuth === 'rejected') {
            checkResult.className = 'text-red-600 dark:text-red-400 pt-1';
            checkResult.textContent = `${name} rejected the platform’s client ID or secret — `
              + 'the configured credential pair is wrong.';
          } else {
            checkResult.className = 'text-amber-600 dark:text-amber-400 pt-1';
            checkResult.textContent = `Couldn’t reach ${name} to verify the credentials. Try again shortly.`;
          }
        } catch {
          checkResult.className = 'text-red-600 dark:text-red-400 pt-1';
          checkResult.textContent = 'The configuration check failed to run. Try again shortly.';
        } finally {
          checkButton.disabled = false;
        }
      });
      checkRow.append(checkButton, checkResult);
      panel.appendChild(checkRow);
      return panel;
    },

    // "Don't take our word for it": GitHub's own page lists what every
    // authorized OAuth app can reach, so the claim above is checkable in one
    // click. Deliberately a top-level link (target=_blank + noopener) — the
    // shell is framed, and github.com refuses to be framed.
    _githubAuditNote() {
      return this._socialIdentityAuditNote('github');
    },

    _socialIdentityAuditNote(provider) {
      const note = document.createElement('p');
      if (provider === 'github') note.id = 'github-link-audit-note';
      note.className = 'text-xs text-zinc-500 dark:text-zinc-500 mt-2';
      note.appendChild(document.createTextNode('Review or revoke this authorization at '));
      const anchor = document.createElement('a');
      anchor.href = provider === 'github'
        ? 'https://github.com/settings/applications'
        : 'https://x.com/settings/connected_apps';
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      anchor.className = 'text-violet-600 dark:text-violet-400 hover:underline';
      anchor.textContent = provider === 'github'
        ? 'github.com/settings/applications'
        : 'x.com/settings/connected_apps';
      note.appendChild(anchor);
      note.appendChild(document.createTextNode('.'));
      return note;
    },

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
      const messages = {
        linked: `${name} connected.`,
        conflict: `That ${name} account is already linked elsewhere, or a different account must be disconnected first.`,
        denied: `${name} connection was cancelled.`,
        error: `${name} could not be connected. Try again.`,
      };
      status.textContent = messages[result] || '';
      if (!status.textContent) return;
      status.classList.remove('hidden', 'text-red-500', 'text-emerald-500');
      status.classList.add(result === 'linked' ? 'text-emerald-500' : 'text-red-500');
    },

    async _unlinkGithub(button, provider = 'github') {
      const status = document.getElementById('github-link-status');
      if (button) button.disabled = true;
      try {
        const response = await fetch(`/api/me/social-identities/${encodeURIComponent(provider)}`, {
          method: 'DELETE',
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (!response.ok) throw new Error(`Could not disconnect ${provider === 'x' ? 'X' : 'GitHub'}.`);
        await this._loadGithubLink();
      } catch (err) {
        if (button) button.disabled = false;
        if (status) {
          status.textContent = err.message || 'Could not disconnect this account.';
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
      // Staging disables the real CLI surface, but ?demo=1 is a read-only
      // fixture endpoint specifically meant to make this section reviewable.
      // Let that mock path through while still suppressing every real token
      // request when auth/me advertises cliAuthEnabled=false.
      if (!this._cliTokensDemo() && !(await this._cliAuthAvailable())) {
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
      this._mobilePushLoadToken += 1;
    },

    // Clear the "Send a test alert" countdown interval (#138). Idempotent —
    // safe to call when none is running (rapid re-clicks, modal close).
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
      if (!Array.isArray(preferences)) throw new Error('Invalid preferences response.');
      const next = {};
      for (const preference of preferences) {
        if (!preference || typeof preference.key !== 'string'
            || typeof preference.enabled !== 'boolean') {
          throw new Error('Invalid preferences response.');
        }
        next[preference.key] = preference.enabled;
      }
      for (const row of this._mobilePushRows()) {
        if (typeof next[row.dataset.mobilePushCategory] !== 'boolean') {
          throw new Error('Incomplete preferences response.');
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
      status.textContent = message || (disabled ? 'Loading mobile push preferences…' : 'Saved to your account.');
      status.className = 'text-xs mt-3 ' + (error
        ? 'text-red-600 dark:text-red-400'
        : 'text-zinc-500 dark:text-zinc-400');
    },

    async _loadMobilePushPreferences() {
      const token = ++this._mobilePushLoadToken;
      this._mobilePushLoading = true;
      this._renderMobilePushPreferences('Loading mobile push preferences…');
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
        this._renderMobilePushPreferences('Saved to your account.');
      } catch (err) {
        if (token !== this._mobilePushLoadToken) return;
        this._mobilePushLoading = false;
        this._mobilePushPreferences = null;
        this._renderMobilePushPreferences(
          `Could not load mobile push preferences: ${err.message}`, true
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
      this._renderMobilePushPreferences('Saving…');
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
        this._renderMobilePushPreferences('Saved to your account.');
      } catch (err) {
        this._mobilePushPreferences[category] = previous;
        this._mobilePushSaving = false;
        this._renderMobilePushPreferences(`Could not save: ${err.message}`, true);
        if (window.PlatformUI) PlatformUI.toast('Could not save mobile push preferences');
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

    // ── OpenRouter (BYOK) ──────────────────────────────────────
    _normalizeOpenRouterCopy() {
      const section = document.querySelector('[data-settings-section="openrouter"]');
      if (!section) return;
      const heading = section.querySelector('h3');
      const intro = section.querySelector('p');
      const modelLabel = section.querySelector('label[for="settings-openrouter-model"]');
      if (heading) heading.textContent = 'OpenRouter';
      if (intro) {
        intro.textContent = 'Use any compatible model exposed by your OpenRouter key for all chat and coding in an OpenRouter session. These sessions do not use your platform Claude allowance. Your key is encrypted at rest, injected only for each turn, and removed completely when you delete it here.';
      }
      if (modelLabel) modelLabel.textContent = 'OpenRouter model';
      const betaGate = document.getElementById('settings-openrouter-beta-gated');
      if (betaGate) betaGate.textContent = 'OpenRouter is being rolled out gradually and is not available for your account yet.';
    },

    _formatOpenRouterPrice(value) {
      if (value == null || value === '') return null;
      const price = Number(value);
      if (!Number.isFinite(price) || price < 0) return null;
      if (price === 0) return '$0';
      const decimals = price < 0.01 ? 4 : price < 10 ? 2 : price < 100 ? 1 : 0;
      const fixed = price.toFixed(decimals);
      const compact = fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
      return `$${compact}`;
    },

    _openRouterModelCostSummary(model) {
      const tier = {
        free: 'Free',
        low: 'Low cost',
        medium: 'Medium cost',
        high: 'High cost',
        unknown: 'Price unavailable',
      }[model?.costTier] || 'Price unavailable';
      const input = this._formatOpenRouterPrice(model?.inputPricePerMillion);
      const output = this._formatOpenRouterPrice(model?.outputPricePerMillion);
      if (!input && !output) return tier;
      return `${tier} · ${input || '?'} /M input · ${output || '?'} /M output`;
    },

    _openRouterModelOptionLabel(model) {
      const compatibility = model?.compatibility === 'verified'
        ? ' · verified'
        : (model?.compatibility === 'blocked' ? ' · limited' : ' · unverified');
      return `${model?.name || model?.id || 'Unknown model'} — ${this._openRouterModelCostSummary(model)}${compatibility}`;
    },

    _syncOpenRouterModelDetails() {
      const select = document.getElementById('settings-openrouter-model');
      const effort = document.getElementById('settings-openrouter-reasoning');
      const model = this._openRouterModels.find((item) => item.id === select?.value) || null;
      if (!model) {
        if (select) select.title = 'Models are sorted by average input/output price. Actual spend depends on token usage.';
        if (effort) effort.disabled = true;
        return;
      }
      let compatibility = 'Not yet verified for repository coding.';
      if (model.compatibility === 'verified') compatibility = 'Verified for repository coding.';
      else if (!model.meetsCodexMinimums) {
        compatibility = model.compatibilityNote
          || 'This model may lack repository tools or enough context, so an OpenRouter turn may fail.';
      }
      if (select) select.title = `${this._openRouterModelCostSummary(model)}. ${compatibility} Actual spend depends on token usage.`;
      if (effort) {
        effort.disabled = model.supportsReasoning !== true;
        if (effort.disabled) effort.value = '';
        effort.title = effort.disabled
          ? 'This model does not expose reasoning-effort controls.'
          : 'Optional OpenRouter reasoning effort for this model.';
      }
    },

    _setOrStatus(text, kind) {
      const el = document.getElementById('settings-openrouter-status');
      if (!el) return;
      el.textContent = text;
      el.classList.remove('hidden', 'text-red-500', 'text-emerald-500', 'text-zinc-500');
      const cls = kind === 'error' ? 'text-red-500' : kind === 'ok' ? 'text-emerald-500' : 'text-zinc-500';
      el.classList.add(cls);
    },

    async _refreshOpenRouter() {
      const betaGate = document.getElementById('settings-openrouter-beta-gated');
      const display = document.getElementById('settings-openrouter-key-display');
      const last4 = document.getElementById('settings-openrouter-key-last4');
      const info = document.getElementById('settings-openrouter-key-info');
      const removeBtn = document.getElementById('settings-openrouter-remove');
      const input = document.getElementById('settings-openrouter-key');
      const saveBtn = document.getElementById('settings-openrouter-save');
      const modelsWrap = document.getElementById('settings-openrouter-models-wrap');
      try {
        const r = await fetch('/api/me/coding-agent', { credentials: 'same-origin' });
        const prefs = r.ok ? await r.json() : {};
        const isBeta = !!prefs.codexAvailable;
        if (betaGate) betaGate.classList.toggle('hidden', isBeta);
        if (!isBeta) { if (modelsWrap) modelsWrap.classList.add('hidden'); return; }
      } catch {}
      try {
        const r = await fetch('/api/me/credentials/openrouter', { credentials: 'same-origin' });
        const j = r.ok ? await r.json() : {};
        if (j.configured) {
          if (display) display.classList.remove('hidden');
          if (last4) last4.textContent = j.last4 || '••••';
          if (removeBtn) removeBtn.classList.remove('hidden');
          if (input) { input.placeholder = 'Paste a new key to replace'; input.value = ''; }
          if (saveBtn) saveBtn.textContent = 'Replace';
          if (info && j.keyInfo) {
            info.classList.remove('hidden');
            const lim = j.keyInfo.limit != null ? `$${j.keyInfo.limit}` : '';
            const rem = j.keyInfo.limitRemaining != null ? `$${j.keyInfo.limitRemaining}` : '';
            info.textContent = lim ? `Key limit: ${lim} · Remaining: ${rem}` : (j.keyInfo.label || '');
          }
          await this._loadOpenRouterModels();
        } else {
          if (display) display.classList.add('hidden');
          if (removeBtn) removeBtn.classList.add('hidden');
          if (input) input.placeholder = 'sk-or-...';
          if (saveBtn) saveBtn.textContent = 'Test & save';
          if (info) info.classList.add('hidden');
          if (modelsWrap) modelsWrap.classList.add('hidden');
        }
      } catch {}
    },

    async _loadOpenRouterModels() {
      const sel = document.getElementById('settings-openrouter-model');
      const wrap = document.getElementById('settings-openrouter-models-wrap');
      if (!sel) return;
      try {
        const r = await fetch('/api/me/coding-agent/models?backend=codex_openrouter', { credentials: 'same-origin' });
        if (!r.ok) { if (wrap) wrap.classList.add('hidden'); return; }
        const cat = await r.json();
        const models = Array.isArray(cat.models) ? cat.models : [];
        this._openRouterModels = models;
        if (!models.length) { if (wrap) wrap.classList.add('hidden'); return; }
        // Build options with DOM methods, NOT innerHTML (review P2):
        // OpenRouter model IDs/names are untrusted catalog data and
        // could inject markup into the authenticated Settings page.
        sel.innerHTML = '';
        for (const m of models) {
          const opt = document.createElement('option');
          opt.value = m.id;
          opt.textContent = this._openRouterModelOptionLabel(m);
          sel.appendChild(opt);
        }
        const recommended = models.some((model) => model.id === cat.recommendedModelId)
          ? cat.recommendedModelId
          : (models.find((model) => model.compatibility === 'verified')?.id || models[0].id);
        sel.value = recommended;
        // Restore the previously-saved model/effort if any.
        const prefs = await (await fetch('/api/me/coding-agent', { credentials: 'same-origin' })).json();
        const saved = prefs.backends?.codex_openrouter;
        if (saved?.model && models.some((model) => model.id === saved.model)) sel.value = saved.model;
        const eff = document.getElementById('settings-openrouter-reasoning');
        if (eff) eff.value = saved?.reasoningEffort || '';
        this._syncOpenRouterModelDetails();
        if (wrap) wrap.classList.remove('hidden');
      } catch {
        this._openRouterModels = [];
      }
    },

    async _saveOpenRouterKey() {
      const input = document.getElementById('settings-openrouter-key');
      const saveBtn = document.getElementById('settings-openrouter-save');
      const key = input?.value?.trim();
      if (!key) { this._setOrStatus('Paste an OpenRouter API key first.', 'error'); return; }
      if (saveBtn) saveBtn.disabled = true;
      this._setOrStatus('Verifying with OpenRouter…', 'info');
      try {
        const r = await fetch('/api/me/credentials/openrouter', {
          method: 'PUT', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey: key }),
        });
        const j = await r.json();
        if (!r.ok) { this._setOrStatus(j.error || 'Failed to save key.', 'error'); return; }
        this._setOrStatus('Saved and encrypted. OpenRouter sessions bill to this key.', 'ok');
        input.value = '';
        await this._refreshOpenRouter();
      } catch (err) {
        this._setOrStatus(`Network error: ${err.message}`, 'error');
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
        if (!r.ok) { this._setOrStatus(j.error || 'Failed to remove key.', 'error'); return; }
        const note = j.defaultReset ? ' Key removed; your default agent was reset to Claude Code.' : '';
        this._setOrStatus('Key removed.' + note, 'ok');
        this._openRouterModels = [];
        await this._refreshOpenRouter();
      } catch {
        this._setOrStatus('Failed to remove key.', 'error');
      } finally {
        if (removeBtn) removeBtn.disabled = false;
      }
    },

    async _saveOpenRouterDefault() {
      const model = document.getElementById('settings-openrouter-model')?.value;
      const reasoningEffort = document.getElementById('settings-openrouter-reasoning')?.value || null;
      // Preserve the user's existing cost cap across this save (review P3):
      // include it explicitly so an omission can't drop the safety limit,
      // and the server also COALESCEs when omitted.
      let maxTurnCostUsd = null;
      try {
        const prefs = await (await fetch('/api/me/coding-agent', { credentials: 'same-origin' })).json();
        maxTurnCostUsd = prefs.backends?.codex_openrouter?.maxTurnCostUsd ?? null;
      } catch {}
      try {
        const r = await fetch('/api/me/coding-agent', {
          method: 'PATCH', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ defaultBackend: 'codex_openrouter', model, reasoningEffort, maxTurnCostUsd }),
        });
        if (!r.ok) { const j = await r.json().catch(() => ({})); this._setOrStatus(j.error || 'Failed to save.', 'error'); return; }
        this._setOrStatus('OpenRouter saved as your default session AI.', 'ok');
      } catch { this._setOrStatus('Network error.', 'error'); }
    },

    async _saveClaudeDefault() {
      // Reciprocal default control (review #8): set Claude Code (the
      // legacy backend) as the user's default coding agent. Sends no model
      // so it doesn't pin a Claude model either.
      try {
        const r = await fetch('/api/me/coding-agent', {
          method: 'PATCH', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ defaultBackend: 'claude_code' }),
        });
        if (!r.ok) { const j = await r.json().catch(() => ({})); this._setOrStatus(j.error || 'Failed to save.', 'error'); return; }
        this._setOrStatus('Claude Code is now your default coding agent.', 'ok');
      } catch { this._setOrStatus('Network error.', 'error'); }
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

    _setCuStatus(text, kind) {
      const el = document.getElementById('cu-status');
      if (!el) return;
      el.textContent = text;
      el.classList.remove('hidden', 'text-red-500', 'text-emerald-500', 'text-zinc-500');
      const cls = kind === 'error' ? 'text-red-500' : kind === 'ok' ? 'text-emerald-500' : 'text-zinc-500';
      el.classList.add(cls);
    },

    // Paint the current handle. Called from _renderAllSections on every
    // open, so the row is right even after a rename made somewhere else in
    // this tab (or in another one, once /api/auth/me is re-read).
    _renderChangeUsernameSection() {
      const cur = document.getElementById('cu-current');
      if (!cur) return;
      const name = (typeof App !== 'undefined' && App.user && App.user.username) || '';
      cur.textContent = name ? `@${name}` : '—';
    },

    // POST /api/me/username. The server is the authority on every rule
    // here (charset, reserved names, availability against the retired
    // ledger, the cooldown, the password); this only avoids a round-trip
    // for the two states the form can see on its own.
    async changeUsername() {
      const nameEl = document.getElementById('cu-new');
      const pwEl = document.getElementById('cu-password');
      const btn = document.getElementById('cu-save');
      if (!nameEl || !pwEl || !btn) return;

      const username = nameEl.value.trim();
      const currentPassword = pwEl.value;

      if (!username) { this._setCuStatus('Enter a new username.', 'error'); return; }
      if (!currentPassword) { this._setCuStatus('Enter your current password.', 'error'); return; }

      btn.disabled = true;
      this._setCuStatus('Saving…', 'info');
      try {
        const r = await fetch('/api/me/username', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ username, currentPassword }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { this._setCuStatus(j.error || 'Failed to change username.', 'error'); return; }

        nameEl.value = '';
        pwEl.value = '';

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
        this._renderChangeUsernameSection();

        this._setCuStatus(
          j.unchanged
            ? 'That is already your username.'
            : `You are now @${j.username}.`,
          'ok',
        );
      } catch (err) {
        this._setCuStatus(`Network error: ${err.message}`, 'error');
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
      let preflight = {
        nativeTerminal: false, latch: 'unsupported', reason: null, code: null,
      };
      try {
        if (window.NativeChrome && NativeChrome.prepareWebLogout) {
          const result = await NativeChrome.prepareWebLogout();
          preflight = (result && typeof result === 'object')
            ? result
            : {
              nativeTerminal: result === true,
              latch: 'unsupported',
              reason: null,
              code: null,
            };
        }
      } catch (error) {
        // prepareWebLogout resolves a report now, but a rejection must not
        // be a dead end either — treat it exactly like a refused latch.
        console.warn('[settings] native logout preflight failed:', error);
        preflight = {
          nativeTerminal: false,
          latch: 'unavailable',
          reason: (error && error.message) ? String(error.message) : null,
          code: null,
        };
      }

      // THE DEAD END THIS REMOVES: a refused privileged bridge used to
      // abort here, BEFORE POST /api/auth/logout, so the web session
      // survived and the user had no way out of the app at all. The
      // admission latches are already closed; ask, then sign out of the
      // web session regardless. The app's own session is attempted
      // best-effort below and named on the landing screen if it survives.
      const degraded = preflight.latch === 'unavailable' ||
        preflight.latch === 'inconclusive';
      if (degraded && !await this._confirmDegradedSignOut(preflight)) {
        if (btn) btn.disabled = false;
        return false;
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
      if (preflight.nativeTerminal) {
        // FIXME: if this rejects after web cleanup, add a fail-closed retry UI
        // without resuming normal work in this old document.
        return NativeChrome.commitNativeLogout();
      }

      if (degraded && !await this._bestEffortNativeLogout()) {
        // The app kept its session. Say so on the next screen rather than
        // leaving the user to discover it, and point at the fix.
        this._noteIncompleteNativeSignOut();
      }

      // Hard navigation on purpose: enterAuthed is one-shot per document
      // in a regular browser or an old app without hard logout. `/` boots
      // the anonymous shell on the landing screen — the public app
      // directory a guest normally sees — instead of the bare sign-in
      // form (#1159); the landing header's Sign in CTA keeps re-login one
      // tap away.
      window.location.href = '/';
    },

    // The user's call, not ours: the web session is going either way, but
    // they should know the app may stay signed in on this device.
    _confirmDegradedSignOut(preflight) {
      if (!window.PlatformUI || typeof PlatformUI.confirm !== 'function') {
        // No dialog to ask with is not a reason to trap someone in a
        // session — proceed, and the login-screen notice still fires.
        return Promise.resolve(true);
      }
      const detail = preflight && preflight.reason
        ? ` (${preflight.reason})`
        : '';
      return PlatformUI.confirm({
        title: 'Sign out without the app?',
        message: 'The Usernode app isn’t responding to this screen' +
          detail + ', so it may stay signed in on this device. ' +
          'You’ll be signed out of Social either way — force-close ' +
          'and reopen the app to finish signing out there.',
        confirmLabel: 'Sign out anyway',
        cancelLabel: 'Cancel',
        danger: true,
      });
    },

    // The app may still accept a plain logout even though its privileged
    // latch never answered. Try, briefly, and swallow the rejection: the
    // web session is already gone, so nothing here may block the user from
    // leaving. Resolves whether the app accepted it.
    NATIVE_SIGNOUT_BUDGET_MS: 3000,

    _bestEffortNativeLogout() {
      const bridge = window.usernode;
      if (!bridge || bridge.isNative !== true ||
          typeof bridge.logout !== 'function') {
        return Promise.resolve(false);
      }
      return new Promise((resolve) => {
        let done = false;
        const settle = (ok) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(ok);
        };
        const timer = setTimeout(() => settle(false),
          this.NATIVE_SIGNOUT_BUDGET_MS);
        try {
          bridge.logout().then(() => settle(true), (err) => {
            console.warn('[settings] best-effort native logout failed:', err);
            settle(false);
          });
        } catch (err) {
          console.warn('[settings] best-effort native logout threw:', err);
          settle(false);
        }
      });
    },

    NATIVE_SIGNOUT_NOTICE_KEY: 'sv:native_signout_incomplete',

    _noteIncompleteNativeSignOut() {
      try {
        sessionStorage.setItem(this.NATIVE_SIGNOUT_NOTICE_KEY, '1');
      } catch (_) { /* private mode / disabled storage: nothing to note */ }
    },

    // One-shot, on the next document — which is the landing screen, since
    // logout hard-navigates to `/`. Without it the user lands there with
    // no idea the app may still hold its own session.
    _showIncompleteNativeSignOutNotice() {
      let flagged = false;
      try {
        flagged = sessionStorage.getItem(this.NATIVE_SIGNOUT_NOTICE_KEY) === '1';
        if (flagged) sessionStorage.removeItem(this.NATIVE_SIGNOUT_NOTICE_KEY);
      } catch (_) { return; }
      if (!flagged) return;
      if (!window.PlatformUI || typeof PlatformUI.toast !== 'function') return;
      PlatformUI.toast(
        'Signed out of Social. The Usernode app didn’t confirm — ' +
        'force-close and reopen it to finish signing out there.',
        { duration: 10000, priority: true }
      );
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
      'page-changed': 'The request was cancelled because this page changed.',
      'privileged-unavailable': 'The Usernode app refused this screen’s ' +
        'secure connection. See “Usernode app — connection” below.',
    },
    USERNODE_READ_ERROR_FALLBACK: 'The Usernode app returned no settings.',

    // ── The connection panel ──────────────────────────────────────────
    //
    // Plain-language reason per privileged-handshake `state` (the record
    // from usernode.getBridgeDiagnostics). The remedies are ordered the
    // way the report that prompted this was: force-close and reopen
    // FIRST, reinstall only if that doesn't clear it.
    PRIVILEGED_STATE_LABELS: {
      'ready': 'Connected',
      'blocked-frame': 'Refused',
      'unsupported': 'Not in this app build',
      'inconclusive': 'Unconfirmed',
      'unattached': 'No answer',
      'unknown': 'Not needed yet',
    },
    PRIVILEGED_STATE_REASONS: {
      'ready': 'This screen can manage the app’s settings.',
      'blocked-frame': 'The app is refusing this screen’s secure ' +
        'connection, so app settings and app sign-out can’t be ' +
        'changed from here. Force-close the app and reopen it — that ' +
        'usually re-establishes it. If it keeps happening, reinstalling ' +
        'the app clears the stuck state.',
      'unsupported': 'This app build predates the secure connection this ' +
        'screen uses. Update the Usernode app to manage its settings here.',
      'inconclusive': 'The app hasn’t answered yet, so we can’t ' +
        'tell whether the secure connection is up. It may still be ' +
        'starting — try again in a moment.',
      'unattached': 'The app never answered this screen’s secure ' +
        'connection request. Force-close the app and reopen it; if that ' +
        'doesn’t help, reinstalling the app clears the stuck state.',
      'unknown': 'This screen hasn’t needed the app’s secure ' +
        'connection yet.',
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
      bridgeVersion: 4,
      capabilities: ['getBridgeInfo', 'getSettingsState', 'logout'],
      appVersion: '0.0.0-demo',
      buildNumber: '0',
      privileged: {
        state: 'blocked-frame',
        code: 'privileged_frame_unauthorized',
        kind: 'privileged-unavailable',
        message: 'Staging demo — privileged bridge is unavailable for this main frame',
        at: 0,
        attempts: 3,
      },
      lastErrors: {
        getSettingsState: {
          method: 'getSettingsState',
          kind: 'privileged-unavailable',
          message: 'Staging demo — privileged bridge is unavailable for this main frame',
          at: 0,
        },
      },
      collectedAt: 0,
    },

    _bridgeDiagDemo() {
      return this._demoParam('bridgediag') === 'demo';
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
    _unDemoMode() {
      const v = this._demoParam('usernodedemo');
      return (v === 'ios' || v === 'ios-denied') ? v : null;
    },

    DEMO_USERNODE_STATE: {
      buildInfo: { appVersion: '0.0.0-demo', buildNumber: '0' },
      nodeSleepEnabled: true,
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
      lastHealOutcome: 'sent 1',
      readError: {
        method: 'getBridgeInfo',
        kind: 'timeout',
        message: 'Staging demo — the capability probe did not answer',
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

    // ── Settings → "Usernode app — widget icons" ──────────────────────
    //
    // Gated on being in the app (or the demo link), NEVER on the
    // capability or the mechanism: this box exists to explain why the
    // widget looks wrong, and every interesting case is one where some
    // part of that chain answered "no". Hiding it on a "no" would hide it
    // exactly when it is wanted — the same mistake the connection panel
    // above was written to undo.
    _renderWidgetIconsSection(parent) {
      const diag = this._widgetIconDiagnostics();
      if (!diag) return;
      const box = this._unSection(parent, 'Usernode app — widget icons',
        'What the homescreen widget was told to show, and what it reports back.');
      if (this._widgetIconsDemo()) {
        box.appendChild(this._unEl('p',
          'text-xs font-medium text-amber-600 dark:text-amber-400 mb-2',
          'Staging demo — sample data'));
      }
      const isWidget = diag.mechanism === 'widget';
      this._unStatusRow(box, 'Widget shortcuts', isWidget, 'Available',
        diag.mechanism ? `Not this device (${diag.mechanism})` : 'Not available',
        { id: 'settings-widget-mechanism-row' });
      this._unStatusRow(box, 'Pinned registry', diag.registryLoaded === true,
        `Loaded — ${diag.entries.length} pinned`, 'Could not be read',
        { id: 'settings-widget-registry-row' });
      // Tri-state, and the third state is the point: `has()` used to
      // collapse "couldn't say" into "no", which is what latched the
      // single-face path for a whole page load.
      this._unStatusRow(box, 'Dark icon capability', diag.capability === true,
        'Advertised by the app',
        diag.capability === false ? 'Not advertised' : 'The app couldn’t say',
        { id: 'settings-widget-capability-row' });
      this._unStatusRow(box, 'Confirmed by the widget',
        diag.verdict === 'supported', 'Stores both faces',
        diag.verdict === 'unsupported' ? 'Single face only' : 'Not confirmed yet',
        { id: 'settings-widget-verdict-row' });
      const sending = diag.resolved === true
        ? 'Light + dark pair'
        : (diag.resolved === false
          ? `Single face (${diag.scheme})`
          : 'Undecided — single face for now');
      this._unStatusRow(box, 'Sending', diag.resolved === true, sending, sending,
        { id: 'settings-widget-sending-row' });
      const build = diag.build
        ? `${diag.build.appVersion} (${diag.build.buildNumber || '?'})`
        : 'unknown — the verdict is re-confirmed each time';
      box.appendChild(this._unEl('p',
        'text-xs text-zinc-500 dark:text-zinc-500 mt-2',
        `Verdict bound to app version: ${build}`));
      const healedAt = diag.lastHealAt
        ? this._widgetIconTime(diag.lastHealAt)
        : 'never';
      box.appendChild(this._unEl('p',
        'text-xs text-zinc-500 dark:text-zinc-500',
        `Last icon check: ${healedAt}` +
        (diag.lastHealOutcome ? ` — ${diag.lastHealOutcome}` : '')));
      if (diag.readError) {
        const reason = this.USERNODE_READ_ERROR_REASONS[diag.readError.kind] ||
          this.USERNODE_READ_ERROR_FALLBACK;
        box.appendChild(this._unEl('p',
          'text-xs text-amber-600 dark:text-amber-400 mt-2',
          `${diag.readError.method}: ${reason}`));
      }
      this._renderWidgetIconEntries(box, diag);
      if (!this._widgetIconsDemo()) {
        this._unButton(box, 'Re-check icons', async () => {
          const home = window.Home;
          if (home && typeof home._refreshWidgetItems === 'function') {
            // Clears the one-attempt-per-load cap so the pass this
            // triggers actually re-sends anything it finds wrong.
            home._iconHealTried = null;
            await home._refreshWidgetItems();
          }
          this._renderUsernodeBody();
        });
      }
    },

    _widgetIconTime(ms) {
      try { return new Date(ms).toLocaleTimeString(); } catch (_) { return String(ms); }
    },

    // One line per pinned entry: what the widget says it holds, and
    // whether that matches what SV believes it last sent. A mismatch here
    // is the difference between "SV never sent it" and "SV sent it and
    // the app didn't keep it" — which are different bugs in different
    // repositories, and were previously indistinguishable from outside.
    _renderWidgetIconEntries(box, diag) {
      if (!diag.entries.length) {
        box.appendChild(this._unEl('p',
          'text-xs text-zinc-500 dark:text-zinc-500 mt-2',
          'No shortcuts are pinned to the widget.'));
        return;
      }
      const list = this._unEl('div', 'mt-3 space-y-1');
      list.id = 'settings-widget-icon-entries';
      diag.entries.forEach((entry) => {
        const flag = (v) => (v === true ? 'yes' : (v === false ? 'no' : '—'));
        const row = this._unEl('div',
          'flex items-center gap-2 text-xs ' +
          'text-zinc-600 dark:text-zinc-400');
        const healthy = entry.foreign
          ? true
          : entry.hasIcon !== false && entry.matches;
        row.appendChild(this._unEl('span',
          'w-1.5 h-1.5 rounded-full shrink-0 ' +
          (healthy ? 'bg-emerald-500' : 'bg-amber-500')));
        row.appendChild(this._unEl('span',
          'text-zinc-700 dark:text-zinc-300', entry.name));
        const note = entry.foreign
          ? 'pinned by another app'
          : (entry.unknownApp
            ? 'app not loaded'
            : `icon ${flag(entry.hasIcon)} · dark ${flag(entry.hasIconDark)} · ` +
              `sent ${entry.matches ? 'current' : 'stale'}`);
        row.appendChild(this._unEl('span', 'ml-auto', note));
        list.appendChild(row);
      });
      box.appendChild(list);
    },

    _bridgeDiagnostics() {
      if (this._bridgeDiagDemo()) return this.DEMO_BRIDGE_DIAGNOSTICS;
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

    // The copyable report. Deliberately assembled from the diagnostics
    // snapshot only — it carries no capability token, no session cookie
    // and no user data, so it is safe to paste into an issue.
    _bridgeDiagnosticsText(diag) {
      const at = (ms) => {
        if (!ms) return 'never';
        try { return new Date(ms).toISOString(); } catch (_) { return String(ms); }
      };
      const lines = [
        'Usernode bridge diagnostics',
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
        lines.push(`  ${method}: ${rec.kind} — ${rec.message || 'no message'} ` +
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
        lines.push(`last session failure: ${session.stage} — ` +
          `${session.message || 'no message'} (${at(session.at)})`);
      }
      return lines.join('\n');
    },

    // Rendered FIRST inside the Usernode app section and independent of
    // the settings snapshot: when the handshake is refused there is no
    // snapshot, and this panel is the only thing that can say why.
    _renderUsernodeConnection(section) {
      const diag = this._bridgeDiagnostics();
      if (!diag) return null;
      const demo = this._bridgeDiagDemo();
      const box = this._unSection(section, 'Usernode app — connection',
        'What this screen can reach in the app, and what to do when it can’t.');
      box.id = 'settings-usernode-connection';
      if (demo) {
        box.appendChild(this._unEl('p',
          'text-xs font-medium text-amber-600 dark:text-amber-400 mb-2',
          'Staging demo — sample data'));
      }
      const state = (diag.privileged && diag.privileged.state) || 'unknown';
      this._unStatusRow(box, 'Secure app connection', state === 'ready',
        this.PRIVILEGED_STATE_LABELS.ready,
        this.PRIVILEGED_STATE_LABELS[state] || 'Unavailable');
      box.appendChild(this._unEl('p',
        'text-xs text-zinc-500 dark:text-zinc-400 mt-2',
        this.PRIVILEGED_STATE_REASONS[state] ||
          this.PRIVILEGED_STATE_REASONS.unknown));
      const buildBits = [];
      if (diag.appVersion) {
        buildBits.push(`App ${diag.appVersion}` +
          (diag.buildNumber ? ` (${diag.buildNumber})` : ''));
      }
      buildBits.push(`Bridge v${diag.bridgeVersion}`);
      box.appendChild(this._unEl('p',
        'text-xs font-mono text-zinc-500 dark:text-zinc-500 mt-2 break-words',
        buildBits.join(' · ')));
      if (diag.privileged && diag.privileged.message) {
        box.appendChild(this._unEl('p',
          'text-xs font-mono text-zinc-500 dark:text-zinc-500 mt-1 break-words',
          diag.privileged.message));
      }
      const actions = this._unEl('div');
      const retry = this._unButton(actions, 'Try again',
        () => this._retryUsernodeConnection());
      retry.id = 'settings-usernode-connection-retry';
      const copy = this._unButton(actions, 'Copy diagnostics', async () => {
        const text = this._bridgeDiagnosticsText(diag);
        const ok = window.PlatformUI && PlatformUI.copyText
          ? await PlatformUI.copyText(text)
          : false;
        if (window.PlatformUI && PlatformUI.toast) {
          PlatformUI.toast(ok ? 'Diagnostics copied' : 'Could not copy',
            ok ? {} : { error: true });
        }
      });
      copy.id = 'settings-usernode-connection-copy';
      if (demo) {
        // Read-only hook: the buttons are rendered so the screenshot shows
        // the real panel, but they must not touch a bridge or a session.
        retry.disabled = true;
        copy.disabled = true;
      }
      box.appendChild(actions);
      return box;
    },

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
      const section = document.getElementById('settings-usernode-section');
      if (!section) return;
      // Gated on BEING IN THE APP, not on the getSettingsState capability.
      // That probe is itself a casualty of the failures this section now
      // diagnoses — a degraded getBridgeInfo answers "no capabilities", so
      // the section used to disappear exactly when the user needed it most.
      // getBridgeInfo is unprivileged, so `isNative` stays readable on a
      // device whose privileged handshake is refused.
      const bridge = window.usernode;
      const demo = this._unDemoMode();
      const gated = this._bridgeDiagDemo() || this._widgetIconsDemo() || !!demo ||
        (!!bridge && bridge.isNative === true);
      // The gate resolves asynchronously downstream, so the "Usernode app"
      // menu row is only settled here — re-render the nav either way.
      if (!gated) {
        section.classList.add('hidden');
        this._renderNavIfOpen();
        return;
      }
      section.classList.remove('hidden');
      this._renderNavIfOpen();
      const token = ++this._usernodeRenderToken;
      // A fresh mount re-probes the real notification permission (below)
      // and drops the previous visit's dead-end notice.
      this._unPushProbed = false;
      this._unNotifNotice = null;
      if (demo) {
        // Fixed snapshot, no bridge call: this link exists to make the
        // notification row reachable from a browser.
        this._usernodeState = this.DEMO_USERNODE_STATE;
        this._unPushStatus = demo === 'ios-denied' ? 'denied' : 'undetermined';
        this._unPushProbed = true;
        this._unCanOpenNotifSettings = true;
        this._renderUsernodeBody();
        return;
      }
      if (!this._usernodeState) {
        section.textContent = '';
        section.appendChild(this._unEl('div',
          'mt-6 pt-5 border-t border-zinc-200 dark:border-zinc-700 ' +
          'text-xs text-zinc-500', 'Loading Usernode app settings…'));
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
        this._renderUsernodeBody(this._usernodeReadError());
        return;
      }
      this._clearUsernodeAuthStatusRetry();
      this._renderUsernodeBody();
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
      if (changed) this._renderUsernodeBody();
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

    _unToggle(parent, label, checked, onChange, opts = {}) {
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
          if (window.PlatformUI) {
            const detail = opts.includeErrorDetail && err && err.message
              ? `: ${err.message}` : '';
            PlatformUI.toast(this._nativeActionMessage(err,
              `Could not save the setting${detail}`));
          }
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
          if (window.PlatformUI) {
            PlatformUI.toast(this._nativeActionMessage(err, 'Action failed'));
          }
        } finally {
          btn.disabled = false;
        }
      });
      parent.appendChild(btn);
      return btn;
    },

    // `opts.onActivate` turns the row itself into a real control.
    //
    // Without it the row is a plain `div` with no listener, so tapping it
    // is a no-op BY CONSTRUCTION — and the only control was a small chip
    // rendered underneath, conditionally. On a phone the row is what a
    // thumb lands on, so the notifications row now carries the tap and the
    // chip is a second affordance rather than the only one.
    _unStatusRow(parent, label, ok, okText, badText, opts = {}) {
      const interactive = typeof opts.onActivate === 'function';
      const row = this._unEl(interactive ? 'button' : 'div',
        'flex items-center gap-2 mt-1 text-sm w-full text-left' +
        (interactive
          ? ' rounded-md -mx-1 px-1 py-1 transition-colors ' +
            'hover:bg-zinc-100 dark:hover:bg-zinc-800'
          : ''));
      if (opts.id) row.id = opts.id;
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
      if (interactive) {
        row.type = 'button';
        if (opts.hint) row.setAttribute('aria-label', `${label} — ${opts.hint}`);
        row.appendChild(this._unEl('span',
          'text-xs text-zinc-400 dark:text-zinc-500 shrink-0', '›'));
        row.addEventListener('click', async () => {
          row.disabled = true;
          try {
            await opts.onActivate();
          } catch (err) {
            console.warn('[settings] usernode row action failed:', err);
            if (window.PlatformUI) {
              PlatformUI.toast(this._nativeActionMessage(err, 'Action failed'));
            }
          } finally {
            row.disabled = false;
          }
        });
      }
      parent.appendChild(row);
      return row;
    },

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
        return 'The Usernode app isn’t accepting changes from this ' +
          'screen. Force-close and reopen the app, then try again.';
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
          ? 'Opening the permission prompt…'
          : 'Opening the notification prompt…',
      };
      this._renderUsernodeBody();
      try {
        await this._runNotifPermissionTap(isAndroid);
      } finally {
        this._unRequestInFlight = false;
        this._renderUsernodeBody();
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
          text: 'This is a preview of the in-app row — the notification ' +
            'permission itself lives in the Usernode app.',
        };
        return;
      }
      if (!nc || typeof nc.decideNotificationTap !== 'function') {
        // Old bundle: fall back to the plain ask rather than refusing.
        if (!hasRequest) {
          this._unNotifDeadEnd('no-bridge', {
            text: 'Notification permission is only available inside the ' +
              'Usernode app.',
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
            text: 'Notifications are already allowed for Usernode.',
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
            ? 'The Usernode app didn’t respond to the permission request. ' +
              'Force-close and reopen the app, then try again.'
            : this._nativeActionMessage(err,
                'The permission request could not be started.'),
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
            ? 'Permission granted.'
            : 'Notifications are now allowed for Usernode.',
        };
        this._renderUsernodeBody();
        return;
      }
      this._unNotifDeadEnd(outcome.verdict, {
        text: this._notifDeadEndText(outcome, isAndroid),
        settings: outcome.settings === true,
        reason: outcome.reason,
      });
      this._renderUsernodeBody();
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
          const err = new Error('the Usernode app did not answer in time');
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
          return 'Notification permission is only available inside the ' +
            'Usernode app.';
        case 'unsupported':
          return 'This version of the Usernode app can’t open the ' +
            'notification prompt. Update the app from the App Store.';
        case 'settings':
          return isAndroid
            ? 'Permission was denied. Allow notifications in the system ' +
              'settings for Usernode.'
            : 'Notifications are turned off for Usernode. iOS only shows ' +
              'its prompt once, so this has to be changed in Settings › ' +
              'Notifications › Usernode.';
        case 'declined':
          return 'Permission was not granted.';
        case 'silent':
          return 'The Usernode app closed without showing the notification ' +
            'prompt. Reopen the app and try again, or allow notifications ' +
            'in Settings › Notifications › Usernode.';
        default:
          return 'The notification prompt could not be opened.';
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
        text: (opts && opts.text) || 'The notification prompt could not be ' +
          'opened.',
        settings: !!(opts && opts.settings),
      };
    },

    // The notice, plus — only when the app positively advertises the
    // capability — a way out of a determined-denied permission. A button
    // that cannot work is worse than no button, so an inconclusive
    // capability probe (null) renders the manual instructions instead.
    _renderNotifNotice(parent) {
      const n = this._unNotifNotice;
      if (!n) return;
      const box = this._unEl('div',
        'mt-2 rounded-md border px-3 py-2 text-xs ' +
        (n.tone === 'warn'
          ? 'border-amber-300 dark:border-amber-800 bg-amber-50 ' +
            'dark:bg-amber-950/40 text-amber-800 dark:text-amber-300'
          : n.tone === 'ok'
            ? 'border-emerald-300 dark:border-emerald-800 bg-emerald-50 ' +
              'dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300'
            : 'border-zinc-300 dark:border-zinc-700 text-zinc-600 ' +
              'dark:text-zinc-300'),
        n.text);
      box.id = 'settings-notif-notice';
      parent.appendChild(box);
      if (n.settings && this._unCanOpenNotifSettings === true) {
        this._unButton(parent, 'Open notification settings', () =>
          window.usernode.openNotificationSettings());
      }
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
    //   payload — a pre-fetched (or fixed) /terms/current data object;
    //     skips the fetch. The first-run trigger passes the payload it
    //     already fetched, and the ?shot=terms-consent screenshot state
    //     passes a fixed one so the shot does no fetch and no writes.
    async showTermsSheet(onAccepted, opts) {
      opts = opts || {};
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
      }

      const el = (tag, cls, text) => this._unEl(tag, cls, text);
      const panel = el('div', 'px-4 pb-5');
      panel.appendChild(el('div', 'text-lg font-bold py-3',
        payload.title || 'Terms'));
      if (firstRun) {
        panel.appendChild(el('p',
          'text-sm text-zinc-600 dark:text-zinc-400 mb-2',
          'Reviewing the terms is part of joining the platform. Your ' +
          'token allocation stays paused until you accept.'));
      }
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
            onOk();
          } catch (err) {
            console.warn('[settings] terms consent failed:', err);
            if (window.PlatformUI) PlatformUI.toast('Could not record your consent');
            consentButtons.forEach((b) => { b.disabled = false; });
          }
        };

        const acceptBtn = el('button',
          'w-full rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 ' +
          'text-sm font-medium text-white', 'Accept the terms');
        acceptBtn.addEventListener('click', () => postConsent('accepted',
          () => {
            if (window.PlatformUI) PlatformUI.toast('Terms accepted');
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
            'dark:text-zinc-200', 'Decline');
          declineBtn.addEventListener('click', () => postConsent('refused',
            () => {
              if (window.PlatformUI) {
                PlatformUI.toast('Your token allocation stays paused — ' +
                  'you can accept later from your profile');
              }
            }));
          consentButtons.push(declineBtn);
          panel.appendChild(declineBtn);
        }
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

      // First, so a refused handshake explains itself above the failures
      // it causes rather than below them.
      this._renderUsernodeConnection(section);

      if (!s) {
        this._renderUsernodeError(section, readError, loading);
      } else {
        // Device permissions — mirrors the native QuickSettingsPanel.
        // iOS maps requestPermissions() to the notification prompt and has
        // no block production since v4 — describe each platform's real ask.
        const permBox = this._unSection(section, 'Usernode app — device permissions',
          isAndroid
            ? 'Block production needs the app to wake your device at exact slot times.'
            : 'Notifications let Usernode alert you about node and account activity.');
        if (this._unDemoMode()) {
          permBox.appendChild(this._unEl('p',
            'text-xs font-medium text-amber-600 dark:text-amber-400 mb-2',
            'Staging demo — sample data'));
        }
        // iOS row truth: `exactAlarmGranted` is a lagging proxy for the
        // notification permission (there are no exact alarms on iOS), so
        // once a request has settled through NativeChrome.settleIosPushGrant
        // that answer is the authority — the same rule the first-run sheet
        // in public/js/native-chrome.js applies.
        const notifOk = !isAndroid && this._unPushStatus != null
          ? this._unPushStatus === 'granted'
          : !!perms.exactAlarmGranted;
        // The row IS the control. It used to be an inert div whose only
        // affordance was the chip below, and that chip only rendered when
        // the (iOS-meaningless) exactAlarmGranted boolean said "not
        // granted" — so on a build reporting it `true` there was nothing
        // to tap at all. The row now always carries the ask.
        this._unStatusRow(permBox, isAndroid ? 'Exact alarms' : 'Notifications',
          notifOk, 'Granted', 'Not granted', {
            id: 'settings-notif-row',
            hint: isAndroid ? 'request permissions' : 'allow notifications',
            onActivate: () => this._unRequestPermissions(isAndroid),
          });
        if (!notifOk) {
          this._unButton(permBox,
            isAndroid ? 'Request permissions' : 'Allow notifications',
            () => this._unRequestPermissions(isAndroid));
        }
        this._renderNotifNotice(permBox);
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
      // The demo link renders the permissions rows and stops: the sections
      // below all read the live bridge, which a browser does not have.
      if (this._unDemoMode()) return;
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

      // Widget icons. Above the general diagnostics box because it is the
      // one someone arrives here for: "the widget tile is the wrong
      // colour" is a user-visible symptom, not a debugging tool.
      this._renderWidgetIconsSection(section);

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
          const admissionPending = window.NativeChrome &&
            typeof NativeChrome.isSessionAdmitted === 'function' &&
            !NativeChrome.isSessionAdmitted();
          // "Finishing secure app sign-in…" is a lie once the handshake has
          // been refused — nothing is finishing. Name the state and point
          // at the panel that explains it.
          const diag = this._bridgeDiagnostics();
          const stuck = !!diag && diag.privileged &&
            (diag.privileged.state === 'blocked-frame' ||
             diag.privileged.state === 'unattached');
          holder.appendChild(this._unEl('p',
            'text-xs text-zinc-500 dark:text-zinc-400',
            stuck
              ? 'The Usernode app isn’t accepting this screen’s ' +
                'secure connection, so notifications can’t be set up. ' +
                'See “Usernode app — connection” above.'
              : (admissionPending
                ? 'Finishing secure app sign-in before enabling notifications…'
                : 'Notification settings are temporarily unavailable.')));
          const failure = (window.NativeChrome &&
            typeof NativeChrome.lastSessionFailure === 'function')
            ? NativeChrome.lastSessionFailure()
            : null;
          if (failure && failure.message) {
            holder.appendChild(this._unEl('p',
              'text-xs font-mono text-zinc-500 dark:text-zinc-500 mt-1 break-words',
              failure.message));
          }
          if (admissionPending &&
              typeof NativeChrome.recoverSessionAdmission === 'function') {
            this._unButton(holder, 'Try again', async () => {
              await NativeChrome.recoverSessionAdmission();
              if (window.SocialPush &&
                  typeof SocialPush.retryBridgeReadiness === 'function') {
                try { SocialPush.retryBridgeReadiness(); } catch (_) {}
              }
              render(await SocialPush.getState());
            });
          }
          return;
        }
        this._unToggle(holder, 'Activity notifications', state.enabled,
          async (enabled) => render(await SocialPush.setEnabled(enabled)),
          { includeErrorDetail: true });
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

  // Published at module scope, not from the island's effect: app.js,
  // app-view.js, dev-chat.js and credit-options.js call window.Settings
  // unguarded, and the bundle's entry runs before any of their init()s. The
  // typeof guard is for the SSG prerender pass, which evaluates this whole
  // module graph in Node (#1081 chunk D).
  if (typeof window !== 'undefined') window.Settings = Settings;

  // init() is called from SettingsScreen's layout effect (../index.tsx), not
  // from DOMContentLoaded. Same moment in practice — the React entry is a
  // deferred module, so it hydrates before DOMContentLoaded fires — but it now
  // happens after the island's own markup is in the document, which is the
  // ordering every id-bound listener below depends on.
})();
