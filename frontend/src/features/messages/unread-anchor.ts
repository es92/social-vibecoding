import { useEffect, useRef, useState, type RefObject } from 'react';

import { t } from '../../lib/i18n/runtime';
import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { isNearBottom, STICK_SLACK_PX, type ScrollBox } from './stick-to-bottom';
import { inMainStream } from './bot-shared';

/*
 * A conversation with unread messages opens where they begin.
 *
 * "when you go to a dm / discussion with unread messages, start so that the
 * top of the screen is where you've unread, and have a little unread banner,
 * like I think discord or slack does? And some little button to scroll down
 * / indicates you can scroll down, like claude does" (Evan, 5 Oct 2026).
 *
 * The first two read off one fact, where reading had stopped when the
 * conversation was opened (Messages' `unreadMark`, the group chat's
 * `_unreadMark`), taken from the server before the open reads it:
 *
 *   - the OPENING. The first unread message sits near the top of the
 *     transcript with a row or two of what was already read above it,
 *     unless everything new fits at the bottom, which is where it then opens;
 *   - the "New" LINE above that message, and a BANNER over the top of the
 *     transcript saying how many are new. The banner goes once the reader
 *     has scrolled onto the line or past it, or reached the bottom; a tap
 *     takes them back to the line. The line stays while the conversation is
 *     open;
 *
 * and the third reads only where the reader is:
 *
 *   - JUMP TO LATEST, a round button over the foot of the transcript
 *     whenever the reader is not at the bottom, with a dot when somebody
 *     wrote while they were away from it.
 *
 * Everything that decides is a pure function here, so a test can pin it;
 * the hooks only measure and call them.
 */

/** What the opening, the line and the dot read off one message. */
export interface UnreadRow {
  id: number;
  /** The viewer's own message: never unread, as the server counts. */
  mine: boolean;
  /**
   * Whether it is a message the server's unread count counts at all: a
   * person's, in the main stream, not deleted, and already stored (a row
   * still sending has no id of its own yet).
   */
  countable: boolean;
}

/** The read position a conversation had when it was opened. */
export interface UnreadMark {
  conversationId: number;
  /** The newest message read before this open; 0 when none had been. */
  lastReadId: number;
  /** How many were unread then, as the server counted them. */
  count: number;
}

/** How much of what was already read the opening leaves above the line: about two rows. */
export const UNREAD_CONTEXT_PX = 64;

/**
 * The mark an open takes from the conversation it read: none unless
 * something was unread and the server said where reading stopped.
 */
export function markFor(
  conversationId: number,
  conversation: { membershipStatus?: string; unreadCount?: number; lastReadMessageId?: number | null } | null | undefined,
): UnreadMark | null {
  if (!conversation || conversation.membershipStatus !== 'member') return null;
  const count = Math.floor(Number(conversation.unreadCount) || 0);
  const lastReadId = conversation.lastReadMessageId;
  if (count <= 0 || typeof lastReadId !== 'number' || !Number.isFinite(lastReadId) || lastReadId < 0) return null;
  return { conversationId, lastReadId, count };
}

/**
 * The first message after the cursor that is unread: somebody else's,
 * counted the way the server counts. Rows run oldest first. Null when none
 * of the rows drawn is, and then the conversation opens at its newest
 * message, as it does with nothing unread.
 */
export function firstUnreadId(rows: readonly UnreadRow[], lastReadId: number): number | null {
  for (const row of rows) {
    if (row.id > lastReadId && row.countable && !row.mine) return row.id;
  }
  return null;
}

/** "3 new messages", in words. Nothing at all for none. */
export function newMessagesLabel(count: number): string {
  const n = Math.floor(Number(count) || 0);
  if (n <= 0) return '';
  return t('messages:thread.newMessages', { count: n });
}

/**
 * Where the opening puts the scroller, given where the "New" line starts in
 * the scroller's content (`lineTop`): the line UNREAD_CONTEXT_PX below the
 * top. Never past the bottom, and when that lands within the follow
 * allowance of the bottom everything new is on screen, so the reader counts
 * as at the bottom (`pinned`) and keeps following what arrives, as
 * ./stick-to-bottom.ts would decide on their next scroll.
 */
