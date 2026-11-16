/**
 * The Improve feature's controller: the seam between the classic scripts and
 * the React islands that draw what Improve offers.
 *
 * ── What replaced what ─────────────────────────────────────────────────
 *
 * The header used to carry an App/Dev segmented switch, a feedback button and
 * a work cog. All three are gone. An app renders as an app, and the second
 * mode — everything you do *to* the app rather than *with* it — became a
 * panel this file presented, which is why it absorbed three retired places:
 *
 *   * `App.ImproveStatus.setAppOpen()`'s show/hide of `#app-mode-switch`
 *     becomes `Improve.setTarget()`, which publishes what Improve is ABOUT
 *     (and therefore whether its controls have a subject at all);
 *   * the drawer's `#drawer-row-github` / `#drawer-row-share` / version rows
 *     become fields on the store;
 *   * `WorkDrawer`'s cross-app session list became the panel's two session
 *     sections, this app's and everything else.
 *
 * ── And then the panel itself went (#2718 review) ──────────────────────
 *
 * Each of those three found a surface of its own, which is what left the
 * panel holding two buttons: the sessions are the Workshop's, the reference
 * rows are the app menu's
 * About pane, and the two actions plus the build notice are rows of that same
 * menu (../app-context/, ./actions.tsx). A drawer you open to press a button
 * is a tap to reach a tap, so it retired and this file stopped owning a
 * presentation: `open`, `close`, `toggle` and `dismissForNav` are names every
 * caller already says, forwarded to the controller that owns the surface.
 *
 * ── And the session list went last (16 Nov 2026) ───────────────────────
 *
 * The cross-app list of the viewer's changes in flight (GET
 * /api/me/active-sessions, re-read while the bell or Messages was open)
 * lost its last surface when Messages stopped listing changes. The changes
 * are listed on the Homeroom bot tab, the Homeroom menu and each project's
 * Workshop, which read them their own way, so this file no longer loads,
 * buckets or polls them. What it keeps of sessions is `working`, the
 * mark's cue, read from the live session store.
 *
 * ── Why the store and not the DOM ──────────────────────────────────────
 *
 * Everything below writes `improveStore` and never a node in anyone's markup.
 * Those subtrees are React-owned, so a `getElementById` write in here would be
 * exactly the two-owners conflict the migration exists to prevent — and with
 * the panel gone there is no root left for this file to adopt either, which is
 * why the kit-surface call its header used to describe is no longer here.
 */

import { improveStore } from './improve-store.js';
import { saveShellSnapshot } from '../../lib/shell-snapshot';

