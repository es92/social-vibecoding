import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/**
 * The rounded-square glyph tile, in its five sizes.
 *
 * `sm` is the leading tile in a grouped-list row; `lg` is the launcher/app
 * tile — the same shape at 4rem, used for app identity on Home, in the
 * Activity feed's app card, and on the record cards attached to chat
 * messages. `xs` is the same face at 2rem, for a row whose whole height is
 * the 44px tap target and where an 11-unit tile would leave no air: the
 * Improve panel's App / Board / Activity rows. `2xs` is 1.5rem, for a tile
 * inside a single-line header rather than a row. `xl` is the 5rem artwork
 * tile on the shared challenge card (features/leaderboard/challenge-card.tsx),
 * which the Challenges tab and Home both draw: it holds a 4rem illustration,
 * else the challenge kind's emoji, else nothing.
 *
 * ── There is ONE face, and it is neutral ──────────────────────────────
 *
 * The reskin gave each app a slug-derived identity tint here — six pastels,
 * picked by hashing the slug — and it was removed rather than tuned: a
 * launcher of six unrelated pastels reads as six unrelated things instead of
 * as one shelf, and an app's icon is its own artwork, which the tile should
 * hold rather than compete with. The face is a single off-white surface with
 * a hairline, identical everywhere, and app.css's `.app-icon-tile` is the one
 * rule that draws it.
 *
 * That is also why there is no `data-tint` and no slug hash any more. The
 * class strings below stay COMPLETE literals: Tailwind's extractor is a regex
 * over source text, so a computed class name is one that never compiles.
 *
 * A challenge illustration is the one tile that is not on this face, and the
 * difference is not a tint of the tile's. The artwork is drawn for a pale
 * harmonic ground, so its tone comes WITH it — named per artwork in
 * frontend/src/lib/challenge-illustrations.ts, never derived from the caller —
 * and the challenge card hands the tone class and a `--tint-art` background in
 * through `className`, where `cn` (tailwind-merge) displaces the neutral one.
 * No variant here knows about it, and the neutral face stays the default for
 * every other tile, that card's included when it has no artwork.
 */

const tile = cva('flex shrink-0 items-center justify-center', {
  variants: {
    size: {
      // `2xs` is the tile inside a single-line HEADER rather than a row: the
      // Improve panel's title bar, where "Improve" and the app's name sit on
      // one 20px baseline and an 8-unit tile would set the bar's height
      // instead of fitting inside it.
      '2xs': 'h-6 w-6 rounded-md [&>svg]:h-4 [&>svg]:w-4',
      xs: 'h-8 w-8 rounded-lg [&>svg]:h-5 [&>svg]:w-5',
      sm: 'h-11 w-11 rounded-xl [&>svg]:h-6 [&>svg]:w-6',
      lg: 'h-16 w-16 rounded-2xl [&>svg]:h-9 [&>svg]:w-9',
      xl: 'h-20 w-20 rounded-2xl [&>svg]:h-16 [&>svg]:w-16 [&>img]:h-16 [&>img]:w-16',
    },
    tint: {
      neutral: 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100',
    },
  },
  defaultVariants: { size: 'sm', tint: 'neutral' },
});

export type TileTint = 'neutral';

export interface IconTileProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof tile> {}

export function IconTile({ className, size, tint, ...props }: IconTileProps) {
  return <div className={cn(tile({ size, tint }), className)} {...props} />;
}

/**
 * A launcher tile with its caption — the unit Home's "Your saved apps" rail
 * and the app-picker are built from. The caption truncates to one line at the
 * tile's width, which is what makes a long name read as "GOAL! World…" rather
 * than wrapping and shoving the rail's baseline around.
 */
export function AppTile({
  label, tint, className, children, ...props
}: { label: React.ReactNode; tint?: TileTint } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('flex w-16 shrink-0 flex-col items-center gap-1.5', className)} {...props}>
      <IconTile size="lg" tint={tint}>{children}</IconTile>
      <span className="w-full truncate text-center text-[0.8125rem] text-zinc-900 dark:text-zinc-100">
        {label}
      </span>
    </div>
  );
}
