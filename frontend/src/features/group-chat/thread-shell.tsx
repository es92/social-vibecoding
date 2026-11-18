/**
 * The thread panel — the scroller, the messages host, the typing slot and the
 * composer — as the only React writer below the container `GroupChat.mountThread`
 * is given.
 *
 * ── Props, not a store ────────────────────────────────────────────────
 *
 * Everything here is fixed for the life of one mount: which layout, whether
 * there is an in-scroll header slot, whether the thread is read-only and with
 * what wording. It only changes when `mountThread` runs again, and
 * `mountLegacyPortal` re-renders with a new node and commits synchronously —
 * so the props ARE the publish, and a store would be a second thing to keep in
 * step for no gain.
 *
 * ── Two layouts, and the difference is load-bearing ───────────────────
 *
 * `fill` (#194 card-list revision) is the topic sub-view's thread: it fills its
 * flex container and mirrors the general chat pane — full-width message list,
 * then the status line and the composer bar at the bottom of the screen. The
 * other is the boxed inline layout kept for any legacy caller, where the
 * message list is itself a 40vh scroller.
 *
 * Every layout here ends in the chat foot Messages and the general chat end
 * in (@/components/ui/chat, "A chat's foot", 1 November 2026): the scroller
 * wears `chat-transcript`, so its transcript ends 12px inside it and it meets
 * the composer's card; Jump to latest hangs from its foot; the status line
 * takes no room until somebody types; the bar is `ChatComposerBar`. Each
 * layout used to give its typing slot a height of its own (`h-5`, `h-4`) and
 * its bar 4px of padding over the card (`pt-1`).
 *
 * In fill mode an optional header slot and the messages list share ONE scroll
 * container (#363), so a topic's card and its discussion scroll as one area.
 * The messages list does not scroll; the typing slot and composer are pinned
 * `shrink-0` siblings outside the scroller.
 *
 * ── The composer is shared with the general chat ──────────────────────
 *
 * The staged-reply chip, the attachment error, the pending-upload strip, the
 * form and the status line are ./composer.tsx's, rendered here with
 * `scope="thread"`. They were one renderer in public/js/group-chat.js — each
 * of them opening with `thread ? 'gc-thread-…' : 'gc-…'` — and they stay one
 * here. What this file keeps is the BAR around them, which really does differ
 * between the two panes: here the read-only notice REPLACES the bar, and in
 * the chat pane it sits inside it.
 *
 * ── Two hosts stay other owners' ──────────────────────────────────────
 *
 * Rendered once as empty elements with constant `className`, never looked
 * inside — the controller-host seam AGENTS.md documents:
 *
 *   * `#gc-thread-head` — the topic card, `innerHTML`'d by
 *     `AppView._renderTopicHead`. It is inside the scroller precisely so it
 *     survives the message list's rewrites.
 *   * `#gc-thread-messages` — the transcript's portal target. React renders
 *     the element and nothing else; `GroupChat.renderThread` mounts
 *     ./transcript.tsx into it.
 *
 * ── The composer's listeners are still attached, not props ────────────
 *
 * `mountThread` binds submit, input, keydown, the attachment wiring and both
 * autocompletes to the elements below, on the line after this renders. They
 * are LISTENERS on nodes — they write no markup — which is the split
 * app-grid.tsx makes for the canvas recognizer, and it keeps one owner for the
 * draft, the typing ping, the multi-line submit semantics and the Escape rule.
 */

import { useEffect, useRef, type RefObject } from 'react';

import { ChatComposerBar } from '@/components/ui/chat';
import { useMessages } from '../../lib/i18n/react';
import { armOnMove, readSplitWidth, splitKey, startSplitDrag, writeSplitWidth, type SplitDrag } from '../../lib/split-drag';
import { JumpToLatest } from '../messages/jump-to-latest';
import { ComposerForm, ComposerSlots, StatusLine } from './composer';

const SAFE_BAR = 'platform-safe-bar';

/**
 * THE LINE BETWEEN THE CARD AND "HOW IT GOT HERE" IS A HANDLE (18 Nov 2026),
 * on a wide page where the timeline stands beside the card: a grip under
 * the pointer, which moves the line. The timeline takes the width it is
 * dragged to (`--thread-rail-w`, app.css) between 260 and 520px, kept for
 * the next page; a double-click goes back to its 332px. Elsewhere the
 * timeline is under the card and app.css draws no handle.
 */
const RAIL_W_KEY = 'homeroom:thread-rail-w';
const RAIL_MIN = 260;

