// #328: max characters in a single group-chat message. Raised from 2000 to
// 8000 to give room for markdown-formatted messages (code samples, lists).
// Kept in sync with the server-side cap in src/services/ws.js — both ends
// must agree or a message that passes the composer would be silently
// truncated on insert. Drives every composer/edit `maxlength` below.
const GC_MAX_MESSAGE_LEN = 8000;

const GroupChat = {
  ws: null,
  appSlug: null,
  messages: [],
  // B9: the cards under the viewer's own messages that asked Homeroom bot
  // for something (message id → card), theirs alone; and whether the bot
  // answers them on this project at all (it offers "Make this a request").
  _botCards: new Map(),
  _botHere: false,
  typingUsers: new Map(),
  typingTimeout: null,
  oldestMessageId: null,
  hasMore: true,
  _historyLoad: null,
  // Scroll-position memory. `_lockedToBottom` drives "should new incoming
  // messages auto-scroll?". `_savedScrollTop` is the last observed scroll
  // offset so we can restore it when the tab is re-mounted (group-chat DOM
  // is destroyed on every tab switch, but GroupChat state persists for as
  // long as we stay inside the same app).
  _lockedToBottom: true,
  _savedScrollTop: null,
  _didInitialScroll: false,

  // Reconnect bookkeeping (#7). The WS connection is the canonical
  // send path for chat messages; if it's down we have to either
  // queue or drop. We queue.
  //   _reconnectAttempts — exponent for backoff (1s,2s,4s,…30s).
  //                        Reset to 0 on every successful onopen.
  //   _reconnectTimer    — pending setTimeout handle; null if no
  //                        reconnect is scheduled. Guards against
  //                        double-scheduling.
  //   _pendingOutgoing   — chat texts the user submitted while the
  //                        socket was down. Flushed in order on the
  //                        next onopen. Capped at PENDING_LIMIT so
  //                        a long-offline session can't grow
  //                        unbounded; oldest entries are dropped
  //                        first when full (rare in practice; the
  //                        8000-char-per-message * 50 ceiling is
  //                        ~400KB which is fine to hold in RAM).
  _reconnectAttempts: 0,
  _reconnectTimer: null,
  _pendingOutgoing: [],

  // #15: Signal-style reply. `replyDraft` is the quote to attach to the
  // NEXT outgoing message (or null). `_tap` records the last pointerdown
  // position so the tap-to-quote handler can distinguish a clean tap from
  // a drag/text-selection (mobile-first: tap quotes, drag selects).
  replyDraft: null,
  _tap: null,

  // #25: emoji reactions. Long-press (or hover button) opens the reaction
  // bar; `_pressTimer` arms the long-press, `_longPressed` swallows the
  // trailing click so it doesn't also quote. `_reactBar` is the lazily
  // built floating picker.
  _pressTimer: null,
  _longPressed: false,
  // True while a pointer is held down on a message row. Used to gate the
  // drag-vs-hold decision that toggles native text selection (hold =
  // react bar + no selection; drag = re-enable selection).
  _pressActive: false,
  _reactBar: null,
  _reactBarDismiss: null,
  _reactBarOpenedAt: 0,
  // The bar's two moving parts, mirrored here because they are published
  // rather than toggled in place: whether the `＋` grid is expanded, and
  // whether the pointed-at row offers Edit. See
  // frontend/src/features/group-chat/reaction-bar-store.ts.
  _reactBarGridOpen: false,
  _reactBarEditable: false,
  // Shell-injected staging iframe token, captured at script load so SPA
  // history rewrites can't lose it before a (re)connect needs it.
  _bootToken: new URLSearchParams(location.search).get('token'),
  QUICK_REACTIONS: ['\u{1F44D}', '\u2764\uFE0F', '\u{1F602}', '\u{1F62E}', '\u{1F622}', '\u{1F64F}'],
  // Full picker grid, ordered by category (smileys \u2192 gestures \u2192 hearts \u2192
  // animals \u2192 food \u2192 activities \u2192 objects \u2192 symbols) so related emoji sit
  // together while scrolling. Rendered flat; the CSS grid handles layout.
  GRID_REACTIONS: [
    // Smileys & emotion
    '\uD83D\uDE00', '\uD83D\uDE01', '\uD83D\uDE02', '\uD83E\uDD23', '\uD83D\uDE0A', '\uD83D\uDE07', '\uD83D\uDE42', '\uD83D\uDE09',
    '\uD83D\uDE0D', '\uD83E\uDD70', '\uD83D\uDE18', '\uD83D\uDE0B', '\uD83D\uDE1C', '\uD83E\uDD2A', '\uD83D\uDE0E', '\uD83E\uDD13',
    '\uD83E\uDD73', '\uD83E\uDD29', '\uD83D\uDE0F', '\uD83D\uDE05', '\uD83D\uDE2C', '\uD83D\uDE43', '\uD83D\uDE0C', '\uD83D\uDE34',
    '\uD83E\uDD24', '\uD83D\uDE2A', '\uD83D\uDE2E', '\uD83D\uDE32', '\uD83D\uDE33', '\uD83E\uDD7A', '\uD83D\uDE22', '\uD83D\uDE2D',
    '\uD83D\uDE24', '\uD83D\uDE20', '\uD83D\uDE21', '\uD83E\uDD2C', '\uD83E\uDD2F', '\uD83E\uDD75', '\uD83E\uDD76', '\uD83D\uDE31',
    '\uD83D\uDE28', '\uD83D\uDE30', '\uD83E\uDD17', '\uD83E\uDD14', '\uD83E\uDD2D', '\uD83E\uDD2B', '\uD83D\uDE44', '\uD83D\uDE12',
    '\uD83D\uDE1E', '\uD83D\uDE14', '\uD83D\uDE1F', '\uD83D\uDE15', '\uD83D\uDE16', '\uD83D\uDE2B', '\uD83D\uDE29', '\uD83E\uDD22',
    '\uD83E\uDD2E', '\uD83E\uDD27', '\uD83D\uDE37', '\uD83E\uDD12', '\uD83E\uDD20', '\uD83E\uDD11', '\uD83D\uDE08', '\uD83D\uDC80',
    '\uD83D\uDC7B', '\uD83D\uDC7D', '\uD83E\uDD16', '\uD83D\uDCA9', '\uD83E\uDD21', '\uD83D\uDE3A', '\uD83D\uDE48', '\uD83D\uDE49',
    '\uD83D\uDE4A', '\uD83D\uDE36', '\uD83D\uDE10', '\uD83E\uDD74',
    // Gestures & hands
    '\uD83D\uDC4D', '\uD83D\uDC4E', '\uD83D\uDC4C', '\uD83E\uDD0C', '\u270C\uFE0F', '\uD83E\uDD1E', '\uD83E\uDD1F', '\uD83E\uDD18',
    '\uD83E\uDD19', '\uD83D\uDC4B', '\uD83D\uDD90\uFE0F', '\u270B', '\uD83D\uDC4A', '\u270A', '\uD83E\uDD1B', '\uD83E\uDD1C',
    '\uD83D\uDC4F', '\uD83D\uDE4C', '\uD83E\uDD1D', '\uD83D\uDE4F', '\uD83D\uDCAA', '\uD83D\uDD95', '\u261D\uFE0F', '\uD83D\uDC46',
    '\uD83D\uDC47', '\uD83D\uDC48', '\uD83D\uDC49', '\u270D\uFE0F', '\uD83E\uDD32', '\uD83D\uDC40', '\uD83E\uDDE0', '\uD83D\uDDE3\uFE0F',
    '\uD83D\uDC81', '\uD83D\uDE45', '\uD83D\uDE46', '\uD83E\uDD37', '\uD83E\uDD26', '\uD83E\uDDCE', '\uD83C\uDFC3', '\uD83D\uDC83',
    // Hearts
    '\u2764\uFE0F', '\uD83E\uDDE1', '\uD83D\uDC9B', '\uD83D\uDC9A', '\uD83D\uDC99', '\uD83D\uDC9C', '\uD83D\uDDA4', '\uD83E\uDD0D',
    '\uD83E\uDD0E', '\uD83D\uDC95', '\uD83D\uDC9E', '\uD83D\uDC93', '\uD83D\uDC97', '\uD83D\uDC96', '\uD83D\uDC98', '\uD83D\uDC9D',
    '\uD83D\uDC94', '\u2763\uFE0F', '\uD83D\uDC9F', '\uD83D\uDC8C',
    // Animals & nature
    '\uD83D\uDC36', '\uD83D\uDC31', '\uD83D\uDC2D', '\uD83D\uDC39', '\uD83D\uDC30', '\uD83E\uDD8A', '\uD83D\uDC3B', '\uD83D\uDC3C',
    '\uD83D\uDC28', '\uD83D\uDC2F', '\uD83E\uDD81', '\uD83D\uDC2E', '\uD83D\uDC37', '\uD83D\uDC38', '\uD83D\uDC35', '\uD83D\uDC14',
    '\uD83D\uDC27', '\uD83D\uDC26', '\uD83E\uDD86', '\uD83E\uDD85', '\uD83E\uDD89', '\uD83D\uDC22', '\uD83D\uDC0D', '\uD83D\uDC19',
    '\uD83E\uDD80', '\uD83D\uDC2C', '\uD83D\uDC33', '\uD83E\uDD88', '\uD83E\uDD8B', '\uD83D\uDC1D', '\uD83D\uDC1E', '\uD83D\uDC0C',
    '\uD83C\uDF38', '\uD83C\uDF39', '\uD83C\uDF3B', '\uD83C\uDF35', '\uD83C\uDF32', '\uD83C\uDF40', '\uD83C\uDF08', '\u2B50',
    '\uD83C\uDF1F', '\u2728', '\u26A1', '\u2600\uFE0F', '\uD83C\uDF19', '\u2601\uFE0F', '\uD83C\uDF27\uFE0F', '\u2744\uFE0F',
    '\uD83C\uDF0A', '\uD83C\uDF0D',
    // Food & drink
    '\uD83C\uDF4E', '\uD83C\uDF4C', '\uD83C\uDF49', '\uD83C\uDF47', '\uD83C\uDF53', '\uD83C\uDF52', '\uD83C\uDF51', '\uD83E\uDD6D',
    '\uD83C\uDF4D', '\uD83E\uDD51', '\uD83C\uDF45', '\uD83E\uDD55', '\uD83C\uDF3D', '\uD83C\uDF5E', '\uD83E\uDDC0', '\uD83E\uDD5A',
    '\uD83E\uDD53', '\uD83C\uDF54', '\uD83C\uDF5F', '\uD83C\uDF55', '\uD83C\uDF2D', '\uD83C\uDF2E', '\uD83C\uDF2F', '\uD83C\uDF63',
    '\uD83C\uDF5C', '\uD83C\uDF5D', '\uD83C\uDF7F', '\uD83C\uDF69', '\uD83C\uDF6A', '\uD83C\uDF82', '\uD83C\uDF70', '\uD83E\uDDC1',
    '\uD83C\uDF6B', '\uD83C\uDF6C', '\uD83C\uDF6D', '\u2615', '\uD83C\uDF75', '\uD83E\uDD64', '\uD83C\uDF7A', '\uD83C\uDF7B',
    '\uD83E\uDD42', '\uD83C\uDF77', '\uD83C\uDF78', '\uD83E\uDD43',
    // Activities & sports
    '\u26BD', '\uD83C\uDFC0', '\uD83C\uDFC8', '\u26BE', '\uD83C\uDFBE', '\uD83C\uDFD0', '\uD83C\uDFB1', '\uD83C\uDFD3',
    '\uD83C\uDFF8', '\uD83E\uDD4A', '\u26F3', '\uD83C\uDFA3', '\uD83C\uDFBD', '\u26F7\uFE0F', '\uD83C\uDFC2', '\uD83C\uDFC6',
    '\uD83E\uDD47', '\uD83E\uDD48', '\uD83E\uDD49', '\uD83C\uDFC5', '\uD83C\uDFAE', '\uD83D\uDD79\uFE0F', '\uD83C\uDFB2', '\uD83E\uDDE9',
    '\u265F\uFE0F', '\uD83C\uDFAF', '\uD83C\uDFB3', '\uD83C\uDFA4', '\uD83C\uDFA7', '\uD83C\uDFB8', '\uD83E\uDD41', '\uD83C\uDFB9',
    '\uD83C\uDFBA', '\uD83C\uDFBB', '\uD83C\uDFAC', '\uD83C\uDFA8', '\uD83C\uDFAD', '\uD83C\uDFAA', '\uD83C\uDF9F\uFE0F', '\uD83C\uDFB0',
    // Travel & objects
    '\uD83D\uDE80', '\u2708\uFE0F', '\uD83D\uDE97', '\uD83D\uDE95', '\uD83D\uDE8C', '\uD83D\uDEB2', '\uD83D\uDEF4', '\uD83C\uDFCD\uFE0F',
    '\uD83D\uDE82', '\uD83D\uDEA2', '\u26F5', '\uD83D\uDDFA\uFE0F', '\uD83C\uDFE0', '\uD83C\uDFD6\uFE0F', '\uD83C\uDFD4\uFE0F', '\uD83D\uDDFD',
    '\uD83D\uDCBB', '\uD83D\uDDA5\uFE0F', '\u2328\uFE0F', '\uD83D\uDDB1\uFE0F', '\uD83D\uDCF1', '\uD83D\uDCF7', '\uD83C\uDFA5', '\uD83D\uDCFA',
    '\uD83D\uDCFB', '\u23F0', '\u231A', '\uD83D\uDD0B', '\uD83D\uDD0C', '\uD83D\uDCA1', '\uD83D\uDD26', '\uD83D\uDD6F\uFE0F',
    '\uD83D\uDEE0\uFE0F', '\uD83D\uDD27', '\uD83D\uDD28', '\u2699\uFE0F', '\uD83E\uDDF2', '\uD83D\uDD11', '\uD83D\uDD12', '\uD83D\uDD13',
    '\uD83D\uDCCC', '\uD83D\uDCCE', '\u2702\uFE0F', '\uD83D\uDCCF', '\uD83D\uDCDA', '\uD83D\uDCD6', '\uD83D\uDCDD', '\u270F\uFE0F',
    '\uD83D\uDCE6', '\uD83C\uDF81', '\uD83C\uDF88', '\uD83C\uDF89', '\uD83C\uDF8A', '\uD83D\uDED2', '\uD83D\uDCB0', '\uD83D\uDCB5',
    '\uD83D\uDCB3', '\uD83D\uDC8E',
    // Symbols
    '\u2705', '\u2611\uFE0F', '\u274C', '\u274E', '\u26A0\uFE0F', '\uD83D\uDEAB', '\u2757', '\u2753',
    '\u203C\uFE0F', '\u2049\uFE0F', '\uD83D\uDCAF', '\uD83D\uDD25', '\uD83D\uDCA5', '\uD83D\uDCAB', '\uD83D\uDCA2', '\uD83D\uDCA4',
    '\uD83D\uDCAC', '\uD83D\uDCAD', '\uD83D\uDDE8\uFE0F', '\uD83D\uDD14', '\uD83D\uDD15', '\uD83C\uDFB5', '\uD83C\uDFB6', '\u2795',
    '\u2796', '\u2797', '\u2716\uFE0F', '\u267E\uFE0F', '\uD83D\uDCB2', '\u00A9\uFE0F', '\u00AE\uFE0F', '\u2122\uFE0F',
    '\uD83D\uDD34', '\uD83D\uDFE0', '\uD83D\uDFE1', '\uD83D\uDFE2', '\uD83D\uDD35', '\uD83D\uDFE3', '\u26AB', '\u26AA',
    '\uD83D\uDD3A', '\uD83D\uDD3B', '\uD83D\uDD04', '\uD83D\uDD01', '\u25B6\uFE0F', '\u23F8\uFE0F', '\u23E9', '\u23EA',
    '\uD83C\uDD97', '\uD83C\uDD92', '\uD83C\uDD95', '\uD83C\uDD93', '\uD83D\uDD1D', '\uD83D\uDD1A', '\uD83D\uDD1C', '\uD83C\uDFC1',
    '\uD83D\uDEA9', '\uD83C\uDFF3\uFE0F', '\uD83C\uDFF4', '\uD83D\uDC1B',
  ],

  // In-progress draft helpers — preserved across tab switches *and* page
  // refreshes (via localStorage). Keyed by app slug (plus the thread key
  // for thread composers, #194) so each surface has its own draft.
  // Cleared on send.
  _draftKey(slug, threadKey) {
    return threadKey
      ? `usernode:gc-draft:${slug}:${threadKey}`
      : `usernode:gc-draft:${slug}`;
  },
  getDraft(slug, threadKey) {
    if (!slug) return '';
    try { return localStorage.getItem(GroupChat._draftKey(slug, threadKey)) || ''; }
    catch { return ''; }
  },
  setDraft(slug, value, threadKey) {
    if (!slug) return;
    try {
      if (value) localStorage.setItem(GroupChat._draftKey(slug, threadKey), value);
      else localStorage.removeItem(GroupChat._draftKey(slug, threadKey));
    } catch {}
  },

  // ── #194: thread-scoped chat state ──────────────────────────────────
  // One WS connection, multiple render targets: the general stream
  // (#gc-messages) plus at most one mounted thread (#gc-thread-messages,
  // inside an Issues/Proposals accordion). Per-thread history caches
  // live in `threads`, keyed by `${type}:${ref}`.
  threads: new Map(),       // key -> { messages, oldestId, hasMore, loaded, loading, failed }
  // #2992: the general stream's first history request failed, so the
  // transcript offers "Try again" instead of an empty (or quiet) channel.
  _historyFailed: false,
  activeThread: null,       // { type, ref } | null — the mounted thread
  _threadTypingTimer: null,

  threadKey(type, ref) {
    return `${type}:${ref}`;
  },

  _threadState(type, ref) {
    const key = GroupChat.threadKey(type, ref);
    if (!GroupChat.threads.has(key)) {
      GroupChat.threads.set(key, { messages: [], oldestId: null, hasMore: true, loaded: false, loading: false, failed: false });
    }
    return GroupChat.threads.get(key);
  },

  /**
   * The app the CURRENT mount is about, when the caller named one — see
   * mount(). Null means "ask AppView", which is what the app view's own
   * mount wants and what every path did before this existed.
   */
  _app: null,

  /**
   * The open app's slug and name, and whether this viewer may write.
   *
   * THE MOUNTING CALLER FIRST, AppView second. Every read below used to go
   * straight to AppView.appData, which is the app view's own state: correct
   * while that screen was the only one that mounted this module, and wrong
   * the moment the Messages screen mounts a discussion for an app the app
   * view has not opened. `_app` is what mount() was told; the AppView
   * fallback keeps the app view's own path byte-identical.
   */
  _appSlug() {
    if (GroupChat._app && GroupChat._app.slug) return GroupChat._app.slug;
    return (typeof AppView !== 'undefined' && AppView.appData && AppView.appData.slug) || null;
  },
  _appName() {
    if (GroupChat._app && GroupChat._app.name) return GroupChat._app.name;
    return (typeof AppView !== 'undefined' && AppView.appData && AppView.appData.name) || null;
  },

  // Called by AppView.renderGroupChatTab on every tab (re-)entry. On first
  // entry for an app we open the WS and lazy-load history; on subsequent
  // re-entries we reuse the existing connection + cached messages and just
  // restore scroll.
  /**
   * @param {string} appSlug
   * @param {{slug: string, name?: string, readOnly?: boolean}} [app]
   *
   * `app` is the SECOND caller's answer (#2718 review). This module reads
   * AppView.appData in a handful of places for the app's name and whether
   * the viewer may write — fine while the app view was the only surface that
   * mounted it. The Messages screen mounts it too now, for the discussion
   * thread of an app the app view has not opened, where AppView.appData is
   * null or somebody else's. So the mounting caller may state the app, and
   * `GroupChat._app` below is what the reads prefer.
   */
  mount(appSlug, app) {
    GroupChat._app = (app && app.slug === appSlug) ? app : null;
    // Side-panel hooks: bind the draggable divider on every mount
    // (the handle DOM element is recreated on each tab render, so
    // there's no stale binding to worry about) and restore any
    // saved open state so a refresh re-opens the same spec the user
    // was last viewing in this app. Both are no-ops when nothing's
    // saved or the slot doesn't exist yet.
    GroupChat._initSpecPanelResizer();
    GroupChat._restoreSpecPanelIfSaved(appSlug);

    // Reuse the existing connection only if it's actually usable
    // (CONNECTING or OPEN). A CLOSING/CLOSED socket sitting in
    // GroupChat.ws was the silent-drop trap behind #7: mount would
    // short-circuit here and subsequent send()s would no-op on the
    // dead socket until the user refreshed. Treat anything past
    // OPEN as "no socket" and reconnect.
    const liveWs = GroupChat.ws && GroupChat.ws.readyState <= 1; // CONNECTING(0) or OPEN(1)
    if (GroupChat.appSlug === appSlug && liveWs) {
      GroupChat.render();
      GroupChat.attachScrollHandlers();
      GroupChat.restoreScroll();
      GroupChat._applyPendingReveal();
      // #2387: coming back to a channel whose socket stayed up is opening it
      // too — what arrived while it was off screen is read now. After this
      // turn, once the remounted transcript is on the page.
      setTimeout(() => { if (GroupChat.appSlug === appSlug) void GroupChat.markRead(); }, 0);
      return;
    }
    GroupChat.connect(appSlug);
  },

  connect(appSlug) {
    GroupChat.disconnect();
    GroupChat.appSlug = appSlug;
    GroupChat.messages = [];
    GroupChat.threads = new Map();
    // B9: another project's cards and door are not this one's.
    GroupChat._botCards = new Map();
    GroupChat._botHere = false;
    GroupChat.activeThread = null;
    GroupChat.oldestMessageId = null;
    GroupChat.hasMore = true;
    GroupChat._historyFailed = false;
    GroupChat._lockedToBottom = true;
    GroupChat._savedScrollTop = null;
    GroupChat._didInitialScroll = false;
    GroupChat._reconnectAttempts = 0;
    GroupChat.replyDraft = null;
    GroupChat.replyDraftScope = null;
    // #2387: a new channel starts unread-cursor bookkeeping afresh.
    GroupChat._readUpTo = 0;
    GroupChat._unreadHold = null;
    GroupChat._longPressed = false;
    GroupChat._pressActive = false;
    GroupChat._clearPressTimer();
    GroupChat._closeReactionBar();

    GroupChat._openSocket();
    GroupChat.attachScrollHandlers();
  },

  // Open (or re-open) the WS for the currently-mounted appSlug.
  // Split out from connect() so the reconnect path can reuse the
  // socket-construction without resetting message history, draft,
  // scroll, etc. Reads GroupChat.appSlug rather than taking it as
  // an arg so a reconnect that fires after disconnect() has nulled
  // appSlug is a clean no-op.
  _openSocket() {
    const appSlug = GroupChat.appSlug;
    if (!appSlug) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // Staging previews run in an iframe and authenticate via the
    // shell-injected ?token= JWT; the session cookie may be orphaned by a
    // redeploy (sessions is staging:private). Forward the token on the WS
    // URL so the handshake has the same fallback HTTP requests do. In
    // prod there is no token param and this is a no-op. Prefer the live
    // URL, fall back to the boot-time capture (SPA history rewrites may
    // have stripped the query by now).
    const token = new URLSearchParams(location.search).get('token') || GroupChat._bootToken;
    const qs = token ? `?token=${encodeURIComponent(token)}` : '';
    const ws = new WebSocket(`${proto}//${location.host}/ws/chat/${appSlug}${qs}`);
    GroupChat.ws = ws;

    ws.onopen = () => {
      // Successful handshake → backoff resets, queued messages
      // flush in order, history loads (refreshes the cache in case
      // we missed broadcasts while disconnected).
      GroupChat._reconnectAttempts = 0;
      GroupChat._flushPendingOutgoing();
      GroupChat._renderStatusLine();
      GroupChat.loadHistory();
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        GroupChat.handleIncoming(msg);
      } catch {}
    };

    ws.onclose = (ev) => {
      // Surface the close code in the dev console — a clean reconnect
      // cycle logs 1006s, while e.g. 4004 (access denied) pinpoints a
      // server-side rejection that retrying will never fix.
      console.warn(`[gc] chat socket closed code=${ev.code}${ev.reason ? ` reason=${ev.reason}` : ''}`);
      // Bail if disconnect() ran (we changed apps / left the
      // surface entirely); the existing socket reference is stale.
      if (GroupChat.ws !== ws) return;
      GroupChat._renderStatusLine();
      GroupChat._scheduleReconnect();
    };

    // onerror typically fires immediately before onclose; leave
    // rescheduling to onclose so we don't double-schedule. We just
    // want the early UI signal that something went wrong.
    ws.onerror = () => {
      if (GroupChat.ws !== ws) return;
      GroupChat._renderStatusLine();
    };
  },

  _scheduleReconnect() {
    if (GroupChat._reconnectTimer) return;
    if (!GroupChat.appSlug) return;
    // 1s, 2s, 4s, 8s, 16s, capped at 30s. Plus 0–500ms jitter so a
    // server restart doesn't get a thundering herd from every open
    // tab waking up in lockstep.
    const n = GroupChat._reconnectAttempts;
    const base = Math.min(30_000, 1000 * Math.pow(2, n));
    const delay = base + Math.floor(Math.random() * 500);
    GroupChat._reconnectTimer = setTimeout(() => {
      GroupChat._reconnectTimer = null;
      GroupChat._reconnectAttempts++;
      if (GroupChat.appSlug) GroupChat._openSocket();
    }, delay);
  },

  // Drain the offline-typed messages onto the freshly-open socket.
  // Slice + reset before sending so a synchronous re-entry (e.g. if
  // ws.send throws and we somehow re-enter) doesn't double-send.
  _flushPendingOutgoing() {
    if (!GroupChat._pendingOutgoing.length) return;
    if (!GroupChat.ws || GroupChat.ws.readyState !== 1) return;
    const queue = GroupChat._pendingOutgoing.slice();
    GroupChat._pendingOutgoing.length = 0;
    for (const payload of queue) {
      try {
        GroupChat.ws.send(JSON.stringify(payload));
      } catch {
        // Socket closed mid-flush — re-queue whatever didn't go
        // and let the next reconnect try again.
        GroupChat._pendingOutgoing.unshift(payload);
        break;
      }
    }
  },

  disconnect() {
    GroupChat._historyLoad = null;
    if (GroupChat._reconnectTimer) {
      clearTimeout(GroupChat._reconnectTimer);
      GroupChat._reconnectTimer = null;
    }
    if (GroupChat.ws) {
      GroupChat.ws.onopen = null;
      GroupChat.ws.onmessage = null;
      GroupChat.ws.onclose = null;
      GroupChat.ws.onerror = null;
      GroupChat.ws.close();
      GroupChat.ws = null;
    }
    GroupChat.appSlug = null;
    GroupChat.threads = new Map();
    GroupChat.activeThread = null;
    GroupChat.typingUsers.clear();
    GroupChat._lockedToBottom = true;
    GroupChat._savedScrollTop = null;
    GroupChat._didInitialScroll = false;
    GroupChat._reconnectAttempts = 0;
    // Pending messages are tied to *this* app's chat room — when
    // we switch apps, drop them rather than silently sending them
    // to whatever room reconnects next.
    GroupChat._pendingOutgoing.length = 0;
  },

  // History can overlap messages already delivered over the socket. Keep the
  // server's chronological positions, but prefer the live cached version.
  _mergeHistory(messages, current) {
    const byId = new Map();
    for (const message of [...messages, ...current]) {
      byId.set(String(message.id), message);
    }
    return [...byId.values()];
  },

  // A block changes which persisted posts this viewer may see. Drop every
  // cached page (including topic discussions) before reloading from the
  // filtered API; an in-flight fetch may no longer publish its old result.
  refreshAfterBlock() {
    GroupChat._historyLoad = null;
    GroupChat.messages = [];
    GroupChat.oldestMessageId = null;
    GroupChat.hasMore = true;
    GroupChat._historyFailed = false;
    GroupChat.threads = new Map();
    GroupChat.typingUsers.clear();
    if (!GroupChat.appSlug) return;
    GroupChat.render();
    void GroupChat.loadHistory();
    const active = GroupChat.activeThread;
    if (active) {
      GroupChat.renderThread();
      void GroupChat.loadThreadHistory(active.type, active.ref);
    }
  },

  async loadHistory() {
    if (!GroupChat.appSlug || GroupChat._historyLoad) return;
    const load = {};
    GroupChat._historyLoad = load;
    const isFirstLoad = !GroupChat.oldestMessageId;
    let ok = false;
    try {
      const url = GroupChat.oldestMessageId
        ? `/api/apps/${GroupChat.appSlug}/messages?before=${GroupChat.oldestMessageId}&limit=50`
        : `/api/apps/${GroupChat.appSlug}/messages?limit=50${GroupChat._demoParam()}`;

      // Preserve scroll anchor when prepending older history so the viewport
      // doesn't jump to the top.
      const container = document.getElementById('gc-messages');
      const prevScrollHeight = container?.scrollHeight || 0;
      const prevScrollTop = container?.scrollTop || 0;

      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { messages } = await res.json();
      // Disconnect invalidates this request, even if we return to the same app.
      if (GroupChat._historyLoad !== load) return;
      ok = true;
      GroupChat._historyFailed = false;

      if (messages.length < 50) GroupChat.hasMore = false;

      if (messages.length > 0) {
        GroupChat.messages = GroupChat._mergeHistory(messages, GroupChat.messages);
        GroupChat.oldestMessageId = messages[0].id;
      }

      // Flushed: both branches below measure the scroller, and the rows have
      // to be in it first (features/group-chat/mount.ts publishTranscript).
      GroupChat.render({ flush: true });

      if (isFirstLoad && !GroupChat._didInitialScroll) {
        GroupChat.scrollToBottom();
        GroupChat._didInitialScroll = true;
        GroupChat._applyPendingReveal();
        // B9: the viewer's own cards under their requests, and the bot's door.
        void GroupChat._loadBotCards();
        // #2387: opening the channel reads it.
        void GroupChat.markRead();
      } else if (container) {
        const newScrollHeight = container.scrollHeight;
        container.scrollTop = prevScrollTop + (newScrollHeight - prevScrollHeight);
      }
    } catch { /* surfaced below */ } finally {
      if (GroupChat._historyLoad === load) {
        GroupChat._historyLoad = null;
        // #2992: a failed FIRST page left the channel blank (or claiming a
        // quiet channel) with nothing to retry; say so and offer "Try again".
        // A failed earlier page keeps what is on screen — the next scroll to
        // the top asks again.
        if (!ok && isFirstLoad) {
          GroupChat._historyFailed = true;
          GroupChat.render();
        }
      }
    }
  },

  handleIncoming(msg) {
    switch (msg.type) {
      case 'join_required': {
        // Posting here is for the app's members (services/communities.js).
        // The server answered THIS socket's own message with the question
        // rather than dropping it; see _answerJoinRequired.
        void GroupChat._answerJoinRequired(msg);
        break;
      }
      case 'chat': {
        // #194: thread messages never land in the general stream — they
        // route to the mounted thread (if it matches) or bump the
        // chat-count badge on their issue/proposal row. #2387 follow-up:
        // except a REPLY thread's, which also lands in the general stream,
        // drawn there as a line where it happened.
        if (msg.thread && msg.thread.type) {
          GroupChat._handleThreadIncoming(msg);
          if (msg.thread.type === 'message' && !GroupChat.messages.some((m) => String(m.id) === String(msg.id))) {
            const shouldStick = GroupChat._lockedToBottom || GroupChat._isOwnMessage(msg);
            GroupChat.messages.push(msg);
            GroupChat.appendMessage(msg);
            if (shouldStick) GroupChat.scrollToBottom();
          }
          break;
        }
        // #2389: your own message always brings you to the bottom, even when
        // you had scrolled up — you just sent it, so you expect to see it.
        const shouldStick = GroupChat._lockedToBottom || GroupChat._isOwnMessage(msg);
        GroupChat.messages.push(msg);
        GroupChat.appendMessage(msg);
        if (shouldStick) GroupChat.scrollToBottom();
        // #2387: a message landing on the open channel is read.
        void GroupChat.markRead();
        break;
      }
      case 'reaction': {
        // #25: authoritative reaction aggregate for one message.
        GroupChat._updateMessageReactions(msg.messageId, msg.reactions || []);
        break;
      }
      case 'bot_request_status': {
        // B9: a request asked of Homeroom bot here moved on.
        GroupChat._applyBotRequestStatus(msg);
        break;
      }
      case 'moderation_changed': {
        void GroupChat.loadHistory();
        GroupChat.loadThreadHistoryForOpen();
        break;
      }
      case 'chat_edit': {
        // Author edited a message — patch content + the "edited" marker in
        // place (preserves scroll, reactions, and the row's quote block).
        GroupChat._applyEdit(msg);
        break;
      }
      case 'chat_delete': {
        // #2387: its author deleted it — the placeholder, wherever it is drawn.
        GroupChat._applyDelete(msg);
        GroupChat._settleDelete(msg.id, null);
        break;
      }
      case 'delete_error': {
        // The server refused THIS socket's own delete (services/ws.js): put
        // the message back and let deleteMessage's caller say so.
        GroupChat._settleDelete(msg.id, new Error(`Delete failed (${msg.code || 'refused'})`));
        break;
      }
      case 'thread_summary': {
        // #2387: a reply landed in a thread — the chip under its first message.
        GroupChat._applyThreadSummary(msg);
        break;
      }
      case 'typing': {
        // #194: thread typing renders inside the mounted thread only;
        // general typing keeps the original #gc-typing slot.
        if (msg.thread && msg.thread.type) {
          const a = GroupChat.activeThread;
          if (a && a.type === msg.thread.type && Number(a.ref) === Number(msg.thread.ref)) {
            GroupChat._renderThreadTyping(msg.username);
          }
          break;
        }
        GroupChat.typingUsers.set(msg.userId, msg.username);
        GroupChat.renderTyping();
        setTimeout(() => {
          GroupChat.typingUsers.delete(msg.userId);
          GroupChat.renderTyping();
        }, 3000);
        break;
      }
    }
  },

  // Incoming message scoped to a thread: store it, and either append it
  // to the mounted thread's DOM or bump the row badge.
  _handleThreadIncoming(msg) {
    const { type, ref } = msg.thread;
    const st = GroupChat._threadState(type, ref);
    st.messages.push(msg);
    const a = GroupChat.activeThread;
    if (a && a.type === type && Number(a.ref) === Number(ref)) {
      const el = document.getElementById('gc-thread-messages');
      const scroll = GroupChat._threadScrollEl();
      if (el && scroll) {
        // #363: only stick to the newest message when the reader is already
        // near the bottom — otherwise a live message would yank someone who
        // has scrolled up to read the topic body or older replies.
        const nearBottom =
          scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80
          || GroupChat._isOwnMessage(msg);
        // Appended to the MODEL. #gc-thread-messages is the same React
        // transcript #gc-messages is (mounted with the 'thread' key a few
        // methods down), so the insertAdjacentHTML this replaces was legacy
        // markup spliced into a reconciled tree: the row carried none of the
        // component's handlers and the next store update erased it.
        GroupChat._react()?.appendTranscriptMessage(
          GroupChat._messageView(msg, { language: GroupChat.activeThread && GroupChat.activeThread.language }),
          'thread',
        );
        if (nearBottom) scroll.scrollTop = scroll.scrollHeight;
        return;
      }
    }
    // Only human messages bump the 💬 badge — dual-posted lifecycle
    // system rows would otherwise inflate a count that the server now
    // computes from msg_type='message' rows only.
    // A reply thread (#2387) has no badge of its own: its count is the chip
    // under its first message, which the `thread_summary` frame repaints.
    if (msg.msgType === 'message' && type !== 'message'
        && typeof AppView !== 'undefined' && AppView.bumpThreadBadge) {
      AppView.bumpThreadBadge(type, Number(ref));
    }
  },

  _renderThreadTyping(username) {
    if (username === App.user?.username) return;
    GroupChat._publishComposer('thread', { status: `${username} is typing...` });
    clearTimeout(GroupChat._threadTypingTimer);
    GroupChat._threadTypingTimer = setTimeout(() => {
      GroupChat._publishComposer('thread', { status: '' });
    }, 3000);
  },

  // Hard cap on the offline queue. Picked to be large enough that
  // a transient drop never bites (a fast typer at ~5 msgs/sec for
  // 10s is 50 msgs) and small enough that a genuinely-offline
  // session can't balloon RAM. When full, we drop the oldest to
  // preserve the user's most recent intent.
  PENDING_LIMIT: 50,

  // Submit a chat message. Either ships it now (socket OPEN) or
  // queues it for the next reconnect. Never silently drops — that
  // was the visible half of #7 ("messages fail to send without
  // page refresh"). The caller can clear the input as soon as we
  // return without losing user-typed content.
  // #621: true when the open app is in read-only dev mode for this
  // viewer (non-collaborator on an invite-only-build app). Writes are
  // suppressed client-side here; the WS server drops them regardless.
  _readOnly() {
    if (GroupChat._app) return !!GroupChat._app.readOnly;
    return typeof AppView !== 'undefined' && !!AppView.readOnly;
  },

  send(content, thread) {
    if (GroupChat._readOnly()) return;
    // #194: thread sends carry their scope.
    const payload = { type: 'chat', content };
    if (thread && thread.type && thread.ref) {
      payload.thread = { type: thread.type, ref: Number(thread.ref) };
    }
    // #15: consume the pending reply quote (if any) for this message and
    // clear it so it only attaches once. Both composers stage into the
    // same replyDraft, and mount/unmount of a thread clears it, so the
    // quote always belongs to the surface doing the send. We send a
    // minimal reference; the server re-derives author/snippet.
    // #2387: only a quote staged in THIS composer rides along — with a reply
    // thread open beside the channel, the other composer's belongs to it.
    const sendScope = payload.thread ? 'thread' : 'general';
    const quote = !GroupChat.replyDraftScope || GroupChat.replyDraftScope === sendScope
      ? GroupChat.replyDraft : null;
    if (quote) {
      GroupChat.replyDraft = null;
      GroupChat.replyDraftScope = null;
      GroupChat._renderQuotePreview();
      payload.quote = GroupChat._wireQuote(quote);
    }

    // #694: consume this composer scope's uploaded attachments. Entries
    // still uploading are never consumed (the submit handlers block the
    // send while any upload is in flight).
    const atts = GroupChat._takePendingAttachments(thread);
    if (atts.length) payload.attachmentIds = atts.map((a) => a.id);
    // #2938: whatever the error line said was about the composer this send
    // just emptied — a "Still uploading" notice from an earlier tap above
    // all, which nothing else would ever take down.
    GroupChat._setAttachError(null, thread);

    if (GroupChat.ws && GroupChat.ws.readyState === 1) {
      GroupChat.ws.send(JSON.stringify(payload));
      return;
    }
    // Drop oldest if at cap — better to lose the message someone
    // typed 3 minutes ago than the one they just typed.
    if (GroupChat._pendingOutgoing.length >= GroupChat.PENDING_LIMIT) {
      GroupChat._pendingOutgoing.shift();
    }
    GroupChat._pendingOutgoing.push(payload);
    // Kick a reconnect if one isn't already in flight. Covers the
    // edge case where send() is called between onclose firing and
    // the next reconnect being scheduled (shouldn't happen in
    // practice — onclose schedules synchronously — but cheap
    // insurance).
    if (!GroupChat._reconnectTimer && (!GroupChat.ws || GroupChat.ws.readyState >= 2)) {
      GroupChat._scheduleReconnect();
    }
    GroupChat._renderStatusLine();
  },

  // A 'chat' the server refused because the sender has not joined the app's
  // community. Ask through the shell's one Join prompt
  // (frontend/src/lib/join-required.ts, published as
  // window.UsernodeReact.offerJoin) and, on a yes, send the SAME message
  // again — the server echoed it back as `retry`, so its thread, quote and
  // attachments ride along untouched. The composer cleared itself when the
  // message left, so a no has to say the message was not sent, or it would
  // simply vanish.
  async _answerJoinRequired(msg) {
    const offer = typeof window !== 'undefined' ? window.UsernodeReact?.offerJoin : null;
    let joined = false;
    try {
      joined = typeof offer === 'function' ? await offer(msg) : false;
    } catch { joined = false; }
    if (joined && msg.retry && msg.retry.type === 'chat') {
      if (GroupChat.ws && GroupChat.ws.readyState === 1) {
        GroupChat.ws.send(JSON.stringify(msg.retry));
      } else {
        GroupChat._pendingOutgoing.push(msg.retry);
      }
      return;
    }
    window.PlatformUI?.toast?.(`Not sent. ${msg.error || 'Join this project to post here.'}`);
  },

  sendTyping(thread) {
    if (GroupChat._readOnly()) return;
    if (!GroupChat.ws || GroupChat.ws.readyState !== 1) return;
    if (GroupChat.typingTimeout) return;
    const payload = { type: 'typing' };
    if (thread && thread.type && thread.ref) {
      payload.thread = { type: thread.type, ref: Number(thread.ref) };
    }
    GroupChat.ws.send(JSON.stringify(payload));
    GroupChat.typingTimeout = setTimeout(() => { GroupChat.typingTimeout = null; }, 2000);
  },

  // ── The transcript's view model (#1191) ────────────────────────────
  //
  // One message -> the flat facts its row renders. Every branch the template
  // string evaluated inline is resolved HERE, where App.user, AppView.voteState
  // and the message-kind vocabulary already live; features/group-chat/
  // transcript.tsx renders it and is the only writer below #gc-messages.
  //
  // `bodyHtml` stays markup: renderMessageBody runs the content through
  // DevChat.renderMarkdown and a sanitizer, and a second copy of that pipeline
  // in React is exactly how the two drift apart.
  // The same "is this mine" rule `_messageView` stamps on each row.
  _isOwnMessage(msg) {
    const me = App.user?.id;
    return me != null && (msg.userId === me || msg.user_id === me);
  },

  // `opts.language` is 'chat' for a change page's Discussion, which draws
  // every row in the general chat's language (#2366): a person's message as
  // a bubble, and every notice as a message from whoever did it, with one
  // box under the header (`_threadEvent`). Absent, the row is modelled as
  // it always was: the general chat decides its own events, and a topic
  // thread keeps the centred lines.
  _messageView(msg, opts) {
    const chat = !!(opts && opts.language === 'chat');
    const kindRaw = msg.msgType || msg.msg_type || 'message';
    const meta = msg.metadata || msg.meta || {};
    const isVote = kindRaw === 'vote';
    const isSpecShare = kindRaw === 'spec_share' && !!meta.specShare;
    // A spec_share whose snapshot context is missing — an older server, or a
    // share whose metadata did not survive — degrades to a SYSTEM line, which
    // is what the string renderer's `if (!meta)` branch did. Without this
    // clause it fell through to `message`, and the row acquired an avatar, an
    // author name and a trip through the markdown pipeline it was never meant
    // to have.
    // Conflict resolution posts `conflict`, including the repeated synced-with-
    // main notices. They are system events too: treating them as human messages
    // bypasses the transcript's repeat folding on both history and live updates.
    const isSystem = kindRaw === 'system' || kindRaw === 'conflict'
      || (kindRaw === 'spec_share' && !isSpecShare);
    const kind = isSpecShare ? 'spec_share' : (isVote ? 'vote' : (isSystem ? 'system' : 'message'));
    const username = msg.username || 'System';
    const me = App.user && App.user.username;
    const editedAt = msg.editedAt || msg.edited_at;
    const q = meta.quote;
    const atts = meta.attachments;
    const stamp = GroupChat._stamp(msg.createdAt || msg.created_at);
    // The general chat's two proposal events, or null — see _proposalEvent;
    // on a change page's Discussion, every notice as one (_threadEvent).
    const event = chat ? GroupChat._threadEvent(msg, kind) : GroupChat._proposalEvent(msg, kind);
    // Resolved ONCE for the vote facts below — the row's tint, its phase and
    // the event's link all read the same live PR out of AppView.voteState.
    // #1688: the Friday card names several proposals in its text, so the
    // "PR #N" its content happens to carry must not resolve it to one.
    // A row on the proposal's own page (`here`) is not a door to that page.
    const linksProposal = !!event && event.type !== 'weekly' && !event.here;
    const pr = (isVote || linksProposal) ? GroupChat._resolvePr(...GroupChat._voteRef(msg)) : null;
    // #2387: a deleted message keeps its row and its thread, and loses its
    // words, files, quote and reactions (the server sends it that way; a live
    // `chat_delete` patches the same fields).
    const deleted = !!msg.deleted;
    const threadType = msg.thread_type || (msg.thread && msg.thread.type) || null;
    return {
      id: msg.id == null ? null : Number(msg.id),
      senderId: Number(msg.userId ?? msg.user_id) || null,
      kind,
      username,
      text: deleted ? '' : String(msg.content == null ? '' : msg.content),
      deleted,
      // The reply thread under a general-chat message (#2387), as the chip
      // under it draws it; `thread` on a row is the server's summary, not the
      // live frame's `{ type, ref }` scope, which never reaches a general row.
      thread: GroupChat._threadSummaryView(msg),
      canThread: !threadType && !deleted && (kind === 'message' || kind === 'spec_share'),
      threadRoot: !!msg._threadRoot,
      // #2387 follow-up: a reply-thread reply, which the general transcript
      // draws as a line where it landed (TranscriptRows); `thread_root` on a
      // loaded row, `threadRoot` on a live frame.
      replyOf: GroupChat._replyOfView(msg, threadType),
      time: stamp.text,
      timeTitle: stamp.title,
      // #2783: the raw instant, which the transcript groups consecutive
      // messages from one person on (groupsWithPrevious); `time` is display.
      at: msg.createdAt || msg.created_at || null,
      bodyHtml: kind === 'message' && !deleted ? renderMessageBody(msg.content) : '',
      systemText: kind === 'message' ? '' : String(msg.content == null ? '' : msg.content),
      mine: msg.userId === App.user?.id || msg.user_id === App.user?.id,
      editedTitle: editedAt ? GroupChat._editedTitle(editedAt) : null,
      unread: !!msg.has_unread_notification,
      bookmarked: !!(msg.saved || msg.bookmarked),
      // #2236: 'agent' when the connector posted this on the author's behalf
      // (`posted_via` on a loaded row, `postedVia` on a live broadcast);
      // null for a person typing. Only the one value the server writes.
      postedVia: (msg.postedVia || msg.posted_via) === 'agent' ? 'agent' : null,
      canEdit: msg.userId === App.user?.id || msg.user_id === App.user?.id,
      // The three header controls, gated exactly as the string template gated
      // them: edit is your own message and not read-only (#621), react is not
      // read-only, save needs a signed-in viewer.
      showEdit: kind === 'message'
        && (msg.userId === App.user?.id || msg.user_id === App.user?.id)
        && !GroupChat._readOnly(),
      showReact: !GroupChat._readOnly(),
      showBookmark: !!(window.App && App.user),
      quote: q && !deleted ? {
        icon: q.source === 'pr' ? '\u{1F500}' : (q.source === 'spec' ? '\u{1F4CB}' : '\u21A9'),
        username: q.author || (q.source === 'pr' ? `PR #${q.prNumber || ''}`.trim() : 'system'),
        excerpt: GroupChat._collapseSnippet(q.snippet).slice(0, 160),
        source: q.source || '',
        href: q.source === 'pr' ? (q.href || '') : null,
        targetId: q.refMsgId == null ? null : Number(q.refMsgId),
      } : null,
      // Set by a jump-to-original and cleared 1.5s later; never true on a
      // freshly built row.
      flash: false,
      reactions: (deleted ? [] : (msg.reactions || [])).map((r) => {
        const users = Array.isArray(r.users) ? r.users : [];
        return { emoji: r.emoji, count: r.count, users, mine: !!(me && users.includes(me)) };
      }),
      attachments: deleted ? [] : GroupChat._attachmentsView(msg),
      voteRowClass: isVote ? GroupChat._rowVoteClass(pr) : '',
      // Whether the vote is still open, which the general chat's event row
      // marks (features/group-chat/proposal-event.tsx). Vote rows only, so
      // the key is absent — not null — on every other kind.
      ...(isVote ? { votePhase: GroupChat._votePhase(pr) } : {}),
      // The event the general chat draws this row as — a message from
      // whoever did it, with the glyph the Dev board gives the same proposal;
      // null for every other row, which the general chat then does not draw.
      // The sender is the actor where the wording names one, else the app
      // itself, announcing a merge its vote decided. The link is a separate
      // field because it is PATCHED (refreshVoteControls) once the vote
      // snapshot names the session behind an older row, and a patch compares
      // fields by identity — an object rebuilt on every refresh would repaint
      // the transcript forever.
      event: event ? {
        ...event,
        sender: event.actor
          || GroupChat._appName()
          || 'System',
        // Yours when you are the actor — the row then sits on the right, as
        // your messages do. A merge the vote decided is nobody's.
        mine: !!(event.actor && App.user && event.actor === App.user.username),
        icon: GroupChat._eventIcon(event.type, event),
      } : null,
      eventHref: linksProposal ? GroupChat._eventHref(GroupChat._voteRef(msg)[0], pr) : null,
      // The controls host is module-filled, but only the message knows WHICH
      // pull request it is about — so the pair rides on the view model and
      // lands on the host as the two data-* attributes refreshVoteControls
      // reads back.
      // #3288: an ordinary message can carry one too, when its metadata
      // names the proposal: the Homeroom bot's "built this" post is a message
      // from its own user, and its card hangs under the bubble. Only that
      // metadata, never a "PR #N" in the words, which anybody can type; and
      // a person's post cannot set it (handleMessage builds its metadata).
      // B9: how a request asked of Homeroom bot is going, on the message
      // everybody sees (its metadata, set by the server alone), and the card
      // under it for its writer alone (GroupChat._botCards).
      botRequest: GroupChat._botRequestView(kind === 'message' && !deleted ? meta.botRequest : null),
      botCard: kind === 'message' && !deleted && (msg.userId === App.user?.id || msg.user_id === App.user?.id)
        ? (GroupChat._botCards.get(Number(msg.id)) || null) : null,
      canAskBot: GroupChat._botHere && kind === 'message' && !deleted && !threadType && msg.id != null
        && (msg.userId === App.user?.id || msg.user_id === App.user?.id)
        && !(meta.botRequest) && !GroupChat._botCards.has(Number(msg.id))
        && !/(^|[^\w])@(homeroom_bot\b|homeroom\s+bot\b)/i.test(String(msg.content || '')),
      voteRef: isVote || (kind === 'message' && !deleted && !!(meta.vote && meta.vote.sessionId))
        ? (([sessionId, prNumber]) => ({ sessionId, prNumber }))(GroupChat._voteRef(msg))
        : null,
      specShare: isSpecShare ? GroupChat._specShareView(meta.specShare, msg) : null,
    };
  },

  // The React bridge, or null before the bundle has evaluated. Reached by name
  // because this file is a classic script that loads before it.
  _react() {
    return (typeof window !== 'undefined' && window.UsernodeReact)
      ? window.UsernodeReact.groupChat : null;
  },

  render(opts) {
    const container = document.getElementById('gc-messages');
    if (!container) return;
    // (Re)establish the portal: #gc-messages is created fresh by
    // AppView.renderDevChatTab on every tab switch, so the previous mount is
    // pointing at a detached node by now.
    GroupChat._react()?.mountTranscript(container);
    GroupChat._react()?.publishTranscript(
      GroupChat.messages.map(GroupChat._messageView),
      'main',
      {
        earlier: false,
        placeholder: null,
        error: GroupChat._historyFailed ? 'Couldn’t load messages.' : null,
        // The quiet card's three facts (features/group-chat/quiet-card.tsx).
        // Whether the card SHOWS is the transcript's call — it knows whether a
        // person's message is among the rows, including one that lands live —
        // but "paged back to the beginning", "can this viewer post" and the
        // app's name are this module's to know.
        quiet: GroupChat._historyFailed ? null : {
          exhausted: !GroupChat.hasMore,
          canPost: !GroupChat._readOnly(),
          appName: GroupChat._appName()
            || 'this app',
        },
      },
      { flush: !!(opts && opts.flush) },
    );
  },

  appendMessage(msg) {
    if (!document.getElementById('gc-messages')) return;
    GroupChat._react()?.appendTranscriptMessage(GroupChat._messageView(msg));
  },

  // ── #194: thread chat (mounted inside Issues / Proposals accordions) ─

  // Render a thread chat (scoped message list + composer) into
  // `container` and make it the active thread render target. Reuses the
  // same renderMessageHtml pipeline and the one per-app WS connection —
  // which is opened on demand here, since the user can land on the
  // Issues/Proposals tabs without ever mounting the Chat sub-tab.
  // opts: { type, ref, container, readOnly?, notice?, placeholder? }
  mountThread(opts) {
    const { type, ref, container } = opts || {};
    if (!type || !ref || !container) return;
    const slug = GroupChat._appSlug()
      || GroupChat.appSlug;
    if (!slug) return;

    const liveWs = GroupChat.ws && GroupChat.ws.readyState <= 1;
    if (!(GroupChat.appSlug === slug && liveWs)) {
      GroupChat.connect(slug);
    }
    // `language: 'chat'` is the change page's Discussion (topic/
    // conversation.tsx): bubbles, and every notice as a message. Every other
    // thread keeps its flat rows and centred lines.
    const language = opts.language === 'chat' ? 'chat' : 'flat';
    GroupChat.activeThread = { type, ref: Number(ref), language };

    const threadKey = GroupChat.threadKey(type, ref);
    // A quote staged in the general composer must not ride along into a
    // thread send (and vice versa — see unmountThread): entering a thread
    // is a fresh composer context.
    GroupChat.clearQuote();
    // fullHeight (#194 card-list revision): the topic sub-view's thread
    // fills its flex container and mirrors the general chat pane's look —
    // full-width message list, h-5 typing slot, bordered-top composer with
    // the same input/Send sizing — instead of the boxed inline 40vh layout
    // kept for any legacy (non-fullHeight) caller.
    const fill = !!opts.fullHeight;
    // #363: in fill (topic) mode, the caller can ask for an in-scroll header
    // slot so the topic card/body and the discussion share ONE scroll region
    // (the topic sub-view paints into #gc-thread-head after mount). Off by
    // default, so the general-chat path and any legacy caller are unaffected.
    const withHeader = fill && !!opts.withHeader;
    // The SHELL is features/group-chat/thread-shell.tsx's — scroller,
    // messages host, typing slot and composer — mounted as a portal where
    // this used to be one `container.innerHTML` string. Its shape is fixed for
    // the life of a mount, so it travels as props rather than through a store.
    //
    // The transcript's own portal points INTO `#gc-thread-messages`, so drop
    // it before re-rendering the shell: React usually preserves that element,
    // but a layout flip recreates it, and a portal left pointing at a detached
    // node keeps its subtree and its store subscription alive. (The
    // `innerHTML` this replaces destroyed the node without telling React at
    // all — rule 1 in lib/legacy-portals.tsx, quietly broken.)
    const previousList = container.querySelector('#gc-thread-messages');
    if (previousList) GroupChat._react()?.unmountTranscript(previousList);
    GroupChat._react()?.mountThreadShell(container, {
      fill,
      withHeader,
      readOnly: !!opts.readOnly,
      notice: opts.notice || 'This thread is read-only.',
      placeholder: opts.placeholder || 'Reply in thread…',
      maxLength: GC_MAX_MESSAGE_LEN,
    });

    // Kit polish: keyboard avoidance on the unified thread scroller
    // (fill mode only — the legacy boxed layout scrolls inside a card).
    if (fill) {
      PlatformUI.attachScreenFx(
        'gc-thread',
        container.querySelector('#gc-thread-scroll'),
        document.getElementById('platform-header'),
        { navBar: false },
      );
    }

    // Full general-chat interaction set on the thread list: tap-to-quote,
    // long-press / hover reactions, quote-jump, reference chips.
    const msgsEl = container.querySelector('#gc-thread-messages');
    if (msgsEl) {
      GroupChat._attachQuoteHandlers(msgsEl);
      // app.css keys the thread's own tint off this: a bubbled row carries
      // its own surface. Written the way `renderThread` writes data-loaded.
      msgsEl.dataset.language = language;
    }

    const form = container.querySelector('#gc-thread-form');
    const input = container.querySelector('#gc-thread-input');
    if (form && input) {
      const saved = GroupChat.getDraft(slug, threadKey);
      if (saved) input.value = saved;
      GroupChat._autoGrowTextarea(input);
      const submitThread = () => {
        const content = input.value.trim();
        // #694: attachments-only sends are allowed; in-flight uploads
        // block the send (input keeps its text).
        const threadScope = { type, ref };
        if (GroupChat.attachmentsUploading(threadScope)) {
          GroupChat._setAttachError(GroupChat.UPLOAD_WAIT_NOTICE, threadScope);
          return;
        }
        if (!content && !GroupChat.hasPendingAttachments(threadScope)) return;
        GroupChat.send(content, threadScope);
        input.value = '';
        GroupChat.setDraft(slug, '', threadKey);
        GroupChat._autoGrowTextarea(input);
      };
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        submitThread();
      });
      input.addEventListener('input', () => {
        GroupChat.setDraft(slug, input.value, threadKey);
        GroupChat._autoGrowTextarea(input);
        GroupChat.sendTyping({ type, ref });
      });
      // Multi-line submit semantics, same as the general composer: Enter
      // sends, Shift+Enter inserts a newline, touch keyboards always insert
      // a newline (Send button sends) — and ⌘/Ctrl+Enter sends anywhere
      // (#2145), touch included: it is the chord every other composer on the
      // platform answers to, and the one way to send from a hardware
      // keyboard on a touch screen. Bubble phase so the autocomplete's
      // capture-phase Enter handling wins while its dropdown is open.
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        if ((e.metaKey || e.ctrlKey) || (!e.shiftKey && !GroupChat._isTouch())) {
          e.preventDefault();
          submitThread();
        }
      });
      // #694: paperclip / paste / drag-and-drop attachment wiring for
      // this thread's composer.
      GroupChat.setupAttachments({ type, ref });
      // #87/#130 parity with the general composer: @mention, #/PR#
      // reference and `:emoji` autocomplete on the thread input.
      if (typeof MentionAutocomplete !== 'undefined') {
        MentionAutocomplete.attach(input, slug);
      }
      if (typeof RefAutocomplete !== 'undefined') {
        RefAutocomplete.attach(input, slug);
      }
      // `:th` emoji shortcodes, and `:tada:` → 🎉 (same as the general one).
      if (typeof EmojiAutocomplete !== 'undefined') {
        EmojiAutocomplete.attach(input);
      }
      // #15 parity: Escape clears a staged reply quote (when the input is
      // empty so we don't fight other Escape semantics mid-typing).
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && GroupChat.replyDraft && !input.value) {
          e.preventDefault();
          GroupChat.clearQuote();
        }
      });
    }

    GroupChat.renderThread();
    // Only fetch on first open — the per-thread cache stays current
    // while connected (incoming WS messages are stored even when the
    // thread isn't mounted), and loadThreadHistory with an oldestId set
    // pages BACKWARD (that's the "Load earlier" button's job).
    const st = GroupChat._threadState(type, ref);
    if (!st.loaded) GroupChat.loadThreadHistory(type, ref);
  },

  // Drop the active thread render target (its history cache survives in
  // `threads` for instant re-open). Called when an accordion collapses
  // or the user leaves the sub-tab.
  unmountThread() {
    // A quote staged in the thread composer must not leak into the
    // general composer (replyDraft is global).
    if (GroupChat.activeThread && GroupChat.replyDraft) GroupChat.clearQuote();
    GroupChat.activeThread = null;
    clearTimeout(GroupChat._threadTypingTimer);
  },

  async loadThreadHistory(type, ref) {
    const slug = GroupChat.appSlug;
    if (!slug) return;
    const st = GroupChat._threadState(type, ref);
    // A topic repaint can mount this thread again before its first fetch
    // finishes. Only one initial/page request may own this cache at a time.
    if (st.loading) return;
    st.loading = true;
    let ok = false;
    // A retry goes back to "Loading…" while it is in flight.
    if (st.failed) {
      st.failed = false;
      const a = GroupChat.activeThread;
      if (a && a.type === type && Number(a.ref) === Number(ref)) GroupChat.renderThread();
    }
    const beforeParam = st.oldestId ? `&before=${st.oldestId}` : '';
    try {
      const res = await fetch(
        `/api/apps/${slug}/messages?thread_type=${encodeURIComponent(type)}&thread_ref=${encodeURIComponent(ref)}`
        + `&limit=50${beforeParam}${beforeParam ? '' : GroupChat._demoParam()}`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const messages = Array.isArray(data.messages) ? data.messages : [];
      ok = true;
      if (GroupChat.threads.get(GroupChat.threadKey(type, ref)) !== st) return;
      // #2387: a reply thread's first message, which heads the thread.
      if (type === 'message' && data.root) st.root = data.root;
      if (messages.length < 50) st.hasMore = false;
      if (messages.length > 0) {
        st.messages = GroupChat._mergeHistory(messages, st.messages);
        st.oldestId = messages[0].id;
      }
      st.loaded = true;
      st.failed = false;
      const a = GroupChat.activeThread;
      if (a && a.type === type && Number(a.ref) === Number(ref)) {
        GroupChat.renderThread({ flush: true });
      }
    } catch { /* surfaced below */ } finally {
      st.loading = false;
      // #2992: a failed FIRST page used to leave the thread on "Loading…"
      // forever — nothing re-rendered it. Record the failure and repaint so
      // the transcript offers "Try again" (loadThreadHistoryForOpen). A failed
      // earlier page keeps the "Load earlier" control, which is its retry.
      if (!ok && !st.loaded && GroupChat.threads.get(GroupChat.threadKey(type, ref)) === st) {
        st.failed = true;
        const a = GroupChat.activeThread;
        if (a && a.type === type && Number(a.ref) === Number(ref)) GroupChat.renderThread();
      }
    }
  },

  // #363: the element that actually scrolls a mounted thread. In the unified
  // topic layout it's the wrapper holding the header + messages; in the legacy
  // boxed layout the messages list is itself the scroller.
  // Called by the transcript's "Load earlier" control, which knows it is in a
  // thread but not WHICH — that is this module's state.
  loadThreadHistoryForOpen() {
    const a = GroupChat.activeThread;
    if (a) GroupChat.loadThreadHistory(a.type, a.ref);
  },

  _threadScrollEl() {
    return document.getElementById('gc-thread-scroll')
      || document.getElementById('gc-thread-messages');
  },

  // Paint the active thread's cached messages into #gc-thread-messages.
  renderThread(opts) {
    const a = GroupChat.activeThread;
    const el = document.getElementById('gc-thread-messages');
    if (!a || !el) return;
    const scroll = GroupChat._threadScrollEl();
    // Unified topic layout: header + messages share #gc-thread-scroll.
    const unified = !!scroll && scroll.id === 'gc-thread-scroll';
    const st = GroupChat._threadState(a.type, a.ref);
    // Preserve the reading position across "Load earlier" prepends. Read/write
    // scroll on the scroll container, not the (now non-scrolling) message list.
    const prevHeight = scroll ? scroll.scrollHeight : 0;
    const prevTop = scroll ? scroll.scrollTop : 0;
    const wasLoaded = el.dataset.loaded === '1';

    const language = a.language === 'chat' ? 'chat' : 'flat';
    const chat = language === 'chat';
    GroupChat._react()?.mountTranscript(el, 'thread');
    // #2387: a reply thread opens with the message it hangs off — from the
    // server's `root`, or the general stream's copy until that lands.
    let root = null;
    if (a.type === 'message') {
      root = st.root || GroupChat.messages.find((m) => Number(m.id) === Number(a.ref)) || null;
    }
    const rows = st.messages.map((m) => GroupChat._messageView(m, { language }));
    if (root) rows.unshift(GroupChat._messageView({ ...root, _threadRoot: true }, { language }));
    GroupChat._react()?.publishTranscript(
      rows,
      'thread',
      {
        earlier: !!(st.loaded && st.hasMore && st.messages.length),
        // In the chat language the quiet card says what an empty thread
        // means; the placeholder line is the flat thread's.
        placeholder: st.loaded
          ? (st.messages.length || chat ? null : 'No messages yet. Start the thread.')
          : (st.failed ? null : 'Loading…'),
        error: !st.loaded && st.failed ? 'Couldn’t load this thread.' : null,
        language,
        ...(chat && st.loaded ? {
          quiet: {
            variant: 'change',
            exhausted: !st.hasMore,
            canPost: !GroupChat._readOnly(),
            appName: GroupChat._appName()
              || 'this app',
          },
        } : {}),
      },
      // A history page measures the scroller below; see render().
      { flush: !!(opts && opts.flush) },
    );
    el.dataset.loaded = st.loaded ? '1' : '';

    if (!scroll) return;
    if (wasLoaded) {
      scroll.scrollTop = prevTop + (scroll.scrollHeight - prevHeight);
    } else if (unified) {
      // #363: open a topic at the TOP so its card/body reads first; the user
      // scrolls down into the discussion (general chat lands at the bottom).
      scroll.scrollTop = 0;
    } else {
      scroll.scrollTop = scroll.scrollHeight;
    }
  },

  // ── #15: reply / quote ──────────────────────────────────────────────

  // Stage a quote to attach to the next message and focus whichever
  // composer is mounted — the thread composer when a topic is open, the
  // general one otherwise. Called by the tap handler (chat + thread rows)
  // and by AppView (PR titles). No-op when no composer exists (read-only
  // merged-proposal thread): staging an invisible quote would silently
  // attach to a later message elsewhere.
  setQuote(quote, scope) {
    if (!quote) return;
    // #2387: with a reply thread open BESIDE the general chat both composers
    // are on screen, so the row's own transcript names the one to reply in.
    // Without a scope, the old rule: the thread composer when a topic is open.
    const input = scope === 'main'
      ? document.getElementById('gc-input')
      : scope === 'thread'
        ? document.getElementById('gc-thread-input')
        : (document.getElementById('gc-thread-input') || document.getElementById('gc-input'));
    if (!input) return;
    GroupChat.replyDraft = quote;
    GroupChat.replyDraftScope = input.id === 'gc-thread-input' ? 'thread' : 'general';
    GroupChat._renderQuotePreview();
    // The caret goes to the box where there is a mouse or trackpad (a
    // hardware keyboard, as a rule). On a touch-only phone, focusing pops the
    // on-screen keyboard over the message being replied to; the quote is
    // staged and the box is one tap away (message-actions/focus.ts).
    let fine = false;
    try { fine = !!(window.matchMedia && window.matchMedia('(any-pointer: fine)').matches); } catch (_) { fine = false; }
    if (fine) input.focus();
  },

  clearQuote() {
    GroupChat.replyDraft = null;
    GroupChat.replyDraftScope = null;
    GroupChat._renderQuotePreview();
  },

  // Minimal wire form — server re-derives author/snippet from the source.
  _wireQuote(q) {
    if (q.source === 'pr') return { source: 'pr', sessionId: q.sessionId };
    return { source: q.source, refMsgId: q.refMsgId };
  },

  // Render (or clear) the composer's "Replying to …" preview chip —
  // into the thread composer's slot when a topic is open, else the
  // general composer's (only one of the two is ever in the DOM).
  // Published to BOTH scopes, which is what it always meant. `replyDraft` is
  // one value — entering a thread clears it (see mountThread) — and only one
  // of the two composers is ever in the DOM, so "write into whichever host is
  // present" and "tell both slots" describe the same behaviour. Saying it this
  // way removes the question of which one wins.
  _renderQuotePreview() {
    const q = GroupChat.replyDraft;
    // #2391: "Replying to message" named nothing. A row with no author is
    // either a platform message (a proposal event, #2390) or a message whose
    // author is gone; say which.
    const view = q ? {
      label: q.source === 'pr'
        ? `PR #${q.prNumber || ''}`.trim()
        : (q.author ? `@${q.author}` : (q.source === 'event' ? 'a platform message' : 'a message')),
      snippet: GroupChat._collapseSnippet(q.snippet).slice(0, 120),
    } : null;
    // #2387: the chip goes to the composer the quote was staged in, now that
    // both can be on screen at once (a reply thread beside the channel).
    const scope = GroupChat.replyDraftScope;
    GroupChat._publishComposer('general', { quote: !scope || scope === 'general' ? view : null });
    GroupChat._publishComposer('thread', { quote: !scope || scope === 'thread' ? view : null });
  },

  // True only for a clean tap: pointer barely moved AND no text is
  // selected. Lets drag-to-select / long-press-select coexist with
  // tap-to-quote (mobile-first, per #15).
  _isCleanTap(e) {
    const t = GroupChat._tap || { x: e.clientX, y: e.clientY };
    if (Math.abs(e.clientX - t.x) + Math.abs(e.clientY - t.y) > 8) return false;
    const sel = window.getSelection && window.getSelection();
    if (sel && String(sel).trim() !== '') return false;
    return true;
  },

  // Collapse all whitespace runs (including the newlines of a multi-line
  // message) to single spaces, so quote snippets stay tidy and single-line.
  _collapseSnippet(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
  },

  // Build a quote object from a tapped chat row (message / event / spec).
  _quoteFromRow(row) {
    const id = parseInt(row.dataset.msgId || '', 10) || null;
    if (!id) return null;
    if (row.classList.contains('gc-spec-card')) {
      return {
        source: 'spec', refMsgId: id,
        author: row.dataset.sharedBy || null,
        snippet: row.dataset.specTitle || 'Spec',
      };
    }
    // #2390: a proposal event (submitted / went live) is a platform message
    // too, and replying to one is how the discussion picks it up. Its line of
    // text is the snippet; the server re-derives the stored quote from the
    // row itself and attributes a system row to nobody.
    if (row.classList.contains('gc-event')) {
      const textEl = row.querySelector('.gc-event-text');
      return { source: 'event', refMsgId: id, author: null, snippet: GroupChat._collapseSnippet(textEl ? textEl.textContent : '') };
    }
    if (row.classList.contains('gc-msg-system')) {
      const textEl = row.querySelector('.gc-msg-system-text');
      const text = (textEl ? textEl.textContent : row.textContent) || '';
      return { source: 'event', refMsgId: id, author: null, snippet: GroupChat._collapseSnippet(text) };
    }
    const body = row.querySelector('.gc-msg-content');
    let snippet = GroupChat._collapseSnippet(body ? body.textContent : '');
    // #694: an attachments-only message has an empty body — preview it as
    // its first file name (the server re-derives the stored snippet the
    // same way).
    if (!snippet) {
      const firstAtt = row.querySelector('.dc-msg-attachments .dc-attach-name, .dc-msg-attachments img');
      if (firstAtt) snippet = `\u{1F4CE} ${firstAtt.textContent || firstAtt.getAttribute('alt') || 'file'}`;
    }
    return {
      source: 'message', refMsgId: id,
      author: row.dataset.username || null,
      // Collapse newlines (multi-line messages render with pre-wrap) so the
      // quote chip stays single-line.
      snippet,
    };
  },

  // Click on a rendered quote block → open the PR, or scroll to & flash
  // the original message if it's in the loaded window.
  _handleQuotedClick(quoted) {
    if (quoted.dataset.quoteSource === 'pr') {
      const href = quoted.dataset.quoteHref;
      if (href) window.open(href, '_blank', 'noopener');
      return;
    }
    const ref = parseInt(quoted.dataset.quoteRef || '', 10);
    if (!ref) return;
    // Jump within whichever message list the quote block lives in
    // (general chat or a mounted thread).
    const container = quoted.closest('#gc-messages, #gc-thread-messages')
      || document.getElementById('gc-messages');
    const target = container && container.querySelector(`[data-msg-id="${ref}"]`);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // The highlight is `flash` on the model, not a class written onto a row
    // React renders — the next repaint would have taken it off mid-animation.
    GroupChat._react()?.patchTranscriptMessage(ref, { flash: true });
    setTimeout(() => GroupChat._react()?.patchTranscriptMessage(ref, { flash: false }), 1500);
  },

  // Delegated tap-to-quote + quote-jump + reactions on the messages
  // container. Bound once (idempotent) — the same shape the spec card's own
  // delegate had before its button became a React control (see openSharedSpec).
  //
  // Interaction model (#15 + #25, mobile-first):
  //   • quick tap         → quote the row (#15)
  //   • long-press (hold) → open the reaction bar (#25, WhatsApp-style)
  //   • hover react button→ open the reaction bar (desktop)
  //   • tap a reaction pill → toggle that emoji for you
  //   • drag / text-select → neither (handled by the move threshold)
  _attachQuoteHandlers(container) {
    if (container._gcQuoteBound) return;
    container._gcQuoteBound = true;

    const ROW_SEL = '.gc-msg, .gc-msg-system, .gc-spec-card';
    // #2390: tap-to-quote also takes the general chat's proposal events.
    // Only the tap: long-press and the react button stay on ROW_SEL, because
    // an event carries no reactions (#2366). Its box is an anchor, so a tap
    // on the box still opens the proposal (the `a, button` rule below) and a
    // tap anywhere else on the row stages the reply.
    const QUOTE_SEL = `${ROW_SEL}, .gc-event`;

    container.addEventListener('pointerdown', (e) => {
      GroupChat._tap = { x: e.clientX, y: e.clientY };
      GroupChat._longPressed = false;
      GroupChat._pressActive = false;
      GroupChat._clearPressTimer();
      // Don't arm long-press on interactive children (links, buttons,
      // pills, the quote block) — those have their own click semantics.
      if (e.target.closest('a, button, .gc-quoted, .gc-ref, .msgx-bar')) return;
      const row = e.target.closest(ROW_SEL);
      if (!row || !container.contains(row)) return;
      // #2387: a person's row answers a long press itself — the shared
      // message sheet (features/message-actions) — so this module's bar
      // stands down for it and keeps only the system and spec rows.
      if (row.classList.contains('gc-msg')) return;
      // Suppress native text selection while the press is stationary, so a
      // long-press opens the reaction bar cleanly instead of highlighting
      // the message text (and popping the iOS selection magnifier). If the
      // user drags past the threshold (pointermove below) we hand selection
      // back so a deliberate drag still selects text.
      GroupChat._pressActive = true;
      GroupChat._setMsgSelect(container, false);
      GroupChat._pressTimer = setTimeout(() => {
        GroupChat._pressTimer = null;
        GroupChat._longPressed = true;
        GroupChat._openReactionBar(row);
      }, 450);
    }, true);

    container.addEventListener('pointermove', (e) => {
      if (!GroupChat._pressActive || !GroupChat._tap) return;
      const dist = Math.abs(e.clientX - GroupChat._tap.x) + Math.abs(e.clientY - GroupChat._tap.y);
      if (dist <= 8) return; // tiny jitter — keep the timer + selection suppressed
      // Real drag: the user is selecting text (desktop) or scrolling
      // (touch), not long-pressing. Cancel the reaction timer and re-enable
      // selection so the drag highlights text.
      GroupChat._clearPressTimer();
      GroupChat._setMsgSelect(container, true);
    }, true);

    const endPress = () => {
      GroupChat._clearPressTimer();
      GroupChat._pressActive = false;
      // Restore the default (selectable) state for the next gesture.
      GroupChat._setMsgSelect(container, true);
    };
    container.addEventListener('pointerup', endPress, true);
    container.addEventListener('pointercancel', endPress, true);

    container.addEventListener('click', (e) => {
      // #2387: the shared bar, its picker and menu, and the thread chip are
      // React controls with their own handlers; a click inside them (the
      // picker's search box included) is never a tap-to-quote.
      if (e.target.closest('.msgx-bar, .msgx-thread-chip, .msgx-thread-activity, .gc-msg-deleted-text')) return;
      // A reaction pill is NOT dispatched here. The reskin draws it with
      // @/components/ui/feed's `ReactionPill`, so no node carries
      // `.gc-react-pill` any more and this branch had nothing to match; the
      // pill calls `GroupChat.sendReact` from an onClick in
      // features/group-chat/transcript.tsx instead. It is a <button>, so the
      // tap-to-quote tail below already declines it.
      // #1280: save/unsave button → toggle this message in the viewer's
      // own saved list. Handled before tap-to-quote (like Edit below) so
      // the click doesn't also stage a reply.
      const saveBtn = e.target.closest('.gc-msg-save');
      if (saveBtn) {
        const row = saveBtn.closest('[data-msg-id]');
        const id = row && parseInt(row.dataset.msgId || '', 10);
        if (id) GroupChat.toggleBookmark(id);
        return;
      }
      // Edit button (own ordinary messages) → swap the row into an inline
      // editor. Handled before tap-to-quote so the click doesn't also stage
      // a reply.
      const editBtn = e.target.closest('.gc-msg-edit');
      if (editBtn) {
        const row = editBtn.closest('[data-msg-id]');
        const id = row && parseInt(row.dataset.msgId || '', 10);
        if (id) GroupChat._startEdit(id);
        return;
      }
      // Clicks inside an open inline editor (textarea, notice span, or any
      // other non-button descendant) belong to the editor — it manages its
      // own behaviour through the listeners attached in _startEdit. Handled
      // before tap-to-quote so the click doesn't also stage a reply.
      if (e.target.closest('.gc-edit')) return;
      // Hover react button (desktop) → open the bar for this row.
      const addBtn = e.target.closest('.gc-react-add');
      if (addBtn) {
        const row = addBtn.closest(ROW_SEL);
        if (row) GroupChat._openReactionBar(row);
        return;
      }
      // A long-press already opened the bar — swallow the trailing click
      // so it doesn't also quote the row.
      if (GroupChat._longPressed) { GroupChat._longPressed = false; return; }
      // #130: PR / issue reference chips reveal the matching row in the
      // activity drawer (GitHub fallback when it isn't there). Handled
      // before tap-to-quote so a chip click doesn't also stage a reply.
      const ref = e.target.closest('.gc-ref');
      if (ref) {
        if (typeof AppView !== 'undefined' && AppView.revealInDrawer) {
          AppView.revealInDrawer(ref.dataset.refType, ref.dataset.refNumber);
        }
        return;
      }
      // #130: the spec-share card's "PR #N" anchor previously rendered
      // dead — route it through the same drawer reveal as the chips.
      const specPr = e.target.closest('.gc-spec-pr');
      if (specPr) {
        e.preventDefault();
        if (typeof AppView !== 'undefined' && AppView.revealInDrawer) {
          AppView.revealInDrawer('pr', specPr.dataset.pr);
        }
        return;
      }
      const quoted = e.target.closest('.gc-quoted');
      if (quoted) { GroupChat._handleQuotedClick(quoted); return; }
      // Real links/buttons (PR link, "View full spec", mentions) win.
      if (e.target.closest('a, button')) return;
      if (!GroupChat._isCleanTap(e)) return;
      const row = e.target.closest(QUOTE_SEL);
      if (!row || !container.contains(row)) return;
      // Clicking a dotted message clears just that message's unread
      // mention/reply/reaction notification.
      const rowId = parseInt(row.dataset.msgId || '', 10);
      if (rowId) GroupChat._clearMessageDot(rowId);
      const quote = GroupChat._quoteFromRow(row);
      // #2387: the transcript tapped names the composer — with a reply
      // thread open beside the channel, both are on screen.
      const scope = container.id === 'gc-thread-messages' ? 'thread'
        : container.id === 'gc-messages' ? 'main' : undefined;
      if (quote) GroupChat.setQuote(quote, scope);
    });

    // #130: chips are spans with role="link" tabindex="0" — give keyboard
    // users the same drawer reveal a click gets.
    container.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const ref = e.target.closest && e.target.closest('.gc-ref');
      if (!ref) return;
      e.preventDefault();
      if (typeof AppView !== 'undefined' && AppView.revealInDrawer) {
        AppView.revealInDrawer(ref.dataset.refType, ref.dataset.refNumber);
      }
    });
  },

  _clearPressTimer() {
    if (GroupChat._pressTimer) {
      clearTimeout(GroupChat._pressTimer);
      GroupChat._pressTimer = null;
    }
  },

  // Toggle native text selection on the messages list. Disabled at the
  // start of a press so a stationary long-press reacts (instead of
  // selecting/highlighting text); re-enabled as soon as a drag is detected
  // so drag-to-select still works.
  _setMsgSelect(container, enabled) {
    const c = container || document.getElementById('gc-messages');
    if (!c) return;
    const v = enabled ? '' : 'none';
    c.style.userSelect = v;
    c.style.webkitUserSelect = v;
  },

  // ── #25: reaction rendering ─────────────────────────────────────────
  //
  // `_renderReactionPills` and `_renderReactionsHtml` lived here — the pills
  // and their (possibly empty) container as an HTML string. Both are
  // features/group-chat/transcript.tsx's `<Reactions>` now, and the empty
  // container is still always rendered so `.gc-reactions:empty` keeps
  // collapsing its margin.

  // `_renderReactAddBtn` lived here — the desktop hover affordance that opens
  // the bar. It is transcript.tsx's `RowActions` now, gated by the same
  // `showReact` (#621: no reactions read-only) and still `tabindex="-1"` so it
  // stays out of the tab order; touch devices long-press instead, and CSS
  // hides it where there is no hover.

  // ── #1280: save (bookmark) a message ────────────────────────────────

  // `_renderBookmarkBtn`, `_bookmarkSvg` and the two Heroicons path constants
  // lived here. The button is transcript.tsx's `<RowActions>` now, drawing
  // frontend/@/components/ui/icons.tsx's BookmarkIcon / BookmarkSolidIcon
  // directly — so the duplicated path data this file used to carry, and the
  // test that kept the two copies in step, are both gone rather than stale.
  // What stays is the RULE the button ran on: `showBookmark` in `_messageView`
  // (a signed-in viewer, and no `_readOnly()` gate — #621, saving writes
  // nothing to the app) and the optimistic flip in `_paintBookmark` below.

  // Toggle the save state of one message. Optimistic: the button flips
  // immediately (a save is a personal, instantly-reversible act, and a
  // spinner on a bookmark reads as breakage), and reverts if the server
  // refuses. The authoritative flag comes back with the next history load.
  async toggleBookmark(messageId) {
    if (!messageId || !GroupChat.appSlug) return;
    const msg = GroupChat._findMessage(messageId);
    const next = !(msg && msg.bookmarked);
    if (msg) msg.bookmarked = next;
    GroupChat._paintBookmark(messageId, next);
    try {
      const res = await fetch(
        `/api/apps/${GroupChat.appSlug}/messages/${messageId}/bookmark`,
        { method: next ? 'PUT' : 'DELETE' }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // The drawer's pinned section is fed by the notifications payload,
      // so it only learns about this through a refresh. Notifications is a
      // window global published by the React bundle; guard for the app
      // frame and the vm harnesses, where it is absent.
      if (window.Notifications && Notifications.refresh) Notifications.refresh();
    } catch (err) {
      if (msg) msg.bookmarked = !next;
      GroupChat._paintBookmark(messageId, !next);
      if (typeof PlatformUI !== 'undefined' && PlatformUI.toast) {
        PlatformUI.toast(next ? "Couldn't save that message" : "Couldn't unsave that message");
      }
      console.warn('[group-chat] bookmark toggle failed', err);
    }
  },

  // Patch just the button(s) for one message — the row may be rendered
  // twice (general stream and a mounted thread), so every match is painted.
  //
  // It writes the MODEL, not the button. The button lives inside #gc-messages,
  // which features/group-chat/transcript.tsx owns end to end, so the
  // classList / setAttribute / innerHTML writes this replaces were a second
  // author in a reconciled tree — they worked until the next store update
  // repainted the row from the model and silently reverted them.
  //
  // patchTranscriptMessage patches EVERY transcript by design, which is
  // exactly what the two-selector sweep was doing by hand.
  // ── #2387: the shared bar's acts that are new to this module ─────────

  // A row's thread summary as the chip under it draws it, or null.
  _threadSummaryView(msg) {
    const t = msg && msg.thread;
    if (!t || typeof t !== 'object' || t.type) return null;
    const count = Number(t.reply_count ?? t.replyCount) || 0;
    if (count < 1) return null;
    const people = Array.isArray(t.participants) ? t.participants : [];
    const last = t.last_reply || t.lastReply || null;
    return {
      replyCount: count,
      lastReplyAt: t.last_reply_at || t.lastReplyAt || null,
      participants: people.map((p) => (p && typeof p === 'object' ? p.username : p)).filter(Boolean).slice(0, 3),
      // #2387 follow-up: the newest reply, which the card under the message shows.
      lastReply: last && typeof last === 'object'
        ? { name: String(last.username || 'someone'), text: String(last.content || '') }
        : null,
    };
  },

  // A reply-thread reply's place in the general stream (#2387 follow-up):
  // which thread, and the start of its first message. Null for any other row.
  _replyOfView(msg, threadType) {
    if (threadType !== 'message') return null;
    const ref = Number(msg.thread_ref ?? (msg.thread && msg.thread.ref));
    if (!Number.isSafeInteger(ref) || ref <= 0) return null;
    const root = msg.thread_root || msg.threadRoot || null;
    return {
      rootId: ref,
      rootText: root && !root.deleted ? String(root.content || '') : '',
      rootDeleted: !!(root && root.deleted),
    };
  },

  // Every loaded copy of one message — the general stream's and any cached
  // thread's (a reply thread's head is a general message too).
  _eachCopy(id, fn) {
    const n = Number(id);
    for (const m of GroupChat.messages) if (Number(m.id) === n) fn(m);
    for (const st of GroupChat.threads.values()) {
      if (st.root && Number(st.root.id) === n) fn(st.root);
      for (const m of st.messages) if (Number(m.id) === n) fn(m);
    }
  },

  // Reply to a row — the same quote a tap on it stages, built from the model
  // rather than read out of the row's markup, into the composer of the
  // transcript the row is in.
  replyToMessage(id, surface) {
    const n = Number(id);
    let msg = null;
    GroupChat._eachCopy(n, (m) => { if (!msg) msg = m; });
    if (!msg) return;
    const meta = msg.metadata || msg.meta || {};
    const kind = msg.msgType || msg.msg_type || 'message';
    let snippet = GroupChat._collapseSnippet(msg.content || '');
    if (!snippet && Array.isArray(meta.attachments) && meta.attachments[0]) {
      snippet = `\u{1F4CE} ${meta.attachments[0].filename || meta.attachments[0].name || 'file'}`;
    }
    const quote = kind === 'spec_share'
      ? { source: 'spec', refMsgId: n, author: msg.username || null, snippet: (meta.specShare && meta.specShare.title) || 'Spec' }
      : { source: 'message', refMsgId: n, author: msg.username || null, snippet };
    GroupChat.setQuote(quote, surface === 'thread' ? 'thread' : 'main');
  },

  // The address a message link opens — the channel in Messages, scrolled to
  // it (#messages/app/<slug>/m/<id>).
  //
  // Only for the general stream and its reply threads, which is what the
  // address can find: a message in an issue's or a proposal's discussion is
  // not in the channel, and its link would open the channel at the bottom.
  messageAddress(id) {
    const slug = GroupChat.appSlug;
    if (!slug) return null;
    let msg = null;
    GroupChat._eachCopy(id, (m) => { if (!msg) msg = m; });
    const type = msg && (msg.thread_type || (msg.thread && msg.thread.type) || null);
    if (!msg || (type && type !== 'message')) return null;
    return `#messages/app/${encodeURIComponent(slug)}/m/${Number(id)}`;
  },

  // Open the reply thread under a general-chat message, beside the channel.
  // #3653: on the channel's project page — its Discussion tab, where the room
  // lives — it opens there, in place: the room has no address of its own on
  // that page, and leaving for Messages to read a thread was leaving the
  // community for a page apart from it. Anywhere else (Homeroom's archived
  // app chat, in Messages) it is the thread's Messages address.
  openReplyThread(id) {
    const slug = GroupChat.appSlug;
    if (!slug || !id) return;
    if (GroupChat._openThreadInPage(slug, id)) return;
    location.hash = `#messages/app/${encodeURIComponent(slug)}/thread/${Number(id)}`;
  },

  // Is `slug`'s channel on screen in its project page's Discussion tab
  // (features/dev-board/workshop/project-discussion.tsx)? Then open the
  // reply thread under `rootId` there and say so.
  _openThreadInPage(slug, rootId) {
    const container = document.getElementById('gc-messages');
    const tab = container && container.closest && container.closest('[data-ws-discussion]');
    if (!tab || tab.getAttribute('data-discussion-app') !== slug) return false;
    if (typeof AppView === 'undefined' || !AppView._stashDiscussionTarget) return false;
    AppView._stashDiscussionTarget(slug, { threadRootId: Number(rootId) });
    return true;
  },

  isReplyThreadOpen(id) {
    const a = GroupChat.activeThread;
    return !!a && a.type === 'message' && Number(a.ref) === Number(id);
  },

  // Delete one of your own messages. Over the socket when it is open (the
  // same path an edit takes), else the REST route; the row turns into its
  // placeholder at once, and the server's `chat_delete` confirms it.
  //
  // A delete that does not go through puts the message back before
  // rejecting, so the caller's "Couldn't delete" toast is not shown beside a
  // placeholder: a REST delete refused, or whose fetch throws (offline), and
  // a socket delete the server answers with `delete_error`. A socket delete
  // resolves on its `chat_delete`, or quietly after DELETE_SETTLE_MS when no
  // answer comes (an already-deleted message is confirmed by silence).
  DELETE_SETTLE_MS: 30000,
  _pendingDeletes: new Map(),

  async deleteMessage(id) {
    const slug = GroupChat.appSlug;
    if (!slug || !id) return;
    const before = [];
    GroupChat._eachCopy(id, (m) => { before.push([m, { ...m }]); });
    GroupChat._applyDelete({ id });
    const restore = () => {
      for (const [m, copy] of before) Object.assign(m, copy, { deleted: false });
      GroupChat.render();
      if (GroupChat.activeThread) GroupChat.renderThread();
    };
    if (GroupChat.ws && GroupChat.ws.readyState === 1) {
      const key = Number(id);
      GroupChat._settleDelete(key, null);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => GroupChat._settleDelete(key, null), GroupChat.DELETE_SETTLE_MS);
        GroupChat._pendingDeletes.set(key, { resolve, reject, restore, timer });
        GroupChat.ws.send(JSON.stringify({ type: 'delete', id: key }));
      });
    }
    let res;
    try {
      res = await fetch(`/api/apps/${encodeURIComponent(slug)}/messages/${Number(id)}`, {
        method: 'DELETE', credentials: 'same-origin', headers: { Accept: 'application/json' },
      });
    } catch (err) {
      restore();
      throw err;
    }
    if (!res.ok) {
      restore();
      throw new Error(`Delete failed (${res.status})`);
    }
  },

  // Settle a socket delete this client is waiting on: `err` null confirms
  // it, an Error puts the message back and rejects. An id nobody is waiting
  // on is ignored.
  _settleDelete(id, err) {
    const key = Number(id);
    const pending = GroupChat._pendingDeletes.get(key);
    if (!pending) return;
    GroupChat._pendingDeletes.delete(key);
    clearTimeout(pending.timer);
    if (!err) { pending.resolve(); return; }
    pending.restore();
    pending.reject(err);
  },

  _applyDelete(data) {
    const id = Number(data && (data.id ?? data.messageId ?? data.message_id));
    if (!id) return;
    GroupChat._eachCopy(id, (m) => {
      m.deleted = true;
      m.content = '';
      m.reactions = [];
      const meta = { ...(m.metadata || m.meta || {}) };
      delete meta.attachments;
      delete meta.quote;
      m.metadata = meta;
    });
    GroupChat._react()?.patchTranscriptMessage(id, {
      deleted: true, text: '', bodyHtml: '', quote: null, attachments: [], reactions: [], editedTitle: null,
    });
  },

  // A thread's new summary on its first message (the `thread_summary` frame).
  _applyThreadSummary(data) {
    const id = Number(data && (data.root_id ?? data.rootId));
    if (!id) return;
    GroupChat._eachCopy(id, (m) => { m.thread = data.thread || null; });
    GroupChat._react()?.patchTranscriptMessage(id, { thread: GroupChat._threadSummaryView({ thread: data.thread }) });
  },

  // The viewer's read cursor on this app's channel (#2387). Read up to the
  // newest general message while the channel is on screen; "Mark unread"
  // moves it back. Both answer with the channel's unread count, which the
  // Messages list re-reads.
  async markRead() {
    const slug = GroupChat.appSlug;
    if (!slug || !window.App || !App.user) return;
    // Read means SEEN: the socket also connects for an app whose chat is not
    // on screen, and loading its history there must not clear the channel.
    if (document.visibilityState === 'hidden' || !document.getElementById('gc-messages')) return;
    // The general stream's own newest message: its thread replies drawn in
    // it (#2387 follow-up) are no position for the channel's read cursor.
    const newest = GroupChat.messages.reduce((top, m) => (
      m && !m.thread_type && !(m.thread && m.thread.type) ? Math.max(top, Number(m.id) || 0) : top
    ), 0);
    if (!newest || newest <= (GroupChat._readUpTo || 0) || GroupChat._unreadHold === slug) return;
    GroupChat._readUpTo = newest;
    try {
      // `?demo=1`: a staging demo stream's newest rows are mock ones, which
      // only the demo branch of the route knows (src/routes/chat.js).
      await fetch(`/api/apps/${encodeURIComponent(slug)}/messages/read${GroupChat._specDemoQS()}`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ message_id: newest }),
      });
      window.UsernodeReact?.messages?.refresh?.();
    } catch (_) { /* the next open reads it again */ }
  },

  // The channel's pane closed (#2387). "Mark unread" holds only while the
  // channel stays open: the socket outlives the pane, so without this the
  // hold lasted until another app's chat was opened, and the channel was
  // never read again before then.
  releaseUnreadHold(appSlug) {
    if (GroupChat._unreadHold && GroupChat._unreadHold === appSlug) GroupChat._unreadHold = null;
  },

  async markUnread(id) {
    const slug = GroupChat.appSlug;
    if (!slug || !id) return;
    const res = await fetch(`/api/apps/${encodeURIComponent(slug)}/messages/unread${GroupChat._specDemoQS()}`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ message_id: Number(id) }),
    });
    if (!res.ok) throw new Error(`Mark unread failed (${res.status})`);
    // Stays unread while it is still the open channel: reading it again the
    // moment it was marked would undo the act.
    GroupChat._unreadHold = slug;
    GroupChat._readUpTo = 0;
    window.UsernodeReact?.messages?.refresh?.();
  },

  _paintBookmark(messageId, on) {
    const gc = (typeof window !== 'undefined' && window.UsernodeReact)
      ? window.UsernodeReact.groupChat : null;
    if (gc && gc.patchTranscriptMessage) gc.patchTranscriptMessage(messageId, { bookmarked: !!on });
  },

  // Apply a fresh reaction aggregate (from the WS 'reaction' broadcast or
  // history) to a message — update state + patch just its pill row. The
  // message may live in the general stream or any cached thread (#194).
  // B9: the chip a request's message wears, from its metadata: reading,
  // building, ready (with the change to try), live. Null for none.
  _botRequestView(value) {
    if (!value || typeof value !== 'object') return null;
    const status = ['reading', 'building', 'ready', 'live'].includes(value.status) ? value.status : null;
    if (!status) return null;
    return {
      status,
      issueNumber: Number(value.issueNumber) || null,
      sessionId: Number(value.sessionId) || null,
    };
  },

  // B9: one row's chat-request fields again, after a frame moved them.
  _repaintBotRequest(messageId) {
    const msg = GroupChat.messages.find((m) => String(m.id) === String(messageId));
    if (!msg) return;
    const view = GroupChat._messageView(msg);
    GroupChat._react()?.patchTranscriptMessage(Number(messageId), {
      botRequest: view.botRequest, botCard: view.botCard, canAskBot: view.canAskBot,
    });
  },

  // B9: the room said a request's status moved (`bot_request_status`).
  _applyBotRequestStatus(frame) {
    const msg = GroupChat.messages.find((m) => String(m.id) === String(frame.messageId));
    if (!msg) return;
    const meta = { ...(msg.metadata || msg.meta || {}) };
    if (frame.botRequest) meta.botRequest = frame.botRequest;
    else delete meta.botRequest;
    msg.metadata = meta;
    GroupChat._repaintBotRequest(frame.messageId);
  },

  // B9: the viewer's own card under one of their messages, pushed to their
  // sockets (`bot_request_card`) or answered by a request of theirs.
  applyBotRequestCard(frame) {
    const card = frame && frame.card;
    if (!card || !card.messageId) return;
    if (frame.appSlug && frame.appSlug !== GroupChat.appSlug) return;
    GroupChat._botCards.set(Number(card.messageId), card);
    GroupChat._repaintBotRequest(card.messageId);
  },

  // B9: read the viewer's cards again (after a load), and whether the bot
  // answers them here. Theirs alone, from their own requests.
  async _loadBotCards() {
    const slug = GroupChat.appSlug;
    if (!slug || !(window.App && App.user)) return;
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(slug)}/my-bot-requests`);
      if (!res.ok || GroupChat.appSlug !== slug) return;
      const data = await res.json();
      GroupChat._botHere = !!data.bot;
      GroupChat._botCards = new Map((Array.isArray(data.cards) ? data.cards : [])
        .filter((card) => card && card.messageId).map((card) => [Number(card.messageId), card]));
      GroupChat.render();
    } catch { /* offline: the cards come back on the next load */ }
  },

  // B9: "Make this a request", or File it under the card that asked first.
  async makeBotRequest(messageId) {
    const slug = GroupChat.appSlug;
    if (!slug || !messageId) return;
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(slug)}/messages/${Number(messageId)}/request`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      const data = await res.json().catch(() => ({}));
      if (data && data.card) GroupChat.applyBotRequestCard({ appSlug: slug, card: data.card });
      else if (!res.ok && window.PlatformUI) PlatformUI.toast(data.error || 'Couldn’t ask Homeroom bot just now.');
    } catch {
      if (window.PlatformUI) PlatformUI.toast('Couldn’t ask Homeroom bot just now.');
    }
  },

  // B9: Not now, under the card that asked first. The card goes for good.
  async dismissBotRequest(messageId) {
    const slug = GroupChat.appSlug;
    if (!slug || !messageId) return;
    GroupChat._botCards.delete(Number(messageId));
    GroupChat._repaintBotRequest(messageId);
    try {
      await fetch(`/api/apps/${encodeURIComponent(slug)}/messages/${Number(messageId)}/request`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dismiss: true }),
      });
    } catch { /* it comes back on the next load, and can be dismissed again */ }
  },

  // B9: the chat with Homeroom bot (See progress, Open chat).
  openBotChat() {
    const messages = window.UsernodeReact && window.UsernodeReact.messages;
    if (messages && typeof messages.openBot === 'function') messages.openBot();
    else location.hash = '#messages';
  },

  // B9: a request asked here, on its request page (See request).
  openBotRequest(issueNumber) {
    const n = Number(issueNumber);
    if (!GroupChat.appSlug || !n) return;
    location.hash = `#app/${encodeURIComponent(GroupChat.appSlug)}/dev/issues/${n}`;
  },

  // B9: Try it, on a request's message once its change is ready: its preview.
  tryBotChange(sessionId) {
    const id = Number(sessionId);
    if (!id) return;
    if (typeof AppView !== 'undefined' && typeof AppView.swapToStagingForSession === 'function') {
      AppView.swapToStagingForSession(id, '');
      return;
    }
    if (GroupChat.appSlug) location.hash = `#app/${encodeURIComponent(GroupChat.appSlug)}/dev/proposals/${id}`;
  },

  _updateMessageReactions(messageId, reactions) {
    let msg = GroupChat.messages.find((m) => String(m.id) === String(messageId));
    if (!msg) {
      for (const st of GroupChat.threads.values()) {
        msg = st.messages.find((m) => String(m.id) === String(messageId));
        if (msg) break;
      }
    }
    if (msg) msg.reactions = reactions || [];
    // A field update, not a targeted innerHTML write into a row React owns.
    const me = App.user && App.user.username;
    GroupChat._react()?.patchTranscriptMessage(Number(messageId), {
      reactions: ((msg && msg.reactions) || reactions || []).map((r) => {
        const users = Array.isArray(r.users) ? r.users : [];
        return { emoji: r.emoji, count: r.count, users, mine: !!(me && users.includes(me)) };
      }),
    });
  },

  // Toggle an emoji on a message for the current user (server decides
  // add-vs-remove). Fire-and-forget over the chat socket; the authoritative
  // aggregate comes back via the 'reaction' broadcast.
  sendReact(messageId, emoji) {
    if (GroupChat._readOnly()) return;
    if (!messageId || !emoji) return;
    if (GroupChat.ws && GroupChat.ws.readyState === 1) {
      GroupChat.ws.send(JSON.stringify({ type: 'react', messageId, emoji }));
    }
    GroupChat._closeReactionBar();
  },

  // ── message editing ─────────────────────────────────────────────────

  // Auto-grow a composer / inline-editor <textarea>: reset to one row then
  // expand to fit its content, capped at MAX so it scrolls internally
  // instead of taking over the screen. Idempotent — safe to call on every
  // input event, draft restore, and after a send (value='' shrinks back).
  _COMPOSER_MAX_PX: 140, // ~5–6 lines before it scrolls
  _autoGrowTextarea(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, GroupChat._COMPOSER_MAX_PX)}px`;
  },

  // Touch devices have no Shift+Enter chord, so Enter inserts a newline and
  // the Send button is the send action (composer) / Save button (editor).
  _isTouch() {
    return !!(window.matchMedia && window.matchMedia('(hover: none)').matches);
  },

  // When a message was posted, in the two forms a row needs (#1808).
  //
  // The transcript used to stamp the time of day alone, so a row read
  // "02:41 PM" whether it landed ten minutes ago or in March, and scrolling
  // a discussion back answered everything except when. The date is added
  // once it stops being today's, and the year once it stops being this
  // one — spending words only where they carry information, because a date
  // repeated down every row is noise the eye learns to skip.
  //
  //   today             02:41 PM
  //   earlier this year Jun 16, 02:41 PM
  //   an earlier year   Jun 16, 2025, 02:41 PM
  //
  // `title` never elides, so an abbreviated row is one hover from certain.
  //
  // frontend/src/lib/timestamp.ts carries the same table for the React
  // surfaces; this file is a legacy IIFE outside that bundle and cannot
  // import it. tests/message-timestamp.test.js pins the two together.
  _stamp(ts, now) {
    // An optimistic row reaches here before the server has stamped it, and
    // neither "Invalid Date" nor a 1970 date belongs in front of a reader —
    // `new Date(null)` is the epoch rather than an invalid date, so the
    // nullish case is turned away before parsing.
    const d = new Date(ts == null ? NaN : ts);
    if (isNaN(d.getTime())) return { text: '', title: '' };
    const today = now || new Date();
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const title = d.toLocaleString([], {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
    const sameDay = d.getFullYear() === today.getFullYear()
      && d.getMonth() === today.getMonth()
      && d.getDate() === today.getDate();
    if (sameDay) return { text: time, title };
    const date = d.toLocaleDateString([], d.getFullYear() === today.getFullYear()
      ? { month: 'short', day: 'numeric' }
      : { year: 'numeric', month: 'short', day: 'numeric' });
    return { text: `${date}, ${time}`, title };
  },

  // Full-precision timestamp for the "edited" marker's tooltip, e.g.
  // "edited Jun 16, 2026, 02:41 PM".
  _editedTitle(ts) {
    const { title } = GroupChat._stamp(ts);
    return title ? `edited ${title}` : 'edited';
  },

  // `_renderEditBtn` lived here — the desktop hover pencil for your own
  // message, hidden on touch via CSS because the long-press bar carries Edit
  // there. It is transcript.tsx's `RowActions` now, gated by the same
  // `showEdit` (#621: no edits read-only).

  // Locate a message (and its containing thread state, if any) by id across
  // the general stream and every cached thread.
  _findMessage(id) {
    let msg = GroupChat.messages.find((m) => String(m.id) === String(id));
    if (msg) return msg;
    for (const st of GroupChat.threads.values()) {
      msg = st.messages.find((m) => String(m.id) === String(id));
      if (msg) return msg;
    }
    return null;
  },

  // Find the rendered row for a message in whichever list it's shown in.
  _findRow(id) {
    return document.querySelector(
      `#gc-messages .gc-msg[data-msg-id="${id}"], #gc-thread-messages .gc-msg[data-msg-id="${id}"]`
    );
  },

  // Send an edit over the WS (fire-and-forget; the authoritative update
  // arrives via the 'chat_edit' broadcast — mirrors sendReact). Returns
  // false when the socket isn't open so the caller can keep the editor up.
  // Edits are deliberately NOT queued like sends: a stale edit replayed
  // after a reconnect is more surprising than a no-op.
  sendEdit(messageId, content) {
    if (!(GroupChat.ws && GroupChat.ws.readyState === 1)) return false;
    GroupChat.ws.send(JSON.stringify({ type: 'edit', messageId, content }));
    return true;
  },

  // Turn a message row into an inline editor pre-filled with its raw
  // content. No-op for rows already being edited (just refocus).
  _startEdit(id) {
    const row = GroupChat._findRow(id);
    if (!row) return;
    if (row.dataset.editing === '1') {
      const ta = row.querySelector('.gc-edit-textarea');
      if (ta) ta.focus();
      return;
    }
    const msg = GroupChat._findMessage(id);
    const contentEl = row.querySelector('.gc-msg-content');
    if (!msg || !contentEl) return;

    const editor = document.createElement('div');
    editor.className = 'gc-edit';
    editor.innerHTML =
      `<textarea class="gc-edit-textarea gc-composer-input" maxlength="${GC_MAX_MESSAGE_LEN}" rows="1"></textarea>` +
      `<div class="gc-edit-actions">` +
        `<button type="button" class="gc-edit-save">Save</button>` +
        `<button type="button" class="gc-edit-cancel">Cancel</button>` +
        `<span class="gc-edit-notice" hidden></span>` +
      `</div>`;
    const ta = editor.querySelector('.gc-edit-textarea');
    ta.value = msg.content || '';
    contentEl.style.display = 'none';
    contentEl.insertAdjacentElement('afterend', editor);
    row.dataset.editing = '1';

    GroupChat._autoGrowTextarea(ta);
    ta.focus();
    try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch {}

    ta.addEventListener('input', () => GroupChat._autoGrowTextarea(ta));
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); GroupChat._cancelEdit(row); return; }
      // Enter saves, Shift+Enter adds a newline (touch: newline only — Save
      // button saves).
      if (e.key === 'Enter' && !e.shiftKey && !GroupChat._isTouch()) {
        e.preventDefault();
        GroupChat._saveEdit(id, row, ta);
      }
    });
    editor.querySelector('.gc-edit-save').addEventListener('click', () => GroupChat._saveEdit(id, row, ta));
    editor.querySelector('.gc-edit-cancel').addEventListener('click', () => GroupChat._cancelEdit(row));
  },

  // Tear down the inline editor and restore the (possibly already-patched)
  // content node.
  _cancelEdit(row) {
    if (!row || row.dataset.editing !== '1') return;
    const editor = row.querySelector('.gc-edit');
    if (editor) editor.remove();
    const contentEl = row.querySelector('.gc-msg-content');
    if (contentEl) contentEl.style.display = '';
    delete row.dataset.editing;
  },

  // Commit an inline edit. Empty content cancels (editing is not a delete
  // path). If the socket is down, surface a notice and keep the editor open
  // rather than dropping or queueing the edit.
  _saveEdit(id, row, ta) {
    const content = ta.value.trim();
    if (!content) { GroupChat._cancelEdit(row); return; }
    if (!GroupChat.sendEdit(id, content)) {
      const notice = row.querySelector('.gc-edit-notice');
      if (notice) {
        notice.hidden = false;
        notice.textContent = 'Not connected. Your edit wasn’t sent, so try again in a moment.';
      }
      return;
    }
    // Optimistically paint the new content so there's no flash; the
    // authoritative content + "edited" marker arrive via the broadcast.
    GroupChat._patchBody(id, content);
    GroupChat._cancelEdit(row);
  },

  // Apply an incoming 'chat_edit' broadcast: update cached state and patch
  // the row in place (content + "edited" marker) without re-rendering the
  // list, so scroll position and reaction pills are preserved.
  _applyEdit(data) {
    const { messageId, content, editedAt } = data || {};
    if (messageId == null) return;
    const msg = GroupChat._findMessage(messageId);
    if (msg) { msg.content = content; msg.editedAt = editedAt; }
    const row = GroupChat._findRow(messageId);
    if (!row) return;
    // If the author had this open in an editor, close it — the broadcast is
    // authoritative.
    GroupChat._cancelEdit(row);
    GroupChat._patchBody(messageId, content, editedAt);
  },

  // Patch a message's rendered body — and, when an edit produced it, the
  // "edited" marker — through the transcript store.
  //
  // This replaces three DOM writes that all landed inside #gc-messages, which
  // features/group-chat/transcript.tsx owns: two `contentEl.innerHTML`
  // assignments and an `insertAdjacentHTML` that spliced the marker in after
  // the timestamp. The last of those has no equivalent here BECAUSE it needs
  // none — `editedTitle` is a field on the message, and the component renders
  // the marker from it.
  //
  // Writing the DOM was not merely redundant. `Body` memoises its
  // `{__html}` wrapper on the string, so React leaves the node alone while
  // the model says the old content — and repaints the row from that stale
  // model the next time anything else about it changes. An edit followed by
  // a reaction reverted the text on screen.
  _patchBody(messageId, content, editedAt) {
    const gc = (typeof window !== 'undefined' && window.UsernodeReact)
      ? window.UsernodeReact.groupChat : null;
    if (!gc || !gc.patchTranscriptMessage) return;
    const patch = { bodyHtml: renderMessageBody(content) };
    if (editedAt) patch.editedTitle = GroupChat._editedTitle(editedAt);
    gc.patchTranscriptMessage(messageId, patch);
  },

  // ── #25: reaction bar (WhatsApp-style quick row + curated grid) ──────

  _ensureReactionBar() {
    if (GroupChat._reactBar) return GroupChat._reactBar;
    const bar = document.createElement('div');
    bar.id = 'gc-react-bar';
    bar.className = 'gc-react-bar hidden';
    bar.addEventListener('click', (e) => {
      const em = e.target.closest('.gc-react-bar-emoji');
      if (em) { GroupChat._reactFromBar(em.dataset.emoji); return; }
      if (e.target.closest('.gc-react-bar-edit')) {
        const id = parseInt(bar.dataset.msgId || '', 10);
        GroupChat._closeReactionBar();
        if (id) GroupChat._startEdit(id);
        return;
      }
      if (e.target.closest('.gc-react-bar-report')) {
        const id = parseInt(bar.dataset.msgId || '', 10);
        GroupChat._closeReactionBar();
        if (id) window.UsernodeReact?.dialogs?.report?.open({ targetType: 'app_message', target: id, label: 'Selected message' });
        return;
      }
      if (e.target.closest('.gc-react-bar-more')) {
        GroupChat._reactBarGridOpen = !GroupChat._reactBarGridOpen;
        GroupChat._publishReactBar();
      }
    });
    document.body.appendChild(bar);
    // The HOST stays ours — position:fixed, appended to the body, pointed at a
    // row and placed by measurement on every open — and its CHILDREN are
    // features/group-chat/reaction-bar.tsx's, mounted once here. The emoji sets
    // ride along as props because they never change.
    window.UsernodeReact?.groupChat?.mountReactionBar?.(bar, {
      quick: GroupChat.QUICK_REACTIONS,
      grid: GroupChat.GRID_REACTIONS,
    });
    GroupChat._reactBar = bar;
    return bar;
  },

  _publishReactBar() {
    window.UsernodeReact?.groupChat?.publishReactionBar?.({
      gridOpen: !!GroupChat._reactBarGridOpen,
      editable: !!GroupChat._reactBarEditable,
      reportable: !!GroupChat._reactBarReportable,
      readOnly: GroupChat._readOnly(),
    });
  },

  _openReactionBar(row) {
    if (!App.user) return;
    const id = row && parseInt(row.dataset.msgId || '', 10);
    if (!id) return;
    const bar = GroupChat._ensureReactionBar();
    bar.dataset.msgId = String(id);
    // Every open starts collapsed, and Edit is offered only on the viewer's
    // own ordinary messages. Publishing goes through flushSync
    // (features/group-chat/mount.ts), so the pencil is in or out of the DOM
    // before the measurement below decides where the bar fits.
    GroupChat._reactBarGridOpen = false;
    GroupChat._reactBarReportable = row.classList.contains('gc-msg') && !row.classList.contains('gc-msg-self');
    GroupChat._reactBarEditable = !GroupChat._readOnly() && row.classList.contains('gc-msg')
      && row.classList.contains('gc-msg-self');
    GroupChat._publishReactBar();
    bar.classList.remove('hidden');
    GroupChat._reactBarOpenedAt = Date.now();

    // Position above the row (fall back to below if it would clip the top).
    const r = row.getBoundingClientRect();
    const bw = bar.offsetWidth || 280;
    const bh = bar.offsetHeight || 44;
    const left = Math.min(Math.max(8, r.left), window.innerWidth - bw - 8);
    let top = r.top - bh - 6;
    if (top < 8) top = Math.min(r.bottom + 6, window.innerHeight - bh - 8);
    bar.style.left = `${left}px`;
    bar.style.top = `${top}px`;

    if (!GroupChat._reactBarDismiss) {
      GroupChat._reactBarDismiss = (ev) => {
        if (ev.type === 'keydown') { if (ev.key === 'Escape') GroupChat._closeReactionBar(); return; }
        if (ev.type === 'click') {
          // Ignore the click that opened the bar (long-press release or the
          // hover button's own click).
          if (Date.now() - (GroupChat._reactBarOpenedAt || 0) < 350) return;
          if (GroupChat._reactBar && GroupChat._reactBar.contains(ev.target)) return;
          GroupChat._closeReactionBar();
          return;
        }
        GroupChat._closeReactionBar(); // scroll
      };
    }
    setTimeout(() => {
      document.addEventListener('click', GroupChat._reactBarDismiss, true);
      document.addEventListener('keydown', GroupChat._reactBarDismiss, true);
      // #363: dismiss on scroll of whichever stream is mounted — the general
      // chat (#gc-messages) or a topic thread's unified scroller
      // (#gc-thread-scroll).
      const msgs = document.getElementById('gc-messages');
      if (msgs) msgs.addEventListener('scroll', GroupChat._reactBarDismiss, true);
      const tscroll = document.getElementById('gc-thread-scroll');
      if (tscroll) tscroll.addEventListener('scroll', GroupChat._reactBarDismiss, true);
    }, 0);
  },

  _closeReactionBar() {
    const bar = GroupChat._reactBar;
    if (bar) { bar.classList.add('hidden'); bar.removeAttribute('data-msg-id'); }
    if (GroupChat._reactBarDismiss) {
      document.removeEventListener('click', GroupChat._reactBarDismiss, true);
      document.removeEventListener('keydown', GroupChat._reactBarDismiss, true);
      const msgs = document.getElementById('gc-messages');
      if (msgs) msgs.removeEventListener('scroll', GroupChat._reactBarDismiss, true);
      const tscroll = document.getElementById('gc-thread-scroll');
      if (tscroll) tscroll.removeEventListener('scroll', GroupChat._reactBarDismiss, true);
    }
  },

  _reactFromBar(emoji) {
    const bar = GroupChat._reactBar;
    const id = bar && parseInt(bar.dataset.msgId || '', 10);
    if (id && emoji) GroupChat.sendReact(id, emoji);
    GroupChat._closeReactionBar();
  },

  // ── per-message unread dot ──────────────────────────────────────────

  // `_unreadDotHtml` lived here. The dot is `unread` on the row's view model
  // now (features/group-chat/transcript.tsx renders it beside the name), and
  // both paths below patch that field instead of adding and removing a span.
  // Driven by the server's has_unread_notification flag on loaded history;
  // live messages never carry it (a brand-new message can't yet have a
  // notification for you).

  // Clear the dot for one message (the "click a dotted message" path):
  // optimistically drop it locally, then confirm read on the server by
  // chat_message_id. Other tabs reconcile via the notifications_changed
  // broadcast the server fans out. No-op if the message has no dot.
  _clearMessageDot(messageId) {
    const msg = GroupChat.messages.find((m) => String(m.id) === String(messageId));
    if (!msg || !msg.has_unread_notification) return;
    msg.has_unread_notification = false;
    GroupChat._react()?.patchTranscriptMessage(Number(messageId), { unread: false });
    fetch('/api/notifications/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_message_id: Number(messageId) }),
    }).then((res) => {
      // Only sync the bell badge once the backend confirms — never
      // optimistically. The dot is already gone locally above.
      if (res.ok) window.Notifications?.refresh?.();
    }).catch(() => {});
  },

  // Reconcile dots from the current notifications list (window.Notifications
  // .items). Called on notification_new (a mention arrived while viewing)
  // and notifications_changed (something was cleared — e.g. this user sent
  // a message and the reply-clears-all fired, or another tab cleared one).
  // Operates only over messages the list actually references, so older
  // dotted messages outside the capped list aren't wrongly touched: a
  // referenced message's dot becomes (readAt == null).
  reconcileDotsFromNotifications() {
    const items = (window.Notifications && Notifications.items) || [];
    if (!Array.isArray(items)) return;
    const KINDS = new Set(['mention', 'reply', 'reaction']);
    const state = new Map(); // chatMessageId -> isUnread
    for (const n of items) {
      if (!n || !KINDS.has(n.kind) || n.chatMessageId == null) continue;
      // A later (newer) item wins; items are newest-first, so only set if
      // not already seen.
      if (!state.has(n.chatMessageId)) state.set(n.chatMessageId, !n.readAt);
    }
    for (const msg of GroupChat.messages) {
      if (!state.has(msg.id)) continue;
      const unread = state.get(msg.id);
      if (!!msg.has_unread_notification === unread) continue;
      msg.has_unread_notification = unread;
      // A field update on whichever transcripts hold the message, not an
      // insertAdjacentHTML into a row React renders.
      GroupChat._react()?.patchTranscriptMessage(Number(msg.id), { unread });
    }
  },

  // ── #694: file attachments ──────────────────────────────────────────
  //
  // Upload-before-send, ported from dev-chat (#450, public/js/dev-chat.js
  // _setupAttachments and friends): each picked/pasted/dropped file is
  // validated client-side (mirroring src/services/attachments.js
  // validateChatUpload), POSTed as raw octet-stream to
  // /api/apps/:slug/chat-attachments, and parked in `pendingAttachments`
  // (rendered as a strip above the composer, reusing the dc-attach-*
  // styles) until the message sends with the attachment ids on the WS
  // 'chat' payload. Entries are keyed by composer scope (general vs a
  // specific thread) so a tab switch never leaks uploads between
  // composers. Orphans left by removed or abandoned uploads are GC'd
  // server-side after 24h.
  pendingAttachments: [],
  _attachClickWired: false,

  // Mirrors the server caps closely enough for instant feedback on
  // obvious size problems; the server remains authoritative.
  ATTACH_LIMITS: {
    maxPerMessage: 4,
    maxImageBytes: 4 * 1024 * 1024,
    maxMarkdownBytes: 512 * 1024,
    maxHtmlBytes: 2 * 1024 * 1024,
    maxTextBytes: 200 * 1024,
    maxBinaryBytes: 10 * 1024 * 1024,
    imageExts: ['png', 'jpg', 'jpeg', 'gif', 'webp'],
  },

  _attachSlug() {
    return GroupChat._appSlug()
      || GroupChat.appSlug || null;
  },

  // Composer scope key: pending uploads belong to the composer they were
  // added in (`<slug>|general` or `<slug>|<type>:<ref>`).
  _attachScopeKey(thread) {
    const slug = GroupChat._attachSlug() || '';
    return thread && thread.type ? `${slug}|${thread.type}:${thread.ref}` : `${slug}|general`;
  },

  _pendingFor(thread) {
    const key = GroupChat._attachScopeKey(thread);
    return GroupChat.pendingAttachments.filter((a) => a.scope === key);
  },

  hasPendingAttachments(thread) {
    return GroupChat._pendingFor(thread).some((a) => a.id);
  },

  attachmentsUploading(thread) {
    return GroupChat._pendingFor(thread).some((a) => a.uploading);
  },

  // Remove and return this scope's uploaded entries — called by send().
  _takePendingAttachments(thread) {
    const key = GroupChat._attachScopeKey(thread);
    const taken = GroupChat.pendingAttachments.filter((a) => a.scope === key && a.id);
    if (!taken.length) return [];
    GroupChat.pendingAttachments = GroupChat.pendingAttachments.filter((a) => !taken.includes(a));
    for (const a of taken) {
      if (a.objectUrl) { try { URL.revokeObjectURL(a.objectUrl); } catch { /* already revoked */ } }
    }
    GroupChat._renderAttachStrip(thread);
    return taken;
  },

  // Wire the paperclip button, hidden file input, clipboard paste, and
  // drag-and-drop for one composer. `thread` null = the general composer
  // (ids gc-*), else the thread composer (ids gc-thread-*). Idempotent
  // per mount — both composers are fresh DOM on every (re)render.
  setupAttachments(thread) {
    const t = thread || null;
    const btn = document.getElementById(t ? 'gc-thread-attach-btn' : 'gc-attach-btn');
    const fileInput = document.getElementById(t ? 'gc-thread-file-input' : 'gc-file-input');
    if (!btn || !fileInput) return;

    // Pending uploads from other composer scopes are dropped (their
    // server rows fall to the 24h orphan sweep — harmless).
    const key = GroupChat._attachScopeKey(t);
    GroupChat.pendingAttachments = GroupChat.pendingAttachments.filter((a) => a.scope === key);
    GroupChat._renderAttachStrip(t);

    btn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      if (fileInput.files?.length) GroupChat._addFiles(fileInput.files, t);
      fileInput.value = '';
    });

    // Paste an image straight from the clipboard (screenshots).
    const textarea = document.getElementById(t ? 'gc-thread-input' : 'gc-input');
    if (textarea) {
      textarea.addEventListener('paste', (e) => {
        const items = e.clipboardData?.items || [];
        const files = [];
        for (const item of items) {
          if (item.kind === 'file') {
            const f = item.getAsFile();
            if (f) {
              // Clipboard images often arrive nameless — synthesize one.
              if (!f.name || f.name === 'image.png' || !/\./.test(f.name)) {
                const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
                const named = new File([f], `pasted-image-${Date.now() % 100000}.${ext}`, { type: f.type });
                files.push(named);
              } else {
                files.push(f);
              }
            }
          }
        }
        if (files.length) {
          e.preventDefault();
          GroupChat._addFiles(files, t);
        }
      });
    }

    // Drag-and-drop onto the message area or the composer.
    const dropEls = [
      document.getElementById(t ? 'gc-thread-form' : 'gc-form'),
      document.getElementById(t ? 'gc-thread-messages' : 'gc-messages'),
    ];
    for (const el of dropEls) {
      if (!el) continue;
      el.addEventListener('dragover', (e) => { e.preventDefault(); });
      el.addEventListener('drop', (e) => {
        if (e.dataTransfer?.files?.length) {
          e.preventDefault();
          GroupChat._addFiles(e.dataTransfer.files, t);
        }
      });
    }
  },

  // Mirror the server's classifier (src/services/attachments.js
  // validateChatUpload) closely enough for instant feedback; UTF-8
  // sniffing reads the bytes, cheap under the 10 MB cap.
  async _classifyChatFile(file) {
    const L = GroupChat.ATTACH_LIMITS;
    const ext = (file.name.toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
    if (L.imageExts.includes(ext)) {
      if (file.size > L.maxImageBytes) {
        return { error: `"${file.name}" is too big. Images max ${Math.round(L.maxImageBytes / 1024 / 1024)} MB.` };
      }
      return { kind: 'image' };
    }
    if (ext === 'md' || ext === 'markdown') {
      if (file.size > L.maxMarkdownBytes) {
        return { error: `"${file.name}" is too big. Markdown files max ${Math.round(L.maxMarkdownBytes / 1024)} KB.` };
      }
      return { kind: 'markdown' };
    }
    if (ext === 'html' || ext === 'htm') {
      if (file.size > L.maxHtmlBytes) {
        return { error: `"${file.name}" is too big. HTML files max ${Math.round(L.maxHtmlBytes / 1024 / 1024)} MB.` };
      }
      return { kind: 'html' };
    }
    if (file.size > L.maxBinaryBytes) {
      return { error: `"${file.name}" is too big. Files max ${Math.round(L.maxBinaryBytes / 1024 / 1024)} MB.` };
    }
    if (file.size <= L.maxTextBytes) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (!bytes.includes(0)) {
          new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          return { kind: 'text' };
        }
      } catch { /* non-UTF-8 → binary */ }
    }
    return { kind: 'binary' };
  },

  async _addFiles(fileList, thread) {
    if (GroupChat._readOnly()) return;
    const slug = GroupChat._attachSlug();
    if (!slug) return;
    GroupChat._setAttachError(null, thread);
    const key = GroupChat._attachScopeKey(thread);
    const L = GroupChat.ATTACH_LIMITS;
    for (const file of Array.from(fileList)) {
      if (GroupChat.pendingAttachments.filter((a) => a.scope === key).length >= L.maxPerMessage) {
        GroupChat._setAttachError(`Up to ${L.maxPerMessage} files per message.`, thread);
        break;
      }
      const classified = await GroupChat._classifyChatFile(file);
      if (classified.error) {
        GroupChat._setAttachError(classified.error, thread);
        continue;
      }
      const entry = {
        scope: key,
        // Stable identity for the strip's rows. `id` arrives only when the
        // upload finishes, and the filename is not unique — two shots pasted
        // in a row are both `pasted-image-<n>.png` only by luck.
        key: `p${(GroupChat._attachSeq += 1)}`,
        uploading: true,
        id: null,
        kind: classified.kind,
        filename: file.name,
        sizeBytes: file.size,
        meta: null,
        objectUrl: classified.kind === 'image' ? URL.createObjectURL(file) : null,
      };
      GroupChat.pendingAttachments.push(entry);
      GroupChat._renderAttachStrip(thread);
      try {
        const res = await fetch(`/api/apps/${slug}/chat-attachments?filename=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: file,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || `Upload failed (HTTP ${res.status})`);
        entry.id = data.id;
        entry.kind = data.kind;
        entry.meta = data.meta || null;
        entry.uploading = false;
        // #2938: a send tapped mid-upload left the wait notice up; once the
        // last upload in this composer lands there is nothing to wait for.
        if (!GroupChat.attachmentsUploading(thread)
            && GroupChat._attachErrors[GroupChat._composerScope(thread)] === GroupChat.UPLOAD_WAIT_NOTICE) {
          GroupChat._setAttachError(null, thread);
        }
      } catch (err) {
        GroupChat.pendingAttachments = GroupChat.pendingAttachments.filter((a) => a !== entry);
        if (entry.objectUrl) { try { URL.revokeObjectURL(entry.objectUrl); } catch { /* already revoked */ } }
        GroupChat._setAttachError(err.message || 'Upload failed', thread);
      }
      GroupChat._renderAttachStrip(thread);
    }
  },

  // The React bridge for one composer. Both are one renderer in
  // features/group-chat/composer.tsx, so every writer below names a SCOPE
  // ('general' | 'thread') where it used to pick an element id.
  _publishComposer(scope, patch) {
    GroupChat._react()?.publishComposer?.(scope, patch);
  },

  // The scope for a `thread` argument, which is how every attachment path
  // spells the same choice.
  _composerScope(thread) {
    return thread ? 'thread' : 'general';
  },

  _attachSeq: 0,

  // Remove by INDEX, because that is what a serialisable view model can carry:
  // the live entry holds a File and an object URL and never leaves this module.
  _removeAttachmentAt(index, scope) {
    const thread = scope === 'thread' ? GroupChat.activeThread : null;
    GroupChat._removeAttachment(GroupChat._pendingFor(thread)[index], thread);
  },

  _removeAttachment(entry, thread) {
    if (!entry || entry.uploading) return;
    GroupChat.pendingAttachments = GroupChat.pendingAttachments.filter((a) => a !== entry);
    if (entry.objectUrl) { try { URL.revokeObjectURL(entry.objectUrl); } catch { /* already revoked */ } }
    // Server row stays until the 24h orphan sweep — harmless.
    GroupChat._setAttachError(null, thread);
    GroupChat._renderAttachStrip(thread);
  },

  // The error line above the composer. Its `hidden` follows from the text now
  // — the component draws the row either way, so the module has one thing to
  // say rather than two to keep in step.
  _setAttachError(msg, thread) {
    const scope = GroupChat._composerScope(thread);
    GroupChat._attachErrors[scope] = msg || null;
    GroupChat._publishComposer(scope, { attachError: msg || null });
  },

  // What each composer's error line currently says, so an upload finishing
  // can take down the wait notice without erasing a real error (#2938).
  _attachErrors: { general: null, thread: null },

  // Shown when Send is tapped while an attachment is still uploading.
  UPLOAD_WAIT_NOTICE: 'Still uploading, one moment…',

  _humanAttSize(bytes) {
    const n = Number(bytes) || 0;
    if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    if (n >= 1024) return `${Math.round(n / 1024)} KB`;
    return `${n} B`;
  },

  // `_escAttr` lived here — an attribute-safe escape for filenames, because
  // `escapeHtml` (the div trick) mirrors browser TEXT-node escaping and
  // leaves `"` alone, which a crafted filename could break out of inside a
  // double-quoted attribute. React escapes text and attributes alike, and
  // both places that put a filename into markup are components now, so the
  // hazard and its guard go together.
  //
  // `_attachKindBadgeHtml` went with the composer strip it wrapped. The label
  // itself stays, because both strips read it.

  // Small kind badge for chips ("MD", "HTML", "BIN"). Null for image/text.
  _attachKindBadge(a) {
    if (a.kind === 'markdown') return 'MD';
    if (a.kind === 'html') return 'HTML';
    if (a.kind === 'binary') return 'BIN';
    return null;
  },

  _renderAttachStrip(thread) {
    GroupChat._publishComposer(GroupChat._composerScope(thread), {
      attachments: GroupChat._pendingFor(thread).map((a) => ({
        key: a.key || `p${a.id || a.filename}`,
        name: a.filename || 'file',
        kind: a.kind,
        badge: GroupChat._attachKindBadge(a),
        size: GroupChat._humanAttSize(a.sizeBytes),
        thumbUrl: a.objectUrl || null,
        uploading: !!a.uploading,
      })),
    });
  },

  // The files on a message, from the server-derived metadata.attachments
  // summary, as the view model features/group-chat/transcript.tsx draws.
  //
  // Resolved OUTSIDE the message body on purpose — the DOMPurify allowlist
  // strips <img> from untrusted markdown and must keep doing so; these
  // elements only ever point at the app-gated attachments routes, and the id
  // check below is what keeps them there. Per kind: image → inline thumbnail
  // linking to full size; markdown → chip opening the side panel (+
  // download); html → chip with sandboxed Preview (+ download); text/binary
  // → download chip.
  //
  // `_attachmentsRowHtml` lived here and built that as an HTML string. It had
  // NO CALLERS after the transcript conversion, which is why a message with
  // files was rendering an empty `[data-gc-attachments]` host and nothing
  // else — the same way the spec-share card went missing. `_escAttr` is not
  // needed on this path any more (React escapes both text and attributes);
  // the composer strip still uses it.
  //
  // `_attImgError` went with it. A thumbnail whose bytes are missing — a
  // staging clone copies chat_messages but not attachment blobs
  // (staging:private) — degraded by rewriting the anchor's className and
  // textContent in place, which is a write into a row React owns. The
  // component holds that as its own state instead.
  _attachmentsView(msg) {
    const meta = (msg && (msg.metadata || msg.meta)) || {};
    const atts = meta.attachments;
    if (!Array.isArray(atts) || !atts.length) return [];
    const slug = GroupChat._attachSlug();
    if (!slug) return [];
    GroupChat._ensureAttachClickHandler();
    return atts
      // A filename is user-controlled; an id must be exactly what the server
      // minted, or the URL it builds is not one of ours.
      .filter((a) => a && typeof a.id === 'string' && /^[a-f0-9]{32}$/.test(a.id))
      .map((a) => ({
        id: a.id,
        kind: a.kind,
        name: a.filename || 'file',
        url: `/api/apps/${encodeURIComponent(slug)}/chat-attachments/${a.id}`,
        size: GroupChat._humanAttSize(a.sizeBytes),
        badge: GroupChat._attachKindBadge(a),
      }));
  },

  // One document-level delegated handler for markdown-chip clicks —
  // message rows are re-rendered wholesale, so per-row listeners would
  // be lost. Capture-phase + stopPropagation keeps the tap-to-quote
  // handler from also firing on the same click.
  _ensureAttachClickHandler() {
    if (GroupChat._attachClickWired || typeof document === 'undefined') return;
    GroupChat._attachClickWired = true;
    document.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('[data-att-md]') : null;
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      GroupChat._openMarkdownAttachment(
        btn.getAttribute('data-att-md'),
        btn.getAttribute('data-att-name') || 'file.md'
      );
    }, true);
  },

  // Fetch a markdown attachment (served text/plain) and render it in the
  // spec side panel (same panel as "View full spec"). Falls back to a
  // plain download when the panel slot isn't in the current tab's DOM.
  async _openMarkdownAttachment(url, filename) {
    if (!url) return;
    if (!document.getElementById('gc-spec-side-panel')) {
      window.open(url, '_blank', 'noopener');
      return;
    }
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Couldn't load ${filename} (HTTP ${res.status})`);
      const text = await res.text();
      GroupChat._showSpecPanel({ title: filename, content: text });
    } catch (err) {
      GroupChat._showSpecPanel({ title: filename, content: err.message || 'Failed to load file', isError: true });
    }
  },

  // `renderMessageHtml` lived here: one HTML string per row, dispatching on
  // msgType to a spec-share card, a system/vote line or an ordinary message.
  // The transcript conversion replaced it with `_messageView` +
  // features/group-chat/transcript.tsx and left it with NO CALLERS — which is
  // how the spec-share card came to render as an empty `[data-gc-spec-share]`
  // host that nothing filled. Its last live branch is `_specShareView` below;
  // the rest was already duplicated by the view builder, so keeping a second
  // copy of it would only be a second thing to keep in step.

  // `_voteControlsHtml` lived here — the `.gc-vote-inline` wrapper plus its
  // first fill, as one string. The wrapper is transcript.tsx's now (it is a
  // vote row's markup, and the row is React's); the FILL is still
  // `refreshVoteControls` below, because it comes from AppView's vote
  // renderers and arrives on the vote panel's schedule.
  //
  // Retiring it left the host with the wrong attribute for a while:
  // `[data-gc-vote-controls]` is not `[data-vote-controls]`, the selector
  // below matched nothing, and every vote row rendered an empty span where
  // its Yes/No pair and tally pill belonged.

  // [sessionId, prNumber] ref for a vote-activity row: the precise metadata
  // session id (new server) when present, plus the "PR #N" parsed from the
  // row text (works for older rows that predate the metadata tag).
  _voteRef(msg) {
    const meta = (msg.metadata || msg.meta || {}).vote;
    const sid = meta && meta.sessionId != null ? String(meta.sessionId) : '';
    const m = /PR #(\d+)/.exec(msg.content || '');
    return [sid, m ? m[1] : ''];
  },

  // Resolve a (sessionId, prNumber) ref to the live PR in AppView.voteState,
  // or null when it isn't currently votable ('merging'/merged/closed → no
  // longer in the promoted set, mirroring the vote panel). Prefers the
  // session id; falls back to PR number, then to treating the parsed number
  // as a session id (the label uses pr_number || session.id when no PR
  // number exists yet).
  _resolvePr(sid, prNum) {
    const st = (typeof AppView !== 'undefined' && AppView.voteState) || null;
    if (!st) return null;
    let pr = sid ? (st.bySession && st.bySession[sid]) : null;
    if (!pr && prNum) pr = (st.byPrNumber && st.byPrNumber[prNum]) || (st.bySession && st.bySession[prNum]);
    // 'merging' AND 'merged' rows stay resolvable so the tally pill + "You
    // voted X" don't vanish during or after a merge — a "Merging…"/"Merged"
    // badge is appended alongside instead.
    if (pr && (pr.status === 'promoted' || pr.status === 'merging' || pr.status === 'merged')) return pr;
    // Streamlined Concept: a SETTLED vote row keeps its "✓ Merged" chip even
    // after the PR leaves the votable set — the Figma Activity stream shows
    // history as history. Recently-merged rows are already in hand
    // (AppView._merged), so resolve against them and mark the result settled:
    // _voteInnerHtml renders the badge alone for these (no live tally left).
    if (prNum && Array.isArray(typeof AppView !== 'undefined' && AppView._merged)) {
      const merged = AppView._merged.find((m) => m
        && (String(m.pr_number) === String(prNum) || (sid && String(m.session_id || m.id) === String(sid))));
      // `id` rides along so a merged proposal's event row can link to its
      // page (_eventHref) even when the row predates the metadata tag.
      if (merged) {
        return { status: 'merged', pr_number: merged.pr_number, id: merged.session_id || merged.id, _settled: true };
      }
    }
    return null;
  },

  // Inner HTML for a resolved votable PR: the live "yes / majority" count
  // followed by the vote buttons. Empty when the PR isn't votable, so the
  // wrapper collapses and the row falls back to a plain activity line.
  _voteInnerHtml(pr) {
    if (!pr || typeof AppView.voteButtonsHtml !== 'function') return '';
    // A settled historical row (see _resolvePr): the persistent "✓ Merged"
    // chip alone — there is no live tally or castable vote left to draw.
    if (pr._settled) return AppView.mergedBadgeHtml();
    const st = (typeof AppView !== 'undefined' && AppView.voteState) || {};
    // collapseVoted: in the chat, a cast vote collapses to a "You voted X"
    // box (the drawer keeps the full set so it stays re-castable there).
    // A "Merging…"/"Merged" badge is appended (not substituted) once the PR
    // crosses the threshold, so the pill + "You voted X" survive the merge.
    let badge = '';
    if (pr.status === 'merging') badge = AppView.mergingBadgeHtml();
    else if (pr.status === 'merged') badge = AppView.mergedBadgeHtml();
    return AppView.voteCountPill(pr, st.majority) + AppView.voteButtonsHtml(pr, { collapseVoted: true }) + badge;
  },

  // Row text-color class from the viewer's vote status: faded once voted,
  // full-strength while their vote is outstanding. '' for non-votable rows
  // (keeps the default --accent vote-line color).
  _rowVoteClass(pr) {
    if (!pr) return '';
    return pr.my_vote === 'yes' || pr.my_vote === 'no' ? 'gc-vote-voted' : 'gc-vote-unvoted';
  },

  // Whether a vote row still asks something of the reader, which the general
  // chat's event row marks (features/group-chat/proposal-event.tsx):
  //   'open'    — the PR is promoted and votable;
  //   'settled' — merged, merging, or gone from the votable set (withdrawn /
  //               closed / long merged: a plain activity line by now);
  //   'unknown' — AppView.voteState has not arrived yet. The transcript
  //               treats it as open: a mark that fades a moment later is
  //               fine, a live vote shown as over is not.
  // `pr` is what _resolvePr returned for the row, or null.
  _votePhase(pr) {
    const st = (typeof AppView !== 'undefined' && AppView.voteState) || null;
    if (!st) return 'unknown';
    return pr && !pr._settled && pr.status === 'promoted' ? 'open' : 'settled';
  },

  // ── The general chat's proposal events ───────────────────────────
  //
  // The general chat draws only two of the notices that land in it: a
  // proposal put up for a vote, and a proposal merged. Each is drawn as a
  // message from whoever did it (features/group-chat/proposal-event.tsx).
  // WHICH rows those are is decided here, from the row's kind and its
  // wording, because this module already owns that vocabulary (_voteRef
  // parses the same "PR #N"). Everything else — a request closing, a check
  // verdict, main's suite going red, a visibility change — stays in the
  // transcript's data and in the topic thread it was dual-posted to, and is
  // not drawn in the general chat at all: a stream of thirty such lines was
  // what made a quiet app's Discussion unreadable.
  //
  // The wordings are the server's own (routes/votes.js). A promote or an
  // import posts "<who> promoted PR #N: <title> for voting" as a `vote` row;
  // a merge posts "<title> is live (PR #N). Thanks to everyone who voted
  // (a/b votes)" (on the platform's own app, "<title> merged (PR #N) and
  // will be live in a few minutes. …"), or "PR #N: <title> force-merged by
  // admin <who> (a/b votes at the time)". Every vote row is a submission whatever its wording (the
  // number comes from _voteRef then); a system row that matches neither
  // merge wording is not an event.
  _proposalEvent(msg, kind) {
    const text = String(msg.content == null ? '' : msg.content);
    const [sessionId, prFromText] = GroupChat._voteRef(msg);
    if (kind === 'vote') {
      const m = /^(\S+) (?:promoted|imported) PR #(\d+)(?:: ([\s\S]*?))? for (?:voting|a vote)$/.exec(text);
      return {
        type: 'submitted', sessionId, prNumber: m ? m[2] : prFromText,
        title: (m && m[3]) || '', actor: m ? m[1] : '', force: false, votes: '',
      };
    }
    if (kind !== 'system') return null;
    // #1688: the Friday card — a system row carrying `weekly` metadata
    // (services/weekly-digest.js), drawn as a card from the app itself.
    const weekly = GroupChat._weeklyEvent(msg);
    if (weekly) return weekly;
    // #1688: the sentence between the lead-in and the tally names the people
    // ("Built by evan, backed by alice and bob, shaped by carol.") — or is the
    // older "Thanks to everyone who voted". The names ride as metadata on a
    // new row; an older row, or a row whose metadata did not survive, has
    // them read back out of the sentence. `credits` is on the event only
    // when somebody is named, so a row naming nobody keeps its old shape.
    const credits = GroupChat._mergeCredits(msg);
    // Follow-up to #2897: a merge on the platform's own app posts "<title>
    // merged (PR #N) and will be live in a few minutes. …" (or "PR #N merged
    // and will be live in a few minutes. …"), because its release runs after
    // the merge. Every other merge, and every row stored before that, says
    // "is live". Both wordings are merges; `liveSoon` says which it was, from
    // the row's metadata where it rides, else from the wording. It is on the
    // event only when true, so an "is live" row keeps its old shape.
    const soonMeta = GroupChat._mergeLiveSoon(msg);
    const merged = (prNumber, title, sentence, votes, soonText) => {
      const named = credits || GroupChat._parseCredits(sentence);
      return {
        type: 'merged', sessionId, prNumber, title, actor: '', force: false, votes,
        ...(named ? { credits: named } : {}),
        ...(soonMeta || soonText ? { liveSoon: true } : {}),
      };
    };
    let m = /^([\s\S]*?) is live \(PR #(\d+)\)\. ([\s\S]*?) \((\d+\/\d+) votes?\)$/.exec(text);
    if (m) return merged(m[2], m[1], m[3], m[4], false);
    m = /^([\s\S]*?) merged \(PR #(\d+)\) and will be live in a few minutes\. ([\s\S]*?) \((\d+\/\d+) votes?\)$/.exec(text);
    if (m) return merged(m[2], m[1], m[3], m[4], true);
    m = /^PR #(\d+) is live\. ([\s\S]*?) \((\d+\/\d+) votes?\)$/.exec(text);
    if (m) return merged(m[1], '', m[2], m[3], false);
    m = /^PR #(\d+) merged and will be live in a few minutes\. ([\s\S]*?) \((\d+\/\d+) votes?\)$/.exec(text);
    if (m) return merged(m[1], '', m[2], m[3], true);
    m = /^PR #(\d+)(?:: ([\s\S]*?))? force-merged by admin (\S+) \((\d+\/\d+) votes? at the time\)$/.exec(text);
    if (m) return { type: 'merged', sessionId, prNumber: m[1], title: m[2] || '', actor: m[3], force: true, votes: m[4] };
    return null;
  },

  // The Friday card's data (#1688), or null on a row that is not one. The
  // lists are what the card draws; the totals say how many it stands for.
  _weeklyEvent(msg) {
    const w = (msg.metadata || msg.meta || {}).weekly;
    if (!w || typeof w !== 'object') return null;
    const item = (x) => ({
      id: x && x.id != null ? Number(x.id) : null,
      prNumber: x && x.prNumber != null ? String(x.prNumber) : '',
      title: String((x && x.title) || ''),
      author: String((x && x.author) || ''),
      backers: Array.isArray(x && x.backers)
        ? x.backers.map((n) => String(n || '').trim()).filter(Boolean) : [],
    });
    return {
      type: 'weekly', sessionId: '', prNumber: '', title: '', actor: '', force: false, votes: '',
      weekly: {
        app: String(w.app || ''),
        slug: String(w.slug || ''),
        merged: (Array.isArray(w.merged) ? w.merged : []).map(item),
        mergedTotal: Number(w.mergedTotal) || 0,
        open: (Array.isArray(w.open) ? w.open : []).map(item),
        openTotal: Number(w.openTotal) || 0,
      },
    };
  },

  // True when a merge announcement's metadata says its release is still to
  // come (routes/votes.js finalizeMerge sets `liveSoon` on a self-hosted
  // merge); false on a row without it, whose wording then decides.
  _mergeLiveSoon(msg) {
    const meta = (msg.metadata || msg.meta || {}).merged;
    return !!(meta && typeof meta === 'object' && meta.liveSoon === true);
  },

  // The names a merge announcement carries as metadata (routes/votes.js
  // finalizeMerge), or null on a row without them.
  _mergeCredits(msg) {
    const meta = (msg.metadata || msg.meta || {}).merged;
    if (!meta || typeof meta !== 'object') return null;
    const names = (v) => (Array.isArray(v) ? v.map((n) => String(n || '').trim()).filter(Boolean) : []);
    const author = typeof meta.author === 'string' ? meta.author.trim() : '';
    const backers = names(meta.backers);
    const shapers = names(meta.shapers);
    if (!author && !backers.length && !shapers.length) return null;
    return { author, backers, shapers };
  },

  // The same names read back out of the sentence, for a row without
  // metadata: "Built by evan, backed by alice and bob, shaped by carol."
  // → { author, backers, shapers }. Null when the sentence names nobody
  // (the older "Thanks to everyone who voted").
  _parseCredits(sentence) {
    const s = String(sentence || '').replace(/\.\s*$/, '');
    const part = (verb) => {
      const m = new RegExp(`(?:^|, )[${verb[0].toUpperCase()}${verb[0]}]${verb.slice(1)} by (.+?)(?=, [a-z]+ by |$)`).exec(s);
      return m ? m[1] : '';
    };
    const names = (run) => run.split(/, | and /).map((n) => n.trim())
      .filter((n) => n && !/^\d+ more$/.test(n));
    const author = part('built');
    const backers = names(part('backed'));
    const shapers = names(part('shaped'));
    if (!author && !backers.length && !shapers.length) return null;
    return { author, backers, shapers };
  },

  // The glyph the Dev board gives the same proposal — the "done" tick once
  // it has merged, the proposal glyph while it is up for a vote — from the
  // board's own table, so the two surfaces cannot draw one thing two ways.
  // Null where app-view.js has not loaded (a test), and the row draws none.
  // ── The change page's Discussion: every notice is a message ─────────
  // The general chat draws two events (`_proposalEvent`); the change
  // page's own Discussion draws them ALL in that language, because there
  // every notice is the story of this one change: proposed, voted, merged,
  // and the platform's own notices as a message from the app itself. The
  // proposal is the page, so a row here names the act without the number
  // and title, and is never a door (`here`).
  _threadEvent(msg, kind) {
    const text = String(msg.content == null ? '' : msg.content);
    const [sessionId, prNumber] = GroupChat._voteRef(msg);
    const base = { sessionId, prNumber, title: '', force: false, votes: '', here: true };
    if (kind === 'vote') {
      // routes/votes.js: "<who> voted yes on PR #N: <title>" or, with a
      // reason, "<who> voted no: “<reason>”".
      let m = /^(\S+) voted (yes|no)(?::\s*[“"]([\s\S]*?)[”"]|\s+on\b[\s\S]*)?$/.exec(text);
      if (m) {
        return {
          ...base, type: 'vote', actor: m[1], vote: m[2], reason: m[3] || '',
          earlier: GroupChat._votedOnEarlierVersion(sessionId, m[1]),
        };
      }
      m = /^(\S+) (?:promoted|imported) PR #\d+/.exec(text);
      return { ...base, type: 'submitted', actor: m ? m[1] : '' };
    }
    if (kind !== 'system') return null;
    const known = GroupChat._proposalEvent(msg, kind);
    if (known) return { ...known, here: known.type !== 'weekly' };
    return { ...base, type: 'notice', actor: '', text: GroupChat._noticeText(text, sessionId, prNumber) };
  },

  // #3411: whether this voter's vote no longer counts because the proposal
  // changed after they cast it. The line posted at vote time is permanent,
  // but the tally counts only votes on the current version, so a "Voted yes"
  // row beside "Yes 0" needs to say why. Read off the roster the page has
  // already loaded (AppView._loadVoteRoster), never a fetch per row. A voter
  // has one vote per proposal, so one listed there has none on the current
  // version and every line of theirs is from an earlier one; a voter who
  // re-cast on the current version is not listed, and no line of theirs is
  // marked.
  _votedOnEarlierVersion(sessionId, username) {
    const a = GroupChat.activeThread;
    const sid = sessionId || (a && a.type === 'session' ? String(a.ref) : '');
    if (!sid || !username || typeof AppView === 'undefined' || !AppView._voteRoster) return false;
    const roster = AppView._voteRoster[sid];
    return !!(roster && Array.isArray(roster.earlierVoters) && roster.earlierVoters.includes(username));
  },

  // A notice's wording on its own page: "PR #12: <title> reached the vote
  // threshold…" opens with the page's own name, so the row says "Reached
  // the vote threshold…". The title is read off the vote snapshot; without
  // it only a bare "PR #12:" lead-in is dropped, never a guess at where the
  // title ends.
  _noticeText(text, sessionId, prNumber) {
    let t = String(text || '');
    const pr = GroupChat._resolvePr(sessionId, prNumber);
    const title = pr && pr.pr_title ? String(pr.pr_title) : '';
    const n = prNumber || (pr && pr.pr_number != null ? String(pr.pr_number) : '');
    if (n && title && t.startsWith(`PR #${n}: ${title}`)) {
      t = t.slice(`PR #${n}: ${title}`.length).replace(/^[\s:,.\p{Pd}]+/u, '');
    } else if (n && /^PR #\d+:\s/.test(t) && !title) {
      t = t.replace(/^PR #\d+:\s*/, '');
    }
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : String(text || '');
  },

  _eventIcon(type, ev) {
    // A yes is the board's done glyph; every other act wears the proposal's.
    if (type === 'vote' && typeof AppView !== 'undefined' && typeof AppView._devCardIcon === 'function') {
      return AppView._devCardIcon(ev && ev.vote === 'yes' ? 'done' : 'proposal', { small: true });
    }
    if (type === 'notice' && typeof AppView !== 'undefined' && typeof AppView._devCardIcon === 'function') {
      return AppView._devCardIcon('proposal', { small: true });
    }
    // #1688: the Friday card has no proposal to take a glyph from.
    if (type === 'weekly') return null;
    if (typeof AppView === 'undefined' || typeof AppView._devCardIcon !== 'function') return null;
    return AppView._devCardIcon(type === 'merged' ? 'done' : 'proposal', { small: true });
  },

  // Where an event row leads: the proposal's own page, which is where its
  // Preview, the vote and the discussion live. Needs the session id — from
  // the row's metadata tag, else from the live PR the snapshot resolved —
  // and null until one is known, in which case the row is not a link.
  _eventHref(sessionId, pr) {
    const slug = GroupChat._appSlug()
      || GroupChat.appSlug;
    const id = sessionId || (pr && pr.id != null ? String(pr.id) : '');
    if (!slug || !id) return null;
    return (typeof App !== 'undefined' && App._appUrl)
      ? App._appUrl(slug, 'dev', { kind: 'proposal', id: Number(id) }, 'topic')
      : `/app/${encodeURIComponent(slug)}/dev/proposals/${id}`;
  },

  // Re-fill every inline vote-control wrapper from the current
  // AppView.voteState. Called by AppView.loadVotePanel after it reloads on
  // a vote/session update (and on first open, covering the race where the
  // chat renders before the panel finishes fetching), so the inline
  // buttons + count + row tint track the panel. A PR no longer in the
  // votable set yields empty controls and the row falls back to a plain
  // activity line.
  refreshVoteControls() {
    document.querySelectorAll('#gc-messages [data-vote-controls], #gc-thread-messages [data-vote-controls]').forEach((el) => {
      const pr = GroupChat._resolvePr(
        el.getAttribute('data-session-id') || '',
        el.getAttribute('data-pr-number') || ''
      );
      // The host's CONTENTS stay ours — this is AppView's markup, and the
      // element is rendered once as an empty span it never looks inside.
      el.innerHTML = GroupChat._voteInnerHtml(pr);
      // The row's TINT is not: `voteRowClass` is on the view model and React
      // renders it, so a classList write here would be undone by the next
      // repaint. Patch the model instead — and only when it moved, or the
      // effect that calls this after each render would publish forever.
      const row = el.closest('.gc-msg-vote[data-msg-id]');
      const id = row && parseInt(row.dataset.msgId || '', 10);
      if (id) {
        // The phase rides along for the same reason: a row that was 'unknown'
        // at first paint learns here whether it stands or folds. A settled
        // row already inside a collapsed digest has no host in the DOM and
        // is not visited — it has nothing left to learn.
        GroupChat._react()?.patchTranscriptMessage(id, {
          voteRowClass: GroupChat._rowVoteClass(pr),
          votePhase: GroupChat._votePhase(pr),
        });
      }
    });
    // The general chat's proposal events carry no host — their controls live
    // on the proposal's page — so they are visited by row: a submission's
    // phase says whether it is still open, which its row marks, and the link
    // is resolved once the snapshot names the session behind a row that
    // predates the metadata tag.
    document.querySelectorAll('#gc-messages .gc-event[data-msg-id]').forEach((el) => {
      const id = parseInt(el.dataset.msgId || '', 10);
      if (!id) return;
      const sid = el.dataset.sessionId || '';
      const pr = GroupChat._resolvePr(sid, el.dataset.prNumber || '');
      const patch = { eventHref: GroupChat._eventHref(sid, pr) };
      if (el.dataset.event === 'submitted') patch.votePhase = GroupChat._votePhase(pr);
      GroupChat._react()?.patchTranscriptMessage(id, patch);
    });
  },

  // `_renderQuotedBlock` lived here — the `.gc-quoted` block on a message
  // that is itself a reply, as an HTML string. It is transcript.tsx's
  // `QuoteBlock` now, drawn from the same four facts and carrying the same
  // class and `data-quote-*` attributes, because `_handleQuotedClick` above
  // is still what a click on it goes through.
  //
  // What the transcript conversion had put in its place drew a
  // `ThreadReplySummary` — the widget language's "N replies" affordance for a
  // thread, which is a different thing — so a quoted reply read "1 reply
  // alice", lost its snippet and its icon entirely, and did nothing when
  // clicked: the block carried none of the attributes the handler dispatches
  // on, and the onClick it did carry called a `scrollToMessage` that is not a
  // method of this module.

  // The shared-spec card, as data.
  //
  // Was `renderSpecShareCard`, reached from `renderMessageHtml` — which the
  // transcript conversion left with no callers, so the card had quietly
  // stopped rendering at all: the transcript emitted `[data-gc-spec-share]`
  // as an empty host and nothing filled it. This is what fills it, through
  // features/group-chat/transcript.tsx, and the row is markup again.
  //
  // `meta.title` is set by the share endpoint when the spec content starts
  // with an H1; older shares predate that field and fall back to
  // "Spec v<n>". The snippet is rendered as markdown so the preview matches
  // what the user sees in the dev-chat spec viewer (shared markdown helper
  // from DevChat).
  //
  // Reach DevChat via a bare reference and a `typeof` guard rather than
  // `window.DevChat` — DevChat is declared with `const` at dev-chat.js's top
  // level, which does NOT install it as a property on `window` (only `var` /
  // function declarations do). It IS visible as a global identifier across
  // <script> tags because both files share the same script scope, so a bare
  // `DevChat.renderMarkdown(...)` works; the `typeof` keeps things safe if
  // dev-chat.js ever fails to load.
  _specShareView(meta, msg) {
    const renderMd = typeof DevChat !== 'undefined' && DevChat.renderMarkdown
      ? (str) => DevChat.renderMarkdown(str)
      : null;
    // #1808: composed from `_stamp` rather than spelling its own options
    // table, which had no `year` — a spec built last June read "Jun 16,
    // 02:41 PM", exactly like one built this June.
    const built = GroupChat._stamp(meta.builtAt).text || null;
    return {
      title: meta.title || `Spec v${meta.version}`,
      // The preview title the panel header shows while the fetch is in
      // flight. It was a `data-spec-title` attribute the click delegate read
      // back off the card; it is a field now, so nothing has to round-trip
      // through the DOM to find it.
      previewTitle: meta.title || `spec v${meta.version}`,
      sharedBy: meta.sharedBy?.username || msg.username || 'Someone',
      version: meta.version,
      built,
      prNumber: meta.prNumber || null,
      sessionId: meta.sessionId || null,
      // Markdown, so `dangerouslySetInnerHTML`; null when the share carried
      // no snippet, or when dev-chat.js is not loaded to render one.
      snippetHtml: meta.snippet && renderMd ? renderMd(meta.snippet) : null,
      // …and the raw text as the fallback, escaped by React as a text child.
      snippetText: meta.snippet && !renderMd ? String(meta.snippet) : null,
    };
  },

  // Open a shared spec in the side panel.
  //
  // Was the body of `_attachSpecCardHandlers`, a click delegate bound to the
  // messages container that read the button's `data-session-id` /
  // `data-version` and then wrote `disabled` and `textContent` back onto it.
  // Those two writes were the problem: the card is React's since #1191, and
  // the button's in-flight state is the component's own — so this returns a
  // promise and the component brackets it. The address bookkeeping, the fetch
  // and every failure wording stay here.
  //
  // `previewTitle` fills the panel header while the request is in flight, so
  // the panel is never a blank box; it falls back to the version label for an
  // older share that predates `metadata.specShare.title`.
  async openSharedSpec(sessionId, version, previewTitle) {
    if (!sessionId || !version) return;
    const title = previewTitle || `Spec v${version}`;
    // Persist the open state so a refresh re-opens this same spec
    // automatically. Per-app keying ensures switching apps doesn't drag this
    // open state along with you.
    GroupChat._writeSpecPanelOpen(GroupChat.appSlug, {
      sessionId: parseInt(sessionId, 10),
      version: parseInt(version, 10),
      title,
    });
    try {
      const resp = await fetch(`/api/sessions/${sessionId}/specs/${version}${GroupChat._specDemoQS()}`);
      // After #6, the server allows any authed user to read a spec version
      // that was explicitly shared into the group chat. A 404 here therefore
      // means the share was withdrawn or the version row is gone (rare —
      // would require manual DB edits or a session DELETE CASCADE) rather
      // than the routine "not the owner" case it used to mean.
      if (!resp.ok) {
        GroupChat._showSpecPanel({
          title,
          version,
          content: resp.status === 404
            ? 'This spec is no longer available. The sharer may have deleted the session.'
            : `Failed to load spec (HTTP ${resp.status}).`,
          isError: true,
        });
        return;
      }
      const data = await resp.json();
      GroupChat._showSpecPanel({
        title,
        version,
        content: data.spec.content || '(empty spec)',
        builtAt: data.spec.built_at,
        prNumber: data.spec.pr_number,
      });
    } catch (err) {
      GroupChat._showSpecPanel({
        title,
        version,
        content: `Error: ${err.message}`,
        isError: true,
      });
    }
  },

  // (#1012) Raw markdown currently displayed in the spec panel, kept in
  // JS state because the panel rewrites its own innerHTML and nothing
  // else retains `content`. Deliberately NOT a data- attribute: a spec
  // is multi-KB markdown full of quotes and newlines.
  _specPanelRaw: null,

  _showSpecPanel({ title, version, content, builtAt, prNumber, isError, canCopy = true }) {
    // Populates the side-panel slot rendered inside the group-chat
    // tab body (see app-view.js renderGroupChatTab). The same panel
    // markup serves both responsive layouts — CSS switches between
    //   ≥ 1024px → inline side panel beside the chat (does NOT cover
    //              the app header or vote panel, slots into the
    //              gc-tab-body row alongside gc-chat-pane)
    //   < 1024px → fullscreen modal covering only the gc-tab-body
    //              area (still does NOT cover the app header or
    //              vote/issue panel, since the slot is constrained
    //              to that flex row).
    // Esc closes; the panel persists across re-renders of the chat
    // tab because the slot lives in the layout, not in body.
    //
    // The general chat is not the only layout with the slot: a request's or
    // a proposal's Discussion is a thread in the Dev topic frame
    // (features/dev-board/topic-frame.tsx), which carries the same row, and
    // a spec card there opens the panel beside the topic. Before it did, the
    // lookup below found nothing and "View full spec" did nothing (#3495).
    const panel = document.getElementById('gc-spec-side-panel');
    if (!panel) return;
    // The divider is bound on mount by the general chat; the topic frame has
    // no mount of this module's, so bind it here too. Idempotent per handle.
    GroupChat._initSpecPanelResizer();

    GroupChat._specPanelRaw = content == null ? '' : String(content);

    if (!panel._gcKeyHandler) {
      const onKey = (e) => {
        if (e.key === 'Escape' && panel.classList.contains('gc-spec-side-panel-open')) {
          GroupChat._closeSpecPanel();
        }
      };
      document.addEventListener('keydown', onKey);
      panel._gcKeyHandler = onKey;
    }

    // Same table as the share card above, from the same helper (#1808).
    const builtStr = GroupChat._stamp(builtAt).text;
    const subtitleParts = [];
    if (version != null) subtitleParts.push(`v${version}`);
    if (builtStr) subtitleParts.push(builtStr);
    if (prNumber) subtitleParts.push(`PR #${prNumber}`);
    const subtitle = subtitleParts.join(' · ');

    // Render markdown for normal content; error / 404 messages are
    // plain text so we don't accidentally turn an error into a
    // misleadingly-formatted bit of markup. See the _specShareView
    // comment for why we use a bare `DevChat` reference + `typeof`
    // guard rather than `window.DevChat` (const-declared globals don't
    // attach to window).
    // An error renders as TEXT and a spec as markdown, and that split is
    // deliberate: formatting a 404 message turns it into something that looks
    // like a document. It used to be two branches of one HTML string; it is
    // two tags in features/group-chat/spec-panel.tsx now, so the error path
    // cannot acquire markup by accident. See the _specShareView comment
    // for why this is a bare `DevChat` reference behind a `typeof` guard
    // rather than `window.DevChat` (const-declared globals don't attach).
    const body = isError
      ? { kind: 'error', text: String(content == null ? '' : content) }
      : (typeof DevChat !== 'undefined' && DevChat.renderMarkdown
        ? { kind: 'markdown', html: DevChat.renderMarkdown(content) }
        : { kind: 'error', text: String(content == null ? '' : content) });

    GroupChat._react()?.mountSpecPanel?.(panel);
    GroupChat._react()?.publishSpecPanel?.({
      open: true,
      title: String(title == null ? '' : title),
      subtitle: subtitle || null,
      // (#1012) Copy the whole document as raw markdown. Suppressed for an
      // error body (a 404 message is not a spec) and for a caller that opted
      // out via canCopy — the reload-restore skeleton, whose placeholder
      // "Loading…" must never be copyable.
      canCopy: !!(canCopy && !isError && content),
      body,
    });
    // The HOST's class stays ours: it is the AUTHORITATIVE open state that the
    // resizer and the width restore both read.
    panel.classList.add('gc-spec-side-panel-open');
    GroupChat._applySavedSpecPanelWidth();

    const handle = document.getElementById('gc-spec-resizer');
    if (handle) handle.classList.add('gc-spec-resizer-open');
  },

  _closeSpecPanel() {
    const panel = document.getElementById('gc-spec-side-panel');
    if (!panel) return;
    panel.classList.remove('gc-spec-side-panel-open');
    // Publish "closed" rather than clearing the host: its subtree is React's,
    // and an innerHTML wipe behind React's back is the write the ownership
    // rule forbids. The portal stays mounted and draws nothing.
    GroupChat._react()?.publishSpecPanel?.({
      open: false, title: '', subtitle: null, canCopy: false, body: null,
    });
    // Don't leave a closed panel's document copyable.
    GroupChat._specPanelRaw = null;
    if (panel._gcKeyHandler) {
      document.removeEventListener('keydown', panel._gcKeyHandler);
      panel._gcKeyHandler = null;
    }
    const handle = document.getElementById('gc-spec-resizer');
    if (handle) handle.classList.remove('gc-spec-resizer-open');
    GroupChat._writeSpecPanelOpen(GroupChat.appSlug, null);
  },

  // ===== Spec panel: draggable divider + open/width persistence =====
  //
  // Mirrors DevChat's spec-viewer pattern. Width is a global user
  // preference (one value across all apps). Open state is per-app —
  // when you're viewing app A with a panel open and switch to app B,
  // B opens with its own remembered state, not A's leftover.
  //
  // Open state shape: { sessionId, version, title } so we can paint
  // the panel header instantly on refresh while the spec content
  // request is in flight.

  _SPEC_PANEL_WIDTH_KEY: 'gc-spec-panel-width-v1',
  _SPEC_PANEL_OPEN_KEY_PREFIX: 'gc-spec-panel-open-v1:',

  // (#1012) ?demo=1 passthrough for the spec-version fetch, same shape as
  // Notifications' and Browse's. chat_session_specs is staging:private, so
  // on a prod-cloned staging DB the cloned spec_share cards in group chat
  // have no content to load and the panel only ever renders its error
  // branch. With demo=1 on the page URL the server answers a mock version
  // (see stagingMockSpecVersion in src/routes/sessions.js) so the panel —
  // and its copy button — are reviewable in a staging preview. Honoured by
  // the server ONLY in staging; a no-op in production.
  // #1808: the same ?demo=1 passthrough for the TRANSCRIPT reads. A declared
  // check renders against a fresh, empty staging database, so both the
  // general stream and a topic's Discussion thread came back with nothing to
  // stamp; the server answers a first page of `[Mock]` rows spanning all
  // three branches (see stagingMockGroupChat in src/routes/chat.js). Only on
  // a first page — a `before` cursor is paging past what is already on
  // screen — and honoured by the server ONLY in staging.
  _demoParam() {
    try {
      return new URLSearchParams(location.search).get('demo') === '1' ? '&demo=1' : '';
    } catch { return ''; }
  },

  _specDemoQS() {
    try {
      return new URLSearchParams(location.search).get('demo') === '1' ? '?demo=1' : '';
    } catch { return ''; }
  },

  _readSpecPanelWidth() {
    try {
      const v = parseInt(localStorage.getItem(GroupChat._SPEC_PANEL_WIDTH_KEY) || '', 10);
      return Number.isFinite(v) && v > 0 ? v : null;
    } catch { return null; }
  },

  _writeSpecPanelWidth(px) {
    try { localStorage.setItem(GroupChat._SPEC_PANEL_WIDTH_KEY, String(Math.round(px))); }
    catch {}
  },

  _readSpecPanelOpen(appSlug) {
    if (!appSlug) return null;
    try {
      const raw = localStorage.getItem(GroupChat._SPEC_PANEL_OPEN_KEY_PREFIX + appSlug);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.sessionId && parsed.version) return parsed;
      return null;
    } catch { return null; }
  },

  _writeSpecPanelOpen(appSlug, state) {
    if (!appSlug) return;
    try {
      const key = GroupChat._SPEC_PANEL_OPEN_KEY_PREFIX + appSlug;
      if (state) localStorage.setItem(key, JSON.stringify(state));
      else localStorage.removeItem(key);
    } catch {}
  },

  // Apply the persisted width as inline style on the panel. Called
  // by _showSpecPanel when opening; CSS clamps via min-width /
  // max-width so a stale value can't strand the chat too narrow.
  _applySavedSpecPanelWidth() {
    const panel = document.getElementById('gc-spec-side-panel');
    if (!panel) return;
    const w = GroupChat._readSpecPanelWidth();
    if (w) panel.style.width = `${w}px`;
  },

  // Bind the resizer's drag handler. Idempotent: re-binding on
  // every group-chat mount is fine because the handle element gets
  // recreated whenever the tab re-renders, and we tag the handle
  // so we don't double-bind on the same element.
  _initSpecPanelResizer() {
    const handle = document.getElementById('gc-spec-resizer');
    const panel = document.getElementById('gc-spec-side-panel');
    if (!handle || !panel) return;
    if (handle._gcResizerBound) return;
    handle._gcResizerBound = true;

    handle.addEventListener('pointerdown', (e) => {
      // Drag only matters when the panel is actually showing in
      // side-panel layout. CSS hides the handle (display: none)
      // outside that condition, so a pointerdown reaching this
      // listener already implies the layout is correct — but the
      // `.gc-spec-side-panel-open` class is the authoritative
      // signal so we double-check it.
      if (!panel.classList.contains('gc-spec-side-panel-open')) return;
      e.preventDefault();

      const tabBody = handle.parentElement;
      const startX = e.clientX;
      const startWidth = panel.getBoundingClientRect().width;
      const bodyRect = tabBody.getBoundingClientRect();
      const minWidth = 280;
      // Leave at least 320px for the chat pane on the left, even on
      // tiny laptop screens where 50vw might breach that.
      const maxWidth = Math.max(minWidth + 1, bodyRect.width - 320);

      handle.setPointerCapture(e.pointerId);
      handle.classList.add('gc-spec-resizer-active');
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';

      const onMove = (ev) => {
        // Dragging right shrinks the panel (its left edge moves right).
        const delta = ev.clientX - startX;
        const next = Math.max(minWidth, Math.min(maxWidth, startWidth - delta));
        panel.style.width = `${next}px`;
      };

      const onUp = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        try { handle.releasePointerCapture(e.pointerId); } catch {}
        handle.classList.remove('gc-spec-resizer-active');
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
        const finalWidth = panel.getBoundingClientRect().width;
        GroupChat._writeSpecPanelWidth(finalWidth);
      };

      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    });
  },

  // Restore the panel from localStorage on group-chat tab mount /
  // page refresh. The header paints immediately from the saved
  // {title, version}; the spec content fetches in the background
  // and replaces the body when it lands. If the request 404s (e.g.
  // the user no longer has access), we surface the same error
  // message the click-handler does — keeps the panel visible
  // instead of vanishing silently.
  async _restoreSpecPanelIfSaved(appSlug) {
    if (!appSlug) return;
    const saved = GroupChat._readSpecPanelOpen(appSlug);
    if (!saved) return;

    const { sessionId, version, title } = saved;
    const previewTitle = title || `Spec v${version}`;

    // Show the panel header right away (skeleton body) so the user
    // sees something immediately while the spec content loads.
    GroupChat._showSpecPanel({
      title: previewTitle,
      version,
      content: 'Loading…',
      // (#1012) The placeholder is not a document — no copy button until
      // the real content lands and replaces this render.
      canCopy: false,
    });

    try {
      const resp = await fetch(`/api/sessions/${sessionId}/specs/${version}${GroupChat._specDemoQS()}`);
      // If the user navigated away during the fetch, don't clobber
      // whatever's on screen.
      if (GroupChat.appSlug !== appSlug) return;
      if (!resp.ok) {
        GroupChat._showSpecPanel({
          title: previewTitle,
          version,
          content: resp.status === 404
            ? 'This spec is no longer available. The sharer may have deleted the session.'
            : `Failed to load spec (HTTP ${resp.status}).`,
          isError: true,
        });
        return;
      }
      const data = await resp.json();
      if (GroupChat.appSlug !== appSlug) return;
      GroupChat._showSpecPanel({
        title: previewTitle,
        version,
        content: data.spec.content || '(empty spec)',
        builtAt: data.spec.built_at,
        prNumber: data.spec.pr_number,
      });
    } catch (err) {
      if (GroupChat.appSlug !== appSlug) return;
      GroupChat._showSpecPanel({
        title: previewTitle,
        version,
        content: `Error: ${err.message}`,
        isError: true,
      });
    }
  },

  renderTyping() {
    GroupChat._renderStatusLine();
  },

  // Single writer for #gc-typing. Two pieces of state compete for
  // this slot: the connection-state indicator (#7 reconnect / queued
  // messages) and the typing-users line. Connection-state wins when
  // we're offline because it's actionable ("your message is waiting,
  // here's why") and a typing notice from a stale state would be
  // misleading. When connected, the typing-users line owns the slot
  // exactly as before.
  _renderStatusLine() {
    const wsOpen = GroupChat.ws && GroupChat.ws.readyState === 1;
    if (!wsOpen && GroupChat.appSlug) {
      const queued = GroupChat._pendingOutgoing.length;
      GroupChat._publishComposer('general', {
        status: queued > 0 ? `Reconnecting… (${queued} queued)` : 'Reconnecting…',
      });
      return;
    }

    const names = [...GroupChat.typingUsers.values()].filter((n) => n !== App.user?.username);
    GroupChat._publishComposer('general', {
      status: names.length === 0 ? ''
        : names.length === 1 ? `${names[0]} is typing...`
          : `${names.join(', ')} are typing...`,
    });
  },

  scrollToBottom() {
    const container = document.getElementById('gc-messages');
    if (!container) return;
    container.scrollTop = container.scrollHeight;
    GroupChat._lockedToBottom = true;
    GroupChat._savedScrollTop = container.scrollTop;
  },

  // Attached after every render of the group-chat tab (the DOM element is
  // re-created each time the user switches back in). Handles:
  //   1. Load-more when the user scrolls to the top.
  //   2. Tracking `_lockedToBottom` + `_savedScrollTop` so new messages only
  //      auto-scroll when the user is already near the bottom, and the
  //      previous scroll offset is restored on tab re-entry.
  //   3. A ResizeObserver that re-pins the view to the bottom when locked
  //      and the viewport height changes under us. The vote/issue panel
  //      above the messages loads asynchronously and grows after our
  //      initial scroll-to-bottom — without this, the user sees the chat
  //      "land slightly above the bottom" every time they come back.
  attachScrollHandlers() {
    const container = document.getElementById('gc-messages');
    if (!container) return;
    GroupChat._attachQuoteHandlers(container);
    if (container._gcScrollBound) return;
    container._gcScrollBound = true;
    container.addEventListener('scroll', () => {
      if (container.scrollTop === 0 && GroupChat.hasMore) {
        GroupChat.loadHistory();
      }
      // 50px slack: if the user is within ~one message of the bottom we
      // still treat them as "following the conversation".
      const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 50;
      GroupChat._lockedToBottom = atBottom;
      GroupChat._savedScrollTop = container.scrollTop;
    });

    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => {
        if (GroupChat._lockedToBottom) {
          container.scrollTop = container.scrollHeight;
        }
      });
      ro.observe(container);
      // Also watch the whole tab pane so panel height changes above the
      // messages list (e.g. vote panel finishing its async fetch) re-pin
      // the scroll position.
      const tabPane = container.closest('.flex.flex-col.h-full') || container.parentElement;
      if (tabPane) ro.observe(tabPane);
    }
  },

  // ── A bell row's message, brought into view ─────────────────────────
  //
  // A mention, a reply, a reaction or a saved message names ONE message of an
  // app's discussion, and the discussion opened at the newest with that
  // message somewhere above it. The bell asks for it here as it opens the
  // discussion (Notifications._openAppDiscussion), and so does the project
  // page's Discussion tab for a message link it was sent to (#3653); the first
  // history load of that app — or the remount of an app already loaded, or
  // this call itself when that discussion is the one already open — scrolls
  // it to the middle of the stream and flashes it, the highlight a quote's
  // jump-to-original lands on. Only a message inside the page that loaded
  // can be shown; one older than that leaves the stream at the newest, as
  // before. The request lapses after REVEAL_TTL_MS, so a discussion opened
  // much later is not moved by a click it never saw.
  _pendingReveal: null,
  REVEAL_TTL_MS: 20000,

  revealMessage(appSlug, messageId) {
    const id = Number(messageId);
    if (!appSlug || !Number.isSafeInteger(id) || id <= 0) return;
    GroupChat._pendingReveal = { slug: appSlug, id, at: Date.now() };
    // Now, only when the stream on screen is that discussion's pane — in
    // Messages, or its project page's Discussion tab, which carries the same
    // attribute: anywhere else the click is about to move the reader there,
    // and the mount it lands on applies it.
    const container = document.getElementById('gc-messages');
    const pane = container && container.closest && container.closest('[data-discussion-app]');
    if (pane && pane.getAttribute('data-discussion-app') === appSlug) {
      GroupChat._applyPendingReveal();
    }
  },

  _applyPendingReveal(attempt = 0) {
    const want = GroupChat._pendingReveal;
    if (!want) return false;
    if (Date.now() - want.at > GroupChat.REVEAL_TTL_MS) {
      GroupChat._pendingReveal = null;
      return false;
    }
    if (GroupChat.appSlug !== want.slug || !GroupChat._didInitialScroll) return false;
    const container = document.getElementById('gc-messages');
    if (!container) return false;
    // A reply in a reply thread (#2387 follow-up): the general stream holds
    // it now, but as a line of a thread card rather than a row of its own —
    // the link opens its thread beside the channel instead.
    const loadedReply = GroupChat.messages.find((m) => Number(m && m.id) === want.id
      && (m.thread_type === 'message' || (m.thread && m.thread.type === 'message')));
    if (loadedReply) {
      const root = Number(loadedReply.thread_ref ?? (loadedReply.thread && loadedReply.thread.ref));
      GroupChat._pendingReveal = null;
      if (Number.isSafeInteger(root) && root > 0
          && !GroupChat._openThreadInPage(want.slug, root)) {
        const address = `#messages/app/${encodeURIComponent(want.slug)}/thread/${root}`;
        const messages = window.UsernodeReact?.messages;
        if (messages?.openAddress) messages.openAddress(address);
        else window.location.hash = address;
      }
      return false;
    }
    const row = container.querySelector(`[data-msg-id="${want.id}"]`);
    if (!row) {
      // The transcript is published BATCHED (features/group-chat/mount.ts):
      // its rows land in React's next commit, a frame or so after render().
      // Wait for them while the message is one this page loaded; one older
      // than the page is not coming, and the stream stays at the newest.
      const loaded = GroupChat.messages.some((m) => Number(m && m.id) === want.id);
      if (loaded && attempt < 30 && typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => GroupChat._applyPendingReveal(attempt + 1));
      } else if (!loaded && !want.located) {
        // #2387: a message link can name any message — one older than the
        // page that loaded, or a reply inside a reply thread. Go and find it.
        want.located = true;
        void GroupChat._locateReveal(want);
      } else {
        GroupChat._pendingReveal = null;
      }
      return false;
    }
    GroupChat._pendingReveal = null;
    // Scrolled inside the stream only: scrollIntoView would move every
    // scrolling ancestor too. Unlocked from the bottom FIRST, or the
    // ResizeObserver in attachScrollHandlers pins it straight back.
    GroupChat._lockedToBottom = false;
    const box = container.getBoundingClientRect();
    const at = row.getBoundingClientRect();
    container.scrollTop += (at.top - box.top) - (box.height - at.height) / 2;
    GroupChat._savedScrollTop = container.scrollTop;
    GroupChat._react()?.patchTranscriptMessage(want.id, { flash: true });
    setTimeout(() => GroupChat._react()?.patchTranscriptMessage(want.id, { flash: false }), 1500);
    return true;
  },

  // Where a message link's message is (#2387), when the first page did not
  // have it. The server's permalink window says whether it is a reply in a
  // reply thread — then the thread opens beside the channel — and otherwise
  // the stream pages back to it, a bounded number of pages, so the stream
  // stays one unbroken run to the present rather than a window with a gap.
  REVEAL_MAX_PAGES: 20,

  async _locateReveal(want) {
    const slug = want.slug;
    const live = () => GroupChat._pendingReveal === want && GroupChat.appSlug === slug;
    try {
      const res = await fetch(
        `/api/apps/${encodeURIComponent(slug)}/messages?around=${want.id}&limit=1${GroupChat._demoParam()}`
      );
      if (!live()) return;
      if (!res.ok) { GroupChat._pendingReveal = null; return; }
      const body = await res.json();
      const root = Number(body && body.focus && body.focus.thread_ref);
      if (Number.isSafeInteger(root) && root > 0 && root !== want.id) {
        GroupChat._pendingReveal = null;
        // On the project page, beside the channel there (#3653).
        if (GroupChat._openThreadInPage(slug, root)) return;
        const address = `#messages/app/${encodeURIComponent(slug)}/thread/${root}`;
        const messages = window.UsernodeReact?.messages;
        if (messages?.openAddress) messages.openAddress(address);
        else window.location.hash = address;
        return;
      }
      for (let page = 0; page < GroupChat.REVEAL_MAX_PAGES; page += 1) {
        if (!live()) return;
        if (GroupChat.messages.some((m) => Number(m && m.id) === want.id)) break;
        const oldest = Number(GroupChat.oldestMessageId);
        if (!GroupChat.hasMore || (oldest && oldest < want.id)) break;
        if (GroupChat._historyLoad) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          continue;
        }
        await GroupChat.loadHistory();
      }
      if (!live()) return;
      want.at = Date.now();
      GroupChat._applyPendingReveal();
    } catch {
      if (live()) GroupChat._pendingReveal = null;
    }
  },

  restoreScroll() {
    const container = document.getElementById('gc-messages');
    if (!container) return;
    if (!GroupChat._didInitialScroll) {
      // History hasn't loaded yet for this connection — defer; loadHistory
      // will scroll to bottom itself on completion.
      return;
    }
    if (GroupChat._lockedToBottom || GroupChat._savedScrollTop == null) {
      container.scrollTop = container.scrollHeight;
    } else {
      container.scrollTop = GroupChat._savedScrollTop;
    }
  },
};

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Render chat content with @mention highlighting. Mentions that match the
// current viewer's username get the `-self` variant so their own mentions
// stand out more than someone else's. A second pass (#130) chips PR#N / #N
// references so they read as navigable tokens.
// #2783: the viewer's channel handles — #general and one per app they are a
// member of — from the Messages store (features/messages/channels.ts), which
// is what decides whether a `#name` is a channel reference or just text.
// Empty until that store has loaded its lists, when a `#name` stays text.
function knownChannelHandles() {
  try {
    const list = window.UsernodeReact?.messages?.channels?.() || [];
    return new Set(list.map((item) => item.handle));
  } catch {
    return new Set();
  }
}

