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
 * builder or slot) is Waiting. 30 Oct 2026, from his Task Assistant
 * prototype: one line a row, grouped by project, on three sheets, with a
 * chip for each project (./lists.tsx draws them):
 *
 *   [bot] Homeroom bot             Needs you: 2 · In progress: 1
 *   ( All ) ( Garden club ) ( Bread bot )
 *
 *   NEEDS YOU · 2
 *   [tile] Garden club
 *     ☑ #403  Dark mode                                     Vote
 *     ▶ #410  A reminder email                          Build it
 *   ─────────
 *   IN PROGRESS · 1
 *   ─────────
 *   WAITING · 2
 *
 *   LIVE THIS WEEK · 1
 *   ( Ask Homeroom bot )                  ← a phone: Main
 *
 * THE LIST AND ONE THREAD (1 Nov 2026; 6 Nov 2026, request #6425). Main
 * Chat, the private conversation with the bot, is the list's first row, and
 * this page is the only place it is drawn: every way into it lands here
 * (./door.ts), never on the Messages screen. From 768px the page opens on
 * its lists alone, and the column beside them holds one thing at a time,
 * opened by a row: Main Chat, a private thread alone under its own head
 * (its name and "Only you can see this thread"; ReplyThreadPanel `inMain`),
 * or a page. The row of whichever it is is drawn lit. Everything in the
 * column closes with a × — a thread's own, Main Chat's, the side panel's
 * for a page — and closing leaves the lists alone, unless Main Chat was open
 * just before. On a phone the list and the column are one drawer, as
 * Messages' list and a conversation are (./phone-drawer.tsx): a row or the
 * Ask bar slides it in, and a thread's back arrow slides the list back.
 *
 * A REQUEST, A CHANGE OR A DECISION OPENS HERE TOO. On a wide window in the
 * column beside the list, in Main's place: the side panel, drawn as this
 * page's own column (the page's own name over it and a ×, no Expand, no
 * Back; ../side-panel/side-panel.tsx), and Main's composer
 * takes it as the item a question is about. Anywhere else on its page,
 * whose back chip says ‹ Homeroom bot and comes back here, with the
 * project's Workshop beside it (Improve.enterTopicFrom), and the tab bar
 * keeps Homeroom bot lit (App._isBotTopic). The phone's drawer holds only
 * Main and its threads (Evan, 30 Oct: "the Messages approach").
 *
 * A DESIGN'S PREVIEW IS A COLUMN OF ITS OWN (1 Nov 2026, threads, one loop
 * C1). Any private thread can hold a design; a version said in it shows
 * small with Open preview (../messages/design-card.tsx), and the preview
 * (the design pane) opens beside the thread (./preview.ts): list | thread |
 * preview where the three fit, the thread and the preview in halves where
 * they do not (the list steps aside; the tab, or the preview's ×, brings it
 * back), the whole screen on a phone, with a back arrow to the thread. It
 * goes when the column shows anything else.
 *
 * THE FIRST RENDER IS THE PRERENDER: the screen hidden, the bot's name and
 * no rows. The lists load in effects once the screen is shown to somebody
 * signed in, and the docked pane and the drawer exist only after mount.
 * While the screen is up they are read again whenever a thread they list
 * moves (./live.ts), not only when it is shown again.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { LockIcon, MicrophoneIcon, SearchIcon, XIcon } from '@/components/ui/icons';

import { RichMessage, useMessages } from '../../lib/i18n/react';
import { KEPT_DRAW_MS, keepCopy, keptCopy } from '../../lib/kept-copies';
import { FRESH } from '../../lib/live-reads';
import { useStoreState } from '../../lib/use-store-state';
import { useVisibility, useVisibilityHiddenClass } from '../../lib/visibility-store';
import { EmbeddedConversation } from '../messages';
import { closeNewThread, NewThreadButton, startNewThread, useNewThread } from '../messages/new-thread';
import { keptConversations, openBotConversation } from '../messages/api';
import { BOT_AVATAR } from '../messages/format';
import { closeThread, embed, loadConversations, useMessagesSnapshot } from '../messages/store';
import { SidePanelDivider } from '../side-panel/side-panel';
import { panelEdgeStore } from '../side-panel/edge-store';
import {
  AI_MAIN_WIDTH_KEY,
  AI_PREVIEW_COLUMN_WIDTH_KEY,
  AI_PREVIEW_WIDTH_KEY,
  MIN_PANEL_W,
  inlineStartOf,
  probeLayout,
} from '../side-panel/resize';
import { sidePanelStore } from '../side-panel/store.js';
import { attachmentFor, columnAddress, columnKey, routeOf, type Column, type ColumnDetail, type ColumnHow } from './column';
import {
  BOT_TAB, botDetailAt, botItemFromRoute, botItemRoute, botTabAddress, botTabAt, knownBotConversation, noteBotConversation, useBotTabAsk,
  type BotAt, type BotItem,
} from './door';
import { useLiveLists } from './live';
import { AiLists } from './lists';
import { AiFrameList } from './frame-list';
import { isFrameSkin, useSkin } from '../../lib/skin';
import { useFramePage } from '../frame/frame-page-store';
import { Icon as KitIcon, Tile as KitTile, k as kit } from '@/components/ui/kit';
import { historyAsked, isBotTabHash, kindOf, projectsOf, withFilter, type HistoryKind } from './filter-address';
import { useHistory, type HistoryRow } from './history';
import { communityScopeStore } from '../workshop/community-scope';
import { publishBotDrawer, registerBotBack } from '../nav-drawer/bot-drawer';
import { AiDrawer, MainPane, usePhone } from './phone-drawer';
import { closeDetail, detailLayout, openDetail, useDetail, THREE_COLUMNS } from './detail';
import { DetailPane } from '../detail/detail-pane';
import {
  freshCount, heroWords, inProgress, isTopicHref, liveThisWeek, needsYou, owedCount, rankProjects, upNext,
  type AiApp, type AiThread, type AiWork, type NeedItem, type WorkRow,
} from './model';

// 1 Nov 2026: the column is docked from 768px, where a phone's drawer ends.
const WIDE = '(min-width: 768px)';

/** The narrowest a design's or a plan's preview is in three columns
 *  (app.css, A DESIGN'S PREVIEW, A COLUMN OF ITS OWN). */
const PREVIEW_MIN_W = 360;
/** This page's address: where a thread opened from it comes back to. */
const BOT_PAGE = BOT_TAB;

