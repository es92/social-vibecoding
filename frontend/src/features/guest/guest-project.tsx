/**
 * A public project's page for a visitor with no account (features/auth/
 * landing.tsx draws it in Home's place for `#app/<slug>…` while signed
 * out, under the signed-out site's own bar: the wordmark, Sign in and Sign
 * up). A member sees the same page from the hub's ⋯, "See what visitors
 * see" (./visitor-view.tsx), and nothing on it differs for them.
 *
 * ONE PAGE, NO TABS (the hand-off of 11 Nov 2026). Top to bottom:
 *
 *   All communities   the way back to Home.
 *   The project card  its picture (the preview loop, else the featured
 *                     illustration, else its icon), its name and what it
 *                     says it is, and three buttons (./project-card.tsx).
 *                     "Open <name>" where the app has a view for somebody
 *                     with no account (./guest-discover.tsx TryLink), else
 *                     "Sign up to open" with a line under it saying it needs
 *                     a free account. Join and Share beside it. No Pin.
 *   Who is around     how many were active this week and how many are in
 *                     it, as numbers only (never a name).
 *   What it's like    the after pictures of the latest changes that went
 *                     live, with their titles, sideways; not drawn under
 *                     three (until the preview loop's own stills exist).
 *   Made together     how a change gets in, and Join to vote and suggest.
 *   Up for a vote     compact rows: a small before & after, the title, a
 *                     line of it, the tally and Vote. Two, then "N more up
 *                     for a vote". A row opens the change (GuestChange):
 *                     its before & after with a slider, and Join to vote.
 *   Recently live     the last three changes that went live, and how many
 *                     more did this month.
 *
 * Read from GET /api/public/apps/:slug/overview (src/services/
 * public-project.js), which carries no names on purpose: how many, not who.
 * Taking part (Join, Vote, Sign up to open) opens the sign-in sheet titled
 * for it, and signing in lands back here (`onIntent`).
 */

import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { SectionHeader } from '@/components/ui/grouped-list';
import { ChevronLeftIcon, ChevronRightIcon, ShareIcon, UserGroupIcon } from '@/components/ui/icons';
import { cn } from '@/lib/utils';

import { RichMessage, useMessages } from '../../lib/i18n/react';
import { useStoreState } from '../../lib/use-store-state';
import { devicePinsStore, loadDevicePins, toggleDevicePin } from './device-pins';
import { useCommunityColor } from '../../lib/community-color';
import { agoStamp } from '../../lib/timestamp';
import { GuestIcon, TryLink } from './guest-discover';
import { GuestProjectFrame } from './frame/project-frame';
import { isFrameSkin, useLiveSkin } from '../../lib/skin';
import { CARD_GLASS_BTN, CARD_OPEN_BTN, CARD_ROUND_BTN, PEOPLE_CARD, PeopleCard, ProjectCard } from './project-card';
import {
  type GuestApp, type GuestMerged, type GuestOverview, type GuestVote, MIN_ACTIVE, MIN_MEMBERS, canTryHere,
  fetchOverview, inHomeroomApp,
} from './guest-data';

/** What somebody tried to do: the sign-in sheet is titled for it. */
export type GuestIntent =
  | { kind: 'join'; app: GuestApp }
  | { kind: 'vote'; app: GuestApp; change: string }
  | { kind: 'ask'; app: GuestApp }
  | { kind: 'chat'; app: GuestApp }
  | { kind: 'use'; app: GuestApp };

type Tab = 'hub' | 'workshop' | 'discussion';

/** The changes each list shows before its "N more" row opens the rest. */
export const VOTES_SHOWN = 2;
export const LIVE_SHOWN = 3;
/** What it's like is drawn from this many pictures, and shows up to five. */
export const LIKE_MIN = 3;
export const LIKE_MAX = 5;
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

