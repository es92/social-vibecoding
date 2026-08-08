// Header cog — the "your work" drawer.
//
// The home screen's "Your proposals" / "Your active sessions" strips
// moved here: a cog button in the header (left of the notifications
// bell) that spins while the machine is doing something for the viewer
// — an AI turn in flight in one of their dev sessions, or one of their
// proposals mid-pipeline (checks running / conflicts auto-resolving /
// actively merging). Tapping it opens a drawer (same chrome as the
// notifications panel) with three stacked sections:
//
//   1. "Needs attention" — the viewer's unread session-related
//      notifications (session_done / auto_solve_done / stale_pr /
//      check_failed), rerouted OUT of the bell. Rows are rendered by
//      notifications.js's shared renderRow and click through via
//      Notifications._onItemClick, so deep links and mark-on-click
//      behave exactly like the bell rows used to.
//   2. "Your sessions" — every non-archived session the viewer owns
//      (active + promoted + paused; the old home strip showed only
//      active), from /api/me/active-sessions.
//   3. "Your proposals" — their open PR proposals (with the same
//      tally pill + MergeStatus lifecycle chip as the old home strip)
//      plus open governance proposals, from /api/me/proposals.
//
// Data flow: Notifications (notifications.js) stays the single owner
// of the /api/notifications fetch/pagination/mark-read plumbing; this
// module reads window.Notifications.items at render time and is nudged
// via WorkDrawer.onNotificationsChanged() whenever that store changes.
// Sessions/proposals are fetched here and refreshed by the same WS paths
// that used to refresh the home strips (App.refreshHomeProposals).
//
// #1038: the SPIN state no longer comes from that fetch cadence. It used
// to be driven by a 15s poll that was only armed while isWorking() was
// ALREADY true (or the drawer was open) — which is exactly why the cog
// never started spinning when you began a turn: nothing was polling, and
// turn start/finish broadcast no session_update. Now the server pushes a
// `session_state` event on every transition, window.SessionState holds
// them, and this module subscribes and repaints. The fetched rows' own
// `busy` flags are seeded into that store so the first paint is right,
// and a live entry always beats a stale fetch.

// The four session-related notification kinds that live in the cog
// drawer instead of the bell. notifications.js exposes the canonical
// set on window (window.SESSION_NOTIF_KINDS); the literal fallback here
// keeps this module self-contained for direct/test loading — a test
// asserts the two literals stay identical.
const WORK_DRAWER_SESSION_KINDS = new Set([
  'session_done', 'auto_solve_done', 'stale_pr', 'check_failed',
]);

