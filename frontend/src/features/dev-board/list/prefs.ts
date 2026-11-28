/**
 * HOW A PERSON READS ALL ITEMS (28 Nov 2026): the board's columns or the
 * list (./board-list.tsx), whether the list is narrowed to their own work,
 * and whether Waiting on others is open. Each is theirs and kept in this
 * browser, so the page opens the way they left it.
 *
 * `?board=list` (or `board`) in the address names the view for one visit,
 * as `?ws=` names the page: a link to the list opens the list, and a
 * declared check, which runs with nothing stored, can ask for it. It is
 * read once and never written back.
 *
 * Nothing is read in the first render, which is the prerender's and any
 * hydrating one's: the page starts as the board and `usePrefs` reads what
 * is stored after it mounts.
 */

import { useEffect, useSyncExternalStore } from 'react';

export type BoardView = 'board' | 'list';

export interface BoardPrefs {
  view: BoardView;
  /** The list shows only the viewer's own work, as the Homeroom bot tab lists it. */
  yours: boolean;
  /** Waiting on others is open (it starts folded). */
  othersOpen: boolean;
}

export const DEFAULT_PREFS: BoardPrefs = { view: 'board', yours: false, othersOpen: false };

const KEYS = { view: 'devBoardView', yours: 'devBoardYours', othersOpen: 'devBoardOthersOpen' } as const;

let prefs: BoardPrefs = DEFAULT_PREFS;
let loaded = false;
const listeners = new Set<() => void>();

function stored(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

function store(key: string, value: string | null): void {
  try {
    if (value == null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch { /* a private window keeps it for this visit only */ }
}

/** Pure: the view an address asks for (`?board=list`), or null when it names none. */
export function viewAsked(search: string | null | undefined): BoardView | null {
  let asked: string | null = null;
  try { asked = new URLSearchParams(String(search || '')).get('board'); } catch { asked = null; }
  return asked === 'list' || asked === 'board' ? asked : null;
}

function load(): void {
  if (loaded || typeof window === 'undefined') return;
  loaded = true;
  const asked = viewAsked(window.location.search);
  prefs = {
    view: asked || (stored(KEYS.view) === 'list' ? 'list' : 'board'),
    yours: stored(KEYS.yours) === '1',
    othersOpen: stored(KEYS.othersOpen) === '1',
  };
  listeners.forEach((fn) => fn());
}

export function setPrefs(patch: Partial<BoardPrefs>): void {
  load();
  prefs = { ...prefs, ...patch };
  if (patch.view) store(KEYS.view, patch.view === 'list' ? 'list' : null);
  if (patch.yours !== undefined) store(KEYS.yours, patch.yours ? '1' : null);
  if (patch.othersOpen !== undefined) store(KEYS.othersOpen, patch.othersOpen ? '1' : null);
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** The viewer's choices: the defaults in the first render, theirs once mounted. */
export function usePrefs(): BoardPrefs {
  const value = useSyncExternalStore(subscribe, () => prefs, () => DEFAULT_PREFS);
  useEffect(() => { load(); }, []);
  return value;
}

/** For a test: forget what was read. */
export function resetPrefsForTest(): void {
  prefs = DEFAULT_PREFS;
  loaded = false;
}