export function openingScrollTop(
  { lineTop, scrollHeight, clientHeight, context = UNREAD_CONTEXT_PX, slack = STICK_SLACK_PX }: {
    lineTop: number;
    scrollHeight: number;
    clientHeight: number;
    context?: number;
    slack?: number;
  },
): { top: number; pinned: boolean } {
  const bottom = Math.max(0, scrollHeight - clientHeight);
  const top = Math.min(bottom, Math.max(0, Math.round(lineTop - context)));
  return { top, pinned: bottom - top <= slack };
}

/** Where the "New" line is against what the scroller shows. */
export type LinePlace = 'below' | 'in-view' | 'passed';

/**
 * `top` is the line's top less the scroller's own (both on screen, as
 * getBoundingClientRect has them). Above the top edge, the reader has read
 * on past it; at or past the bottom edge, it is still to come.
 */
export function linePlace(top: number, clientHeight: number): LinePlace {
  if (top < 0) return 'passed';
  if (top >= clientHeight) return 'below';
  return 'in-view';
}

/** The banner's state between measurements. */
export interface BannerState {
  dismissed: boolean;
  /** Where the line was at the last measurement; null before the first. */
  place: LinePlace | null;
}

export const BANNER_START: BannerState = { dismissed: false, place: null };

/**
 * The banner goes, for good, once the reader reaches the bottom, or MOVES
 * the line into view or past the top. Moves: the opening puts the line in
 * view, and the banner is for that moment, so where the line starts is not
 * a reason to go; a link that opened the conversation further down or
 * further up leaves it up too, until the reader scrolls. Scrolling up away
 * from the line (it goes below) keeps it, so a tap can bring them back.
 */
export function nextBanner(previous: BannerState, now: { place: LinePlace | null; atBottom: boolean }): BannerState {
  if (previous.dismissed) return previous;
  const moved = previous.place !== null && now.place !== null && now.place !== previous.place;
  const dismissed = now.atBottom || (moved && now.place !== 'below');
  return { dismissed, place: now.place ?? previous.place };
}

/**
 * Messages from somebody else after the newest one the reader saw at the
 * bottom: what the jump button's dot is for.
 */
export function arrivalsAfter(rows: readonly UnreadRow[], seenThrough: number): number {
  let n = 0;
  for (const row of rows) if (row.id > seenThrough && row.countable && !row.mine) n += 1;
  return n;
}

/** The newest stored message, or 0. */
export function newestId(rows: readonly UnreadRow[]): number {
  let top = 0;
  for (const row of rows) if (row.id > top) top = row.id;
  return top;
}

/**
 * Jump to latest is up whenever the reader is not at the bottom: the same
 * allowance as following new messages, so the button is there exactly when
 * a new message would not be followed.
 */
export function jumpShown(box: ScrollBox, slack: number = STICK_SLACK_PX): boolean {
  return !isNearBottom(box, slack);
}

/** The button's name, which says what the dot means. */
export function jumpLabel(arrived: number): string {
  const n = Math.floor(Number(arrived) || 0);
  return n > 0 ? t('messages:thread.jumpToLatestNew', { count: n }) : t('messages:thread.jumpToLatest');
}

/** A glide the reader asked for, or a jump for a reader who asked for less motion. */
export function scrollBehavior(win: { matchMedia?: (query: string) => { matches: boolean } } = globalThis as never): ScrollBehavior {
  try {
    return win.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  } catch {
    return 'auto';
  }
}

type Box = { getBoundingClientRect(): { top: number } };

/** Where `line` starts in `scroller`'s content: its distance from the top when scrolled to 0. */
export function lineTopIn(scroller: Box & { scrollTop: number }, line: Box): number {
  return line.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
}

/** What the transcript draws over itself. */
export interface UnreadView {
  banner: boolean;
  jump: boolean;
  /** Messages from others since the reader left the bottom. */
  arrived: number;
}

const HIDDEN: UnreadView = { banner: false, jump: false, arrived: 0 };

function sameView(a: UnreadView, b: UnreadView): boolean {
  return a.banner === b.banner && a.jump === b.jump && a.arrived === b.arrived;
}