const Improve = {
  /** The live kit adoption on touch, or null on desktop / before presenting. */
  _sheet: null,

  // ── What the panel is about ──────────────────────────────────────
  //
  // Called from App.ImproveStatus.setAppOpen() for an open app, and from
  // Home.publishImproveTarget() for the platform's own self-hosted row while
  // home is on screen (#1367). Passing null clears the target, which hides the
  // header button — every OTHER screen does that.
  //
  // Home's publisher lives in Home.render() rather than on the navigation
  // paths, and that is load-bearing: the reverted first attempt published only
  // when returning from an app, so the button appeared after backing out and
  // vanished on refresh. Both callers land here identically; only the moment
  // they fire differs.
  setTarget(target) {
    if (!target || !target.slug) {
      // Was `if (improveStore.get().open) Improve.close()`, on a flag the
      // retired panel wrote. dismissForNav asks the surface's own owner,
      // which is the only one that knows.
      Improve.dismissForNav();
      improveStore.set({
        target: null,
        slug: null,
        name: '',
        selfHosted: false,
        restricted: false,
        repoUrl: null,
        iconUrl: null,
        iconEmoji: null,
        iconColor: null,
        version: null,
        deploying: false,
        appUpdateReady: false,
        readOnly: false,
        showTerminal: false,
        canShare: false,
        canReport: false,
        // Back to App.currentTab's own initial value, so the next target does
        // not inherit the last one's half.
        tab: 'app',
      });
      // Remembered for the next cold paint, so the button is drawn (or not)
      // at hydration rather than a network round trip later — see
      // lib/shell-snapshot.ts.
      saveShellSnapshot({ improveTarget: '' });
      return;
    }
    const prev = improveStore.get();
    const slugChanged = prev.slug !== target.slug;
    improveStore.set({
      target: target.kind === 'platform' ? 'platform' : 'app',
      slug: target.slug,
      name: target.name || '',
      selfHosted: !!target.selfHosted,
      // Homeroom for a viewer not served its row (../app-context/
      // platform-target.js): the menu hides the rows that would 404.
      restricted: target.kind === 'platform' && !!target.restricted,
      repoUrl: target.repoUrl || null,
      iconUrl: target.iconUrl || null,
      iconEmoji: target.iconEmoji || null,
      iconColor: target.iconColor || null,
      version: target.version || null,
      deploying: !!target.deploying,
      // A build that landed for the PREVIOUS app is not this one's news.
      appUpdateReady: slugChanged ? false : !!prev.appUpdateReady,
      readOnly: !!target.readOnly,
      canShare: !!target.canShare,
      canReport: target.canReport === true,
      // The terminal is only meaningful while an iframe is on screen, and
      // DevConsole owns that fact — a target change alone never turns it on.
      showTerminal: slugChanged ? false : prev.showTerminal,
    });
    saveShellSnapshot({ improveTarget: target.kind === 'platform' ? 'platform' : 'app' });
  },

  /**
   * Publish which half of the app is on screen — the App tab or the Dev area.
   *
   * Called from `App.switchTab()`, the single place `App.currentTab` is
   * assigned. Only meaningful while there IS a target, so a switch with none
   * published is dropped rather than stored against nothing.
   */
  setTab(tab, subTab) {
    const prev = improveStore.get();
    if (!prev.slug) return;
    // #1406's 'other' value survives in the store's type but has no publisher
    // since the Streamlined Concept took platform screens back to a plain
    // title; anything unrecognised still collapses to 'app' exactly as before.
    const next = tab === 'dev' ? 'dev' : (tab === 'other' ? 'other' : 'app');
    const nextSubTab = next === 'dev' ? (subTab || 'forum') : null;
    improveStore.set({
      tab: next,
      // Which dev sub-view is on screen.
      subTab: nextSubTab,
      // And which LAYOUT the Dev screen is in, for the header's back arrow on
      // the sub-views that are reached from it. Captured on every route change
      // rather than subscribed to, because the only reader is a route that has
      // already left the board: by the time a topic publishes, the layout can
      // no longer change under it.
      boardView: Improve._boardView(),
      topicOrigin: Improve._topicOriginFor(prev, next, nextSubTab),
    });
  },

  /**
   * Which layout the Dev screen is in — 'kanban' or 'workshop'.
   *
   * Read through `window.AppView` rather than from the view-mode store in
   * ../dev-board/view-mode-store.ts, and the difference is a COLD DEEP LINK:
   * that store is seeded when the board frame mounts, and a link straight to
   * an issue never mounts one, so it would answer with its own default
   * instead of with this viewer's preference. `_getViewMode()` resolves the
   * `?view=` override and then the stored preference, and needs no board.
   *
   * Settled by the time this runs on a layout hop too: `restoreFromHash`
   * calls `AppView._setViewMode(boardView)` BEFORE `App.navigateToApp`, which
   * is what reaches `App.switchTab` and therefore `setTab` above.
   */
  _boardView() {
    return window.AppView?._getViewMode?.() === 'kanban' ? 'kanban' : 'workshop';
  },

  /**
   * Where a TOPIC's back chip should point, when not its board (#3103).
   *
   * Only a door that names its origin yields one. A card shared into a
   * Messages conversation opens the topic route, and the Improve store's
   * `prev` cannot say it came from Messages — it describes the last APP
   * route. Taken once on the way in; kept while the route stays a topic
   * (navigateToApp re-publishes it once the app's record loads); dropped by
   * every other route.
   */
  _topicOriginFor(prev, next, nextSubTab) {
    if (!(next === 'dev' && nextSubTab === 'topic')) return null;
    const named = Improve._nextTopicOrigin;
    Improve._nextTopicOrigin = null;
    if (named) return named;
    return prev.tab === 'dev' && prev.subTab === 'topic' ? (prev.topicOrigin || null) : null;
  },

  /** The origin the NEXT topic entry should record. See `_topicOriginFor`. */
  _nextTopicOrigin: null,

  /**
   * The captured topic origin, for the router (App._isBotTopic: a topic
   * opened from the Homeroom bot tab's page lights that tab). Read through
   * `window.Improve`: the router is a classic script and cannot import the
   * store.
   */
  topicOrigin() {
    return improveStore.get().topicOrigin;
  },

  /**
   * Called by a shared card in Messages, and by a row of the Homeroom bot
   * tab's page (features/ai/), just before it navigates.
   */
  enterTopicFrom(href) {
    Improve._nextTopicOrigin = typeof href === 'string' && href.startsWith('#') ? href : null;
  },

  /**
   * The captured topic origin ends with the app-view visit it belonged to.
   * App._showOnlyScreen calls this on every reveal of another screen, so a
   * topic later reached some other way (the bell, a link) does not inherit a
   * conversation it was not opened from.
   */
  clearTopicOrigin() {
    if (improveStore.get().topicOrigin) improveStore.set({ topicOrigin: null });
  },

  /**
   * The App/Feed/Kanban toggle's first segment: back to the app itself.
   *
   * The counterpart of openDev below. It does NOT go through _withApp, which
   * always lands on Dev — this is the one destination that is the other tab.
   *
   * ── The self-hosted row goes HOME (#1386) ──────────────────────────
   *
   * The platform's own row has no per-slug iframe URL, so `switchTab('app')`
   * coerces the request to the Dev forum — which is why the segment used not to
   * be rendered for it at all. That reasoning held for the TAB and not for the
   * destination: "the app itself" is not missing for the platform, it merely is
   * not an iframe. The platform's product surface IS the home screen, and home
   * is the very screen `Home.publishImproveTarget()` publishes this target
   * from. So the segment renders there too and lands home, which closes the
   * one-way trip the toggle exists to fix.
   *
   * ── #1406 widened where this can be reached from ──────────────────
   *
   * That used to be true of exactly two states — home, and an open app —
   * because every other screen cleared the target outright and unrendered the
   * control. #1406 republishes the platform's row on settings, profile,
   * messages and the rest, so the segment is now reachable from a screen that
   * is NEITHER home nor an app.
   *
   * So "no app open" no longer means "already home", and the guard is the home
   * screen itself rather than the absence of a slug. Left as it was, this
   * would have silently done nothing from Settings — a segment rendering as
   * inactive, clicked, and no navigation.
   */
  openApp() {
    Improve.close();
    const { slug, selfHosted } = improveStore.get();
    if (!slug || !window.App) return;
    if (selfHosted) {
      // Home is where this goes, from wherever it is clicked. The only state
      // with nothing to do is being on home ALREADY, which is the state the
      // segment renders as active — and `_isScreenVisible` is what answers
      // that now, since an open app is no longer the only other possibility.
      const onHome = typeof window.App._isScreenVisible === 'function'
        ? window.App._isScreenVisible('home-screen')
        : !window.App.currentApp;
      if (!onHome) window.App.navigateHome();
      return;
    }
    if (window.App.currentApp === slug) window.App.switchTab('app');
    else window.App.navigateToApp(slug, 'app');
  },

  /** Patch fields on the CURRENT target — app-view.js calls this as data lands. */
  update(patch) {
    if (!patch || !improveStore.get().slug) return;
    const allowed = {};
    for (const key of ['name', 'repoUrl', 'iconUrl', 'iconEmoji', 'version', 'deploying', 'appUpdateReady', 'readOnly', 'canShare', 'canReport', 'selfHosted']) {
      if (key in patch) allowed[key] = patch[key];
    }
    improveStore.set(allowed);
  },

  /**
   * Whether the developer-terminal row is worth showing.
   *
   * Published by features/dev-console/store.ts's setButtonVisible(), which is
   * the same call that used to show and hide the header's `#dev-console-btn`.
   * The button is gone; the row it became reads the identical signal.
   */
  setTerminalAvailable(available) {
    improveStore.set({ showTerminal: !!available });
  },

  // ── Presentation ─────────────────────────────────────────────────
  //
  // THERE IS NO IMPROVE PANEL ANY MORE (#2718 review). It was a drawer you
  // opened from a row in the mark's menu to reach two buttons, a session list
  // the Workshop took earlier in this issue, and a build notice — one tap to
  // open, one to press. All three are in the menu now (../app-context/), so
  // "open Improve" and "open the menu" name the same act.
  //
  // THESE FOUR ARE NAMES, NOT STATE. Four call sites in public/js/app.js say
  // `window.Improve?.open()`, the tour drives open and close, and every row
  // that navigates dismisses its host through `dismissForNav` — so the names
  // stay and each forwards to the controller that actually owns the surface,
  // its registry entry and its dismissal promise.
  //
  // WHAT WENT WITH THE PANEL IS THE SECOND COPY OF `open`. `toggle` and
  // `dismissForNav` used to read `improveStore.open`, which nothing writes
  // any more: toggle would only ever have opened, and dismissForNav would
  // never have fired. A controller that tracks a surface it no longer
  // presents answers from a field nobody sets, which is worse than not
  // answering — so it asks the owner instead. `LEGACY_CLOSE_MS` and
  // `DISMISS_SAFETY_MS` went the same way: the transition they were timed
  // against was #improve-panel's, and that rule is gone from app.css.

  /** @returns {object|undefined} the app-context controller, where mounted. */
  _surface() {
    return (typeof window !== 'undefined' && window.AppContext) || undefined;
  },

  /**
   * Whether Improve has a subject yet.
   *
   * THE SURFACE NO LONGER ANSWERS THIS. The Improve panel refused to open
   * without a target, so "did it open" was also "is there something to act
   * on" — which is what `?shot=app-update-ready` and the rest waited on. The
   * menu opens on every route (it is the app menu, and Home needs it too), so
   * the two questions came apart and the second one needs asking directly.
   * Without it those shots fired into a surface whose rows had no app, and
   * `update()` — which no-ops without a slug — did nothing at all.
   */
  hasTarget() {
    return !!improveStore.get().slug;
  },

  toggle() {
    Improve._surface()?.toggle();
  },

  open() {
    return Improve._surface()?.open();
  },

  /**
   * Resolves once the surface is actually GONE — the kit teardown on the
   * touch path, the CSS slide's end on the desktop one, immediately when
   * nothing was open.
   *
   * That contract is why this returns a promise at all: "Share app" presents
   * a DIALOG of its own, and a dialog that fades in while its host surface is
   * still sliding out reads as two things moving at once. Every other caller
   * can keep ignoring the return value.
   */
  close() {
    return Improve._surface()?.close() ?? Promise.resolve();
  },

  /**
   * Close before a row navigates.
   *
   * On touch the surface is modal over the destination screen, so a row that
   * navigates has to take it down first. On desktop the dropdown closes too.
   */
  dismissForNav() {
    return Improve._surface()?.dismissForNav() ?? Promise.resolve();
  },

  // ── Sessions ─────────────────────────────────────────────────────

  /**
   * Session state changed underneath us: the mark's `working` cue follows
   * it. Called from app.js's live sweeps and from the island's SessionState
   * subscription (./index.tsx). It reloaded the cross-app session list too,
   * while the bell or Messages showed it; nothing shows that list now
   * (16 Nov 2026), so this is the cue alone.
   */
  onSessionStateChanged() {
    Improve.refreshWorking();
  },

  /**
   * `SessionState.anyActiveFor(<viewer>)`, as store state: one of the
   * viewer's OWN sessions is mid-turn. Not anyActive(), which also counts
   * every shared session on the apps the viewer can see, so the
   * mark lit up for other people's builds (#2779 follow-up). Safe before
   * either exists.
   */
  refreshWorking() {
    const me = window.App?.user?.id;
    const working = me != null && !!window.SessionState?.anyActiveFor?.(me);
    if (improveStore.get().working !== working) improveStore.set({ working });
  },

  // setSessionBadge is GONE (#1610). Notifications._renderBadge used to
  // publish the unread session count here so this button could render it;
  // that count is part of the bell's number now, because the bell's list is
  // the only place a session notification can be marked read. `working`
  // above is the one indicator this button still carries.

  /**
   * Where the PLATFORM's build has got to, from
   * ImproveStatus.refreshDeployDot(), which takes it from
   * App.renderPlatformVersionPill rather than from any rendered markup.
   *
   *   'deploying'   — a new build is rolling out
   *   'downloading' — it rolled out, and this tab is pulling it down
   *   'ready'       — it is cached; a reload lands on it
   *   'failed'      — it could not be pre-downloaded; a reload may need two
   *                   tries, but withholding the offer entirely is worse
   *   'idle'        — this tab is on the current build
   *
   * 'stale' was the single value that used to cover downloading, ready and
   * failed together. It is still accepted, as ready: nothing in the tree
   * publishes it any more, but it was the vocabulary of a global the shell
   * exposes, and mapping it beats a silent fall to 'idle' that would hide a
   * real update from anyone still sending it.
   */
  setVersionState(versionState) {
    const KNOWN = ['deploying', 'downloading', 'ready', 'failed'];
    const next = versionState === 'stale'
      ? 'ready'
      : (KNOWN.includes(versionState) ? versionState : 'idle');
    if (improveStore.get().versionState !== next) improveStore.set({ versionState: next });
  },

  // ── Actions ──────────────────────────────────────────────────────
  //
  // Every row closes the panel first. On touch it is a modal sheet over the
  // destination; on desktop the slide-over covers the right edge of the screen
  // the row is navigating to. Neither is somewhere to leave a surface open.

  /**
   * Put the panel's TARGET on screen, then run `then` against it.
   *
   * Improve can be opened for an app whose `/api/apps/<slug>` payload is not
   * the one `AppView` currently describes (a target published before the
   * app's own fetch settles). So the actions that need `AppView.appData`
   * navigate first and await the same promise the router awaits, rather than
   * firing at an `AppView` that is still describing the previous app (or
   * none).
   */
  async _withApp(then, opts) {
    const { slug } = improveStore.get();
    if (!slug || !window.App) return;
    const subTab = opts?.subTab || 'forum';
    const ref = opts?.ref ?? null;
    if (window.App.currentApp === slug) {
      await window.App.switchTab('dev', ref, subTab);
    } else {
      await window.App.navigateToApp(slug, 'dev', ref, subTab);
    }
    // The viewer can navigate away while the fetch above is in flight; the
    // router guards its own tail on exactly this condition, so this does too.
    if (window.App.currentApp !== slug) return;
    if (then) then();
  },

  /**
   * Open the feedback dialog.
   *
   * Waits for the panel to be GONE first, the way `openTerminal()` and
   * `share()` do (#4730): with the experimental comment shortcut on, the
   * dialog opens comment mode, and comment mode draws the page the moment it
   * opens — a menu still on screen would be in that picture. Desktop
   * resolves after the slide, so the row costs nothing there.
   *
   * `fromDev` opens it asking where the suggestion goes, with neither "This
   * app" nor "Homeroom" chosen (#2707): a person in an app may well mean the
   * platform, so the press does not answer that question (#4236). A button
   * that already names the app may pass `target: 'app'` instead (Home's
   * Getting started card's Suggest did, until #4635 retired the card) — and
   * the header's Suggest on a running app does now too (#3702): the control
   * sits on the app, so "This app" is already the answer and asking again
   * would be a second tap.
   */
  giveFeedback(opts = {}) {
    const { slug } = improveStore.get();
    return Promise.resolve(Improve.close()).then(() => {
      if (!window.App?.openFeedbackModal) return;
      if (window.App.currentApp === slug) {
        if (opts.target === 'app') {
          window.App.openFeedbackModal({ target: 'app' });
          return;
        }
        window.App.openFeedbackModal({ fromDev: true });
        return;
      }
      // Otherwise there is no open app for "This app" to mean, so the dialog
      // opens on its Platform default.
      window.App.openFeedbackModal();
    });
  },

  /**
   * New change: the entry point for starting new work on desktop and touch.
   * Improve's "New change" and the Workshop's "Start here" both come through
   * here.
   *
   * New work starts on the Homeroom bot tab's new-thread screen, on the
   * project Improve is pointed at. That screen offers Homeroom bot, Claude
   * Code or ChatGPT as the builder. Nothing is created by the click.
   */
  startSession() {
    Improve.close();
    const { slug } = improveStore.get();
    window.location.hash = slug
      ? `#homeroom-bot/new?project=${encodeURIComponent(slug)}`
      : '#homeroom-bot/new';
  },

  /**
   * Open the Dev screen on one of its two tabs.
   *
   * `mode` is a dev view mode ('feed' | 'kanban'), which is what the two
   * board tabs are. Setting it before the repaint means the board paints the
   * requested tab on its first frame rather than flashing the stored one.
   */
  openDev(mode) {
    Improve.close();
    Improve._withApp(() => {
      if (mode && window.AppView?.openDevView) window.AppView.openDevView(mode);
    });
  },

  /** The retired `#dev-console-btn`, as a row. */
  // Waits for the panel to be GONE before presenting, for the same reason
  // `share()` below does: on touch the console rides in a kit bottom sheet of
  // its own, and presenting it across this panel's exit spring puts two kit
  // surfaces on screen at once — the second one adopting its node while the
  // first is still tearing its own down. Desktop resolves immediately after
  // the slide, so the row costs nothing there. (#1967)
  openTerminal() {
    Promise.resolve(Improve.close()).then(() => {
      window.DevConsole?.show?.();
    });
  },

  /**
   * Load the build that just landed. The panel's reload row and the button's
   * arrow glyph both mean this. The offer is withdrawn as it is taken up, so
   * a reload that is slow to show the new build does not re-offer itself
   * midway: a second tap is a second reload, not a repeat of the first.
   *
   * The frame, not the tab: what is stale is the app's document, and
   * AppView.reloadAppFrame knows the two loads it takes to get past an app's
   * own shell cache.
   */
  reloadApp() {
    improveStore.set({ appUpdateReady: false });
    Promise.resolve(Improve.close())
      .then(() => Improve._showAppTab())
      .then(() => { window.AppView?.reloadAppFrame?.(); });
  },

  /**
   * Put the app itself on screen, if it is not already.
   *
   * The offer is made from every screen the panel opens over, the Dev ones
   * included — the Workshop, the board, a topic. On those the app's frame is
   * behind another surface or not mounted at all, so a reload there reloads
   * nothing the viewer can see: the panel closed, the offer was withdrawn,
   * and as far as the screen was concerned the click did nothing. Taking the
   * offer means "show me the new version", so go to the app first.
   *
   * Answers switchTab's promise so the reload waits for the destination to
   * render — renderAppTab mounts the frame and sets its src synchronously,
   * so by then reloadAppFrame has a frame to work on. A render that mounted
   * the frame fresh has already started one load and the reload adds its
   * usual two; a third load of a document the app's own cache is serving is
   * cheap, and cutting it would mean this function knowing which branch
   * renderAppTab took.
   *
   * On the app tab already: nothing, rather than a re-render.
   */
  _showAppTab() {
    const app = window.App;
    if (!app || app.currentTab === 'app' || typeof app.switchTab !== 'function') return null;
    return app.switchTab('app');
  },

  /** The retired `#drawer-row-share`, as a row. */
  // Share — a dialog of its own, so it waits for the panel to be GONE rather
  // than fading in across its exit (#977, carried over from the hamburger row
  // this replaced).
  share() {
    Promise.resolve(Improve.close()).then(() => {
      window.AppView?.openShareModal?.();
    });
  },
};

if (typeof window !== 'undefined') {
  window.Improve = Improve;
}

export { Improve };
