/**
 * A COMMUNITY'S TILE, and Home's one use left of it.
 *
 * The tiles here are what the Communities tab's page draws
 * (../communities/index.tsx, `#communities`): the communities you pinned
 * and the others you are in. They were Home's Pinned communities section
 * (One Home, #6361) until the tab came back (18 Nov 2026); Home no longer
 * lists your communities.
 *
 * The tile is 62px with 18px corners and the blue votes-waiting number, in
 * a ring of the community's colour (lib/community-color.ts) so it never
 * reads as an app. A community's tile opens its hub; an app's tile (Home's
 * Pinned apps) opens the app. Beside the tiles, the page's own:
 *
 *   New community    the create flow: present for every signed-in account
 *                    but a private member, locked (muted, and its name says
 *                    how to see the quota) without the quota to make one. It
 *                    keeps the `data-panel-slot="create"` hook.
 *
 *   Needs you        while any vote waits on you, the way to Needs you
 *                    (#needs), every decision owed across your projects,
 *                    with the one count of votes waiting (community-scope
 *                    `badgeNeeds`, the number a vote cast or skipped lowers
 *                    at once). A zero says nothing, so the tile is not drawn
 *                    on a quiet day.
 *
 * WHAT HOME KEEPS (`HomeCommunityMatches`, `#home-communities-section`):
 * Home's search still finds your communities. While something is typed in
 * Home's field the section lists the ones that match, pinned or joined,
 * each a tile that opens its hub, so a search for a community you are in is
 * never answered with an offer to make it. With nothing typed it is hidden.
 * It is also where the account's pins are read and kept fresh
 * (./home-pins-store.ts `wireHomePins`), since Home is always mounted.
 *
 * Signed in only. Signed out, the guest Home draws its device's pins with
 * the same tile (features/guest).
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { PlusIcon, SpeechCheckIcon, UserGroupIcon } from '@/components/ui/icons';

import { useCommunityColor } from '../../lib/community-color';
import { useMessages } from '../../lib/i18n/react';
import { useStoreState } from '../../lib/use-store-state';
import { AppIconContent, appIconKind } from '../apps/app-card-view';
import { swatchFor } from '../messages/format';
import { SectionHeading } from './panels/ui';
import {
  homePinsStore, importDevicePins, loadHomePins, loadHomePinsForSession,
  wireHomePins, type HomePin, type PinActivity,
} from './home-pins-store';
import { matchesQuery, useSettledHomeQuery } from './use-home-query';

export const HEAD_ACTION = 'shrink-0 flex items-center text-[14px] font-semibold text-[color:var(--accent)] hover:underline whitespace-nowrap un-touch-target';
const TILE = 'flex min-w-0 flex-col items-center gap-1.5 rounded-2xl py-1 text-center no-underline un-touch-target';
const FACE = 'app-icon-tile w-14 h-14 shrink-0 rounded-[16px] overflow-hidden flex items-center justify-center font-bold text-2xl';
const RING = 'rounded-[21px] p-[3px] shadow-[inset_0_0_0_2px_var(--ring)]';
const NAME = 'max-w-full line-clamp-2 break-words text-[12.5px] font-semibold leading-[15px] text-zinc-800 dark:text-zinc-200';
const VOTES = 'absolute -top-1.5 -end-2 min-w-[22px] h-[22px] px-1.5 rounded-full bg-violet-600 text-white text-xs font-extrabold tabular-nums flex items-center justify-center shadow-[0_0_0_2px_var(--dc-sheet-solid)]';
// The corner discs the grid's edit mode draws (app-grid.tsx .app-card-remove):
// a dark − to unpin; a white + in the accent ink to pin (Discover's add pill's
// treatment), never a primary button's fill on a 24px badge.
const CORNER = 'absolute -top-1.5 w-6 h-6 rounded-full flex items-center justify-center shadow-[0_0_0_2px_var(--dc-sheet-solid)]';
export const CORNER_UNPIN = 'bg-zinc-700 text-white dark:bg-zinc-500';
export const CORNER_PIN = 'bg-white text-violet-700 dark:bg-zinc-800 dark:text-violet-400';
/** No MinusIcon in the kit's set: the glyph is the minus itself, as app-grid.tsx draws it. */
export function MinusGlyph() {
  return <span aria-hidden="true" className="text-[15px] leading-none font-semibold">&minus;</span>;
}
const FACE_WRAP = 'relative z-[1] inline-flex';
const WIGGLE = 'animate-[home-wiggle_260ms_ease-in-out_infinite_alternate] motion-reduce:animate-none';
const ACTION_FACE = 'flex h-[62px] w-[62px] shrink-0 items-center justify-center rounded-[18px]';

/** Open a community's hub, as the Communities tab's tile did (the door rule). */
function openHub(event: React.MouseEvent<HTMLAnchorElement>, slug: string) {
  const win = window as any;
  if (win.NavLink?.isNativeClick?.(event)) return;
  event.preventDefault();
  try { win.AppView?._landOnHub?.(slug); } catch { /* the page opens on what it remembers */ }
  win.App?.navigateToApp?.(slug, 'dev');
}

