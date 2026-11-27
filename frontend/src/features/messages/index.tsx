import { openReport } from '../dialogs/report';
import {
  Fragment, memo, useDeferredValue, useCallback, useEffect, useMemo, useRef, useState,
  type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import {
  ChatStatusLine, JumpToLatestButton, NewMessagesBanner, NewMessagesDivider, TranscriptOverlay, groupsWithPrevious,
} from '@/components/ui/chat';
import {
  ArrowsPointingInIcon, ArrowsPointingOutIcon, ChatIcon, ChevronLeftIcon, EllipsisHorizontalIcon, ListBulletIcon,
  LockIcon, PlusIcon, SearchIcon, UserGroupIcon, XIcon,
  ChevronRightIcon, HashIcon,
} from '@/components/ui/icons';
import { setListClosed, useShowListButton } from '../ai/list-closed';
import { GroupedList, ListRow, ListRowMeta } from '@/components/ui/grouped-list';
import { Skeleton, SkeletonGroup } from '@/components/ui/skeleton';
import { placeUnderAnchor, type AnchorRect } from '../../lib/anchor-popover';
import { cardRunLabel, cardRunStarts } from '../../lib/card-runs';
import { useComposerKeyboard } from '../../lib/composer-keyboard';
import { dirSign, ownDirection } from '../../lib/i18n/direction';
import { useMessages } from '../../lib/i18n/react';
import { t as translate } from '../../lib/i18n/runtime';
import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { unmountLegacyPortal } from '../../lib/legacy-portals';
import { confirmAction } from '../../lib/confirm';
import { useMenuKeyboard } from '../../lib/menu-keys';
import { anchorRectOf, useAnchoredDismiss } from '../../lib/popover-dismiss';
import { matchesSearch } from '../../lib/search-rank.js';
import { agoStamp, timeOfDay } from '../../lib/timestamp';
import { getTimeZone, inZone, zonedDay } from '../../lib/time-zone';
import { useVisibilityHiddenClass } from '../../lib/visibility-store';
import * as api from './api';
import { BotActivitySync, isActivityMessage, isMovedActivity } from './bot-activity';
import { NO_PLAN_LAYOUT, asksWithQuestionsCard, isPlanMessage, planLayout } from './bot-plan';
import { botRequestNames, botThreadTitle, dotText, threadsAllowed } from './bot-shared';
import { BotWorkSync, loadBotWork, newestBotMessageId, useBotWork, useWorkChanged } from './bot-work';
import {
  PrivateThreadDoors, PrivateThreadFoot, PrivateThreadNote, isOwnPrivateThread, newProjectInvited, privateThreadName, privateThreadTitle, privateThreadWords, serverThreadName,
  usePrivateThread,
} from './private-thread-bar';
import { useLiveDraft } from './live-draft-bar';
import { ArtifactsButton } from './artifacts-button';
import { requestPageOf } from './request-page';
import { RequestTag, stripGroups, summaryParts } from './bot-strip';
import { useTrackOf } from './bot-track';
import { isPlusThreadOpener } from './bot-request';
import { firstRowInView, scrollCorrection, type MeasuredRow, type SavedPlace } from './list-place';
import { ThreadDoneMenu } from './private-thread-done';
import { MessageComposer } from './composer';
import { InboxToEnd } from './inbox-to-end';
import { ListDivider } from './list-divider';
import { usePaneDrop } from './pane-drop';
import { DropOverlay } from '../attachments/file-drag';
import { useMessagesDrawer } from './phone-drawer';
import { CreateConversationDialog } from './create-dialog';
import { ConversationMembersDialog } from './members-dialog';
import { fullTime, UserAvatar, senderName } from './format';
import { DiscussionRow, MessageRow } from './message-row';
import { useDismiss } from '../message-actions/use-dismiss';
import { ShareItemDialog } from './share-dialog';
import { ShareToDialog } from './share-to-dialog';
import { JumpToLatest } from './jump-to-latest';
import { ThreadPage } from '../group-chat/thread-page';
import { ThreadHeadCard } from '../dev-board/topic/thread-head';
import { centreInScroller, isNearBottom, isNearStart, isNearTop, LOAD_NEWER_SLACK_PX, needsMoreHistory, useStickToBottom } from './stick-to-bottom';
import {
  firstUnreadId, jumpLabel, lineTopIn, messageRow, newMessagesLabel, openingScrollTop, useLineHold, useUnreadAffordances,
} from './unread-anchor';
import {
  closeThread,
  embed,
  initializeMessagesStore,
  finishDirectBlock,
  jumpToPresent,
  loadConversations,
  loadNewer,
  loadOlder,
  loadOlderReplies,
  loadReplyThread,
  messagesController,
  open as openConversation,
  renameConversation,
  openThread,
  release,
  respond,
  setUserBlocked,
  selectConversation,
  setListCollapsed,
  scopeKey,
  syncChrome,
  followPlatformSlug,
  typingUsers,
  useChannelHandles,
  useMessagesSnapshot,
  type ComposerScope,
} from './store';
import { typingLine } from './typing-line';
import { BotWorkingCard, typingBesides, workingBot } from './bot-working';
import { DesignPane, DesignViewSwitch, isDesignRoot, isDesignThread, setDesignView, useDesignView } from './design-pane';
// (20 Nov 2026, I: the thread head's Artifacts button opens the column: ./artifacts-button.tsx.)
import { NewThreadPanel, startedThreadTitle, useNewThread } from './new-thread';
import { isBotMention, issueRefHref } from './channels';
import { AppIconContent, AppIconLink, appIconKind } from '../apps/app-card-view';
import { PageBackButton } from '../dev-board/workshop/page-back';
import { generalHubBack, openChannelHub, platformHubServed, platformSlug, usePlatformSlug } from './channel-hub';
import { ThreadActivityCard } from '../message-actions/thread-activity';
import { INBOX_QUERY_MAX, buildInbox, savedInboxQuery } from './inbox';
import { useSidebarRows } from '../nav/sidebar-rows';
import type { ConversationMessage, ConversationSummary, DiscussionMessage } from './types';

/*
 * ── The screen, in the widget language ─────────────────────────────────
 *
 * Messages is drawn on the LIFT LADDER (`.dc-lift` and its two
 * plane classes in app.css). The wallpaper is the ground. `.messages-layout`
 * is the frosted STRIP: it carries the screen's title, the New disc and the
 * conversation rows, drawn straight on it. The open conversation is the
 * frosted SHEET rising on the strip — `.messages-thread-pane` — and it
 * carries everything about that conversation: its title row with the
 * actions, the transcript, the typing line and the composer.
 *
 * The same construction at both widths. On a phone the list screen IS the
 * strip, and a thread is the strip's shoulder showing above the sheet; from
 * 768px up both panes render on one strip with the sheet beside the list.
 * That is what makes the two read as one screen at two widths rather than a
 * phone layout and a desktop layout.
 *
 * The transcript has ONE shape now, Discord's (#2783): every conversation —
 * a DM, a group, #general — is a named-row transcript, with consecutive
 * messages from one person grouped under a single name. DMs lost their
 * bubbles so that a chat reads the same whichever section it sits in.
 * ./message-row.tsx draws it.
 *
 * The LIST is the conversations with people, newest first, under one
 * People heading (./inbox.ts). The channels are drawn on their
 * communities' hubs, and changes in flight on the Homeroom bot tab, the
 * Homeroom menu and each project's Workshop.
 */

function openDialog(name: 'messagesCreate' | 'messagesMembers' | 'messagesShare', payload?: unknown) {
  window.UsernodeReact?.dialogs?.[name]?.open(payload);
}

function conversationPeer(conversation: ConversationSummary) {
  const currentUserId = typeof window !== 'undefined' ? Number(window.App?.user?.id) : 0;
  return conversation.peer || (conversation.kind === 'direct'
    ? conversation.members.find((member) => Number(member.id) !== currentUserId) || null
    : null);
}

/**
 * QA 2026-09-24 Q33a: who a direct conversation is WITH, for its name and
 * face. An accepted one is its peer. A request the viewer has not answered
 * yet carries no peer — the roster stays hidden until acceptance — but it
 * does carry its requester, deliberately, "so the recipient can decide"
 * (services/conversations.js serializeConversation). That requester IS the
 * other person of a direct request, so the row and the header name them
 * rather than reading "Direct message" over an anonymous "DM" tile.
 */
function directPerson(conversation: ConversationSummary) {
  if (conversation.kind !== 'direct') return null;
  return conversationPeer(conversation)
    || (conversation.membershipStatus === 'invited' ? conversation.requester || null : null);
}

/**
 * #5393: what a group row's tile is — the faces of the people in it, not the
 * title's first letters. Up to two of the other members, stacked in the same
 * 44px box the `lg` square takes, so the row's own geometry (the 74px
 * separator inset) holds. The viewer is never one of the faces. One other
 * member is their face at full size; nobody known keeps the title's
 * initials, as today. A member with no photo falls back to their initials
 * tile, the way avatars look everywhere else.
 */
function GroupFaces({ conversation }: { conversation: Pick<ConversationSummary, 'members' | 'title'> }) {
  const viewerId = typeof window !== 'undefined' ? Number(window.App?.user?.id) : 0;
  const others = conversation.members
    .filter((member) => member.status === 'member' && Number(member.id) !== viewerId)
    .slice(0, 2);
  if (others.length === 2) {
    return (
      <span className="messages-group-faces" aria-hidden="true">
        <UserAvatar user={others[0]} size="sm" shape="square" />
        <UserAvatar user={others[1]} size="sm" shape="square" />
      </span>
    );
  }
  if (others.length === 1) return <UserAvatar user={others[0]} size="lg" shape="square" />;
  return <UserAvatar user={null} title={conversation.title} size="lg" shape="square" />;
}

/**
 * The line a row draws under its name, as text: the one place it is put
 * together, because the search reads it too (phone review, 23 Nov 2026, #44:
 * a word standing in a row's preview answered "No messages match", since the
 * search knew only the names).
 *
 * #5393: in a group the preview names its last sender, the way #general's
 * row already does: "@name: …", or "You: …" when the viewer wrote it. A
 * message with no person behind it (a platform line) keeps the bare
 * summary. A direct message keeps its preview as it is, an invitation says
 * it is one to review, and the bot's own line (`botLine`) still wins where
 * it is given.
 */
function rowPreview(
  conversation: ConversationSummary,
  t: ReturnType<typeof useMessages>,
  botLine: string | null = null,
): string {
  if (conversation.membershipStatus === 'invited') {
    return conversation.kind === 'direct' ? t('messages:inbox.requestReview') : t('messages:inbox.invitationReview');
  }
  const groupSender = conversation.kind === 'group' ? conversation.latestMessage?.sender || null : null;
  if (groupSender?.id && conversation.latestSummary) {
    const viewer = typeof window === 'undefined' ? null : window.App?.user?.id;
    return Number(groupSender.id) === Number(viewer)
      ? t('messages:inbox.previewYou', { message: ownDirection(conversation.latestSummary) })
      : t('messages:inbox.previewBy', { username: groupSender.username, message: ownDirection(conversation.latestSummary) });
  }
  return ownDirection(botLine || conversation.latestSummary || '') || t('messages:inbox.noMessages');
}

/**
 * ONE LOOK (25 Nov 2026): a row's time is the compact age the agreed mockups
 * draw after the name ("2h", "1d", then "Nov 18"): agoStamp's own ladder
 * (#1808), its relative steps said without "ago". Its title keeps the whole
 * instant, as agoStamp's does.
 */
const ROW_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
function rowStamp(value: string | null | undefined): { text: string; title: string } {
  const stamp = agoStamp(value);
  const elapsed = Date.now() - (value ? Date.parse(value) : Number.NaN);
  if (!stamp.text || !Number.isFinite(elapsed) || elapsed < 60_000 || elapsed >= ROW_WEEK_MS) return stamp;
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return { text: translate('messages:inbox.ago.minutes', { count: minutes }), title: stamp.title };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { text: translate('messages:inbox.ago.hours', { count: hours }), title: stamp.title };
  return { text: translate('messages:inbox.ago.days', { count: Math.floor(hours / 24) }), title: stamp.title };
}

const ConversationRow = memo(function ConversationRow({ conversation, active, preview = null, rowKey }: {
  conversation: ConversationSummary;
  active: boolean;
  /** 16 Oct 2026: the Homeroom bot's row says what waits on you, not its last message. */
  preview?: string | null;
  /** #6508: the inbox entry's key, so the list can hold its place across a re-sort. */
  rowKey?: string;
}) {
  const t = useMessages('messages');
  const peer = directPerson(conversation);
  // #6118: the name is its own hover hint, so a row the layout ellipsises can
  // still be read whole without opening the conversation.
  const rowName = conversation.kind === 'direct' && peer ? senderName(peer, { bare: true }) : conversation.title;
  const invited = conversation.membershipStatus === 'invited';
  const unread = conversation.unreadCount > 0;
  // #1808: the shared ago ladder, which stops being relative at a week — a
  // conversation last spoken in during March read "412d", which is a duration
  // and not information. `title` carries the unelided instant either way.
  const activity = rowStamp(conversation.lastActivityAt);
  // THE SHARED ROW (@/components/ui/grouped-list.tsx). The inbox drew its own
  // two lines here, with the time at the end of the name's line and the count
  // at the end of the preview's; ListRowMeta is that pair as the row's
  // trailing column, so an unread row still says so three ways (the time in
  // ink, "2 new" under it, and the bold name the row always has) without a
  // third line. The open conversation is lit by its aria-current.
  return (
    <ListRow
      as="a"
      href={`#messages/${conversation.id}`}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        if (window.location.hash === `#messages/${conversation.id}`) {
          event.preventDefault(); selectConversation(conversation.id);
        }
      }}
      className="messages-conversation-row"
      aria-current={active ? 'page' : undefined}
      data-inbox-row={rowKey}
      data-inbox-bot={conversation.homeroomBot ? '' : undefined}
      data-inbox-unread={unread ? '' : undefined}
      chevron={false}
      leading={conversation.kind === 'group' && !invited
        ? <GroupFaces conversation={conversation} />
        : <UserAvatar user={conversation.kind === 'direct' ? peer : null} title={peer?.username || conversation.title} size="lg" shape="square" />}
      tooltip={rowName || undefined}
      title={<>{rowName}{conversation.kind === 'direct' && peer?.bot ? <span className="messages-bot-badge ms-1.5 align-[2px]">{t('messages:inbox.aiBadge')}</span> : null}</>}
      // An invitation's line is the action the row offers, so it takes the accent.
      subtitle={rowPreview(conversation, t, preview)}
      subtitleClassName={invited ? 'font-medium text-violet-700 dark:text-violet-400' : undefined}
      trailing={(
        <ListRowMeta
          tone={unread ? 'strong' : 'quiet'}
          top={<time dateTime={conversation.lastActivityAt} title={activity.title}>{activity.text}</time>}
          bottom={unread ? t('messages:inbox.newCount', { count: conversation.unreadCount }) : null}
        />
      )}
    />
  );
});

/**
 * What the "+" can start, in the order the popover lists them: the
 * conversations with people. A new chat with Homeroom bot starts on its own
 * tab.
 */
const NEW_CHOICES = [
  { key: 'direct', label: 'messages:inbox.new.direct.label', hint: 'messages:inbox.new.direct.hint' },
  { key: 'group', label: 'messages:inbox.new.group.label', hint: 'messages:inbox.new.group.hint' },
] as const;
type NewChoice = typeof NEW_CHOICES[number]['key'];

/** The kit's own answer to "is this a touch screen", as its sheets use it. */
function isTouchScreen(): boolean {
  const pu = typeof window !== 'undefined' ? (window as any).PlatformUI : null;
  return !!(pu && typeof pu.isTouch === 'function' && pu.isTouch());
}

function startNew(choice: NewChoice) {
  // DM and group are the create dialog, opened on the matching tab.
  openDialog('messagesCreate', choice);
}

/**
 * THE GUIDE (23 Nov 2026, #7040): what the pane beside the list says while
 * no conversation is open, for a look that draws the list and the pane side
 * by side from 768px (app.css; hidden everywhere else, where the pane's
 * heading and line stand alone). What Messages is for, the two ways to start
 * a conversation (the "+" menu's own choices, in its own words), and where
 * a project's channel is, which is not here.
 */
