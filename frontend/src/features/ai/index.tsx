/**
 * #ai-screen — the AI tab's main view (#6019 follow-up; plan v3, "the
 * Homeroom bot tab: what needs you comes first, then your private threads,
 * with a lock on the tile, then Up next: what's moving without you, soonest
 * first"). Needs you here is only the threads you are in; Communities ›
 * Needs you has every decision you owe.
 *
 * 29 Oct 2026 (Evan): the first list is Needs you, since it holds other
 * people's threads too, and only what waits on you; In progress is what is
 * being worked on; what waits on someone else (other people's votes, a free
 * builder or slot) is Waiting. 30 Oct 2026, from his Task Assistant
 * prototype: one line a row, grouped by project, on three sheets, with a
 * chip for each project (./lists.tsx draws them):
 *
 *   [bot] Homeroom bot                        ( 🔍 ) ( + New chat )
 *         Needs you: 2 · In progress: 1
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
 *   ( Ask Homeroom bot )                  ← a phone: a new chat
 *
 * THE LIST AND ONE THREAD (1 Nov 2026; 6 Nov 2026, request #6425; 14 Nov
 * 2026: no Main Chat). Every conversation with the bot is a thread, and this
 * page is the only place one is drawn: every way into the chat lands here
 * (./door.ts), never on the Messages screen. From 768px the page opens on
 * its lists alone, and the column beside them holds one thing at a time: a
 * private thread alone under its own head (its name and "Only you can see
 * this thread"; ReplyThreadPanel `alone`), a new chat, or a page. The row of
 * whichever it is is drawn lit. Everything in the column closes with a × (a
 * thread's own, the new chat's, the side panel's for a page), and closing
 * leaves the lists alone. On a phone the list and the column are one drawer,
 * as Messages' list and a conversation are (./phone-drawer.tsx): a row, New
 * chat or the Ask bar slides it in, and a thread's back arrow slides the
 * list back.
 *
 * NEW CHAT (14 Nov 2026) is the head's labelled button, and on a phone the
 * Ask bar too. It opens "What do you want to do?"
 * (../messages/new-thread.tsx) with its project already set: the one project
 * chip picked on this page, else the project page the person last left
 * (../workshop/community-scope.ts), else Any project. A page open in the
 * column (a request, a change, a decision) is carried into the new chat's
 * box as its attached item, with that item's project. Nothing is saved
 * until the first message is sent, which makes the thread.
 *
 * THE CHAT IS MOUNTED THREADS ONLY (../messages EmbeddedConversation
 * `threadsOnly`): the conversation's own stream is never read, drawn or
 * marked read. A thread marks itself read when it is drawn, and its row here
 * carries its own new mark.
 *
 * A REQUEST, A CHANGE OR A DECISION OPENS HERE TOO. On a wide window in the
 * column beside the list: the side panel, drawn as this page's own column
 * (the page's own name over it and a ×, no Expand, no Back;
 * ../side-panel/side-panel.tsx). Anywhere else on its page, whose back chip
 * says ‹ Homeroom bot and comes back here, with the project's Workshop
 * beside it (Improve.enterTopicFrom), and the tab bar keeps Homeroom bot lit
 * (App._isBotTopic). The phone's drawer holds only threads (Evan, 30 Oct:
 * "the Messages approach").
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

import { MicrophoneIcon, SearchIcon } from '@/components/ui/icons';

import { RichMessage, useMessages } from '../../lib/i18n/react';
import { KEPT_DRAW_MS, keepCopy, keptCopy } from '../../lib/kept-copies';
import { FRESH } from '../../lib/live-reads';
import { useStoreState } from '../../lib/use-store-state';
import { useVisibility, useVisibilityHiddenClass } from '../../lib/visibility-store';
import { EmbeddedConversation } from '../messages';
import { closeNewThread, startNewThread, useNewThread, type NewThreadPreset } from '../messages/new-thread';
import { noteThreadNames } from '../messages/private-thread-bar';
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
import { columnAddress, columnKey, pageProject, routeOf, type Column, type ColumnDetail } from './column';
import {
  BOT_TAB, botDetailAt, botItemFromRoute, botItemRoute, botNewAddress, botTabAddress, botTabAt, knownBotConversation, noteBotConversation, useBotTabAsk,
  type BotAt, type BotItem,
} from './door';
// The old Main Chat addresses, and a message named without its thread: the
// router hands them to this module's doors (window.UsernodeReact.ai.openOld).
import './where';
import { useLiveLists } from './live';
import { AiLists } from './lists';
import { AiFrameList } from './frame-list';
import { showsPicked } from './lines';
import { isFrameSkin, useSkin } from '../../lib/skin';
import { historyAsked, isBotTabHash, kindOf, projectsOf, withFilter, type HistoryKind } from './filter-address';
import { useHistory, type HistoryRow } from './history';
import { cleanQuery, useBotSearch } from './search';
import { clearSearchMark, currentSearchMark } from './search-mark';
import { communityScopeStore } from '../workshop/community-scope';
import { NewChatButton } from './new-chat-button';
import { AiDrawer, ThreadPane, usePhone } from './phone-drawer';
import { closeDetail, detailEntry, detailLayout, holdDetail, openDetail, reopenDetail, setDetailOwner, takeHeldDetail, useDetail, THREE_COLUMNS } from './detail';
import { DetailPane } from '../detail/detail-pane';
import {
  applyWorkState, freshCount, heroWords, inProgress, isTopicHref, liveThisWeek, movedSince, needsYou, owedCount, rankProjects,
  standingsOf, upNext, type AiApp, type AiThread, type AiWork, type NeedItem, type WorkRow,
} from './model';
import type { WorkStatePush } from '../../lib/work-state';

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
 * What a row opens, as the item a new chat's box can carry (the ◆ chip a
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
 * window in the column beside the list (the side panel, drawn as this
 * page's column: the page's name over it and a ×); anywhere else, and
 * whenever the panel does not take it, its page, which goes back here.
 */
