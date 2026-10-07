/**
 * The legacy globals React-owned regions still talk to.
 *
 * public/js/** is 50-odd classic scripts that each publish one object on
 * `window`; a converted region needs the same names, and #1079 chunk B moved
 * two of those modules INTO this bundle (features/notifications/
 * notifications.js) while keeping
 * their `window.X = X` publication so their remaining legacy callers — app.js,
 * app-view.js, dev-chat.js, home.js — keep working untouched.
 *
 * Declared loosely on purpose: these are untyped JS modules, and pretending
 * otherwise here would be a type that lies rather than a type that helps. Only
 * the members React code actually calls are named.
 */

export {};

declare global {
  /**
   * An agent session's hint as a legacy caller hands it over
   * (features/agent-session/api.ts AgentHint). `message` and `handoff` are
   * the screen's alone: the unsent conversation's first message, and the
   * "Build with" tab it opens on.
   */
  interface LegacyAgentHint {
    slug?: string;
    issueNumber?: number;
    proposalId?: number;
    entry?: string;
    issueTitle?: string;
    message?: string;
    handoff?: 'claude-code' | 'codex';
  }

  /** What a kit presentation returns; `el` is the shell it built. */
  interface KitHandle {
    el?: HTMLElement | null;
    dismiss(): void;
  }

  /**
   * What every kit presentation takes. `contentEl` is REPARENTED into the
   * kit's shell — see lib/kit-surface.ts, which is the only thing in this
   * bundle that should be calling these directly.
   */
  interface KitSurfaceOpts {
    contentEl: HTMLElement;
    onDismiss?: () => void;
    [key: string]: unknown;
  }

  interface Window {
    /** features/notifications/notifications.js */
    Notifications?: {
      init(): void;
      refresh(): Promise<void>;
      /**
       * Clear this document's copy of one conversation's notifications, after
       * the server has already cleared them (features/messages/store.ts calls
       * it on the local read and on a `conversation_read` for this viewer).
       * Declared rather than left to the index signature below, which types a
       * lookup as `unknown` and so makes the call itself an error.
       */
      markConversationRead(conversationId: number): void;
      /** The same, for one reply thread's alerts (#2387). */
      markConversationThreadRead(conversationId: number, rootId: number): void;
      /** One row's descriptor: its kind line and subject segments (#3233). */
      _rowView?(row: Record<string, unknown>): unknown;
      open: boolean;
      [key: string]: unknown;
    };
    /**
     * The three platform SHEETS, each built by lib/sheet-controller.js and
     * published at its controller's module scope. Classic scripts and the
     * header glyphs reach them here.
     */
    NotificationsSheet?: {
      open(): void;
      close(): Promise<void> | void;
      toggle(): void;
      isOpen(): boolean;
      [key: string]: unknown;
    };
    /** features/settings/settings.js */
    Settings?: {
      init(): void;
      /** Reads /api/auth/me into Settings.state; runs at hydration on every route. */
      refresh(): Promise<void>;
      open(section?: string | null, opts?: unknown): void;
      [key: string]: unknown;
    };
    /** public/js/app.js — the shell's router. */
    App?: {
      currentApp?: string | null;
      user?: {
        id?: number;
        username?: string;
        avatarUrl?: string | null;
        appCreationQuota?: {
          used: number | null;
          limit: number | null;
          remaining: number | null;
        };
        [key: string]: unknown;
      } | null;
      eventsWs?: WebSocket | null;
      navigateHome?(opts?: { viaTab?: boolean }): void;
      restoreFromHash?(): void;
      navigateToApp?(slug: string, tab?: string, ref?: unknown, subTab?: string | null): Promise<void>;
      openAppTab?(slug: string, tab?: string, opts?: unknown): void;
      setRailPinned?(on: boolean): void;
      _appUrl?(slug: string, tab?: string, ref?: unknown, subTab?: string | null,
        options?: unknown): string;
      _rootUrl?(hash?: string): string;
      setBackIcon?(mode: 'home' | 'arrow', href?: string): void;
      setHeaderTitle?(title: string): void;
      /**
       * Paints the platform build into #platform-version-pill-slot, the host
       * Settings → About renders for it. Declared rather than left to the
       * index signature below, which types a lookup as `unknown` and so makes
       * the call itself an error — and that pane calls it on mount, to paint
       * an answer that arrived before the host existed.
       */
      renderPlatformVersionPill?(info: unknown): void;
      /** app.js's last /api/version answer; null until the first one lands. */
      _lastVersionInfo?: unknown;
      [key: string]: unknown;
    };
    /**
     * public/js/platform-ui.js — the native-kit adapter.
     *
     * The three presentation calls are typed because `lib/kit-surface.ts`
     * dispatches on their names: `ui[kind]` has to be something better than
     * `unknown` for that lookup to be checkable at all. Each returns null
     * when the kit declines, which every caller has to handle — that is the
     * fall-through to the web presentation.
     *
     * `hasKit` is optional because the property predates the method: older
     * builds of the adapter shipped without it, and `kit-surface` feature-
     * detects rather than assuming. `isTouch` is not, because everything in
     * this repo has always called it unguarded.
     */
    PlatformUI?: {
      isTouch(): boolean;
      hasKit?(): boolean;
      modal?(opts: KitSurfaceOpts): KitHandle | null;
      sheet?(opts: KitSurfaceOpts): KitHandle | null;
      panel?(opts: KitSurfaceOpts & { side?: 'left' | 'right' }): KitHandle | null;
      pullToRefresh(el: Element, fn: () => Promise<unknown> | void): void;
      toast?(message: string): void;
      /** A native-style confirm card; resolves true on the confirm button. */
      confirm?(opts: { title?: string; message?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean }): Promise<boolean>;
      /** A one-field prompt; resolves the text, or null when cancelled. */
      prompt?(opts: { title?: string; message?: string; value?: string; placeholder?: string; confirmLabel?: string; cancelLabel?: string }): Promise<string | null>;
      /** The adaptive menu: a sheet on touch, an anchored popover on desktop. */
      menu?(opts: {
        anchorEl?: HTMLElement;
        title?: string;
        items: Array<{ label: string; title?: string; destructive?: boolean; handler: () => void }>;
      }): Promise<unknown>;
      copyText?(text: string): Promise<boolean>;
      /**
       * The kit's swipe-to-act row (unNative.attachSwipeActions): it wraps
       * `row` in a container of its own beside the action tray, so the
       * element handed in must not be one React places among siblings. The
       * last action, when destructive, is also the full swipe, and it takes
       * the row out of the document BEFORE its handler runs. An inert
       * handle without the kit.
       */
      swipeActions?(row: HTMLElement, opts: {
        actions: Array<{ label: string; color?: string; destructive?: boolean; handler: () => void }>;
      }): { close(): void; detach(): void };
      [key: string]: unknown;
    };
    /** features/header/node-pill.js */
    NodePill?: {
      init(): Promise<void>;
      [key: string]: unknown;
    };
    /** features/header/wallet-sheet.js */
    WalletSheet?: {
      init(): void;
      [key: string]: unknown;
    };
    /** features/header/native-app-version.js */
    NativeAppVersion?: {
      init(): void;
      refresh(): Promise<string | null>;
      [key: string]: unknown;
    };
    /**
     * features/header/header-menu-controller.js — the hamburger drawer's
     * open/close. It was App.HeaderMenu in app.js, which now forwards onto
     * this so its own call sites (plus app-view.js, native-chrome.js,
     * node-pill.js, wallet-sheet.js) are untouched.
     */
    HeaderMenu?: {
      init(): void;
      open(): void;
      close(): Promise<void> | void;
      isPresenting(): boolean;
      consumeNavPending(): boolean;
      [key: string]: unknown;
    };
    /** features/improve/improve-status.js */
    ImproveStatus?: {
      setAppOpen(open: boolean): void;
      refreshDeployDot(): void;
      [key: string]: unknown;
    };
    /**
     * features/leaderboard/leaderboard.js — the Leaderboard screen's section
     * state. The island's tab strip reports a click back through
     * `_setSection`, which is what the strip's own innerHTML'd listener did.
     */
    Leaderboard?: {
      _setSection?(section: string): void;
      [key: string]: unknown;
    };
    /** public/js/app-view.js — the app screen. The dialogs read its appData. */
    AppView?: {
      appData?: { slug?: string; name?: string; url?: string; [key: string]: unknown } | null;
      /** Let `slug`'s kept-alive frame go, so its next open loads afresh; true when one went. */
      evictKeptApp?(slug: string): boolean;
      /**
       * POST /api/apps/:slug/main-check/resume — the admin's "I know, let
       * them through" while main's unit suite is red. One implementation,
       * called by the per-card ledger's button and the board banner alike.
       */
      resumeMainMerges?(slug: string, btn?: HTMLButtonElement | null): Promise<boolean | undefined>;
      /** The "Proposal checks" dialog for one change: its checks, Refresh and Re-run. */
      openSessionChecks?(sessionId: number): void;
      /** POST /api/sessions/:id/recheck, with the platform's own toasts; true once it started. */
      castRecheck?(sessionId: number): Promise<boolean | undefined>;
      /**
       * The staging preview (#439, #771), shared with an agent session's side
       * pane (#2779): ensure-then-open a change's preview, docked beside the
       * chat when a dock host's slot is mounted, for an explicit app.
       */
      ensureStaging?(
        sessionId: number,
        fallbackUrl: string | null,
        testing: { md?: string | null; path?: string | null } | null,
        opts?: { dock?: boolean; app?: { slug: string; self_hosted?: boolean }; readOnly?: boolean; jump?: boolean },
      ): Promise<void>;
      closeStagingOverlay?(): void;
      setStagingDockHost?(host: {
        slotId: string;
        live(): boolean;
        collapse(): void;
        redock(): void;
        closed: (() => void) | null;
      } | null): void;
      onStagingRebuildResult?(sessionId: number, result: { url?: string | null; failed?: boolean; error?: string | null }): void;
      _syncStagingDockGeometry?(): void;
      [key: string]: unknown;
    };
    /** features/home/home.js — refreshed after app creation. */
    Home?: {
      load?(): void;
      [key: string]: unknown;
    };
    /** public/js/dev-host.js — maps container-local preview URLs for browsers. */
    resolveDevHost?: (url: string) => string;
    /**
     * features/dialogs/app-secrets-controller.js — the retired
     * public/js/app-secrets.js. Still published under this name because five
     * call sites in app-view.js reach it as `window.Secrets`.
     */
    Secrets?: {
      open(slug: string, opts?: { declare?: boolean }): void;
      close(): void;
      [key: string]: unknown;
    };
    /**
     * features/dialogs/screenshot-select.js — the retired
     * public/js/screenshot-select.js. The feedback dialog gates its attach
     * button on `isSupported()`, exactly as it did when this was a tag.
     */
    ScreenshotSelect?: {
      isSupported(): boolean;
      start(opts?: unknown): Promise<{ blob: Blob; contentType: string }>;
      [key: string]: unknown;
    };
    /**
     * The bridge this bundle publishes for `public/js/**` to call back into.
     * `dialogs` is #1078 chunk I's addition: one entry per shell dialog,
     * registered by `useDialog`, so the legacy open/close entry points drive
     * React state instead of writing `hidden` themselves.
     */
    UsernodeReact?: {
      dialogs?: Record<
        string,
        { isOpen(): boolean; open(payload?: unknown): void; close(): void } | undefined
      >;
      /**
       * features/first-session: the first session's screens, and the one
       * front door for a new project. `create` opens "What do you want to
       * make?" from the Create button (false when it cannot); `made` hands
       * the New project dialog's project to the made screen.
       */
      firstSession?: {
        create?(): boolean;
        made?(made: {
          slug: string;
          name: string;
          emoji: string | null;
          description: string | null;
          example: null;
          conversationId: number | null;
          audience?: 'solo' | 'invited' | 'open';
        }): boolean;
        [key: string]: unknown;
      };
      messages?: {
        open(conversationId?: number | null): void;
        route(conversationId?: number | null): void;
        close(): void;
        isOpen(): boolean;
        handleBack(): boolean;
        syncChrome(): void;
        handleEvent(event: Record<string, unknown>): void;
        share(reference?: unknown): Promise<void> | void;
        /** Repaint one row's save state — the notifications drawer's unsave. */
        paintSaved(messageId: number, saved: boolean): void;
        refresh(): Promise<void> | void;
        /** #3705: the inbox and the conversation on screen, from the server. */
        resync(): Promise<void> | void;
        /** The Messages screen, or a room embedded in its community's page, is on screen. */
        showing(): boolean;
      };
      /**
       * features/agent-session/store.ts (#2779). `new` is the conversation
       * New change opens, unsent until its first message creates it.
       */
      agentSession?: {
        open(id: number | 'new', options?: { host?: 'screen' | 'messages' }): Promise<void> | void;
        route(id: number | 'new', options?: { drawer?: boolean }): Promise<void> | void;
        start(hint?: LegacyAgentHint | null): void;
        prepareDraft(hint?: LegacyAgentHint | null): void;
        deactivate(): void;
        isOpen(): boolean;
        currentId(): number | 'new' | null;
        refreshList(): Promise<void> | void;
      };
      globalChat?: {
        open(options?: { threadId?: string | null }): Promise<void> | void;
        route(threadId?: string | null): Promise<void> | void;
        close(classicPath?: string | null): void;
        deactivate(): void;
        isOpen(): boolean;
        send(text: string): Promise<void> | void;
      };
      [key: string]: unknown;
    };
    /** features/dev-chat/dev-chat.js — sanitized Markdown renderer. */
    DevChat?: {
      renderMarkdown(text: string, opts?: { breaks?: boolean; images?: boolean }): string;
      dismissReturnHint(): void;
      _importOwnToolsPr(): void;
      /** An agent session's turn is running on screen: the tab's "⏳ Thinking…". */
      setAgentSessionThinking?(on: boolean): void;
      [key: string]: unknown;
    };
    /** The inline head-blocking theme module in src/head.html. */
    Theme?: {
      get(): 'light' | 'dark' | 'system';
      set(mode: string): void;
      apply(): void;
      onChange(fn: (mode: string) => void): void;
    };
  }
}
