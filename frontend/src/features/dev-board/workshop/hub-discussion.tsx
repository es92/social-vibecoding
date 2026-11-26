/**
 * THE HUB'S DISCUSSION (owner, 26 Nov 2026): a project's #general, drawn on
 * its hub as posts with replies.
 *
 *   ┌ Discussion ─────────────────────────────────────────────┐
 *   │ Posts and replies from everyone in Lakeside Book Club    │
 *   │ (Y) [ Start a post…                               (↑) ]  │
 *   │ Sort by: Newest · Most replies                           │
 *   │ ┌──────────────────────────────────────────────────────┐ │
 *   │ │ (P) Priya  1:32 PM  •                  ◇ 2 replies    │ │
 *   │ │ I can host on the 14th if we start at 7. Who is in?   │ │
 *   │ │ [👍 4] [🎉 1]                                          │ │
 *   │ └─┬────────────────────────────────────────────────────┤ │
 *   │   │ (D) Dev  1:40 PM   In. I can bring four chairs.     │ │
 *   │   │ [ Reply in thread…                            (↑) ] │ │
 *   │   └─────────────────────────────────────────────────────┘ │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Each post is its own outlined box: one header line (face, name, time, a
 * blue dot when it is new to the viewer, and at the far end "N replies" in
 * the accent or a grey "Reply"), the words at body size, then its reaction
 * pills. Its replies hang in a second box joined under it, faintly tinted
 * and stepped in from the left: "View N earlier replies" when the thread is
 * long, the newest few as ordinary chat rows, then the reply field. A post
 * with no replies has no second box until somebody presses Reply.
 *
 * Reactions have no button of their own on the post: a pointer gets the
 * platform's hover bar (../../message-actions/action-bar.tsx) and a touch
 * screen the long-press sheet (../../message-actions/action-sheet.tsx), the
 * same two every chat row has.
 *
 * Three drawings of one feed (./discussion-feed.ts):
 *   - `full`, the hub's card: on a wide window the right of the hub's two
 *     columns, under 1024px the card after For you (app.css, THE HUB IN TWO
 *     COLUMNS);
 *   - `preview`, a phone's card: the newest few posts, a line each, with their
 *     reply counts; it opens the page;
 *   - `page`, the Discussion whole: the place the places list's Discussion
 *     row opens (`posts`, ./places.ts) and the phone's card goes to.
 *
 * Discussion takes #general's place on the hub, so For you has no #general
 * row while this card is drawn (./hub-cards.tsx ForYouCard `discussionHere`).
 *
 * ── #general IS THE DISCUSSION (part 2, 26 Nov 2026) ──────────────────
 *
 * The places list's #general row is the Discussion row, which opens the
 * page. A door that names a message or a reply thread in #general (a
 * notification, a message link: AppView._landOnDiscussion) lands on the
 * page, which opens the post it is in, brings the message into view and
 * marks it (DiscussionFeed.place). What the posts do not show, an old
 * message's own thread or a message further back than PLACE_PAGES pages,
 * goes on to #general's chat with the same target (`onMissing`). The chat
 * is still the room's other drawing, one stream oldest to newest with files,
 * formatting and editing: the page's "Open as chat", and the channel's own
 * address. Its topics are untouched.
 *
 * ── Island rules ───────────────────────────────────────────────────────
 *
 * The hub mounts client-side and reads in effects: the first render is the
 * card's frame and its loading rows, never data. It reads again every
 * REFRESH_MS while the page is on screen, after the viewer writes, and when
 * the window comes back into focus; the room's own socket belongs to the
 * channel's chat, which this does not hold.
 */

import {
  useCallback, useEffect, useId, useMemo, useRef, useState,
  type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject,
} from 'react';

import { ReactionPill } from '@/components/ui/feed';
import { ArrowUpIcon, ChevronRightIcon, HashIcon, ReplyArrowIcon, ThreadIcon } from '@/components/ui/icons';

import { useMessages } from '../../../lib/i18n/react';
import { messageStamp, shortDate } from '../../../lib/timestamp';
import { enterSends, isTouchInput } from '../../../lib/enter-sends';
import { useStoreState } from '../../../lib/use-store-state';
import { MessageActionBar } from '../../message-actions/action-bar';
import { MessageActionSheet, useLongPress } from '../../message-actions/action-sheet';
import { EmojiPicker } from '../../message-actions/emoji-picker';
import { emojiName } from '../../message-actions/emoji-data';
import { rememberReaction, useRecentReactions } from '../../message-actions/recents';
import { useDismiss } from '../../message-actions/use-dismiss';
import { MessageMarkdown, UserAvatar } from '../../messages/format';
import type { ConversationUser } from '../../messages/types';
import type { CommunityPayload } from './community-card';
import {
  POSTS_SHOWN, PREVIEW_POSTS, appSource, assemble, conversationSource, earlierFold, inEarlier, isNewTo, shownReplies, sortItems,
  toggledReactions,
  type DiscussionItem, type DiscussionPerson, type DiscussionSort, type DiscussionSource, type DiscussionSummary,
  type EarlierFold, type Said,
} from './discussion-feed';
import { takeDiscussionTarget, type DiscussionTarget } from './project-discussion';

/** How often the card reads the room again while it is on screen. */
export const REFRESH_MS = 60_000;
/** At most this many older posts with a new reply are brought in by one read. */
const ACTIVE_ROOTS_READ = 5;
/** Older pages of the room a door's message is looked for in before #general's chat takes it. */
export const PLACE_PAGES = 3;
/** How long a message a door named stays marked. */
const FOCUS_MS = 2400;