const LABEL = 'px-1 pb-2 pt-0';
const SECTION = 'mt-8 md:mt-9';
const ROW_LINE = 'shadow-[inset_0_-1px_0_var(--app-sheet-line)]';
/** A list's closing row ("10 more up for a vote"): the plane under the rows. */
const MORE_ROW = 'flex min-h-[56px] w-full items-center gap-3 bg-zinc-50 px-3.5 py-2 text-start dark:bg-zinc-800/60';
const MORE_PILL = 'inline-flex h-8 min-w-[56px] shrink-0 items-center justify-center rounded-lg bg-violet-100 px-2 text-[13px] font-bold text-violet-700 dark:bg-violet-950 dark:text-violet-300';

/** A game is played; anything else is used. */
function playsIt(app: GuestApp): boolean {
  return app.category === 'games';
}

/** Whether a change went live within the last thirty days (the month's count). */
function thisMonth(m: GuestMerged, now: number): boolean {
  const at = m.merged_at ? Date.parse(m.merged_at) : NaN;
  return Number.isFinite(at) && now - at <= MONTH_MS;
}

/** The project's tile on its colour, where a change has no picture anybody may see. */
function TilePicture({ app, color, className }: { app: GuestApp; color: string; className: string }) {
  return (
    <span className={cn('flex items-center justify-center overflow-hidden', className)} style={{ background: color }} aria-hidden="true">
      <GuestIcon app={app} size="sm" />
    </span>
  );
}

/**
 * One change up for a vote, as a row: its small before & after, its title
 * and a line of it, the tally and Vote. The row opens the change; Vote asks
 * to sign in for it. On a phone the tally is the row's second line and the
 * row ends in a chevron.
 */
function VoteRow({ vote, app, color, last, signedIn, onOpen, onIntent }: {
  vote: GuestVote;
  app: GuestApp;
  color: string;
  last: boolean;
  signedIn: boolean;
  onOpen: () => void;
  onIntent: (i: GuestIntent) => void;
}) {
  const t = useMessages('auth');
  const title = vote.title || t('auth:guest.project.untitledChange');
  const pic = vote.pictures?.after || null;
  return (
    <div data-guest-vote={vote.id} className={cn('flex items-center gap-2 pe-3.5', last ? '' : ROW_LINE)}>
      <button type="button" data-guest-vote-open="" className="flex min-h-[72px] min-w-0 flex-1 items-center gap-3.5 py-2.5 ps-3.5 text-start" onClick={onOpen}>
        <span className="relative h-[72px] w-[72px] shrink-0 overflow-hidden rounded-xl bg-zinc-100 md:h-[70px] md:w-[112px] dark:bg-zinc-800">
          {pic ? (
            <img src={pic} alt="" loading="lazy" draggable={false} className="h-full w-full object-cover object-top" />
          ) : (
            <TilePicture app={app} color={color} className="h-full w-full" />
          )}
          {vote.pictures?.before ? (
            <span className="absolute bottom-1 start-1 hidden rounded-full bg-zinc-950/70 px-1.5 py-px text-[10px] font-bold text-white md:inline">
              {t('auth:guest.project.beforeAfter')}
            </span>
          ) : null}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-[650] leading-5 text-zinc-900 dark:text-zinc-100">{title}</span>
          {vote.summary ? <span className="hidden truncate text-[13px] leading-[18px] text-zinc-500 md:block dark:text-zinc-400">{vote.summary}</span> : null}
          <span className="block text-[13px] leading-[18px] text-zinc-500 md:hidden dark:text-zinc-400">{t('auth:guest.project.yes', { count: vote.yes })}</span>
        </span>
        <span className="hidden shrink-0 text-[13px] text-zinc-500 md:inline dark:text-zinc-400">{t('auth:guest.project.yes', { count: vote.yes })}</span>
        <ChevronRightIcon className="h-[18px] w-[18px] shrink-0 text-zinc-500 md:hidden dark:text-zinc-400" aria-hidden="true" />
      </button>
      {signedIn ? null : (
        <button
          type="button"
          data-guest-vote-btn=""
          className="hidden h-9 shrink-0 rounded-full bg-violet-100 px-[18px] text-sm font-bold text-violet-700 hover:bg-violet-200 md:inline-flex md:items-center dark:bg-violet-950 dark:text-violet-300 dark:hover:bg-violet-900"
          onClick={() => onIntent({ kind: 'vote', app, change: title })}
        >
          {t('auth:guest.project.vote')}
        </button>
      )}
    </div>
  );
}

