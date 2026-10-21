/**
 * The guest Discover: what a visitor with no account sees first
 * (features/auth/landing.tsx draws it under the story's short hero).
 *
 * Every public project, as a card with its picture, icon and name, what it
 * is (its own description, else the last change its group voted in), how
 * many members it has beside the figure the list is sorted by (people
 * active, when it was made, how many build it), and what is up for a vote
 * or when it last changed. A card opens the
 * project's read-only page (./guest-project.tsx) at the project's own
 * address, `#app/<slug>/workshop`, which is also where a person lands once
 * they sign in from there. Nothing on a card is locked: the page behind it
 * is readable by anyone, and only that page's "Try it" says whether the app
 * itself needs an account yet (`guest_ready`, src/services/shell-probe.js).
 * The landing's old grid was taken away because 36 of its 41 tiles were
 * locked (docs/superpowers/specs/2026-09-18-logged-out-screens-design.md);
 * a page to read behind every card is what makes a grid worth having again.
 *
 * Above the grid: a search, the kinds of app the directory has, a row of
 * what an admin featured, and a sort. Partway down, one card says what an
 * account adds ("Want to join in?"), with a way to say not now. Ways in are
 * asked for where somebody wants to do something (the project page's Join,
 * Vote, Ask), never as a wall.
 */

import { type ReactNode, useMemo, useState } from 'react';

import { Chip, ChipRail } from '@/components/ui/chip';
import { BallotIcon, LightBulbIcon, PlusIcon, SearchIcon } from '@/components/ui/icons';
import { cn } from '@/lib/utils';

import { useMessages } from '../../lib/i18n/react';
import { useCommunityColor } from '../../lib/community-color';
import { agoStamp } from '../../lib/timestamp';
import { AppIconContent, appIconKind } from '../apps/app-card-view';
import {
  type GuestApp,
  type GuestSort,
  SORTS,
  buildersOf,
  featuredApps,
  filterApps,
  presentCategories,
  projectHash,
  sortApps,
} from './guest-data';

/** The cards above the "Want to join in?" card: two rows on a phone, two on a desktop. */
const FIRST_CARDS = 6;
const FIRST_CARDS_WIDE = 8;

/** A project made in the last two weeks wears "New". */
const NEW_FOR_MS = 14 * 24 * 60 * 60 * 1000;

export const SMALL_CAPS_LABEL = 'text-xs font-bold uppercase tracking-[0.06em] text-zinc-500 dark:text-zinc-400';

function isNew(app: GuestApp, now = Date.now()): boolean {
  const t = app.created_at ? Date.parse(app.created_at) : NaN;
  return Number.isFinite(t) && now - t < NEW_FOR_MS;
}

/** The app's icon, in the tile Discover's rows draw (app-card-view.tsx). */
export function GuestIcon({ app, size = 'md', eager = false }: { app: GuestApp; size?: 'sm' | 'md' | 'lg' | 'xl'; eager?: boolean }) {
  const box = size === 'xl'
    ? 'w-20 h-20 rounded-[22px] text-4xl shadow-[0_6px_20px_rgba(0,0,0,0.18)]'
    : size === 'lg'
    ? 'w-16 h-16 rounded-2xl text-2xl shadow-[0_4px_14px_rgba(0,0,0,0.16)]'
    : size === 'sm' ? 'w-8 h-8 rounded-lg text-sm' : 'w-11 h-11 rounded-xl text-lg';
  return (
    <span
      className={cn('app-icon-tile shrink-0 overflow-hidden flex items-center justify-center font-bold', box)}
      data-icon={appIconKind(app)}
      aria-hidden="true"
    >
      <AppIconContent app={app} eager={eager} />
    </span>
  );
}

/**
 * A project's picture: the one its group chose for its Discover card
 * (`illustration_url`, its dark twin in the dark theme), else its icon large
 * on its own colour (lib/community-color.ts).
 */
