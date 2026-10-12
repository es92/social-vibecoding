import { useEffect, useState } from 'react';

import { hasPlatformViewer, whenPlatformViewer } from '../../lib/platform-viewer';
import { isEmbeddedPanel } from '../../lib/side-panel-mode';
import { detectMobileOs, installOffer, type MobileOs, type StoreUrls } from './detect';
import { isNativeApp, isStandalone } from './environment';

/**
 * The OS to show add-to-home-screen steps for, or null when this visitor has
 * no such offer (#4399).
 *
 * The mark menu asks this for a private member who has not been Home yet: the
 * install banner stays down for them, and the menu's Go to Homeroom card
 * carries the offer instead. It is the banner's own decision (`installOffer`,
 * the same phone / native / standalone / member checks and the same store
 * listing fetch), minus the banner's dismissal: that ✕ answered an
 * unsolicited strip, and this row is in a menu somebody opened.
 *
 * Only an `a2hs` offer counts. A published store listing is the banner's to
 * link to; the How sheet this row opens is the home-screen steps.
 */
export function useHomeScreenOffer(enabled: boolean): MobileOs | null {
  const [os, setOs] = useState<MobileOs | null>(null);

  useEffect(() => {
    // Disabled keeps the last answer rather than clearing it, so the row does
    // not blink out and back every time the menu that asks is reopened. The
    // caller gates the row on its own condition too.
    if (!enabled) return undefined;
    const nav = window.navigator;
    const ua = nav.userAgent || '';
    const maxTouchPoints = nav.maxTouchPoints || 0;
    if (detectMobileOs(ua, maxTouchPoints) === null || isNativeApp() || isStandalone()
        || isEmbeddedPanel()) return undefined;

    let live = true;
    const stopWaiting = whenPlatformViewer(() => {
      if (!live) return;
      fetch('/api/public/mobile-app')
        .then((res) => (res.ok ? res.json() : null))
        .then((body) => {
          if (!live || !body) return;
          const urls: StoreUrls = { ios: body.ios ?? null, android: body.android ?? null };
          const offer = installOffer({
            ua,
            maxTouchPoints,
            native: isNativeApp(),
            standalone: isStandalone(),
            member: hasPlatformViewer(),
            // Nor the strip's hold over a first-session tour (#4899): that
            // keeps an unsolicited layer off the tour, and this is a row.
            touring: false,
            dismissed: false,
            urls,
          });
          setOs(offer && offer.kind === 'a2hs' ? offer.os : null);
        })
        .catch(() => {
          /* Offline, or the endpoint is unreachable: no row, no console noise. */
        });
    });
    return () => { live = false; stopWaiting(); };
  }, [enabled]);

  return os;
}
