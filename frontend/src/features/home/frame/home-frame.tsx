/**
 * Home in the one frame, under any of the five looks: version 2 of the
 * screen tour's step s01-home (docs/superpowers/plans/
 * 2026-11-11-looks-v2-todays-content.md). The first tour's layout (the
 * kit's head, its two columns, its tiles, cards and rows) holding today's
 * Home, section for section:
 *
 *   the search field      Home's own (#home-search-input, which home.js
 *                         wires): the kit field writes its words there, so
 *                         one search still filters the apps grid, Pinned
 *                         communities and Communities to join
 *   Pinned apps           the launcher's grid store (../grid-store), folded
 *                         and unfolded by Home itself ("Show all N apps"),
 *                         with Edit (remove a tile, add other apps) and New
 *                         project under the standard heading's own rules
 *   Pinned communities    the pins store (../home-pins-store) as tiles, then
 *                         Needs you, All communities (which shows, faded,
 *                         the ones you are in and have not pinned) and New
 *                         community, as ../pinned-communities.tsx draws them
 *   Communities to join   the public directory (../communities-to-join):
 *                         the kind filter, Featured as cards, then the rest
 *                         as rows, each with a real Join, more as you scroll
 *   Next challenges       the side column: Home's own strip
 *                         (../panels-store, filled by home-panels.js) as rows
 *
 * Nothing here fetches or words anything of its own, except the page's
 * title and its one sentence, which today's Home does not have.
 *
 * HomeScreen (../index.tsx) mounts this after mount only, when lib/skin.ts
 * says the device's look is one of the frame's and the member APIs will
 * answer (lib/platform-viewer.ts), as the first child of #home-screen; the
 * standard Home stays mounted beside it, hidden by app.css, so what
 * home.js writes still lands and nothing of the standard look changes.
 *
 * Four pieces of the standard Home are not redrawn: they are handed in by
 * HomeScreen as they are, one instance each (so no id is in the document
 * twice), and stand inside this page as the product's own (class `fr-own`,
 * where the kit's reset stops; app.css, HOME UNDER A LOOK, dresses them):
 *
 *   the grid while it is arranged   Edit swaps the kit's tiles for the
 *                         standard launcher grid (../app-grid.tsx), so a
 *                         drag rearranges Pinned apps by the product's one
 *                         controller and layout (home.js, HomeLayout: four
 *                         columns of cells), on a desktop and by touch
 *   the iOS widget strip, the waitlist card, the verify card
 *
 * A tile's menu opens on a right-click and on a hold (home.js
 * _wireCardLongPressMenu, the standard tile's own), and offers Edit My apps.
 *
 * Every tile and row is a door (pinned-communities.tsx's rule): a plain
 * click lands on the place through AppView, a cmd-click or middle-click
 * keeps the href.
 */
import { useHomeSearchPlaceholder } from '../search-hint';
import { useEffect, useMemo, useRef, useState } from 'react';

import { Btn, Card, CapSub, ChallengeArt, Count, GroupLink, HCard, Icon, Lead, Mut, Note, PageBody, Pill, Row, RowArrow, Search, Sec, SecNote, ShowAll, Sub, Tile, k } from '@/components/ui/kit';
import { resolveIllustration } from '../../../lib/challenge-illustrations';
import { useCommunityColor } from '../../../lib/community-color';
import { useMessages } from '../../../lib/i18n/react';
import { useStoreState } from '../../../lib/use-store-state';
import { useVisibility } from '../../../lib/visibility-store';
import { liveAppLabel, useLiveAppSlugs } from '../../app-frame/live-apps';
import { type GuestApp, MIN_PEOPLE, isNew } from '../../guest/guest-data';
import { communityScopeStore } from '../../workshop/community-scope';
import { openAddAppsSheet } from '../add-apps-sheet';
import { chromeStore } from '../chrome-store';
import { readDirectory } from '../communities-to-join';
import { gridStore, type HomeAppView, type IconView } from '../grid-store';
import { homePinsStore, setHomePin, type HomePin } from '../home-pins-store';
import { panelsStore, type HomePanelsState } from '../panels-store';
import { HOME_SEARCH_SHORTCUT_KEYS } from '../search-shortcut';
import { matchesQuery, useSettledHomeQuery } from '../use-home-query';
import { ToJoinView } from './to-join';

/** A tile's picture in the grids of this page. */
const FACE = 52;

