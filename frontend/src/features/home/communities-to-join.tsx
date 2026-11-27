/**
 * COMMUNITIES TO JOIN (One Home, #6361): the bottom of Home, signed in or
 * out. It is the signed-out directory's picture card (features/guest Card,
 * GuestCover), so the page a visitor browses before signing up is the page
 * they land on after. A card is the same either way (#6609): its picture,
 * one count, its name and its sentence, with no footer and no Join. The
 * whole card opens the project's page, where Join already sits next to what
 * the community is about; joining there takes the community off this list
 * (sv:membership-changed).
 *
 * Every card is the community card (../communities/card.tsx, approved 20
 * Nov 2026: "use this style everywhere"), on its grid: four across where
 * four fit (`.cm-grid`, the Communities page's Pinned columns), two across
 * on a phone.
 *
 * Kind chips over the cards, fading at whichever edge has more chips past it
 * so the row is never just cut off (the same rail as the AI page's project
 * chips). Then FEATURED, the communities an admin featured, in their order
 * (featured_order), its first row LARGER, signed in or out ("first row of
 * featured larger everywhere"): one fewer than a row of the rest holds,
 * three on a laptop, the whole width on a phone (`useLeadCount`), and the
 * rest of Featured in the grid under it. The signed-in pages show at most
 * FEATURED_MAX of them, so the grid ends on a full row; a featured
 * community past it is not hidden, it joins the list below (#7229).
 * Featured is the first group of the section, of the chosen kind, and left
 * out while a search is typed (its matches are the grid, featured first).
 * Its heading names the chosen kind ("Featured in Games") so the group reads
 * as that kind's. Then the rest under "More communities" whenever Featured
 * is shown, under All or
 * a chosen kind (#6584, #6597): every community of the kind that Featured
 * does not already show, in the sort picked beside that heading (New,
 * Popular, Most active, Most played, Most hearts or A to Z; most active
 * until somebody picks another),
 * so no
 * community appears twice. The heading tells the rest apart from Featured;
 * when every community of the kind is featured there is nothing left and
 * it is not drawn. No heading while searching, or with nothing featured:
 * then there is one grid, and the sort sits on its own line above it. More
 * load as the reader reaches the end (an IntersectionObserver on the last
 * card's sentinel, inside Home's own scroller), with two
 * placeholder cards while they come. The directory is
 * GET /api/public/apps, which answers every public project at once today,
 * so "more" pages through it here.
 */
import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Chip, FadeRail } from '@/components/ui/chip';
import { Select } from '@/components/ui/select';

import { useMessages } from '../../lib/i18n/react';
import { CommunityCardSkeleton, LEAD_MAX, useLeadCount } from '../communities/card';
import { Card, SMALL_CAPS_LABEL } from '../guest/guest-discover';
import { featuredApps, presentCategories, sortApps, type GuestApp, type GuestSort } from '../guest/guest-data';
import { SectionHeading } from './panels/ui';
import { rankCommunities } from './use-home-query';

/** How many cards a page brings. */
export const JOIN_PAGE = 8;

/**
 * How many featured communities the signed-in pages draw (#7229): three
 * across on a desktop, two on a phone (app.css `.cm-grid`, ONE LOOK), so six
 * always ends on a full row. A seventh, and any after it, joins the list
 * under Communities to join rather than sitting alone on an empty row.
 */
export const FEATURED_MAX = 6;

/** The sorts the "More communities" control offers, in the order it shows them. */
export const JOIN_SORTS = ['new', 'popular', 'trending', 'played', 'hearts', 'name'] as const;
export type JoinSort = (typeof JOIN_SORTS)[number];

/** The cards' grid (app.css `.cm-grid`), and the larger first row's. */
const GRID = 'cm-grid px-1';

export function joinOrder(apps: readonly GuestApp[], sort: GuestSort = 'trending'): GuestApp[] {
  const featured = featuredApps(apps);
  const first = new Set(featured.map((a) => a.slug));
  return [...featured, ...sortApps(apps, sort).filter((a) => !first.has(a.slug))];
}

