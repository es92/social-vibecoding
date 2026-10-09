/**
 * The group chat transcript's view model.
 *
 * `public/js/group-chat.js` used to render this list by building an HTML string
 * per message and assigning the lot to `#gc-messages.innerHTML` — then again on
 * every reaction, every edit, every bookmark toggle, each with its own targeted
 * `innerHTML` write into the row it had just built. It pushes THIS instead, and
 * ./transcript.tsx is the only writer of the DOM below that host.
 *
 * ── Why the shape is flat and pre-decided ─────────────────────────────
 *
 * Every branch the template string evaluated inline — is this a system row, a
 * vote row, mine, edited, does it carry a quote — is resolved by group-chat.js,
 * where `App.user`, `AppView.voteState` and the message-kind vocabulary already
 * live. The component renders; it does not decide. That is the same split the
 * launcher grid runs under (features/home/grid-store.ts), and it is what lets
 * the module keep owning its data while React owns its markup.
 *
 * ── What is NOT in here, on purpose ───────────────────────────────────
 *
 * `bodyHtml` is sanitized markup, not text. `renderMessageBody` in
 * group-chat.js runs the content through DevChat.renderMarkdown and then a
 * sanitizer; reproducing that in React would mean a second markdown pipeline
 * and a second sanitizer, which is exactly how the two drift apart. The
 * component renders it through `dangerouslySetInnerHTML` with a memoised
 * wrapper — see the note there about object identity.
 *
 * Three things are NOT modelled and stay module-filled hosts, which is the
 * documented controller-host seam in AGENTS.md — the same one `#dev-body` runs
 * under:
 *
 *   * vote controls, whose markup comes from `AppView.voteState`. That arrives
 *     on its own schedule and is re-filled in place, so modelling it would mean
 *     re-rendering every row whenever any vote changed. What the row DOES
 *     model is `voteRef` — the (sessionId, prNumber) pair
 *     `refreshVoteControls` resolves against that state — because those come
 *     off the message and nothing else can supply them;
 *   * the spec-share card, a whole second renderer.
 *
 * That is a second copy of logic that already exists, for markup that changes
 * only when the message does.
 *
 * The attachment row was on that list and should not have been. Its hrefs are
 * derived from the app slug and its markdown chips go through a delegated
 * handler, both of which stay the module's — but neither is markup, and
 * nothing ever filled the host, so a message with files rendered an empty div
 * where its thumbnails and download chips belonged. It is `attachments`
 * below.
 */

import { createStore } from '../../lib/plain-store.js';
import type { ReleaseOutlook } from '../../lib/release-eta';

export interface Reaction {
  emoji: string;
  count: number;
  /** Everyone who reacted — the pill's tooltip, and how "mine" is decided. */
  users: string[];
  mine: boolean;
}

/**
 * A vote row's reference to the pull request it is about.
 *
 * `sessionId` is the precise tag newer servers put in the message metadata;
 * `prNumber` is parsed out of the row's own text and covers rows that predate
 * it. Either may be `''`. They travel onto the controls host as
 * `data-session-id` / `data-pr-number`, which is exactly where
 * `GroupChat.refreshVoteControls` reads them back — the host is module-filled,
 * so the attributes it fills FROM are part of that contract.
 */
export interface VoteRef {
  sessionId: string;
  prNumber: string;
}

/**
 * A quoted reply block, shown above the content (#15, Signal-style reply).
 *
 * Everything the block DRAWS and everything the delegated click handler READS,
 * because they are the same four facts: `_handleQuotedClick` dispatches on
 * `data-quote-source`, opens `data-quote-href` for a PR and jumps to
 * `data-quote-ref` for anything else.
 */
export interface Quote {
  /** 🔀 for a PR, 📋 for a spec, ↩ otherwise. The module picks it. */
  icon: string;
  /** The author, or "PR #12" / "system" where there isn't one. */
  username: string;
  excerpt: string;
  source: string;
  /** PR quotes open this in a new tab; null on every other source. */
  href: string | null;
  /** The row this quote points at, for scroll-into-view. */
  targetId: number | null;
}

/**
 * `github` (#4453) is a comment on a request's GitHub issue, which a request's
 * page draws in the same stream as its thread (AppView._requestThreadRows).
 */
export type MessageKind = 'message' | 'system' | 'vote' | 'spec_share' | 'github';