const iconProps = (icon: IconView) => (icon.kind === 'image' ? { src: icon.src } : icon.kind === 'emoji' ? { emoji: icon.emoji } : { emoji: icon.letter });

const hubHref = (slug: string) => `/app/${encodeURIComponent(slug)}/workshop?ws=status`;
const appHref = (slug: string) => `/app/${encodeURIComponent(slug)}`;

const win = (): any => (typeof window !== 'undefined' ? window : null);
const native = (event: React.MouseEvent<HTMLElement>) => !!win()?.NavLink?.isNativeClick?.(event);

/** Open a community's hub, as the standard Home's tile does (the door rule). */
function openHub(event: React.MouseEvent<HTMLElement>, slug: string) {
  if (native(event)) return;
  event.preventDefault();
  try { win()?.AppView?._landOnHub?.(slug); } catch { /* the page opens on what it remembers */ }
  win()?.App?.navigateToApp?.(slug, 'dev');
}

/** Launch an app. */
function openApp(event: React.MouseEvent<HTMLElement>, slug: string) {
  if (native(event)) return;
  event.preventDefault();
  win()?.App?.navigateToApp?.(slug);
}

/** The − that takes a tile off Home, on its corner while its group is being edited. */
function Minus() {
  return <span aria-hidden="true">&minus;</span>;
}

/**
 * One tile of a grid: its picture, its name, a count if it asks for you,
 * and at most one control of its own on a corner. Always a group holding
 * its door beside that control, since a button may not sit inside a link.
 */
function HomeTile({ face, name, count, href, onClick, inert, dim, lit, pressed, corner, marks, status, title, label, id, onContextMenu, nodeRef, ring, ...data }: {
  face: React.ReactNode;
  name: React.ReactNode;
  count?: number;
  href?: string;
  onClick?: (event: React.MouseEvent<HTMLElement>) => void;
  /** Not a door right now: a tile being arranged, an app that cannot open yet. */
  inert?: boolean;
  dim?: boolean;
  lit?: boolean;
  pressed?: boolean;
  corner?: React.ReactNode;
  /** Small marks on the picture: made from another app, who it is for, still open. */
  marks?: React.ReactNode;
  /** One short line under the name: an app that is being made, or failed. */
  status?: React.ReactNode;
  title?: string;
  label?: string;
  id?: string;
  onContextMenu?: (event: React.MouseEvent<HTMLElement>) => void;
  nodeRef?: React.Ref<HTMLDivElement>;
  /** A community's tile: the ring of its colour, which tells it from an app (../pinned-communities.tsx). */
  ring?: string;
} & Record<`data-${string}`, string | undefined> & Pick<React.HTMLAttributes<HTMLDivElement>, 'onPointerDownCapture' | 'onPointerCancel'>) {
  const body = (<>{face}<Count>{count}</Count><span className={k('nm')}>{name}</span></>);
  return (
    <div ref={nodeRef} className={k('at', dim && 'dim', lit && 'lit', ring && 'ring')} style={ring ? { '--fr-cr': ring } as React.CSSProperties : undefined} title={title} onContextMenu={onContextMenu} {...data}>
      {inert
        ? <span className={k('atl')}>{body}</span>
        : href
          ? <a className={k('atl')} id={id} href={href} onClick={onClick} aria-label={label}>{body}</a>
          : <button type="button" className={k('atl')} id={id} onClick={onClick} aria-pressed={pressed} aria-label={label}>{body}</button>}
      {marks}
      {corner}
      {status}
    </div>
  );
}

/**
 * A community's tile: the tile of the grid, in the ring of the community's
 * colour, as the standard Home draws it so a community never reads as an app.
 */
function CommunityTile({ of, ...tile }: { of: { slug: string; iconUrl?: string | null; iconEmoji?: string | null; iconColor?: string | null } } & Omit<React.ComponentProps<typeof HomeTile>, 'ring'>) {
  const ring = useCommunityColor({ color: of.iconColor || null, iconUrl: of.iconUrl || null, iconEmoji: of.iconEmoji || null, key: of.slug });
  return <HomeTile ring={ring} {...tile} />;
}

