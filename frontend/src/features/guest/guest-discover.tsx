/**
 * The guest Discover: what a visitor with no account sees first
 * (features/auth/landing.tsx draws it under the story's short hero).
 *
 * WHAT CAN BE PLAYED COMES FIRST (21 Oct 2026 review): a visitor came to
 * try things, and one tap from the list to playing is what makes them stay.
 * Featured holds only projects a visitor can try (guest-data featuredApps),
 * every sort puts those first (sortApps' `tryable`), and each of their cards
 * carries Try it. Only the first eight (four on a phone) are big cards;
 * after them "More projects" is a list of rows, twelve at a time, so the top
 * is curated rather than everything listed evenly. Search and the kinds
 * still reach every project.
 *
 * A card says what the project is (its own description, else the last
 * change its group voted in), its counts only when they are big enough to
 * read as busy (guest-data MIN_MEMBERS, MIN_ACTIVE), else what changed
 * lately, and what is up for a vote, which opens the project's page at
 * its votes. A card opens the project's read-only page (./guest-project.tsx)
 * at the project's own address, `#app/<slug>/workshop`, which is also where
 * a person lands once they sign in from there. Nothing on a card is locked:
 * the page behind it is readable by anyone.
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

import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';

import { Chip, ChipRail } from '@/components/ui/chip';
import { GroupedList } from '@/components/ui/grouped-list';
import { BallotIcon, ChevronRightIcon, LightBulbIcon, PlusIcon, SearchIcon } from '@/components/ui/icons';
import { cn } from '@/lib/utils';

import { useMessages } from '../../lib/i18n/react';
import { useCommunityColor } from '../../lib/community-color';
import { agoStamp } from '../../lib/timestamp';
import { AppIconContent, appIconKind } from '../apps/app-card-view';
import {
  type GuestApp,
  type GuestSort,
  MIN_ACTIVE,
  MIN_BUILDERS,
  MIN_MEMBERS,
  SORTS,
  UPDATED_WITHIN_MS,
  buildersOf,
  canTryHere,
  featuredApps,
  inHomeroomApp,
  filterApps,
  presentCategories,
  projectHash,
  projectVotesHash,
  sortApps,
} from './guest-data';

/** The big cards before the list: two rows on a phone, two on a wide screen. */
const TOP_CARDS = 4;
const TOP_CARDS_WIDE = 8;
/** "More projects" shows this many rows at a time. */
const ROWS_STEP = 12;

/** A project made in the last 30 days wears "New". */
const NEW_FOR_MS = 30 * 24 * 60 * 60 * 1000;

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
 * it has beside the figure the list is sorted by, each only from its
 * minimum (guest-data MIN_MEMBERS, MIN_ACTIVE, MIN_BUILDERS): a public app's
 * median is one person active, and "1 person active" reads as a project
 * nobody uses. `activity`: what changed lately, how many changes went live
 * this week, else when the last one did, up to 30 days back. It takes the
 * fact's place when there is none. `votes`: what is up for a vote, in the
 * accent, since a visitor can take part in it once they join. A zero says
 * nothing.
 */
function useCardFacts(sort: GuestSort) {
  const t = useMessages('auth');
  return (app: GuestApp) => {
    const about = app.description || (app.latest_change ? t('auth:guest.card.latest', { title: app.latest_change }) : '');
    const builders = buildersOf(app);
    const active = app.active_users || 0;
    const figure = sort === 'new'
      ? (app.created_at ? t('auth:guest.card.made', { when: agoStamp(app.created_at).text }) : '')
      : sort === 'built'
        ? (builders >= MIN_BUILDERS ? t('auth:guest.card.builders', { count: builders }) : '')
        : (active >= MIN_ACTIVE ? t('auth:guest.card.active', { count: active }) : '');
    const members = (app.member_count || 0) >= MIN_MEMBERS ? t('auth:guest.card.members', { count: app.member_count }) : '';
    const fact = members && figure ? t('auth:guest.card.pair', { first: members, second: figure }) : members || figure;
    const votes = (app.open_votes || 0) > 0 ? t('auth:guest.card.votes', { count: app.open_votes }) : '';
    // A change the group voted in, not a redeploy: a project made an hour
    // ago was not "updated" an hour ago.
    const merged = app.last_merged_at ? Date.parse(app.last_merged_at) : NaN;
    const activity = (app.merged_week || 0) > 0
      ? t('auth:guest.card.week', { count: app.merged_week })
      : Number.isFinite(merged) && Date.now() - merged < UPDATED_WITHIN_MS
        ? t('auth:guest.card.updated', { when: agoStamp(app.last_merged_at as string).text })
        : '';
    return { about, fact, activity, votes };
  };
}

