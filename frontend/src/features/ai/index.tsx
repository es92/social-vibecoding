/**
 * #ai-screen — the AI tab's main view (#6019 follow-up; plan v3, "the
 * Homeroom bot tab: what needs you comes first, then your private threads,
 * with a lock on the tile, then Up next: what's moving without you, soonest
 * first. Ask Homeroom bot opens Main"). Needs you here is only the threads
 * you are in; Communities › Needs you has every decision you owe.
 *
 * 29 Oct 2026 (Evan): the first list is Needs you, since it holds other
 * people's threads too, and only what waits on you; In progress is what is
 * being worked on; what waits on someone else (other people's votes, a free
 * builder, somebody to pick it up) is Up next. A thread opens on this page:
 *
 *   Homeroom bot                  Needs you: 2 · In progress: 1
 *   NEEDS YOU · 2
 *   [tile] Dark mode          Garden club · #403              [Vote]
 *   [tile] A reminder email   Garden club · #410          [Build it]
 *   [lock] A calendar idea    Only you · Not in a community yet
 *   IN PROGRESS                                        Soonest first
 *   [tile] Weekly digest      Garden club · #401 · Going live
 *   UP NEXT
 *   [tile] Search the board   Garden club · #403 · Waiting for votes · you voted Yes
 *   [tile] Print view         Garden club · #388 · Nobody is building it yet
 *   ▸ LIVE THIS WEEK · 1
 *   ( Ask Homeroom bot )                 ← a phone: opens Main
 *
 * Main, the private conversation with the bot, is the Messages screen's
 * chat with it (`#homeroom-bot/main`, ../messages). On a phone the Ask bar
 * opens it and a private thread opens as `#homeroom-bot/thread/<id>`; on a
 * desktop it is docked beside this list (EmbeddedConversation), and a
 * private thread opens in it.
 *
 * A REQUEST, A CHANGE OR A DECISION OPENS HERE TOO. On a wide window in the
 * column beside the list, in Main's place: the side panel, drawn as this
 * page's own column (‹ Main and the project's name over the page, no
 * Expand, no Close; ../side-panel/side-panel.tsx). Anywhere else on its
 * page, whose back chip says ‹ Homeroom bot and comes back here, with the
 * project's Workshop beside it (Improve.enterTopicFrom), and the tab bar
 * keeps Homeroom bot lit (App._isBotTopic).
 *
 * THE FIRST RENDER IS THE PRERENDER: the screen hidden, the bot's name and
 * no rows. The lists load in effects once the screen is shown to somebody
 * signed in, and the docked pane exists only after mount on a wide window.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { GroupedList, ListRow, SectionHeader } from '@/components/ui/grouped-list';
import { ChevronDownIcon, LockIcon, MicrophoneIcon, UserGroupIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { useVisibility, useVisibilityHiddenClass } from '../../lib/visibility-store';
import { AppIconContent, appIconKind } from '../apps/app-card-view';
import { EmbeddedConversation } from '../messages';
import { openBotConversation } from '../messages/api';
import { BOT_AVATAR } from '../messages/format';
import { SidePanelDivider } from '../side-panel/side-panel';
import {
  NEXT_FIRST, foldWork, heroWords, inProgress, isTopicHref, needsYou, nextWords, owedCount, upNext,
  type AiApp, type AiThread, type AiWork, type NeedItem, type Phrase, type Who, type WorkRow,
} from './model';

const WIDE = '(min-width: 1024px)';
/** This page's address: where a thread opened from it comes back to. */
const BOT_PAGE = '#homeroom-bot';

function demoQuery(): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('demo') === '1' ? '?demo=1' : '';
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(path, { credentials: 'same-origin' });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

function useWide(): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const query = window.matchMedia(WIDE);
    const sync = () => setWide(query.matches);
    sync();
    query.addEventListener?.('change', sync);
    return () => query.removeEventListener?.('change', sync);
  }, []);
  return wide;
}

/** A project's tile, badged with who is in the thread: people for everyone in it, a lock for only you. */
// Complete literals: Tailwind's extractor reads source text.
const BADGE_ALL = 'absolute -right-1 -bottom-1 flex h-5 w-5 items-center justify-center rounded-full '
  + 'bg-[color:var(--dc-sheet-solid)] text-zinc-500 shadow-[0_0_0_1.5px_var(--app-sheet-line)] '
  + 'dark:text-zinc-400 [&>svg]:h-3 [&>svg]:w-3';
