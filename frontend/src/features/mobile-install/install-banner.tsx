import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { XIcon } from '@/components/ui/icons';
import { useHiddenClass } from '../../lib/legacy-dom';
import {
  A2HS_STEPS, detectMobileOs, installOffer, storeLabel,
  type InstallOffer, type StoreUrls,
} from './detect';
import { isNativeApp, isStandalone } from './environment';

/**
 * `#mobile-install-banner` — the phone-browser strip offering the native app
 * (#1372).
 *
 * Sits directly under `#offline-banner`, and is the same SHAPE as it: an
 * in-flow `shrink-0` strip in the header column, which `public/css/app.css`
 * lifts to `position: fixed` while `body.has-install-strip` is set. That is
 * how the offline banner floats over content instead of displacing it, and
 * the two stack — offline at `z-60`, this at `z-59`, so a connectivity
 * warning is never covered by an advert for an app you cannot download while
 * offline.
 *
 * ── Why the body class ─────────────────────────────────────────────────
 *
 * A fixed strip covers whatever is at the top of the document, so the body
 * gains `padding-top` for exactly as long as the strip is up. `body` is not
 * React-owned (app.js writes `is-offline`, `is-view-as-non-admin` and others
 * to it), so toggling one more class from an effect is the established seam
 * rather than a new one.
 *
 * ── Why the markup renders even when there is nothing to offer ─────────
 *
 * AGENTS.md: an island's INITIAL render must emit exactly the empty/hidden
 * markup, with the data loaded in an effect. A first render that disagrees
 * with the prerendered document is a hydration mismatch, React `console.error`s
 * it, and a console error on any route fails proposal checks. So the strip is
 * always in the document, `hidden`, and the offer only ever toggles the class
 * through a ref — never the rendered `className`, which must stay a constant
 * for the reason lib/legacy-dom.ts explains.
 *
 * The practical consequence is worth stating plainly: with no store listing
 * published, `GET /api/public/mobile-app` answers `{ios: null, android: null}`
 * and this element is inert markup that no one ever sees. It turns itself on
 * the day an admin pastes a URL into App version.
 */

const DISMISS_KEY = 'mobileInstallBannerDismissed';
const BODY_CLASS = 'has-install-strip';

/**
 * #1514: the dismissal lasts a SESSION, not forever.
 *
 * It used to be written to `localStorage`, so the one person who tapped the
 * × on a day the store link was not yet live could never be offered the app
 * again on that device. `sessionStorage` keeps the strip down for as long as
 * the tab is open — refreshes and in-app navigation included, which is what
 * makes a dismissal feel respected — and lets the next visit ask once more.
 *
 * The old `localStorage` entry is deliberately NOT read as a fallback: it
 * would pin exactly the people this change is meant to reach.
 */
/** Every read below is in a try/catch: Safari throws on storage in private mode. */
function readDismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

function writeDismissed(): void {
  try {
    sessionStorage.setItem(DISMISS_KEY, '1');
  } catch {
    /* A dismissal that cannot be persisted still hides the strip for this page. */
  }
}

export function MobileInstallBanner() {
  const ref = useRef<HTMLDivElement>(null);
  const [urls, setUrls] = useState<StoreUrls | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [offer, setOffer] = useState<InstallOffer | null>(null);
  // #1513: the home-screen instructions are one tap away rather than always
  // on, so the strip stays one line until somebody asks how.
  const [showSteps, setShowSteps] = useState(false);

  // The fetch is skipped entirely for anyone who cannot be offered anything —
  // a desktop visitor, the native app, an installed PWA, someone who already
  // said no. That is most pageviews, and this is one request each.
  useEffect(() => {
    const nav = window.navigator;
    const onAPhone = detectMobileOs(nav.userAgent || '', nav.maxTouchPoints || 0) !== null;
    if (!onAPhone || isNativeApp() || isStandalone() || readDismissed()) return undefined;

    let live = true;
    fetch('/api/public/mobile-app')
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (live && body) setUrls({ ios: body.ios ?? null, android: body.android ?? null });
      })
      .catch(() => {
        /* Offline, or the endpoint is unreachable: no banner, no console noise. */
      });
    return () => { live = false; };
  }, []);

  // Recomputed from the real environment whenever the inputs change, rather
  // than trusted from the effect above — the eligibility probe there is a
  // cheap "is this a phone", not the decision.
  useEffect(() => {
    const nav = window.navigator;
    setOffer(installOffer({
      ua: nav.userAgent || '',
      maxTouchPoints: nav.maxTouchPoints || 0,
      native: isNativeApp(),
      standalone: isStandalone(),
      dismissed: dismissed || readDismissed(),
      urls,
    }));
  }, [urls, dismissed]);

  useHiddenClass(ref, !offer);

  // The strip is fixed, so it covers the top of the document while it is up.
  useEffect(() => {
    const { body } = document;
    if (!body) return undefined;
    body.classList.toggle(BODY_CLASS, !!offer);
    return () => body.classList.remove(BODY_CLASS);
  }, [offer]);

  const dismiss = useCallback(() => {
    writeDismissed();
    setDismissed(true);
  }, []);

  return (
    <div
      ref={ref}
      id="mobile-install-banner"
      className="hidden shrink-0 items-center gap-2 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-2 text-xs"
    >
      <img src="/icons/v2/icon-192.png" alt="" aria-hidden="true" className="w-8 h-8 rounded-lg shrink-0" />
      <div className="min-w-0 flex-1 text-left leading-tight">
        <div className="font-medium text-zinc-900 dark:text-zinc-100 truncate">Homeroom</div>
        <div className="text-zinc-500 dark:text-zinc-400 truncate">
          {/* Three states, and the middle one is the whole of #1513: with no
              store listing published this used to read "Get the app" over a
              link to nowhere. */}
          {offer === null
            ? 'Get the app'
            : offer.kind === 'store'
              ? `Get the app on ${storeLabel(offer.os, offer.url)}`
              : (showSteps ? A2HS_STEPS[offer.os] : 'Add it to your home screen')}
        </div>
      </div>
      {offer && offer.kind === 'a2hs' ? (
        // A BUTTON, not a link: there is nowhere to send anybody. iOS Safari
        // has no install API and Android's prompt event is not guaranteed to
        // fire, so the honest control reveals where the menu item is.
        <Button
          id="mobile-install-open"
          type="button"
          aria-expanded={showSteps}
          onClick={() => setShowSteps((v) => !v)}
          // Composed, not hand-written: the fill is `variant`'s and the ink is
          // `ink`'s, so a restyle of the shell's primary button reaches this
          // one too. Only the height and the tap target ride in className,
          // which is what the anchor beside it already spells out — the two
          // controls occupy the same seat and must be the same size.
          layout="shrink"
          variant="default"
          size="xsText"
          ink="solid"
          className="inline-flex items-center h-7 un-touch-target"
        >
          {showSteps ? 'Got it' : 'How'}
        </Button>
      ) : (
        <a
          id="mobile-install-open"
          href={offer && offer.kind === 'store' ? offer.url : undefined}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 inline-flex items-center h-7 px-3 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-xs font-medium transition-colors un-touch-target"
        >
          Get
        </a>
      )}
      <button
        id="mobile-install-dismiss"
        type="button"
        onClick={dismiss}
        aria-label="Dismiss install banner"
        className="shrink-0 w-7 h-7 flex items-center justify-center rounded-full text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors un-touch-target"
      >
        <XIcon className="w-4 h-4" aria-hidden="true" />
      </button>
    </div>
  );
}