function MessagesGuide() {
  const t = useMessages('messages');
  return (
    <div className="messages-guide" data-messages-guide="">
      <span className="messages-guide-mark" aria-hidden="true"><ChatIcon /></span>
      <h2 className="messages-guide-title">{t('messages:guide.title')}</h2>
      <p className="messages-guide-body">{t('messages:guide.body')}</p>
      <div className="messages-guide-rows">
        {NEW_CHOICES.map((item) => (
          <button key={item.key} type="button" className="messages-guide-row" data-guide-new={item.key} onClick={() => startNew(item.key)}>
            <span className="messages-guide-glyph" aria-hidden="true">{item.key === 'direct' ? <PlusIcon /> : <UserGroupIcon />}</span>
            <span className="messages-guide-text">
              <b>{t(item.label)}</b>
              <span>{t(item.hint)}</span>
            </span>
            <ChevronRightIcon className="messages-guide-go" aria-hidden="true" />
          </button>
        ))}
        <a className="messages-guide-row" data-guide-channels="" href="#communities">
          <span className="messages-guide-glyph" aria-hidden="true"><HashIcon /></span>
          <span className="messages-guide-text">
            <b>{t('messages:guide.channels.label')}</b>
            <span>{t('messages:guide.channels.hint')}</span>
          </span>
          <ChevronRightIcon className="messages-guide-go" aria-hidden="true" />
        </a>
      </div>
      <p className="messages-guide-note">{t('messages:guide.bot')}</p>
    </div>
  );
}

/**
 * The "+" and its popover (#2778), beside the search since the filter strip
 * went (16 Oct 2026).
 *
 * The popover is placed and dismissed exactly as the vote picker's desktop
 * home is — lib/anchor-popover.ts and lib/popover-dismiss.ts are that code,
 * shared — and portalled to
 * the body so the list's own scroller cannot clip it.
 *
 * ON TOUCH IT OPENS THE DIALOG ITSELF (phone review #124, 23 Nov 2026). It
 * raised the kit's action sheet, Direct message or Group chat, and the
 * dialog that followed opened on a Direct | Group switch for the same
 * choice: one question asked twice, the first time in a sheet unlike any
 * other in the app. A tap opens the dialog on Direct, and its switch is the
 * one place the choice is made. A pointer keeps the menu (#2778), whose rows
 * also say what each is for.
 *
 * Nothing is rendered until the button is pressed, so the prerendered
 * document holds the button alone and hydration has nothing to disagree
 * about.
 *
 * KEYBOARD (QA 2026-09-24 Q18): opening moves focus to the first row, the
 * arrows move between rows, Escape and Tab close it back onto the "+"
 * (lib/menu-keys.ts). Before, Enter opened a menu that focus never reached:
 * it is portalled to the end of <body>, so Tab walked the whole page first.
 */
function NewMessageButton() {
  const t = useMessages('messages');
  const [rect, setRect] = useState<AnchorRect | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const open = !!rect;
  const shut = () => setRect(null);
  useAnchoredDismiss(open, [btnRef, popRef], shut);
  const menuKeys = useMenuKeyboard(open, popRef, btnRef, shut);
  // What the press opens, for a screen reader: read after hydration, so the
  // prerender and the first render agree on the menu.
  const [touch, setTouch] = useState(false);
  useEffect(() => { setTouch(isTouchScreen()); }, []);

  const toggle = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (open) { shut(); return; }
    if (isTouchScreen()) {
      startNew('direct');
      return;
    }
    setRect(anchorRectOf(event.currentTarget));
  };
  // Focus goes back to the "+" BEFORE the dialog opens, so the dialog's own
  // focus restore (the kit records what was focused when it presents) lands
  // on the button rather than on a row this close is about to unmount.
  const choose = (choice: NewChoice) => { btnRef.current?.focus({ preventScroll: true }); shut(); startNew(choice); };
  const pos = rect
    ? placeUnderAnchor(rect, { width: 260, height: 54 * NEW_CHOICES.length + 2 }, { width: window.innerWidth, height: window.innerHeight })
    : null;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        id="messages-new"
        className="messages-new-btn one-fab"
        aria-haspopup={touch ? 'dialog' : 'menu'}
        aria-expanded={open ? 'true' : 'false'}
        aria-label={t('messages:inbox.new.button')}
        title={t('messages:inbox.new.button')}
        onClick={toggle}
      >
        <PlusIcon aria-hidden="true" />
      </button>
      {open && pos ? createPortal(
        <div
          ref={popRef}
          id="messages-new-menu"
          className="messages-new-pop"
          role="menu"
          aria-label={t('messages:inbox.new.menuName')}
          style={{ top: `${pos.top}px`, left: `${pos.left}px` }}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={menuKeys.onKeyDown}
        >
          {NEW_CHOICES.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              data-new-choice={item.key}
              className="messages-new-option"
              onClick={() => choose(item.key)}
            >
              {item.key === 'direct' ? <ChatIcon aria-hidden="true" /> : null}
              {item.key === 'group' ? <UserGroupIcon aria-hidden="true" /> : null}
              <span className="min-w-0">
                <span className="messages-new-option-label">{t(item.label)}</span>
                <span className="messages-new-option-hint">{t(item.hint)}</span>
              </span>
            </button>
          ))}
        </div>,
        document.body,
      ) : null}
    </>
  );
}

/**
 * The list's heading (16 Oct 2026): DMs & groups in small caps (People until
 * 24 Nov 2026, though it held group chats too), and how many messages from
 * people are unread ("3 unread"). It was the second of two headings until
 * Agents left the list (16 Nov 2026), and it stays: it says what the rows
 * are, and carries the count. It does not fold.
 */
function PeopleHead({ aside }: { aside: string | null }) {
  const t = useMessages('messages');
  return (
    <h3 className="messages-section-head" data-inbox-section="people">
      <span className="messages-section-name">{t('messages:inbox.section.people')}</span>
      {aside ? <span className="messages-section-aside">{aside}</span> : null}
    </h3>
  );
}

/**
 * Narrow the inbox by what a row SAYS, not by what it is.
 *
 * A CLIENT-SIDE MATCH over the three lists already in memory, so it answers
 * on every keystroke and adds no endpoint. What it matches is the text each
 * row draws — a person's name or a group's title, and (#44, 23 Nov 2026) the
 * preview line under it, `rowPreview` — because a search that found rows by a
 * field the reader cannot see would return results they cannot explain, and
 * one that missed a word standing on the row cannot be explained either.
 * Nothing earlier in a conversation is read: the field says what it searches
 * ("Search people and chats"), and its empty state says so again.
 *
 * It composes with the filter rather than replacing it: the strip says which
 * kinds, this says which of them, and an empty query is every row.
 */
function inboxMatches(text: string | null | undefined, query: string): boolean {
  return matchesSearch(query, text);
}

/**
 * The conversation list's loading state, at the ROW's own geometry.
 *
 * It was a spinner beside the words "Loading conversations…" — a fixed mark
 * that says "busy, somewhere" over an empty pane. These say where the
 * conversations are going and roughly how many, so the arriving rows land on
 * their own outlines instead of replacing a centred line of grey text.
 *
 * The placeholders ARE the shared row in the shared card, not an imitation
 * of them: ListRow owns the padding, the gap and the inset separator, and
 * GroupedList the card. Borrowing them means the placeholder cannot drift
 * from the row the first time any of those move, and the separator between
 * placeholders is drawn for free, which is most of what makes a list read as
 * a list.
 *
 * Six, because the pane is taller than that on every phone and a list that
 * stops halfway reads as a short list rather than a loading one.
 */
function ConversationRowSkeleton() {
  const t = useMessages('messages');
  return (
    <SkeletonGroup label={t('messages:inbox.loading')}>
      <GroupedList className="mx-0">
        {Array.from({ length: 6 }, (_, i) => (
          <ListRow
            key={i}
            chevron={false}
            // The `lg` square UserAvatar's 44px box.
            leading={<Skeleton shape="block" className="w-11 h-11 shrink-0 rounded-xl" />}
            title={<Skeleton className={i % 2 ? 'w-28' : 'w-36'} />}
            subtitle={<Skeleton shape="muted" className={i % 3 ? 'w-3/5' : 'w-2/5'} />}
            // The trailing time's short bar.
            trailing={<Skeleton shape="muted" className="w-8 self-start" />}
          />
        ))}
      </GroupedList>
    </SkeletonGroup>
  );
}

/**
 * #6508: the selector for one row's key (./inbox.ts), escaped where
 * `CSS.escape` exists (every browser that draws the shell) and quoted with
 * its own quotes and backslashes escaped where it does not, so no key can
 * break the selector.
 */
function keyedRow(key: string): string {
  const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(key)
    : key.replace(/["\\\n\r\f]/g, (ch) => `\\${ch}`);
  return `[data-inbox-row="${escaped}"]`;
}

function ConversationList({ drawer = false }: {
  /** The phone's drawer holds the screen (./phone-drawer.tsx): the list stays drawn beside a conversation. */
  drawer?: boolean;
} = {}) {
  const t = useMessages('messages');
  const snap = useMessagesSnapshot();
  // The search: REMEMBERED PER DEVICE SINCE #5459, AND STILL NOT IN THE STORE. A
  // person narrows the list, leaves, and comes back: the query survives
  // that, kept in localStorage (`usernode:messages-query`, ./inbox.ts), so
  // the visit starts narrowed the way the last one ended. It is kept out
  // of the store because nothing else reads what was typed here — and the
  // field itself is where the reason rows are missing shows, so a restored
  // query never hides rows with nothing on screen saying why. The value is
  // read after mount, so the first render and the prerendered shell both
  // show an empty field and hydration matches. (The filter the old comment
  // was written for IS in the store, because the thread pane and the
  // deep-link router both read it.)
  const [query, setQuery] = useState('');
  // Restore the last search one commit after mount. An unusable or absent
  // saved value leaves the field empty, and storage that throws (private
  // mode, blocked) is the same as never having typed.
  useEffect(() => {
    try {
      const saved = savedInboxQuery(localStorage.getItem('usernode:messages-query'));
      if (saved) setQuery(saved);
    } catch { /* storage unavailable */ }
  }, []);
  // Save the search on each keystroke, before the field updates. A write
  // that throws is skipped and the list still narrows exactly as it did
  // before the remembering; clearing the field removes the key, so the next
  // visit starts empty; a search past the cap is not kept at all, rather
  // than stored cut.
  const changeQuery = useCallback((value: string) => {
    try {
      if (value && value.length <= INBOX_QUERY_MAX) localStorage.setItem('usernode:messages-query', value);
      else localStorage.removeItem('usernode:messages-query');
    } catch { /* storage unavailable */ }
    setQuery(value);
  }, []);
  // The list filters on the DEFERRED query: the field takes the keystroke at
  // once, and the rows follow in a render React can interrupt with the next
  // one, so typing a word into a long inbox does not wait on it per letter.
  const deferredQuery = useDeferredValue(query);
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  // Built once per change to what it is built from, not once per keystroke
  // in the search box or per publish of a store this list does not draw.
  const inbox = useMemo(() => buildInbox({
    conversations: snap.conversations,
  }), [snap.conversations]);
  const byConversation = useMemo(() => new Map(snap.conversations.map((item) => [String(item.id), item])), [snap.conversations]);

  // 16 Oct 2026: what the Homeroom bot's row says. What waits on you and
  // what it is doing ("1 needs you · 2 in progress", ./bot-strip.tsx
  // summaryParts), counted from your requests' tracks once this list is up;
  // its last message until then. #5392: the row stays current: read again
  // whenever the list opens and a request's stage moves (./bot-work.tsx).
  const botWork = useBotWork();
  const botConversation = snap.conversations.find((item) => item.homeroomBot && item.kind !== 'channel') || null;
  useEffect(() => {
    if (mounted && botConversation) loadBotWork();
  }, [mounted, botConversation?.id, botConversation?.lastActivityAt]);
  useWorkChanged(!!botConversation);
  const botLine = useMemo(() => {
    if (!botWork.work) return null;
    const parts = summaryParts(stripGroups(botWork.work));
    return parts.length ? parts.slice(0, 2).map((part) => part.text).join(' · ') : null;
  }, [botWork.work]);

  const q = deferredQuery.trim();
  const matches = (entry: { kind: string; key: string }) => {
    if (!q) return true;
    if (entry.kind === 'person') {
      const c = byConversation.get(entry.key.slice('person:'.length));
      if (!c) return false;
      const peer = directPerson(c) || conversationPeer(c);
      return inboxMatches(c.title, q)
        || inboxMatches(peer?.username, q)
        || inboxMatches(peer?.displayName, q)
        || inboxMatches(rowPreview(c, t, c.homeroomBot ? botLine : null), q);
    }
    return false;
  };
  const found = inbox.filter(matches);

  // What the heading says: the messages from people you have not read. A
  // zero says nothing. Unread is new to read, grey like every unread count
  // since #18 (19 Oct 2026 polish board); the accent is for what waits on
  // you.
  const unreadFromPeople = snap.conversations
    .filter((item) => !item.homeroomBot && item.kind !== 'channel')
    .reduce((sum, item) => sum + Math.max(0, Number(item.unreadCount) || 0), 0);
  const unreadAside = unreadFromPeople ? t('messages:inbox.section.unread', { count: unreadFromPeople }) : null;

  // #6508: the list keeps its place while it updates live (./list-place.ts).
  // The row at the top of what the reader sees is noted on every scroll, and
  // a live re-sort puts that same row back where it was. At the very top
  // nothing is held, so new rows arrive there as they always have; the
  // browser's own anchoring is switched off for this scroller in app.css,
  // because it was the one dragging the list with a row that had moved.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const anchor = useRef<SavedPlace | null>(null);
  const readAnchor = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollTop <= 0) { anchor.current = null; return; }
    const box = el.getBoundingClientRect();
    const rows: MeasuredRow[] = [];
    const nodes = el.querySelectorAll<HTMLElement>('[data-inbox-row]');
    for (const node of Array.from(nodes)) {
      const key = node.dataset.inboxRow;
      if (!key) continue;
      const rect = node.getBoundingClientRect();
      rows.push({ key, top: rect.top - box.top, bottom: rect.bottom - box.top });
    }
    anchor.current = firstRowInView(rows, 0);
  }, []);
  // The reader changing the list (a search) drops the held place: that is
  // them moving the list, not it moving itself.
  const listShape = deferredQuery;
  const lastShape = useRef(listShape);
  useIsomorphicLayoutEffect(() => {
    if (lastShape.current === listShape) return;
    lastShape.current = listShape;
    anchor.current = null;
  }, [listShape]);
  // After a commit that changes the order (a live re-sort, or the bot's line
  // changing its row's height), put the saved row back at its offset. The
  // scroll event our own write fires records the same row again, so this
  // settles in one step rather than looping.
  const orderKey = `${found.map((entry) => entry.key).join('|')}\u0000${botLine || ''}`;
  useIsomorphicLayoutEffect(() => {
    const el = scrollRef.current;
    const saved = anchor.current;
    // A list the layout has taken off screen (the phone's drawer behind an
    // open conversation) measures every row at zero; correcting there would
    // move it while nobody can see it.
    if (!el || !saved || !el.clientHeight) return;
    const box = el.getBoundingClientRect();
    let row: Element | null = null;
    try {
      row = el.querySelector(keyedRow(saved.key));
    } catch { row = null; }
    const nowTop = row ? row.getBoundingClientRect().top - box.top : null;
    const delta = scrollCorrection(saved, nowTop, 0);
    if (delta) el.scrollTop += delta;
  }, [orderKey]);

  return (
    <section className={`messages-list-pane ${drawer ? 'flex' : snap.route.conversationId || snap.route.appSlug ? 'hidden md:flex' : 'flex'}`} aria-label={t('messages:inbox.listName')}>
      {/* THE SCREEN NAMES ITSELF ONCE (#2718 review). An <h2> reading
          "Messages" sat here, under a bar already reading Messages — two
          titles, one word, an inch apart. The bar is the title now, which is
          what it is for on every other screen in the shell.

          A SEARCH TAKES ITS PLACE, because a list that can run to hundreds of
          rows and holds three kinds of thing needs a way to name one. The
          "+" that starts something is beside it, since the filter strip it
          ended went (16 Oct 2026): the sections' headings say which is
          which. */}
      <div className="messages-toolbar">
        <div className="messages-search">
          <SearchIcon className="messages-search-glyph w-5 h-5" aria-hidden="true" />
          <input
            id="messages-search"
            type="search"
            className="messages-search-input"
            placeholder={t('messages:inbox.searchPlaceholder')}
            aria-label={t('messages:inbox.searchLabel')}
            value={query}
            onChange={(e) => changeQuery(e.currentTarget.value)}
            // #44: a phone capitalised the first letter typed, which is
            // not what a name or a word from a message is searched by.
            autoCapitalize="none"
          />
        </div>
        <NewMessageButton />
      </div>
      {/* No offline strip of its own (the native-offline proposal): the
          header's connection status says it for every screen, and a message
          written meanwhile says it was queued on its own row. */}
      {/* #1953: a click on the list's own blank space — below the last row,
          not on a row or a button — closes the open conversation, as it
          would in a desktop mail client. Only the list itself counts
          (`target === currentTarget`), so no row, empty state or retry
          button is affected. On a phone the list is hidden while a thread is
          open, so this is a two-pane (md+) gesture. */}
      <div
        className="messages-list-scroll platform-safe-scroll"
        data-page-bounce=""
        ref={scrollRef}
        onScroll={readAnchor}
        onClick={(e) => {
          if (e.target === e.currentTarget && snap.route.conversationId) openConversation(null);
        }}
      >
        {snap.loadingList && !snap.listLoaded ? <ConversationRowSkeleton /> : null}
        {snap.error ? <div className={snap.errorOffline ? 'messages-state' : 'messages-state messages-state-error'}><p>{snap.error}</p><button type="button" onClick={() => void loadConversations(true)}>{t('core:common.tryAgain')}</button></div> : null}
        {/* Nothing in the list: what the list draws, not what was read.
            #general is always read (every account is in it) and is drawn on
            Homeroom's hub, never here (./inbox.ts), so a new account's
            Messages was a search box over nothing (sign-up test, 19 Oct
            2026). */}
        {!snap.loadingList && !snap.error && snap.listLoaded && !inbox.length
          ? <div className="messages-empty"><h3>{t('messages:inbox.empty.title')}</h3><p>{t('messages:inbox.empty.body')}</p><button type="button" onClick={() => openDialog('messagesCreate')}>{t('messages:inbox.empty.action')}</button></div>
          : null}
        {/* A QUERY THAT MATCHED NOTHING is not an empty inbox, and must not
            borrow the empty inbox's offer to start a conversation: the rows
            are there, this one word is what hid them. */}
        {!snap.loadingList && !snap.error && snap.listLoaded && inbox.length && !found.length
          ? (
            // #44: it says what was searched, and offers the way back to the
            // whole list, so the page is not one grey line over nothing.
            <div id="messages-search-empty" className="messages-state">
              <p>{t('messages:inbox.searchEmpty', { query: deferredQuery.trim() })}</p>
              <p>{t('messages:inbox.searchEmptyHint')}</p>
              <button type="button" onClick={() => changeQuery('')}>{t('messages:inbox.searchClear')}</button>
            </div>
          )
          : null}
        {/* PEOPLE, HEADED (16 Oct 2026): the rows sit in a card under their
            heading, the grouped list's label-over-card shape; on a desktop
            the column draws them as the Communities column draws its places
            (app.css). The list's one section since Agents left it (16 Nov
            2026): the heading still says what the rows are, and how many
            messages in them are unread. */}
        {found.length ? (
          <>
            <PeopleHead aside={unreadAside} />
            <GroupedList className="mx-0 mb-4" data-inbox-card="people">
              {found.map(inboxRow)}
            </GroupedList>
          </>
        ) : null}
      </div>
      <InboxToEnd scroller={scrollRef} />
      {/* Desktop polish 09: the line between the list and the pane beside
          it is a handle (./list-divider.tsx). After the foot, which has to
          stay the scroller's next sibling (app.css, the inbox's fade). */}
      <ListDivider />
    </section>
  );

  function inboxRow(entry: { kind: string; key: string }) {
    if (entry.kind === 'person') {
      const conversation = byConversation.get(entry.key.slice('person:'.length));
      return conversation
        ? (
          <ConversationRow
            key={entry.key}
            conversation={conversation}
            active={snap.route.conversationId === conversation.id}
            preview={conversation.homeroomBot ? botLine : null}
            rowKey={entry.key}
          />
        )
        : null;
    }
    return null;
  }
}

