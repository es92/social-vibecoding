/**
 * The trailing pager / truncation affordance under a kanban column. It lived
 * in the Activity feed's module (card/dev-feed.tsx) until the feed retired
 * in favour of the Workshop; the kanban was its other reader.
 *
 * The buttons dispatch by name: showAllDone, loadMoreMerged.
 */

import type { ReactNode } from 'react';

import type { FooterSpec } from './model';

function callAppView(fn: string): void {
  const av = typeof window !== 'undefined' ? (window as any).AppView : null;
  if (av && typeof av[fn] === 'function') av[fn]();
}

export function FooterView({ f }: { f: FooterSpec }): ReactNode {
  if (f.kind === 'showAll') {
    return (
      <button className="gc-vote-btn" onClick={() => callAppView('showAllDone')}>{`Show all ${f.n}`}</button>
    );
  }
  if (f.kind === 'loadMerged') {
    return (
      <button className="gc-vote-btn" disabled={f.loading} onClick={() => callAppView('loadMoreMerged')}>
        {f.loading ? 'Loading…' : (f.n != null ? `Load more (${f.n})` : 'Load more')}
      </button>
    );
  }
  if (f.kind === 'github') {
    return (
      <a href={f.href} target="_blank" rel="noopener" className="text-xs text-violet-700 hover:underline dark:text-violet-400">
        {'More open requests →'}
      </a>
    );
  }
  return <span className="text-xs text-zinc-500 dark:text-zinc-500 italic">{`+${f.n} more completed`}</span>;
}

