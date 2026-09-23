/**
 * Whether an app Workshop's "Which workshop?" panel is open (#2768).
 *
 * TWO CONTROLS OPEN ONE PANEL, which is why this is a store and not the
 * `useState` it used to be inside `AppWorkshopScope`
 * (./workshop-chrome.tsx). Above the 700px breakpoint the control is the
 * scope chip at the head of the app's Workshop, as before. On a phone the
 * chip is gone — it was a second row saying which app you are in, directly
 * under a header saying the same thing — and the HEADER's icon and name are
 * the control instead (features/header/header-title.tsx). The panel itself
 * stays where it always rendered, at the top of the Workshop page, so on a
 * phone it drops down from right under the header that opened it.
 *
 * It is not `workshopStore.picker`: that flag was the all-apps screen's, which
 * has no switcher any more (#2759), and a flag shared between two screens is
 * a panel left open on one greeting the other.
 *
 * `open: false` is the prerender: the panel renders only once somebody taps.
 */

import { createStore } from '../../lib/plain-store.js';

export const appScopeStore = createStore({ open: false });

/**
 * The panel's id, which the header's control names in its `aria-controls` —
 * one spelling, so the two cannot point at different elements. The chip's own
 * `aria-controls` is its id plus `-picker`, which is this same string.
 */
export const APP_SCOPE_PANEL_ID = 'dev-ws-scope-chip-picker';