function InvitationBanner() {
  const t = useMessages('messages');
  const snap = useMessagesSnapshot();
  const active = snap.active;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!active || active.membershipStatus !== 'invited') return null;
  const conversationId = active.id;
  const requesterUser = active.requester;
  async function answer(action: 'accept' | 'decline') {
    setBusy(true); setError('');
    try { await respond(action); }
    catch (err) { setError(err instanceof Error ? err.message : t('messages:invitation.error.respond')); }
    finally { setBusy(false); }
  }
  async function declineAndBlock() {
    const requesterId = requesterUser?.id;
    if (!requesterId) return;
    setBusy(true); setError('');
    try {
      // Blocking is also the server-side decline for every still-pending
      // direct/group invitation from this requester. Purge this invitation
      // locally as soon as that consent decision commits.
      await api.setBlock(requesterId, true);
      await finishDirectBlock(conversationId);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('messages:invitation.error.declineBlock'));
    } finally { setBusy(false); }
  }
  return (
    <div className="messages-invitation">
      <div className="min-w-0 flex-1"><strong>{active.kind === 'direct' ? t('messages:invitation.messageRequest') : t('messages:invitation.groupInvitation')}</strong>{active.kind === 'group' ? <p className="messages-invitation-group">{t('messages:invitation.groupSummary', { title: active.title, count: active.memberCount || 0 })}</p> : null}{active.inviteNote ? (<><p>{requesterUser?.unnamed ? t('messages:invitation.addedYouWithNoteUnknown', { note: active.inviteNote }) : requesterUser?.username ? t('messages:invitation.addedYouWithNote', { username: requesterUser.username, note: active.inviteNote }) : t('messages:invitation.addedYouWithNoteSomeone', { note: active.inviteNote })}</p><p>{t('messages:invitation.historyNotice')}</p></>) : (<p>{requesterUser?.unnamed ? t('messages:invitation.invitedByUnknown') : requesterUser?.username ? t('messages:invitation.invitedBy', { username: requesterUser.username }) : t('messages:invitation.invitedBySomeone')}</p>)}{error ? <span role="alert">{error}</span> : null}</div>
      <div className="messages-invite-actions">
        <button type="button" disabled={busy} onClick={() => void answer('decline')} className="messages-invite-decline">{t('messages:invitation.decline')}</button>
        {requesterUser?.id ? <button type="button" disabled={busy} onClick={() => void declineAndBlock()} className="messages-invite-block">{requesterUser.unnamed ? t('messages:invitation.declineAndBlockUnknown') : t('messages:invitation.declineAndBlock', { username: requesterUser.username })}</button> : null}
        <button type="button" disabled={busy} onClick={() => void answer('accept')} className="messages-invite-accept">{t('messages:invitation.accept')}</button>
      </div>
    </div>
  );
}

/**
 * #2387: FULL WIDTH. On a desktop the list and the open discussion sit side
 * by side; this folds the list away so the discussion (and a thread beside
 * it) has the whole width, and brings it back. Only the list: the platform's
 * own sidebar is navigation and stays. It is remembered on this device.
 *
 * ONE CONTROL, ONE PLACE, EVERY PANE. It sits at the right of the header,
 * just before ⋯ where a pane has one — where a video player or a document
 * editor puts its full-screen control — on a conversation, #general and an
 * app's channel alike.
 *
 * The glyph is the verb a press performs: arrows out while the list is
 * shown, arrows in once it is hidden. A phone shows one pane at a time
 * already, so there it is not drawn (app.css).
 *
 * It only widens the pane. (`data-bot-work-keep` is kept from when the
 * bot's activity panel stayed open through it, #3770.)
 */
function FullWidthToggle() {
  const t = useMessages('messages');
  const snap = useMessagesSnapshot();
  const collapsed = snap.listCollapsed;
  // A channel is always full width (see the layout's note), so a toggle for
  // a list it never shows would do nothing.
  if (snap.route.appSlug || (snap.active?.kind === 'channel' && snap.active.id === snap.route.conversationId)) return null;
  const label = collapsed ? t('messages:header.showList') : t('messages:header.fullWidth');
  return (
    <button
      type="button"
      className="messages-thread-action messages-list-toggle"
      aria-pressed={collapsed}
      aria-label={label}
      title={label}
      data-bot-work-keep=""
      onClick={() => setListCollapsed(!collapsed)}
    >
      {collapsed ? <ArrowsPointingInIcon aria-hidden="true" /> : <ArrowsPointingOutIcon aria-hidden="true" />}
    </button>
  );
}

/**
 * The sheet's title row: who this conversation is with, and its actions as
 * floating discs. No back control of its own — on a phone the platform
 * header's back arrow already points at the list (see syncChrome in
 * ./store.ts), and a second one here was the same affordance twice.
 * #general is the exception: a channel goes back up to its hub, not to this
 * list, and like the hub's own pages it says so in the page (#3407).
 */
/**
 * ONE LOOK (25 Nov 2026): what the phone's bar says over a conversation.
 * "Messages", the screen it is in, beside the arrow back
 * to the list; the conversation names itself in its own title card
 * (ThreadHeader), the way a request's page does.
 */
export function barWords(): { title: string; sub: string } {
  return { title: translate('core:header.drawer.messages'), sub: '' };
}

function ThreadHeader() {
  const t = useMessages('messages');
  const snap = useMessagesSnapshot();
  const active = snap.active;
  // ONE LOOK (25 Nov 2026): a conversation is drawn as a request's thread
  // is, on a phone as on a desktop: the bar says Messages (barWords, above)
  // and the page opens on a title card of its own, with the face, "Direct
  // message" over the name, and the discs.
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  // QA 2026-09-24 Q18: the ⋯ menu is a real menu now. It closes on a press
  // outside it and on Escape (it used to stay open until its own button was
  // pressed again), takes focus to its first row when it opens, moves
  // between rows on the arrow keys, and hands focus back to the ⋯ on
  // Escape. Hooks before the early return below, so their order is stable.
  const menuWrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  // #3407: #general's hub is the platform project's, whose slug may land
  // after this header first draws (channel-hub.ts), so it is subscribed to;
  // the disc's label and its press come from that one value.
  const hubBack = generalHubBack(usePlatformSlug(active?.kind === 'channel'));
  const closeMenu = () => setMenu(false);
  useDismiss(menu, [menuWrapRef, menuRef], closeMenu);
  const toggleMenu = () => {
    setMenu((open) => !open);
  };
  const menuKeys = useMenuKeyboard(menu, menuRef, menuBtnRef, closeMenu);
  // Another conversation is another header: a menu left open does not follow.
  useEffect(() => { setMenu(false); }, [active?.id]);
  const peer = active ? conversationPeer(active) : null;
  if (!active) return null;
  async function blockPeer() {
    if (!peer) return;
    // The menu goes first and focus returns to the ⋯, so the confirm below
    // hands focus back there whichever way it is answered.
    menuBtnRef.current?.focus({ preventScroll: true });
    setMenu(false);
    // QA 2026-09-24 Q15: the app's own confirm (lib/confirm.ts), not the
    // browser's, which some webview hosts suppress.
    const ok = await confirmAction({
      title: peer.unnamed ? (peer.id ? t('messages:header.block.titleUnknownHandle') : t('messages:header.block.titleUnknown')) : t('messages:header.block.title', { name: senderName(peer, { bare: active.kind === 'direct' }) }),
      message: t('messages:header.block.message'),
      confirmLabel: t('messages:header.block.confirm'),
      danger: true,
    });
    if (!ok) return;
    const conversationId = active?.id;
    if (!conversationId) return;
    setBusy(true);
    try { await setUserBlocked(peer.id, true); }
    catch (err) { window.PlatformUI?.toast?.(err instanceof Error ? err.message : t('messages:header.block.failed')); }
    finally { setBusy(false); setMenu(false); }
  }
  // QA 2026-09-24 Q14: rename, for whoever the server lets rename — the
  // group's owner (`canManage`, the same gate PATCH /api/conversations/:id
  // applies). The kit's own one-field dialog, pre-filled with the name.
  async function renameGroup() {
    setMenu(false);
    const current = active?.title || '';
    // PlatformUI.prompt (public/js/platform-ui.js) is the kit alert's inset
    // text field, resolving the string or null on Cancel.
    const ui = window.PlatformUI as undefined | {
      prompt?: (opts: { title: string; value?: string; placeholder?: string; confirmLabel?: string; maxLength?: number }) => Promise<string | null>;
      toast?: (message: string) => void;
    };
    if (!ui?.prompt) return;
    const next = await ui.prompt({ title: t('messages:header.rename.title'), value: current, placeholder: t('messages:header.rename.placeholder'), confirmLabel: t('core:common.save'), maxLength: 80 });
    if (next == null) return;
    try { await renameConversation(next); }
    catch (err) { ui.toast?.(err instanceof Error ? err.message : t('messages:header.rename.failed')); }
  }
  const channel = active.kind === 'channel';
  const invited = active.membershipStatus === 'invited';
  // #3692: the Homeroom bot's DM says what the bot is doing where a DM says
  // "Direct message", and its Activity disc, before the full-width toggle,
  // opens the activity panel (./bot-work.tsx), working or not. #3770: the
  // disc, not the name block, which nobody read as a control.
  const botDm = active.kind === 'direct' && !!active.homeroomBot && active.membershipStatus === 'member';
  // Polish N15: the Homeroom bot is the platform, not a person, so its ⋯
  // offers no "Block Homeroom bot" or "Report user". What there is to say
  // about a bot goes to Homeroom as feedback, which its menu offers instead.
  const withBot = active.kind === 'direct' && !!active.homeroomBot;
  // QA 2026-09-24 Q33a: an unanswered request names its requester.
  const person = directPerson(active);
  // #6118: the header ellipsises its name, so the name is also its hover hint.
  const threadName = active.kind === 'direct' && person
    ? senderName(person, { bare: true })
    : channel ? `#${active.channelKey || active.title}` : active.title;
  // QA 2026-09-24 Q14: "1 member", not "1 members". An invitee is not shown
  // the roster until they accept, so the count the server gives them is 0 —
  // they read the invitation's state instead of "0 members".
  const said = channel
    ? t('messages:header.subtitle.channel', { count: active.memberCount })
    : invited
      ? t('messages:header.subtitle.invited')
      : active.kind === 'group'
        ? (active.myRole === 'owner'
          ? t('messages:header.subtitle.groupOwner', { count: active.memberCount })
          : t('messages:header.subtitle.group', { count: active.memberCount }))
        : active.awaitingAcceptance ? t('messages:header.subtitle.requestPending') : t('messages:header.subtitle.direct');
  // N14 (19 Oct polish board): the people asked who have not joined yet are
  // said beside the members, since a group's name can already list them.
  const asked = active.kind === 'group' && !invited ? active.members.filter((m) => m.status === 'invited').length : 0;
  const subtitle = asked ? dotText([said, t('messages:header.subtitle.invitedCount', { count: asked })]) : said;
  // N14: a group leads with its members' faces, not the initials of its
  // name ("E+" for "Evan + Lukas"). Audit C02: the same faces its row in
  // the list draws (GroupFaces), not one of them, so the group is one
  // picture in both places.
  const groupFaces = active.kind === 'group' && !invited;
  const discs = (
    <>
      {active.kind === 'group' ? <button type="button" onClick={() => openDialog('messagesMembers')} className="messages-thread-action" aria-label={t('messages:header.groupMembers')} title={t('messages:header.groupMembers')}><UserGroupIcon aria-hidden="true" /></button> : null}
      <FullWidthToggle />
      <div className="relative" ref={menuWrapRef}>
        <button ref={menuBtnRef} type="button" onClick={toggleMenu} className="messages-thread-action" aria-label={t('messages:header.actions')} aria-haspopup="menu" aria-expanded={menu}><EllipsisHorizontalIcon aria-hidden="true" /></button>
        {menu ? (
          <div
            ref={menuRef}
            className="messages-thread-menu"
            role="menu"
            aria-label={t('messages:header.actions')}
            onKeyDown={menuKeys.onKeyDown}
          >
            {active.kind === 'group' && active.canManage
              ? <button type="button" role="menuitem" data-rename-group="" onClick={() => { menuBtnRef.current?.focus({ preventScroll: true }); void renameGroup(); }}>{t('messages:header.menu.rename')}</button>
              : null}
            {active.kind === 'group'
              ? <button type="button" role="menuitem" onClick={() => { menuBtnRef.current?.focus({ preventScroll: true }); setMenu(false); openDialog('messagesMembers'); }}>{t('messages:header.menu.members')}</button>
              : withBot
                ? <button type="button" role="menuitem" data-bot-feedback="" onClick={() => { menuBtnRef.current?.focus({ preventScroll: true }); setMenu(false); (window as unknown as { App?: { openFeedbackModal?: () => void } }).App?.openFeedbackModal?.(); }}>{t('messages:header.menu.botFeedback')}</button>
                : active.kind === 'direct'
                  ? <button type="button" role="menuitem" disabled={busy || !peer} onClick={() => void blockPeer()} className="text-red-700 dark:text-red-400">{!peer ? t('messages:header.menu.blockUnknown')
                    : peer.unnamed ? (peer.id ? t('messages:header.menu.blockUnnamedHandle') : t('messages:header.menu.blockUnnamed'))
                      : t('messages:header.menu.block', { name: senderName(peer, { bare: active.kind === 'direct' }) })}</button>
                  : null}
            {peer && !withBot ? <button type="button" role="menuitem" onClick={() => { menuBtnRef.current?.focus({ preventScroll: true }); setMenu(false); openReport({ targetType: 'user', target: peer.username, label: senderName(peer, { bare: active.kind === 'direct' }), userId: peer.id }); }}>{t('messages:header.menu.report')}</button> : null}
            <button type="button" role="menuitem" onClick={() => { menuBtnRef.current?.focus({ preventScroll: true }); setMenu(false); void loadConversations(true); }}>{t('messages:header.menu.refresh')}</button>
          </div>
        ) : null}
      </div>
    </>
  );
  return (
    <header className="messages-thread-header">
      {channel ? <PageBackButton label={hubBack.label} onBack={hubBack.onBack} data-channel-back="" /> : null}
      {channel
        ? <span className="messages-inbox-tile messages-channel-tile messages-thread-channel-tile" aria-hidden="true">#</span>
        : groupFaces ? <GroupFaces conversation={active} />
          : <UserAvatar user={active.kind === 'direct' ? person : null} title={person?.username || active.title} shape="square" />}
      <button
        type="button"
        className="min-w-0 text-start flex-1"
        onClick={() => { if (active.kind === 'group') openDialog('messagesMembers'); }}
      >
        <div className="messages-thread-name" title={threadName || undefined}>{active.kind === 'direct' && person ? senderName(person, { bare: true }) : channel ? `#${active.channelKey || active.title}` : active.title}{active.kind === 'direct' && person?.bot ? <span className="messages-bot-badge">{t('messages:header.aiBadge')}</span> : null}</div>
        {/* One request, one story: what the bot is doing is the strip under
            this header (./bot-strip.tsx); the line under its name says what
            it is for. */}
        <div className="messages-thread-sub">{botDm ? t('messages:header.subtitle.homeroomBot') : subtitle}</div>
      </button>
      {discs}
    </header>
  );
}

