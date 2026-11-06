/**
 * "Your communities": the switcher behind the Communities tab.
 *
 * A search box first, which filters every community you are in by name as
 * you type (./sections.ts matchRows, the rule the Communities screen and the
 * phone's drawer search by); then Recent, the communities you use
 * (`switcherRecent`: your pins, then the five the desktop's sidebar lists);
 * then All communities, the way to the page that lists every one; then
 * "Join a community" (Discover) and "Start a community" (the new-project
 * dialog, #3543). Each community has its tile, who it is for and how many
 * are in it, how many votes it is waiting on you for, and a tick on the one
 * you are on. Picking one makes it the tab's community and opens it
 * (./community-scope.ts goToCommunity).
 *
 * #5290: it used to draw the All communities page in a smaller box (the
 * three sections and their "Show N more", #3519). That is the page's job,
 * and the switcher is for the few you move between; the All communities row
 * stays as the clear way there (the review asked to keep it).
 *
 * It replaced the in-place "Which project?" panel under the header, and it
 * opens from three places, all through the same store: the community's name
 * and ⌄ in the coloured header, the header's "Communities ⌄" on the
 * Communities list, and ⌘K / Ctrl+K anywhere in the signed-in shell
 * (./community-shortcut.ts), which focuses the search. The phone's tab held
 * opened it too (#3701) until the drawer's list replaced it there (18 Oct
 * 2026). The tab PRESSED while it is lit does not open it, at any width: it
 * goes up a level, to the community, its top, then All communities
 * (./tab-ladder.ts).
 *
 * ── Two presentations ──────────────────────────────────────────────────
 *
 * On a phone it is a sheet from the floor, handed to the native kit when one
 * is there (lib/kit-surface.ts, the same hand-off as the staking sheet) and a
 * CSS sheet over a scrim when not. From 768px up it is a menu hung off
 * whatever opened it: under the header's name, or, from ⌘K, in the middle
 * of the window near its top.
 *
 * ── Island rules ───────────────────────────────────────────────────────
 *
 * Rendered only while open, into document.body, from state that only ever
 * changes after the first paint: nothing here is in the prerendered shell.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { CheckIcon, PlusIcon, SearchIcon, UserGroupIcon } from '@/components/ui/icons';
import { AppIconContent, appIconKind } from '../apps/app-card-view';
import { useMessages } from '../../lib/i18n/react';
import { t as translate } from '../../lib/i18n/runtime';
import { adoptKitSurface, type KitAdoption } from '../../lib/kit-surface';
import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { useStoreState } from '../../lib/use-store-state';
import { useCommunityColor } from '../../lib/community-color';
import { navStore } from '../nav/nav-store.js';
import { pinnedAppsStore } from '../nav/pinned-apps-store.js';
import { railCommunities, readKept } from '../nav/rail-communities';
import {
  closeSwitcher, communityScopeStore, goToCommunity, openSwitcher, type CommunityInfo, type SwitcherFrom,
} from './community-scope';
import { COMMUNITY_SHORTCUT_KEYS, installCommunityShortcut } from './community-shortcut';
import { matchRows } from './sections';

const WIDE = '(min-width: 768px)';

function useWide(): boolean {
  const [wide, setWide] = useState(() => {
    try { return window.matchMedia(WIDE).matches; } catch { return false; }
  });
  useEffect(() => {
    let mq: MediaQueryList | null = null;
    try { mq = window.matchMedia(WIDE); } catch { return undefined; }
    const on = () => setWide(!!mq?.matches);
    mq.addEventListener?.('change', on);
    return () => mq?.removeEventListener?.('change', on);
  }, []);
  return wide;
}

/** "Public · 23 members", "Private · 11 members", "Just you". */
export function switcherSub(info: Pick<CommunityInfo, 'audience' | 'memberCount'>): string {
  if (info.audience === 'solo') return translate('communities:switcher.row.solo');
  const count = Number(info.memberCount) || 0;
  return info.audience === 'invited'
    ? translate('communities:switcher.row.invited', { count })
    : translate('communities:switcher.row.open', { count });
}

function Waiting({ n }: { n: number }) {
  const t = useMessages('communities');
  if (!n) return null;
  return <span className="community-switcher-waiting" data-switcher-waiting="">{t('communities:switcher.toVote', { count: n })}</span>;
}

