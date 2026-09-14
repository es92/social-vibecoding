/**
 * The App AI permissions list's view model (#34's list, converted).
 *
 * `settings.js` used to build these rows itself: `#llm-grants-list.innerHTML`
 * for the loading / error / empty lines, then a `document.createElement` +
 * `innerHTML` per grant, then four `querySelector` + `addEventListener` calls
 * per row to wire the cap field, the BYOK toggle and Revoke. It pushes THIS
 * instead, and ./grants-list.tsx is the only writer of the DOM below that host.
 *
 * ── Why the shape is flat and pre-decided ─────────────────────────────
 *
 * Every branch the template evaluated inline — is this grant revoked, does the
 * viewer have a key on file, is this a fabricated staging row — is resolved by
 * settings.js, where `Settings.state.hasApiKey` and the demo flag already live.
 * The component renders; it does not decide. Same split as the launcher grid
 * (features/home/grid-store.ts) and the group chat transcript, and it is what
 * lets the module keep owning its data and its fetches while React owns the
 * markup.
 *
 * The money is pre-formatted for the same reason `time` is on a chat message:
 * settings.js divides cents by 100 and fixes to 2 decimals today, and moving
 * that into the component would be a second place that decides what a cap
 * looks like.
 *
 * `appSlug` and `capCents` ride along for Re-enable (#1957): the re-grant
 * endpoint is keyed on slug, not app id, and the previous cap is what it
 * restores — a revoked row keeps both, so the view carries both.
 *
 * ── What is NOT in here ───────────────────────────────────────────────
 *
 * The status line (`#llm-grants-status`). It is a SIBLING of this host, not a
 * child, and `_setLlmGrantsStatus` owns it — including a 3s self-clearing
 * timer. Nothing in this subtree writes to it.
 *
 * @typedef {{
 *   appId: number, appName: string, appSlug: string, revoked: boolean,
 *   spent: string, cap: string, capValue: string, capCents: number,
 *   showByok: boolean, allowByok: boolean,
 * }} GrantView
 * @typedef {{ phase: 'idle'|'loading'|'error'|'ready', grants: GrantView[] }} GrantsState
 */

import { createStore } from '../../lib/plain-store.js';

/**
 * `idle` renders NOTHING, which is exactly the empty `<div id="llm-grants-list">`
 * that sections/app-ai.tsx ships and the SSG prerender emits. The list is
 * fetched when the section opens, so a first render that drew a "Loading…"
 * line would be a hydration mismatch — which console.errors, and a console
 * error on any route fails proposal checks.
 */
export const INITIAL_GRANTS = /** @type {GrantsState} */ ({ phase: 'idle', grants: [] });

export const grantsStore = createStore(INITIAL_GRANTS);

/**
 * Published for settings.js, which is a classic script loaded before this
 * bundle and cannot import. Same seam as features/group-chat/mount.ts and
 * `window.GroupChatTranscriptStore`, and published at module-evaluation time
 * so the API exists long before the section can be opened.
 *
 * Deliberately NOT hung off `UsernodeReact.settings` — features/settings/mount.ts
 * points that key at `window.Settings` itself, so putting a publisher there
 * would have the module reaching through the bridge back into itself.
 *
 * The `typeof window` guard is not decoration: the SSG prerender evaluates
 * this whole module graph in Node.
 */
if (typeof window !== 'undefined') {
  const w = /** @type {any} */ (window);
  w.UsernodeReact = w.UsernodeReact || {};
  w.UsernodeReact.settingsGrants = {
    publish: (next) => grantsStore.set(next),
  };
}
