import type {
  ConversationDetail,
  ConversationMember,
  ConversationMessage,
  ConversationSummary,
  ConversationUser,
  HomeroomBotActivity,
  HomeroomBotActivityOutcome,
  HomeroomBotJob,
  HomeroomBotAction,
  HomeroomBotMeta,
  HomeroomBotPastJob,
  HomeroomBotPhase,
  HomeroomBotPlan,
  HomeroomBotPlanQuestion,
  HomeroomBotWork,
  MessageAttachment,
  MessageReaction,
  MessageThreadSummary,
  SharedObjectCard,
  SharedObjectReference,
  ThreadRootRef,
  UserSearchResult,
} from './types';
import type { HomeroomLink } from './homeroom-links';
import { plainText } from './plain-text';

const MAX_ID = 2_147_483_647;

type JsonRecord = Record<string, unknown>;

export class MessagesApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'MessagesApiError';
    this.status = status;
  }
}

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function strictId(value: unknown): number | null {
  const raw = typeof value === 'string' ? value : String(value ?? '');
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id <= MAX_ID ? id : null;
}

function dateText(value: unknown): string {
  const candidate = text(value);
  return candidate || new Date(0).toISOString();
}

function pick(source: JsonRecord, ...keys: string[]): unknown {
  for (const key of keys) {
    if (source[key] !== undefined) return source[key];
  }
  return undefined;
}

export function normalizeUser(input: unknown): ConversationUser {
  const row = record(input);
  return {
    id: strictId(pick(row, 'id', 'userId', 'user_id')) || 0,
    username: text(pick(row, 'username', 'name'), 'unknown'),
    avatarUrl: text(pick(row, 'avatarUrl', 'avatar_url')) || null,
    // #3624: a platform account (the Homeroom bot). Named here, or dropped.
    ...(pick(row, 'bot') === true ? { bot: true } : {}),
    // B5: and the name it is shown by, for a platform account only.
    ...(pick(row, 'bot') === true && text(pick(row, 'displayName')) ? { displayName: text(pick(row, 'displayName')).slice(0, 80) } : {}),
  };
}

const BOT_QUESTION_STATES = new Set(['open', 'answered', 'closed']);
// B3: the kinds of button the client knows how to press (types.ts
// HomeroomBotAction). An unknown one is dropped, never drawn as a dead button.
// B7: a change's ready card adds three: its preview (Try it), the person's
// own Yes (Approve) and a reply quoting the card (Change something).
const BOT_ACTION_TYPES = new Set(['server', 'open', 'prompt', 'preview', 'vote', 'reply']);
const MAX_BOT_ACTIONS = 3;

