import { openReport } from '../dialogs/report';
import {
  memo, useDeferredValue, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import { groupsWithPrevious } from '@/components/ui/chat';
import {
  ArrowsPointingInIcon, ArrowsPointingOutIcon, ChatIcon, ChevronDownIcon, DraftTrashIcon, EllipsisHorizontalIcon, PlusIcon,
  SearchIcon, SparklesIcon, UserGroupIcon, XIcon,
} from '@/components/ui/icons';
import { Skeleton, SkeletonGroup } from '@/components/ui/skeleton';
import { placeUnderAnchor, type AnchorRect } from '../../lib/anchor-popover';
import { cardRunLabel, cardRunStarts } from '../../lib/card-runs';
import { useComposerKeyboard } from '../../lib/composer-keyboard';
import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { unmountLegacyPortal } from '../../lib/legacy-portals';
import { confirmAction } from '../../lib/confirm';
import { useMenuKeyboard } from '../../lib/menu-keys';
import { anchorRectOf, useAnchoredDismiss } from '../../lib/popover-dismiss';
import { agoStamp, timeOfDay } from '../../lib/timestamp';
import { useStoreState } from '../../lib/use-store-state';
import { useVisibility, useVisibilityHiddenClass } from '../../lib/visibility-store';
import * as api from './api';
import { BotActivitySync } from './bot-activity';
import { BotWorkButton, BotWorkPanel, BotWorkStatusLine, BotWorkSync, newestBotMessageId } from './bot-work';
import { MessageComposer } from './composer';
import { CreateConversationDialog } from './create-dialog';
import { ConversationMembersDialog } from './members-dialog';
import { fullTime, UserAvatar, senderName } from './format';
import { MessageRow } from './message-row';
import { plainText } from './plain-text';
import { useDismiss } from '../message-actions/use-dismiss';
import { ShareItemDialog } from './share-dialog';
import { ShareToDialog } from './share-to-dialog';
import { useStickToBottom } from './stick-to-bottom';
import {
  agentThreadAddress,
  closeThread,
  embed,
  fullScreenAddress,
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
  openAgentThread,
  renameConversation,
  openThread,
  release,
  respond,
  setUserBlocked,
  selectConversation,
  setListCollapsed,
  setShowMoreChannels,
  syncChrome,
  followPlatformSlug,
  setFilter,
  typingUsers,
  useChannelHandles,
  useMessagesSnapshot,
  openBot,
} from './store';
import { AppIconContent, AppIconLink, appIconKind } from '../apps/app-card-view';
import { PageBackButton } from '../dev-board/workshop/page-back';
import { generalHubBack, openChannelHub, usePlatformSlug } from './channel-hub';
import { ThreadActivityCard } from '../message-actions/thread-activity';
import { GlobalChatPanel } from '../global-chat';
import { AgentSessionPanel } from '../agent-session';
import { useSidePaneBeside } from '../agent-session/spec-layout';
import { ACTIVITY_LABEL, agentActivity } from '../agent-session/activity';
import { AgentActivityIcon } from '../agent-session/activity-mark';
import {
  deactivateAgentSession,
  getAgentSessionState,
  loadAgentSessions,
  openAgentSession,
  startAgentSession,
  useAgentSessionSelector,
  useAgentSessions,
} from '../agent-session/store';
import type { AgentSession as MayorSession } from '../agent-session/api';
import {
  deactivateGlobalChat,
  getGlobalChatState,
  initializeGlobalChat,
  openGlobalChat,
  removeGlobalChatThread,
  useGlobalChatSelector,
} from '../global-chat/store';
import { Improve } from '../improve/improve-controller.js';
import { improveStore } from '../improve/improve-store.js';
import { SessionRow, type SessionRowView } from '../improve/session-row';
import { INBOX_FILTERS, buildInbox, sectionRuns, type AgentChat, type AppDiscussion, type InboxFilter, type InboxSection, inClockOrder } from './inbox';
import type { ConversationMessage, ConversationSummary, MessagesAgentThread } from './types';

/*
 * ── The screen, in the widget language ─────────────────────────────────
 *
 * Messages is drawn on the dev session's LIFT LADDER (`.dc-lift` and its two
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
 * The LIST is Discord's too: the chats (people and agents) on top, newest
 * first, then the channels — #general and one per app you are a member of.
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

const ConversationRow = memo(function ConversationRow({ conversation, active }: { conversation: ConversationSummary; active: boolean }) {
  const peer = directPerson(conversation);
  const invited = conversation.membershipStatus === 'invited';
  const unread = conversation.unreadCount > 0;
  // #1808: the shared ago ladder, which stops being relative at a week — a
  // conversation last spoken in during March read "412d", which is a duration
  // and not information. `title` carries the unelided instant either way.
  const activity = agoStamp(conversation.lastActivityAt);
  return (
    <a
      href={`#messages/${conversation.id}`}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        if (window.location.hash === `#messages/${conversation.id}`) {
          event.preventDefault(); selectConversation(conversation.id);
        }
      }}
      className={`messages-conversation-row ${active ? 'messages-conversation-active' : ''}`}
      aria-current={active ? 'page' : undefined}
    >
      <UserAvatar user={conversation.kind === 'direct' ? peer : null} title={peer?.username || conversation.title} size="lg" shape="square" />
      <div className="min-w-0 flex-1">
        {/* Two lines, the row's own geometry: the name with the time on its
            trailing edge, then the preview with the unread count on its. The
            time and the count read as one column, which is what lets an
            unread row state itself three ways — bold name, accent time, count
            pill — without adding a third line. */}
        <div className="messages-row-line">
          <span className="messages-row-name">{conversation.kind === 'direct' && peer ? senderName(peer) : conversation.title}{conversation.kind === 'direct' && peer?.bot ? <span className="messages-bot-badge">AI</span> : null}{conversation.kind === 'group' && !invited ? <span className="messages-group-tag">{conversation.memberCount}</span> : null}</span>
          <time className={`messages-row-time ${unread ? 'messages-row-time-unread' : ''}`} dateTime={conversation.lastActivityAt} title={activity.title}>{activity.text}</time>
        </div>
        <div className="messages-row-line">
          <span className={`messages-row-preview ${invited ? 'messages-row-preview-invited' : ''}`}>{invited ? `${conversation.kind === 'direct' ? 'Message request' : 'Group invitation'} · Tap to review` : conversation.latestSummary || 'No messages yet'}</span>
          {conversation.unreadCount > 0 ? <span className="messages-unread" aria-label={`${conversation.unreadCount} unread`}>{conversation.unreadCount > 99 ? '99+' : conversation.unreadCount}</span> : null}
        </div>
      </div>
    </a>
  );
});

/**
 * The mark that says what KIND of thread a row is (#2718).
 *
 * People get none, and that is the whole design of it: they are the
 * overwhelming majority of an inbox and a pill on every row is a pill that
 * says nothing. The two that are NOT a person say so — which is the
 * arrangement Slack and Teams land on with a channel, a DM and a bot thread
 * in one sidebar, and the one thing that makes a single list readable.
 */
function KindPill({ kind }: { kind: 'agent' }) {
  // Only an agent wears one now (#2783): the channels have a section of
  // their own, headed, so an "App" pill on each of them said it twice.
  return (
    <span className="messages-kind-pill" data-kind={kind}>
      Agent
    </span>
  );
}

/**
 * #general, the room every user is in (#2783).
 *
 * A `channel` conversation, so unlike an app's channel it DOES carry an
 * unread count: it lives in the conversations domain, which keeps a read
 * cursor per member. The tile is the `#` a channel is named with, where a
 * person's row has their face.
 */
const GeneralChannelRow = memo(function GeneralChannelRow({ conversation, active }: { conversation: ConversationSummary; active: boolean }) {
  const unread = conversation.unreadCount > 0;
  const activity = agoStamp(conversation.lastActivityAt);
  const by = conversation.latestMessage?.sender?.username;
  const handle = conversation.channelKey || conversation.title;
  return (
    <a
      href={`#messages/${conversation.id}`}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        if (window.location.hash === `#messages/${conversation.id}`) {
          event.preventDefault(); selectConversation(conversation.id);
        }
      }}
      data-inbox-channel={handle}
      className={`messages-conversation-row messages-channel-row ${active ? 'messages-conversation-active' : ''}`}
      aria-current={active ? 'page' : undefined}
    >
      <span className="messages-inbox-tile messages-channel-tile" aria-hidden="true">#</span>
      <div className="min-w-0 flex-1">
        <div className="messages-row-line">
          <span className="messages-row-name">{handle}</span>
          <time className={`messages-row-time ${unread ? 'messages-row-time-unread' : ''}`} dateTime={conversation.lastActivityAt} title={activity.title}>{activity.text}</time>
        </div>
        <div className="messages-row-line">
          <span className="messages-row-preview">
            {conversation.latestSummary
              ? (by ? `@${by}: ${conversation.latestSummary}` : conversation.latestSummary)
              : 'Everyone on Homeroom'}
          </span>
          {unread ? <span className="messages-unread" aria-label={`${conversation.unreadCount} unread`}>{conversation.unreadCount > 99 ? '99+' : conversation.unreadCount}</span> : null}
        </div>
      </div>
    </a>
  );
});

/**
 * An app's channel — the general thread on its board, one per app the
 * viewer is a member of, including one nobody has spoken in yet (#2783).
 *
 * It carries NO unread count, and its absence is honest rather than an
 * omission: `chat_messages` has no per-viewer read cursor, so a number here
 * would be invented. What the row says instead is when the last thing was
 * said and who said it, which is what makes it worth a tap.
 *
 * An anchor at the channel's address in this inbox, so a modified click
 * opens it in a tab the way every other row on this screen does.
 */