/** An app of Pinned apps: the launcher's own tile, with what the standard tile says about it. */
function AppTile({ app, editing, yours, live }: { app: HomeAppView; editing: boolean; yours: boolean; live: boolean }) {
  const t = useMessages('home');
  const home = () => win()?.Home;
  const made = app.forkName
    ? (app.forkDeleted ? t('home:grid.tile.remixedFromDeleted', { open: '<', close: '>' }) : t('home:grid.tile.remixedFrom', { app: app.forkName }))
    : '';
  const whose = app.audience === 'invited' ? t('home:grid.tile.audience.invited') : app.audience === 'solo' ? t('home:grid.tile.audience.solo') : '';
  // A hold opens the tile's menu, as on the standard tile: home.js's own
  // recogniser, which reads the slug off the node. The node carries no
  // data-yours, which there hands a touch to the grid's drag: these tiles
  // are not dragged (Edit shows the standard grid for that).
  const node = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = node.current;
    if (!el) return undefined;
    const unwire = home()?._wireCardLongPressMenu?.(el);
    // A menu opened by a finger's hold may lie under that finger, and the
    // click its release sends would press whichever item is there. On the
    // standard grid the drag's recogniser owns the touch and no such click
    // arrives; here the release's click is eaten once.
    const onDown = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') return;
      const end = () => {
        window.removeEventListener('pointerup', end, true);
        window.removeEventListener('pointercancel', end, true);
        if (!home()?._suppressClick) return;
        const eat = (click: Event) => { click.preventDefault(); click.stopPropagation(); };
        window.addEventListener('click', eat, { capture: true, once: true });
        window.setTimeout(() => window.removeEventListener('click', eat, true), 400);
      };
      window.addEventListener('pointerup', end, true);
      window.addEventListener('pointercancel', end, true);
    };
    el.addEventListener('pointerdown', onDown);
    return () => { el.removeEventListener('pointerdown', onDown); if (typeof unwire === 'function') unwire(); };
  }, [app.slug]);
  return (
    <HomeTile
      nodeRef={node}
      data-slug={app.slug}
      // What home.js reads to offer "Edit My apps" in the menu: a tile of your own, not a demo.
      data-home-frame-tile={yours && !app.demo ? 'yours' : 'app'}
      onPointerDownCapture={(event) => { const N = home(); if (N) N._cardPointerType = event.pointerType; }}
      onPointerCancel={() => { home()?.closeCardMenu?.(); }}
      face={<Tile size={FACE} name={app.name} {...iconProps(app.icon)} />}
      name={app.name}
      href={appHref(app.slug)}
      onClick={(event) => {
        // The press that ends a hold opened the menu; it does not open the app too.
        const N = home();
        if (N?._suppressClick) { N._suppressClick = false; event.preventDefault(); return; }
        openApp(event, app.slug);
      }}
      // While the grid is being arranged a tile is not a door (#4669).
      inert={editing || !app.clickable}
      dim={!app.clickable && !app.showRetry}
      title={t('home:grid.tile.tip', { app: app.name })}
      // The tile's menu, as a right-click opens it on the standard tile.
      onContextMenu={(event) => {
        const N = home();
        if (!N?.openCardMenu || (event.target as HTMLElement).closest('button')) return;
        event.preventDefault();
        // A phone's browser sends contextmenu during the same hold: the menu is opened once.
        if (N._cardPointerType === 'touch') { if (!N._menu) N.openCardMenu(app.slug, event.currentTarget); return; }
        if ((N._menuAnchor || N._menuAnchorAtPress) === event.currentTarget) { N.closeCardMenu?.(); return; }
        N.openCardMenu(app.slug, event.currentTarget);
      }}
      marks={(
        <>
          {made ? <span className={k('tag', 'l')} role="img" title={made} aria-label={made}><Icon name="copy" size={12} /></span> : null}
          {whose ? <span className={k('tag', 'r')} role="img" title={whose} aria-label={whose}><Icon name={app.audience === 'invited' ? 'users' : 'lock'} size={12} /></span> : null}
          {live ? <span className={k('live')} role="img" title={liveAppLabel()} aria-label={liveAppLabel()} /> : null}
        </>
      )}
      corner={editing && yours && !app.demo ? (
        <button
          type="button"
          className={k('corner', 'un')}
          aria-label={t('home:edit.removeNamed', { app: app.name })}
          onClick={() => { home()?._editRemove?.(app.slug); }}
        >
          <Minus />
        </button>
      ) : null}
      status={app.statusLabel ? (
        <>
          <span className={k('st', app.buildLine ? '' : app.isAwaiting ? 'wait' : 'bad')} title={app.failureReason || undefined}>{app.statusLabel}</span>
          {app.showRetry ? (
            <button
              type="button"
              className={k('link')}
              aria-label={t('home:grid.tile.retryNamed', { app: app.name })}
              onClick={(event) => { home()?._onRetry?.(app.slug, event.currentTarget); }}
            >
              {t('core:common.retry')}
            </button>
          ) : null}
        </>
      ) : null}
    />
  );
}