/**
 * B9: a request's chip on its message (homeroom-bot-chat.js setStatus).
 * `fixing`: a fix asked for on one of the bot's changes still waiting for
 * approval, until that change is ready again. `waiting_first_version`: a
 * request held until the project's first version is live.
 */
export interface BotRequestChip {
  status: 'reading' | 'building' | 'ready' | 'live' | 'fixing' | 'waiting_first_version';
  issueNumber: number | null;
  sessionId: number | null;
}

/**
 * Where a card's request (or fix) stands now, read from the platform's
 * records whenever the card is (homeroom-bot-chat.js cardsOf, CARD_STAGES).
 * `waitingOn` and `youApprove` say who still has to approve a built change,
 * `missing` how many more approvals it needs (0 once it has them) and
 * `needed` how many in all, so a change that needs fewer than the people
 * named says so.
 */
export interface BotRequestState {
  stage: 'waiting_first_version' | 'reading' | 'waiting' | 'building' | 'question' | 'checking' | 'proposed' | 'approved'
    | 'live' | 'closed' | 'person' | 'stopped' | 'fixing' | 'asked' | 'answered';
  sessionId?: number;
  youApprove?: boolean;
  waitingOn?: string[];
  more?: number;
  missing?: number;
  needed?: number;
  /**
   * `approved`, on a merge of the platform's own app that is not live yet:
   * when the platform's next release carries it (services/release-watch.js),
   * which the card words (../../lib/release-eta.ts).
   */
  release?: ReleaseOutlook;
}

/**
 * B9: the card under a message of the viewer's that asked Homeroom bot for
 * something (homeroom-bot-chat.js cardOf): filed (it builds it), group (filed
 * for the group), unsure (asks first), question (pointed at its chat), busy
 * (too many this hour), failed (could not file it). WP-C: offer, an idea of
 * a newcomer's offered as a request; `first`, their first request on the
 * project, which says it stays. Fix in place: revise, a fix sent to one of
 * the bot's pending changes (`sessionId`, `firstVersion`), and
 * revise_refused when that change could not take one. `state` follows the
 * request from there.
 */
export interface BotRequestCard {
  messageId: number;
  kind: 'filed' | 'group' | 'unsure' | 'question' | 'busy' | 'failed' | 'offer' | 'revise' | 'revise_refused';
  title: string | null;
  issueNumber: number | null;
  typicalMinutes?: number;
  first?: boolean;
  sessionId?: number;
  firstVersion?: boolean;
  state?: BotRequestState;
}

/**
 * One of the two proposal events the general chat draws: a proposal put up
 * for a vote, or a proposal merged. Decided by `GroupChat._proposalEvent`
 * from the row's kind and the server's own wording, which is that module's
 * vocabulary; ./proposal-event.tsx only draws it, as a message from whoever
 * did it. `sender` is that name: the actor where there is one, else the app
 * itself announcing a merge its vote decided. `icon` is the Dev board's glyph
 * for the same proposal, from its own table, or null where app-view.js is
 * not loaded.
 */
/** One line of the Friday card (#1688): a change that landed, or a proposal waiting. */
export interface WeeklyItem {
  id: number | null;
  prNumber: string;
  title: string;
  author: string;
  /** Whose Yes counted when it merged; empty on an open proposal. */
  backers: string[];
}

/** The Friday card's data (#1688): what went live this week and what is waiting on votes. */
export interface WeeklyCard {
  app: string;
  slug: string;
  merged: WeeklyItem[];
  mergedTotal: number;
  open: WeeklyItem[];
  openTotal: number;
}