const AppChannelRow = memo(function AppChannelRow({ discussion, active }: { discussion: AppDiscussion; active: boolean }) {
  const activity = discussion.lastAt ? agoStamp(discussion.lastAt) : null;
  // #2387: app channels keep a read cursor now, so they carry a count like
  // #general's — only while the viewer is not reading it.
  const unread = !active && (discussion.unreadCount || 0) > 0 ? discussion.unreadCount || 0 : 0;
  const record = {
    icon_url: discussion.iconUrl,
    icon_emoji: discussion.iconEmoji,
    name: discussion.name,
  };
  const handle = discussion.channel || discussion.slug;
  return (
    <a
      href={`#messages/app/${encodeURIComponent(discussion.slug)}`}
      data-inbox-app={discussion.slug}
      data-inbox-channel={handle}
      className={`messages-conversation-row messages-channel-row ${active ? 'messages-conversation-active' : ''}`}
      aria-current={active ? 'page' : undefined}
    >
      <AppIconLink
        nested
        slug={discussion.slug}
        name={discussion.name}
        data-icon={appIconKind(record as never)}
        className="app-icon-tile messages-inbox-tile"
      >
        <AppIconContent app={record as never} />
      </AppIconLink>
      <div className="min-w-0 flex-1">
        <div className="messages-row-line">
          <span className="messages-row-name">{discussion.name}<span className="messages-channel-handle">#{handle}</span></span>
          {activity
            ? <time className={`messages-row-time ${unread ? 'messages-row-time-unread' : ''}`} dateTime={discussion.lastAt || undefined} title={activity.title}>{activity.text}</time>
            : null}
        </div>
        <div className="messages-row-line">
          <span className="messages-row-preview">
            {discussion.lastMessage
              ? (discussion.lastBy ? `@${discussion.lastBy}: ${plainText(discussion.lastMessage)}` : plainText(discussion.lastMessage))
              : 'No messages yet'}
          </span>
          {unread ? <span className="messages-unread" aria-label={`${unread} unread`}>{unread > 99 ? '99+' : unread}</span> : null}
        </div>
      </div>
    </a>
  );
});

/**
 * An agent chat — a thread with the AI that builds.
 *
 * Read from features/global-chat's own store rather than copied into this
 * one: that list is already loaded, merged on every thread event and
 * invalidated by the chat itself, and a second copy of it is a copy that
 * drifts. The row's address is the same `#chat/<id>` the Improve panel's own
 * list uses.
 */
/**
 * An agent chat, as a row of this inbox.
 *
 * ── It can be DELETED here (#2718 review) ─────────────────────────────
 *
 * The Improve panel's own list of these could, and the panel is retired: it
 * had become a drawer you opened to press one of two buttons, so the buttons
 * moved into the mark's menu and the drawer went. Everything else in it was
 * already somewhere better — the sessions in the Workshop, GitHub and Share
 * in About, these chats in this list — except the delete, which existed
 * nowhere else. So it comes here rather than going away, because retiring a
 * surface is not a reason to retire what only that surface offered.
 *
 * The confirm is a row rather than a dialog, which is what it was: a chat is
 * cheap to lose and a modal over a list to delete one row from it is the
 * heavier gesture.
 */
const AgentChatRow = memo(function AgentChatRow({ chat, active }: { chat: AgentChat; active: boolean }) {
  const at = chat.updatedAt || chat.createdAt || null;
  const activity = at ? agoStamp(at) : null;
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);

  async function remove() {
    if (removing) return;
    setRemoving(true);
    try {
      await removeGlobalChatThread(chat.id);
    } catch {
      setRemoving(false);
      window.PlatformUI?.toast?.('Could not delete this chat.');
    }
  }

  if (confirming) {
    return (
      <div className="messages-conversation-row messages-row-confirm" data-inbox-agent={chat.id}>
        <span className="min-w-0 flex-1">Delete this chat?</span>
        <button
          type="button"
          className="messages-row-confirm-cancel"
          disabled={removing}
          onClick={() => setConfirming(false)}
        >
          Cancel
        </button>
        <button
          type="button"
          className="messages-row-confirm-delete"
          disabled={removing}
          onClick={() => void remove()}
        >
          {removing ? 'Deleting…' : 'Delete'}
        </button>
      </div>
    );
  }
  // #2813: the inbox's own address, so on a desktop the chat opens in the
  // pane beside this list. On a phone the router swaps it for `#chat/<id>`,
  // the full-screen chat this row always led to there.
  const thread: MessagesAgentThread = { kind: 'chat', id: chat.id };
  const href = agentThreadAddress(thread);
  return (
    <a
      href={href}
      data-inbox-agent={chat.id}
      className={`messages-conversation-row ${active ? 'messages-conversation-active' : ''}`}
      aria-current={active ? 'page' : undefined}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        if (window.location.hash === href) { event.preventDefault(); openAgentThread(thread); }
      }}
    >
      <span className="messages-inbox-tile messages-inbox-agent-tile" aria-hidden="true">
        <SparklesIcon className="w-5 h-5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="messages-row-line">
          <span className="messages-row-name">{chat.title || 'Untitled chat'}<KindPill kind="agent" /></span>
          {activity
            ? <time className="messages-row-time" dateTime={at || undefined} title={activity.title}>{activity.text}</time>
            : null}
        </div>
        <div className="messages-row-line">
          <span className="messages-row-preview">
            {chat.busy ? 'Working…' : (chat.summary || 'No messages yet')}
          </span>
        </div>
      </div>
      {/* Inside the anchor, so it rides the row's own layout — and it stops
          the navigation itself, the way the Discover row's Add button does. */}
      <button
        type="button"
        className="messages-row-delete"
        aria-label={`Delete ${chat.title || 'this chat'}`}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setConfirming(true); }}
      >
        <DraftTrashIcon className="w-4 h-4" aria-hidden="true" />
      </button>
    </a>
  );
});

/**
 * A change in flight, as a row of this inbox (#2770, #2772).
 *
 * ── A change IS an agent conversation ─────────────────────────────────
 *
 * A dev session is the viewer talking to the agent that builds, which is
 * what an agent chat is too — so it is listed under Agents beside them, and
 * New change lands on one. Until now Messages → Agents held only the global
 * chats, and a change somebody had just started was findable from the
 * Workshop and the bell's Agents tab but not from here.
 *
 * ── The same row, from the same list ──────────────────────────────────
 *
 * The bell's Agents tab already draws these, with ../improve/session-row.tsx
 * from the Improve store's own list (`sessions` + `otherSessions`, one
 * fetch of /api/me/active-sessions). So this reads that store and draws that
 * row: a second copy of the list would drift, and a second row would let a
 * change's Working / Ready state say two things in two places. The store is
 * also what `Improve.onSessionCreated` publishes into, which is what makes a
 * change started a moment ago appear here at once.
 *
 * NOT GATED ON THE GLOBAL-CHAT FLAGS. Those decide whether the experimental
 * chat exists; a change is not that chat, and every collaborator has one.
 *
 * ── Where the row goes ────────────────────────────────────────────────
 *
 * The session itself, the conversation, rather than the change's card page
 * the bell links. Since #2813 that is `#messages/session/<slug>/<id>`: on a
 * desktop the session opens in the pane beside this list. On a phone the
 * router swaps that address for `#app/<slug>/dev/sessions/<id>`, the
 * full-screen session, which lights the Messages tab and hangs its chevron
 * off this inbox. The router records that (`Improve.enterSessionFrom`) as
 * it swaps, because the route being left is not an app route and the
 * Improve store cannot tell. A work order has no conversation here, so it
 * keeps its own destination.
 */
function inboxSessionView(session: SessionRowView): SessionRowView {
  if (session.kind !== 'session' || !session.appSlug) return session;
  return {
    ...session,
    // #2813: the inbox's own address for the session, so on a desktop it
    // opens in the pane beside this list. On a phone the router swaps it for
    // `#app/<slug>/dev/sessions/<id>` — and records `Improve.enterSessionFrom`
    // there, which this row's click used to — so the session is still the
    // full-screen conversation it was, with its chevron back to this inbox.
    href: agentThreadAddress({ kind: 'session', slug: session.appSlug, id: session.id }),
  };
}

const AgentSessionRow = memo(function AgentSessionRow({ session, active }: { session: SessionRowView; active: boolean }) {
  return (
    <div
      className={`messages-inbox-session ${active ? 'messages-inbox-session-active' : ''}`}
      data-inbox-session={session.key}
      aria-current={active ? 'page' : undefined}
    >
      <SessionRow session={session} showApp onNavigate={() => {}} />
    </div>
  );
});

/**
 * The filter row — a SEGMENTED STRIP, the same one the app Workshop wears —
 * with the "+" that starts something at its trailing end (#2778).
 *
 * THE PLUS IS BACK ON IT. #2718's review took it off because one control
 * saying "new" could only ever mean one of the things this inbox holds — it
 * opened the people dialog on the Agents tab as readily as on People. It
 * comes back as a CHOICE rather than a guess: pressing it opens a small
 * popover, the vote picker's kind rather than a dialog, offering the three
 * things that can be started — a direct message, a group chat, an agent
 * chat. A channel is not among them: #general and each app's exist already.
 *
 * STYLED AS THE WORKSHOP'S STRIP IS: a track with the segments inside it and
 * the selected one tinted with a hairline ring, which is the shell's one
 * segmented control rather than this screen's own. The Workshop's slides a
 * measured marker between segments; this does not, because that measurement
 * is against a DOM that screen owns. At rest they are the same object.
 */
