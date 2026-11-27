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
 * (./door.ts), never on the Messages screen. From 768px the page is its
 * lists and, beside them, a column that holds one thing at a time: a
 * private thread alone under its own head (its name and "Only you can see
 * this thread"; ReplyThreadPanel `alone`), a new chat, or a page. The row of
 * whichever it is is drawn lit. A thread and a page close with a × (the
 * thread's own, the side panel's for a page), and since #7039 (23 Nov 2026,
 * THE COLUMN IS NEVER EMPTY BESIDE THE LISTS, below) closing one lands on a
 * new chat, the column's resting state: that new chat has no × of its own
 * (../messages/new-thread.tsx NewThreadDocked), and opening a thread is how
 * it is left. On a phone the list and the column are one drawer,
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

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { ArrowUpIcon, MicrophoneIcon, PlusIcon, SearchIcon, XIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { KEPT_DRAW_MS, keepCopy, keptCopy } from '../../lib/kept-copies';
import { FRESH } from '../../lib/live-reads';
import { useStoreState } from '../../lib/use-store-state';
import { useVisibility, useVisibilityHiddenClass } from '../../lib/visibility-store';
import { EmbeddedConversation } from '../messages';
import { LiveStartBeside, NewThreadDocked, closeNewThread, liveOpeningStore, liveStartStore, newThreadIn, startNewThread, useNewThread, type NewThreadPreset } from '../messages/new-thread';
import { LiveStartPane } from '../messages/live-start-pane';
import { noteThreadNames } from '../messages/private-thread-bar';
import { keptConversations, openBotConversation } from '../messages/api';
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
import { listLayout, setDocked, setListClosed, useListClosed } from './list-closed';
import { columnAddress, columnKey, pageProject, routeOf, type Column, type ColumnDetail } from './column';
import {
  BOT_TAB, botDetailAt, botItemFromRoute, botItemRoute, botNewAddress, botTabAddress, botTabAt, knownBotConversation, noteBotConversation, useBotTabAsk,
  type BotAt, type BotItem,
} from './door';
// The old Main Chat addresses, and a message named without its thread: the
// router hands them to this module's doors (window.UsernodeReact.ai.openOld).
import { oldAddressPending } from './where';
import { useLiveLists } from './live';
import { AiLists } from './lists';
import { bareTab, historyAsked, isBotTabHash, kindOf, progressAddress, progressAsked, projectsOf, waitingAddress, waitingAsked, withFilter, type HistoryKind } from './filter-address';
import { useHistory, type HistoryRow } from './history';
import { cleanQuery, useBotSearch } from './search';
import { clearSearchMark, currentSearchMark } from './search-mark';
import { communityScopeStore } from '../workshop/community-scope';
import { NewChatButton } from './new-chat-button';
import { BOT_SEARCH_SHORTCUT_KEYS, installBotSearchShortcut } from './search-shortcut';
import { useSearchHint } from '../home/search-hint';
import { AiDrawer, PHONE_QUERY, ThreadPane } from './phone-drawer';
import { useNewChatBar } from './new-chat-bar';
import { claimDetail, closeDetail, detailEntry, detailLayout, holdDetail, openDetail, reopenDetail, setDetailOwner, takeHeldDetail, useDetail, THREE_COLUMNS } from './detail';
import { DetailPane } from '../detail/detail-pane';
import {
  applyWorkState, inProgress, isTopicHref, liveThisWeek, movedSince, needsYou, owedCount, rankProjects, standingsOf, upNext, withoutDismissed, type AiApp, type AiThread, type AiWork, type NeedItem, type WorkRow,
} from './model';
import type { WorkStatePush } from '../../lib/work-state';
import { noteOpened, useListVisit } from './use-visit';
import { openedHistory, openedNeed, openedThread, visitSeen, withOpened, type OpenedEntry } from './visit';

// 1 Nov 2026: the column is docked from 768px, where a phone's drawer ends.
const WIDE = '(min-width: 768px)';

/** The narrowest a design's or a plan's preview is in three columns
 *  (app.css, A DESIGN'S PREVIEW, A COLUMN OF ITS OWN). */
const PREVIEW_MIN_W = 360;
/** The list's floor beside a thread and a preview (app.css's 480px there). */
const THREE_LIST_MIN = 480;
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
/** How long the column says a live start's draft is opening before it gives the room back. */
const LIVE_OPENING_MS = 120_000;

export type ListsFailure = 'unreachable' | 'failed' | null;

/**
 * Phone review #11 (23 Nov 2026): the page's two layouts read as ONE answer.
 * A phone's width and a docked window's were two hooks, each with its own
 * listener, so turning a folded phone drew one render with both true: the
 * drawer's chat and the docked one both mounted, and the drawer's, leaving a
 * render later, closed the route they share (../messages/store.ts release).
 * The thread was gone and the address was the bare tab's. Both queries are
 * read together here, on either one's change, so the layouts swap in one render.
 */
function useWidths(): { phone: boolean; wide: boolean } {
  const [widths, setWidths] = useState({ phone: false, wide: false });
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const narrow = window.matchMedia(PHONE_QUERY);
    const docked = window.matchMedia(WIDE);
    const sync = () => setWidths((had) => (
      had.phone === narrow.matches && had.wide === docked.matches ? had : { phone: narrow.matches, wide: docked.matches }
    ));
    sync();
    narrow.addEventListener?.('change', sync);
    docked.addEventListener?.('change', sync);
    return () => {
      narrow.removeEventListener?.('change', sync);
      docked.removeEventListener?.('change', sync);
    };
  }, []);
  return widths;
}

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
 * The address says what the column shows, so a reload reopens it. Only while
 * the address is this page's.
 *
 * #7045: A ROW OPENED FROM THE LISTS IS A STEP BACK CAN UNDO. The address was
 * always replaced in place, so Back from a thread left the tab altogether
 * (on a phone, where the thread is the whole screen, that was the only Back
 * there is). Now the first thing opened from the bare tab is a new entry,
 * and closing it steps back onto the tab's own entry when that is the one
 * below (App._stepBackTo), so no second copy of the list is left behind.
 * One row to another, a filter, a detail: those still swap in place.
 */