function demoQuery(): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('demo') === '1' ? '?demo=1' : '';
}

/** A read of the lists: its answer when it was one, and whether the server answered at all. */
interface ListRead<T> {
  data: T | null;
  reached: boolean;
}

async function readJson<T>(path: string, init?: RequestInit): Promise<ListRead<T>> {
  try {
    const res = await fetch(path, { ...init, credentials: 'same-origin' });
    return { data: res.ok ? ((await res.json()) as T) : null, reached: true };
  } catch {
    return { data: null, reached: false };
  }
}

/**
 * Why the lists show less than they should: nothing read and nothing kept
 * for one of them, with no answer from the server ('unreachable') or with
 * an error ('failed'). Null when every list has something to draw.
 */
export type ListsFailure = 'unreachable' | 'failed' | null;

function useWide(at: string = WIDE): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const query = window.matchMedia(at);
    const sync = () => setWide(query.matches);
    sync();
    query.addEventListener?.('change', sync);
    return () => query.removeEventListener?.('change', sync);
  }, [at]);
  return wide;
}

function go(href: string | null): void {
  if (href && typeof window !== 'undefined') window.location.hash = href.replace(/^#/, '');
}

/**
 * The address says what the column shows, in place: a row pressed here is
 * no step for Back to take (as it was not before), but a reload reopens it.
 * Only while the address is this page's.
 */
function showAddress(href: string): void {
  if (typeof window === 'undefined' || !/^#(homeroom-bot|ai)(\/|\?|$)/.test(window.location.hash)) return;
  if (window.location.hash === href) return;
  try {
    history.replaceState(history.state, '', `${window.location.pathname}${window.location.search}${href}`);
  } catch { /* the column still shows it */ }
}

/** The side panel's controller (features/side-panel/), when the shell has one. */
function sidePanel(): {
  take?: (route: string, hint?: { place?: AiApp | null; label?: string | null } | null) => boolean;
  close?: () => void;
} | null {
  return typeof window === 'undefined' ? null : (window as any).UsernodeReact?.sidePanel || null;
}

/**
 * What a row opens, as the item Main's composer can carry (the ◆ chip a
 * shared item gets): a request by its number, a change by its session, a
 * decision by its id. Null for a page that is none of those (a Workshop).
 */
export interface AboutItem {
  type: 'issue' | 'proposal' | 'governance';
  appSlug: string;
  issueNumber?: number;
  sessionId?: number;
  proposalId?: number;
  title: string | null;
}
export function aboutRow(row: { key?: string; href: string | null; title?: string | null; app: AiApp | null; change?: { id: number } | null }): AboutItem | null {
  const slug = row.app?.slug;
  if (!slug) return null;
  const title = row.title || null;
  const issue = String(row.href || '').match(/^#?app\/[^/]+\/dev\/issues\/(\d+)$/);
  if (issue) return { type: 'issue', appSlug: slug, issueNumber: Number(issue[1]), title };
  const need = String(row.key || '').match(/^need:(proposal|governance):(\d+)$/);
  if (need?.[1] === 'proposal') return { type: 'proposal', appSlug: slug, sessionId: Number(need[2]), title };
  if (need?.[1] === 'governance') return { type: 'governance', appSlug: slug, proposalId: Number(need[2]), title };
  if (row.change?.id) return { type: 'proposal', appSlug: slug, sessionId: row.change.id, title };
  return null;
}

/** The Improve controller, which records where a topic page was opened from. */
function improve(): { enterTopicFrom?: (href: string) => void } | null {
  return typeof window === 'undefined' ? null : (window as any).Improve || null;
}

/**
 * A request, a change or a decision, opened from the list. On a wide
 * window in the column beside the list, in Main's place (the side panel,
 * drawn as this page's column: ‹ Main Chat and the page's name over it);
 * anywhere else, and whenever the panel does not take it, its page, which
 * goes back here.
 */
function openPublic(href: string | null, app: AiApp | null, label: string | null): boolean {
  if (!href) return false;
  try {
    // Main's composer takes what was opened (./column.ts attachmentFor),
    // once the column says it is this page.
    if (sidePanel()?.take?.(href.replace(/^#/, ''), { place: app, label })) return true;
  } catch {
    /* the page instead */
  }
  if (isTopicHref(href)) improve()?.enterTopicFrom?.(BOT_PAGE);
  go(href);
  return false;
}

/** Pure: the item a page's route is, for Main's composer, when no row named it (a reload). */
export function aboutRoute(route: string | null): AboutItem | null {
  const item = botItemFromRoute(route);
  if (!item || item.kind !== 'request') return null;
  return { type: 'issue', appSlug: item.slug, issueNumber: item.number, title: null };
}

export function AiScreen(): ReactNode {
  const t = useMessages('messages');
  const screenRef = useRef<HTMLElement | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  const previewRef = useRef<HTMLElement | null>(null);
  useVisibilityHiddenClass(screenRef, 'ai-screen', false);
  const visible = useVisibility('ai-screen', false);
  const wide = useWide();
  const [work, setWork] = useState<AiWork | null>(null);
  const [needs, setNeeds] = useState<NeedItem[] | null>(null);
  const [botId, setBotId] = useState<number | null>(null);
  const [at, setAt] = useState<{ threadRootId: number | null; focusMessageId: number | null } | null>(null);
  // A phone: the list and Main are one drawer (./phone-drawer.tsx); level 1 is Main.
  const phone = usePhone();
  const [level, setLevel] = useState<0 | 1>(0);
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

  // THE FILTER IS THE ADDRESS'S (5 Nov 2026, ./filter-address.ts): the
  // projects the chips narrow the lists to, and History's kind. Read from
  // the address whenever it changes to one of the tab's (a project's
  // Workshop links here narrowed to it), and written back in place when the
  // chips change, so a reload or a copied link keeps it. A plain
  // #homeroom-bot is every project.
  const [picked, setPicked] = useState<string[]>([]);
  const [historyKind, setHistoryKind] = useState<HistoryKind | null>(null);
  const [toHistory, setToHistory] = useState(0);
  const historyRef = useRef<HTMLDivElement | null>(null);
  // Read again each time the tab is shown, too: an old address the router
  // swaps for one of the tab's in place (#profile/your-changes, which is
  // History on changes now) fires no hashchange.
  const takeFilter = useRef<() => void>(() => {});
  takeFilter.current = () => {
    if (typeof window === 'undefined') return;
    const hash = window.location.hash;
    if (!isBotTabHash(hash)) return;
    setPicked(projectsOf(hash));
    setHistoryKind(kindOf(hash));
    if (historyAsked(hash)) setToHistory((n) => n + 1);
  };
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const take = () => takeFilter.current();
    take();
    window.addEventListener('hashchange', take);
    return () => window.removeEventListener('hashchange', take);
  }, []);
  useEffect(() => { if (visible) takeFilter.current(); }, [visible]);
  const filterRef = useRef({ picked, historyKind });
  filterRef.current = { picked, historyKind };
  const writeFilter = (next: { picked: string[]; historyKind: HistoryKind | null }) => {
    if (typeof window === 'undefined' || !isBotTabHash(window.location.hash)) return;
    showAddress(withFilter(window.location.hash, { projects: next.picked, kind: next.historyKind }));
  };
  const pick = (slugs: string[]) => {
    setPicked(slugs);
    writeFilter({ picked: slugs, historyKind });
  };
  const pickKind = (kind: HistoryKind | null) => {
    setHistoryKind(kind);
    writeFilter({ picked, historyKind: kind });
  };
  // A project a link picked that no list names yet: its chip, from what
  // the Communities tab knows of it, else by its address alone, so the
  // lists still say there is nothing of yours there rather than showing
  // every project.
  const appFor = (slug: string): AiApp | null => {
    const info = communityScopeStore.get().info?.[slug];
    return info
      ? { slug, name: info.name || slug, icon_url: info.iconUrl || null, icon_emoji: info.iconEmoji || null }
      : { slug, name: slug, icon_url: null, icon_emoji: null };
  };

  // Read on every showing: what is yours changes while you are elsewhere.
  // And again while the page is up, each time a thread it lists moves
  // (./live.ts counts those in `moved`). Every read after the first asks
  // past the service worker's saved copy, since it is for what changed
  // since; one that fails keeps the lists as they were.
  //
  // Offline (offline test, 2 Nov 2026), a list with nothing drawn yet draws
  // the copy this device kept of it (../../lib/kept-copies.ts: GET
  // /api/ai/work answers `no-store`, so the worker keeps none), and one with
  // no copy either says so over Needs you, with Try again (`failed`),
  // instead of leaving an empty card. A list with nothing drawn draws its
  // copy once its read has gone KEPT_DRAW_MS unanswered too, the read still
  // going: a network that carries nothing answers no read for 15 s.
  const [moved, setMoved] = useState(0);
  const [failed, setFailed] = useState<ListsFailure>(null);
  const readBefore = useRef(false);
  const drawn = useRef({ work, needs });
  drawn.current = { work, needs };
  useEffect(() => {
    if (!visible || typeof window === 'undefined' || !(window as any).App?.user) return undefined;
    let live = true;
    const qs = demoQuery();
    const again = readBefore.current;
    readBefore.current = true;
    const init = again ? FRESH : undefined;
    const early = setTimeout(() => {
      if (!live) return;
      const keptWork = drawn.current.work ? null : keptCopy<AiWork>('ai:work');
      const keptNeeds = drawn.current.needs ? null : keptCopy<NeedItem[]>('ai:needs');
      if (keptWork) setWork(keptWork);
      if (Array.isArray(keptNeeds)) setNeeds(keptNeeds);
    }, KEPT_DRAW_MS);
    // Each list as it lands; the read that left one with nothing to draw is handed on.
    const workDone = readJson<AiWork>(`/api/ai/work${qs}`, init).then((read) => {
      if (!live) return null;
      if (read.data) {
        setWork(read.data);
        keepCopy('ai:work', read.data);
        return null;
      }
      if (drawn.current.work) return null;
      const kept = keptCopy<AiWork>('ai:work');
      if (kept) setWork(kept);
      return kept ? null : read;
    });
    const needsDone = readJson<{ items?: NeedItem[] }>(`/api/workshop/needs-feed?in=threads${qs ? '&demo=1' : ''}`, init).then((read) => {
      if (!live) return null;
      if (read.data) {
        const items = Array.isArray(read.data.items) ? read.data.items : [];
        setNeeds(items);
        keepCopy('ai:needs', items);
        return null;
      }
      if (drawn.current.needs) return null;
      const kept = keptCopy<NeedItem[]>('ai:needs');
      if (Array.isArray(kept)) setNeeds(kept);
      return Array.isArray(kept) ? null : read;
    });
    void Promise.all([workDone, needsDone]).then((reads) => {
      clearTimeout(early);
      if (!live) return;
      const missing = reads.flatMap((read) => (read ? [read] : []));
      setFailed(!missing.length ? null : missing.some((read) => !read.reached) ? 'unreachable' : 'failed');
    });
    return () => { live = false; clearTimeout(early); };
  }, [visible, session, moved]);

  // Main beside the list, on a desktop, or peeking beside it in a phone's
  // drawer: the chat with the bot, opened once. The list is read here too,
  // so Main's row says what is new without the chat being open (#6425).
  useEffect(() => {
    if (!visible || !(wide || phone) || botId || typeof window === 'undefined' || !(window as any).App?.user) return;
    void loadConversations();
    void openBotConversation().then((id) => {
      if (!id) return;
      noteBotConversation(id);
      setBotId(id);
    }).catch(() => {
      // Offline: the chat this device already knows, from Messages' list or
      // the copy of it kept here, so Main opens on what was kept of it.
      const known = knownBotConversation()
        || keptConversations()?.find((item) => item.homeroomBot && item.kind !== 'channel')?.id
        || null;
      if (!known) return;
      noteBotConversation(known);
      setBotId(known);
    });
  }, [visible, wide, phone, botId, session]);

  // What the column shows (1 Nov 2026): Main Chat, a thread of it, a blank
  // thread from "+", or a page the side panel holds in Main's place. Read
  // after mount: the first render is the prerender's.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const snap = useMessagesSnapshot();
  const blank = useNewThread(botId);
  const panel = useStoreState(sidePanelStore);
  const docked = wide && !!botId;
  const inMain = !!botId && snap.route.embedded && snap.route.conversationId === botId;
  const openRoot = inMain ? snap.route.threadRootId : null;
  const threadUp = !!openRoot || blank;
  // THE COLUMN (./column.ts, 3 Nov 2026): the one answer to what is open
  // beside the list. The lit row, the address and Main's attachment all read
  // it; nothing else keeps a copy. 6 Nov 2026 (#6425): on a desktop the lists
  // start alone, and Main Chat opens in the column only when its row (or a
  // link to it) asks for it.
  const [mainOpen, setMainOpen] = useState(false);
  const panelRoute = panel.open ? routeOf(panel.route) : null;
  const column: Column = !mounted || !botId ? null
    : phone ? (level === 1 ? (openRoot ? { at: 'thread', rootId: openRoot } : blank ? { at: 'new' } : { at: 'main' }) : null)
    : !docked ? null
    : panelRoute ? { at: 'page', route: panelRoute }
    : blank ? { at: 'new' }
    : openRoot ? { at: 'thread', rootId: openRoot }
    : mainOpen ? { at: 'main' } : null;
  // Whether anything is open beside the lists: the room Main takes, its
  // divider, the aside's visibility and the list's padding all follow it.
  const columnOpen = docked && !!column;
  // THE CHAT IS MOUNTED ONLY WHEN IT CAN BE SEEN OR ASKED FOR (#6425): Main
  // closed is neither drawn nor marked read, and its row keeps showing what
  // is new. A thread asked for by a row or an address is not in the store
  // yet, so `at` mounts the conversation that opens it.
  const conversationUp = columnOpen || !!at?.threadRootId;
  // A private thread closed with its own × leaves the lists alone: `at`
  // named it, and keeping it would keep the conversation mounted beside them.
  const hadThread = useRef<number | null>(null);
  useEffect(() => {
    const before = hadThread.current;
    hadThread.current = openRoot;
    if (before && !openRoot) setAt(null);
  }, [openRoot]);
  const shown = columnKey(column);
  const lit = shown === 'new' ? null : shown;
  // 1 Nov 2026 (C1), one store since #6230: what a thread opened to read
  // beside it — a design's preview, a plan, or a change's before and after
  // (./detail.ts). A design belongs to the thread it is in; a plan or a
  // change belongs to the page the column shows.
  const detail = useDetail();
  const three = useWide(THREE_COLUMNS);
  const layout = detailLayout('bot', { phone, wide: three });
  const detailHere = !!detail && !!botId && (detail.kind === 'design'
    ? detail.ref.conversationId === botId && openRoot === detail.ref.rootId
      && (phone ? level === 1 : docked && !panel.open)
    : detail.kind === 'draft'
    // #6248: a request draft is read beside the thread it was said in, or Main.
    ? detail.ref.conversationId === botId && (openRoot ?? null) === (detail.ref.rootId ?? null)
      && (phone ? level === 1 : docked && !panel.open)
    : !!column && (column.at === 'page' || column.at === 'thread'));
  // With a preview beside the thread both edges are handles (#6359), each
  // the width of the column after it, the list taking what is left. In three
  // columns the thread's width runs to where the preview begins, and its
  // bound keeps the list's floor beside the preview as it is now drawn, the
  // same room app.css leaves it (`--ai-room` - 480px - `--ai-preview-w`), so
  // the handle stops where the column does; it is read again whenever the
  // preview's width changes (`watch` below). The preview's keeps the list's
  // floor and the thread's. In halves the list has stepped aside, so the
  // thread's edge is no handle and the preview's keeps only the thread's floor.
  const threeUp = detailHere && layout === 'three';
  const pageInColumn = column?.at === 'page';
  const threadProbe = useCallback(() => {
    const probe = probeLayout();
    const pane = previewRef.current;
    const box = pane ? pane.getBoundingClientRect() : null;
    if (!box || box.width <= 0) return { ...probe, neighbourMin: (probe.neighbourMin ?? 0) + PREVIEW_MIN_W };
    const endAt = inlineStartOf(box);
    const roomEnd = probe.innerWidth - Math.max(0, probe.rightInset || 0);
    return { ...probe, neighbourMin: (probe.neighbourMin ?? 0) + Math.max(0, roomEnd - endAt), endAt };
  }, []);
  const previewProbe = useCallback(() => {
    const probe = probeLayout();
    return layout === 'three'
      ? { ...probe, neighbourMin: (probe.neighbourMin ?? 0) + MIN_PANEL_W, selfMin: PREVIEW_MIN_W }
      : { ...probe, neighbourMin: MIN_PANEL_W };
  }, [layout]);
  // A PAGE IN THE SIDE PANEL WITH A DETAIL BESIDE IT (#6394, 6 Nov 2026):
  // list | request | plan. That middle column is its own island, outside
  // #ai-screen, so its divider cannot take threadProbe as a prop: this store
  // is the seam (../side-panel/edge-store). While it is set, the panel's edge
  // sets the column's own width under the thread's key, with the thread's
  // probe (the list's floor plus the preview) and the preview to watch.
  // Cleared whenever the column is not that page, or the detail or the third
  // column goes, so the edge is Main's again.
  useEffect(() => {
    panelEdgeStore.set({
      slot: visible && threeUp && pageInColumn
        ? { widthKey: AI_PREVIEW_COLUMN_WIDTH_KEY, probe: threadProbe, watch: previewRef }
        : null,
    });
    return () => { panelEdgeStore.set({ slot: null }); };
  }, [visible, threeUp, pageInColumn, threadProbe]);
  const detailSlot: ColumnDetail | undefined = !detailHere || !detail ? undefined
    : detail.kind === 'design' ? { kind: 'design', version: detail.version }
      : detail.kind === 'plan' && detail.ref.sessionId ? { kind: 'plan', sessionId: detail.ref.sessionId, version: detail.version }
        : detail.kind === 'shots' && detail.ref.changeId ? { kind: 'shots', changeId: detail.ref.changeId }
          : undefined;
  const columnShown: Column = column && detailSlot ? { ...column, detail: detailSlot } as Column : column;
  // The column shows another thread: its detail goes — unless it was opened
  // from that very page (the forwarded plan on a request).
  // Only while this page is the one on screen: the AI screen stays mounted
  // (hidden) behind every other page, and its rule must not close a plan
  // opened beside a request's own page or in the Workshop.
  useEffect(() => {
    if (!visible || !botId || !detail) return;
    if (detail.kind === 'design' && openRoot && openRoot !== detail.ref.rootId) closeDetail();
    if (detail.kind === 'draft' && openRoot && openRoot !== detail.ref.rootId) closeDetail();
    if (detail.kind !== 'design' && detail.kind !== 'draft' && !detailHere) closeDetail();
  }, [visible, botId, detail, openRoot, detailHere]);
  // The tab pressed (the page's own address, from a thread's): the list
  // comes back, and the detail goes.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const back = () => { if (window.location.hash === BOT_TAB) closeDetail(); };
    window.addEventListener('hashchange', back);
    return () => window.removeEventListener('hashchange', back);
  }, []);
  // A reload or a copied link reopens the detail the address names (#6230).
  const restored = useRef<string | null>(null);
  useEffect(() => {
    if (!mounted || !botId || typeof window === 'undefined') return;
    const hash = window.location.hash;
    if (restored.current === hash) return;
    restored.current = hash;
    const at = botDetailAt(hash);
    if (!at) return;
    if (at.kind === 'plan') openDetail({ kind: 'plan', ref: { sessionId: at.sessionId }, version: at.version });
    else if (at.kind === 'shots') openDetail({ kind: 'shots', ref: { changeId: at.changeId }, version: null });
    else {
      const where = botTabAt(hash);
      if (where?.threadRootId) {
        openDetail({ kind: 'design', ref: { conversationId: botId, rootId: where.threadRootId }, version: at.version });
      }
    }
  }, [mounted, botId]);
  const botRow = mounted ? snap.conversations.find((item) => item.homeroomBot && item.kind !== 'channel') : null;
  const unread = Math.max(0, Number(botRow?.unreadCount) || 0);

  // #6159: a thread marked done from its row's ⋯ leaves at once; the next
  // read of the lists confirms it.
  const [doneRoots, setDoneRoots] = useState<ReadonlySet<number>>(() => new Set());
  // #6262: opening a thread clears its dot at once, before the next read of
  // the lists says so. The server keeps the cursor (POST threads/read), so
  // the next read agrees.
  const [seenThreads, setSeenThreads] = useState<ReadonlySet<number>>(() => new Set());
  const markThreadRead = (threadId: number | null | undefined, app: AiApp | null): void => {
    if (!threadId) return;
    setSeenThreads((had) => (had.has(threadId) ? had : new Set([...had, threadId])));
    if (!app?.slug || typeof window === 'undefined') return;
    void fetch(`/api/apps/${encodeURIComponent(app.slug)}/threads/read${demoQuery()}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ thread_id: threadId }),
    }).then((res) => (res.ok ? res.text() : null)).catch(() => { /* the next open reads it again */ });
  };
  const cleared = <T extends { threadId?: number | null; unread?: number }>(row: T): T => (
    row.threadId && seenThreads.has(row.threadId) ? { ...row, unread: 0 } : row
  );
  const allRows = useMemo(
    () => needsYou(needs, work).map(cleared),
    [needs, work, seenThreads], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const rows = useMemo(() => allRows.filter((row) => !row.rootId || !doneRoots.has(row.rootId)), [allRows, doneRoots]);
  const progress = useMemo(() => inProgress(needs, work).map(cleared), [needs, work, seenThreads]); // eslint-disable-line react-hooks/exhaustive-deps
  const waiting = useMemo(() => upNext(needs, work).map(cleared), [needs, work, seenThreads]); // eslint-disable-line react-hooks/exhaustive-deps
  const live: AiThread[] = useMemo(() => liveThisWeek(work).map(cleared), [work, seenThreads]); // eslint-disable-line react-hooks/exhaustive-deps
  const owed = owedCount(rows);
  const fresh = freshCount(rows);
  const projects = useMemo(
    () => new Set(rankProjects(rows, progress, waiting, live).map((p) => p.app.slug)),
    [rows, progress, waiting, live],
  );
  useLiveLists(() => setMoved((n) => n + 1), visible, { projects, botId });
  // HISTORY (./history.ts): read on each showing, and again when the
  // projects picked or its kind change.
  const [showings, setShowings] = useState(0);
  useEffect(() => { if (visible) setShowings((n) => n + 1); }, [visible, session]);
  const history = useHistory({
    showing: showings,
    signedIn: mounted && typeof window !== 'undefined' && !!(window as any).App?.user,
    projects: picked,
    kind: historyKind,
    demo: !!demoQuery(),
  });
  // #homeroom-bot/history: the card, scrolled to once it has drawn.
  const scrolledFor = useRef(0);
  useEffect(() => {
    if (!toHistory || scrolledFor.current === toHistory || !visible || !history.ready) return;
    scrolledFor.current = toHistory;
    historyRef.current?.scrollIntoView?.({ block: 'start' });
  }, [toHistory, visible, history.ready]);

  // A place in the chat, in the column (Main, or a thread of it, at a
  // message): a page the panel holds there gives Main its place back, and a
  // thread or a blank one open there gives way. On a phone the drawer slides
  // to it.
  // How the column came to change (./column.ts ColumnHow): this page's own
  // doors say 'row'; a change none of them made is the column's ×, 'back'.
  // The item a row opened, for Main's composer.
  const how = useRef<ColumnHow>('back');
  const opened = useRef<{ route: string; about: AboutItem | null } | null>(null);
  const showAt = (next: BotAt) => {
    sidePanel()?.close?.();
    closeNewThread();
    if (!detail || detail.kind === 'design') {
      if (!next.threadRootId || next.threadRootId !== detail?.ref.rootId) closeDetail();
    }
    if (!next.threadRootId && openRoot) closeThread();
    setAt({ ...next });
    // A thread asked for goes into the store here, not only through the chat
    // mounted below: with Main closed that chat is not drawn yet, and the
    // column reads the thread from the store (#6425).
    if (botId && next.threadRootId) embed(botId, next);
    // Main Chat opens it; a thread leaves Main behind it only when it was.
    setMainOpen(!next.threadRootId || column?.at === 'main');
    if (phone) setLevel(1);
  };
  // CLOSING THE COLUMN (6 Nov 2026, #6425): × on Main Chat, or the tab
  // pressed while something is open. Everything opened beside the lists goes;
  // a page opened over a private thread is the side panel's own × instead,
  // which leaves that thread under it.
  const closeColumn = () => {
    if (!docked) return;
    sidePanel()?.close?.();
    closeNewThread();
    if (openRoot) closeThread();
    closeDetail();
    setMainOpen(false);
    setAt(null);
  };
  // The router's ask (./door.ts): `#homeroom-bot/main`, `/thread/<id>`, a
  // message in either, from any door into the chat; a bare `#homeroom-bot`
  // closes what is open. Each once, once the page knows whether it is a
  // phone's.
  const ask = useBotTabAsk();
  const askTaken = useRef(0);
  useEffect(() => {
    if (!ask || ask.seq === askTaken.current || !visible || !(wide || phone)) return;
    askTaken.current = ask.seq;
    how.current = 'row';
    if (ask.close) closeColumn();
    else if (ask.item) openItem(ask.item);
    else if (ask.at) showAt(ask.at);
  }, [ask, visible, wide, phone]); // eslint-disable-line react-hooks/exhaustive-deps
  // 10 Nov 2026: `#homeroom-bot/new…` is the "+" pressed for you, with the
  // project and who works on it already set when the address names them
  // (./door.ts botNewAt). It opens beside the chat, so it has a count of its
  // own to wait on until the page knows which chat that is.
  const freshTaken = useRef(0);
  useEffect(() => {
    if (!ask?.fresh || ask.seq === freshTaken.current || !visible || !(wide || phone) || !botId) return;
    freshTaken.current = ask.seq;
    how.current = 'row';
    openBlank();
    startNewThread(botId, ask.fresh);
  }, [ask, visible, wide, phone, botId]); // eslint-disable-line react-hooks/exhaustive-deps

  const openMain = () => {
    if (!(wide || phone)) { go(botTabAddress(null)); return; }
    how.current = 'row';
    showAt({ threadRootId: null, focusMessageId: null });
  };
  // A page the panel took is in the column, in Main's place, and closing it
  // gives the column back to what was under it: a thread that was open there,
  // or Main Chat when Main was (6 Nov 2026, #6425). The address is the
  // column's (below).
  const underPanel = () => {
    closeNewThread();
    if (openRoot) closeThread();
  };
  // A private thread is the column's, alone, in Main's place.
  const openPrivate = (rootId: number) => {
    const next = { threadRootId: rootId, focusMessageId: null };
    if (!(wide || phone)) { go(botTabAddress(next)); return; }
    how.current = 'row';
    showAt(next);
  };
  // A request, a change or a decision: its page, in the column on a wide
  // window, its own page anywhere else. Every row goes to its own place
  // (#6210): a ▷ plan row to its request's page, where its plan and Build
  // it are, the same place a Vote or Needs Reply row for it opens.
  const openPage = (href: string | null, app: AiApp | null, title: string | null, about: AboutItem | null) => {
    how.current = 'row';
    setMainOpen(column?.at === 'main');
    const route = routeOf(href);
    opened.current = route ? { route, about } : null;
    if (openPublic(href, app, title)) underPanel();
  };
  const openRow = (row: WorkRow) => {
    markThreadRead(row.threadId, row.app);
    if (row.rootId) {
      openPrivate(row.rootId);
      return;
    }
    openPage(row.href, row.app, row.title, aboutRow(row));
  };
  const openThread = (th: AiThread) => {
    markThreadRead(th.threadId, th.app);
    // #6153: a request filed from a private thread opens that thread, where
    // its design and its story are, rather than the request's page.
    if (th.rootId) {
      openPrivate(th.rootId);
      return;
    }
    openPage(th.href, th.app, th.title, aboutRow(th));
  };
  // A History row opens what it names: a private thread in the column, a
  // request, a change or a decision on its page, as the lists' rows do.
  const openHistory = (row: HistoryRow) => {
    if (row.rootId) {
      openPrivate(row.rootId);
      return;
    }
    openPage(row.href, row.app, row.title, aboutRow({ key: row.key, href: row.href, title: row.title, app: row.app }));
  };
  // A project as the lists name it, for the column's heading when an item is
  // reopened from its address (the row that named it is not to hand).
  function appFromLists(slug: string): AiApp | null {
    for (const list of [rows, progress, waiting, live]) {
      const row = (list as Array<{ app: AiApp | null }>).find((item) => item.app?.slug === slug);
      if (row?.app) return row.app;
    }
    return (needs || []).find((item) => item.app?.slug === slug)?.app ?? null;
  }
  // An item the router asked for by its address (#6215,
  // `#homeroom-bot/request/<slug>/<n>`): in the column on a wide window, its
  // own page anywhere else, or when the column does not take it.
  function openItem(item: BotItem) {
    const route = botItemRoute(item);
    if (!route) { go(BOT_TAB); return; }
    setMainOpen(column?.at === 'main');
    opened.current = { route, about: null };
    if (wide) {
      try {
        if (sidePanel()?.take?.(route, { place: appFromLists(item.slug), label: null })) { underPanel(); return; }
      } catch { /* the page instead */ }
    }
    improve()?.enterTopicFrom?.(BOT_PAGE);
    window.location.replace(`#${route}`);
  }
  // THE ADDRESS IS THE COLUMN'S (#6215): Main, a thread, or the item in it,
  // so a reload reopens it; a phone's list, a blank thread and any other page
  // are the tab itself. Written in place: a row is no step for Back. Not on
  // the column's first showing, which the address itself asked for.
  const addressed = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!mounted || !visible || !botId) return;
    const before = addressed.current;
    const now = `${shown}|${detailSlot ? JSON.stringify(detailSlot) : ''}`;
    addressed.current = now;
    if (before === undefined) return;
    if (before === now) return;
    showAddress(withFilter(columnAddress(columnShown), { projects: filterRef.current.picked, kind: filterRef.current.historyKind }));
  }, [mounted, visible, botId, shown, detailSlot]); // eslint-disable-line react-hooks/exhaustive-deps
  // MAIN'S ATTACHMENT FOLLOWS THE COLUMN (#6212, ./column.ts attachmentFor):
  // a page opened from the list is what a question is about; ‹ Main Chat back
  // from it keeps it; any other way into Main, or a thread, takes the list's
  // off. An item the person attached themselves stays (the composer's rule).
  const attachedFor = useRef<Column>(null);
  useEffect(() => {
    if (!botId || typeof window === 'undefined') return;
    const before = attachedFor.current;
    attachedFor.current = column;
    const was = how.current;
    how.current = 'back';
    const what = attachmentFor(before, column, was);
    if (what === 'attach' && column?.at === 'page') {
      const named = opened.current?.route === column.route ? opened.current.about : null;
      const about = named || aboutRoute(column.route);
      if (about) {
        window.dispatchEvent(new CustomEvent('usernode:messages-object-selected', {
          detail: { ...about, conversationId: botId, source: 'list' },
        }));
      } else {
        window.dispatchEvent(new CustomEvent('usernode:messages-object-cleared', { detail: { conversationId: botId } }));
      }
    } else if (what === 'clear') {
      window.dispatchEvent(new CustomEvent('usernode:messages-object-cleared', { detail: { conversationId: botId } }));
    }
  }, [shown, botId]); // eslint-disable-line react-hooks/exhaustive-deps
  // A page the side panel takes is the column's: no design preview beside it.
  useEffect(() => { if (panel.open && detail?.kind === 'design') closeDetail(); }, [panel.open, detail]);
  // On a phone the column slides back to the list; the address is the page's.
  const toList = () => {
    setLevel(0);
  };
  // THE HEADER IS MAIN CHAT'S on a phone (3 Nov 2026,
  // ../nav-drawer/bot-drawer.ts): "Homeroom bot" over the list, the arrow and
  // "Main Chat" over its line once it slides in. A private thread keeps its
  // own head, so the header is the tab's plain one while a thread is open.
  const toListRef = useRef(toList);
  toListRef.current = toList;
  useEffect(() => registerBotBack(() => toListRef.current()), []);
  const mainTitle = t('messages:store.header.main');
  const mainSub = t('messages:ai.main.sub');
  useEffect(() => {
    publishBotDrawer({ on: phone && visible && !threadUp, level, title: mainTitle, sub: mainSub });
  }, [phone, visible, threadUp, level, mainTitle, mainSub]);
  useEffect(() => () => publishBotDrawer({ on: false, level: 0, title: '', sub: '' }), []);

  // #6071 follow-up: "+" starts a new blank thread with the bot, in the
  // column (../messages/new-thread.tsx), slid in on a phone.
  const openBlank = () => {
    sidePanel()?.close?.();
    closeDetail();
    how.current = 'row';
    setMainOpen(column?.at === 'main');
    if (phone) setLevel(1);
  };
  // SEARCH (#6398, 6 Nov 2026): a round button beside the plus opens a box
  // under the heading, and every list narrows to the threads whose title,
  // number or project matches what it says (./lists.tsx). It starts closed
  // each time the page loads, closing it clears what was typed, and it is
  // not kept in the address: the chips are what a link carries.
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { if (searchOpen) searchRef.current?.focus(); }, [searchOpen]);

  const heroLine = work ? heroWords(owed, progress.length, fresh) : null;
  // A look of the one frame draws the list with the kit (./frame-list.tsx),
  // from the same rows and presses. Read after mount (lib/skin.ts says why).
  const frame = isFrameSkin(useSkin());
  // On a phone the open chat takes the whole screen: the frame's bar names
  // it and its arrow goes back to the list (../frame/frame-page-store.ts).
  const listAgain = useCallback(() => toListRef.current(), []);
  useFramePage(frame && phone && visible && level === 1 && !threadUp ? [mainTitle] : null, listAgain);
  const hero = (
    <>
      <section className="flex items-center gap-3 px-4 pt-3" data-ai-hero="">
        <img src={BOT_AVATAR} alt="" className="w-12 h-12 rounded-2xl object-cover shrink-0" />
        <span className="min-w-0 flex-1 flex flex-col">
          <h1 className="text-[1.375rem] font-bold leading-tight">{t('messages:ai.hero.name')}</h1>
          {heroLine ? (
            <span className="text-[13px] text-zinc-500 dark:text-zinc-400" data-ai-hero-sub="">
              <RichMessage
                id={heroLine.id}
                values={heroLine.values}
                components={[<strong className="font-semibold text-violet-700 dark:text-violet-300" />]}
              />
            </span>
          ) : null}
        </span>
        {/* The plus's own button, with the magnifying glass: the app's icon. */}
        <button
          type="button"
          className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-zinc-700 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800 [&>svg]:h-5 [&>svg]:w-5"
          aria-label={t('messages:ai.search.open')}
          title={t('messages:ai.search.open')}
          aria-expanded={searchOpen}
          data-ai-search-toggle=""
          onClick={() => {
            if (searchOpen) setQuery('');
            setSearchOpen((open) => !open);
          }}
        >
          <SearchIcon aria-hidden="true" />
        </button>
        <NewThreadButton
          conversationId={botId || null}
          onOpen={openBlank}
          className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-zinc-700 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800 [&>svg]:h-5 [&>svg]:w-5"
        />
      </section>
      {/* The More projects panel's own search box, under the heading and
          between it and the project chips (./project-picker.tsx). */}
      {searchOpen ? (
        <label className="mx-4 mt-3 flex h-[38px] shrink-0 items-center gap-2 rounded-xl bg-zinc-900/[0.05] px-3 text-zinc-500 focus-within:shadow-[inset_0_0_0_2px_var(--accent)] dark:bg-white/[0.08] dark:text-zinc-400">
          <SearchIcon className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setQuery(''); setSearchOpen(false); } }}
            placeholder={t('messages:ai.search.label')}
            aria-label={t('messages:ai.search.label')}
            className="h-full min-w-0 flex-1 appearance-none border-0 bg-transparent p-0 text-base text-zinc-900 outline-none placeholder:text-zinc-500 dark:text-zinc-100 dark:placeholder:text-zinc-400 [&::-webkit-search-cancel-button]:hidden"
            data-ai-search=""
          />
        </label>
      ) : null}
    </>
  );

  const listContent = (
    <>
      {frame ? (
        <AiFrameList
          heroLine={heroLine}
          main={{ lit: lit === 'main', unread, open: openMain }}
          lit={lit}
          ready={!!work && !!needs}
          rows={rows}
          progress={progress}
          waiting={waiting}
          live={live}
          openRow={openRow}
          openThread={openThread}
          picked={picked}
          onPick={pick}
          appFor={appFor}
          onNew={() => { openBlank(); if (botId) startNewThread(botId); }}
          query={query}
          onQuery={setQuery}
          history={history}
          historyKind={historyKind}
          onHistoryKind={pickKind}
          openHistory={openHistory}
          historyRef={historyRef}
        />
      ) : (
      <div className="ai-screen-body max-w-2xl mx-auto pb-8">
        <AiLists
          hero={hero}
          main={{ lit: lit === 'main', unread, open: openMain }}
          query={searchOpen ? query : ''}
          lit={lit}
          ready={!!work && !!needs}
          failed={failed}
          onRetry={() => setMoved((n) => n + 1)}
          rows={rows}
          owed={owed}
          progress={progress}
          waiting={waiting}
          live={live}
          openRow={openRow}
          openThread={openThread}
          onDone={(rootId) => { setDoneRoots((had) => new Set([...had, rootId])); setMoved((n) => n + 1); }}
          picked={picked}
          onPick={pick}
          appFor={appFor}
          history={history}
          historyKind={historyKind}
          onHistoryKind={pickKind}
          openHistory={openHistory}
          historyRef={historyRef}
        />
        <div className="ai-askbar-gap" aria-hidden="true" />
      </div>
      )}

      {/* Ask Homeroom bot: Main. A bar over the tab bar; on a desktop Main
          is docked beside the list and this is not drawn. */}
      <div className="ai-askbar messages-composer" data-ai-askbar="">
        <a
          href="#homeroom-bot/main"
          className="messages-composer-card ai-askbar-card"
          aria-label={t('messages:ai.ask.label')}
          // On a phone's drawer Main is beside the list: in, not away.
          onClick={(e) => { if (phone) { e.preventDefault(); openMain(); } }}
        >
          <span className="ai-askbar-text">{t('messages:ai.ask.label')}</span>
          <span className="messages-composer-action" aria-hidden="true"><MicrophoneIcon className="h-5 w-5" /></span>
        </a>
      </div>
    </>
  );

  return (
    <main
      ref={screenRef}
      id="ai-screen"
      className="hidden flex-1 overflow-y-auto platform-safe-scroll"
      data-page-bounce=""
      data-ai-docked={docked ? '' : undefined}
      data-ai-open={columnOpen ? '' : undefined}
      data-ai-drawer={phone ? level : undefined}
      data-ai-preview={detailHere ? layout : undefined}
      data-frame-list={frame ? '' : undefined}
      style={{ position: 'relative' }}
    >
      {phone ? (
        <AiDrawer
          level={level}
          onLevel={setLevel}
          list={listContent}
          pane={<MainPane botId={botId} active={visible} at={at} onBack={toList} />}
        />
      ) : listContent}

      {/* Main's left edge is the side panel's handle (30 Oct 2026): drag it,
          or use the arrow keys, to share the window between the list and
          Main; a page opened in Main's place keeps the width. The aside stays
          mounted while docked, because it opens a thread from `at`; app.css
          hides it while nothing is open beside the lists (#6425). */}
      {docked ? (
        <aside
          id="ai-main-pane"
          ref={mainRef}
          className="ai-main-pane"
          aria-labelledby={threadUp ? undefined : 'ai-main-title'}
          data-ai-main=""
          data-ai-column={columnOpen ? (threadUp ? 'thread' : 'main') : undefined}
        >
          <SidePanelDivider
            panelRef={mainRef}
            shown={columnOpen}
            id="ai-main-divider"
            controls="ai-main-pane"
            widthKey={threeUp ? AI_PREVIEW_COLUMN_WIDTH_KEY : AI_MAIN_WIDTH_KEY}
            probe={threeUp ? threadProbe : undefined}
            watch={threeUp ? previewRef : undefined}
          />
          {/* Main Chat's name over it. 1 Nov 2026: a thread in its place is
              alone under its own (ReplyThreadPanel `inMain`), with no bar of
              Main Chat's over it. 6 Nov 2026: Main Chat closes with its own
              ×, leaving the lists alone (#6425). */}
          {frame ? (threadUp ? null : (
            // The open item's head, as the kit draws it: who it is, one line
            // about it, and the way to close it.
            <header className="fr" data-ai-main-head="">
              <div className={kit('dhead')}>
                <KitTile name={t('messages:store.header.main')} src={BOT_AVATAR} />
                <div className={kit('tx')}>
                  <div className={kit('t')} id="ai-main-title">{t('messages:store.header.main')}</div>
                  <div className={kit('s')}>{t('messages:ai.main.sub')}</div>
                </div>
                <button type="button" className={kit('ib')} data-ai-main-close="" aria-label={t('messages:ai.main.close')} onClick={closeColumn}>
                  <KitIcon name="x" size={18} />
                </button>
              </div>
            </header>
          )) : (
            <>
          {threadUp ? null : (
            <header className="ai-main-head" data-ai-main-head="">
              <img src={BOT_AVATAR} alt="" className="w-8 h-8 rounded-[10px] object-cover shrink-0" />
              <span className="min-w-0 flex flex-col">
                <span id="ai-main-title" className="truncate text-[0.9375rem] font-[650] leading-5 text-zinc-900 dark:text-zinc-100">
                  {t('messages:store.header.main')}
                </span>
                <span className="flex min-w-0 items-center gap-1 text-[13px] leading-[18px] text-zinc-500 dark:text-zinc-400">
                  <LockIcon className="h-3 w-3 shrink-0" aria-hidden="true" />
                  <span className="truncate">{t('messages:ai.main.sub')}</span>
                </span>
              </span>
              <button
                type="button"
                className="messages-thread-action ms-auto"
                data-ai-main-close=""
                aria-label={t('messages:ai.main.close')}
                title={t('messages:ai.main.close')}
                onClick={closeColumn}
              >
                <XIcon className="w-4 h-4" aria-hidden="true" />
              </button>
            </header>
          )}
            </>
          )}
          {conversationUp ? <EmbeddedConversation conversationId={botId!} active={visible && columnOpen} at={at} mainChat /> : null}
        </aside>
      ) : null}

      {/* THE DETAIL COLUMN (./detail.ts, #6230): what the thread opened to
          read beside it — a design's preview, a plan, or a change's before
          and after. Three side by side, halves, or the whole screen. */}
      {detailHere && detail ? (
        <aside
          ref={previewRef}
          id="ai-preview-pane"
          className="ai-preview-pane"
          data-ai-preview-pane={layout}
          aria-label={detail.kind === 'draft' ? t('messages:draft.pane.label') : t('messages:design.pane.label')}
        >
          {/* The thread | preview edge, a handle too (#6359): it sets the
              preview's own width, and the list takes what is left. */}
          {layout === 'full' ? null : (
            <SidePanelDivider
              panelRef={previewRef}
              shown={columnOpen}
              id="ai-preview-divider"
              controls="ai-preview-pane"
              widthKey={AI_PREVIEW_WIDTH_KEY}
              probe={previewProbe}
            />
          )}
          <DetailPane layout={layout} />
        </aside>
      ) : null}
    </main>
  );
}