/**
 * The banner and the jump button for one transcript.
 *
 * `conversation` starts both again when another opens, and `markKey` starts
 * the banner again when the line moves (Mark unread). `rows` are the
 * transcript's messages, oldest first, and `lineAt` the message the line is
 * drawn above (null with none). `atPresent` is false at the foot of a window
 * a message link opened part-way back (#2387): nothing there has ARRIVED, so
 * no dot. `offerBanner` is false when the conversation opened at a message a
 * link named rather than at its first unread: the link is where the reader
 * asked to be, and the line still shows where the new ones begin.
 *
 * Measured on the reader's scrolls (at most once a frame) and after a commit
 * that changes the rows or the line, never on the renders in between (a
 * typing notice re-renders the thread, and costs no layout read here). The
 * caller declares this hook AFTER its own scroll effect, so the first
 * measurement sees where the opening put the scroller.
 *
 * Only a scroll MOVES the line for the banner. A commit can shift it with
 * nobody scrolling (older messages drawn above it, then the scroller put
 * back a frame later), and that is not the reader reaching it.
 *
 * `slack` is how near the bottom counts as at it: the allowance the
 * transcript itself follows new messages within, so the button is up
 * exactly when a new message would not be followed. `watchContent` measures
 * again whenever the rows change size, for a transcript whose rows this
 * component does not draw (the group chat's, filled by public/js/group-chat.js).
 */
export function useUnreadAffordances(
  scroller: RefObject<HTMLElement | null>,
  line: RefObject<HTMLElement | null>,
  { conversation, markKey, lineAt, rows, atPresent = true, offerBanner = true, slack = STICK_SLACK_PX, watchContent = false }: {
    conversation: number | string | null;
    markKey: string;
    lineAt: number | null;
    rows: readonly UnreadRow[];
    atPresent?: boolean;
    offerBanner?: boolean;
    slack?: number;
    watchContent?: boolean;
  },
): { view: UnreadView; toLine: () => void; toLatest: () => void } {
  const [view, setView] = useState<UnreadView>(HIDDEN);
  const shown = useRef<UnreadView>(HIDDEN);
  const banner = useRef<BannerState>(BANNER_START);
  const seen = useRef<{ conversation: number | string | null; through: number }>({ conversation: null, through: 0 });
  const latest = useRef({ rows, atPresent, offerBanner, slack, watchContent });
  latest.current = { rows, atPresent, offerBanner, slack, watchContent };
  const attached = useRef<{ el: HTMLElement; detach: () => void } | null>(null);

  // Reads refs only, so the copy a scroll listener holds is never stale.
  const measure = useRef((byScroll: boolean) => {
    const el = scroller.current;
    let next = HIDDEN;
    if (el) {
      const { rows: current, atPresent: present, offerBanner: offer, slack: allowance } = latest.current;
      const atBottom = isNearBottom(el, allowance);
      const mark = line.current;
      if (mark) {
        const measured = linePlace(mark.getBoundingClientRect().top - el.getBoundingClientRect().top, el.clientHeight);
        const was = banner.current.place;
        banner.current = nextBanner(banner.current, { place: byScroll || was === null ? measured : was, atBottom });
      }
      if (atBottom || !present) seen.current.through = Math.max(seen.current.through, newestId(current));
      next = {
        banner: offer && !!mark && !banner.current.dismissed,
        jump: jumpShown(el, allowance),
        arrived: atBottom || !present ? 0 : arrivalsAfter(current, seen.current.through),
      };
    }
    if (sameView(shown.current, next)) return;
    shown.current = next;
    setView(next);
  }).current;

  // Another conversation, or the line moved: the banner starts again.
  useIsomorphicLayoutEffect(() => {
    banner.current = BANNER_START;
  }, [conversation, markKey]);
  // What a conversation opens with is what the reader has seen of it: the
  // dot is for what comes after. Taken again while there is nothing drawn
  // (the conversation still loading), so the first page is never news.
  useIsomorphicLayoutEffect(() => {
    if (seen.current.conversation !== conversation || !seen.current.through || !rows.length) {
      seen.current = { conversation, through: newestId(rows) };
    }
    measure(false);
  }, [conversation, markKey, lineAt, rows, atPresent, offerBanner]);

  // The scroller React draws: attached again only when it is another node
  // (a conversation rather than the empty state), as useStickToBottom does.
  useIsomorphicLayoutEffect(() => {
    const el = scroller.current;
    if ((attached.current?.el || null) === el) return;
    attached.current?.detach();
    attached.current = null;
    if (!el) return;
    // One measurement a frame at most, a scroll's winning over a resize's.
    let frame = 0;
    let byScroll = false;
    const later = (scrolled: boolean) => {
      byScroll = byScroll || scrolled;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const moved = byScroll;
        byScroll = false;
        measure(moved);
      });
    };
    const onScroll = () => later(true);
    el.addEventListener('scroll', onScroll, { passive: true });
    const content = latest.current.watchContent ? attachContentWatch(el, () => later(false)) : null;
    attached.current = {
      el,
      detach: () => {
        el.removeEventListener('scroll', onScroll);
        content?.();
        if (frame) cancelAnimationFrame(frame);
      },
    };
  });
  useEffect(() => () => {
    attached.current?.detach();
    attached.current = null;
  }, []);

  const toLine = () => {
    const el = scroller.current;
    const mark = line.current;
    banner.current = { ...banner.current, dismissed: true };
    if (el && mark) {
      const { top } = openingScrollTop({ lineTop: lineTopIn(el, mark), scrollHeight: el.scrollHeight, clientHeight: el.clientHeight });
      el.scrollTo({ top, behavior: scrollBehavior() });
    }
    measure(false);
  };
  const toLatest = () => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: scrollBehavior() });
  };
  return { view, toLine, toLatest };
}