/** B3: a bot message's buttons, as types.ts HomeroomBotAction: at most three, one primary. */
function normalizeBotActions(input: unknown): HomeroomBotAction[] {
  const out: HomeroomBotAction[] = [];
  let primary = false;
  for (const entry of array(input)) {
    if (out.length >= MAX_BOT_ACTIONS) break;
    const row = record(entry);
    const id = text(pick(row, 'id')).slice(0, 40);
    const label = text(pick(row, 'label')).slice(0, 60);
    const type = text(pick(row, 'type'));
    if (!id || !label || !BOT_ACTION_TYPES.has(type)) continue;
    const target = type === 'open' ? inAppHref(pick(row, 'target')) : null;
    if (type === 'open' && !target) continue;
    // B7: the change a preview or a vote is of, and the version a vote is for.
    const sessionId = type === 'preview' || type === 'vote' ? strictId(pick(row, 'sessionId')) : null;
    if ((type === 'preview' || type === 'vote') && !sessionId) continue;
    const epoch = type === 'vote' && Number.isInteger(pick(row, 'epoch')) ? Number(pick(row, 'epoch')) : null;
    const style = pick(row, 'style') === 'primary' && !primary ? 'primary' : 'secondary';
    if (style === 'primary') primary = true;
    out.push({
      id, label, style, type: type as HomeroomBotAction['type'],
      ...(target ? { target } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(epoch !== null ? { epoch } : {}),
    });
  }
  return out;
}

/** B6: a plan's choices, or two questions: each with two to four answers, the suggested one first. */
function normalizePlanQuestions(input: unknown): HomeroomBotPlanQuestion[] {
  const out: HomeroomBotPlanQuestion[] = [];
  for (const entry of array(input)) {
    if (out.length >= 2) break;
    const row = record(entry);
    const question = text(pick(row, 'question')).slice(0, 300);
    const answers = array(pick(row, 'answers')).filter((a): a is string => typeof a === 'string' && !!a.trim()).slice(0, 4);
    if (question && answers.length >= 2) out.push({ question, answers });
  }
  return out;
}

/** B6: a first version's plan, or null: at most five bullets. */
function normalizePlan(input: unknown): HomeroomBotPlan | null {
  const row = record(input);
  const bullets = array(pick(row, 'bullets')).filter((b): b is string => typeof b === 'string' && !!b.trim()).slice(0, 5);
  return bullets.length ? { bullets, questions: normalizePlanQuestions(pick(row, 'questions')) } : null;
}

/**
 * #3624: the Homeroom bot's structured part of a message (services/
 * conversations.js publicMetadata), field by field like everything else
 * here: its question, the answers to tap and their state. Null for any
 * message without one.
 */
export function normalizeBotMeta(input: unknown): { homeroomBot: HomeroomBotMeta } | null {
  const bot = record(pick(record(input), 'homeroomBot'));
  const kind = text(pick(bot, 'kind'));
  if (!kind) return null;
  const issueNumber = strictId(pick(bot, 'issueNumber'));
  const status = text(pick(bot, 'status'));
  const optional = (key: string) => text(pick(bot, key)) || undefined;
  const answers = array(pick(bot, 'answers')).filter((a): a is string => typeof a === 'string' && !!a.trim()).slice(0, 6);
  const actions = normalizeBotActions(pick(bot, 'actions'));
  const actionId = strictId(pick(bot, 'actionId'));
  const plan = normalizePlan(pick(bot, 'plan'));
  const questions = normalizePlanQuestions(pick(bot, 'questions'));
  const choices = array(pick(bot, 'choices')).filter((c): c is string => typeof c === 'string').slice(0, 2);
  const readyRow = pick(bot, 'ready');
  const ready = readyRow && typeof readyRow === 'object' ? {
    group: pick(record(readyRow), 'group') === true,
    last: pick(record(readyRow), 'last') === true,
    waitingOn: array(pick(record(readyRow), 'waitingOn')).filter((u): u is string => typeof u === 'string' && !!u).slice(0, 3),
    more: Math.max(Number(pick(record(readyRow), 'more')) || 0, 0),
  } : null;
  return {
    homeroomBot: {
      kind,
      appSlug: optional('appSlug'),
      appName: optional('appName'),
      ...(issueNumber ? { issueNumber } : {}),
      issueTitle: optional('issueTitle'),
      ...(pick(bot, 'firstVersion') === true ? { firstVersion: true } : {}),
      ...(pick(bot, 'mirrors') === true ? { mirrors: true } : {}),
      question: optional('question'),
      ...(answers.length ? { answers } : {}),
      ...(BOT_QUESTION_STATES.has(status) ? { status: status as HomeroomBotMeta['status'] } : {}),
      answer: optional('answer'),
      link: optional('link'),
      ...(actionId ? { actionId } : {}),
      ...(actions.length ? { actions } : {}),
      chosen: optional('chosen'),
      startedAt: optional('startedAt'),
      askedText: optional('askedText'),
      hello: optional('hello'),
      ...(pick(bot, 'live') === true ? { live: true } : {}),
      // B6: a plan, or two questions at once, and how its buttons went.
      ...(plan ? { plan } : {}),
      ...(questions.length > 1 ? { questions, lead: optional('lead') } : {}),
      ...(pick(bot, 'replaced') === true ? { replaced: true } : {}),
      ...(pick(bot, 'stopped') === true ? { stopped: true } : {}),
      ...(pick(bot, 'changing') === true ? { changing: true } : {}),
      ...(choices.length ? { choices } : {}),
      // B7: a change ready to try, drawn as its card.
      ...(ready ? { ready } : {}),
      ...(strictId(pick(bot, 'sessionId')) ? { sessionId: strictId(pick(bot, 'sessionId'))! } : {}),
      ...(Number.isInteger(pick(bot, 'epoch')) ? { epoch: Number(pick(bot, 'epoch')) } : {}),
      ...(pick(bot, 'updated') === true ? { updated: true } : {}),
    },
  };
}

export function normalizeMember(input: unknown): ConversationMember {
  const row = record(input);
  const user = normalizeUser(record(pick(row, 'user') ?? row));
  const status = text(pick(row, 'status', 'membershipStatus', 'membership_status'));
  const role = text(pick(row, 'role', 'memberRole', 'member_role'));
  return {
    ...user,
    role: role === 'owner' ? 'owner' : 'member',
    status: ['invited', 'declined', 'left', 'removed'].includes(status)
      ? status as ConversationMember['status']
      : 'member',
    joinedAt: text(pick(row, 'joinedAt', 'joined_at')) || null,
  };
}

function normalizeReaction(input: unknown): MessageReaction {
  const row = record(input);
  return {
    emoji: text(pick(row, 'emoji', 'reaction')),
    count: Number(pick(row, 'count', 'total')) || 0,
    reacted: bool(pick(row, 'reacted', 'mine', 'hasReacted', 'has_reacted')),
    users: array(pick(row, 'users', 'usernames')).map((name) => text(name)).filter(Boolean),
  };
}

function normalizeAttachment(input: unknown, conversationId: number): MessageAttachment {
  const row = record(input);
  const rawId = text(pick(row, 'id', 'attachmentId', 'attachment_id')).toLowerCase();
  const id = /^[a-f0-9]{32}$/.test(rawId) ? rawId : '';
  const base = `/api/conversations/${conversationId}/attachments/${id}`;
  const rawViewUrl = pick(row, 'viewUrl', 'view_url');
  return {
    id,
    name: text(pick(row, 'name', 'filename', 'originalName', 'original_name'), 'attachment'),
    size: Number(pick(row, 'size', 'sizeBytes', 'size_bytes')) || 0,
    contentType: text(pick(row, 'contentType', 'content_type', 'mimeType', 'mime_type'), 'application/octet-stream'),
    kind: text(pick(row, 'kind', 'fileKind', 'file_kind')) || null,
    url: text(pick(row, 'url', 'downloadUrl', 'download_url'), base),
    // A deliberate null means the backend judged this attachment unsafe to
    // render inline. Never fabricate a preview URL in that case.
    viewUrl: rawViewUrl === null ? null : text(rawViewUrl) || `${base}/view`,
  };
}

function normalizeObject(input: unknown): SharedObjectCard {
  const row = record(input);
  const ref = record(pick(row, 'reference', 'ref') ?? row);
  const type = text(pick(ref, 'type', 'kind')) as SharedObjectCard['type'];
  return {
    type: ['app', 'issue', 'proposal', 'governance', 'spec', 'hub', 'discussion'].includes(type) ? type : 'app',
    appId: strictId(pick(ref, 'appId', 'app_id')) || undefined,
    appSlug: text(pick(ref, 'appSlug', 'app_slug')) || undefined,
    issueNumber: strictId(pick(ref, 'issueNumber', 'issue_number')) || undefined,
    sessionId: strictId(pick(ref, 'sessionId', 'session_id')) || undefined,
    proposalId: strictId(pick(ref, 'proposalId', 'proposal_id', 'governanceId', 'governance_id')) || undefined,
    version: strictId(pick(ref, 'version', 'specVersion', 'spec_version')) || undefined,
    available: pick(row, 'available') !== false && !bool(pick(row, 'unavailable')),
    title: text(pick(row, 'title', 'name')) || null,
    subtitle: text(pick(row, 'subtitle', 'appName', 'app_name')) || null,
    state: text(pick(row, 'state', 'status')) || null,
    author: text(pick(row, 'author', 'username')) || null,
    href: text(pick(row, 'href', 'url', 'webPath', 'web_path')) || null,
  };
}

/** A thread's summary on the message it hangs off, or null when it has no replies. */
export function normalizeThreadSummary(input: unknown): MessageThreadSummary | null {
  if (!input || typeof input !== 'object') return null;
  const row = record(input);
  const replyCount = Number(pick(row, 'replyCount', 'reply_count')) || 0;
  if (replyCount < 1) return null;
  const last = pick(row, 'lastReply', 'last_reply');
  const lastRow = last && typeof last === 'object' ? record(last) : null;
  const lastId = lastRow ? strictId(pick(lastRow, 'id')) : null;
  return {
    replyCount,
    lastReplyAt: dateText(pick(row, 'lastReplyAt', 'last_reply_at')),
    participants: array(pick(row, 'participants')).map(normalizeUser).filter((user) => user.id).slice(0, 3),
    lastReply: lastRow && lastId ? {
      id: lastId,
      sender: normalizeUser(pick(lastRow, 'sender') ?? {
        id: pick(lastRow, 'userId', 'user_id'), username: pick(lastRow, 'username'),
      }),
      content: text(pick(lastRow, 'content')),
      createdAt: dateText(pick(lastRow, 'createdAt', 'created_at')),
    } : null,
  };
}

/** A reply's thread root, as the main stream's line names it (#2387 follow-up). */
export function normalizeThreadRoot(input: unknown): ThreadRootRef | null {
  if (!input || typeof input !== 'object') return null;
  const row = record(input);
  const id = strictId(pick(row, 'id'));
  if (!id) return null;
  return {
    id,
    senderUsername: text(pick(row, 'senderUsername', 'sender_username', 'username')) || 'Deleted user',
    content: text(pick(row, 'content')),
    deleted: pick(row, 'deleted') === true,
  };
}

export function normalizeMessage(input: unknown, fallbackConversationId = 0): ConversationMessage {
  const row = record(input);
  const conversationId = strictId(pick(row, 'conversationId', 'conversation_id')) || fallbackConversationId;
  const senderSource = pick(row, 'sender', 'user', 'author') ?? {
    id: pick(row, 'senderId', 'sender_id', 'userId', 'user_id'),
    username: pick(row, 'senderUsername', 'sender_username', 'username'),
    avatarUrl: pick(row, 'senderAvatarUrl', 'sender_avatar_url', 'avatar_url'),
  };
  const replyRow = record(pick(row, 'reply', 'replyTo', 'reply_to'));
  const replyId = strictId(pick(replyRow, 'id', 'messageId', 'message_id'));
  const botMeta = normalizeBotMeta(pick(row, 'metadata'));
  return {
    id: strictId(pick(row, 'id', 'messageId', 'message_id')) || 0,
    conversationId,
    sender: normalizeUser(senderSource),
    content: text(pick(row, 'content', 'text')),
    createdAt: dateText(pick(row, 'createdAt', 'created_at')),
    editedAt: text(pick(row, 'editedAt', 'edited_at')) || null,
    reply: replyId ? {
      id: replyId,
      sender: normalizeUser(pick(replyRow, 'sender', 'user', 'author') ?? replyRow),
      content: text(pick(replyRow, 'content', 'text')),
      deleted: pick(replyRow, 'deleted') === true,
    } : null,
    deleted: pick(row, 'deleted') === true,
    threadRootId: strictId(pick(row, 'threadRootId', 'thread_root_id')),
    threadRoot: normalizeThreadRoot(pick(row, 'threadRoot', 'thread_root')),
    thread: normalizeThreadSummary(pick(row, 'thread')),
    reactions: array(pick(row, 'reactions')).map(normalizeReaction).filter((reaction) => reaction.emoji),
    attachments: array(pick(row, 'attachments')).map((attachment) => normalizeAttachment(attachment, conversationId)),
    objects: array(pick(row, 'objects', 'objectCards', 'object_cards', 'sharedObjects', 'shared_objects')).map(normalizeObject),
    // This normalizer builds an explicit object rather than spreading the row,
    // so a field the server adds is DROPPED until it is named here — which is
    // exactly what happened to `saved` the first time: the API returned it,
    // the star rendered empty, and nothing anywhere errored.
    saved: pick(row, 'saved', 'bookmarked') === true,
    // #3624: the Homeroom bot's question and its answers, when it has one.
    ...(botMeta ? { metadata: botMeta } : {}),
  };
}

export function normalizeConversation(input: unknown): ConversationDetail {
  const row = record(input);
  const id = strictId(pick(row, 'id', 'conversationId', 'conversation_id')) || 0;
  const members = array(pick(row, 'members', 'participants')).map(normalizeMember);
  const rawKind = text(pick(row, 'kind', 'type'));
  // #2783: `channel` is #general — a room everybody is in.
  const kind = rawKind === 'group' ? 'group' : rawKind === 'channel' ? 'channel' : 'direct';
  const peerRaw = pick(row, 'peer', 'otherUser', 'other_user', 'recipient');
  const peer = peerRaw ? normalizeUser(peerRaw) : null;
  const membershipStatus = text(pick(row, 'membershipStatus', 'membership_status', 'myStatus', 'my_status', 'status'));
  const latestRaw = pick(row, 'latestMessage', 'latest_message', 'lastMessage', 'last_message');
  const latestMessage = latestRaw ? normalizeMessage(latestRaw, id) : null;
  const title = text(pick(row, 'title', 'name'))
    || (kind === 'direct' ? peer?.username || members.find((member) => member.status === 'member')?.username : '')
    || 'Conversation';
  const canSendValue = pick(row, 'canSend', 'can_send');
  return {
    id,
    kind,
    title,
    avatarUrl: text(pick(row, 'avatarUrl', 'avatar_url')) || peer?.avatarUrl || null,
    members,
    memberCount: Number(pick(row, 'memberCount', 'member_count')) || members.filter((member) => member.status === 'member').length,
    membershipStatus: ['invited', 'declined', 'left', 'removed'].includes(membershipStatus)
      ? membershipStatus as ConversationDetail['membershipStatus']
      : 'member',
    myRole: text(pick(row, 'myRole', 'my_role', 'role')) === 'owner' ? 'owner' : 'member',
    requester: pick(row, 'requester', 'inviter') ? normalizeUser(pick(row, 'requester', 'inviter')) : null,
    peer,
    latestMessage,
    // One line of plain text: the row is a preview, not the message, and a
    // bot message's `**Project**` should not show its asterisks.
    latestSummary: plainText(text(pick(row, 'latestSummary', 'latest_summary', 'preview')) || latestMessage?.content || ''),
    lastActivityAt: dateText(pick(row, 'lastActivityAt', 'last_activity_at', 'updatedAt', 'updated_at', 'createdAt', 'created_at')),
    unreadCount: Number(pick(row, 'unreadCount', 'unread_count')) || 0,
    awaitingAcceptance: kind === 'direct' && pick(row, 'awaitingAcceptance', 'awaiting_acceptance') === true,
    canSend: typeof canSendValue === 'boolean' ? canSendValue : membershipStatus !== 'invited',
    canInvite: bool(pick(row, 'canInvite', 'can_invite'), kind === 'group' && membershipStatus !== 'invited'),
    canManage: bool(pick(row, 'canManage', 'can_manage'), text(pick(row, 'myRole', 'my_role', 'role')) === 'owner'),
    archived: bool(pick(row, 'archived')) || text(pick(row, 'status')) === 'archived',
    channelKey: kind === 'channel' ? text(pick(row, 'channelKey', 'channel_key')) || null : null,
    ...(kind === 'direct' && pick(row, 'homeroomBot') === true ? { homeroomBot: true } : {}),
  };
}

function demoQuery(path: string): string {
  if (typeof window === 'undefined') return path;
  if (new URLSearchParams(window.location.search).get('demo') !== '1') return path;
  return `${path}${path.includes('?') ? '&' : '?'}demo=1`;
}

/**
 * How a read is asked for (#3705, #3706). `fresh` is a read made because
 * something CHANGED — a realtime event, a send settling, a reconnect — and it
 * needs the server's answer, not the service worker's.
 *
 * The worker answers an ordinary GET /api/* from its offline copy once the
 * network has taken a second (public/sw.js, API_TIMEOUT_MS). For a read like
 * this one that copy is the transcript from BEFORE the change: the message the
 * event announced is missing, and the store, taking the page as the server's
 * word, dropped the sender's own just-confirmed row with it. The Homeroom
 * bot's DM is where it showed, because its page is the slowest to answer.
 *
 * `cache: 'no-store'` is the worker's existing "leave this to the network"
 * signal: its fetch handler returns before classifying such a request. A
 * first open keeps the ordinary read, and with it the offline copy.
 */
export interface ReadOptions {
  fresh?: boolean;
}

function readInit(options?: ReadOptions): RequestInit {
  return options?.fresh ? { cache: 'no-store' } : {};
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !(init.body instanceof Blob)) {
    headers.set('Content-Type', headers.get('Content-Type') || 'application/json');
  }
  headers.set('Accept', 'application/json');
  const response = await fetch(demoQuery(path), { credentials: 'same-origin', ...init, headers });
  let data: unknown = null;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok) {
    const body = record(data);
    throw new MessagesApiError(response.status, text(pick(body, 'error', 'message'), `Request failed (${response.status})`));
  }
  return data as T;
}