export interface ProposalEvent {
  /**
   * #1688 adds `weekly`: the Friday card, a message from the app itself.
   * `vote` and `notice` exist only on a change page's own Discussion
   * (`GroupChat._threadEvent`), where every row is drawn in this language:
   * a vote cast, and any other notice the platform posted about the change.
   */
  type: 'submitted' | 'merged' | 'weekly' | 'vote' | 'notice';
  /** `vote` rows: which way, and the line the voter left, if any. */
  vote?: 'yes' | 'no';
  reason?: string;
  /**
   * `vote` rows (#3411): the voter's vote was cast on an earlier version of
   * the proposal and no longer counts in the tally.
   */
  earlier?: boolean;
  /** `notice` rows: the notice, reworded for the page it is on. */
  text?: string;
  /**
   * True on the proposal's OWN page: the row names the act without the
   * number and title ("Asked for approval"), and is no door.
   */
  here?: boolean;
  /** The Friday card's data; set only when `type` is `weekly`. */
  weekly?: WeeklyCard | null;
  /** The session id from the row's metadata tag, or '' on an older row. */
  sessionId: string;
  prNumber: string;
  /** The PR title parsed out of the line, or '' when it carried none. */
  title: string;
  /** Who put it up for a vote, or the admin who force-merged it; '' otherwise. */
  actor: string;
  /** The name on the row's header line: `actor`, or the app's name. */
  sender: string;
  /** True when the actor is the viewer: the row sits on the right, as their messages do. */
  mine: boolean;
  force: boolean;
  /** "a/b", the tally the merge announced; '' on a submission. */
  votes: string;
  icon: { tint: string; path: string; small?: boolean; title?: string } | null;
  /**
   * #1688: who the merge announcement named — the proposer, the Yes voters
   * whose votes counted, and whoever shaped it. Null on a submission, a
   * force merge, and an announcement from before names were carried.
   */
  credits?: { author: string; backers: string[]; shapers: string[] } | null;
  /**
   * A merge on the platform's own app, whose release runs after the merge
   * (follow-up to #2897): the announcement said it "will be live in a few
   * minutes" rather than "is live". Absent on every other row.
   */
  liveSoon?: boolean;
}

/**
 * One file on a message, as its chip draws it.
 *
 * Resolved by the module, which owns the app slug the URL is built from and
 * the 32-hex id check that drops anything else before it can reach an `href`.
 * `kind` decides the shape: `image` is an inline thumbnail, `markdown` and
 * `html` are chips with their own action, and everything else is a plain
 * download. `badge` is the little MD / HTML / BIN tag, or null where the kind
 * carries no tag.
 */
export interface Attachment {
  id: string;
  kind: string;
  /** The filename, as a text child — never interpolated into an attribute. */
  name: string;
  url: string;
  /** Pre-formatted by the module: "2 KB", "3.0 MB". */
  size: string;
  badge: string | null;
}

/** #2387: a reply thread's summary, as the chip under its first message draws it. */
export interface ThreadSummaryView {
  replyCount: number;
  lastReplyAt: string | null;
  participants: string[];
  /** The newest reply, which the card under the message shows (#2387 follow-up). */
  lastReply?: { name: string; text: string } | null;
}

/**
 * A reply-thread reply read as part of the GENERAL stream (#2387 follow-up):
 * which thread it is in, and the start of that thread's first message, which
 * its line there names. The general transcript draws it as a card where it
 * landed; a thread's own transcript draws it as the row it always was.
 */
export interface ReplyInStream {
  rootId: number;
  rootText: string;
  rootDeleted: boolean;
}

