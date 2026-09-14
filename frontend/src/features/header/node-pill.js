// MOVED in #1079 chunk B. This file was public/js/node-pill.js;
// #header-menu-panel became a React island and this module owns nodes inside
// it, so it moved into the bundle with the region it writes to. Its legacy
// window publication and layout-effect init seam remain load-bearing.
//
// Node status row (top of the hamburger drawer) — surfaces the embedded
// Homeroom node's sync state when the platform runs inside the Homeroom
// app (app-as-SV-chrome migration, see NATIVE-BRIDGE.md). Lived in the
// header as a pill originally; moved into the drawer to keep the header
// uncluttered.
//
// Data flow: the app pushes `usernode:node-status` CustomEvents (once through
// the explicit realm-readiness replay + on pill-state transitions), so the row
// renders from the event stream; `usernode.getNodeStatus()` is only called for
// the initial value and when the detail sheet opens. No polling.
//
// The row is present for every native top frame, even while capabilities or
// node state are unavailable. Desktop browsers and child-app iframes keep it
// hidden. A temporary bridge/provisioning problem must not rewrite navigation.
import { nodePillStore, NODE_PILL_EMPTY } from './node-pill-store';
import { mountNodeSheet, unmountNodeSheet } from './node-pill-sheet';

(function () {
  'use strict';

  // The status → dot/label/ink table moved to ./node-pill-row.tsx. It was a
  // `tone` string carrying a border colour AND an ink, with the border stripped
  // at runtime by a `.filter()` — a computed class name, which Tailwind's
  // extractor cannot see. It is two complete literals there.

  const NodePill = {
    _status: null,
    _sheet: null,
    // Was `hidden` on the row element. It is the model's now, and the
    // component renders the class — see ./node-pill-row.tsx.
    _visible: false,


    // #977 had this await the hamburger drawer's exit before presenting:
    // the row sat inside that drawer, and a kit sheet cannot open over a kit
    // panel still sliding out. The row is in the Profile screen's account
    // group now — a screen does not need dismissing — so the sheet presents
    // directly. This was an addEventListener on the row; it is the
    // component's onClick, dispatching here by name.
    openFromRow() {
      NodePill._openSheet();
    },

    async init() {
      if (!window.NativeChrome || !window.usernode ||
          window.usernode.isNative !== true) return;

      // The row is present for every native top frame — capabilities and node
      // state affect its CONTENTS, never the navigation structure — so this
      // flips before the capability probe and never flips back.
      NodePill._visible = true;
      NodePill._render();

      // Wire this BEFORE the asynchronous capability probe. The native app
      // pushes this event through the readiness replay, so it is independent
      // positive proof that node status is supported and rescues a transient /
      // degraded first probe instead of leaving the row hidden for the realm.
      window.addEventListener('usernode:node-status', (e) => {
        const status = e && e.detail;
        if (!status || typeof status.status !== 'string') return;
        NodePill._visible = true;
        NodePill._status = status;
        NodePill._render();
        NodePill._renderSheetBody();
      });

      if (!(await NativeChrome.has('getNodeStatus'))) {
        NodePill._render();
        return;
      }

      try {
        const snap = await window.usernode.getNodeStatus();
        // An event that arrived while we awaited wins (fresher).
        if (snap && !NodePill._status) NodePill._status = snap;
      } catch (_) { /* event stream will populate it */ }
      NodePill._render();
    },

    // Five writes across two elements — the dot's class, the label's text and
    // the label's class — become one publish. The row and the sheet read the
    // same model, so they cannot disagree for a frame.
    //
    // It publishes RESOLVED values: the four `_*For` helpers above run here,
    // once, rather than in the component. A view model carries answers.
    _render() {
      const s = NodePill._status || {};
      const networkBestHeight = NodePill._networkHeightFor(s);
      const readyPeers = NodePill._readyPeersFor(s);
      nodePillStore.set({
        visible: NodePill._visible,
        status: typeof s.status === 'string' ? s.status : 'unavailable',
        chain: typeof s.chain === 'string' ? s.chain : '',
        localBestHeight: s.localBestHeight == null ? null : s.localBestHeight,
        tipAge: NodePill._tipAgeFor(s),
        networkBestHeight: networkBestHeight == null ? null : networkBestHeight,
        readyPeers: readyPeers == null ? null : readyPeers,
        totalPeers: s.totalPeers == null ? null : s.totalPeers,
        warnings: NodePill._warningMessagesFor(s),
      });
    },

    // -- detail sheet ---------------------------------------------------

    // #1402's four derivations live here, because each is a DECISION — which
    // clock, which height counts as the network's, what is worth warning
    // about — and the module owns decisions. Its `_sheetRow` and
    // `_sheetWarnings` do NOT come across: those built markup, and markup is
    // ./node-pill-sheet.tsx's.
    //
    // They stay named methods rather than folding into `_render` so that the
    // tests upstream wrote against them keep their subject.

    _networkHeightFor(s) {
      // Once synced, our own best tip is the height the network has reached.
      // While catching up, the peer-derived height is the node's sync target.
      return s.status === 'synced' ? s.localBestHeight : s.networkBestHeight;
    },

    _readyPeersFor(s) {
      return s.readyPeers == null ? s.connectedPeers : s.readyPeers;
    },

    _tipAgeFor(s, nowMs = Date.now()) {
      const timestampMs = Number(s.localBestTimestampMs);
      if (!Number.isFinite(timestampMs) || timestampMs <= 0) return null;
      const driftMs = Number(s.clockDriftMs);
      const nodeNowMs = Number(nowMs) -
        (Number.isFinite(driftMs) ? driftMs : 0);
      const seconds = Math.max(0, Math.floor((nodeNowMs - timestampMs) / 1000));
      if (seconds < 5) return 'just now';
      if (seconds < 60) return `${seconds} seconds ago`;
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) {
        return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
      }
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
      const days = Math.floor(hours / 24);
      return `${days} day${days === 1 ? '' : 's'} ago`;
    },

    _warningMessagesFor(s) {
      const warnings = [];
      if (NodePill._readyPeersFor(s) === 0) {
        warnings.push('No connected peers.');
      }
      if (s.syncStalled === true) {
        warnings.push('Sync appears stalled.');
      }
      const driftMs = Number(s.clockDriftMs);
      if (Number.isFinite(driftMs) && Math.abs(driftMs) > 5000) {
        warnings.push('Node clock is out of sync.');
      }
      if (s.walletDataHydrating === true) {
        warnings.push('Wallet-data hydration is still running.');
      }
      return warnings;
    },

    // `_sheetRow` and `_renderSheetBody` built six nodes imperatively and
    // blanked them with `body.textContent = ''` on every status event. The
    // body is a portal now (./node-pill-sheet.tsx) and the store repaints it,
    // so an event arriving mid-sheet updates the numbers in place — including
    // #1402's tip age, which is why nothing here needs a timer.
    _renderSheetBody() {
      NodePill._render();
    },

    async _openSheet() {
      if (NodePill._sheet) return;

      const panel = document.createElement('div');
      panel.className = 'px-4 pb-4';
      const title = document.createElement('div');
      title.className = 'text-lg font-bold py-3';
      title.textContent = 'Node';
      panel.appendChild(title);
      const bodyEl = document.createElement('div');
      bodyEl.id = 'node-pill-sheet-body';
      panel.appendChild(bodyEl);

      NodePill._sheet = PlatformUI.sheet({
        contentEl: panel,
        // Drop the portal BEFORE the kit discards the node it is mounted in —
        // the rule the dev chat's conversions wrote down, on the one seam here
        // where something other than React destroys the host.
        onDismiss: () => {
          unmountNodeSheet(bodyEl);
          NodePill._sheet = null;
        },
      });
      // The store already holds what the body draws, so the mount paints the
      // current status immediately — no separate first render.
      mountNodeSheet(bodyEl);

      // Refresh heights/peers on open — pill events only fire on state
      // transitions, so the numbers can be stale between flips.
      try {
        const snap = await window.usernode.getNodeStatus();
        if (snap) {
          NodePill._status = snap;
          NodePill._render();
          NodePill._renderSheetBody();
        }
      } catch (_) { /* keep the last snapshot */ }
    },
  };

  // Published for the legacy callers that still reach for it by name, exactly
  // as before. init() is NOT called here any more: this module now evaluates
  // while the bundle is being imported, i.e. BEFORE hydration, and its init
  // removes `hidden` from #account-row-node — a class React is about to hydrate
  // against. The island calls it from a layout effect instead (see
  // features/header/header-menu.tsx), which is still before DOMContentLoaded.
  // `typeof window` guard: the shell's markup is PRERENDERED in Node
  // (frontend/scripts/build-shell.mjs), which imports this island's module
  // graph. Same guard as features/notifications/notifications.js.
  if (typeof window !== 'undefined') window.NodePill = NodePill;
})();