function Row({ info, current }: { info: CommunityInfo; current: boolean }) {
  // Subscribed: the second line (switcherSub) is read in the language on screen.
  useMessages('communities');
  const color = useCommunityColor({ color: info.iconColor, iconUrl: info.iconUrl, iconEmoji: info.iconEmoji, key: info.slug });
  const app = { slug: info.slug, name: info.name, icon_url: info.iconUrl, icon_emoji: info.iconEmoji };
  return (
    <button
      type="button"
      className="community-switcher-row"
      data-switcher-community={info.slug}
      aria-current={current ? 'true' : undefined}
      style={current ? { background: `color-mix(in srgb, ${color} 12%, transparent)` } : undefined}
      onClick={() => goToCommunity(info.slug)}
    >
      <span className="app-icon-tile community-switcher-tile" data-icon={appIconKind(app as never)} aria-hidden="true">
        <AppIconContent app={app as never} />
      </span>
      <span className="community-switcher-text">
        <span className="community-switcher-name">{info.name}</span>
        <span className="community-switcher-sub">{switcherSub(info)}</span>
      </span>
      <Waiting n={Number(info.needs) || 0} />
      <span className="community-switcher-tick" style={{ color, visibility: current ? 'visible' : 'hidden' }} aria-hidden="true">
        <CheckIcon className="w-5 h-5" strokeWidth="2.5" />
      </span>
    </button>
  );
}

/** Arrow keys between the rows; Home and End to either end. */
function roveRows(e: React.KeyboardEvent<HTMLDivElement>): void {
  const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
  if (!keys.includes(e.key)) return;
  const rows = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('.community-switcher-row'));
  if (!rows.length) return;
  e.preventDefault();
  const at = rows.indexOf(document.activeElement as HTMLButtonElement);
  const next = e.key === 'Home' ? 0
    : e.key === 'End' ? rows.length - 1
      : (at + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
  rows[next]?.focus();
}

/**
 * RECENT (#5290): the communities you use, the ones the desktop's sidebar
 * lists. The ones you pinned first (an account's pins, ../nav/rail-pinned.tsx,
 * which the phone draws nowhere else), then the sidebar's five: this device's
 * own order (../nav/rail-communities.tsx railCommunities, kept under the
 * viewer by the tab bar's useRailCommunities), else the most recently active
 * of yours. Only communities you are in. Pure.
 */
export function switcherRecent(
  pinned: readonly string[],
  kept: readonly string[],
  list: readonly string[] | null,
): string[] {
  if (!list) return [];
  const pins = pinned.filter((slug, k) => list.includes(slug) && pinned.indexOf(slug) === k);
  return [...pins, ...railCommunities(kept, list.filter((slug) => !pins.includes(slug)))];
}

/**
 * The switcher's contents, in either presentation. Exported for tests.
 *
 * #5290: it no longer repeats the All communities page (its three sections
 * and their "Show N more") in a smaller box. A search over every community
 * you are in comes first, then Recent, then All communities, the clear way
 * to that page (Evan's review), then Join and Start. While there are words
 * in the search, the matches take Recent's place.
 */
