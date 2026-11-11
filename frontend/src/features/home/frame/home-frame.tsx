/**
 * Home in the one frame, as the 2026-11-06 screen tour draws it (its step
 * s01-home, `home()` in the tour's screens/in1.mjs), under any of the nine
 * looks.
 *
 * Drawn with the frame's kit (frontend/@/components/ui/kit.tsx), whose
 * styles are the tour's own (app.css between the looks marks). The layout
 * is the 10 Nov 2026 Home proposal (the Homeroom Home Mockups artifact),
 * which puts what you launch on the left and what asks for you on the
 * right: the title, one sentence saying what needs you, one primary action
 * (Make a project); then the main column — Pinned apps (tiles: an app is
 * the one thing you launch), Pinned communities (rows that say what is new
 * there), Featured (one row of picture cards) and Communities to join
 * (rows) — beside a 400px side column — Needs you (three rows, each ending
 * in the one word that says what to do), Live this week, Your week (three
 * figures) and the season row. Under both columns, the whole width, the
 * season's challenges as one sideways row of cards. On a phone the side
 * column comes first, so what needs you is the top of the page.
 *
 * HomeScreen (../index.tsx) mounts this after mount only, when lib/skin.ts
 * says the device's look is one of the frame's and the member APIs will
 * answer (lib/platform-viewer.ts), as the first child of #home-screen; the
 * standard Home stays mounted beside it, hidden by app.css, so what
 * home.js writes still lands and nothing of the standard look changes.
 *
 * Data, all of it the product's own:
 *   Needs you            GET /api/workshop/needs-feed (votes owed, shaped by
 *                        src/routes/workshop-overview.js shapeNeedsFeed) and
 *                        GET /api/workshop/bot-questions (Homeroom bot waits
 *                        for an answer)
 *   Pinned apps          the launcher's grid store (../grid-store)
 *   Pinned communities   the pins store (../home-pins-store), with what is
 *                        owed and under way from GET /api/workshop/counts
 *   Communities to join  the public directory (../communities-to-join)
 *   Live this week       GET /api/workshop/live-feed (what went live in the
 *                        viewer's communities in the last seven days)
 *
 * TWO PAGES UNDER IT, the tour's s03 and s04, that the router does not
 * know: All apps (./home-all-apps.tsx) and All communities
 * (./home-all-communities.tsx). Which is up is this component's own state;
 * a group's "All N" opens one, the shell's own "All communities"
 * (Home.showCommunities, by its document event) the other, and a press on
 * Home in the frame's chrome comes back here.
 *
 * Every row is a door (pinned-communities.tsx's rule): a plain click lands
 * on the place through AppView, a cmd-click or middle-click keeps the href.
 */
import { useCallback, useEffect, useState } from 'react';

import { Btn, ChallengeCard, Facts, GroupLink, HRow, Meta, PageBody, PicCard, Pill, Row, Sec, Card, Tile, TileItem, Tiles, Lead, type PillKind } from '@/components/ui/kit';
import { TONE_FILL, resolveIllustration } from '../../../lib/challenge-illustrations';
import { useMessages } from '../../../lib/i18n/react';
import { useStoreState } from '../../../lib/use-store-state';
import { readDirectory } from '../communities-to-join';
import { gridStore, type IconView } from '../grid-store';
import { homePinsStore, loadHomePins, type HomePin, type JoinedCommunity } from '../home-pins-store';
import { MyStanding, myStandingStore, standingView } from '../../leaderboard/my-standing.js';
import { panelsStore, type HomePanelsState } from '../panels-store';
import { HomeAllApps } from './home-all-apps';
import { HomeAllCommunities, type OwedVote } from './home-all-communities';

/** How many rows a group shows before its link opens the rest (the tour's Home). */
const NEEDS_SHOWN = 3;
const APPS_SHOWN = 11;
const COMMUNITIES_SHOWN = 6;
const JOIN_SHOWN = 4;
const FEATURED_SHOWN = 6;
const LIVE_SHOWN = 4;
const CHALLENGES_SHOWN = 6;

