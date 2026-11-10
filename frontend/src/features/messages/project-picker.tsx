/**
 * 5 Nov 2026: the project a new thread with Homeroom bot is for
 * (./new-thread.tsx), chosen the way "Your communities" chooses a community
 * (../workshop/community-switcher.tsx), not from a plain web select.
 *
 *   [▦ Any project ⌄]          ← ProjectChip, floating over the message box
 *   ┌───────────────────────┐
 *   │ Which project is it for? │ ← ProjectPicker: a sheet from the floor on a
 *   │ ⌕ Search your projects │   phone, a menu above the chip from 768px
 *   │ ▦ Any project       ✓ │
 *   │ RECENT                │
 *   │ 📚 Book Club · Private │
 *   └───────────────────────┘
 *
 * The rows are the switcher's own (its classes, its tiles, its "Public · 23
 * members" line and its tick, tinted in the community's colour on the one
 * picked), with Any project on top: the default, where Homeroom bot works out
 * which project the message is about. Recent is the switcher's Recent (your
 * pins, then the sidebar's five); every other community you are in follows.
 * Words in the search take their place, as in the switcher.
 *
 * Picking a row only says what the thread is for: nothing is read or written
 * until the first message is sent (./new-thread.tsx send).
 *
 * ── Island rules ───────────────────────────────────────────────────────
 *
 * The picker is rendered only while open, into document.body, from state
 * that changes only after the first paint. The chip's first render is the
 * default's: Any project.
 */

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { CheckIcon, ChevronDownIcon, SearchIcon, Squares2X2Icon } from '@/components/ui/icons';
import { AppIconContent, appIconKind } from '../apps/app-card-view';
import { useMessages } from '../../lib/i18n/react';
import { adoptKitSurface, type KitAdoption } from '../../lib/kit-surface';
import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { useStoreState } from '../../lib/use-store-state';
import { useCommunityColor } from '../../lib/community-color';
import { navStore } from '../nav/nav-store.js';
import { pinnedAppsStore } from '../nav/pinned-apps-store.js';
import { readKept } from '../nav/rail-communities';
import { communityScopeStore, loadCommunities, type CommunityInfo } from '../workshop/community-scope';
import { switcherRecent, switcherSub } from '../workshop/community-switcher';
import { matchRows } from '../workshop/sections';

const WIDE = '(min-width: 768px)';