/** The day a message was sent, in the viewer's zone, for the separators. */
/**
 * A message that is only a card (#2884): one or more shared items and nothing
 * a person wrote — no words, no file, no reply. A sending or unsent one is
 * never folded: it carries a status the sender is watching.
 */
function isCardMessage(message: ConversationMessage): boolean {
  return message.objects.length > 0 && !message.content && !message.attachments.length
    && !message.reply && !message.pending && !message.failed;
}

// #6479: the day in the zone the stamps are written in (the one picked in
// Settings › Language, else the device's), so a separator and the stamps
// under it never name two different days.
export function dayKey(message: ConversationMessage): string {
  const date = new Date(message.createdAt);
  if (Number.isNaN(date.getTime())) return '';
  const { year, month, day } = zonedDay(date);
  return `${year}-${month}-${day}`;
}

export function dayLabel(message: ConversationMessage, now: Date = new Date(Date.now())): string {
  const date = new Date(message.createdAt);
  if (Number.isNaN(date.getTime())) return '';
  const day = zonedDay(date);
  const today = zonedDay(now);
  const same = (a: { year: number; month: number; day: number }, b: typeof a) =>
    a.year === b.year && a.month === b.month && a.day === b.day;
  if (same(day, today)) return translate('messages:thread.day.today');
  // The calendar day before today's, counted on the calendar rather than by
  // subtracting 24 hours, so a daylight-saving night cannot skip it.
  const before = new Date(Date.UTC(today.year, today.month - 1, today.day - 1));
  if (same(day, { year: before.getUTCFullYear(), month: before.getUTCMonth() + 1, day: before.getUTCDate() })) {
    return translate('messages:thread.day.yesterday');
  }
  const timeZone = getTimeZone();
  return date.toLocaleDateString(undefined, {
    ...(timeZone ? { timeZone } : {}),
    month: 'short', day: 'numeric', ...(day.year === today.year ? {} : { year: 'numeric' }),
  });
}

/**
 * An app's general discussion, as a thread of this inbox (#2718 review).
 *
 * ── Why it is mounted rather than rendered ────────────────────────────
 *
 * The transcript, its composer, the @mention and #ref autocompletes, the
 * spec side panel, the drafts and the attachment wiring are all
 * public/js/group-chat.js and features/group-chat/. That is one surface
 * with one owner, and re-implementing it here would be a second copy of a
 * thing that is loaded, merged and invalidated elsewhere. So this renders a
 * HOST and asks the owner to fill it.
 *
 * ── The app travels with the mount ────────────────────────────────────
 *
 * `AppView.renderGroupChatTab` used to read the app out of AppView.appData,
 * which is the app view's state. This screen is not the app view and does
 * not open one, so it passes the app in instead — see that function's note
 * and GroupChat._app. Nothing here writes AppView's state.
 *
 * ── It waits for `readOnly` ───────────────────────────────────────────
 *
 * The row carries the app's name but not whether this viewer may write; the
 * store fetches that (`discussionContext`). Mounting before it lands would
 * draw a composer and then take it away, or the reverse — so the pane holds
 * on a skeleton until the answer is here.
 */
function AppDiscussionThread({ slug }: { slug: string }) {
  const t = useMessages('messages');
  const snap = useMessagesSnapshot();
  const host = useRef<HTMLDivElement | null>(null);
  const context = snap.discussionContext;
  const ready = !!context && context.slug === slug;
  const name = ready ? context.name : slug;
  const readOnly = ready ? context.readOnly : false;
  const archived = ready ? !!context.archived : false;
  // The channel's list row, when the viewer is a member: its `#handle`, and
  // the app's artwork for the header tile below.
  const row = snap.discussions.find((item) => item.slug === slug) || null;
  const handle = row?.channel || null;
  // THE HEADER DRAWS THE TILE THE ROW DRAWS. It was built from `{ name }`
  // alone, so `iconViewFor` could only ever fall through to the name's first
  // letter — a "W" over the Whiteboard channel whose row, one column to the
  // left, wears the palette emoji. The row's own two fields first, so the two
  // tiles cannot disagree; the app record the pane fetched (`context`) when
  // there is no row, as for a discussion opened from a link by a non-member.
  // Both arrive after the first paint, so the tile starts as the letter it
  // always was.
  const iconRecord = {
    name,
    icon_url: row ? row.iconUrl : (ready ? context.iconUrl : null),
    icon_emoji: row ? row.iconEmoji : (ready ? context.iconEmoji : null),
  };

  useEffect(() => {
    const el = host.current;
    if (!el || !ready) return undefined;
    const view = (window as any).AppView;
    const chat = (window as any).UsernodeReact?.groupChat;
    // OUT OF REACT'S COMMIT (#2783). renderGroupChatTab mounts the chat as a
    // portal published inside flushSync, which cannot flush while React is
    // still committing this effect: the pane, its box included, did not
    // exist yet when the lines after the mount ran (they wired the old
    // composer once). A macrotask later the commit is over and the portal
    // lands at once.
    let live = true;
    const timer = window.setTimeout(() => {
      if (live) view?.renderGroupChatTab?.({ host: el, slug, name, readOnly, archived });
    }, 0);
    return () => {
      live = false;
      window.clearTimeout(timer);
      // BOTH PORTALS, and the transcript's first: it points INTO #gc-messages
      // inside the pane, and a portal left pointing at a detached node keeps
      // its subtree and its store subscription alive (rule 1 in
      // lib/legacy-portals.tsx, and the same order renderGroupChatTab
      // observes when it re-renders).
      const list = el.querySelector('#gc-messages');
      if (list) chat?.unmountTranscript?.(list);
      chat?.unmountGeneralChat?.(el);
      // #2387: a "Mark unread" lasts while the channel is open, not after.
      (window as any).GroupChat?.releaseUnreadHold?.(slug);
    };
  }, [slug, ready, name, readOnly, archived]);

  if (snap.discussionError) {
    return (
      <section className="flex messages-thread-pane messages-no-selection" aria-label={name}>
        <h2>{t('messages:discussion.error.title')}</h2>
        <p>{t('messages:discussion.error.body')}</p>
      </section>
    );
  }
  return (
    <section
      className="flex messages-thread-pane messages-thread-discussion"
      aria-label={name}
      data-discussion-app={slug}
    >
      {/* THE PANE SAYS WHOSE DISCUSSION IT IS. On the app view this screen
          did not need one — the bar above it named the app — but here the
          bar says "Messages", and the group chat's own intro banner shows
          once per browser and then never again. The conversation pane beside
          it carries the same row (ThreadHeader). */}
      <header className="messages-thread-header">
        <PageBackButton label={name} onBack={() => openChannelHub(slug)} data-channel-back="" />
        <AppIconLink
          slug={slug}
          name={name}
          data-icon={appIconKind(iconRecord as never)}
          className="app-icon-tile messages-inbox-tile"
        >
          <AppIconContent app={iconRecord as never} />
        </AppIconLink>
        <span className="min-w-0 flex-1">
          <span className="messages-thread-name block">{name}</span>
          <span className="messages-thread-sub block">
            {archived
              ? t('messages:discussion.subtitle.archived')
              : handle ? t('messages:discussion.subtitle.channel', { channel: handle }) : t('messages:discussion.subtitle.everyone')}
          </span>
        </span>
        <FullWidthToggle />
      </header>
      {/* NO `dc-lift dc-lift-session` HERE, unlike the conversation pane
          beside it: features/group-chat/general-chat.tsx opens with exactly
          that pair, so the sheet is drawn once, inside. What this section
          contributes is the BOX — `.messages-thread-pane`'s margins put the
          sheet on the strip with the shoulder showing, the same geometry a
          conversation gets. `platform-kb-column` is inside too, on the chat
          pane, for the same reason.

          The host's class string is constant and its subtree is entirely
          group-chat's: the one-owner rule satisfied at this boundary rather
          than at a node within it. */}
      <div ref={host} className="messages-discussion-host flex-1 min-h-0" />
    </section>
  );
}

/**
 * The open conversation. `embedded` is the copy a community's page mounts
 * (#3494, EmbeddedConversation below): the same thread, drawn without this
 * screen's header because the page's own header and tabs already name it.
 * Exactly one copy draws the thread at a time — the store's route says
 * which — so the ids its rows carry are never on the page twice.
 */
/**
 * #general IS A DISCUSSION (26 Nov 2026): the platform's #general is
 * Homeroom's Discussion, posts with replies on its project page
 * (dev-board/workshop/hub-discussion.tsx), and never a chat here. Its
 * address is taken there (channelToHub, App.openDiscussionInHub); until the
 * store knows where, or for a viewer the platform's page is not served to,
 * this pane says where it is rather than drawing the room.
 */
function ScreenConversation() {
  const snap = useMessagesSnapshot();
  const conversationId = snap.route.conversationId;
  if (conversationId && snap.active?.id === conversationId && snap.active.kind === 'channel') {
    return <ChannelIsDiscussion conversationId={conversationId} />;
  }
  return <ConversationThread />;
}