/** Pinned apps: the launcher's grid, as tiles in one card. */
function PinnedApps({ grid: standardGrid }: { grid?: React.ReactNode }) {
  const t = useMessages('home');
  const grid = useStoreState(gridStore);
  const { moreCount } = useStoreState(chromeStore);
  const live = useLiveAppSlugs();
  const home = () => win()?.Home;
  // The standard heading's own rules (../index.tsx).
  const canEdit = grid.ready && grid.view === 'grid' && !grid.editing && grid.items.some((item) => !item.app.demo);
  const noApps = grid.ready && grid.view === 'grid' && !grid.editing && grid.items.length === 0 && !grid.create;
  if (!grid.ready && !grid.notice) return null;
  if (noApps && !grid.notice) return null;
  const create = grid.create;
  const newProject = () => { win()?.App?.showCreateModal?.(); };
  const locked = create ? t('home:create.lockedTip', { hint: create.hint }) : '';
  const action = grid.editing ? (
    <>
      <GroupLink onClick={() => { openAddAppsSheet(); }}>{t('home:edit.addTile')}</GroupLink>
      <GroupLink onClick={() => { home()?.setEditing?.(false); }}>{t('home:edit.done')}</GroupLink>
    </>
  ) : (canEdit || create?.heldBack) ? (
    <>
      {canEdit ? <GroupLink onClick={() => { home()?.setEditing?.(true); }}>{t('home:edit.start')}</GroupLink> : null}
      {create?.heldBack ? <GroupLink onClick={newProject}>{t('home:create.label')}</GroupLink> : null}
    </>
  ) : null;
  const tiles = grid.items.length > 0 || (create && !create.heldBack);
  return (
    <Sec label={t('home:grid.heading')} id="home-frame-apps" action={action} data-editing={grid.editing ? '' : undefined}>
      {grid.notice && grid.notice.tone === 'error' ? (
        <Card pad>
          <Note tone="bad" icon="alert">{grid.notice.text}</Note>
          <div className={k('btnrow')}>
            <Btn small kind="quiet" onClick={() => { home()?.load?.(); }}>{t('core:common.tryAgain')}</Btn>
          </div>
        </Card>
      ) : grid.notice ? (
        <SecNote>{grid.notice.text}</SecNote>
      ) : null}
      {grid.emptyQuery !== null ? (
        <SecNote>
          {t('home:grid.noMatches', { query: grid.emptyQuery })}
        </SecNote>
      ) : null}
      {grid.resultsHeading ? <CapSub>{grid.resultsHeading}</CapSub> : null}
      {grid.editing && standardGrid ? (
        // Arranging: the standard grid itself, in the look's card. Its tiles
        // are dragged, removed and added by home.js, as without a look.
        <Card>
          <div className={k('own')} data-home-frame-own="grid">{standardGrid}</div>
        </Card>
      ) : tiles ? (
        <Card>
          <div className={k('tiles')}>
            {grid.items.map((item) => (
              <AppTile
                key={item.app.slug}
                app={item.app}
                editing={grid.editing}
                yours={grid.view === 'grid'}
                live={live.includes(item.app.slug)}
              />
            ))}
            {/* The grid's last tile, unless the folded grid holds it back: then it is the heading's link. */}
            {create && !create.heldBack ? (
              <HomeTile
                id="home-frame-create"
                face={<Lead icon="plus" size={FACE} dash />}
                name={t('home:create.label')}
                dim={!create.enabled}
                title={create.enabled ? t('home:create.tip') : locked}
                label={create.enabled ? undefined : locked}
                onClick={newProject}
              />
            ) : null}
          </div>
          {moreCount > 0 ? (
            <ShowAll
              go
              onClick={() => {
                const N = home();
                if (!N) return;
                N._appsExpanded = true;
                N.render();
              }}
            >
              {t('home:grid.showAll', { count: moreCount })}
            </ShowAll>
          ) : null}
        </Card>
      ) : null}
    </Sec>
  );
}