export function GuestCover({ app, className, iconSize = 'lg' }: { app: GuestApp; className?: string; iconSize?: 'lg' | 'xl' }) {
  const color = useCommunityColor({ color: app.icon_color, iconUrl: app.icon_url, iconEmoji: app.icon_emoji, key: app.slug });
  if (app.illustration_url) {
    return (
      <span className={cn('relative block overflow-hidden bg-zinc-200 dark:bg-zinc-800', className)}>
        <img
          src={app.illustration_url}
          alt=""
          loading="lazy"
          draggable={false}
          className={cn('h-full w-full object-cover', app.illustration_dark_url ? 'dark:hidden' : '')}
        />
        {app.illustration_dark_url ? (
          <img src={app.illustration_dark_url} alt="" loading="lazy" draggable={false} className="hidden h-full w-full object-cover dark:block" />
        ) : null}
      </span>
    );
  }
  return (
    <span className={cn('relative flex items-center justify-center overflow-hidden', className)} style={{ background: color }}>
      <GuestIcon app={app} size={iconSize} />
    </span>
  );
}

/**
 * What a card says under the project's name. `about`: what it is, in its own
 * words, else the last change its group voted in. `fact`: how many members
 * it has, beside the figure the list is sorted by, so the number a card was
 * ranked by is the number it shows (as Discover's rows do,
 * features/apps/browse.js metaLine). `votes`: what is up for a vote, in the
 * accent, since a visitor can take part in it once they join; else
 * `updated`, when the last change its group voted in went live. A zero
 * says nothing.
 */
function useCardFacts(sort: GuestSort) {
  const t = useMessages('auth');
  return (app: GuestApp) => {
    const about = app.description || (app.latest_change ? t('auth:guest.card.latest', { title: app.latest_change }) : '');
    const builders = buildersOf(app);
    const figure = sort === 'new'
      ? (app.created_at ? t('auth:guest.card.made', { when: agoStamp(app.created_at).text }) : '')
      : sort === 'built'
        ? (builders > 0 ? t('auth:guest.card.builders', { count: builders }) : '')
        : ((app.active_users || 0) > 0 ? t('auth:guest.card.active', { count: app.active_users }) : '');
    const members = (app.member_count || 0) > 0 ? t('auth:guest.card.members', { count: app.member_count }) : '';
    const fact = members && figure ? t('auth:guest.card.pair', { first: members, second: figure }) : members || figure;
    const votes = (app.open_votes || 0) > 0 ? t('auth:guest.card.votes', { count: app.open_votes }) : '';
    // A change the group voted in, not a redeploy: a project made an hour
    // ago was not "updated" an hour ago.
    const updated = !votes && app.last_merged_at ? t('auth:guest.card.updated', { when: agoStamp(app.last_merged_at).text }) : '';
    return { about, fact, votes, updated };
  };
}

/** The lines under a card's name (useCardFacts). */
function CardFacts({ app, sort }: { app: GuestApp; sort: GuestSort }) {
  const { about, fact, votes, updated } = useCardFacts(sort)(app);
  return (
    <>
      {about ? (
        <span data-guest-card-about="" className="line-clamp-2 block text-[13px] leading-[18px] text-zinc-500 dark:text-zinc-400">
          {about}
        </span>
      ) : null}
      {fact ? <span data-guest-card-fact="" className="mt-1 block text-xs text-zinc-500 dark:text-zinc-400">{fact}</span> : null}
      {votes ? (
        <span data-guest-card-votes="" className="mt-0.5 block text-xs font-semibold text-violet-700 dark:text-violet-400">{votes}</span>
      ) : updated ? (
        <span data-guest-card-updated="" className="mt-0.5 block text-xs text-zinc-500 dark:text-zinc-400">{updated}</span>
      ) : null}
    </>
  );
}