export interface TranscriptMessage {
  id: number | null;
  kind: MessageKind;
  username: string;
  senderId?: number | null;
  /**
   * Rendered stamp — formatted by the module, whose locale rules these are.
   * The time of day alone for today's messages, prefixed with the date once
   * it is not today's (#1808).
   */
  time: string;
  /** The same instant with nothing elided, for `title`. */
  timeTitle: string;
  /** #2783: the raw instant (ISO), which consecutive messages group on. */
  at?: string | null;
  /** Sanitized markdown for an ordinary message; plain text for a system row. */
  bodyHtml: string;
  systemText: string;
  /** Set by transcript.tsx's foldRepeats: how many identical lines this one stands for. */
  repeat?: number;
  mine: boolean;
  /** Full timestamp for the "edited" marker's tooltip, or null if never edited. */
  editedTitle: string | null;
  unread: boolean;
  bookmarked: boolean;
  /**
   * #2236: 'agent' when a coding agent posted the message on the author's
   * behalf through the connector; the row wears the "via agent" chip. The
   * module reads it off either spelling of the row (`posted_via` loaded,
   * `postedVia` live) and never off anything the composer sent.
   */
  postedVia?: 'agent' | null;
  /**
   * The 1.5s highlight a jump-to-original lands on. On the MODEL because the
   * row is React's: `_handleQuotedClick` used to `classList.add` it, which the
   * next repaint would have swept away mid-animation.
   */
  flash: boolean;
  canEdit: boolean;
  /**
   * Whether each of the row's three header controls renders. The module
   * decides — `_readOnly()` and `App.user` are its state, not the
   * component's — which is the same split every other field here runs under.
   *
   * They were MISSING from this type and from the component until the
   * conversion was checked against a seeded chat: the legacy row emitted an
   * edit button, a save button and an add-reaction button, and the first
   * React transcript silently rendered none of the three.
   */
  showEdit: boolean;
  showBookmark: boolean;
  showReact: boolean;
  quote: Quote | null;
  reactions: Reaction[];
  /** The files on this message, already resolved to URLs. Empty for most rows. */
  attachments: Attachment[];
  /** Vote rows only: the tint class the module derives from the viewer's vote. */
  voteRowClass: string;
  /** Vote rows only: what the controls host is about. Null on every other kind. */
  voteRef: VoteRef | null;
  /**
   * B9: how a request asked of Homeroom bot on this message is going, which
   * everybody in the room sees (metadata the server alone sets): reading,
   * building, ready (with its change to try), live. Null for none.
   */
  botRequest?: BotRequestChip | null;
  /** B9: the card under the viewer's own message about it, theirs alone. */
  botCard?: BotRequestCard | null;
  /** B9: "Make this a request" is offered on this message (theirs, and the bot answers them here). */
  canAskBot?: boolean;
  /**
   * #4238: the Open button under Homeroom bot's "I've made the first
   * version" message in a project's channel. Absent or null on every other row.
   */
  openApp?: { label: string; target: string } | null;
  /**
   * #4455: a system row that announces the preview build, from its metadata:
   * `started` (a change's page leaves it out: its Testing card says so) or
   * `ready` ("The preview is ready · Try it"). Absent on every other row.
   */
  stagingBuild?: 'started' | 'ready';
  /** Spec-share rows only — see SpecShareView. Null on every other kind. */
  specShare: SpecShareView | null;
  /**
   * Vote rows only: whether the pull request this row is about is still up
   * for a vote. `open` is what the general chat's event row marks as still
   * wanting the reader (./proposal-event.tsx); `settled` is merged, merging,
   * or gone from the votable set; `unknown` means the vote snapshot has not
   * arrived and reads as open, since a vote shown as over when it is not is
   * the failure that matters. Written by `_messageView` and patched by
   * `refreshVoteControls` in public/js/group-chat.js, which is where
   * `AppView.voteState` lives. Absent on every other kind.
   */
  votePhase?: 'open' | 'settled' | 'unknown';
  /**
   * The proposal event the general chat draws this row as, or null. The
   * general chat draws a row of kind `system` or `vote` ONLY when this is
   * set; the thread transcript ignores it and draws every row.
   */
  event?: ProposalEvent | null;
  /**
   * Where the event row leads — the proposal's page — or null while the
   * session behind it is unknown, in which case the row is not a link. A
   * field of its own, patched by `refreshVoteControls`, because a patch
   * compares by identity and `event` is an object.
   */
  eventHref?: string | null;
  /**
   * #2387: the message's own words, unrendered — what "Copy text" copies.
   * `bodyHtml` is the markdown pipeline's output, which is not what someone
   * pasting it elsewhere wants.
   */
  text?: string;
  /** #2387: deleted by its author — drawn as a placeholder with no controls. */
  deleted?: boolean;
  /** #2387: the reply thread under this message, or null when it has none. */
  thread?: ThreadSummaryView | null;
  /** #2387: whether a reply thread can hang off this row (the general chat's people and specs). */
  canThread?: boolean;
  /** #2387: this row is the message a reply thread hangs off, drawn at the thread's head. */
  threadRoot?: boolean;
  /** Set on a reply-thread reply; the general transcript draws it as activity. */
  replyOf?: ReplyInStream | null;
  /** #4453: a `github` row's stable key (GitHub's comment id, or its place). */
  key?: string;
  /**
   * #4453: Homeroom bot's spec on a `github` row (`AppView._botSpecOf`): its
   * title and its text, as markdown and rendered. A request's page draws it
   * as a spec card and an event line, not as a comment.
   */
  githubSpec?: { title: string | null; markdown: string; html: string } | null;
}

/**
 * A shared spec, as its card draws it.
 *
 * `snippetHtml` is markdown the module rendered through `DevChat.renderMarkdown`
 * so the preview matches the dev-chat spec viewer exactly; `snippetText` is the
 * fallback for a page where dev-chat.js did not load, and arrives as a text
 * child. At most one of the two is ever set.
 */