const BADGE_ONLY_YOU = 'absolute -right-1 -bottom-1 flex h-5 w-5 items-center justify-center rounded-full '
  + 'bg-zinc-900 text-white shadow-[0_0_0_2px_var(--dc-sheet-solid)] dark:bg-zinc-100 dark:text-zinc-900 '
  + '[&>svg]:h-3 [&>svg]:w-3';
const PILL = 'inline-flex shrink-0 items-center rounded-full bg-violet-50 px-2.5 py-0.5 text-[13px] font-semibold '
  + 'text-violet-700 dark:bg-violet-500/15 dark:text-violet-300';

function WhoTile({ app, who }: { app: AiApp | null; who: Who }): ReactNode {
  const Badge = who === 'all' ? UserGroupIcon : LockIcon;
  return (
    <span className="relative inline-flex shrink-0" data-who={who} aria-hidden="true">
      {app ? (
        <span className="app-icon-tile w-11 h-11 shrink-0 rounded-xl overflow-hidden flex items-center justify-center font-bold text-lg" data-icon={appIconKind(app as any)}>
          <AppIconContent app={app as any} />
        </span>
      ) : (
        <span className="w-11 h-11 shrink-0 rounded-xl flex items-center justify-center bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-200">
          <LockIcon className="w-5 h-5" />
        </span>
      )}
      <span className={who === 'all' ? BADGE_ALL : BADGE_ONLY_YOU}><Badge /></span>
    </span>
  );
}

function SecHead({ children, end }: { children: ReactNode; end?: ReactNode }): ReactNode {
  return (
    <div className="flex items-end justify-between gap-2 pr-4">
      <SectionHeader className="min-w-0 truncate">{children}</SectionHeader>
      {end}
    </div>
  );
}