export function CommunityTileFace({ slug, name, iconUrl, iconEmoji, iconColor }: {
  slug: string; name: string; iconUrl?: string | null; iconEmoji?: string | null; iconColor?: string | null;
}) {
  const ring = useCommunityColor({ color: iconColor || null, iconUrl: iconUrl || null, iconEmoji: iconEmoji || null, key: slug });
  const app = { slug, name, icon_url: iconUrl || null, icon_emoji: iconEmoji || null };
  return (
    <span className={RING} style={{ ['--ring' as string]: ring }}>
      <span className={FACE} data-icon={appIconKind(app as any)} aria-hidden="true">
        <AppIconContent app={app as any} />
      </span>
    </span>
  );
}

export function PinTile({ pin, votes, editing, faded = false, detail, onUnpin, onPin }: {
  pin: Omit<HomePin, 'member'>;
  votes: number;
  editing: boolean;
  faded?: boolean;
  detail?: PinActivity;
  onUnpin?: () => void;
  onPin?: () => void;
}) {
  const t = useMessages('home');
  const tc = useMessages('communities');
  return (
    <a
      href={`/app/${encodeURIComponent(pin.slug)}/workshop`}
      className={faded ? `${TILE} opacity-60` : TILE}
      data-home-community={pin.slug}
      data-home-community-pinned={faded ? undefined : ''}
      onClick={(event) => { if (editing) { event.preventDefault(); return; } openHub(event, pin.slug); }}
    >
      {/* z-[1] (#6372): the tile's own hit area (un-touch-target's ::after)
          paints after its children and covered the corner discs, so a press
          on − or + reached the tile, a no-op while editing. The lift is on
          this wrapper, not the discs: the wiggle's transform makes it a
          stacking context a disc's own z-index cannot leave. */}
      <span className={editing ? `${FACE_WRAP} ${WIGGLE}` : FACE_WRAP}>
        <CommunityTileFace slug={pin.slug} name={pin.name} iconUrl={pin.iconUrl} iconEmoji={pin.iconEmoji} iconColor={pin.iconColor} />
        {votes > 0 && !editing ? <span className={VOTES} data-home-community-votes={String(votes)} aria-hidden="true">{votes > 99 ? '99+' : votes}</span> : null}
        {editing && onUnpin ? (
          <button
            type="button"
            className={`${CORNER} -start-1.5 ${CORNER_UNPIN}`}
            aria-label={t('home:communities.unpinNamed', { community: pin.name })}
            onClick={(event) => { event.preventDefault(); event.stopPropagation(); onUnpin(); }}
          >
            <MinusGlyph />
          </button>
        ) : null}
        {onPin ? (
          <button
            type="button"
            className={`${CORNER} -end-1.5 ${CORNER_PIN}`}
            aria-label={t('home:communities.pinNamed', { community: pin.name })}
            onClick={(event) => { event.preventDefault(); event.stopPropagation(); onPin(); }}
          >
            <PlusIcon className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        ) : null}
      </span>
      <span className={NAME}>{pin.name}</span>
      {detail ? <CommunityDetail detail={detail} /> : null}
      {votes > 0 ? <span className="sr-only">{tc('communities:row.toVote', { count: votes })}</span> : null}
    </a>
  );
}

/** How many faces a card shows (services/home-pins.js ACTIVITY_FACES). */
const CARD_FACES = 3;

/**
 * WHAT IS GOING ON THERE (Drea's review of #6699): under a community's
 * name on its card, how many members, what went live this week
 * (one pill, the only one on the card) and the faces of a few of the people
 * who were there this week, beside how many there were. A zero says nothing:
 * each line is drawn only when it has something to say. The cards are the
 * brand look's, from 1280px, on the Communities page (app.css, "COMMUNITIES
 * AS PEOPLE PLACES"); everywhere else this stays hidden and the tile is the
 * icon and name it always was.
 */
function CommunityDetail({ detail }: { detail: PinActivity }) {
  const t = useMessages('home');
  const members = Math.max(0, Number(detail.members) || 0);
  const live = Math.max(0, Number(detail.liveWeek) || 0);
  const active = Math.max(0, Number(detail.activeWeek) || 0);
  const people = (detail.people || []).filter((p) => p && p.username).slice(0, CARD_FACES);
  if (!members && !live && !active) return null;
  return (
    <span className="hidden" data-home-community-detail="">
      {members ? (
        <span className="home-community-line">
          <UserGroupIcon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          <span>{t('home:communities.members', { count: members, formatted: members.toLocaleString() })}</span>
        </span>
      ) : null}
      {live ? <span className="home-community-news">{t('home:communities.liveWeek', { count: live })}</span> : null}
      {active ? (
        <span className="home-community-people">
          {people.length ? (
            <span className="dev-ws-hero-faces" aria-hidden="true">
              {people.map((p) => (
                <span key={p.username} className="dev-ws-hero-face" style={{ background: swatchFor(p.username) }} title={`@${p.username}`}>
                  {p.avatarUrl ? <img src={p.avatarUrl} alt="" loading="lazy" draggable={false} /> : (p.username.charAt(0) || '?').toUpperCase()}
                </span>
              ))}
            </span>
          ) : null}
          <span>{t('home:communities.activeWeek', { count: active, formatted: active.toLocaleString() })}</span>
        </span>
      ) : null}
    </span>
  );
}

