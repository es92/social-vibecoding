/**
 * `channel` is a room every user is in (#2783) — today only #general. It has
 * no roster (just a count), no owner and no invitations.
 */
export type ConversationKind = 'direct' | 'group' | 'channel';
export type MembershipStatus = 'invited' | 'member' | 'declined' | 'left' | 'removed';
export type MemberRole = 'owner' | 'member';

export interface ConversationUser {
  id: number;
  username: string;
  avatarUrl?: string | null;
  /** A platform account (the Homeroom bot), not a person (#3624). */
  bot?: boolean;
}

/**
 * #3624: the structured part of a message from the Homeroom bot. Every one
 * about a request says which; a question carries the answers to tap, the
 * default first, and its state (open until answered, or closed when newer
 * news on the request replaced it). `mirrors`: a reply to it is posted on
 * the request's public discussion.
 */
export interface HomeroomBotMeta {
  kind: string;
  appSlug?: string;
  appName?: string;
  issueNumber?: number;
  issueTitle?: string;
  firstVersion?: boolean;
  mirrors?: boolean;
  question?: string;
  answers?: string[];
  status?: 'open' | 'answered' | 'closed';
  answer?: string;
  link?: string;
  // B3: the decision a message's `server` buttons settle
  // (homeroom_bot_dm_actions.id), the buttons themselves, and which one was
  // chosen. An activity card's start and its live state ride along too.
  actionId?: number;
  actions?: HomeroomBotAction[];
  chosen?: string;
  startedAt?: string;
  live?: boolean;
}

/**
 * B3: one of a bot message's buttons. `server` is decided by the action
 * endpoint, once (store.tapBotAction); `open` goes to an in-app address
 * (`target`, always `#app/…`); `prompt` sends its label as the person's own
 * message. At most three, at most one `primary`.
 */
export interface HomeroomBotAction {
  id: string;
  label: string;
  style: 'primary' | 'secondary';
  type: 'server' | 'open' | 'prompt';
  target?: string;
}

/**
 * #3692: the Homeroom bot's work for the viewer, as its DM's activity tray
 * reads it (services/homeroom-bot-tray.js). An entry is one request of
 * theirs, or a project's first version, and appears once: in `now` while
 * the bot has it in hand, in `needsYou` while it waits on them, else in
 * `history`. `href` is where it opens (its proposal once people can open
 * one, else the request), and `links` each place a tile offers; null for
 * one that opens nowhere (the staging demo's). `earlier` is the request's
 * other runs, newest first.
 */
export type HomeroomBotPhase =
  | 'setting_up' | 'queued' | 'looking' | 'building' | 'follow_up_queued' | 'following_up' | 'merging';

export interface HomeroomBotLinks {
  request: string | null;
  proposal: string | null;
  project: string | null;
}

/** One of an entry's earlier runs: what came of it, and when. */
export interface HomeroomBotRun {
  id: number;
  outcome: HomeroomBotActivityOutcome;
  at: string | null;
}

export interface HomeroomBotJob {
  key: string;
  appSlug: string | null;
  appName: string;
  issueNumber: number | null;
  title: string | null;
  firstVersion: boolean;
  href: string | null;
  links: HomeroomBotLinks;
  earlier: HomeroomBotRun[];
}

/** What the bot is doing for them now: its step of the request's steps, what it is doing, since when. */
export interface HomeroomBotCurrentJob extends HomeroomBotJob {
  phase: HomeroomBotPhase;
  step: number | null;
  of: number | null;
  stepName: string | null;
  doing: string | null;
  since: string | null;
}

/**
 * A request the bot is not working on now: what came of it last, and when.
 * `outcome` is null only for something waiting on them that no run says
 * (a new project waiting for its secrets), which `doing` words instead.
 */
export interface HomeroomBotPastJob extends HomeroomBotJob {
  id: number;
  outcome: HomeroomBotActivityOutcome | null;
  doing: string | null;
  at: string | null;
}

export interface HomeroomBotWork {
  now: HomeroomBotCurrentJob[];
  needsYou: HomeroomBotPastJob[];
  history: HomeroomBotPastJob[];
}