/**
 * A change opened from Up for a vote: its title and summary, its before and
 * after with a slider between them, the tally, and Join to vote. The page's
 * chip goes back to the project.
 */
export function GuestChange({ vote, app, signedIn = false, onBack, onIntent }: {
  vote: GuestVote;
  app: GuestApp;
  signedIn?: boolean;
  onBack: () => void;
  onIntent: (i: GuestIntent) => void;
}) {
  const t = useMessages('auth');
  const title = vote.title || t('auth:guest.project.untitledChange');
  const before = vote.pictures?.before || null;
  const after = vote.pictures?.after || null;
  // Where the seam is, from the left: Before shows to its left, After to its right.
  const [seam, setSeam] = useState(50);
  return (
    <div data-guest-change={vote.id} className="flex flex-col gap-4">
      <button
        type="button"
        data-guest-change-back=""
        aria-label={t('auth:guest.project.change.back', { project: app.name })}
        className="inline-flex h-11 items-center gap-1 self-start rounded-full bg-[color:var(--brand-tint)] px-3.5 text-[15px] font-semibold text-[color:var(--brand-ink)]"
        onClick={onBack}
      >
        <ChevronLeftIcon className="h-4 w-4" aria-hidden="true" />
        {app.name}
      </button>
      <article className={cn(PEOPLE_CARD, 'flex flex-col gap-3 p-4 md:p-5')}>
        <SectionHeader className="p-0">{t('auth:guest.project.upForVote')}</SectionHeader>
        <div>
          <h2 className="text-[20px] font-bold leading-[26px] text-zinc-900 dark:text-zinc-100">{title}</h2>
          {vote.summary ? <p className="mt-1 text-[15px] leading-[21px] text-zinc-600 dark:text-zinc-300">{vote.summary}</p> : null}
        </div>
        {after ? (
          <div className="flex flex-col gap-2.5">
            <div data-guest-change-compare="" className="relative h-[min(62vh,520px)] overflow-hidden rounded-2xl bg-zinc-50 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-800">
              <img src={after} alt={t('auth:guest.project.after')} draggable={false} className="absolute inset-0 h-full w-full object-contain" />
              {before ? (
                <>
                  <img
                    src={before}
                    alt={t('auth:guest.project.before')}
                    draggable={false}
                    className="absolute inset-0 h-full w-full object-contain"
                    style={{ clipPath: `inset(0 ${100 - seam}% 0 0)` }}
                  />
                  <span className="pointer-events-none absolute inset-y-0 w-0.5 bg-violet-600" style={{ insetInlineStart: `${seam}%` }} aria-hidden="true" />
                  <span className="absolute start-2.5 top-2.5 rounded-full bg-zinc-950/70 px-2 py-0.5 text-[11px] font-bold text-white">{t('auth:guest.project.before')}</span>
                </>
              ) : null}
              <span className="absolute end-2.5 top-2.5 rounded-full bg-zinc-950/70 px-2 py-0.5 text-[11px] font-bold text-white">{t('auth:guest.project.after')}</span>
            </div>
            {before ? (
              <label className="flex items-center gap-3 text-[13px] text-zinc-500 dark:text-zinc-400">
                <span aria-hidden="true">{t('auth:guest.project.before')}</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={seam}
                  data-guest-change-slider=""
                  aria-label={t('auth:guest.project.change.slider')}
                  className="h-11 min-w-0 flex-1 accent-violet-600"
                  onChange={(e) => setSeam(Number(e.currentTarget.value))}
                />
                <span aria-hidden="true">{t('auth:guest.project.after')}</span>
              </label>
            ) : null}
          </div>
        ) : null}
        <div className={cn('flex flex-wrap items-center gap-3 pt-3', 'shadow-[inset_0_1px_0_var(--app-sheet-line)]')}>
          <span className="min-w-0 flex-1 text-[15px] text-zinc-600 dark:text-zinc-300">
            {t('auth:guest.project.change.tally', { yes: vote.yes, no: vote.no })}
          </span>
          {signedIn ? (
            <span data-guest-vote-later="" className="text-[13px] font-semibold text-zinc-500 dark:text-zinc-400">{t('auth:guest.project.voteLater')}</span>
          ) : (
            <Button
              type="button"
              variant="pillAccent"
              size="none"
              ink="solid"
              data-guest-change-join=""
              className="h-11 px-5 text-[15px] font-bold"
              onClick={() => onIntent({ kind: 'vote', app, change: title })}
            >
              {t('auth:guest.project.change.joinToVote')}
            </Button>
          )}
        </div>
      </article>
    </div>
  );
}

