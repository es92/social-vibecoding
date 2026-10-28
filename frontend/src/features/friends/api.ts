/**
 * The client for mutual friends (#2386) — src/routes/friends.js.
 *
 * Every write answers with the relationship as the viewer now sees it, so a
 * caller never guesses the next state: it draws what came back. A write that
 * found nothing to do (the other person withdrew a moment ago) answers the
 * CURRENT state rather than an error, which is how a button that was one step
 * behind catches up.
 *
 * `?demo=1` rides every request when the page has it, as Messages' client
 * does: a staging preview answers from fixtures and writes nothing.
 */

import { t } from '../../lib/i18n/runtime';

export type FriendState = 'none' | 'outgoing' | 'incoming' | 'friends';
export type FriendAction = 'request' | 'cancel' | 'accept' | 'decline' | 'unfriend';

export interface FriendPerson {
  id: number;
  username: string;
  avatarUrl: string | null;
  /** When you became friends — `friends` rows only. */
  since?: string | null;
  /** When the request was sent — `incoming` / `outgoing` rows only. */
  requestedAt?: string | null;
}

export interface FriendLists {
  friends: FriendPerson[];
  incoming: FriendPerson[];
  outgoing: FriendPerson[];
}

export class FriendsApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.name = 'FriendsApiError';
    this.status = status;
    this.code = code;
  }
}

const STATES: ReadonlySet<string> = new Set(['none', 'outgoing', 'incoming', 'friends']);

export function normalizeState(value: unknown): FriendState {
  return typeof value === 'string' && STATES.has(value) ? value as FriendState : 'none';
}

function person(input: unknown): FriendPerson | null {
  const row = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const id = Number(row.id);
  if (!Number.isSafeInteger(id) || id <= 0 || typeof row.username !== 'string') return null;
  const avatarUrl = typeof row.avatarUrl === 'string' && /^\/avatars\/[a-f0-9]{32}$/.test(row.avatarUrl)
    ? row.avatarUrl : null;
  return {
    id,
    username: row.username,
    avatarUrl,
    since: typeof row.since === 'string' ? row.since : null,
    requestedAt: typeof row.requestedAt === 'string' ? row.requestedAt : null,
  };
}

function people(value: unknown): FriendPerson[] {
  return (Array.isArray(value) ? value : []).map(person).filter((p): p is FriendPerson => !!p);
}

export function normalizeLists(input: unknown): FriendLists {
  const body = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  return { friends: people(body.friends), incoming: people(body.incoming), outgoing: people(body.outgoing) };
}

function demoQuery(path: string): string {
  if (typeof window === 'undefined') return path;
  if (new URLSearchParams(window.location.search).get('demo') !== '1') return path;
  return `${path}${path.includes('?') ? '&' : '?'}demo=1`;
}

async function request(path: string, method = 'GET'): Promise<unknown> {
  const init: RequestInit = { method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
  if (method !== 'GET') {
    init.headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
    init.body = '{}';
  }
  const response = await fetch(demoQuery(path), init);
  let data: unknown = null;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok) {
    const body = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
    // #5104: a friend request to someone who takes them only from people in
    // projects with them is said in the screen's own words.
    const message = body.code === 'contact_restricted'
      ? t('messages:api.contactRestricted')
      : typeof body.error === 'string' ? body.error : t('messages:friends.error.requestFailed', { status: response.status });
    throw new FriendsApiError(
      response.status,
      message,
      typeof body.code === 'string' ? body.code : null,
    );
  }
  return data;
}

export async function listFriends(): Promise<FriendLists> {
  return normalizeLists(await request('/api/friends'));
}

export async function friendState(userId: number): Promise<FriendState> {
  const data = await request(`/api/friends/${userId}`) as { state?: unknown } | null;
  return normalizeState(data?.state);
}

/**
 * The route each action is. Spelled out one literal per action rather than
 * assembled, so a search for a route finds its caller.
 */
export function actionRoute(userId: number, action: FriendAction): { method: string; path: string } {
  switch (action) {
    case 'request': return { method: 'POST', path: `/api/friends/${userId}/request` };
    case 'cancel': return { method: 'DELETE', path: `/api/friends/${userId}/request` };
    case 'accept': return { method: 'POST', path: `/api/friends/${userId}/accept` };
    case 'decline': return { method: 'POST', path: `/api/friends/${userId}/decline` };
    case 'unfriend': return { method: 'DELETE', path: `/api/friends/${userId}` };
    default: throw new Error(`unknown friend action: ${String(action)}`);
  }
}

export async function act(userId: number, action: FriendAction): Promise<FriendState> {
  const { method, path } = actionRoute(userId, action);
  const data = await request(path, method) as { state?: unknown } | null;
  return normalizeState(data?.state);
}

/** What a refusal says, in the platform's voice. Never says WHY a person is unreachable. */
export function errorMessage(err: unknown, username: string | null): string {
  const status = (err as { status?: number } | null)?.status;
  if (err instanceof FriendsApiError && status === 429) return err.message;
  // `username` is an account's name or nothing. With no name the sentence
  // has its own wording: a pronoun is never passed off as a username.
  if (status === 404) {
    return username
      ? t('messages:friends.error.cannotAdd', { username })
      : t('messages:friends.error.cannotAddUnnamed');
  }
  return t('messages:friends.error.updateFailed');
}

/**
 * Tell everything that caches friends (the composer's ordering, the own
 * profile's list) that the answer changed. A DOM event rather than an import,
 * so the notifications controller — which must stay import-free — can raise
 * it too.
 */
export const FRIENDS_CHANGED_EVENT = 'usernode:friends-changed';

export function announceFriendsChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(FRIENDS_CHANGED_EVENT));
}