/** Where a door's message is on the Discussion: the post it is drawn in. */
export interface Placed { key: string; messageId: number }

type Channel = NonNullable<CommunityPayload['channel']>;

// ── The feed: what one room has read, shared by the card and the page ──

interface FeedState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  messages: ReadonlyMap<number, Said>;
  /** The oldest main-stream message read: where the next older page starts. */
  oldest: number | null;
  /** The room has older messages than `oldest`. */
  more: boolean;
  /** Where the viewer's reading stood when the room was first read. */
  readId: number | null;
  /** Threads read whole (a post's "View N earlier replies"). */
  opened: ReadonlySet<number>;
  /** A read of older posts, or of a thread, is under way. */
  busy: boolean;
}

const EMPTY: FeedState = {
  status: 'idle', messages: new Map(), oldest: null, more: false, readId: null, opened: new Set(), busy: false,
};

export class DiscussionFeed {
  source: DiscussionSource;
  summary: DiscussionSummary | null;
  /** The viewer's username, which the room's reactions are read against. */
  viewer: { current: string | null };
  private state: FeedState = EMPTY;
  private listeners = new Set<() => void>();
  private holders = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private marked = 0;
  /** The first read, while it runs and once it has: what a door waits for. */
  private loaded: Promise<void> | null = null;

  constructor(source: DiscussionSource, summary: DiscussionSummary | null, viewer: { current: string | null }) {
    this.source = source;
    this.summary = summary;
    this.viewer = viewer;
  }

  get me(): string | null {
    return this.viewer.current;
  }

  get = (): FeedState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private set(next: Partial<FeedState>): void {
    this.state = { ...this.state, ...next };
    for (const listener of [...this.listeners]) listener();
  }

  private merge(list: ReadonlyArray<Said>, extra: Partial<FeedState> = {}): void {
    const messages = new Map(this.state.messages);
    for (const said of list) messages.set(said.id, said);
    this.set({ ...extra, messages });
  }

  fold(): EarlierFold | null {
    return earlierFold(this.summary);
  }

  /** The posts, as read so far. */
  items(): DiscussionItem[] {
    const fold = this.fold();
    const earlierRead = fold ? [...this.state.messages.values()].filter((m) => m.rootId == null && m.id <= fold.lastId).length : 0;
    return assemble([...this.state.messages.values()], fold, !!fold && earlierRead < fold.count && this.state.more);
  }

  /** Whether "Show more posts" can read further back. */
  morePosts(): boolean {
    const fold = this.fold();
    if (!this.state.more) return false;
    return !(fold && this.state.oldest != null && this.state.oldest <= fold.lastId);
  }

