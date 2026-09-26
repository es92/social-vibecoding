// Top-right notifications dropdown.
//
// MOVED, NOT REWRITTEN (#1079 chunk B). This was public/js/notifications.js —
// a classic <script> — until #notifications-panel became a React island. The
// body is unchanged so the rendered rows stay byte-identical (dapp.json
// selects against them); only the two window publications at the bottom and
// the init() trigger moved. It is plain .js rather than .ts deliberately: a
// mechanical retype of 1,300 lines of untyped DOM code would hide the "this is
// the same module" property that makes the move reviewable, and the tests that
// load this file in a vm keep working unchanged.
//
// The panel's chassis (root, header row, the three leaf containers) is
// rendered by ./index.tsx. This module owns everything INSIDE those
// containers — it is now the only writer, since no public/js/** module
// reaches into them.
//
// Lifecycle:
//  - init() wires the bell button + dropdown controls, does the initial
//    /api/notifications fetch (so the badge is correct on page load even
//    if all pending notifs were queued while the user was offline).
//  - handleIncoming() is called by app.js when a `notification_new`
//    WS event arrives — updates the in-memory list, badge, and dropdown
//    if open.
//  - clicking a leaf item navigates to the app's group-chat tab and
//    marks that one read.
//
// #1385 flat list: `items` stays the single newest-first source of truth, and
// the dropdown renders ONE ROW PER NOTIFICATION in that order — no per-app
// headers, no expand/collapse, no per-group leaf pager.
//
// It used to nest (#84): a collapsed header row per app carrying a count and
// the newest item's preview, expandable to reveal per-kind leaves, with the
// expansion set persisted to localStorage. That earned its keep when the
// drawer showed everything ever received, where one busy app could bury
// another's single row. Two later changes took the premise away —
// notifications arrive newest-first, and #1367's follow-up moved the READ ones
// behind "See older notifications", so the default list is only what is new.
// Grouping a short unread list by app costs a tap to read anything and buys
// nothing back. Every row also NAMES its own app in its text already (see
// rowView, which builds every kind's segments around `appLine`), so the header
// was repeating the row directly beneath it.
//
// Older pages still load through the keyset cursor (nextBefore/hasMore). The
// control that pulls them is now ONE button at the foot of the list instead of
// one inside each expanded group, and that relocation is load-bearing rather
// than cosmetic: `_showMoreGroup` was the only caller of `loadMore()` in the
// codebase, so removing the group chrome without replacing it would have
// stranded server pagination on page one.

// The module's one import (#1808). Notification rows used to carry a
// hand-rolled relative age with no floor, so a year-old row read "412d ago";
// the shared helper prints a real date past a week. Bundled, not imported by
// Node, in tests/notification-row-lines.test.js — see the note there.
import { agoStamp } from '../../lib/timestamp';

const NATIVE_INVALIDATION_TIMEOUT_MS = 10000;
const NATIVE_INVALIDATION_REFRESH_VERSION = 1;

