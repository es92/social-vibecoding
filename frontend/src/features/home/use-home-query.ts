/**
 * The search on Home, for the sections React draws (One Home, #6361).
 *
 * The field itself is #home-search-input, wired by Home._wireSearch
 * (./home.js), which filters the apps grid on a 100 ms debounce. Your
 * communities that match (./pinned-communities.tsx HomeCommunityMatches),
 * Communities to join and the Make offer read the words the grid last judged
 * (gridStore.query, through `settledQuery`), so every list changes with the
 * grid instead of one letter ahead of it: `useHomeQuery` is the field's live
 * text, and only an empty box is read from it directly (clearing the search
 * hides an offer straight away rather than after the debounce).
 */
import { useEffect, useState } from 'react';

import { useStoreState } from '../../lib/use-store-state';
import { gridStore, type HomeGridState } from './grid-store';

export function useHomeQuery(): string {
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const read = (event: Event) => {
      const el = event.target as HTMLInputElement | null;
      if (el && el.id === 'home-search-input') setQuery(String(el.value || ''));
    };
    const clear = (event: Event) => {
      const el = event.target as HTMLElement | null;
      if (el && el.id === 'home-search-clear') setQuery('');
    };
    document.addEventListener('input', read);
    document.addEventListener('click', clear);
    const now = document.getElementById('home-search-input') as HTMLInputElement | null;
    if (now && now.value) setQuery(now.value);
    return () => {
      document.removeEventListener('input', read);
      document.removeEventListener('click', clear);
    };
  }, []);
  return query.trim();
}

/**
 * The words everything beside the grid filters on: the grid's own judged
 * query, so the lists and the grid change together. An empty box settles at
 * once (its live text is ''), and a grid that has judged nothing (no render
 * yet, or its load notice — offline, or a failed fetch) falls back to the
 * live text so the lists still filter.
 */
export function settledQuery(
  live: string,
  grid: Pick<HomeGridState, 'ready' | 'notice' | 'query'>,
): string {
  if (!live) return '';
  if (!grid.ready || grid.notice) return live;
  return grid.query;
}

export function useSettledHomeQuery(): string {
  const live = useHomeQuery();
  const grid = useStoreState(gridStore);
  return settledQuery(live, grid);
}

/** Does a community's name or slug match the search? */
export function matchesQuery(query: string, ...fields: Array<string | null | undefined>): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return fields.some((f) => typeof f === 'string' && f.toLowerCase().includes(q));
}