export async function listConversations(options?: ReadOptions): Promise<ConversationSummary[]> {
  const data = record(await request<unknown>('/api/conversations', readInit(options)));
  return array(pick(data, 'conversations', 'items')).map(normalizeConversation).filter((item) => item.id);
}

export async function getConversation(id: number, options?: ReadOptions): Promise<ConversationDetail> {
  const data = record(await request<unknown>(`/api/conversations/${id}`, readInit(options)));
  return normalizeConversation(pick(data, 'conversation') ?? data);
}

// #3361: the `@` list for a conversation whose roster the client does not
// hold — a channel, whose members the server counts rather than loads. A
// username prefix in, at most `limit` people out (friends first, then whoever
// spoke there last), from exactly the people who can read the room.
export async function getMentionCandidates(id: number, prefix: string, limit = 8): Promise<ConversationUser[]> {
  const q = encodeURIComponent(prefix.slice(0, 64));
  const data = record(await request<unknown>(`/api/conversations/${id}/mention-candidates?q=${q}&limit=${limit}`));
  return array(pick(data, 'users')).map(normalizeUser).filter((user) => user.id);
}

export async function createConversation(body: { kind: 'direct'; userId: number } | { kind: 'group'; title: string; memberIds: number[] }): Promise<ConversationDetail> {
  const payload = body.kind === 'direct'
    ? { kind: 'direct', user_id: body.userId }
    : { kind: 'group', title: body.title, member_ids: body.memberIds };
  const data = record(await request<unknown>('/api/conversations', { method: 'POST', body: JSON.stringify(payload) }));
  return normalizeConversation(pick(data, 'conversation') ?? data);
}