function RailDivider({ sheet }: { sheet: RefObject<HTMLElement | null> }) {
  const t = useMessages('project');
  const page = () => sheet.current?.closest<HTMLElement>('.dev-request') || null;
  const apply = (px: number | null) => {
    const el = page();
    if (!el) return;
    if (px == null) el.style.removeProperty('--thread-rail-w');
    else el.style.setProperty('--thread-rail-w', `clamp(${RAIL_MIN}px, ${Math.round(px)}px, 520px)`);
  };
  const now = () => {
    const rail = page()?.querySelector<HTMLElement>('#gc-thread-rail');
    return rail ? rail.getBoundingClientRect().width : 332;
  };
  const drag: SplitDrag = { start: now, apply, done: () => writeSplitWidth(RAIL_W_KEY, now()), trailing: true };
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    apply(readSplitWidth(RAIL_W_KEY, RAIL_MIN));
    return armOnMove(ref.current);
  }, []);
  return (
    <div
      ref={ref}
      className="dev-request-rail-divider split-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label={t('project:topic.rail.resize')}
      title={t('agent:sidePanel.resizeTitle')}
      tabIndex={0}
      data-rail-divider=""
      onPointerDown={(e) => startSplitDrag(e, drag)}
      onKeyDown={(e) => { if (splitKey(e.key, 24, drag)) e.preventDefault(); }}
      onDoubleClick={() => { writeSplitWidth(RAIL_W_KEY, null); apply(null); }}
    />
  );
}

/**
 * How near the bottom a thread counts as followed: a live reply, the reader's
 * own included, sticks to it within 80px, and so does the composer growing
 * (`THREAD_FOLLOW_PX`, `_handleThreadIncoming` and `_attachThreadFollow` in
 * public/js/group-chat.js).
 */
export const THREAD_FOLLOW_PX = 80;

export interface ThreadShellProps {
  /** The topic sub-view's full-height layout; false is the boxed one. */
  fill: boolean;
  /** Fill mode only: emit the in-scroll header slot the topic card fills. */
  withHeader: boolean;
  readOnly: boolean;
  /** The read-only wording, which replaces the composer entirely. */
  notice: string;
  placeholder: string;
  /** GC_MAX_MESSAGE_LEN, passed through so the module owns the number. */
  maxLength: number;
  /**
   * #4453: a request's page, drawn as the sheet Messages opens a reply thread
   * in. Fill mode only. See `RequestShell` below.
   */
  request?: boolean;
  /**
   * #4455: a change's page, the same sheet (`RequestShell`) with the change
   * as its root post. Fill mode only.
   */
  change?: boolean;
  /**
   * #6440: a governance vote's page — the same sheet again, with the vote as
   * its root post. Fill mode only.
   */
  decision?: boolean;
}

function Composer({ fill, readOnly, notice, placeholder, maxLength, request = false, change = false, decision = false }: ThreadShellProps) {
  // `platform-safe-bar` on BOTH variants: in fill mode this block is the
  // bottom of the screen, so it carries the home-indicator inset above its own
  // padding, and the read-only notice that replaces it needs the identical
  // clearance. In the boxed layout the bar is not screen-bottom-anchored, so
  // the inset is inert: harmless, and it keeps one class per role. The bar
  // gets it from ChatComposerBar, with the padding every chat's bar has; the
  // notice, which is a line of text rather than a bar round a card, keeps its
  // own padding and names the class itself.
  if (readOnly) {
    return (
      <div
        className={`px-3 py-2 text-xs text-zinc-500 dark:text-zinc-400 shrink-0 ${SAFE_BAR}`}
      >
        {notice}
      </div>
    );
  }
  if (request || change || decision) {
    return (
      <ChatComposerBar className="messages-composer messages-composer-thread">
        <ComposerSlots scope="thread" />
        <ComposerForm scope="thread" fill={fill} placeholder={placeholder} maxLength={maxLength} messages />
      </ChatComposerBar>
    );
  }
  return (
    <ChatComposerBar>
      <ComposerSlots scope="thread" />
      <ComposerForm scope="thread" fill={fill} placeholder={placeholder} maxLength={maxLength} />
    </ChatComposerBar>
  );
}

/**
 * #4453: a request's page — the sheet Messages opens a reply thread in
 * (features/messages/index.tsx `ReplyThreadPanel`): its header, a scroller
 * holding the request as the root post and the replies under it, and the
 * thread's composer at its foot. The page's back chip sits above the sheet.
 *
 * Three more empty hosts than the topic layout, all the topic head's
 * (features/dev-board/topic/request-head.tsx portals into them), rendered
 * once with a constant className and never looked inside:
 *
 *   * `#gc-thread-back` — the "‹ Workshop" chip, above the sheet.
 *   * `#gc-thread-bar` — the sheet's header: "Request #N", its category,
 *     and the ⋯ disc. Outside the scroller, so it stays put.
 *   * `#gc-thread-rail` — "How it got here", inside the scroller between the
 *     root post and the replies (a request's and a change's page only).
 *
 * Messages' tokens (`--messages-surface` and the rest) are defined on
 * `.dev-request` in app.css, as they are on `.messages-layout`.
 *
 * #4455: a change's page is the same sheet, with the change as its root post
 * (features/dev-board/topic/change-head.tsx). `.dev-change` beside
 * `.dev-request` is what app.css tells the two apart by.
 *
 * #6440: a governance vote's page is the same sheet a third time, with the
 * vote as its root post (features/dev-board/topic/governance-head.tsx); it
 * wears `.dev-decision` beside `.dev-request`, which is what app.css reads.
 */