export function GuestProject({ app, onIntent, onOpenInside, onShare, onAllCommunities, startOnWorkshop = false, signedIn = false, preview = false, initialOverview = null }: {
  /** The project's card from the public directory. */
  app: GuestApp;
  /**
   * An account still on the waitlist is looking (landing.tsx): every public
   * app opens for it, signed in, and joining and voting wait until it is let
   * in. A member's "See what visitors see" is NOT this: it is a visitor's
   * page exactly (./visitor-view.tsx).
   */
  signedIn?: boolean;
  /** The link asked for its changes up for a vote (a card's votes line): the frame's looks open on their Workshop. */
  startOnWorkshop?: boolean;
  /** The landing's pill class. The card draws its own buttons now; kept so callers need not change. */
  primaryClass?: string;
  onIntent: (intent: GuestIntent) => void;
  onOpenInside: (app: GuestApp) => void;
  onShare: (app: GuestApp) => void;
  /** The All communities chip: back to Home. */
  onAllCommunities?: () => void;
  /**
   * A member looking at it from the hub's ⋯ (./visitor-view.tsx): the page
   * is a visitor's in every way, and Open hands the app to `onOpenInside`.
   */
  preview?: boolean;
  /** The overview already read (the visitor view reads it to find the app). */
  initialOverview?: GuestOverview | null;
}) {
  const t = useMessages('auth');
  const device = useStoreState(devicePinsStore);
  useEffect(() => { loadDevicePins(); }, []);
  const pinnedHere = device.communities.includes(app.slug);
  const color = useCommunityColor({ color: app.icon_color, iconUrl: app.icon_url, iconEmoji: app.icon_emoji, key: app.slug });
  // Under one of the frame's looks the page is the kit's
  // (./frame/project-frame.tsx), handed this component's data and state.
  // Mounted after the first paint, so the device's own look is read at once.
  const frame = isFrameSkin(useLiveSkin());
  const [tab, setTab] = useState<Tab>(startOnWorkshop ? 'workshop' : 'hub');
  const [overview, setOverview] = useState<GuestOverview | null>(initialOverview);
  const [loaded, setLoaded] = useState(!!initialOverview);
  // The change opened from Up for a vote, and whether each list is open in full.
  const [opened, setOpened] = useState<number | null>(null);
  const [allVotes, setAllVotes] = useState(false);
  const [allLive, setAllLive] = useState(false);

  useEffect(() => {
    let live = true;
    setOpened(null);
    setAllVotes(false);
    setAllLive(false);
    setTab(startOnWorkshop ? 'workshop' : 'hub');
    if (initialOverview && initialOverview.app.slug === app.slug) {
      setOverview(initialOverview);
      setLoaded(true);
      return () => { live = false; };
    }
    setOverview(null);
    setLoaded(false);
    void fetchOverview(app.slug).then((o) => {
      if (!live) return;
      setOverview(o);
      setLoaded(true);
    });
    return () => { live = false; };
  }, [app.slug, startOnWorkshop, initialOverview]);

  // A change opened, or closed again, starts at the top of the page.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.getElementById('auth-landing-scroll')?.scrollTo?.(0, 0);
    document.querySelector('[data-visitor-view-scroll]')?.scrollTo?.(0, 0);
  }, [opened]);

  const canTry = signedIn || canTryHere(app, inHomeroomApp());

  if (frame) {
    return (
      <GuestProjectFrame
        app={app}
        overview={overview}
        loaded={loaded}
        tab={tab}
        onTab={setTab}
        signedIn={signedIn}
        pinned={pinnedHere}
        onPin={() => { toggleDevicePin('communities', app.slug); }}
        canTry={canTryHere(app, inHomeroomApp())}
        onIntent={onIntent}
        onOpenInside={onOpenInside}
        onShare={onShare}
      />
    );
  }

  const now = Date.now();
  const votes = overview?.votes || [];
  const voteCount = Math.max(overview?.app.open_votes ?? app.open_votes ?? 0, votes.length);
  const merged = overview?.merged || [];
  const month = Math.max(0, Number(overview?.activity?.merged_month) || 0);
  // Counts only from the minimums (guest-data MIN_ACTIVE, MIN_MEMBERS): a
  // small one reads as a project nobody uses, so it says nothing.
  const activeWeek = Number(overview?.activity?.active_week) || 0;
  const active = activeWeek >= MIN_ACTIVE ? activeWeek : 0;
  const members = (app.member_count || 0) >= MIN_MEMBERS ? app.member_count || 0 : 0;
  const pictures = merged.filter((m) => m.picture).slice(0, LIKE_MAX);
  const openVote = opened == null ? null : votes.find((v) => v.id === opened) || null;

  const votesShown = allVotes ? votes : votes.slice(0, VOTES_SHOWN);
  const votesMore = Math.max(0, voteCount - votesShown.length);
  const liveShown = allLive ? merged : merged.slice(0, LIVE_SHOWN);
  const liveMore = Math.max(0, month - liveShown.filter((m) => thisMonth(m, now)).length);

  if (openVote) {
    return (
      <div data-guest-project={app.slug} className="mx-auto flex w-full max-w-3xl flex-col px-4 pb-10 pt-4">
        <GuestChange vote={openVote} app={app} signedIn={signedIn} onBack={() => setOpened(null)} onIntent={onIntent} />
      </div>
    );
  }

  const openLabel = t('auth:guest.project.openNamed', { project: app.name });
  const actions = (
    <>
      {canTry ? (
        <TryLink app={app} inside={signedIn || preview} onOpenInside={onOpenInside} className={CARD_OPEN_BTN}>
          <span className="truncate">{openLabel}</span>
        </TryLink>
      ) : (
        <button type="button" data-guest-use="" className={CARD_OPEN_BTN} onClick={() => onIntent({ kind: 'use', app })}>
          <span className="truncate">{t('auth:guest.project.signUpToOpen')}</span>
        </button>
      )}
      {signedIn ? null : (
        <button type="button" data-guest-join-project="" className={CARD_GLASS_BTN} onClick={() => onIntent({ kind: 'join', app })}>
          {t('auth:guest.project.join')}
        </button>
      )}
      <button
        type="button"
        data-guest-share=""
        aria-label={t('auth:guest.project.share')}
        className={CARD_ROUND_BTN}
        onClick={() => onShare(app)}
      >
        <ShareIcon className="h-5 w-5" aria-hidden="true" />
      </button>
    </>
  );
  const note = canTry ? null : (
    <p data-guest-needs-account="" className="text-[14px] leading-5 text-white/80">
      {playsIt(app)
        ? t('auth:guest.project.needsAccountPlay', { project: app.name })
        : t('auth:guest.project.needsAccountUse', { project: app.name })}
    </p>
  );

  return (
    <div data-guest-project={app.slug} className="mx-auto flex w-full flex-col px-4 pb-10 pt-4">
      <button
        type="button"
        data-guest-all-communities=""
        className="mb-3.5 inline-flex h-11 items-center gap-1 self-start rounded-full bg-[color:var(--brand-tint)] px-3.5 text-[15px] font-semibold text-[color:var(--brand-ink)]"
        onClick={() => onAllCommunities?.()}
      >
        <ChevronLeftIcon className="h-4 w-4" aria-hidden="true" />
        {t('auth:guest.project.allCommunities')}
      </button>

      <ProjectCard
        place="guest"
        app={app}
        cover={app}
        color={color}
        description={app.description}
        actions={actions}
        note={note}
        data-guest-project-band=""
      />

      {active || members ? (
        <div className="mt-2.5 md:mt-3.5">
          <PeopleCard
            data-guest-people=""
            audience={members ? (
              <span data-guest-people-members="" className="inline-flex items-center gap-1.5">
                <UserGroupIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
                <RichMessage
                  id="auth:guest.project.audienceMembers"
                  values={{ count: members }}
                  components={[<b className="font-[650] text-zinc-900 dark:text-zinc-100" />]}
                />
              </span>
            ) : null}
          >
            {active ? (
              <span data-guest-people-active="" className="text-[15px] font-[650] text-zinc-900 dark:text-zinc-100">
                {t('auth:guest.project.activeWeek', { count: active })}
              </span>
            ) : null}
          </PeopleCard>
        </div>
      ) : null}

      {pictures.length >= LIKE_MIN ? (
        <section data-guest-like="" className={SECTION}>
          <SectionHeader className={LABEL}>{t('auth:guest.project.whatItsLike')}</SectionHeader>
          <ul className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-1 md:mx-0 md:px-0 [scrollbar-width:none]">
            {pictures.map((m) => (
              <li key={m.id} data-guest-like-item={m.id} className="w-[200px] shrink-0 snap-start md:w-[236px]">
                <span className="block h-[125px] overflow-hidden rounded-[14px] bg-zinc-100 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] md:h-[148px] dark:bg-zinc-800">
                  <img src={m.picture || ''} alt="" loading="lazy" draggable={false} className="h-full w-full object-cover object-top" />
                </span>
                <span className="mt-1.5 block truncate px-0.5 text-[13px] leading-[18px] text-zinc-700 dark:text-zinc-300">
                  {m.title || t('auth:guest.project.untitledChange')}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section data-guest-made="" className={SECTION}>
        <SectionHeader className={LABEL}>{t('auth:guest.project.madeTogether')}</SectionHeader>
        <div className={cn(PEOPLE_CARD, 'flex flex-col gap-4 p-4 md:flex-row md:items-center md:gap-6 md:p-5')}>
          <div className="min-w-0 flex-1">
            <h2 className="text-[17px] font-bold leading-6 text-zinc-900 dark:text-zinc-100">
              {playsIt(app) ? t('auth:guest.project.madeByPlayers') : t('auth:guest.project.madeByUsers')}
            </h2>
            <p className="mt-1 text-[15px] leading-[21px] text-zinc-600 dark:text-zinc-300">
              {month > 0 ? t('auth:guest.project.madeHowMonth', { count: month }) : t('auth:guest.project.madeHow')}
            </p>
          </div>
          {signedIn ? (
            <p className="text-[13px] font-semibold text-zinc-500 dark:text-zinc-400">{t('auth:guest.project.joinLater')}</p>
          ) : (
            <Button
              type="button"
              variant="pillAccent"
              size="none"
              ink="solid"
              data-guest-made-join=""
              className="h-12 w-full shrink-0 px-6 text-[16px] font-bold md:w-auto md:min-w-[280px]"
              onClick={() => onIntent({ kind: 'join', app })}
            >
              {t('auth:guest.project.joinToVoteSuggest')}
            </Button>
          )}
        </div>
      </section>

      {votes.length ? (
        <section data-guest-votes="" className={SECTION}>
          <div className="flex items-center justify-between gap-2 px-1 pb-2">
            <SectionHeader className="p-0">{t('auth:guest.project.upForVoteCount', { count: voteCount })}</SectionHeader>
            {!allVotes && votes.length > VOTES_SHOWN ? (
              <button type="button" data-guest-votes-all="" className="un-touch-target text-[15px] font-semibold text-violet-700 dark:text-violet-300" onClick={() => setAllVotes(true)}>
                {t('auth:guest.project.seeAllCount', { count: voteCount })}
              </button>
            ) : null}
          </div>
          <div className={cn(PEOPLE_CARD, 'overflow-hidden')}>
            {votesShown.map((v, i) => (
              <VoteRow
                key={v.id}
                vote={v}
                app={app}
                color={color}
                last={i === votesShown.length - 1 && !votesMore}
                signedIn={signedIn}
                onOpen={() => setOpened(v.id)}
                onIntent={onIntent}
              />
            ))}
            {votesMore ? (
              allVotes || votes.length <= VOTES_SHOWN ? (
                <div data-guest-votes-more="" className={MORE_ROW}>
                  <span className={MORE_PILL}>{t('auth:guest.project.morePill', { count: votesMore })}</span>
                  <span className="flex-1 text-[15px] font-semibold text-zinc-700 dark:text-zinc-300">{t('auth:guest.project.moreVotes', { count: votesMore })}</span>
                </div>
              ) : (
                <button type="button" data-guest-votes-more="" className={MORE_ROW} onClick={() => setAllVotes(true)}>
                  <span className={MORE_PILL}>{t('auth:guest.project.morePill', { count: votesMore })}</span>
                  <span className="flex-1 text-[15px] font-semibold text-violet-700 dark:text-violet-300">{t('auth:guest.project.moreVotes', { count: votesMore })}</span>
                  <ChevronRightIcon className="h-[18px] w-[18px] text-violet-700 dark:text-violet-300" aria-hidden="true" />
                </button>
              )
            ) : null}
          </div>
        </section>
      ) : null}

      {merged.length ? (
        <section data-guest-live="" className={SECTION}>
          <div className="flex items-center justify-between gap-2 px-1 pb-2">
            <SectionHeader className="p-0">{t('auth:guest.project.recentlyLive')}</SectionHeader>
            {!allLive && merged.length > LIVE_SHOWN ? (
              <button type="button" data-guest-live-all="" className="un-touch-target text-[15px] font-semibold text-violet-700 dark:text-violet-300" onClick={() => setAllLive(true)}>
                {t('auth:guest.project.seeAll')}
              </button>
            ) : null}
          </div>
          <div className={cn(PEOPLE_CARD, 'overflow-hidden')}>
            {liveShown.map((m, i) => (
              <div key={m.id} data-guest-merged={m.id} className={cn('flex min-h-[64px] items-center gap-3 px-3.5 py-3', i < liveShown.length - 1 || liveMore ? ROW_LINE : '')}>
                <span className="h-10 w-16 shrink-0 overflow-hidden rounded-lg bg-zinc-100 dark:bg-zinc-800">
                  {m.picture ? (
                    <img src={m.picture} alt="" loading="lazy" draggable={false} className="h-full w-full object-cover object-top" />
                  ) : (
                    <TilePicture app={app} color={color} className="h-full w-full" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[15px] font-[650] leading-5 text-zinc-900 dark:text-zinc-100">{m.title || t('auth:guest.project.untitledChange')}</div>
                  {m.merged_at ? <div className="text-[13px] leading-[18px] text-zinc-500 dark:text-zinc-400" title={agoStamp(m.merged_at).title}>{agoStamp(m.merged_at).text}</div> : null}
                </div>
              </div>
            ))}
            {liveMore ? (
              !allLive && merged.length > LIVE_SHOWN ? (
                <button type="button" data-guest-live-more="" className={MORE_ROW} onClick={() => setAllLive(true)}>
                  <span className={MORE_PILL}>{t('auth:guest.project.morePill', { count: liveMore })}</span>
                  <span className="flex-1 text-[15px] font-semibold text-violet-700 dark:text-violet-300">{t('auth:guest.project.moreLive', { count: liveMore })}</span>
                  <ChevronRightIcon className="h-[18px] w-[18px] text-violet-700 dark:text-violet-300" aria-hidden="true" />
                </button>
              ) : (
                <div data-guest-live-more="" className={MORE_ROW}>
                  <span className={MORE_PILL}>{t('auth:guest.project.morePill', { count: liveMore })}</span>
                  <span className="flex-1 text-[15px] font-semibold text-zinc-700 dark:text-zinc-300">{t('auth:guest.project.moreLive', { count: liveMore })}</span>
                </div>
              )
            ) : null}
          </div>
        </section>
      ) : null}

      {!loaded ? <p className="mt-8 px-1 text-[15px] text-zinc-500 dark:text-zinc-400">{t('auth:guest.project.loading')}</p> : null}
    </div>
  );
}