/** Pinned communities: the pins as tiles, then the section's own three tiles. */
function PinnedCommunities({ query }: { query: string }) {
  const t = useMessages('home');
  const state = useStoreState(homePinsStore);
  const { badgeNeeds } = useStoreState(communityScopeStore) as { badgeNeeds?: number };
  const needs = Math.max(0, Number(badgeNeeds) || 0);
  const [editing, setEditing] = useState(false);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => { if (query) setEditing(false); }, [query]);

  const pinned = useMemo(() => state.pins.filter((p) => matchesQuery(query, p.name, p.slug)), [state.pins, query]);
  const unpinned = useMemo(() => {
    const on = new Set(state.pins.map((p) => p.slug));
    return state.joined
      .filter((c) => !on.has(c.slug))
      .map((c) => ({ slug: c.slug, name: c.name || c.slug, iconUrl: c.icon_url || null, iconEmoji: c.icon_emoji || null, iconColor: c.icon_color || null }))
      .filter((c) => matchesQuery(query, c.name, c.slug));
  }, [state.joined, state.pins, query]);
  const say = (name: string) => ({
    pinned: t('home:communities.pinned', { community: name }),
    unpinned: t('home:communities.unpinned', { community: name }),
    failed: (reason: string) => t('home:communities.failed', { reason }),
  });
  const offerCreate = state.ready && !win()?.App?.user?.privateMember;
  const createOn = offerCreate && !!win()?.Home?.canCreate?.();
  const locked = t('home:communities.newLocked', { hint: t('home:create.disabledHint') });
  const visible = state.ready && (pinned.length > 0 || unpinned.length > 0 || (!query && (offerCreate || needs > 0)));
  if (!visible) return null;

  return (
    <Sec
      label={t('home:communities.heading')}
      id="home-frame-communities"
      data-editing={editing ? '' : undefined}
      action={state.pins.length && !query ? (
        <button
          type="button"
          className={k('link')}
          aria-label={editing ? t('home:edit.done') : t('home:communities.editLabel')}
          onClick={() => setEditing((on) => !on)}
        >
          {editing ? t('home:edit.done') : t('home:edit.start')}
        </button>
      ) : null}
    >
      <Card>
        <div className={k('tiles')}>
          {pinned.map((pin) => (
            <CommunityTile
              key={pin.slug}
              of={pin}
              face={<Tile size={FACE} name={pin.name} src={pin.iconUrl} emoji={pin.iconEmoji} color={pin.iconColor} />}
              name={pin.name}
              count={editing ? undefined : state.owed[pin.slug] || 0}
              href={hubHref(pin.slug)}
              onClick={(event) => openHub(event, pin.slug)}
              inert={editing}
              corner={editing ? (
                <button
                  type="button"
                  className={k('corner', 'un')}
                  aria-label={t('home:communities.unpinNamed', { community: pin.name })}
                  onClick={() => { void setHomePin(pin, false, say(pin.name)); }}
                >
                  <Minus />
                </button>
              ) : null}
            />
          ))}
          {(showAll || query) && !editing ? unpinned.map((c) => (
            <CommunityTile
              key={c.slug}
              of={c}
              dim
              face={<Tile size={FACE} name={c.name} src={c.iconUrl} emoji={c.iconEmoji} color={c.iconColor} />}
              name={c.name}
              count={state.owed[c.slug] || 0}
              href={hubHref(c.slug)}
              onClick={(event) => openHub(event, c.slug)}
              corner={(
                <button
                  type="button"
                  className={k('corner')}
                  aria-label={t('home:communities.pinNamed', { community: c.name })}
                  onClick={() => { void setHomePin({ ...c, member: true } as HomePin, true, say(c.name)); }}
                >
                  <Icon name="plus" size={14} />
                </button>
              )}
            />
          )) : null}
          {needs > 0 && !query && !editing ? (
            <HomeTile
              id="home-frame-needs-tile"
              face={<Lead icon="vote" tone="acc" size={FACE} />}
              name={t('home:communities.needs')}
              count={needs}
              href="#needs"
              label={t('home:communities.needsNamed', { count: needs })}
            />
          ) : null}
          {unpinned.length && !query && !editing ? (
            <HomeTile
              id="home-frame-all-communities"
              face={<Lead icon="grid" size={FACE} />}
              name={t('home:communities.all')}
              lit={showAll}
              pressed={showAll}
              onClick={() => setShowAll((on) => !on)}
            />
          ) : null}
          {offerCreate && !query && !editing ? (
            <HomeTile
              id="home-frame-new-community"
              face={<Lead icon="plus" size={FACE} dash />}
              name={t('home:communities.new')}
              dim={!createOn}
              title={createOn ? t('home:communities.newTip') : locked}
              label={createOn ? undefined : locked}
              // Both states open the same dialog: at the limit its quota row explains the lock.
              onClick={() => { win()?.App?.showCreateModal?.(); }}
            />
          ) : null}
        </div>
      </Card>
    </Sec>
  );
}

