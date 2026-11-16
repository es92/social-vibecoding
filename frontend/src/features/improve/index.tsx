/**
 * The Improve island: no markup any more, just the subscription that keeps
 * the store honest, and the import that publishes `window.Improve`.
 *
 * ── The panel is retired (#2718 review) ───────────────────────────────
 *
 * It was a drawer opened from a row in the mark's menu, holding two buttons,
 * a list of sessions and a build notice. The Workshop took the sessions
 * earlier in this issue, which left a drawer you opened to press one of two
 * buttons. Those and the notice are rows of the menu now
 * (../app-context/app-context-sheet.tsx renders ./actions.tsx), and the
 * drawer went with the row that opened it.
 *
 * This island still EXISTS because the controller has to be imported
 * somewhere for `window.Improve` to be there before `public/js/app.js` looks
 * for it — the same reason every other feature folder imports its
 * classic-side module from the island rather than from main.tsx — and because
 * the live session store has to be subscribed from a mounted component.
 */

import { useEffect } from 'react';

import { improveStore, Improve } from './mount';

export { improveStore, Improve } from './mount';

export function ImproveIsland() {
  // The Escape handler that was here went with the panel: the mark's menu is
  // a registered sheet and lib/sheet-controller.js owns the key for it, which
  // is the seam this hand-rolled listener was working around.

  // #1038's live session store drives the mark's working cue: a turn that
  // starts or finishes in this tab, another tab, or on another device moves
  // it without a refetch. Subscribed from the island rather than at module
  // scope because `window.SessionState` is installed by a classic script that
  // runs before the bundle but after it is imported.
  useEffect(() => {
    const sessionState = (window as unknown as {
      SessionState?: { subscribe(fn: () => void): (() => void) | void };
    }).SessionState;
    if (!sessionState?.subscribe) return undefined;
    // Read once on mount as well as on change: `subscribe` fires on the NEXT
    // notify, and app.js's boot path has usually already synced by the time
    // this island mounts — so a turn that was in flight before the page loaded
    // would leave the button's glyph un-spun until something else moved.
    Improve.onSessionStateChanged();
    const unsubscribe = sessionState.subscribe(() => Improve.onSessionStateChanged());
    return typeof unsubscribe === 'function' ? unsubscribe : undefined;
  }, []);

  return null;
}