function ChannelIsDiscussion({ conversationId }: { conversationId: number }): ReactNode {
  const t = useMessages('messages');
  const snap = useMessagesSnapshot();
  const slug = platformSlug();
  const served = platformHubServed();
  const open = () => {
    const door = (window as { App?: { openDiscussionInHub?: (slug: string, target: unknown) => void } }).App?.openDiscussionInHub;
    if (slug && door) door(slug, { conversationId, threadRootId: snap.route.threadRootId, focusMessageId: snap.route.focusMessageId });
  };
  return (
    <section className="messages-thread" data-channel-discussion="">
      <div className="messages-thread-scroll">
        <div className="messages-state">
          <p>{served ? t('messages:thread.channelIsDiscussion') : t('messages:thread.channelIsDiscussionClosed')}</p>
          {served && slug ? (
            <button type="button" className="messages-state-action" data-channel-discussion-open="" onClick={open}>
              {t('messages:thread.channelIsDiscussionOpen')}
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function ConversationThread({ embedded = false }: { embedded?: boolean } = {}) {
  // #6479: the separators' days are read in the zone picked; useMessages re-renders on a change.
  const t = useMessages('messages');
  const snap = useMessagesSnapshot();
  const channels = useChannelHandles();
  const scroller = useRef<HTMLDivElement>(null);
  // #3571: the kit's keyboard avoidance on this column's scroller, as the
  // channel and its threads get theirs from attachScreenFx.
  // Its settled pin puts back the pan iOS makes on the tap, which otherwise
  // left the composer (lifted by `platform-kb-column`) above the screen.
  useComposerKeyboard(scroller);
  // #3757: whether the reader is at the newest line, from where they last
  // scrolled, so a tall reply or a card that grows after it is drawn keeps
  // them there (./stick-to-bottom.ts).
  const pinned = useStickToBottom(scroller, !snap.nextAfter);
  const previousLast = useRef<number | null>(null);
  const initialScroll = useRef<number | null>(null);
  // Whether this conversation was last drawn as a linked window (#2387).
  const wasWindow = useRef(false);
  const conversationId = snap.route.conversationId;
  // #6254: a file dropped anywhere on this pane goes to this conversation's
  // own box, so the header, the transcript and the box are one drop zone.
  const drop = usePaneDrop(scopeKey(conversationId || 0, null));
  // 1 Nov 2026: the bot's typing is its working card, where its answer will
  // appear (./bot-working.tsx); the status line keeps people's names, and
  // the bot's too while the transcript is a window part-way back.
  const typists = conversationId ? typingUsers(conversationId) : [];
  const working = snap.nextAfter ? null : workingBot(typists);
  const typing = typingBesides(typists, working);
  // #2884: the runs of cards the viewer has opened, by their first message.
  const [expandedRuns, setExpandedRuns] = useState<ReadonlySet<string>>(() => new Set());
  // #2387: the message a link pointed at, flashed once it is drawn.
  const focusId = snap.route.focusMessageId;
  const [flashId, setFlashId] = useState<number | null>(null);
  const shownFocus = useRef<number | null>(null);
  // #5019: loading earlier messages on scroll. A failed load restores the
  // button at the top as the manual way back, until it succeeds or the
  // conversation (or its next-older cursor) changes.
  const [olderFailed, setOlderFailed] = useState(false);
  // #6148: the same at the foot of a window a message link opened part-way
  // back (#2387): a failed load of newer messages restores the button there.
  const [newerFailed, setNewerFailed] = useState(false);
  // THE "NEW" LINE (./unread-anchor.ts): above the first message after where
  // reading had stopped when this conversation was opened (the store's
  // `unreadMark`). The transcript opens with it near the top.
  const unreadLine = useRef<HTMLDivElement>(null);
  const mark = snap.unreadMark && snap.unreadMark.conversationId === conversationId ? snap.unreadMark : null;
  const viewerId = typeof window !== 'undefined' ? Number(window.App?.user?.id) || 0 : 0;
  const unreadRows = useMemo(() => snap.messages.map((message) => messageRow(message, viewerId)), [snap.messages, viewerId]);
  const lineAt = mark ? firstUnreadId(unreadRows, mark.lastReadId) : null;
  const holdLine = useLineHold(conversationId);
  useIsomorphicLayoutEffect(() => {
    if (!conversationId) return;
    previousLast.current = null; initialScroll.current = null; pinned.current = true; wasWindow.current = false;
  }, [conversationId]);

  // A layout effect, so the scroll lands before the new rows are painted and
  // `pinned` is read before any scroll event can report the grown content.
  useIsomorphicLayoutEffect(() => {
    const el = scroller.current;
    const lastMessage = snap.messages.at(-1);
    const last = lastMessage?.id || null;
    if (!el || !last) return;
    const fromWindow = wasWindow.current || !!snap.nextAfter;
    wasWindow.current = !!snap.nextAfter;
    // #2387: a message link lands on its message, centred and flashed, once
    // — not at the bottom, and not again on every refresh after.
    if (focusId && shownFocus.current !== focusId) {
      // This transcript's own row: a reply drawn in the thread pane beside it
      // carries the same id, and is that pane's to show.
      const row = el.querySelector<HTMLElement>(`[id="messages-message-${focusId}"]`);
      if (row) {
        shownFocus.current = focusId;
        previousLast.current = last;
        pinned.current = false;
        requestAnimationFrame(() => centreInScroller(el, row));
        setFlashId(focusId);
        window.setTimeout(() => setFlashId((id) => (id === focusId ? null : id)), 2400);
        return;
      }
    }
    if (focusId && shownFocus.current === focusId && snap.nextAfter) { previousLast.current = last; return; }
    // Unread messages: the conversation opens at the first of them, its
    // "New" line a row or two below the top, instead of at the newest. When
    // everything new fits at the bottom it opens there, following what
    // arrives as it always did (openingScrollTop says which).
    const line = unreadLine.current;
    if (previousLast.current === null && line && !snap.nextAfter) {
      const at = openingScrollTop({ lineTop: lineTopIn(el, line), scrollHeight: el.scrollHeight, clientHeight: el.clientHeight });
      el.scrollTop = at.top;
      pinned.current = at.pinned;
      // And keeps it there while images and link cards above it fill in.
      if (!at.pinned) holdLine(el, line);
      previousLast.current = last;
      return;
    }
    // A new line, the viewer's own send included (#4511), follows only a
    // reader who was at the bottom BEFORE it arrived (#3757): measured now,
    // after the draw, a reply taller than the allowance read as the reader
    // having scrolled up. A reader up in the history stays where they are
    // reading. The one send that still moves is one from a linked window
    // (#2387): store.send takes it to the present, which is a different
    // stretch of the conversation, so it opens at its newest line.
    const sentNow = !!lastMessage?.pending && last !== previousLast.current && fromWindow;
    if (previousLast.current === null || sentNow || pinned.current) {
      // The foot of a linked window (#2387) is not the present: nothing
      // follows it there. A send from one goes to the present (store.send).
      pinned.current = sentNow || !snap.nextAfter;
      el.scrollTop = el.scrollHeight;
    }
    previousLast.current = last;
  }, [snap.messages, focusId, snap.nextAfter]);

  // The banner over the transcript's top and the jump to the latest over its
  // foot. After the effect above, so they measure where the opening put it.
  const { view: unread, toLine, toLatest } = useUnreadAffordances(scroller, unreadLine, {
    conversation: conversationId,
    markKey: mark ? `${mark.conversationId}:${mark.lastReadId}` : '',
    lineAt,
    rows: unreadRows,
    atPresent: !snap.nextAfter,
    offerBanner: !focusId,
  });
  // At the foot of a linked window (#2387) the latest is not drawn yet.
  const jumpToLatest = () => {
    if (snap.nextAfter) { pinned.current = true; jumpToPresent(); return; }
    toLatest();
  };

  async function older() {
    const el = scroller.current;
    if (el) initialScroll.current = el.scrollHeight;
    const ok = await loadOlder();
    requestAnimationFrame(() => {
      if (el && initialScroll.current !== null) el.scrollTop += el.scrollHeight - initialScroll.current;
      initialScroll.current = null;
    });
    return ok;
  }

  // #5019: scrolling up near the top reads the previous page in, one at a
  // time, in place of the button that used to sit there. The latest values
  // the guard reads go through a ref, so the scroll listener below attaches
  // once per scroller instead of on every publish.
  const olderGate = useRef({ conversationId, nextBefore: snap.nextBefore, loadingOlder: snap.loadingOlder, loadingThread: snap.loadingThread, olderFailed });
  olderGate.current = { conversationId, nextBefore: snap.nextBefore, loadingOlder: snap.loadingOlder, loadingThread: snap.loadingThread, olderFailed };
  function maybeLoadOlder() {
    const el = scroller.current;
    if (!el) return;
    const gate = olderGate.current;
    if (!gate.nextBefore || gate.loadingOlder || gate.loadingThread || gate.olderFailed) return;
    if (!isNearTop(el)) return;
    void older().then((ok) => { if (!ok) setOlderFailed(true); });
  }
  useIsomorphicLayoutEffect(() => { setOlderFailed(false); }, [conversationId, snap.nextBefore]);
  // #6148: and at the foot of a window a message link opened part-way back
  // (#2387), scrolling down near the bottom reads the next page in the same
  // way, in place of the "Load newer messages" button that used to stop it.
  // The page lands below what is on screen, so nothing on screen moves, and
  // `pinned` waits for the present: useStickToBottom's atPresent is
  // `!snap.nextAfter`, so the reader's scrolls cannot pin the conversation
  // until the last page is in, and then it follows its newest line as it
  // always does. One page at a time: loadNewer reads with the same
  // `loadingOlder` flag as the top.
  const newerGate = useRef({ nextAfter: snap.nextAfter, loadingOlder: snap.loadingOlder, loadingThread: snap.loadingThread, newerFailed });
  newerGate.current = { nextAfter: snap.nextAfter, loadingOlder: snap.loadingOlder, loadingThread: snap.loadingThread, newerFailed };
  function maybeLoadNewer() {
    const el = scroller.current;
    if (!el) return;
    const gate = newerGate.current;
    if (!gate.nextAfter || gate.loadingOlder || gate.loadingThread || gate.newerFailed) return;
    if (!isNearBottom(el, LOAD_NEWER_SLACK_PX)) return;
    void loadNewer().then((ok) => { if (!ok) setNewerFailed(true); });
  }
  useIsomorphicLayoutEffect(() => { setNewerFailed(false); }, [conversationId, snap.nextAfter]);
  useIsomorphicLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onScroll = () => { maybeLoadOlder(); maybeLoadNewer(); };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);
  // A short thread keeps reading pages in until the screen fills or the
  // conversation's older end is reached.
  useIsomorphicLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (needsMoreHistory(el)) maybeLoadOlder();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.messages, snap.nextBefore, snap.loadingOlder]);
  // #6148: and a linked window too short to scroll reads its newer pages in
  // the same way, until the screen fills or it reaches the present: with
  // nothing to scroll, the reader cannot reach its foot to ask. A pane with
  // no height is not short but hidden (under a thread on a phone): it reads
  // nothing until it is shown.
  useIsomorphicLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !el.clientHeight) return;
    if (needsMoreHistory(el)) maybeLoadNewer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.messages, snap.nextAfter, snap.loadingOlder]);

  // #3494: the room is up in its community's page, so this screen (hidden)
  // draws no second copy of it; and the page's copy draws nothing once
  // Messages has taken the store back.
  if (!!snap.route.embedded !== embedded) {
    return embedded ? null : <section className="hidden md:flex messages-thread-pane messages-no-selection"><h2>{t('messages:thread.empty.title')}</h2></section>;
  }
  if (snap.route.appSlug) return <AppDiscussionThread slug={snap.route.appSlug} />;
  if (!conversationId) return <section className="hidden md:flex messages-thread-pane messages-no-selection"><h2>{t('messages:thread.empty.title')}</h2><p>{t('messages:thread.empty.body')}</p><MessagesGuide /></section>;
  // The kind is on the SECTION — `messages-thread-direct`, `-group` or
  // `-channel` — so the scroller's class string below stays the one the
  // safe-area test pins. It decides the rows' shape: a DM and a group draw
  // their own message on its sender's side (#5680), a channel keeps the
  // named-row transcript (#2783) — ./message-row.tsx.
  const kind = snap.active?.kind || 'direct';
  const rows: ReactNode[] = [];
  let previousDay = '';
  let previous: ConversationMessage | null = null;
  // The "New" line, drawn once: above the first unread message, or above
  // the first row drawn after it when that message is not drawn itself.
  let lineDrawn = false;
  const drawLine = () => {
    if (lineDrawn) return;
    lineDrawn = true;
    rows.push(<NewMessagesDivider key="unread-line" ref={unreadLine} />);
  };
  // #2884: three or more cards in a row — messages that are only a shared
  // item — draw as the first and a "… N more" row (../../lib/card-runs.ts).
  // A day divider breaks a run, so folding never hides one.
  const runs = cardRunStarts(snap.messages, isCardMessage, (a, b) => dayKey(a) === dayKey(b));
  for (let index = 0; index < snap.messages.length; index += 1) {
    const message = snap.messages[index];
    const day = dayKey(message);
    if (day && day !== previousDay) {
      rows.push(<div key={`day-${day}`} className="messages-day" aria-hidden="true">{dayLabel(message)}</div>);
      previousDay = day;
    }
    if (lineAt !== null && message.id >= lineAt) drawLine();
    // #2387 follow-up: a thread's reply, drawn where it landed — one card for
    // the run of replies to that thread with nothing else said between them
    // on the same day. A deleted reply is gone from the run; the next message
    // after the card carries its own name.
    if (message.threadRootId) {
      const run = [message];
      while (index + 1 < snap.messages.length) {
        const next = snap.messages[index + 1];
        if (next.threadRootId !== message.threadRootId || dayKey(next) !== day) break;
        run.push(next);
        index += 1;
      }
      const live = run.filter((item) => !item.deleted);
      if (live.length) {
        rows.push(<ThreadActivityRow key={`thread-activity-${live[0].clientKey || live[0].id}`} replies={live} />);
      }
      previous = null;
      continue;
    }
    // A failed or unsent row is its own line: it carries a status of its own.
    // So is a platform line (a Homeroom line kept as the root of a thread),
    // which has no author to share a name with the row above.
    const grouped = !!previous && !previous.failed && !message.failed
      && !previous.system && !message.system
      && groupsWithPrevious(
        { author: previous.sender.id, at: previous.createdAt },
        { author: message.sender.id, at: message.createdAt, reply: !!message.reply },
      );
    rows.push(<MessageRow
      key={message.clientKey || message.id}
      message={message}
      conversationId={conversationId}
      grouped={grouped}
      channels={channels}
      kind={kind}
      threadOpen={snap.route.threadRootId === message.id}
      focused={flashId === message.id}
      hidePrompts={asksWithQuestionsCard(message) && !!message.sender.bot}
    />);
    previous = message;
    const length = runs.get(index);
    const runKey = String(message.clientKey || message.id);
    if (length && !expandedRuns.has(runKey)) {
      const hidden = length - 1;
      // The first unread folded away in the run: the line goes above the
      // fold that holds it.
      if (lineAt !== null && snap.messages[index + hidden].id >= lineAt) drawLine();
      rows.push(
        <div key={`more-${runKey}`} className="messages-card-run">
          <button
            type="button"
            className="messages-card-run-more"
            data-card-run-more={hidden}
            aria-expanded="false"
            aria-label={t('messages:thread.showMoreCards', { count: hidden })}
            onClick={() => setExpandedRuns((open) => new Set(open).add(runKey))}
          >{cardRunLabel(hidden)}</button>
        </div>,
      );
      // The row after the fold always carries its own name: drawn as a
      // continuation under "… N more", it would read as part of the fold.
      previous = null;
      index += hidden;
    }
  }
  return (
    <section className={`flex messages-thread-pane platform-kb-column dc-lift dc-lift-session messages-thread-${kind}${embedded ? ' messages-thread-embedded' : ''}`} aria-label={snap.active?.title || t('messages:thread.paneName')} {...drop.handlers}>
      {embedded ? null : <ThreadHeader />}
      <InvitationBanner />
      {/* What is new, counted over the transcript's top; a tap goes to the
          "New" line (./unread-anchor.ts). Hung beside the scroller, not in
          it, so the scroller keeps its size and its class string. */}
      {mark ? (
        <TranscriptOverlay edge="top">
          <NewMessagesBanner shown={unread.banner} onClick={toLine}>{newMessagesLabel(mark.count)}</NewMessagesBanner>
        </TranscriptOverlay>
      ) : null}
      {/* No `un-kb-avoid` WRITTEN here: the column reserves the keyboard
          inset (`platform-kb-column` above). The kit adds the class itself
          once useComposerKeyboard attaches (#3571), as it does to
          `#gc-messages`, and app.css's `.platform-kb-column .un-kb-avoid`
          keeps it from padding this scroller with the inset a second time.
          So this className stays constant: React never strips the kit's.
          `chat-transcript` is what ends the transcript 12px inside this
          scroller, at the composer card's edge, as every chat's does
          (@/components/ui/chat, "A chat's foot", 1 November 2026). */}
      <div ref={scroller} className="messages-thread-scroll platform-safe-scroll chat-transcript" aria-live="polite">
        {/* Only a thread with nothing to show yet says it is loading (#2907).
            A refresh of the visible thread — the realtime echo of every send
            is one — re-reads it silently: this row drawn above the messages
            pushed the whole transcript down on each message sent. */}
        {snap.loadingThread && !snap.messages.length ? <div className="messages-state"><span className="messages-spinner" />{t('messages:thread.loading')}</div> : null}
        {/* QA 2026-09-24 Q16: a conversation that cannot come back offers the
            way out, not a Try again that reads the same answer. Leaving it
            here is said plainly, in the ordinary state colour: it is what
            the viewer asked for, not an error. */}
        {snap.threadGone === 'left' ? <div className="messages-state" data-thread-gone="left"><p>{t('messages:thread.left')}</p><button type="button" onClick={() => messagesController.open(null)}>{t('messages:thread.backToMessages')}</button></div> : null}
        {snap.threadError && !snap.messages.length ? <div className={snap.threadErrorOffline ? 'messages-state' : 'messages-state messages-state-error'}><p>{snap.threadError}</p>{snap.threadGone === 'missing'
          ? <button type="button" onClick={() => messagesController.open(null)}>{t('messages:thread.backToMessages')}</button>
          : <button type="button" onClick={() => messagesController.route(conversationId)}>{t('core:common.tryAgain')}</button>}</div> : null}
        {!snap.loadingThread && !snap.threadError && snap.active && snap.active.membershipStatus === 'member' && !snap.messages.length ? <div className="messages-thread-empty"><span aria-hidden="true">👋</span><p>{t('messages:thread.emptyConversation')}</p></div> : null}
        {/* #5019: the old button row holds its height and, while loading, the
            "Loading…" line where the button was. The button itself returns
            only to retry a failed load; scrolling up does the rest. */}
        {snap.nextBefore ? (
          <div className="flex h-12 items-center justify-center" data-load-older="">
            {snap.loadingOlder
              ? <span role="status" className="text-[13px] text-zinc-500 dark:text-zinc-400">{t('messages:thread.loadingOlder')}</span>
              : olderFailed
                ? <button type="button" onClick={() => { setOlderFailed(false); void older().then((ok) => { if (!ok) setOlderFailed(true); }); }} className="messages-load-older">{t('messages:thread.loadEarlier')}</button>
                : null}
          </div>
        ) : null}
        {rows}
        {working ? <BotWorkingCard typist={working} /> : null}
        {/* #2387: a message link opened the transcript part-way back. */}
        {snap.nextAfter ? (
          <div className="messages-newer" data-load-newer="">
            {/* #6148: scrolling down to here reads the newer pages in, so
                the row says "Loading…" while one loads and offers "Load
                newer messages" only to retry a failed load, as the top's
                row does. Jump to present stays, quiet, for a reader a long
                way back. */}
            {snap.loadingOlder
              ? <span role="status" className="text-[13px] text-zinc-500 dark:text-zinc-400">{t('messages:thread.loadingNewer')}</span>
              : newerFailed
                ? <button type="button" onClick={() => { setNewerFailed(false); void loadNewer().then((ok) => { if (!ok) setNewerFailed(true); }); }} className="messages-load-older">{t('messages:thread.loadNewer')}</button>
                : null}
            <button type="button" className="messages-jump-present" onClick={() => { pinned.current = true; jumpToPresent(); }}>{t('messages:thread.jumpToPresent')}</button>
          </div>
        ) : null}
      </div>
      {/* Jump to latest whenever the reader is not at the bottom, with a dot
          for what arrived while they were up: centred, hung from the
          transcript's foot, just above the composer (@/components/ui/chat
          TranscriptOverlay). Above the typing line since 1 November 2026,
          as in every chat: it rises with the transcript when a name
          appears rather than covering it. */}
      <TranscriptOverlay edge="foot">
        <JumpToLatestButton shown={unread.jump} dot={unread.arrived > 0} aria-label={jumpLabel(unread.arrived)} title={t('messages:thread.jumpToLatest')} onClick={jumpToLatest} />
      </TranscriptOverlay>
      <ChatStatusLine className="messages-typing">{typingLine(t, typing)}</ChatStatusLine>
      <MessageComposer scroller={scroller} />
      {drop.dragging ? <DropOverlay className="messages-drop-overlay" /> : null}
    </section>
  );
}

/**
 * A run of one thread's replies in the main transcript (#2387 follow-up):
 * the shared card, told who replied and what, and to open that thread.
 */
function ThreadActivityRow({ replies }: { replies: ConversationMessage[] }) {
  // Subscribed: the time range is read from the catalog as this renders.
  useMessages('messages');
  const first = replies[0];
  const last = replies[replies.length - 1];
  const rootId = first.threadRootId as number;
  const root = first.threadRoot;
  const start = timeOfDay(first.createdAt);
  const end = timeOfDay(last.createdAt);
  return (
    <ThreadActivityCard
      rootText={root?.content || ''}
      rootDeleted={!!root?.deleted}
      time={start === end ? start : translate('messages:thread.activityTimeRange', { start, end })}
      timeTitle={fullTime(last.createdAt)}
      replies={replies.map((reply) => ({
        key: reply.clientKey || reply.id,
        face: <span className="msgx-thread-face"><UserAvatar user={reply.sender} size="sm" shape="square" /></span>,
        // N14: a bot by its name ("Homeroom bot"), a person by @username.
        name: reply.sender.bot ? senderName(reply.sender, { bare: true }) : reply.sender.username,
        bot: !!reply.sender.bot,
        text: reply.content,
      }))}
      onOpen={() => openThread(rootId)}
    />
  );
}

/**
 * A REPLY THREAD beside its conversation (#2387): the message it hangs off,
 * its replies, and a composer of its own. Slack's arrangement — the
 * conversation stays readable on the left while the side conversation runs
 * on the right — drawn as a second sheet on the same strip. On a phone it
 * covers the conversation instead (app.css), and Back returns to it.
 *
 * DMs have no threads: a thread is how a room keeps a side conversation out
 * of everyone's way, and a DM has no one else in it. The chat with Homeroom
 * bot is the one that does (./bot-shared.ts threadsAllowed): there each
 * request's card is the root of its thread, which this pane names by the
 * request ("Dark mode", "Plant Pal first version") over its project.
 */
/**
 * The thread pane's loading state, at the message row's own geometry
 * (#5219 review). While the replies and, on a request's thread, the request's
 * public discussion are still loading, the pane shows the rows they will
 * arrive as — avatar, head line, words — rather than a blank pane under a
 * line of grey text. The wrapper IS `.messages-message`, not an imitation of
 * it: that class owns the flex, the gap and the row padding in app.css, so
 * the placeholder cannot drift from the row the first time any of those move.
 *
 * Four, because the pane is taller than that on every phone and a thread
 * that stops halfway reads as a short thread rather than a loading one.
 */