/** True on a window at least 1280px wide, where the cards are drawn; false in the prerender. */
export function useWide(): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    let query: MediaQueryList | null = null;
    try { query = window.matchMedia('(min-width: 1280px)'); } catch { return undefined; }
    const update = () => setWide(!!query?.matches);
    update();
    query.addEventListener?.('change', update);
    return () => query?.removeEventListener?.('change', update);
  }, []);
  return wide;
}

/**
 * Needs you's tile: a link to the page (`#needs`), so a modified click opens
 * it in a new tab, wearing the votes-waiting number a community's tile wears.
 */
export function NeedsTile({ count }: { count: number }) {
  const t = useMessages('home');
  return (
    <a
      href="#needs"
      id="communities-needs-tile"
      className={TILE}
      data-home-needs={String(count)}
      aria-label={t('home:communities.needsNamed', { count })}
    >
      <span className="relative inline-flex">
        <span className={`${ACTION_FACE} bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300`}>
          <SpeechCheckIcon className="w-7 h-7" aria-hidden="true" />
        </span>
        <span className={VOTES} aria-hidden="true">{count > 99 ? '99+' : count}</span>
      </span>
      <span className={NAME}>{t('home:communities.needs')}</span>
    </a>
  );
}

export function ActionTile({ label, icon, onClick, dashed = false, muted = false, pressed, id, attrs }: {
  label: string; icon: ReactNode; onClick: () => void; dashed?: boolean; muted?: boolean; pressed?: boolean; id?: string;
  attrs?: Record<string, string | undefined>;
}) {
  const face = pressed
    ? `${ACTION_FACE} bg-[color:var(--lit-tint)] text-[color:var(--lit-ink)] shadow-[inset_0_0_0_1px_var(--lit-line)]`
    : dashed
      ? (muted
        ? `home-create-glyph ${ACTION_FACE} border-2 border-dashed transition-colors text-zinc-300 dark:text-zinc-600`
        : `home-create-glyph ${ACTION_FACE} border-2 border-dashed transition-colors text-zinc-500 dark:text-zinc-400`)
      : `${ACTION_FACE} bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200`;
  return (
    <button type="button" id={id} className={`${TILE} cursor-pointer`} aria-pressed={pressed} onClick={onClick} {...attrs}>
      <span className={face}>{icon}</span>
      <span className={pressed ? `${NAME} text-[color:var(--lit-ink)]` : `${NAME} text-zinc-600 dark:text-zinc-300`}>{label}</span>
    </button>
  );
}

/**
 * Your communities that match Home's search (see the header): hidden until
 * something is typed, then every pinned or joined community whose name
 * matches, each a tile that opens its hub. Mounted under every look, since
 * it is also what keeps the account's pins read (`wireHomePins`).
 */
export function HomeCommunityMatches() {
  const t = useMessages('home');
  const state = useStoreState(homePinsStore);
  // The words the grid last judged, so this list changes with the grid
  // rather than one letter ahead of it (./use-home-query.ts, #6793).
  const query = useSettledHomeQuery();

  useEffect(() => {
    const moved = (count: number) => t('home:devicePins.moved', { count });
    const unwire = wireHomePins(moved);
    // Signed in before Home mounted (the session event already went by):
    // move what this device pinned first, then read the list.
    if ((window as any).App?.user) void importDevicePins(moved).then((count) => (count ? loadHomePins() : loadHomePinsForSession()));
    return unwire;
  }, []);

  // Pinned first, in their order, then the others you are in.
  const matches = useMemo(() => {
    if (!query) return [];
    const on = new Set(state.pins.map((p) => p.slug));
    const joined = state.joined
      .filter((c) => !on.has(c.slug))
      .map((c) => ({ slug: c.slug, name: c.name || c.slug, iconUrl: c.icon_url || null, iconEmoji: c.icon_emoji || null, iconColor: c.icon_color || null }));
    return [...state.pins, ...joined].filter((c) => matchesQuery(query, c.name, c.slug));
  }, [state.pins, state.joined, query]);
  // Read after mount only (state.ready), so the prerender and the first
  // client render agree: both draw the section hidden.
  const visible = state.ready && matches.length > 0;

  return (
    <section id="home-communities-section" className="px-3" hidden={!visible}>
      <SectionHeading>{t('home:communities.matches')}</SectionHeading>
      <div className="grid grid-cols-4 gap-x-1 gap-y-4 px-1 pt-2 pb-2">
        {matches.map((c) => (
          <PinTile key={c.slug} pin={c} votes={state.owed[c.slug] || 0} editing={false} />
        ))}
      </div>
    </section>
  );
}
