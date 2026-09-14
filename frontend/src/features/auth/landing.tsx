/**
 * `#auth-landing-screen` — the anonymous shell's entry point (#1080, step 2
 * chunk C, screen 1 of 6).
 *
 * Converted first because it carries `#landing-header`, the second authored
 * top bar in the codebase: `tests/header-height-parity.test.js` pins it to the
 * same HEADER HEIGHT INVARIANT as `#platform-header` (52px + safe area at
 * every width). The markup below is therefore
 * a like-for-like transcription — same ids, same class strings in the same
 * order, same `hidden` semantics, same `data-*` attributes.
 *
 * ── What is React-owned and what is not ────────────────────────────────
 *
 * The header, the pitch, and the app grid are ordinary state: React renders
 * the back button's `hidden`, the title text, the CTA-vs-queued swap and the
 * tiles.
 *
 * Three elements deliberately keep a CONSTANT `className` and are toggled
 * through `classList` instead:
 *
 *   * `#auth-landing-screen` — the router swaps screens inside the kit's view
 *     transition, which needs the class write to land synchronously with the
 *     publish (see `useVisibilityHiddenClass`);
 *   * `#auth-landing-scroll` — the kit's pull-to-refresh attaches to it and
 *     translates it, and the open/close zoom hides it inside the transition
 *     callback for the same reason;
 *   * `#app-viewer` and its `<iframe>` — `AppView.mountViewerCover()` appends
 *     `#app-viewer-cover` INTO the viewer and the teardown REPLACES the frame
 *     element (#1028), both of which are writes into this subtree from
 *     `public/js/**`. It is rendered once, by a memo with no props, and React
 *     never reconciles it again; the handlers below re-resolve it by id, which
 *     is what the legacy module did for exactly the same reason.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';


import { ChevronLeftIcon, LockIcon } from '@/components/ui/icons';

import { useMountedOnReveal } from '../../lib/mount-on-reveal';
import { useVisibilityHiddenClass } from '../../lib/visibility-store';
import {
  AUTH_SCREEN_IDS,
  byId,
  fx,
  hasSession,
  hiddenLast,
  legacy,
  type PublicApp,
  useAuthScreensPatch,
  zoomFx,
} from './shared';
import { TileSkeleton } from '../apps/tile-skeleton';
import { waitlistOptions } from './waitlist-shared';

const LANDING_TITLE = 'Homeroom';

/** Directory-load outcome. `loading` is what the prerendered markup ships. */
type AppsState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'list'; apps: PublicApp[] };

/**
 * The landing tile for `slug`, or null. Scoped to `#landing-apps`: the authed
 * home grid renders `.app-card[data-slug]` too, and both live in this one
 * document after a reload-free login.
 */
function landingTileFor(slug: string | undefined): HTMLElement | null {
  try {
    return document.querySelector<HTMLElement>(
      `#landing-apps .app-card[data-slug="${CSS.escape(String(slug || ''))}"]`,
    );
  } catch {
    return null;
  }
}

/**
 * #1028: teardown REPLACES the `<iframe>` element instead of pointing the live
 * one at about:blank. Assigning `src` to a frame that already holds a real
 * document is a genuine navigation, so it pushed an entry onto the history
 * stack this shell shares with the app — which is what desynced the viewer's
 * own marker entry and left `history.back()` rewinding the iframe instead of
 * closing the viewer (the reported "empty page"). A fresh, never-navigated
 * frame makes every open the INITIAL about:blank navigation, which browsers
 * elide. It also kills the app's JS context outright, which is a stricter stop
 * than blanking.
 *
 * Callers must re-resolve the frame by id afterwards — any reference captured
 * before the swap is stale.
 */
function swapViewerFrame(): HTMLIFrameElement | null {
  const old = byId<HTMLIFrameElement>('app-viewer-frame');
  if (!old || !old.parentNode) return null;
  const fresh = document.createElement('iframe');
  fresh.id = old.id;
  fresh.className = old.className;
  for (const attr of ['title', 'allow', 'sandbox', 'referrerpolicy', 'allowfullscreen']) {
    const value = old.getAttribute(attr);
    if (value !== null) fresh.setAttribute(attr, value);
  }
  old.parentNode.replaceChild(fresh, old);
  // The new contentWindow has never received the shell's safe-area insets, and
  // the broadcast memo suppresses a repeat post of unchanged values — drop the
  // memo so the next one reaches it.
  const appView = legacy().AppView;
  if (appView && typeof appView.forgetSafeAreaFrame === 'function') {
    appView.forgetSafeAreaFrame('app-viewer-frame');
    appView.scheduleSafeAreaBroadcast?.();
  }
  return fresh;
}