/**
 * A message as this module reads it. Countable the way the server's unread
 * count is (services/conversations.js countUnread): the main stream only,
 * not deleted, not a platform line, and stored (a row still sending, or one
 * that failed, has no place among what was read). One request, one story: a
 * thread reply the chat with Homeroom bot also lists in its main stream
 * (`alsoInChat`, ./bot-shared.ts inMainStream) is part of that stream.
 */
export function messageRow(
  message: {
    id: number; sender: { id: number }; threadRootId?: number | null; deleted?: boolean; system?: boolean; pending?: boolean; failed?: boolean;
    metadata?: { homeroomBot?: { alsoInChat?: boolean } | null } | null;
  },
  viewerId: number,
): UnreadRow {
  return {
    id: message.id,
    mine: !!viewerId && message.sender.id === viewerId,
    countable: message.id > 0 && inMainStream(message) && !message.deleted && !message.system && !message.pending && !message.failed,
  };
}

/**
 * Call `changed` whenever the scroller's rows change size, or rows come and
 * go: a transcript filled by somebody else, whose history landing (and
 * scrolling nowhere, as a topic opened at its top does) says nothing to a
 * scroll listener. Returns the detach. Without ResizeObserver it watches
 * nothing, and the scroll events still say most of it.
 */
export function attachContentWatch(
  el: HTMLElement,
  changed: () => void,
  env: LineHoldEnv = globalThis as unknown as LineHoldEnv,
): () => void {
  const Sizes = env.ResizeObserver;
  if (typeof Sizes !== 'function') return () => {};
  const sizes = new Sizes(changed);
  sizes.observe(el);
  for (const child of Array.from(el.children)) sizes.observe(child);
  const Rows = env.MutationObserver;
  const rows = typeof Rows === 'function'
    ? new Rows((records) => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) if (node.nodeType === 1) sizes.observe(node as Element);
        for (const node of Array.from(record.removedNodes)) if (node.nodeType === 1) sizes.unobserve(node as Element);
      }
      changed();
    })
    : null;
  rows?.observe(el, { childList: true });
  return () => {
    rows?.disconnect();
    sizes.disconnect();
  };
}

/** How long the line is held where the opening put it, at most. */
export const LINE_HOLD_MS = 15_000;

type HoldObserver = { observe(target: Element): void; unobserve(target: Element): void; disconnect(): void };
type HoldRows = { observe(target: Node, options: { childList: boolean }): void; disconnect(): void };

/** The observers and the clock the hold uses (the window's, in a browser). */
export interface LineHoldEnv {
  ResizeObserver?: new (callback: () => void) => HoldObserver;
  MutationObserver?: new (callback: (records: { addedNodes: ArrayLike<Node>; removedNodes: ArrayLike<Node> }[]) => void) => HoldRows;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (id: never) => void;
}