export function useWide(): boolean {
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

/**
 * Pure: the picker's sections. Without words, Recent (the switcher's: your
 * pins, then the sidebar's five) and then every other community you are in,
 * in the switcher's order; with words, the matches alone.
 */
export function pickerSections(
  list: readonly string[] | null,
  info: Record<string, CommunityInfo>,
  recent: readonly string[],
  query: string,
): { found: CommunityInfo[] | null; recent: CommunityInfo[]; rest: CommunityInfo[] } {
  const rows = (slugs: readonly string[]) => slugs.map((slug) => info[slug]).filter(Boolean) as CommunityInfo[];
  const all = rows(list || []);
  const q = query.trim();
  if (q) return { found: matchRows(all, q), recent: [], rest: [] };
  const first = rows(recent);
  const taken = new Set(first.map((row) => row.slug));
  return { found: null, recent: first, rest: all.filter((row) => !taken.has(row.slug)) };
}

/** A community's tile, at the size the caller's class gives it. */
function Tile({ info, className }: { info: CommunityInfo; className: string }): ReactNode {
  const app = { slug: info.slug, name: info.name, icon_url: info.iconUrl, icon_emoji: info.iconEmoji };
  return (
    <span className={`app-icon-tile ${className}`} data-icon={appIconKind(app as never)} aria-hidden="true">
      <AppIconContent app={app as never} />
    </span>
  );
}

/** The chip over the message box: the project picked, or Any project. */
export function ProjectChip({ slug, open, onOpen }: {
  slug: string | null;
  open: boolean;
  onOpen: (el: HTMLButtonElement) => void;
}): ReactNode {
  const t = useMessages('messages');
  // Read through the store so a name that arrives after the pick is drawn.
  const st = useStoreState(communityScopeStore);
  const info = slug ? st.info[slug] || null : null;
  const color = useCommunityColor(info ? { color: info.iconColor, iconUrl: info.iconUrl, iconEmoji: info.iconEmoji, key: info.slug } : null);
  const name = info ? info.name : t('messages:newThread.anyProject');
  const style = info ? ({ '--project-ink': color } as CSSProperties) : undefined;
  return (
    <button
      type="button"
      className="messages-project-chip"
      data-bot-new-thread-project={slug || ''}
      data-picked={info ? '' : undefined}
      style={style}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={t('messages:newThread.projectChip', { project: name })}
      title={t('messages:newThread.projectChip', { project: name })}
      onClick={(event) => onOpen(event.currentTarget)}
    >
      {info ? <Tile info={info} className="messages-project-chip-tile" /> : (
        <span className="messages-project-chip-tile messages-project-chip-any" aria-hidden="true"><Squares2X2Icon /></span>
      )}
      <span className="messages-project-chip-name">{name}</span>
      <ChevronDownIcon className="messages-project-chip-chev" aria-hidden="true" />
    </button>
  );
}

function Row({ info, current, onPick }: { info: CommunityInfo; current: boolean; onPick: (slug: string) => void }): ReactNode {
  const color = useCommunityColor({ color: info.iconColor, iconUrl: info.iconUrl, iconEmoji: info.iconEmoji, key: info.slug });
  return (
    <button
      type="button"
      className="community-switcher-row"
      data-bot-project-option={info.slug}
      aria-current={current ? 'true' : undefined}
      style={current ? { background: `color-mix(in srgb, ${color} 12%, transparent)` } : undefined}
      onClick={() => onPick(info.slug)}
    >
      <Tile info={info} className="community-switcher-tile" />
      <span className="community-switcher-text">
        <span className="community-switcher-name">{info.name}</span>
        <span className="community-switcher-sub">{switcherSub(info)}</span>
      </span>
      <span className="community-switcher-tick" style={{ color, visibility: current ? 'visible' : 'hidden' }} aria-hidden="true">
        <CheckIcon className="w-5 h-5" strokeWidth="2.5" />
      </span>
    </button>
  );
}

/** Up and Down between the rows, Home and End to either end, as in the switcher. */
function roveRows(e: ReactKeyboardEvent<HTMLDivElement>): void {
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

function PickerBody({ slug, menu, onPick }: { slug: string | null; menu: boolean; onPick: (slug: string | null) => void }): ReactNode {
  const t = useMessages('messages');
  const st = useStoreState(communityScopeStore);
  const { viewer } = useStoreState(navStore);
  const { apps: pins } = useStoreState(pinnedAppsStore);
  const [kept] = useState(() => readKept(viewer));
  const [query, setQuery] = useState('');
  const recent = switcherRecent(pins.map((app: { slug: string }) => app.slug), kept, st.list);
  const { found, recent: first, rest } = pickerSections(st.list, st.info, recent, query);
  const q = query.trim();
  const any = !slug;
  return (
    <>
      <div className="community-switcher-head">
        <h2 className="community-switcher-title" id="bot-project-picker-title">
          {menu ? t('messages:newThread.project') : t('messages:newThread.picker.title')}
        </h2>
      </div>
      <label className="community-switcher-search">
        <SearchIcon className="community-switcher-search-glyph" aria-hidden="true" />
        <input
          id="bot-project-picker-search"
          type="search"
          className="community-switcher-search-input"
          value={query}
          placeholder={t('messages:newThread.picker.search')}
          aria-label={t('messages:newThread.picker.search')}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="go"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              e.currentTarget.closest('.community-switcher')?.querySelector<HTMLButtonElement>('.community-switcher-list .community-switcher-row')?.focus();
            } else if (e.key === 'Enter' && found && found[0]) {
              e.preventDefault();
              onPick(found[0].slug);
            }
          }}
        />
      </label>
      <div className="community-switcher-list" onKeyDown={roveRows}>
        {found ? null : (
          <button
            type="button"
            className="community-switcher-row"
            data-bot-project-option=""
            aria-current={any ? 'true' : undefined}
            style={any ? { background: 'var(--bg-secondary)' } : undefined}
            onClick={() => onPick(null)}
          >
            <span className="community-switcher-tile community-switcher-tile-add" aria-hidden="true">
              <Squares2X2Icon className="w-5 h-5" />
            </span>
            <span className="community-switcher-text">
              <span className="community-switcher-name">{t('messages:newThread.anyProject')}</span>
              <span className="community-switcher-sub">{t('messages:newThread.picker.anySub')}</span>
            </span>
            <span className="community-switcher-tick" style={{ visibility: any ? 'visible' : 'hidden' }} aria-hidden="true">
              <CheckIcon className="w-5 h-5" strokeWidth="2.5" />
            </span>
          </button>
        )}
        {st.list == null ? (
          <p className="community-switcher-note" data-bot-project-loading="">{t('messages:newThread.picker.loading')}</p>
        ) : found ? (
          found.length ? (
            <div role="group" aria-label={t('messages:newThread.picker.search')}>
              {found.map((info) => <Row key={info.slug} info={info} current={slug === info.slug} onPick={onPick} />)}
            </div>
          ) : (
            <p className="community-switcher-note" data-bot-project-none="">{t('messages:newThread.picker.none', { query: q })}</p>
          )
        ) : (
          <>
            {first.length ? (
              <div role="group" aria-labelledby="bot-project-recent">
                <h3 className="community-switcher-section" id="bot-project-recent"><span>{t('messages:newThread.picker.recent')}</span></h3>
                {first.map((info) => <Row key={info.slug} info={info} current={slug === info.slug} onPick={onPick} />)}
              </div>
            ) : null}
            {rest.length ? (
              <div role="group" aria-labelledby="bot-project-rest">
                <h3 className="community-switcher-section" id="bot-project-rest"><span>{t('messages:newThread.picker.more')}</span></h3>
                {rest.map((info) => <Row key={info.slug} info={info} current={slug === info.slug} onPick={onPick} />)}
              </div>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}

/** Where focus lands when it opens: the row picked now. */
function focusPicked(panel: HTMLElement | null): void {
  panel?.querySelector<HTMLButtonElement>('[aria-current="true"]')?.focus({ preventScroll: true });
}

function PickerSheet({ slug, onPick, onClose }: { slug: string | null; onPick: (slug: string | null) => void; onClose: () => void }): ReactNode {
  const panel = useRef<HTMLDivElement | null>(null);
  const [adopted, setAdopted] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useIsomorphicLayoutEffect(() => {
    if (!panel.current) return undefined;
    // The kit's own sheet when it is there, as "Your communities" is shown.
    let adoption: KitAdoption | null = adoptKitSurface({
      kind: 'sheet',
      contentEl: panel.current,
      home: 'placeholder',
      gate: 'kit',
      onDismiss: () => { adoption = null; closeRef.current(); },
    });
    setAdopted(!!adoption);
    focusPicked(panel.current);
    return () => { if (adoption) adoption.release(); };
  }, []);
  return (
    <div
      className={adopted ? 'contents' : 'community-switcher-scrim'}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={panel}
        id="bot-project-picker"
        className="community-switcher community-switcher-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bot-project-picker-title"
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}
      >
        {adopted ? null : <span className="community-switcher-grab" aria-hidden="true" />}
        <PickerBody slug={slug} menu={false} onPick={onPick} />
      </div>
    </div>
  );
}

function PickerMenu({ slug, anchor, onPick, onClose }: {
  slug: string | null;
  anchor: HTMLElement | null;
  onPick: (slug: string | null) => void;
  onClose: () => void;
}): ReactNode {
  const panel = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    focusPicked(panel.current);
    const onDown = (e: Event) => {
      const target = e.target as Node | null;
      if (target && (panel.current?.contains(target) || anchor?.contains(target))) return;
      closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchor]);
  // Hung ABOVE the chip, which sits over the message box near the foot of
  // the window: its bottom edge 8px over the chip, as wide as the
  // switcher's menu, kept inside the window and no taller than the room.
  const box = anchor?.getBoundingClientRect();
  const width = 364;
  const style: CSSProperties = box
    ? {
      left: `${Math.max(8, Math.min(Math.round(box.left), window.innerWidth - width - 8))}px`,
      bottom: `${Math.round(window.innerHeight - box.top + 8)}px`,
      maxHeight: `${Math.max(240, Math.min(560, Math.round(box.top - 16)))}px`,
    }
    : { left: '50%', top: '12vh', transform: 'translateX(-50%)' };
  return (
    <div
      ref={panel}
      id="bot-project-picker"
      className="community-switcher community-switcher-menu"
      role="dialog"
      aria-labelledby="bot-project-picker-title"
      style={style}
    >
      <PickerBody slug={slug} menu onPick={onPick} />
    </div>
  );
}

/**
 * The picker itself, while `open`: a sheet on a phone, a menu above the chip
 * from 768px. Reads the communities you are in when it opens (at most every
 * thirty seconds, community-scope.ts loadCommunities), and closes on a route
 * change, as the switcher does.
 */
export function ProjectPicker({ open, slug, anchor, onPick, onClose }: {
  open: boolean;
  slug: string | null;
  anchor: HTMLElement | null;
  onPick: (slug: string | null) => void;
  onClose: () => void;
}): ReactNode {
  const wide = useWide();
  useEffect(() => {
    if (!open) return undefined;
    void loadCommunities();
    window.addEventListener('hashchange', onClose);
    window.addEventListener('popstate', onClose);
    return () => {
      window.removeEventListener('hashchange', onClose);
      window.removeEventListener('popstate', onClose);
    };
  }, [open, onClose]);
  if (!open || typeof document === 'undefined') return null;
  return createPortal(
    wide
      ? <PickerMenu slug={slug} anchor={anchor} onPick={onPick} onClose={onClose} />
      : <PickerSheet slug={slug} onPick={onPick} onClose={onClose} />,
    document.body,
  );
}