/** A row of GET /api/workshop/needs-feed, the fields this screen reads. */
export type FeedRow = {
  id: number;
  kind: string;
  title: string | null;
  number?: number | null;
  yes?: number | null;
  app?: { slug?: string; name?: string; icon_url?: string | null; icon_emoji?: string | null } | null;
  approve?: boolean;
  waitingOn?: string[] | null;
};

/** A row of GET /api/workshop/bot-questions. */
export type BotQuestion = { messageId: number; appSlug: string; appName: string; issueNumber: number; question: string; at?: string };

/** A row of GET /api/workshop/live-feed (shapeLiveFeed in src/routes/workshop-overview.js). */
export type LiveRow = {
  id: number;
  number: number | null;
  title: string | null;
  at: string | null;
  author: string | null;
  app: { slug: string; name: string; icon_url: string | null; icon_emoji: string | null };
};

type DirectoryApp = {
  slug: string;
  name?: string;
  description?: string | null;
  icon_url?: string | null;
  icon_emoji?: string | null;
  icon_color?: string | null;
  /** The featured illustration, and its dark twin (src/services/public-app-directory.js). */
  illustration_url?: string | null;
  illustration_dark_url?: string | null;
  member_count?: number | null;
  /** The platform features it (an admin's pick), in `featured_order`. */
  featured?: boolean;
  featured_order?: number | null;
};

type Counts = Record<string, { working?: number; needs?: number }>;

function joinedAsPin(c: JoinedCommunity): HomePin {
  return {
    slug: c.slug,
    name: c.name || c.slug,
    iconUrl: c.icon_url ?? null,
    iconEmoji: c.icon_emoji ?? null,
    iconColor: c.icon_color ?? null,
    member: true,
  };
}

const iconProps = (icon: IconView) => (icon.kind === 'image' ? { src: icon.src } : icon.kind === 'emoji' ? { emoji: icon.emoji } : { emoji: icon.letter });

const hubHref = (slug: string) => `/app/${encodeURIComponent(slug)}/workshop?ws=status`;
const needsHref = (slug: string) => `/app/${encodeURIComponent(slug)}/workshop?ws=needs`;
const appHref = (slug: string) => `/app/${encodeURIComponent(slug)}`;

const native = (event: React.MouseEvent<HTMLElement>) => !!(window as any).NavLink?.isNativeClick?.(event);

/** Open a community's hub, as the standard Home's tile does (the door rule). */
function openHub(event: React.MouseEvent<HTMLElement>, slug: string) {
  if (native(event)) return;
  event.preventDefault();
  const win = window as any;
  try { win.AppView?._landOnHub?.(slug); } catch { /* the page opens on what it remembers */ }
  win.App?.navigateToApp?.(slug, 'dev');
}

/** Open a community's Needs you place, where the decision is taken. */
function openNeeds(event: React.MouseEvent<HTMLElement>, slug: string) {
  if (native(event)) return;
  event.preventDefault();
  const win = window as any;
  try { win.AppView?._landOnTab?.(slug, 'needs'); } catch { /* as above */ }
  win.App?.navigateToApp?.(slug, 'dev');
}

/** Launch an app. */
function openApp(event: React.MouseEvent<HTMLElement>, slug: string) {
  if (native(event)) return;
  event.preventDefault();
  (window as any).App?.navigateToApp?.(slug);
}

