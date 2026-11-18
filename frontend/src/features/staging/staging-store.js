/**
 * State for the staging-preview overlay and the before/after compare overlay
 * (#1085 chunk H).
 *
 * Both are written by `public/js/app-view.js`, which is a classic script and
 * cannot import from this bundle, so each store is fed through a bridge on
 * `window.UsernodeReact` (see ./mount.ts). React-free on purpose — see
 * ../../lib/plain-store.js.
 *
 * ── What is NOT in here, and why ───────────────────────────────────────
 *
 * The iframe's `src`. `#staging-iframe` is rendered exactly once and every
 * change to what it displays is an imperative assignment through a ref
 * (`stagingBridge.setSrc`, `stagingBridge.clearSrc`). If `src` were state, a
 * React re-render would carry it — and a render that re-creates the element,
 * or a `src` prop React decides to re-apply, RELOADS the preview. The
 * loader and testing-panel states must never do that.
 *
 * Click handlers are not state either: they live in a mutable holder the
 * island reads through stable dispatchers, so re-pointing "Back"
 * (what `back.onclick = …` used to do) never re-renders anything.
 */

import { createStore } from '../../lib/plain-store.js';

/**
 * `null` and `0` initial values need declaring, or `tsc --noEmit` infers the
 * literal's own type (`null`, `never`) and every island that reads the field
 * fails to compile.
 *
 * @typedef {{ yes: number | null, needed: number | null, needsOtherMember: boolean, myVote: 'yes' | 'no' | null, status: string }} PreviewVote
 * @typedef {{ left: number, top: number, width: number, height: number }} PreviewRect
 * @typedef {{
 *   open: boolean, urlLabel: string, background: string, solo: boolean,
 *   clockLabel: string, clockAsNow: boolean,
 *   loaderVisible: boolean, loaderTitle: string | null, loaderSub: string, loaderRetry: boolean, loaderRetryLabel: string | null,
 *   loaderShots: boolean,
 *   testBtnHidden: boolean, testBtnTitle: string, testPanelHidden: boolean,
 *   testHtml: string,
 *   changeTitle: string, changeNumber: number, changePending: boolean,
 *   appName: string, appTile: string, appTileImage: string, selfHosted: boolean,
 *   vote: PreviewVote | null, shotsHtml: string, view: 'preview' | 'shots',
 *   placement: 'full' | 'column' | 'panel', rect: PreviewRect | null, expanded: boolean, wide: boolean,
 *   beside: 'app' | null, liveSpot: { left: number, top: number } | null, noteSeen: boolean,
 * }} StagingState
 * @typedef {{ open: boolean, openedAt: number, label: string, bodyHtml: string }} VisualCompareState
 */

/**
 * The initial values MUST equal the markup the hand-written shell shipped —
 * the overlay is hidden, the loader is hidden, its title reads
 * "Opening preview…" (#816: neutral, promising no wait) and its sub-line is
 * empty. A first render that disagrees with the prerendered document is a
 * hydration mismatch, which `console.error`s and fails proposal checks.
 */
