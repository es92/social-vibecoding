/**
 * `#dc-view`'s children — the dev chat's whole screen — as a view model.
 *
 * ── The last boundary, and what it absorbs ────────────────────────────
 *
 * `renderChatView` assigned `#dc-view.innerHTML` and then mounted FIVE
 * portals into the hosts that assignment had just written: the session
 * header, the four banners, the transcript, the composer, and (on the other
 * branch) the app's session list. Each of those was a host-is-mine,
 * children-are-React's seam, and each existed only because the SKELETON
 * around it was still a string.
 *
 * It is a component now, so the five are ordinary children. Their `mount*`
 * bridge methods are gone and only `publish*` crosses the seam — the same
 * fold the composer did for the four strips inside it.
 *
 * That also changes what a re-render COSTS. `renderChatView` runs on every
 * status poll; it used to throw the entire screen away and rebuild it, which
 * is why so much of this module is written to survive that. Re-mounting the
 * same host is a reconcile, so a poll now touches the nodes whose props
 * changed and nothing else.
 *
 * ── Two hosts stay legacy-owned, and each for its own reason ──────────
 *
 * `#dc-spec-viewer` was a third, and the only genuine CONTROLLER host of the
 * three: `_renderSpecViewer` filled it with the version list, the markdown
 * and the share controls. It is an ordinary parent now, with the reader as
 * its child island — see ./spec-viewer-store.ts.
 *
 *   - `#dc-staging-panel` is a SLOT, not a container. The docked preview is
 *     an overlay positioned over its rect (`_syncStagingDockGeometry`
 *     measures it); it stays empty, and a `ResizeObserver` watches it.
 *   - `#dc-session-header` renders its own children, but the ELEMENT keeps a
 *     constant `className` because `PlatformUI.attachScreenFx` writes a
 *     hairline class onto it once the chat scrolls.
 *
 * The two resizers and the two panes carry an `-open` class from this model
 * and a `width` the DRAG writes as an inline style. Those do not collide:
 * the class strings only change when a pane opens or closes, and React does
 * not touch a `className` whose prop value has not changed — which is what
 * also lets the drag's own `-active` class survive a repaint mid-drag.
 */

import { createStore } from '../../lib/plain-store.js';
import type { OwnToolsGuideView } from './own-tools-guide';

/** One resizable side pane: the spec viewer and the staging preview. */
export interface PaneView {
  open: boolean;
  /** Saved from a previous drag. Null when there is nothing to restore. */
  width: number | null;
}

export type DevViewState =
  /**
   * No session open. `renderChatView` painted the app's session list here
   * and nothing else — see the note in migration-state.md about the route
   * that reaches it.
   */
  | { kind: 'none' }
  | {
    kind: 'session';
    /** The full change card already provides the surrounding navigation. */
    embedded?: boolean;
    change?: { item: any; card: any; body: import('../dev-board/topic/model').TopicBody } | null;
    /** #1281's hand-off launchpad: `Launchpad`/`DevFlowSelect`'s markup. */
    launchpadHtml: string;
    /** #1891: the own-tools setup card is an ordinary React child. */
    ownToolsGuide?: OwnToolsGuideView | null;
    /**
     * #1348: in a launchpad the composer is hidden and the venue note is
     * usually absent, so the bar's border and padding are dropped — an
     * empty bordered strip reads as a broken composer. The SAFE-AREA inset
     * is not dropped: this is still the bottom of the screen.
     */
    barEmpty: boolean;
    spec: PaneView;
    staging: PaneView;
    /**
     * #194's one-shot hint, set by the "+" menu's "Propose a change". It was
     * an `insertAdjacentHTML('afterbegin')` from public/js/app-view.js — a
     * second author on this subtree — and is a field here.
     */
    proposalHint: boolean;
    /** #1595: how to leave and find this chat again; dismissed per viewer. */
    returnHint: boolean;
  };

export const devViewStore = createStore<DevViewState>({ kind: 'none' });