const Notifications = {
  // #1191 slice 6: the drawer's two innerHTML hosts are React now. This module
  // still owns the fetches, the mark-read discipline, the click routing and
  // the badges; what it no longer does is build DOM. `_renderList` and
  // `_renderInvites` compute a descriptor tree and push it here, and
  // ./notifications-list.tsx renders it.
  //
  // Planted by ./mount.ts, which is the only module in this feature that may
  // import React. It stays null in the vm harnesses that evaluate this file as
  // a classic script (see ./notifications-store.js for why that matters), and
  // both render methods no-op when it is — exactly as they used to when
  // getElementById came back null.
  _store: null,
  // social-push.js is cached independently from the React shell bundle. It
  // must not trust the older refreshAfterInvalidation implementation, which
  // reported success even when its ordinary cacheable refresh failed.
  nativeInvalidationRefreshVersion: NATIVE_INVALIDATION_REFRESH_VERSION,
  items: [],   // newest-first; the single source of truth
  // Pending collaborator invites (authoritative, from the first-page
  // /api/notifications payload). Rendered as a pinned section above the
  // grouped list with Accept / Decline actions.
  invites: [],
  // #1280: messages this user saved with the bookmark button in group
  // chat, newest save first (also from the first-page payload). Rendered
  // as the TOP pinned section — above the invites and the grouped list —
  // and they stay there until unsaved, from the message or from here.
  //
  // Deliberately NOT folded into `items`: a save is not a notification. It
  // has no unread state, so it must not touch the badge, the mark-all
  // path, the grouping transform or the pagination cursor — all of which
  // operate on `items` alone.
  saved: [],
  unread: 0,
  // `open` is a GETTER now, defined beside show()/hide() below — the drawer
  // owns the presentation, so this module derives the state rather than
  // storing a flag that would disagree with the screen during the drawer's
  // deferred exit. A plain `open: false` here would shadow it.
  // Pagination cursor for the list's foot "Load older notifications" pager.
  nextBefore: null,  // { createdAt, id } | null
  hasMore: false,
  loading: false,
  // The Messages tab's own cursor, walked by loadOlderMessages() over
  // `?kind=conversation`. Deliberately separate from the three above: the two
  // queries skip different rows, so sharing a cursor would let one tab's
  // paging strand rows the other can then never reach. `msgHasMore` starts
  // true because the tab has not asked yet — the first press is what
  // discovers whether there is anything older.
  msgNextBefore: null,  // { createdAt, id } | null
  msgHasMore: true,
  msgLoading: false,
  // Only the newest first-page refresh may replace the authoritative feed.
  // This prevents an older boot/bell request from completing after a native
  // network-only invalidation and overwriting its fresher result.
  _refreshGeneration: 0,
  // Once a native invalidation starts, this document must never replace its
  // feed with the service worker's older API-cache fallback. Raise the floor
  // before the request awaits so a later overlapping ordinary refresh is also
  // network-only. Failed reads preserve the last rendered snapshot while the
  // Social coordinator retains and retries the invalidation.
  _networkFreshnessFloor: false,

  init() {
    // THE UI OVERHAUL merged the bell into the hamburger, so #notifications-btn
    // is gone and so is the outside-click dismissal that used to live here:
    // opening, closing and dismissing this list are all the drawer's business
    // now (features/header/header-menu-controller.js). What is left is the
    // "Mark all read" control, which is still this module's.
    const markAll = document.getElementById('notifications-mark-all');
    if (markAll) markAll.addEventListener('click', Notifications.markAllRead);

    // Every drawer open starts on the "new" list rather than wherever the last
    // visit left it: the drawer opens on what is NEW. This used to re-fold the
    // app groups on the same announcement; #1385 removed them, so the show-older
    // reset is all that is left of that pair.
    document.addEventListener('sv:drawer-open', () => {
      Notifications._setShowOlder(false);
    });

    // Anonymous SPA boot (fold-auth-pages-into-SPA): the initial fetch
    // waits for the authed boot stage instead of firing a guaranteed 401
    // on a sessionless document. `sv:authed` fires at most once.
    if (window.App && App.user) Notifications.refresh();
    else document.addEventListener('sv:authed',
      () => Notifications.refresh(), { once: true });
  },

  // --- fetching --------------------------------------------------------

  async refresh(options) {
    const generation = ++Notifications._refreshGeneration;
    try {
      // ?demo=1 forwarding (preserved on the page URL): staging injects
      // mock session-related rows on the first page so the cog drawer's
      // pinned section is reviewable (routes/notifications.js
      // stagingMockNotifications). No-op in production.
      const demo = new URLSearchParams(location.search).get('demo') === '1' ? '&demo=1' : '';
      const explicitlyNetworkOnly = options && options.networkOnly === true;
      if (explicitlyNetworkOnly) Notifications._networkFreshnessFloor = true;
      const networkOnly = explicitlyNetworkOnly ||
        Notifications._networkFreshnessFloor;
      // The previous service worker classifies this request as an ordinary
      // cacheable API read. A per-attempt URL prevents that worker from
      // replaying an earlier invalidation response while a new page is waiting
      // for the updated worker to take control.
      const invalidationNonce = networkOnly
        ? (typeof crypto !== 'undefined' &&
            typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `${Date.now().toString(36)}-${generation.toString(36)}-` +
            Math.random().toString(36).slice(2))
        : null;
      const invalidation = networkOnly
        ? `&native_invalidation=1&native_invalidation_nonce=${encodeURIComponent(invalidationNonce)}`
        : '';
      let timeout = null;
      let controller = null;
      if (networkOnly && typeof AbortController === 'function') {
        controller = new AbortController();
        timeout = setTimeout(
          () => controller.abort(),
          NATIVE_INVALIDATION_TIMEOUT_MS
        );
      }
      let res;
      let data;
      try {
        res = await fetch(
          `/api/notifications?limit=100${demo}${invalidation}`,
          networkOnly ? {
            credentials: 'same-origin',
            cache: 'no-store',
            ...(controller ? { signal: controller.signal } : {}),
          } : undefined
        );
        if (!res.ok) return false;
        data = await res.json();
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      if (generation !== Notifications._refreshGeneration) return false;
      Notifications.items = Array.isArray(data.notifications) ? data.notifications : [];
      Notifications.invites = Array.isArray(data.pendingInvites) ? data.pendingInvites : [];
      Notifications.saved = Array.isArray(data.savedMessages) ? data.savedMessages : [];
      Notifications.unread = data.unread || 0;
      Notifications.hasMore = !!data.hasMore;
      Notifications.nextBefore = data.nextBefore || null;
      Notifications._reconcileCompletionTitle();
      Notifications._renderBadge();
      // Rendered UNCONDITIONALLY now, where this was gated on `open`.
      //
      // The gate existed because the bell's panel was presented on demand and
      // filled at that moment: show() rendered the three sections before
      // handing the node to the kit, precisely so the sheet measured the right
      // height. THE UI OVERHAUL moved the list into the hamburger, which is
      // always mounted — translated off-screen rather than built on open — so
      // there is no "before presenting" to render at, and no cost to keeping
      // the store current. The payoff is that the drawer opens onto CURRENT
      // rows instead of last-open's.
      Notifications._renderSaved();
      Notifications._renderInvites();
      Notifications._renderList();
      // After the first populated refresh, so a deep-linked drawer opens
      // onto real rows rather than an empty-state flash.
      Notifications._maybeShotOpen();
      return true;
    } catch (err) {
      console.warn('[notifications] refresh failed', err);
      return false;
    }
  },

  // Native foreground push is only an invalidation signal. Re-read the
  // authenticated notification feed; no notification copy crosses the
  // WebView bridge.
  async refreshAfterInvalidation() {
    if (!window.App || !App.user) return false;
    return Notifications.refresh({ networkOnly: true });
  },

  // Resolve a native push's opaque id through the current Social session,
  // then reuse the existing click router and mark-read behavior. The exact
  // endpoint is ownership-scoped and intentionally returns no route from the
  // untrusted push payload.
  async openById(rawId) {
    const id = Number(rawId);
    if (!Number.isSafeInteger(id) || id <= 0 || id > 2147483647) return false;
    let item = Notifications.items.find((candidate) => candidate.id === id);
    if (!item) {
      try {
        const res = await fetch(`/api/notifications/${id}`, {
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (!res.ok) return false;
        const data = await res.json();
        item = data && data.notification;
        if (!item || item.id !== id) return false;
        Notifications.items.unshift(item);
      } catch (err) {
        console.warn('[notifications] exact lookup failed', err);
        return false;
      }
    }
    try {
      return await Notifications._onItemClick(id) !== false;
    } catch (err) {
      console.warn('[notifications] destination failed', err);
      return false;
    }
  },

  async loadMore() {
    if (Notifications.loading || !Notifications.hasMore || !Notifications.nextBefore) return;
    Notifications.loading = true;
    try {
      const { createdAt, id } = Notifications.nextBefore;
      const params = new URLSearchParams({
        limit: '100',
        before: String(createdAt),
        before_id: String(id),
      });
      const res = await fetch(`/api/notifications?${params.toString()}`);
      if (!res.ok) return;
      const data = await res.json();
      const incoming = Array.isArray(data.notifications) ? data.notifications : [];
      // Append, deduping on id (a concurrent prepend could overlap).
      const seen = new Set(Notifications.items.map((n) => n.id));
      for (const n of incoming) {
        if (!seen.has(n.id)) {
          Notifications.items.push(n);
          seen.add(n.id);
        }
      }
      Notifications.hasMore = !!data.hasMore;
      Notifications.nextBefore = data.nextBefore || null;
      Notifications._renderList();
    } catch (err) {
      console.warn('[notifications] loadMore failed', err);
    } finally {
      Notifications.loading = false;
    }
  },

  /**
   * Page the CONVERSATION kinds specifically, on their own cursor.
   *
   * The Messages tab is a client-side filter over the shared feed, so it
   * cannot page on the shared cursor: a page of 100 older rows is 100 older
   * rows of everything, and on a busy account it routinely contains no message
   * at all. That is why the tab's footer link used to be a jump to All rather
   * than a pager — it was the honest thing to offer while the only page
   * available was the unfiltered one.
   *
   * `?kind=conversation` (src/routes/notifications.js) makes a filtered page
   * possible, and this walks it on `msgNextBefore` — kept SEPARATE from
   * `nextBefore` on purpose. Advancing the shared cursor past rows this query
   * skipped would strand every non-message notification between the two
   * positions, so the All tab could never reach them. Rows still land in the
   * one shared `items` array, deduped, because both tabs render from it.
   */
  async loadOlderMessages() {
    if (Notifications.msgLoading || !Notifications.msgHasMore) return;
    Notifications.msgLoading = true;
    Notifications._renderList();
    try {
      const params = new URLSearchParams({ limit: '100', kind: 'conversation' });
      // First press has no cursor: it starts from the newest message and pages
      // back, and the dedup below drops everything already on screen.
      if (Notifications.msgNextBefore) {
        params.set('before', String(Notifications.msgNextBefore.createdAt));
        params.set('before_id', String(Notifications.msgNextBefore.id));
      }
      const res = await fetch(`/api/notifications?${params.toString()}`);
      if (!res.ok) return;
      const data = await res.json();
      const incoming = Array.isArray(data.notifications) ? data.notifications : [];
      const seen = new Set(Notifications.items.map((n) => n.id));
      for (const n of incoming) {
        if (!seen.has(n.id)) {
          Notifications.items.push(n);
          seen.add(n.id);
        }
      }
      // Re-sort: a filtered page reaches further back than the shared cursor
      // has, so its rows do not simply append in feed order the way loadMore's
      // do. The list is created_at DESC with id as the tiebreak, matching the
      // server's ORDER BY.
      Notifications.items.sort((a, b) => {
        const at = new Date(a.createdAt || a.created_at || 0).getTime();
        const bt = new Date(b.createdAt || b.created_at || 0).getTime();
        return (bt - at) || (Number(b.id) - Number(a.id));
      });
      Notifications.msgHasMore = !!data.hasMore;
      Notifications.msgNextBefore = data.nextBefore || null;
    } catch (err) {
      console.warn('[notifications] loadOlderMessages failed', err);
    } finally {
      Notifications.msgLoading = false;
      Notifications._renderList();
    }
  },

  handleIncoming(notif) {
    if (!notif) return;
    // Dedup on id — a reconnect might replay the same notification that
    // /api/notifications already returned.
    const existing = Notifications.items.findIndex((n) => n.id === notif.id);
    if (existing >= 0) {
      Notifications.items[existing] = notif;
    } else {
      Notifications.items.unshift(notif);
    }
    if (!notif.readAt) Notifications.unread += 1;
    // #161: a completion arriving while the user is away from the
    // browser tab sets the dedicated tab-title marker (the replacement
    // for the old streaming-driven "✅ Done"). If they're actively
    // looking at the page, the badge + drawer suffice.
    // #3181: a turn that stopped before finishing is the other half of a
    // finished one, and arrives on the same channels with its own marker.
    if (PRIORITY_KINDS.has(notif.kind)
        && !notif.readAt
        && window.DevChat && DevChat.setCompletionTitle
        && DevChat._userIsAway && DevChat._userIsAway()) {
      DevChat.setCompletionTitle(notif.kind === 'session_done'
        ? 'sessionDone'
        : notif.kind === 'session_stalled'
          ? 'sessionStalled'
          : (notif.detail === 'failed' ? 'autoSolveFailed' : 'autoSolveDone'));
    }
    // #138: route an arriving completion through the alert channels — a
    // chime when the app is visible, an OS notification when it's hidden.
    // The visible/hidden split lives in DevAlerts.onCompletion. This is the
    // "user is elsewhere in the app, or backgrounded" path (notify_on_done
    // was armed, so a notification_new arrives); the "watching the same dev
    // chat" path is handled by DevChat._finishStreaming's direct tone.
    if (PRIORITY_KINDS.has(notif.kind)
        && !notif.readAt
        && window.DevAlerts && typeof DevAlerts.onCompletion === 'function') {
      DevAlerts.onCompletion(completionAlertInfo(notif));
    }
    // A live collab invite needs the authoritative pendingInvites list
    // (the notification row alone can't drive the actionable section) —
    // refresh re-pulls it along with the first page.
    if (notif.kind === 'collab_invite' || notif.kind === 'approver_invite') {
      Notifications.refresh();
      return;
    }
    Notifications._renderBadge();
    Notifications._renderList();
  },

  // ── Presentation: the hamburger drawer ──────────────────────────
  //
  // This module used to own a surface of its own — #notifications-panel, an
  // anchored dropdown on desktop and a kit bottom sheet on touch, both
  // presented from here. THE UI OVERHAUL merged the bell into the hamburger,
  // so the list is rendered inside #header-menu-panel and the DRAWER owns the
  // presentation, including the kit adoption. These three forward to it so
  // every existing caller — a notification click, a screenshot deep link, the
  // native Social coordinator — keeps working unchanged.
  //
  // `open` is derived rather than stored because both surfaces defer their
  // exit behind a spring (see HeaderMenu.isPresenting and the sheet
  // controller's dismiss promise), so a flag set here would disagree with
  // what is on screen for ~200ms after a close.
  //
  // It asks about the SHEET and the drawer both. The rows are the sheet's now
  // (Streamlined Concept), but this module's own dismiss-before-you-navigate
  // rule predates that and still has to cover a drawer somebody opened.
  get open() {
    return !!window.NotificationsSheet?.isOpen?.();
  },

  toggle() {
    if (Notifications.open) Notifications.hide();
    else Notifications.show();
  },

  show() {
    window.NotificationsSheet?.open?.();
  },

  hide() {
    window.NotificationsSheet?.close?.();
  },

  // Screenshot-state deep link (`?shot=notifications`): the list only exists
  // behind a click on the hamburger, so the capture pipeline and any dapp.json
  // test would otherwise never see it — and #1280's saved section lives
  // nowhere else. Pair it with ?demo=1 in staging so the pinned sections have
  // mock rows to render. Once per page load — reopening after a manual
  // dismiss would fight the user, and refresh() runs again on live events.
  //
  // `?shot=notifications-messages` opens it ON THE MESSAGES TAB. That is
  // React state inside the sheet, so without a URL that reaches it neither
  // the capture pipeline nor a declared check could see the tab, its
  // collapsed conversation rows, its "All messages" entry, or the agent
  // session rows it draws (#2815 folded the Agents tab into it) — the
  // platform's own rule for a screen that is otherwise only reachable by
  // clicking. The sheet reads the same parameter for the tab; this only has
  // to open it.
  //
  _shotOpened: false,
  _maybeShotOpen() {
    if (Notifications._shotOpened || Notifications.open) return;
    let shot = null;
    try { shot = new URLSearchParams(location.search).get('shot'); } catch { /* ignore */ }
    if (shot !== 'notifications' && shot !== 'notifications-messages') return;
    Notifications._shotOpened = true;
    // The list is the Notifications SHEET now (Streamlined Concept), so the
    // deep link resolves a screen underneath and presents over it rather
    // than opening the drawer.
    if (window.App?.openNotificationsSheet) window.App.openNotificationsSheet();
    else Notifications.show();
  },

  // #1329: a presented drawer is MODAL on touch — it covers the screen the
  // action navigates to, so leaving it up strands the user under a stuck,
  // mostly-empty sheet over a dimmed backdrop. Every action below that
  // actually routes calls this first.
  //
  // It closes the drawer at EVERY width now. The rule used to be sheet-gated,
  // so the desktop anchored dropdown could keep its documented keep-open
  // behaviour; there is no anchored dropdown any more, and a side drawer left
  // open over the screen you just navigated to is the same problem the touch
  // sheet had.
  _dismissSheetForNav() {
    if (Notifications.open) Notifications.hide();
  },

  // --- mark read -------------------------------------------------------

  async markAllRead() {
    // Mark-all clears EVERYTHING the bell counts, session kinds included.
    //
    // It used to exclude them (`exclude_kinds: [...SESSION_NOTIF_KINDS]`) on
    // the grounds that the session badge was a second surface with a mark-all
    // of its own. That surface is gone: the completed-session count is part of
    // the bell's number now, and an exclusion here would leave a count nothing
    // in the drawer can dismiss — which is the bug this change exists to fix.
    if (Notifications.unread === 0) return;
    try {
      const res = await fetch('/api/notifications/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      });
      if (!res.ok) return;
      const data = await res.json();
      Notifications.unread = data.unread || 0;
      const now = new Date().toISOString();
      Notifications.items = Notifications.items.map((n) => (
        { ...n, readAt: n.readAt || now }
      ));
      Notifications._reconcileCompletionTitle();
      Notifications._renderBadge();
      Notifications._renderList();
      // #449: an open group chat may be showing unread dots for the
      // mentions/replies/reactions that were just cleared — reconcile
      // them from the now-read items list right away, instead of relying
      // solely on the server's notifications_changed round-trip.
      window.GroupChat?.reconcileDotsFromNotifications?.();
    } catch (err) {
      console.warn('[notifications] markAllRead failed', err);
    }
  },

  // #161: drop the tab-title completion marker once no unread completion
  // notification remains (drawer click, group/app mark-read, mark-all,
  // or a cross-tab notifications_changed refresh). The visibility/focus
  // return handler in dev-chat.js is the other clearing path.
  _reconcileCompletionTitle() {
    if (!window.DevChat || !DevChat.setCompletionTitle || !DevChat._titleCompletion) return;
    if (!Notifications.items.some(isPriorityNotif)) DevChat.setCompletionTitle(null);
  },

  async _markOneRead(id) {
    // Optimistically mark read in-memory and re-render the open drawer
    // right away: the unread dot disappears and unread-first sorting
    // updates live, instead of waiting for the network round-trip (which
    // is why a clicked item used to stay unread until close/reopen).
    const item = Notifications.items.find((n) => n.id === id);
    if (item && !item.readAt) {
      item.readAt = new Date().toISOString();
      if (Notifications.unread > 0) Notifications.unread -= 1;
      Notifications._reconcileCompletionTitle();
      Notifications._renderBadge();
      Notifications._renderList();
    }
    try {
      const res = await fetch('/api/notifications/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) return;
      const data = await res.json();
      // Reconcile with the server's authoritative unread count.
      Notifications.unread = data.unread || 0;
      Notifications._renderBadge();
    } catch (err) {
      console.warn('[notifications] markOneRead failed', err);
    }
  },

  // Reading a conversation clears its notifications. Reflect that in THIS
  // document, without a second round-trip.
  //
  // `POST /api/conversations/:id/read` already marks every unread
  // notification row for that conversation read server-side (see markRead in
  // services/conversations.js — including the invite, which carries no
  // message id and so matches its NULL branch). Nothing needs asking for.
  // What needs fixing is local: this tab's `items`/`unread` would otherwise
  // stay stale until the next refresh, so the bell would go on counting
  // messages you have just sat and read.
  //
  // That was survivable while the Messages row owned the messages count and
  // the bell subtracted it. The bell owns it now, so a stale badge is the
  // visible bug — which is why this reconcile lands in the same change.
  //
  // Called by the Messages store on a local read, and on a `conversation_read`
  // for this same viewer in another tab. `window.Notifications` is the seam:
  // this module stays import-free (see the top of the file), so the store
  // calls in rather than being imported.
  markConversationRead(conversationId) {
    const id = Number(conversationId);
    if (!Number.isSafeInteger(id) || id <= 0) return;
    const now = new Date().toISOString();
    let cleared = 0;
    for (const n of Notifications.items) {
      if (!n || n.readAt || Number(n.conversationId) !== id) continue;
      // #2387: an alert about a message inside a reply thread waits for that
      // thread to be read, as it does server-side.
      if (n.conversationThreadRootId) continue;
      n.readAt = now;
      cleared += 1;
    }
    if (!cleared) return;
    // `unread` is the server's account-wide total; only ever walk it down by
    // what was actually cleared here, and never below zero.
    Notifications.unread = Math.max(0, Notifications.unread - cleared);
    Notifications._renderBadge();
    Notifications._renderList();
  },

  // #2387: one reply thread of a conversation was read — its alerts (a reply
  // in it, a mention in it) clear, and nothing else of the conversation's.
  markConversationThreadRead(conversationId, rootId) {
    const id = Number(conversationId);
    const root = Number(rootId);
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(root) || root <= 0) return;
    const now = new Date().toISOString();
    let cleared = 0;
    for (const n of Notifications.items) {
      if (!n || n.readAt || Number(n.conversationId) !== id) continue;
      if (Number(n.conversationThreadRootId) !== root) continue;
      n.readAt = now;
      cleared += 1;
    }
    if (!cleared) return;
    Notifications.unread = Math.max(0, Notifications.unread - cleared);
    Notifications._renderBadge();
    Notifications._renderList();
  },


  // #2847: the viewer opened a proposal card, or touched something on it, so
  // its "New proposal" nudge is answered — clear it the way a vote already
  // does server-side. Called by AppView (the topic page and the dev board's
  // delegated card click) through `window.Notifications`. Skipped when
  // nothing is unread, so the common click costs no request; the server
  // scopes the clear to pr_proposed rows for this one session.
  async markProposalSeen(sessionId) {
    const id = Number(sessionId);
    if (!Number.isSafeInteger(id) || id <= 0 || Notifications.unread === 0) return;
    const now = new Date().toISOString();
    for (const n of Notifications.items) {
      if (n && !n.readAt && n.kind === 'pr_proposed' && Number(n.sessionId) === id) n.readAt = now;
    }
    try {
      const res = await fetch('/api/notifications/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: id }),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (!data.cleared) return;
      Notifications.unread = data.unread || 0;
      Notifications._renderBadge();
      Notifications._renderList();
    } catch (err) {
      console.warn('[notifications] markProposalSeen failed', err);
    }
  },

  // #1688: a row's own button. 'still_yes' re-casts a Yes on the proposal a
  // re-confirm ask names — the server carries the earlier line along, and
  // the vote's auto-dismiss clears the row. Anything else opens the row.
  async _onRowAction(id, key) {
    const item = Notifications.items.find((n) => n.id === id);
    if (!item) return false;
    if ((key === 'friend_accept' || key === 'friend_decline') && item.kind === 'friend_request') {
      return Notifications._answerFriendRequest(item, key === 'friend_accept');
    }
    const sessionId = Number(item.sessionId);
    if (key === 'still_yes' && Number.isFinite(sessionId) && sessionId > 0
        && window.AppView && typeof AppView.castVote === 'function') {
      await AppView.castVote(sessionId, 'yes', null, { reason: null });
      Notifications._markOneRead(id);
      if (typeof Notifications.refresh === 'function') Notifications.refresh();
      return true;
    }
    return Notifications._onItemClick(id);
  },

  // #2386: Accept / Decline right on a friend request row. The server marks
  // the row read and answers the relationship; the row stops offering the
  // buttons (`friendRequestPending`), and the page's friend caches hear about
  // it through the same DOM event the profile button raises
  // (features/friends/api.ts FRIENDS_CHANGED_EVENT) — an event, not an
  // import, because this module stays import-free. A decline tells the sender
  // nothing; the toast is only ever the viewer's own confirmation.
  async _answerFriendRequest(item, accept) {
    const userId = Number(item.sourceUserId);
    if (!Number.isSafeInteger(userId) || userId <= 0) return false;
    const toast = (message) => {
      if (typeof PlatformUI !== 'undefined' && PlatformUI.toast) PlatformUI.toast(message);
    };
    try {
      const init = {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: '{}',
      };
      const res = accept
        ? await fetch(`/api/friends/${userId}/accept`, init)
        : await fetch(`/api/friends/${userId}/decline`, init);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(data.error && res.status === 429 ? data.error : 'Couldn’t answer this friend request. Try again.');
        return false;
      }
      item.friendRequestPending = false;
      if (!item.readAt) {
        item.readAt = new Date().toISOString();
        if (Notifications.unread > 0) Notifications.unread -= 1;
        Notifications._renderBadge();
      }
      Notifications._renderList();
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('usernode:friends-changed'));
      }
      const who = item.sourceUsername ? `@${item.sourceUsername}` : 'them';
      if (accept) toast(data.state === 'friends' ? `You and ${who} are friends` : 'This request was withdrawn');
      else toast('Request declined');
      return true;
    } catch (err) {
      console.warn('[notifications] friend answer failed', err);
      toast('Couldn’t answer this friend request. Try again.');
      return false;
    }
  },

  _onItemClick(id) {
    const item = Notifications.items.find((n) => n.id === id);
    if (!item) return false;
    // Desktop: deliberately do NOT hide the anchored panel here — it stays
    // open over the navigated-to view so the user can keep clicking through
    // other notifications, and only dismisses via outside-click or the
    // explicit close button. Touch is the opposite contract (#1329): the kit
    // bottom sheet is modal and would COVER the destination screen, so each
    // branch below that actually routes calls _dismissSheetForNav() first —
    // a no-op when no sheet is presented.
    Notifications._markOneRead(id);
    if (item.kind === 'test_alert') {
      Notifications._dismissSheetForNav();
      window.location.hash = '#settings/alerts';
      return;
    }
    // Platform conversations are never routed through an app tab. Prefer the
    // React bridge because it re-renders even when this is the current hash;
    // the hash fallback keeps native exact-notification opens functional
    // during shell startup before the island publishes its controller.
    if (CONVERSATION_NOTIF_KINDS.has(item.kind)) {
      const conversationId = Number(item.conversationId);
      if (Number.isSafeInteger(conversationId) && conversationId > 0
          && conversationId <= 2147483647) {
        Notifications._dismissSheetForNav();
        const messages = window.UsernodeReact?.messages;
        // #2387: a row about a message or a thread opens that ADDRESS. The
        // bridge's openAddress re-runs the router when it is the address
        // already in the bar; open(id) would move to the bare conversation
        // and close the thread the row is about.
        const href = conversationNotificationHref(item);
        if (messages?.openAddress) messages.openAddress(href);
        else window.location.hash = href;
      }
      return;
    }
    // #2386: a friend request or acceptance is about a PERSON, so it opens
    // their page — where the relationship's own button lives.
    if (FRIEND_NOTIF_KINDS.has(item.kind)) {
      if (item.sourceUsername) {
        Notifications._dismissSheetForNav();
        window.location.hash = `#profile/${encodeURIComponent(item.sourceUsername)}`;
      }
      return;
    }
    if (item.kind === 'app_quota_changed' || item.kind === 'app_quota_request_declined') {
      Notifications._dismissSheetForNav();
      App.showCreateModal();
      return;
    }
    // #2161: the app this row is about no longer exists, so there is nothing
    // to open. Home is the one screen that is still true.
    if (item.kind === 'app_deleted') {
      Notifications._dismissSheetForNav();
      if (typeof App !== 'undefined' && App.navigateHome) App.navigateHome();
      else window.location.hash = '#home';
      return;
    }
    if (item.kind === 'app_quota_requested') {
      Notifications._dismissSheetForNav();
      App.navigateToAdminConsole('users');
      return;
    }
    if (item.kind === 'openrouter_key_created' || item.kind === 'openrouter_key_review') {
      Notifications._dismissSheetForNav();
      if (typeof App !== 'undefined' && App.navigateToAdminConsole) {
        App.navigateToAdminConsole('users');
      } else {
        window.location.hash = '#admin/users';
      }
      return;
    }
    // A platform limit opens where it is raised. MAX_APPS lives in the
    // platform's Platform variables panel, opened over the current screen
    // like the create dialog does; the session cap opens Health & status,
    // whose capacity meter shows the load behind it. Either falls back to
    // Health & status when the panel or the platform's slug is unavailable.
    if (item.kind === 'platform_limit') {
      Notifications._dismissSheetForNav();
      const limit = parsePlatformLimitDetail(item.detail);
      const selfSlug = typeof window !== 'undefined' && window.PlatformTarget?.slug
        ? window.PlatformTarget.slug() : null;
      if (limit?.limit === 'apps' && selfSlug && typeof window.Secrets?.open === 'function') {
        window.Secrets.open(selfSlug);
      } else if (typeof App !== 'undefined' && App.navigateToAdminConsole) {
        App.navigateToAdminConsole('status');
      } else {
        window.location.hash = '#admin/status';
      }
      return;
    }
    // #161/#194: completion notifications deep-link to their change.
    // session_done opens the lifecycle-aware detail page around its workspace;
    // auto_solve_done opens the Issues tab with that issue's accordion
    // expanded.
    // #2779: a change an agent session started is worked on in that
    // conversation, so its completion opens the conversation.
    // #3181: a session that stopped before finishing opens exactly where a
    // finished one does, since continuing it is what the row asks for.
    const sessionTurnEnd = item.kind === 'session_done' || item.kind === 'session_stalled';
    if (sessionTurnEnd && item.agentSessionId) {
      Notifications._dismissSheetForNav();
      window.location.hash = `#messages/agent/${encodeURIComponent(item.agentSessionId)}`;
      return;
    }
    if (sessionTurnEnd && item.appSlug && item.sessionId) {
      Notifications._dismissSheetForNav();
      if (typeof App !== 'undefined' && App.openAppTab) {
        return App.openAppTab(item.appSlug, 'dev', {
          subTab: 'topic',
          ref: { kind: 'proposal', id: parseInt(item.sessionId, 10) },
        });
      } else {
        window.location.hash = `#app/${item.appSlug}/dev/proposals/${item.sessionId}`;
      }
      return;
    }
    // (#86) Private spec share: persist the spec-panel open state for
    // the app, then land on Dev → Chat — GroupChat's mount path
    // (_restoreSpecPanelIfSaved) opens the read-only panel and fetches
    // the version through the share-widened access check. GroupChat is
    // a same-script-scope global (const-declared, so not on window) —
    // hence the bare reference behind a typeof guard.
    if (item.kind === 'spec_shared' && item.appSlug && item.sessionId) {
      const version = parseInt(item.detail, 10);
      if (Number.isInteger(version) && version > 0
          && typeof GroupChat !== 'undefined' && GroupChat._writeSpecPanelOpen) {
        GroupChat._writeSpecPanelOpen(item.appSlug, {
          sessionId: item.sessionId,
          version,
          title: `Spec v${version}`,
        });
      }
      Notifications._dismissSheetForNav();
      if (typeof App !== 'undefined' && App.openAppTab) {
        return App.openAppTab(item.appSlug, 'dev', { subTab: 'chat' });
      } else {
        window.location.hash = `#app/${item.appSlug}/dev/chat`;
      }
      return;
    }
    // #1405 path A: your agent submitted or shared work. Both are about ONE
    // change, and both used to fall through to the app's general chat with
    // everything else that had a slug — a screen that says nothing about the
    // thing the notification is announcing. A submission is up for a vote and
    // a share is still underway, but the lifecycle-aware change page handles
    // both states around the same full card.
    if (item.kind === 'connector_submitted' && item.appSlug && item.sessionId) {
      Notifications._dismissSheetForNav();
      const id = parseInt(item.sessionId, 10);
      if (typeof App !== 'undefined' && App.openAppTab) {
        return App.openAppTab(item.appSlug, 'dev', {
          subTab: 'topic',
          ref: { kind: 'proposal', id },
        });
      } else {
        window.location.hash = `#app/${item.appSlug}/dev/proposals/${id}`;
      }
      return;
    }
    if (item.kind === 'auto_solve_done' && item.appSlug) {
      Notifications._dismissSheetForNav();
      if (typeof App !== 'undefined' && App.openAppTab) {
        return App.openAppTab(item.appSlug, 'dev', {
          subTab: 'issues',
          ref: item.headlessIssueNumber || null,
        });
      } else {
        window.location.hash = item.headlessIssueNumber
          ? `#app/${item.appSlug}/dev/issues/${item.headlessIssueNumber}`
          : `#app/${item.appSlug}/dev/issues`;
      }
      return;
    }
    if (item.appSlug) {
      // Every path below navigates (the topic sub-branch returns after
      // routing; an invalid topic ref falls through to the chat/proposals
      // navigation), so one dismiss covers the whole block.
      Notifications._dismissSheetForNav();
      // Mentions/replies/reactions land on the app's discussion, in Messages
      // (see _openAppDiscussion) — unless the message lives in a topic thread
      // (#194 parity), in which case the click opens that
      // issue/proposal/governance discussion where the message is actually
      // visible. Vote nudges and kudos land on the Proposals tab where their
      // PR card lives (deep-linked when we know the session).
      //
      // Navigate via App.openAppTab rather than assigning location.hash:
      // a same-value hash assignment fires no `hashchange`, so clicking a
      // notification for the app/tab already on screen wouldn't re-render.
      // openAppTab always renders (and keeps the URL in sync internally).
      const chatKinds = new Set(['mention', 'reply', 'reaction', 'thread_reply']);
      // #2387: a message in a REPLY thread (thread_type 'message', its ref
      // the thread's first message) opens that thread beside the channel,
      // at the address the server worked out for the row.
      if (chatKinds.has(item.kind) && item.threadType === 'message' && item.threadRef != null) {
        const root = parseInt(item.threadRef, 10);
        const href = typeof item.href === 'string' && item.href.startsWith('#messages/app/')
          ? item.href
          : (Number.isInteger(root) && root > 0
            ? `#messages/app/${encodeURIComponent(item.appSlug)}/thread/${root}` : null);
        if (href) {
          const messages = window.UsernodeReact?.messages;
          if (messages?.openAddress) messages.openAddress(href);
          else window.location.hash = href;
          return;
        }
      }
      if (chatKinds.has(item.kind) && item.threadType && item.threadRef != null) {
        const kindMap = { issue: 'issue', session: 'proposal', governance: 'gov' };
        const topicKind = kindMap[item.threadType];
        const topicId = parseInt(item.threadRef, 10);
        if (topicKind && Number.isInteger(topicId) && topicId > 0) {
          if (typeof App !== 'undefined' && App.openAppTab) {
            return App.openAppTab(item.appSlug, 'dev', {
              subTab: 'topic',
              ref: { kind: topicKind, id: topicId },
            });
          } else {
            const seg = topicKind === 'issue' ? 'issues'
              : topicKind === 'proposal' ? 'proposals' : 'governance';
            window.location.hash = `#app/${item.appSlug}/dev/${seg}/${topicId}`;
          }
          return;
        }
      }
      // Every kind that is ABOUT A PROPOSAL opens that proposal — the vote
      // nudge, the going-stale warning, the blocked check and the kudos.
      // `subTab: 'proposals'` plus the session id is the legacy spelling of a
      // typed topic ref; _normalizeTab turns it into { kind: 'proposal', id }
      // and the topic view opens full-screen. Without an id there is no
      // proposal to open and it falls back to the board, which is where the
      // card is.
      // #1374 adds three more that are ABOUT A PROPOSAL: it merged, somebody
      // voted on it, and the daily digest of what is waiting on you. The
      // digest carries no sessionId, so it lands on the board — which is
      // right, since its subject is "these several proposals" rather than
      // one of them.
      // #1688: the re-confirm ask names one proposal and opens it; the
      // weekly card is a chat message, so its row opens the chat it is in.
      const proposalKinds = new Set([
        'pr_proposed', 'stale_pr', 'kudos', 'check_failed',
        'pr_merged', 'proposal_vote', 'vote_digest', 'revision_recheck',
      ]);
      const toProposals = proposalKinds.has(item.kind);
      // A new issue opens THAT ISSUE. `detail` is its number (the producer
      // has no issue column), and this row fell through to the app's general
      // chat, a screen that says nothing about the issue it announces.
      const issueNumber = item.kind === 'issue_opened' && /^\d+$/.test(String(item.detail || ''))
        ? Number(item.detail) : null;
      if (!toProposals && !issueNumber) {
        // Everything else is about a message in the app's general chat — a
        // mention, a reply, a reaction, the weekly card — or has no better
        // page than it.
        Notifications._openAppDiscussion(item.appSlug, item.chatMessageId);
        return;
      }
      if (typeof App !== 'undefined' && App.openAppTab) {
        return App.openAppTab(item.appSlug, 'dev', toProposals
          ? { subTab: 'proposals', ref: item.sessionId || null }
          : { subTab: 'issues', ref: issueNumber });
      } else {
        window.location.hash = toProposals
          ? `#app/${item.appSlug}/dev/proposals${item.sessionId ? `/${item.sessionId}` : ''}`
          : `#app/${item.appSlug}/dev/issues/${issueNumber}`;
      }
    }
  },

  // AN APP'S DISCUSSION IS A THREAD OF MESSAGES (#2718 review, #2763), so a
  // row about a message in it opens it THERE: `#messages/app/<slug>`, two
  // panes on a desktop, with the side panel taking it beside a running app
  // (#2854). These rows opened the old full-screen `#app/<slug>/dev/chat`,
  // whose back arrow climbed to the app's Workshop — a screen the reader
  // had not come from.
  //
  // When the row names ONE message, the discussion opens on it rather than
  // at the newest: GroupChat scrolls it into view and flashes it, the same
  // highlight a quote's jump-to-original lands on, once the transcript has
  // loaded (or at once, when that discussion is already open). A message
  // older than the page the discussion loads cannot be shown, and the
  // thread opens at the newest as before. The Messages controller is the
  // one door, with the address as the fallback for a shell still starting.
  _openAppDiscussion(slug, messageId) {
    if (!slug) return;
    if (messageId && typeof GroupChat !== 'undefined' && GroupChat.revealMessage) {
      GroupChat.revealMessage(slug, messageId);
    }
    const messages = window.UsernodeReact?.messages;
    if (messages?.openDiscussion) messages.openDiscussion(slug);
    else window.location.hash = `#messages/app/${encodeURIComponent(slug)}`;
  },

  // --- rendering -------------------------------------------------------

  // Badge total folds in pending invites so an invite is as loud as an
  // unread notification (its underlying collab_invite row may already
  // be read while the invite is still actionable).
  _badgeTotal() {
    return Notifications.unread + Notifications.invites.length;
  },

  // Of the loaded items, the ones that are a finished dev session
  // specifically. Published on the bell badge as `data-session-done`, so a
  // route check can assert the badge is showing BECAUSE a session finished
  // rather than because something else is unread. Counted from the loaded
  // items page; the unread-dedup keeps completions to one-per-session and
  // they're recent, so they sit within the first page in practice.
  _sessionDoneUnread() {
    return Notifications.items.filter((n) => n && n.kind === 'session_done' && !n.readAt).length;
  },

  _renderBadge() {
    // ONE EVENT, ONE BADGE, ON THE SURFACE THAT OWNS IT — and one count.
    //
    // The bell's number is now every unread notification plus pending
    // invites, session kinds included. There is no second badge and no
    // split.
    //
    // The split it replaces put unread session kinds on #improve-btn — the
    // header pill #2718 has since retired altogether — on the grounds that
    // the sessions themselves are behind that button so its
    // count sent you somewhere the bell could not. What it actually did was
    // put a count on a control that CANNOT CLEAR IT: the only things that
    // mark a session notification read are a click on its row in this list,
    // a group-chat mark-read, and mark-all — all of them behind the bell.
    // Opening the Improve panel marks nothing, so a finished session left a
    // number pointing at the one surface with no way to dismiss it, and the
    // viewer never found the notification that was waiting for them. Folding
    // it back in also re-aligns the bell with the two counts that never
    // learned about the split: the tab title (_updateTitle, which reads
    // _badgeTotal) and the home-screen icon badge (_publishAppBadge, which
    // reads `unread`).
    //
    // The pulse dot survived both moves and is the reason the distinction
    // matters: "a session is running right now" is a live fact, true only
    // while it is true, so it needs no dismissal and belongs wherever the
    // work is — the Homeroom mark, since #2718 — while a COUNT is an event
    // waiting to be read and belongs where reading happens.
    const notifCount = Notifications._badgeTotal();

    const paint = (id, count) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (count > 0) {
        el.textContent = count > 99 ? '99+' : String(count);
        el.classList.remove('hidden');
      } else {
        el.classList.add('hidden');
      }
    };
    // The bell's badge, in the header's right group. The only badge this
    // function paints, and the only one there is.
    //
    // Painting it by id is the sanctioned arrangement rather than an
    // exception: the span is rendered once by <PlatformHeader/> with a
    // CONSTANT className and a constant `data-session-done="0"`, so React
    // never reconciles over what is written here. This module also does not
    // import the store: most of its test harnesses rebuild individual method
    // bodies with `new Function`, so a method that closed over a module-scope
    // binding would be a method those harnesses cannot run.
    paint('notifications-badge', notifCount);

    // How many of those are specifically "your session finished", published
    // as an attribute so a declared check can assert the badge is showing for
    // that reason rather than merely being present.
    const badgeEl = document.getElementById('notifications-badge');
    if (badgeEl) {
      badgeEl.setAttribute('data-session-done', String(Notifications._sessionDoneUnread()));
    }
    // The app-context sheet's per-change unread dots (Streamlined Concept):
    // which sessions have an unread session-kind notification right now.
    // Published into the notifications store — the sheet's rows subscribe.
    //
    // Only when the SET changes. The store compares by identity, so pushing a
    // freshly-built array every time would notify every subscriber (the
    // screen, the pinned sections and every session row) on every badge
    // repaint — and _renderBadge runs on each WS event and each refresh.
    if (Notifications._store) {
      const ids = Notifications.items
        .filter((n) => isSessionNotif(n) && !n.readAt && n.sessionId)
        .map((n) => n.sessionId);
      const prev = Notifications._store.get().sessionUnreadIds || [];
      const same = prev.length === ids.length && prev.every((v, i) => v === ids[i]);
      if (!same) Notifications._store.set({ sessionUnreadIds: ids });
    }
    Notifications._updateTitle();
    Notifications._publishAppBadge();
    // The cog drawer used to render a pinned section from this same items
    // store and was nudged here whenever the store changed. It is retired;
    // the list in the hamburger is React-rendered from the store directly,
    // so it re-renders on its own.
  },

  _updateTitle() {
    const base = document.title.replace(/^\(\d+\)\s*/, '');
    const total = Notifications._badgeTotal();
    if (total > 0) document.title = `(${total}) ${base}`;
    else document.title = base;
  },

  // #1445: the homescreen icon badge. Two feature-detected targets, both
  // fed the server's account-wide unread total (`Notifications.unread` —
  // the same number countUnread stamps into every push payload, so the
  // icon never disagrees with what the next push would set):
  //
  //   - navigator.setAppBadge / clearAppBadge for installed PWAs. The
  //     Flutter WebView has neither, so the detect no-ops there.
  //   - window.SocialPush.publishBadgeCount for the native shell.
  //     SocialPush owns capability probing and session-admission gating
  //     (it is a classic script loaded before this deferred bundle, but
  //     the optional chain also tolerates a mixed cache generation that
  //     predates the seam).
  //
  // Publishes 0 when signed out so a device is not left badged for a
  // session that ended in-app. Best-effort throughout: a badge failure
  // must never break the bell render this rides on.
  _publishAppBadge() {
    const signedIn = typeof window !== 'undefined' && window.App && App.user;
    const count = signedIn ? Math.max(0, Number(Notifications.unread) || 0) : 0;
    try {
      if (typeof navigator !== 'undefined') {
        if (count > 0 && typeof navigator.setAppBadge === 'function') {
          Promise.resolve(navigator.setAppBadge(count)).catch(() => {});
        } else if (count === 0 && typeof navigator.clearAppBadge === 'function') {
          Promise.resolve(navigator.clearAppBadge()).catch(() => {});
        }
      }
    } catch { /* Unsupported surface — the OS badge is best-effort. */ }
    try {
      if (typeof window !== 'undefined' && window.SocialPush
        && typeof window.SocialPush.publishBadgeCount === 'function') {
        window.SocialPush.publishBadgeCount(count);
      }
    } catch { /* Same stance for the native seam. */ }
  },

  // --- pinned saved-messages section (#1280) ----------------------------

  // Same contract as _renderInvites below: compute descriptors, push them
  // into the store, let ./notifications-list.tsx render them. Empty stays
  // empty — nothing saved renders no "Saved" header at all.
  _renderSaved() {
    const store = Notifications._store;
    if (!store) return;
    store.set({
      saved: Notifications.saved.map(savedView),
      touch: isTouchNow(),
    });
  },

  // Clicking a saved row opens the message where it actually lives: the
  // topic discussion when it was posted in one (#194 parity with the
  // mention/reply rows), otherwise the app's discussion in Messages, opened
  // on the saved message (_openAppDiscussion). Deliberately does
  // NOT unsave — a save is not a to-do item, and a row that vanished the
  // moment you looked at it would make the section unusable.
  _onSavedClick(messageId) {
    const saved = Notifications.saved.find((s) => s.messageId === messageId);
    if (!saved) return;
    // A conversation save opens the Messages screen on that conversation, via
    // the island's controller with the hash as the fallback — the same pair
    // _onItemClick uses for the conversation notification kinds, and for the
    // same reason: the hash keeps a native exact-open working during startup
    // before the island publishes. There is no per-message deep link in
    // Messages yet, so it lands on the thread and the reader scrolls, which is
    // the resolution the app-chat branch below settles for too when a message
    // was posted outside a topic.
    if (saved.conversationId) {
      Notifications._dismissSheetForNav();
      const messages = window.UsernodeReact?.messages;
      if (messages?.open) messages.open(saved.conversationId);
      else window.location.hash = `#messages/${saved.conversationId}`;
      return;
    }
    if (!saved.appSlug) return;
    // Both branches below navigate — see _onItemClick for the touch-sheet
    // contract (#1329).
    Notifications._dismissSheetForNav();
    const kindMap = { issue: 'issue', session: 'proposal', governance: 'gov' };
    const topicKind = kindMap[saved.threadType];
    const topicId = parseInt(saved.threadRef, 10);
    if (topicKind && Number.isInteger(topicId) && topicId > 0) {
      if (typeof App !== 'undefined' && App.openAppTab) {
        App.openAppTab(saved.appSlug, 'dev', {
          subTab: 'topic',
          ref: { kind: topicKind, id: topicId },
        });
      } else {
        const seg = topicKind === 'issue' ? 'issues'
          : topicKind === 'proposal' ? 'proposals' : 'governance';
        window.location.hash = `#app/${saved.appSlug}/dev/${seg}/${topicId}`;
      }
      return;
    }
    Notifications._openAppDiscussion(saved.appSlug, saved.messageId);
  },

  // Unsave from the drawer — the "or there" half of "until unsaved in the
  // message / there". Optimistic like the message-side toggle, and it
  // repaints the message's own button when that chat happens to be on
  // screen (GroupChat is a classic-script global lexical binding, so it is
  // reachable by a bare reference behind a typeof guard, not on window).
  async _unsave(messageId) {
    const saved = Notifications.saved.find((s) => s.messageId === messageId);
    if (!saved || !(saved.appSlug || saved.conversationId)) return;
    const endpoint = saved.conversationId
      ? `/api/conversations/${saved.conversationId}/messages/${messageId}/bookmark`
      : `/api/apps/${saved.appSlug}/messages/${messageId}/bookmark`;
    const previous = Notifications.saved;
    Notifications.saved = Notifications.saved.filter((s) => s.messageId !== messageId);
    Notifications._renderSaved();
    if (saved.conversationId) {
      // The Messages twin of the GroupChat repaint below: if that
      // conversation is open, its row's star stops being filled.
      window.UsernodeReact?.messages?.paintSaved?.(messageId, false);
    } else if (typeof GroupChat !== 'undefined' && GroupChat._paintBookmark) {
      GroupChat._paintBookmark(messageId, false);
      const msg = GroupChat._findMessage && GroupChat._findMessage(messageId);
      if (msg) msg.bookmarked = false;
    }
    try {
      const res = await fetch(endpoint, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      // Put it back rather than leaving the drawer disagreeing with the
      // server about what is saved.
      Notifications.saved = previous;
      Notifications._renderSaved();
      if (saved.conversationId) {
        window.UsernodeReact?.messages?.paintSaved?.(messageId, true);
      } else if (typeof GroupChat !== 'undefined' && GroupChat._paintBookmark) {
        GroupChat._paintBookmark(messageId, true);
      }
      console.warn('[notifications] unsave failed', err);
    }
  },

  // --- pinned invites section -------------------------------------------

  // The pinned section is a descriptor list now; ./notifications-list.tsx
  // renders it and owns the stopPropagation, the swipe tray and the header.
  // Empty stays empty — an invite-less drawer renders no "Invites" header,
  // exactly as `box.innerHTML = ''` did.
  _renderInvites() {
    const store = Notifications._store;
    if (!store) return;
    store.set({
      invites: Notifications.invites.map(inviteView),
      touch: isTouchNow(),
    });
  },

  _removeInviteLocal(appId, kind) {
    Notifications.invites = Notifications.invites.filter(
      (i) => !(i.appId === appId && (i.kind || 'collab') === (kind || 'collab'))
    );
    Notifications._renderBadge();
    Notifications._renderInvites();
  },

  async _acceptInvite(appId, slug, kind) {
    const base = kind === 'approver' ? '/api/approver-invites' : '/api/invites';
    try {
      const res = await fetch(`${base}/${appId}/accept`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        PlatformUI.toast(data.error || `Accept failed (HTTP ${res.status})`);
        // The invite may have been revoked — re-sync.
        Notifications.refresh();
        return;
      }
      Notifications._removeInviteLocal(appId, kind);
      // Pull the fresh state (the invite row is now read) and refresh
      // the home grid — a view-private app just became visible.
      Notifications.refresh();
      if (typeof Home !== 'undefined' && App._isScreenVisible('home-screen')) {
        Home.load();
      }
      const target = data.appSlug || slug;
      if (target) {
        // About to navigate — on touch the sheet would otherwise stay
        // presented over the screen this opens (#1329). The people you just
        // joined are in the app's discussion, which is a thread of Messages.
        Notifications._dismissSheetForNav();
        Notifications._openAppDiscussion(target);
      }
    } catch (err) {
      console.warn('[notifications] acceptInvite failed', err);
    }
  },

  async _declineInvite(appId, kind) {
    const base = kind === 'approver' ? '/api/approver-invites' : '/api/invites';
    try {
      const res = await fetch(`${base}/${appId}/decline`, { method: 'POST' });
      if (!res.ok) {
        Notifications.refresh();
        return;
      }
      Notifications._removeInviteLocal(appId, kind);
      Notifications.refresh();
    } catch (err) {
      console.warn('[notifications] declineInvite failed', err);
    }
  },

  // Pure transform: items (newest-first) -> ordered groups, in two tiers
  // (#161). Base tier: the first time an app is seen is its newest
  // notification, so insertion order yields most-recent-activity-first
  // group ordering, and each group's items stay newest-first. Priority
  // tier: UNREAD completion notifications (session_done /
  // auto_solve_done) pin to the top — their group floats above the
  // others and the pinned items lead within their group (so they also
  // become the collapsed header's preview). Both re-sorts are stable
  // partitions, so ordering inside each tier is unchanged; once a
  // completion is read it drops back to its chronological spot.
  // Items the list renders: ALL of them.
  //
  // This used to exclude the session-related kinds (session_done,
  // auto_solve_done, stale_pr, check_failed), because those rendered in the
  // header cog's pinned "Needs attention" section instead. THE UI OVERHAUL
  // retired the cog, so keeping the filter would make four notification kinds
  // invisible everywhere — the one thing a drawer merge must not do.
  //
  // The badge split is gone too — one bell, one number, session kinds
  // included (see _renderBadge). isSessionNotif is still here for the
  // app-context sheet's per-change unread dots, which need to know which
  // sessions have an unread notification against them.
  // ── New vs older (#1367 follow-up) ───────────────────────────────
  //
  // The drawer shows what is NEW. A notification you have already read has
  // done its job — it told you a thing — and leaving it in the list means the
  // one that arrived this morning is buried under three weeks of things you
  // have already dealt with. So the default list is the UNREAD ones, and the
  // read ones are one tap away behind "See older notifications".
  //
  // `readAt` is the existing server-side field and the existing meaning of
  // "viewed": it is set when you click a notification, when you use a group's
  // "Mark read", and by "Mark all read". Nothing new is stored, and nothing is
  // deleted — "go away" here means "leave the new list", which is why the
  // older view can always bring them back.
  //
  // Per drawer OPEN, not persisted: `sv:drawer-open` resets it to false (see
  // init), so a visit always starts on what is new.
  showOlder: false,

  _setShowOlder(next) {
    const value = !!next;
    if (Notifications.showOlder === value) return;
    Notifications.showOlder = value;
    if (Notifications.items.length) Notifications._renderList();
  },

  /** The controller entry point behind the footer button. */
  toggleOlder() {
    Notifications._setShowOlder(!Notifications.showOlder);
  },

  /** Every notification the bell owns, read or not. */
  _allBellItems() {
    return Notifications.items;
  },

  /** What the list actually renders: unread only, unless older is revealed. */
  _bellItems() {
    if (Notifications.showOlder) return Notifications.items;
    return Notifications.items.filter((n) => !n.readAt);
  },

  // One descriptor per notification, newest-first — the whole list, flat
  // (#1385). The list component owns every handler this method used to attach
  // by querySelectorAll: the row clicks, the foot pager and the touch swipe
  // tray. All of them still stopPropagation, for the reason they always did: a
  // re-render detaches the clicked node, and the document-level outside-click
  // handler would then see a target outside the panel and wrongly dismiss the
  // drawer.
  _renderList() {
    const store = Notifications._store;
    if (!store) return;
    const touch = isTouchNow();

    // How many read notifications the older view would add. Drives the footer
    // button's presence AND its count, and separates the two empty states
    // below: "nothing has ever arrived" is not the same as "you are caught
    // up", and telling a viewer the first when the second is true reads as
    // the drawer having lost their history.
    const olderCount = Notifications._allBellItems().filter((n) => n.readAt).length;

    if (Notifications._bellItems().length === 0) {
      // The pinned sections may still have content — only show the empty
      // hint when there's truly nothing in the drawer. #1280 added the
      // saved section to that "truly nothing" test: a drawer showing your
      // saved messages while telling you nothing has arrived yet reads as
      // a bug.
      store.set({
        list: [],
        // The full screen shows read rows regardless of the drawer's
        // showOlder reveal, so its list maps ALL items even when the
        // drawer's own list is empty (Streamlined Concept).
        screenList: screenViews(Notifications.items),
        // `empty` is still the ORIGINAL "you have never had a notification"
        // hint, so it now also requires that there be no older ones to
        // reveal — otherwise a fully-read drawer would claim nothing had
        // ever arrived while offering to show you what had.
        empty: Notifications.invites.length === 0
          && Notifications.saved.length === 0
          && olderCount === 0,
        // …and this is the new one: caught up, with history behind it.
        caughtUp: olderCount > 0 && !Notifications.showOlder,
        olderCount,
        showOlder: Notifications.showOlder,
        // Nothing to append a pager to — see the note in the populated branch.
        canLoadMore: false,
        // The screen HAS rows to append to (the read ones above), so its
        // pager follows the server cursor even while the drawer's is off.
        screenCanLoadMore: Notifications.hasMore,
        loadingMore: Notifications.loading,
        messagesCanLoadMore: Notifications.msgHasMore,
        loadingOlderMessages: Notifications.msgLoading,
        touch,
      });
      return;
    }

    // Straight through, in `items` order. No partition and no re-sort: the
    // feed is already newest-first, and a flat list that reorders itself is
    // exactly the thing #1385 asked to stop. (Unread completion notifications
    // used to float to the top of the grouped list; see PRIORITY_KINDS.)
    store.set({
      list: Notifications._bellItems().map(rowView),
      screenList: screenViews(Notifications.items),
      empty: false,
      caughtUp: false,
      olderCount,
      showOlder: Notifications.showOlder,
      // The foot pager, and whether a page is already in flight. Offered only
      // when there are rows to append to — with none, the empty/caught-up hint
      // owns that space and the older-toggle is the affordance that belongs
      // there.
      canLoadMore: Notifications.hasMore,
      screenCanLoadMore: Notifications.hasMore,
      loadingMore: Notifications.loading,
      // The Messages tab's pager, on its own cursor — see loadOlderMessages().
      messagesCanLoadMore: Notifications.msgHasMore,
      loadingOlderMessages: Notifications.msgLoading,
      touch,
    });
  },

  /**
   * The list's foot pager: pull the next page of older notifications.
   *
   * This is the flat-list replacement for `_showMoreGroup`, which #1385
   * retired along with the group chrome it lived in. It is deliberately a
   * method rather than a direct `loadMore` binding on the button, because the
   * two are not the same thing: `loadMore()` is the transport (it no-ops while
   * a page is in flight, or once the cursor is exhausted) and this is the
   * user-facing action, which the drawer may later want to guard differently.
   *
   * There is NO client-side reveal cap any more. The old one existed to keep
   * an expanded group from unrolling thirty rows inside a collapsed list; a
   * flat list already shows what it has loaded, so a second cap on top of the
   * server's page size would only hide rows the viewer had already paid to
   * fetch. `loadMore()` re-renders on completion, so the arriving page simply
   * appears at the bottom.
   */
  loadOlder() {
    if (!Notifications.hasMore || Notifications.loading) return;
    Notifications.loadMore();
  },

};

const CONVERSATION_NOTIF_KINDS = new Set([
  'conversation_invite',
  'conversation_message',
  'conversation_mention',
  'conversation_reply',
  'conversation_reaction',
  // #2387: a reply in a thread the viewer started or replied in.
  'conversation_thread_reply',
]);

// #2387: where a conversation row opens. A thread alert opens its thread; a
// row about one message (mention, quote-reply, reaction) opens that message's
// permalink, which lands inside its thread when it lives in one; an invite or
// a plain new-message row opens the conversation itself.
function conversationNotificationHref(n) {
  const valid = (v) => Number.isSafeInteger(v) && v > 0 && v <= 2147483647;
  const conversationId = Number(n && n.conversationId);
  if (!valid(conversationId)) return null;
  const messageId = Number(n.conversationMessageId);
  const rootId = Number(n.conversationThreadRootId);
  if (n.kind === 'conversation_thread_reply' && valid(rootId)) {
    return `#messages/${conversationId}/thread/${rootId}`;
  }
  if (['conversation_mention', 'conversation_reply', 'conversation_reaction'].includes(n.kind)
      && valid(messageId)) {
    return `#messages/${conversationId}/m/${messageId}`;
  }
  return `#messages/${conversationId}`;
}

// #2386: the two friend kinds (src/services/notifications.js
// FRIEND_NOTIFICATION_KINDS). No app and no conversation — a person.
const FRIEND_NOTIF_KINDS = new Set(['friend_request', 'friend_accept']);

// services/platform-limit-alerts.js detailToken(): "<limit>_<level>:<used>:<cap>".
const PLATFORM_LIMIT_DETAIL_RE = /^(apps|sessions)_(warn|full):(\d{1,7}):(\d{1,7})$/;

function parsePlatformLimitDetail(detail) {
  const m = PLATFORM_LIMIT_DETAIL_RE.exec(String(detail || ''));
  return m ? { limit: m[1], level: m[2], used: Number(m[3]), cap: Number(m[4]) } : null;
}

// #161 defined these as the kinds that "demand attention": a finished dev
// session or headless run, while still unread.
//
// #1385 stopped the DRAWER acting on it. The pin was a grouped-list device — it
// floated an app's group above the others and led within it, which is also what
// made it the collapsed header's preview — and a flat list the request asked to
// be chronological cannot also reorder itself. Nothing was deleted: the set
// still drives DevChat's completion title through isPriorityNotif() below, and
// restoring a top-of-list pin is one stable partition in _renderList if the
// group decides it wants one.
//
// Deliberately limited to these kinds; grow this set rather than adding a
// server-side priority column if more "priority" kinds emerge. #3181 grew it
// by session_stalled: a session that stopped before finishing demands the
// same attention as one that finished, on the same channels (the tab title,
// the chime, the OS notification; see handleIncoming).
const PRIORITY_KINDS = new Set(['session_done', 'session_stalled', 'auto_solve_done']);
function isPriorityNotif(n) {
  return !!n && PRIORITY_KINDS.has(n.kind) && !n.readAt;
}

// The system-generated (source-user-less) notifications about the
// viewer's OWN sessions and proposals. Everything social — mentions,
// replies, reactions, kudos, vote nudges, invites, spec shares — is
// everything else.
//
// These used to render in the header cog's drawer INSTEAD of the bell, and
// this set was the filter that kept the two apart. THE UI OVERHAUL merged
// both into the hamburger, so all of it renders in one list now. The badge
// split that outlived the drawer is gone as well — the bell counts these
// along with everything else — so what the set is left doing is naming the
// kinds the app-context sheet draws a per-change unread dot for
// (`sessionUnreadIds`, published by _renderBadge). #3181 adds the fifth,
// session_stalled: a change that stopped before finishing is exactly what
// that dot should point at.
const SESSION_NOTIF_KINDS = new Set([
  'session_done', 'session_stalled', 'auto_solve_done', 'stale_pr', 'check_failed',
]);
function isSessionNotif(n) {
  return !!n && SESSION_NOTIF_KINDS.has(n.kind);
}
if (typeof window !== 'undefined') window.SESSION_NOTIF_KINDS = SESSION_NOTIF_KINDS;

// PlatformUI is a classic-script global. The vm harnesses that evaluate this
// file don't define it, and neither does the SSG prerender pass.
function isTouchNow() {
  return typeof PlatformUI !== 'undefined' && !!PlatformUI.isTouch && PlatformUI.isTouch();
}

// #1280: one saved message, as data. The row reads "@author in AppName ·
// 2h ago" over a two-line snippet of the message, which is the same shape
// the mention/reply rows use — a saved message and a message you were
// mentioned in are the same object, and looking different for no reason
// would just make the drawer harder to read.
//
// `time` is the age of the SAVE, not of the message: the section is
// ordered by when you saved things, so a timestamp measuring anything else
// would contradict the order the rows are in.
// One section, two kinds of save. A conversation save carries a
// `conversationId` and no `appSlug`; an app-chat save the reverse — that
// field IS the discriminator, here and at the click and unsave sites, so
// nothing has to carry a separate `kind` string that could disagree with it.
//
// `appName` keeps its name in the descriptor because the component renders it
// as "@who in <that>", and the answer to "in what" is the app for one kind
// and the conversation for the other. Renaming the field to suit both would
// have touched every call site to say the same thing.
function savedView(s) {
  const conversationId = Number(s.conversationId) || 0;
  return {
    messageId: s.messageId,
    slug: s.appSlug || '',
    conversationId,
    who: s.author ? `@${s.author}` : 'System',
    appName: conversationId
      ? (s.conversationTitle || 'a conversation')
      : (s.appName || s.appSlug || 'an app'),
    ...stampFields(s.savedAt),
    text: (s.content || '').slice(0, 140),
  };
}

// #646: approver invites share the pinned section, with distinct copy and
// their own accept/decline endpoints. The descriptor carries the endpoint
// discriminator (`kind`) as well as the copy, because the component's
// buttons and its swipe tray both need it.
function inviteView(inv) {
  const isApprover = inv.kind === 'approver';
  return {
    appId: inv.appId,
    slug: inv.appSlug || '',
    kind: isApprover ? 'approver' : 'collab',
    icon: isApprover ? '🗳️' : '✉️',
    who: inv.invitedBy ? `@${inv.invitedBy}` : 'Someone',
    verb: isApprover ? 'invited you to be an approver on' : 'invited you to collaborate on',
    appName: inv.appName || inv.appSlug || 'an app',
    ...stampFields(inv.createdAt),
  };
}


// #138: derive the title/body + deep-link fields for a completion alert
// (chime/OS notification) from a notification row. Mirrors the per-kind copy in
// rowView so the OS notification reads the same as the bell-menu entry. (It
// used to name previewText too — that was the collapsed group header's
// one-liner, which #1385 retired with the rest of the group chrome.)
function completionAlertInfo(n) {
  const appName = n.appName || 'your app';
  if (n.kind === 'auto_solve_done') {
    const issue = n.headlessIssueNumber ? `issue #${n.headlessIssueNumber}` : 'an issue';
    let title;
    let body;
    if (n.detail === 'failed') {
      title = 'Proposal failed';
      body = `Proposal for ${issue} in ${appName} failed. You can retry`;
    } else if (n.detail === 'question') {
      title = 'Proposal has a question';
      body = `Proposal for ${issue} in ${appName} is waiting for your input`;
    } else {
      title = 'Proposal ready';
      body = `Proposal for ${issue} in ${appName} is ready`;
    }
    return {
      kind: n.kind,
      appSlug: n.appSlug || null,
      sessionId: n.sessionId || null,
      headlessIssueNumber: n.headlessIssueNumber || null,
      title,
      body,
    };
  }
  // #3181: the turn stopped before finishing (an error, a timeout, a lost
  // worker). Same deep link as a finished one; the copy says what to do.
  if (n.kind === 'session_stalled') {
    return {
      kind: 'session_stalled',
      appSlug: n.appSlug || null,
      sessionId: n.sessionId || null,
      ...(n.agentSessionId ? { agentSessionId: n.agentSessionId } : {}),
      headlessIssueNumber: null,
      title: 'Session stopped before finishing',
      body: `Your session on ${appName} stopped before finishing. Open it to continue`,
    };
  }
  // session_done — #971: the session's own title first, then the PR title,
  // and only then the machine-generated branch name.
  const label = n.sessionTitle || n.prTitle || n.branchName || 'your session';
  if (n.agentSessionId) {
    // #2779: a run in an agent session (a spec drafted or a build done).
    return {
      kind: 'session_done',
      appSlug: n.appSlug || null,
      sessionId: n.sessionId || null,
      agentSessionId: n.agentSessionId,
      headlessIssueNumber: null,
      title: 'The coding agent finished',
      body: `The coding agent finished on ${appName}: ${label}`,
    };
  }
  return {
    kind: 'session_done',
    appSlug: n.appSlug || null,
    sessionId: n.sessionId || null,
    headlessIssueNumber: null,
    title: 'Dev session finished',
    body: `Your dev session in ${appName} finished: ${label}`,
  };
}


// Consecutive notifications from ONE conversation, as a single row.
//
// A message notification is created per member PER MESSAGE (sendMessage in
// services/conversations.js), so a friend sending four lines puts four
// near-identical rows in the sheet and buries everything else under them.
// The per-conversation count was the one thing the retired Messages tag did
// better than the bell, and this is where it comes back: the run collapses to
// its newest row carrying `count`, so a thread reads as one thing.
//
// CONSECUTIVE, not "all rows for this conversation". The feed is newest-first
// chronological and the collapsed row sits exactly where its newest member
// sat, so nothing reorders and nothing jumps a section boundary. Two bursts
// with other notifications between them stay two rows, which is honest: they
// happened at different times, and merging them would date the older one
// wrongly.
//
// The read state has to match too. A run is entirely unread or entirely read,
// which is what lets the sheet's Unread tab filter whole rows without ever
// hiding an unread message inside a row it counted as read.
function collapseConversationRuns(items) {
  const runs = [];
  for (const n of items) {
    const prev = runs[runs.length - 1];
    const id = n && n.conversationId != null ? Number(n.conversationId) : null;
    if (prev && id !== null && prev.conversationId === id
        && prev.read === !!n.readAt) {
      prev.count += 1;
      continue;
    }
    runs.push({ item: n, conversationId: id, read: !!(n && n.readAt), count: 1 });
  }
  return runs;
}

// The sheet's rows: one descriptor per run. `count` rides only on a genuine
// collapse, so a lone notification's view is byte-identical to what it was.
function screenViews(items) {
  return collapseConversationRuns(items).map((run) => {
    const view = AGENT_NOTIF_KINDS.has(run.item && run.item.kind)
      ? { ...rowView(run.item), agent: true } : rowView(run.item);
    return run.count > 1 ? { ...view, count: run.count } : view;
  });
}

// #2815: what an AGENT did on your behalf — a session that finished, a
// proposal run that came back, a question it asked, work it submitted or
// shared. The sheet's Messages tab lists these beside the conversations and
// the running sessions themselves, the way the Messages screen already puts
// agents in its chats, so the bell has no separate Agents tab. Carried as a
// flag for the same reason `conversation` is: the tab must never re-derive
// the set from `kind` and drift from it. stale_pr and check_failed stay out:
// they are about a proposal, not about an agent talking back to you.
// #3181: a session that stopped before finishing is an agent talking back
// too, so it lists beside the one that finished.
const AGENT_NOTIF_KINDS = new Set([
  'session_done', 'session_stalled', 'auto_solve_done', 'agent_awaiting_input', 'connector_submitted',
]);

// One notification row, as data. It has ONE renderer — ScreenRow in
// ./notifications-sheet.tsx — which draws THREE lines:
//
//     <kind>                                        ← `label`
//     <subject>                                     ← `segments`
//     <where> · by @<who> · <when>                  ← `appLine` / `by` / `time`
//
// ── WHAT KIND, THEN WHICH ONE, THEN WHERE FROM ───────────────────────
//
// Every kind used to write a SENTENCE about itself: "@evan proposed a PR to
// vote on in Notes", "Your dev session in Notes finished", "Proposal for issue
// #12 in Notes is ready". Three problems, and they compound:
//
//   1. The app's name was in the sentence AND in the meta line directly under
//      it. Every row said where it came from twice.
//   2. The actor was in the sentence, so the row led with a username rather
//      than with what happened — and a list of them all started the same way.
//   3. The SUBJECT (the PR's title, the session's name) was in `body`, a
//      third line this renderer does not draw. So the one thing that told two
//      proposal notifications apart was not on screen at all.
//
// So the sentence is gone. What is left are three FACTS, and the row now gives
// each of them its own line instead of packing two into a headline:
//
//   `label`     what KIND of thing this is: "New proposal", "Submitted by
//               your agent", "Session finished". A short category, and the
//               same words for every row of that kind, so a list of them
//               scans down the left edge.
//   `segments`  WHICH one: the PR's title, the session's name, the message.
//               This used to be `body`, a third field nothing rendered, so
//               the one thing telling two proposal rows apart was invisible.
//   the meta    WHERE it came from and who did it — everything the old
//               sentence was repeating out of the line under itself.
//
// They were one line for a round, joined by a colon ("New proposal: Fix the
// header spacing"), and that line is where a row runs out of width first: the
// subject is the part that varies and the part that truncates, and it was
// paying for a label of fixed length in front of it on every row. Split, the
// label sits in the kind's own smaller ink and the subject gets the full
// width — the same three facts, in falling order of how much of the row's
// width they deserve.
//
// `segments` is the subject, as parts:
//   { t: 'who' }    → @username, in the strong ink
//   { t: 'strong' } → a title, a conversation, an issue ref
//   { t: 'text' }   → connecting words
// Every value is RAW text. Escaping is the renderer's job, and React does it
// by construction — which is the point of moving the rows there.
//
// A kind with nothing to name — a collaborator invite is entirely its own
// label — leaves `segments` EMPTY, and the renderer then draws the label on
// the subject's line and no kind line at all. Two lines when there are two
// things to say; a category heading over nothing would be worse than either.
//
// `by` is the meta line's attribution and is set ONLY where the source user is
// the ACTOR. The two OpenRouter-key rows carry a `sourceUsername` that is the
// SUBJECT instead — it names whose key it is — and "by @them" would be a false
// claim about who did something, so those keep the name in the headline and
// set no `by` at all. A system row — a stale PR, a failed check, a finished
// session — has no actor and no `by` either.
// The two lines of a row's own copy. Spread into the view — `...headline(…)`
// — rather than assigned to one field, because it fills two.
function headline(label, subject) {
  return {
    label,
    segments: subject ? [{ t: 'strong', v: String(subject) }] : [],
  };
}

function rowView(n) {
  // #103: keep the violet left line on every row, read or unread, so a
  // notification never "loses its line" when read. Only the background
  // tint stays unread-conditional (the unread dot below is the other cue).
  const unreadCls = n.readAt
    ? 'border-l-2 border-violet-500'
    : 'bg-violet-500/5 border-l-2 border-violet-500';
  // WHERE this came from, for the meta line — and EMPTY when there is no
  // app, not the literal string 'app'. Plenty of kinds have no app at all (a
  // conversation, an account-level key, an agent question the platform cannot
  // place), and every one of them used to render "app · 4m ago" under itself.
  // The renderer drops a falsy part, so an app-less row simply says less.
  const appLine = n.appName ? n.appName : '';
  const who = n.sourceUsername ? n.sourceUsername : 'someone';
  const base = {
    id: n.id,
    unread: !n.readAt,
    unreadCls,
    ...stampFields(n.createdAt),
    // The sheet buckets rows into Today/Earlier and leads each with an
    // avatar-initial chip, so the raw timestamp and the resolved names ride
    // along as data.
    createdAtMs: Date.parse(n.createdAt) || 0,
    who,
    appLine,
    // Meta-line attribution. Null unless the source user actually DID this.
    by: null,
    // The kind line. Every branch below overwrites it; '' would render a
    // blank first line, which is why nothing is allowed to fall through
    // with the default.
    label: '',
    // The meta line's own layout. `mb` and `wrap` differ per kind, and the
    // plain mention/reply row is the only one that is not a flex row at all.
    mb: true,
    metaFlex: true,
    wrap: false,
    icon: null,
    segments: [],
  };

  if (n.kind === 'test_alert') {
    return { ...base, label: 'Homeroom test alert', icon: '🔔',
      segments: [{ t: 'text', v: 'You requested a push notification test. Open Alerts settings to try again.' }] };
  }

  if (CONVERSATION_NOTIF_KINDS.has(n.kind)) {
    // QA 2026-09-24 Q33a: a direct conversation has no title of its own
    // (the column is NULL), so a DM's row used to be headed "Messages" —
    // the surface, not who wrote. The person on the other end of a DM is
    // the sender, so it is headed with them.
    const conversation = n.conversationTitle
      || (n.conversationKind === 'direct' && n.sourceUsername ? `@${n.sourceUsername}` : 'Messages');
    const snippet = (n.messageContent || '').slice(0, 140);
    // The conversation is the SUBJECT of every one of these, so it leads —
    // and for a plain message the snippet follows it, which is the only part
    // of a message notification anybody reads. The other four say what
    // happened in it instead, because "@you" is the whole news there.
    //
    // The three that used to read "Mentioned you in <conversation>" lost the
    // trailing preposition when the line broke under them: "Mentioned you in"
    // alone above its object is a sentence cut in half, and the line below is
    // plainly what it is in.
    const copy = {
      conversation_invite: headline('Invite', conversation),
      // The only kind whose label is not a fixed category. A message's kind
      // IS its thread — "Message" over the snippet would name the surface,
      // which the meta line already does.
      conversation_message: headline(conversation, snippet),
      conversation_mention: headline('Mentioned you', conversation),
      conversation_reply: headline('Replied', conversation),
      conversation_thread_reply: headline('Replied in thread', conversation),
      conversation_reaction: headline('Reacted', conversation),
    }[n.kind];
    const icons = {
      conversation_invite: '✉️',
      conversation_message: '💬',
      conversation_mention: '@',
      conversation_reply: '↩️',
      conversation_thread_reply: '🧵',
      conversation_reaction: n.detail || '❤️',
    };
    return {
      ...base,
      wrap: true,
      icon: icons[n.kind],
      by: n.sourceUsername || null,
      // What the sheet's Messages tab filters on. Carried as a flag rather
      // than re-deriving it there from `kind`: CONVERSATION_NOTIF_KINDS lives
      // in this module and the tab must never drift from the set the rest of
      // the routing, grouping and copy already agree on.
      conversation: true,
      conversationId: n.conversationId != null ? Number(n.conversationId) : null,
      // A conversation row names MESSAGES as its source, not "app".
      //
      // `appLine` is the sheet's secondary line and falls back to the literal
      // string 'app' when a notification has no app, which every conversation
      // row is by construction (serialize nulls the app fields on one). So the
      // sheet rendered "app · 4m ago" under every message.
      //
      // Deliberately the SURFACE and not the conversation's title: the title
      // is the headline's own subject, and repeating it under itself reads as
      // a rendering fault rather than as attribution.
      appLine: 'Messages',
      ...copy,
    };
  }

  // #2386: the person is the SUBJECT of both friend rows, so their name is
  // the headline and `by` stays null (as on the key rows). A request still
  // waiting on you carries Accept and Decline beside the row; once answered —
  // here, on your profile, or withdrawn by its sender — it is a plain row that
  // opens their page.
  if (FRIEND_NOTIF_KINDS.has(n.kind)) {
    const request = n.kind === 'friend_request';
    return {
      ...base,
      appLine: 'Friends',
      wrap: true,
      icon: request ? '👋' : '🤝',
      label: request ? 'Friend request' : 'Accepted your friend request',
      segments: [{ t: 'who', v: who }],
      ...(request && n.friendRequestPending ? {
        actions: [
          { key: 'friend_accept', label: 'Accept', primary: true },
          { key: 'friend_decline', label: 'Decline' },
        ],
      } : {}),
    };
  }

  // #2161: the two deletion rows. An attempt still has its app (the meta
  // line names it, the click opens it); a completed deletion has no app row
  // left, so the name rides in `detail` and the meta line says Account.
  if (n.kind === 'app_delete_attempted') {
    return {
      ...base,
      wrap: true,
      icon: '🗑️',
      by: n.sourceUsername || null,
      ...headline('Tried to delete this shared app', null),
    };
  }
  if (n.kind === 'app_deleted') {
    return {
      ...base,
      appLine: 'Account',
      wrap: true,
      icon: '🗑️',
      by: n.sourceUsername || null,
      ...headline('Deleted a shared app you contributed to', n.detail || 'an app'),
    };
  }

  if (n.kind === 'app_quota_changed') {
    const [before, after] = String(n.detail || '').split(':');
    const detail = /^\d+$/.test(before) && /^\d+$/.test(after)
      ? `${before} → ${after} app slots` : 'View your current app allowance';
    return { ...base, appLine: 'Account', wrap: true, icon: '＋',
      label: 'App allowance changed', segments: [{ t: 'text', v: detail }] };
  }
  if (n.kind === 'app_quota_requested') {
    return { ...base, appLine: 'Admin', wrap: true, icon: '＋',
      label: 'Requested more app slots', segments: [{ t: 'who', v: who }] };
  }
  if (n.kind === 'app_quota_request_declined') {
    return { ...base, appLine: 'Account', wrap: true, icon: 'ℹ️',
      label: 'App allowance request declined',
      segments: [{ t: 'text', v: 'Your app allowance is unchanged.' }] };
  }

  // Managed OpenRouter review alerts, plus historical successful-issuance
  // rows created before #2121. `who` is WHOSE KEY it is, not who acted, so
  // the name stays in the headline and `by` stays null. They carry no app and
  // click through to Admin → Users, so that is what the meta line names.
  if (n.kind === 'openrouter_key_created' || n.kind === 'openrouter_key_review') {
    const review = n.kind === 'openrouter_key_review';
    return {
      ...base,
      appLine: 'Admin',
      wrap: true,
      icon: review ? '⚠️' : '🔑',
      label: review ? 'OpenRouter key needs admin review' : 'OpenRouter access enabled',
      segments: [{ t: 'who', v: who }],
    };
  }

  // A server-wide cap nearing or at its ceiling (services/platform-limit-
  // alerts.js). Full admins only, no app: the meta line says Admin like the
  // two kinds above. `detail` is "<limit>_<level>:<used>:<cap>"; a token this
  // build cannot read still says which kind of alert it is.
  if (n.kind === 'platform_limit') {
    const limit = parsePlatformLimitDetail(n.detail);
    if (!limit) {
      return { ...base, appLine: 'Admin', wrap: true, icon: '\u26A0\uFE0F',
        ...headline('Platform limit', 'the server is nearing one of its limits') };
    }
    const noun = limit.limit === 'apps' ? 'apps' : 'coding sessions';
    const full = limit.level === 'full';
    const consequence = limit.limit === 'apps'
      ? (full ? ' New apps are refused until MAX_APPS is raised or an app is removed.'
        : ' Raise MAX_APPS before new apps are refused.')
      : (full ? ' New sessions pause idle ones, or wait, until MAX_GLOBAL_SESSIONS is raised.'
        : ' At the limit, idle sessions are paused to make room.');
    return {
      ...base,
      appLine: 'Admin',
      wrap: true,
      icon: full ? '\u{1F6A8}' : '\u26A0\uFE0F',
      label: full
        ? (limit.limit === 'apps' ? 'App limit reached' : 'Session limit reached')
        : (limit.limit === 'apps' ? 'Nearing the app limit' : 'Nearing the session limit'),
      segments: [
        { t: 'strong', v: `${limit.used} of ${limit.cap} ${noun} in use.` },
        { t: 'text', v: consequence },
      ],
    };
  }

  const prLabel = n.prTitle || (n.prNumber ? `PR #${n.prNumber}` : null);

  if (n.kind === 'kudos') {
    return {
      ...base,
      icon: '\u{1F44F}',
      by: n.sourceUsername || null,
      ...headline('Kudos', prLabel || 'your PR'),
    };
  }

  if (n.kind === 'reaction') {
    return {
      ...base,
      icon: n.detail || '❤️',
      by: n.sourceUsername || null,
      ...headline('Reacted', (n.messageContent || '').slice(0, 140)),
    };
  }

  // A system warning, no actor: the author's promoted PR has gone quiet and is
  // heading for auto-archive. The old copy spelled the whole mechanism out
  // ("is going stale, it'll auto-archive soon without votes"); what the row
  // has to say is that it needs votes, and the rest is on the proposal.
  if (n.kind === 'stale_pr') {
    return {
      ...base,
      icon: '⏳',
      ...headline('Needs votes', prLabel || n.sessionTitle || 'your PR'),
    };
  }

  // Also a system warning: the staging preview would not boot, so the checks
  // that gate merge never ran.
  if (n.kind === 'check_failed') {
    return {
      ...base,
      icon: '⚠️',
      ...headline('Checks blocked', prLabel || n.sessionTitle || 'your proposal'),
    };
  }

  // Someone promoted a PR and this is the nudge to come and vote. THE row this
  // whole rewrite is measured against: it read "@evan proposed a PR to vote on
  // in Notes" with the PR's own title on an unrendered third line, so the one
  // thing that distinguished two of them was invisible.
  if (n.kind === 'pr_proposed') {
    return {
      ...base,
      icon: '\u{1F5F3}️',
      by: n.sourceUsername || null,
      ...headline('New proposal', prLabel || 'a PR'),
    };
  }

  // ── #1374's five ────────────────────────────────────────────────────
  //
  // Each of these was a silence before that change: nothing told you your
  // proposal had merged, that somebody had voted on it, or that an issue had
  // been filed on an app you look after.

  // The good-news row. `detail === 'forced'` is an admin override rather than
  // a vote that carried, and the label says which: to the person who wrote
  // the change those are the same event with very different meanings.
  if (n.kind === 'pr_merged') {
    const head = headline(
      n.detail === 'forced' ? 'Merged by an admin' : 'Merged',
      prLabel || n.sessionTitle || 'your proposal',
    );
    // #1688: on a merge the vote carried, `detail` names who backed and
    // shaped it. An admin override's marker is not a sentence to show.
    const credits = n.detail && n.detail !== 'forced' ? String(n.detail) : '';
    return {
      ...base,
      icon: '\u{1F389}',
      label: head.label,
      segments: credits ? [...head.segments, { t: 'text', v: credits }] : head.segments,
    };
  }

  // Somebody voted. The DIRECTION is in the label rather than the subject,
  // because it is the part you want at a glance and the proposal title is
  // usually long enough to push it off the row.
  if (n.kind === 'proposal_vote') {
    const head = headline(
      n.detail === 'no' ? 'Voted no' : 'Voted yes',
      prLabel || n.sessionTitle || 'your proposal',
    );
    // #1688: the voter's own line rides after the subject, quoted — the
    // proposer's first sight of an objection is the sentence, not the thumb.
    const reason = typeof n.voteReason === 'string' ? n.voteReason.trim() : '';
    return {
      ...base,
      by: n.sourceUsername || null,
      icon: n.detail === 'no' ? '\u{1F44E}' : '\u{1F44D}',
      label: head.label,
      segments: reason
        ? [...head.segments, { t: 'text', v: `“${reason}”` }]
        : head.segments,
    };
  }

  // #1688: the author pushed a new version of a proposal this person had
  // said yes to. The row's own button re-casts the yes with one tap (the
  // server carries their earlier line along); the row itself opens the
  // proposal for another look. Once read — by either — the button goes.
  if (n.kind === 'revision_recheck') {
    return {
      ...base,
      by: n.sourceUsername || null,
      icon: '\u{1F501}',
      ...headline('Still good?', prLabel || n.sessionTitle || 'a proposal you backed'),
      actions: n.readAt ? [] : [{ key: 'still_yes', label: 'Still yes', primary: true }],
    };
  }

  // #1688: the Friday card. `detail` is "<merged>:<open>" — what went live
  // this week and what is waiting on votes; the card itself is in the chat.
  if (n.kind === 'weekly_digest') {
    const counts = /^(\d+):(\d+)$/.exec(String(n.detail || ''));
    const merged = counts ? Number(counts[1]) : 0;
    const open = counts ? Number(counts[2]) : 0;
    const shipped = merged === 0
      ? 'Nothing landed this week'
      : `${merged} ${merged === 1 ? 'change' : 'changes'} went live`;
    const waiting = open
      ? `${open} ${open === 1 ? 'proposal is' : 'proposals are'} waiting for eyes`
      : '';
    return {
      ...base,
      icon: '\u{1F4F0}',
      ...headline(`This week on ${n.appName || 'the app'}`, [shipped, waiting].filter(Boolean).join(' · ')),
    };
  }

  // A new issue on an app you have a stake in. `detail` is the issue number
  // (notifications has no issue column; see the producer), so the subject is
  // the number rather than the title — the title is one tap away and a
  // truncated one here would be worse than a precise reference.
  if (n.kind === 'issue_opened') {
    return {
      ...base,
      by: n.sourceUsername || null,
      icon: '\u{1F4DD}',
      ...headline('New issue', n.detail ? `#${n.detail}` : 'filed'),
    };
  }

  // The app is unwell, and this row goes only to people who can fix it.
  //
  // `detail` is a short TOKEN, never a reason line: notifications.detail is
  // VARCHAR(32), so a build failure's own message would arrive as a
  // meaningless fragment. The copy is rendered from the token here, and the
  // full reason is on the app (apps.last_failure) where the row leads.
  // Rendering `detail` directly would also put an internal identifier on
  // screen, which is the thing tests/settings-mobile-push.test.js bars
  // elsewhere for good reason.
  if (n.kind === 'app_health') {
    // #2253: the app storage cap speaks through this channel too, and its
    // two tokens carry copy that says what happened and what it means for
    // the app. The app name leads the line on purpose: this row is only
    // ever about one app, and "has used most of its storage" with nothing
    // in front of it reads as the platform talking about itself.
    const appName = n.appName || 'Your app';
    if (n.detail === 'storage_warn') {
      return {
        ...base,
        wrap: true,
        icon: '\u{1F4BE}',
        ...headline('App storage', `${appName} has used most of its storage`),
      };
    }
    if (n.detail === 'storage_full') {
      return {
        ...base,
        wrap: true,
        icon: '\u{1F4BE}',
        label: 'App storage',
        segments: [
          { t: 'strong', v: `${appName} is out of storage.` },
          { t: 'text', v: ' New data cannot be saved until an admin raises its limit or allows time to clean up' },
        ],
      };
    }
    // release_stalled: the platform's own app, a merged commit that has not
    // become the running release (services/release-watch.js).
    const APP_HEALTH_COPY = {
      deploy_failed: 'a deploy failed',
      release_stalled: 'a merged change has not gone live',
    };
    return {
      ...base,
      wrap: true,
      icon: '\u{1F6A8}',
      ...headline('App problem', APP_HEALTH_COPY[n.detail] || 'something needs looking at'),
    };
  }

  // The daily digest, and the counterweight to `new_proposals` defaulting
  // off. `detail` is the COUNT, so the subject is a plural-aware phrase
  // rather than a bare number nobody can parse without the label.
  if (n.kind === 'vote_digest') {
    const count = Number(n.detail) || 0;
    return {
      ...base,
      icon: '\u{1F5F3}\uFE0F',
      ...headline(
        'Waiting on your vote',
        count === 1 ? '1 proposal' : `${count} proposals`,
      ),
    };
  }

  // #1405 path A: your agent put work somewhere while you were away. The label
  // carries the DESTINATION, because that is the part you cannot infer —
  // "submitted" is at a vote with checks running, "shared" is visible on the
  // Dev board with nobody being asked to decide anything.
  if (n.kind === 'connector_submitted') {
    const shared = n.detail === 'shared';
    return {
      ...base,
      wrap: true,
      icon: shared ? '\u{1F441}️' : '\u{1F4E4}',
      ...headline(
        shared ? 'Shared by your agent' : 'Submitted by your agent',
        n.sessionTitle || prLabel || 'your change',
      ),
    };
  }

  // #1405 path B: the agent asked you something and you have not answered.
  //
  // The copy says it was ASKED, never that you are currently being waited on.
  // Clearing depends on the agent calling back and it may forget, so "is
  // waiting on you" would be FALSE on the row you see after already replying —
  // and a notification making a false claim reads as broken. This phrasing
  // stays true either way, which is what makes a stale one merely redundant.
  if (n.kind === 'agent_awaiting_input') {
    return {
      ...base,
      wrap: true,
      icon: '\u{1F4AC}',
      ...headline('Claude asked you something', n.sessionTitle || null),
    };
  }

  // #161: dev-session completion — the owner left mid-turn and it finished.
  // #971: label precedence is sessionTitle → prTitle → branchName. The session
  // title is the canonical display name (schema.sql #249) and is mirrored from
  // pr_title once a PR exists, so a promoted session reads exactly as it did
  // before; a pre-PR session shows its real title instead of
  // `dev/<user>-<epoch>`.
  if (n.kind === 'session_done') {
    return {
      ...base,
      wrap: true,
      icon: '✅',
      ...headline(
        // #2779: a run in an agent session says what finished, not "session".
        n.agentSessionId ? 'The coding agent finished' : 'Session finished',
        n.sessionTitle || prLabel || n.branchName || 'your session',
      ),
    };
  }

  // #3181: the other way a turn ends. It errored, timed out or lost its
  // worker, or the platform paused the session mid-turn, so the work is not
  // done and nothing else would say so. Same subject ladder as session_done;
  // the app is on the meta line, so the label is the whole message.
  if (n.kind === 'session_stalled') {
    return {
      ...base,
      wrap: true,
      icon: '⏸️',
      ...headline(
        n.agentSessionId ? 'The coding agent stopped before finishing' : 'Session stopped before finishing',
        n.sessionTitle || prLabel || n.branchName || 'your session',
      ),
    };
  }

  // #161: headless proposal-run completion. #150: a question outcome isn't
  // "ready" work product — it is the run asking the reporter for input, so the
  // label says so.
  if (n.kind === 'auto_solve_done') {
    const failed = n.detail === 'failed';
    const label = failed ? 'Proposal failed'
      : (n.detail === 'question' ? 'Proposal has a question' : 'Proposal ready');
    return {
      ...base,
      wrap: true,
      icon: failed ? '⚠️' : '\u{1F916}',
      ...headline(
        label,
        n.headlessIssueNumber ? `issue #${n.headlessIssueNumber}` : 'an issue',
      ),
    };
  }

  // (#86) Private spec share: someone sent this user a spec version. Clicking
  // opens the app's general chat with the read-only spec panel showing that
  // exact version (see _onItemClick).
  if (n.kind === 'spec_shared') {
    return {
      ...base,
      wrap: true,
      icon: '\u{1F4CB}',
      by: n.sourceUsername || null,
      ...headline(
        'Spec shared',
        n.sessionTitle || prLabel || n.branchName || `v${n.detail || '?'}`,
      ),
    };
  }

  // Collab-invite history rows (the actionable Accept/Decline buttons live
  // ONLY in the pinned Invites section, driven by pendingInvites — once
  // resolved this is just a plain history row). The app's name is the meta
  // line's job, so the label is the whole headline.
  if (n.kind === 'collab_invite' || n.kind === 'collab_invite_accepted'
    || n.kind === 'approver_invite' || n.kind === 'approver_invite_accepted') {
    const label = n.kind === 'collab_invite'
      ? 'Invited you to collaborate'
      : n.kind === 'collab_invite_accepted'
        ? 'Accepted your collaborator invite'
        : n.kind === 'approver_invite'
          ? 'Invited you to be an approver'
          : 'Accepted your approver invite';
    return {
      ...base,
      mb: false,
      wrap: true,
      icon: n.kind === 'collab_invite' ? '✉️'
        : n.kind === 'approver_invite' ? '🗳️' : '✅',
      by: n.sourceUsername || null,
      ...headline(label, null),
    };
  }

  // Mentions and replies, and anything else that carries a chat message.
  return {
    ...base,
    metaFlex: false,
    by: n.sourceUsername || null,
    ...headline(
      n.kind === 'mention' ? 'Mentioned you'
        : n.kind === 'reply' ? 'Replied to you'
          // #2387: somebody answered in a reply thread you started or joined.
          : n.kind === 'thread_reply' ? 'Replied in thread' : 'Posted',
      (n.messageContent || '').slice(0, 140),
    ),
  };
}

// `relativeTime` lived here. It never stopped being relative, so a row from
// last spring read "412d ago" — a duration, not a date. It is `agoStamp` from
// lib/timestamp.ts now, which prints "Mar 4" past a week (#1808).
//
// Both halves of a row's stamp cross to the component as descriptor fields:
// `time` is what the row prints and `timeTitle` is what it hangs on `title`,
// so a "3d ago" is one hover from the exact instant.
function stampFields(ts) {
  const { text, title } = agoStamp(ts);
  return { time: text, timeTitle: title };
}

// #1079 chunk B published this row builder on the object rather than leaving
// it in file scope: the cog drawer's "Needs attention" section rendered these
// very same per-kind rows, and once each module had its own scope inside the
// bundle it could no longer just call a neighbour's function.
//
// #1191 slice 6 conversion 4 then made what crosses here a DESCRIPTOR rather
// than an HTML string, so both drawers rendered the rows with one React
// component (NotificationRow in ./notifications-list.tsx).
//
// THE UI OVERHAUL retired the cog drawer and merged its pinned rows into this
// list, so there is one caller again. The seam stays as it is: the descriptor
// is what keeps ./notifications-list.tsx presentational, and it is what let the
// list be lifted wholesale into the hamburger without this module noticing.
Notifications._rowView = rowView;

// Published exactly where the classic <script> published it: at module
// evaluation, which for the React entry is still before DOMContentLoaded. The
// guard is for the SSG prerender pass, which evaluates this module in node.
// init() is called by the island's layout effect (see ./index.tsx) rather than
// from a DOMContentLoaded handler — that runs during hydration, i.e. EARLIER
// than the old handler did, so it still lands before app.js's init.
if (typeof window !== 'undefined') window.Notifications = Notifications;
