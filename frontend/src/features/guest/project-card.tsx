/**
 * THE PROJECT CARD: one card for people still deciding (the hand-off of
 * 11 Nov 2026). It is the hero of a project's hub for somebody signed in who
 * has not joined (../dev-board/workshop/community-card.tsx) and the head of
 * the signed-out project page (./guest-project.tsx); only its buttons
 * differ, and the caller hands them in. Once somebody has joined, the hub
 * goes back to its own hero: the card is for deciding, not for every visit.
 *
 *   - It wears the project's colour (lib/community-color.ts): the hub's
 *     `--community-tint`, the guest page's own reading of the icon.
 *   - Its picture leads (ProjectPreview): the project's preview loop where
 *     its group voted one in, playing on its own with a pause button and
 *     "Preview of the real app"; a still under reduced motion, Data Saver or
 *     "Play previews" off (lib/card-previews.ts previewsAllowed). Without a
 *     loop it is the featured illustration, and without that the icon on
 *     the project's colour, the same picture Discover's card shows
 *     (./guest-discover.tsx GuestCover).
 *   - Beside it, or under it on a narrow column: the tile, the name, what
 *     the project says it is (two lines at most), then the buttons.
 *
 * Under it, the people card (PeopleCard): who is around. The hub fills it
 * with faces and names, which a signed-in viewer already reads there; the
 * signed-out page with counts only, because the public overview carries no
 * names (src/services/public-project.js).
 *
 * THE ISLAND RULES. The first render is the still and nothing else: the
 * video mounts after the island does, so the prerender and the first client
 * render agree, nothing is fetched until it may play, and a loop that fails
 * leaves the still with nothing on the console.
 */

import { type ReactNode, type Ref, useEffect, useRef, useState } from 'react';

import { PauseIcon, PlayIcon } from '@/components/ui/icons';
import { cn } from '@/lib/utils';

import { useMessages } from '../../lib/i18n/react';
import { markPreviewFailed, onPreviewsPref, previewFailed, previewsAllowed } from '../../lib/card-previews';
import { GuestIcon } from './guest-discover';
import type { GuestApp } from './guest-data';

/** The picture a project's card can show: what its group voted in. */
export interface ProjectCover {
  illustration_url?: string | null;
  illustration_dark_url?: string | null;
  preview_url?: string | null;
}

/** Which page the card heads: the hub's 760px column, or the wider signed-out page. */
export type ProjectCardPlace = 'hub' | 'guest';

/** The card's three kinds of button, shared by both pages' callers. */
export const CARD_OPEN_BTN = 'flex h-[50px] min-w-0 flex-1 items-center justify-center gap-2 rounded-full bg-white px-3 text-[17px] font-bold text-zinc-950 hover:bg-zinc-100 md:h-[52px] md:px-5';
export const CARD_GLASS_BTN = 'flex h-[50px] shrink-0 items-center justify-center rounded-full bg-white/15 px-4 text-[17px] font-bold text-white hover:bg-white/25 md:h-[52px] md:px-5';
export const CARD_ROUND_BTN = 'flex h-[50px] w-[50px] shrink-0 items-center justify-center rounded-full bg-white/15 text-white hover:bg-white/25 md:h-[52px] md:w-[52px]';
/** Join in the accent: the Button primitive's pillAccent, at the card's height. */
export const CARD_JOIN_SIZE = 'h-[50px] shrink-0 px-5 text-[17px] font-bold md:h-[52px] md:px-6';

/** The white card under it, the GroupedList values: 20px, one hairline. */
export const PEOPLE_CARD = 'rounded-[20px] bg-white shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900';

/**
 * The card's picture, 16:10. A loop plays over the still once the island has
 * mounted and only where previews may play; the pause button stops it and
 * plays it again. Anything that goes wrong with the loop leaves the still.
 */