  /** Hold the feed while a card shows it: it is read once, and again every REFRESH_MS. */
  hold(): () => void {
    this.holders += 1;
    if (this.state.status === 'idle' || this.state.status === 'error') void this.load();
    if (!this.timer && typeof window !== 'undefined') {
      this.timer = setInterval(() => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
        void this.refresh();
      }, REFRESH_MS);
    }
    return () => {
      this.holders -= 1;
      if (this.holders <= 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }

  load(): Promise<void> {
    this.loaded = this.readFirst();
    return this.loaded;
  }

  private async readFirst(): Promise<void> {
    this.set({ status: 'loading' });
    try {
      const page = await this.source.page(null);
      const readId = page.readId ?? await this.source.readPosition();
      this.state = { ...EMPTY, opened: this.state.opened, status: 'ready', readId };
      this.merge(page.messages, { oldest: oldestMain(page.messages), more: page.more, status: 'ready' });
      await this.fillIn();
    } catch {
      this.set({ status: 'error' });
    }
  }

  /** Read the room's newest page again, keeping what is already read. */
  async refresh(): Promise<void> {
    if (this.state.status !== 'ready') return;
    try {
      const page = await this.source.page(null);
      this.merge(page.messages);
      await this.fillIn(true);
    } catch { /* the next read tries again */ }
  }

  /**
   * What a page of the stream does not carry by itself: the newest old
   * messages of a folded history, the replies of the posts on show (a room
   * whose stream holds no replies), what was written into the Earlier post,
   * and an older post that has a new reply.
   */
  private async fillIn(again = false): Promise<void> {
    const fold = this.fold();
    const all = [...this.state.messages.values()];
    const reads: Promise<unknown>[] = [];
    if (fold && !all.some((m) => m.rootId == null && m.id <= fold.lastId)) {
      reads.push(this.source.page(fold.lastId + 1).then((page) => {
        this.merge(page.messages, { oldest: Math.min(this.state.oldest ?? Infinity, oldestMain(page.messages) ?? Infinity), more: page.more });
      }).catch(() => {}));
    }
    if (fold && (!again || !this.source.streamHoldsReplies)) reads.push(this.readThread(fold.lastId, false));
    if (!this.source.streamHoldsReplies) {
      const roots = all.filter((m) => m.rootId == null && m.replyCount > 0 && !inEarlier(m, fold))
        .sort((a, b) => b.id - a.id).slice(0, POSTS_SHOWN);
      for (const root of roots) {
        const have = all.filter((m) => m.rootId === root.id).length;
        if (!again || have < root.replyCount) reads.push(this.readThread(root.id, false));
      }
    } else {
      const known = new Set(all.filter((m) => m.rootId == null).map((m) => m.id));
      const missing = [...new Set(all.filter((m) => m.rootId != null && !known.has(m.rootId) && !inEarlier(m, fold)).map((m) => m.rootId as number))]
        .sort((a, b) => b - a).slice(0, ACTIVE_ROOTS_READ);
      for (const rootId of missing) reads.push(this.readThread(rootId, false));
    }
    await Promise.all(reads);
  }

  private async readThread(rootId: number, open: boolean): Promise<void> {
    try {
      const thread = await this.source.thread(rootId);
      const list = thread.root ? [thread.root, ...thread.replies] : thread.replies;
      const opened = open ? new Set([...this.state.opened, rootId]) : this.state.opened;
      this.merge(list, { opened });
    } catch { /* drawn as it was */ }
  }

  /** "View N earlier replies" on a post: its thread, read whole. */
  async openThread(rootId: number): Promise<void> {
    this.set({ busy: true });
    await this.readThread(rootId, true);
    this.set({ busy: false });
  }

  /** "View N earlier replies" on the Earlier post: the next older page of the history. */
  async openEarlier(): Promise<void> {
    const fold = this.fold();
    if (!fold) return;
    const oldestEarlier = Math.min(...[...this.state.messages.values()].filter((m) => m.rootId == null && m.id <= fold.lastId).map((m) => m.id));
    this.set({ busy: true, opened: new Set([...this.state.opened, fold.lastId]) });
    try {
      const page = await this.source.page(Number.isFinite(oldestEarlier) ? oldestEarlier : fold.lastId + 1);
      this.merge(page.messages, { oldest: Math.min(this.state.oldest ?? Infinity, oldestMain(page.messages) ?? Infinity), more: page.more });
    } catch { /* drawn as it was */ }
    this.set({ busy: false });
  }

  /** "Show more posts": the next older page of the stream. */
  async morePostsRead(): Promise<void> {
    if (!this.morePosts() || this.state.oldest == null) return;
    this.set({ busy: true });
    try {
      const page = await this.source.page(this.state.oldest);
      this.merge(page.messages, { oldest: oldestMain(page.messages) ?? this.state.oldest, more: page.more });
      await this.fillIn(true);
    } catch { /* drawn as it was */ }
    this.set({ busy: false });
  }

  /** Write a post or a reply; it is on the card when the answer lands. */
  async write(content: string, rootId: number | null): Promise<void> {
    const said = await this.source.post(content, rootId);
    if (!said) { await this.refresh(); return; }
    const updates: Said[] = [said];
    if (rootId) {
      const root = this.state.messages.get(rootId);
      if (root) updates.push({ ...root, replyCount: root.replyCount + 1, lastReplyAt: said.at });
    }
    this.merge(updates);
  }

  /** Toggle the viewer's reaction: drawn at once, then as the room answers. */
  async react(messageId: number, emoji: string): Promise<void> {
    const said = this.state.messages.get(messageId);
    if (!said) return;
    const was = said.reactions.find((r) => r.emoji === emoji);
    const on = !(was && was.reacted);
    this.merge([{ ...said, reactions: toggledReactions(said.reactions, emoji, this.me) }]);
    const answer = await this.source.react(messageId, emoji, on);
    const now = this.state.messages.get(messageId);
    if (!now) return;
    this.merge([{ ...now, reactions: answer || said.reactions }]);
  }

  /**
   * Where the message a door named is on the Discussion, read far enough
   * back to draw it: its post, with the replies box open when it is a reply
   * or the door named the thread. Null when the posts do not show it (an old
   * message's own thread, one further back than PLACE_PAGES pages, one gone),
   * for #general's chat to take.
   */
  async place(target: Pick<DiscussionTarget, 'threadRootId' | 'focusMessageId'>): Promise<Placed | null> {
    await (this.loaded || this.load());
    if (this.state.status !== 'ready') return null;
    const rootId = target.threadRootId || null;
    const wanted = target.focusMessageId || rootId;
    if (!wanted) return null;
    const have = () => this.state.messages.get(wanted) || null;
    if (rootId && !have()) await this.readThread(rootId, false);
    for (let i = 0; !have() && i < PLACE_PAGES && this.state.more && this.state.oldest != null; i += 1) {
      try {
        const page = await this.source.page(this.state.oldest);
        this.merge(page.messages, { oldest: oldestMain(page.messages) ?? this.state.oldest, more: page.more });
      } catch { break; }
    }
    const said = have();
    if (!said) return null;
    if (said.rootId != null && !this.state.messages.has(said.rootId)) await this.readThread(said.rootId, false);
    const item = this.items().find((it) => (it.kind === 'post' && it.root.id === said.id) || it.replies.some((r) => r.id === said.id));
    if (!item) return null;
    const asReply = item.kind === 'earlier' || item.root.id !== said.id;
    if (asReply || rootId) {
      const open = item.kind === 'post' ? item.root.id : item.fold.lastId;
      if (item.kind === 'post' && item.replies.length < item.replyCount) await this.readThread(open, true);
      else this.set({ opened: new Set([...this.state.opened, open]) });
    }
    return { key: item.key, messageId: said.id };
  }

  /** The viewer has seen the room up to its newest post: their reading moves there, once. */
  markSeen(): void {
    const newest = Math.max(0, ...[...this.state.messages.values()].filter((m) => m.rootId == null).map((m) => m.id));
    if (!newest || newest <= (this.state.readId || 0) || newest <= this.marked) return;
    this.marked = newest;
    void this.source.markRead(newest).catch(() => {});
  }
}

function oldestMain(list: ReadonlyArray<Said>): number | null {
  const ids = list.filter((m) => m.rootId == null).map((m) => m.id);
  return ids.length ? Math.min(...ids) : null;
}

const feeds = new Map<string, DiscussionFeed>();

/** The source a channel is read from: Homeroom's #general conversation, or the app's own chat. */
export function sourceFor(slug: string, channel: Channel, viewer: { current: string | null }): DiscussionSource {
  const conversationId = Number((channel as { conversation_id?: unknown }).conversation_id) || null;
  return conversationId ? conversationSource(conversationId) : appSource(slug, viewer);
}

function sourceKey(slug: string, channel: Channel): string {
  const conversationId = Number((channel as { conversation_id?: unknown }).conversation_id) || null;
  return conversationId ? `conversation:${conversationId}` : `app:${slug}`;
}

/** The one feed of a channel, shared by its hub card and its page. */
export function feedFor(slug: string, channel: Channel, me: string | null): DiscussionFeed {
  const summary = (channel as { discussion?: DiscussionSummary | null }).discussion || null;
  let feed = feeds.get(sourceKey(slug, channel));
  if (!feed) {
    const viewer = { current: me };
    feed = new DiscussionFeed(sourceFor(slug, channel, viewer), summary, viewer);
    feeds.set(feed.source.key, feed);
  } else {
    feed.summary = summary;
    feed.viewer.current = me;
  }
  return feed;
}

/** For tests: forget every feed. */
export function resetDiscussionFeedsForTest(): void {
  feeds.clear();
}

/** The phone's card asked for the page with its box ready to write in. */
let focusOnOpen = false;

// ── The viewer ─────────────────────────────────────────────────────────

interface Viewer { username: string; avatarUrl: string | null }

/** Who is reading, once the page has said (read in an effect: the first render has nobody). */
function useViewer(): { viewer: Viewer | null; known: boolean } {
  const [seen, setSeen] = useState<{ viewer: Viewer | null; known: boolean }>({ viewer: null, known: false });
  useEffect(() => {
    const user = (window as unknown as { App?: { user?: { username?: string; avatarUrl?: string | null } | null } }).App?.user;
    setSeen({ viewer: user && user.username ? { username: user.username, avatarUrl: user.avatarUrl || null } : null, known: true });
  }, []);
  return seen;
}

function asUser(who: DiscussionPerson): ConversationUser {
  return { id: who.id || 0, username: who.username, avatarUrl: who.avatarUrl || null, bot: !!who.bot, displayName: who.displayName };
}

function nameOf(who: DiscussionPerson): string {
  return who.bot && who.displayName ? who.displayName : who.username;
}

/** Open a place in the channel's own chat: an old message's thread. */
function openInGeneral(slug: string, channel: Channel, threadRootId: number): void {
  const conversationId = Number((channel as { conversation_id?: unknown }).conversation_id) || null;
  (window as unknown as { AppView?: { _landOnDiscussion?: (slug: string, target: object) => void } })
    .AppView?._landOnDiscussion?.(slug, { threadRootId, asChat: true, ...(conversationId ? { conversationId } : {}) });
}

// ── The card ───────────────────────────────────────────────────────────

export interface DiscussionCardProps {
  slug: string;
  /** The project's name, for the line under the heading. */
  name: string;
  data: CommunityPayload | null;
  mode: 'full' | 'preview' | 'page';
  /** The phone's card: open the page. */
  onOpenPage?: () => void;
  /** The page: show #general as a chat (its "Open as chat"). */
  onChat?: () => void;
  /** The page: a door's message the posts do not show, for #general's chat to take. */
  onMissing?: (target: DiscussionTarget) => void;
}

export function DiscussionCard({ slug, name, data, mode, onOpenPage, onChat, onMissing }: DiscussionCardProps): ReactNode {
  useMessages('project');
  useMessages('messages');
  const headId = useId();
  const { viewer, known } = useViewer();
  const channel = data?.channel || null;
  const me = viewer ? viewer.username : null;
  const feed = useMemo(() => (channel ? feedFor(slug, channel, me) : null), [slug, channel, me]);
  const host = useRef<HTMLElement | null>(null);
  const [focus, setFocus] = useState<Placed | null>(null);
  const missing = useRef(onMissing);
  missing.current = onMissing;
  const focused = useCallback(() => setFocus(null), []);

  // Read once the viewer is known, so their own reactions read as theirs.
  useEffect(() => (feed && known ? feed.hold() : undefined), [feed, known]);
  useEffect(() => {
    if (!feed) return undefined;
    const again = () => { if (document.visibilityState !== 'hidden') void feed.refresh(); };
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
  }, [feed]);
  // The page takes a door's target (AppView._stashDiscussionTarget): when it
  // mounts, and when a door is followed while it is up.
  useEffect(() => {
    if (mode !== 'page' || !feed || !known) return undefined;
    let gone = false;
    const room = Number((channel as { conversation_id?: unknown } | null)?.conversation_id) || null;
    const take = () => {
      const target = takeDiscussionTarget(slug, null, 'posts');
      if (!target || !(target.threadRootId || target.focusMessageId)) return;
      // A message of another room than the one this page reads (a demo
      // #general, an old conversation) is the chat's at once.
      if (target.conversationId && room && target.conversationId !== room) { missing.current?.(target); return; }
      void feed.place(target).then((found) => {
        if (gone) return;
        if (found) setFocus(found);
        else missing.current?.(target);
      });
    };
    take();
    const heard = (event: Event) => {
      if ((event as CustomEvent<{ slug?: string }>).detail?.slug === slug) take();
    };
    window.addEventListener('usernode:workshop-discussion', heard);
    return () => { gone = true; window.removeEventListener('usernode:workshop-discussion', heard); };
  }, [mode, feed, known, slug, channel]);

  if (!channel || !feed) return null;
  const card = (
    <section
      ref={host}
      className="dev-ws-hub-section dev-ws-hub-discussion"
      data-ws-hub-discussion={mode}
      aria-labelledby={headId}
    >
      <FeedView
        feed={feed}
        slug={slug}
        name={name}
        channel={channel}
        mode={mode}
        headId={headId}
        host={host}
        viewer={viewer}
        focus={focus}
        onFocused={focused}
        onOpenPage={onOpenPage}
        onChat={onChat}
      />
    </section>
  );
  if (mode !== 'page') return card;
  return <div className="dev-ws-discussion-page" data-ws-discussion-page="">{card}</div>;
}

function FeedView({ feed, slug, name, channel, mode, headId, host, viewer, focus, onFocused, onOpenPage, onChat }: {
  feed: DiscussionFeed;
  slug: string;
  name: string;
  channel: Channel;
  mode: DiscussionCardProps['mode'];
  headId: string;
  host: RefObject<HTMLElement | null>;
  viewer: Viewer | null;
  /** The message a door named, to bring into view and mark once. */
  focus: Placed | null;
  onFocused: () => void;
  onOpenPage?: () => void;
  onChat?: () => void;
}): ReactNode {
  const t = useMessages('project');
  const state = useStoreState(feed);
  const [sort, setSort] = useState<DiscussionSort>('newest');
  const [limit, setLimit] = useState(POSTS_SHOWN);
  const items = useMemo(() => sortItems(feed.items(), mode === 'preview' ? 'newest' : sort), [feed, state, sort, mode]); // eslint-disable-line react-hooks/exhaustive-deps
  const startRef = useRef<HTMLTextAreaElement | null>(null);

  // Seen once it is on screen: the viewer's reading moves to its newest post.
  useEffect(() => {
    if (state.status !== 'ready' || mode === 'preview') return undefined;
    const node = host.current;
    if (!node || typeof IntersectionObserver !== 'function') { feed.markSeen(); return undefined; }
    const watch = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) feed.markSeen();
    });
    watch.observe(node);
    return () => watch.disconnect();
  }, [feed, state, mode, host]);

  // The phone's card asked for the box: it is ready to write in.
  useEffect(() => {
    if (mode !== 'page' || !focusOnOpen) return;
    focusOnOpen = false;
    startRef.current?.focus({ preventScroll: false });
  }, [mode]);

  // A door's message: its post drawn (the list grows to it), then brought
  // into view and marked for a moment.
  const [marked, setMarked] = useState<number | null>(null);
  useEffect(() => {
    if (!focus) return;
    const at = items.findIndex((item) => item.key === focus.key);
    if (at >= limit) { setLimit(at + 1); return; }
    const node = host.current?.querySelector(`[data-ws-discussion-message="${focus.messageId}"]`);
    if (!node) return;
    node.scrollIntoView?.({ block: 'center' });
    setMarked(focus.messageId);
    onFocused();
  }, [focus, items, limit, host, onFocused]);
  useEffect(() => {
    if (marked == null) return undefined;
    const clear = setTimeout(() => setMarked(null), FOCUS_MS);
    return () => clearTimeout(clear);
  }, [marked]);

  // The page's heading is the place's name; its far end shows the same room as a chat.
  const head = (
    <div className="dev-ws-hub-discussion-head">
      <h2 id={headId} className="dev-ws-hub-discussion-title">{t('project:hub.discussion.title')}</h2>
      <p className="dev-ws-hub-discussion-about">{t('project:hub.discussion.about', { project: name })}</p>
      {mode === 'page' && onChat ? (
        <button type="button" className="dh-as-chat" data-ws-discussion-as-chat="" onClick={onChat}>
          <HashIcon aria-hidden="true" />
          {t('project:hub.discussion.asChat')}
        </button>
      ) : null}
    </div>
  );

  if (mode === 'preview') {
    const open = (focus: boolean) => { focusOnOpen = focus; onOpenPage?.(); };
    const shown = items.slice(0, PREVIEW_POSTS);
    return (
      <>
        <button type="button" className="dh-preview-head" data-ws-discussion-open="" onClick={() => open(false)}>
          {head}
          <ChevronRightIcon className="dh-preview-go" aria-hidden="true" />
        </button>
        {state.status === 'ready' ? (
          shown.length ? (
            <ul className="dh-preview-list">
              {shown.map((item) => (
                <li key={item.key}>
                  <button type="button" className="dh-preview-row" data-ws-discussion-preview={item.key} onClick={() => open(false)}>
                    <PostHeader item={item} readId={state.readId} me={viewer?.username || null} />
                    <PostWords item={item} clamp />
                  </button>
                </li>
              ))}
            </ul>
          ) : <p className="dh-empty" data-ws-discussion-empty="">{t('project:hub.discussion.empty')}</p>
        ) : <FeedLoading status={state.status} onRetry={() => void feed.load()} rows={2} />}
        <button type="button" className="dh-composer dh-composer-door" data-ws-discussion-start-door="" onClick={() => open(true)}>
          <ViewerFace viewer={viewer} />
          <span className="dh-composer-hint">{t('project:hub.discussion.start.placeholder')}</span>
          <span className="dh-send" aria-hidden="true"><ArrowUpIcon /></span>
        </button>
      </>
    );
  }

  const shown = items.slice(0, limit);
  const canMore = items.length > limit || feed.morePosts();
  return (
    <>
      {head}
      <Composer
        kind="post"
        boxRef={startRef}
        viewer={viewer}
        placeholder={t('project:hub.discussion.start.placeholder')}
        label={t('project:hub.discussion.start.label', { project: name })}
        sendLabel={t('project:hub.discussion.start.send')}
        onSend={(words) => feed.write(words, null)}
      />
      <div className="dh-sort" role="group" aria-label={t('project:hub.discussion.sort.label')} data-ws-discussion-sort={sort}>
        <span className="dh-sort-label" aria-hidden="true">{t('project:hub.discussion.sort.label')}</span>
        <button type="button" aria-pressed={sort === 'newest'} data-ws-discussion-sort-by="newest" onClick={() => setSort('newest')}>
          {t('project:hub.discussion.sort.newest')}
        </button>
        <button type="button" aria-pressed={sort === 'replies'} data-ws-discussion-sort-by="replies" onClick={() => setSort('replies')}>
          {t('project:hub.discussion.sort.replies')}
        </button>
      </div>
      {state.status !== 'ready' ? (
        <FeedLoading status={state.status} onRetry={() => void feed.load()} rows={3} />
      ) : shown.length ? (
        <div className="dh-list" data-ws-discussion-posts={String(shown.length)}>
          {shown.map((item) => (
            <Thread key={item.key} item={item} feed={feed} slug={slug} channel={channel} viewer={viewer} readId={state.readId} busy={state.busy} opened={state.opened} marked={marked} />
          ))}
        </div>
      ) : (
        <p className="dh-empty" data-ws-discussion-empty="">{t('project:hub.discussion.empty')}</p>
      )}
      {state.status === 'ready' && canMore ? (
        <button
          type="button"
          className="dh-more-posts"
          data-ws-discussion-more=""
          disabled={state.busy}
          onClick={() => {
            setLimit((n) => n + POSTS_SHOWN);
            if (items.length <= limit + POSTS_SHOWN) void feed.morePostsRead();
          }}
        >
          {t('project:hub.discussion.morePosts')}
        </button>
      ) : null}
    </>
  );
}

