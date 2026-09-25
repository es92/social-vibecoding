/**
 * `#account-row-node` — the node status row in the Profile screen's account group.
 * See ./node-pill-store.ts for what the seam carries.
 *
 * ── Every class here is a complete literal, and that is load-bearing ──
 *
 * The module built the status ink by SUBTRACTION:
 *
 *   statusEl.className = 'ml-auto text-xs font-medium ' +
 *     style.tone.split(' ').filter((c) => !c.startsWith('border')).join(' ');
 *
 * — a `tone` string carrying both a border colour and an ink, with the border
 * stripped at runtime because this surface never wanted it. Tailwind's
 * extractor is a regex over source text, so that only ever compiled because
 * the whole `tone` literal sat in a file the extractor scans. Splitting the
 * table into `dot` and `ink`, each a complete literal, is the same rendered
 * output with nothing computed.
 */

import { type ReactNode } from 'react';

import { useStoreState } from '../../lib/use-store-state';
import { nodePillStore, type NodeStatusKind } from './node-pill-store';

export const STATUS_STYLES: Record<NodeStatusKind, {
  dot: string; label: string; ink: string;
}> = {
  synced: {
    dot: 'bg-emerald-500',
    label: 'Synced',
    ink: 'text-emerald-700 dark:text-emerald-400',
  },
  syncing: {
    dot: 'bg-amber-500',
    label: 'Syncing',
    ink: 'text-amber-800 dark:text-amber-400',
  },
  connecting: {
    dot: 'bg-zinc-400 animate-pulse',
    label: 'Connecting',
    ink: 'text-zinc-500 dark:text-zinc-400',
  },
  offline: {
    dot: 'bg-red-500',
    label: 'Offline',
    ink: 'text-red-700 dark:text-red-400',
  },
  unavailable: {
    dot: 'bg-zinc-400',
    label: 'Unavailable',
    ink: 'text-zinc-500 dark:text-zinc-400',
  },
};

export function styleFor(status: string | null | undefined) {
  return STATUS_STYLES[status as NodeStatusKind] || STATUS_STYLES.unavailable;
}

/** The row's own class run, in both states — the `hidden` is the model's. */
const ROW
  = 'flex items-center gap-3 px-4 min-h-[44px] w-full text-left relative'
  + " after:absolute after:bottom-0 after:left-12 after:right-0 after:h-px"
  + " after:bg-zinc-100 dark:after:bg-zinc-800 after:content-['']"
  + ' text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800';

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).NodePill : null) || null;
}

export function NodePillRow(): ReactNode {
  const s = useStoreState(nodePillStore);
  const style = styleFor(s.status);
  return (
    <button
      id="account-row-node"
      className={s.visible ? ROW : `hidden ${ROW}`}
      onClick={() => controller()?.openFromRow?.()}
    >
      <span
        id="account-node-dot"
        className={`w-2.5 h-2.5 rounded-full shrink-0 ${style.dot}`}
        aria-hidden="true"
      >
      </span>
      <span className="text-sm font-medium">
        Node
      </span>
      {/* Empty until the module has something to say — the hand-written row
          shipped this span blank, and the prerender has to agree. */}
      <span
        id="account-node-status"
        data-node-status={s.status}
        className={s.visible ? `ml-auto text-xs font-medium ${style.ink}` : 'ml-auto text-xs font-medium text-zinc-500 dark:text-zinc-400'}
      >{s.visible ? style.label : ''}</span>
    </button>
  );
}