function RequestShell(props: ThreadShellProps) {
  const t = useMessages('project');
  const scroll = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLElement>(null);
  const change = !!props.change;
  const decision = !!props.decision;
  // #6440: a decision opens at its TOP — its root post and Votes card are
  // what the page is for, not the newest reply. The thread renderer places
  // a chat at its bottom, and its history lands a paint or two later, so
  // hold the top for the first moment of the page; any scroll, wheel or
  // touch from the reader ends that at once and leaves the page to them.
  useEffect(() => {
    if (!decision) return undefined;
    const el = scroll.current;
    if (!el) return undefined;
    const started = performance.now();
    let raf = 0;
    const stop = () => { cancelAnimationFrame(raf); };
    const holdTop = () => {
      el.scrollTop = 0;
      const gc = (window as Window & { GroupChat?: { _threadPinned?: boolean } }).GroupChat;
      if (gc) gc._threadPinned = false;
      if (performance.now() - started < 1500) raf = requestAnimationFrame(holdTop);
    };
    raf = requestAnimationFrame(holdTop);
    el.addEventListener('pointerdown', stop, { once: true });
    el.addEventListener('wheel', stop, { once: true, passive: true });
    el.addEventListener('touchmove', stop, { once: true, passive: true });
    return () => {
      stop();
      el.removeEventListener('pointerdown', stop);
      el.removeEventListener('wheel', stop);
      el.removeEventListener('touchmove', stop);
    };
  }, [decision]);
  const cls = change ? 'dev-request dev-change platform-kb-column'
    : decision ? 'dev-request dev-decision platform-kb-column'
      : 'dev-request platform-kb-column';
  return (
    <div className={cls}>
      <div id="gc-thread-back" className="dev-request-back" />
      <section ref={sheet} className="dev-request-sheet dc-lift dc-lift-session" aria-label={change ? t('project:topic.change.sheetLabel') : decision ? t('project:topic.decision.sheetLabel') : t('project:topic.request.sheetLabel')}>
        {decision ? null : <RailDivider sheet={sheet} />}
        <div id="gc-thread-bar" className="dev-request-bar" />
        <div ref={scroll} id="gc-thread-scroll" className="messages-thread-scroll dev-request-scroll overscroll-contain chat-transcript">
          <div id="gc-thread-head" />
          {/* "How it got here", the thread's big events (dev-board/topic/
              thread-rail.tsx portals into it): between the root post and the
              replies, where a narrow page reads it; app.css stands it beside
              them on a wide one. A decision's page has none. */}
          {decision ? null : <div id="gc-thread-rail" className="dev-request-rail" />}
          <div id="gc-thread-messages" />
        </div>
        {/* Floating over the transcript's foot, with nothing behind it
            (1 Nov 2026). #4553 docked it in a strip of its own so it never
            covered the cards' buttons, but the strip cut the transcript off
            above it and read as a solid box; it is up only while the reader
            is up the page. */}
        <JumpToLatest scroller={scroll} slack={THREAD_FOLLOW_PX} />
        <StatusLine scope="thread" />
        <Composer {...props} />
      </section>
    </div>
  );
}

export function ThreadShell(props: ThreadShellProps) {
  const { fill, withHeader } = props;
  const scroll = useRef<HTMLDivElement>(null);
  if (fill && (props.request || props.change || props.decision)) return <RequestShell {...props} />;
  if (fill) {
    return (
      // `platform-kb-column` is what app.css hangs the keyboard reservation
      // on (#1937). It has to be the COLUMN, not the composer: the composer is
      // a `shrink-0` sibling below the scroller, so the kit's `.un-kb-avoid`
      // padding — which lands inside the scroller — can never lift it. The
      // boxed variant below does NOT take it: it is not screen-bottom-anchored,
      // so reserving keyboard space there would be dead space mid-page.
      <div className="dev-thread dev-thread-fill platform-kb-column flex flex-col h-full min-h-0 dc-lift dc-lift-session">
        <div
          ref={scroll}
          id="gc-thread-scroll"
          className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-3 pt-3 chat-transcript"
        >
          {withHeader ? <div id="gc-thread-head" /> : null}
          {/* `pt-2` alone: the transcript's end is the scroller's (above). */}
          <div id="gc-thread-messages" className="pt-2 space-y-0.5" />
        </div>
        {/* A topic opens at its card (#363), so the way down is up from the
            start whenever the discussion runs past the screen. It floats
            over the transcript's foot, as on a change's page (above). */}
        <JumpToLatest scroller={scroll} slack={THREAD_FOLLOW_PX} />
        <StatusLine scope="thread" />
        <Composer {...props} />
      </div>
    );
  }
  return (
    <div className="dev-thread border border-zinc-200 dark:border-zinc-800 rounded-xl flex flex-col bg-zinc-50/50 dark:bg-zinc-900/40">
      {/* The messages host is the scroller here, so it is what wears
          `chat-transcript`; its `pt-1` is its top alone. */}
      <div
        id="gc-thread-messages"
        className="overflow-y-auto px-2 pt-1 space-y-0.5 chat-transcript"
        style={{ maxHeight: '40vh', minHeight: '60px' }}
      />
      <StatusLine scope="thread" />
      <Composer {...props} />
    </div>
  );
}