export function CommunitiesToJoin({ apps, failed = false, exclude, signedIn, query, onRetry, headingAction, emptyLine, ids }: {
  /** The public directory, or null while it loads. */
  apps: GuestApp[] | null;
  /** The directory could not be read: say so, with a way to try again. */
  failed?: boolean;
  /** Communities already on this Home (joined or pinned), left out of the list. */
  exclude: ReadonlySet<string>;
  /** Only the heading and the ids the tours and declared checks find. */
  signedIn: boolean;
  query: string;
  /** Read the directory again, from the line that says it could not be. */
  onRetry?: () => void;
  /** A control at the end of the heading's row: the visitor's search button (../guest/guest-discover.tsx). */
  headingAction?: ReactNode;
  /** Drawn when a search matches nothing. Home's own search answers that itself; the visitor's page has only this list, and was left blank. */
  emptyLine?: ReactNode;
  /** The section's and its Featured label's ids where it is drawn a second time in the document (the Communities page): Home's own stay Home's. */
  ids?: { section: string; featured: string };
}) {
  const t = useMessages('home');
  const ta = useMessages('auth');
  // Featured is a row of Home's own on the signed-in pages (Home, and the
  // Communities page), so its label says of what: the visitor's landing
  // draws this same list, and keeps the plain drawing of it.
  const wip = signedIn;
  const [kind, setKind] = useState<string | null>(null);
  const [sort, setSort] = useState<JoinSort>('trending');
  const [shown, setShown] = useState(JOIN_PAGE);
  const [loadingMore, setLoadingMore] = useState(false);
  const sentinel = useRef<HTMLDivElement | null>(null);

  const pool = useMemo(() => (apps || []).filter((a) => !exclude.has(a.slug)), [apps, exclude]);
  const kinds = useMemo(() => presentCategories(pool), [pool]);
  const allFeatured = useMemo(() => (query ? [] : featuredApps(pool).filter((a) => !kind || a.category === kind)), [pool, kind, query]);
  // The signed-in pages show at most FEATURED_MAX of them (#7229), so the
  // grid ends on a full row; what is past it is not dropped: it falls into
  // the list below, which leaves out only the featured ones actually drawn.
  const featured = useMemo(() => (wip ? allFeatured.slice(0, FEATURED_MAX) : allFeatured), [allFeatured, wip]);
  // Featured's first row is larger, signed in or out: as many as
  // useLeadCount reads off an empty grid of the rest's kind (`probe`).
  const [probe, setProbe] = useState<HTMLDivElement | null>(null);
  // Standard (WIP) holds Featured's place while the directory is read (below).
  const holdFeatured = wip && !apps && !failed && !query;
  const leadCount = useLeadCount(probe);
  const lead = useMemo(() => featured.slice(0, leadCount), [featured, leadCount]);
  // One look (25 Nov 2026): on the standard look's signed-in pages Featured
  // is one grid of covers of one size (app.css, ONE LOOK), so every featured
  // community is in the first grid; each card is still drawn as it is signed
  // out, the first row's marked larger, so the card is one card everywhere.
  const firstGrid = wip ? featured : lead;
  const leadStyle = { ['--cm-lead-cols' as string]: String(leadCount) } as CSSProperties;
  // One featured community where the row has room for more is the whole row,
  // a wide card, not one card beside an empty half page (phone review, 23 Nov
  // 2026, the Duo unfolded sideways). Its picture is a band (app.css).
  const lone = lead.length === 1 && leadCount > 1;
  const shownLeadStyle = lone ? ({ ['--cm-lead-cols' as string]: '1' } as CSSProperties) : leadStyle;
  const list = useMemo(() => {
    // Searching keeps the join order (featured first); otherwise this is the
    // rest, in the chosen sort, the featured ones left out because Featured
    // already shows them (#6597). When every community of the kind is
    // featured, nothing is left and the list is empty.
    const lead = new Set(featured.map((a) => a.slug));
    // Ranked last, never sorted after: the join order (featured, then the
    // chosen sort) is what ties keep, and a later sort would undo the lead
    // (#7021, guest-data.ts says the same).
    return rankCommunities(
      (query ? joinOrder(pool, sort) : sortApps(pool, sort).filter((a) => !lead.has(a.slug)))
        .filter((a) => !kind || a.category === kind),
      query,
      { description: true },
    );
  }, [pool, kind, query, sort, featured]);
  useEffect(() => { setShown(JOIN_PAGE); }, [kind, query, sort]);
  const more = list.length > shown;
  // "More communities" names the rest under Featured. Standard (WIP) draws
  // Featured as a row of Home's own, away from this list, so the list is
  // simply Communities to join and takes no second label.
  const restLabel = featured.length > 0 && !wip;
  // Standard (WIP): the filters are one line, the kinds at its start and the
  // sort at its end, right over the list (app.css `.wip-filterbar`).
  const oneLine = wip && !query && kinds.length > 0;

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !more || typeof IntersectionObserver === 'undefined') return undefined;
    // The scroller the list is in: Home's own signed in, the landing's
    // (#auth-landing-scroll) signed out. An observer rooted on a box that
    // does not hold the cards never fires, which left a visitor with the
    // first page alone, the featured ones.
    const root = scrollParent(el);
    let timer = 0;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting) || timer) return;
      setLoadingMore(true);
      // A beat, so the placeholders read as "more on the way" rather than a flash.
      timer = window.setTimeout(() => { timer = 0; setShown((n) => n + JOIN_PAGE); setLoadingMore(false); }, 250);
    }, { root, rootMargin: '0px 0px 600px 0px' });
    io.observe(el);
    return () => { io.disconnect(); if (timer) window.clearTimeout(timer); };
  }, [more, shown]);

  if (query && !list.length) return emptyLine ?? null;
  const sortMenu = (
    <Select
      variant="plain"
      className="w-auto min-h-11"
      aria-label={t('home:join.sort.label')}
      data-home-join-sort=""
      value={sort}
      onChange={(e) => setSort(e.target.value as JoinSort)}
    >
      {JOIN_SORTS.map((s) => (
        <option key={s} value={s}>
          {s === 'trending' ? t('home:join.sort.active') : t(`home:join.sort.${s}`)}
        </option>
      ))}
    </Select>
  );
  // Nothing drawn on a card depends on being signed in (#6609): a member and
  // a visitor get the same card, and Join is the project page's.
  const heading = signedIn ? t('home:join.heading') : t('home:join.headingSignedOut');
  const featuredId = ids ? ids.featured : signedIn ? 'home-join-featured-label' : 'guest-join-featured-label';
  // An empty grid of the rest's kind, which useLeadCount reads.
  const probeGrid = <div ref={setProbe} className={GRID} data-cm-grid="join" data-cm-probe="" aria-hidden="true" />;
  return (
    // The id is the signed-in Home's (the tours and the declared checks find
    // it); the landing draws the same section signed out, in the same
    // document, so it goes without one there.
    <section id={ids ? ids.section : signedIn ? 'home-join-section' : undefined} data-home-join-section="" className="px-3 pb-6" aria-busy={apps ? undefined : true}>
      <SectionHeading action={headingAction}>{heading}</SectionHeading>
      {!query && kinds.length ? (
        <div className={oneLine ? 'wip-filterbar' : undefined}>
        <FadeRail role="group" aria-label={ta('auth:guest.categories.label')} className={oneLine ? 'min-w-0 flex-1 gap-2 px-0 py-0' : '-mx-3 gap-2 px-3 pt-1 pb-3'}>
          <Chip size="bar" className="min-h-11" selected={!kind} data-home-join-kind="all" onClick={() => setKind(null)}>
            {ta('auth:guest.category.all')}
          </Chip>
          {kinds.map((k) => (
            <Chip key={k} size="bar" className="min-h-11" selected={kind === k} data-home-join-kind={k} onClick={() => setKind(kind === k ? null : k)}>
              {ta(`auth:guest.category.${k}`)}
            </Chip>
          ))}
        </FadeRail>
        {oneLine && list.length > 1 ? sortMenu : null}
        </div>
      ) : holdFeatured ? (
        // The filter line's place, held while the directory is read (27 Nov
        // 2026): the line's own box with a chip's and the menu's shapes in
        // it, so it is the line's height at every width (two lines under
        // 480px, as the real one wraps) and the cards under it do not drop
        // by it when the kinds land.
        <div className="wip-filterbar animate-pulse" data-loading="" aria-hidden="true">
          <span className="flex min-w-0 flex-1 gap-2">
            <span className="h-11 w-16 shrink-0 rounded-full bg-zinc-200/70 dark:bg-zinc-800/70" />
            <span className="h-11 w-24 shrink-0 rounded-full bg-zinc-200/70 dark:bg-zinc-800/70" />
          </span>
          <span className="ms-auto h-11 w-24 shrink-0 rounded-full bg-zinc-200/70 dark:bg-zinc-800/70" />
        </div>
      ) : null}
      {holdFeatured ? (
        // Standard (WIP) draws Featured as a row of Home's own, above this
        // list: its place is held while the directory is read, by as many
        // covers as Featured shows at most (FEATURED_MAX: three rows of two
        // on a phone, two of three from 768px), so the rows under it do not
        // move when they land. It held one row, and the list under it
        // dropped by the rest (27 Nov 2026).
        <div data-home-join-featured="" data-loading="" className="pb-4 animate-pulse" aria-hidden="true">
          <h3 className={`${SMALL_CAPS_LABEL} px-1 pb-2`}>{t('home:join.featured')}</h3>
          {probeGrid}
          <div className={GRID} data-cm-grid="lead" style={leadStyle}>
            {/* One look: one grid of covers of one size (app.css). */}
            {Array.from({ length: FEATURED_MAX }, (_, i) => <CommunityCardSkeleton key={i} lead />)}
          </div>
        </div>
      ) : null}
      {featured.length ? (
        <div data-home-join-featured="" className="pb-4">
          <h3 id={featuredId} className={`${SMALL_CAPS_LABEL} px-1 pb-2`}>
            {/* One name for one thing on Home (phone review, 23 Nov 2026): the
                row is Featured in every look, not "Featured apps / communities". */}
            {kind ? t('home:join.featuredKind', { kind: ta(`auth:guest.category.${kind}`) }) : t('home:join.featured')}
          </h3>
          {probeGrid}
          {/* The first few featured communities are drawn larger, a row of
              their own, so Featured reads as a feature and not as the first
              row of the same grid (Drea, 17 Nov 2026), signed in or out
              (20 Nov 2026; until then a visitor's sideways rail). The rest
              of Featured is the grid under it. */}
          <div
            role="list"
            aria-labelledby={featuredId}
            data-home-join-lead={lead.length}
            data-cm-grid="lead"
            data-cm-lone={lone ? '' : undefined}
            className={GRID}
            style={shownLeadStyle}
          >
            {firstGrid.map((app, i) => (
              <div key={app.slug} role="listitem" className="flex min-w-0 [&>article]:flex-1">
                <Card app={app} eager={i < LEAD_MAX} featured lead={i < lead.length} />
              </div>
            ))}
          </div>
          {featured.length > firstGrid.length ? (
            <div
              role="list"
              aria-labelledby={featuredId}
              data-home-join-featured-rest=""
              data-cm-grid="join"
              className={GRID}
            >
              {featured.slice(lead.length).map((app) => (
                <div key={app.slug} role="listitem" className="flex min-w-0 [&>article]:flex-1">
                  <Card app={app} eager={false} featured />
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {failed ? (
        // #6354 review: a request that failed must say so and offer to try
        // again, rather than leaving the loading placeholders up forever.
        <div className="flex flex-col items-start gap-3 px-1 py-6" data-home-join-failed="">
          <p className="text-[14px] text-zinc-500 dark:text-zinc-400">{t('home:join.failed')}</p>
          {onRetry ? (
            <Button type="button" variant="pill" size="sm" className="min-h-11 px-5 py-0 un-touch-target"
              data-home-join-retry="" onClick={onRetry}>
              {t('home:join.retry')}
            </Button>
          ) : null}
        </div>
      ) : !apps ? (
        <div className={GRID} data-cm-grid="join" aria-label={ta('auth:guest.loading')}>
          {[0, 1, 2, 3].map((i) => <CommunityCardSkeleton key={i} />)}
        </div>
      ) : list.length ? (
        <>
        {/* Featured above, so the rest gets a heading of its own: without it
            every card reads as featured (#6434, #6584). It is not drawn when
            nothing is left (every community of the kind is featured, #6597).
            A search leaves Featured out, and then there is one grid with no
            heading, and the sort sits on its own line above it. The sort is
            drawn only when there are two cards it could order. */}
        {oneLine ? null : list.length > 1 ? (
          <div className={`flex items-center gap-2 px-1 pb-2${restLabel ? '' : ' justify-end'}`}>
            {restLabel ? <h3 className={`${SMALL_CAPS_LABEL} flex-1`} data-home-join-rest="">{t('home:join.more')}</h3> : null}
            {sortMenu}
          </div>
        ) : restLabel ? (
          <h3 className={`${SMALL_CAPS_LABEL} px-1 pb-2`} data-home-join-rest="">{t('home:join.more')}</h3>
        ) : null}
        <div className={GRID} data-cm-grid="join">
          {list.slice(0, shown).map((app, i) => (
            <Card
              key={app.slug}
              app={app}
              eager={i < 4}
            />
          ))}
        </div>
        </>
      ) : featured.length ? null : (
        <p className="px-2 py-4 text-[14px] text-zinc-500 dark:text-zinc-400">
          {!pool.length && !kind && !query ? t('home:join.empty') : t('home:join.allJoined')}
        </p>
      )}
      {more ? (
        <>
          {loadingMore ? (
            <div className={`${GRID} pt-3 animate-pulse`} data-cm-grid="join" aria-label={t('home:join.loadingMore')}>
              {[0, 1].map((i) => <CommunityCardSkeleton key={i} />)}
            </div>
          ) : null}
          <div ref={sentinel} className="h-px" data-home-join-more="" />
        </>
      ) : list.length > JOIN_PAGE ? (
        <p className="px-2 pt-5 text-center text-[13px] text-zinc-500 dark:text-zinc-400" data-home-join-end="">
          {kind ? t('home:join.endKind') : t('home:join.end')}
        </p>
      ) : null}
    </section>
  );
}

/** The nearest ancestor that scrolls, or null (the viewport). */
export function scrollParent(el: Element | null): Element | null {
  for (let node = el?.parentElement || null; node; node = node.parentElement) {
    const y = getComputedStyle(node).overflowY;
    if (y === 'auto' || y === 'scroll') return node;
  }
  return null;
}

/** The public directory, read once per page load (GET /api/public/apps). */
let directory: Promise<GuestApp[] | null> | null = null;
export function readDirectory(refresh = false): Promise<GuestApp[] | null> {
  if (refresh) directory = null;
  if (!directory) {
    // An answer the server never sends ends as a failed read, not as loading
    // placeholders left up for good (#6609 review): to the section, a held
    // request and one that failed are the same, and it has a Retry.
    const init: RequestInit = { credentials: 'same-origin' };
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      init.signal = AbortSignal.timeout(8000);
    }
    directory = fetch('/api/public/apps?include_wallets=0', init)
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => (Array.isArray(body?.apps) ? body.apps as GuestApp[] : null))
      .catch(() => null)
      .then((apps) => { if (!apps) directory = null; return apps; });
  }
  return directory;
}
