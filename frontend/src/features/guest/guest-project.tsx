/**
 * A public project's page for a visitor with no account: the guest version
 * of its hub, read-only (features/auth/landing.tsx draws it in the
 * Discover's place for `#app/<slug>…` while signed out).
 *
 * The band wears the project's colour (lib/community-color.ts), like its
 * page does for members: its picture, icon, name, its own description, how
 * many built it and how many use it, and three actions. "Try it" opens the
 * app where it has a view for somebody with no account (./guest-discover.tsx
 * TryLink); otherwise it asks them to sign in to use it. "Join" and every
 * other way of taking part (Vote, Ask for something, the chat) open the
 * sign-in sheet titled for what they were doing, and signing in lands back
 * on this address, the project's hub (`onIntent`).
 *
 * Under it, three tabs, read from GET /api/public/apps/:slug/overview
 * (src/services/public-project.js):
 *
 *   Hub         what is happening, the changes up for a vote, the last few
 *               voted in, how many people, and the chat (for members)
 *   Workshop    every change up for a vote and the open requests
 *   Discussion  for members
 *
 * Names are never shown: how many built it, not who (the overview carries
 * no names). The chat stays with members.
 */

import { type ReactNode, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { GroupedList, SectionHeader } from '@/components/ui/grouped-list';
import { ChatIcon, ChevronRightIcon, PlusIcon, ShareIcon, UserGroupIcon } from '@/components/ui/icons';
import { cn } from '@/lib/utils';

import { useMessages } from '../../lib/i18n/react';
import { useCommunityColor } from '../../lib/community-color';
import { agoStamp } from '../../lib/timestamp';
import { GuestCover, GuestIcon, TryLink } from './guest-discover';
import { type GuestApp, type GuestOverview, type GuestVote, MIN_ACTIVE, MIN_BUILDERS, buildersOf, canTryHere, fetchOverview, inHomeroomApp } from './guest-data';

/** What somebody tried to do: the sign-in sheet is titled for it. */
export type GuestIntent =
  | { kind: 'join'; app: GuestApp }
  | { kind: 'vote'; app: GuestApp; change: string }
  | { kind: 'ask'; app: GuestApp }
  | { kind: 'chat'; app: GuestApp }
  | { kind: 'use'; app: GuestApp };

type Tab = 'hub' | 'workshop' | 'discussion';

const CARD = 'rounded-[20px] bg-white shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900';
const LABEL = 'px-1 pb-2 pt-0';

export function VoteCard({ vote, app, onIntent }: { vote: GuestVote; app: GuestApp; onIntent: (i: GuestIntent) => void }) {
  const t = useMessages('auth');
  const total = vote.yes + vote.no;
  const pct = total ? Math.round((100 * vote.yes) / total) : 0;
  const title = vote.title || t('auth:guest.project.untitledChange');
  const pictures = vote.pictures || null;
  return (
    <article data-guest-vote={vote.id} className={cn(CARD, 'flex flex-col gap-2.5 overflow-hidden p-3.5')}>
      {pictures ? (
        <div data-guest-vote-pictures="" className={cn('-mx-3.5 -mt-3.5 grid gap-px bg-[color:var(--app-sheet-line)]', pictures.before ? 'grid-cols-2' : 'grid-cols-1')}>
          {([['before', pictures.before], ['after', pictures.after]] as const).map(([side, src]) => (src ? (
            <figure key={side} className="relative m-0 aspect-[4/3] overflow-hidden bg-zinc-100 dark:bg-zinc-800">
              <img src={src} alt="" loading="lazy" draggable={false} className="h-full w-full object-cover object-top" />
              <figcaption className="absolute bottom-1.5 left-1.5 rounded-full bg-zinc-950/70 px-2 py-0.5 text-[11px] font-bold text-white">
                {side === 'before' ? t('auth:guest.project.before') : t('auth:guest.project.after')}
              </figcaption>
            </figure>
          ) : null))}
        </div>
      ) : null}
      <div>
        <h3 className="text-[15px] font-[650] text-zinc-900 dark:text-zinc-100">{title}</h3>
        {vote.summary ? <p className="mt-0.5 text-[13px] leading-[18px] text-zinc-500 dark:text-zinc-400">{vote.summary}</p> : null}
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800" aria-hidden="true">
        <div className="h-full rounded-full bg-violet-600 dark:bg-violet-400" style={{ width: `${pct}%` }} />
      </div>
      <div className="flex items-center gap-2.5">
        <span className="flex-1 text-[13px] text-zinc-500 dark:text-zinc-400">
          {t('auth:guest.project.tally', { yes: vote.yes, no: vote.no })}
        </span>
        <button
          type="button"
          data-guest-vote-btn=""
          className="h-9 rounded-full bg-violet-100 px-[18px] text-sm font-bold text-violet-700 hover:bg-violet-200 dark:bg-violet-950 dark:text-violet-300 dark:hover:bg-violet-900"
          onClick={() => onIntent({ kind: 'vote', app, change: title })}
        >
          {t('auth:guest.project.vote')}
        </button>
      </div>
    </article>
  );
}

function MembersOnly({ app, onIntent, roomy = false }: { app: GuestApp; onIntent: (i: GuestIntent) => void; roomy?: boolean }) {
  const t = useMessages('auth');
  return (
    <div
      data-guest-members-only=""
      className={cn(CARD, roomy ? 'flex flex-col items-center gap-2.5 px-[18px] py-6 text-center' : 'flex items-center gap-3 p-3.5')}
    >
      <span className={cn('flex shrink-0 items-center justify-center rounded-full bg-black/5 text-zinc-600 dark:bg-white/10 dark:text-zinc-300', roomy ? 'h-11 w-11' : 'h-9 w-9')} aria-hidden="true">
        <ChatIcon className="h-[18px] w-[18px]" />
      </span>
      <div className={roomy ? '' : 'min-w-0 flex-1'}>
        <div className={cn('font-[650] text-zinc-900 dark:text-zinc-100', roomy ? 'text-[17px]' : 'text-[15px]')}>{t('auth:guest.project.chatMembers')}</div>
        <div className={cn('text-zinc-500 dark:text-zinc-400', roomy ? 'mt-1 text-[15px] leading-[21px]' : 'text-[13px] leading-[18px]')}>
          {t('auth:guest.project.chatJoin', { project: app.name })}
        </div>
      </div>
      {roomy ? (
        <Button
          type="button"
          data-guest-chat-join=""
          variant="pillAccent"
          size="pill"
          ink="solid"
          className="mt-1 h-11"
          onClick={() => onIntent({ kind: 'chat', app })}
        >
          {t('auth:guest.project.join')}
        </Button>
      ) : (
        <button
          type="button"
          data-guest-chat-join=""
          className="h-9 shrink-0 rounded-full bg-zinc-100 px-4 text-sm font-semibold text-zinc-900 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700"
          onClick={() => onIntent({ kind: 'chat', app })}
        >
          {t('auth:guest.project.join')}
        </button>
      )}
    </div>
  );
}

function Row({ children, onClick, last }: { children: ReactNode; onClick?: () => void; last: boolean }) {
  const cls = cn(
    'flex min-h-[52px] w-full items-center gap-3 px-3.5 py-2 text-left',
    last ? '' : 'shadow-[inset_0_-1px_0_var(--app-sheet-line)]',
  );
  if (!onClick) return <div className={cls}>{children}</div>;
  return (
    <button type="button" className={cls} onClick={onClick}>
      {children}
      <ChevronRightIcon className="h-[18px] w-[18px] text-zinc-400 dark:text-zinc-500" />
    </button>
  );
}

export function GuestProject({ app, primaryClass, onIntent, onOpenInside, onShare, startOnWorkshop = false }: {
  /** The project's card from the public directory. */
  app: GuestApp;
  /** The link asked for its changes up for a vote (a card's votes line): open on the Workshop. */
  startOnWorkshop?: boolean;
  primaryClass: string;
  onIntent: (intent: GuestIntent) => void;
  onOpenInside: (app: GuestApp) => void;
  onShare: (app: GuestApp) => void;
}) {
  const t = useMessages('auth');
  const color = useCommunityColor({ color: app.icon_color, iconUrl: app.icon_url, iconEmoji: app.icon_emoji, key: app.slug });
  const [tab, setTab] = useState<Tab>(startOnWorkshop ? 'workshop' : 'hub');
  const [overview, setOverview] = useState<GuestOverview | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let live = true;
    setOverview(null);
    setLoaded(false);
    setTab(startOnWorkshop ? 'workshop' : 'hub');
    void fetchOverview(app.slug).then((o) => {
      if (!live) return;
      setOverview(o);
      setLoaded(true);
    });
    return () => { live = false; };
  }, [app.slug, startOnWorkshop]);

  const builders = overview?.app.builders ?? buildersOf(app);
  // Counts only from the cards' minimums (guest-data MIN_BUILDERS,
  // MIN_ACTIVE): a small one reads as a project nobody uses. Under them the
  // band says what changed this week, when anything did.
  const active = (app.active_users || 0) >= MIN_ACTIVE ? app.active_users || 0 : 0;
  const bandBuilders = builders >= MIN_BUILDERS ? builders : 0;
  const week = app.merged_week || 0;
  const votes = overview?.votes || [];
  const voteCount = Math.max(overview?.app.open_votes ?? app.open_votes ?? 0, votes.length);
  const requests = overview?.requests || null;
  const updatedAt = app.last_merged_at || app.last_deploy_at || null;
  const updated = updatedAt ? agoStamp(updatedAt).text : '';

  const tabs: { key: Tab; label: string }[] = [
    { key: 'hub', label: t('auth:guest.project.tab.hub') },
    { key: 'workshop', label: t('auth:guest.project.tab.workshop') },
    { key: 'discussion', label: t('auth:guest.project.tab.discussion') },
  ];

  const voteCards = (limit: number) => votes.slice(0, limit).map((v) => (
    <VoteCard key={v.id} vote={v} app={app} onIntent={onIntent} />
  ));

  return (
    <div data-guest-project={app.slug} className="mx-auto flex w-full flex-col gap-[18px] px-4">
      <section
        data-guest-project-band=""
        className="flex flex-wrap items-start gap-x-5 gap-y-3.5 rounded-3xl p-3 text-white"
        style={{ background: color }}
      >
        {app.illustration_url ? (
          <GuestCover app={app} className="aspect-[16/10] min-w-0 flex-[1_1_420px] rounded-2xl" />
        ) : null}
        <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-2.5 px-1 py-0.5">
          <div className="flex items-center gap-3">
            <span className="rounded-2xl shadow-[0_0_0_2px_rgba(255,255,255,0.9)]"><GuestIcon app={app} size="lg" eager /></span>
            <div className="min-w-0">
              <h1 className="text-[26px] font-extrabold leading-[30px] tracking-[-0.02em] [overflow-wrap:anywhere]">{app.name}</h1>
              <div className="text-[13px] font-semibold text-white/80">{t('auth:guest.project.audience')}</div>
            </div>
          </div>
          {app.description ? <p className="text-base leading-[22px] text-white/90">{app.description}</p> : null}
          {bandBuilders || active ? (
            <div data-guest-project-facts="" className="flex items-center gap-1.5 text-[13px] text-white/80">
              <UserGroupIcon className="h-4 w-4 shrink-0" />
              {bandBuilders ? <span>{t('auth:guest.project.builders', { count: bandBuilders })}</span> : null}
              {bandBuilders && active ? <span aria-hidden="true">·</span> : null}
              {active ? <span>{t('auth:guest.project.active', { count: active })}</span> : null}
            </div>
          ) : week ? (
            <div data-guest-project-facts="" className="text-[13px] text-white/80">{t('auth:guest.card.week', { count: week })}</div>
          ) : null}
          <div className="mt-0.5 flex gap-2">
            {canTryHere(app, inHomeroomApp()) ? (
              <TryLink
                app={app}
                onOpenInside={onOpenInside}
                className="flex h-11 flex-1 items-center justify-center rounded-full bg-white px-4 text-base font-semibold text-zinc-950 hover:bg-zinc-100 md:max-w-[240px]"
              >
                {t('auth:guest.card.tryIt')}
              </TryLink>
            ) : (
              <button
                type="button"
                data-guest-use=""
                className="flex h-11 flex-1 items-center justify-center rounded-full bg-white px-4 text-base font-semibold text-zinc-950 hover:bg-zinc-100 md:max-w-[240px]"
                onClick={() => onIntent({ kind: 'use', app })}
              >
                {t('auth:guest.project.signInToUse')}
              </button>
            )}
            <button
              type="button"
              data-guest-join-project=""
              className="h-11 shrink-0 rounded-full bg-white/15 px-5 text-base font-semibold text-white hover:bg-white/25"
              onClick={() => onIntent({ kind: 'join', app })}
            >
              {t('auth:guest.project.join')}
            </button>
            <button
              type="button"
              aria-label={t('auth:guest.project.share')}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/15 text-white hover:bg-white/25"
              onClick={() => onShare(app)}
            >
              <ShareIcon className="h-[18px] w-[18px]" />
            </button>
          </div>
        </div>
      </section>

      <div role="tablist" aria-label={t('auth:guest.project.tabs')} className="flex rounded-full bg-black/5 p-[3px] dark:bg-white/10">
        {tabs.map((x) => (
          <button
            key={x.key}
            type="button"
            role="tab"
            aria-selected={tab === x.key}
            data-guest-tab={x.key}
            onClick={() => setTab(x.key)}
            className={cn(
              'h-9 flex-1 rounded-full text-sm font-semibold',
              tab === x.key
                ? 'bg-white text-zinc-950 shadow-sm dark:bg-zinc-800 dark:text-white'
                : 'text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200',
            )}
          >
            {x.label}
          </button>
        ))}
      </div>

      {tab === 'hub' ? (
        <div className="flex flex-col gap-[18px]">
          {voteCount > 0 || (requests && requests.total > 0) || updated ? (
          <section>
            <SectionHeader className={LABEL}>{t('auth:guest.project.happening')}</SectionHeader>
            <GroupedList className="mx-0">
              {voteCount > 0 ? (
                <Row last={false} onClick={() => setTab('workshop')}>
                  <span className="flex-1 text-[15px] font-[650] text-zinc-900 dark:text-zinc-100">{t('auth:guest.project.votesOpen', { count: voteCount })}</span>
                </Row>
              ) : null}
              {requests && requests.total > 0 ? (
                <Row last={false} onClick={() => setTab('workshop')}>
                  <span className="flex-1 text-[15px] font-[650] text-zinc-900 dark:text-zinc-100">
                    {requests.more
                      ? t('auth:guest.project.requestsOpenMore', { total: requests.total })
                      : t('auth:guest.project.requestsOpen', { count: requests.total })}
                  </span>
                </Row>
              ) : null}
              {updated ? (
                <Row last>
                  <span className="flex-1 text-[15px] font-[650] text-zinc-900 dark:text-zinc-100">
                    {t('auth:guest.project.updated', { when: updated })}
                  </span>
                </Row>
              ) : null}
            </GroupedList>
          </section>
          ) : null}

          {votes.length ? (
            <section className="flex flex-col gap-2">
              <SectionHeader className={LABEL}>{t('auth:guest.project.upForVote')}</SectionHeader>
              {voteCards(3)}
            </section>
          ) : null}

          {overview?.merged.length ? (
            <section>
              <SectionHeader className={LABEL}>{t('auth:guest.project.votedIn')}</SectionHeader>
              <GroupedList className="mx-0">
                {overview.merged.slice(0, 3).map((m, i, all) => (
                  <div key={m.id} data-guest-merged={m.id} className={cn('flex items-start gap-3 px-3.5 py-3', i < all.length - 1 ? 'shadow-[inset_0_-1px_0_var(--app-sheet-line)]' : '')}>
                    <div className="min-w-0 flex-1">
                      <div className="text-[15px] font-[650] text-zinc-900 dark:text-zinc-100">{m.title || t('auth:guest.project.untitledChange')}</div>
                      {m.summary ? <div className="text-[13px] leading-[18px] text-zinc-500 dark:text-zinc-400">{m.summary}</div> : null}
                    </div>
                    {m.merged_at ? <span className="whitespace-nowrap text-xs text-zinc-500 dark:text-zinc-400">{agoStamp(m.merged_at).text}</span> : null}
                  </div>
                ))}
              </GroupedList>
            </section>
          ) : null}

          <section>
            <SectionHeader className={LABEL}>{t('auth:guest.project.peopleLabel')}</SectionHeader>
            <div className={cn(CARD, 'flex items-center gap-3 p-3.5')}>
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white" style={{ background: color }} aria-hidden="true">
                <UserGroupIcon className="h-[18px] w-[18px]" />
              </span>
              <div className="min-w-0">
                <div className="text-[15px] font-[650] text-zinc-900 dark:text-zinc-100">{t('auth:guest.project.builders', { count: builders })}</div>
                {active > 0 ? <div className="text-[13px] text-zinc-500 dark:text-zinc-400">{t('auth:guest.project.active', { count: active })}</div> : null}
              </div>
            </div>
          </section>

          <section>
            <SectionHeader className={LABEL}>{t('auth:guest.project.fromChat')}</SectionHeader>
            <MembersOnly app={app} onIntent={onIntent} />
          </section>
        </div>
      ) : null}

      {tab === 'workshop' ? (
        <div className="flex flex-col gap-[18px]">
          <section className="flex flex-col gap-2">
            <SectionHeader className={LABEL}>{t('auth:guest.project.upForVote')}</SectionHeader>
            {votes.length ? voteCards(votes.length) : (
              <div className={cn(CARD, 'p-3.5 text-[15px] text-zinc-500 dark:text-zinc-400')}>
                {loaded ? t('auth:guest.project.noVotes') : t('auth:guest.project.loading')}
              </div>
            )}
          </section>
          <section>
            <div className="flex items-center justify-between gap-2 px-1 pb-2">
              <SectionHeader className="p-0">{t('auth:guest.project.requests')}</SectionHeader>
              <button
                type="button"
                data-guest-ask=""
                className="flex h-9 items-center gap-1.5 rounded-full bg-white px-3.5 text-sm font-semibold text-zinc-900 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
                onClick={() => onIntent({ kind: 'ask', app })}
              >
                <PlusIcon className="h-[15px] w-[15px]" />
                {t('auth:guest.project.ask')}
              </button>
            </div>
            {requests && requests.items.length ? (
              <GroupedList className="mx-0">
                {requests.items.map((r, i) => (
                  <Row key={r.number} last={i === requests.items.length - 1 && requests.total <= requests.items.length}>
                    <span data-guest-request={r.number} className="flex-1 text-[15px] font-[650] text-zinc-900 dark:text-zinc-100">{r.title}</span>
                  </Row>
                ))}
                {requests.total > requests.items.length ? (
                  <Row last>
                    <span className="flex-1 text-[13px] text-zinc-500 dark:text-zinc-400">
                      {t('auth:guest.project.moreRequests', { count: requests.total - requests.items.length })}
                    </span>
                  </Row>
                ) : null}
              </GroupedList>
            ) : (
              <div className={cn(CARD, 'p-3.5 text-[15px] text-zinc-500 dark:text-zinc-400')}>
                {!loaded ? t('auth:guest.project.loading') : requests ? t('auth:guest.project.noRequests') : t('auth:guest.project.requestsUnavailable')}
              </div>
            )}
          </section>
        </div>
      ) : null}

      {tab === 'discussion' ? <MembersOnly app={app} onIntent={onIntent} roomy /> : null}
    </div>
  );
}