const FACT_LINE = 'block text-xs text-zinc-500 dark:text-zinc-400';

/** The lines under a card's name (useCardFacts). */
function CardFacts({ app, sort }: { app: GuestApp; sort: GuestSort }) {
  const { about, fact, activity, votes } = useCardFacts(sort)(app);
  // Two lines at most: the fact, else what changed lately; then what is up
  // for a vote, else what changed lately when the fact took the first.
  const second = votes ? null : fact ? activity : '';
  return (
    <>
      {about ? (
        <span data-guest-card-about="" className="line-clamp-2 block text-[13px] leading-[18px] text-zinc-500 dark:text-zinc-400">
          {about}
        </span>
      ) : null}
      {fact ? <span data-guest-card-fact="" className={cn('mt-1', FACT_LINE)}>{fact}</span> : null}
      {!fact && activity ? <span data-guest-card-activity="" className={cn('mt-1', FACT_LINE)}>{activity}</span> : null}
      {votes ? (
        <a
          href={projectVotesHash(app.slug)}
          data-guest-card-votes=""
          className="mt-0.5 block text-xs font-semibold text-violet-700 hover:underline dark:text-violet-400"
        >
          {votes}
        </a>
      ) : second ? (
        <span data-guest-card-activity="" className={cn('mt-0.5', FACT_LINE)}>{second}</span>
      ) : null}
    </>
  );
}

const TRY_SMALL = 'flex h-8 items-center justify-center rounded-full bg-black/5 px-3.5 text-sm font-semibold text-zinc-900 hover:bg-black/10 dark:bg-white/10 dark:text-zinc-100 dark:hover:bg-white/15';

/**
 * A big card. Its picture and its name open the project's page, its votes
 * line opens the page at its votes, and Try it opens the app: three links
 * side by side, never one inside another.
 */
function Card({ app, eager, sort, tryable, inside, onOpenInside }: {
  app: GuestApp;
  eager: boolean;
  sort: GuestSort;
  tryable: boolean;
  inside: boolean;
  onOpenInside: (app: GuestApp) => void;
}) {
  const t = useMessages('auth');
  return (
    <article data-guest-card={app.slug} className="flex min-w-0 flex-col gap-2">
      <a href={projectHash(app.slug)} tabIndex={-1} aria-hidden="true" className="relative block rounded-2xl outline-offset-4">
        <GuestCover app={app} className="aspect-[16/10] w-full rounded-2xl shadow-[inset_0_0_0_1px_var(--app-sheet-line)]" />
        {isNew(app) ? (
          <span className="absolute left-2 top-2 rounded-full bg-white px-2 py-0.5 text-xs font-bold text-zinc-950 dark:bg-zinc-900 dark:text-white">
            {t('auth:guest.card.new')}
          </span>
        ) : null}
      </a>
      <span className="flex min-w-0 items-start gap-2.5">
        {/* The icon is the picture already when the group chose none. On a
            phone's two narrow columns the words get the room instead. */}
        {app.illustration_url ? <span className="hidden md:block"><GuestIcon app={app} size="sm" eager={eager} /></span> : null}
        <span className="min-w-0 flex-1">
          <a href={projectHash(app.slug)} data-guest-card-link="" className="block truncate text-[15px] font-[650] text-zinc-900 outline-offset-4 dark:text-zinc-100">
            {app.name}
          </a>
          <CardFacts app={app} sort={sort} />
        </span>
      </span>
      {tryable ? (
        <TryLink app={app} inside={inside} onOpenInside={onOpenInside} className={cn(TRY_SMALL, 'self-start')}>
          <span aria-hidden="true">{t('auth:guest.card.tryIt')}</span>
          <span className="sr-only">{t('auth:guest.card.tryItLabel', { name: app.name })}</span>
        </TryLink>
      ) : null}
    </article>
  );
}