function InboxFilters({ filter }: { filter: InboxFilter }) {
  return (
    <div id="messages-filters" className="messages-filters">
      <div className="messages-filter-track" role="group" aria-label="Show">
        {INBOX_FILTERS.map(([key, label]) => (
          <button
            key={key}
            id={`messages-filter-${key}`}
            type="button"
            data-messages-filter={key}
            aria-current={filter === key ? 'page' : 'false'}
            className="messages-filter"
            onClick={() => setFilter(key)}
          >
            {label}
          </button>
        ))}
      </div>
      <NewMessageButton />
    </div>
  );
}

/**
 * What the "+" can start, in the order the popover lists them. B8: Homeroom
 * bot first, for somebody who has it (/api/auth/me `homeroomBotDm`), then
 * building it yourself, then people.
 */
const NEW_CHOICES = [
  { key: 'bot', label: 'Homeroom bot', hint: 'Make an app or ask for a change' },
  // #2779: a conversation with the Mayor that works on any app, so there is
  // no app to pick first. It replaced "Agent chat", which asked which app and
  // opened a classic dev session there; those are no longer created. B8:
  // named for what it is beside Homeroom bot, building it yourself.
  { key: 'agent', label: 'Build it yourself', hint: 'Plan and build a change with a coding agent' },
  { key: 'direct', label: 'Direct message', hint: 'Talk to one person' },
  { key: 'group', label: 'Group chat', hint: 'Bring a few people together' },
] as const;
type NewChoice = typeof NEW_CHOICES[number]['key'];

/** B8: whether the signed-in person has Homeroom bot to ask. */
function hasHomeroomBot(): boolean {
  return typeof window !== 'undefined' && !!(window as any).App?.user?.homeroomBotDm;
}

function newChoices() {
  return NEW_CHOICES.filter((item) => item.key !== 'bot' || hasHomeroomBot());
}

function startNew(choice: NewChoice) {
  // DM and group are the create dialog, opened on the matching tab.
  if (choice === 'bot') void openBot();
  else if (choice === 'agent') void startAgentSession({ entry: 'messages' });
  else openDialog('messagesCreate', choice);
}

/**
 * The "+" and its popover (#2778).
 *
 * The popover is placed and dismissed exactly as the vote picker's desktop
 * home is — lib/anchor-popover.ts and lib/popover-dismiss.ts are that code,
 * shared — and portalled to
 * the body so the list's own scroller cannot clip it. On touch it is the
 * kit's action sheet instead, which is what a three-row menu is on a phone.
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
  const [rect, setRect] = useState<AnchorRect | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const open = !!rect;
  const shut = () => setRect(null);
  useAnchoredDismiss(open, [btnRef, popRef], shut);
  const menuKeys = useMenuKeyboard(open, popRef, btnRef, shut);

  const toggle = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (open) { shut(); return; }
    const pu = (window as any).PlatformUI;
    if (pu && typeof pu.isTouch === 'function' && pu.isTouch() && typeof pu.actionSheet === 'function') {
      pu.actionSheet({
        actions: newChoices().map((item) => ({ label: item.label, handler: () => startNew(item.key) })),
      });
      return;
    }
    setRect(anchorRectOf(event.currentTarget));
  };
  // Focus goes back to the "+" BEFORE the dialog opens, so the dialog's own
  // focus restore (the kit records what was focused when it presents) lands
  // on the button rather than on a row this close is about to unmount.
  const choose = (choice: NewChoice) => { btnRef.current?.focus({ preventScroll: true }); shut(); startNew(choice); };
  const pos = rect
    ? placeUnderAnchor(rect, { width: 260, height: 54 * newChoices().length + 2 }, { width: window.innerWidth, height: window.innerHeight })
    : null;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        id="messages-new"
        className="messages-new-btn"
        aria-haspopup="menu"
        aria-expanded={open ? 'true' : 'false'}
        aria-label="New message"
        title="New message"
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
          aria-label="Start a new conversation"
          style={{ top: `${pos.top}px`, left: `${pos.left}px` }}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={menuKeys.onKeyDown}
        >
          {newChoices().map((item) => (
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
              {item.key === 'agent' ? <SparklesIcon aria-hidden="true" /> : null}
              {item.key === 'bot' ? <img src="/brand/homeroom-mark.png" alt="" aria-hidden="true" className="messages-new-option-mark" /> : null}
              <span className="min-w-0">
                <span className="messages-new-option-label">{item.label}</span>
                <span className="messages-new-option-hint">{item.hint}</span>
              </span>
            </button>
          ))}
        </div>,
        document.body,
      ) : null}
    </>
  );
}

/** The heading over each part of the list (#2783). */
const SECTION_LABELS: Record<InboxSection, string> = {
  chats: 'Chats',
  channels: 'Channels',
};

/**
 * Narrow the inbox by what a row SAYS, not by what it is.
 *
 * A CLIENT-SIDE MATCH over the three lists already in memory, so it answers
 * on every keystroke and adds no endpoint. What it matches is the text each
 * row draws — a person's name or a group's title, an app's name, a chat's
 * title — because a search that found rows by a field the reader cannot see
 * would return results they cannot explain.
 *
 * It composes with the filter rather than replacing it: the strip says which
 * kinds, this says which of them, and an empty query is every row.
 */
function inboxMatches(text: string | null | undefined, query: string): boolean {
  if (!query) return true;
  return String(text || '').toLowerCase().includes(query);
}

/**
 * The conversation list's loading state, at the ROW's own geometry.
 *
 * It was a spinner beside the words "Loading conversations…" — a fixed mark
 * that says "busy, somewhere" over an empty pane. These say where the
 * conversations are going and roughly how many, so the arriving rows land on
 * their own outlines instead of replacing a centred line of grey text.
 *
 * The wrapper IS `.messages-conversation-row`, not an imitation of it: that
 * class owns the 66px minimum height, the padding, the gap and the inset
 * separator, all in app.css. Borrowing it means the placeholder cannot
 * drift from the row the first time any of those move — and the separator
 * between placeholders is drawn for free, which is most of what makes a list
 * read as a list.
 *
 * Six, because the pane is taller than that on every phone and a list that
 * stops halfway reads as a short list rather than a loading one.
 */
function ConversationRowSkeleton() {
  return (
    <SkeletonGroup label="Loading conversations">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="messages-conversation-row">
          {/* The `lg` square UserAvatar's 44px box. */}
          <Skeleton shape="block" className="w-11 h-11 rounded-xl" />
          <div className="min-w-0 flex-1">
            {/* The name line, with the timestamp's short bar pushed right —
                the real row's trailing <time>. */}
            <div className="flex items-center gap-2">
              <Skeleton className={i % 2 ? 'w-28' : 'w-36'} />
              <Skeleton shape="muted" className="ml-auto w-8" />
            </div>
            {/* The preview line under it. */}
            <Skeleton shape="muted" className={`mt-1.5 ${i % 3 ? 'w-3/5' : 'w-2/5'}`} />
          </div>
        </div>
      ))}
    </SkeletonGroup>
  );
}

