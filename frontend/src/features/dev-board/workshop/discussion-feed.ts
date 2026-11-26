/**
 * THE DISCUSSION'S DATA: a project's #general read as posts with replies
 * (the hub's Discussion card, ./hub-discussion.tsx; owner, 26 Nov 2026).
 *
 * A POST is a message in the channel's main stream; its REPLIES are the reply
 * thread under it (#2387). Nothing is stored differently for Discussion: a
 * post is written by the channel's own write route, a reply is a thread reply
 * written by the same route, and both are read by the reads the channel's
 * chat already makes. Two rooms answer to "#general":
 *
 *   - an ordinary project's channel, the app's chat
 *     (GET /api/apps/:slug/messages, its reply threads by
 *     ?thread_type=message&thread_ref=<root>, and a reaction by
 *     POST /api/apps/:slug/messages/:id/reactions);
 *   - Homeroom's own #general, a Messages conversation
 *     (../../messages/api.ts listMessages, listThread, sendMessage,
 *     toggleReaction, markRead).
 *
 * Both are read into one shape (`Said`), so the card draws one thing.
 *
 * ── What was said before Discussion ───────────────────────────────────
 *
 * The server says when Discussion arrived (`since`) and, for this channel,
 * how many messages people wrote before it (`earlier`: src/services/
 * discussion.js). With no more than `fold_at` of them, each is a post like
 * any other. With more, they are ONE post, "Earlier in #general", whose
 * replies are those messages, oldest first. A reply written into it is a
 * thread reply under the last of them (`earlier.last_id`), so the model
 * holds it as it holds every reply; the old messages' own reply threads stay
 * where they are, and each such message says how many replies it has, opening
 * them in #general (./hub-discussion.tsx).
 *
 * ── The app's stream already holds every reply of its posts ───────────
 *
 * The app chat's main stream carries each reply of its reply threads as a
 * line where it landed (routes/chat.js selectStream). A post read in the
 * newest page has all its replies in that page or a newer one, because a
 * reply is always newer than the message it answers. So, for that room, the
 * replies of the posts on screen are read with the posts, and a thread is
 * asked for only to bring in an older post that has a new reply. Homeroom's
 * #general carries its replies only in their threads, so each shown post with
 * replies reads its thread.
 *
 * Pure functions first, for the tests; the reads after them.
 */

import * as messagesApi from '../../messages/api';
import type { ConversationMessage } from '../../messages/types';

/** How many replies a post shows under it before "View N earlier replies". */
export const REPLIES_SHOWN = 3;
/** How many posts the card shows before "Show more posts". */
export const POSTS_SHOWN = 8;
/** How many posts a phone's Discussion card previews. */
export const PREVIEW_POSTS = 3;
/** The rule's own number, when the server's answer does not carry one. */
export const EARLIER_FOLD_AT = 8;

export interface DiscussionPerson {
  id: number | null;
  username: string;
  avatarUrl?: string | null;
  /** The Homeroom bot, named by its name (../../messages/format.tsx senderName). */
  bot?: boolean;
  displayName?: string;
}

export interface DiscussionReaction {
  emoji: string;
  count: number;
  /** The viewer is one of its people. */
  reacted: boolean;
  users: string[];
}

/** One message, from either room. */
export interface Said {
  id: number;
  who: DiscussionPerson;
  content: string;
  at: string;
  deleted: boolean;
  reactions: DiscussionReaction[];
  /** How many files ride on it, for a message with no words. */
  files: number;
  /** A reply: the message its thread hangs off. Null for a main-stream message. */
  rootId: number | null;
  /** A main-stream message: how many replies its thread holds, and when the last came. */
  replyCount: number;
  lastReplyAt: string | null;
}

/** What the community read says about the channel's history (services/discussion.js). */
export interface DiscussionSummary {
  since: string | null;
  fold_at?: number;
  earlier: { count: number; from: string | null; to: string | null; last_id: number | null } | null;
}

