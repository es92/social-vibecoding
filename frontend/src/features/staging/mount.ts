/**
 * The legacy → React seam for the staging-preview and visual-compare overlays
 * (#1085 chunk H, step 1).
 *
 * `public/js/app-view.js` is a classic script that runs before this bundle, so
 * it calls by name: `AppView._staging().setLoader(…)` resolves
 * `window.UsernodeReact.staging`. Published at module scope (main.tsx imports
 * this above `hydrateRoot`) for the same reason the Dev board's bridge is —
 * these calls must not queue, because the overlay is opened from a user gesture
 * that reads the DOM on its next line.
 *
 * app-view.js keeps an equivalent DOM adapter (`AppView._stagingDom`) for
 * contexts where this bundle is not present at all — the Node-side render tests
 * load app-view.js as a classic script into a stubbed document. Both adapters
 * implement the same API; exactly one of them is live in any given context, so
 * there is never a second writer for these nodes.
 *
 * The bridge bodies themselves live in ./staging-bridge.js, which imports no
 * React: that is what lets tests/staging-iframe-identity.test.js drive the real
 * bridge. This file adds the two React-dependent halves.
 *
 * The `typeof window !== 'undefined'` guard is load-bearing: the SSG prerender
 * pass evaluates this whole module graph in Node.
 */

import { flushSync } from 'react-dom';

import { stagingBridge, visualCompareBridge } from './staging-bridge.js';
import { stagingHandlers, stagingStore, visualCompareStore } from './staging-store.js';
import { placePreview, togglePreviewSize, unplacePreview } from './placement';

// Legacy callers read the DOM on their next statement (`_watchStagingIframeLoad`
// straight after `open()`), so store writes must land synchronously — the same
// contract an `innerHTML` assignment used to give them.
stagingStore.setFlush(flushSync);
visualCompareStore.setFlush(flushSync);

// Where the preview stands (./placement.ts), which needs the detail column's
// and the side panel's stores, so it joins the bridge here rather than in
// the React-free ./staging-bridge.js the tests drive on its own.
Object.assign(stagingBridge, {
  place: (input?: { sessionId?: number | null; wide?: boolean; settle?: boolean }) => placePreview(input || {}),
  unplace: () => unplacePreview(),
  placementNow: () => {
    const s = stagingStore.get();
    return s.expanded ? 'full' : s.placement;
  },
});

// The header's own controls, which need nothing from app-view.js: Full
// window and back, the Preview | Before & after switch, and Comment, which
// turns on comment mode over the preview (its pins in the preview go to the
// change, ../comment-pin/).
stagingHandlers.onSize = () => { togglePreviewSize(); };
stagingHandlers.onView = (view?: string) => { stagingBridge.setView(view === 'shots' ? 'shots' : 'preview'); };
stagingHandlers.onComment = () => {
  import('../comment-pin/comment-pin')
    .then((m) => m.toggleCommentMode({ via: 'switch' }))
    .catch(() => {});
};

export { stagingBridge, visualCompareBridge };

if (typeof window !== 'undefined') {
  const host = window as unknown as { UsernodeReact?: Record<string, unknown> };
  const bridge = (host.UsernodeReact ||= {});
  bridge.staging = stagingBridge;
  bridge.visualCompare = visualCompareBridge;
}