function ConversationList() {
  const snap = useMessagesSnapshot();
  // Agent chats come from the chat's OWN store (#2718): that list is already
  // loaded, merged on every thread event and invalidated by the chat itself,
  // and a second copy in this store is a copy that drifts. Gated on the same
  // two flags the Improve panel's list is, so a shell where the feature is
  // off sees no Agents rows and no Agents filter doing nothing.
  // EPHEMERAL, AND DELIBERATELY NOT IN THE STORE. Nothing else reads what
  // was typed here, and a query that survived leaving the screen would greet
  // the next visit with a list that is missing rows for a reason no longer on
  // screen. The filter IS in the store, because the thread pane and the
  // deep-link router both read it.
  const [query, setQuery] = useState('');
  // The list filters on the DEFERRED query: the field takes the keystroke at
  // once, and the rows follow in a render React can interrupt with the next
  // one, so typing a word into a long inbox does not wait on it per letter.
  const deferredQuery = useDeferredValue(query);
  // Two fields of the chat's store, not the whole of it: a turn streaming
  // its progress in the Agents pane is not a reason to redraw this list.
  const chatBootstrap = useGlobalChatSelector((s) => s.bootstrap);
  const chatThreads = useGlobalChatSelector((s) => s.threads);
  const agentsOn = !!chatBootstrap?.parityReady
    && chatBootstrap.profiles.globalChat.enabled === true;
  const agents = useMemo<AgentChat[]>(
    () => (agentsOn ? (chatThreads as AgentChat[]) : []),
    [agentsOn, chatThreads],
  );
  // The viewer's changes in flight (#2770) — see AgentSessionRow. AFTER
  // MOUNT ONLY: app.js can have filled the Improve store before this island
  // hydrates, and rows the prerendered document did not have are a hydration
  // mismatch on every route. The first client render therefore matches the
  // prerender, and the rows arrive one commit later.
  const improve = useStoreState(improveStore) as {
    sessions?: SessionRowView[];
    otherSessions?: SessionRowView[];
  };
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  // A change started from an agent session (#2779) is that conversation's:
  // its row below says where it stands, so it is not listed twice.
  // Memoised on the store's own arrays: inboxSessionView builds a new row
  // object, and a new object per render is a memo()'d row drawn again.
  const sessions = useMemo<SessionRowView[]>(() => (mounted
    ? [...(improve.sessions || []), ...(improve.otherSessions || [])]
      .filter((row) => !row.agentSessionId)
      .map(inboxSessionView)
    : []), [mounted, improve.sessions, improve.otherSessions]);
  // Agent sessions (#2779), from their own store and, like the sessions
  // above, only after mount. Listed whatever the flag says: turning it off
  // never hides a conversation that already exists. The list alone: a reply
  // streaming into the open conversation does not redraw the inbox.
  const mayorSessions = useAgentSessions();
  useEffect(() => { void loadAgentSessions(); }, []);
  const mayors = useMemo<MayorSession[]>(() => (mounted ? mayorSessions : []), [mounted, mayorSessions]);
  // The side pane open BESIDE an agent session's chat (#2779 follow-up), a
  // spec or a preview, takes this column's width while it is open: at 1280
  // the thread pane alone is too narrow for two readable columns. Closing it
  // brings the list back. False until mounted, like everything above
  // (../agent-session/spec-layout).
  const specBeside = useSidePaneBeside('messages');
  // Built once per change to what it is built from, not once per keystroke
  // in the search box or per publish of a store this list does not draw.
  const inbox = useMemo(() => buildInbox({
    conversations: snap.conversations,
    discussions: snap.discussions,
    agents,
    sessions,
    mayors,
    filter: snap.filter,
  }), [snap.conversations, snap.discussions, agents, sessions, mayors, snap.filter]);
  const byMayor = useMemo(() => new Map(mayors.map((item) => [String(item.id), item])), [mayors]);
  const byConversation = useMemo(() => new Map(snap.conversations.map((item) => [String(item.id), item])), [snap.conversations]);
  const byApp = useMemo(() => new Map(snap.discussions.map((item) => [item.slug, item])), [snap.discussions]);
  const byAgent = useMemo(() => new Map(agents.map((item) => [item.id, item])), [agents]);
  const bySession = useMemo(() => new Map(sessions.map((item) => [item.key, item])), [sessions]);

  const q = deferredQuery.trim().toLowerCase();
  const matches = (entry: { kind: string; key: string }) => {
    if (!q) return true;
    if (entry.kind === 'channel') {
      const c = byConversation.get(entry.key.slice('channel:'.length));
      return !!c && (inboxMatches(c.title, q) || inboxMatches(c.channelKey, q));
    }
    if (entry.kind === 'person') {
      const c = byConversation.get(entry.key.slice('person:'.length));
      if (!c) return false;
      const peer = directPerson(c) || conversationPeer(c);
      return inboxMatches(c.title, q)
        || inboxMatches(peer?.username, q)
        || inboxMatches(peer?.displayName, q);
    }
    if (entry.kind === 'app') {
      const a = byApp.get(entry.key.slice('app:'.length));
      return !!a && (inboxMatches(a.name, q) || inboxMatches(a.slug, q) || inboxMatches(a.channel, q));
    }
    if (entry.kind === 'session') {
      const c = bySession.get(entry.key.slice('session:'.length));
      return !!c && (inboxMatches(c.title, q) || inboxMatches(c.appName, q));
    }
    if (entry.kind === 'mayor') {
      const m = byMayor.get(entry.key.slice('mayor:'.length));
      return !!m && (inboxMatches(m.title, q) || inboxMatches(m.focusApp?.name, q)
        || inboxMatches(m.activeChange?.title, q));
    }
    const g = byAgent.get(entry.key.slice('agent:'.length));
    return !!g && inboxMatches(g.title, q);
  };
  // #2967: the channels outside Your apps fold behind "Show N more" — except
  // while searching (a query looks through everything), and except the one
  // that is open, which stays in view wherever it lives.
  const moreEntries = inbox.filter((entry) => entry.more);
  const openSlug = snap.route.appSlug;
  const found = inbox.filter(matches).filter((entry) => !entry.more || !!q || snap.showMoreChannels
    || (entry.kind === 'app' && entry.key === `app:${openSlug}`));
  // B5: search results stay in the order things happened; only the full
  // list keeps the Homeroom bot first.
  const shown = q ? inClockOrder(found) : found;
  const moreToggle = moreEntries.length && !q ? (
    <button
      key="more-channels"
      type="button"
      id="messages-more-channels"
      className="messages-more-channels"
      aria-expanded={snap.showMoreChannels}
      onClick={() => setShowMoreChannels(!snap.showMoreChannels)}
    >
      <span className="messages-more-channels-glyph" aria-hidden="true">
        <ChevronDownIcon className={snap.showMoreChannels ? 'rotate-180' : ''} />
      </span>
      <span>{snap.showMoreChannels ? 'Show less' : `Show ${moreEntries.length} more`}</span>
    </button>
  ) : null;

  return (
    <section className={`messages-list-pane ${specBeside ? 'hidden' : snap.route.conversationId || snap.route.appSlug || snap.route.agent ? 'hidden md:flex' : 'flex'}`} aria-label="Conversations">
      {/* THE SCREEN NAMES ITSELF ONCE (#2718 review). An <h2> reading
          "Messages" sat here, under a bar already reading Messages — two
          titles, one word, an inch apart. The bar is the title now, which is
          what it is for on every other screen in the shell.

          A SEARCH TAKES ITS PLACE, because a list that can run to hundreds of
          rows and holds three kinds of thing needs a way to name one. */}
      <div className="messages-search">
        <SearchIcon className="messages-search-glyph w-5 h-5" aria-hidden="true" />
        <input
          id="messages-search"
          type="search"
          className="messages-search-input"
          placeholder="Search messages…"
          aria-label="Search messages"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
        />
      </div>
      <InboxFilters filter={snap.filter} />
      {!snap.online ? <div className="messages-network-banner">Offline. Queued messages retry when you reconnect.</div> : null}
      {/* #1953: a click on the list's own blank space — below the last row,
          not on a row or a button — closes the open conversation, as it
          would in a desktop mail client. Only the list itself counts
          (`target === currentTarget`), so no row, empty state or retry
          button is affected. On a phone the list is hidden while a thread is
          open, so this is a two-pane (md+) gesture. */}
      <div
        className="messages-list-scroll platform-safe-scroll"
        data-page-bounce=""
        onClick={(e) => {
          if (e.target === e.currentTarget && snap.route.conversationId) openConversation(null);
        }}
      >
        {snap.loadingList && !snap.listLoaded ? <ConversationRowSkeleton /> : null}
        {snap.error ? <div className="messages-state messages-state-error"><p>{snap.error}</p><button type="button" onClick={() => void loadConversations(true)}>Try again</button></div> : null}
        {/* THE EMPTY STATE IS STILL THE CONVERSATIONS', and that is the
            correct reading: "no messages yet" offers to start one, which is
            an answer about people. An inbox that is empty only because a
            FILTER is narrow says something else, below. */}
        {!snap.loadingList && !snap.error && snap.listLoaded && !snap.conversations.length && !inbox.length
          ? <div className="messages-empty"><h3>No messages yet</h3><p>Start a direct conversation or bring a group together.</p><button type="button" onClick={() => openDialog('messagesCreate')}>New conversation</button></div>
          : null}
        {!snap.loadingList && !snap.error && snap.listLoaded && !inbox.length && snap.filter !== 'all'
          ? <div id="messages-filter-empty" className="messages-state"><p>Nothing here under this filter.</p></div>
          : null}
        {/* A QUERY THAT MATCHED NOTHING is not an empty inbox, and must not
            borrow the empty inbox's offer to start a conversation: the rows
            are there, this one word is what hid them. */}
        {!snap.loadingList && !snap.error && snap.listLoaded && inbox.length && !shown.length
          ? <div id="messages-search-empty" className="messages-state"><p>No messages match “{deferredQuery.trim()}”.</p></div>
          : null}
        {/* ONE LIST, TWO SECTIONS (#2783). ./inbox.ts orders them — the
            chats on one clock, then the channels — and returns DESCRIPTORS
            rather than rows, so each kind is still drawn by the component
            that knows how. Under All each section is headed, the way Discord
            heads its DMs and its channels; under a filter the strip already
            says which one this is. */}
        {/* EACH SECTION'S ROWS SIT IN A CARD, under its label: the grouped
            list's label-over-card shape that Workshop and Discover draw,
            rather than rows ruled straight onto the strip. The card is the
            rows' parent, so `:last-child` (which drops the last separator)
            now means the last row of its section. Under a filter there is no
            label and one card.

            #2967's toggle is a row of the channels card: it sits where the
            channels outside Your apps begin (above them once they are shown,
            so "Show less" is next to what it folds), or at the card's foot
            while they are folded. */}
        {/* ONE LIST, UNHEADED. The Channels section moved to the hubs of the
            communities its rooms belong to (./inbox.ts), which leaves the
            chats alone here, and a lone "Chats" heading over the only list
            on the screen would be a label for nothing. */}
        {sectionRuns(shown, false).map((run) => {
          const rows = run.entries.flatMap((entry, i) => {
            const toggle = entry.more && (i === 0 || !run.entries[i - 1].more) ? moreToggle : null;
            return [toggle, inboxRow(entry)].filter(Boolean);
          });
          const foot = run.section === 'channels' && moreToggle && !run.entries.some((entry) => entry.more)
            ? moreToggle : null;
          return [
            run.head
              ? <h3 key={`head-${run.section}`} className="messages-section-head" data-inbox-section={run.section}>{SECTION_LABELS[run.section]}</h3>
              : null,
            <div key={`card-${run.section}`} className="messages-section-card" data-inbox-card={run.section}>
              {rows}
              {foot}
            </div>,
          ];
        })}
        {moreToggle && !shown.some((entry) => entry.section === 'channels') && (snap.filter === 'all' || snap.filter === 'channels') ? moreToggle : null}
      </div>
    </section>
  );

  function inboxRow(entry: { kind: string; key: string }) {
    if (entry.kind === 'channel') {
      const conversation = byConversation.get(entry.key.slice('channel:'.length));
      return conversation
        ? <GeneralChannelRow key={entry.key} conversation={conversation} active={snap.route.conversationId === conversation.id} />
        : null;
    }
    if (entry.kind === 'person') {
      const conversation = byConversation.get(entry.key.slice('person:'.length));
      return conversation
        ? <ConversationRow key={entry.key} conversation={conversation} active={snap.route.conversationId === conversation.id} />
        : null;
    }
    if (entry.kind === 'app') {
      const discussion = byApp.get(entry.key.slice('app:'.length));
      return discussion ? <AppChannelRow key={entry.key} discussion={discussion} active={snap.route.appSlug === discussion.slug} /> : null;
    }
    if (entry.kind === 'session') {
      const session = bySession.get(entry.key.slice('session:'.length));
      const open = snap.route.agent;
      return session
        ? <AgentSessionRow key={entry.key} session={session} active={open?.kind === 'session' && open.id === session.id} />
        : null;
    }
    if (entry.kind === 'mayor') {
      const session = byMayor.get(entry.key.slice('mayor:'.length));
      const open = snap.route.agent;
      return session
        ? <MayorSessionRow key={entry.key} session={session} active={open?.kind === 'agent' && open.id === session.id} />
        : null;
    }
    const agent = byAgent.get(entry.key.slice('agent:'.length));
    const open = snap.route.agent;
    return agent
      ? <AgentChatRow key={entry.key} chat={agent} active={open?.kind === 'chat' && open.id === agent.id} />
      : null;
  }
}