/** The fold, when it applies: the history from before Discussion is one post. */
export interface EarlierFold {
  count: number;
  from: string | null;
  to: string | null;
  lastId: number;
  since: string;
}

export interface DiscussionPost {
  kind: 'post';
  key: string;
  root: Said;
  /** The replies read so far, oldest first. */
  replies: Said[];
  replyCount: number;
  /** The newest moment anything happened in it: its own time or its last reply's. */
  activityAt: string;
}

export interface DiscussionEarlier {
  kind: 'earlier';
  key: 'earlier';
  fold: EarlierFold;
  /** Its replies read so far, oldest first: the old messages, then what was written into it since. */
  replies: Said[];
  replyCount: number;
  activityAt: string;
  /** Messages from before Discussion not read yet: what "View N earlier replies" pages back into. */
  olderToRead: boolean;
}

export type DiscussionItem = DiscussionPost | DiscussionEarlier;

export type DiscussionSort = 'newest' | 'replies';

const time = (value: string | null | undefined): number => {
  const n = value ? Date.parse(value) : NaN;
  return Number.isFinite(n) ? n : 0;
};

/**
 * Pure: whether the history from before Discussion folds into one post, and
 * that post's facts; null when each message is a post of its own. The rule
 * is the owner's: more than `fold_at` messages (eight) fold.
 */
export function earlierFold(summary: DiscussionSummary | null | undefined): EarlierFold | null {
  if (!summary || !summary.since || !summary.earlier) return null;
  const at = Number.isFinite(Number(summary.fold_at)) && Number(summary.fold_at) > 0 ? Number(summary.fold_at) : EARLIER_FOLD_AT;
  const { count, from, to, last_id: lastId } = summary.earlier;
  if (!(Number(count) > at) || !lastId) return null;
  return { count: Number(count), from: from || null, to: to || null, lastId: Number(lastId), since: summary.since };
}

/** Pure: whether a message belongs to the folded history (or answers it). */
export function inEarlier(said: Pick<Said, 'id' | 'rootId'>, fold: EarlierFold | null): boolean {
  if (!fold) return false;
  return said.rootId != null ? said.rootId <= fold.lastId : said.id <= fold.lastId;
}

/** Pure: the newest moment a post saw anything. */
export function activityOf(root: Pick<Said, 'at' | 'lastReplyAt'>, replies: ReadonlyArray<Pick<Said, 'at'>>): string {
  let best = root.at;
  for (const at of [root.lastReplyAt, ...replies.map((r) => r.at)]) {
    if (at && time(at) > time(best)) best = at;
  }
  return best;
}

/**
 * Pure: the posts a set of read messages makes. `messages` is every message
 * read from the main stream and the threads, in any order and with repeats
 * (a later read of one wins); main-stream messages become posts, replies go
 * under theirs, and, when the history folds, what is from before Discussion
 * (and what answers it) becomes the one Earlier post. A reply whose post was
 * not read is left out: it shows once its post is read.
 */