function go(href: string | null): void {
  if (href && typeof window !== 'undefined') window.location.hash = href.replace(/^#/, '');
}

/** The side panel's controller (features/side-panel/), when the shell has one. */
function sidePanel(): {
  take?: (route: string, hint?: { place?: AiApp | null } | null) => boolean;
  close?: () => void;
} | null {
  return typeof window === 'undefined' ? null : (window as any).UsernodeReact?.sidePanel || null;
}

/** The Improve controller, which records where a topic page was opened from. */
function improve(): { enterTopicFrom?: (href: string) => void } | null {
  return typeof window === 'undefined' ? null : (window as any).Improve || null;
}

/**
 * A request, a change or a decision, opened from the list. On a wide
 * window in the column beside the list, in Main's place (the side panel,
 * drawn as this page's column: ‹ Main and its project over it); anywhere
 * else, and whenever the panel does not take it, its page, which goes back
 * here.
 */
function openPublic(href: string | null, app: AiApp | null): void {
  if (!href) return;
  try {
    if (sidePanel()?.take?.(href.replace(/^#/, ''), { place: app })) return;
  } catch {
    /* the page instead */
  }
  if (isTopicHref(href)) improve()?.enterTopicFrom?.(BOT_PAGE);
  go(href);
}

/** In progress or Up next: rows that each say what they wait on, the first few and Show more. */
function ThreadSection({ list, title, end, rows }: {
  list: 'next' | 'up'; title: ReactNode; end?: ReactNode; rows: AiThread[];
}): ReactNode {
  const t = useMessages('messages');
  const say = (p: Phrase) => t(p.id, p.values);
  const [all, setAll] = useState(false);
  if (!rows.length) return null;
  return (
    <>
      <SecHead end={end}>{title}</SecHead>
      <GroupedList tone="plane" data-ai-list={list}>
        {(all ? rows : rows.slice(0, NEXT_FIRST)).map((row) => (
          <ListRow
            key={row.threadId}
            as="button"
            chevron={false}
            onClick={() => openPublic(row.href, row.app)}
            data-ai-next={list === 'next' ? row.what : undefined}
            data-ai-up={list === 'up' ? row.what : undefined}
            leading={<WhoTile app={row.app} who="all" />}
            title={row.title || ''}
            titleClassName="whitespace-normal line-clamp-2"
            subtitle={say(nextWords(row))}
          />
        ))}
        {rows.length > NEXT_FIRST ? (
          <ListRow
            as="button"
            chevron={false}
            onClick={() => setAll(!all)}
            aria-expanded={all}
            title={<span className="text-violet-700 dark:text-violet-300">{all ? t('messages:ai.work.showLess') : t('messages:ai.work.showMore', { count: rows.length - NEXT_FIRST })}</span>}
            titleClassName="font-semibold"
          />
        ) : null}
      </GroupedList>
    </>
  );
}

export function AiScreen(): ReactNode {
  const t = useMessages('messages');
  const say = (p: Phrase) => t(p.id, p.values);
  const screenRef = useRef<HTMLElement | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  useVisibilityHiddenClass(screenRef, 'ai-screen', false);
  const visible = useVisibility('ai-screen', false);
  const wide = useWide();
  const [work, setWork] = useState<AiWork | null>(null);
  const [needs, setNeeds] = useState<NeedItem[] | null>(null);
  const [allWork, setAllWork] = useState(false);
  const [liveOpen, setLiveOpen] = useState(false);
  const [botId, setBotId] = useState<number | null>(null);
  const [at, setAt] = useState<{ threadRootId: number | null; focusMessageId: number | null } | null>(null);
  // A boot from the saved session draws this page before the server has
  // confirmed who you are, and a read made in that window can come back
  // with nothing; so could the chat docked beside it. `sv:session` (app.js)
  // is the shell saying who is signed in, so both are asked again then,
  // rather than staying empty until a reload (29 Oct 2026).
  const [session, setSession] = useState(0);
  useEffect(() => {
    const again = () => setSession((n) => n + 1);
    document.addEventListener('sv:session', again);
    return () => document.removeEventListener('sv:session', again);
  }, []);

  // Read on every showing: what is yours changes while you are elsewhere.
  useEffect(() => {
    if (!visible || typeof window === 'undefined' || !(window as any).App?.user) return undefined;
    let live = true;
    const qs = demoQuery();
    void readJson<AiWork>(`/api/ai/work${qs}`).then((data) => { if (live && data) setWork(data); });
    void readJson<{ items?: NeedItem[] }>(`/api/workshop/needs-feed?in=threads${qs ? '&demo=1' : ''}`)
      .then((data) => { if (live) setNeeds(Array.isArray(data?.items) ? data!.items : []); });
    return () => { live = false; };
  }, [visible, session]);

  // Main beside the list, on a desktop: the chat with the bot, opened once.
  useEffect(() => {
    if (!visible || !wide || botId || typeof window === 'undefined' || !(window as any).App?.user) return;
    void openBotConversation().then((id) => { if (id) setBotId(id); }).catch(() => {});
  }, [visible, wide, botId, session]);

  const rows = useMemo(() => needsYou(needs, work), [needs, work]);
  const folded = useMemo(() => foldWork(rows), [rows]);
  const progress = useMemo(() => inProgress(needs, work), [needs, work]);
  const waiting = useMemo(() => upNext(needs, work), [needs, work]);
  const live: AiThread[] = work?.live || [];
  const owed = owedCount(rows);
  const docked = wide && !!botId;

  const openRow = (row: WorkRow) => {
    if (row.rootId) {
      if (docked) {
        // A private thread is Main's: the panel, if a page is up in it, gives
        // Main its place back.
        sidePanel()?.close?.();
        setAt({ threadRootId: row.rootId, focusMessageId: null });
      } else go(`#homeroom-bot/thread/${row.rootId}`);
      return;
    }
    openPublic(row.href, row.app);
  };

  return (
    <main
      ref={screenRef}
      id="ai-screen"
      className="hidden flex-1 overflow-y-auto platform-safe-scroll"
      data-page-bounce=""
      data-ai-docked={docked ? '' : undefined}
      style={{ position: 'relative' }}
    >
      <div className="ai-screen-body max-w-2xl mx-auto pb-8">
        <section className="flex items-center gap-3 px-4 pt-5 pb-1" data-ai-hero="">
          <img src={BOT_AVATAR} alt="" className="w-12 h-12 rounded-2xl object-cover shrink-0" />
          <span className="min-w-0 flex flex-col">
            <h1 className="text-[1.375rem] font-bold leading-tight">{t('messages:ai.hero.name')}</h1>
            {work ? (
              <span className="text-[13px] text-zinc-500 dark:text-zinc-400" data-ai-hero-sub="">
                {say(heroWords(owed, progress.length))}
              </span>
            ) : null}
          </span>
        </section>

        {/* Needs you, counted in the label's own ink: a count is not a link. */}
        <SecHead>
          {owed ? t('messages:ai.work.titleCount', { count: owed }) : t('messages:ai.work.title')}
        </SecHead>
        <GroupedList tone="plane" data-ai-list="work">
          {work && needs && !rows.length ? (
            <p className="px-4 py-3 text-[0.9375rem] text-zinc-500 dark:text-zinc-400" data-ai-empty="">{t('messages:ai.work.empty')}</p>
          ) : null}
          {(allWork ? rows : folded).map((row) => (
            <ListRow
              key={row.key}
              as="button"
              chevron={false}
              onClick={() => openRow(row)}
              data-ai-row={row.key.split(':')[0]}
              data-who={row.who}
              leading={<WhoTile app={row.app} who={row.who} />}
              title={row.title}
              titleClassName="whitespace-normal line-clamp-2"
              subtitle={say(row.sub)}
              trailing={row.pill ? <span className={PILL}>{say(row.pill)}</span> : undefined}
            />
          ))}
          {rows.length > folded.length ? (
            <ListRow
              as="button"
              chevron={false}
              onClick={() => setAllWork(!allWork)}
              aria-expanded={allWork}
              title={<span className="text-violet-700 dark:text-violet-300">{allWork ? t('messages:ai.work.showLess') : t('messages:ai.work.showMore', { count: rows.length - folded.length })}</span>}
              titleClassName="font-semibold"
            />
          ) : null}
        </GroupedList>

        <ThreadSection
          list="next"
          title={t('messages:ai.next.title')}
          end={<span className="mb-1 text-[13px] text-zinc-500 dark:text-zinc-400">{t('messages:ai.next.soonest')}</span>}
          rows={progress}
        />
        <ThreadSection list="up" title={t('messages:ai.up.title')} rows={waiting} />

        {live.length ? (
          <>
            <button
              type="button"
              className="flex w-full items-center gap-1 px-4 pb-2 pt-6 text-left"
              aria-expanded={liveOpen}
              data-ai-live-toggle=""
              onClick={() => setLiveOpen(!liveOpen)}
            >
              <ChevronDownIcon className={`h-4 w-4 text-zinc-500 dark:text-zinc-400 transition-transform${liveOpen ? '' : ' -rotate-90'}`} aria-hidden="true" />
              <span className="text-xs font-bold uppercase tracking-[0.06em] text-zinc-500 dark:text-zinc-400">
                {t('messages:ai.live.title', { count: live.length })}
              </span>
            </button>
            {liveOpen ? (
              <GroupedList tone="plane" data-ai-list="live">
                {live.map((row) => (
                  <ListRow
                    key={row.threadId}
                    as="button"
                    chevron={false}
                    onClick={() => openPublic(row.href, row.app)}
                    leading={<WhoTile app={row.app} who="all" />}
                    title={row.title || ''}
                    subtitle={t('messages:ai.live.row', { project: row.app?.name || '', number: row.number || '' })}
                  />
                ))}
              </GroupedList>
            ) : null}
          </>
        ) : null}
        <div className="ai-askbar-gap" aria-hidden="true" />
      </div>

      {/* Ask Homeroom bot: Main. On a phone a bar over the tab bar; on a
          desktop Main is docked beside the list and this is not drawn. */}
      <div className="ai-askbar messages-composer" data-ai-askbar="">
        <a href="#homeroom-bot/main" className="messages-composer-card ai-askbar-card" aria-label={t('messages:ai.ask.label')}>
          <span className="ai-askbar-text">{t('messages:ai.ask.label')}</span>
          <span className="messages-composer-action" aria-hidden="true"><MicrophoneIcon className="h-5 w-5" /></span>
        </a>
      </div>

      {/* Main's left edge is the side panel's handle (30 Oct 2026): drag it,
          or use the arrow keys, to share the window between the list and
          Main; a page opened in Main's place keeps the width. */}
      {docked ? (
        <aside id="ai-main-pane" ref={mainRef} className="ai-main-pane" aria-labelledby="ai-main-title" data-ai-main="">
          <SidePanelDivider panelRef={mainRef} shown={docked} id="ai-main-divider" controls="ai-main-pane" />
          <header className="ai-main-head" data-ai-main-head="">
            <img src={BOT_AVATAR} alt="" className="w-8 h-8 rounded-[10px] object-cover shrink-0" />
            <span className="min-w-0 flex flex-col">
              <span id="ai-main-title" className="truncate text-[0.9375rem] font-[650] leading-5 text-zinc-900 dark:text-zinc-100">
                {t('messages:store.header.main')}
              </span>
              <span className="truncate text-[13px] leading-[18px] text-zinc-500 dark:text-zinc-400">{t('messages:ai.main.sub')}</span>
            </span>
          </header>
          <EmbeddedConversation conversationId={botId!} active={visible} at={at} />
        </aside>
      ) : null}
    </main>
  );
}