/**
 * In-page app viewer: public apps open in an iframe here instead of a
 * `target=_blank` (which strands mobile webview users on the app subdomain
 * with no way back). It is an IN-FLOW sibling of the scroller — not a fixed
 * overlay — so the header above stays put and owns Back + the app name.
 * Opening zooms it out of the tapped tile (kit 'zoom-in', mirroring
 * App.navigateToApp); the background must stay opaque because the kit pins
 * this LIVE element as a fixed overlay for the duration of the zoom.
 *
 * `memo` with no props: this subtree renders once and React never touches it
 * again. See the file header.
 */
const ViewerRegion = memo(function ViewerRegion() {
  return (
    <div id="app-viewer" className="hidden flex-1 min-h-0 flex flex-col bg-white dark:bg-zinc-950">
      <iframe
        id="app-viewer-frame"
        className="flex-1 w-full border-0"
        title="App"
        allow="geolocation"
      ></iframe>
    </div>
  );
});

/**
 * One launcher tile, mirroring the authed homescreen's renderAppCard shape
 * (home.js): centered 14x14 icon tile (image > emoji > first letter), then the
 * name row.
 *
 * Gated apps (requires_login — anything the shell probe didn't positively
 * classify as public) render dimmed with a lock badge and an "Account
 * required" caption; tapping one remembers the app deep link and routes to
 * #signup, so the account flow lands the user in the app they wanted.
 */
export function LandingTile({ app, onOpen }: { app: PublicApp; onOpen: (app: PublicApp) => void }) {
  // Only an explicit public verdict unlocks a tile. Missing/stale client
  // metadata must not turn an unknown app into an anonymous launch (#1522).
  const gated = app.requires_login !== false;
  const label = app.name || app.slug;
  return (
    <div
      className={
        'app-card relative rounded-xl transition-colors p-3 flex flex-col items-center text-center gap-1.5 cursor-pointer' +
        // `grayscale` alone, where this was `opacity-50 grayscale`. Opacity
        // composites toward whatever is behind, so it fades on the light page
        // and muddies on the dark one; draining the colour reads the same on
        // both. Same correction as the authed launcher's unlaunchable tiles.
        (gated ? ' grayscale-[0.75]' : '')
      }
      data-slug={app.slug || ''}
      data-gated={gated ? 'true' : 'false'}
      onClick={() => onOpen(app)}
    >
      <div className="relative w-14 h-14 shrink-0">
        {app.icon_url ? (
          <div
            className="app-icon-tile w-14 h-14 rounded-2xl overflow-hidden flex items-center justify-center font-bold text-xl"
            data-icon="image"
          >
            <img
              src={app.icon_url}
              alt=""
              loading="lazy"
              draggable={false}
              className="w-full h-full rounded-xl object-cover"
            />
          </div>
        ) : app.icon_emoji ? (
          <div
            className="app-icon-tile w-14 h-14 rounded-2xl overflow-hidden flex items-center justify-center font-bold text-xl"
            data-icon="emoji"
          >
            <span className="text-3xl leading-none" aria-hidden="true">
              {app.icon_emoji}
            </span>
          </div>
        ) : (
          <div
            className="app-icon-tile w-14 h-14 rounded-2xl overflow-hidden flex items-center justify-center font-bold text-xl"
            data-icon="letter"
          >
            {(app.name || '?').charAt(0).toUpperCase()}
          </div>
        )}
        {gated ? (
          <span
            className="absolute -top-1.5 -right-1.5 w-6 h-6 flex items-center justify-center rounded-full bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-600 shadow-sm text-zinc-500 dark:text-zinc-300"
            title="Account required"
          >
            <LockIcon className="w-3.5 h-3.5" aria-hidden="true" />
          </span>
        ) : null}
      </div>
      {/*
          Name row. This is deliberately the SAME launcher tile the authed home
          screen renders, so it lost the active-users badge with it — an icon
          and a label, nothing else. The count still shows in the Browse-all
          directory, which is a ranked list where it is the point. The label is
          .app-card-title (app.css) — iOS-sized 11px/13px type clamped to two
          lines in a fixed-height lane, same as the authed grid (#951), so both
          launchers show the same amount of a name.
      */}
      <div className="w-full min-w-0">
        <div className="app-card-title" title={label || ''}>
          {label}
        </div>
        {gated ? (
          <p className="app-card-status text-zinc-500 dark:text-zinc-500">Account required</p>
        ) : null}
      </div>
    </div>
  );
}

// The landing bar's back disc: the same periwinkle disc as the signed-in
// bar's back button (BACK_BTN_CLASS in header/platform-header.tsx). The
// landing sits on the same wallpaper now, so its one glyph control is drawn
// the same way.
const LANDING_BACK_CLASS = 'inline-flex items-center justify-center w-7 h-7 rounded-full'
  + ' border border-[color:var(--brand-line)] bg-[color:var(--brand-tint)]'
  + ' text-[color:var(--brand-ink)]';