export function assemble(
  messages: ReadonlyArray<Said>,
  fold: EarlierFold | null,
  olderToRead = false,
): DiscussionItem[] {
  const byId = new Map<number, Said>();
  for (const m of messages) byId.set(m.id, m);
  const roots = new Map<number, Said>();
  const repliesOf = new Map<number, Said[]>();
  const earlierItems: Said[] = [];
  for (const m of byId.values()) {
    if (fold && inEarlier(m, fold)) {
      // A main-stream message from before, or a reply written into the
      // Earlier post since (one under its last message). An old message's own
      // older replies stay in its thread.
      if (m.rootId == null || (m.rootId === fold.lastId && time(m.at) >= time(fold.since))) earlierItems.push(m);
      continue;
    }
    if (m.rootId == null) roots.set(m.id, m);
    else {
      const list = repliesOf.get(m.rootId) || [];
      list.push(m);
      repliesOf.set(m.rootId, list);
    }
  }
  const items: DiscussionItem[] = [];
  for (const root of roots.values()) {
    const replies = (repliesOf.get(root.id) || []).filter((r) => !r.deleted).sort((a, b) => a.id - b.id);
    items.push({
      kind: 'post',
      key: `post:${root.id}`,
      root,
      replies,
      replyCount: Math.max(root.replyCount, replies.length),
      activityAt: activityOf(root, replies),
    });
  }
  if (fold) {
    const replies = earlierItems.filter((m) => !m.deleted).sort((a, b) => a.id - b.id);
    // The old messages, which the server counted, and what was written into
    // the post since, which is read with it.
    const since = replies.filter((r) => r.rootId != null).length;
    const newest = replies.length ? replies[replies.length - 1].at : null;
    items.push({
      kind: 'earlier',
      key: 'earlier',
      fold,
      replies,
      replyCount: fold.count + since,
      activityAt: newest && time(newest) > time(fold.to) ? newest : (fold.to || fold.since),
      olderToRead,
    });
  }
  return items;
}

/**
 * Pure: the posts in the order asked. Newest is the most recent activity
 * first (a post with a fresh reply comes up); Most replies is the busiest
 * first, then the most recent.
 */
export function sortItems(items: ReadonlyArray<DiscussionItem>, sort: DiscussionSort): DiscussionItem[] {
  const list = [...items];
  list.sort((a, b) => {
    if (sort === 'replies' && b.replyCount !== a.replyCount) return b.replyCount - a.replyCount;
    const d = time(b.activityAt) - time(a.activityAt);
    if (d) return d;
    // The Earlier post is never newer than a post made since.
    if (a.kind !== b.kind) return a.kind === 'earlier' ? 1 : -1;
    return (b.kind === 'post' ? b.root.id : 0) - (a.kind === 'post' ? a.root.id : 0);
  });
  return list;
}

/**
 * Pure: whether a post is new to the viewer: written by somebody else past
 * where the viewer's reading stood. The reading position is the channel's own
 * (its main stream: routes/chat.js, the read cursor), so it is the post that
 * is new, as the channel's unread count counts it; a new reply brings its
 * post up under Newest instead. Nothing is new without a reading position (a
 * first visit, or a room that gave none), and the Earlier post never is.
 */
export function isNewTo(item: DiscussionItem, readId: number | null, me: string | null): boolean {
  if (!readId || item.kind !== 'post') return false;
  const s = item.root;
  return s.id > readId && !s.deleted && !(me && s.who.username === me);
}

/** Pure: the replies a post shows, the newest few, and how many are not shown. */
export function shownReplies(item: DiscussionItem, open: boolean): { shown: Said[]; hidden: number } {
  const shown = open ? item.replies : item.replies.slice(-REPLIES_SHOWN);
  return { shown, hidden: Math.max(0, item.replyCount - shown.length) };
}

/** Pure: a reaction toggled on a message's list, as the viewer will see it before the answer lands. */
export function toggledReactions(list: ReadonlyArray<DiscussionReaction>, emoji: string, me: string | null): DiscussionReaction[] {
  const out = list.map((r) => ({ ...r, users: [...r.users] }));
  const at = out.findIndex((r) => r.emoji === emoji);
  if (at < 0) return [...out, { emoji, count: 1, reacted: true, users: me ? [me] : [] }];
  const r = out[at];
  if (r.reacted) {
    r.reacted = false;
    r.count = Math.max(0, r.count - 1);
    r.users = me ? r.users.filter((u) => u !== me) : r.users;
  } else {
    r.reacted = true;
    r.count += 1;
    if (me) r.users.push(me);
  }
  return out.filter((x) => x.count > 0);
}

// ── Reading the two rooms into one shape ───────────────────────────────

type Json = Record<string, unknown>;

const num = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