function ReplyRowSkeleton() {
  const t = useMessages('messages');
  return (
    <SkeletonGroup label={t('messages:replies.loading')}>
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="messages-message" aria-hidden="true">
          {/* The md square UserAvatar's 36px box. */}
          <Skeleton shape="block" className="h-9 w-9 rounded-xl" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Skeleton className="w-24" />
              <Skeleton shape="muted" className="ms-auto w-12" />
            </div>
            <Skeleton shape="muted" className={`mt-2 ${i % 2 ? 'w-2/5' : 'w-3/5'}`} />
          </div>
        </div>
      ))}
    </SkeletonGroup>
  );
}

// #5691: the divider between a chat and its open thread. The width is this
// device's own, under a key of its own, kept
// between the thread's floor and the room the chat has to keep.
const REPLY_WIDTH_KEY = 'messages-reply-width-v1';
const REPLY_MIN_WIDTH = 320;
const REPLY_CHAT_MIN_WIDTH = 360;
/** The strip's margins beside the chat and right of the thread. */
const REPLY_MARGINS = 24;
/** How far one arrow key moves the divider. */
const REPLY_WIDTH_STEP = 24;

function clampReplyWidth(width: number, containerWidth: number | null | undefined): number {
  const wanted = Number.isFinite(width) ? width : REPLY_MIN_WIDTH;
  const ceiling = typeof containerWidth === 'number' && Number.isFinite(containerWidth) && containerWidth > 0
    ? Math.max(REPLY_MIN_WIDTH, containerWidth - REPLY_CHAT_MIN_WIDTH - REPLY_MARGINS)
    : Infinity;
  return Math.round(Math.min(ceiling, Math.max(REPLY_MIN_WIDTH, wanted)));
}