export async function updateConversation(id: number, body: { title: string }): Promise<ConversationDetail> {
  const data = record(await request<unknown>(`/api/conversations/${id}`, { method: 'PATCH', body: JSON.stringify(body) }));
  return normalizeConversation(pick(data, 'conversation') ?? data);
}

export async function respondToInvitation(id: number, action: 'accept' | 'decline'): Promise<ConversationDetail | null> {
  const data = record(await request<unknown>(`/api/conversations/${id}/respond`, { method: 'POST', body: JSON.stringify({ action }) }));
  const raw = pick(data, 'conversation');
  if (raw === null || (action === 'decline' && raw === undefined)) return null;
  const conversation = normalizeConversation(raw ?? data);
  return conversation.id ? conversation : null;
}

export async function addMembers(id: number, userIds: number[]): Promise<ConversationDetail> {
  const data = record(await request<unknown>(`/api/conversations/${id}/members`, { method: 'POST', body: JSON.stringify({ user_ids: userIds }) }));
  return normalizeConversation(pick(data, 'conversation') ?? data);
}

export async function removeMember(id: number, userId: number): Promise<void> {
  await request<unknown>(`/api/conversations/${id}/members/${userId}`, { method: 'DELETE' });
}

export async function leaveConversation(id: number): Promise<void> {
  await request<unknown>(`/api/conversations/${id}/leave`, { method: 'POST', body: '{}' });
}