function appReactions(list: unknown, me: string | null): DiscussionReaction[] {
  return (Array.isArray(list) ? list : []).map((raw) => {
    const r = (raw || {}) as Json;
    const users = Array.isArray(r.users) ? r.users.map(String) : [];
    return {
      emoji: str(r.emoji),
      count: Number(r.count) || users.length,
      reacted: typeof r.reacted === 'boolean' ? r.reacted : !!me && users.includes(me),
      users,
    };
  }).filter((r) => r.emoji && r.count > 0);
}

/** The app chat's message kinds a post can be: what a person wrote, and a plan shared. */
const APP_POST_KINDS = new Set(['message', 'spec_share']);

/** Pure: one app chat row (routes/chat.js) as `Said`, or null for a row that is no post or reply. */
export function fromAppRow(row: unknown, me: string | null): Said | null {
  const m = (row || {}) as Json;
  const id = num(m.id);
  if (!id) return null;
  const threadType = m.thread_type == null ? null : str(m.thread_type);
  if (threadType && threadType !== 'message') return null;
  if (!APP_POST_KINDS.has(str(m.msg_type) || 'message')) return null;
  if (m.moderation_hidden_at) return null;
  const thread = (m.thread || null) as Json | null;
  return {
    id,
    who: { id: num(m.user_id), username: str(m.username) || 'someone' },
    content: str(m.content),
    at: str(m.created_at),
    deleted: !!m.deleted,
    reactions: appReactions(m.reactions, me),
    files: Array.isArray((m.metadata as Json | null)?.attachments) ? ((m.metadata as Json).attachments as unknown[]).length : 0,
    rootId: threadType === 'message' ? num(m.thread_ref) : null,
    replyCount: thread ? Number(thread.reply_count) || 0 : 0,
    lastReplyAt: thread ? str(thread.last_reply_at) || null : null,
  };
}

/** Pure: one Messages message (../../messages/api.ts) as `Said`, or null for a platform line. */
export function fromConversationMessage(m: ConversationMessage): Said | null {
  if (!m || !m.id || m.system || m.moderated) return null;
  return {
    id: m.id,
    who: {
      id: m.sender?.id || null,
      username: m.sender?.username || 'someone',
      avatarUrl: m.sender?.avatarUrl || null,
      bot: !!m.sender?.bot,
      displayName: m.sender?.displayName,
    },
    content: m.content || '',
    at: m.createdAt,
    deleted: !!m.deleted,
    reactions: (m.reactions || []).map((r) => ({ emoji: r.emoji, count: r.count, reacted: !!r.reacted, users: r.users || [] })),
    files: (m.attachments || []).length,
    rootId: m.threadRootId || null,
    replyCount: m.thread ? m.thread.replyCount || 0 : 0,
    lastReplyAt: m.thread ? m.thread.lastReplyAt || null : null,
  };
}

/** One room, as the card reads and writes it. */
export interface DiscussionSource {
  key: string;
  /** Whether the main stream carries each reply as a line (the app chat's does). */
  streamHoldsReplies: boolean;
  /** A page of the main stream, oldest first, before `before` (the newest page without it). */
  page(before: number | null): Promise<{ messages: Said[]; more: boolean; readId: number | null }>;
  /** A thread: its first message and its newest replies, oldest first. */
  thread(rootId: number): Promise<{ root: Said | null; replies: Said[] }>;
  /** Write a post (`rootId` null) or a reply. */
  post(content: string, rootId: number | null): Promise<Said | null>;
  react(messageId: number, emoji: string, on: boolean): Promise<DiscussionReaction[] | null>;
  /** Where the viewer's reading stands, when the page did not say. */
  readPosition(): Promise<number | null>;
  markRead(messageId: number): Promise<void>;
  /**
   * "Most replies" across the whole room: the posts after `afterId` (the
   * Earlier post's last message, or 0), busiest first, `limit` from
   * `offset`. The server sorts (routes/apps.js `discussion/most-replied`).
   */
  ranked(afterId: number, offset: number, limit: number): Promise<{ ids: number[]; more: boolean }>;
  /** What the room says as it says it, handed to `heard` until the returned stop is called. */
  live(heard: (event: LiveEvent) => void): () => void;
}