function Card({ app, eager, sort }: { app: GuestApp; eager: boolean; sort: GuestSort }) {
  const t = useMessages('auth');
  return (
    <a
      href={projectHash(app.slug)}
      data-guest-card={app.slug}
      className="group flex min-w-0 flex-col gap-2 rounded-[20px] outline-offset-4"
    >
      <span className="relative block">
        <GuestCover app={app} className="aspect-[16/10] w-full rounded-2xl shadow-[inset_0_0_0_1px_var(--app-sheet-line)]" />
        {isNew(app) ? (
          <span className="absolute left-2 top-2 rounded-full bg-white px-2 py-0.5 text-xs font-bold text-zinc-950 dark:bg-zinc-900 dark:text-white">
            {t('auth:guest.card.new')}
          </span>
        ) : null}
      </span>
      <span className="flex min-w-0 items-start gap-2.5">
        {/* The icon is the picture already when the group chose none. On a
            phone's two narrow columns the words get the room instead. */}
        {app.illustration_url ? <span className="hidden md:block"><GuestIcon app={app} size="sm" eager={eager} /></span> : null}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-[650] text-zinc-900 dark:text-zinc-100">{app.name}</span>
          <CardFacts app={app} sort={sort} />
        </span>
      </span>
    </a>
  );
}

/**
 * "Try it", where the app has a view for somebody with no account, else a
 * way to read about it. An app that answers a visitor with no credential at
 * all opens in the landing's own viewer, inside Homeroom; one that answers a
 * guest opens at its own address, where the app host gives the visitor a
 * guest's view, the "You're looking around" strip and "Make an account to
 * continue" (src/services/edge-gate.js, public/usernode-bridge.js).
 */
export function TryLink({ app, className, onOpenInside, children }: {
  app: GuestApp;
  className: string;
  onOpenInside: (app: GuestApp) => void;
  children: ReactNode;
}) {
  return (
    <a
      href={app.url}
      data-guest-try={app.slug}
      className={className}
      onClick={(e) => {
        if (app.requires_login === false) {
          e.preventDefault();
          onOpenInside(app);
        }
      }}
    >
      {children}
    </a>
  );
}