async function readJson(url: string): Promise<any> {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** `initial*` seed the state a render test cannot reach through effects. */
export function HomeFrame({ initialFeed = null, initialQuestions = null, initialDirectory = null, initialCounts = null, initialLive = null, initialView = 'home', now = Date.now() }: {
  initialFeed?: FeedRow[] | null;
  initialQuestions?: BotQuestion[] | null;
  initialDirectory?: DirectoryApp[] | null;
  initialCounts?: Counts | null;
  initialLive?: LiveRow[] | null;
  initialView?: 'home' | 'apps' | 'communities';
  now?: number;
}) {
  const t = useMessages('home');
  const pins = useStoreState(homePinsStore);
  const grid = useStoreState(gridStore);
  // Your season (the tour's s01): one row of the side column, from the
  // standing Challenges reads, once the standings know you.
  const standingState = useStoreState(myStandingStore) as { status: string; ranking?: { total_points?: number | string } | null };
  // The season's challenges, as Home's own strip reads them (../panels-store,
  // filled by home-panels.js): the same heading and rows, as a group.
  const { challenges } = useStoreState(panelsStore) as HomePanelsState;
  const standing = standingView(standingState) as { rank: number | null; people: number } | null;
  useEffect(() => { void MyStanding.load(); }, []);
  const [feed, setFeed] = useState<FeedRow[] | null>(initialFeed);
  const [questions, setQuestions] = useState<BotQuestion[] | null>(initialQuestions);
  const [directory, setDirectory] = useState<DirectoryApp[] | null>(initialDirectory);
  const [counts, setCounts] = useState<Counts | null>(initialCounts);
  const [live, setLive] = useState<LiveRow[] | null>(initialLive);
  const [view, setView] = useState<'home' | 'apps' | 'communities'>(initialView);
  const show = useCallback((next: 'home' | 'apps' | 'communities') => {
    setView(next);
    // A page opens at its top: Home's own scroller on a desktop, the
    // document on a phone, where the browser scrolls it.
    try {
      document.getElementById('home-screen')?.scrollTo?.({ top: 0 });
      window.scrollTo?.({ top: 0 });
    } catch { /* nothing to scroll */ }
  }, []);
  const backHome = useCallback(() => show('home'), [show]);
  useEffect(() => {
    const all = () => show('communities');
    const tab = (event: Event) => { if ((event as CustomEvent).detail === 'home') show('home'); };
    document.addEventListener('home:show-all-communities', all);
    document.addEventListener('frame:tab', tab);
    return () => {
      document.removeEventListener('home:show-all-communities', all);
      document.removeEventListener('frame:tab', tab);
    };
  }, [show]);

  useEffect(() => {
    let on = true;
    const set = <T,>(setter: (v: T) => void, empty: T) => (v: T) => { if (on) setter(v ?? empty); };
    loadHomePins().catch(() => {});
    readJson('/api/workshop/needs-feed').then((b) => (Array.isArray(b?.items) ? b.items : [])).catch(() => []).then(set(setFeed, [] as FeedRow[]));
    readJson('/api/workshop/bot-questions').then((b) => (Array.isArray(b?.questions) ? b.questions : [])).catch(() => []).then(set(setQuestions, [] as BotQuestion[]));
    readJson('/api/workshop/counts').then((b) => b?.counts || {}).catch(() => ({})).then(set(setCounts, {} as Counts));
    readJson('/api/workshop/live-feed').then((b) => (Array.isArray(b?.items) ? b.items : [])).catch(() => []).then(set(setLive, [] as LiveRow[]));
    readDirectory().then((apps) => { if (on) setDirectory((apps || []) as DirectoryApp[]); });
    return () => { on = false; };
  }, []);

  // ── Needs you: what the bot asked first (an answer unblocks a build),
  //    then the votes owed.
  const asked = questions || [];
  const votes = feed || [];
  const waiting = asked.length + votes.length;
  const where = new Set([...asked.map((q) => q.appSlug), ...votes.map((v) => v.app?.slug || '')].filter(Boolean));
  const firstName = asked[0]?.appName || votes[0]?.app?.name || '';
  const purpose = waiting === 0
    ? t('home:frame.purposeQuiet')
    : where.size > 1
      ? t('home:frame.purposeNeeds', { count: waiting, communities: where.size })
      : t('home:frame.purposeNeedsIn', { count: waiting, community: firstName });

  const voteWord = (row: FeedRow): { word: string; kind: PillKind } => {
    const on = Array.isArray(row.waitingOn) && row.waitingOn.length ? String(row.waitingOn[0]) : null;
    if (on === 'checks') return { word: t('home:frame.waiting.checks'), kind: 'wait' };
    if (on === 'conflict') return { word: t('home:frame.waiting.conflict'), kind: 'wait' };
    if (row.approve) return { word: t('home:frame.approve'), kind: 'act' };
    return { word: t('home:frame.vote'), kind: 'act' };
  };

  const needRows: React.ReactNode[] = [];
  for (const q of asked) {
    if (needRows.length >= NEEDS_SHOWN) break;
    const face = votes.find((v) => v.app?.slug === q.appSlug)?.app;
    needRows.push(
      <Row
        key={`q:${q.messageId}`}
        href={`/app/${encodeURIComponent(q.appSlug)}/dev/issues/${q.issueNumber}`}
        onClick={(event) => openNeeds(event, q.appSlug)}
        lead={<Tile name={q.appName} src={face?.icon_url} emoji={face?.icon_emoji} />}
        title={q.question}
        line={t('home:frame.askedLine', { community: q.appName, number: q.issueNumber })}
        right={<Pill kind="act">{t('home:frame.reply')}</Pill>}
        go
      />,
    );
  }
  for (const row of votes) {
    if (needRows.length >= NEEDS_SHOWN) break;
    const slug = row.app?.slug || '';
    const name = row.app?.name || slug;
    const { word, kind } = voteWord(row);
    needRows.push(
      <Row
        key={`${row.kind}:${row.id}`}
        href={slug ? needsHref(slug) : '#needs'}
        onClick={slug ? (event) => openNeeds(event, slug) : undefined}
        lead={<Tile name={name} src={row.app?.icon_url} emoji={row.app?.icon_emoji} />}
        title={row.title || name}
        line={t('home:frame.voteLine', { community: name, count: Number(row.yes) || 0 })}
        right={<Pill kind={kind}>{word}</Pill>}
        go
      />,
    );
  }

  // ── Pinned apps: the launcher's own tiles.
  const apps = grid.ready ? grid.items.filter((i) => i.kind === 'card').map((i) => i.app) : [];

  // ── Pinned communities: the pinned ones first, then the joined ones not pinned.
  const pinned = new Set(pins.pins.map((p) => p.slug));
  const mine: HomePin[] = [...pins.pins, ...pins.joined.filter((c) => !pinned.has(c.slug)).map(joinedAsPin)];
  const inMine = new Set(mine.map((p) => p.slug));
  const toJoinAll = (directory || []).filter((a) => a && a.slug && !inMine.has(a.slug));
  // The platform's featured communities lead, under their own label, in
  // their order; the rest follow as Communities to join.
  const featured = toJoinAll.filter((a) => a.featured).sort((a, b) => (a.featured_order ?? Number.MAX_SAFE_INTEGER) - (b.featured_order ?? Number.MAX_SAFE_INTEGER));
  const toJoin = toJoinAll.filter((a) => !a.featured);

  const communityLine = (slug: string): string => {
    const owed = pins.owed[slug] || 0;
    const working = Number(counts?.[slug]?.working) || 0;
    return [
      owed > 0 ? t('home:frame.toVote', { count: owed }) : '',
      working > 0 ? t('home:frame.inProgress', { count: working }) : '',
    ].filter(Boolean).join(' · ');
  };

  // ── Live this week.
  const ago = (iso?: string | null): string => {
    const ms = iso ? now - new Date(iso).getTime() : NaN;
    if (!Number.isFinite(ms) || ms < 0) return '';
    const minutes = Math.floor(ms / 60000);
    if (minutes < 60) return t('home:frame.ago.minutes', { count: Math.max(1, minutes) });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t('home:frame.ago.hours', { count: hours });
    return t('home:frame.ago.days', { count: Math.floor(hours / 24) });
  };
  const went = (live || []).slice(0, LIVE_SHOWN);

  const seasonPoints = Math.round(Number(standingState.ranking?.total_points || 0));
  const openChallenges = challenges ? challenges.rows.filter((row) => row.state !== 'done').length : 0;
  const week = standing && standing.rank != null ? (
    <Sec label={t('home:frame.yourWeek')} id="home-frame-week">
      <Facts items={[
        { value: `#${standing.rank}`, label: t('home:frame.thisSeason'), tone: 'acc' },
        { value: seasonPoints.toLocaleString('en-US'), label: t('home:frame.pointsLabel') },
        { value: openChallenges, label: t('home:frame.challengesGoing', { count: openChallenges }), tone: 'ok' },
      ]} />
    </Sec>
  ) : null;
  const season = standing && standing.rank != null ? (
    <Sec label={t('home:frame.season')}>
      <Card>
        <Row
          href="#leaderboard/challenges"
          lead={<Lead>{standing.rank}</Lead>}
          title={standing.people > 0 ? t('home:frame.seasonRank', { rank: standing.rank, count: standing.people, number: standing.people.toLocaleString('en-US') }) : t('home:frame.seasonRankAlone', { rank: standing.rank })}
          line={seasonPoints > 0 ? t('home:frame.seasonPoints', { count: seasonPoints, points: seasonPoints.toLocaleString('en-US') }) : undefined}
          go
        />
      </Card>
    </Sec>
  ) : null;
  const liveSec = went.length > 0 ? (
    <Sec label={t('home:frame.liveThisWeek')} id="home-frame-live">
      <Card>
        {went.map((row) => (
          <Row
            key={row.id}
            href={hubHref(row.app.slug)}
            onClick={(event) => openHub(event, row.app.slug)}
            lead={<Tile name={row.app.name} src={row.app.icon_url} emoji={row.app.icon_emoji} />}
            title={row.title || row.app.name}
            line={row.author ? `${row.app.name} · ${row.author}` : row.app.name}
            right={<Meta>{ago(row.at)}</Meta>}
          />
        ))}
      </Card>
    </Sec>
  ) : null;
  const needsSec = needRows.length > 0 ? (
    <Sec
      label={t('home:frame.needs')}
      id="home-frame-needs"
      action={waiting > needRows.length
        ? <GroupLink href="#needs">{t('home:frame.all', { count: waiting })}</GroupLink>
        : null}
    >
      <Card>{needRows}</Card>
    </Sec>
  ) : null;
  const side = needsSec || liveSec || week ? <>{needsSec}{liveSec}{week}{season}</> : null;

  // ── The season's challenges: one row of cards under both columns.
  const challengesSec = challenges && challenges.rows.length > 0 ? (
    <Sec
      label={challenges.heading}
      id="home-frame-challenges"
      action={challenges.seeAll ? <GroupLink href="#leaderboard/challenges">{t('home:challenges.seeAll.text')}</GroupLink> : null}
    >
      <HRow>
        {challenges.rows.slice(0, CHALLENGES_SHOWN).map((row) => {
          const art = resolveIllustration(row.illustration, row.illustrationTone);
          return (
            <ChallengeCard
              key={row.id}
              href={row.eventId != null ? `#leaderboard/challenges/${row.eventId}` : '#leaderboard/challenges'}
              art={art ? { src: art.src, fill: TONE_FILL[art.tone] } : null}
              icon={row.icon}
              title={row.goal}
              state={row.state}
              label={row.stateLabel}
              fill={row.fill}
              reward={row.earned || row.reward}
            />
          );
        })}
      </HRow>
    </Sec>
  ) : null;

  if (view === 'apps') return <HomeAllApps onBack={backHome} />;
  if (view === 'communities') {
    const owedVotes: OwedVote[] = votes.map((v) => ({
      key: `${v.kind}:${v.id}`, title: v.title || v.app?.name || '', community: v.app?.name || '', slug: v.app?.slug || '',
      iconUrl: v.app?.icon_url, iconEmoji: v.app?.icon_emoji,
    }));
    return <HomeAllCommunities onBack={backHome} mine={mine} votes={owedVotes} />;
  }

  return (
    <PageBody
      data-home-frame=""
      title={t('home:frame.title')}
      purpose={purpose}
      acts={<Btn icon="plus" onClick={() => { (window as any).App?.showCreateModal?.(); }}>{t('home:frame.make')}</Btn>}
      side={side}
      sideFirst
      wide
      below={challengesSec}
    >
      {apps.length > 0 ? (
        <Sec
          label={t('home:frame.pinnedApps')}
          id="home-frame-apps"
          action={<GroupLink onClick={() => { (window as any).Home?.setEditing?.(true); }}>{t('home:frame.edit')}</GroupLink>}
        >
          <Tiles>
            {apps.slice(0, APPS_SHOWN).map((app) => (
              <TileItem
                key={app.slug}
                href={appHref(app.slug)}
                onClick={(event) => openApp(event, app.slug)}
                tile={<Tile size={52} name={app.name} {...iconProps(app.icon)} />}
                name={app.name}
              />
            ))}
            {apps.length > APPS_SHOWN ? (
              <TileItem
                onClick={() => show('apps')}
                tile={<Lead icon="grid" size={52} />}
                name={t('home:frame.all', { count: apps.length })}
              />
            ) : null}
          </Tiles>
        </Sec>
      ) : null}

      {mine.length > 0 ? (
        <Sec
          label={t('home:frame.pinnedCommunities')}
          id="home-frame-communities"
          action={mine.length > COMMUNITIES_SHOWN
            ? <GroupLink onClick={() => show('communities')}>{t('home:frame.all', { count: mine.length })}</GroupLink>
            : null}
        >
          <Card>
            {mine.slice(0, COMMUNITIES_SHOWN).map((c) => {
              const owed = pins.owed[c.slug] || 0;
              return (
                <Row
                  key={c.slug}
                  href={hubHref(c.slug)}
                  onClick={(event) => openHub(event, c.slug)}
                  lead={<Tile name={c.name} src={c.iconUrl} emoji={c.iconEmoji} color={c.iconColor} />}
                  title={c.name}
                  line={communityLine(c.slug) || undefined}
                  right={owed > 0 ? <Pill kind="act">{t('home:frame.toVote', { count: owed })}</Pill> : null}
                  go
                />
              );
            })}
          </Card>
        </Sec>
      ) : null}

      {featured.length > 0 ? (
        <Sec label={t('home:join.featured')} id="home-frame-featured">
          <HRow>
            {featured.slice(0, FEATURED_SHOWN).map((a) => (
              <PicCard
                key={a.slug}
                href={hubHref(a.slug)}
                onClick={(event) => openHub(event, a.slug)}
                cover={a.illustration_url}
                darkCover={a.illustration_dark_url}
                tile={<Tile size={56} name={a.name || a.slug} src={a.icon_url} emoji={a.icon_emoji} color={a.icon_color} />}
                title={a.name || a.slug}
                line={a.description || undefined}
                meta={a.member_count ? t('home:join.members', { count: a.member_count }) : undefined}
                word={t('home:frame.join')}
              />
            ))}
          </HRow>
        </Sec>
      ) : null}

      {toJoin.length > 0 ? (
        <Sec
          label={t('home:frame.toJoin')}
          id="home-frame-to-join"
          action={toJoin.length > JOIN_SHOWN
            ? <GroupLink onClick={() => { (window as any).Home?.showCommunitiesToJoin?.(); }}>{t('home:frame.browseAll')}</GroupLink>
            : null}
        >
          <Card>
            {/* The row is the door to the hub, where Join lives with what the
                community is about; its word is Join, not a button inside the
                link. */}
            {toJoin.slice(0, JOIN_SHOWN).map((a) => (
              <Row
                key={a.slug}
                href={hubHref(a.slug)}
                onClick={(event) => openHub(event, a.slug)}
                lead={<Tile name={a.name || a.slug} src={a.icon_url} emoji={a.icon_emoji} color={a.icon_color} />}
                title={a.name || a.slug}
                line={a.member_count ? t('home:join.members', { count: a.member_count }) : undefined}
                right={<span className="fr-btn fr-sm">{t('home:frame.join')}</span>}
              />
            ))}
          </Card>
        </Sec>
      ) : null}
    </PageBody>
  );
}