let steppingBack = false;
function showAddress(href: string): void {
  if (typeof window === 'undefined' || !/^#(homeroom-bot|ai)(\/|\?|$)/.test(window.location.hash)) return;
  // An address from before is still being resolved (./where.ts): the bar is
  // the server's to rewrite until it says where the address lands, and the
  // column's resting place (the bare tab) must not take it away first.
  if (oldAddressPending()) return;
  // A step back is on its way (history.back() lands a task later): the
  // address is about to be the tab's, and a second write now would step
  // back twice, off the tab.
  if (steppingBack) return;
  if (window.location.hash === href) return;
  const bare = (hash: string) => /^#(homeroom-bot|ai)(\?|$)/.test(hash);
  const url = `${window.location.pathname}${window.location.search}${href}`;
  try {
    if (bare(window.location.hash) && !bare(href)) { history.pushState(history.state, '', url); return; }
    if (!bare(window.location.hash) && bare(href)) {
      const app = (window as { App?: { _stepBackTo?: (to: string) => boolean } }).App;
      if (app?._stepBackTo?.(href)) {
        steppingBack = true;
        const done = () => { steppingBack = false; };
        window.addEventListener('popstate', done, { once: true });
        window.setTimeout(done, 1500);
        return;
      }
    }
    history.replaceState(history.state, '', url);
  } catch { /* the column still shows it */ }
}

/** The side panel's controller (features/side-panel/), when the shell has one. */
function sidePanel(): {
  take?: (route: string, hint?: { place?: AiApp | null; label?: string | null } | null) => boolean;
  close?: () => void;
  /** Mobile 04: the page the panel took opens at this message of its thread. */
  revealMessage?: (slug: string, messageId: number) => void;
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
  // A phone: the list and the column are one drawer (./phone-drawer.tsx);
  // from 768px the column is docked. One reading of the two (useWidths).
  const { phone, wide } = useWidths();
  const [work, setWork] = useState<AiWork | null>(null);
  const [needs, setNeeds] = useState<NeedItem[] | null>(null);
  const [botId, setBotId] = useState<number | null>(null);
  const [at, setAt] = useState<{ threadRootId: number | null; focusMessageId: number | null } | null>(null);
  // On a phone, level 1 is the thread or the new chat.
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
  // WAITING ON YOU (24 Nov 2026): the list the head's Needs you count opens,
  // every thing that needs you in one card, with its own address
  // (`#homeroom-bot/waiting`, ./filter-address.ts). A row opened from it
  // keeps it; Back to the bare tab leaves it.
  const [waitingOpen, setWaitingOpen] = useState(false);
  const waitingWas = useRef(false);
  // IN PROGRESS (25 Nov 2026): the head's other count opens its own list,
  // Waiting on you's sibling, with its own address
  // (`#homeroom-bot/progress`). Only one of the two is open at a time.
  const [progressOpen, setProgressOpen] = useState(false);
  const progressWas = useRef(false);
  const historyRef = useRef<HTMLDivElement | null>(null);
  // THE SEARCH BOX DOES NOT OUTLIVE THE VISIT (phone review, 23 Nov 2026, #3
  // and S14). This screen stays mounted while another is shown, so what was
  // typed here an hour ago was still narrowing every list when You › Your
  // changes opened History: one row of 2,330, the box scrolled out of sight.
  // So the box is emptied when the tab is left, and when a door asks for
  // History (`#homeroom-bot/history`), which is asking for all of it.
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement | null>(null);
  const endSearch = useCallback(() => { setQuery(''); }, []);
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
    if (historyAsked(hash)) { setToHistory((n) => n + 1); endSearch(); }
    // Opening Waiting on you reads the lists again, so something finished
    // elsewhere (another screen, another device) is not still listed. Coming
    // back to it from a row reads them again too: the vote or answer may
    // have been saved on the page that row opened (#7103), and that row
    // must not linger.
    const askedWaiting = waitingAsked(hash);
    if (askedWaiting) {
      if (!waitingWas.current) setMoved((n) => n + 1);
      setWaitingOpen(true);
      setProgressOpen(false);
    } else if (bareTab(hash)) {
      setWaitingOpen(false);
    }
    waitingWas.current = askedWaiting;
    // In progress opens its own list the same way, reading the lists again
    // for the same reason (#7157).
    const askedProgress = progressAsked(hash);
    if (askedProgress) {
      if (!progressWas.current) setMoved((n) => n + 1);
      setProgressOpen(true);
      setWaitingOpen(false);
    } else if (bareTab(hash)) {
      setProgressOpen(false);
    }
    progressWas.current = askedProgress;
  };
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const take = () => takeFilter.current();
    take();
    window.addEventListener('hashchange', take);
    return () => window.removeEventListener('hashchange', take);
  }, []);
  useEffect(() => { if (visible) takeFilter.current(); else endSearch(); }, [visible, endSearch]);
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
  // The head's Needs you count opens Waiting on you, in its own address (a
  // link and a reload find it), and reads the lists again as it opens.
  const openWaiting = () => {
    waitingWas.current = true;
    setWaitingOpen(true);
    progressWas.current = false;
    setProgressOpen(false);
    setMoved((n) => n + 1);
    showAddress(waitingAddress(picked));
  };
  // All threads: back to the tab itself, the head and its three bands.
  const closeWaiting = () => {
    waitingWas.current = false;
    setWaitingOpen(false);
    showAddress(withFilter('#homeroom-bot', { projects: picked }));
  };
  // The head's In progress count opens its own list, the same way (#7157).
  const openProgress = () => {
    progressWas.current = true;
    setProgressOpen(true);
    waitingWas.current = false;
    setWaitingOpen(false);
    setMoved((n) => n + 1);
    showAddress(progressAddress(picked));
  };
  const closeProgress = () => {
    progressWas.current = false;
    setProgressOpen(false);
    showAddress(withFilter('#homeroom-bot', { projects: picked }));
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
  // What the window's width makes of a preview. The list put away turns
  // three columns into halves (below); nothing else changes it.
  const fits = detailLayout('bot', { phone, wide: three });
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
  // THE LIST HIDDEN (#6963): dragging the divider past the list's floor puts
  // the page in one pane, and the choice holds across threads and reloads
  // (./list-closed). AND BESIDE A PREVIEW (24 Nov 2026), wherever three
  // columns fit: the thread and the preview are left in halves, and the
  // thread's left edge is still the handle that brings the list back. One
  // choice, so opening or closing a preview leaves it as it is (listLayout).
  // THE PREVIEW'S COLUMN, WAITING (26 Nov 2026). Where three columns fit, a
  // new chat with Homeroom bot has the column a live preview runs in beside
  // it from the start (../messages/live-start-pane.tsx): Start live preview
  // for the project About names, or the projects to pick from. Narrower, the
  // new chat's head offers the same as a button (../messages/new-thread.tsx
  // START LIVE PREVIEW). `liveOpening` is the thread a live start just made:
  // the column stays, saying the draft is opening, until the draft's own
  // preview takes it (a detail of kind `preview`, above).
  const liveChat = useStoreState(liveStartStore);
  const liveOpening = useStoreState(liveOpeningStore);
  const roomForLive = !!botId && docked && !phone && fits === 'three' && !panel.open && !detailHere;
  const waitingNew = roomForLive && column?.at === 'new' && !!liveChat && liveChat.bot;
  const openingHere = roomForLive && column?.at === 'thread' && !!liveOpening && liveOpening.rootId === column.rootId;
  const waitingHere = waitingNew || openingHere;
  // What the layout calls a preview: the detail, or the column waiting for one.
  const previewHere = detailHere || waitingHere;
  useEffect(() => {
    if (!liveOpening) return undefined;
    // The draft is there, or the person opened something else: the column is no longer the start's.
    const elsewhere = column?.at === 'page' || (column?.at === 'thread' && column.rootId !== liveOpening.rootId);
    if (detailHere || elsewhere) { liveOpeningStore.set(null); return undefined; }
    // A draft that never comes (the bot declined, or failed) is not waited on for ever.
    const timer = setTimeout(() => liveOpeningStore.set(null), LIVE_OPENING_MS);
    return () => clearTimeout(timer);
  }, [liveOpening, detailHere, shown]); // eslint-disable-line react-hooks/exhaustive-deps
  const listClosed = useListClosed();
  const { snaps, oneUp, layout } = listLayout({ closed: listClosed, open: columnOpen, preview: previewHere, fits, phone });
  // With a preview beside the thread both edges are handles (#6359), each
  // the width of the column after it, the list taking what is left. In three
  // columns the thread's width runs to where the preview begins, and its
  // bound keeps the list's floor beside the preview as it is now drawn, the
  // same room app.css leaves it (`--ai-room` - 480px - `--ai-preview-w`), so
  // the handle stops where the column does; it is read again whenever the
  // preview's width changes (`watch` below). The preview's keeps the list's
  // floor and the thread's. In halves the list has stepped aside, so the
  // thread's edge is no handle and the preview's keeps only the thread's floor.
  // The list put away is not that: the thread's edge keeps the three
  // columns' width, bound and preview to watch, so pulling the list back
  // opens the thread where it was, measured as three columns.
  const threeFits = previewHere && fits === 'three';
  useEffect(() => {
    setDocked(docked && snaps && !phone);
  }, [docked, snaps, phone]);
  const pageInColumn = column?.at === 'page';
  const threadProbe = useCallback(() => {
    const probe = probeLayout();
    // Three columns hold the list to 480px (app.css), more than the
    // `--ai-list-min` the probe reads (22rem since #6474), so the handle
    // stops where the thread is drawn to stop, and the snap that hides the
    // list is measured from there (24 Nov 2026).
    const listMin = Math.max(probe.neighbourMin ?? 0, THREE_LIST_MIN);
    const pane = previewRef.current;
    const box = pane ? pane.getBoundingClientRect() : null;
    if (!box || box.width <= 0) return { ...probe, neighbourMin: listMin + PREVIEW_MIN_W };
    const endAt = inlineStartOf(box);
    const roomEnd = probe.innerWidth - Math.max(0, probe.rightInset || 0);
    return { ...probe, neighbourMin: listMin + Math.max(0, roomEnd - endAt), endAt };
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
  // Cleared whenever the column is not that page, or the detail goes, or the
  // window has no room for the third column, so the edge is Main's again.
  // Kept while the list is put away beside the detail, as Main's edge is.
  useEffect(() => {
    panelEdgeStore.set({
      slot: visible && threeFits && pageInColumn
        ? { widthKey: AI_PREVIEW_COLUMN_WIDTH_KEY, probe: threadProbe, watch: previewRef }
        : null,
    });
    return () => { panelEdgeStore.set({ slot: null }); };
  }, [visible, threeFits, pageInColumn, threadProbe]);
  // AND THE SAME EDGE HIDES THE LIST (#6973): while a request, change or
  // decision page is the column, the divider people drag is the side panel's
  // own, not Main's, so it is handed the one-pane wiring too. It never
  // overwrites the slot above: the store merges the patch.
  useEffect(() => {
    panelEdgeStore.set({
      snap: visible && pageInColumn && snaps && !phone
        ? { collapsed: oneUp, onCollapse: () => setListClosed(true), onRestore: () => setListClosed(false) }
        : null,
    });
    return () => { panelEdgeStore.set({ snap: null }); };
  }, [visible, pageInColumn, snaps, oneUp, phone]);
  const detailSlot: ColumnDetail | undefined = !detailHere || !detail ? undefined
    : detail.kind === 'design' ? { kind: 'design', version: detail.version }
      : detail.kind === 'plan' && detail.ref.sessionId ? { kind: 'plan', sessionId: detail.ref.sessionId, version: detail.version }
        : detail.kind === 'shots' && detail.ref.changeId ? { kind: 'shots', changeId: detail.ref.changeId }
          : undefined;
  const columnShown: Column = column && detailSlot ? { ...column, detail: detailSlot } as Column : column;
  // The thread or page on screen claims what opens beside it, while this
  // page is the one shown (the AI screen stays mounted behind every other).
  // What opened before it was known (a reload's preview, reopened from its
  // address while the page drew) is claimed by it, and drawn again.
  const [, claimed] = useState(0);
  useEffect(() => {
    const owner = visible && shown && shown !== 'new' ? shown : null;
    setDetailOwner(owner);
    if (claimDetail(owner)) claimed((n) => n + 1);
  }, [visible, shown]);
  // Another thread opened: the one left holds what it showed, and the one
  // arrived at shows what it held, if anything.
  //
  // LEAVING THE PAGE IS LEAVING THE THREAD (phone review #5, 23 Nov 2026).
  // The store is the whole shell's, and a request's or a change's own page
  // draws whatever is in it (../detail/detail-slot.tsx). An artifact left
  // open here, with Home pressed instead of its back arrow, stayed in the
  // store, and the next request opened was covered by it, whatever its
  // project. So what the thread shows is held for it when this page stops
  // being the one on screen, as when another thread opens, and shown again
  // when the page is come back to. A running preview is not: its frame is
  // the staging overlay's, which puts its own entry away.
  const ownerWas = useRef<string | null>(null);
  useEffect(() => {
    const was = ownerWas.current;
    if (!visible) {
      ownerWas.current = null;
      const entry = detailEntry();
      if (!entry?.owner || entry.kind === 'preview') return;
      const ofThisChat = (entry.kind === 'design' || entry.kind === 'draft') && !!botId && entry.ref.conversationId === botId;
      if (entry.owner === was || ofThisChat) holdDetail(entry.owner);
      return;
    }
    ownerWas.current = shown;
    if (was === shown) return;
    if (was) holdDetail(was);
    const back = takeHeldDetail(shown);
    if (back) reopenDetail(back);
  }, [visible, shown]); // eslint-disable-line react-hooks/exhaustive-deps
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
    // No column yet (the page still drawing after a reload): it is claimed
    // by the thread once that is known (above), not closed for want of one.
    if (!shown) return;
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
  // 24 Nov 2026 (mobile 04): an @ row's Dismiss takes it out of Needs you at
  // once, its thread back where it would be (./model.ts withoutDismissed),
  // by thread and the moment of the @ dismissed: a read already on its way
  // cannot bring it back, and a newer @ still can. The server keeps it
  // (POST threads/mentions/dismiss), so a reload agrees.
  const [dismissed, setDismissed] = useState<ReadonlyMap<number, string | null>>(() => new Map());
  const listedWork = useMemo(() => withoutDismissed(work, dismissed), [work, dismissed]);
  const dismissNamed = (row: WorkRow) => {
    const threadId = row.threadId;
    const slug = row.app?.slug;
    if (!threadId || !slug) return;
    setDismissed((had) => new Map([...had, [threadId, row.at]]));
    const undo = () => {
      setDismissed((had) => {
        if (!had.has(threadId)) return had;
        const next = new Map(had);
        next.delete(threadId);
        return next;
      });
      (window as any).PlatformUI?.toast?.(t('messages:ai.named.dismissFailed'));
    };
    void fetch(`/api/apps/${encodeURIComponent(slug)}/threads/mentions/dismiss${demoQuery()}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ thread_id: threadId }),
    }).then((res) => { if (!res.ok) undo(); }).catch(undo);
  };
  const allRows = useMemo(
    () => needsYou(needs, listedWork).map(cleared),
    [needs, listedWork, seenThreads, seenRoots], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const rows = useMemo(() => allRows.filter((row) => !row.rootId || !doneRoots.has(row.rootId)), [allRows, doneRoots]);
  const progress = useMemo(() => inProgress(needs, listedWork).map(cleared), [needs, listedWork, seenThreads, seenRoots]); // eslint-disable-line react-hooks/exhaustive-deps
  const waiting = useMemo(() => upNext(needs, listedWork).map(cleared), [needs, listedWork, seenThreads, seenRoots]); // eslint-disable-line react-hooks/exhaustive-deps
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
  // Mobile polish 05 (24 Nov 2026): your last visit, which the bands mark
  // what is new since (./use-visit.ts, ./visit.ts), and what they hold now,
  // which this visit leaves for the next one to measure from.
  const listSeen = useMemo(() => visitSeen(rows, progress, waiting, live), [rows, progress, waiting, live]);
  const lastVisit = useListVisit({ visible, session, ready: !!work && !!needs, seen: listSeen, demo: demoQuery() });
  // #7121: a row opened during this visit stops being new at once: the
  // page's copy of the last visit learns it (withOpened), and the server's
  // does too (noteOpened), so a reload in the same visit agrees. A fresh
  // answer from the server replaces the patched copy, with the entries it
  // was told about already in it.
  const [shownVisit, setShownVisit] = useState(lastVisit);
  useEffect(() => { setShownVisit(lastVisit); }, [lastVisit]);
  const seeOpened = (entry: OpenedEntry) => {
    if (!lastVisit) return;
    setShownVisit((now) => withOpened(now ?? lastVisit, ...entry));
    noteOpened(entry[0], entry[1], entry[2], demoQuery());
  };
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
        openDetail({
          kind: 'design',
          ref: { conversationId: botId, rootId: where.threadRootId, ...(at.artifactId ? { artifactId: at.artifactId } : {}) },
          version: at.version,
        });
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
  // it are, the same place a Vote or Needs reply row for it opens.
  const openPage = (href: string | null, app: AiApp | null, title: string | null, about: AboutItem | null): boolean => {
    const route = routeOf(href);
    opened.current = route ? { route, about } : null;
    const took = openPublic(href, app, title);
    if (took) underPanel();
    return took;
  };
  const openRow = (row: WorkRow) => {
    seeOpened(openedNeed(row));
    markThreadRead(row.threadId, row.app, row.rootId);
    if (row.rootId) {
      openPrivate(row.rootId);
      return;
    }
    // Mobile 04: Reply on a thread somebody named you in opens its page at
    // the message that named you, once its thread is drawn (group-chat.js
    // revealInThread): this document's, or the column's own when the column
    // took the page. An @ in a request's own text has no message: its page
    // opens at the top, where that text is.
    const messageId = row.named?.messageId;
    const slug = row.app?.slug;
    if (messageId && slug) (window as any).GroupChat?.revealInThread?.(slug, messageId);
    if (openPage(row.href, row.app, row.title, aboutRow(row)) && messageId && slug) sidePanel()?.revealMessage?.(slug, messageId);
  };
  const openThread = (th: AiThread) => {
    seeOpened(openedThread(th));
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
    seeOpened(openedHistory(row));
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
    const now = `${shown}|${detailSlot ? JSON.stringify(detailSlot) : ''}|${waitingOpen ? 'waiting' : ''}|${progressOpen ? 'progress' : ''}`;
    addressed.current = now;
    if (before === undefined) return;
    if (before === now) return;
    // #7103: while Waiting on you is the list, the column's own resting
    // state (a new chat) keeps the waiting address rather than the bare
    // tab's, so closing an item opened from it, or a window that changes
    // layout, comes back to the list. An item in the column still writes
    // its own address; All threads writes the bare tab's itself.
    const href = columnAddress(columnShown);
    const base = href !== BOT_TAB ? href
      : waitingOpen ? waitingAddress()
        : progressOpen ? progressAddress()
          : href;
    showAddress(withFilter(base, { projects: filterRef.current.picked, kind: filterRef.current.historyKind }));
  }, [mounted, visible, botId, shown, detailSlot, waitingOpen, progressOpen]); // eslint-disable-line react-hooks/exhaustive-deps
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
  // ONE LOOK (25 Nov 2026): on a phone the bar is New chat's while it is the
  // drawer's level in view, for its back disc (./new-chat-bar.ts); since 26
  // Nov 2026 it says the tab's name there, and New chat's own title card
  // names the chat. A thread keeps the plain bar and its own head.
  const newChatHere = mounted && visible && phone && blank && !openRoot;
  const newChatBar = useNewChatBar({
    shown: newChatHere && level === 1,
    away: newChatHere && level === 0,
    list: t('messages:ai.hero.name'),
    back: t('messages:newThread.back'),
    onBack: () => toListRef.current(),
  });

  // NEW CHAT (#6071 follow-up; 14 Nov 2026): a new chat with the bot, in the
  // column (../messages/new-thread.tsx), slid in on a phone.
  // Whether the new chat in the column was put there by the page (below), not asked for.
  const autoBlank = useRef(false);
  const openBlank = () => {
    autoBlank.current = false;
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
  // THE COLUMN IS NEVER EMPTY BESIDE THE LISTS (23 Nov 2026, #7039): from
  // 768px, where the column is docked, a new chat is what it shows whenever
  // nothing else is open there, as if New chat had been pressed. The page
  // opens on it, and closing a thread or a page comes back to it. Nothing
  // is made until the first message. A phone's list stays alone.
  // `autoBlank` says this new chat was not asked for: a thread that arrives
  // after it (a cold load on a thread's address, whose chat is learned
  // late) takes the column from it, where one the person opened stays.
  useEffect(() => {
    if (!visible || !mounted || !docked || phone || !botId || column) return;
    // A new chat an address just asked for (`#homeroom-bot/new?with=…`, the
    // effect above, in this same commit) is already there, set as it asked:
    // read live, since this render's `column` is from before it.
    if (newThreadIn() === botId) return;
    autoBlank.current = true;
    startNewThread(botId, newChatPreset());
  }, [visible, mounted, docked, phone, botId, column]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (blank && autoBlank.current && openRoot && !phone) { autoBlank.current = false; closeNewThread(); }
  }, [blank, openRoot, phone]);
  // THE LAYOUT SWITCHED (phone review #11, 23 Nov 2026): a folded phone
  // turned, or opened and closed, crosses 768px, and the drawer and the
  // docked column are two trees with a chat mounted in each. The one left
  // gives the store's route back as it goes (../messages/store.ts release),
  // which closed the thread on screen and left the address the bare tab's.
  // So the thread that was open is asked for again in the layout arrived at
  // (after the two chats' own effects, which run before this one), slid in
  // on a phone; a new chat the person opened stays up too, where one the
  // page put in an empty column (above) gives the phone its list back.
  const layoutNow = phone ? 'phone' : wide ? 'wide' : null;
  const layoutWas = useRef<'phone' | 'wide' | null>(null);
  useEffect(() => {
    const was = layoutWas.current;
    layoutWas.current = layoutNow;
    if (!was || !layoutNow || was === layoutNow || !botId) return;
    if (openRoot) {
      const next = { threadRootId: openRoot, focusMessageId: null };
      setAt(next);
      embed(botId, next, { threadsOnly: true });
      if (layoutNow === 'phone') setLevel(1);
      return;
    }
    if (layoutNow === 'phone') setLevel(blank && !autoBlank.current ? 1 : 0);
  }, [layoutNow]); // eslint-disable-line react-hooks/exhaustive-deps
  // And the lists keep their place: they are drawn again in the other
  // layout's scroller (the drawer's list on a phone, the page itself from
  // 768px), which would start at its top.
  const listTop = useRef(0);
  useEffect(() => {
    const screen = screenRef.current;
    if (!screen) return undefined;
    const note = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (target === screen || target?.classList?.contains('ai-drawer-list')) listTop.current = target.scrollTop;
    };
    screen.addEventListener('scroll', note, true);
    return () => screen.removeEventListener('scroll', note, true);
  }, []);
  const scrolledIn = useRef<'phone' | 'wide' | null>(null);
  useLayoutEffect(() => {
    const was = scrolledIn.current;
    scrolledIn.current = layoutNow;
    const screen = screenRef.current;
    if (!was || !layoutNow || was === layoutNow || !screen || !listTop.current) return;
    const scroller = layoutNow === 'phone' ? screen.querySelector<HTMLElement>('.ai-drawer-list') : screen;
    if (scroller) scroller.scrollTop = listTop.current;
  }, [layoutNow]);
  // SEARCH (#6398, 6 Nov 2026): every list narrows to the threads whose
  // title, number or project matches what the box says (./lists.tsx). 24 Nov
  // 2026 (the three bands): on the standard list the box is always there, on
  // the head card's tools line, rather than behind a round button. Its state
  // is declared above, with the filter, which empties it when the tab is
  // left or a door opens History; it is not kept in the address: the project
  // filter is what a link carries.
  const asked = query;
  // Ctrl+K (⌘K) puts the cursor in the box while the tab is showing
  // (./search-shortcut.ts); the box names the key at its end on a computer.
  useEffect(() => installBotSearchShortcut(() => (visible ? searchRef.current : null)), [visible]);
  const searchHint = useSearchHint();
  // 13 Nov 2026: the box also searches what was said, in the person's own
  // threads with the bot, on the server (./search.ts). Asked
  // only once something is typed, so the first render has none of it.
  const search = useBotSearch(asked, {
    signedIn: mounted && typeof window !== 'undefined' && !!(window as any).App?.user,
    demo: !!demoQuery(),
  });
  // 17 Nov 2026 (./search-mark.ts): the words a found result opened stay
  // marked in its message while it is read. Clearing the box, closing the
  // search or typing something else takes the marks with it; the box is not
  // in the address, so nothing else is left for a reload to find.
  const marked = cleanQuery(asked);
  useEffect(() => {
    const mark = currentSearchMark();
    if (mark && mark.q !== marked) clearSearchMark();
  }, [marked]);

  // THE HEAD CARD'S TOOLS LINE (./lists.tsx draws the card): the search
  // field, always there. Escape empties it, and a second Escape leaves it.
  const searchField = (
    <label className="flex h-9 min-w-[10rem] flex-1 basis-40 items-center gap-2 rounded-[10px] px-3 text-zinc-500 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] focus-within:shadow-[inset_0_0_0_2px_var(--accent)] dark:text-zinc-400" data-ai-search-box="">
      <SearchIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
      <input
        ref={searchRef}
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          e.stopPropagation();
          if (query) setQuery('');
          else e.currentTarget.blur();
        }}
        placeholder={t('messages:ai.search.placeholder')}
        aria-label={t('messages:ai.search.label')}
        aria-keyshortcuts={searchHint === 'none' ? undefined : BOT_SEARCH_SHORTCUT_KEYS}
        className="h-full min-w-0 flex-1 appearance-none border-0 bg-transparent p-0 text-base text-zinc-900 outline-none placeholder:text-zinc-500 md:text-sm dark:text-zinc-100 dark:placeholder:text-zinc-400 [&::-webkit-search-cancel-button]:hidden"
        data-ai-search=""
      />
      {/* S14: a way to empty the box, drawn only while it holds something;
          the cursor stays in the box. Otherwise, on a computer, the key that
          puts the cursor here (after mount: the prerender cannot know the
          device). app.css takes the key away where the list is narrow. */}
      {query ? (
        <button
          type="button"
          className="-me-2 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-zinc-500 hover:text-zinc-900 focus-visible:shadow-[inset_0_0_0_2px_var(--accent)] outline-none dark:text-zinc-400 dark:hover:text-zinc-100 [&>svg]:h-4 [&>svg]:w-4"
          aria-label={t('messages:ai.search.clear')}
          title={t('messages:ai.search.clear')}
          data-ai-search-clear=""
          onClick={(e) => { e.preventDefault(); setQuery(''); searchRef.current?.focus(); }}
        >
          <XIcon aria-hidden="true" strokeWidth="2.25" />
        </button>
      ) : searchHint === 'none' ? null : (
        <kbd className="ai-search-key shrink-0 rounded-md bg-zinc-900/[0.05] px-1.5 py-0.5 font-mono text-[11px] leading-4 text-zinc-500 dark:bg-white/[0.08] dark:text-zinc-400" aria-hidden="true" data-ai-search-key="">
          {searchHint === 'cmd' ? t('messages:ai.search.keyMac') : t('messages:ai.search.keyOther')}
        </kbd>
      )}
    </label>
  );

  const listContent = (
    <>
      <div className="ai-screen-body max-w-2xl mx-auto pb-8">
        <AiLists
          newChat={<NewChatButton onOpen={openNewChat} />}
          search={searchField}
          query={asked}
          onQueryClear={endSearch}
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
          onDismiss={dismissNamed}
          picked={picked}
          onPick={pick}
          appFor={appFor}
          history={history}
          historyKind={historyKind}
          onHistoryKind={pickKind}
          openHistory={openHistory}
          historyRef={historyRef}
          doneOpen={toHistory}
          visit={shownVisit}
          waitingOpen={waitingOpen}
          onOpenWaiting={openWaiting}
          onCloseWaiting={closeWaiting}
          progressOpen={progressOpen}
          onOpenProgress={openProgress}
          onCloseProgress={closeProgress}
        />
        <div className="ai-askbar-gap" aria-hidden="true" />
      </div>

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
          {/* One look (25 Nov 2026): drawn as the message box it opens, its
              "+" first and its send last, quiet until there are words. */}
          <span className="messages-composer-action ai-askbar-add" aria-hidden="true"><PlusIcon className="h-5 w-5" /></span>
          <span className="ai-askbar-text">{t('messages:ai.ask.label')}</span>
          <span className="messages-composer-action" aria-hidden="true"><MicrophoneIcon className="h-5 w-5" /></span>
          <span className="ai-askbar-send" aria-hidden="true"><ArrowUpIcon className="h-5 w-5" /></span>
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
      data-ai-preview={previewHere ? layout : undefined}
      // The column is only waiting for a live preview: it is never wider than the chat (app.css).
      data-ai-live-wait={waitingHere ? '' : undefined}
      data-ai-list-closed={oneUp ? '' : undefined}
      style={{ position: 'relative' }}
    >
      {phone ? (
        <AiDrawer
          level={level}
          onLevel={setLevel}
          onPan={newChatBar.pan}
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
            widthKey={threeFits ? AI_PREVIEW_COLUMN_WIDTH_KEY : AI_MAIN_WIDTH_KEY}
            probe={threeFits ? threadProbe : undefined}
            watch={threeFits ? previewRef : undefined}
            collapsed={oneUp}
            onCollapse={snaps ? () => setListClosed(true) : undefined}
            onRestore={snaps ? () => setListClosed(false) : undefined}
          />
          {/* A thread is alone under its own head (ReplyThreadPanel `alone`),
              and a new chat under its own: the column draws no bar over them. */}
          {/* The new chat drawn here is the column's resting state, with
              no × to close it to an empty column (NewThreadDocked). */}
          {conversationUp ? (
            <NewThreadDocked.Provider value>
              {/* With the preview's column beside it, Start is there, not in the head. */}
              <LiveStartBeside.Provider value={waitingNew}>
                <EmbeddedConversation conversationId={botId!} active={visible && columnOpen} at={at} threadsOnly />
              </LiveStartBeside.Provider>
            </NewThreadDocked.Provider>
          ) : null}
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
      ) : waitingHere ? (
        // The same column, before there is anything to read in it: a new
        // chat's live preview, waiting to be started or just started.
        <aside
          ref={previewRef}
          id="ai-preview-pane"
          className="ai-preview-pane"
          data-ai-preview-pane={layout}
          data-ai-live-start=""
          aria-label={t('messages:newThread.live.pane.label')}
        >
          <SidePanelDivider
            panelRef={previewRef}
            shown={columnOpen}
            id="ai-preview-divider"
            controls="ai-preview-pane"
            widthKey={AI_PREVIEW_WIDTH_KEY}
            probe={previewProbe}
          />
          <LiveStartPane opening={openingHere && liveOpening ? { name: liveOpening.name } : null} />
        </aside>
      ) : null}
    </main>
  );
}