export function ProjectPreview({ app, cover, hero = false }: {
  app: GuestApp;
  cover: ProjectCover | null | undefined;
  /** The picture a Discover card grows into as the page opens (./card-morph.ts). */
  hero?: boolean;
}) {
  const t = useMessages('auth');
  const src = cover?.preview_url || null;
  const still = cover?.illustration_url || null;
  const dark = cover?.illustration_dark_url || null;
  const video = useRef<HTMLVideoElement>(null);
  // Mounted after the first render, so the prerender is the still alone.
  const [canPlay, setCanPlay] = useState(false);
  const [paused, setPaused] = useState(false);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const read = () => setCanPlay(!!src && previewsAllowed() && !previewFailed(src));
    read();
    return onPreviewsPref(read);
  }, [src]);
  useEffect(() => {
    const v = video.current;
    if (!canPlay || !v) return;
    v.muted = true;
    if (paused) { v.pause(); return; }
    try {
      const played = v.play();
      if (played && typeof played.catch === 'function') played.catch(() => setPaused(true));
    } catch { setPaused(true); }
  }, [canPlay, paused]);
  return (
    <div data-project-preview="" data-guest-hero={hero ? '' : undefined} className="relative aspect-[16/10] overflow-hidden rounded-2xl bg-black/15">
      {still ? (
        <>
          <img src={still} alt="" draggable={false} className={cn('absolute inset-0 h-full w-full object-cover', dark ? 'dark:hidden' : '')} />
          {dark ? <img src={dark} alt="" draggable={false} className="absolute inset-0 hidden h-full w-full object-cover dark:block" /> : null}
        </>
      ) : (
        <span className="absolute inset-0 flex items-center justify-center bg-white/10">
          <GuestIcon app={app} size="xl" eager />
        </span>
      )}
      {canPlay && src ? (
        <>
          <video
            ref={video}
            src={src}
            poster={still || undefined}
            muted
            loop
            playsInline
            autoPlay
            preload="auto"
            tabIndex={-1}
            disablePictureInPicture
            aria-hidden="true"
            data-project-preview-video=""
            className={cn('absolute inset-0 h-full w-full object-cover transition-opacity duration-200 motion-reduce:transition-none', shown ? 'opacity-100' : 'opacity-0')}
            onPlaying={() => setShown(true)}
            onError={() => { markPreviewFailed(src); setCanPlay(false); }}
          />
          <div className="absolute bottom-2.5 start-2.5 flex items-center gap-1.5">
            <button
              type="button"
              data-project-preview-pause=""
              aria-pressed={paused}
              aria-label={paused ? t('auth:guest.project.card.play') : t('auth:guest.project.card.pause')}
              className="flex h-11 w-11 items-center justify-center rounded-full bg-zinc-950/75 text-white hover:bg-zinc-950/90"
              onClick={() => setPaused((p) => !p)}
            >
              {paused ? <PlayIcon className="h-4 w-4" aria-hidden="true" /> : <PauseIcon className="h-4 w-4" strokeWidth="3" aria-hidden="true" />}
            </button>
            <span className="rounded-full bg-zinc-950/75 px-2.5 py-1 text-[12px] font-bold text-white">{t('auth:guest.project.card.previewLabel')}</span>
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * The card itself. `actions` is one row of buttons (Open, Join, ⋯ or Share),
 * the first growing to fill; `note` hangs under them.
 */
export function ProjectCard({ place, app, cover, color, description, actions, note = null, headingLevel = 1, cardRef, ...data }: {
  place: ProjectCardPlace;
  /** The project's identity: its slug, name and icon. */
  app: GuestApp;
  cover: ProjectCover | null | undefined;
  /** The project's colour, or a CSS value that resolves to it. */
  color: string;
  description?: string | null;
  actions: ReactNode;
  note?: ReactNode;
  /** The page's one large heading by default. */
  headingLevel?: 1 | 2;
  cardRef?: Ref<HTMLElement>;
} & { [key: `data-${string}`]: string | undefined }) {
  const Heading = headingLevel === 1 ? 'h1' : 'h2';
  return (
    <section
      ref={cardRef}
      data-project-card={place}
      {...data}
      className="flex flex-wrap items-center gap-x-5 gap-y-4 rounded-[22px] p-2.5 text-white md:rounded-3xl md:p-4"
      style={{ background: color }}
    >
      <div className="min-w-0 flex-[1.15_1_340px]">
        <ProjectPreview app={app} cover={cover} hero={place === 'guest'} />
      </div>
      <div className="flex min-w-0 flex-[1_1_280px] flex-col gap-3 px-1.5 pb-1.5 md:px-0 md:pb-0">
        <div className="flex min-w-0 items-center gap-3">
          <span className="shrink-0 rounded-2xl shadow-[0_0_0_3px_#fff]"><GuestIcon app={app} size="lg" eager /></span>
          <Heading
            data-project-card-name=""
            className={cn(
              'min-w-0 font-extrabold leading-[1.1] tracking-[-0.02em] [overflow-wrap:anywhere]',
              place === 'guest' ? 'text-[26px] md:text-[34px]' : 'text-[26px] md:text-[30px]',
            )}
          >
            {app.name}
          </Heading>
        </div>
        {description ? (
          <p data-project-card-description="" className="line-clamp-2 text-[17px] leading-[24px] text-white/90 md:text-[18px] md:leading-[26px]">
            {description}
          </p>
        ) : null}
        <div data-project-card-actions="" className="mt-1 flex min-w-0 items-center gap-2">{actions}</div>
        {note}
      </div>
    </section>
  );
}

/**
 * Who is around, in a white card of its own under the project card. On a
 * wide window one row, the audience at its far end; on a phone the audience
 * goes under the rest.
 */
export function PeopleCard({ children, audience, ...data }: {
  children?: ReactNode;
  audience?: ReactNode;
} & { [key: `data-${string}`]: string | undefined }) {
  if (!children && !audience) return null;
  return (
    <div {...data} className={cn(PEOPLE_CARD, 'flex flex-wrap items-center gap-x-4 gap-y-2.5 px-3.5 py-3 md:px-4')}>
      {children ? <div className="flex min-w-0 flex-1 items-center gap-3">{children}</div> : null}
      {audience ? <div className="w-full min-w-0 text-[13px] text-zinc-500 md:ms-auto md:w-auto md:shrink-0 dark:text-zinc-400">{audience}</div> : null}
    </div>
  );
}