function renderWithMentions(raw) {
  const escaped = escapeHtml(raw || '');
  const me = (App.user?.username || '').toLowerCase();
  // B9: "@Homeroom bot" is one mention, the bot's display form.
  const withMentions = escaped.replace(/(^|[^\w])@([A-Za-z0-9_]{1,32}(?:(?<=homeroom) bot\b)?)/gi, (_m, pre, name) => {
    const isMe = name.toLowerCase() === me;
    const cls = isMe ? 'gc-mention gc-mention-self' : 'gc-mention';
    return `${pre}<span class="${cls}">@${name}</span>`;
  });
  return renderChannelChips(renderRefChips(withMentions));
}

// #2783: `#name` for a channel the viewer knows becomes a link to it. After
// the issue pass, which only takes digits, so `#123` is never a channel.
function renderChannelChips(html) {
  const handles = knownChannelHandles();
  if (!handles.size) return html;
  return html.replace(/(^|[^\w&;"=\/])#([A-Za-z][A-Za-z0-9-]{0,39})(?![\w-])/g, (m, pre, name) => {
    const handle = name.toLowerCase();
    if (!handles.has(handle)) return m;
    return `${pre}<a class="gc-channel-ref" href="#messages/channel/${handle}" data-channel-ref="${handle}">#${handle}</a>`;
  });
}

// #130: second replacement pass over the (already escaped, mention-marked)
// content — `PR#N` / `PR #N` render as violet PR chips and bare `#N` as
// emerald issue chips. One combined regex so `PR#12` is never double-matched
// by the issue pattern. The `&` exclusion in the boundary keeps escaped
// entities from chipping; the trailing lookahead keeps `#12abc` plain.
// Clicking / Enter / Space on a chip routes to AppView.revealInDrawer (see
// _attachQuoteHandlers) — refs are a pure display convention, so message
// content stays plain text on the wire and in the DB.
function renderRefChips(html) {
  return html.replace(/(^|[^\w&])(pr ?#|#)(\d{1,7})(?!\w)/gi, (_m, pre, prefix, num) => {
    const isPr = prefix.length > 1; // `PR#` / `PR #` vs bare `#`
    const cls = isPr ? 'gc-ref gc-ref-pr' : 'gc-ref gc-ref-issue';
    const type = isPr ? 'pr' : 'issue';
    const label = isPr ? `PR#${num}` : `#${num}`;
    return `${pre}<span class="${cls}" data-ref-type="${type}" data-ref-number="${num}" role="link" tabindex="0">${label}</span>`;
  });
}

// #328: the authoritative renderer for a USER message body. Renders a safe
// markdown subset via the shared DevChat.renderMarkdown (marked + DOMPurify,
// strict allowlist, https-only links, raw HTML escaped) and then layers the
// existing @mention + PR/issue-ref decoration on top. All three message
// surfaces (main chat, thread replies, inline edit) funnel through here so
// they format identically — keep new call sites pointed at this function.
//
// Why a DOM walk and not another regex pass: renderWithMentions runs its
// regexes over *escaped text*. After markdown the body is *sanitized HTML*,
// so a string regex could match inside an <a href> attribute, inside a
// <code>/<pre> literal, or straddle a tag — reintroducing exactly the
// injection the sanitizer just removed. Instead we parse the sanitized HTML
// and walk TEXT NODES ONLY, skipping anything inside <a>/<code>/<pre>, and
// build the mention/ref <span>s via DOM APIs (textContent / setAttribute) so
// no unsanitized HTML is ever re-created. Message content stays plain
// markdown source on the wire and in the DB — this is display-only.
//
// Falls back to the plain renderWithMentions path when the markdown libs /
// DevChat aren't available (CDN blocked, native shell, the test sandbox).
function renderMessageBody(raw) {
  const text = raw == null ? '' : String(raw);
  const renderMd = typeof DevChat !== 'undefined' && DevChat.renderMarkdown;
  if (!renderMd || typeof document === 'undefined' || !document.createElement) {
    return renderWithMentions(text);
  }
  let html;
  try {
    html = DevChat.renderMarkdown(text, { breaks: true });
  } catch {
    return renderWithMentions(text);
  }
  const root = document.createElement('div');
  root.innerHTML = html;
  decorateMentionsAndRefs(root);
  return root.innerHTML;
}

// Tags whose text content must stay literal: links (don't rewrite hrefs or
// double-link), and code spans/blocks (a `@name` or `#5` in code is source,
// not a mention/ref).
const GC_DECORATE_SKIP = new Set(['A', 'CODE', 'PRE']);

// Recursively walk `node`'s subtree, decorating eligible text nodes in place.
// Snapshots childNodes first because decorateTextNode mutates the list.
function decorateMentionsAndRefs(node) {
  const children = node.childNodes ? Array.prototype.slice.call(node.childNodes) : [];
  for (const child of children) {
    if (child.nodeType === 3) { // text node
      decorateTextNode(child);
    } else if (child.nodeType === 1) { // element
      const tag = (child.tagName || '').toUpperCase();
      if (GC_DECORATE_SKIP.has(tag)) continue;
      decorateMentionsAndRefs(child);
    }
  }
}

// Replace one text node with [text, <span class="gc-mention">…</span>,
// <span class="gc-ref">…</span>, …] when it contains mentions/refs.
function decorateTextNode(textNode) {
  const value = textNode.nodeValue != null ? textNode.nodeValue : (textNode.textContent || '');
  const me = (typeof App !== 'undefined' && App.user && App.user.username
    ? App.user.username : '').toLowerCase();
  const segs = tokenizeMentionsAndRefs(value, me, knownChannelHandles());
  if (segs.length === 1 && segs[0].type === 'text') return; // nothing to decorate
  const parent = textNode.parentNode;
  if (!parent) return;
  const frag = document.createDocumentFragment();
  for (const seg of segs) {
    if (seg.type === 'text') {
      frag.appendChild(document.createTextNode(seg.value));
    } else if (seg.type === 'mention') {
      const span = document.createElement('span');
      span.className = seg.isSelf ? 'gc-mention gc-mention-self' : 'gc-mention';
      span.textContent = `@${seg.name}`;
      frag.appendChild(span);
    } else if (seg.type === 'channel') {
      // #2783: a real link — see .gc-channel-ref in app.css for why it is
      // not a `.gc-ref`.
      const link = document.createElement('a');
      link.className = 'gc-channel-ref';
      link.setAttribute('href', `#messages/channel/${seg.handle}`);
      link.setAttribute('data-channel-ref', seg.handle);
      link.textContent = `#${seg.handle}`;
      frag.appendChild(link);
    } else { // ref
      const span = document.createElement('span');
      span.className = seg.isPr ? 'gc-ref gc-ref-pr' : 'gc-ref gc-ref-issue';
      span.setAttribute('data-ref-type', seg.isPr ? 'pr' : 'issue');
      span.setAttribute('data-ref-number', seg.num);
      span.setAttribute('role', 'link');
      span.setAttribute('tabindex', '0');
      span.textContent = seg.isPr ? `PR#${seg.num}` : `#${seg.num}`;
      frag.appendChild(span);
    }
  }
  parent.replaceChild(frag, textNode);
}

// Pure tokenizer (no DOM): split a raw text run into ordered segments of
// plain text, @mentions, and PR/issue refs. Mirrors the boundary + char-class
// rules of renderWithMentions/renderRefChips so behaviour matches the string
// path and the server-side mention parser (MENTION_CHARS, length 1..32). The
// leading boundary char each pattern requires is preserved as text. One
// combined regex so `PR#12` is never half-consumed by the bare `#N` pattern.
function tokenizeMentionsAndRefs(text, me, channels) {
  // #2783: a third alternative, `#name` for a channel — a letter first, so it
  // never competes with `#123`. Only a handle in `channels` is one; any other
  // `#word` is left as text.
  // B9: "@Homeroom bot", the bot's display form, is one mention too.
  const RE = /(^|[^\w])(@([A-Za-z0-9_]{1,32}(?:(?<=homeroom) bot\b)?)|(pr ?#|#)(\d{1,7})(?!\w)|#([A-Za-z][A-Za-z0-9-]{0,39})(?![\w-]))/gi;
  const known = channels || new Set();
  const segs = [];
  let pos = 0;
  let m;
  const pushText = (s) => {
    if (!s) return;
    const last = segs[segs.length - 1];
    if (last && last.type === 'text') last.value += s;
    else segs.push({ type: 'text', value: s });
  };
  while ((m = RE.exec(text)) !== null) {
    if (m[6] != null && !known.has(m[6].toLowerCase())) continue;
    pushText(text.slice(pos, m.index));
    pushText(m[1]); // boundary char (start-of-string is '')
    if (m[3] != null) {
      segs.push({ type: 'mention', name: m[3], isSelf: m[3].toLowerCase() === me });
    } else if (m[6] != null) {
      segs.push({ type: 'channel', handle: m[6].toLowerCase() });
    } else {
      segs.push({ type: 'ref', isPr: m[4].trim().length > 1, num: m[5] });
    }
    pos = m.index + m[0].length;
  }
  pushText(text.slice(pos));
  if (segs.length === 0) segs.push({ type: 'text', value: '' });
  return segs;
}

// ── #87: @mention autocomplete ─────────────────────────────────────────
//
// Composer dropdown that opens when the user types `@` in #gc-input and
// suggests usernames participating in this app's chat. Self-contained:
// the only integration points are MentionAutocomplete.attach() (called
// from AppView.renderGroupChatTab when the input is (re)created) and the
// shared `escapeHtml` helper above.
//
// Matching parity is the whole game (see spec): the trigger regex and the
// inserted text MUST use the same character class the server's MENTION_RE
// (`src/services/notifications.js`) recognizes — `[A-Za-z0-9_]`, length
// 1..32, only when the `@` is preceded by a non-word char or start. A
// suggestion that inserts a string the server won't parse as a mention is
// worse than no autocomplete, so both ends derive from MENTION_CHARS.
const MentionAutocomplete = {
  // Character class shared with the server-side mention parser.
  MENTION_CHARS: 'A-Za-z0-9_',
  MAX_LEN: 32,
  // How many filtered names to keep (the menu scrolls; CSS caps the
  // visible height). Plenty for prefix-filtered participant lists.
  MAX_RESULTS: 50,
  // Cache freshness: a stale list only means a just-joined user isn't
  // suggested yet, which is fine. Re-fetch when older than this.
  CACHE_TTL_MS: 2 * 60 * 1000,
  // The server caps the whole list at this many (src/routes/chat.js). A list
  // that long may have left somebody out, so a prefix it cannot fill is also
  // asked of the server by what was typed (?q=), as the hub's channel box
  // does (#3361).
  FULL_LIST: 500,
  PREFIX_DEBOUNCE_MS: 150,

  _cacheBySlug: new Map(), // slug -> { users: [username...], fetchedAt }
  _prefixBySlug: new Map(), // slug -> Map(lowercased prefix -> [username...])
  _prefixTimer: null,
  _prefixAsked: null, // `${slug}\n${prefix}` of the lookup in flight or due
  _input: null,
  _slug: null,
  _menu: null,
  _items: [],     // currently-shown usernames
  _active: -1,    // highlighted index into _items
  _open: false,
  _tokenStart: -1, // index of the `@` in input.value for the active token
  _composing: false,
  _dismissBound: null,

  get _triggerRe() {
    // Anchored to the caret: boundary (start or non-word char), `@`, then
    // up to MAX_LEN mention chars, end-of-substring.
    return new RegExp(
      `(^|[^${this.MENTION_CHARS}])@([${this.MENTION_CHARS}]{0,${this.MAX_LEN}})$`
    );
  },

  // Wire (or re-wire) the controller onto a freshly-rendered composer.
  // Idempotent per element; called on every group-chat tab mount. The
  // candidates are warmed when the box is focused, before the first
  // keystroke, rather than on every mount (see RefAutocomplete.attach).
  attach(input, slug) {
    if (!input) return;
    MentionAutocomplete._input = input;
    MentionAutocomplete._slug = slug;
    if (document.activeElement === input) MentionAutocomplete._loadCandidates(slug);

    if (input._gcMentionBound) return;
    input._gcMentionBound = true;

    input.addEventListener('focus', () => {
      if (MentionAutocomplete._input === input) MentionAutocomplete._loadCandidates(MentionAutocomplete._slug);
    });

    input.addEventListener('compositionstart', () => { MentionAutocomplete._composing = true; });
    input.addEventListener('compositionend', () => {
      MentionAutocomplete._composing = false;
      MentionAutocomplete._sync();
    });
    input.addEventListener('input', () => MentionAutocomplete._sync());
    input.addEventListener('click', () => MentionAutocomplete._sync());
    input.addEventListener('keyup', (e) => {
      // The keys we manage in the capture-phase keydown handler don't
      // change the token; skip re-detecting on their keyup.
      if (['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(e.key)) return;
      MentionAutocomplete._sync();
    });
    // Capture phase so we win over the composer's own keydown handler and
    // the form's implicit Enter-submit while the menu is open.
    input.addEventListener('keydown', (e) => MentionAutocomplete._onKeydown(e), true);
    input.addEventListener('blur', () => {
      // Defer so a mousedown on a menu option (which we preventDefault to
      // keep focus) can run first.
      setTimeout(() => { if (document.activeElement !== input) MentionAutocomplete.close(); }, 0);
    });
  },

  async _loadCandidates(slug) {
    if (!slug) return;
    const cached = MentionAutocomplete._cacheBySlug.get(slug);
    if (cached && (Date.now() - cached.fetchedAt) < MentionAutocomplete.CACHE_TTL_MS) return;
    try {
      const res = await fetch(`/api/apps/${slug}/mention-suggestions`);
      if (!res.ok) return;
      const { users, bot } = await res.json();
      const names = Array.isArray(users)
        ? users.map((u) => (u && u.username) || '').filter(Boolean)
        : [];
      // B9: Homeroom bot, when it answers this viewer on this project.
      MentionAutocomplete._cacheBySlug.set(slug, { users: names, bot: !!(bot && bot.username), fetchedAt: Date.now() });
      // What prefix lookups found is as old as the list it widened.
      MentionAutocomplete._prefixBySlug.delete(slug);
      // If the user already has an open `@token` while we were fetching,
      // refresh the menu now that we have data.
      if (MentionAutocomplete._input === document.activeElement) MentionAutocomplete._sync();
    } catch { /* offline / transient — next keystroke retries via TTL */ }
  },

  _candidates() {
    const c = MentionAutocomplete._cacheBySlug.get(MentionAutocomplete._slug);
    const whole = (c && c.users) || [];
    const asked = MentionAutocomplete._prefixBySlug.get(MentionAutocomplete._slug);
    if (!asked || !asked.size) return whole;
    // The whole list first (its order is the server's: friends, then the
    // people who have spoken), then anybody a prefix lookup found beyond it.
    const seen = new Set(whole);
    const out = whole.slice();
    for (const names of asked.values()) {
      for (const name of names) if (!seen.has(name)) { seen.add(name); out.push(name); }
    }
    return out;
  },

  // The whole list is capped and this prefix did not fill the menu from it:
  // ask the server for the people matching what has been typed. Debounced;
  // an answer is used only if the token under the caret is still the one
  // asked about, and a refusal or failure (a 429 included) is not
  // remembered, so a later keystroke asks again.
  _maybeLookup(query, shown) {
    const slug = MentionAutocomplete._slug;
    const c = MentionAutocomplete._cacheBySlug.get(slug);
    if (!slug || !query || !c || c.users.length < MentionAutocomplete.FULL_LIST) return;
    if (shown >= MentionAutocomplete.MAX_RESULTS) return;
    const key = query.toLowerCase();
    const asked = MentionAutocomplete._prefixBySlug.get(slug);
    if (asked && asked.has(key)) return;
    const id = `${slug}\n${key}`;
    if (MentionAutocomplete._prefixAsked === id) return;
    clearTimeout(MentionAutocomplete._prefixTimer);
    MentionAutocomplete._prefixAsked = id;
    MentionAutocomplete._prefixTimer = setTimeout(async () => {
      MentionAutocomplete._prefixTimer = null;
      let names = null;
      try {
        const res = await fetch(`/api/apps/${slug}/mention-suggestions?q=${encodeURIComponent(query)}`);
        if (res.ok) {
          const { users } = await res.json();
          names = Array.isArray(users) ? users.map((u) => (u && u.username) || '').filter(Boolean) : [];
        }
      } catch { /* offline / transient — the next keystroke asks again */ }
      if (MentionAutocomplete._prefixAsked === id) MentionAutocomplete._prefixAsked = null;
      if (!names) return;
      // Stale: the person has typed on, or moved to another room, since.
      const token = MentionAutocomplete._detectToken();
      if (MentionAutocomplete._slug !== slug || !token || token.query.toLowerCase() !== key) return;
      if (!MentionAutocomplete._prefixBySlug.has(slug)) MentionAutocomplete._prefixBySlug.set(slug, new Map());
      MentionAutocomplete._prefixBySlug.get(slug).set(key, names);
      MentionAutocomplete._sync();
    }, MentionAutocomplete.PREFIX_DEBOUNCE_MS);
  },

  // Detect an active mention token immediately before the caret.
  // Returns { start, query } or null.
  _detectToken() {
    const input = MentionAutocomplete._input;
    if (!input) return null;
    const caret = input.selectionStart;
    if (caret == null || caret !== input.selectionEnd) return null; // ignore ranges
    const before = input.value.slice(0, caret);
    const m = before.match(MentionAutocomplete._triggerRe);
    if (!m) return null;
    const query = m[2];
    const start = m.index + m[1].length; // index of the `@`
    return { start, query };
  },

  // B9: the bot's row in the list (its handle; it inserts its display form).
  BOT: 'homeroom_bot',
  BOT_NAME: 'Homeroom bot',

  _filter(query) {
    const q = query.toLowerCase();
    const out = [];
    // B9: Homeroom bot leads whenever what was typed matches it (a bare @ does).
    const c = MentionAutocomplete._cacheBySlug.get(MentionAutocomplete._slug);
    if (c && c.bot && (MentionAutocomplete.BOT.startsWith(q) || MentionAutocomplete.BOT_NAME.toLowerCase().replace(' ', '').startsWith(q))) {
      out.push(MentionAutocomplete.BOT);
    }
    for (const name of MentionAutocomplete._candidates()) {
      if (name.toLowerCase() === MentionAutocomplete.BOT) continue;
      if (!q || name.toLowerCase().startsWith(q)) {
        out.push(name);
        if (out.length >= MentionAutocomplete.MAX_RESULTS) break;
      }
    }
    return out;
  },

  // Re-evaluate the token under the caret and open/close/refresh the menu.
  _sync() {
    if (MentionAutocomplete._composing) return;
    const token = MentionAutocomplete._detectToken();
    if (!token) { MentionAutocomplete.close(); return; }
    const items = MentionAutocomplete._filter(token.query);
    MentionAutocomplete._maybeLookup(token.query, items.length);
    if (!items.length) { MentionAutocomplete.close(); return; }
    MentionAutocomplete._tokenStart = token.start;
    MentionAutocomplete._items = items;
    // Keep a valid highlighted row; reset to the top when the set changes.
    MentionAutocomplete._active = 0;
    MentionAutocomplete._render();
  },

  _ensureMenu() {
    if (MentionAutocomplete._menu) return MentionAutocomplete._menu;
    const menu = document.createElement('div');
    menu.id = 'gc-mention-menu';
    menu.className = 'gc-mention-menu hidden';
    menu.setAttribute('role', 'listbox');
    // mousedown (not click) so we can preventDefault and keep the input
    // focused — a blur-then-click would close the menu before the click.
    menu.addEventListener('mousedown', (e) => {
      const opt = e.target.closest('.gc-mention-option');
      if (!opt) return;
      e.preventDefault();
      MentionAutocomplete.accept(opt.dataset.username);
    });
    document.body.appendChild(menu);
    // The HOST stays ours — it is position:fixed, appended to the body,
    // measured against the composer on every render — and its CHILDREN are
    // features/group-chat/autocomplete.tsx's, mounted once here.
    window.UsernodeReact?.groupChat?.mountMentionMenu?.(menu);
    MentionAutocomplete._menu = menu;
    return menu;
  },

  _publish() {
    const me = (App.user?.username || '').toLowerCase();
    window.UsernodeReact?.groupChat?.publishMentionMenu?.(
      MentionAutocomplete._items.map((name) => ({
        username: name,
        // Decided here, where the viewer is known.
        you: name.toLowerCase() === me,
        // B9: Homeroom bot's row wears its name, its mark and its AI badge.
        ...(name === MentionAutocomplete.BOT ? { bot: true, displayName: MentionAutocomplete.BOT_NAME } : {}),
      })),
      MentionAutocomplete._active
    );
  },

  _render() {
    const menu = MentionAutocomplete._ensureMenu();
    // Publishing goes through flushSync (features/group-chat/mount.ts), so the
    // rows exist before _position() measures the menu's height on the line
    // after next — the synchronous contract the innerHTML assignment gave.
    MentionAutocomplete._publish();

    if (!MentionAutocomplete._open) {
      menu.classList.remove('hidden');
      MentionAutocomplete._open = true;
      MentionAutocomplete._bindDismiss();
    }
    MentionAutocomplete._position();
  },

  // Anchor above the composer (input lives at the bottom of the pane),
  // flipping below if it would clip the top. Matches the input width.
  _position() {
    const input = MentionAutocomplete._input;
    const menu = MentionAutocomplete._menu;
    if (!input || !menu) return;
    const r = input.getBoundingClientRect();
    menu.style.left = `${r.left}px`;
    menu.style.width = `${r.width}px`;
    const h = menu.offsetHeight || 0;
    let top = r.top - h - 4;
    if (top < 8) top = Math.min(r.bottom + 4, window.innerHeight - h - 8);
    menu.style.top = `${top}px`;
  },

  _bindDismiss() {
    if (MentionAutocomplete._dismissBound) return;
    MentionAutocomplete._dismissBound = (e) => {
      if (e.type === 'scroll') { MentionAutocomplete.close(); return; }
      if (MentionAutocomplete._menu && MentionAutocomplete._menu.contains(e.target)) return;
      if (e.target === MentionAutocomplete._input) return;
      MentionAutocomplete.close();
    };
    document.addEventListener('mousedown', MentionAutocomplete._dismissBound, true);
    const msgs = document.getElementById('gc-messages');
    if (msgs) msgs.addEventListener('scroll', MentionAutocomplete._dismissBound, true);
  },

  close() {
    if (!MentionAutocomplete._open) return;
    MentionAutocomplete._open = false;
    MentionAutocomplete._active = -1;
    MentionAutocomplete._items = [];
    MentionAutocomplete._tokenStart = -1;
    if (MentionAutocomplete._menu) {
      MentionAutocomplete._menu.classList.add('hidden');
      MentionAutocomplete._publish();
    }
    if (MentionAutocomplete._dismissBound) {
      document.removeEventListener('mousedown', MentionAutocomplete._dismissBound, true);
      const msgs = document.getElementById('gc-messages');
      if (msgs) msgs.removeEventListener('scroll', MentionAutocomplete._dismissBound, true);
      MentionAutocomplete._dismissBound = null;
    }
  },

  // An arrow key moves the highlight and nothing else. It used to walk every
  // option element toggling a class and scrolling the winner into view; the
  // class follows from the render now, and the scroll is an effect in
  // features/group-chat/autocomplete.tsx keyed on this index.
  _move(delta) {
    const n = MentionAutocomplete._items.length;
    if (!n) return;
    MentionAutocomplete._active = (MentionAutocomplete._active + delta + n) % n;
    MentionAutocomplete._publish();
  },

  // Capture-phase keydown. Consumes the event (preventing the composer's
  // own handler + the form's Enter-submit) only when the menu is open and
  // the key is one we own.
  _onKeydown(e) {
    if (!MentionAutocomplete._open) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault(); e.stopPropagation(); MentionAutocomplete._move(1); break;
      case 'ArrowUp':
        e.preventDefault(); e.stopPropagation(); MentionAutocomplete._move(-1); break;
      case 'Enter':
      case 'Tab': {
        const name = MentionAutocomplete._items[MentionAutocomplete._active];
        if (name) {
          e.preventDefault(); e.stopPropagation();
          MentionAutocomplete.accept(name);
        }
        break;
      }
      case 'Escape':
        e.preventDefault(); e.stopPropagation(); MentionAutocomplete.close(); break;
      default:
        break;
    }
  },

  // Replace the active `@token` with `@username ` (trailing space), keep
  // within maxlength, restore the caret, and fire a synthetic `input`
  // event so the composer's own handlers (draft persistence + typing
  // indicator) run exactly as if the user typed it.
  accept(username) {
    const input = MentionAutocomplete._input;
    if (!input || !username || MentionAutocomplete._tokenStart < 0) { MentionAutocomplete.close(); return; }
    const caret = input.selectionStart;
    const value = input.value;
    const before = value.slice(0, MentionAutocomplete._tokenStart);
    const after = value.slice(caret);
    // B9: the bot goes in as "@Homeroom bot", which the server reads as it.
    const insert = `@${username === MentionAutocomplete.BOT ? MentionAutocomplete.BOT_NAME : username} `;
    const next = before + insert + after;

    const max = parseInt(input.getAttribute('maxlength') || '0', 10);
    if (max && next.length > max) {
      // Wouldn't fit — leave the user's text untouched rather than
      // silently truncating their message.
      MentionAutocomplete.close();
      return;
    }

    input.value = next;
    const pos = (before + insert).length;
    input.setSelectionRange(pos, pos);
    MentionAutocomplete.close();
    input.focus();
    // Run the existing #gc-input `input` listener (draft save + sendTyping).
    input.dispatchEvent(new Event('input', { bubbles: true }));
  },
};

// ── #130: PR / issue reference autocomplete ─────────────────────────────
//
// Composer dropdown that opens when the user types `PR#` (open PRs only)
// or a bare `#` (open issues first, then open PRs) in #gc-input. Modeled
// directly on MentionAutocomplete above: same menu element pattern,
// capture-phase keydown, _detectToken/_sync/accept lifecycle, blur/dismiss
// handling, and positioning anchored above the composer. Candidates come
// from the endpoints the activity panel already uses (/promoted +
// /github-issues) — no new API.
//
// Unlike @mentions there is no server-side parser to stay in sync with:
// refs are a pure display convention (renderRefChips above), so the only
// contract is that accept() inserts the canonical `PR#N` / `#N` forms the
// renderer chips. Selecting a PR from the bare-`#` combined menu inserts
// the canonical `PR#N`, not `#N`.
const RefAutocomplete = {
  MAX_RESULTS: 50,
  // Stale list only means a just-opened PR/issue isn't suggested for a
  // couple of minutes (the issues endpoint is itself cached server-side
  // for 5) — users can still type the number manually and it chips fine.
  CACHE_TTL_MS: 2 * 60 * 1000,

  _cacheBySlug: new Map(), // slug -> { prs: [...], issues: [...], fetchedAt }
  _input: null,
  _slug: null,
  _menu: null,
  _items: [],      // currently-shown { number, title, kind: 'pr'|'issue' }
  _active: -1,
  _open: false,
  _tokenStart: -1, // index of the token start (the `P` or `#`) in input.value
  _composing: false,
  _dismissBound: null,

  // Anchored at the caret: boundary (start or non-word, non-& char), then
  // `PR#` / `PR #` (PR mode) or bare `#` (combined mode), then a
  // digits-only query, end of substring. Typing a non-digit after the `#`
  // stops matching and the menu closes. The `&` exclusion mirrors
  // renderRefChips' boundary so the dropdown never triggers where the
  // renderer wouldn't chip. The `@` vs `#` triggers are mutually exclusive
  // at one caret position, so this menu and MentionAutocomplete's can't
  // both be open at once.
  //
  // #2783: a bare `#` also offers the viewer's CHANNELS, and a query that
  // starts with a letter (`#gen`) narrows to them — the same split the
  // renderer makes, where `#123` is an issue and `#general` a channel.
  _triggerRe: /(^|[^\w&])(pr ?#|#)(\d{0,7}|[A-Za-z][A-Za-z0-9-]{0,39})$/i,

  // Wire (or re-wire) the controller onto a freshly-rendered composer.
  // Idempotent per element; called on every group-chat tab mount. Warms the
  // candidates when the box is focused — before the first keystroke, as it
  // always was — rather than on every mount: the list is the app's open
  // proposals and GitHub issues, a read no screen that merely SHOWS a chat
  // needed (on the platform app, two of the board's largest).
  attach(input, slug) {
    if (!input) return;
    RefAutocomplete._input = input;
    RefAutocomplete._slug = slug;
    if (document.activeElement === input) RefAutocomplete._loadCandidates(slug);

    if (input._gcRefBound) return;
    input._gcRefBound = true;

    input.addEventListener('focus', () => {
      if (RefAutocomplete._input === input) RefAutocomplete._loadCandidates(RefAutocomplete._slug);
    });

    input.addEventListener('compositionstart', () => { RefAutocomplete._composing = true; });
    input.addEventListener('compositionend', () => {
      RefAutocomplete._composing = false;
      RefAutocomplete._sync();
    });
    input.addEventListener('input', () => RefAutocomplete._sync());
    input.addEventListener('click', () => RefAutocomplete._sync());
    input.addEventListener('keyup', (e) => {
      if (['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(e.key)) return;
      RefAutocomplete._sync();
    });
    // Capture phase so we win over the composer's own keydown handler and
    // the form's implicit Enter-submit while the menu is open. Only
    // consumes keys while this menu is open, so it can't fight
    // MentionAutocomplete's identical handler.
    input.addEventListener('keydown', (e) => RefAutocomplete._onKeydown(e), true);
    input.addEventListener('blur', () => {
      setTimeout(() => { if (document.activeElement !== input) RefAutocomplete.close(); }, 0);
    });
  },

  async _loadCandidates(slug) {
    if (!slug) return;
    const cached = RefAutocomplete._cacheBySlug.get(slug);
    if (cached && (Date.now() - cached.fetchedAt) < RefAutocomplete.CACHE_TTL_MS) return;
    try {
      const [prRes, issueRes] = await Promise.all([
        // `results=failing`: numbers and titles are all this reads; the list
        // form is the Workshop's own spelling (AppView._listQS), so one copy.
        fetch(`/api/apps/${slug}/promoted?results=failing`),
        fetch(`/api/apps/${slug}/github-issues`),
      ]);
      const prData = prRes.ok ? await prRes.json() : {};
      const issueData = issueRes.ok ? await issueRes.json() : {};
      // Open (promoted/merging) PRs — the same set the drawer's "Open PRs"
      // section shows. Merged PRs are intentionally not suggested; they're
      // still clickable once rendered as chips.
      const prs = (Array.isArray(prData.promoted) ? prData.promoted : [])
        .filter((pr) => pr.pr_number != null)
        .map((pr) => ({ number: pr.pr_number, title: pr.pr_title || `by ${pr.username || ''}`, kind: 'pr' }));
      const issues = (Array.isArray(issueData.issues) ? issueData.issues : [])
        .map((i) => ({ number: i.number, title: i.title || '', kind: 'issue' }));
      RefAutocomplete._cacheBySlug.set(slug, { prs, issues, fetchedAt: Date.now() });
      // If the user already has an open token while we were fetching,
      // refresh the menu now that we have data.
      if (RefAutocomplete._input === document.activeElement) RefAutocomplete._sync();
    } catch { /* offline / transient — next keystroke retries via TTL */ }
  },

  // Detect an active ref token immediately before the caret.
  // Returns { start, query, mode: 'pr'|'combined' } or null.
  _detectToken() {
    const input = RefAutocomplete._input;
    if (!input) return null;
    const caret = input.selectionStart;
    if (caret == null || caret !== input.selectionEnd) return null; // ignore ranges
    const before = input.value.slice(0, caret);
    const m = before.match(RefAutocomplete._triggerRe);
    if (!m) return null;
    // A PR is a number, never a channel.
    if (m[2].length > 1 && !/^\d*$/.test(m[3])) return null;
    return {
      start: m.index + m[1].length,
      query: m[3],
      mode: m[2].length > 1 ? 'pr' : 'combined',
    };
  },

  // Prefix-match on the stringified number ("1" matches #1, #12, #130).
  // Combined mode lists the issues block first, then PRs.
  _filter(query, mode) {
    const c = RefAutocomplete._cacheBySlug.get(RefAutocomplete._slug) || {};
    const q = String(query || '').toLowerCase();
    // #2783: the viewer's channels, from the Messages store. Offered on a
    // bare `#` (after the issues and PRs) and alone once the query is a word.
    let channels = [];
    if (mode !== 'pr' && !/^\d+$/.test(q)) {
      try {
        channels = (window.UsernodeReact?.messages?.channels?.() || [])
          .map((item) => ({ number: item.handle, title: item.name || '', kind: 'channel' }));
      } catch { channels = []; }
    }
    const word = /^[a-z]/.test(q);
    const pool = mode === 'pr'
      ? (c.prs || [])
      : word ? channels : [...(c.issues || []), ...(c.prs || []), ...channels];
    const out = [];
    for (const item of pool) {
      if (!q || String(item.number).toLowerCase().startsWith(q)) {
        out.push(item);
        if (out.length >= RefAutocomplete.MAX_RESULTS) break;
      }
    }
    return out;
  },

  // Re-evaluate the token under the caret and open/close/refresh the menu.
  _sync() {
    if (RefAutocomplete._composing) return;
    const token = RefAutocomplete._detectToken();
    if (!token) { RefAutocomplete.close(); return; }
    const items = RefAutocomplete._filter(token.query, token.mode);
    if (!items.length) { RefAutocomplete.close(); return; }
    RefAutocomplete._tokenStart = token.start;
    RefAutocomplete._items = items;
    RefAutocomplete._active = 0;
    RefAutocomplete._render();
  },

  _ensureMenu() {
    if (RefAutocomplete._menu) return RefAutocomplete._menu;
    const menu = document.createElement('div');
    menu.id = 'gc-ref-menu';
    // Reuse the mention menu/option styling so positioning + theming come
    // for free; gc-ref-option only widens the row gap for the badge.
    menu.className = 'gc-mention-menu hidden';
    menu.setAttribute('role', 'listbox');
    // mousedown (not click) so we can preventDefault and keep the input
    // focused — a blur-then-click would close the menu before the click.
    menu.addEventListener('mousedown', (e) => {
      const opt = e.target.closest('.gc-mention-option');
      if (!opt) return;
      e.preventDefault();
      RefAutocomplete.accept(opt.dataset.kind, opt.dataset.number);
    });
    document.body.appendChild(menu);
    // Same split as the mention menu: ours to place, React's to fill.
    window.UsernodeReact?.groupChat?.mountRefMenu?.(menu);
    RefAutocomplete._menu = menu;
    return menu;
  },

  _publish() {
    window.UsernodeReact?.groupChat?.publishRefMenu?.(
      RefAutocomplete._items.map((item) => ({
        kind: item.kind,
        number: item.number,
        title: item.title || '',
      })),
      RefAutocomplete._active
    );
  },

  _render() {
    const menu = RefAutocomplete._ensureMenu();
    // Publishing goes through flushSync (features/group-chat/mount.ts), so the
    // rows exist before _position() measures the menu's height on the line
    // after next — the synchronous contract the innerHTML assignment gave.
    RefAutocomplete._publish();

    if (!RefAutocomplete._open) {
      menu.classList.remove('hidden');
      RefAutocomplete._open = true;
      RefAutocomplete._bindDismiss();
    }
    RefAutocomplete._position();
  },

  // Anchor above the composer, flipping below if it would clip the top.
  // Matches the input width — same mechanics as MentionAutocomplete.
  _position() {
    const input = RefAutocomplete._input;
    const menu = RefAutocomplete._menu;
    if (!input || !menu) return;
    const r = input.getBoundingClientRect();
    menu.style.left = `${r.left}px`;
    menu.style.width = `${r.width}px`;
    const h = menu.offsetHeight || 0;
    let top = r.top - h - 4;
    if (top < 8) top = Math.min(r.bottom + 4, window.innerHeight - h - 8);
    menu.style.top = `${top}px`;
  },

  _bindDismiss() {
    if (RefAutocomplete._dismissBound) return;
    RefAutocomplete._dismissBound = (e) => {
      if (e.type === 'scroll') { RefAutocomplete.close(); return; }
      if (RefAutocomplete._menu && RefAutocomplete._menu.contains(e.target)) return;
      if (e.target === RefAutocomplete._input) return;
      RefAutocomplete.close();
    };
    document.addEventListener('mousedown', RefAutocomplete._dismissBound, true);
    const msgs = document.getElementById('gc-messages');
    if (msgs) msgs.addEventListener('scroll', RefAutocomplete._dismissBound, true);
  },

  close() {
    if (!RefAutocomplete._open) return;
    RefAutocomplete._open = false;
    RefAutocomplete._active = -1;
    RefAutocomplete._items = [];
    RefAutocomplete._tokenStart = -1;
    if (RefAutocomplete._menu) {
      RefAutocomplete._menu.classList.add('hidden');
      RefAutocomplete._publish();
    }
    if (RefAutocomplete._dismissBound) {
      document.removeEventListener('mousedown', RefAutocomplete._dismissBound, true);
      const msgs = document.getElementById('gc-messages');
      if (msgs) msgs.removeEventListener('scroll', RefAutocomplete._dismissBound, true);
      RefAutocomplete._dismissBound = null;
    }
  },

  // Same as the mention menu's: the index is the state, the class and the
  // scroll follow from it.
  _move(delta) {
    const n = RefAutocomplete._items.length;
    if (!n) return;
    RefAutocomplete._active = (RefAutocomplete._active + delta + n) % n;
    RefAutocomplete._publish();
  },

  // Capture-phase keydown. Consumes the event only when the menu is open
  // and the key is one we own.
  _onKeydown(e) {
    if (!RefAutocomplete._open) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault(); e.stopPropagation(); RefAutocomplete._move(1); break;
      case 'ArrowUp':
        e.preventDefault(); e.stopPropagation(); RefAutocomplete._move(-1); break;
      case 'Enter':
      case 'Tab': {
        const item = RefAutocomplete._items[RefAutocomplete._active];
        if (item) {
          e.preventDefault(); e.stopPropagation();
          RefAutocomplete.accept(item.kind, item.number);
        }
        break;
      }
      case 'Escape':
        e.preventDefault(); e.stopPropagation(); RefAutocomplete.close(); break;
      default:
        break;
    }
  },

  // Replace the active token with the canonical form — `PR#N ` for a PR,
  // `#N ` for an issue (trailing space) — keep within maxlength, restore
  // the caret, and fire a synthetic `input` event so draft persistence and
  // the typing indicator run exactly as if the user typed it.
  accept(kind, number) {
    const input = RefAutocomplete._input;
    if (!input || !number || RefAutocomplete._tokenStart < 0) { RefAutocomplete.close(); return; }
    const caret = input.selectionStart;
    const value = input.value;
    const before = value.slice(0, RefAutocomplete._tokenStart);
    const after = value.slice(caret);
    const insert = kind === 'pr' ? `PR#${number} ` : `#${number} `; // a channel is `#handle `
    const next = before + insert + after;

    const max = parseInt(input.getAttribute('maxlength') || '0', 10);
    if (max && next.length > max) {
      // Wouldn't fit — leave the user's text untouched rather than
      // silently truncating their message.
      RefAutocomplete.close();
      return;
    }

    input.value = next;
    const pos = (before + insert).length;
    input.setSelectionRange(pos, pos);
    RefAutocomplete.close();
    input.focus();
    input.dispatchEvent(new Event('input', { bubbles: true }));
  },
};

// ── `:shortcode` emoji autocomplete ─────────────────────────────────────
//
// Discord's `:th` → "Emoji matching :th" → `👍 :thumbsup:`, in #gc-input and
// #gc-thread-input. Modeled on MentionAutocomplete and RefAutocomplete above:
// same body-level menu host (`#gc-emoji-menu`, children React's —
// features/group-chat/autocomplete.tsx), same capture-phase keydown, same
// _detectToken/_sync/accept lifecycle, same dismiss and positioning. Two
// differences:
//
//   - The matching is not here. The emoji, their shortcodes and the token
//     rules are features/message-actions/emoji-shortcodes.ts, which the
//     Messages composer uses directly; this module calls the same functions
//     through window.UsernodeReact.groupChat. Before the bundle has loaded
//     there is nothing to call, and the menu simply does not open.
//   - A complete, known `:tada:` becomes 🎉 the moment its closing colon is
//     typed, menu or no menu (_convert, from the `input` listener).
//
// A `:` only starts a token at the start of the text or after whitespace or
// an opening bracket, so `10:30` and `https://` never open it, and the query
// is name characters only — so it never shares a caret with an `@name` or a
// `#123` token, and at most one of the three menus is open at once.
const EmojiAutocomplete = {
  MAX_RESULTS: 8,

  _input: null,
  _menu: null,
  _items: [],      // currently-shown { emoji, shortcode }
  _active: -1,
  _open: false,
  _tokenStart: -1, // index of the `:` in input.value for the active token
  _query: '',
  _composing: false,
  _dismissBound: null,

  _api() {
    const api = window.UsernodeReact?.groupChat;
    return api && typeof api.emojiShortcodeToken === 'function' ? api : null;
  },

  // Wire (or re-wire) the controller onto a freshly-rendered composer.
  // Idempotent per element; called on every group-chat tab mount and every
  // thread mount. Each listener re-targets the controller at ITS input, so
  // the general composer and an open thread's never answer for each other.
  attach(input) {
    if (!input) return;
    EmojiAutocomplete._input = input;

    if (input._gcEmojiBound) return;
    input._gcEmojiBound = true;

    const own = () => {
      if (EmojiAutocomplete._input !== input) {
        EmojiAutocomplete.close();
        EmojiAutocomplete._input = input;
      }
    };
    input.addEventListener('compositionstart', () => { EmojiAutocomplete._composing = true; });
    input.addEventListener('compositionend', () => {
      EmojiAutocomplete._composing = false;
      own(); EmojiAutocomplete._sync();
    });
    input.addEventListener('input', (e) => {
      own();
      // Only a typed colon completes a code — not a paste, and not the
      // synthetic `input` accept() and _convert() dispatch themselves.
      if (e.inputType === 'insertText' && e.data === ':' && EmojiAutocomplete._convert()) return;
      EmojiAutocomplete._sync();
    });
    input.addEventListener('click', () => { own(); EmojiAutocomplete._sync(); });
    input.addEventListener('keyup', (e) => {
      if (['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(e.key)) return;
      own(); EmojiAutocomplete._sync();
    });
    // Capture phase so we win over the composer's own keydown handler and
    // the form's implicit Enter-submit while the menu is open. Only
    // consumes keys while this menu is open, so it can't fight the mention
    // and reference menus' identical handlers.
    input.addEventListener('keydown', (e) => {
      if (EmojiAutocomplete._input === input) EmojiAutocomplete._onKeydown(e);
    }, true);
    input.addEventListener('blur', () => {
      setTimeout(() => { if (document.activeElement !== input) EmojiAutocomplete.close(); }, 0);
    });
  },

  // Detect an active `:query` immediately before the caret.
  // Returns { start, query } or null.
  _detectToken() {
    const input = EmojiAutocomplete._input;
    const api = EmojiAutocomplete._api();
    if (!input || !api) return null;
    return api.emojiShortcodeToken(input.value, input.selectionStart, input.selectionEnd);
  },

  // Re-evaluate the token under the caret and open/close/refresh the menu.
  _sync() {
    if (EmojiAutocomplete._composing) return;
    const token = EmojiAutocomplete._detectToken();
    if (!token) { EmojiAutocomplete.close(); return; }
    const items = EmojiAutocomplete._api().matchEmojiShortcodes(token.query, EmojiAutocomplete.MAX_RESULTS);
    if (!items.length) { EmojiAutocomplete.close(); return; }
    EmojiAutocomplete._tokenStart = token.start;
    EmojiAutocomplete._query = token.query;
    EmojiAutocomplete._items = items;
    EmojiAutocomplete._active = 0;
    EmojiAutocomplete._render();
  },

  _ensureMenu() {
    if (EmojiAutocomplete._menu) return EmojiAutocomplete._menu;
    const menu = document.createElement('div');
    menu.id = 'gc-emoji-menu';
    // The mention menu's box; its rows are gc-mention-option too, so the
    // hover and highlight are theirs. No role on the host: the heading is not
    // an option, so the listbox is a child (autocomplete.tsx).
    menu.className = 'gc-mention-menu gc-emoji-menu hidden';
    // mousedown (not click) so we can preventDefault and keep the input
    // focused — a blur-then-click would close the menu before the click.
    menu.addEventListener('mousedown', (e) => {
      const opt = e.target.closest('.gc-emoji-option');
      if (!opt) return;
      e.preventDefault();
      EmojiAutocomplete.accept(opt.dataset.emoji);
    });
    document.body.appendChild(menu);
    // Same split as the other two menus: ours to place, React's to fill.
    window.UsernodeReact?.groupChat?.mountEmojiMenu?.(menu);
    EmojiAutocomplete._menu = menu;
    return menu;
  },

  _publish() {
    window.UsernodeReact?.groupChat?.publishEmojiMenu?.(
      EmojiAutocomplete._query,
      EmojiAutocomplete._items.map((item) => ({ emoji: item.emoji, shortcode: item.shortcode })),
      EmojiAutocomplete._active
    );
  },

  _render() {
    const menu = EmojiAutocomplete._ensureMenu();
    // Publishing goes through flushSync (features/group-chat/mount.ts), so the
    // rows exist before _position() measures the menu's height.
    EmojiAutocomplete._publish();

    if (!EmojiAutocomplete._open) {
      menu.classList.remove('hidden');
      EmojiAutocomplete._open = true;
      EmojiAutocomplete._bindDismiss();
    }
    EmojiAutocomplete._position();
  },

  // Anchor above the composer, flipping below if it would clip the top.
  // Matches the input width — same mechanics as MentionAutocomplete.
  _position() {
    const input = EmojiAutocomplete._input;
    const menu = EmojiAutocomplete._menu;
    if (!input || !menu) return;
    const r = input.getBoundingClientRect();
    menu.style.left = `${r.left}px`;
    menu.style.width = `${r.width}px`;
    const h = menu.offsetHeight || 0;
    let top = r.top - h - 4;
    if (top < 8) top = Math.min(r.bottom + 4, window.innerHeight - h - 8);
    menu.style.top = `${top}px`;
  },

  _bindDismiss() {
    if (EmojiAutocomplete._dismissBound) return;
    EmojiAutocomplete._dismissBound = (e) => {
      if (e.type === 'scroll') { EmojiAutocomplete.close(); return; }
      if (EmojiAutocomplete._menu && EmojiAutocomplete._menu.contains(e.target)) return;
      if (e.target === EmojiAutocomplete._input) return;
      EmojiAutocomplete.close();
    };
    document.addEventListener('mousedown', EmojiAutocomplete._dismissBound, true);
    const msgs = document.getElementById('gc-messages');
    if (msgs) msgs.addEventListener('scroll', EmojiAutocomplete._dismissBound, true);
  },

  close() {
    if (!EmojiAutocomplete._open) return;
    EmojiAutocomplete._open = false;
    EmojiAutocomplete._active = -1;
    EmojiAutocomplete._items = [];
    EmojiAutocomplete._tokenStart = -1;
    EmojiAutocomplete._query = '';
    if (EmojiAutocomplete._menu) {
      EmojiAutocomplete._menu.classList.add('hidden');
      EmojiAutocomplete._publish();
    }
    if (EmojiAutocomplete._dismissBound) {
      document.removeEventListener('mousedown', EmojiAutocomplete._dismissBound, true);
      const msgs = document.getElementById('gc-messages');
      if (msgs) msgs.removeEventListener('scroll', EmojiAutocomplete._dismissBound, true);
      EmojiAutocomplete._dismissBound = null;
    }
  },

  // The index is the state; the class and the scroll follow from it.
  _move(delta) {
    const n = EmojiAutocomplete._items.length;
    if (!n) return;
    EmojiAutocomplete._active = (EmojiAutocomplete._active + delta + n) % n;
    EmojiAutocomplete._publish();
  },

  // Capture-phase keydown. Consumes the event only when the menu is open
  // and the key is one we own.
  _onKeydown(e) {
    if (!EmojiAutocomplete._open || e.isComposing) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault(); e.stopPropagation(); EmojiAutocomplete._move(1); break;
      case 'ArrowUp':
        e.preventDefault(); e.stopPropagation(); EmojiAutocomplete._move(-1); break;
      case 'Enter':
      case 'Tab': {
        if (e.key === 'Tab' && e.shiftKey) break;
        const item = EmojiAutocomplete._items[EmojiAutocomplete._active];
        if (item) {
          e.preventDefault(); e.stopPropagation();
          EmojiAutocomplete.accept(item.emoji);
        }
        break;
      }
      case 'Escape':
        e.preventDefault(); e.stopPropagation(); EmojiAutocomplete.close(); break;
      default:
        break;
    }
  },

  // Put `emoji` and a space where the `:query` token was, restore the caret,
  // and fire a synthetic `input` event so draft persistence and the typing
  // indicator run exactly as if the user typed it.
  accept(emoji) {
    const input = EmojiAutocomplete._input;
    if (!input || !emoji || EmojiAutocomplete._tokenStart < 0) { EmojiAutocomplete.close(); return; }
    const caret = input.selectionStart;
    const value = input.value;
    const before = value.slice(0, EmojiAutocomplete._tokenStart);
    const insert = `${emoji} `;
    const next = before + insert + value.slice(caret);
    // `:query` is at least three characters and an emoji plus a space at
    // most four, but the maxlength rule is the other menus', so keep it.
    const max = parseInt(input.getAttribute('maxlength') || '0', 10);
    if (max && next.length > max) { EmojiAutocomplete.close(); return; }

    input.value = next;
    const pos = (before + insert).length;
    input.setSelectionRange(pos, pos);
    EmojiAutocomplete.close();
    input.focus();
    input.dispatchEvent(new Event('input', { bubbles: true }));
  },

  // A typed closing colon that completes a known code — `:tada:` — swaps the
  // code for its emoji in place. True when it did (the synthetic `input` it
  // dispatches has already re-synced every menu).
  _convert() {
    const input = EmojiAutocomplete._input;
    const api = EmojiAutocomplete._api();
    if (!input || !api || input.selectionStart !== input.selectionEnd) return false;
    const done = api.completedEmojiShortcode(input.value, input.selectionStart);
    if (!done) return false;
    const value = input.value;
    input.value = value.slice(0, done.start) + done.emoji + value.slice(done.end);
    const pos = done.start + done.emoji.length;
    input.setSelectionRange(pos, pos);
    EmojiAutocomplete.close();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  },
};

// Expose on window so app.js's WS dispatcher can reconcile the in-chat
// unread dots on notification events. (A top-level `const` is a lexical
// global accessible by bare name within the realm, but is NOT a property
// of `window` — mirror the `window.Notifications` pattern explicitly.)
window.GroupChat = GroupChat;
window.MentionAutocomplete = MentionAutocomplete;
window.RefAutocomplete = RefAutocomplete;
window.EmojiAutocomplete = EmojiAutocomplete;
