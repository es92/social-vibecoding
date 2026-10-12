import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { XIcon } from '@/components/ui/icons';
import { useMessages } from '../../lib/i18n/react';
import { useHiddenClass } from '../../lib/legacy-dom';
import { useStoreState } from '../../lib/use-store-state';
import { offeringGoToHomeroom } from '../app-context/about-data';
import { useTourRunning } from '../first-session/tour-running';
import { navStore } from '../nav/nav-store.js';
import { hasPlatformViewer, whenPlatformViewer } from '../../lib/platform-viewer';
import { isEmbeddedPanel } from '../../lib/side-panel-mode';
import {
  detectMobileOs, installOffer, storeLabel,
  type InstallOffer, type StoreUrls,
} from './detect';
import { isNativeApp, isStandalone } from './environment';
import { InstallStepsSheet } from './install-steps-sheet';

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

// The shots worker writes this same key before every page it shoots
// (worker/shots-page-init.js, #4087); tests/shots-page-init.test.js pins the pair.
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
  const t = useMessages('agent');
  const ref = useRef<HTMLDivElement>(null);
  const [urls, setUrls] = useState<StoreUrls | null>(null);
  const [dismissed, setDismissed] = useState(false);
  // #4204: only somebody who is in. Starts false (the first render must be
  // the hidden strip either way) and turns on when the authed shell boots.
  const [member, setMember] = useState(false);
  // #4399: not over the app a private member was invited into, while the
  // mark menu still offers them "Go to Homeroom" (../app-context/about-data
  // offeringGoToHomeroom). That menu's Go to Homeroom card carries the
  // home-screen offer instead; once they have been Home, the strip behaves as
  // it does for everyone. `tab` is read so the offer is recomputed when they
  // get there, which is when the remembered visit changes.
  const { privateMember, tab } = useStoreState(navStore);
  // #4899: held while a first-session tour is on screen, and offered again
  // the moment it ends, without a reload. False whenever no tour is up, so
  // somebody who never takes one is never held.
  const touring = useTourRunning();
  const [offer, setOffer] = useState<InstallOffer | null>(null);
  // #1513: the home-screen instructions are one tap away rather than always
  // on. #4400: that tap opens a sheet (./install-steps-sheet.tsx) rather than
  // swapping the strip's one line for a sentence it had to truncate, so the
  // strip itself never changes. Closing the sheet leaves the strip up.
  const [stepsOpen, setStepsOpen] = useState(false);

  // The fetch is skipped entirely for anyone who cannot be offered anything —
  // a desktop visitor, the native app, an installed PWA, someone who already
  // said no. That is most pageviews, and this is one request each.
  useEffect(() => {
    const nav = window.navigator;
    const onAPhone = detectMobileOs(nav.userAgent || '', nav.maxTouchPoints || 0) !== null;
    // Nor inside the side panel's document (`?panel=1`), which is framed
    // beside a running app on a desktop window: the top window offers the
    // install, if anyone does.
    if (!onAPhone || isNativeApp() || isStandalone() || readDismissed()
        || isEmbeddedPanel()) return undefined;

    // #4204: nor before the visitor is in. The signed-out landing (an invite
    // link's page included) and the waiting room never ask; the fetch waits
    // for the authed shell, which also covers a sign-in without a reload.
    let live = true;
    const stopWaiting = whenPlatformViewer(() => {
      if (!live) return;
      setMember(true);
      fetch('/api/public/mobile-app')
        .then((res) => (res.ok ? res.json() : null))
        .then((body) => {
          if (live && body) setUrls({ ios: body.ios ?? null, android: body.android ?? null });
        })
        .catch(() => {
          /* Offline, or the endpoint is unreachable: no banner, no console noise. */
        });
    });
    return () => { live = false; stopWaiting(); };
  }, []);

  // Recomputed from the real environment whenever the inputs change, rather
  // than trusted from the effect above — the eligibility probe there is a
  // cheap "is this a phone", not the decision.
  useEffect(() => {
    if (offeringGoToHomeroom(!!privateMember)) { setOffer(null); return; }
    const nav = window.navigator;
    setOffer(installOffer({
      ua: nav.userAgent || '',
      maxTouchPoints: nav.maxTouchPoints || 0,
      native: isNativeApp(),
      standalone: isStandalone(),
      member: member && hasPlatformViewer(),
      touring,
      dismissed: dismissed || readDismissed(),
      urls,
    }));
  }, [urls, dismissed, member, privateMember, tab, touring]);

  // #4899: `touring` is read here as well as in the decision above. That is
  // an effect, settled a render after the tour comes up; this takes the strip
  // down in the frame the tour's first card is drawn, rather than one frame
  // later with the page jumping up under the card.
  const up = !!offer && !touring;

  useHiddenClass(ref, !up);

  // The strip is fixed, so it covers the top of the document while it is up.
  useEffect(() => {
    const { body } = document;
    if (!body) return undefined;
    body.classList.toggle(BODY_CLASS, up);
    return () => body.classList.remove(BODY_CLASS);
  }, [up]);

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
      <img src="/icons/v3/icon-192.png" alt="" aria-hidden="true" className="w-8 h-8 rounded-lg shrink-0" />
      <div className="min-w-0 flex-1 text-left leading-tight">
        <div className="font-medium text-zinc-900 dark:text-zinc-100 truncate">Homeroom</div>
        <div className="text-zinc-500 dark:text-zinc-400 truncate">
          {/* Three states, and the last one is the whole of #1513: with no
              store listing published this used to read "Get the app" over a
              link to nowhere. */}
          {offer === null
            ? t('agent:install.banner.getApp')
            : offer.kind === 'store'
              ? t(storeLabel(offer.os, offer.url))
              : t('agent:install.banner.addToHomeScreen')}
        </div>
      </div>
      {offer && offer.kind === 'a2hs' ? (
        // A BUTTON, not a link: there is nowhere to send anybody. iOS Safari
        // has no install API and Android's prompt event is not guaranteed to
        // fire, so the honest control shows where the menu item is.
        <Button
          id="mobile-install-open"
          type="button"
          aria-haspopup="dialog"
          aria-expanded={stepsOpen}
          onClick={() => setStepsOpen(true)}
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
          {t('agent:install.banner.how')}
        </Button>
      ) : (
        <a
          id="mobile-install-open"
          href={offer && offer.kind === 'store' ? offer.url : undefined}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 inline-flex items-center h-7 px-3 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-xs font-medium transition-colors un-touch-target"
        >
          {t('agent:install.banner.get')}
        </a>
      )}
      <button
        id="mobile-install-dismiss"
        type="button"
        onClick={dismiss}
        aria-label={t('agent:install.banner.dismiss')}
        className="shrink-0 w-7 h-7 flex items-center justify-center rounded-full text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors un-touch-target"
      >
        <XIcon className="w-4 h-4" aria-hidden="true" />
      </button>
      {stepsOpen && offer && offer.kind === 'a2hs' ? (
        <InstallStepsSheet os={offer.os} onClose={() => setStepsOpen(false)} />
      ) : null}
    </div>
  );
}