export async function listMessages(id: number, before?: number | null, options?: ReadOptions): Promise<{ messages: ConversationMessage[]; nextBefore: number | null }> {
  const params = new URLSearchParams({ limit: '50' });
  if (before) params.set('before', String(before));
  const data = record(await request<unknown>(`/api/conversations/${id}/messages?${params}`, readInit(options)));
  return {
    messages: array(pick(data, 'messages', 'items')).map((message) => normalizeMessage(message, id)),
    nextBefore: strictId(pick(data, 'nextBefore', 'next_before')),
  };
}

export async function sendMessage(id: number, input: { content: string; replyToId?: number; threadRootId?: number; attachmentIds?: string[]; object?: SharedObjectReference; idempotencyKey: string }): Promise<ConversationMessage> {
  const payload: JsonRecord = { content: input.content, idempotency_key: input.idempotencyKey };
  if (input.replyToId) payload.reply_to_id = input.replyToId;
  if (input.threadRootId) payload.thread_root_id = input.threadRootId;
  if (input.attachmentIds?.length) payload.attachment_ids = input.attachmentIds;
  if (input.object) payload.object = input.object;
  const data = record(await request<unknown>(`/api/conversations/${id}/messages`, { method: 'POST', body: JSON.stringify(payload) }));
  return normalizeMessage(pick(data, 'message') ?? data, id);
}

/**
 * The page a message link opens on (#2387): the messages around one, with a
 * cursor each way. When the linked message is a reply inside a thread, the
 * window is around the thread's first message and `focus.threadRootId` names
 * it, so the thread opens beside it.
 */
export async function listMessagesAround(id: number, messageId: number, options?: ReadOptions): Promise<{
  messages: ConversationMessage[];
  nextBefore: number | null;
  nextAfter: number | null;
  focus: { messageId: number; threadRootId: number | null };
}> {
  const params = new URLSearchParams({ limit: '50', around: String(messageId) });
  const data = record(await request<unknown>(`/api/conversations/${id}/messages?${params}`, readInit(options)));
  const focus = record(pick(data, 'focus'));
  return {
    messages: array(pick(data, 'messages', 'items')).map((message) => normalizeMessage(message, id)),
    nextBefore: strictId(pick(data, 'nextBefore', 'next_before')),
    nextAfter: strictId(pick(data, 'nextAfter', 'next_after')),
    focus: {
      messageId: strictId(pick(focus, 'messageId', 'message_id')) || messageId,
      threadRootId: strictId(pick(focus, 'threadRootId', 'thread_root_id')),
    },
  };
}

/** The newer half of a linked page: messages after one, oldest first. */
export async function listMessagesAfter(id: number, after: number): Promise<{ messages: ConversationMessage[]; nextAfter: number | null }> {
  const params = new URLSearchParams({ limit: '50', after: String(after) });
  const data = record(await request<unknown>(`/api/conversations/${id}/messages?${params}`));
  return {
    messages: array(pick(data, 'messages', 'items')).map((message) => normalizeMessage(message, id)),
    nextAfter: strictId(pick(data, 'nextAfter', 'next_after')),
  };
}