const READER_INPUT = ['touchstart', 'wheel', 'keydown', 'mousedown'] as const;

/**
 * Keep the "New" line where the opening put it while what is drawn above it
 * settles. An image or a link card filling in above the line pushes it, and
 * the reader's place with it, down the screen, and iOS WebKit has no scroll
 * anchoring to put it back. While the hold lasts, any change of size among
 * the rows moves the scroller by however far the line moved.
 *
 * It ends at the reader's first touch, wheel, key or click in the
 * transcript, at any scroll that is not its own (a send taking the reader
 * to the bottom, Jump to latest, the browser's own anchoring), when the
 * line is gone, or after `ms`. Returns the end, to call early.
 */
export function attachLineHold(
  el: HTMLElement,
  line: HTMLElement,
  env: LineHoldEnv = globalThis as unknown as LineHoldEnv,
  ms: number = LINE_HOLD_MS,
): () => void {
  const offset = () => line.getBoundingClientRect().top - el.getBoundingClientRect().top;
  const want = offset();
  let expected = el.scrollTop;
  let done = false;
  let timer: unknown = null;
  let sizes: HoldObserver | null = null;
  let rows: HoldRows | null = null;
  const stop = () => {
    if (done) return;
    done = true;
    for (const type of READER_INPUT) el.removeEventListener(type, stop);
    el.removeEventListener('scroll', onScroll);
    rows?.disconnect();
    sizes?.disconnect();
    if (timer !== null) env.clearTimeout?.(timer as never);
  };
  const settle = () => {
    if (done) return;
    if ((line as { isConnected?: boolean }).isConnected === false) { stop(); return; }
    const drift = offset() - want;
    if (Math.abs(drift) < 1) return;
    el.scrollTop += drift;
    expected = el.scrollTop;
  };
  function onScroll() {
    if (Math.abs(el.scrollTop - expected) > 1) stop();
  }
  for (const type of READER_INPUT) el.addEventListener(type, stop, { passive: true });
  el.addEventListener('scroll', onScroll, { passive: true });
  const Sizes = env.ResizeObserver;
  if (typeof Sizes === 'function') {
    const watching = new Sizes(settle);
    sizes = watching;
    for (const child of Array.from(el.children)) watching.observe(child);
    const Rows = env.MutationObserver;
    if (typeof Rows === 'function') {
      rows = new Rows((records) => {
        for (const record of records) {
          for (const node of Array.from(record.addedNodes)) if (node.nodeType === 1) watching.observe(node as Element);
          for (const node of Array.from(record.removedNodes)) if (node.nodeType === 1) watching.unobserve(node as Element);
        }
      });
      rows.observe(el, { childList: true });
    }
  }
  if (typeof env.setTimeout === 'function') timer = env.setTimeout(stop, ms);
  return stop;
}

/**
 * attachLineHold for the transcript on screen: `hold` starts one (ending
 * the last), and another conversation or unmounting ends it.
 */
export function useLineHold(conversation: number | null): (el: HTMLElement, line: HTMLElement) => void {
  const current = useRef<(() => void) | null>(null);
  useIsomorphicLayoutEffect(() => () => {
    current.current?.();
    current.current = null;
  }, [conversation]);
  return useRef((el: HTMLElement, line: HTMLElement) => {
    current.current?.();
    current.current = attachLineHold(el, line);
  }).current;
}

/**
 * A row of the group chat's transcript as this module reads it
 * (features/group-chat/transcript-store.ts TranscriptMessage). Countable the
 * way the app chat's unread count is (services/app-chat.js unreadCount): the
 * general stream (not a reply-thread reply drawn in it), written by a person
 * (a system line has no sender), not deleted.
 */
export function transcriptRow(message: {
  id: number | null;
  mine: boolean;
  senderId?: number | null;
  deleted?: boolean;
  replyOf?: unknown;
  threadRoot?: boolean;
}): UnreadRow {
  const id = message.id == null ? 0 : message.id;
  return {
    id,
    mine: !!message.mine,
    countable: id > 0 && message.senderId != null && !message.deleted && !message.replyOf && !message.threadRoot,
  };
}