/**
 * #3736: one activity card in the bot's DM, drawn in the message the bot
 * sent when it started a piece of work for the viewer (metadata kind
 * `activity`), with that work's state as services/homeroom-bot-activity.js
 * reads it. While `working`: the step it is at of the request's steps, and
 * what it is doing. Once `done`: what it came to, and when, where the
 * records say. Links are in-app addresses, or null.
 */
export type HomeroomBotActivityOutcome =
  | 'question' | 'proposed' | 'live' | 'closed' | 'blocked' | 'build_failed'
  | 'person' | 'empty' | 'failed' | 'held' | 'stopped' | 'answer' | 'revise';

export interface HomeroomBotActivity {
  messageId: number;
  state: 'working' | 'done';
  startedAt: string | null;
  links: { request: string | null; proposal: string | null };
  step: number | null;
  of: number | null;
  stepName: string | null;
  doing: string | null;
  outcome: HomeroomBotActivityOutcome | null;
  endedAt: string | null;
}

export interface ConversationMember extends ConversationUser {
  role: MemberRole;
  status: MembershipStatus;
  joinedAt?: string | null;
}

export interface MessageReaction {
  emoji: string;
  count: number;
  reacted: boolean;
  users?: string[];
}

export interface MessageAttachment {
  id: string;
  name: string;
  size: number;
  contentType: string;
  kind?: string | null;
  url: string;
  viewUrl?: string | null;
}

export type SharedObjectType = 'app' | 'issue' | 'proposal' | 'governance' | 'spec';

export interface SharedObjectReference {
  type: SharedObjectType;
  appId?: number;
  appSlug?: string;
  issueNumber?: number;
  sessionId?: number;
  proposalId?: number;
  version?: number;
}

/**
 * What a card under a message can be: anything that can be shared, plus the
 * two pages a pasted Homeroom link can name that are not items (#3660) — a
 * community's hub and its discussion. Those two are never stored on a
 * message; they are drawn from the message's own text (./link-cards.tsx).
 */
export type ObjectCardType = SharedObjectType | 'hub' | 'discussion';

export interface SharedObjectCard extends Omit<SharedObjectReference, 'type'> {
  type: ObjectCardType;
  available: boolean;
  title?: string | null;
  subtitle?: string | null;
  state?: string | null;
  author?: string | null;
  href?: string | null;
}

export interface ConversationMessage {
  id: number;
  conversationId: number;
  sender: ConversationUser;
  content: string;
  createdAt: string;
  editedAt?: string | null;
  moderated?: boolean;
  reply?: {
    id: number;
    sender: ConversationUser;
    content: string;
    /** The quoted message was deleted: the quote says so instead of its words (#2387). */
    deleted?: boolean;
  } | null;
  /**
   * Deleted by its author (#2387): a placeholder that keeps its place, its
   * sender and its thread, with no words, files, cards or reactions left.
   */
  deleted?: boolean;
  /**
   * A platform line rather than a person's message. Homeroom no longer
   * writes any into a channel; one kept as the root of somebody's thread is
   * deleted (services/conversations.js). Its sender reads Homeroom.
   */
  system?: boolean;
  /** A reply inside a thread: the id of the message the thread hangs off. */
  threadRootId?: number | null;
  /**
   * On a reply read as part of the main stream (#2387 follow-up): the start
   * of the message its thread hangs off, which the reply's line there names.
   */
  threadRoot?: ThreadRootRef | null;
  /** On a message a thread hangs off: how many replies, when the last, and who. */
  thread?: MessageThreadSummary | null;
  reactions: MessageReaction[];
  attachments: MessageAttachment[];
  objects: SharedObjectCard[];
  /** Set by the platform only, on the Homeroom bot's messages (#3624). */
  metadata?: { homeroomBot?: HomeroomBotMeta } | null;
  /**
   * Whether the VIEWER has saved this message — their own private bookmark,
   * never an aggregate. Hydrated with the page (services/conversations.js), so
   * the row's button renders already filled rather than flashing empty.
   * Optional because an optimistic local echo has no server answer yet.
   */
  saved?: boolean;
  pending?: boolean;
  failed?: boolean;
  clientKey?: string;
}

