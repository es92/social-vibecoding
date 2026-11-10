/**
 * THE HUB CARDS YOU CLOSED (15 Oct 2026).
 *
 * Two cards on a project's hub are there to get a project going: Share it
 * (./community-card.tsx ShareItCard, how a project that is just yours
 * grows) and "What do you want to change?" (./workshop.tsx
 * StartHereBanner, the first change). Each has a small ✕. Closing one hides
 * it for that person on that project, and it stays closed: what both cards
 * offer is still on the page without them, Invite in the hero's row and
 * Suggest an improvement in the hero's ⋯.
 *
 * A version's Update card (./hub-cards.tsx UpdateCard, docs/plans/versions.md)
 * closes the same way, from its Not now, under the name of the one update
 * it is about (`update:<the original's commit>`), so the next update shows
 * again; `update:behind` is the one-time card of a version that does not
 * get its updates.
 *
 * ── The record ─────────────────────────────────────────────────────────
 *
 * There is no per-person store of closed cards on the server, so this is
 * the device's, kept the way the Needs you counts keep the votes you passed
 * over (../../workshop/needs-seen.ts): localStorage per account
 * (`hubDismissed:v1:<user id>`), by project, then by card, with when it was
 * closed. Read in an effect, never during render (the island rule), and a
 * layout effect so the read lands before the hub paints: a closed card is
 * never drawn. A private window or a full quota is a card closed for this
 * page only, never an error. Bounded: the newest HUB_DISMISSED_MAX projects
 * are kept. A signed-out reader's close lasts the page.
 */

import { useLayoutEffect } from 'react';

import { createStore } from '../../../lib/plain-store.js';
import { useStoreState } from '../../../lib/use-store-state';

export const HUB_DISMISSED_KEY = 'hubDismissed:v1';
/** How many projects one account's record keeps, newest first. */
export const HUB_DISMISSED_MAX = 200;

/**
 * The cards that can be closed: Share it, What do you want to change?, a
 * version's Update card for one update, and (10 Nov 2026) the Workshop's
 * "Make your first change here" (./first-change.tsx), which is not on the
 * hub but closes the same way.
 */
export type HubCard = 'share' | 'start' | 'first' | `update:${string}`;

/** By project, then by card: when it was closed. */
type ClosedMap = Record<string, Partial<Record<HubCard, number>>>;

export interface HubDismissedState {
  /** Whose record this is, so a shared device keeps two. */
  owner: string;
  /** Whether the record has been read for `owner`. */
  read: boolean;
  closed: ClosedMap;
}

export const hubDismissedStore = createStore<HubDismissedState>({ owner: '', read: false, closed: {} });

function viewer(): string {
  try {
    const id = (window as unknown as { App?: { user?: { id?: unknown } } }).App?.user?.id;
    return id == null || id === '' ? '' : String(id);
  } catch {
    return '';
  }
}

function storageKey(owner: string): string {
  return `${HUB_DISMISSED_KEY}:${owner}`;
}

/** The newest HUB_DISMISSED_MAX projects, by when a card on each was last closed. */
function trim(closed: ClosedMap): ClosedMap {
  const latest = (cards: Partial<Record<HubCard, number>>) => Math.max(0, ...Object.values(cards).map((n) => Number(n) || 0));
  const kept = Object.entries(closed)
    .filter(([slug, cards]) => slug && cards && typeof cards === 'object')
    .sort((a, b) => latest(b[1]) - latest(a[1]))
    .slice(0, HUB_DISMISSED_MAX);
  return Object.fromEntries(kept);
}

/** Read this account's record, once per account. */
export function hydrateHubDismissed(): void {
  if (typeof window === 'undefined') return;
  const owner = viewer();
  const state = hubDismissedStore.get();
  if (state.read && state.owner === owner) return;
  let closed: ClosedMap = {};
  if (owner) {
    try {
      const raw = JSON.parse(window.localStorage.getItem(storageKey(owner)) || 'null');
      if (raw && typeof raw === 'object') closed = trim(raw as ClosedMap);
    } catch { /* nothing kept: every card shows */ }
  }
  hubDismissedStore.set({ owner, read: true, closed });
}

/** Whether `card` was closed on `slug`'s hub. */
export function isHubCardDismissed(slug: string | null | undefined, card: HubCard): boolean {
  if (!slug) return false;
  const cards = hubDismissedStore.get().closed[slug];
  return !!cards && !!cards[card];
}

/** Close `card` on `slug`'s hub, for good on this device. */
export function dismissHubCard(slug: string | null | undefined, card: HubCard): void {
  if (!slug || typeof window === 'undefined') return;
  hydrateHubDismissed();
  const { owner, closed } = hubDismissedStore.get();
  const next = trim({ ...closed, [slug]: { ...(closed[slug] || {}), [card]: Date.now() } });
  hubDismissedStore.set({ closed: next });
  if (!owner) return;
  try {
    window.localStorage.setItem(storageKey(owner), JSON.stringify(next));
  } catch { /* private mode: closed for this page only */ }
}

/**
 * Whether `card` is closed on `slug`'s hub, and the ✕'s action. The record
 * is read in a layout effect, before the hub paints.
 */
export function useHubDismissed(slug: string, card: HubCard): [boolean, () => void] {
  useLayoutEffect(() => { hydrateHubDismissed(); }, []);
  useStoreState(hubDismissedStore);
  return [isHubCardDismissed(slug, card), () => dismissHubCard(slug, card)];
}