/** Communities to join: the public directory, less the ones already on this Home (./to-join.tsx draws it). */
function ToJoin({ query, initialDirectory }: { query: string; initialDirectory: GuestApp[] | null }) {
  const t = useMessages('home');
  const ta = useMessages('auth');
  const pins = useStoreState(homePinsStore);
  const [apps, setApps] = useState<GuestApp[] | null>(initialDirectory);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // The directory, read as ../home-join.tsx reads it: null is one that could
  // not be read, which says so and offers to try again.
  // And only while Home is on show (#6591, ../home-join.tsx): Home stays
  // mounted behind every other screen.
  const shown = useVisibility('home-screen', true);
  useEffect(() => {
    if (!pins.ready || !shown) return undefined;
    let on = true;
    setFailed(false);
    void readDirectory(attempt > 0).then((list) => {
      if (!on) return;
      if (list) setApps(list);
      else { setApps(null); setFailed(true); }
    });
    return () => { on = false; };
  }, [pins.ready, attempt, shown]);

  const exclude = useMemo(() => new Set([...pins.joined.map((c) => c.slug), ...pins.pins.map((p) => p.slug)]), [pins.joined, pins.pins]);
  if (!pins.ready) return null;

  const people = (app: GuestApp) => app.active_users || 0;

  return (
    <ToJoinView
      apps={apps}
      failed={failed}
      onRetry={() => { setApps(null); setAttempt((n) => n + 1); }}
      exclude={exclude}
      query={query}
      heading={t('home:join.heading')}
      id="home-frame-to-join"
      title={(app) => app.name || app.slug}
      // The standard Home's card (../communities-to-join.tsx, #6609): the
      // picture or the tile on the community's colour, "New" and who is
      // there on the cover, the name and the sentence. No foot and no Join:
      // the whole card opens the project's page, where Join sits.
      link={(app) => ({
        href: hubHref(app.slug),
        onClick: (event) => openHub(event, app.slug),
        label: people(app) >= MIN_PEOPLE ? ta('auth:guest.card.peopleLabel', { name: app.name, count: people(app) }) : undefined,
      })}
      picture={(app) => ({
        flag: isNew(app) ? ta('auth:guest.card.new') : undefined,
        badge: people(app) >= MIN_PEOPLE ? <><Icon name="users" size={14} />{people(app).toLocaleString()}</> : undefined,
      })}
      cardEnd={() => null}
      rowEnd={() => null}
      rowLine={(app) => app.description || undefined}
    />
  );
}