/** A thread: the message it hangs off, and its replies oldest first (#2387). */
export async function listThread(id: number, rootId: number, before?: number | null, options?: ReadOptions): Promise<{
  root: ConversationMessage | null;
  messages: ConversationMessage[];
  nextBefore: number | null;
}> {
  const params = new URLSearchParams({ limit: '50' });
  if (before) params.set('before', String(before));
  const data = record(await request<unknown>(`/api/conversations/${id}/threads/${rootId}?${params}`, readInit(options)));
  const root = pick(data, 'root');
  return {
    root: root ? normalizeMessage(root, id) : null,
    messages: array(pick(data, 'messages', 'items')).map((message) => normalizeMessage(message, id)),
    nextBefore: strictId(pick(data, 'nextBefore', 'next_before')),
  };
}

/** Delete your own message (#2387). The server keeps a "deleted" placeholder. */
export async function deleteMessage(conversationId: number, messageId: number): Promise<ConversationMessage | null> {
  const data = record(await request<unknown>(`/api/conversations/${conversationId}/messages/${messageId}`, { method: 'DELETE' }));
  const raw = pick(data, 'message');
  return raw ? normalizeMessage(raw, conversationId) : null;
}

/** Make this message, and everything after it, unread again (#2387). */
export async function markUnread(conversationId: number, messageId: number): Promise<{ unreadCount: number }> {
  const data = record(await request<unknown>(`/api/conversations/${conversationId}/unread`, {
    method: 'POST', body: JSON.stringify({ message_id: messageId }),
  }));
  return { unreadCount: Number(pick(data, 'unreadCount', 'unread_count')) || 0 };
}

export async function editMessage(conversationId: number, messageId: number, content: string): Promise<ConversationMessage> {
  const data = record(await request<unknown>(`/api/conversations/${conversationId}/messages/${messageId}`, { method: 'PATCH', body: JSON.stringify({ content }) }));
  return normalizeMessage(pick(data, 'message') ?? data, conversationId);
}

export async function toggleReaction(conversationId: number, messageId: number, emoji: string): Promise<MessageReaction[]> {
  const data = record(await request<unknown>(`/api/conversations/${conversationId}/messages/${messageId}/reactions`, { method: 'POST', body: JSON.stringify({ emoji }) }));
  return array(pick(data, 'reactions')).map(normalizeReaction);
}

export async function markRead(conversationId: number, messageId: number): Promise<void> {
  await request<unknown>(`/api/conversations/${conversationId}/read`, { method: 'POST', body: JSON.stringify({ message_id: messageId }) });
}

export async function setTyping(conversationId: number, typing: boolean): Promise<void> {
  await request<unknown>(`/api/conversations/${conversationId}/typing`, {
    method: 'POST', body: JSON.stringify({ typing }),
  });
}

export async function uploadAttachment(conversationId: number, file: File): Promise<MessageAttachment> {
  const response = await fetch(`/api/conversations/${conversationId}/attachments?filename=${encodeURIComponent(file.name)}`, {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': file.type || 'application/octet-stream', Accept: 'application/json' }, body: file,
  });
  let data: unknown = null;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok) throw new MessagesApiError(response.status, text(pick(record(data), 'error', 'message'), `Upload failed (${response.status})`));
  return normalizeAttachment(pick(record(data), 'attachment') ?? data, conversationId);
}

export async function searchUsers(query: string): Promise<UserSearchResult[]> {
  const data = record(await request<unknown>(`/api/users/search?q=${encodeURIComponent(query.trim().slice(0, 255))}&scope=messages`));
  return array(pick(data, 'users')).map(normalizeUser).filter((user) => user.id);
}

export async function listApps(): Promise<Array<{ id: number; slug: string; name: string }>> {
  const data = record(await request<unknown>('/api/apps'));
  return array(pick(data, 'apps')).map((item) => {
    const row = record(item);
    return { id: strictId(row.id) || 0, slug: text(row.slug), name: text(row.name, text(row.slug)) };
  }).filter((app) => app.id && app.slug);
}

export async function listAppItems(slug: string, type: 'issue' | 'proposal' | 'governance'): Promise<Array<{ id: number; title: string; status?: string }>> {
  const endpoint = type === 'proposal' ? 'promoted' : 'issues';
  const data = record(await request<unknown>(`/api/apps/${encodeURIComponent(slug)}/${endpoint}`));
  const candidates = type === 'proposal'
    ? array(pick(data, 'proposals', 'sessions', 'items'))
    : array(pick(data, 'issues', 'items'));
  return candidates.map((item) => {
    const row = record(item);
    return {
      id: strictId(pick(row, 'number', 'id')) || 0,
      title: text(pick(row, 'title', 'pr_title', 'session_title'), 'Untitled'),
      status: text(pick(row, 'status')) || undefined,
    };
  }).filter((item) => item.id);
}

/**
 * #3660: the cards a message's Homeroom links stand for, as the server
 * resolves them for THIS viewer — one answer per link, in order, and an
 * unavailable one for a page they cannot see. Only the parsed page goes up
 * (./homeroom-links.ts), never the link itself.
 */
export async function resolveLinkCards(links: ReadonlyArray<Pick<HomeroomLink, 'type' | 'appSlug' | 'issueNumber' | 'sessionId' | 'proposalId'>>): Promise<SharedObjectCard[]> {
  const refs = links.map((link) => ({
    type: link.type,
    app_slug: link.appSlug,
    ...(link.issueNumber ? { issue_number: link.issueNumber } : {}),
    ...(link.sessionId ? { session_id: link.sessionId } : {}),
    ...(link.proposalId ? { proposal_id: link.proposalId } : {}),
  }));
  const data = record(await request<unknown>('/api/link-cards', { method: 'POST', body: JSON.stringify({ refs }) }));
  return array(pick(data, 'cards')).map(normalizeObject);
}