export interface MessageThreadSummary {
  replyCount: number;
  lastReplyAt: string;
  /** Up to three of the most recent distinct repliers. */
  participants: ConversationUser[];
  /** The newest reply, which the card under the message shows (#2387 follow-up). */
  lastReply?: { id: number; sender: ConversationUser; content: string; createdAt: string } | null;
}

/** The message a thread hangs off, as a reply's line in the main stream names it. */
export interface ThreadRootRef {
  id: number;
  senderUsername: string;
  /** Its start, one line's worth; empty when it was deleted. */
  content: string;
  deleted: boolean;
}

export interface ConversationSummary {
  id: number;
  kind: ConversationKind;
  title: string;
  avatarUrl?: string | null;
  members: ConversationMember[];
  memberCount: number;
  membershipStatus: MembershipStatus;
  myRole: MemberRole;
  requester?: ConversationUser | null;
  peer?: ConversationUser | null;
  latestMessage?: ConversationMessage | null;
  latestSummary?: string;
  lastActivityAt: string;
  unreadCount: number;
  /**
   * QA 2026-09-24 Q2: the viewer asked for this direct conversation and the
   * other person has not accepted yet. One opening message is allowed; after
   * it `canSend` turns false and the thread says who it is waiting for.
   */
  awaitingAcceptance?: boolean;
  canSend: boolean;
  canInvite: boolean;
  canManage: boolean;
  archived?: boolean;
  /** A channel's `#handle` (`general`); null for everything else. */
  channelKey?: string | null;
  /** #3692: the viewer's direct conversation with the Homeroom bot, which carries its activity tray. */
  homeroomBot?: boolean;
}

export interface ConversationDetail extends ConversationSummary {
  members: ConversationMember[];
}

export interface UserSearchResult extends ConversationUser {}

export interface ConversationEvent {
  type: string;
  conversationId?: number;
  conversation_id?: number;
  conversation?: unknown;
  message?: unknown;
  messageId?: number;
  message_id?: number;
  reactions?: unknown;
  unreadCount?: number;
  unread_count?: number;
  [key: string]: unknown;
}

export interface MessagesRoute {
  open: boolean;
  conversationId: number | null;
  /**
   * #2718 review: an app's general discussion, open as a thread of THIS
   * inbox rather than as the app view's own screen.
   *
   * It is listed here beside the people and the agent chats, so it opens
   * here too — beside the list, at `#messages/app/<slug>`. Addressing it as
   * `#app/<slug>/dev/chat` made a row in this list navigate to a different
   * SCREEN ROOT: no conversation list beside it, and the app view's back
   * slot instead of this screen's. A row in a list opens beside that list.
   *
   * Mutually exclusive with `conversationId` — one thread is open, and the
   * two kinds are addressed differently because one is a conversation row
   * in this database and the other is an app.
   */
  appSlug: string | null;
  /**
   * #2813: an AGENT thread open beside the list on a desktop — a global
   * agent chat (`#messages/agent/<id>`) or an app's dev session
   * (`#messages/session/<slug>/<id>`). Both used to navigate away to a
   * screen of their own (`#chat/<id>`, `#app/<slug>/dev/sessions/<id>`),
   * which is still where a PHONE goes: the router swaps these addresses for
   * those there, so the full-screen behaviour on a narrow viewport is the
   * one it always was.
   *
   * Mutually exclusive with the other two, for the same reason they are
   * with each other: one thread is open.
   */
  agent: MessagesAgentThread | null;
  /**
   * #2387: a reply thread open beside the conversation or app channel — the
   * id of the message it hangs off (`#messages/<id>/thread/<root>`,
   * `#messages/app/<slug>/thread/<root>`). Null when no thread is open.
   */
  threadRootId: number | null;
  /**
   * #2387: a message link (`…/m/<id>`) — the message the transcript opens
   * scrolled to and flashes. Cleared once shown.
   */
  focusMessageId: number | null;
  /**
   * #3494: the conversation is open IN ITS COMMUNITY'S PAGE, not on this
   * screen — #general, on Homeroom's Discussion tab (`embed` in ./store.ts).
   * `open` stays false while it is, so nothing that asks whether Messages is
   * on screen (its chrome, Back, the router) hears yes. Optional so a
   * fixture without it reads as false.
   */
  embedded?: boolean;
}

