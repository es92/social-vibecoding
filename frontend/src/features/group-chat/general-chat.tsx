/**
 * The general chat pane — the message stream, the status line, the composer
 * and the spec side-panel's slot — as the only React writer below
 * `#dev-chat-body`.
 *
 * ── Props, not a store ────────────────────────────────────────────────
 *
 * Everything here is fixed for the life of one mount: the app's name, whether
 * the viewer is read-only, whether the first-arrival banner is due. It changes
 * only when `AppView.renderGroupChatTab` runs again, and `mountLegacyPortal`
 * re-renders with a new node and commits synchronously — so the props ARE the
 * publish. The parts that move while the pane is open (the staged reply and
 * the typing text) go through ./composer-store.ts; the box's own words,
 * files and menus are Messages' box's (./composer.tsx ChatComposer).
 *
 * ── The layout ────────────────────────────────────────────────────────
 *
 * A flex row holding the chat pane on the left and a slot for the spec side
 * panel on the right. The slot lives empty in the DOM so re-rendering this tab
 * does not tear down a panel the reader has open, and CSS switches it between
 * a side panel and a fullscreen modal at 1024px. The divider between them is
 * `display:none` until both the panel is open and the viewport is wide.
 *
 * ── Two hosts stay other owners' ──────────────────────────────────────
 *
 * `#gc-messages` is the transcript's portal target and `#gc-spec-side-panel`
 * is the spec reader's — both rendered here as empty elements with constant
 * `className`, and both mounted into by features/group-chat/mount.ts. That is
 * the same arrangement `#gc-thread-messages` has inside ./thread-shell.tsx,
 * and it carries the same obligation on the caller: drop the transcript's
 * portal BEFORE re-rendering this shell, because a layout change recreates the
 * element and a portal left pointing at a detached node keeps its subtree and
 * its store subscription alive.
 */

import { useMemo, useRef, useState, type RefObject } from 'react';

import { ChatComposerBar, NewMessagesBanner, TranscriptOverlay } from '@/components/ui/chat';
import { DropOverlay } from '../attachments/file-drag';
import { usePaneDrop } from '../messages/pane-drop';
import { useMessages } from '../../lib/i18n/react';
import { DetailSlot } from '../detail/detail-slot';
import { useStoreState } from '../../lib/use-store-state';
import { JumpToLatest } from '../messages/jump-to-latest';
import {
  firstUnreadId, newMessagesLabel, transcriptRow, useUnreadAffordances, type UnreadRow,
} from '../messages/unread-anchor';
import { ChatComposer, StatusLine, chatScopeKey, type ChatThreadRef } from './composer';
import { ReplyStarters } from './reply-starters';
import { transcriptStore, unreadOpenings } from './transcript-store';

/**
 * How near the bottom the channel counts as followed: public/js/group-chat.js
 * keeps `_lockedToBottom` within 50px, so Jump to latest is up exactly when
 * a new message would not be followed.
 */
export const GENERAL_FOLLOW_PX = 50;

const NO_ROWS: readonly UnreadRow[] = [];

/** The general stream's rows, as the unread pieces read them. */
function useChannelRows(): { rows: readonly UnreadRow[]; unread: { lastReadId: number; count: number } | null } {
  const main = useStoreState(transcriptStore).byKey.main;
  const messages = main ? main.messages : null;
  const rows = useMemo(() => (messages ? messages.map(transcriptRow) : NO_ROWS), [messages]);
  return { rows, unread: main?.lead.unread || null };
}

/**
 * "3 new messages" over the top of the stream, while the channel is open at
 * its "New" line (./transcript.tsx draws the line; group-chat.js and
 * ./mount.ts open the stream at it). Its own component, beside the stream,
 * so the pane around it holds no state.
 *
 * It starts counting from the OPENING (`unreadOpenings`): the stream is
 * moved to the line after the rows land, and where the line sat before that
 * is not the reader scrolling onto it. A stream that did not open at the
 * line (a message the bell sent them to) offers no banner.
 */
