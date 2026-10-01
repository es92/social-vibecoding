/**
 * The challenges Getting started still hides, as one placeholder: a dashed
 * card the size of a challenge card with a hatched lock tile, how many there
 * are and what opens them ("6 challenges unlock after Getting started"), and,
 * when the server names them, the first few ("Make a proposal, Invite a
 * friend and 4 more"). Nothing else about them is shown, because the server
 * does not send them until the list is done; it sends only the count and a
 * few names. The first line is the unlock note, so a surface that draws this
 * card does not repeat the note beneath.
 *
 * The words name the list on Home rather than "setup" (2026-10-01): the gate
 * is only for a new account, whose Getting started card IS the First
 * challenges plus the tour, and the tour counts too, so "Finish setup" named
 * a thing the person could not find. Without names (an older server) the
 * second line says what to do instead.
 *
 * SHARED like ./challenge-card.tsx: the Challenges tab draws it after its
 * last group, and Home's block draws it ALONE while the gate is closed, in
 * place of the First challenges the Getting started card above it already
 * lists. It draws nothing for a count below one, so a payload without the
 * count simply has no placeholder.
 *
 * Both lines may wrap to a second line rather than truncate: the count line
 * is a sentence now, wider than a phone's card body, and a name cut to "Make
 * a pro…" says nothing.
 *
 * The corners follow the card's: the outer 24px of `rounded-3xl`, and the tile
 * 11px, which is the outer radius less the 12px padding and the 1px border.
 */

import type { ReactNode } from 'react';

import { LockIcon } from '@/components/ui/icons';

const CARD = 'flex min-h-[6.5rem] items-center gap-3 rounded-3xl border border-dashed border-zinc-300 '
  + 'bg-white/40 p-3 dark:border-zinc-700 dark:bg-white/[0.03]';
const TILE = 'flex h-20 w-20 shrink-0 items-center justify-center rounded-[0.6875rem] text-zinc-500 dark:text-zinc-400 '
  + 'bg-[repeating-linear-gradient(135deg,rgb(24_24_27/0.05)_0_6px,rgb(24_24_27/0.02)_6px_12px)] '
  + 'dark:bg-[repeating-linear-gradient(135deg,rgb(255_255_255/0.07)_0_6px,rgb(255_255_255/0.03)_6px_12px)]';
const TEXT = 'flex min-w-0 flex-col';
const TITLE = 'line-clamp-2 text-base font-medium leading-6 text-zinc-600 dark:text-zinc-300';
const HINT = 'mt-0.5 line-clamp-2 text-[0.8125rem] leading-5 text-zinc-500 dark:text-zinc-400';

/** "6 challenges unlock after Getting started". */
export function lockedTitle(count: number): string {
  const n = Math.floor(Number(count) || 0);
  return n === 1 ? '1 challenge unlocks after Getting started' : `${n} challenges unlock after Getting started`;
}

/**
 * "Make a proposal, Invite a friend and 4 more", from the names the server
 * sent and the count; without names, what to do: "Finish Getting started on
 * Home to see them".
 */
export function lockedHint(count: number, names?: string[] | null): string {
  const n = Math.floor(Number(count) || 0);
  const shown = (Array.isArray(names) ? names : [])
    .map((s) => String(s == null ? '' : s).trim()).filter(Boolean).slice(0, Math.max(0, n));
  if (!shown.length) return 'Finish Getting started on Home to see them';
  const more = n - shown.length;
  if (more > 0) return `${shown.join(', ')} and ${more} more`;
  if (shown.length === 1) return shown[0];
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

export function LockedChallengesCard({ count, names, className }: {
  count: number; names?: string[] | null; className?: string;
}): ReactNode {
  const n = Math.floor(Number(count) || 0);
  if (n < 1) return null;
  return (
    <div className={className ? `${className} ${CARD}` : CARD} data-locked-count={String(n)}>
      <div aria-hidden="true" className={TILE}>
        <LockIcon className="h-[1.625rem] w-[1.625rem]" />
      </div>
      <div className={TEXT}>
        <p className={TITLE}>{lockedTitle(n)}</p>
        <p className={HINT}>{lockedHint(n, names)}</p>
      </div>
    </div>
  );
}
