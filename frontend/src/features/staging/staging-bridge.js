/**
 * The staging-preview / visual-compare bridge bodies (#1085 chunk H, step 1).
 *
 * Split out of ./mount.ts, and plain JS with no React import, for one reason:
 * tests/staging-iframe-identity.test.js drives THIS code — the real bridge over
 * the real store — against the real public/js/app-view.js. A bridge that only
 * existed inside a react-dom import could not be exercised by the root test
 * suite (which runs with no frontend/node_modules), and an identity guarantee
 * asserted against a re-implementation is not an identity guarantee.
 *
 * ./mount.ts owns the two things that genuinely need React: pointing each
 * store's flush at `flushSync`, and publishing these objects on
 * `window.UsernodeReact`.
 */

import {
  stagingHandlers,
  stagingRefs,
  stagingStore,
  visualCompareHandlers,
  visualCompareStore,
} from './staging-store.js';
import { APP_FRAME_SANDBOX, PENDING_FRAME_SANDBOX } from '../app-frame/app-frame-policy.js';

/**
 * Counts genuine `src` assignments on #staging-iframe.
 *
 * The identity test's core assertion: every state change that is NOT a
 * navigation (open, close, loader text, testing panel) must
 * leave this untouched, and the element must be the same object throughout.
 */
let navigations = 0;