function readReplyWidth(): number | null {
  try {
    const value = parseInt(window.localStorage.getItem(REPLY_WIDTH_KEY) || '', 10);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function writeReplyWidth(px: number): void {
  try { window.localStorage.setItem(REPLY_WIDTH_KEY, String(Math.round(px))); } catch { /* the default next time */ }
}

function ReplyThreadPanel({ alone = false, onBack = null }: {
  /**
   * 31 Oct 2026: open in the column of the Homeroom bot tab, the only place
   * the chat with the bot is drawn, and (14 Nov 2026) drawn there as its
   * threads only: the thread fills the column (app.css `[data-bot-threads]`),
   * alone under its own head, its title and "Only you can see this thread".
   * 6 Nov 2026 (#6425): it closes with its own ✕, which leaves the lists
   * alone; a phone's drawer keeps its back arrow to the list and no ✕.
   */
  alone?: boolean;
  /** A phone's drawer: the back arrow that leads the head, to the list. */
  onBack?: (() => void) | null;
} = {}) {
  const t = useMessages('messages');
  const snap = useMessagesSnapshot();
  const channels = useChannelHandles();
  // #6963: the bot tab's list is hidden behind this thread, and this is the
  // way back to it (../ai/list-closed). Drawn only in the bot tab's own
  // column, never in a phone's drawer or another surface's thread. First in
  // the head, where a phone draws its back arrow, on both heads this thread
  // can have: the compact sheet the bot tab draws it as (#6863) and the
  // plain one every other surface draws.
  const showList = useShowListButton();
  const showListButton = alone && !onBack && showList ? (
    <button type="button" className="messages-thread-action messages-thread-back" data-reply-show-list=""
      aria-label={t('messages:ai.list.show')} title={t('messages:ai.list.show')}
      onClick={() => setListClosed(false)}>
      <ListBulletIcon aria-hidden="true" />
    </button>
  ) : null;
  const conversationId = snap.route.conversationId;
  const rootId = snap.route.threadRootId;
  // #6254: this thread is its own drop area — a file dropped on the reply box
  // or on the replies around it never goes to the chat beside it.
  const drop = usePaneDrop(scopeKey(conversationId || 0, rootId));
  const thread = snap.thread && snap.thread.rootId === rootId ? snap.thread : null;
  // 1 Nov 2026: the bot answering here is its working card (./bot-working.tsx).
  const threadTypists = conversationId && rootId ? typingUsers(conversationId, rootId) : [];
  const threadWorking = workingBot(threadTypists);
  const threadTyping = typingBesides(threadTypists, threadWorking);
  // 16 Oct 2026: a request's thread marks where each of its tries began
  // (./bot-track.tsx), when the bot built it more than once.
  const trackRoot = thread?.root || snap.messages.find((item) => item.id === rootId) || null;
  const trackMeta = trackRoot?.sender.bot ? trackRoot.metadata?.homeroomBot || null : null;
  const track = useTrackOf(trackMeta ? {
    appSlug: trackMeta.appSlug, appName: trackMeta.appName, issueNumber: trackMeta.issueNumber, firstVersion: trackMeta.firstVersion === true,
  } : null);
  const scroller = useRef<HTMLDivElement>(null);
  // #3571: the same keyboard avoidance as the conversation beside it. On a
  // phone this pane covers the conversation, so its composer is the one the
  // keyboard comes up under when a thread is replied to.
  useComposerKeyboard(scroller);
  // #4511/#4513: the conversation's rule (./stick-to-bottom.ts). A reader at
  // the newest reply stays there as replies arrive, their own included, and
  // as the composer grows with a second line; one reading further up is
  // left there. A thread opens at its newest reply.
  const pinned = useStickToBottom(scroller, true);
  const count = useRef(0);
  useIsomorphicLayoutEffect(() => { pinned.current = true; }, [conversationId, rootId]);
  useEffect(() => {
    if (conversationId && rootId && !snap.loadingThread && snap.active?.id === conversationId) {
      void loadReplyThread(conversationId, rootId);
    }
  }, [conversationId, rootId, snap.active?.id, snap.loadingThread]);
  // New replies land in view for a reader who was at the bottom before they
  // arrived. A layout effect, so it is read before a scroll event can report
  // the grown content.
  useIsomorphicLayoutEffect(() => {
    const el = scroller.current;
    const n = thread?.messages.length || 0;
    if (el && n !== count.current && pinned.current) el.scrollTop = el.scrollHeight;
    count.current = n;
  }, [thread?.messages.length]);
  // B19 follow-up (audit, 2 Nov 2026): a thread opens at the first reply
  // the reader had not read, its "New" line a little below the top, as a
  // conversation does (./unread-anchor.ts openingScrollTop); with nothing
  // unread, at its newest reply. Once per open, after the rows are drawn,
  // and never over a message the thread was opened at (below).
  const unreadLine = useRef<HTMLDivElement>(null);
  const openedAt = useRef<string | null>(null);
  const firstUnread = thread && !thread.loading ? thread.firstUnreadId ?? null : null;
  useIsomorphicLayoutEffect(() => {
    const el = scroller.current;
    const key = `${conversationId}:${rootId}`;
    if (!el || !thread || thread.loading || openedAt.current === key) return;
    openedAt.current = key;
    const line = unreadLine.current;
    if (!firstUnread || !line || snap.route.focusMessageId) return;
    const opening = openingScrollTop({ lineTop: lineTopIn(el, line), scrollHeight: el.scrollHeight, clientHeight: el.clientHeight });
    el.scrollTop = opening.top;
    pinned.current = opening.pinned;
  }, [conversationId, rootId, thread?.loading, thread?.messages.length]);
  // A thread opened at one of its messages (a link to a reply) shows it
  // once it is drawn, centred and flashed, and stops following the newest
  // reply. Looked for in this pane only.
  const wanted = snap.route.focusMessageId || null;
  const [flashId, setFlashId] = useState<number | null>(null);
  const shownFocus = useRef<number | null>(null);
  useIsomorphicLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !wanted || shownFocus.current === wanted || !thread || thread.loading) return;
    const row = el.querySelector<HTMLElement>(`[id="messages-message-${wanted}"]`);
    if (!row) return;
    shownFocus.current = wanted;
    pinned.current = false;
    requestAnimationFrame(() => centreInScroller(el, row));
    setFlashId(wanted);
    window.setTimeout(() => setFlashId((id) => (id === wanted ? null : id)), 2400);
  }, [wanted, thread?.messages.length, thread?.loading]);
  // #6148: scrolling up near the top of the replies reads the earlier page
  // in, one at a time, as a conversation's top does (#5019), in place of the
  // "Load earlier replies" button that used to stop it. The top is where the
  // replies start: their row under the message the thread hangs off, which
  // can be taller than the allowance on its own (./stick-to-bottom.ts
  // isNearStart). What is on screen stays where it is, as the conversation's
  // older() keeps it: the scroller's height before the page, the difference
  // added after. A failed load restores the button as the manual retry,
  // until it succeeds or the thread (or its next-earlier cursor) changes.
  const [earlierFailed, setEarlierFailed] = useState(false);
  const earlierRow = useRef<HTMLDivElement>(null);
  const earlierScroll = useRef<number | null>(null);
  useIsomorphicLayoutEffect(() => { earlierScroll.current = null; }, [conversationId, rootId]);
  async function earlierReplies() {
    const el = scroller.current;
    if (el) earlierScroll.current = el.scrollHeight;
    const ok = await loadOlderReplies();
    requestAnimationFrame(() => {
      if (el && earlierScroll.current !== null) el.scrollTop += el.scrollHeight - earlierScroll.current;
      earlierScroll.current = null;
    });
    return ok;
  }
  // The latest values the guard reads go through a ref, so the scroll
  // listener below attaches once per thread instead of on every publish.
  const earlierGate = useRef({ nextBefore: thread?.nextBefore || null, loading: !!thread?.loading, earlierFailed });
  earlierGate.current = { nextBefore: thread?.nextBefore || null, loading: !!thread?.loading, earlierFailed };
  function maybeLoadEarlierReplies() {
    const el = scroller.current;
    if (!el) return;
    const gate = earlierGate.current;
    if (!gate.nextBefore || gate.loading || gate.earlierFailed) return;
    const start = earlierRow.current;
    if (!(start ? isNearStart(el, start) : isNearTop(el))) return;
    void earlierReplies().then((ok) => { if (!ok) setEarlierFailed(true); });
  }
  useIsomorphicLayoutEffect(() => { setEarlierFailed(false); }, [conversationId, rootId, thread?.nextBefore]);
  useIsomorphicLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onScroll = () => maybeLoadEarlierReplies();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, rootId]);
  // A thread too short to scroll reads its earlier pages in until the pane
  // fills: with nothing to scroll, the reader cannot reach its top to ask.
  // A pane with no height is hidden, not short: it reads nothing.
  useIsomorphicLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !el.clientHeight) return;
    if (needsMoreHistory(el)) maybeLoadEarlierReplies();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread?.messages.length, thread?.nextBefore, thread?.loading]);
  // #5691: how wide this thread is, against the chat beside it. Read in an
  // effect, never during the first render, so the first paint draws the CSS
  // default (and is the same markup on every render).
  const paneRef = useRef<HTMLElement>(null);
  const [replyWidth, setReplyWidth] = useState<number | null>(null);
  const stripWidth = () => paneRef.current?.parentElement?.getBoundingClientRect().width ?? null;
  useEffect(() => {
    const stored = readReplyWidth();
    if (stored != null) setReplyWidth(clampReplyWidth(stored, stripWidth()));
  }, []);
  const hasReplyWidth = replyWidth != null;
  // A window made narrower than a remembered width allows is re-clamped.
  useEffect(() => {
    if (!hasReplyWidth) return undefined;
    const onResize = () => setReplyWidth((width) => (width == null ? width : clampReplyWidth(width, stripWidth())));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [hasReplyWidth]);
  const commitReplyWidth = (next: number) => {
    const clamped = clampReplyWidth(next, stripWidth());
    setReplyWidth(clamped);
    return clamped;
  };
  const onReplyResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = paneRef.current?.getBoundingClientRect().width ?? replyWidth ?? REPLY_MIN_WIDTH;
    let latest = startWidth;
    event.preventDefault();
    try { handle.setPointerCapture(event.pointerId); } catch { /* moves still arrive on the handle */ }
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    // An iframe swallows pointer moves: the spec's screen frames, while the
    // drag runs.
    const frames = Array.from(paneRef.current?.querySelectorAll<HTMLIFrameElement>('iframe') || []);
    frames.forEach((frame) => { frame.style.pointerEvents = 'none'; });
    // Dragging toward the thread's own edge widens it: the divider is its
    // inline-start edge, the left in English and the right in Arabic.
    const onMove = (move: PointerEvent) => { latest = commitReplyWidth(startWidth - dirSign() * (move.clientX - startX)); };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      try { handle.releasePointerCapture(event.pointerId); } catch { /* already released */ }
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      frames.forEach((frame) => { frame.style.pointerEvents = ''; });
      writeReplyWidth(latest);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  };
  const onReplyResizeKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const base = replyWidth ?? Math.round(paneRef.current?.getBoundingClientRect().width || REPLY_MIN_WIDTH);
    // An arrow toward the divider widens the thread, as the drag does.
    const toward = event.key === 'ArrowLeft' ? 1 : -1;
    writeReplyWidth(commitReplyWidth(base + toward * dirSign() * REPLY_WIDTH_STEP));
  };
  // #6019: a private thread in their chat with the bot is theirs alone
  // until they File it or Post it under the bot's offer: its head says so,
  // its foot has the door that applies (./private-thread-bar.tsx). 1 Nov 2026: every one, not only
  // those off a message of theirs: a "+" thread, a draft the bot opened and
  // a design thread hang off a line of the bot's, and the server says
  // whether it is theirs (`mine`). Read before the early return, so the hook
  // holding where it stands always runs.
  const meId = Number(typeof window !== 'undefined' ? (window as any).App?.user?.id : 0) || 0;
  const privateRootMessage = thread?.root || snap.messages.find((item) => item.id === rootId) || null;
  const privateRoot = rootId && snap.active?.kind === 'direct' && threadsAllowed(snap.active) && snap.active.homeroomBot
    && privateRootMessage && !requestPageOf(privateRootMessage)
    ? rootId : null;
  const [privateWhere, setPrivateWhere] = usePrivateThread(privateRoot);
  const privateMine = !!privateRoot && isOwnPrivateThread(privateWhere, privateRootMessage, meId);
  // 20 Nov 2026 (live-draft review, G and I): the thread's live draft, read
  // and kept current here now that it has no bar (./live-draft-bar.tsx): its
  // preview comes up when the bot opens it, reloads after each edit, and the
  // Artifacts button shows it. Read before the early return, as the hooks
  // above are.
  const liveDraft = useLiveDraft(privateMine && privateRoot && privateWhere?.state === 'open' ? privateRoot : null);
  // #6159: what they write in a done thread brings it back (the server's
  // reopenOnReply): its state is read again once their message is in it.
  const ownCount = (thread?.messages || []).filter((item) => !item.sender.bot && item.sender.id === meId && item.id > 0).length;
  useEffect(() => {
    if (!privateRoot || privateWhere?.state !== 'done' || !ownCount) return;
    fetch(`/api/conversations/homeroom-bot/threads/${privateRoot}`, { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (data && typeof data.state === 'string' && data.state !== 'done') setPrivateWhere(data); })
      .catch(() => {});
  }, [ownCount]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!conversationId || !rootId) return null;
  const active = snap.active;
  const kind = active?.kind || 'group';
  const root = thread?.root || snap.messages.find((item) => item.id === rootId) || null;
  // One request, one story: the bot's chat names the thread by its request.
  const botChat = kind === 'direct' && threadsAllowed(active);
  // 31 Oct 2026: a request's story is the request's page (./request-page.ts),
  // which the store opens instead (store.openThread, loadReplyThread): no
  // thread of this chat's is drawn for it, even for the moment that takes.
  if (botChat && kind === 'direct' && requestPageOf(root)) return null;
  // #6863: alone in the bot tab's column, a private thread is one compact
  // sheet of three cards, drawn as a public thread is (app.css "A PRIVATE
  // THREAD WITH THE BOT IS ONE COMPACT SHEET"). Its head holds the bot's
  // round picture: the conversation's peer carries the platform's `bot`
  // flag, and a roster that only names the bot's handle is marked the same
  // way. With neither, the tile falls back to the thread's initials.
  const sheet = alone && botChat;
  const other = active
    ? active.peer && active.peer.id !== meId
      ? active.peer
      : active.members.find((member) => isBotMention(member.username)) || null
    : null;
  const face = sheet && other ? (other.bot ? other : { ...other, bot: true }) : null;
  const rootMeta = botChat && root?.sender.bot ? root.metadata?.homeroomBot || null : null;
  // #6071 follow-up: a thread from the bot's "+" is named by what it is for
  // and its project, never as a request it is not.
  const started = rootMeta?.kind === 'opened_thread' ? rootMeta : null;
  const request = rootMeta && !started ? botRequestNames(rootMeta) : null;
  const where = started ? (started.appName || started.appSlug || t('messages:newThread.anyProject'))
    : request ? request.project : active ? (kind === 'channel' ? `#${active.channelKey || active.title}` : active.title) : '';
  const replies = thread?.messages || [];
  // 1 Nov 2026: alone in the bot tab's column a thread is named as the tab's
  // list names it (./private-thread-bar.tsx privateThreadTitle). 14 Nov
  // 2026: by the server's name for it when it has one ("Earlier chat",
  // "Plant Pal, first version"), never by the first words under it.
  const aloneTitle = alone
    ? serverThreadName(privateRoot, privateWhere)
      || privateThreadTitle(root, replies, meId) || (started ? startedThreadTitle(t, started.changeKind) : t('messages:replies.title'))
    : null;
  // #6118: the name the reply header ellipsises, computed once for its hint.
  const replyTitle = started ? startedThreadTitle(t, started.changeKind) : request ? botThreadTitle(request) : t('messages:replies.title');
  // A plan in a request's thread carries the step of the card it hangs off (./bot-plan.tsx).
  const cardId = root && isActivityMessage(root) ? root.id : null;
  // 14 Nov 2026: A FIRST VERSION'S PLAN IS A REPLY OF ITS OWN THREAD. With no
  // Main Chat, a project's first version has one thread: the line that says
  // it is being set up, then its activity card, its plan and the card Build
  // it moves under the plan, each a reply. They used to be messages of the
  // main stream, which read them together (planLayout): the card above its
  // plan is not drawn, the plan carries its step, and a card Build it moved
  // is drawn where it went. A thread that hangs off no card reads its own
  // replies the same way, as the stream they now are. Drawn one by one, the
  // card stood above the plan as a strip of its own and the plan had no step.
  const flatPlans = botChat && !cardId
    ? planLayout(replies.map((message) => (message.threadRootId ? { ...message, threadRootId: null } : message)))
    : NO_PLAN_LAYOUT;
  const carried = (message: ConversationMessage) => botChat && !cardId
    && (flatPlans.hidden.has(message.id) || isMovedActivity(message));
  // #5219: on a request's thread the request's public discussion rides
  // along, and the two read in one transcript, in the order they were said.
  // Ties keep the DM replies first (the sort is stable); a reply still in
  // flight (an optimistic local echo) stays last, whatever its time.
  const discussion = thread?.discussion || null;
  type MergedRow =
    | { kind: 'reply'; message: ConversationMessage }
    | { kind: 'discussion'; message: DiscussionMessage };
  const merged: MergedRow[] = [
    ...replies.filter((message) => !carried(message)).map((message) => ({ kind: 'reply' as const, message })),
    ...(discussion?.messages || []).map((message) => ({ kind: 'discussion' as const, message })),
  ];
  if (merged.length > 1) {
    merged.sort((a, b) => (a.message.createdAt < b.message.createdAt ? -1 : a.message.createdAt > b.message.createdAt ? 1 : 0));
    const inFlight = merged.filter((row) => row.kind === 'reply' && row.message.id < 0);
    if (inFlight.length) {
      merged.splice(0, merged.length,
        ...merged.filter((row) => !(row.kind === 'reply' && row.message.id < 0)),
        ...inFlight);
    }
  }
  // Phone review S6 (23 Nov 2026): A THREAD THE PERSON OPENED STARTS WITH
  // THEIR OWN WORDS, NOT A REPLY. A new chat's thread hangs off the bot's
  // "New thread." line, which is not drawn, so its first message is the
  // person's, and it names the thread. Counted, a thread just sent said
  // "1 reply" under its own title. It is not counted, and with nothing else
  // in the thread yet (the bot has not answered) there is no count line.
  let previous: MergedRow | null = null;
  let newLineDrawn = false;
  // Which try each entry belongs to: one divider where a try begins.
  const tryStarts = track && track.tryStarts.length > 1 ? track.tryStarts.map((at) => Date.parse(at)).filter(Number.isFinite) : [];
  let lastTry = 0;
  const tryDivider = (createdAt: string) => {
    if (!tryStarts.length) return null;
    const at = Date.parse(createdAt);
    const which = Math.max(1, tryStarts.filter((start) => start <= at).length);
    if (which === lastTry) return null;
    lastTry = which;
    const date = new Date(tryStarts[which - 1]).toLocaleDateString(undefined, inZone({ day: 'numeric', month: 'short' }));
    return (
      <div className="messages-reply-count" data-bot-try={which}>
        <span>{t('messages:bot.track.tryDivider', { number: String(which), date })}</span>
      </div>
    );
  };
  // 20 Nov 2026: the thread's two parts, drawn either way below: its
  // opening message, and the replies under it.
  // The root's Reply quotes it into THIS thread's composer (#2387): its
  // own threadRootId is null, being the main stream's message.
  // #6668: a thread opened from the bot's "+" opens on what the person
  // wrote, not on the bot's "New thread." line (Main Chat left that
  // line out too, #6250). The root still names the thread; it is only
  // not drawn.
  const rootRow = root && !(botChat && isPlusThreadOpener(root)) ? <MessageRow message={{ ...root, thread: null, threadRootId: rootId }} conversationId={conversationId} channels={channels} kind={kind} inThread botChat={botChat} flat={sheet} /> : null;
  // (S6, above: the root not drawn is that "New thread." line.)
  const opensWithOwnWords = sheet && !!root && !rootRow
    && merged[0]?.kind === 'reply' && merged[0].message.sender.id === meId;
  const counted = merged.length - (opensWithOwnWords ? 1 : 0);
  const repliesPart = (
    <>
          {/* An error stands in place of the thread (#5219 review): with one,
              the count line would say "No replies yet", which is a different
              answer to the same question, so it waits. */}
          {thread?.error || (opensWithOwnWords && !counted) ? null : (
            <div className="messages-reply-count" aria-hidden={!merged.length}>
              <span>{counted ? t('messages:replies.count', { count: counted }) : thread?.loading ? t('messages:replies.loading') : t('messages:replies.none')}</span>
            </div>
          )}
          {thread?.loading && !merged.length && !thread.error ? <ReplyRowSkeleton /> : null}
          {/* #6148: the row holds its height and, while an earlier page
              loads, the "Loading…" line; the button returns only to retry a
              failed load. Scrolling up to here does the rest. */}
          {(thread?.nextBefore || discussion?.more) ? (
            <div ref={earlierRow} className="flex min-h-12 flex-wrap items-center justify-center gap-x-3 gap-y-1 py-2" data-load-earlier-replies="">
              {thread?.nextBefore
                ? thread.loading
                  ? <span role="status" className="text-[13px] text-zinc-500 dark:text-zinc-400">{t('messages:replies.loadingEarlier')}</span>
                  : earlierFailed
                    ? <button type="button" onClick={() => { setEarlierFailed(false); void earlierReplies().then((ok) => { if (!ok) setEarlierFailed(true); }); }} className="messages-load-older">{t('messages:replies.loadEarlier')}</button>
                    : null
                : null}
              {discussion?.more ? <a className="messages-load-older" href={issueRefHref(discussion.appSlug, String(discussion.issueNumber))}>{t('messages:replies.discussion.more')}</a> : null}
            </div>
          ) : null}
          {thread?.error ? <div className="messages-state messages-state-error"><p>{thread.error}</p><button type="button" onClick={() => void loadReplyThread(conversationId, rootId, true)}>{t('core:common.tryAgain')}</button></div> : null}
          {merged.map((entry) => {
            const divider = tryDivider(entry.message.createdAt);
            if (entry.kind === 'discussion') {
              const row = <DiscussionRow key={`discussion-${entry.message.id}`} message={entry.message} appSlug={discussion.appSlug} issueNumber={discussion.issueNumber} />;
              return divider ? <Fragment key={`discussion-${entry.message.id}`}>{divider}{row}</Fragment> : row;
            }
            const { message } = entry;
            const grouped = !!previous && previous.kind === 'reply' && !previous.message.failed && !message.failed
              && groupsWithPrevious(
                { author: previous.message.sender.id, at: previous.message.createdAt },
                { author: message.sender.id, at: message.createdAt, reply: !!message.reply },
              );
            previous = entry;
            // B19 follow-up: the "New" line above the first reply not read when it opened.
            // (Above the first reply drawn from there on: the one it names may be
            // a card its plan carries, which is not drawn.)
            const line = firstUnread && !newLineDrawn && message.id >= firstUnread
              ? <NewMessagesDivider key="unread-line" ref={unreadLine} /> : null;
            if (line) newLineDrawn = true;
            const row = <MessageRow key={message.clientKey || message.id} message={{ ...message, threadRootId: message.threadRootId || rootId }} conversationId={conversationId} grouped={grouped && !divider} channels={channels} kind={kind} inThread botChat={botChat} flat={sheet} focused={flashId === message.id} planCardId={isPlanMessage(message) ? cardId || flatPlans.cardOf.get(message.id) || null : null} />;
            return divider || line ? <Fragment key={message.clientKey || message.id}>{divider}{line}{row}</Fragment> : row;
          })}
          {threadWorking ? <BotWorkingCard typist={threadWorking} /> : null}
          {privateRoot && privateMine && root ? (
            <PrivateThreadDoors
              rootId={privateRoot}
              text={privateThreadWords(root, replies, meId)}
              name={privateThreadName(root, replies)}
              where={privateWhere}
              botReplied={replies.some((message) => message.sender.bot)}
              invited={newProjectInvited(root, replies)}
              working={!!threadWorking}
            />
          ) : null}
    </>
  );
  // A PRIVATE THREAD IS DRAWN ON A PUBLIC THREAD'S PAGE (20 Nov 2026). Alone
  // in the bot tab's column, the thread is the page a request's thread is
  // drawn on (../group-chat/thread-page.tsx),
  // as a request's page is drawn in the same column: the head card every
  // thread leads with (../dev-board/topic/thread-head.tsx), floating over the
  // page and tightening as it scrolls; the opening message as the first card,
  // whose foot says where the thread went (./private-thread-bar.tsx
  // PrivateThreadFoot); the replies as the second; and the reply box at the
  // foot, as wide as the cards. #6863 drew it as a sheet of its own, a 446px
  // strip whose replies scrolled inside the middle card, and its copy of the
  // public head drifted within a day (Preview forced into the round button).
  // Every other thread keeps the pane below.
  const page = sheet;
  const footShown = privateMine && !!privateWhere && (privateWhere.state !== 'open' || !!privateWhere.made);
  return (
    <aside
      ref={paneRef}
      {...drop.handlers}
      className={`messages-reply-pane platform-kb-column${page ? '' : ' dc-lift dc-lift-session'}`}
      style={replyWidth != null ? { '--messages-reply-width': `${replyWidth}px` } as CSSProperties : undefined}
      aria-label={t('messages:replies.paneName')}
      data-bot-sheet={sheet ? '' : undefined}
      data-thread-page-host={page ? '' : undefined}
      data-reply-thread={rootId}
    >
      {/* #5691: the divider between the chat and this thread, dragged to
          trade room between them (and stepped by the arrow keys). It is
          drawn from 768px up only, where the two panes sit side by side. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('messages:replies.resize')}
        aria-valuenow={replyWidth != null ? Math.round(replyWidth) : undefined}
        aria-valuemin={REPLY_MIN_WIDTH}
        tabIndex={0}
        className="messages-reply-resizer"
        data-reply-resizer=""
        onPointerDown={onReplyResizeStart}
        onKeyDown={onReplyResizeKey}
      />
      {page ? (
        <ThreadPage
          kind="private"
          label={aloneTitle || t('messages:replies.paneName')}
          scroller={scroller}
          scrollClassName="messages-reply-scroll platform-safe-scroll"
          scrollProps={{ 'aria-live': 'polite' }}
          back={onBack ? (
            <button type="button" className="dev-topic-back un-touch-target" data-reply-back="" onClick={onBack} title={t('messages:ai.drawer.back')}>
              <ChevronLeftIcon className="dev-topic-back-icon" aria-hidden="true" />
              <span>{t('messages:ai.drawer.back')}</span>
            </button>
          ) : null}
          bar={(
            <ThreadHeadCard
              attrs={{ 'data-reply-head': 'alone' }}
              tile={<span className="dev-thread-bar-tile dev-thread-bar-face" data-reply-avatar=""><UserAvatar user={face} title={aloneTitle || undefined} size="lg" shape="circle" /></span>}
              // #6963: the way back to the list, before the tile (thread-head.tsx).
              lead={showListButton}
              // The lock line is the small line's own part that gives way
              // first in a narrow head, as a request's project does: it is
              // the head's `.messages-thread-sub`, as it was in the pane's.
              line={null}
              title={<div className="messages-thread-name line-clamp-2 dev-request-bar-title" data-reply-title="" title={aloneTitle || undefined}>{aloneTitle}</div>}
              sub={(
                <div className="messages-thread-sub" data-private-thread-sub="">
                  <LockIcon className="dev-thread-bar-lock" aria-hidden="true" />{t('messages:ai.thread.sub')}
                </div>
              )}
              menu={(
                <>
                  {isDesignRoot(root) && !snap.route.embedded ? <DesignViewSwitch onView={setDesignView} /> : null}
                  {/* I: one Artifacts button, whenever the thread holds an
                      artifact or runs a live draft; it toggles the column. */}
                  <ArtifactsButton conversationId={conversationId} rootId={rootId}
                    hasArtifact={isDesignThread(root, replies)} liveDraft={liveDraft}
                    className="messages-thread-action messages-thread-preview dev-thread-head-text" />
                  {privateMine && privateRoot && privateWhere ? (
                    <ThreadDoneMenu rootId={privateRoot} done={privateWhere.state === 'done'} name={aloneTitle}
                      onChanged={(state) => setPrivateWhere({ ...privateWhere, state })}
                      onRenamed={(title) => setPrivateWhere({ ...privateWhere, title, titled: 'person' })} />
                  ) : null}
                </>
              )}
              exits={onBack ? null : (
                <span className="dev-thread-exits" data-thread-exits="">
                  <button type="button" className="messages-thread-action dev-thread-exit" data-reply-close="" aria-label={t('messages:replies.close')} title={t('messages:replies.close')} onClick={() => closeThread()}>
                    <XIcon aria-hidden="true" />
                  </button>
                </span>
              )}
            />
          )}
          foot={(
            <>
              <JumpToLatest scroller={scroller} />
              <ChatStatusLine className="messages-typing">{typingLine(t, threadTyping)}</ChatStatusLine>
              <MessageComposer threadRootId={rootId} scroller={scroller} />
            </>
          )}
        >
          {/* The opening card is always drawn, as a public page's is, so the
              page is always drawn as cards (app.css reads the card). A thread
              begun from New chat shows no opening line (the bot's "New
              thread.", above), so its card holds only where the thread stands,
              and with nothing to hold it is not drawn at all. */}
          <div className="dev-thread-page-post" data-thread-page-post="">
            <div className="dev-request-root dev-thread-card" data-thread-card="">
              {rootRow ? <div className="min-w-0">{rootRow}</div> : null}
              {footShown ? (
                <PrivateThreadFoot where={privateWhere} rootId={privateRoot}
                  onChanged={(state) => { if (privateWhere) setPrivateWhere({ ...privateWhere, state }); }} />
              ) : null}
            </div>
          </div>
          <div className="dev-thread-page-replies" data-thread-page-replies="">{repliesPart}</div>
        </ThreadPage>
      ) : (
        <>
          <header className="messages-thread-header" data-reply-head={alone ? 'alone' : undefined}>
            {/* #6963: the list is hidden, and this is the way back to it —
                first in the head, where a phone draws its back arrow. */}
            {showListButton}
            {alone && onBack ? (
              <button type="button" className="messages-thread-action messages-thread-back" data-reply-back=""
                aria-label={t('messages:ai.drawer.back')} title={t('messages:ai.drawer.back')} onClick={onBack}>
                <ChevronLeftIcon aria-hidden="true" />
              </button>
            ) : null}
            {/* #6863: the sheet's head card opens on the other member's round
                picture, the way a public thread's head opens on its face. */}
            {sheet ? <span data-reply-avatar=""><UserAvatar user={face} title={aloneTitle || undefined} size="lg" shape="circle" /></span> : null}
            {alone ? (
              // 1 Nov 2026: the thread alone in the column, under its own name
              // and the line that says it is theirs alone.
              <div className="min-w-0 flex-1" title={aloneTitle || undefined}>
                <div className="messages-thread-name min-w-0 truncate" data-reply-title="">{aloneTitle}</div>
                <div className="messages-thread-sub flex min-w-0 items-center gap-1" data-private-thread-sub="">
                  <LockIcon className="h-3 w-3 shrink-0" aria-hidden="true" />
                  <span className="truncate">{t('messages:ai.thread.sub')}</span>
                </div>
              </div>
            ) : (
              <div className="min-w-0 flex-1">
                <div className="messages-thread-name flex min-w-0 items-center gap-2">
                  {request && !request.firstVersion ? <RequestTag number={request.number} size="head" /> : null}
                  <span className="min-w-0 truncate" title={replyTitle}>{started ? startedThreadTitle(t, started.changeKind) : request ? botThreadTitle(request) : t('messages:replies.title')}</span>
                </div>
                {where ? <div className="messages-thread-sub">{where}</div> : null}
              </div>
            )}
            {/* #6071: in a design thread, the way to its preview: on a phone the
                switch back to it. 1 Nov 2026 (C1): in the bot tab's column, any
                thread holding a design (a version said anywhere in it) has
                Preview, which opens the design as the tab's own column
                (../ai/preview.ts), while it is not open already. */}
            {isDesignRoot(root) && !snap.route.embedded ? <DesignViewSwitch onView={setDesignView} /> : null}
            {alone ? (
              <ArtifactsButton conversationId={conversationId} rootId={rootId}
                hasArtifact={isDesignThread(root, replies)} liveDraft={liveDraft}
                className="messages-thread-action messages-thread-preview" />
            ) : null}
            {/* #6159: Mark done, or Reopen, in the thread's own ⋯. */}
            {privateMine && privateRoot && privateWhere ? (
              <ThreadDoneMenu rootId={privateRoot} done={privateWhere.state === 'done'} name={aloneTitle}
                onChanged={(state) => setPrivateWhere({ ...privateWhere, state })}
                onRenamed={(title) => setPrivateWhere({ ...privateWhere, title, titled: 'person' })} />
            ) : null}
            {/* On a phone the Messages screen's header bar has the way back
                (app.css hides this one there, polish N16), and in the bot tab's
                drawer its own back arrow leads the head instead, so no ✕ is
                drawn. 6 Nov 2026 (#6425): on a desktop the ✕ closes the thread,
                leaving the lists alone. */}
            {alone && onBack ? null : (
              <button type="button" className="messages-thread-action" data-reply-close="" aria-label={t('messages:replies.close')} title={t('messages:replies.close')} onClick={() => closeThread()}>
                <XIcon aria-hidden="true" />
              </button>
            )}
          </header>
          {/* Its head says it is theirs alone in the bot tab's column; under
              it, where it went once it was filed or posted. */}
          {privateMine && !(alone && privateWhere?.state === 'open') ? (
            <PrivateThreadNote where={privateWhere} rootId={privateRoot}
              onChanged={(state) => { if (privateWhere) setPrivateWhere({ ...privateWhere, state }); }} />
          ) : null}
          <div ref={scroller} className="messages-thread-scroll messages-reply-scroll platform-safe-scroll chat-transcript" aria-live="polite">
            {rootRow}
            {repliesPart}
          </div>
          <JumpToLatest scroller={scroller} />
          {/* 31 Oct 2026: who is typing in this thread (the bot answering a
              message written here among them), as the conversation's own line
              says it. It was drawn beside the conversation alone, which a phone
              hides while a thread is open. Under Jump to latest, as in every
              chat (1 Nov 2026). */}
          <ChatStatusLine className="messages-typing">{typingLine(t, threadTyping)}</ChatStatusLine>
          <MessageComposer threadRootId={rootId} scroller={scroller} />
        </>
      )}
      {drop.dragging ? <DropOverlay className="messages-drop-overlay" /> : null}
    </aside>
  );
}