/**
 * A row of "More projects": the icon, the name and one line (the fact, else
 * what changed lately, else what is up for a vote, else what it is), then
 * Try it where the visitor can, else a chevron to its page.
 */
function MoreRow({ app, sort, tryable, inside, onOpenInside, last }: {
  app: GuestApp;
  sort: GuestSort;
  tryable: boolean;
  inside: boolean;
  onOpenInside: (app: GuestApp) => void;
  last: boolean;
}) {
  const t = useMessages('auth');
  const { about, fact, activity, votes } = useCardFacts(sort)(app);
  const line = fact || activity || votes || about;
  return (
    <div
      data-guest-row={app.slug}
      className={cn('flex min-h-[64px] items-center gap-3 px-3.5 py-2.5', last ? '' : 'shadow-[inset_0_-1px_0_var(--app-sheet-line)]')}
    >
      <a href={projectHash(app.slug)} className="flex min-w-0 flex-1 items-center gap-3 outline-offset-4">
        <GuestIcon app={app} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-[650] text-zinc-900 dark:text-zinc-100">{app.name}</span>
          {line ? (
            <span className={cn('block truncate text-[13px]', line === votes && !fact && !activity
              ? 'font-semibold text-violet-700 dark:text-violet-400'
              : 'text-zinc-500 dark:text-zinc-400')}
            >
              {line}
            </span>
          ) : null}
        </span>
      </a>
      {tryable ? (
        <TryLink app={app} inside={inside} onOpenInside={onOpenInside} className={cn(TRY_SMALL, 'shrink-0')}>
          <span aria-hidden="true">{t('auth:guest.card.tryIt')}</span>
          <span className="sr-only">{t('auth:guest.card.tryItLabel', { name: app.name })}</span>
        </TryLink>
      ) : (
        <ChevronRightIcon className="h-[18px] w-[18px] shrink-0 text-zinc-400 dark:text-zinc-500" aria-hidden="true" />
      )}
    </div>
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
export function TryLink({ app, className, onOpenInside, inside = false, children }: {
  app: GuestApp;
  className: string;
  onOpenInside: (app: GuestApp) => void;
  /** Open it in the landing's viewer whatever it needs: the visitor is signed in (a waitlisted account). */
  inside?: boolean;
  children: ReactNode;
}) {
  return (
    <a
      href={app.url}
      data-guest-try={app.slug}
      className={className}
      onClick={(e) => {
        if (inside || app.requires_login === false) {
          e.preventDefault();
          onOpenInside(app);
        }
      }}
    >
      {children}
    </a>
  );
}

function Featured({ app, primaryClass, inside, onOpenInside }: {
  app: GuestApp;
  primaryClass: string;
  inside: boolean;
  onOpenInside: (app: GuestApp) => void;
}) {
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
          <div className="min-w-0 flex-1">
            <a href={projectHash(app.slug)} className="block truncate text-[15px] font-[650] text-zinc-900 outline-offset-4 dark:text-zinc-100">
              {app.name}
            </a>
            <CardFacts app={app} sort="trending" />
          </div>
          {/* Featured holds only projects a visitor can try (featuredApps). */}
          <TryLink
            app={app}
            inside={inside}
            onOpenInside={onOpenInside}
            className={cn(primaryClass, 'h-9 w-auto shrink-0 px-4 text-sm')}
          >
            <span aria-hidden="true">{t('auth:guest.card.tryIt')}</span>
            <span className="sr-only">{t('auth:guest.card.tryItLabel', { name: app.name })}</span>
          </TryLink>
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

function CardGrid({ apps, sort, tryable, inside, onOpenInside }: {
  apps: GuestApp[];
  sort: GuestSort;
  tryable: (app: GuestApp) => boolean;
  inside: boolean;
  onOpenInside: (app: GuestApp) => void;
}) {
  if (!apps.length) return null;
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-3 gap-y-[18px] md:grid-cols-[repeat(auto-fill,minmax(220px,1fr))]">
      {apps.map((app, i) => (
        <Card key={app.slug} app={app} sort={sort} eager={i < 4} tryable={tryable(app)} inside={inside} onOpenInside={onOpenInside} />
      ))}
    </div>
  );
}

export function GuestDiscover({ apps, failed, hero, primaryClass, waitlist, onContinue, onOpenInside, signedIn = false }: {
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
  /** Open an app in the landing's own viewer. */
  onOpenInside: (app: GuestApp) => void;
  /**
   * A waitlisted account is looking (landing.tsx): it is signed in, so
   * every public project opens for it in the landing's viewer, and nothing
   * here asks it to sign up.
   */
  signedIn?: boolean;
}) {
  const t = useMessages('auth');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [sort, setSort] = useState<GuestSort>('trending');
  const [joinDismissed, setJoinDismissed] = useState(false);

  const [rowsShown, setRowsShown] = useState(ROWS_STEP);

  const all = apps || [];
  const kinds = useMemo(() => presentCategories(all), [all]);
  const browsing = !query.trim() && !category;
  const inApp = inHomeroomApp();
  const tryable = useCallback((app: GuestApp) => signedIn || canTryHere(app, inApp), [signedIn, inApp]);
  const featured = useMemo(() => (browsing ? featuredApps(all, tryable) : []), [all, browsing, tryable]);
  const list = useMemo(() => {
    const above = new Set(featured.map((a) => a.slug));
    return sortApps(filterApps(all, query, category), sort, tryable).filter((a) => !above.has(a.slug));
  }, [all, query, category, sort, tryable, featured]);
  useEffect(() => { setRowsShown(ROWS_STEP); }, [query, category, sort]);
  const showJoin = browsing && !signedIn && !joinDismissed && !!apps && list.length > 0;
  const wide = typeof window !== 'undefined' && window.matchMedia?.('(min-width: 768px)').matches;
  const top = list.slice(0, wide ? TOP_CARDS_WIDE : TOP_CARDS);
  const more = list.slice(top.length);
  const rows = more.slice(0, rowsShown);

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
              {featured.map((app) => (
                <Featured key={app.slug} app={app} primaryClass={primaryClass} inside={signedIn} onOpenInside={onOpenInside} />
              ))}
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
          <CardGrid apps={top} sort={sort} tryable={tryable} inside={signedIn} onOpenInside={onOpenInside} />
          {showJoin ? (
            <JoinIn
              primaryClass={primaryClass}
              waitlist={waitlist}
              onContinue={onContinue}
              onDismiss={() => setJoinDismissed(true)}
            />
          ) : null}
          {rows.length ? (
            <div data-guest-more="" className="flex flex-col gap-2.5">
              <h2 className={SMALL_CAPS_LABEL}>{t('auth:guest.more')}</h2>
              <GroupedList className="mx-0">
                {rows.map((app, i) => (
                  <MoreRow
                    key={app.slug}
                    app={app}
                    sort={sort}
                    tryable={tryable(app)}
                    inside={signedIn}
                    onOpenInside={onOpenInside}
                    last={i === rows.length - 1}
                  />
                ))}
              </GroupedList>
              {more.length > rows.length ? (
                <button
                  type="button"
                  data-guest-show-more=""
                  className="h-10 self-center rounded-full bg-white px-5 text-[15px] font-semibold text-zinc-900 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
                  onClick={() => setRowsShown((n) => n + ROWS_STEP)}
                >
                  {t('auth:guest.showMore')}
                </button>
              ) : null}
            </div>
          ) : null}
          {apps && !list.length ? (
            <p className="py-6 text-center text-[15px] text-zinc-500 dark:text-zinc-400">{t('auth:guest.empty')}</p>
          ) : null}
        </section>
      </div>
    </div>
  );
}