function Featured({ app, primaryClass, onOpenInside }: { app: GuestApp; primaryClass: string; onOpenInside: (app: GuestApp) => void }) {
  const t = useMessages('auth');
  return (
    <article
      data-guest-featured={app.slug}
      className="flex w-[296px] shrink-0 snap-start flex-col overflow-hidden rounded-[20px] bg-white shadow-[inset_0_0_0_1px_var(--app-sheet-line)] md:w-[360px] dark:bg-zinc-900"
    >
      <a href={projectHash(app.slug)} tabIndex={-1} aria-hidden="true" className="block">
        <GuestCover app={app} className="aspect-[16/10] w-full" iconSize="xl" />
      </a>
      <div className="flex flex-1 flex-col gap-2.5 p-3.5">
        <div className="flex items-start gap-3">
          {app.illustration_url ? <GuestIcon app={app} eager /> : null}
          <a href={projectHash(app.slug)} className="min-w-0 flex-1">
            <span className="block truncate text-[15px] font-[650] text-zinc-900 dark:text-zinc-100">{app.name}</span>
            <CardFacts app={app} sort="trending" />
          </a>
          {app.guest_ready ? (
            <TryLink
              app={app}
              onOpenInside={onOpenInside}
              className={cn(primaryClass, 'h-9 w-auto shrink-0 px-4 text-sm')}
            >
              <span aria-hidden="true">{t('auth:guest.card.tryIt')}</span>
              <span className="sr-only">{t('auth:guest.card.tryItLabel', { name: app.name })}</span>
            </TryLink>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function JoinIn({ onContinue, onDismiss, primaryClass, waitlist }: {
  onContinue: () => void;
  onDismiss: () => void;
  primaryClass: string;
  waitlist: boolean;
}) {
  const t = useMessages('auth');
  const points: { icon: ReactNode; title: string; body: string }[] = [
    { icon: <BallotIcon className="h-[18px] w-[18px]" />, title: t('auth:guest.join.vote.title'), body: t('auth:guest.join.vote.body') },
    { icon: <LightBulbIcon className="h-[18px] w-[18px]" />, title: t('auth:guest.join.ask.title'), body: t('auth:guest.join.ask.body') },
    { icon: <PlusIcon className="h-[18px] w-[18px]" />, title: t('auth:guest.join.make.title'), body: t('auth:guest.join.make.body') },
  ];
  return (
    <aside data-guest-join="" className="flex flex-col gap-3.5 rounded-[20px] bg-white p-[18px] shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900">
      <h2 className="text-[17px] font-bold text-zinc-950 dark:text-white">{t('auth:guest.join.title')}</h2>
      <ul className="flex flex-wrap gap-x-6 gap-y-3.5">
        {points.map((p) => (
          <li key={p.title} className="flex min-w-[240px] flex-1 items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-violet-50 text-violet-700 dark:bg-violet-950 dark:text-violet-300" aria-hidden="true">
              {p.icon}
            </span>
            <span>
              <span className="block text-[15px] font-[650] text-zinc-900 dark:text-zinc-100">{p.title}</span>
              <span className="block text-[13px] leading-[18px] text-zinc-500 dark:text-zinc-400">{p.body}</span>
            </span>
          </li>
        ))}
      </ul>
      {waitlist ? (
        <p className="text-[13px] leading-[18px] text-zinc-500 dark:text-zinc-400">{t('auth:guest.join.waitlist')}</p>
      ) : null}
      <div className="flex items-center gap-2">
        <button type="button" data-guest-join-continue="" className={cn(primaryClass, 'h-11 w-auto px-5 text-[15px]')} onClick={onContinue}>
          {t('auth:guest.join.signUp')}
        </button>
        <button
          type="button"
          className="h-11 rounded-full px-4 text-[15px] font-semibold text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
          onClick={onDismiss}
        >
          {t('auth:guest.join.notNow')}
        </button>
      </div>
    </aside>
  );
}

function SortControl({ sort, onSort }: { sort: GuestSort; onSort: (s: GuestSort) => void }) {
  const t = useMessages('auth');
  const label: Record<GuestSort, string> = {
    trending: t('auth:guest.sort.trending'),
    new: t('auth:guest.sort.new'),
    built: t('auth:guest.sort.built'),
  };
  return (
    <div role="group" aria-label={t('auth:guest.sort.label')} className="flex rounded-full bg-black/5 p-[3px] dark:bg-white/10">
      {SORTS.map((s) => (
        <button
          key={s}
          type="button"
          aria-pressed={s === sort}
          data-guest-sort={s}
          onClick={() => onSort(s)}
          className={cn(
            'h-8 rounded-full px-3 text-[13px] font-semibold',
            s === sort
              ? 'bg-white text-zinc-950 shadow-sm dark:bg-zinc-800 dark:text-white'
              : 'text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200',
          )}
        >
          {label[s]}
        </button>
      ))}
    </div>
  );
}

function CardGrid({ apps, eagerFirst, sort }: { apps: GuestApp[]; eagerFirst: boolean; sort: GuestSort }) {
  if (!apps.length) return null;
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-3 gap-y-[18px] md:grid-cols-[repeat(auto-fill,minmax(220px,1fr))]">
      {apps.map((app, i) => <Card key={app.slug} app={app} sort={sort} eager={eagerFirst && i < 4} />)}
    </div>
  );
}

export function GuestDiscover({ apps, failed, hero, primaryClass, waitlist, onContinue, onOpenInside }: {
  /** The public directory, or null while it loads. */
  apps: GuestApp[] | null;
  /** The directory could not be read. */
  failed: boolean;
  /** The story's short version, above everything (features/auth/story.tsx). */
  hero: ReactNode;
  primaryClass: string;
  /** Say that new accounts start on the waitlist. */
  waitlist: boolean;
  /** The sign-in sheet, as the story's Continue opens it. */
  onContinue: () => void;
  /** Open an app that needs no account at all in the landing's own viewer. */
  onOpenInside: (app: GuestApp) => void;
}) {
  const t = useMessages('auth');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [sort, setSort] = useState<GuestSort>('trending');
  const [joinDismissed, setJoinDismissed] = useState(false);

  const all = apps || [];
  const kinds = useMemo(() => presentCategories(all), [all]);
  const browsing = !query.trim() && !category;
  const featured = useMemo(() => (browsing ? featuredApps(all) : []), [all, browsing]);
  const list = useMemo(() => sortApps(filterApps(all, query, category), sort), [all, query, category, sort]);
  const showJoin = browsing && !joinDismissed && !!apps && list.length > 0;
  const wide = typeof window !== 'undefined' && window.matchMedia?.('(min-width: 768px)').matches;
  const first = showJoin ? list.slice(0, wide ? FIRST_CARDS_WIDE : FIRST_CARDS) : list;
  const rest = showJoin ? list.slice(first.length) : [];

  return (
    <div data-guest-discover="" className="flex flex-col gap-5">
      {hero}
      <div className="flex flex-col gap-5 px-4">
        <label className="flex h-11 items-center gap-2 rounded-[14px] bg-white px-3.5 text-zinc-400 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900 dark:text-zinc-500">
          <SearchIcon className="h-[18px] w-[18px] shrink-0" />
          <input
            type="search"
            data-guest-search=""
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('auth:guest.search.placeholder')}
            aria-label={t('auth:guest.search.label')}
            className="min-w-0 flex-1 bg-transparent text-base text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100 dark:placeholder:text-zinc-500"
          />
        </label>

        {kinds.length ? (
          <ChipRail role="group" aria-label={t('auth:guest.categories.label')} className="-mx-4 -my-2 gap-2">
            <Chip size="bar" selected={!category} data-guest-category="all" onClick={() => setCategory(null)}>
              {t('auth:guest.category.all')}
            </Chip>
            {kinds.map((k) => (
              <Chip key={k} size="bar" selected={category === k} data-guest-category={k} onClick={() => setCategory(category === k ? null : k)}>
                {t(`auth:guest.category.${k}`)}
              </Chip>
            ))}
          </ChipRail>
        ) : null}

        {featured.length ? (
          <section className="flex flex-col gap-2.5">
            <h2 className={SMALL_CAPS_LABEL}>{t('auth:guest.featured')}</h2>
            <div className="-mx-4 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-1.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {featured.map((app) => <Featured key={app.slug} app={app} primaryClass={primaryClass} onOpenInside={onOpenInside} />)}
            </div>
          </section>
        ) : null}

        <section className="flex flex-col gap-3" aria-busy={apps ? undefined : true}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className={SMALL_CAPS_LABEL}>{browsing ? t('auth:guest.all') : t('auth:guest.results')}</h2>
            <SortControl sort={sort} onSort={setSort} />
          </div>
          {!apps && !failed ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3 md:grid-cols-[repeat(auto-fill,minmax(220px,1fr))]" aria-label={t('auth:guest.loading')}>
              {[0, 1, 2, 3].map((i) => <span key={i} className="aspect-[16/10] rounded-2xl bg-black/5 dark:bg-white/10" />)}
            </div>
          ) : null}
          {failed ? <p className="py-6 text-center text-[15px] text-zinc-500 dark:text-zinc-400">{t('auth:guest.loadFailed')}</p> : null}
          <CardGrid apps={first} sort={sort} eagerFirst />
          {showJoin ? (
            <JoinIn
              primaryClass={primaryClass}
              waitlist={waitlist}
              onContinue={onContinue}
              onDismiss={() => setJoinDismissed(true)}
            />
          ) : null}
          <CardGrid apps={rest} sort={sort} eagerFirst={false} />
          {apps && !list.length ? (
            <p className="py-6 text-center text-[15px] text-zinc-500 dark:text-zinc-400">{t('auth:guest.empty')}</p>
          ) : null}
        </section>
      </div>
    </div>
  );
}