function InvitationBanner() {
  const snap = useMessagesSnapshot();
  const active = snap.active;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!active || active.membershipStatus !== 'invited') return null;
  const conversationId = active.id;
  const requesterUser = active.requester;
  const requester = requesterUser?.username ? `@${requesterUser.username}` : 'Someone';
  async function answer(action: 'accept' | 'decline') {
    setBusy(true); setError('');
    try { await respond(action); }
    catch (err) { setError(err instanceof Error ? err.message : 'Couldn’t update this invitation.'); }
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
      setError(err instanceof Error ? err.message : 'Couldn’t decline and block this requester.');
    } finally { setBusy(false); }
  }
  return (
    <div className="messages-invitation">
      <div className="min-w-0 flex-1"><strong>{active.kind === 'direct' ? 'Message request' : 'Group invitation'}</strong><p>{requester} invited you. Accepting gives you access to the complete retained conversation history.</p>{error ? <span role="alert">{error}</span> : null}</div>
      <div className="messages-invite-actions">
        <button type="button" disabled={busy} onClick={() => void answer('decline')} className="messages-invite-decline">Decline</button>
        {requesterUser?.id ? <button type="button" disabled={busy} onClick={() => void declineAndBlock()} className="messages-invite-block">Decline &amp; block @{requesterUser.username}</button> : null}
        <button type="button" disabled={busy} onClick={() => void answer('accept')} className="messages-invite-accept">Accept</button>
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
 * editor puts its full-screen control — on a conversation, #general, an
 * app's channel, an agent chat and both kinds of session alike. The agent
 * panels are drawn by their own features, so they take it as `headerAction`
 * rather than importing this store.
 *
 * The glyph is the verb a press performs: arrows out while the list is
 * shown, arrows in once it is hidden. A phone shows one pane at a time
 * already, so there it is not drawn (app.css).
 *
 * It only widens the pane, so the bot's activity panel open over that pane
 * stays open through it (`data-bot-work-keep`, #3770; ./bot-work.tsx).
 */
function FullWidthToggle() {
  const snap = useMessagesSnapshot();
  // A Mayor session's side pane (its spec or a preview) open beside its chat
  // has already moved the list aside (ConversationList), so here the control
  // would do nothing. It is not drawn, as app.css does for an open reply
  // thread below 1600px.
  const specBeside = useSidePaneBeside('messages');
  const collapsed = snap.listCollapsed;
  if (specBeside) return null;
  // A channel is always full width (see the layout's note), so a toggle for
  // a list it never shows would do nothing.
  if (snap.route.appSlug || (snap.active?.kind === 'channel' && snap.active.id === snap.route.conversationId)) return null;
  const label = collapsed ? 'Show the conversation list' : 'Full width';
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
function ThreadHeader() {
  const snap = useMessagesSnapshot();
  const active = snap.active;
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
  useDismiss(menu, [menuWrapRef], closeMenu);
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
      title: `Block ${senderName(peer)}?`,
      message: 'Their messages in shared chats and app discussions will be hidden, and they won’t be able to message you directly.',
      confirmLabel: 'Block',
      danger: true,
    });
    if (!ok) return;
    const conversationId = active?.id;
    if (!conversationId) return;
    setBusy(true);
    try { await setUserBlocked(peer.id, true); }
    catch (err) { window.PlatformUI?.toast?.(err instanceof Error ? err.message : 'Couldn’t block this user.'); }
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
    const next = await ui.prompt({ title: 'Rename group', value: current, placeholder: 'Group name', confirmLabel: 'Save', maxLength: 80 });
    if (next == null) return;
    try { await renameConversation(next); }
    catch (err) { ui.toast?.(err instanceof Error ? err.message : 'Couldn’t rename this group.'); }
  }
  const channel = active.kind === 'channel';
  const invited = active.membershipStatus === 'invited';
  // #3692: the Homeroom bot's DM says what the bot is doing where a DM says
  // "Direct message", and its Activity disc, before the full-width toggle,
  // opens the activity panel (./bot-work.tsx), working or not. #3770: the
  // disc, not the name block, which nobody read as a control.
  const botDm = active.kind === 'direct' && !!active.homeroomBot && active.membershipStatus === 'member';
  // QA 2026-09-24 Q33a: an unanswered request names its requester.
  const person = directPerson(active);
  const count = (n: number) => `${n} ${n === 1 ? 'member' : 'members'}`;
  // QA 2026-09-24 Q14: "1 member", not "1 members". An invitee is not shown
  // the roster until they accept, so the count the server gives them is 0 —
  // they read the invitation's state instead of "0 members".
  const subtitle = channel
    ? `The Homeroom community's channel · ${count(active.memberCount)}`
    : invited
      ? 'Invitation pending'
      : active.kind === 'group'
        ? `${count(active.memberCount)}${active.myRole === 'owner' ? ' · you own this group' : ''}`
        : active.awaitingAcceptance ? 'Request pending' : 'Direct message';
  return (
    <header className="messages-thread-header">
      {channel ? <PageBackButton label={hubBack.label} onBack={hubBack.onBack} data-channel-back="" /> : null}
      {channel
        ? <span className="messages-inbox-tile messages-channel-tile messages-thread-channel-tile" aria-hidden="true">#</span>
        : <UserAvatar user={active.kind === 'direct' ? person : null} title={person?.username || active.title} shape="square" />}
      <button
        type="button"
        className="min-w-0 text-left flex-1"
        onClick={() => { if (active.kind === 'group') openDialog('messagesMembers'); }}
      >
        <div className="messages-thread-name">{active.kind === 'direct' && person ? senderName(person) : channel ? `#${active.channelKey || active.title}` : active.title}{active.kind === 'direct' && person?.bot ? <span className="messages-bot-badge">AI</span> : null}</div>
        {botDm ? <BotWorkStatusLine /> : <div className="messages-thread-sub">{subtitle}</div>}
      </button>
      {active.kind === 'group' ? <button type="button" onClick={() => openDialog('messagesMembers')} className="messages-thread-action" aria-label="Group members" title="Group members"><UserGroupIcon aria-hidden="true" /></button> : null}
      {botDm ? <BotWorkButton /> : null}
      <FullWidthToggle />
      <div className="relative" ref={menuWrapRef}>
        <button ref={menuBtnRef} type="button" onClick={() => setMenu((open) => !open)} className="messages-thread-action" aria-label="Conversation actions" aria-haspopup="menu" aria-expanded={menu}><EllipsisHorizontalIcon aria-hidden="true" /></button>
        {menu ? (
          <div ref={menuRef} className="messages-thread-menu" role="menu" aria-label="Conversation actions" onKeyDown={menuKeys.onKeyDown}>
            {active.kind === 'group' && active.canManage
              ? <button type="button" role="menuitem" data-rename-group="" onClick={() => { menuBtnRef.current?.focus({ preventScroll: true }); void renameGroup(); }}>Rename group</button>
              : null}
            {active.kind === 'group'
              ? <button type="button" role="menuitem" onClick={() => { menuBtnRef.current?.focus({ preventScroll: true }); setMenu(false); openDialog('messagesMembers'); }}>Members &amp; invitations</button>
              : active.kind === 'direct'
                ? <button type="button" role="menuitem" disabled={busy || !peer} onClick={() => void blockPeer()} className="text-red-700 dark:text-red-400">Block {senderName(peer)}</button>
                : null}
            {peer ? <button type="button" role="menuitem" onClick={() => { menuBtnRef.current?.focus({ preventScroll: true }); setMenu(false); openReport({ targetType: 'user', target: peer.username, label: senderName(peer), userId: peer.id }); }}>Report user</button> : null}
            <button type="button" role="menuitem" onClick={() => { menuBtnRef.current?.focus({ preventScroll: true }); setMenu(false); void loadConversations(true); }}>Refresh conversation</button>
          </div>
        ) : null}
      </div>
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

function dayKey(message: ConversationMessage): string {
  const date = new Date(message.createdAt);
  return Number.isNaN(date.getTime()) ? '' : date.toDateString();
}

function dayLabel(message: ConversationMessage): string {
  const date = new Date(message.createdAt);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return 'Today';
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString(undefined, date.getFullYear() === today.getFullYear()
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
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
 * thing that is loaded, merged and invalidated elsewhere — the same reason
 * the agent chats are read from their own store rather than copied into
 * this one. So this renders a HOST and asks the owner to fill it.
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
    // portal and then, on its next line, looks up `#gc-input` to wire the
    // composer — send on Enter, drafts, the @ and # menus. The portal is
    // published inside flushSync, which cannot flush while React is still
    // committing this effect, so the input did not exist yet and the
    // composer of a channel opened here was never wired: nothing typed in it
    // sent. A macrotask later the commit is over and the portal lands at once.
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
        <h2>This discussion could not be opened.</h2>
        <p>It may have been removed, or you may not be a member of that app.</p>
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
              ? 'Earlier project discussion · read-only'
              : `${handle ? `#${handle} · ` : ''}Everyone building this project`}
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
 * A global agent chat, as a thread of this inbox (#2813).
 *
 * ── Rendered, not mounted ─────────────────────────────────────────────
 *
 * Unlike an app's discussion and a dev session, this chat is React already:
 * features/global-chat is a store and a component tree, so the pane draws
 * the chat's own panel (`GlobalChatPanel`) rather than hosting a legacy
 * surface. It is the SAME panel the chat's screen draws, reading the same
 * store — one transcript, loaded and invalidated in one place.
 *
 * ── The store is told who is drawing it ───────────────────────────────
 *
 * `host: 'messages'` is what makes New, delete-and-move-on and Close write
 * inbox addresses (`#messages/agent/<id>`, `#messages`) instead of taking
 * the viewer to the chat's own screen, and what hides that screen's copy of
 * the transcript while this one is up. Leaving the pane deactivates the chat
 * exactly as leaving its screen does — but only if the pane still owns it:
 * following a `#chat/<id>` link from here reopens the store for the screen
 * before this unmounts, and that open is not this pane's to undo.
 */
/**
 * An agent session (#2779), as a thread of this inbox: the same panel its
 * own screen draws (features/agent-session), told it is drawn here. Leaving
 * the pane deactivates it only if the pane still owns it, as above — and
 * only if it is still THIS conversation: an unsent one (`new`) becomes its
 * session on the first message, and the thread for that address takes over
 * a store that is already showing it.
 */
function MayorSessionThread({ id }: { id: number | 'new' }) {
  useEffect(() => {
    void openAgentSession({ id, host: 'messages' });
    return () => {
      const current = getAgentSessionState();
      const same = id === 'new' ? current.id === null : current.id === id;
      if (current.open && current.host === 'messages' && same) deactivateAgentSession();
    };
  }, [id]);
  // A screen swap can close the conversation under this pane after the pane
  // took it (a desktop's transition out of #agent/<id> into Messages closes
  // the conversation's own screen last): the pane would draw a conversation
  // nobody holds open, which nothing updates. While Messages is on screen
  // and nothing holds it, the pane takes it back.
  const shown = useVisibility('messages-screen', false);
  const held = useAgentSessionSelector((s) => s.open);
  useEffect(() => {
    if (shown && !held) void openAgentSession({ id, host: 'messages' });
  }, [shown, held, id]);
  return (
    <section
      className="flex messages-thread-pane dc-lift dc-lift-session messages-thread-agent"
      aria-label="Agent session"
      data-agent-session-thread={id}
    >
      <AgentSessionPanel embedded headerAction={<FullWidthToggle />} />
    </section>
  );
}

/**
 * One agent session's row (#2779): its title, the app it is about, and
 * where its active change stands. A link to the inbox's own address for it,
 * which a phone's router swaps for the conversation's screen.
 */
const MayorSessionRow = memo(function MayorSessionRow({ session, active }: { session: MayorSession; active: boolean }) {
  const at = session.lastActivityAt || session.createdAt || null;
  const activity = at ? agoStamp(at) : null;
  const thread: MessagesAgentThread = { kind: 'agent', id: session.id };
  const href = agentThreadAddress(thread);
  const change = session.activeChange;
  const mark = agentActivity(session);
  const status = change
    ? `${change.title || (change.prNumber ? `PR #${change.prNumber}` : `Change ${change.id}`)} · ${
      change.status === 'promoted' ? 'Waiting for approval' : change.status === 'merged' ? 'Merged' : 'In progress'}`
    : 'No active change';
  return (
    <a
      href={href}
      data-inbox-agent-session={session.id}
      className={`messages-conversation-row ${active ? 'messages-conversation-active' : ''}`}
      aria-current={active ? 'page' : undefined}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        if (window.location.hash === href) { event.preventDefault(); openAgentThread(thread); }
      }}
    >
      {/* #3076: working, the spinner takes the sparkle's place in the tile;
          finished unseen, the green dot does. The tile is aria-hidden, so
          the state is said in words beside the name. */}
      <span className="messages-inbox-tile messages-inbox-agent-tile" aria-hidden="true">
        {mark
          ? <AgentActivityIcon activity={mark} className="w-5 h-5" />
          : <SparklesIcon className="w-5 h-5" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="messages-row-line">
          <span className="messages-row-name">{session.title || 'New session'}</span>
          {mark ? <span className="sr-only">{`, ${ACTIVITY_LABEL[mark].toLowerCase()}`}</span> : null}
          {activity
            ? <time className="messages-row-time" dateTime={at || undefined} title={activity.title}>{activity.text}</time>
            : null}
        </div>
        <div className="messages-row-line">
          <span className="messages-row-preview">
            {session.busy ? 'Working…' : `${session.focusApp?.name ? `${session.focusApp.name} · ` : ''}${status}`}
          </span>
        </div>
      </div>
    </a>
  );
});

function AgentChatThread({ id }: { id: string }) {
  useEffect(() => {
    void openGlobalChat({ threadId: id, host: 'messages' });
    return () => {
      const current = getGlobalChatState();
      if (current.open && current.host === 'messages') deactivateGlobalChat();
    };
  }, [id]);
  return (
    <section
      className="flex messages-thread-pane dc-lift dc-lift-session messages-thread-agent"
      aria-label="Agent chat"
      data-agent-chat={id}
    >
      <GlobalChatPanel embedded headerAction={<FullWidthToggle />} />
    </section>
  );
}

/**
 * An app's dev session, as a thread of this inbox (#2813).
 *
 * ── Mounted, like a discussion ────────────────────────────────────────
 *
 * The session view — transcript, composer, header, venue, drafts, the spec
 * and staging panes — is DevChat's (features/dev-chat/dev-chat.js), one
 * surface with fixed ids and one owner. So the pane renders a HOST and asks
 * AppView to fill it (`AppView.mountSessionInHost`), the same arrangement
 * `AppDiscussionThread` makes with the group chat. The host's class string is
 * constant and React renders nothing inside it: its whole subtree is
 * DevChat's, which is the one-owner rule satisfied at this boundary.
 *
 * ── The side panes stay inside ────────────────────────────────────────
 *
 * The spec viewer and the staging preview are slots INSIDE the session view,
 * so they open inside this pane, docked beside the transcript, exactly as
 * they do in the app view. A viewer who wants the whole window for them has
 * the "Open full view" link in the pane's head, which is the session's own
 * address in the app.
 *
 * ── It says when it cannot open ───────────────────────────────────────
 *
 * The app view's fallback is its Board, which is not on this screen. A
 * session this viewer cannot open — and that has no published chat to read
 * instead — says so here, with the full-view link to try the app itself.
 */
function AgentSessionThread({ slug, id }: { slug: string; id: number }) {
  const host = useRef<HTMLDivElement | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const full = fullScreenAddress({ kind: 'session', slug, id });

  useEffect(() => {
    const el = host.current;
    if (!el) return undefined;
    const view = (window as any).AppView;
    let live = true;
    setPhase('loading');
    // A macrotask later, for the reason AppDiscussionThread gives: the
    // session view is published into portals inside flushSync, which cannot
    // flush while React is still committing this effect.
    const timer = window.setTimeout(() => {
      if (!live || !view?.mountSessionInHost) return;
      Promise.resolve(view.mountSessionInHost(el, { slug, sessionId: id }))
        .then((result: string) => {
          if (!live || result === 'stale') return;
          setPhase(result === 'ready' ? 'ready' : 'unavailable');
        })
        .catch(() => { if (live) setPhase('unavailable'); });
    }, 0);
    return () => {
      live = false;
      window.clearTimeout(timer);
      view?.unmountSessionHost?.(el);
    };
  }, [slug, id]);

  return (
    <section
      className="flex messages-thread-pane messages-thread-session"
      aria-label="Agent session"
      data-agent-session={`${slug}/${id}`}
    >
      <div className="messages-session-bar">
        <a className="messages-session-full" href={full}>Open full view</a>
        <FullWidthToggle />
      </div>
      {phase === 'unavailable' ? (
        <div className="messages-state messages-state-error">
          <p>This session could not be opened here.</p>
          <a href={full}>Open it in the app</a>
        </div>
      ) : null}
      {phase === 'loading' ? (
        <div className="messages-state"><span className="messages-spinner" />Loading session…</div>
      ) : null}
      <div ref={host} className="messages-session-host flex-1 min-h-0" hidden={phase === 'unavailable'} />
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
function ConversationThread({ embedded = false }: { embedded?: boolean } = {}) {
  const snap = useMessagesSnapshot();
  const channels = useChannelHandles();
  const scroller = useRef<HTMLDivElement>(null);
  // #3571: the kit's keyboard avoidance on this column's scroller, as the
  // channel, its threads and a dev session get theirs from attachScreenFx.
  // Its settled pin puts back the pan iOS makes on the tap, which otherwise
  // left the composer (lifted by `platform-kb-column`) above the screen.
  useComposerKeyboard(scroller);
  // #3757: whether the reader is at the newest line, from where they last
  // scrolled, so a tall reply or a card that grows after it is drawn keeps
  // them there (./stick-to-bottom.ts).
  const pinned = useStickToBottom(scroller, !snap.nextAfter);
  const previousLast = useRef<number | null>(null);
  const initialScroll = useRef<number | null>(null);
  const conversationId = snap.route.conversationId;
  const typing = conversationId ? typingUsers(conversationId) : [];
  // #2884: the runs of cards the viewer has opened, by their first message.
  const [expandedRuns, setExpandedRuns] = useState<ReadonlySet<string>>(() => new Set());
  // #2387: the message a link pointed at, flashed once it is drawn.
  const focusId = snap.route.focusMessageId;
  const [flashId, setFlashId] = useState<number | null>(null);
  const shownFocus = useRef<number | null>(null);

  useIsomorphicLayoutEffect(() => {
    if (!conversationId) return;
    previousLast.current = null; initialScroll.current = null; pinned.current = true;
  }, [conversationId]);

  // A layout effect, so the scroll lands before the new rows are painted and
  // `pinned` is read before any scroll event can report the grown content.
  useIsomorphicLayoutEffect(() => {
    const el = scroller.current;
    const lastMessage = snap.messages.at(-1);
    const last = lastMessage?.id || null;
    if (!el || !last) return;
    // #2387: a message link lands on its message, centred and flashed, once
    // — not at the bottom, and not again on every refresh after.
    if (focusId && shownFocus.current !== focusId) {
      const row = document.getElementById(`messages-message-${focusId}`);
      if (row) {
        shownFocus.current = focusId;
        previousLast.current = last;
        pinned.current = false;
        requestAnimationFrame(() => row.scrollIntoView({ block: 'center' }));
        setFlashId(focusId);
        window.setTimeout(() => setFlashId((id) => (id === focusId ? null : id)), 2400);
        return;
      }
    }
    if (focusId && shownFocus.current === focusId && snap.nextAfter) { previousLast.current = last; return; }
    // The viewer's own send always lands in view, wherever they had scrolled.
    // Anything else follows only a reader who was at the bottom BEFORE it
    // arrived (#3757): measured now, after the draw, a reply taller than the
    // allowance read as the reader having scrolled up.
    const sentNow = !!lastMessage?.pending && last !== previousLast.current;
    if (previousLast.current === null || sentNow || pinned.current) {
      // The foot of a linked window (#2387) is not the present: nothing
      // follows it there. A send from one goes to the present (store.send).
      pinned.current = sentNow || !snap.nextAfter;
      el.scrollTop = el.scrollHeight;
    }
    previousLast.current = last;
  }, [snap.messages, focusId, snap.nextAfter]);

  async function older() {
    const el = scroller.current;
    if (el) initialScroll.current = el.scrollHeight;
    await loadOlder();
    requestAnimationFrame(() => {
      if (el && initialScroll.current !== null) el.scrollTop += el.scrollHeight - initialScroll.current;
      initialScroll.current = null;
    });
  }

  // #3494: the room is up in its community's page, so this screen (hidden)
  // draws no second copy of it; and the page's copy draws nothing once
  // Messages has taken the store back.
  if (!!snap.route.embedded !== embedded) {
    return embedded ? null : <section className="hidden md:flex messages-thread-pane messages-no-selection"><h2>Choose a conversation</h2></section>;
  }
  if (snap.route.appSlug) return <AppDiscussionThread slug={snap.route.appSlug} />;
  if (snap.route.agent?.kind === 'chat') return <AgentChatThread key={snap.route.agent.id} id={snap.route.agent.id} />;
  if (snap.route.agent?.kind === 'agent') return <MayorSessionThread key={`agent/${snap.route.agent.id}`} id={snap.route.agent.id} />;
  if (snap.route.agent?.kind === 'session') {
    const { slug, id } = snap.route.agent;
    return <AgentSessionThread key={`${slug}/${id}`} slug={slug} id={id} />;
  }
  if (!conversationId) return <section className="hidden md:flex messages-thread-pane messages-no-selection"><h2>Choose a conversation</h2><p>Your chats open here. A community's channel is on its hub, under Communities.</p></section>;
  // The kind is on the SECTION — `messages-thread-direct`, `-group` or
  // `-channel` — so the scroller's class string below stays the one the
  // safe-area test pins. It no longer changes the rows' shape: every kind is
  // the same named-row transcript (#2783).
  const kind = snap.active?.kind || 'direct';
  // #3692: a conversation with the Homeroom bot carries its activity tray.
  const botDm = !!snap.active && snap.active.id === conversationId && snap.active.kind === 'direct'
    && snap.active.membershipStatus === 'member' && snap.active.homeroomBot === true;
  const rows: ReactNode[] = [];
  let previousDay = '';
  let previous: ConversationMessage | null = null;
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
    />);
    previous = message;
    const length = runs.get(index);
    const runKey = String(message.clientKey || message.id);
    if (length && !expandedRuns.has(runKey)) {
      const hidden = length - 1;
      rows.push(
        <div key={`more-${runKey}`} className="messages-card-run">
          <button
            type="button"
            className="messages-card-run-more"
            data-card-run-more={hidden}
            aria-expanded="false"
            aria-label={`Show ${hidden} more ${hidden === 1 ? 'card' : 'cards'}`}
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
    <section className={`flex messages-thread-pane platform-kb-column dc-lift dc-lift-session messages-thread-${kind}${embedded ? ' messages-thread-embedded' : ''}`} aria-label={snap.active?.title || 'Conversation'}>
      {embedded ? null : <ThreadHeader />}
      {/* #3692: the bot's activity panel drops over the transcript from under its header. */}
      {botDm && !embedded ? <BotWorkPanel /> : null}
      <InvitationBanner />
      {botDm ? <BotWorkSync conversationId={conversationId} newsKey={newestBotMessageId(snap.messages)} /> : null}
      {/* #3736: and keeps the activity cards in its transcript current. */}
      {botDm ? <BotActivitySync conversationId={conversationId} newsKey={newestBotMessageId(snap.messages)} /> : null}
      {/* No `un-kb-avoid` WRITTEN here: the column reserves the keyboard
          inset (`platform-kb-column` above). The kit adds the class itself
          once useComposerKeyboard attaches (#3571), as it does to
          `#gc-messages`, and app.css's `.platform-kb-column .un-kb-avoid`
          keeps it from padding this scroller with the inset a second time.
          So this className stays constant: React never strips the kit's. */}
      <div ref={scroller} className="messages-thread-scroll platform-safe-scroll" aria-live="polite">
        {/* Only a thread with nothing to show yet says it is loading (#2907).
            A refresh of the visible thread — the realtime echo of every send
            is one — re-reads it silently: this row drawn above the messages
            pushed the whole transcript down on each message sent. */}
        {snap.loadingThread && !snap.messages.length ? <div className="messages-state"><span className="messages-spinner" />Loading messages…</div> : null}
        {/* QA 2026-09-24 Q16: a conversation that cannot come back offers the
            way out, not a Try again that reads the same answer. Leaving it
            here is said plainly, in the ordinary state colour: it is what
            the viewer asked for, not an error. */}
        {snap.threadGone === 'left' ? <div className="messages-state" data-thread-gone="left"><p>You left this group.</p><button type="button" onClick={() => messagesController.open(null)}>Back to Messages</button></div> : null}
        {snap.threadError && !snap.messages.length ? <div className="messages-state messages-state-error"><p>{snap.threadError}</p>{snap.threadGone === 'missing'
          ? <button type="button" onClick={() => messagesController.open(null)}>Back to Messages</button>
          : <button type="button" onClick={() => messagesController.route(conversationId)}>Try again</button>}</div> : null}
        {!snap.loadingThread && !snap.threadError && snap.active && snap.active.membershipStatus === 'member' && !snap.messages.length ? <div className="messages-thread-empty"><span aria-hidden="true">👋</span><p>No messages yet. Say hello.</p></div> : null}
        {snap.nextBefore ? <div className="flex justify-center py-2"><button type="button" disabled={snap.loadingOlder} onClick={() => void older()} className="messages-load-older">{snap.loadingOlder ? 'Loading…' : 'Load earlier messages'}</button></div> : null}
        {rows}
        {/* #2387: a message link opened the transcript part-way back. */}
        {snap.nextAfter ? (
          <div className="messages-newer">
            <button type="button" className="messages-load-older" disabled={snap.loadingOlder} onClick={() => void loadNewer()}>{snap.loadingOlder ? 'Loading…' : 'Load newer messages'}</button>
            <button type="button" className="messages-load-older" onClick={() => { pinned.current = true; jumpToPresent(); }}>Jump to present</button>
          </div>
        ) : null}
      </div>
      <div className="messages-typing" aria-live="polite">{typing.length === 1 ? `${typing[0]} is typing…` : typing.length > 1 ? `${typing.slice(0, 2).join(', ')} are typing…` : ''}</div>
      <MessageComposer />
    </section>
  );
}

/**
 * A run of one thread's replies in the main transcript (#2387 follow-up):
 * the shared card, told who replied and what, and to open that thread.
 */
function ThreadActivityRow({ replies }: { replies: ConversationMessage[] }) {
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
      time={start === end ? start : `${start} – ${end}`}
      timeTitle={fullTime(last.createdAt)}
      replies={replies.map((reply) => ({
        key: reply.clientKey || reply.id,
        face: <span className="msgx-thread-face"><UserAvatar user={reply.sender} size="sm" shape="square" /></span>,
        name: reply.sender.username,
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
 * of everyone's way, and a DM has no one else in it (store: canThread).
 */
function ReplyThreadPanel() {
  const snap = useMessagesSnapshot();
  const channels = useChannelHandles();
  const conversationId = snap.route.conversationId;
  const rootId = snap.route.threadRootId;
  const thread = snap.thread && snap.thread.rootId === rootId ? snap.thread : null;
  const scroller = useRef<HTMLDivElement>(null);
  // #3571: the same keyboard avoidance as the conversation beside it. On a
  // phone this pane covers the conversation, so its composer is the one the
  // keyboard comes up under when a thread is replied to.
  useComposerKeyboard(scroller);
  const count = useRef(0);
  useEffect(() => {
    if (conversationId && rootId && !snap.loadingThread && snap.active?.id === conversationId) {
      void loadReplyThread(conversationId, rootId);
    }
  }, [conversationId, rootId, snap.active?.id, snap.loadingThread]);
  // New replies land in view, as the conversation's do.
  useEffect(() => {
    const el = scroller.current;
    const n = thread?.messages.length || 0;
    if (el && n !== count.current) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
    count.current = n;
  }, [thread?.messages.length]);
  if (!conversationId || !rootId) return null;
  const active = snap.active;
  const kind = active?.kind || 'group';
  const where = active ? (kind === 'channel' ? `#${active.channelKey || active.title}` : active.title) : '';
  const root = thread?.root || snap.messages.find((item) => item.id === rootId) || null;
  const replies = thread?.messages || [];
  let previous: ConversationMessage | null = null;
  return (
    <aside className="messages-reply-pane platform-kb-column dc-lift dc-lift-session" aria-label="Thread" data-reply-thread={rootId}>
      <header className="messages-thread-header">
        <div className="min-w-0 flex-1">
          <div className="messages-thread-name">Thread</div>
          {where ? <div className="messages-thread-sub">{where}</div> : null}
        </div>
        <button type="button" className="messages-thread-action" aria-label="Close thread" title="Close thread" onClick={() => closeThread()}>
          <XIcon aria-hidden="true" />
        </button>
      </header>
      <div ref={scroller} className="messages-thread-scroll messages-reply-scroll platform-safe-scroll" aria-live="polite">
        {/* The root's Reply quotes it into THIS thread's composer (#2387): its
            own threadRootId is null, being the main stream's message. */}
        {root ? <MessageRow message={{ ...root, thread: null, threadRootId: rootId }} conversationId={conversationId} channels={channels} kind={kind} inThread /> : null}
        <div className="messages-reply-count" aria-hidden={!replies.length}>
          <span>{replies.length ? `${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}` : thread?.loading ? 'Loading replies…' : 'No replies yet'}</span>
        </div>
        {thread?.nextBefore ? <div className="flex justify-center py-2"><button type="button" disabled={thread.loading} onClick={() => void loadOlderReplies()} className="messages-load-older">{thread.loading ? 'Loading…' : 'Load earlier replies'}</button></div> : null}
        {thread?.error ? <div className="messages-state messages-state-error"><p>{thread.error}</p><button type="button" onClick={() => void loadReplyThread(conversationId, rootId, true)}>Try again</button></div> : null}
        {replies.map((message) => {
          const grouped = !!previous && !previous.failed && !message.failed
            && groupsWithPrevious(
              { author: previous.sender.id, at: previous.createdAt },
              { author: message.sender.id, at: message.createdAt, reply: !!message.reply },
            );
          previous = message;
          return <MessageRow key={message.clientKey || message.id} message={{ ...message, threadRootId: message.threadRootId || rootId }} conversationId={conversationId} grouped={grouped} channels={channels} kind={kind} inThread />;
        })}
      </div>
      <MessageComposer threadRootId={rootId} />
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
        <a className="messages-thread-action" href={back} aria-label="Close thread" title="Close thread">
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
        placeholder: 'Reply in thread…',
        notice: 'Only members of this app can reply here.',
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
    <aside className="messages-reply-pane messages-reply-pane-app" aria-label="Thread" data-reply-thread={rootId}>
      <header className="messages-thread-header">
        <div className="min-w-0 flex-1">
          <div className="messages-thread-name">Thread</div>
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
export function EmbeddedConversation({ conversationId, active, at = null }: {
  conversationId: number;
  active: boolean;
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
    embed(conversationId, take());
    return () => release(conversationId);
  }, [active, messagesOpen, conversationId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!active || messagesOpen) return;
    const next = take();
    if (next) embed(conversationId, next);
  }, [at]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={`messages-layout messages-layout-embedded${here && snap.route.threadRootId ? ' messages-has-reply-thread' : ''}`}>
      {here ? <ConversationThread embedded /> : null}
      {here && snap.route.threadRootId ? <ReplyThreadPanel /> : null}
    </div>
  );
}

export function MessagesScreen() {
  const screenRef = useRef<HTMLElement | null>(null);
  const snap = useMessagesSnapshot();
  useVisibilityHiddenClass(screenRef, 'messages-screen', false);
  useEffect(() => initializeMessagesStore(), []);
  // THE AGENT HALF OF THIS INBOX HAS TO ASK FOR ITSELF (#2718 review).
  //
  // The list's `useGlobalChatSelector` reads a store that nothing on this screen
  // was filling: the ONLY caller of initializeGlobalChat outside Settings
  // was the Improve panel's own New chat button. So an inbox opened without
  // ever having opened Improve saw `bootstrap: null`, which reads as "the
  // feature is off" — no agent rows in the list, and no way to start one
  // under the Agents tab. The tab was there and did nothing, which is what
  // "there is no new agent button under agents" is.
  //
  // The same shape that button uses, and for the same reason: a boot-time
  // 401 is expected before app.js has established the session, so `sv:authed`
  // asks again. The call is idempotent — it returns the bootstrap it already
  // has unless forced — so two surfaces asking costs one request.
  useEffect(() => {
    void initializeGlobalChat();
    const retry = () => { void initializeGlobalChat({ force: true }); };
    window.addEventListener('sv:authed', retry);
    return () => window.removeEventListener('sv:authed', retry);
  }, []);
  // THE CHANGES HALF ASKS FOR ITSELF TOO (#2770). The Improve store's list
  // is prefetched once per page when an app target is published, which a
  // viewer who lands on Messages first may not have had — and a list read
  // once at boot is stale by the time the inbox is opened. So opening
  // Messages reads it again; while it stays open, Improve's own
  // onSessionStateChanged keeps it fresh (it asks whether Messages is on
  // screen). Signed-in only: the endpoint is per-user, and a 401 in the
  // network log is a console error on the route.
  useEffect(() => {
    if (!snap.route.open || !window.App?.user) return;
    void Promise.resolve(Improve.loadSessions()).catch(() => {});
  }, [snap.route.open]);
  // #3407: and again when #general's hub becomes known (store.ts).
  useEffect(() => followPlatformSlug(), []);
  useEffect(() => { if (snap.route.open) syncChrome(); },
    // The DISCUSSION's two facts belong here for the same reason the
    // conversation's title does: on a phone this is what names the thread in
    // the bar and puts the chevron back to the list. Without them, opening a
    // discussion kept the previous thread's name.
    [snap.active?.title, snap.route.open, snap.route.conversationId,
      snap.route.appSlug, snap.route.agent, snap.discussionContext?.name, snap.route.threadRootId]);
  // #2387: full width applies to any open discussion — a conversation, an
  // app channel, or an agent thread (every one carries the toggle). With
  // nothing open the list is there: it is the only thing to show. Reply
  // threads hang off conversations and channels alone.
  const chatOpen = !!(snap.route.conversationId || snap.route.appSlug);
  const discussionOpen = chatOpen || !!snap.route.agent;
  // A CHANNEL OPENS FULL WIDTH. It is its community's room, reached from the
  // community's hub, and the list beside it is people and agents — a column
  // of other things beside a room that is not in it. So there is no list
  // for it to sit beside, whatever the full-width preference says.
  const channelOpen = !!snap.route.appSlug
    || (!!snap.route.conversationId && snap.active?.id === snap.route.conversationId && snap.active?.kind === 'channel');
  const layout = `messages-layout dc-lift dc-lift-strip${(snap.listCollapsed && discussionOpen) || channelOpen ? ' messages-list-collapsed' : ''}${chatOpen && snap.route.threadRootId ? ' messages-has-reply-thread' : ''}`;
  // No background of its own: the route paints the wallpaper (the
  // body:has(#messages-screen) rules in app.css), and the two frosted planes
  // need a transparent ancestor chain to have anything to blur.
  return (
    <>
      <main ref={screenRef} id="messages-screen" className="hidden flex-1 min-h-0 overflow-hidden" style={{ position: 'relative' }}>
        <div className={layout}>
          <ConversationList />
          <ConversationThread />
          {snap.route.conversationId && snap.route.threadRootId && !snap.route.embedded ? <ReplyThreadPanel /> : null}
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