/**
 * A reply thread beside an app's channel (#2387) — the same side sheet as a
 * conversation's, filled the way the channel itself is: by the group chat
 * (public/js/group-chat.js), which owns the app chat's transcript, composer,
 * drafts, @ and # menus and its socket. `GroupChat.mountThread` puts a
 * thread's shell and transcript into this host, exactly as it does for an
 * issue's or a proposal's own discussion; this pane is the frame around it.
 *
 * It waits for the channel: the module can only mount a thread for the app
 * it is connected to, and that is the channel pane's to establish.
 */
function AppReplyThreadPanel({ slug, rootId }: { slug: string; rootId: number }) {
  const t = useMessages('messages');
  const snap = useMessagesSnapshot();
  const context = snap.discussionContext;
  const ready = !!context && context.slug === slug;
  const handle = snap.discussions.find((item) => item.slug === slug)?.channel || null;
  const back = `#messages/app/${encodeURIComponent(slug)}`;
  return (
    <AppReplyThreadPane
      slug={slug}
      rootId={rootId}
      ready={ready}
      readOnly={ready ? context.readOnly : true}
      where={handle ? `#${handle}` : (ready ? context.name : slug)}
      close={(
        <a className="messages-thread-action" href={back} aria-label={t('messages:replies.close')} title={t('messages:replies.close')}>
          <XIcon aria-hidden="true" />
        </a>
      )}
    />
  );
}

/**
 * The pane itself, for the two places an app channel's reply thread opens:
 * beside the channel here, and beside it in its project page's Discussion
 * tab (#3653, ../dev-board/workshop/project-discussion.tsx), which closes it
 * in place rather than by an address. `ready` holds the mount until the
 * caller knows whether the viewer may write.
 */
export function AppReplyThreadPane({ slug, rootId, ready, readOnly, where, close }: {
  slug: string;
  rootId: number;
  ready: boolean;
  readOnly: boolean;
  where: string;
  close: ReactNode;
}) {
  const t = useMessages('messages');
  const host = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = host.current;
    if (!el || !ready) return undefined;
    const chat = (window as any).GroupChat;
    let live = true;
    let tries = 0;
    let timer = 0;
    const mount = () => {
      if (!live) return;
      // The channel pane connects the module a macrotask after it mounts;
      // wait for it rather than connecting a second time from here.
      if (chat?.appSlug !== slug && tries < 40) { tries += 1; timer = window.setTimeout(mount, 50); return; }
      chat?.mountThread?.({
        type: 'message',
        ref: rootId,
        container: el,
        fullHeight: true,
        readOnly,
        placeholder: translate('messages:replies.app.placeholder'),
        notice: translate('messages:replies.app.membersOnly'),
      });
    };
    timer = window.setTimeout(mount, 0);
    return () => {
      live = false;
      window.clearTimeout(timer);
      const list = el.querySelector('#gc-thread-messages');
      if (list) (window as any).UsernodeReact?.groupChat?.unmountTranscript?.(list);
      unmountLegacyPortal(el);
      if (chat?.activeThread?.type === 'message' && Number(chat.activeThread.ref) === rootId) chat.unmountThread?.();
    };
  }, [slug, rootId, ready, readOnly]);
  return (
    <aside className="messages-reply-pane messages-reply-pane-app" aria-label={t('messages:replies.paneName')} data-reply-thread={rootId}>
      <header className="messages-thread-header">
        <div className="min-w-0 flex-1">
          <div className="messages-thread-name">{t('messages:replies.title')}</div>
          <div className="messages-thread-sub">{where}</div>
        </div>
        {close}
      </header>
      {/* The host's class string is constant and its subtree is the group
          chat's — the one-owner rule, satisfied at this boundary. */}
      <div ref={host} className="messages-reply-host flex-1 min-h-0" />
    </aside>
  );
}

/**
 * A conversation drawn IN ITS COMMUNITY'S PAGE (#3494): #general, on
 * Homeroom's Discussion tab (features/dev-board/workshop/project-discussion.tsx).
 *
 * Every other project's Discussion tab mounts its own chat in place, under
 * the page's header and tabs. #general is a conversation of this store
 * rather than an app chat, so it went to the Messages screen instead, which
 * swapped the header, the tabs and the tint for Messages' own (#3491). This
 * is the same thread, composer and reply threads, mounted in the page:
 * while `active` it holds the store's one route (`embed`), and it gives it
 * back when it leaves the screen or unmounts (`release`). The Messages
 * screen takes the store back whenever it opens — its route() replaces an
 * embedded one — and the effect below re-embeds once it has closed again.
 *
 * `messages-layout` carries the thread's surface tokens; it is not this
 * screen's strip, so none of the strip's own classes come with it.
 */
/**
 * A room on its way, as the room says it itself (ConversationThread's own
 * loading row, in its scroller). A project's channel shows it from its first
 * frame until its messages are in, so the channel loads in one state rather
 * than a card skeleton, then "#general" over "Loading messages…", then its
 * messages (polish board #19).
 */
export function ChannelLoading(): ReactNode {
  const t = useMessages('messages');
  return (
    <div className="messages-thread-scroll" data-channel-loading="">
      <div className="messages-state"><span className="messages-spinner" />{t('messages:thread.loading')}</div>
    </div>
  );
}

export function EmbeddedConversation({ conversationId, active, at = null, threadsOnly = false, onBack = null }: {
  conversationId: number;
  active: boolean;
  /**
   * 14 Nov 2026: this copy is the chat with Homeroom bot on its tab
   * (features/ai/), a column of 400 to 720px (or a phone's drawer), where
   * every conversation is a thread. The conversation's own stream is never
   * read, drawn, marked read or scrolled (store.ts loadThreadsOnly): only
   * the one thread open, alone under its own head (ReplyThreadPanel
   * `alone`), and New chat's screen live here.
   */
  threadsOnly?: boolean;
  /** A phone's drawer: the thread's back arrow, to the tab's list. */
  onBack?: (() => void) | null;
  /**
   * #3653: where a door into the room asked to land — a reply thread, or a
   * message. Each one is taken ONCE, when the room is put in place or at
   * once if it already is: a room put back later (the page shown again)
   * opens as the reader left it, not at a door they followed before.
   */
  at?: { threadRootId: number | null; focusMessageId: number | null } | null;
}) {
  const snap = useMessagesSnapshot();
  const here = !!snap.route.embedded && snap.route.conversationId === conversationId;
  const messagesOpen = snap.route.open;
  const atRef = useRef(at);
  atRef.current = at;
  const taken = useRef<typeof at>(null);
  const take = () => {
    const next = atRef.current && atRef.current !== taken.current ? atRef.current : null;
    if (next) taken.current = next;
    return next;
  };
  useEffect(() => {
    if (!active || messagesOpen) return undefined;
    embed(conversationId, take(), { threadsOnly });
    return () => release(conversationId);
  }, [active, messagesOpen, conversationId, threadsOnly]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!active || messagesOpen) return;
    const next = take();
    if (next) embed(conversationId, next, { threadsOnly });
  }, [at]); // eslint-disable-line react-hooks/exhaustive-deps
  // #6071 follow-up: a new chat with Homeroom bot, in the thread's place.
  const blank = useNewThread(conversationId) && here && !snap.route.threadRootId;
  if (threadsOnly) {
    return (
      <div className={`messages-layout messages-layout-embedded messages-has-reply-thread${blank ? ' messages-has-blank-thread' : ''}`} data-bot-threads="">
        {here ? <BotThreadsSync conversationId={conversationId} /> : null}
        {here && snap.route.threadRootId ? <ReplyThreadPanel alone onBack={onBack} /> : null}
        {blank ? <NewThreadPanel conversationId={conversationId} /> : null}
      </div>
    );
  }
  return (
    <div className={`messages-layout messages-layout-embedded${here && (snap.route.threadRootId || blank) ? ' messages-has-reply-thread' : ''}${blank ? ' messages-has-blank-thread' : ''}`}>
      {here ? <ConversationThread embedded /> : <ChannelLoading />}
      {here && snap.route.threadRootId ? <ReplyThreadPanel onBack={onBack} /> : null}
      {blank ? <NewThreadPanel conversationId={conversationId} /> : null}
    </div>
  );
}

/**
 * What the chat with Homeroom bot keeps current while one of its threads is
 * drawn with no stream beside it (EmbeddedConversation `threadsOnly`): where
 * each request stands (./bot-work.tsx) and the bot's activity cards
 * (./bot-activity.tsx), which a thread's plan, its tries and its cards read.
 * The conversation's own transcript mounted both; here the open thread's
 * newest message from the bot is the news that moves them on. Renders
 * nothing.
 */
function BotThreadsSync({ conversationId }: { conversationId: number }) {
  const snap = useMessagesSnapshot();
  const thread = snap.thread && snap.thread.conversationId === conversationId ? snap.thread : null;
  const newsKey = thread ? newestBotMessageId(thread.messages) : null;
  return (
    <>
      <BotWorkSync conversationId={conversationId} newsKey={newsKey} />
      <BotActivitySync conversationId={conversationId} newsKey={newsKey} />
    </>
  );
}

export function MessagesScreen() {
  const screenRef = useRef<HTMLElement | null>(null);
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const snap = useMessagesSnapshot();
  const designView = useDesignView();
  useVisibilityHiddenClass(screenRef, 'messages-screen', false);
  useEffect(() => initializeMessagesStore(), []);
  // #3407: and again when #general's hub becomes known (store.ts).
  useEffect(() => followPlatformSlug(), []);
  useEffect(() => { if (snap.route.open) syncChrome(); },
    // The DISCUSSION's two facts belong here for the same reason the
    // conversation's title does: on a phone this is what names the thread in
    // the bar and puts the chevron back to the list. Without them, opening a
    // discussion kept the previous thread's name.
    [snap.active?.title, snap.route.open, snap.route.conversationId,
      snap.route.appSlug, snap.discussionContext?.name, snap.route.threadRootId]);
  // #2387: full width applies to any open discussion — a conversation or an
  // app channel (each carries the toggle). With nothing open the list is
  // there: it is the only thing to show.
  const chatOpen = !!(snap.route.conversationId || snap.route.appSlug);
  // A CHANNEL OPENS FULL WIDTH. It is its community's room, reached from the
  // community's hub, and the list beside it is people — a column
  // of other things beside a room that is not in it. So there is no list
  // for it to sit beside, whatever the full-width preference says.
  const channelOpen = !!snap.route.appSlug
    || (!!snap.route.conversationId && snap.active?.id === snap.route.conversationId && snap.active?.kind === 'channel');
  // THE PHONE'S DRAWER (./phone-drawer.tsx): the list, the whole screen, and
  // a conversation with people sliding in over it.
  const drawer = useMessagesDrawer(layoutRef, snap.route, snap.active, barWords);
  const drawerClass = drawer.on ? ` messages-drawer${drawer.level === 0 ? ' messages-drawer-alone' : ''}` : '';
  // ON A DESKTOP, with nothing open, the whole list is the page (All
  // messages), with its search and previews; an open conversation has the
  // list beside it. (v3, 18 Oct 2026, put the list in the sidebar under
  // Messages and drew one pane at a time; on 7 Nov 2026 the sidebar kept its
  // nesting for communities alone, so the list is the inbox's own again.)
  const sidebarRows = useSidebarRows();
  const railClass = sidebarRows && !drawer.on && !chatOpen ? ' messages-list-page' : '';
  // #6071: a design thread draws its preview in the conversation's place
  // (./design-pane.tsx); on a phone the preview and the thread take turns.
  const designRootId = snap.route.conversationId && snap.route.threadRootId && !snap.route.embedded ? snap.route.threadRootId : null;
  const designRoot = designRootId
    ? (snap.thread?.rootId === designRootId ? snap.thread.root : null) || snap.messages.find((item) => item.id === designRootId) || null
    : null;
  const designOpen = !!designRootId && isDesignRoot(designRoot);
  const designClass = designOpen ? ` messages-has-design messages-design-view-${designView}` : '';
  // #6071 follow-up: a blank thread from Homeroom bot's "+", in the thread's place.
  const blankThread = useNewThread(snap.route.conversationId) && !snap.route.threadRootId && !snap.route.embedded;
  const layout = `messages-layout dc-lift dc-lift-strip${(snap.listCollapsed && chatOpen) || channelOpen ? ' messages-list-collapsed' : ''}${chatOpen && (snap.route.threadRootId || blankThread) ? ' messages-has-reply-thread' : ''}${railClass}${drawerClass}${designClass}`;
  // No background of its own: the route paints the wallpaper (the
  // body:has(#messages-screen) rules in app.css), and the two frosted planes
  // need a transparent ancestor chain to have anything to blur.
  return (
    <>
      <main ref={screenRef} id="messages-screen" className="hidden flex-1 min-h-0 overflow-hidden" style={{ position: 'relative' }}>
        <div ref={layoutRef} className={layout} data-messages-drawer={drawer.on ? drawer.level : undefined} {...(drawer.handlers || {})}>
          <ConversationList drawer={drawer.on} />
          <ScreenConversation />
          {designOpen && snap.route.conversationId && designRootId ? (
            <DesignPane conversationId={snap.route.conversationId} rootId={designRootId} view={designView} onView={setDesignView} />
          ) : null}
          {snap.route.conversationId && snap.route.threadRootId && !snap.route.embedded && snap.active?.kind !== 'channel' ? <ReplyThreadPanel /> : null}
          {blankThread && snap.route.conversationId ? <NewThreadPanel conversationId={snap.route.conversationId} /> : null}
          {snap.route.appSlug && snap.route.threadRootId ? <AppReplyThreadPanel slug={snap.route.appSlug} rootId={snap.route.threadRootId} /> : null}
        </div>
      </main>
      <CreateConversationDialog />
      <ConversationMembersDialog />
      <ShareItemDialog />
      <ShareToDialog />
    </>
  );
}

if (typeof window !== 'undefined') {
  const host = (window.UsernodeReact ||= {});
  host.messages = messagesController;
}

export { messagesController };