export const stagingBridge = {
  open() {
    stagingStore.set({ open: true });
  },
  close() {
    stagingStore.set({
      open: false,
      loaderVisible: false,
      loaderShots: false,
      testBtnHidden: true,
      testPanelHidden: true,
      testHtml: '',
      clockLabel: '',
      clockAsNow: false,
      changeTitle: '',
      changeNumber: 0,
      changePending: false,
      appName: '',
      appTile: '',
      appTileImage: '',
      selfHosted: false,
      vote: null,
      shotsHtml: '',
      view: 'preview',
      placement: 'full',
      rect: null,
      expanded: false,
      wide: false,
      beside: null,
      liveSpot: null,
    });
  },

  /**
   * Which change the preview shows, for its header (`{ title, number, tile,
   * tileImage, selfHosted, pending }`). Only words the header; never touches
   * the iframe. `pending` says its name is still being looked up; a name
   * that arrives ends the wait.
   */
  setChange(change) {
    // A patch: a field left out keeps what the header shows, so the change's
    // name can arrive after the app's tile without clearing it.
    const c = change || {};
    const next = {};
    if (c.title !== undefined) next.changeTitle = typeof c.title === 'string' ? c.title.trim().slice(0, 256) : '';
    if (c.pending !== undefined) next.changePending = !!c.pending;
    if (next.changeTitle) next.changePending = false;
    if (c.number !== undefined) {
      const number = Number(c.number);
      next.changeNumber = Number.isInteger(number) && number > 0 ? number : 0;
    }
    if (c.appName !== undefined) next.appName = typeof c.appName === 'string' ? c.appName.trim().slice(0, 120) : '';
    if (c.tile !== undefined) next.appTile = typeof c.tile === 'string' ? c.tile.slice(0, 16) : '';
    if (c.tileImage !== undefined) {
      next.appTileImage = typeof c.tileImage === 'string' && /^(https?:\/\/|\/)/.test(c.tileImage) ? c.tileImage : '';
    }
    if (c.selfHosted !== undefined) next.selfHosted = !!c.selfHosted;
    stagingStore.set(next);
  },
  /** The vote as the chat's vote card reads it, or null when it is not up for one. */
  setVote(vote) {
    if (!vote || typeof vote !== 'object') { stagingStore.set({ vote: null }); return; }
    const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
    stagingStore.set({
      vote: {
        yes: num(vote.yes),
        needed: num(vote.needed),
        needsOtherMember: !!vote.needsOtherMember,
        myVote: vote.myVote === 'yes' || vote.myVote === 'no' ? vote.myVote : null,
        status: typeof vote.status === 'string' ? vote.status : 'promoted',
      },
    });
  },
  /** The before and after viewer's markup (built escaped by AppView.shotsHtml), or ''. */
  setShots(html) {
    const shotsHtml = html || '';
    stagingStore.set(shotsHtml ? { shotsHtml } : { shotsHtml: '', view: 'preview' });
  },
  /** The switch: 'preview' (the running change) or 'shots' (its before and after). */
  setView(view) {
    const st = stagingStore.get();
    stagingStore.set({ view: view === 'shots' && st.shotsHtml ? 'shots' : 'preview' });
  },
  /** Where it stands (./placement.ts): `{ placement, rect, wide, beside }`. */
  setPlacement(p) {
    const placement = p && (p.placement === 'column' || p.placement === 'panel') ? p.placement : 'full';
    stagingStore.set({
      placement,
      rect: placement === 'full' ? null : (p.rect || null),
      wide: !!(p && p.wide),
      beside: placement === 'panel' && p && p.beside === 'app' ? 'app' : null,
    });
  },
  /** The spot moved (a resize, a column dragged): only the rectangle changes. */
  setRect(rect) {
    if (stagingStore.get().placement === 'full') return;
    stagingStore.set({ rect: rect || null });
  },
  /** Full window (true), or back to the column or the panel (false). */
  setExpanded(expanded) {
    stagingStore.set({ expanded: !!expanded });
  },
  isExpanded() {
    return stagingStore.get().expanded;
  },
  /** The first-visit line was put away on this device. */
  setNoteSeen(seen) {
    stagingStore.set({ noteSeen: !!seen });
  },
  isOpen() {
    return stagingStore.get().open;
  },

  setUrlLabel(text) {
    stagingStore.set({ urlLabel: text || '' });
  },

  /**
   * Who the previewed app is for (`apps.audience`: 'open' | 'invited' |
   * 'solo'). Only words the banner; never touches the iframe.
   */
  setAudience(audience) {
    stagingStore.set({ solo: audience === 'solo' });
  },

  /**
   * The moment the preview is shown as of (`{ label, asNow }`), or null when
   * its change declares none (src/services/preview-clock.js). Only words the
   * line under the bar: the preview's address, `un-now` included, is
   * app-view.js's, through setSrc. Answers whether a line is now drawn,
   * which is what lets app-view.js open the preview at that moment at all.
   */
  setClock(clock) {
    const label = clock && typeof clock.label === 'string' ? clock.label.trim() : '';
    stagingStore.set(label
      ? { clockLabel: label, clockAsNow: !!clock.asNow }
      : { clockLabel: '', clockAsNow: false });
    return !!label;
  },

  /**
   * #816: an EXPLICIT '' clears a line; `undefined` leaves it alone.
   * #3413: the retry label is reset on every call, so only a caller that
   * names it ("Retry preview") gets anything but "Retry sign-in".
   * `offerShots` is reset the same way: only a wait or a dead end offers
   * the change's before and after.
   */
  setLoader(visible, patch = {}) {
    const next = {
      loaderVisible: !!visible,
      loaderRetry: !!visible && !!patch.retry,
      loaderRetryLabel: patch.retryLabel || null,
      loaderShots: !!visible && !!patch.offerShots,
    };
    if (patch.title !== undefined) next.loaderTitle = patch.title;
    if (patch.sub !== undefined) next.loaderSub = patch.sub;
    stagingStore.set(next);
  },

  setTestBtn({ hidden, title } = {}) {
    stagingStore.set({ testBtnHidden: !!hidden, testBtnTitle: title || '' });
  },
  setTestHtml(html) {
    stagingStore.set({ testHtml: html || '' });
  },
  setTestPanelHidden(hidden) {
    stagingStore.set({ testPanelHidden: !!hidden });
  },
  isTestPanelHidden() {
    return stagingStore.get().testPanelHidden;
  },

  /** The live iframe element, or null before hydration. */
  frame() {
    return stagingRefs.iframe;
  },
  setBackground(background) {
    if (!stagingRefs.iframe) return;
    stagingStore.set({ background: background || '' });
  },
  /**
   * Point the preview at `src`. The ONLY way its `src` ever changes, and an
   * imperative write by design — see staging-store.js.
   */
  setSrc(src) {
    const el = stagingRefs.iframe;
    if (!el || !src) return false;
    navigations += 1;
    // A preview runs unreviewed code: it gets the production app frame's
    // sandbox, so it can never navigate the Homeroom tab itself, and it
    // behaves as its change will once it is live. A sandbox applies from the
    // next navigation, so it is set before `src` (../app-frame/app-frame-policy.js).
    el.setAttribute('sandbox', APP_FRAME_SANDBOX);
    el.src = src;
    return true;
  },
  /** `iframe.src = ''` — drops the previous preview without touching the element. */
  clearSrc() {
    stagingStore.set({ background: '' });
    const el = stagingRefs.iframe;
    if (!el) return;
    // The blank document it falls back to is same-origin with the shell, so
    // it must not keep allow-scripts with allow-same-origin.
    el.setAttribute('sandbox', PENDING_FRAME_SANDBOX);
    el.src = '';
  },

  setHandlers(patch) {
    Object.assign(stagingHandlers, patch);
  },

  /** Diagnostics for tests/staging-iframe-identity.test.js. */
  stats() {
    return { navigations };
  },
};

export const visualCompareBridge = {
  open({ label, bodyHtml, openedAt } = {}) {
    visualCompareStore.set({
      open: true,
      openedAt: openedAt || 0,
      label: label || '',
      bodyHtml: bodyHtml || '',
    });
  },
  close() {
    // Clearing the body (rather than only hiding the overlay) is what stops a
    // looping <video> inside a comparison — see #353.
    visualCompareStore.set({ open: false, bodyHtml: '', label: '' });
  },
  openedAt() {
    return visualCompareStore.get().openedAt;
  },
  setHandlers(patch) {
    Object.assign(visualCompareHandlers, patch);
  },
};