/**
 * What the room said live: a project's chat socket (`/ws/chat/:slug`, the
 * frames src/services/ws.js broadcasts) or, for Homeroom's #general, the
 * page's events socket, which names only what changed (`stale`: read it
 * again).
 */
export type LiveEvent =
  | { kind: 'said'; said: Said }
  | { kind: 'thread'; rootId: number; replyCount: number; lastReplyAt: string | null }
  | { kind: 'edit'; id: number; content: string }
  | { kind: 'reactions'; id: number; reactions: DiscussionReaction[] }
  | { kind: 'gone'; id: number }
  | { kind: 'stale'; messageId: number | null; rootId: number | null };

/** Pure: one frame of a project's chat socket as a LiveEvent, or null for one the Discussion does not draw. */
export function liveFromAppFrame(frame: unknown, me: string | null): LiveEvent | null {
  const f = (frame || {}) as Json;
  switch (str(f.type)) {
    case 'chat': {
      const thread = (f.thread || null) as Json | null;
      const said = fromAppRow({
        id: f.id,
        user_id: f.userId,
        username: f.username,
        content: f.content,
        msg_type: f.msgType || 'message',
        metadata: f.metadata,
        thread_type: thread ? thread.type : null,
        thread_ref: thread ? thread.ref : null,
        created_at: f.createdAt,
        reactions: [],
        deleted: false,
      }, me);
      return said ? { kind: 'said', said } : null;
    }
    case 'thread_summary': {
      const rootId = num(f.root_id);
      const t = (f.thread || {}) as Json;
      return rootId ? { kind: 'thread', rootId, replyCount: Number(t.reply_count) || 0, lastReplyAt: str(t.last_reply_at) || null } : null;
    }
    case 'chat_edit': {
      const id = num(f.messageId);
      return id ? { kind: 'edit', id, content: str(f.content) } : null;
    }
    case 'reaction': {
      const id = num(f.messageId);
      return id ? { kind: 'reactions', id, reactions: appReactions(f.reactions, me) } : null;
    }
    case 'chat_delete': {
      const id = num(f.id);
      return id ? { kind: 'gone', id } : null;
    }
    case 'resync_hint':
      return { kind: 'stale', messageId: null, rootId: null };
    default:
      return null;
  }
}

/** Pure: one Messages event as a LiveEvent for `conversationId`'s room, or null for another room's. */
export function liveFromConversationEvent(event: unknown, conversationId: number): LiveEvent | null {
  const e = (event || {}) as Json;
  if (num(e.conversationId) !== conversationId) return null;
  return { kind: 'stale', messageId: num(e.messageId), rootId: num(e.threadRootId) };
}

/** Wait before a dropped socket is opened again, doubling to the cap. */
export const LIVE_RETRY_MS = 1000;
export const LIVE_RETRY_MAX_MS = 30_000;