export interface SpecShareView {
  title: string;
  /** The header the panel shows while the fetch is in flight. */
  previewTitle: string;
  sharedBy: string;
  version: number;
  /** Formatted build time, or null when the share carried none. */
  built: string | null;
  prNumber: number | null;
  sessionId: number | null;
  snippetHtml: string | null;
  snippetText: string | null;
}

/**
 * The rows above the messages: "Load earlier", and the empty/loading line.
 * Only the thread transcript has them — the general chat paginates from its own
 * header — but modelling them here keeps ONE component for both hosts.
 */
export interface TranscriptLead {
  /** Show the "Load earlier" control. */
  earlier: boolean;
  /** The placeholder line, or null when there are messages to show. */
  placeholder: string | null;
  /**
   * #2992: the history request failed — the line to show with a "Try again"
   * control, drawn whether or not live rows have landed since. Null or absent
   * when the last load succeeded.
   */
  error?: string | null;
  /**
   * The general chat's quiet card, drawn AFTER the rows when nobody has
   * posted a message of their own among the loaded ones — the activity
   * notices land in this stream on their own, so "empty" is rare and "no
   * conversation" is what a visitor actually meets. The module supplies the
   * three facts the card cannot know: whether it has paged back to the
   * beginning (`exhausted`, which is the difference between "yet" and
   * "lately"), whether the viewer has a composer to answer with, and the
   * app's name. Null or absent on the thread transcript, which has its own
   * placeholder above.
   */
  quiet?: { exhausted: boolean; canPost: boolean; appName: string; variant?: 'app' | 'change' } | null;
  /**
   * How a THREAD transcript draws its rows. 'chat' is the change page's
   * Discussion: bubbles for people, and every notice as a message from
   * whoever did it, the general chat's language. Absent or 'flat', the
   * thread keeps its flat named rows and centred lines (an issue's page).
   */
  language?: 'chat' | 'flat' | 'request' | 'change';
  /**
   * #4453: a request's page. `loaded` once its thread's history has
   * answered; `githubMore` when GitHub returned only the newest comments,
   * with the issue's page to read the rest on.
   */
  request?: { loaded: boolean; githubMore?: { url: string | null } | null } | null;
  /**
   * #4455: a change's page. `loaded` once its thread's history has answered;
   * `closed` is what the page says instead of a stream while nobody else can
   * see the change (its thread is not read then).
   */
  change?: { loaded: boolean; closed: string | null } | null;
  /**
   * The general chat only: where the reader's reading stood when the
   * channel opened (`GroupChat._takeUnreadMark`), the newest message read
   * then and how many were unread. The transcript draws its "New" line
   * above the first message after it, and the pane counts them. Null or
   * absent with nothing unread.
   */
  unread?: { lastReadId: number; count: number } | null;
}

export interface TranscriptView {
  messages: TranscriptMessage[];
  lead: TranscriptLead;
}

export interface TranscriptState {
  /** False until group-chat.js has pushed once — see the initial-render note. */
  ready: boolean;
  /**
   * Transcripts by host key — `main` for the general chat, `thread` for the
   * topic sub-view. Keyed rather than two stores because the two are the same
   * shape rendered by the same component into different hosts; a second store
   * would be a second copy of every update path.
   */
  byKey: Record<string, TranscriptView>;
}

export const EMPTY_VIEW: TranscriptView = {
  messages: [],
  lead: { earlier: false, placeholder: null },
};

/**
 * Renders nothing, which is exactly the empty `<div id="gc-messages">` that
 * `AppView.renderDevChatTab` creates. The host is built by a legacy template,
 * so there is no prerender to match here — but an empty first render still
 * matters: the module mounts this portal and THEN loads, and a transcript that
 * flashed placeholder rows would be visible on every tab switch.
 */
export const INITIAL_TRANSCRIPT: TranscriptState = { ready: false, byKey: {} };

export const transcriptStore = createStore<TranscriptState>(INITIAL_TRANSCRIPT);

/**
 * How many times a channel has been opened at its "New" line
 * (mount.ts openAtUnreadLine). The pane's banner counts from the opening, so
 * where the line sat before the stream was moved to it is not the reader
 * scrolling onto it (general-chat.tsx).
 */
export const unreadOpenings = createStore<{ count: number }>({ count: 0 });

if (typeof window !== 'undefined') {
  (window as unknown as { GroupChatTranscriptStore?: unknown })
    .GroupChatTranscriptStore = transcriptStore;
}