const WorkDrawer = {
  sessions: [],
  totals: { active: 0, promoted: 0, paused: 0, busy: 0, total: 0 },
  proposals: [],
  governance: [],
  open: false,

  _kinds() {
    return (typeof window !== 'undefined' && window.SESSION_NOTIF_KINDS)
      ? window.SESSION_NOTIF_KINDS
      : WORK_DRAWER_SESSION_KINDS;
  },

  init() {
    const btn = document.getElementById('work-drawer-btn');
    if (btn) btn.addEventListener('click', WorkDrawer.toggle);
    const closeBtn = document.getElementById('work-drawer-close');
    if (closeBtn) closeBtn.addEventListener('click', WorkDrawer.hide);
    const markAll = document.getElementById('work-drawer-mark-all');
    if (markAll) markAll.addEventListener('click', WorkDrawer.markAllRead);

    // Dismiss on outside click (same pattern as the bell drawer).
    document.addEventListener('click', (e) => {
      if (!WorkDrawer.open) return;
      const panel = document.getElementById('work-drawer-panel');
      const btnEl = document.getElementById('work-drawer-btn');
      if (!panel || !btnEl) return;
      if (panel.contains(e.target) || btnEl.contains(e.target)) return;
      WorkDrawer.hide();
    });

    // #1038: repaint the cog (and the open drawer) whenever live session
    // state moves, with no refetch. This is what makes the cog start
    // spinning the moment a turn begins — in this tab, another tab, or on
    // another device.
    if (window.SessionState) {
      SessionState.subscribe(() => {
        WorkDrawer._renderCog();
        if (WorkDrawer.open) WorkDrawer._renderList();
      });
    }

    // Anonymous SPA boot (fold-auth-pages-into-SPA): the initial fetch
    // waits for the authed boot stage instead of firing a guaranteed 401
    // on a sessionless document. `sv:authed` fires at most once.
    if (window.App && App.user) WorkDrawer.refresh();
    else document.addEventListener('sv:authed',
      () => WorkDrawer.refresh(), { once: true });
  },

  // ?demo=1 forwarding (preserved on the page URL) so the staging demo
  // fixtures populate both lists — same convention Home.load() used for
  // the old strips.
  _demoQS() {
    try {
      return new URLSearchParams(location.search).get('demo') === '1' ? '?demo=1' : '';
    } catch { return ''; }
  },

  // Screenshot-state deep link (`?shot=work-drawer`): the drawer only
  // exists behind a click on the header cog, so the capture pipeline and
  // any dapp.json test would otherwise only ever see the home feed. Same
  // idiom as ?shot=secrets-new / ?shot=card-menu. Pair it with ?demo=1 in
  // staging so the "Needs attention" section has mock rows to render.
  // Once per page load — reopening after a manual dismiss would fight the
  // user, and refresh() runs on a timer.
  _shotOpened: false,
  _maybeShotOpen() {
    if (WorkDrawer._shotOpened || WorkDrawer.open) return;
    let shot = null;
    try { shot = new URLSearchParams(location.search).get('shot'); } catch { /* ignore */ }
    if (shot !== 'work-drawer') return;
    WorkDrawer._shotOpened = true;
    WorkDrawer.show();
  },

  async refresh() {
    const demoQS = WorkDrawer._demoQS();
    // #1038: stamped BEFORE the request goes out — that's the moment this
    // payload is a snapshot of. Using the arrival time instead would let a
    // slow response outrank the idle event that overtook it mid-flight and
    // put the spinner back.
    const issuedAt = Date.now();
    const [sessionsRes, proposalsRes] = await Promise.all([
      fetch(`/api/me/active-sessions${demoQS}`).catch(() => null),
      fetch(`/api/me/proposals${demoQS}`).catch(() => null),
    ]);
    try {
      if (sessionsRes && sessionsRes.ok) {
        const data = await sessionsRes.json();
        WorkDrawer.sessions = Array.isArray(data.sessions) ? data.sessions : [];
        WorkDrawer.totals = data.totals || { active: 0, promoted: 0, paused: 0, busy: 0, total: 0 };
        // Fold this payload's busy flags into the live store; a live event
        // newer than `issuedAt` wins, so a slow fetch can't resurrect a
        // finished turn's spinner.
        if (window.SessionState) SessionState.seed(WorkDrawer.sessions, issuedAt);
      }
    } catch { /* keep the previous snapshot */ }
    try {
      if (proposalsRes && proposalsRes.ok) {
        const data = await proposalsRes.json();
        WorkDrawer.proposals = Array.isArray(data.proposals) ? data.proposals : [];
        WorkDrawer.governance = Array.isArray(data.governance) ? data.governance : [];
      }
    } catch { /* keep the previous snapshot */ }
    WorkDrawer._renderCog();
    if (WorkDrawer.open) WorkDrawer._renderList();
    // After the first populated refresh, so the deep-linked drawer opens
    // onto real rows rather than an empty-state flash.
    WorkDrawer._maybeShotOpen();
  },

  // #1038: live-first busy read for one of the fetched session rows. The
  // `busy` field on the row is only a fallback for a session the store has
  // never heard about.
  _busy(s) {
    if (!s) return false;
    if (typeof window !== 'undefined' && window.SessionState) {
      return SessionState.isBusy(s.id, s.busy);
    }
    return !!s.busy;
  },

  // "The machine is doing something for you right now": an AI turn in
  // flight in any of the viewer's sessions, or a proposal in one of the
  // in-progress merge-pipeline states (the MergeStatus descriptors that
  // carry spinner:true — merging / resolving / checks running). A
  // session that's merely open but waiting on the user does NOT spin.
  isWorking() {
    // #1038: `totals.busy` is a snapshot from the last fetch, so it is only
    // trusted when the live store has nothing to say about the session it
    // counted. Reading the rows through _busy() covers both directions —
    // a turn that started since the fetch, and one that finished.
    if ((WorkDrawer.sessions || []).some(WorkDrawer._busy)) return true;
    if (!(typeof window !== 'undefined' && window.SessionState)
      && (WorkDrawer.totals && WorkDrawer.totals.busy) > 0) return true;
    if (typeof window !== 'undefined' && window.MergeStatus && MergeStatus.lifecycle) {
      return (WorkDrawer.proposals || []).some((p) => {
        const life = MergeStatus.lifecycle(p);
        return !!(life && life.spinner);
      });
    }
    return false;
  },

  _renderCog() {
    const icon = document.getElementById('work-drawer-icon');
    if (!icon) return;
    icon.classList.toggle('work-cog-spinning', WorkDrawer.isWorking());
  },

  // #1038: the 15s `_syncPolling` timer that used to live here is gone.
  // It was the drawer's only path from "a turn started" to "the cog
  // spins", and it was armed on exactly the wrong condition — only while
  // isWorking() was already true — so a turn beginning on an idle account
  // never woke it. window.SessionState's pushed events (subscribed in
  // init) drive the spin now, with its own adaptive reconcile tick as the
  // missed-push safety net.

  toggle() {
    if (WorkDrawer.open) WorkDrawer.hide();
    else WorkDrawer.show();
  },

  _sheet: null,

  show() {
    const panel = document.getElementById('work-drawer-panel');
    if (!panel) return;
    // One drawer at a time: opening the cog closes the bell.
    if (window.Notifications && Notifications.open) Notifications.hide();
    // Touch platforms: kit bottom sheet (a top-sheet variant was tried
    // and reverted — the bottom sheet felt better). Desktop keeps the
    // anchored dropdown below.
    if (PlatformUI.isTouch() && !WorkDrawer._sheet) {
      panel.classList.remove('hidden');
      panel.classList.add('platform-sheet-adopted');
      // Render BEFORE presenting — the kit sheet measures its height
      // once at present time to seed the slide-up spring (see the
      // matching note in notifications.js show()).
      WorkDrawer._renderList();
      const sheet = PlatformUI.sheet({
        contentEl: panel,
        onDismiss: () => {
          panel.classList.remove('platform-sheet-adopted');
          panel.classList.add('hidden');
          document.body.appendChild(panel);
          WorkDrawer._sheet = null;
          WorkDrawer.open = false;
        },
      });
      if (sheet) {
        WorkDrawer._sheet = sheet;
        WorkDrawer.open = true;
        WorkDrawer.refresh();
        return;
      }
      panel.classList.remove('platform-sheet-adopted');
    }
    panel.classList.remove('hidden');
    WorkDrawer.open = true;
    WorkDrawer._renderList();
    WorkDrawer.refresh();
  },

  hide() {
    if (WorkDrawer._sheet) {
      WorkDrawer._sheet.dismiss();
      return;
    }
    const panel = document.getElementById('work-drawer-panel');
    if (!panel) return;
    panel.classList.add('hidden');
    WorkDrawer.open = false;
  },

  // Nudge from notifications.js whenever its items store changes (WS
  // arrival, mark-read, cross-tab refresh) — the cog badge itself is
  // painted by Notifications._renderBadge; this just repaints the open
  // drawer's pinned section.
  onNotificationsChanged() {
    if (WorkDrawer.open) WorkDrawer._renderList();
  },

  // The viewer's unread session-related notifications, from the shared
  // Notifications store (loaded pages; unread session notifs are
  // deduped one-per-session server-side, so the first page covers them
  // in practice).
  _pendingNotifs() {
    const items = (typeof window !== 'undefined' && window.Notifications
      && Array.isArray(Notifications.items)) ? Notifications.items : [];
    const kinds = WorkDrawer._kinds();
    return items.filter((n) => n && kinds.has(n.kind) && !n.readAt);
  },

  async markAllRead() {
    const pending = WorkDrawer._pendingNotifs();
    if (!pending.length) return;
    try {
      const res = await fetch('/api/notifications/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true, kinds: [...WorkDrawer._kinds()] }),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (window.Notifications) {
        const kinds = WorkDrawer._kinds();
        const now = new Date().toISOString();
        Notifications.unread = data.unread || 0;
        Notifications.items = Notifications.items.map((n) =>
          kinds.has(n.kind) ? { ...n, readAt: n.readAt || now } : n
        );
        Notifications._reconcileCompletionTitle();
        Notifications._renderBadge();
      }
      WorkDrawer._renderList();
    } catch (err) {
      console.warn('[work-drawer] markAllRead failed', err);
    }
  },

  // ===== Rendering =====

  _renderList() {
    const list = document.getElementById('work-drawer-list');
    const empty = document.getElementById('work-drawer-empty');
    if (!list || !empty) return;

    const pendingHtml = WorkDrawer.renderPendingSection();
    const sessionsHtml = WorkDrawer.renderSessionsSection();
    const proposalsHtml = WorkDrawer.renderProposalsSection();
    const html = pendingHtml + sessionsHtml + proposalsHtml;

    const markAll = document.getElementById('work-drawer-mark-all');
    if (markAll) markAll.classList.toggle('hidden', !pendingHtml);

    if (!html) {
      list.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    list.innerHTML = html;

    // Pinned-notification clicks reuse the bell's mark-read + deep-link
    // logic wholesale. stopPropagation so the re-render doesn't detach
    // the row before the document-level outside-click handler sees a
    // target still inside the panel (same reasoning as the bell).
    list.querySelectorAll('[data-notif-id]').forEach((el) => {
      const id = Number(el.getAttribute('data-notif-id'));
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        if (window.Notifications) Notifications._onItemClick(id);
        WorkDrawer._renderList();
      });
    });
  },

  _sectionHeader(label) {
    return `<div class="px-3 py-1.5 text-[0.7rem] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950/40">${label}</div>`;
  },

  // "Needs attention": unread session-related notifications, rendered
  // with notifications.js's shared per-kind row builder so copy/markup
  // match what the bell used to show. Hidden when empty.
  renderPendingSection() {
    const pending = WorkDrawer._pendingNotifs();
    if (!pending.length) return '';
    const rowFn = (typeof renderRow === 'function') ? renderRow : null;
    if (!rowFn) return '';
    return WorkDrawer._sectionHeader('Needs attention') + pending.map(rowFn).join('');
  },

  // "Your sessions" — one compact row per non-archived dev session the
  // viewer owns, across all apps (ported from the home screen's
  // "Your active sessions" strip, which showed active-status rows only;
  // paused sessions render too, with a muted tag).
  //
  // #747: a promoted session IS its proposal (same chat_sessions row),
  // so any session whose id appears in the loaded PR-proposal list is
  // dropped here — it renders once, under "Your proposals". Id-match
  // (not status-match) so the row only disappears when its proposal
  // duplicate actually rendered; if the proposals fetch failed, the
  // promoted session still shows here with its "in vote" tag. The
  // governance list is deliberately excluded — its ids come from the
  // issues table and could collide with session ids. Display-only:
  // WorkDrawer.sessions stays unfiltered so isWorking() still sees
  // busy promoted sessions.
  renderSessionsSection() {
    const esc = wdEscapeHtml;
    const proposalIds = new Set(
      (Array.isArray(WorkDrawer.proposals) ? WorkDrawer.proposals : []).map((p) => p.id)
    );
    const all = (Array.isArray(WorkDrawer.sessions) ? WorkDrawer.sessions : [])
      .filter((s) => !proposalIds.has(s.id));
    if (!all.length) return '';

    // Busy-first on top of the server's last_activity_at DESC order
    // (stable sort preserves activity order within each bucket). Cap at
    // 10 — the per-user slot caps keep the real count small; this is
    // just a safety bound.
    // #1038: busy comes from the live store, so the ordering re-sorts on a
    // pushed transition rather than on the next fetch.
    const shown = [...all]
      .sort((a, b) => (WorkDrawer._busy(b) ? 1 : 0) - (WorkDrawer._busy(a) ? 1 : 0))
      .slice(0, 10);

    let rows = '';
    for (const s of shown) {
      const title = s.session_title || s.pr_title || s.branch_name || `Session #${s.id}`;
      const rel = wdRelativeTime(s.last_activity_at || s.created_at);
      const busy = WorkDrawer._busy(s);
      const busyTag = busy
        ? '<span class="inline-flex items-center gap-1 text-xs text-emerald-500 shrink-0"><span class="dc-status-icon dc-status-spinner-arc" aria-hidden="true"></span>working…</span>'
        : '';
      const statusTag = !busy && s.status === 'paused'
        ? '<span class="text-[0.65rem] font-medium text-zinc-400 dark:text-zinc-500 uppercase shrink-0">paused</span>'
        : (!busy && s.status === 'promoted'
          ? '<span class="text-[0.65rem] font-medium text-violet-400 uppercase shrink-0">in vote</span>'
          : '');
      const timeTag = rel
        ? `<span class="text-[0.7rem] text-zinc-400 dark:text-zinc-500 shrink-0">${esc(rel)}</span>`
        : '';
      rows += `
        <a href="#app/${esc(s.app_slug)}/dev/sessions/${s.id}"
           class="flex items-center gap-2 px-3 py-2.5 border-b border-zinc-200 dark:border-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-800/60 transition-colors">
          <span class="text-xs font-medium text-zinc-500 dark:text-zinc-400 shrink-0 max-w-[30%] truncate">${esc(s.app_name)}</span>
          <span class="text-sm text-zinc-800 dark:text-zinc-200 flex-1 min-w-0 truncate">${esc(title)}</span>
          ${timeTag}
          ${statusTag}
          ${busyTag}
        </a>`;
    }

    return WorkDrawer._sectionHeader('Your sessions') + rows;
  },

  // "Your proposals" — the viewer's PR proposals currently open for
  // voting/merging plus their open governance (secret_change)
  // proposals, ported from the home screen's "Your proposals" strip:
  // same qualified-tally pill (#695), auto-title chip, and canonical
  // MergeStatus lifecycle chip (#405).
  renderProposalsSection() {
    const esc = wdEscapeHtml;
    const prs = Array.isArray(WorkDrawer.proposals) ? WorkDrawer.proposals : [];
    const govs = Array.isArray(WorkDrawer.governance) ? WorkDrawer.governance : [];
    if (!prs.length && !govs.length) return '';

    const pill = (yes, majority, state, advisory) => {
      const cls = state === 'merging'
        ? 'bg-amber-500/10 text-amber-500'
        : (yes >= majority ? 'bg-emerald-500/10 text-emerald-500' : 'bg-violet-500/10 text-violet-400');
      // #695: advisory (non-approver) surplus on invited-approver apps —
      // a muted chip beside the pill, never inside the headline tally.
      const adv = advisory > 0
        ? ` <span class="inline-flex items-center text-[0.65rem] font-medium px-1 py-0.5 rounded bg-zinc-500/10 text-zinc-500 shrink-0" title="${advisory} advisory Yes vote${advisory === 1 ? '' : 's'} from non-approvers — they don't count toward merging">+${advisory} advisory</span>`
        : '';
      return `<span class="inline-flex items-center text-[0.7rem] font-mono font-medium px-1.5 py-0.5 rounded ${cls}">${yes} / ${majority}</span>${adv}`;
    };

    // #695: headline tally = the QUALIFYING (approver-only) count when the
    // row carries one, against the per-row governed requirement
    // (votes_required) rather than the raw active-user majority — matching
    // voteCountPill's precedence. Advisory = the non-approver surplus.
    const tally = (row, rawYes) => {
      const yes = row.qualified_yes_count != null
        ? (parseInt(row.qualified_yes_count) || 0) : (parseInt(rawYes) || 0);
      const snap = parseInt(row.votes_required);
      const target = (Number.isFinite(snap) && snap > 0) ? snap : (row.majority || 1);
      const advisory = (row.approval_policy === 'invited' && row.qualified_yes_count != null)
        ? Math.max(0, (parseInt(rawYes) || 0) - yes) : 0;
      return { yes, target, advisory };
    };

    // #405: the merge-status chip is driven by the shared MergeStatus
    // lifecycle helper so this drawer surfaces the SAME canonical states
    // as the proposal feed card and the dev session header. The vote pill
    // carries the tally, so in-vote/draft states render no extra chip.
    const lifeChip = (p) => {
      if (!(typeof window !== 'undefined' && window.MergeStatus && MergeStatus.lifecycle)) return '';
      const life = MergeStatus.lifecycle(p);
      if (!life || ['in_vote', 'draft', 'none'].indexOf(life.key) !== -1) return '';
      return `<span class="shrink-0">${MergeStatus.badgeHtml(life)}</span>`;
    };

    // #747: promoted sessions no longer render in "Your sessions", so a
    // proposal whose underlying session has an AI turn in flight carries
    // the same "working…" spinner tag here instead — in-flight work never
    // becomes invisible. busy comes from the active-sessions payload
    // (promoted sessions can be mid-turn; see /api/me/active-sessions).
    const busyIds = new Set(
      (Array.isArray(WorkDrawer.sessions) ? WorkDrawer.sessions : [])
        .filter(WorkDrawer._busy).map((s) => s.id)
    );
    const busyTag = '<span class="inline-flex items-center gap-1 text-xs text-emerald-500 shrink-0"><span class="dc-status-icon dc-status-spinner-arc" aria-hidden="true"></span>working…</span>';

    let rows = '';
    for (const p of prs) {
      const t = tally(p, p.yes_count);
      const title = p.pr_title || `PR #${p.pr_number || p.id}`;
      // Placeholder-title marker: AI naming was down when this PR was
      // titled; the title-heal sweeper regenerates it automatically.
      const fallbackChip = p.pr_title_fallback
        ? '<span class="inline-flex items-center text-[0.65rem] font-medium px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-500 shrink-0" title="AI naming was unavailable when this proposal was created, so it shows a placeholder title. A descriptive title will be generated automatically.">Auto-title pending</span>'
        : '';
      rows += `
        <a href="#app/${esc(p.app_slug)}/dev/proposals/${p.id}"
           class="flex items-center gap-2 px-3 py-2.5 border-b border-zinc-200 dark:border-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-800/60 transition-colors">
          <span class="text-xs font-medium text-zinc-500 dark:text-zinc-400 shrink-0 max-w-[30%] truncate">${esc(p.app_name)}</span>
          <span class="text-sm text-zinc-800 dark:text-zinc-200 flex-1 min-w-0 truncate">${esc(title)}</span>
          ${fallbackChip}
          ${lifeChip(p)}
          ${pill(t.yes, t.target, p.status, t.advisory)}
          ${busyIds.has(p.id) ? busyTag : ''}
        </a>`;
    }
    for (const g of govs) {
      const gt = tally(g, g.up_count);
      rows += `
        <a href="#app/${esc(g.app_slug)}/dev/proposals"
           class="flex items-center gap-2 px-3 py-2.5 border-b border-zinc-200 dark:border-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-800/60 transition-colors">
          <span class="text-xs font-medium text-zinc-500 dark:text-zinc-400 shrink-0 max-w-[30%] truncate">${esc(g.app_name)}</span>
          <span class="text-sm text-zinc-800 dark:text-zinc-200 flex-1 min-w-0 truncate">${esc(g.title)}</span>
          ${pill(gt.yes, gt.target, 'open', gt.advisory)}
          <span class="text-[0.65rem] font-medium text-violet-400 uppercase shrink-0">In vote</span>
        </a>`;
    }

    return WorkDrawer._sectionHeader('Your proposals') + rows;
  },
};

// Local helpers with drawer-unique names — home.js and notifications.js
// each declare their own global escapeHtml/relative-time helpers, and a
// same-named declaration here would silently shadow theirs (classic
// scripts share one global scope).
function wdEscapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Compact "Nx ago" formatter (same buckets as home.js's card meta line).
// Returns null for unparseable input so callers can drop the segment.
function wdRelativeTime(input) {
  if (!input) return null;
  const t = new Date(input);
  if (Number.isNaN(t.getTime())) return null;
  const seconds = Math.floor((Date.now() - t.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 86400 * 30) return `${Math.floor(seconds / 86400)}d ago`;
  if (seconds < 86400 * 365) return `${Math.floor(seconds / (86400 * 30))}mo ago`;
  return `${Math.floor(seconds / (86400 * 365))}y ago`;
}

if (typeof window !== 'undefined') window.WorkDrawer = WorkDrawer;

if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('DOMContentLoaded', () => WorkDrawer.init());
}