/** The "Most replies" read both rooms share: the project's own address answers for either. */
async function rankedRead(slug: string, afterId: number, offset: number, limit: number): Promise<{ ids: number[]; more: boolean }> {
  const params = new URLSearchParams({ after: String(afterId || 0), offset: String(offset), limit: String(limit) });
  const response = await fetch(`/api/apps/${encodeURIComponent(slug)}/discussion/most-replied?${params}`, {
    credentials: 'same-origin', headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`discussion ranking ${response.status}`);
  const data = await readJson(response);
  const posts = Array.isArray(data.posts) ? data.posts as Json[] : [];
  return { ids: posts.map((p) => num(p.id)).filter((id): id is number => !!id), more: !!data.more };
}

/** The project's chat socket, held while the Discussion is on screen; it opens again after a drop, and says so (`stale`). */
function appSocket(slug: string, viewer: { current: string | null }, heard: (event: LiveEvent) => void): () => void {
  if (typeof WebSocket !== 'function' || typeof location === 'undefined') return () => {};
  let socket: WebSocket | null = null;
  let stopped = false;
  let wait = LIVE_RETRY_MS;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let dropped = false;
  const open = () => {
    if (stopped) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // A staging preview signs its sockets in with the page's token, as the chat's own does (public/js/group-chat.js).
    const token = new URLSearchParams(location.search).get('token');
    const qs = token ? `?token=${encodeURIComponent(token)}` : '';
    const ws = new WebSocket(`${proto}//${location.host}/ws/chat/${encodeURIComponent(slug)}${qs}`);
    socket = ws;
    ws.onopen = () => {
      wait = LIVE_RETRY_MS;
      // What was said while it was away is read again.
      if (dropped) heard({ kind: 'stale', messageId: null, rootId: null });
      dropped = false;
    };
    ws.onmessage = (message) => {
      let frame: unknown = null;
      try { frame = JSON.parse(String(message.data)); } catch { return; }
      const event = liveFromAppFrame(frame, viewer.current);
      if (event) heard(event);
    };
    ws.onclose = (closed) => {
      if (socket !== ws || stopped) return;
      socket = null;
      dropped = true;
      // 4004: this viewer may not read the room; asking again will not change that.
      if (closed.code === 4004) return;
      retry = setTimeout(open, wait);
      wait = Math.min(LIVE_RETRY_MAX_MS, wait * 2);
    };
  };
  open();
  return () => {
    stopped = true;
    if (retry) clearTimeout(retry);
    const ws = socket;
    socket = null;
    try { ws?.close(1000, 'done'); } catch { /* already gone */ }
  };
}

function demoParam(): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('demo') === '1' ? 'demo=1' : '';
}

function withDemo(path: string): string {
  const demo = demoParam();
  return demo ? `${path}${path.includes('?') ? '&' : '?'}${demo}` : path;
}

async function readJson(response: Response): Promise<Json> {
  try {
    const data = await response.json();
    return data && typeof data === 'object' ? data as Json : {};
  } catch {
    return {};
  }
}

/** A write's refusal, in the server's own words when it gave some. */
export class DiscussionWriteError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'DiscussionWriteError';
    this.status = status;
  }
}