export function LandingScreen() {
  const rootRef = useRef<HTMLElement>(null);
  useVisibilityHiddenClass(rootRef, AUTH_SCREEN_IDS.landing, false);
  // The screen's interior mounts on its first reveal, not in the prerender —
  // see lib/mount-on-reveal.ts. AuthScreens.show() asks for it (through
  // window.UsernodeReact.mount) before it wires or reveals the screen, so the
  // hooks this component patches onto AuthScreens are installed and the
  // interior's nodes exist by the time the on-show hook runs.
  const mounted = useMountedOnReveal(AUTH_SCREEN_IDS.landing);

  // Both start at the value the prerendered markup shipped with: no session,
  // no app open. `_renderLandingHeader`'s equivalent (refreshHeader) runs on
  // show, i.e. after hydration.
  const [session, setSession] = useState(false);
  const [openApp, setOpenApp] = useState<{ slug: string; name: string } | null>(null);
  const [apps, setApps] = useState<AppsState>({ kind: 'loading' });

  // Non-render state, mirroring the legacy module's fields one for one.
  const st = useRef({
    appsLoaded: false,
    appsReady: null as Promise<void> | null,
    appsList: [] as PublicApp[],
    openSlug: null as string | null,
    // #931: launch-cover state for the in-page viewer. The generation counter
    // makes a superseded open's `load`/timers inert (same contract as
    // AppView._launchId); the timer array is the one the shared ladder pushes
    // its rungs into.
    launchId: 0,
    timers: [] as number[],
    unwindingViewerEntry: false,
    anonBackShotRan: false,
  }).current;

  /**
   * Single writer for the persistent landing header + the CTA block's
   * link-vs-queued line. Three states:
   *   anonymous, directory  → no back button, platform title, both CTAs
   *   anonymous, app open   → back button, app name, both CTAs (a visitor can
   *                           sign up without backing out)
   *   waiting-room session  → "Your queue status" instead of the CTAs, and the
   *                           CTA block says they're on the list
   */
  const refreshHeader = useCallback(() => {
    setSession(hasSession());
  }, []);

  const clearViewerCover = useCallback(() => {
    st.timers.forEach((t) => clearTimeout(t));
    // In place — the ladder captured this array (see AppView).
    st.timers.length = 0;
    const frame = byId<HTMLIFrameElement>('app-viewer-frame');
    if (frame) {
      frame.onload = null;
      frame.onerror = null;
      frame.style.opacity = '';
    }
    byId('app-viewer-cover')?.remove();
  }, [st]);

  /**
   * Instant, un-animated teardown of the in-page viewer. Used on the paths
   * that LEAVE the landing screen (Sign in, hash routing, the authed boot):
   * animating a zoom-out into a tile on a screen that's being replaced in the
   * same frame just fights the screen transition, and the live iframe must
   * stop either way — `#app-viewer` sits inside the z-40 landing overlay now,
   * so a later screen doesn't cover it.
   */
  const resetViewer = useCallback(() => {
    const viewer = byId('app-viewer');
    if (!viewer || viewer.classList.contains('hidden')) return;
    st.openSlug = null;
    setOpenApp(null);
    // #931: retire the launch generation and drop the cover with it.
    st.launchId = (st.launchId || 0) + 1;
    clearViewerCover();
    viewer.classList.add('hidden');
    swapViewerFrame();
    byId('auth-landing-scroll')?.classList.remove('hidden');
    refreshHeader();
  }, [clearViewerCover, refreshHeader, st]);

  const openLandingApp = useCallback(
    (app: PublicApp) => {
      // Guard the actual viewer entry, not only tile clicks: the legacy
      // bridge calls this opener too. Never mount a gated app's frame.
      if (app.requires_login !== false) {
        (legacy().AuthScreens?.rememberDeepLink as undefined | ((h: string) => void))?.(
          '/app/' + encodeURIComponent(app.slug || ''),
        );
        location.hash = '#signup';
        return;
      }
      if (!app.url) return;
      const viewer = byId('app-viewer');
      const scroller = byId('auth-landing-scroll');
      if (!viewer || !scroller) return;
      const slug = app.slug || '';
      st.openSlug = slug;
      setOpenApp({ slug, name: app.name || slug });
      // #931: the anonymous viewer had the same white-window problem as the
      // signed-in App tab — the frame started loading here, but the zoom
      // animated a blank iframe and the app popped in afterwards. It needs no
      // token (public apps only), so the src assignment was already immediate;
      // what was missing is something to look at while it loads. Mount the same
      // cover over the frame and cross-fade it out on load, using the shared
      // ladder in AppView.
      st.launchId = (st.launchId || 0) + 1;
      const launchId = st.launchId;
      clearViewerCover();
      const frame = byId<HTMLIFrameElement>('app-viewer-frame');
      const appView = legacy().AppView;
      if (appView && typeof appView.mountViewerCover === 'function') {
        appView.mountViewerCover(viewer, frame, app, {
          timers: st.timers,
          isCurrent: () => launchId === st.launchId,
        });
      }
      // The frame is fresh on every open (teardown swaps the element), so this
      // is its INITIAL navigation away from about:blank — the one browsers
      // elide instead of pushing onto the shared history stack.
      if (frame && app.url) frame.src = app.url;
      history.pushState({ svAnonAppViewer: true }, '', location.href);
      // The flex-sibling pitfall (#764): #app-viewer and #auth-landing-scroll
      // are flex:1 siblings, so while BOTH are visible (fn reveals the viewer,
      // the scroller stays beneath the zoom) they split the height 50/50 and
      // the kit would measure the viewer's destination as the bottom half.
      // `outEl` lets the kit hide the scroller for its synchronous pre-paint
      // measurement, so the zoom targets the true settled rect.
      zoomFx(
        () => {
          viewer.classList.remove('hidden');
        },
        {
          type: 'zoom-in',
          el: viewer,
          fromEl: () => landingTileFor(slug),
          outEl: scroller,
          fallback: 'push',
          after: () => scroller.classList.add('hidden'),
        },
      );
      refreshHeader();
    },
    [clearViewerCover, refreshHeader, st],
  );

  const closeLandingApp = useCallback(() => {
    const viewer = byId('app-viewer');
    const scroller = byId('auth-landing-scroll');
    if (!viewer || !scroller || viewer.classList.contains('hidden')) return;
    const slug = st.openSlug;
    st.openSlug = null;
    setOpenApp(null);
    // #931: retire the launch generation and drop the cover before the
    // zoom-out, so a `load` still in flight can't fade a cover back in over
    // the shrinking overlay.
    st.launchId = (st.launchId || 0) + 1;
    clearViewerCover();
    // fallback 'none': a View Transition snapshot of a LIVE app iframe can
    // flash on iOS Safari, so the non-kit path cuts instantly — same choice
    // App.navigateHome makes leaving the App tab. `after` runs exactly once on
    // every path, so the shrinking overlay keeps showing the app's content
    // until it lands.
    zoomFx(
      () => {
        scroller.classList.remove('hidden');
      },
      {
        type: 'zoom-out',
        el: viewer,
        fromEl: () => (slug ? landingTileFor(slug) : null),
        fallback: 'none',
        after: () => {
          viewer.classList.add('hidden');
          swapViewerFrame();
        },
      },
    );
    refreshHeader();
    // #1028: the UI above has already closed — nothing here waits on the
    // browser. Unwind our own marker entry AFTERWARDS so the stack doesn't grow
    // one entry per open, and only when the current entry really is the
    // marker. The re-entrancy flag swallows exactly the popstate this
    // triggers; the timer is a backstop for the case where that popstate never
    // arrives (a foreign entry), so a later genuine back gesture can't be
    // swallowed instead.
    if (!st.unwindingViewerEntry && history.state && history.state.svAnonAppViewer) {
      st.unwindingViewerEntry = true;
      setTimeout(() => {
        st.unwindingViewerEntry = false;
      }, 600);
      try {
        history.back();
      } catch {
        st.unwindingViewerEntry = false;
      }
    }
  }, [clearViewerCover, refreshHeader, st]);

  const loadLandingApps = useCallback(async () => {
    try {
      const res = await fetch('/api/public/apps?include_wallets=0');
      if (!res.ok) throw new Error('http ' + res.status);
      const data = await res.json();
      const list: PublicApp[] = (data && data.apps) || [];
      // Kept for `?shot=anon-back`, which needs the first app the directory
      // would actually open (not gated, has a URL) without re-deriving it from
      // the rendered tiles.
      st.appsList = list;
      setApps({ kind: 'list', apps: list });
    } catch {
      st.appsList = [];
      setApps({ kind: 'error' });
    }
  }, [st]);

  /**
   * The whole `?shot=anon-back` script's time budget, held well under the
   * check runner's 25s per-check timeout so the run always ends in a verdict
   * rather than in an abandonment. 18s leaves seven for the page load and the
   * runner's own polling either side of it.
   */
  const ANON_BACK_BUDGET_MS = 18000;

  /**
   * Screenshot-state deep link `?shot=anon-back` (#1028): scripts the guest
   * back path end to end — open an app, back out, open again, back out —
   * because the regression it pins only appears from the SECOND open onward,
   * and neither the capture nor the proposal check can click anything.
   * `#app-viewer` is stamped `data-anon-back="done"` at the end so the
   * dapp.json assertion can't pass vacuously on a directory that never loaded
   * (an empty list leaves the attribute unset).
   *
   * Steps wait on the actual DOM state rather than a fixed delay. Budgets are
   * CAPS, not sleeps: the happy path finishes as fast as the transitions do.
   * They are generous because the close leg rides history.back() → popstate →
   * the 600ms unwind guard and takes ~2s even on an idle page — the old 900ms
   * cap expired mid-close every time, cycle two ran against a still-open
   * viewer, and the stamp never landed (the check runner polls the assertion
   * since #1148, so a few seconds of page-side patience is free).
   */
  const runAnonBackShot = useCallback(async () => {
    const viewer = byId('app-viewer');
    if (!viewer) return;
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    // ONE OVERALL DEADLINE, because the per-step caps MULTIPLY and nobody had
    // added them up. Two cycles of 5000 + 5000 + 8000 plus the 2000 the tile
    // gets before the loop is 38.4 SECONDS of worst case, against a check
    // runner that abandons a check at 25 (TEST_TIMEOUT_MS, capture/capture.js).
    // So on any preview slow enough to spend those budgets — which is what a
    // pool of eight hammering one container produces — this check could not
    // report at all, and it failed as "did not finish within 25s" rather than
    // as anything anyone could act on.
    //
    // The caps below stay as they are: each one is a real statement about how
    // long its own step may honestly take, and the close leg genuinely needs
    // seconds (history.back() → popstate → the 600ms unwind guard). What is
    // added is a ceiling on their SUM, so the script always returns in time to
    // be judged. Spending it means the page really was too slow, and the
    // assertion then fails on the missing marker — a fact — instead of on a
    // timeout, which says nothing about the guest back path at all.
    const deadline = Date.now() + ANON_BACK_BUDGET_MS;
    const until = async (pred: () => boolean, budgetMs: number) => {
      const stop = Math.min(Date.now() + budgetMs, deadline);
      while (!pred() && Date.now() < stop) await wait(30);
      return pred();
    };
    const isOpen = () => !viewer.classList.contains('hidden');
    /**
     * Stamp WHY the script gave up (#1755).
     *
     * Every bail below used to be a bare `return`, which left
     * `data-anon-back` unset. The assertion can then never become true, so
     * the runner polls it to its 25s per-check cap and reports `Check did not
     * finish within 25s` — the same sentence whichever step failed, about a
     * page that may be perfectly healthy. That verdict is unactionable, and
     * "re-run it" was the only tool anyone had.
     *
     * Stamping a non-`done` value changes nothing about what passes: the
     * assertion requires `data-anon-back="done"` and still gets it only from
     * the happy path. What it buys is a verdict that arrives IMMEDIATELY, on
     * a settled DOM, naming the step.
     *
     * The `-slow` suffix separates the two questions that matter and used to
     * be indistinguishable: a step that genuinely failed, versus one that ran
     * out of the overall budget because the container was overloaded. The
     * first is a bug in the guest back path; the second is capacity.
     */
    const bail = (reason: string) => {
      viewer.setAttribute('data-anon-back', Date.now() >= deadline ? `${reason}-slow` : reason);
    };
    try {
      await st.appsReady;
    } catch {
      /* ignore */
    }
    // First app the directory would actually open: not gated, has a URL.
    const target = st.appsList.find((a) => a && a.requires_login === false && a.url);
    if (!target) { bail('no-target'); return; }
    // `st.appsReady` settles when the FETCH does; the tiles appear when React
    // commits the state it set, which is a tick or more later. So wait for
    // the element, like every other step here waits on DOM state — reading
    // "not committed yet" as "no directory" and returning is how this shot
    // finished without ever stamping the marker below.
    if (!(await until(() => !!landingTileFor(target.slug), 2000))) { bail('no-tile'); return; }
    for (let cycle = 0; cycle < 2; cycle++) {
      const c = `c${cycle + 1}`;
      // POLL for the tile: `appsReady` resolves when the FETCH lands, but the
      // tiles appear one React commit later, so a synchronous lookup here found
      // nothing and bailed — the reason this shot had never once stamped.
      if (!(await until(() => !!landingTileFor(target.slug), 5000))) { bail(`no-tile-${c}`); return; }
      landingTileFor(target.slug)?.click();
      if (!(await until(isOpen, 5000))) { bail(`open-timeout-${c}`); return; }
      // Let the zoom-in settle before backing out, so each cycle exercises a
      // fully-open viewer rather than a mid-transition one.
      await wait(140);
      byId('landing-back-btn')?.click();
      // The stamp below is the assertion's subject: a close that never lands
      // means the guest back path is genuinely broken, so bail WITHOUT
      // stamping rather than start cycle two against an open viewer.
      if (!(await until(() => !isOpen(), 8000))) { bail(`close-timeout-${c}`); return; }
      // Let the marker entry's history.back() popstate drain before the next
      // cycle pushes a fresh entry — a human cannot re-open in under 80ms.
      await wait(80);
    }
    viewer.setAttribute('data-anon-back', 'done');
  }, [st]);

  const landingOnShow = useCallback(() => {
    refreshHeader();
    if (!st.appsLoaded) {
      st.appsLoaded = true;
      st.appsReady = loadLandingApps();
    }
    // Warm the survey options (memoised) while the visitor is reading the
    // pitch, so the #waitlist chips and country list are already filled by the
    // time they tap through.
    void waitlistOptions();
    // Screenshot-state deep link `?shot=anon-back` (#1028) — see above.
    let shot: string | null = null;
    try {
      shot = new URLSearchParams(location.search).get('shot');
    } catch {
      /* ignore */
    }
    if (shot === 'anon-back' && !st.anonBackShotRan) {
      st.anonBackShotRan = true;
      void runAnonBackShot();
    }
  }, [loadLandingApps, refreshHeader, runAnonBackShot, st]);

  // ── The seam back into public/js/** ────────────────────────────────
  //
  // `AuthScreens.show()` / `hideAll()` look these up by name at call time, so
  // patching them here replaces the legacy landing half wholesale. Forwarders
  // keep the installed identity stable while reading the current closures.
  const live = useRef({ landingOnShow, resetViewer, openLandingApp, closeLandingApp, refreshHeader, loadLandingApps });
  live.current = { landingOnShow, resetViewer, openLandingApp, closeLandingApp, refreshHeader, loadLandingApps };
  useAuthScreensPatch({
    _wireLanding: () => {},
    _landingOnShow: () => live.current.landingOnShow(),
    _resetLandingViewer: () => live.current.resetViewer(),
    _openLandingApp: (app: PublicApp) => live.current.openLandingApp(app),
    _closeLandingApp: () => live.current.closeLandingApp(),
    _renderLandingHeader: () => live.current.refreshHeader(),
    _loadLandingApps: () => live.current.loadLandingApps(),
    _landingTileFor: (slug: string) => landingTileFor(slug),
    _swapViewerFrame: () => swapViewerFrame(),
  });

  /**
   * Kit pull-to-refresh on the landing scroller, same element-mode wiring as
   * the authed screens (app.js _wirePullToRefresh). The kit no-ops this on
   * desktop; the refresh re-pulls the app directory (probe results, active-user
   * counts, new deploys) — and, via App._refreshOrReload, hard-reloads when the
   * platform itself redeployed since this document loaded (the anonymous shell
   * has no drawer, hence no stale-version pill, so this pull is its only
   * recovery path to new client code).
   *
   * Attached to the INNER scroller, never the fixed overlay: the rubber-band
   * translate on the overlay itself would expose the authed shell's header
   * behind it during the pull.
   */
  useEffect(() => {
    const ui = legacy().PlatformUI;
    if (!ui) return;
    // The scroller is part of the interior, so there is nothing to attach to
    // until the screen has mounted; keyed on that, this runs once it has.
    if (!mounted) return;
    const handle = ui.pullToRefresh(byId('auth-landing-scroll'), () =>
      legacy().App?._refreshOrReload?.(() => live.current.loadLandingApps()),
    );
    return () => {
      try {
        handle?.detach();
      } catch {
        /* ignore */
      }
    };
  }, [mounted]);

  /**
   * The browser/OS back gesture still closes the viewer. Ignore a popstate
   * that LANDS on the marker entry — that is a pop INTO the open viewer, not
   * out of it — and the one our own unwind provokes.
   */
  useEffect(() => {
    const onPop = () => {
      if (st.unwindingViewerEntry) {
        st.unwindingViewerEntry = false;
        return;
      }
      if (history.state && history.state.svAnonAppViewer) return;
      live.current.closeLandingApp();
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [st]);

  // Mirror the header title into the tab title so the Flutter WebView's AppBar
  // follows the screen, same as App.setHeaderTitle does authed.
  const headerTitle = openApp ? openApp.name || openApp.slug : LANDING_TITLE;
  useEffect(() => {
    try {
      document.title = headerTitle;
    } catch {
      /* ignore */
    }
  }, [headerTitle]);

  /**
   * Gated tiles remember the app deep link and route to #signup; public ones
   * open in the viewer.
   */
  const onTileClick = useCallback(
    (app: PublicApp) => {
      live.current.openLandingApp(app);
    },
    [],
  );

  /**
   * "Join waitlist" and "Sign in" are both plain anchors to another route, so
   * they leave the landing screen entirely; close the viewer first so the next
   * screen never paints over a still-running iframe (the viewer lives INSIDE
   * this z-40 overlay now, not above it). show() also resets it on the route
   * change — this keeps the teardown ahead of the transition, same as it has
   * always been for Sign in.
   */
  const onLeaveCta = useCallback(() => {
    live.current.resetViewer();
  }, []);

  return (
    <main
      ref={rootRef}
      id="auth-landing-screen"
      className="hidden fixed inset-0 z-40 bg-white dark:bg-zinc-950 flex flex-col"
    >
      {mounted ? (
        <>
      {/*
          Mirrors #platform-header's shape (height, padding, safe-area) so
          both shells read identically — same HEADER HEIGHT
          INVARIANT: `py-3` around a 28px content row, i.e.
          52px + safe-area, with `h-7` on the back-button wrapper as the
          floor and nothing inside allowed to exceed 28px. The CTAs below
          used to break that twice over — `sm:py-2 sm:text-sm` made them
          36px at `sm` and up (a 61px bar), and the bordered one was still
          30px at `py-1.5` — so they now declare `h-7` outright. The
          20px back-button wrapper is fixed-WIDTH on purpose too: toggling
          the button's `hidden` must not shift the title.
      */}
      <header
        id="landing-header"
        className="un-safe-top-extend relative flex items-center gap-3 px-4 pt-3 pb-5 shrink-0"
      >
        <div className="w-7 h-7 shrink-0 flex items-center justify-center">
          <button
            id="landing-back-btn"
            type="button"
            className={hiddenLast(!openApp, LANDING_BACK_CLASS)}
            aria-label="Back to apps"
            onClick={() => live.current.closeLandingApp()}
          >
            <ChevronLeftIcon className="w-5 h-5" />
          </button>
        </div>
        <h1
          id="landing-header-title"
          className="flex-1 min-w-0 text-lg font-bold pointer-events-none truncate text-left"
        >
          {headerTitle}
        </h1>
        <div className="ml-auto shrink-0 flex items-center">
          {/*
              Two entry points only (issue: landing simplification). Account
              creation is deferred: it happens at the end of the waitlist
              journey, or when a gated app below routes to #signup.
          */}
          {/*
              `h-7 inline-flex items-center` — pinned to the header's 28px
              content row, exactly like #app-mode-switch, rather than sized by
              padding. Padding-sizing is what broke this bar twice over: the
              `sm:py-2 sm:text-sm` bump these used to carry made them 36px (a
              61px bar on desktop), and even at `py-1.5` the BORDERED "Join
              waitlist" was 30px against its borderless siblings' 28px,
              because the 1px border top and bottom is part of the box. An
              explicit height is immune to both. `sm:px-5` still gives them
              desktop presence horizontally, which costs no height.
          */}
          <div id="landing-header-ctas" className={hiddenLast(session, 'flex items-center gap-2')}>
            <a
              href="#login"
              id="landing-signin-cta"
              className="h-7 inline-flex items-center rounded-lg bg-violet-600 hover:bg-violet-500 px-3 text-xs sm:px-5 font-medium transition-colors text-white"
              onClick={onLeaveCta}
            >
              Sign in
            </a>
            <a
              href="#waitlist"
              id="landing-waitlist-cta"
              data-offline-disabled=""
              className="h-7 inline-flex items-center rounded-lg border border-[color:var(--brand-line)] bg-[color:var(--brand-tint)] px-3 text-xs sm:px-5 font-medium text-[color:var(--brand-ink)] transition-colors"
              onClick={onLeaveCta}
            >
              Join waitlist
            </a>
          </div>
          {/* Shown instead of the CTAs when a (waiting-room) session exists. */}
          <div id="landing-back-to-waiting" className={session ? '' : 'hidden'}>
            <a
              href="#waiting"
              className="h-7 inline-flex items-center rounded-lg bg-violet-600 hover:bg-violet-500 px-3 text-xs sm:px-5 font-medium transition-colors text-white"
            >
              Your queue status
            </a>
          </div>
        </div>
      </header>
      {/*
          Inner scroller: the kit pull-to-refresh rubber-band translates the
          element it is attached to. Attaching to the overlay itself would
          slide the WHOLE screen down (header included) and expose the
          authed shell behind it (z-lower in the same document) — so the
          overlay stays put as an opaque backstop and this wrapper takes
          the gesture. flex-1/min-h-0, not h-full: it's a flex child under
          the header now, and h-full would overflow by the header's height.
      */}
      <div id="auth-landing-scroll" className="flex-1 min-h-0 overflow-y-auto platform-safe-scroll">
        <div className="max-w-3xl mx-auto px-6 py-12">
          <div className="text-center mb-10">
            <h1 className="text-3xl font-bold mb-2">
              Homeroom
            </h1>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 italic">
              A place where users own and build apps together
            </p>
          </div>
          {/*
              Offline explanation (#1021). The landing page's app grid is
              fetched, so offline it renders empty or stale with no reason
              given — and both header CTAs lead to screens that cannot
              complete. Say so once, here.
          */}
          <div className="offline-only mb-10 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3">
            <h2 className="text-sm font-semibold text-amber-800 dark:text-amber-400">
              You're offline
            </h2>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              Anything below is the last version this device loaded, and signing in or joining the
          waitlist both need a connection.
            </p>
            <button
              type="button"
              data-offline-retry=""
              className="mt-3 rounded-lg border border-amber-500/50 px-3 py-1.5 text-sm font-medium text-amber-800 dark:text-amber-300 hover:bg-amber-500/10 transition-colors"
            >
              Try again
            </button>
          </div>
          {/*
              The CTA block sits where the Sign in / Join waitlist buttons used
              to be: a compact pitch plus ONE link into the dedicated waitlist
              screen (#waitlist). The survey itself lives on that screen — a
              four-question form flat on the homepage buried the app directory
              under it. Both this link and the header's "Join waitlist" button
              are plain anchors to the same route.
          */}
          <section
            id="landing-waitlist"
            // No border: this page's ground is WHITE, so the card is a step DOWN
            // (zinc-50) rather than the step up a card takes on the authed
            // shell's grey ground. Either way the language separates by
            // figure/ground, and the outline was doing the separating here.
            className="rounded-2xl bg-zinc-50 dark:bg-zinc-900/60 p-5 mb-10"
          >
            <h2 className="text-lg font-semibold mb-1">
              Build apps together, own them together
            </h2>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-3">
              Homeroom is a place where users describe the app
          they want in chat, an AI builds it, and the community votes the
          changes in. Every app below was built here by the people who use
          it. They run on the Homeroom chain, and contributors own a share
          of what they build.
            </p>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">
              Platform access opens in batches. The apps below are open to
          everyone right now.
            </p>
            <a
              id="landing-waitlist-link"
              href="#waitlist"
              data-offline-disabled=""
              className={hiddenLast(
                session,
                'inline-block rounded-lg bg-violet-600 hover:bg-violet-500 px-5 py-2 text-sm font-medium text-white transition-colors',
              )}
              onClick={onLeaveCta}
            >
              Join the waitlist
            </a>
            {/*
                The way back for somebody who already joined, on a device that
                knows nothing about it (#1538). It goes to the same code-entry
                step the waitlist screen's own "Already joined?" link opens,
                which is where an emailed code is typed and where the status
                comes back. Hidden alongside the CTA for a session: they are
                already in the queue and can read their own state from the
                waiting room.
            */}
            <p
              className={hiddenLast(
                session,
                'mt-3 text-sm text-zinc-500 dark:text-zinc-400',
              )}
            >
              {'Already joined? '}
              <a
                id="landing-status-link"
                href="#waitlist?confirm=1"
                data-offline-disabled=""
                className="font-medium text-violet-700 dark:text-violet-400 hover:underline"
                onClick={onLeaveCta}
              >
                Check your status
              </a>
            </p>
            {/*
                Swapped in for the link when a (waiting-room) session exists —
                they're already on the list, so pointing them at the join form
                again is noise.
            */}
            <p
              id="landing-cta-queued"
              className={
                session
                  ? 'text-sm text-zinc-500 dark:text-zinc-400'
                  : 'hidden text-sm text-zinc-500 dark:text-zinc-400'
              }
            >
              You're already on the waitlist. We'll email you when your spot opens.
            </p>
          </section>
          <section>
            <h2 className="text-lg font-semibold mb-1">
              Apps built here
            </h2>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">
              Community-built apps on the Homeroom chain. Many are open to
          everyone. The grayed-out ones need an account.
            </p>
            {/* Same launcher-grid shape as the authed homescreen (#app-list). */}
            <div id="landing-apps" className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2">
              {apps.kind === 'loading' ? (
                /* The directory's LOADING state, at the tile geometry rather
                   than as the word "Loading…".
                   This is the shipped document's own first paint — the landing
                   screen is what a signed-out visitor lands on, served from
                   cache — so eleven characters of grey text in the top-left of
                   an empty grid was the platform's first impression, and it is
                   the same "content loads without you realising it's loading"
                   the board's skeleton was built for. Six tiles: three rows at
                   the 2-column phone width, two at `md`, and never so many
                   that a directory of four watches placeholders evaporate. */
                <TileSkeleton
                  n={6}
                  label="Loading apps"
                  className={'col-span-full grid grid-cols-2 md:grid-cols-3 '
                    + 'lg:grid-cols-4 xl:grid-cols-5 gap-2'}
                />
              ) : apps.kind === 'error' ? (
                <p className="text-sm text-zinc-500 dark:text-zinc-400 col-span-full">Could not load apps right now.</p>
              ) : apps.apps.length === 0 ? (
                <p className="text-sm text-zinc-500 dark:text-zinc-400 col-span-full">No public apps yet.</p>
              ) : (
                apps.apps.map((app, i) => (
                  <LandingTile key={app.slug || i} app={app} onOpen={onTileClick} />
                ))
              )}
            </div>
          </section>
        </div>
      </div>
      <ViewerRegion />
        </>
      ) : null}
    </main>
  );
}