function ChannelUnreadBanner({ scroller }: { scroller: RefObject<HTMLElement | null> }) {
  const { rows, unread } = useChannelRows();
  const opened = useStoreState(unreadOpenings).count;
  const [atMount] = useState(opened);
  const line = useMemo(() => ({
    get current(): HTMLElement | null {
      return scroller.current?.querySelector<HTMLElement>('[data-unread-line]') || null;
    },
  }), [scroller]);
  const lineAt = unread ? firstUnreadId(rows, unread.lastReadId) : null;
  const { view, toLine } = useUnreadAffordances(scroller, line, {
    conversation: null,
    markKey: unread ? `${unread.lastReadId}:${opened}` : '',
    lineAt,
    rows,
    offerBanner: opened !== atMount,
    slack: GENERAL_FOLLOW_PX,
  });
  if (!unread) return null;
  return (
    <TranscriptOverlay edge="top">
      <NewMessagesBanner shown={view.banner} onClick={toLine}>{newMessagesLabel(unread.count)}</NewMessagesBanner>
    </TranscriptOverlay>
  );
}

/** Jump to latest over the stream's foot, with a dot for what arrived while the reader was up it. */
function ChannelJumpToLatest({ scroller }: { scroller: RefObject<HTMLElement | null> }) {
  const { rows } = useChannelRows();
  return <JumpToLatest scroller={scroller} slack={GENERAL_FOLLOW_PX} rows={rows} />;
}

export interface GeneralChatProps {
  /** The project the chat is; the box posts to it. */
  slug: string;
  /** #4417 follow-up: the topic's channel the pane shows; null for the project's own stream. */
  channel?: ChatThreadRef | null;
  readOnly: boolean;
  /**
   * What the read-only bar says, when it is not the usual "only
   * collaborators can post": Homeroom's old project discussion, kept as
   * history since #general became the Homeroom community's channel.
   */
  notice?: string | null;
  /**
   * #4417 follow-up: what the empty box says, when it is not the app's own
   * stream: a topic's channel says "Message #handle".
   */
  placeholder?: string;
}

export function GeneralChat({ slug, channel = null, readOnly, notice, placeholder }: GeneralChatProps) {
  const t = useMessages('chat');
  const messages = useRef<HTMLDivElement>(null);
  // #6254: the pane takes a dropped file as Messages' thread pane does: the
  // box at its foot uploads it (../messages/pane-drop.ts).
  const drop = usePaneDrop(chatScopeKey(slug, channel));
  return (
    <div className="flex flex-col h-full min-h-0 dc-lift dc-lift-session">
      <div className="gc-tab-body flex-1 flex min-h-0">
        {/* `platform-kb-column` (app.css): same shape as the topic thread —
            #gc-messages scrolls and the composer bar is a shrink-0 sibling
            below it — so the keyboard inset is reserved here, on the column. */}
        <div className="gc-chat-pane platform-kb-column relative flex-1 flex flex-col min-h-0" {...drop.handlers}>
          {/* Over the stream's top and its foot: siblings of #gc-messages,
              which stays the transcript's alone. The foot under it is the
              one every chat draws, Messages' included (@/components/ui/chat,
              "A chat's foot", 1 November 2026): the stream ends 12px inside
              #gc-messages (its `pt-2` is its top alone), then the status
              line, then the bar. */}
          <ChannelUnreadBanner scroller={messages} />
          <div ref={messages} id="gc-messages" className="flex-1 overflow-y-auto pt-2 space-y-0.5 chat-transcript" />
          <ChannelJumpToLatest scroller={messages} />
          <StatusLine scope="general" />
          {/*
              The bar (ChatComposerBar) is padded 0 12px 8px, and
              `platform-safe-bar` (app.css) adds the home-indicator inset
              under it. Messages' box draws its own (./composer.tsx); the
              read-only notice sits inside one too, so it clears the
              indicator as the box does.
          */}
          {readOnly ? (
            <ChatComposerBar>
              <div className="px-3 py-2 text-xs text-zinc-500 dark:text-zinc-400 text-center" data-gc-readonly-notice="">
                {notice || t('chat:group.readOnly.devSpace')}
              </div>
            </ChatComposerBar>
          ) : (
            <ChatComposer
              scope="general"
              slug={slug}
              thread={channel}
              placeholder={placeholder || t('chat:group.composer.placeholder')}
              scroller={messages}
              // Reply chips for somebody who has not said anything here yet,
              // once someone else has (./reply-starters.tsx). A tap fills the
              // box below; it does not send.
              above={<ReplyStarters />}
            />
          )}
          {drop.dragging ? <DropOverlay className="messages-drop-overlay" /> : null}
        </div>
        <DetailSlot surface="chat" resizerLabel={t('chat:group.specPanel.resize')} />
      </div>
    </div>
  );
}