export function SwitcherBody(): ReactNode {
  const t = useMessages('communities');
  const st = useStoreState(communityScopeStore);
  const { viewer } = useStoreState(navStore);
  const { apps: pins } = useStoreState(pinnedAppsStore);
  const [query, setQuery] = useState('');
  const all = !st.slug;
  const rowsOf = (slugs: readonly string[]) => slugs.map((slug) => st.info[slug]).filter(Boolean) as CommunityInfo[];
  // This device's order, read when the switcher opens: never in a
  // prerendered document, since the switcher is not in one.
  const [kept] = useState(() => readKept(viewer));
  const q = query.trim();
  const found = q ? matchRows(rowsOf(st.list || []), q) : [];
  const recent = q ? [] : rowsOf(switcherRecent(pins.map((app: { slug: string }) => app.slug), kept, st.list));
  return (
    <>
      <div className="community-switcher-head">
        <h2 className="community-switcher-title" id="community-switcher-title">{t('communities:switcher.title')}</h2>
      </div>
      <label className="community-switcher-search">
        <SearchIcon className="community-switcher-search-glyph" aria-hidden="true" />
        <input
          id="community-switcher-search"
          type="search"
          className="community-switcher-search-input"
          value={query}
          placeholder={t('communities:switcher.search.placeholder')}
          aria-label={t('communities:switcher.search.label')}
          aria-keyshortcuts={COMMUNITY_SHORTCUT_KEYS}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="go"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Down into the rows; Enter opens the first match.
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              e.currentTarget.closest('.community-switcher')?.querySelector<HTMLButtonElement>('.community-switcher-list .community-switcher-row')?.focus();
            } else if (e.key === 'Enter' && found[0]) {
              e.preventDefault();
              goToCommunity(found[0].slug);
            }
          }}
        />
      </label>
      {/* Up and Down move between the rows, as in the Homeroom menu. */}
      <div className="community-switcher-list" onKeyDown={roveRows}>
        {st.list == null ? (
          <p className="community-switcher-note" data-switcher-loading="">{t('communities:switcher.loading')}</p>
        ) : q ? (
          found.length ? (
            <div role="group" aria-label={t('communities:switcher.search.results')} data-switcher-results="">
              {found.map((info) => <Row key={info.slug} info={info} current={st.slug === info.slug} />)}
            </div>
          ) : (
            <p className="community-switcher-note" data-switcher-none="">{t('communities:switcher.search.none', { query: q })}</p>
          )
        ) : recent.length ? (
          <div role="group" aria-labelledby="switcher-recent-label" data-switcher-section="recent">
            <h3 className="community-switcher-section" id="switcher-recent-label">
              <span>{t('communities:switcher.recent')}</span>
            </h3>
            {recent.map((info) => <Row key={info.slug} info={info} current={st.slug === info.slug} />)}
          </div>
        ) : null}
        <button
          type="button"
          className="community-switcher-row"
          data-switcher-community="all"
          aria-current={all ? 'true' : undefined}
          style={all ? { background: 'rgba(0,0,0,0.06)' } : undefined}
          onClick={() => goToCommunity(null)}
        >
          {/* THE TAB'S OWN FACE for All communities (#3663): the people
              glyph in a square ring, not a dark tile, which in a list
              holding Homeroom's own read as a second Homeroom. app.css sizes
              the glyph to the tile, as it does the tab's. */}
          <span className="community-switcher-tile community-switcher-tile-all" aria-hidden="true">
            <UserGroupIcon />
          </span>
          <span className="community-switcher-text">
            <span className="community-switcher-name">{t('communities:switcher.all.name')}</span>
            <span className="community-switcher-sub">
              {st.list ? t('communities:switcher.all.count', { count: st.list.length }) : t('communities:switcher.all.every')}
            </span>
          </span>
          <Waiting n={Number(st.totalNeeds) || 0} />
          <span className="community-switcher-tick" style={{ visibility: all ? 'visible' : 'hidden' }} aria-hidden="true">
            <CheckIcon className="w-5 h-5" strokeWidth="2.5" />
          </span>
        </button>
        {/* #3543: two ways out, not one. "Join or start a community" went
            to Discover, where there is nothing to start; Start opens the
            new-project dialog, which asks who it is for first. */}
        <button
          type="button"
          className="community-switcher-row"
          data-switcher-join=""
          // One Home (#6361): the directory is Home's Communities to join.
          onClick={() => { closeSwitcher(); (window as any).Home?.showCommunitiesToJoin?.(); }}
        >
          <span className="community-switcher-tile community-switcher-tile-add" aria-hidden="true">
            <SearchIcon className="w-5 h-5" />
          </span>
          <span className="community-switcher-text">
            <span className="community-switcher-name">{t('communities:switcher.join')}</span>
          </span>
        </button>
        <button
          type="button"
          className="community-switcher-row"
          data-switcher-start=""
          onClick={() => { closeSwitcher(); (window as any).App?.showCreateModal?.(); }}
        >
          <span className="community-switcher-tile community-switcher-tile-add" aria-hidden="true">
            <PlusIcon className="w-5 h-5" />
          </span>
          <span className="community-switcher-text">
            <span className="community-switcher-name">{t('communities:switcher.start')}</span>
          </span>
        </button>
      </div>
    </>
  );
}

/**
 * Where focus lands when the switcher opens: the search box when ⌘K opened
 * it, else the row you are on (a phone's keyboard does not jump up under a
 * tap on the header's name).
 */
