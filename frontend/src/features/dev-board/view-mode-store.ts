/**
 * The Dev board's view-mode seam between public/js/app-view.js and the React
 * frame that renders the header bar's segmented control (#1084 chunk G).
 *
 * ── Why a store, and not just a prop ───────────────────────────────────
 *
 * `AppView._updateViewToggleUI()` used to walk `.dev-view-btn` and assign
 * `btn.className` outright, so switching between modes could restyle the
 * buttons without re-rendering the header bar. The header bar
 * is React-rendered now, and React writes the whole `class` attribute when the
 * prop changes — two owners of one attribute is precisely the conflict the
 * migration's ownership rule forbids. So the toggle's active mode is the one
 * piece of board state that genuinely changes hands, and it becomes real React
 * state: the module PUBLISHES the mode it just switched to and React renders
 * the tab strip.
 *
 * Deliberately mirrors ../leaderboard/section-store.ts, including the
 * `globalThis` key and the cached-snapshot dance. Read that file's header for
 * the reasoning; the two differences are noted below.
 *
 * ── Difference 1: no `mounted` flag ────────────────────────────────────
 *
 * The Leaderboard's tab strip ships empty in the prerendered document and fills
 * in on first open, so its island needs a one-way `mounted` latch to keep the
 * hydrating render byte-identical to the shipped markup. The board frame is not
 * in the prerendered document at all — it is mounted into `#app-content` by an
 * interim root (../../lib/interim-root.ts), long after hydration — so there is
 * no shipped markup to match and the control renders populated from its first
 * frame, exactly as the `innerHTML` template did.
 *
 * ── Difference 2: the module stays the source of truth ─────────────────
 *
 * The persisted preference (localStorage `devViewMode`), the `?view=` URL
 * override and the width-based auto-default all still live in app-view.js —
 * `_getViewMode()` is unchanged and is what everything else on the board reads.
 * This store is a MIRROR of that value for rendering purposes only. A click on a
 * button calls `AppView._setViewMode(mode)`, which is what the template's
 * listener did, so persistence, the repaint and the override clear all still run
 * in the module. Seeding happens at mount, from `_getViewMode()`, so a cold deep
 * link with `?view=kanban` paints kanban on the first frame.
 */

import { useSyncExternalStore } from 'react';

export const DEV_VIEW_MODE_STORE_KEY = '__usernodeDevViewMode';

/**
 * Mirrors `AppView.VIEW_MODES`; 'workshop' is the fallback for an unknown
 * value.
 *
 * THE UI OVERHAUL cut this from four modes to two — 'list' became 'feed' and
 * 'pm' / 'report' were retired — and the Workshop then replaced 'feed' as the
 * Dev screen's lander. The module keeps the migration table
 * (`AppView.RETIRED_VIEW_MODES`) so a stored preference naming a retired mode
 * still resolves; nothing here needs it, because everything that reaches this
 * store has already been through `_setViewMode`.
 *
 * 'kanban' HAS SINCE RETIRED from `AppView.VIEW_MODES` as well: the board's
 * columns are the Workshop's "By stage" pane, which renders the same
 * <DevKanban/> from the same view model, so the standalone Board surface has
 * nothing left that routes to it. The value stays in the union here because
 * ./board-frame.tsx still compares against it to decide what that unreachable
 * surface would draw — narrowing this type is the first step of removing that
 * surface, which is a sweep of its own and not this change. Nothing publishes
 * 'kanban' any more: `_getViewMode()` cannot resolve it, and
 * `RETIRED_VIEW_MODES` maps a stored one onto 'workshop'.
 */
export const DEV_VIEW_MODES = ['workshop', 'kanban'] as const;

export type DevViewMode = (typeof DEV_VIEW_MODES)[number];

export const DEFAULT_DEV_VIEW_MODE: DevViewMode = 'workshop';

export function isDevViewMode(value: unknown): value is DevViewMode {
  return typeof value === 'string' && (DEV_VIEW_MODES as readonly string[]).includes(value);
}

export interface DevViewModeStore {
  mode: DevViewMode;
  listeners: Set<() => void>;
}

type StoreHost = typeof globalThis & {
  [DEV_VIEW_MODE_STORE_KEY]?: DevViewModeStore;
};

/** The shared store, created on first touch by whichever side gets there. */
export function getViewModeStore(): DevViewModeStore {
  const host = globalThis as StoreHost;
  let store = host[DEV_VIEW_MODE_STORE_KEY];
  if (!store) {
    store = { mode: DEFAULT_DEV_VIEW_MODE, listeners: new Set() };
    host[DEV_VIEW_MODE_STORE_KEY] = store;
  }
  return store;
}

/**
 * Publish the active view mode.
 *
 * Called from `AppView._setViewMode()` (replacing the
 * `AppView._updateViewToggleUI()` call that followed it) and once at mount, to
 * seed from whatever `_getViewMode()` resolved.
 */
export function publishViewMode(mode: string): void {
  const next = isDevViewMode(mode) ? mode : DEFAULT_DEV_VIEW_MODE;
  const store = getViewModeStore();
  if (store.mode === next) return;
  store.mode = next;
  // Copy first: a listener that unsubscribes during notification would
  // otherwise mutate the set being iterated.
  for (const listener of [...store.listeners]) {
    try {
      listener();
    } catch (err) {
      console.error('[dev-board] view-mode listener failed', err);
    }
  }
}

function subscribe(onChange: () => void): () => void {
  const store = getViewModeStore();
  store.listeners.add(onChange);
  return () => {
    store.listeners.delete(onChange);
  };
}

function getSnapshot(): DevViewMode {
  return getViewModeStore().mode;
}

/**
 * Subscribe the board frame to the active view mode.
 *
 * The snapshot is a primitive, so — unlike the Leaderboard's — it needs no
 * identity caching.
 */
export function useDevViewMode(): DevViewMode {
  return useSyncExternalStore(subscribe, getSnapshot, () => DEFAULT_DEV_VIEW_MODE);
}