/** An agent thread of the inbox (#2813). See `MessagesRoute.agent`. */
export type MessagesAgentThread =
  | { kind: 'chat'; id: string }
  | { kind: 'session'; slug: string; id: number }
  // #2779: an agent session, a conversation with the Mayor (a serial id), or
  // `new`: the one New change opens, unsent until its first message.
  | { kind: 'agent'; id: number | 'new' };

/** The app whose discussion is open, once its metadata has landed. */
export interface DiscussionContext {
  slug: string;
  name: string;
  /** `can_collaborate === false` — the composer does not render. */
  readOnly: boolean;
  /** Homeroom's old project discussion, kept read-only (#general is its channel now). */
  archived?: boolean;
  /**
   * The app's artwork, for the pane header's tile when the inbox has no row
   * to take it from (a discussion opened from a link by a non-member). The
   * row's own `iconUrl` / `iconEmoji` win when there is one.
   */
  iconUrl: string | null;
  iconEmoji: string | null;
}

import type { AppDiscussion, InboxFilter } from './inbox';

export interface MessagesSnapshot {
  route: MessagesRoute;
  conversations: ConversationSummary[];
  active: ConversationDetail | null;
  messages: ConversationMessage[];
  loadingList: boolean;
  loadingThread: boolean;
  loadingOlder: boolean;
  listLoaded: boolean;
  error: string | null;
  threadError: string | null;
  /**
   * Why the open conversation cannot be shown when trying again cannot change
   * it (QA 2026-09-24 Q16): `left`, the viewer left it in this tab (Back
   * after Leave group lands here); `missing`, the server says it is not theirs
   * to read. Null otherwise. Optional so a fixture without it reads as null.
   */
  threadGone?: 'left' | 'missing' | null;
  nextBefore: number | null;
  online: boolean;
  demo: boolean;
  revision: number;
  /**
   * #2718: the other two kinds of thread this screen lists.
   *
   * `discussions` is GET /api/messages/app-discussions — the general thread
   * on each app the viewer is a member of, one row per app. `filter` is which
   * of the four the list is showing. Agent chats are NOT here: they are
   * already in features/global-chat's own store, and a second copy of a list
   * that is loaded, merged and invalidated elsewhere is a copy that drifts.
   */
  discussions: AppDiscussion[];
  discussionsLoaded: boolean;
  /**
   * The open discussion's app, or null while it loads or when the open
   * thread is a conversation. The row carries the name, but not whether the
   * viewer may write — that is `can_collaborate` on the app itself, so it
   * comes from GET /api/apps/<slug> when the thread opens.
   */
  discussionContext: DiscussionContext | null;
  discussionError: string | null;
  filter: InboxFilter;
  /**
   * #2387: the reply thread open beside the conversation, or null. Its own
   * page of messages, loaded from `/threads/<root>`, so a thread never pushes
   * the conversation's own transcript out of the store.
   */
  thread: ReplyThreadState | null;
  /**
   * #2387: a message link opened the transcript part-way back, so there are
   * newer messages than the ones drawn; the cursor to fetch them. Null when
   * the transcript ends at the present.
   */
  nextAfter: number | null;
  /** #2387: the list pane folded away on a desktop — single-panel mode. */
  listCollapsed: boolean;
  /** #2967: the channels outside Your apps shown, under "Show more". */
  showMoreChannels: boolean;
}

export interface ReplyThreadState {
  conversationId: number;
  rootId: number;
  root: ConversationMessage | null;
  messages: ConversationMessage[];
  loading: boolean;
  error: string | null;
  nextBefore: number | null;
}