function FeedLoading({ status, onRetry, rows }: { status: FeedState['status']; onRetry: () => void; rows: number }): ReactNode {
  const t = useMessages('project');
  if (status === 'error') {
    return (
      <p className="dh-failed" data-ws-discussion-failed="">
        <span>{t('project:hub.discussion.failed')}</span>
        <button type="button" className="dh-link" onClick={onRetry}>{t('project:hub.discussion.retry')}</button>
      </p>
    );
  }
  return (
    <div className="dh-list" aria-busy="true" data-ws-discussion-loading="">
      <span className="sr-only" role="status">{t('project:hub.discussion.loading')}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="dh-post dh-post-bone" aria-hidden="true">
          <span className="dh-bone dh-bone-head" />
          <span className="dh-bone dh-bone-line" />
        </div>
      ))}
    </div>
  );
}

function ViewerFace({ viewer }: { viewer: Viewer | null }): ReactNode {
  if (!viewer) return <span className="dh-face-blank" aria-hidden="true" />;
  return <UserAvatar user={{ id: 1, username: viewer.username, avatarUrl: viewer.avatarUrl }} size="sm" />;
}

// ── A post and its replies ─────────────────────────────────────────────

function Thread({ item, feed, slug, channel, viewer, readId, busy, opened, marked }: {
  item: DiscussionItem;
  feed: DiscussionFeed;
  slug: string;
  channel: Channel;
  viewer: Viewer | null;
  readId: number | null;
  busy: boolean;
  opened: ReadonlySet<number>;
  /** The message a door named, marked for a moment. */
  marked: number | null;
}): ReactNode {
  const t = useMessages('project');
  const [replying, setReplying] = useState(false);
  const replyBox = useRef<HTMLTextAreaElement | null>(null);
  const rootId = item.kind === 'post' ? item.root.id : item.fold.lastId;
  const open = opened.has(rootId);
  const { shown, hidden } = shownReplies(item, open);
  const hasBox = item.replyCount > 0 || replying;
  const startReply = () => {
    setReplying(true);
    // The box is drawn on the next render; focus it once it is there.
    setTimeout(() => replyBox.current?.focus({ preventScroll: false }), 0);
  };
  const more = () => {
    if (item.kind === 'earlier') {
      if (item.olderToRead || !open) void feed.openEarlier();
      return;
    }
    if (!open) { void feed.openThread(item.root.id); return; }
    openInGeneral(slug, channel, item.root.id);
  };
  const me = viewer?.username || null;
  return (
    <div className="dh-thread" data-ws-discussion-thread={item.key}>
      {item.kind === 'post' ? (
        <Message said={item.root} feed={feed} me={me} className="dh-post" marked={marked === item.root.id} onReply={startReply}>
          <PostHeader item={item} readId={readId} me={me} onReply={startReply} />
          <PostWords item={item} />
          <Pills said={item.root} feed={feed} me={me} />
        </Message>
      ) : (
        <article className="dh-post dh-post-earlier" data-ws-discussion-earlier="">
          <PostHeader item={item} readId={readId} me={me} onReply={startReply} />
          <PostWords item={item} />
        </article>
      )}
      {hasBox ? (
        <div className="dh-replies" data-ws-discussion-replies={String(item.replyCount)}>
          {hidden > 0 && (item.kind === 'post' || item.olderToRead || !open) ? (
            <button type="button" className="dh-earlier" data-ws-discussion-view-earlier={String(hidden)} disabled={busy} onClick={more}>
              {item.kind === 'post' && open
                ? t('project:hub.discussion.wholeThread')
                : t('project:hub.discussion.earlierReplies', { count: hidden })}
            </button>
          ) : null}
          {shown.map((reply) => (
            <Message key={reply.id} said={reply} feed={feed} me={me} className="dh-reply" marked={marked === reply.id} onReply={startReply}>
              <ReplyRow said={reply}>
                <Pills said={reply} feed={feed} me={me} small />
                {item.kind === 'earlier' && reply.rootId == null && oldThreadCount(item, reply) > 0 ? (
                  <button type="button" className="dh-old-thread" data-ws-discussion-old-thread={String(reply.id)} onClick={() => openInGeneral(slug, channel, reply.id)}>
                    <ThreadIcon aria-hidden="true" />
                    {t('project:hub.discussion.oldThread', { count: oldThreadCount(item, reply) })}
                  </button>
                ) : null}
              </ReplyRow>
            </Message>
          ))}
          <Composer
            kind="reply"
            boxRef={replyBox}
            viewer={viewer}
            placeholder={t('project:hub.discussion.reply.placeholder')}
            label={item.kind === 'post'
              ? t('project:hub.discussion.reply.label', { username: nameOf(item.root.who) })
              : t('project:hub.discussion.reply.labelEarlier')}
            sendLabel={t('project:hub.discussion.reply.send')}
            onSend={(words) => feed.write(words, rootId)}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * An old message's own reply thread, inside the Earlier post: how many
 * replies it has in #general. The last old message's thread also holds what
 * was written into the Earlier post since, which the post shows itself.
 */
function oldThreadCount(item: DiscussionItem, said: Said): number {
  if (item.kind !== 'earlier' || said.id !== item.fold.lastId) return said.replyCount;
  return Math.max(0, said.replyCount - item.replies.filter((r) => r.rootId === said.id).length);
}

/** A post's one header line: face, name, time, the new dot, and the replies at its far end. */
function PostHeader({ item, readId, me, onReply }: {
  item: DiscussionItem;
  readId: number | null;
  me: string | null;
  /** Absent in the phone's preview, where the whole row opens the page. */
  onReply?: () => void;
}): ReactNode {
  const t = useMessages('project');
  const fresh = isNewTo(item, readId, me);
  const count = item.replyCount;
  const tail = count > 0 ? (
    <span className="dh-count">
      <ThreadIcon aria-hidden="true" />
      {t('project:hub.discussion.replies', { count })}
    </span>
  ) : (
    <span className="dh-count dh-count-none">
      <ThreadIcon aria-hidden="true" />
      {t('project:hub.discussion.reply')}
    </span>
  );
  if (item.kind === 'earlier') {
    const { from, to } = item.fold;
    const range = from && to ? t('project:hub.discussion.earlier.range', { from: shortDate(from), to: shortDate(to) }) : '';
    return (
      <div className="dh-head">
        <span className="dh-earlier-mark" aria-hidden="true"><HashIcon /></span>
        <b className="dh-name">{t('project:hub.discussion.earlier.title')}</b>
        {range ? <span className="dh-time">{range}</span> : null}
        {fresh ? <NewDot /> : null}
        {onReply && count === 0 ? <button type="button" className="dh-tail" onClick={onReply}>{tail}</button> : <span className="dh-tail">{tail}</span>}
      </div>
    );
  }
  const stamp = messageStamp(item.root.at);
  return (
    <div className="dh-head">
      <UserAvatar user={asUser(item.root.who)} />
      <b className="dh-name">{nameOf(item.root.who)}</b>
      <span className="dh-time" title={stamp.title}>{stamp.text}</span>
      {fresh ? <NewDot /> : null}
      {onReply && count === 0 ? <button type="button" className="dh-tail" data-ws-discussion-reply="" onClick={onReply}>{tail}</button> : <span className="dh-tail">{tail}</span>}
    </div>
  );
}

function NewDot(): ReactNode {
  const t = useMessages('project');
  return (
    <span className="dh-new" data-ws-discussion-new="">
      <span className="sr-only">{t('project:hub.discussion.new')}</span>
    </span>
  );
}

function PostWords({ item, clamp = false }: { item: DiscussionItem; clamp?: boolean }): ReactNode {
  const t = useMessages('project');
  if (item.kind === 'earlier') return <p className={clamp ? 'dh-words dh-clamp' : 'dh-words'}>{t('project:hub.discussion.earlier.body')}</p>;
  return <Words said={item.root} clamp={clamp} className="dh-words" />;
}

function Words({ said, clamp = false, className }: { said: Said; clamp?: boolean; className: string }): ReactNode {
  const t = useMessages('project');
  if (said.deleted) return <p className={`${className} dh-deleted`}>{t('project:hub.discussion.deleted')}</p>;
  if (!said.content.trim()) return <p className={`${className} dh-quiet`}>{t('project:hub.discussion.files', { count: Math.max(1, said.files) })}</p>;
  if (clamp) return <p className={`${className} dh-clamp`}>{said.content.replace(/\s+/g, ' ').trim()}</p>;
  return <div className={className}><MessageMarkdown content={said.content} /></div>;
}

/** A reply, drawn as a chat row is: a small face, the name and time, the words. */
function ReplyRow({ said, children }: { said: Said; children?: ReactNode }): ReactNode {
  const stamp = messageStamp(said.at);
  return (
    <>
      <UserAvatar user={asUser(said.who)} size="sm" />
      <div className="dh-reply-body">
        <div className="dh-reply-who">
          <b>{nameOf(said.who)}</b>
          <span title={stamp.title}>{stamp.text}</span>
        </div>
        <Words said={said} className="dh-reply-words" />
        {children}
      </div>
    </>
  );
}

function Pills({ said, feed, me, small = false }: { said: Said; feed: DiscussionFeed; me: string | null; small?: boolean }): ReactNode {
  const t = useMessages('messages');
  if (!said.reactions.length) return null;
  return (
    <div className={small ? 'dh-pills dh-pills-small' : 'dh-pills'}>
      {said.reactions.map((r) => (
        <ReactionPill
          key={r.emoji}
          emoji={r.emoji}
          count={r.count}
          tone={r.reacted ? 'accent' : 'neutral'}
          className="dh-pill"
          title={r.users.join(', ')}
          aria-pressed={r.reacted}
          aria-label={r.reacted
            ? t('messages:actions.removeReaction', { emoji: emojiName(r.emoji) })
            : t('messages:actions.reactWith', { emoji: emojiName(r.emoji) })}
          disabled={!me}
          data-emoji={r.emoji}
          onClick={() => void feed.react(said.id, r.emoji)}
        />
      ))}
    </div>
  );
}

/**
 * A message that can be reacted to and replied to: the hover bar on a
 * pointer, the long-press sheet on a touch screen. Nobody signed in, or a
 * deleted message: neither.
 */
function Message({ said, feed, me, className, marked = false, onReply, children }: {
  said: Said;
  feed: DiscussionFeed;
  me: string | null;
  className: string;
  marked?: boolean;
  onReply: () => void;
  children: ReactNode;
}): ReactNode {
  const tm = useMessages('messages');
  const recents = useRecentReactions();
  const [picking, setPicking] = useState(false);
  const [sheet, setSheet] = useState(false);
  const bar = useRef<HTMLDivElement | null>(null);
  const pickerButton = useRef<HTMLButtonElement | null>(null);
  const can = !!me && !said.deleted;
  useDismiss(picking, [bar], () => setPicking(false));
  const press = useLongPress(() => setSheet(true), { disabled: !can });
  const reacted = (emoji: string) => said.reactions.some((r) => r.emoji === emoji && r.reacted);
  const react = (emoji: string) => { rememberReaction(emoji); void feed.react(said.id, emoji); };
  const Tag = className === 'dh-post' ? 'article' : 'div';
  return (
    <Tag
      className={`${className} dh-msg`}
      data-ws-discussion-message={String(said.id)}
      data-ws-discussion-marked={marked ? '' : undefined}
      {...(can ? press : {})}
    >
      {children}
      {can ? (
        <MessageActionBar
          className="dh-actions"
          barRef={bar}
          recents={recents}
          reacted={reacted}
          onReact={react}
          pickerOpen={picking}
          onTogglePicker={() => setPicking((v) => !v)}
          pickerButtonRef={pickerButton}
          onReply={onReply}
        >
          {picking ? (
            <EmojiPicker
              placement="below"
              autoFocus={!isTouchInput()}
              onPick={(emoji) => { setPicking(false); react(emoji); }}
              onClose={() => setPicking(false)}
            />
          ) : null}
        </MessageActionBar>
      ) : null}
      {can ? (
        <MessageActionSheet
          open={sheet}
          onClose={() => setSheet(false)}
          recents={recents}
          reacted={reacted}
          onReact={(emoji) => { setSheet(false); react(emoji); }}
          onPick={react}
          items={[{ key: 'reply', label: tm('messages:actions.reply'), icon: ReplyArrowIcon, onSelect: () => { setSheet(false); onReply(); } }]}
          preview={{ who: nameOf(said.who), text: said.content.replace(/\s+/g, ' ').trim().slice(0, 120) }}
        />
      ) : null}
    </Tag>
  );
}

// ── The boxes ──────────────────────────────────────────────────────────

/**
 * The platform's message box, as the hub draws it: "Start a post…" with the
 * viewer's face, or a thread's "Reply in thread…". Enter sends on a device
 * with a keyboard and Shift + Enter is a new line; on a touch screen the
 * button sends (../../../lib/enter-sends.ts). What it says is the server's
 * to refuse: somebody who has not joined is asked to join and the send goes
 * through (../../../lib/join-required.ts), and any other refusal is said under
 * the box with what was typed kept.
 */
function Composer({ kind, boxRef, viewer, placeholder, label, sendLabel, onSend }: {
  kind: 'post' | 'reply';
  boxRef: RefObject<HTMLTextAreaElement | null>;
  viewer: Viewer | null;
  placeholder: string;
  label: string;
  sendLabel: string;
  onSend: (words: string) => Promise<void>;
}): ReactNode {
  const t = useMessages('project');
  const [words, setWords] = useState('');
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const empty = !words.trim();
  const grow = () => {
    const box = boxRef.current;
    if (!box) return;
    box.style.height = 'auto';
    box.style.height = `${Math.min(box.scrollHeight, 240)}px`;
  };
  useEffect(grow, [words]); // eslint-disable-line react-hooks/exhaustive-deps
  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    if (empty || sending) return;
    setSending(true);
    setFailed(null);
    try {
      await onSend(words.trim());
      setWords('');
    } catch (error) {
      const said = error instanceof Error && error.message ? error.message : '';
      setFailed(said || t('project:hub.discussion.sendFailed'));
    } finally {
      setSending(false);
    }
  };
  const onKey = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (enterSends(event.nativeEvent)) {
      event.preventDefault();
      void send();
    }
  };
  return (
    <form className={kind === 'post' ? 'dh-composer dh-composer-post' : 'dh-composer dh-composer-reply'} data-ws-discussion-compose={kind} onSubmit={send}>
      {kind === 'post' ? <ViewerFace viewer={viewer} /> : null}
      <textarea
        ref={boxRef}
        className="dh-box"
        rows={1}
        dir="auto"
        maxLength={8000}
        value={words}
        placeholder={placeholder}
        aria-label={label}
        disabled={sending}
        onChange={(event) => setWords(event.currentTarget.value)}
        onKeyDown={onKey}
      />
      <button type="submit" className="dh-send" disabled={empty || sending} aria-label={sendLabel} title={sendLabel}>
        <ArrowUpIcon aria-hidden="true" />
      </button>
      {failed ? <p className="dh-send-failed" role="alert" data-ws-discussion-send-failed="">{failed}</p> : null}
    </form>
  );
}
