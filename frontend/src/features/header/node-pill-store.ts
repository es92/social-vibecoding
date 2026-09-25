/**
 * The embedded node's status, as one view model for TWO surfaces.
 *
 * ── Why one store and not two ─────────────────────────────────────────
 *
 * The drawer row and the detail sheet are different shapes on screen and the
 * same fact underneath: what is the node doing. `_render` and
 * `_renderSheetBody` were two writers reading one `_status` field, and every
 * `usernode:node-status` event called both. Two stores would have been two
 * copies of that answer, free to disagree for a frame — the rule the dev
 * chat's composer chunk wrote down, on a much smaller surface.
 *
 * ── The empty state is the hidden row ─────────────────────────────────
 *
 * `visible: false` is what the prerender renders, matching the `hidden` the
 * hand-written drawer shipped. The row is revealed for every native top
 * frame — desktop browsers and child-app iframes keep it hidden — and a
 * temporary bridge or provisioning problem must never rewrite navigation, so
 * `visible` and `status` are deliberately separate: an unavailable node is a
 * VISIBLE row reading "Unavailable", not a missing one.
 */

import { createStore } from '../../lib/plain-store.js';

/** From the app's chrome-level provider. `unavailable` is this file's fallback. */
export type NodeStatusKind =
  | 'synced' | 'syncing' | 'connecting' | 'offline' | 'unavailable';

export interface NodePillState {
  visible: boolean;
  status: NodeStatusKind;
  /**
   * The chain the node is on. Empty renders an em dash rather than a blank
   * row — an unknown chain is a fact worth showing.
   */
  chain: string;
  /**
   * The sheet's numbers. Null renders an em dash. The pill's events only fire
   * on state transitions, so the module re-reads them every few seconds while
   * Settings or the sheet is on screen (NodePill.setLiveRefresh).
   */
  localBestHeight: number | null;
  /**
   * How old the local tip is, ALREADY WORDED ('just now', '4 minutes ago').
   *
   * #1402 derives it from `localBestTimestampMs` and `clockDriftMs`, which
   * makes it a decision — which clock, what wording, what counts as "just
   * now" — and decisions stay in the module. It is recomputed on each publish:
   * per status event, and per live pull while Settings or the Node sheet is
   * visible. It does NOT tick on its own otherwise.
   */
  tipAge: string | null;
  /**
   * The height to show as the network's. #1402: once we are synced our own tip
   * IS the height the network has reached, and only while catching up is the
   * peer-derived number a separate thing (the sync target). The module picks
   * between them; this field is the answer, not the input.
   */
  networkBestHeight: number | null;
  /**
   * Peers whose P2P connection has reached ready. The bridge sends
   * `connectedPeers` as a compatibility alias on older builds, so the module
   * resolves the two before publishing.
   */
  readyPeers: number | null;
  totalPeers: number | null;
  /**
   * Health notices, already worded, in display order. Empty renders no box at
   * all — see ./node-pill-sheet.tsx.
   */
  warnings: string[];
}

export const NODE_PILL_EMPTY: NodePillState = {
  visible: false,
  status: 'unavailable',
  chain: '',
  localBestHeight: null,
  tipAge: null,
  networkBestHeight: null,
  readyPeers: null,
  totalPeers: null,
  warnings: [],
};

export const nodePillStore = createStore<NodePillState>(NODE_PILL_EMPTY);