function focusOnOpen(panel: HTMLElement, from: SwitcherFrom | null): void {
  if (from === 'shortcut') {
    panel.querySelector<HTMLInputElement>('#community-switcher-search')?.focus();
    return;
  }
  panel.querySelector<HTMLButtonElement>('[aria-current="true"]')?.focus();
}

function SwitcherSheet(): ReactNode {
  const { switcher } = useStoreState(communityScopeStore);
  const panel = useRef<HTMLDivElement | null>(null);
  const [adopted, setAdopted] = useState(false);
  useIsomorphicLayoutEffect(() => {
    if (!panel.current) return undefined;
    const previousFocus = document.activeElement as HTMLElement | null;
    let adoption: KitAdoption | null = adoptKitSurface({
      kind: 'sheet',
      contentEl: panel.current,
      home: 'placeholder',
      gate: 'kit',
      onDismiss: () => { adoption = null; closeSwitcher(); },
    });
    setAdopted(!!adoption);
    focusOnOpen(panel.current, switcher);
    return () => {
      if (adoption) adoption.release();
      previousFocus?.focus?.();
    };
  }, []);
  return (
    <div
      className={adopted ? 'contents' : 'community-switcher-scrim'}
      onClick={(e) => { if (e.target === e.currentTarget) closeSwitcher(); }}
    >
      <div
        ref={panel}
        id="community-switcher"
        className="community-switcher community-switcher-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="community-switcher-title"
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); closeSwitcher(); } }}
      >
        {adopted ? null : <span className="community-switcher-grab" aria-hidden="true" />}
        <SwitcherBody />
      </div>
    </div>
  );
}

function SwitcherMenu(): ReactNode {
  const st = useStoreState(communityScopeStore);
  const panel = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    if (panel.current) focusOnOpen(panel.current, st.switcher);
    const onDown = (e: Event) => {
      const t = e.target as Node | null;
      if (t && panel.current?.contains(t)) return;
      // The opener toggles on its own; a press on it must not close and reopen.
      // (Not the rail's Communities row: it opens nothing since #3701, so a
      // press on it closes the menu like a press anywhere else.)
      if (t instanceof Element && t.closest('[data-community-switch]')) return;
      closeSwitcher();
    };
    // Escape gives focus back to whatever opened it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      closeSwitcher();
      previousFocus?.focus?.();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, []);
  // Under what opened it (the header's name, or its "Communities ⌄"); with no box
  // to hang from, under the header's left edge. ⌘K opens it from nowhere in
  // particular, so it comes down in the middle of the window, as a search.
  const a = st.anchor;
  const style: Record<string, string> = st.switcher === 'shortcut'
    ? { left: '50%', top: '12vh', transform: 'translateX(-50%)' }
    : a
      ? { left: `${Math.max(8, Math.round(a.left))}px`, top: `${Math.round(a.bottom + 8)}px` }
      : { left: '240px', top: '64px' };
  return (
    <div
      ref={panel}
      id="community-switcher"
      className="community-switcher community-switcher-menu"
      role="dialog"
      aria-labelledby="community-switcher-title"
      style={style}
    >
      <SwitcherBody />
    </div>
  );
}

/** The switcher, while it is open: a sheet on a phone, a menu on a wide window. */
export function CommunitySwitcher(): ReactNode {
  const st = useStoreState(communityScopeStore);
  const wide = useWide();
  // ⌘K / Ctrl+K, from anywhere in the signed-in shell (#5290): the switcher
  // with its search focused, or shut again (./community-shortcut.ts).
  useEffect(() => installCommunityShortcut({
    win: window,
    doc: document as never,
    isOpen: () => !!communityScopeStore.get().switcher,
    open: () => openSwitcher('shortcut'),
    close: closeSwitcher,
    signedIn: () => !!(window as unknown as { App?: { user?: unknown } }).App?.user,
  }), []);
  // A route change closes it: the page it was about has gone.
  useEffect(() => {
    if (!st.switcher) return undefined;
    const close = () => closeSwitcher();
    window.addEventListener('hashchange', close);
    window.addEventListener('popstate', close);
    return () => {
      window.removeEventListener('hashchange', close);
      window.removeEventListener('popstate', close);
    };
  }, [st.switcher]);
  if (!st.switcher || typeof document === 'undefined') return null;
  return createPortal(wide ? <SwitcherMenu /> : <SwitcherSheet />, document.body);
}