function clientKey(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch { /* fall through */ }
  return `dh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** An ordinary project's channel: the app's own chat. */
export function appSource(slug: string, viewer: { current: string | null }): DiscussionSource {
  const base = `/api/apps/${encodeURIComponent(slug)}/messages`;
  const json = { 'Content-Type': 'application/json', Accept: 'application/json' };
  return {
    key: `app:${slug}`,
    streamHoldsReplies: true,
    async page(before) {
      const params = new URLSearchParams({ limit: '60' });
      if (before) params.set('before', String(before));
      const response = await fetch(withDemo(`${base}?${params}`), { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`discussion read ${response.status}`);
      const data = await readJson(response);
      const rows = Array.isArray(data.messages) ? data.messages : [];
      const read = (data.read || null) as Json | null;
      return {
        messages: rows.map((row) => fromAppRow(row, viewer.current)).filter((m): m is Said => !!m),
        more: !!data.has_more_before,
        readId: read ? num(read.last_read_message_id) : null,
      };
    },
    async thread(rootId) {
      const params = new URLSearchParams({ thread_type: 'message', thread_ref: String(rootId), limit: '50' });
      const response = await fetch(withDemo(`${base}?${params}`), { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (!response.ok) return { root: null, replies: [] };
      const data = await readJson(response);
      const replies = (Array.isArray(data.messages) ? data.messages : [])
        .map((row) => fromAppRow({ ...(row as Json), thread_type: 'message', thread_ref: rootId }, viewer.current))
        .filter((m): m is Said => !!m);
      return { root: data.root ? fromAppRow(data.root, viewer.current) : null, replies };
    },
    async post(content, rootId) {
      const body: Json = { content, client_key: clientKey() };
      if (rootId) { body.thread_type = 'message'; body.thread_ref = rootId; }
      const response = await fetch(base, { method: 'POST', credentials: 'same-origin', headers: json, body: JSON.stringify(body) });
      const data = await readJson(response);
      if (!response.ok) throw new DiscussionWriteError(response.status, str(data.error));
      return data.message ? fromAppRow({ ...(data.message as Json), deleted: false }, viewer.current) : null;
    },
    async react(messageId, emoji, on) {
      const response = await fetch(`${base}/${messageId}/reactions`, {
        method: 'POST', credentials: 'same-origin', headers: json, body: JSON.stringify({ emoji, on }),
      });
      if (!response.ok) return null;
      const data = await readJson(response);
      return appReactions(data.reactions, viewer.current);
    },
    async readPosition() {
      return null;
    },
    async markRead(messageId) {
      await fetch(withDemo(`${base}/read`), {
        method: 'POST', credentials: 'same-origin', headers: json, body: JSON.stringify({ message_id: messageId }),
      });
    },
    ranked(afterId, offset, limit) {
      return rankedRead(slug, afterId, offset, limit);
    },
    live(heard) {
      return appSocket(slug, viewer, heard);
    },
  };
}

/** Homeroom's own #general: a Messages conversation, on the project `slug`. */
export function conversationSource(conversationId: number, slug: string): DiscussionSource {
  const shape = (list: ConversationMessage[]) => list.map(fromConversationMessage).filter((m): m is Said => !!m);
  return {
    key: `conversation:${conversationId}`,
    streamHoldsReplies: false,
    async page(before) {
      const page = await messagesApi.listMessages(conversationId, before);
      // The main stream may carry a reply or two shown in the chat as well
      // (ALSO_IN_CHAT); its thread is read on its own, so they are left out.
      return { messages: shape(page.messages).filter((m) => m.rootId == null), more: !!page.nextBefore, readId: null };
    },
    async thread(rootId) {
      const page = await messagesApi.listThread(conversationId, rootId);
      const root = page.root ? fromConversationMessage(page.root) : null;
      return { root, replies: shape(page.messages).map((m) => ({ ...m, rootId })) };
    },
    async post(content, rootId) {
      try {
        const sent = await messagesApi.sendMessage(conversationId, {
          content,
          ...(rootId ? { threadRootId: rootId } : {}),
          idempotencyKey: clientKey(),
        });
        const said = fromConversationMessage(sent);
        return said && rootId ? { ...said, rootId } : said;
      } catch (error) {
        const status = error instanceof messagesApi.MessagesApiError ? error.status : 0;
        throw new DiscussionWriteError(status, error instanceof Error ? error.message : '');
      }
    },
    async react(messageId, emoji, on) {
      try {
        const list = await messagesApi.toggleReaction(conversationId, messageId, emoji, on);
        return list.map((r) => ({ emoji: r.emoji, count: r.count, reacted: !!r.reacted, users: r.users || [] }));
      } catch {
        return null;
      }
    },
    async readPosition() {
      try {
        const detail = await messagesApi.getConversation(conversationId);
        return detail.lastReadMessageId || null;
      } catch {
        return null;
      }
    },
    async markRead(messageId) {
      await messagesApi.markRead(conversationId, messageId);
    },
    ranked(afterId, offset, limit) {
      return rankedRead(slug, afterId, offset, limit);
    },
    // The page's events socket names what changed in the room (public/js/app.js
    // relays it as `usernode:conversation-changed`); the feed reads it again.
    live(heard) {
      if (typeof window === 'undefined') return () => {};
      const changed = (event: Event) => {
        const live = liveFromConversationEvent((event as CustomEvent).detail, conversationId);
        if (live) heard(live);
      };
      window.addEventListener('usernode:conversation-changed', changed);
      return () => window.removeEventListener('usernode:conversation-changed', changed);
    },
  };
}