/** The side column: the season's challenges, as Home's own strip names and orders them. */
function Challenges({ challenges }: { challenges: NonNullable<HomePanelsState['challenges']> }) {
  const t = useMessages('home');
  const art = (row: { illustration: string | null; illustrationTone: string | null }) => {
    const found = resolveIllustration(row.illustration, row.illustrationTone);
    return found ? { src: found.src, tone: found.toneClass } : {};
  };
  return (
    <Sec
      label={challenges.heading}
      id="home-frame-challenges"
      action={challenges.seeAll ? <GroupLink href="#leaderboard/challenges">{t('home:challenges.seeAll.text')}</GroupLink> : null}
    >
      {challenges.rows.length ? (
        <Card>
          {challenges.rows.map((row) => (
            <Row
              key={row.id}
              href={row.eventId != null ? `#leaderboard/challenges/${row.eventId}/${row.id}` : '#leaderboard/challenges'}
              onClick={(event) => {
                if (native(event)) return;
                event.preventDefault();
                win()?.HomePanels?.goToChallenge?.(row.eventId, row.id);
              }}
              // The picture today's Home shows for it (../../leaderboard/challenge-card.tsx
              // ChallengeTile), and the card's arrow; a done one is the check, as there.
              lead={row.state === 'done' ? <Lead icon="check" tone="ok" /> : <ChallengeArt {...art(row)} icon={row.icon} />}
              title={row.goal}
              // An open one says its state, then its points on a line of their own:
              // beside the arrow, in the side column, a pill left the name three lines.
              line={row.state === 'done' ? (row.stateLabel || undefined) : (
                <>
                  {row.stateLabel}
                  {row.earned || row.reward ? <span className={k('bp')}>{row.earned || row.reward}</span> : null}
                </>
              )}
              wrap
              right={row.state === 'done' ? <Pill kind="ok">{row.earned || row.reward}</Pill> : <RowArrow />}
            />
          ))}
        </Card>
      ) : challenges.note ? (
        <Card text>
          <Sub size={15}><b>{challenges.note.title}</b></Sub>
          <Mut>{challenges.note.text}</Mut>
        </Card>
      ) : null}
    </Sec>
  );
}

/**
 * The search field. Home's search has one owner, #home-search-input, which
 * Home._wireSearch (../home.js) reads to filter the grid and which
 * ../use-home-query.ts listens to for the communities. That field is hidden
 * under a look, so this one writes each change into it and says so with the
 * `input` event both already listen for; Escape clears, as it does there.
 * Home.focusSearch and the search shortcut find this field by
 * [data-home-frame-search] (Home._searchField).
 */
function HomeSearch() {
  const t = useMessages('home');
  const searchPlaceholder = useHomeSearchPlaceholder();
  const [words, setWords] = useState('');
  const host = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const own = document.getElementById('home-search-input') as HTMLInputElement | null;
    // What was typed before this look was put on, and whatever else writes the field.
    if (own?.value) setWords(own.value);
    const read = (event: Event) => {
      const el = event.target as HTMLInputElement | null;
      if (el && el.id === 'home-search-input') setWords(String(el.value || ''));
    };
    document.addEventListener('input', read);
    host.current?.querySelector('input')?.setAttribute('aria-keyshortcuts', HOME_SEARCH_SHORTCUT_KEYS);
    return () => document.removeEventListener('input', read);
  }, []);
  const type = (next: string) => {
    setWords(next);
    const own = document.getElementById('home-search-input') as HTMLInputElement | null;
    if (!own) return;
    own.value = next;
    own.dispatchEvent(new Event('input', { bubbles: true }));
  };
  return (
    <div
      ref={host}
      data-home-frame-search=""
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !words) return;
        event.preventDefault();
        type('');
      }}
    >
      <Search value={words} onChange={type} placeholder={searchPlaceholder} label={t('home:search.label')} />
    </div>
  );
}

/** `initialDirectory` seeds the one state a render test cannot reach through effects. */
export function HomeFrame({ initialDirectory = null, grid, widgets, waitlist, verify }: {
  initialDirectory?: GuestApp[] | null;
  /** The standard pieces HomeScreen hands in, each drawn once on the page (see the header). */
  grid?: React.ReactNode;
  widgets?: React.ReactNode;
  waitlist?: React.ReactNode;
  verify?: React.ReactNode;
}) {
  const t = useMessages('home');
  const query = useSettledHomeQuery();
  const { challenges } = useStoreState(panelsStore) as HomePanelsState;
  const side = challenges && (challenges.rows.length > 0 || challenges.note) ? <Challenges challenges={challenges} /> : null;
  return (
    <PageBody
      data-home-frame=""
      title={t('home:frame.title')}
      purpose={t('home:frame.purpose')}
      tabs={<HomeSearch />}
      side={side}
      // On a phone the challenges come before the directory, as on the
      // standard page: the directory has no end to scroll past.
      tail={<ToJoin query={query} initialDirectory={initialDirectory} />}
    >
      {widgets ? <div className={k('own')} data-home-frame-own="widgets">{widgets}</div> : null}
      <PinnedApps grid={grid} />
      <PinnedCommunities query={query} />
      {waitlist ? <div className={k('own')} data-home-frame-own="waitlist">{waitlist}</div> : null}
      {verify ? <div className={k('own')} data-home-frame-own="verify">{verify}</div> : null}
    </PageBody>
  );
}
