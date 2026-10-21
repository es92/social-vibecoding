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
  // While a card of theirs is still going, the cards are read again now and
  // then (_followBotCards): the timer, or null.
  _botCardsTimer: null,
  _botWorkListener: null,
  typingUsers: new Map(),
  typingTimeout: null,
  oldestMessageId: null,
  hasMore: true,
  _historyLoad: null,
  // The general stream's catch-up state (#4177): `_latestLoad` is the
  // catch-up in flight; `_streamLoaded` says its first page has loaded, even
  // an empty one; the rest are `_general`'s, explained in "One rule for every
  // read of a chat stream" below.
  _latestLoad: null,
  _latestAgain: false,
  _streamLoaded: false,
  _streamStale: false,
  _syncedMax: -Infinity,
  // One array per read in flight: the socket events that arrived meanwhile.
  _liveWindows: new Set(),
  // Scroll-position memory. `_lockedToBottom` drives "should new incoming
  // messages auto-scroll?". `_savedScrollTop` is the last observed scroll
  // offset so we can restore it when the tab is re-mounted (group-chat DOM
  // is destroyed on every tab switch, but GroupChat state persists for as
  // long as we stay inside the same app).
  _lockedToBottom: true,
  // The open thread's own: whether its reader is at the newest line, from
  // where they last scrolled it (`_attachThreadFollow`).
  _threadPinned: false,
  // Whether the open topic page has been put at its top (renderThread), which
  // it is once per mount (mountThread).
  _threadPlaced: false,
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
  threads: new Map(),       // key -> see `_threadState`
  // #2992: the general stream's first history request failed, so the
  // transcript offers "Try again" instead of an empty (or quiet) channel.
  _historyFailed: false,
  activeThread: null,       // { type, ref } | null — the mounted thread
  _threadTypingTimer: null,
  // #4640: the container the open thread was mounted INTO. The Workshop side
  // panel is portalled to the end of <body>, while #messages-screen's reply
  // pane keeps a hidden thread shell of its own — so a lookup by document
  // id found the hidden pane and drew the panel's discussion into it, leaving
  // the panel's own box empty. Every thread lookup goes through `_threadEl`,
  // which scopes to this container when one is mounted.
  _threadHost: null,
  _threadEl(id) {
    return GroupChat._threadHost
      ? GroupChat._threadHost.querySelector('#' + id)
      : document.getElementById(id);
  },

  // ── #4417 follow-up: the channel the general pane shows ─────────────
  //
  // Null is the app's own general stream. A project's TOPIC channel
  // (`{ type: 'category', ref }`, dev-board/workshop/project-discussion.tsx
  // TopicChannel) is the general stream one level down, as the server reads
  // it (src/routes/chat.js selectStream): its own messages, and the replies
  // of the reply threads that start in it. So it is the same pane, read and
  // written by the same paths, and its messages open their reply threads
  // beside it as #general's do. Only the scope differs: every read names
  // the channel, every send and typing frame carries it, and the socket's
  // frames are sorted by it (`_isChannel`).
  _channel: null,

  // The channel a mount names (`app.channel`), normalised, or null.
  _channelOf(app) {
    const c = app && app.channel;
    const ref = c ? Number(c.ref) : NaN;
    if (!c || c.type !== 'category' || !Number.isSafeInteger(ref) || ref <= 0 || ref > 2147483647) return null;
    const markers = Array.isArray(c.markers) && c.markers.length ? c.markers : null;
    return { type: 'category', ref, ...(markers ? { markers } : {}) };
  },

  // Is `scope` the stream the general pane shows? A frame's `thread`, or a
  // reply root's own place (`{ type: root.thread_type, ref: root.thread_ref }`);
  // no type is the app's general stream.
  _isChannel(scope) {
    const c = GroupChat._channel;
    if (!scope || !scope.type) return !c;
    return !!c && scope.type === c.type && Number(scope.ref) === c.ref;
  },

  // The open channel's ref, or null for the general stream.
  _channelRef() {
    return GroupChat._channel ? GroupChat._channel.ref : null;
  },

  threadKey(type, ref) {
    return `${type}:${ref}`;
  },

  _threadState(type, ref) {
    const key = GroupChat.threadKey(type, ref);
    if (!GroupChat.threads.has(key)) {
      // `stale`, `again`, `syncedMax`, `read`: the catch-up state, see "One
      // rule for every read of a chat stream" (#4177).
      GroupChat.threads.set(key, {
        messages: [], oldestId: null, hasMore: true, loaded: false, loading: false, failed: false,
        stale: false, again: false, syncedMax: -Infinity, read: null,
      });
    }
    return GroupChat.threads.get(key);
  },

  /**
   * The app the CURRENT mount is about, when the caller named one — see
   * mount(), and mountThread(), whose `app` replaces it. Null means "ask
   * AppView", which is what the app view's own mount wants and what every
   * path did before this existed.
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
    // #4417 follow-up: the channel this mount shows (null: the general stream).
    const channel = GroupChat._channelOf(GroupChat._app);
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
    // #4417 follow-up: another channel of the same app (#general and a
    // topic, or two topics): the socket stays, and the stream starts over
    // from it (`_showChannel` publishes the pane, as render() below does).
    const here = GroupChat.appSlug === appSlug && liveWs;
    if (here && (channel ? channel.ref : null) !== GroupChat._channelRef()) {
      GroupChat._showChannel(channel);
      return;
    }
    // The same channel: the cards it draws by time may have moved.
    if (here && channel) GroupChat._channel = channel;
    if (GroupChat.appSlug === appSlug && liveWs) {
      GroupChat.render();
      // #4177: a catch-up still owed (the last one failed) runs on the way in;
      // one on the wire already will settle it.
      if (GroupChat._streamStale && !GroupChat._latestLoad) void GroupChat._refreshLatest(null);
      GroupChat.attachScrollHandlers();
      GroupChat.restoreScroll();
      GroupChat._applyPendingReveal();
      // Loaded off screen and still unread: open at the first.
      GroupChat._openAtUnread();
      // #2387: coming back to a channel whose socket stayed up is opening it
      // too — what arrived while it was off screen is read now. After this
      // turn, once the remounted transcript is on the page.
      setTimeout(() => { if (GroupChat.appSlug === appSlug) void GroupChat.markRead(); }, 0);
      return;
    }
    GroupChat.connect(appSlug, channel);
  },

  // #4417 follow-up: the general pane moves to another channel of the app
  // whose socket is up. The socket and the thread caches stay; the stream
  // starts over as a newly opened app's does, read from that channel, and a
  // read still on the wire for the one it leaves is dropped as it lands
  // (`_historyLoad`, `_latestLoad`).
  _showChannel(channel) {
    GroupChat._historyLoad = null;
    GroupChat._resetStreamCatchUp();
    GroupChat._channel = channel || null;
    GroupChat.messages = [];
    GroupChat.oldestMessageId = null;
    GroupChat.hasMore = true;
    GroupChat._historyFailed = false;
    GroupChat._lockedToBottom = true;
    GroupChat._savedScrollTop = null;
    GroupChat._didInitialScroll = false;
    GroupChat._readUpTo = 0;
    GroupChat._unreadHold = null;
    GroupChat._unreadMark = null;
    GroupChat._unreadOpened = false;
    GroupChat.typingUsers.clear();
    // A quote staged in the pane's composer was about the channel it left.
    if (GroupChat.replyDraft && GroupChat.replyDraftScope !== 'thread') GroupChat.clearQuote();
    GroupChat.render();
    GroupChat.attachScrollHandlers();
    void GroupChat.loadHistory();
  },

  connect(appSlug, channel = null) {
    // #4640: a thread open on THIS app survives the reset. connect() used to
    // null activeThread unconditionally, so a Workshop side-panel discussion
    // (or any mounted thread) opened before a reconnect was orphaned:
    // renderThread no-oped from then on and the panel never filled in.
    const keep = GroupChat.appSlug === appSlug ? GroupChat.activeThread : null;
    GroupChat.disconnect();
    GroupChat.appSlug = appSlug;
    // #4417 follow-up: the channel the general stream is (null: the app's own).
    GroupChat._channel = channel || null;
    GroupChat.messages = [];
    GroupChat.threads = new Map();
    // B9: another project's cards and door are not this one's.
    GroupChat._botCards = new Map();
    GroupChat._botHere = false;
    GroupChat.activeThread = null;
    GroupChat.oldestMessageId = null;
    GroupChat.hasMore = true;
    GroupChat._resetStreamCatchUp();
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
    // And where reading stood when it opened (_takeUnreadMark).
    GroupChat._unreadMark = null;
    GroupChat._unreadOpened = false;
    GroupChat._longPressed = false;
    GroupChat._pressActive = false;
    GroupChat._clearPressTimer();
    GroupChat._closeReactionBar();
    GroupChat.activeThread = keep;

    GroupChat._openSocket();
    GroupChat.attachScrollHandlers();
    // #4177: the re-reads this socket cannot see for itself (the events
    // socket reconnecting, the tab coming back, the worker's corrections).
    GroupChat._watchLiveReads();
    // The Homeroom bot started or finished work for the viewer: their cards
    // under its requests may have moved (botWorkChanged). Listened for once.
    if (!GroupChat._botWorkListener && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      GroupChat._botWorkListener = () => GroupChat.botWorkChanged();
      window.addEventListener('homeroom-bot-work-changed', GroupChat._botWorkListener);
    }
    // #4640: the thread this reset kept was read against the map the reset
    // dropped. The same pair refreshAfterBlock uses: repaint the shell (its
    // host, `#gc-thread-messages`, travels in `_threadHost`) and re-read the
    // history, whose per-thread cache went with the old map. A thread of
    // another app still starts with no thread, as before.
    if (keep) {
      GroupChat.renderThread();
      // A `closed` change's thread is not read at all (see mountThread).
      if (!keep.closed) void GroupChat.loadThreadHistory(keep.type, keep.ref);
    }
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
      // flush in order, and what is held catches up with what was sent
      // while disconnected. It used to call loadHistory(), which on a
      // stream that already had a page asks for the OLDER one before it
      // (#4177): the messages missed during the drop never arrived.
      GroupChat._reconnectAttempts = 0;
      GroupChat._flushPendingOutgoing();
      GroupChat._renderStatusLine();
      GroupChat.resyncLoaded();
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
    GroupChat._resetStreamCatchUp();
    if (GroupChat._botCardsTimer) {
      clearTimeout(GroupChat._botCardsTimer);
      GroupChat._botCardsTimer = null;
    }
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

  // A block changes which persisted posts this viewer may see. Drop every
  // cached page (including topic discussions) before reloading from the
  // filtered API; an in-flight fetch may no longer publish its old result.
  refreshAfterBlock() {
    GroupChat._historyLoad = null;
    GroupChat._resetStreamCatchUp();
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
    // #4177: an older page waits for a catch-up on the wire, which can start
    // the stream over and move the cursor this page reads from (and for the
    // one queued behind it, which starts as that one lands).
    while (GroupChat._latestLoad) await GroupChat._latestLoad;
    if (!GroupChat.appSlug || GroupChat._historyLoad) return;
    const load = {};
    GroupChat._historyLoad = load;
    const isFirstLoad = !GroupChat.oldestMessageId;
    // #4177: what the socket delivers or changes during the read stays on its
    // answer; a first page also keeps what it delivered before (`_takeNewest`).
    const events = GroupChat._openLiveLog(GroupChat.messages);
    let ok = false;
    try {
      // #4417 follow-up: a topic's channel reads its own stream, by the
      // same addresses its pages had as a thread (`_firstPageUrl`).
      const channel = GroupChat._channel;
      const url = channel
        ? (GroupChat.oldestMessageId
          ? `${GroupChat._threadQuery(GroupChat.appSlug, channel)}&limit=50&before=${GroupChat.oldestMessageId}`
          : GroupChat._firstPageUrl(GroupChat.appSlug, null))
        : GroupChat.oldestMessageId
          ? `/api/apps/${GroupChat.appSlug}/messages?before=${GroupChat.oldestMessageId}&limit=50`
          : `/api/apps/${GroupChat.appSlug}/messages?limit=50${GroupChat._demoParam()}`;

      // Preserve scroll anchor when prepending older history so the viewport
      // doesn't jump to the top.
      const container = document.getElementById('gc-messages');
      const prevScrollHeight = container?.scrollHeight || 0;
      const prevScrollTop = container?.scrollTop || 0;

      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const { messages } = body;
      // Disconnect invalidates this request, even if we return to the same app.
      if (GroupChat._historyLoad !== load) return;
      ok = true;
      GroupChat._streamLoaded = true;
      GroupChat._historyFailed = false;
      // Where reading stood, from the first page and before markRead below
      // moves it: the stream opens at the first message after it.
      if (isFirstLoad) GroupChat._takeUnreadMark(body && body.read);

      if (!isFirstLoad) GroupChat._takeOlder(GroupChat._general, null, messages, body, events);
      else {
        // A page from the worker's saved copy is caught up at once (`finally`).
        if (GroupChat._fromSavedCopy(res)) GroupChat._owe(GroupChat._general, true);
        GroupChat._takeNewest(GroupChat._general, null, messages, body, events, true);
      }

      // Flushed: both branches below measure the scroller, and the rows have
      // to be in it first (features/group-chat/mount.ts publishTranscript).
      GroupChat.render({ flush: true });

      if (isFirstLoad && !GroupChat._didInitialScroll) {
        GroupChat.scrollToBottom();
        GroupChat._didInitialScroll = true;
        GroupChat._applyPendingReveal();
        // Unread messages: at the first of them instead (_openAtUnread).
        GroupChat._openAtUnread();
        // B9: the viewer's own cards under their requests, and the bot's door.
        void GroupChat._loadBotCards();
        // #2387: opening the channel reads it.
        void GroupChat.markRead();
      } else if (container) {
        const newScrollHeight = container.scrollHeight;
        container.scrollTop = prevScrollTop + (newScrollHeight - prevScrollHeight);
      }
    } catch { /* surfaced below */ } finally {
      GroupChat._closeLiveLog(events);
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
        // #4177: a catch-up asked for while this page was on the wire.
        if (GroupChat._latestAgain && GroupChat._streamLoaded) void GroupChat._refreshLatest(null);
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
      case 'rate_limited': {
        // The server refused THIS socket's own message, edit or reaction for
        // coming too fast (admitSocketFrame in services/ws.js). The composer
        // already cleared itself, so say it was not sent and when to retry.
        window.PlatformUI?.toast?.(GroupChat._rateLimitedText(msg));
        break;
      }
      case 'error': {
        // A refusal the server explains in words, such as Homeroom's old
        // channel being read-only (`channel_moved`). It answers a message
        // this socket sent, so it used to vanish along with that message.
        GroupChat._showSocketError(msg);
        break;
      }
      case 'chat': {
        // #194: thread messages never land in the general stream — they
        // route to the mounted thread (if it matches) or bump the
        // chat-count badge on their issue/proposal row. #2387 follow-up:
        // except a REPLY thread's, which also lands in the general stream,
        // drawn there as a line where it happened.
        // #4417 follow-up: a topic's channel, open in the general pane, is
        // that pane's stream (`_isChannel`): its messages take the general
        // path below, and the app's own general stream's do not.
        const ownStream = msg.thread && msg.thread.type
          ? msg.thread.type === 'category' && GroupChat._isChannel(msg.thread)
          : GroupChat._isChannel(null);
        if (msg.thread && msg.thread.type && !ownStream) {
          GroupChat._handleThreadIncoming(msg);
          // #4417: a reply under a message of one of the project's TOPIC
          // channels is that channel's (its root says where it is), so it
          // is drawn there, never in the general stream.
          const root = msg.threadRoot || null;
          const rootHere = GroupChat._isChannel(root && root.thread_type
            ? { type: root.thread_type, ref: root.thread_ref } : null);
          if (msg.thread.type === 'message' && rootHere
              && !GroupChat.messages.some((m) => String(m.id) === String(msg.id))) {
            const shouldStick = GroupChat._lockedToBottom;
            GroupChat.messages.push(msg);
            if (GroupChat._streamLoaded && !GroupChat._streamStale) GroupChat._syncedMax = Math.max(GroupChat._syncedMax, Number(msg.id) || -Infinity);
            GroupChat.appendMessage(msg);
            if (shouldStick) GroupChat.scrollToBottom();
          }
          break;
        }
        // The app's general stream, while a topic's channel is the pane's.
        if (!ownStream) break;
        // A catch-up read (#4177) can bring in a message a moment before its
        // own broadcast arrives.
        if (GroupChat.messages.some((m) => String(m.id) === String(msg.id))) break;
        // #4511: your own message follows you to the bottom when you were
        // at it or near it, as anyone's does. A reader who had scrolled up
        // into the history is left where they are reading, even by their own
        // send. (#2389 made a send always jump; that is retired.)
        const shouldStick = GroupChat._lockedToBottom;
        GroupChat.messages.push(msg);
        // #4177: a live message extends the gap-free span of a loaded stream,
        // unless a gap is pending, in which case it is past the gap and proves
        // nothing (before the first page there is no span to extend).
        if (GroupChat._streamLoaded && !GroupChat._streamStale) GroupChat._syncedMax = Math.max(GroupChat._syncedMax, Number(msg.id) || -Infinity);
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
      case 'chat_message_updated': {
        // An offer of Homeroom bot's in a thread was decided.
        GroupChat._applyMessageUpdate(msg);
        break;
      }
      case 'moderation_changed':
      // #4177: the relay could not deliver an event to this room (it was too
      // big for NOTIFY, or this server's listener was down). Both mean the
      // same thing a moderation change does: re-read what is held. Both used
      // to call loadHistory(), whose page on a loaded stream is the OLDER one.
      case 'resync_hint': {
        GroupChat.resyncLoaded();
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
        // #4417 follow-up: a topic's channel open in the general pane types
        // into the pane's slot, and the app's general stream then does not.
        const inPane = msg.thread && msg.thread.type
          ? msg.thread.type === 'category' && GroupChat._isChannel(msg.thread)
          : GroupChat._isChannel(null);
        if (msg.thread && msg.thread.type && !inPane) {
          const a = GroupChat.activeThread;
          if (a && a.type === msg.thread.type && Number(a.ref) === Number(msg.thread.ref)) {
            GroupChat._renderThreadTyping(msg.username);
          }
          break;
        }
        if (!inPane) break;
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
    // Already in hand from a catch-up read (#4177).
    if (st.messages.some((m) => String(m.id) === String(msg.id))) return;
    st.messages.push(msg);
    // #4177: see the general stream's `_syncedMax`.
    if (st.loaded && !st.stale) st.syncedMax = Math.max(st.syncedMax ?? -Infinity, Number(msg.id) || -Infinity);
    const a = GroupChat.activeThread;
    if (a && a.type === type && Number(a.ref) === Number(ref)) {
      const el = GroupChat._threadEl('gc-thread-messages');
      const scroll = GroupChat._threadScrollEl();
      if (el && scroll) {
        // #363: only stick to the newest message when the reader is already
        // near the bottom — otherwise a live message would yank someone who
        // has scrolled up to read the topic body or older replies. #4511:
        // the reader's own send too; measured before it is drawn.
        const nearBottom = GroupChat._threadPinned
          || scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < GroupChat.THREAD_FOLLOW_PX;
        // And pinned from here, so a row drawn after this returns (a request
        // page's render is batched) or growing later (an image) is followed.
        if (nearBottom) GroupChat._threadPinned = true;
        // Appended to the MODEL. #gc-thread-messages is the same React
        // transcript #gc-messages is (mounted with the 'thread' key a few
        // methods down), so the insertAdjacentHTML this replaces was legacy
        // markup spliced into a reconciled tree: the row carried none of the
        // component's handlers and the next store update erased it.
        //
        // A request's page (#4453) renders the whole stream again instead:
        // its rows are merged with the GitHub comments, and a spec posted
        // live has to reach the head's spec cards and status card too.
        if (a.language === 'request') {
          GroupChat.renderThread({ keepScroll: true });
          if (nearBottom) scroll.scrollTop = scroll.scrollHeight;
          return;
        }
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
    GroupChat._publishComposer('thread', { status: PlatformI18n.t('chat:group.typing.one', { name: username }) });
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
    // #4417 follow-up: the pane's composer posts to the channel it shows.
    const channel = GroupChat._channel;
    if (!payload.thread && channel) payload.thread = { type: channel.type, ref: channel.ref };
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
    window.PlatformUI?.toast?.(msg.error
      ? PlatformI18n.t('chat:group.send.notSentReason', { reason: msg.error })
      : PlatformI18n.t('chat:group.send.notSentJoin'));
  },

  // The toast for a `rate_limited` frame. Worded here from the number rather
  // than read off the frame's `error`, so the copy has one home on screen;
  // the server words its `error` the same way (socketRetryPhrase).
  _rateLimitedText(msg) {
    const n = Math.ceil(Number(msg && msg.retryAfterSeconds));
    return Number.isFinite(n) && n > 0
      ? PlatformI18n.t('chat:group.send.rateLimited', { count: n })
      : PlatformI18n.t('chat:group.send.rateLimitedMoment');
  },

  // An `error` frame: show what the server said. Every code sent today
  // answers a chat message the server would not post (services/ws.js
  // refuseChat), so it says that too: the composer emptied as it left, and
  // a refusal nobody told the sender about was a message that vanished.
  // #4417: `topic_closed` is a retired topic's channel, read-only too.
  NOT_SENT_CODES: new Set([
    'channel_moved', 'topic_closed', 'not_collaborator', 'write_access_failed',
    'invalid_thread', 'invalid_attachment_ids', 'attachment_not_owned', 'send_failed',
  ]),
  _showSocketError(msg) {
    const said = (msg && (msg.message || msg.error)) || '';
    const notSent = !!msg && GroupChat.NOT_SENT_CODES.has(msg.code);
    // The server's own sentence when it sent one; the client's otherwise.
    window.PlatformUI?.toast?.(said
      ? (notSent ? PlatformI18n.t('chat:group.send.notSentReason', { reason: said }) : said)
      : (notSent ? PlatformI18n.t('chat:group.send.notSentError') : PlatformI18n.t('chat:group.send.error')));
  },

  sendTyping(thread) {
    if (GroupChat._readOnly()) return;
    if (!GroupChat.ws || GroupChat.ws.readyState !== 1) return;
    if (GroupChat.typingTimeout) return;
    const payload = { type: 'typing' };
    // #4417 follow-up: the pane's composer types in the channel it shows.
    const scope = (thread && thread.type && thread.ref) ? thread : GroupChat._channel;
    if (scope) {
      payload.thread = { type: scope.type, ref: Number(scope.ref) };
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
    // #4455: a change's page (`language: 'change'`) reads its notices the
    // same way: each is an event of this one change, drawn as a line.
    const chat = !!(opts && (opts.language === 'chat' || opts.language === 'change'));
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
    const username = msg.username || PlatformI18n.t('chat:group.systemSender');
    // No author came with the row: `username` is a stand-in, never a name in a sentence.
    const usernameMissing = !msg.username;
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
      usernameMissing,
      text: deleted ? '' : String(msg.content == null ? '' : msg.content),
      deleted,
      // The reply thread under a general-chat message (#2387), as the chip
      // under it draws it; `thread` on a row is the server's summary, not the
      // live frame's `{ type, ref }` scope, which never reaches a general row.
      thread: GroupChat._threadSummaryView(msg),
      // #4417 follow-up: a message of a topic's channel starts one too, as
      // #general's do; the transcript offers it in the pane's rows alone.
      canThread: (!threadType || threadType === 'category') && !deleted && (kind === 'message' || kind === 'spec_share'),
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
        username: q.author || (q.source === 'pr' ? (q.prNumber ? PlatformI18n.t('chat:group.quote.pr', { number: q.prNumber }) : PlatformI18n.t('chat:group.quote.prUnnumbered')) : PlatformI18n.t('chat:group.quote.system')),
        excerpt: GroupChat._collapseSnippet(q.snippet).slice(0, 160),
        source: q.source || '',
        href: q.source === 'pr' ? (q.href || '') : null,
        targetId: q.refMsgId == null ? null : Number(q.refMsgId),
      } : null,
      // Set by a jump-to-original and cleared 1.5s later; never true on a
      // freshly built row but the one a reveal is marking (`_revealFlash`),
      // which a whole publish in those 1.5s (a channel's bot cards landing
      // just after its first page) would otherwise take straight back off.
      flash: GroupChat._revealFlashing(msg.id),
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
          || PlatformI18n.t('chat:group.systemSender'),
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
      // #4455: a preview build notice ('started' / 'ready', pr-import-sync.js
      // and staging-recovery.js), which a change's page draws as one line.
      ...(kind === 'system' && (meta.stagingBuild === 'started' || meta.stagingBuild === 'ready')
        ? { stagingBuild: meta.stagingBuild } : {}),
      // #4238: Homeroom bot's "I've made the first version" line in the
      // channel carries its Open button (ws.sendFirstVersionMessage). Only
      // that metadata, which a person's post cannot set.
      openApp: GroupChat._openAppView(kind === 'message' && !deleted && !threadType ? meta : null),
      // 10 October: Homeroom bot's offer in a thread (homeroom-bot-voice.js),
      // with its buttons for the person it was offered to. Only that
      // metadata, which a person's post cannot set.
      botOffer: GroupChat._botOfferView(kind === 'message' && !deleted ? meta : null),
    };
  },

  // The buttons under Homeroom bot's offer, from its message's metadata
  // (homeroom-bot-voice.js say): open until the person it was offered to
  // taps one, for everybody else only a record that it was offered.
  _botOfferView(meta) {
    const bot = meta && meta.homeroomBot;
    if (!bot || bot.kind !== 'voice' || !bot.offer || typeof bot.offer !== 'object') return null;
    const status = ['open', 'deciding', 'done', 'declined', 'failed'].includes(bot.offer.status) ? bot.offer.status : null;
    if (!status) return null;
    const me = window.App && App.user ? Number(App.user.id) : null;
    const actions = (Array.isArray(bot.actions) ? bot.actions : [])
      .filter((a) => a && (a.id === 'yes' || a.id === 'no') && typeof a.label === 'string' && a.label)
      .map((a) => ({ id: a.id, label: a.label.slice(0, 40), primary: a.style === 'primary' }));
    return { status, forMe: me != null && Number(bot.offer.forUserId) === me, actions };
  },

  // Yes or No under one of Homeroom bot's offers. The buttons go when the
  // room hears it was decided (`chat_message_updated`); a refusal is said.
  async decideBotOffer(messageId, choice) {
    const slug = GroupChat.appSlug;
    if (!slug || !messageId || (choice !== 'yes' && choice !== 'no')) return;
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(slug)}/messages/${Number(messageId)}/bot-offer`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ choice }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok && !data.said && window.PlatformUI) PlatformUI.toast(data.error || PlatformI18n.t('chat:group.botOffer.failed'));
    } catch {
      if (window.PlatformUI) PlatformUI.toast(PlatformI18n.t('chat:group.botOffer.failed'));
    }
  },

  // A message's metadata changed for everybody (`chat_message_updated`): an
  // offer of Homeroom bot's was decided, or (papote #3) what became of its
  // plan on a request (homeroom-bot-live.js notePlanRows). Every copy, and
  // its row.
  _applyMessageUpdate(frame) {
    if (!frame || frame.id == null || !frame.metadata || typeof frame.metadata !== 'object') return;
    GroupChat._applyLive({ kind: 'metadata', id: frame.id, metadata: frame.metadata });
    let msg = null;
    GroupChat._eachCopy(frame.id, (m) => { if (!msg) msg = m; });
    if (!msg) return;
    const view = GroupChat._messageView(msg);
    GroupChat._react()?.patchTranscriptMessage(Number(frame.id), {
      botOffer: view.botOffer,
      ...(frame.metadata.specShare ? { specShare: view.specShare } : {}),
    });
  },

  _openAppView(meta) {
    if (!meta || meta.kind !== 'first_version' || !Array.isArray(meta.actions)) return null;
    const open = meta.actions.find((a) => a && a.type === 'open' && typeof a.target === 'string'
      && a.target.startsWith('#app/') && typeof a.label === 'string' && a.label);
    return open ? { label: open.label, target: open.target } : null;
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
    // #4417 follow-up: a topic's channel says so when it is empty, as it did
    // when it was drawn as a thread, rather than with the app's quiet card;
    // and it draws its merged topics' cards by time.
    const channel = GroupChat._channel;
    GroupChat._react()?.publishTranscript(
      GroupChat.messages.map(GroupChat._messageView),
      'main',
      {
        earlier: false,
        placeholder: channel && GroupChat._streamLoaded ? PlatformI18n.t('chat:group.topicChannel.empty') : null,
        error: GroupChat._historyFailed ? PlatformI18n.t('chat:group.history.failed') : null,
        ...(channel && channel.markers ? { markers: channel.markers, moreBefore: !!GroupChat.hasMore } : {}),
        // The quiet card's three facts (features/group-chat/quiet-card.tsx).
        // Whether the card SHOWS is the transcript's call — it knows whether a
        // person's message is among the rows, including one that lands live —
        // but "paged back to the beginning", "can this viewer post" and the
        // app's name are this module's to know.
        quiet: GroupChat._historyFailed || channel ? null : {
          exhausted: !GroupChat.hasMore,
          canPost: !GroupChat._readOnly(),
          // '' when the project has no name yet: the card then says "this app".
          appName: GroupChat._appName()
            || '',
        },
        // Where reading stood when the channel opened: the transcript draws
        // its "New" line above the first message after it, and the pane
        // counts them (features/group-chat/transcript.tsx, general-chat.tsx).
        unread: GroupChat._unreadMark || null,
      },
      { flush: !!(opts && opts.flush) },
    );
  },

  // ── Where the channel opens ─────────────────────────────────────────
  //
  // A channel with unread messages opens at the first of them, as a
  // conversation in Messages does (frontend/src/features/messages/
  // unread-anchor.ts): its "New" line a row or two under the top, with what
  // was already read just above, instead of at the newest message. The mark
  // is the cursor the first page reported (`read`, src/routes/chat.js),
  // taken before this open reads the channel, and it lasts while the pane is
  // open (releaseUnreadHold lets it go). Nothing unread, no mark: the stream
  // opens at the bottom as it always did.

  _takeUnreadMark(read) {
    const last = read ? Number(read.last_read_message_id) : NaN;
    const count = read ? Math.floor(Number(read.unread_count) || 0) : 0;
    GroupChat._unreadMark = Number.isSafeInteger(last) && last >= 0 && count > 0
      ? { lastReadId: last, count }
      : null;
    GroupChat._unreadOpened = false;
  },

  // Once per mark, with the stream on screen. After scrollToBottom and the
  // bell's reveal: a message the reader was sent to wins (it unlocks the
  // bottom), as does a place they scrolled to on an earlier visit. React
  // finds the line and makes the move (mount.ts openAtUnreadLine); this
  // module keeps its own follow state in step.
  _openAtUnread() {
    const container = document.getElementById('gc-messages');
    if (!container || !GroupChat._unreadMark || GroupChat._unreadOpened) return;
    const react = GroupChat._react();
    if (!react || typeof react.openAtUnreadLine !== 'function') return;
    GroupChat._unreadOpened = true;
    if (GroupChat._pendingReveal || !GroupChat._lockedToBottom) return;
    // A remount publishes batched: put the rows, and the line, on the page.
    if (!container.querySelector('[data-unread-line]')) GroupChat.render({ flush: true });
    const at = react.openAtUnreadLine(container);
    if (!at) return;
    // At the very top with history above it, the scroll listener would page
    // back at once and carry the line out of view: a pixel down, the reader
    // pages back when they scroll up, as they always do.
    if (container.scrollTop === 0 && GroupChat.hasMore) container.scrollTop = 1;
    GroupChat._lockedToBottom = at.pinned;
    GroupChat._savedScrollTop = container.scrollTop;
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
  // opts: { type, ref, container, app?, readOnly?, notice?, placeholder? }
  //
  // `app` ({ slug, name, readOnly }, as mount() takes it) names the app the
  // thread is in, and it is the mount's app from here on. The app view
  // passes its own for every topic page: `_app` otherwise still named the
  // app the Messages screen or a project's Discussion tab last mounted, so a
  // reply on a change's page went out on THAT app's socket, whose server
  // refuses a thread it does not have, or was dropped before it left because
  // that app's pane was read-only. Either way the box emptied and nothing
  // was posted. A reply thread opened beside a channel passes none: it is in
  // the channel's app, which `_app` already names.
  mountThread(opts) {
    const { type, ref, container } = opts || {};
    if (!type || !ref || !container) return;
    if (opts.app && opts.app.slug) GroupChat._app = opts.app;
    const slug = GroupChat._appSlug()
      || GroupChat.appSlug;
    if (!slug) return;

    const liveWs = GroupChat.ws && GroupChat.ws.readyState <= 1;
    if (!(GroupChat.appSlug === slug && liveWs)) {
      // #4417 follow-up: a reconnect of the same app keeps the channel its
      // pane shows (a reply thread opened beside a topic's channel).
      // #4640: this mount replaces whatever thread was open, so drop it
      // before connect() — connect keeps an open thread of the same app
      // alive, and restoring the one being replaced here would render it
      // over this mount's host.
      GroupChat.activeThread = null;
      GroupChat.connect(slug, GroupChat.appSlug === slug ? GroupChat._channel : null);
    }
    // `language: 'chat'` was the change page's Discussion (bubbles, and every
    // notice as a message) until #4455 made that page a thread of its own
    // (`'change'`, below). Every other thread keeps its flat rows and
    // centred lines.
    // `language: 'request'` (#4453) is a request's page: Messages' reply
    // thread, with the request as its root post and its GitHub comments in
    // the same stream (`renderThread`).
    // `language: 'change'` (#4455) is a change's page: the same thread, with
    // the change as its root post and every notice a single line. `closed`
    // is what a change nobody else can see yet says instead of a stream: its
    // thread is not read at all (only its author can open the page).
    const language = ['chat', 'request', 'change'].includes(opts.language) ? opts.language : 'flat';
    const closed = language === 'change' && opts.closed ? String(opts.closed) : null;
    // #5007: a change built for a request points its replies at that
    // request's own page, where the conversation lives. Only the change
    // language takes one, and only with the in-app href its chip opens.
    const issue = language === 'change' && opts.issue && Number.isInteger(opts.issue.n)
      && typeof opts.issue.href === 'string' && opts.issue.href.startsWith('#app/')
      ? { n: opts.issue.n, href: opts.issue.href } : null;
    // #4417: cards a topic's channel draws by time (a merged topic's), which
    // the transcript places among the rows (TranscriptLead.markers).
    const markers = Array.isArray(opts.markers) && opts.markers.length ? opts.markers : null;
    GroupChat.activeThread = {
      type, ref: Number(ref), language,
      ...(closed ? { closed } : {}), ...(issue ? { issue } : {}), ...(markers ? { markers } : {}),
    };
    // #4640: the thread renders into the container it was mounted in, not
    // whichever `#gc-thread-messages` a document-wide lookup finds first.
    GroupChat._threadHost = container;

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
      notice: opts.notice || PlatformI18n.t('chat:group.thread.readOnly'),
      placeholder: opts.placeholder || PlatformI18n.t('chat:group.thread.placeholder'),
      maxLength: GC_MAX_MESSAGE_LEN,
      request: fill && language === 'request',
      change: fill && language === 'change',
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
    // #4513: a new thread starts unpinned; `renderThread` says where it opens,
    // once (`_threadPlaced`, polish board #12).
    GroupChat._threadPlaced = false;
    GroupChat._threadPinned = false;
    GroupChat._attachThreadFollow(GroupChat._threadScrollEl());

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
    // #4517: the shell is React's now, so moving from one topic's page to
    // another's in the same host keeps the SAME form and input nodes. Every
    // listener below closes over this mount's `{ type, ref }`, and the ones
    // an earlier mount bound were still on those nodes — the oldest ran first
    // and sent the message to the topic opened earlier, emptying the input
    // before this mount's own handler could see it. Each mount drops the
    // previous mount's listeners before it binds its own.
    const signal = GroupChat._rewireThreadComposer();
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
      }, { signal });
      input.addEventListener('input', () => {
        GroupChat.setDraft(slug, input.value, threadKey);
        GroupChat._autoGrowTextarea(input);
        GroupChat.sendTyping({ type, ref });
      }, { signal });
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
      }, { signal });
      // #694: paperclip / paste / drag-and-drop attachment wiring for
      // this thread's composer.
      GroupChat.setupAttachments({ type, ref }, signal);
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
      }, { signal });
    }

    GroupChat.renderThread();
    // Only fetch on first open — the per-thread cache stays current
    // while connected (incoming WS messages are stored even when the
    // thread isn't mounted), and loadThreadHistory with an oldestId set
    // pages BACKWARD (that's the "Load earlier" button's job). A cache a
    // gap left behind (#4177, `resyncLoaded`) catches up instead.
    const st = GroupChat._threadState(type, ref);
    if (closed) return;
    if (!st.loaded) GroupChat.loadThreadHistory(type, ref);
    else if (st.stale && !st.read) void GroupChat._refreshLatest({ type, ref });
  },

  // #4417: the cards a topic's channel draws by time changed while it is
  // open (a merge applied): redraw it with them, where the reader is.
  // #4417 follow-up: and the topic's channel in the general pane, the same.
  setThreadMarkers(type, ref, markers) {
    const next = Array.isArray(markers) && markers.length ? markers : null;
    const c = GroupChat._channel;
    if (c && c.type === type && c.ref === Number(ref)) {
      if (JSON.stringify(c.markers || null) === JSON.stringify(next)) return;
      if (next) c.markers = next; else delete c.markers;
      GroupChat.render();
      return;
    }
    const a = GroupChat.activeThread;
    if (!a || a.type !== type || Number(a.ref) !== Number(ref)) return;
    if (JSON.stringify(a.markers || null) === JSON.stringify(next)) return;
    if (next) a.markers = next; else delete a.markers;
    GroupChat.renderThread({ keepScroll: true });
  },

  // Drop the active thread render target (its history cache survives in
  // `threads` for instant re-open). Called when an accordion collapses
  // or the user leaves the sub-tab.
  unmountThread() {
    // A quote staged in the thread composer must not leak into the
    // general composer (replyDraft is global).
    if (GroupChat.activeThread && GroupChat.replyDraft) GroupChat.clearQuote();
    GroupChat.activeThread = null;
    GroupChat._threadHost = null;
    // #4517: nothing typed into a left thread's composer may still post to it.
    GroupChat._threadComposerWiring?.abort();
    GroupChat._threadComposerWiring = null;
    clearTimeout(GroupChat._threadTypingTimer);
  },

  // #4517: the thread composer's listeners belong to ONE mount, the topic it
  // was mounted for. The form and input outlive a mount (React keeps them
  // across topics), so each mount aborts the last one's listeners here and
  // binds its own with the signal this returns.
  _threadComposerWiring: null,
  _rewireThreadComposer() {
    GroupChat._threadComposerWiring?.abort();
    GroupChat._threadComposerWiring = new AbortController();
    return GroupChat._threadComposerWiring.signal;
  },

  async loadThreadHistory(type, ref) {
    const slug = GroupChat.appSlug;
    if (!slug) return;
    let st = GroupChat._threadState(type, ref);
    // #4177: "Load earlier" waits for a catch-up on the wire (see loadHistory).
    while (st.read) {
      await st.read;
      if (GroupChat.appSlug !== slug) return;
      st = GroupChat._threadState(type, ref);
    }
    // A topic repaint can mount this thread again before its first fetch
    // finishes. Only one initial/page request may own this cache at a time.
    if (st.loading) return;
    st.loading = true;
    let ok = false;
    // A retry goes back to "Loading…" while it is in flight.
    if (st.failed) {
      st.failed = false;
      if (GroupChat._isOpenThread(type, ref)) GroupChat.renderThread();
    }
    const thread = { type, ref };
    const isFirstPage = !st.oldestId;
    // #4640: a first page that never answers held "Loading…" up forever —
    // nothing else re-reads a thread that is neither loaded nor failed. The
    // abort lands in the catch below, so the state records the failure and
    // the transcript offers "Try again". Later pages keep the browser's own
    // timeout; "Load earlier" and catch-ups are unchanged.
    let abort = null;
    let timeout = null;
    const init = {};
    if (isFirstPage && typeof AbortController === 'function') {
      try {
        abort = new AbortController();
        init.signal = abort.signal;
        timeout = setTimeout(() => abort.abort(), GroupChat.THREAD_FIRST_PAGE_TIMEOUT_MS);
      } catch { /* no timeout: the browser's own applies */ }
    }
    // #4177: as in loadHistory, socket events during the read are replayed.
    const events = GroupChat._openLiveLog(st.messages);
    try {
      const res = await fetch(st.oldestId
        ? `${GroupChat._threadQuery(slug, thread)}&limit=50&before=${st.oldestId}`
        : GroupChat._firstPageUrl(slug, thread), init);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const messages = Array.isArray(data.messages) ? data.messages : [];
      ok = true;
      if (GroupChat.threads.get(GroupChat.threadKey(type, ref)) !== st) return;
      if (!isFirstPage) GroupChat._takeOlder(st, thread, messages, data, events);
      else {
        if (GroupChat._fromSavedCopy(res)) GroupChat._owe(st, true);
        GroupChat._takeNewest(st, thread, messages, data, events, true);
      }
      st.loaded = true;
      st.failed = false;
      if (GroupChat._isOpenThread(type, ref)) GroupChat.renderThread({ flush: true });
    } catch { /* surfaced below */ } finally {
      if (timeout) clearTimeout(timeout);
      GroupChat._closeLiveLog(events);
      st.loading = false;
      // #2992: a failed FIRST page used to leave the thread on "Loading…"
      // forever — nothing re-rendered it. Record the failure and repaint so
      // the transcript offers "Try again" (loadThreadHistoryForOpen). A failed
      // earlier page keeps the "Load earlier" control, which is its retry.
      if (!ok && !st.loaded && GroupChat.threads.get(GroupChat.threadKey(type, ref)) === st) {
        st.failed = true;
        if (GroupChat._isOpenThread(type, ref)) GroupChat.renderThread();
      }
      // #4640: the answer was thrown away because connect() or
      // refreshAfterBlock swapped the cache while it was on the wire (a
      // dropped success had already set ok, so the failure branch above
      // passed it by; a failure that was swapped records into a discarded
      // state), and nothing started a load for the state the open thread now
      // reads. Run one, and let its `st.loading` guard stand down when
      // refreshAfterBlock already did. One re-run per swap: connect,
      // disconnect and refreshAfterBlock are the only swaps, so this cannot
      // spin.
      if (!st.loaded
          && GroupChat.threads.get(GroupChat.threadKey(type, ref)) !== st
          && GroupChat.appSlug === slug && GroupChat._isOpenThread(type, ref)) {
        void GroupChat.loadThreadHistory(type, ref);
      }
      // #4177: a catch-up asked for while this page was on the wire.
      if (st.loaded && st.again && GroupChat._isOpenThread(type, ref)) void GroupChat._refreshLatest(thread);
    }
  },

  // ── One rule for every read of a chat stream (#4177) ────────────────
  //
  // A stream (the general one, or a thread) loads a page and then stays
  // current from the socket. Every read (first page, "Load earlier", catch-up)
  // follows the same rule: the socket events that arrive while it is on the
  // wire are recorded (`_openLiveLog`) and replayed onto its answer
  // (`_replayLive`), so each changes exactly the fields it changed live.
  //
  // A catch-up (`_refreshLatest`) re-reads the newest page after a gap: the
  // socket was down, the relay could not deliver (`resync_hint`), the worker
  // answered from an older saved copy, the tab was away. The newest page is
  // the truth from its first id on (`_reconcileLatest`). Each stream keeps:
  //   syncedMax  the newest id it holds with no gap before it; a live message
  //              moves it only while no gap is pending;
  //   stale      a catch-up is owed, until one succeeds;
  //   again      one was asked for while a read was on the wire: it runs when
  //              that read lands (only this re-runs at once, so a failing read
  //              cannot loop);
  //   read       the catch-up in flight, which "Load earlier" waits for.
  // The general stream's fields live on GroupChat itself; `_general` gives them
  // a thread state's names so one path serves both (`_streamOf`).

  _general: {
    get messages() { return GroupChat.messages; },
    set messages(v) { GroupChat.messages = v; },
    get oldestId() { return GroupChat.oldestMessageId; },
    set oldestId(v) { GroupChat.oldestMessageId = v; },
    get hasMore() { return GroupChat.hasMore; },
    set hasMore(v) { GroupChat.hasMore = v; },
    get syncedMax() { return GroupChat._syncedMax; },
    set syncedMax(v) { GroupChat._syncedMax = v; },
    get stale() { return GroupChat._streamStale; },
    set stale(v) { GroupChat._streamStale = v; },
    get again() { return GroupChat._latestAgain; },
    set again(v) { GroupChat._latestAgain = v; },
    get loaded() { return GroupChat._streamLoaded; },
    get loading() { return !!(GroupChat._historyLoad || GroupChat._latestLoad); },
    get read() { return GroupChat._latestLoad; },
    root: null,
  },

  _streamOf(thread) {
    return thread ? GroupChat._threadState(thread.type, thread.ref) : GroupChat._general;
  },

  _resetStreamCatchUp() {
    GroupChat._latestLoad = null;
    GroupChat._latestAgain = false;
    GroupChat._streamLoaded = false;
    GroupChat._streamStale = false;
    GroupChat._syncedMax = -Infinity;
  },

  _isOpenThread(type, ref) {
    const a = GroupChat.activeThread;
    return !!a && a.type === type && String(a.ref) === String(ref);
  },

  // The address of a stream's newest page. Byte-identical to every first-page
  // read, because the service worker keys its cache, and its corrections, by
  // URL.
  _threadQuery(slug, thread) {
    return `/api/apps/${slug}/messages?thread_type=${encodeURIComponent(thread.type)}`
      + `&thread_ref=${encodeURIComponent(thread.ref)}`;
  },
  // #4417 follow-up: no thread is the general pane's stream, which is a
  // topic's channel while one is open there (`_channel`).
  _firstPageUrl(slug, thread) {
    const scope = thread || GroupChat._channel;
    return scope
      ? `${GroupChat._threadQuery(slug, scope)}&limit=50${GroupChat._demoParam()}`
      : `/api/apps/${slug}/messages?limit=50${GroupChat._demoParam()}`;
  },

  // A catch-up waits for the network (the worker's `no-cache` rule, sw.js),
  // but not forever: a half-dead link would otherwise hold it, and "Load
  // earlier" and every later ask would wait behind it. A browser without
  // `AbortSignal.timeout` (Safari before 16) gets the same from a timer.
  _freshInit() {
    const init = { cache: 'no-cache' };
    const ms = GroupChat.CATCH_UP_TIMEOUT_MS;
    try {
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        init.signal = AbortSignal.timeout(ms);
      } else if (typeof AbortController === 'function') {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), ms);
        init.signal = controller.signal;
      }
    } catch { /* no timeout: the browser's own applies */ }
    return init;
  },
  CATCH_UP_TIMEOUT_MS: 30_000,

  // #4640: the first page of a thread's history gives up after this long, so
  // a request that never settles shows "Couldn't load this thread." with its
  // Try again control instead of "Loading…" forever.
  THREAD_FIRST_PAGE_TIMEOUT_MS: 20_000,

  // The service worker stamps its saved copies (CACHED_AT_HEADER in sw.js).
  _fromSavedCopy(res) {
    try {
      return !!(res && res.headers && typeof res.headers.get === 'function' && res.headers.get('sw-cached-at'));
    } catch {
      return false;
    }
  },

  // ── What changes while a read is on the wire ──
  //
  // A read's answer is older than anything the socket delivers meanwhile. It
  // notes what the stream holds when it starts (`log.held`); when it lands,
  // whatever the stream holds that it did not hold then arrived during the
  // read, and keeps its live copy. Edits, deletes, reactions and thread
  // summaries are recorded as events and replayed onto the answer, so each
  // changes exactly the fields it changed live.
  _openLiveLog(messages) {
    const log = [];
    log.held = new Set(messages.map((m) => String(m.id)));
    GroupChat._liveWindows.add(log);
    return log;
  },
  _closeLiveLog(log) {
    GroupChat._liveWindows.delete(log);
  },
  _noteLive(event) {
    for (const log of GroupChat._liveWindows) log.push(event);
  },
  // A change that did not happen after all (a refused delete): out of every
  // record, so it is not replayed onto an answer that never had it.
  _forgetLive(kind, id) {
    for (const log of GroupChat._liveWindows) {
      for (let i = log.length - 1; i >= 0; i -= 1) {
        if (log[i].kind === kind && String(log[i].id) === String(id)) log.splice(i, 1);
      }
    }
  },

  // A field event, applied to every held copy of its message (a reply is held
  // in the general stream AND its thread, a thread's root on its own) and
  // recorded for the reads in flight.
  _applyLive(event) {
    GroupChat._noteLive(event);
    GroupChat._eachCopy(event.id, (m) => GroupChat._patchLive(m, event));
  },

  _patchLive(m, event) {
    switch (event.kind) {
      case 'edit':
        m.content = event.content;
        m.editedAt = event.editedAt;
        break;
      case 'reaction':
        m.reactions = event.reactions || [];
        break;
      case 'summary':
        m.thread = event.thread || null;
        break;
      case 'metadata':
        m.metadata = event.metadata;
        break;
      case 'delete': {
        m.deleted = true;
        m.content = '';
        m.reactions = [];
        const meta = { ...(m.metadata || m.meta || {}) };
        delete meta.attachments;
        delete meta.quote;
        m.metadata = meta;
        break;
      }
      default:
        break;
    }
  },

  /**
   * Put what arrived during a read onto its answer, then replay the read's
   * events (onto a thread's root too). An arrival replaces the answer's copy
   * of the same message, or goes at the end, in arrival order: it is newer
   * than anything the answer holds (sorting by id would reorder the staging
   * demo's mock rows). One older than `from`, the first id the answer is the
   * truth for, is history "Load earlier" reads again.
   */
  _replayLive(answer, root, events, arrived, from) {
    const list = answer.slice();
    const at = new Map(list.map((m, i) => [String(m.id), i]));
    for (const msg of arrived) {
      if (Number(msg.id) < from) continue;
      const i = at.get(String(msg.id));
      if (i == null) { at.set(String(msg.id), list.length); list.push(msg); } else list[i] = msg;
    }
    for (const event of events) {
      for (const m of list) if (String(m.id) === String(event.id)) GroupChat._patchLive(m, event);
      if (root && String(root.id) === String(event.id)) GroupChat._patchLive(root, event);
    }
    return list;
  },

  /**
   * Merge a stream's newest page into what it held. Pure. The page is the
   * truth from its first id on (all of it when `full` is false: the server had
   * nothing before it); what is held from before it is kept (`older` counts
   * it). When the page starts after `before` (the stream's `syncedMax`), the
   * gap is wider than a page: the stream starts over from the page (`reset`)
   * and "Load earlier" pages back from there. Unknown counts as wider.
   */
  _reconcileLatest(current, latest, full, { before = -Infinity } = {}) {
    const id = (m) => Number(m && m.id);
    const start = full && latest.length ? id(latest[0]) : -Infinity;
    const reset = full && latest.length > 0 && !(before >= start);
    const older = reset ? [] : current.filter((m) => id(m) < start);
    return { messages: [...older, ...latest], reset, older: older.length, start };
  },

  _maxId(list) {
    let top = -Infinity;
    for (const m of list) {
      const n = Number(m && m.id);
      if (Number.isFinite(n) && n > top) top = n;
    }
    return top;
  },

  /**
   * Take a newest page into stream `s`: a catch-up, or (`first`) a first
   * page, which also keeps what the stream held before it when the page
   * lacks it (the socket delivered it before the page landed).
   */
  _takeNewest(s, thread, latest, data, log, first = false) {
    const full = typeof data.has_more_before === 'boolean' ? data.has_more_before : latest.length >= 50;
    const before = s.messages.filter((m) => log.held.has(String(m.id)));
    const arrived = s.messages.filter((m) => !log.held.has(String(m.id)));
    // A first page has nothing known gap-free before it: whatever the socket
    // delivered first may lie past a gap, so it is not a boundary.
    const next = GroupChat._reconcileLatest(before, latest, full, { before: first ? -Infinity : s.syncedMax });
    let answer = next.messages;
    if (first) {
      const inAnswer = new Set(answer.map((m) => String(m.id)));
      answer = [...answer, ...before.filter((m) => !inAnswer.has(String(m.id)) && !(Number(m.id) < next.start))];
    }
    const root = thread && thread.type === 'message' && data.root ? data.root : (thread ? s.root : null);
    s.messages = GroupChat._replayLive(answer, root, log, arrived, next.start);
    if (thread && root) s.root = root;
    if (s.messages.length) s.oldestId = s.messages[0].id;
    if (!full) s.hasMore = false;
    else if (next.reset || !next.older) s.hasMore = true;
    // The answer's newest id is the server's. What arrived past it extends the
    // gap-free span only when no other gap is pending (`again`): otherwise it
    // may lie past that gap, which the next catch-up must see.
    s.syncedMax = GroupChat._maxId(s.again ? latest : s.messages);
    if (!s.again) s.stale = false;
    return next;
  },

  // Take an older page ("Load earlier") into stream `s`, in front.
  _takeOlder(s, thread, page, data, log) {
    const held = new Set(s.messages.map((m) => String(m.id)));
    const root = thread && thread.type === 'message' && data.root ? data.root : (thread ? s.root : null);
    s.messages = GroupChat._replayLive(
      [...page.filter((m) => !held.has(String(m.id))), ...s.messages], root, log, [], Infinity);
    if (thread && root) s.root = root;
    if (page.length) s.oldestId = page[0].id;
    const full = typeof data.has_more_before === 'boolean' ? data.has_more_before : page.length >= 50;
    if (!full) s.hasMore = false;
  },

  // A catch-up is owed; `now`: run it as soon as the read on the wire lands.
  _owe(s, now) {
    s.stale = true;
    if (now || s.loading) s.again = true;
  },

  /** Re-read one loaded stream's newest page (`thread` null: the general one). */
  async _refreshLatest(thread) {
    const slug = GroupChat.appSlug;
    if (!slug) return;
    const s = GroupChat._streamOf(thread);
    if (!s.loaded && !s.loading) return;
    if (s.loading) { GroupChat._owe(s, true); return; }
    s.stale = true;
    s.again = false;
    const key = thread ? GroupChat.threadKey(thread.type, thread.ref) : null;
    const current = () => (thread ? GroupChat.threads.get(key) === s : GroupChat._latestLoad === read);
    let settle;
    const read = new Promise((resolve) => { settle = resolve; });
    if (thread) { s.loading = true; s.read = read; } else GroupChat._latestLoad = read;
    const events = GroupChat._openLiveLog(s.messages);
    try {
      const res = await fetch(GroupChat._firstPageUrl(slug, thread), GroupChat._freshInit());
      // The network failed and the worker could only answer from its saved
      // copy: no catch-up at all. What is held stays, and still owed.
      if (!res.ok || GroupChat._fromSavedCopy(res)) return;
      const data = await res.json();
      if (GroupChat.appSlug !== slug || !current()) return;
      GroupChat._takeNewest(s, thread, Array.isArray(data.messages) ? data.messages : [], data, events);
      if (thread) {
        if (GroupChat._isOpenThread(thread.type, thread.ref)) GroupChat.renderThread({ keepScroll: true });
        return;
      }
      GroupChat._historyFailed = false;
      GroupChat.render({ flush: true });
      if (GroupChat._lockedToBottom) GroupChat.scrollToBottom();
      // What it brought onto the open channel is read, like a live message.
      void GroupChat.markRead();
    } catch {
      // Best-effort: what is on screen stays, still owed.
    } finally {
      GroupChat._closeLiveLog(events);
      settle();
      if (thread) {
        s.loading = false;
        if (s.read === read) s.read = null;
        if (s.again && GroupChat._isOpenThread(thread.type, thread.ref)) void GroupChat._refreshLatest(thread);
      } else if (GroupChat._latestLoad === read) {
        GroupChat._latestLoad = null;
        if (s.again) void GroupChat._refreshLatest(null);
      }
    }
  },

  // A thread owes a catch-up: the open one runs it now; one off screen, or
  // still on its first read, runs it when mounted again or when that lands.
  _resyncThread(key, st) {
    if (!st || (!st.loaded && !st.loading)) return;
    const a = GroupChat.activeThread;
    if (a && key === GroupChat.threadKey(a.type, a.ref)) void GroupChat._refreshLatest({ type: a.type, ref: a.ref });
    else GroupChat._owe(st);
  },

  /**
   * Bring every loaded stream up to date after a gap. The general stream,
   * which every socket open reads, takes its first page if it has none yet.
   */
  resyncLoaded() {
    if (!GroupChat.appSlug) return;
    if (GroupChat._streamLoaded || GroupChat._historyLoad) void GroupChat._refreshLatest(null);
    else void GroupChat.loadHistory();
    for (const [key, st] of GroupChat.threads) GroupChat._resyncThread(key, st);
    // #4640: the open thread the loop above skipped — one that is neither
    // loaded nor reading (a first page still on the wire when the socket
    // dropped, or one that failed) is never re-read by `_resyncThread`. Read
    // it now: on reconnect this also retries a failed load, and the
    // `st.loading` guard keeps it off the back of one already in flight.
    const a = GroupChat.activeThread;
    if (a && !a.closed) {
      const st = GroupChat.threads.get(GroupChat.threadKey(a.type, a.ref));
      if (!st || (!st.loaded && !st.loading)) void GroupChat.loadThreadHistory(a.type, a.ref);
    }
  },

  // A re-read live-reads.ts asks for: everything (`urls` null), or the streams
  // whose newest page the service worker just corrected. The events socket
  // reconnecting (`reconnect`) says nothing about this module's own socket,
  // whose `onopen` and `resync_hint` already cover a gap in it; answering it
  // too read every open stream twice per gap.
  _onLiveResync(resync) {
    if (!GroupChat.appSlug || !resync) return;
    if (!resync.urls) {
      // Unless the pass ALSO carries another trigger (the tab back after a
      // while, back online), which the chat's socket may not have noticed.
      const reasons = resync.reasons || [resync.reason];
      if (!reasons.every((r) => r === 'reconnect')) GroupChat.resyncLoaded();
      return;
    }
    for (const href of resync.urls) {
      let u;
      try { u = new URL(href, location.origin); } catch { continue; }
      if (u.searchParams.has('before')) continue;
      const type = u.searchParams.get('thread_type');
      // The general stream, even one whose first page came back empty: that
      // page may be the stale copy being corrected. #4417 follow-up: the
      // general pane's stream is a topic's channel while one is open there.
      if (GroupChat._isChannel(type ? { type, ref: u.searchParams.get('thread_ref') } : null)) {
        void GroupChat._refreshLatest(null);
        continue;
      }
      if (!type) continue;
      const key = GroupChat.threadKey(type, u.searchParams.get('thread_ref'));
      GroupChat._resyncThread(key, GroupChat.threads.get(key));
    }
  },

  // Registered once, the first time a channel connects: the watcher reads
  // whichever app this module is on when a re-read comes, so it outlives
  // app switches without being re-registered.
  _liveWatch: null,
  _watchLiveReads() {
    if (GroupChat._liveWatch) return;
    const live = typeof window !== 'undefined' && window.UsernodeReact && window.UsernodeReact.liveReads;
    if (!live || typeof live.watch !== 'function') return;
    GroupChat._liveWatch = live.watch((resync) => GroupChat._onLiveResync(resync), {
      reads: (u) => !!GroupChat.appSlug && u.pathname === `/api/apps/${GroupChat.appSlug}/messages`,
    });
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
    return GroupChat._threadEl('gc-thread-scroll')
      || GroupChat._threadEl('gc-thread-messages');
  },

  // How near the bottom a thread counts as followed (thread-shell.tsx's
  // THREAD_FOLLOW_PX, which its jump-to-latest button uses too).
  THREAD_FOLLOW_PX: 80,

  // #4513: an open thread's reader at the newest line stays there.
  //
  // The composer is a sibling below the scroller, so typing a second line
  // grows it and takes that height from the scroller: the bottom of the
  // stream went under the composer, and the thread no longer read as
  // followed. The general chat's ResizeObserver (`attachScrollHandlers`)
  // always put its own scroller back; a thread had none.
  //
  // So `_threadPinned` is kept from the reader's scroll events, and while it
  // holds, any change of size of the scroller (the composer growing or
  // shrinking, the keyboard) or of what it holds (the topic card, the rows,
  // an image loading) puts it back at the bottom. A reader up in the history
  // is never moved. The keyboard's own scrolls are held as the general
  // chat's are (lib/keyboard-hold.ts).
  _attachThreadFollow(scroll) {
    if (!scroll || scroll._gcFollowBound) return;
    scroll._gcFollowBound = true;
    const follow = () => {
      if (GroupChat._threadPinned && GroupChat._threadScrollEl() === scroll) {
        scroll.scrollTop = scroll.scrollHeight;
      }
    };
    const hold = window.UsernodeKeyboardHold
      ? window.UsernodeKeyboardHold.attach(scroll, {
        pinned: () => !!GroupChat._threadPinned,
        follow,
      })
      : null;
    scroll.addEventListener('scroll', () => {
      if (GroupChat._threadScrollEl() !== scroll) return;
      if (hold && hold.holding()) {
        if (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight > 1) follow();
        return;
      }
      GroupChat._threadPinned =
        scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < GroupChat.THREAD_FOLLOW_PX;
    }, { passive: true });
    if (typeof ResizeObserver === 'undefined') return;
    // A short thread fits with room to spare, so nobody scrolled it and the
    // flag never came on; when the composer then takes height from it, its
    // newest line is what must stay in view.
    //
    // Not while a topic page that opens at its top is still loading (polish
    // board #12): before its card and replies are in, every page "fits", and
    // pinning it then sent the reader to the bottom as the card painted and
    // again as its pictures arrived.
    let last = { client: scroll.clientHeight, content: scroll.scrollHeight };
    const ro = new ResizeObserver(() => {
      if (GroupChat._threadScrollEl() !== scroll) return;
      const host = scroll.id === 'gc-thread-scroll' && typeof scroll.querySelector === 'function'
        ? scroll.querySelector('#gc-thread-messages') : null;
      const loading = !!host && !!host.dataset && host.dataset.loaded !== '1';
      if (!loading && scroll.clientHeight < last.client && last.content - last.client <= 1) {
        GroupChat._threadPinned = true;
      }
      follow();
      last = { client: scroll.clientHeight, content: scroll.scrollHeight };
    });
    ro.observe(scroll);
    // The topic card and the messages host, in the fill layouts. The boxed
    // one scrolls the messages host itself.
    for (const child of Array.from(scroll.children)) ro.observe(child);
  },

  // Paint the active thread's cached messages into #gc-thread-messages.
  renderThread(opts) {
    const a = GroupChat.activeThread;
    // #4640: scoped to the mount's own host — a hidden Messages reply pane's
    // shell must not win a document-wide id lookup over the side panel's.
    const el = GroupChat._threadEl('gc-thread-messages');
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

    const language = ['chat', 'request', 'change'].includes(a.language) ? a.language : 'flat';
    const chat = language === 'chat';
    GroupChat._react()?.mountTranscript(el, 'thread');
    // #2387: a reply thread opens with the message it hangs off — from the
    // server's `root`, or the general stream's copy until that lands.
    let root = null;
    if (a.type === 'message') {
      root = st.root || GroupChat.messages.find((m) => Number(m.id) === Number(a.ref)) || null;
    }
    let rows = st.messages.map((m) => GroupChat._messageView(m, { language }));
    if (root) rows.unshift(GroupChat._messageView({ ...root, _threadRoot: true }, { language }));
    // #4453: a request's page is ONE stream in time order. Its GitHub
    // comments (AppView's per-issue cache, fetched once the page opens) join
    // the thread's own rows by when they were written, and the specs among
    // them all go to the head's spec cards and status card.
    let githubMore;
    if (language === 'request' && a.type === 'issue') {
      const extra = (typeof AppView !== 'undefined' && AppView._requestThreadRows)
        ? AppView._requestThreadRows(a.ref) : null;
      if (extra && extra.rows.length) rows = GroupChat._mergeByTime(rows, extra.rows);
      if (typeof AppView !== 'undefined' && AppView._reactDevBoard) {
        AppView._reactDevBoard()?.publishRequestThread(a.ref, rows);
      }
      // GitHub returned only the newest comments: the stream says so, and
      // links to the rest.
      githubMore = extra && extra.truncated ? { url: extra.htmlUrl || null } : null;
    }
    GroupChat._react()?.publishTranscript(
      rows,
      'thread',
      {
        earlier: !!(st.loaded && st.hasMore && st.messages.length),
        // In the chat language the quiet card says what an empty thread
        // means; the placeholder line is the flat thread's.
        // A request's page says it in its own "N replies" line instead.
        // A change's page (#4455) as well.
        placeholder: language === 'request' || language === 'change' ? null : st.loaded
          ? (st.messages.length || chat ? null
            // #4417: a topic's channel is a room, not a reply thread.
            : (a.type === 'category' ? PlatformI18n.t('chat:group.topicChannel.empty') : PlatformI18n.t('chat:group.thread.empty')))
          : (st.failed ? null : PlatformI18n.t('chat:group.thread.loading')),
        error: !st.loaded && st.failed ? PlatformI18n.t('chat:group.thread.failed') : null,
        language,
        ...(language === 'request' ? { request: { loaded: !!st.loaded, githubMore } } : {}),
        ...(a.markers ? { markers: a.markers } : {}),
        ...(language === 'change' ? { change: { loaded: !!(st.loaded || a.closed), closed: a.closed || null, issue: a.issue || null } } : {}),
        ...(chat && st.loaded ? {
          quiet: {
            variant: 'change',
            exhausted: !st.hasMore,
            canPost: !GroupChat._readOnly(),
            appName: GroupChat._appName()
              || '',
          },
        } : {}),
      },
      // A history page measures the scroller below; see render().
      { flush: !!(opts && opts.flush) },
    );
    el.dataset.loaded = st.loaded ? '1' : '';

    // A catch-up (#4177) changes rows at the bottom and inside the newest
    // page, not above the reader: the "Load earlier" offset below would move
    // them by however much was added under them.
    if (!scroll || (opts && opts.keepScroll)) return;
    if (wasLoaded) {
      scroll.scrollTop = prevTop + (scroll.scrollHeight - prevHeight);
    } else if (unified) {
      // #363: open a topic at the TOP so its card/body reads first; the user
      // scrolls down into the discussion (general chat lands at the bottom).
      // Once, as it mounts (polish board #12): the replies' first page lands
      // later, and sending the reader back to the top then was the page's
      // second jump.
      if (GroupChat._threadPlaced) return;
      GroupChat._threadPlaced = true;
      scroll.scrollTop = 0;
      GroupChat._threadPinned = false;
    } else {
      scroll.scrollTop = scroll.scrollHeight;
      GroupChat._threadPinned = true;
    }
  },

  // #4453: `rows` with `others` slotted in by time. The thread's own rows
  // keep the order the server gave them (a run of identical notices stays a
  // run, for the transcript's repeat fold); each of `others` (oldest first)
  // goes in before the first row written after it.
  _mergeByTime(rows, others) {
    const t = (row) => Date.parse((row && row.at) || '') || 0;
    const sorted = others.slice().sort((x, y) => t(x) - t(y));
    const out = [];
    let j = 0;
    for (const row of rows) {
      while (j < sorted.length && t(sorted[j]) <= t(row)) out.push(sorted[j++]);
      out.push(row);
    }
    while (j < sorted.length) out.push(sorted[j++]);
    return out;
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
      // The name the strip says after "Replying to"; with nobody to name,
      // `unnamed` says which sentence the composer draws instead.
      label: q.source === 'pr'
        ? (q.prNumber ? PlatformI18n.t('chat:group.quote.pr', { number: q.prNumber }) : PlatformI18n.t('chat:group.quote.prUnnumbered'))
        : (q.author ? `@${q.author}` : ''),
      // A pull request is not somebody's name: the strip has a sentence for it.
      pr: q.source === 'pr' ? String(q.prNumber || '') : null,
      unnamed: q.source === 'pr' ? null
        : q.authorMissing && q.author ? q.authorMissing
          : q.author ? null : (q.source === 'event' ? 'event' : 'message'),
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
        // The card names nobody: `author` is its stand-in, and the strip has its own sentence.
        authorMissing: 'sharedByUnknown' in row.dataset ? 'someone' : null,
        snippet: row.dataset.specTitle || PlatformI18n.t('chat:group.quote.spec'),
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
      if (firstAtt) snippet = `\u{1F4CE} ${firstAtt.textContent || firstAtt.getAttribute('alt') || PlatformI18n.t('chat:group.quote.file')}`;
    }
    return {
      source: 'message', refMsgId: id,
      author: row.dataset.username || null,
      // The row came with no author: `author` is the chat's stand-in for one.
      authorMissing: 'usernameMissing' in row.dataset ? 'system' : null,
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
      // #4029: a mention is never a tap-to-quote. A person's is a link to
      // their page (the browser follows it); Homeroom bot's is text, and a
      // tap on it does nothing rather than stage a reply to the row.
      if (e.target.closest('.gc-mention')) return;
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
      // activity drawer (GitHub fallback when it isn't there); #4668: a chip
      // with an address is a real link — Ctrl/Cmd/Shift/Alt click and the
      // middle button are the browser's (a new tab), so stand down without
      // preventing default and without staging a reply. Handled before
      // tap-to-quote so a chip click doesn't also stage a reply.
      const ref = e.target.closest('.gc-ref');
      if (ref) {
        if (ref.tagName === 'A' && (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)) return;
        e.preventDefault();
        GroupChat._openRef(ref);
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
      // Real links/buttons (PR link, "View full spec", channel refs) win.
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

    // #130: chips are spans with role="link" tabindex="0" (or, since #4668,
    // real anchors) — give keyboard users the same reveal a click gets.
    container.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const ref = e.target.closest && e.target.closest('.gc-ref');
      if (!ref) return;
      e.preventDefault();
      GroupChat._openRef(ref);
    });
  },

  // #4668: what a tap (or Enter / Space) on a `.gc-ref` chip does. A plain
  // span keeps #130's drawer reveal. A chip that names the request whose own
  // page is open scrolls back up to the request head, where its status and
  // any open vote are — reopening the page would change nothing on screen,
  // which is the case the request's screenshot shows. A chip with an address
  // for a different project than the one the app view has open follows it,
  // so a chip in a Messages-mounted thread opens the project it names.
  _openRef(chip) {
    const type = chip.dataset.refType;
    const num = chip.dataset.refNumber;
    const n = parseInt(num, 10);
    const slug = GroupChat._appSlug();
    const appSlug = (typeof AppView !== 'undefined' && AppView.appData && AppView.appData.slug) || null;
    const sameApp = !!(slug && appSlug && slug === appSlug);
    if (type === 'issue' && sameApp && typeof AppView !== 'undefined'
      && AppView._devTopic && AppView._devTopic.kind === 'issue'
      && Number(AppView._devTopic.id) === n) {
      GroupChat._threadPinned = false;
      const scroll = GroupChat._threadScrollEl();
      if (scroll && typeof scroll.scrollTo === 'function') {
        scroll.scrollTo({ top: 0, behavior: 'smooth' });
      }
      return;
    }
    if (!chip.getAttribute('href') || sameApp) {
      if (typeof AppView !== 'undefined' && AppView.revealInDrawer) {
        AppView.revealInDrawer(type, num);
      }
      return;
    }
    const href = chip.getAttribute('href');
    if (href) location.hash = href;
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
        PlatformUI.toast(next ? PlatformI18n.t('chat:group.bookmark.saveFailed') : PlatformI18n.t('chat:group.bookmark.unsaveFailed'));
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
        // `unnamed`: nobody to name, and `name` is the stand-in shown where a name would be.
        ? { name: String(last.username || PlatformI18n.t('chat:group.thread.unknownAuthor')), unnamed: !last.username, text: String(last.content || '') }
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
      snippet = `\u{1F4CE} ${meta.attachments[0].filename || meta.attachments[0].name || PlatformI18n.t('chat:group.quote.file')}`;
    }
    const quote = kind === 'spec_share'
      ? { source: 'spec', refMsgId: n, author: msg.username || null, snippet: (meta.specShare && meta.specShare.title) || PlatformI18n.t('chat:group.quote.spec') }
      : { source: 'message', refMsgId: n, author: msg.username || null, snippet };
    GroupChat.setQuote(quote, surface === 'thread' ? 'thread' : 'main');
  },

  // The address a message link opens — the channel in Messages, scrolled to
  // it (#messages/app/<slug>/m/<id>).
  //
  // Only for the general stream and its reply threads, which is what the
  // address can find: a message in an issue's or a proposal's discussion is
  // not in the channel, and its link would open the channel at the bottom.
  //
  // #4417 follow-up: a message of a topic's channel, or a reply in one of
  // its reply threads, is that channel's: `#messages/app/<slug>/c/<topic>/m/<id>`,
  // the address its notification has, which opens the channel on it.
  messageAddress(id) {
    const slug = GroupChat.appSlug;
    if (!slug) return null;
    let msg = null;
    GroupChat._eachCopy(id, (m) => { if (!msg) msg = m; });
    const type = msg && (msg.thread_type || (msg.thread && msg.thread.type) || null);
    if (!msg || (type && type !== 'message' && type !== 'category')) return null;
    const topic = GroupChat._topicOf(msg);
    if (topic) return `#messages/app/${encodeURIComponent(slug)}/c/${topic}/m/${Number(id)}`;
    if (type === 'category') return null;
    return `#messages/app/${encodeURIComponent(slug)}/m/${Number(id)}`;
  },

  // #4417 follow-up: the topic channel `msg` is in (its own, or its reply
  // thread's first message's), or null for the general stream. A reply's
  // root says where it is on a live frame (`threadRoot`) and in its open
  // thread (`root`); a root held in the pane's stream is the pane's.
  _topicOf(msg) {
    if (!msg) return null;
    const type = msg.thread_type || (msg.thread && msg.thread.type) || null;
    const ref = Number(msg.thread_type ? msg.thread_ref : (msg.thread && msg.thread.ref));
    if (type === 'category') return Number.isSafeInteger(ref) && ref > 0 ? ref : null;
    if (type !== 'message' || !Number.isSafeInteger(ref) || ref <= 0) return null;
    const open = GroupChat.threads.get(GroupChat.threadKey('message', ref));
    for (const root of [msg.threadRoot, open && open.root]) {
      if (root && root.thread_type !== undefined) {
        return root.thread_type === 'category' ? (Number(root.thread_ref) || null) : null;
      }
    }
    const held = GroupChat.messages.some((m) => Number(m && m.id) === ref && GroupChat._ownRow(m));
    return held ? GroupChat._channelRef() : null;
  },

  // The address of a reply thread under `rootId`, beside the channel the
  // pane shows (#4417 follow-up: a topic's, or the app's general stream).
  _threadAddress(slug, rootId) {
    const topic = GroupChat._channelRef();
    return `#messages/app/${encodeURIComponent(slug)}${topic ? `/c/${topic}` : ''}/thread/${Number(rootId)}`;
  },

  // Open the reply thread under a general-chat message, beside the channel.
  // #3653: on the channel's project page — its Discussion tab, where the room
  // lives — it opens there, in place: the room has no address of its own on
  // that page, and leaving for Messages to read a thread was leaving the
  // community for a page apart from it. Anywhere else (Homeroom's archived
  // app chat, in Messages) it is the thread's Messages address.
  // #4417 follow-up: a topic's channel, in the general pane on its project's
  // page, opens its reply threads beside it the same way.
  openReplyThread(id) {
    const slug = GroupChat.appSlug;
    if (!slug || !id) return;
    if (GroupChat._openThreadInPage(slug, id)) return;
    location.hash = `#messages/app/${encodeURIComponent(slug)}${GroupChat._channel ? `/c/${GroupChat._channel.ref}` : ''}/thread/${Number(id)}`;
  },

  // Is `slug`'s channel on screen in its project page's Discussion tab
  // (features/dev-board/workshop/project-discussion.tsx)? Then open the
  // reply thread under `rootId` there and say so. The target names the
  // topic whose channel it is (#4417 follow-up), so only that channel's
  // place takes it.
  _openThreadInPage(slug, rootId) {
    const container = document.getElementById('gc-messages');
    const tab = container && container.closest && container.closest('[data-ws-discussion]');
    if (!tab || tab.getAttribute('data-discussion-app') !== slug) return false;
    if (typeof AppView === 'undefined' || !AppView._stashDiscussionTarget) return false;
    AppView._stashDiscussionTarget(slug, { threadRootId: Number(rootId), topicRef: GroupChat._channelRef() });
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
      // #4177: the delete did not happen, so it comes out of every read's
      // record, and off a copy a read brought in meanwhile.
      GroupChat._forgetLive('delete', id);
      const was = before.length ? before[0][1] : null;
      if (was) {
        GroupChat._eachCopy(id, (m) => {
          if (m.deleted) Object.assign(m, { deleted: false, content: was.content, reactions: was.reactions, metadata: was.metadata });
        });
      }
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
    GroupChat._applyLive({ kind: 'delete', id });
    GroupChat._react()?.patchTranscriptMessage(id, {
      deleted: true, text: '', bodyHtml: '', quote: null, attachments: [], reactions: [], editedTitle: null,
    });
  },

  // A thread's new summary on its first message (the `thread_summary` frame).
  _applyThreadSummary(data) {
    const id = Number(data && (data.root_id ?? data.rootId));
    if (!id) return;
    GroupChat._applyLive({ kind: 'summary', id, thread: data.thread || null });
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
    // #4417 follow-up: nor, in a topic's channel, are they for its own.
    const newest = GroupChat.messages.reduce((top, m) => (
      m && GroupChat._ownRow(m) ? Math.max(top, Number(m.id) || 0) : top
    ), 0);
    if (!newest || newest <= (GroupChat._readUpTo || 0) || GroupChat._unreadHold === slug) return;
    GroupChat._readUpTo = newest;
    const channel = GroupChat._channel;
    try {
      // `?demo=1`: a staging demo stream's newest rows are mock ones, which
      // only the demo branch of the route knows (src/routes/chat.js).
      const res = await fetch(`/api/apps/${encodeURIComponent(slug)}/messages/read${GroupChat._specDemoQS()}`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ message_id: newest, ...GroupChat._cursorScope(channel) }),
      });
      // A channel's unread count lives in the project's places list
      // (dev-board/workshop/place-store.ts): a topic's by its ref, #general
      // by `ref` null. Messages' list re-reads #general's count besides.
      if (channel) {
        if (res && res.ok) window.UsernodeReact?.places?.channelRead?.(slug, channel.ref);
      } else {
        window.UsernodeReact?.messages?.refresh?.();
        if (res && res.ok) window.UsernodeReact?.places?.channelRead?.(slug, null);
      }
      // Drained, so the request ends: an answer nobody reads stays open in
      // the browser, and a page that reads its channel never went idle.
      if (res && typeof res.text === 'function') void res.text().catch(() => {});
    } catch (_) { /* the next open reads it again */ }
  },

  // #4417 follow-up: is `m` one of the pane's own messages (not a reply
  // drawn in it)? A loaded row says where it is in `thread_type`, a live
  // frame in `thread` (a loaded row's `thread` is its reply summary).
  _ownRow(m) {
    const type = m.thread_type || (m.thread && m.thread.type) || null;
    const ref = m.thread_type ? m.thread_ref : (m.thread && m.thread.ref);
    return type ? type === 'category' && GroupChat._isChannel({ type, ref }) : GroupChat._isChannel(null);
  },

  // The read routes' scope for a topic's channel (src/routes/chat.js
  // moveReadCursor), or nothing for the general stream.
  _cursorScope(channel) {
    return channel ? { thread_type: channel.type, thread_ref: channel.ref } : {};
  },

  // The channel's pane closed (#2387). "Mark unread" holds only while the
  // channel stays open: the socket outlives the pane, so without this the
  // hold lasted until another app's chat was opened, and the channel was
  // never read again before then.
  releaseUnreadHold(appSlug) {
    if (GroupChat._unreadHold && GroupChat._unreadHold === appSlug) GroupChat._unreadHold = null;
    // The "New" line lasts while the channel is open, too (_openAtUnread).
    if (GroupChat.appSlug === appSlug) {
      GroupChat._unreadMark = null;
      GroupChat._unreadOpened = false;
    }
  },

  async markUnread(id) {
    const slug = GroupChat.appSlug;
    if (!slug || !id) return;
    // #4417 follow-up: in a topic's channel, its own cursor.
    const channel = GroupChat._channel;
    const res = await fetch(`/api/apps/${encodeURIComponent(slug)}/messages/unread${GroupChat._specDemoQS()}`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ message_id: Number(id), ...GroupChat._cursorScope(channel) }),
    });
    if (!res.ok) throw new Error(`Mark unread failed (${res.status})`);
    // Stays unread while it is still the open channel: reading it again the
    // moment it was marked would undo the act.
    GroupChat._unreadHold = slug;
    GroupChat._readUpTo = 0;
    if (channel) window.UsernodeReact?.places?.channelRead?.(slug, channel.ref, true);
    else {
      window.UsernodeReact?.messages?.refresh?.();
      window.UsernodeReact?.places?.channelRead?.(slug, null, true);
    }
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
  // building, ready (with the change to try), live, fixing (a fix asked on
  // one of the bot's changes waiting for approval), or waiting_first_version
  // (held until the project's first version is live). Null for none.
  _botRequestView(value) {
    if (!value || typeof value !== 'object') return null;
    const status = ['reading', 'building', 'ready', 'live', 'fixing', 'waiting_first_version'].includes(value.status) ? value.status : null;
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
    GroupChat._followBotCards();
  },

  // The stages at which a card's request is still going (homeroom-bot-chat.js
  // CARD_STAGES), or waiting on approval that may come in at any time, or on
  // the project's first version going live.
  _BOT_CARD_GOING: new Set(['waiting_first_version', 'reading', 'waiting', 'building', 'checking', 'proposed', 'approved', 'fixing']),

  // Whether one card still has somewhere to go.
  _botCardGoing(card) {
    if (!card || (card.kind !== 'filed' && card.kind !== 'revise')) return false;
    return GroupChat._BOT_CARD_GOING.has((card.state && card.state.stage) || 'reading');
  },

  // While a card of the viewer's is still going, read the cards again in a
  // minute, so each says where its request stands now: the moments the
  // server pushes do not cover every turn (a fix's discussion turn on
  // somebody else's change, a vote). Only while this chat is open, and not
  // while the page is hidden.
  _followBotCards() {
    if (GroupChat._botCardsTimer) {
      clearTimeout(GroupChat._botCardsTimer);
      GroupChat._botCardsTimer = null;
    }
    const slug = GroupChat.appSlug;
    if (!slug || ![...GroupChat._botCards.values()].some((card) => GroupChat._botCardGoing(card))) return;
    GroupChat._botCardsTimer = setTimeout(() => {
      GroupChat._botCardsTimer = null;
      if (GroupChat.appSlug !== slug) return;
      if (typeof document !== 'undefined' && document.hidden) { GroupChat._followBotCards(); return; }
      void GroupChat._loadBotCards();
    }, 60 * 1000);
  },

  // The Homeroom bot started or finished work for the viewer (app.js turns
  // `homeroom_bot_work_changed` into the window event connect() listens for,
  // and sends it again after a reconnect): their cards may have moved.
  botWorkChanged() {
    if (GroupChat.appSlug && GroupChat._botCards.size) void GroupChat._loadBotCards();
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
      GroupChat._followBotCards();
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
      else if (!res.ok && window.PlatformUI) PlatformUI.toast(data.error || PlatformI18n.t('chat:group.bot.askFailed'));
    } catch {
      if (window.PlatformUI) PlatformUI.toast(PlatformI18n.t('chat:group.bot.askFailed'));
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

  // B9: the chat with Homeroom bot (See progress, Open chat). 16 Oct 2026
  // (C4): See progress opens it at the request's own thread, its story.
  openBotChat(issueNumber) {
    const messages = window.UsernodeReact && window.UsernodeReact.messages;
    const n = Number(issueNumber);
    if (messages && n && GroupChat.appSlug && typeof messages.openBotRequest === 'function') messages.openBotRequest(GroupChat.appSlug, n);
    else if (messages && typeof messages.openBot === 'function') messages.openBot();
    else location.hash = '#messages';
  },

  // Fix in place: the change a fix went to, on its page (See change).
  openBotChange(sessionId) {
    const id = Number(sessionId);
    if (!GroupChat.appSlug || !id) return;
    location.hash = `#app/${encodeURIComponent(GroupChat.appSlug)}/dev/proposals/${id}`;
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
    // Every copy: a reply is held in the general stream AND in its thread.
    GroupChat._applyLive({ kind: 'reaction', id: messageId, reactions: reactions || [] });
    const msg = GroupChat._findMessage(messageId);
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
    // No zero-padded hour (polish N5): "4:14 AM", as lib/timestamp.ts.
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const title = d.toLocaleString([], {
      year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
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
    return title ? PlatformI18n.t('chat:group.row.editedAt', { when: title }) : PlatformI18n.t('chat:group.row.editedTooltip');
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
        `<button type="button" class="gc-edit-save">${PlatformI18n.htmlText('core:common.save')}</button>` +
        `<button type="button" class="gc-edit-cancel">${PlatformI18n.htmlText('core:common.cancel')}</button>` +
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
        notice.textContent = PlatformI18n.t('chat:group.edit.notConnected');
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
    // Every copy: a reply is held in the general stream AND in its thread.
    GroupChat._applyLive({ kind: 'edit', id: messageId, content, editedAt });
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
        if (id) window.UsernodeReact?.dialogs?.report?.open({ targetType: 'app_message', target: id, label: PlatformI18n.t('chat:group.report.selected') });
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
  // per mount: the thread composer's nodes survive a remount (#4517), so its
  // caller passes the mount's `signal` and the previous mount's listeners,
  // which carry the previous topic's scope, are gone before these bind.
  setupAttachments(thread, signal) {
    const t = thread || null;
    const btn = document.getElementById(t ? 'gc-thread-attach-btn' : 'gc-attach-btn');
    const fileInput = document.getElementById(t ? 'gc-thread-file-input' : 'gc-file-input');
    if (!btn || !fileInput) return;

    // Pending uploads from other composer scopes are dropped (their
    // server rows fall to the 24h orphan sweep — harmless).
    const key = GroupChat._attachScopeKey(t);
    GroupChat.pendingAttachments = GroupChat.pendingAttachments.filter((a) => a.scope === key);
    GroupChat._renderAttachStrip(t);

    const opts = signal ? { signal } : undefined;
    btn.addEventListener('click', () => fileInput.click(), opts);
    fileInput.addEventListener('change', () => {
      if (fileInput.files?.length) GroupChat._addFiles(fileInput.files, t);
      fileInput.value = '';
    }, opts);

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
      }, opts);
    }

    // Drag-and-drop onto the message area or the composer.
    const dropEls = [
      document.getElementById(t ? 'gc-thread-form' : 'gc-form'),
      document.getElementById(t ? 'gc-thread-messages' : 'gc-messages'),
    ];
    for (const el of dropEls) {
      if (!el) continue;
      el.addEventListener('dragover', (e) => { e.preventDefault(); }, opts);
      el.addEventListener('drop', (e) => {
        if (e.dataTransfer?.files?.length) {
          e.preventDefault();
          GroupChat._addFiles(e.dataTransfer.files, t);
        }
      }, opts);
    }
    GroupChat._wireDropZone(dropEls, t);
  },

  // #4065: show the drop zone while a file is held over the composer or its
  // messages. The drop itself is the listener above; this only counts the
  // drag in and out (features/attachments/file-drag.tsx's tracker, reached
  // through the bridge) and publishes `dragging` into the composer's slot,
  // where the React card draws the outline. One tracker per composer scope,
  // shared by both elements, so moving from the messages to the box is one
  // drag. Never lit on a read-only thread, where nothing can be dropped.
  _dropTrackers: { general: null, thread: null },
  _wireDropZone(els, thread) {
    const api = typeof window !== 'undefined' && window.UsernodeReact && window.UsernodeReact.fileDrag;
    if (!api || !api.createFileDragTracker) return;
    const scope = GroupChat._composerScope(thread);
    const previous = GroupChat._dropTrackers[scope];
    if (previous) { previous.reset(); previous.dispose(); }
    const tracker = api.createFileDragTracker({
      isDisabled: () => GroupChat._readOnly(),
      onChange: (dragging) => GroupChat._publishComposer(scope, { dragging }),
    });
    GroupChat._dropTrackers[scope] = tracker;
    for (const el of els) {
      if (!el) continue;
      // The form survives a re-render now (it is React's), so its listeners
      // are bound once and read whichever tracker is current for the scope.
      if (el._gcDropZone) continue;
      el._gcDropZone = true;
      el.addEventListener('dragenter', (e) => GroupChat._dropTrackers[scope]?.enter(e));
      el.addEventListener('dragleave', (e) => GroupChat._dropTrackers[scope]?.leave(e));
      el.addEventListener('drop', () => GroupChat._dropTrackers[scope]?.reset());
    }
  },

  // The line a drop or a pick shows when it left files out: the first reason,
  // and how many more went with it (#4065).
  _refusalSummary(first, more) {
    const api = typeof window !== 'undefined' && window.UsernodeReact && window.UsernodeReact.fileDrag;
    if (api && api.refusalSummary) return api.refusalSummary(first, more);
    return first;
  },

  // Mirror the server's classifier (src/services/attachments.js
  // validateChatUpload) closely enough for instant feedback; UTF-8
  // sniffing reads the bytes, cheap under the 10 MB cap.
  async _classifyChatFile(file) {
    const L = GroupChat.ATTACH_LIMITS;
    const ext = (file.name.toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
    if (L.imageExts.includes(ext)) {
      if (file.size > L.maxImageBytes) {
        return { error: PlatformI18n.t('chat:group.attach.tooBig.image', { file: file.name, megabytes: Math.round(L.maxImageBytes / 1024 / 1024) }) };
      }
      return { kind: 'image' };
    }
    if (ext === 'md' || ext === 'markdown') {
      if (file.size > L.maxMarkdownBytes) {
        return { error: PlatformI18n.t('chat:group.attach.tooBig.markdown', { file: file.name, kilobytes: Math.round(L.maxMarkdownBytes / 1024) }) };
      }
      return { kind: 'markdown' };
    }
    if (ext === 'html' || ext === 'htm') {
      if (file.size > L.maxHtmlBytes) {
        return { error: PlatformI18n.t('chat:group.attach.tooBig.html', { file: file.name, megabytes: Math.round(L.maxHtmlBytes / 1024 / 1024) }) };
      }
      return { kind: 'html' };
    }
    if (file.size > L.maxBinaryBytes) {
      return { error: PlatformI18n.t('chat:group.attach.tooBig.other', { file: file.name, megabytes: Math.round(L.maxBinaryBytes / 1024 / 1024) }) };
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
    // #4065: one line for every file this drop or pick left out — the first
    // reason, and how many more went with it — not whichever came last.
    let firstRefusal = null;
    let refused = 0;
    const refuse = (reason, count = 1) => {
      firstRefusal = firstRefusal || reason;
      refused += count;
      GroupChat._setAttachError(GroupChat._refusalSummary(firstRefusal, refused - 1), thread);
    };
    const files = Array.from(fileList);
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      if (GroupChat.pendingAttachments.filter((a) => a.scope === key).length >= L.maxPerMessage) {
        refuse(PlatformI18n.t('chat:group.attach.maxPerMessage', { count: L.maxPerMessage }), files.length - i);
        break;
      }
      const classified = await GroupChat._classifyChatFile(file);
      if (classified.error) {
        refuse(classified.error);
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
        if (!res.ok) throw new Error(data?.error || PlatformI18n.t('chat:group.attach.uploadFailedStatus', { status: res.status }));
        entry.id = data.id;
        entry.kind = data.kind;
        entry.meta = data.meta || null;
        entry.uploading = false;
        // #2938: a send tapped mid-upload left the wait notice up; once the
        // last upload in this composer lands there is nothing to wait for.
        if (!GroupChat.attachmentsUploading(thread)
            && GroupChat._attachWaiting[GroupChat._composerScope(thread)]) {
          GroupChat._setAttachError(null, thread);
        }
      } catch (err) {
        GroupChat.pendingAttachments = GroupChat.pendingAttachments.filter((a) => a !== entry);
        if (entry.objectUrl) { try { URL.revokeObjectURL(entry.objectUrl); } catch { /* already revoked */ } }
        GroupChat._setAttachError(err.message || PlatformI18n.t('chat:group.attach.uploadFailed'), thread);
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
    // Whether the line is the wait notice is state, taken as it is set: the
    // notice's words follow the language on screen and are not compared later.
    GroupChat._attachWaiting[scope] = !!msg && msg === GroupChat.UPLOAD_WAIT_NOTICE;
    GroupChat._publishComposer(scope, { attachError: msg || null });
  },

  // What each composer's error line currently says, so an upload finishing
  // can take down the wait notice without erasing a real error (#2938).
  _attachErrors: { general: null, thread: null },

  // Shown when Send is tapped while an attachment is still uploading.
  // A getter: read in the language on screen each time it is shown.
  get UPLOAD_WAIT_NOTICE() { return PlatformI18n.t('chat:group.attach.stillUploading'); },

  // Whether each composer's error line is that wait notice (see _setAttachError).
  _attachWaiting: { general: false, thread: false },

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
        name: a.filename || PlatformI18n.t('chat:group.attachment.unnamed'),
        unnamed: !a.filename,
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
        name: a.filename || PlatformI18n.t('chat:group.attachment.unnamed'),
        // No file name: the tooltips have their own wording, and `name` is only a label.
        unnamed: !a.filename,
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
        btn.getAttribute('data-att-name') || 'file.md',
        // The chip's name is a stand-in: the failure line has its own wording.
        btn.hasAttribute('data-att-unnamed')
      );
    }, true);
  },

  // Fetch a markdown attachment (served text/plain) and render it in the
  // spec side panel (same panel as "View full spec"). Falls back to a
  // plain download when the panel slot isn't in the current tab's DOM.
  async _openMarkdownAttachment(url, filename, unnamed) {
    if (!url) return;
    if (!document.getElementById('gc-spec-side-panel')) {
      window.open(url, '_blank', 'noopener');
      return;
    }
    try {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(unnamed
          ? PlatformI18n.t('chat:group.file.loadFailedStatusUnnamed', { status: res.status })
          : PlatformI18n.t('chat:group.file.loadFailedStatus', { file: filename, status: res.status }));
      }
      const text = await res.text();
      GroupChat._showSpecPanel({ title: filename, content: text });
    } catch (err) {
      GroupChat._showSpecPanel({ title: filename, content: err.message || PlatformI18n.t('chat:group.file.loadFailed'), isError: true });
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
  // come (`liveSoon`, which the old merge path set on a self-hosted merge;
  // the merge-followups machine announces a merge once it is live); false on
  // a row without it, whose wording then decides.
  _mergeLiveSoon(msg) {
    const meta = (msg.metadata || msg.meta || {}).merged;
    return !!(meta && typeof meta === 'object' && meta.liveSoon === true);
  },

  // The names a merge announcement carries as metadata (the merge-followups
  // machine's merged line), or null on a row without them.
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
    // #4367: the change's pull request number, when the PR resolved is it.
    const prNumber = pr && pr.pr_number != null && String(pr.id) === String(id)
      ? Number(pr.pr_number) || null : null;
    return (typeof App !== 'undefined' && App._appUrl)
      ? App._appUrl(slug, 'dev', { kind: 'proposal', id: Number(id), ...(prNumber ? { pr: prNumber } : {}) }, 'topic')
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
      title: meta.title || PlatformI18n.t('chat:group.spec.title', { version: meta.version }),
      // The preview title the panel header shows while the fetch is in
      // flight. It was a `data-spec-title` attribute the click delegate read
      // back off the card; it is a field now, so nothing has to round-trip
      // through the DOM to find it.
      previewTitle: meta.title || PlatformI18n.t('chat:group.spec.previewTitle', { version: meta.version }),
      sharedBy: meta.sharedBy?.username || msg.username || PlatformI18n.t('chat:group.spec.someone'),
      // Nobody to name: the lines that say who shared it have an unnamed
      // wording, and never take the stand-in above as a username.
      sharedByUnknown: !(meta.sharedBy?.username || msg.username),
      version: meta.version,
      built,
      prNumber: meta.prNumber || null,
      sessionId: meta.sessionId || null,
      // Homeroom bot's plan says where it stands in one sentence on a
      // request's page (homeroom-bot-live.js specCard): it is building it,
      // or it waits for whoever asked for it to say Build it. Papote #3:
      // or a newer plan replaced it, or it stopped waiting (notePlanRows).
      botNote: ['building', 'waiting', 'replaced', 'stopped'].includes(meta.botNote) ? meta.botNote : null,
      waitingFor: meta.botNote === 'waiting' && typeof meta.waitingFor === 'string' && meta.waitingFor ? meta.waitingFor : null,
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
    const title = previewTitle || PlatformI18n.t('chat:group.spec.title', { version });
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
            ? PlatformI18n.t('chat:group.spec.gone')
            : PlatformI18n.t('chat:group.spec.loadFailed', { status: resp.status }),
          isError: true,
        });
        return;
      }
      const data = await resp.json();
      GroupChat._showSpecPanel({
        title,
        version,
        content: data.spec.content || PlatformI18n.t('chat:group.spec.empty'),
        html: data.spec.content_html || null,
        builtAt: data.spec.built_at,
        prNumber: data.spec.pr_number,
      });
    } catch (err) {
      GroupChat._showSpecPanel({
        title,
        version,
        content: PlatformI18n.t('chat:group.spec.error', { message: err.message }),
        isError: true,
      });
    }
  },

  // (#1012) Raw markdown currently displayed in the spec panel, kept in
  // JS state because the panel rewrites its own innerHTML and nothing
  // else retains `content`. Deliberately NOT a data- attribute: a spec
  // is multi-KB markdown full of quotes and newlines.
  _specPanelRaw: null,

  _showSpecPanel({ title, version, content, html = null, builtAt, prNumber, isError, canCopy = true }) {
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
    if (prNumber) subtitleParts.push(PlatformI18n.t('chat:group.quote.pr', { number: prNumber }));
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
    // #3699: a version written as HTML renders from its own document, with
    // the dev chat viewer's two tabs (frontend/src/lib/spec-html.ts);
    // `content`, its markdown copy, is still what Copy markdown takes.
    const specHtml = !isError && html && window.UsernodeReact && window.UsernodeReact.specHtml;
    const doc = specHtml && typeof specHtml.render === 'function'
      ? specHtml.render(String(html), { key: `gc-${version == null ? 'x' : version}` })
      : null;
    const body = isError
      ? { kind: 'error', text: String(content == null ? '' : content) }
      : doc
        ? { kind: 'spec', ...doc }
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
    const previewTitle = title || PlatformI18n.t('chat:group.spec.title', { version });

    // Show the panel header right away (skeleton body) so the user
    // sees something immediately while the spec content loads.
    GroupChat._showSpecPanel({
      title: previewTitle,
      version,
      content: PlatformI18n.t('chat:group.spec.loading'),
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
            ? PlatformI18n.t('chat:group.spec.gone')
            : PlatformI18n.t('chat:group.spec.loadFailed', { status: resp.status }),
          isError: true,
        });
        return;
      }
      const data = await resp.json();
      if (GroupChat.appSlug !== appSlug) return;
      GroupChat._showSpecPanel({
        title: previewTitle,
        version,
        content: data.spec.content || PlatformI18n.t('chat:group.spec.empty'),
        html: data.spec.content_html || null,
        builtAt: data.spec.built_at,
        prNumber: data.spec.pr_number,
      });
    } catch (err) {
      if (GroupChat.appSlug !== appSlug) return;
      GroupChat._showSpecPanel({
        title: previewTitle,
        version,
        content: PlatformI18n.t('chat:group.spec.error', { message: err.message }),
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
        status: queued > 0 ? PlatformI18n.t('chat:group.status.reconnectingQueued', { count: queued }) : PlatformI18n.t('chat:group.status.reconnecting'),
      });
      return;
    }

    const names = [...GroupChat.typingUsers.values()].filter((n) => n !== App.user?.username);
    GroupChat._publishComposer('general', {
      status: names.length === 0 ? ''
        : names.length === 1 ? PlatformI18n.t('chat:group.typing.one', { name: names[0] })
          : PlatformI18n.t('chat:group.typing.several', { names: PlatformI18n.listText(names) }),
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
    // 5 Oct 2026: the keyboard coming up for the composer moves this
    // scroller too (the app's web view resizing, iOS Safari revealing the
    // field), and a scroll event it caused away from the bottom read as the
    // reader scrolling up, so the room stopped following its newest line
    // while they typed. lib/keyboard-hold.ts (the same hold as Messages'
    // conversation) says when a scroll event is the keyboard's: then the
    // view goes back to the bottom, still locked there, and no history loads.
    const pinBottom = () => {
      container.scrollTop = container.scrollHeight;
      GroupChat._savedScrollTop = container.scrollTop;
    };
    const hold = window.UsernodeKeyboardHold
      ? window.UsernodeKeyboardHold.attach(container, {
        pinned: () => !!GroupChat._lockedToBottom,
        follow: pinBottom,
      })
      : null;
    container.addEventListener('scroll', () => {
      if (hold && hold.holding()) {
        if (GroupChat._lockedToBottom
          && container.scrollHeight - container.scrollTop - container.clientHeight > 1) pinBottom();
        return;
      }
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

  // #4417 follow-up: `topicRef` names one of the project's topic channels,
  // whose pane must be the one showing (a notification for a message in it,
  // project-discussion.tsx TopicChannel); none is the app's general stream.
  revealMessage(appSlug, messageId, topicRef = null) {
    const id = Number(messageId);
    if (!appSlug || !Number.isSafeInteger(id) || id <= 0) return;
    const ref = Number(topicRef);
    const channel = Number.isSafeInteger(ref) && ref > 0 ? ref : null;
    GroupChat._pendingReveal = { slug: appSlug, id, at: Date.now(), ...(channel ? { channel } : {}) };
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
    // #4417 follow-up: a topic channel's message, for that channel's pane.
    if ((want.channel || null) !== GroupChat._channelRef()) return false;
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
        const address = GroupChat._threadAddress(want.slug, root);
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
    GroupChat._revealFlash = { id: want.id, until: Date.now() + 1500 };
    GroupChat._react()?.patchTranscriptMessage(want.id, { flash: true });
    setTimeout(() => GroupChat._react()?.patchTranscriptMessage(want.id, { flash: false }), 1500);
    return true;
  },

  // The message a reveal is marking, and until when (#4417 follow-up: a
  // notification's message, in #general or a topic's channel). Its row is
  // built flashed while the mark lasts.
  _revealFlash: null,
  _revealFlashing(id) {
    const f = GroupChat._revealFlash;
    return !!f && id != null && Number(id) === f.id && Date.now() < f.until;
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
      // #4417 follow-up: looked for in the channel the pane shows.
      const channel = GroupChat._channel;
      const scope = channel
        ? `&thread_type=${encodeURIComponent(channel.type)}&thread_ref=${encodeURIComponent(channel.ref)}` : '';
      const res = await fetch(
        `/api/apps/${encodeURIComponent(slug)}/messages?around=${want.id}&limit=1${scope}${GroupChat._demoParam()}`
      );
      if (!live()) return;
      if (!res.ok) { GroupChat._pendingReveal = null; return; }
      const body = await res.json();
      const root = Number(body && body.focus && body.focus.thread_ref);
      if (Number.isSafeInteger(root) && root > 0 && root !== want.id) {
        GroupChat._pendingReveal = null;
        // On the project page, beside the channel there (#3653).
        if (GroupChat._openThreadInPage(slug, root)) return;
        const address = GroupChat._threadAddress(slug, root);
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
  const handles = new Set();
  try {
    const list = window.UsernodeReact?.messages?.channels?.() || [];
    for (const item of list) handles.add(item.handle);
  } catch {}
  // #4417: and, inside a project, its topics' handles and the ones they had
  // before a rename (features/dev-board/workshop/place-store.ts).
  for (const handle of Object.keys(knownTopicHandles())) handles.add(handle);
  return handles;
}

// #4417: the topic handles a `#name` can mean in the project whose chat is
// on screen, each to the handle the topic has now. Inside the project they
// come before the platform's own channels of the same name.
function knownTopicHandles() {
  try {
    const slug = typeof App !== 'undefined' ? App.currentApp : null;
    return (slug && window.UsernodeReact?.places?.topicHandles?.(slug)) || {};
  } catch {
    return {};
  }
}

// Where a `#name` link goes: a topic's channel on its project's page, or the
// platform channel in Messages.
function channelRefLink(handle) {
  const topic = knownTopicHandles()[handle];
  const slug = typeof App !== 'undefined' ? App.currentApp : null;
  if (topic && slug) {
    return { href: `#app/${encodeURIComponent(slug)}/dev/c/${topic}`, handle: topic, topic: true };
  }
  return { href: `#messages/channel/${handle}`, handle, topic: false };
}

// #4029: a mention is a link to that person's page, the address a project's
// contributors and Kudos' Top users open. Homeroom bot has no person page, so
// its mention ("@Homeroom bot", or its handle) stays text.
function isBotMention(name) {
  const key = String(name || '').toLowerCase();
  return key === 'homeroom bot' || key === 'homeroom_bot';
}

function mentionHref(name) {
  return `#leaderboard/users/${encodeURIComponent(name)}`;
}

function renderWithMentions(raw) {
  const escaped = escapeHtml(raw || '');
  const me = (App.user?.username || '').toLowerCase();
  // B9: "@Homeroom bot" is one mention, the bot's display form.
  const withMentions = escaped.replace(/(^|[^\w])@([A-Za-z0-9_]{1,32}(?:(?<=homeroom) bot\b)?)/gi, (_m, pre, name) => {
    const isMe = name.toLowerCase() === me;
    const cls = isMe ? 'gc-mention gc-mention-self' : 'gc-mention';
    if (isBotMention(name)) return `${pre}<span class="${cls}">@${name}</span>`;
    return `${pre}<a class="${cls}" href="${mentionHref(name)}" data-mention="${name}">@${name}</a>`;
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
    const link = channelRefLink(handle);
    const topicAttr = link.topic ? ` data-topic-ref="${link.handle}"` : '';
    return `${pre}<a class="gc-channel-ref" href="${link.href}" data-channel-ref="${link.handle}"${topicAttr}>#${handle}</a>`;
  });
}

// #4668: a chip's address. Real links when the chat names a project (the
// #N one opens that project's request, the PR#N one the change's page, the
// #4367 address the topic route resolves from a pull request number — same
// shape as frontend/src/lib/change-href.ts); null when it does not (a DM
// has no project to open), which leaves today's plain span.
function refChipHref(isPr, num) {
  const slug = GroupChat._appSlug();
  if (!slug) return null;
  return `#app/${encodeURIComponent(slug)}/dev/${isPr ? 'changes' : 'issues'}/${num}`;
}

// #130: second replacement pass over the (already escaped, mention-marked)
// content — `PR#N` / `PR #N` render as violet PR chips and bare `#N` as
// emerald issue chips. One combined regex so `PR#12` is never double-matched
// by the issue pattern. The `&` exclusion in the boundary keeps escaped
// entities from chipping; the trailing lookahead keeps `#12abc` plain.
// Clicking / Enter / Space on a chip routes through GroupChat._openRef (see
// _attachQuoteHandlers): a plain span goes to AppView.revealInDrawer and an
// anchor carries its own address. Refs are a pure display convention, so
// message content stays plain text on the wire and in the DB. The href holds
// no `#<digit>` or `#<letter>` after a permitted boundary (`"#app/…` sits
// after `"`, which renderChannelChips excludes), so the later passes never
// match inside it.
function renderRefChips(html) {
  return html.replace(/(^|[^\w&])(pr ?#|#)(\d{1,7})(?!\w)/gi, (_m, pre, prefix, num) => {
    const isPr = prefix.length > 1; // `PR#` / `PR #` vs bare `#`
    const cls = isPr ? 'gc-ref gc-ref-pr' : 'gc-ref gc-ref-issue';
    const type = isPr ? 'pr' : 'issue';
    const label = isPr ? `PR#${num}` : `#${num}`;
    const href = refChipHref(isPr, num);
    if (href) {
      return `${pre}<a class="${cls}" href="${href}" data-ref-type="${type}" data-ref-number="${num}">${label}</a>`;
    }
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

// The viewer's username, lower-cased: their own mention gets `-self`.
function viewerMentionKey() {
  return (typeof App !== 'undefined' && App.user && App.user.username
    ? App.user.username : '').toLowerCase();
}

// Replace one text node with [text, <a class="gc-mention">…</a>,
// <span class="gc-ref">…</span>, …] when it contains mentions/refs.
function decorateTextNode(textNode) {
  const value = textNode.nodeValue != null ? textNode.nodeValue : (textNode.textContent || '');
  replaceTextWithSegments(textNode, tokenizeMentionsAndRefs(value, viewerMentionKey(), knownChannelHandles()));
}

// The tokenizer's segments, built through DOM APIs in place of `textNode`.
function replaceTextWithSegments(textNode, segs) {
  if (segs.length === 1 && segs[0].type === 'text') return; // nothing to decorate
  const parent = textNode.parentNode;
  if (!parent) return;
  const frag = document.createDocumentFragment();
  for (const seg of segs) {
    if (seg.type === 'text') {
      frag.appendChild(document.createTextNode(seg.value));
    } else if (seg.type === 'mention') {
      // #4029: a link to the person's page; Homeroom bot's stays text.
      const bot = isBotMention(seg.name);
      const el = document.createElement(bot ? 'span' : 'a');
      el.className = seg.isSelf ? 'gc-mention gc-mention-self' : 'gc-mention';
      if (!bot) {
        el.setAttribute('href', mentionHref(seg.name));
        el.setAttribute('data-mention', seg.name);
      }
      el.textContent = `@${seg.name}`;
      frag.appendChild(el);
    } else if (seg.type === 'channel') {
      // #2783: a real link — see .gc-channel-ref in app.css for why it is
      // not a `.gc-ref`.
      const link = document.createElement('a');
      const to = channelRefLink(seg.handle);
      link.className = 'gc-channel-ref';
      link.setAttribute('href', to.href);
      link.setAttribute('data-channel-ref', to.handle);
      // #4417: a topic's channel, on its project's page.
      if (to.topic) link.setAttribute('data-topic-ref', to.handle);
      link.textContent = `#${seg.handle}`;
      frag.appendChild(link);
    } else { // ref
      // #4668: an anchor when the chat names a project — a link one can open
      // in a new tab. No role or tabindex: an anchor is focusable and a link
      // already. No slug (a DM, the test sandbox): today's span.
      const href = refChipHref(seg.isPr, seg.num);
      const el = document.createElement(href ? 'a' : 'span');
      el.className = seg.isPr ? 'gc-ref gc-ref-pr' : 'gc-ref gc-ref-issue';
      el.setAttribute('data-ref-type', seg.isPr ? 'pr' : 'issue');
      el.setAttribute('data-ref-number', seg.num);
      if (href) {
        el.setAttribute('href', href);
      } else {
        el.setAttribute('role', 'link');
        el.setAttribute('tabindex', '0');
      }
      el.textContent = seg.isPr ? `PR#${seg.num}` : `#${seg.num}`;
      frag.appendChild(el);
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
// `opts.mentionsOnly` (#3952, a request's text) leaves every ref and channel
// as text, the way an unknown `#word` is left.
function tokenizeMentionsAndRefs(text, me, channels, opts) {
  const mentionsOnly = !!(opts && opts.mentionsOnly);
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
    if (mentionsOnly && m[3] == null) continue;
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

// ── #3952: @mentions in a request's text ──────────────────────────────
//
// A request's description and its comments name people the way a chat
// message does ("@snait lmk wyt"), so they get the chat's mention links: the
// same tokenizer, markup and Homeroom bot exception as above, mentions only.
// A request's `#12` or `PR#3` opens nothing on its page, so it stays text.
//
// Only a mention Homeroom wrote is linked. Everything Homeroom sends to
// GitHub goes through services/github.js safeMention, which puts a
// zero-width space after each `@` so GitHub pings nobody; that guard is how a
// name typed here is told apart from a GitHub handle in an issue or comment
// written on GitHub itself, which names a GitHub account rather than a person
// here, and stays text. The guard comes out of every text node, display
// only, so what reads (and copies) is what was typed, a code block's
// `@scope/pkg` included. Takes and returns sanitized HTML (the output of
// DevChat.renderMarkdown); app-view.js calls it for a request's body and its
// GitHub comments.
const GC_MENTION_GUARD = '@​';

function renderRequestMentions(html) {
  const text = html == null ? '' : String(html);
  if (text.indexOf(GC_MENTION_GUARD) === -1) return text;
  if (typeof document === 'undefined' || !document.createElement) return text;
  const root = document.createElement('div');
  root.innerHTML = text;
  decorateRequestMentions(root, false);
  return root.innerHTML;
}

// Walk like decorateMentionsAndRefs, but into <a>/<code>/<pre> too
// (`literal`): the guard comes out there, and nothing is linked.
function decorateRequestMentions(node, literal) {
  const children = node.childNodes ? Array.prototype.slice.call(node.childNodes) : [];
  for (const child of children) {
    if (child.nodeType === 3) {
      const value = child.nodeValue != null ? child.nodeValue : (child.textContent || '');
      if (value.indexOf(GC_MENTION_GUARD) === -1) continue;
      if (literal) child.nodeValue = value.split(GC_MENTION_GUARD).join('@');
      else decorateGuardedMentions(child, value);
    } else if (child.nodeType === 1) {
      decorateRequestMentions(child, literal || GC_DECORATE_SKIP.has((child.tagName || '').toUpperCase()));
    }
  }
}

function decorateGuardedMentions(textNode, value) {
  // The text without the guard, and where each guarded `@` lands in it.
  const guarded = new Set();
  let plain = '';
  for (let i = 0; i < value.length; i += 1) {
    if (value.startsWith(GC_MENTION_GUARD, i)) {
      guarded.add(plain.length);
      i += GC_MENTION_GUARD.length - 1;
      plain += '@';
    } else {
      plain += value[i];
    }
  }
  const segs = [];
  let offset = 0;
  let linked = false;
  for (const seg of tokenizeMentionsAndRefs(plain, viewerMentionKey(), null, { mentionsOnly: true })) {
    const raw = seg.type === 'text' ? seg.value : `@${seg.name}`;
    if (seg.type === 'mention' && guarded.has(offset)) {
      segs.push(seg);
      linked = true;
    } else if (segs.length && segs[segs.length - 1].type === 'text') {
      segs[segs.length - 1].value += raw;
    } else {
      segs.push({ type: 'text', value: raw });
    }
    offset += raw.length;
  }
  if (linked) replaceTextWithSegments(textNode, segs);
  else textNode.nodeValue = plain;
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
    // #4571: remember the slug on the element too, so a composer kept across
    // topic mounts (#4517) picks up the new project when its listener
    // retakes the menu below. The singleton stays "whoever attached last"
    // here; the per-event `own()` is what makes the menu follow the box
    // being typed in.
    input._gcMentionSlug = slug;
    MentionAutocomplete._input = input;
    MentionAutocomplete._slug = slug;
    if (document.activeElement === input) MentionAutocomplete._loadCandidates(slug);

    if (input._gcMentionBound) return;
    input._gcMentionBound = true;

    // The menu answers for ONE box at a time — whichever was used last.
    // Without this, a composer mounted after this one (the side panel's
    // thread beside a tab's, or vice versa) left this box's keystrokes
    // reading the other's value and caret, and no menu opened.
    const own = () => {
      if (MentionAutocomplete._input !== input) {
        MentionAutocomplete.close();
        MentionAutocomplete._input = input;
        MentionAutocomplete._slug = input._gcMentionSlug;
      }
    };
    input.addEventListener('focus', () => {
      own();
      MentionAutocomplete._loadCandidates(MentionAutocomplete._slug);
    });

    input.addEventListener('compositionstart', () => { MentionAutocomplete._composing = true; });
    input.addEventListener('compositionend', () => {
      MentionAutocomplete._composing = false;
      own(); MentionAutocomplete._sync();
    });
    input.addEventListener('input', () => { own(); MentionAutocomplete._sync(); });
    input.addEventListener('click', () => { own(); MentionAutocomplete._sync(); });
    input.addEventListener('keyup', (e) => {
      // The keys we manage in the capture-phase keydown handler don't
      // change the token; skip re-detecting on their keyup.
      if (['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(e.key)) return;
      own(); MentionAutocomplete._sync();
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
    // #4571: the slug on the element, as MentionAutocomplete now keeps it —
    // a composer kept across topic mounts picks up the new project when its
    // listener retakes the menu below.
    input._gcRefSlug = slug;
    RefAutocomplete._input = input;
    RefAutocomplete._slug = slug;
    if (document.activeElement === input) RefAutocomplete._loadCandidates(slug);

    if (input._gcRefBound) return;
    input._gcRefBound = true;

    // Same retarget as the mention menu's `own()`: the menu answers for
    // whichever composer was used last, so a box typed into after another
    // was mounted still opens its own list.
    const own = () => {
      if (RefAutocomplete._input !== input) {
        RefAutocomplete.close();
        RefAutocomplete._input = input;
        RefAutocomplete._slug = input._gcRefSlug;
      }
    };
    input.addEventListener('focus', () => {
      own();
      RefAutocomplete._loadCandidates(RefAutocomplete._slug);
    });

    input.addEventListener('compositionstart', () => { RefAutocomplete._composing = true; });
    input.addEventListener('compositionend', () => {
      RefAutocomplete._composing = false;
      own(); RefAutocomplete._sync();
    });
    input.addEventListener('input', () => { own(); RefAutocomplete._sync(); });
    input.addEventListener('click', () => { own(); RefAutocomplete._sync(); });
    input.addEventListener('keyup', (e) => {
      if (['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(e.key)) return;
      own(); RefAutocomplete._sync();
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
        .map((pr) => ({ number: pr.pr_number, title: pr.pr_title || PlatformI18n.t('chat:group.ref.byUser', { username: pr.username || '' }), kind: 'pr' }));
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

// The words this module publishes (the transcripts' placeholder and error
// lines, the reply strip, the status line) are read as they are published:
// publish them again, from the state already held, when the language on
// screen changes or this module's text arrives.
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('homeroom:language-changed', () => {
    if (!GroupChat.appSlug) return;
    GroupChat.render();
    GroupChat.renderThread({ keepScroll: true });
    GroupChat._renderQuotePreview();
    GroupChat._renderStatusLine();
  });
}
window.MentionAutocomplete = MentionAutocomplete;
window.RefAutocomplete = RefAutocomplete;
window.EmojiAutocomplete = EmojiAutocomplete;