/**
 * #3660: post a message to an app's discussion (its general stream) over
 * the REST twin of the chat socket — the same canonical write
 * (routes/chat.js), for a page that has no socket open to that app.
 */
export async function postAppMessage(slug: string, content: string): Promise<void> {
  await request<unknown>(`/api/apps/${encodeURIComponent(slug)}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: content.slice(0, 8000) }),
  });
}

export async function reportMessage(
  conversationId: number,
  messageId: number,
  reason: 'harassment' | 'spam' | 'threats' | 'hate' | 'sexual_content' | 'other',
  detail?: string,
): Promise<void> {
  await request<unknown>(`/api/conversations/${conversationId}/messages/${messageId}/report`, {
    method: 'POST', body: JSON.stringify({ reason, ...(detail ? { detail: detail.slice(0, 500) } : {}) }),
  });
}

/**
 * Save or unsave one message — the Messages half of the bookmark app group
 * chat has carried since #1280. PUT saves, DELETE unsaves, matching that
 * surface's verbs so the two behave identically.
 */
export async function setMessageSaved(
  conversationId: number,
  messageId: number,
  saved: boolean,
): Promise<void> {
  await request<unknown>(`/api/conversations/${conversationId}/messages/${messageId}/bookmark`, {
    method: saved ? 'PUT' : 'DELETE', ...(saved ? { body: '{}' } : {}),
  });
}

/**
 * B3: press one of a bot message's `server` buttons. Decided once, by the
 * person it was offered to: a 409 means it was decided already (on another
 * device, say), and the message's own update shows how.
 */
/**
 * B7: Approve, from a change's ready card: the person's own Yes, cast from
 * their own browser on the version the card was sent for, as the change
 * page's vote is. `stale` when that version was replaced (a 409 that says
 * so), with the version it is at now.
 */
export async function approveChange(sessionId: number, epoch: number | null): Promise<{ ok: boolean; stale: boolean; epoch: number | null; error: string | null }> {
  let response: Response;
  try {
    response = await fetch(`/api/sessions/${sessionId}/vote`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(epoch === null ? { vote: 'yes' } : { vote: 'yes', expectedEpoch: epoch }),
    });
  } catch {
    return { ok: false, stale: false, epoch: null, error: 'Couldn’t reach Homeroom. Try again.' };
  }
  const data = record(await response.json().catch(() => ({})));
  if (response.ok) return { ok: true, stale: false, epoch, error: null };
  const stale = response.status === 409 && pick(data, 'headChanged') === true;
  const next = Number.isInteger(pick(data, 'approvalEpoch')) ? Number(pick(data, 'approvalEpoch')) : null;
  return { ok: false, stale, epoch: next, error: stale ? null : (text(pick(data, 'message')) || text(pick(data, 'error')) || 'Couldn’t approve it just now.') };
}

export async function decideBotAction(actionId: number, choice: string, answers?: string[]): Promise<{ label: string | null }> {
  // B6: Build it under a plan carries the answers tapped, in order.
  const data = record(await request<unknown>(`/api/conversations/homeroom-bot/actions/${actionId}`, {
    method: 'POST', body: JSON.stringify(answers ? { choice, answers } : { choice }),
  }));
  return { label: text(pick(data, 'label')) || null };
}

/** B8: the signed-in person's chat with Homeroom bot, made the first time. */
export async function openBotConversation(): Promise<number | null> {
  const data = record(await request<unknown>('/api/conversations/homeroom-bot', { method: 'POST', body: '{}' }));
  return strictId(pick(data, 'conversationId')) || null;
}

export async function setBlock(userId: number, blocked: boolean): Promise<void> {
  await request<unknown>(`/api/me/blocks/${userId}`, { method: blocked ? 'PUT' : 'DELETE', ...(blocked ? { body: '{}' } : {}) });
}

export async function listBlocks(): Promise<ConversationUser[]> {
  const data = record(await request<unknown>('/api/me/blocks'));
  return array(pick(data, 'blocks', 'users')).map((entry) => {
    const row = record(entry);
    return normalizeUser(pick(row, 'user', 'blockedUser', 'blocked_user') ?? row);
  }).filter((user) => user.id);
}

const ACTIVITY_OUTCOMES = new Set<HomeroomBotActivityOutcome>([
  'question', 'proposed', 'live', 'closed', 'blocked', 'build_failed',
  'person', 'empty', 'failed', 'held', 'stopped', 'answer', 'revise',
]);

/** An in-app address (`#app/…`), or null: a card's link never leaves the shell. */
function inAppHref(value: unknown): string | null {
  const href = text(value);
  return href.startsWith('#app/') ? href : null;
}

const BOT_PHASES = new Set<HomeroomBotPhase>([
  'setting_up', 'queued', 'looking', 'building', 'follow_up_queued', 'following_up', 'merging',
]);

/**
 * #3692: who one of the Homeroom bot's tray entries is about, and where it
 * opens, field by field. Every address is kept only when it is one of the
 * platform's own in-app addresses (`#app/…`): the tray draws them as links,
 * and a link it draws never leaves the shell. An earlier run with an
 * unknown ending reads as one that stopped, as a card's does.
 */
function normalizeBotJob(row: JsonRecord): HomeroomBotJob {
  const links = record(pick(row, 'links'));
  const appSlug = text(pick(row, 'appSlug')) || null;
  const issueNumber = strictId(pick(row, 'issueNumber'));
  const firstVersion = pick(row, 'firstVersion') === true;
  return {
    key: text(pick(row, 'key')) || `${appSlug || ''}#${issueNumber || 'first'}`,
    appSlug,
    appName: text(pick(row, 'appName')) || appSlug || 'A project',
    issueNumber,
    title: text(pick(row, 'title')) || null,
    firstVersion,
    href: inAppHref(pick(row, 'href')),
    links: {
      request: inAppHref(pick(links, 'request')),
      proposal: inAppHref(pick(links, 'proposal')),
      project: inAppHref(pick(links, 'project')),
    },
    earlier: array(pick(row, 'earlier')).map((entry) => {
      const run = record(entry);
      const outcome = text(pick(run, 'outcome')) as HomeroomBotActivityOutcome;
      return {
        id: strictId(pick(run, 'id')) || 0,
        outcome: ACTIVITY_OUTCOMES.has(outcome) ? outcome : 'stopped',
        at: text(pick(run, 'at')) || null,
      };
    }).filter((run) => run.id),
  };
}

/** A past entry (Needs you or History). One without a known ending says what waits instead, or is dropped. */
function normalizeBotPastJob(entry: unknown): HomeroomBotPastJob | null {
  const row = record(entry);
  const outcome = text(pick(row, 'outcome')) as HomeroomBotActivityOutcome;
  const known = ACTIVITY_OUTCOMES.has(outcome);
  const doing = text(pick(row, 'doing')) || null;
  if (!known && !doing && !outcome) return null;
  return {
    ...normalizeBotJob(row),
    id: strictId(pick(row, 'id')) || 0,
    outcome: known ? outcome : (outcome ? 'failed' : null),
    doing,
    at: text(pick(row, 'at')) || null,
  };
}

export function normalizeBotWork(input: unknown): HomeroomBotWork {
  const data = record(input);
  const now = array(pick(data, 'now')).map((entry) => {
    const row = record(entry);
    const phase = text(pick(row, 'phase')) as HomeroomBotPhase;
    const step = strictId(pick(row, 'step'));
    const of = strictId(pick(row, 'of'));
    const whole = !!step && !!of && step <= of && of <= 12;
    return {
      ...normalizeBotJob(row),
      phase: BOT_PHASES.has(phase) ? phase : 'looking',
      step: whole ? step : null,
      of: whole ? of : null,
      stepName: whole ? text(pick(row, 'stepName')) || null : null,
      doing: text(pick(row, 'doing')) || null,
      since: text(pick(row, 'since')) || null,
    };
  });
  const past = (key: string) => array(pick(data, key)).map(normalizeBotPastJob)
    .filter((job): job is HomeroomBotPastJob => !!job);
  return { now, needsYou: past('needsYou'), history: past('history') };
}

/**
 * #3692: what the Homeroom bot is doing for the signed-in person, what waits
 * on them, and what it did before. #8 (WP3): a re-read after news passes
 * `fresh`, as the activity cards' does: it was the one read of the bot's
 * that never did, so a slow answer was the worker's offline copy, and the
 * header said "Working on…" for work long finished (see ReadOptions).
 */
export async function getHomeroomBotWork(options?: ReadOptions): Promise<HomeroomBotWork> {
  return normalizeBotWork(await request<unknown>('/api/conversations/homeroom-bot/work', readInit(options)));
}

/**
 * #3736: the state of the activity cards in the bot's DM, field by field.
 * A card without a message id is dropped; a step is kept only as a whole
 * "N of M"; an unknown state or outcome reads as a piece of work that
 * stopped, never as one still going.
 */
export function normalizeBotActivity(input: unknown): HomeroomBotActivity[] {
  return array(pick(record(input), 'cards')).map((entry): HomeroomBotActivity | null => {
    const row = record(entry);
    const messageId = strictId(pick(row, 'messageId'));
    if (!messageId) return null;
    const links = record(pick(row, 'links'));
    const step = strictId(pick(row, 'step'));
    const of = strictId(pick(row, 'of'));
    const whole = !!step && !!of && step <= of && of <= 12;
    const working = text(pick(row, 'state')) === 'working';
    const outcome = text(pick(row, 'outcome')) as HomeroomBotActivityOutcome;
    return {
      messageId,
      state: working ? 'working' : 'done',
      startedAt: text(pick(row, 'startedAt')) || null,
      links: { request: inAppHref(pick(links, 'request')), proposal: inAppHref(pick(links, 'proposal')) },
      step: working && whole ? step : null,
      of: working && whole ? of : null,
      stepName: working ? text(pick(row, 'stepName')) || null : null,
      doing: working ? text(pick(row, 'doing')) || null : null,
      outcome: working ? null : (ACTIVITY_OUTCOMES.has(outcome) ? outcome : 'stopped'),
      endedAt: working ? null : text(pick(row, 'endedAt')) || null,
    };
  }).filter((card): card is HomeroomBotActivity => !!card);
}

/**
 * #3736: how far along each activity card in the signed-in person's bot DM
 * is. A re-read after news passes `fresh`, so the worker's offline copy of
 * an older state never stands in for it (see ReadOptions).
 */
export async function getHomeroomBotActivity(options?: ReadOptions): Promise<HomeroomBotActivity[]> {
  return normalizeBotActivity(await request<unknown>('/api/conversations/homeroom-bot/activity', readInit(options)));
}

/**
 * The bot's DM opened: any of the signed-in person's work the bot has under
 * way without an activity card gets one, sent by the server at the end of
 * the DM (services/homeroom-bot-activity.js catchUpCards). The request names
 * nothing. How many cards it added.
 */
export async function catchUpHomeroomBotActivity(): Promise<number> {
  const data = record(await request<unknown>('/api/conversations/homeroom-bot/activity', { method: 'POST', body: '{}' }));
  const added = Number(pick(data, 'added'));
  return Number.isSafeInteger(added) && added > 0 ? added : 0;
}
