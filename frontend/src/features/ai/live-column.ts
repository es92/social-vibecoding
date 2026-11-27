/**
 * THE WAITING COLUMN, CLOSED (27 Nov 2026). From 1500px a new chat with
 * Homeroom bot has the column a live preview runs in beside it from the
 * start (../messages/live-start-pane.tsx). It had no way out but starting a
 * chat. Its title card has a close button now, as a real preview's has, and
 * this is the choice it makes: kept on this device, the way hiding the list
 * is (./list-closed.ts), so the column does not come back with every new
 * chat. While it is closed, New chat's title card offers Live preview, which
 * brings the column back and starts nothing (../messages/new-thread.tsx
 * `LiveStartReopen`).
 *
 * Only the waiting column is closed here. A draft's own preview is a detail
 * (./detail.ts) with its own close, and comes up beside its thread whatever
 * this says.
 *
 * The server snapshot is false, so the prerender and the first client render
 * agree: nothing of the column is drawn before mount anyway.
 */

import { useSyncExternalStore } from 'react';

/** localStorage key for the choice: '1' while the waiting column is closed. */
export const AI_LIVE_COLUMN_CLOSED_KEY = 'usernode_ai_live_closed_v1';

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Storage can be absent or throw on access (a private window, blocked site data): then there is no choice kept. */
function storage(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readLiveColumnClosed(store: StorageLike | null = storage()): boolean {
  try {
    return !!store && store.getItem(AI_LIVE_COLUMN_CLOSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeLiveColumnClosed(closed: boolean, store: StorageLike | null = storage()): void {
  try {
    if (!store) return;
    if (closed) store.setItem(AI_LIVE_COLUMN_CLOSED_KEY, '1');
    else store.removeItem(AI_LIVE_COLUMN_CLOSED_KEY);
  } catch {
    /* a choice that does not survive a reload is the column back next time */
  }
}

let closed: boolean | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Is the waiting column closed on this device? */
export function isLiveColumnClosed(): boolean {
  if (closed === null) closed = readLiveColumnClosed();
  return closed;
}

/** Close the waiting column, or bring it back, and keep that on this device. */
export function setLiveColumnClosed(next: boolean): void {
  if (isLiveColumnClosed() === next) return;
  closed = next;
  writeLiveColumnClosed(next);
  for (const listener of listeners) listener();
}

/** The page's hook. */
export function useLiveColumnClosed(): boolean {
  return useSyncExternalStore(subscribe, isLiveColumnClosed, () => false);
}