export const stagingStore = createStore(/** @type {StagingState} */ ({
  open: false,
  urlLabel: '',
  background: '',
  /**
   * Whether the previewed app is a project that is just its creator's
   * (`audience === 'solo'`), which words the banner under the bar. False
   * until a preview says otherwise, so the first render is the group wording
   * the prerendered page carries.
   */
  solo: false,
  /**
   * The moment a preview is shown as of, in plain words ("Thursday 8 Oct,
   * 7 pm"), when its change declares one (src/services/preview-clock.js);
   * '' otherwise, which draws no line at all, as the prerendered page does.
   * `clockAsNow` is the viewer's "See it as now".
   */
  clockLabel: '',
  clockAsNow: false,
  loaderVisible: false,
  // `null` is the shipped wording, which the overlay reads from the catalog
  // when it renders (devchat:staging.loader.opening and .retrySignIn);
  // a caller's own text replaces it.
  /** @type {string | null} */
  loaderTitle: null,
  loaderSub: '',
  loaderRetry: false,
  /** #3413: "Retry preview" after a failed build; the shipped markup's text otherwise. */
  /** @type {string | null} */
  loaderRetryLabel: null,
  /**
   * The loader is a wait or a dead end (not running, a failure, a rebuild),
   * where "See the before & after instead" is offered when the change has
   * verified shots. False for the moment a preview opens, which is too short
   * to offer anything.
   */
  loaderShots: false,
  testBtnHidden: true,
  testBtnTitle: '',
  testPanelHidden: true,
  /** Sanitized markdown from PlatformMarkdown.render, or escaped plain text. */
  testHtml: '',
  /**
   * The change the preview shows, for its header: its title and pull request
   * number (the preview answer's `change`), and the project's tile (an emoji,
   * or an image's address). '' / 0 until a preview says, which draws the
   * plain "Preview" title the prerendered page carries.
   */
  changeTitle: '',
  changeNumber: 0,
  /**
   * The change's name is still being looked up (the page held no row of it):
   * the title is drawn as a placeholder rather than the project's name, which
   * the change's own would replace a moment later.
   */
  changePending: false,
  /** The project's name, which the line under the title carries in the whole window. */
  appName: '',
  appTile: '',
  appTileImage: '',
  /** Homeroom's own change: the previewed platform sits on a tinted mat. */
  selfHosted: false,
  /**
   * The vote, as the chat's vote card reads it (GroupChat._voteView): null
   * when the change is not up for a vote, which draws no Vote button.
   */
  vote: null,
  /**
   * The change's before and after viewer (AppView.shotsHtml's `thread`
   * reading, escaped where it is built), or '' when it has no verified shots,
   * which draws no Preview | Before & after switch.
   */
  shotsHtml: '',
  /** Which side of that switch is showing. */
  view: 'preview',
  /**
   * Where the preview stands (./placement.ts): the whole window, a column
   * beside the thread, or the side panel's place. `rect` is the spot it
   * covers when it is not the whole window; `expanded` is the person's
   * Full window, which a column or a panel docks back from; `wide` says it
   * opened full width because its change is for large screens.
   */
  placement: 'full',
  rect: null,
  expanded: false,
  wide: false,
  /** 'app' while it stands in the side panel beside a running app (the app is marked Live). */
  beside: null,
  /** Where the Live mark sits: after the app's name in the shell's header. */
  liveSpot: null,
  /** The first-visit line was put away on this device ("Got it"). */
  noteSeen: false,
}));

/**
 * The live `#staging-iframe` element, registered by the island on mount.
 *
 * A registered ref rather than `document.getElementById`: the bridge must never
 * be able to act on an element React does not currently own, and the identity
 * test in tests/staging-iframe-identity.test.js reads exactly what the island
 * published.
 */
/** @type {{ iframe: HTMLIFrameElement | null }} */
export const stagingRefs = { iframe: null };

/**
 * Click handlers, re-pointed by app-view.js where it used to assign `.onclick`.
 *
 * @type {Record<'onBack' | 'onTest' | 'onTestingClose' | 'onRetry' | 'onClockToggle' | 'onVote' | 'onComment' | 'onSize' | 'onView' | 'onNoteSeen',
 *   ((arg?: any) => void) | null>}
 */
export const stagingHandlers = {
  onBack: null,
  onTest: null,
  onTestingClose: null,
  onRetry: null,
  onClockToggle: null,
  /** Vote / See the vote: the change's Votes card. */
  onVote: null,
  /** Comment: comment mode over the preview. */
  onComment: null,
  /** Full window, and back to the column or the panel. */
  onSize: null,
  /** The Preview | Before & after switch, with the side picked. */
  onView: null,
  /** "Got it" on the first-visit line. */
  onNoteSeen: null,
};

export const visualCompareStore = createStore(/** @type {VisualCompareState} */ ({
  open: false,
  /**
   * `Date.now()` at open, rendered as `data-opened-at` so
   * `AppView.modalDismissGuarded` keeps swallowing the opening tap's ghost
   * click exactly as it does for the hand-written modals (it reads
   * `dataset.openedAt`).
   */
  openedAt: 0,
  label: '',
  /** Built by AppView.openVisualComparison from server-side capture ids. */
  bodyHtml: '',
}));

/**
 * Same holder pattern as the staging overlay's.
 *
 * @type {Record<'onBack' | 'onBackdrop', ((ev?: Event) => void) | null>}
 */
export const visualCompareHandlers = {
  onBack: null,
  /** Called only for a click on the overlay root itself, never a child. */
  onBackdrop: null,
};