function openPublic(href: string | null, app: AiApp | null, label: string | null): boolean {
  if (!href) return false;
  try {
    if (sidePanel()?.take?.(href.replace(/^#/, ''), { place: app, label })) return true;
  } catch {
    /* the page instead */
  }
  if (isTopicHref(href)) improve()?.enterTopicFrom?.(BOT_PAGE);
  go(href);
  return false;
}

/** Pure: the item a page's route is, for a new chat's box, when no row named it (a reload). */
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
  // A phone: the list and the column are one drawer (./phone-drawer.tsx); level 1 is the thread or the new chat.
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

  // The threads the server names by what they are ("Earlier chat", a
  // project's first version): kept for the open thread's head, which must
  // say what its row says (../messages/private-thread-bar.tsx).
  useEffect(() => { noteThreadNames(work?.private); }, [work]);

  // Which chat is the bot's, asked once: a thread or a new chat opens in it.
  // The list of conversations is read here too, for the tab's badge.
  useEffect(() => {
    if (!visible || !(wide || phone) || botId || typeof window === 'undefined' || !(window as any).App?.user) return;
    void loadConversations();
    void openBotConversation().then((id) => {
      if (!id) return;
      noteBotConversation(id);
      setBotId(id);
    }).catch(() => {
      // Offline: the chat this device already knows, from Messages' list or
      // the copy of it kept here, so a thread can still be asked for.
      const known = knownBotConversation()
        || keptConversations()?.find((item) => item.homeroomBot && item.kind !== 'channel')?.id
        || null;
      if (!known) return;
      noteBotConversation(known);
      setBotId(known);
    });
  }, [visible, wide, phone, botId, session]);

  // What the column shows (1 Nov 2026): a thread, a new chat, or a page the
  // side panel holds there. Read after mount: the first render is the
  // prerender's.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const snap = useMessagesSnapshot();
  const blank = useNewThread(botId);
  const panel = useStoreState(sidePanelStore);
  const docked = wide && !!botId;
  const inChat = !!botId && snap.route.embedded && snap.route.conversationId === botId;
  const openRoot = inChat ? snap.route.threadRootId : null;
  const threadUp = !!openRoot || blank;
  // THE COLUMN (./column.ts, 3 Nov 2026): the one answer to what is open
  // beside the list. The lit row and the address read it; nothing else keeps
  // a copy. 6 Nov 2026 (#6425): on a desktop the lists start alone, and the
  // column opens only when a row, New chat or an address asks for it.
  const panelRoute = panel.open ? routeOf(panel.route) : null;
  const column: Column = !mounted || !botId ? null
    : phone ? (level === 1 ? (openRoot ? { at: 'thread', rootId: openRoot } : blank ? { at: 'new' } : null) : null)
    : !docked ? null
    : panelRoute ? { at: 'page', route: panelRoute }
    : blank ? { at: 'new' }
    : openRoot ? { at: 'thread', rootId: openRoot } : null;
  // Whether anything is open beside the lists: the room the column takes,
  // its divider, the aside's visibility and the list's padding all follow it.
  const columnOpen = docked && !!column;
  // THE CHAT IS MOUNTED ONLY WHEN IT CAN BE SEEN OR ASKED FOR (#6425), and
  // threads only: nothing of the conversation's own stream is read. A thread
  // asked for by a row or an address is not in the store yet, so `at` mounts
  // the conversation that opens it.
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
  // THE COLUMN BELONGS TO ITS THREAD (20 Nov 2026). What opens beside the
  // thread on screen is that thread's (./detail.ts setDetailOwner); another
  // thread's is never drawn here. Leaving the thread holds it, and coming
  // back shows it again (below).
  const ownedHere = !detail?.owner || detail.owner === shown;
  const detailHere = !!detail && !!botId && ownedHere && (detail.kind === 'design'
    ? detail.ref.conversationId === botId && openRoot === detail.ref.rootId
      && (phone ? level === 1 : docked && !panel.open)
    : detail.kind === 'draft'
    // #6248: a request draft is read beside the thread it was said in.
    ? detail.ref.conversationId === botId && !!openRoot && openRoot === detail.ref.rootId
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
  // The thread or page on screen claims what opens beside it, while this
  // page is the one shown (the AI screen stays mounted behind every other).
  useEffect(() => {
    setDetailOwner(visible && shown && shown !== 'new' ? shown : null);
  }, [visible, shown]);
  // Another thread opened: the one left holds what it showed, and the one
  // arrived at shows what it held, if anything.
  const ownerWas = useRef<string | null>(null);
  useEffect(() => {
    if (!visible) return;
    const was = ownerWas.current;
    ownerWas.current = shown;
    if (was === shown) return;
    if (was) holdDetail(was);
    const back = takeHeldDetail(shown);
    if (back) reopenDetail(back);
  }, [visible, shown]);
  // Put the column's detail away with its thread, to show again when the
  // thread is opened again; one that belongs to no thread just closes.
  const putAway = () => {
    const entry = detailEntry();
    if (entry?.owner) holdDetail(entry.owner);
    else closeDetail();
  };
  // The column shows another thread: its detail goes — unless it was opened
  // from that very page (the forwarded plan on a request).
  // Only while this page is the one on screen: the AI screen stays mounted
  // (hidden) behind every other page, and its rule must not close a plan
  // opened beside a request's own page or in the Workshop.
  useEffect(() => {
    if (!visible || !botId || !detail || detailEntry() !== detail) return;
    // A thread's own detail is held for it, not closed (above). A running
    // preview with nowhere to stand is held too: its frame is placed over
    // the column, which is not drawn.
    if (detail.owner) {
      if (detail.owner !== shown || (detail.kind === 'preview' && !detailHere)) holdDetail(detail.owner);
      return;
    }
    if (detail.kind === 'design' && openRoot && openRoot !== detail.ref.rootId) closeDetail();
    if (detail.kind === 'draft' && openRoot && openRoot !== detail.ref.rootId) closeDetail();
    if (detail.kind !== 'design' && detail.kind !== 'draft' && !detailHere) closeDetail();
  }, [visible, botId, detail, openRoot, detailHere, shown]);
  // The tab pressed (the page's own address, from a thread's): the list
  // comes back, and the detail is put away with its thread, to show again
  // when the thread is opened again.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const back = () => {
      if (window.location.hash !== BOT_TAB) return;
      const entry = detailEntry();
      if (entry?.owner) holdDetail(entry.owner);
      else closeDetail();
    };
    window.addEventListener('hashchange', back);
    return () => window.removeEventListener('hashchange', back);
  }, []);

  // #6159: a thread marked done from its row's ⋯ leaves at once; the next
  // read of the lists confirms it.
  const [doneRoots, setDoneRoots] = useState<ReadonlySet<number>>(() => new Set());
  // #6262: opening a thread clears its dot at once, before the next read of
  // the lists says so. The server keeps the cursor (POST threads/read), so
  // the next read agrees. 14 Nov 2026: a private thread's row carries its
  // own new mark (there is no Main Chat to count it), cleared the same way,
  // by its first message; the thread marks itself read when it is drawn
  // (../messages/store.ts loadReplyThread), so nothing is posted for it here.
  const [seenThreads, setSeenThreads] = useState<ReadonlySet<number>>(() => new Set());
  const [seenRoots, setSeenRoots] = useState<ReadonlySet<number>>(() => new Set());
  const markThreadRead = (threadId: number | null | undefined, app: AiApp | null, rootId?: number | null): void => {
    if (rootId) setSeenRoots((had) => (had.has(rootId) ? had : new Set([...had, rootId])));
    if (!threadId) return;
    setSeenThreads((had) => (had.has(threadId) ? had : new Set([...had, threadId])));
    // #6604: only a PRIVATE thread is marked read from here. A request's or
    // a change's page marks its own thread when its group chat mounts
    // (group-chat.js _noteThreadRead), so posting from both sent the same
    // read twice on every open.
    if (!rootId) return;
    if (!app?.slug || typeof window === 'undefined') return;
    void fetch(`/api/apps/${encodeURIComponent(app.slug)}/threads/read${demoQuery()}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ thread_id: threadId }),
    }).then((res) => (res.ok ? res.text() : null)).catch(() => { /* the next open reads it again */ });
  };
  // A private thread's mark is held off only until the lists are read again:
  // by then the server has its read (the thread marked itself read when it
  // was drawn), and a reply that lands later is new again. The thread open
  // now stays cleared.
  useEffect(() => {
    setSeenRoots((had) => {
      const keep = openRoot && had.has(openRoot) ? [openRoot] : [];
      return had.size === keep.length ? had : new Set(keep);
    });
  }, [work]); // eslint-disable-line react-hooks/exhaustive-deps
  const cleared = <T extends { threadId?: number | null; rootId?: number | null; unread?: number }>(row: T): T => (
    (row.threadId && seenThreads.has(row.threadId)) || (!row.threadId && row.rootId && seenRoots.has(row.rootId)) ? { ...row, unread: 0 } : row
  );
  const allRows = useMemo(
    () => needsYou(needs, work).map(cleared),
    [needs, work, seenThreads, seenRoots], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const rows = useMemo(() => allRows.filter((row) => !row.rootId || !doneRoots.has(row.rootId)), [allRows, doneRoots]);
  const progress = useMemo(() => inProgress(needs, work).map(cleared), [needs, work, seenThreads, seenRoots]); // eslint-disable-line react-hooks/exhaustive-deps
  const waiting = useMemo(() => upNext(needs, work).map(cleared), [needs, work, seenThreads, seenRoots]); // eslint-disable-line react-hooks/exhaustive-deps
  const live: AiThread[] = useMemo(() => liveThisWeek(work).map(cleared), [work, seenThreads, seenRoots]); // eslint-disable-line react-hooks/exhaustive-deps
  const owed = owedCount(rows);
  const projects = useMemo(
    () => new Set(rankProjects(rows, progress, waiting, live).map((p) => p.app.slug)),
    [rows, progress, waiting, live],
  );
  // A work_state push is drawn at once where the lists hold its item
  // (./model.ts applyWorkState); the read after it puts the row in its list.
  const applyPush = useCallback((push: WorkStatePush) => {
    setWork((now) => applyWorkState(now, null, push).work);
    setNeeds((now) => applyWorkState(null, now, push).needs);
  }, []);
  // #6595: a request or a change open in the column is a page of its own
  // project, so an update about that project re-reads the lists beside it
  // even when nothing of it was listed. Never by App.currentApp: on this
  // page that is null.
  const shownProjects = useMemo(() => {
    const slug = column?.at === 'page' ? pageProject(column.route) : null;
    return slug && !projects.has(slug) ? new Set([...projects, slug]) : projects;
  }, [projects, column]);
  useLiveLists(() => setMoved((n) => n + 1), visible, { projects: shownProjects, botId }, applyPush);
  // HISTORY (./history.ts): read on each showing, and again when the
  // projects picked or its kind change.
  const [showings, setShowings] = useState(0);
  useEffect(() => { if (visible) setShowings((n) => n + 1); }, [visible, session]);
  // 18 Nov 2026 (PR 6792): In progress and Waiting as this showing of the
  // page first had them, so a row that moves while the page is up is never
  // folded behind Show more (./model.ts movedSince, groupRows). Taken again
  // on every showing: what moved while the page was hidden is lifted when it
  // is seen, and nothing stays lifted from one showing to the next.
  const [seen, setSeen] = useState<{ showing: number; at: Map<number, string> } | null>(null);
  useEffect(() => {
    if (!visible || !work || !needs) return;
    setSeen((had) => (had && had.showing === showings ? had : { showing: showings, at: standingsOf([...progress, ...waiting]) }));
  }, [visible, showings, work, needs]); // eslint-disable-line react-hooks/exhaustive-deps
  const seenAt = seen && seen.showing === showings ? seen.at : null;
  const progressDrawn = useMemo(() => movedSince(seenAt, progress), [seenAt, progress]);
  const waitingDrawn = useMemo(() => movedSince(seenAt, waiting), [seenAt, waiting]);
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

  // A thread of the chat, in the column, at a message of it when one is
  // named: a page the panel holds there gives the column back, and another
  // thread or a new chat open there gives way. On a phone the drawer slides
  // to it. A place with no thread is nothing to show (an old Main Chat
  // address is resolved to a thread first, ./where.ts).
  // The item a row opened, for a new chat's box.
  const opened = useRef<{ route: string; about: AboutItem | null } | null>(null);
  const showAt = (next: BotAt) => {
    if (!next.threadRootId) return;
    sidePanel()?.close?.();
    closeNewThread();
    if (!detail || detail.kind === 'design') {
      if (next.threadRootId !== detail?.ref.rootId) putAway();
    }
    setAt({ ...next });
    // A thread asked for goes into the store here, not only through the chat
    // mounted below: with the column closed that chat is not drawn yet, and
    // the column reads the thread from the store (#6425).
    if (botId) embed(botId, next, { threadsOnly: true });
    if (phone) setLevel(1);
  };
  // CLOSING THE COLUMN (6 Nov 2026, #6425): the tab pressed while something
  // is open. Everything opened beside the lists goes; a page opened over a
  // private thread is the side panel's own × instead, which leaves that
  // thread under it. On a phone the list slides back (14 Nov 2026: its
  // second level has no bar of its own to go back by while a thread asked
  // for is still on its way).
  const closeColumn = () => {
    if (phone) { setLevel(0); setAt(null); return; }
    if (!docked) return;
    sidePanel()?.close?.();
    closeNewThread();
    if (openRoot) closeThread();
    putAway();
    setAt(null);
  };
  // The router's ask (./door.ts): `/thread/<id>`, with a message in it, from
  // any door into the chat; a bare `#homeroom-bot` closes what is open. Each
  // once, once the page knows whether it is a phone's.
  //
  // A THREAD'S ASK WAITS FOR THE CHAT IT IS IN. On a cold load (a refresh on
  // `#homeroom-bot/thread/<id>`, that address in a new tab, the first visit
  // from a bell row) the page knows its width before it knows which chat is
  // the bot's. Taken then, `showAt` could not put the thread in the store,
  // and since #6425 nothing else does: the chat is mounted but not active
  // until the column is open, and the column needs the store's thread. So
  // the address named a thread over the lists alone. A page needs no chat
  // id, and is taken at once; so is a phone's thread, whose drawer slides in
  // first and whose pane embeds the thread when the chat is known
  // (./phone-drawer.tsx ThreadPane).
  const ask = useBotTabAsk();
  const askTaken = useRef(0);
  useEffect(() => {
    if (!ask || ask.seq === askTaken.current || !visible || !(wide || phone)) return;
    if (ask.at?.threadRootId && !botId && !phone) return;
    askTaken.current = ask.seq;
    if (ask.close) closeColumn();
    else if (ask.item) openItem(ask.item);
    else if (ask.at) showAt(ask.at);
  }, [ask, visible, wide, phone, botId]); // eslint-disable-line react-hooks/exhaustive-deps
  // A reload or a copied link reopens the detail the address names (#6230).
  // Declared after the ask above on purpose: both run in the commit that
  // learns the bot's chat, and a thread's ask closes any detail that is not
  // its own, so a design named by `/thread/<id>/design/<v>` is opened after
  // its thread, not before it.
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
  // 10 Nov 2026: `#homeroom-bot/new…` is New chat pressed for you, with the
  // project and who works on it already set when the address names them
  // (./door.ts botNewAt); one that names no project takes the page's own
  // (newChatPreset). It opens in the bot's chat, so it has a count of its own
  // to wait on until the page knows which chat that is.
  const freshTaken = useRef(0);
  useEffect(() => {
    if (!ask?.fresh || ask.seq === freshTaken.current || !visible || !(wide || phone) || !botId) return;
    freshTaken.current = ask.seq;
    const named = ask.fresh;
    const own = named.project ? null : newChatPreset();
    openBlank();
    startNewThread(botId, own ? { ...own, builder: named.builder } : named);
  }, [ask, visible, wide, phone, botId]); // eslint-disable-line react-hooks/exhaustive-deps

  // A page the panel took is in the column, and closing it gives the lists
  // back (6 Nov 2026, #6425). The address is the column's (below).
  const underPanel = () => {
    closeNewThread();
    if (openRoot) closeThread();
  };
  // A private thread is the column's, alone.
  const openPrivate = (rootId: number) => {
    const next = { threadRootId: rootId, focusMessageId: null };
    if (!(wide || phone)) { go(botTabAddress(next)); return; }
    showAt(next);
  };
  // A request, a change or a decision: its page, in the column on a wide
  // window, its own page anywhere else. Every row goes to its own place
  // (#6210): a ▷ plan row to its request's page, where its plan and Build
  // it are, the same place a Vote or Needs Reply row for it opens.
  const openPage = (href: string | null, app: AiApp | null, title: string | null, about: AboutItem | null) => {
    const route = routeOf(href);
    opened.current = route ? { route, about } : null;
    if (openPublic(href, app, title)) underPanel();
  };
  const openRow = (row: WorkRow) => {
    markThreadRead(row.threadId, row.app, row.rootId);
    if (row.rootId) {
      openPrivate(row.rootId);
      return;
    }
    openPage(row.href, row.app, row.title, aboutRow(row));
  };
  const openThread = (th: AiThread) => {
    markThreadRead(th.threadId, th.app, th.rootId);
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
    opened.current = { route, about: null };
    if (wide) {
      try {
        if (sidePanel()?.take?.(route, { place: appFromLists(item.slug), label: null })) { underPanel(); return; }
      } catch { /* the page instead */ }
    }
    improve()?.enterTopicFrom?.(BOT_PAGE);
    window.location.replace(`#${route}`);
  }
  // THE ADDRESS IS THE COLUMN'S (#6215): a thread, or the item in it, so a
  // reload reopens it; a phone's list, a new chat and any other page are the
  // tab itself. Written in place: a row is no step for Back. Not on
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
  // A page the side panel takes is the column's: no design preview beside it.
  useEffect(() => { if (panel.open && detail?.kind === 'design') putAway(); }, [panel.open, detail]); // eslint-disable-line react-hooks/exhaustive-deps
  // On a phone the column slides back to the list; the address is the page's.
  const toList = () => {
    setLevel(0);
  };
  const toListRef = useRef(toList);
  toListRef.current = toList;
  // A PHONE'S SECOND LEVEL IS A THREAD OR A NEW CHAT, NEVER EMPTY (14 Nov
  // 2026): once neither is open there, and none is on its way (`at`, a thread
  // asked for before the chat is known), the list slides back. A thread or a
  // new chat closed with its own × lands here.
  useEffect(() => {
    if (phone && level === 1 && !threadUp && !at?.threadRootId) setLevel(0);
  }, [phone, level, threadUp, at]);

  // NEW CHAT (#6071 follow-up; 14 Nov 2026): a new chat with the bot, in the
  // column (../messages/new-thread.tsx), slid in on a phone.
  const openBlank = () => {
    sidePanel()?.close?.();
    putAway();
    if (phone) setLevel(1);
  };
  // What a new chat opens set to. The page a row opened in the column (a
  // request, a change, a decision) is carried into its box as the attached
  // item, with that item's project, so what the person was looking at is not
  // lost. Otherwise the project is the one chip picked here, else the
  // project page they last left (the Communities tab's own memory of it,
  // ../workshop/community-scope.ts; none once they have gone back to every
  // community), else Any project.
  function newChatPreset(): NewThreadPreset {
    const route = column?.at === 'page' ? column.route : null;
    const about = route ? (opened.current?.route === route ? opened.current.about : null) || aboutRoute(route) : null;
    if (about) return { project: about.appSlug, builder: 'homeroom', object: about };
    const project = picked.length === 1 ? picked[0] : communityScopeStore.get().slug || null;
    return { project, builder: 'homeroom' };
  }
  // The head's New chat, the Ask bar and the frame list's plus. Where the
  // column is not drawn (a window between a phone's and a desktop's that has
  // neither), the address asks for it.
  const openNewChat = () => {
    const preset = newChatPreset();
    if (!botId || !(wide || phone)) { go(botNewAddress({ project: preset.project })); return; }
    openBlank();
    startNewThread(botId, preset);
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
  // 13 Nov 2026: the box also searches what was said, in the person's own
  // threads with the bot, on the server (./search.ts). Asked
  // only once something is typed, so the first render has none of it.
  const search = useBotSearch(searchOpen ? query : '', {
    signedIn: mounted && typeof window !== 'undefined' && !!(window as any).App?.user,
    demo: !!demoQuery(),
  });
  // 17 Nov 2026 (./search-mark.ts): the words a found result opened stay
  // marked in its message while it is read. Clearing the box, closing the
  // search or typing something else takes the marks with it; the box is not
  // in the address, so nothing else is left for a reload to find.
  const marked = cleanQuery(searchOpen ? query : '');
  useEffect(() => {
    const mark = currentSearchMark();
    if (mark && mark.q !== marked) clearSearchMark();
  }, [marked]);

  // #6744: the line under the bot's name summarises the lists below it, so it
  // counts only the projects the chips show, as the "Needs you" heading and
  // every list do. Search does not narrow it (./lines.ts owedShown does), so it
  // does not jump while you type; each chip keeps its own project's count.
  const heroShows = showsPicked(picked);
  const heroRows = rows.filter((row) => heroShows(row.app));
  const heroLine = work
    ? heroWords(owedCount(heroRows), progress.filter((th) => heroShows(th.app)).length, freshCount(heroRows))
    : null;
  // A look of the one frame draws the list with the kit (./frame-list.tsx),
  // from the same rows and presses. Read after mount (lib/skin.ts says why).
  const frame = isFrameSkin(useSkin());
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
        {/* Search, then New chat: the head's one labelled, filled button. */}
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
        <NewChatButton onOpen={openNewChat} />
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
          query={searchOpen ? query : ''}
          onQuery={setQuery}
          searchOpen={searchOpen}
          onSearch={setSearchOpen}
          searchRef={searchRef}
          found={search.found}
          onFoundRetry={search.retry}
          lit={lit}
          ready={!!work && !!needs}
          failed={failed}
          onRetry={() => setMoved((n) => n + 1)}
          rows={rows}
          owed={owed}
          progress={progressDrawn}
          waiting={waitingDrawn}
          live={live}
          openRow={openRow}
          openThread={openThread}
          onDone={(rootId) => { setDoneRoots((had) => new Set([...had, rootId])); setMoved((n) => n + 1); }}
          picked={picked}
          onPick={pick}
          appFor={appFor}
          onNew={openNewChat}
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
          query={searchOpen ? query : ''}
          found={search.found}
          onFoundRetry={search.retry}
          lit={lit}
          ready={!!work && !!needs}
          failed={failed}
          onRetry={() => setMoved((n) => n + 1)}
          rows={rows}
          owed={owed}
          progress={progressDrawn}
          waiting={waitingDrawn}
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

      {/* Ask Homeroom bot: a new chat, as the head's New chat opens. A bar
          over the tab bar; on a desktop the column is docked beside the list
          and this is not drawn. */}
      <div className="ai-askbar messages-composer" data-ai-askbar="">
        <a
          href={botNewAddress(null)}
          className="messages-composer-card ai-askbar-card"
          aria-label={t('messages:ai.ask.label')}
          // On a phone's drawer the new chat slides in beside the list: in, not away.
          onClick={(e) => { if (phone) { e.preventDefault(); openNewChat(); } }}
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
          canOpen={threadUp}
          pane={<ThreadPane botId={botId} active={visible} at={at} onBack={toList} />}
        />
      ) : listContent}

      {/* The column's left edge is the side panel's handle (30 Oct 2026):
          drag it, or use the arrow keys, to share the window between the list
          and the column; a page opened there keeps the width. The aside
          stays mounted while docked, because it opens a thread from `at`;
          app.css hides it while nothing is open beside the lists (#6425). */}
      {docked ? (
        <aside
          id="ai-main-pane"
          ref={mainRef}
          className="ai-main-pane"
          data-ai-main=""
          data-ai-column={columnOpen && threadUp ? (blank ? 'new' : 'thread') : undefined}
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
          {/* A thread is alone under its own head (ReplyThreadPanel `alone`),
              and a new chat under its own: the column draws no bar over them. */}
          {conversationUp ? <EmbeddedConversation conversationId={botId!} active={visible && columnOpen} at={at} threadsOnly /> : null}
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
          aria-label={detail.kind === 'draft' ? t('messages:draft.pane.label') : t('messages:design.pane.labelOpening')}
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
          <DetailPane layout={layout} card />
        </aside>
      ) : null}
    </main>
  );
}
