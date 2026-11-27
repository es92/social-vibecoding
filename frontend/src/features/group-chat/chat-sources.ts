/**
 * What a project's chat offers its message box (one message box, 27 Nov
 * 2026): the people `@` lists, the requests, changes and channels `#` lists,
 * and where a file goes. Messages' box (../messages/composer.tsx MessageBox)
 * draws them; this module only answers it, for every place that writes into
 * a project's chat: a topic's channel and the thread on a request, a change
 * or a decision (./composer.tsx), and the comments under a change
 * (../dev-board/card/feed-thread.tsx).
 *
 * They were three copies: the classic script's MentionAutocomplete and
 * RefAutocomplete in public/js/group-chat.js, and the comments box's own
 * mention and ref typeaheads in dev-board/card/. The endpoints, the caches
 * and the token grammar are kept as they were.
 */

import type { ComposerPeople, ComposerRef, ComposerRefMatch, MentionPerson } from '../messages/composer';
import { channels } from '../messages/store';
import type { MessageAttachment } from '../messages/types';
import { errorText, t as translate } from '../../lib/i18n/runtime';

/** A stale list only means a just-joined person, or a just-opened request, is not offered yet. */
export const CHAT_SOURCE_TTL_MS = 2 * 60 * 1000;
/** The server's cap on the whole people list (src/routes/chat.js); a list this long may be missing people. */
export const MENTION_FULL_LIST = 500;
/** People one `@` prefix is answered with; the box shows six. */
export const CHAT_MENTION_LIMIT = 8;
/** Rows one `#` token is answered with. */
export const CHAT_REF_LIMIT = 6;

/** B9: Homeroom bot's handle, and the name a pick puts in, which the server reads as it. */
export const BOT_HANDLE = 'homeroom_bot';
export const BOT_NAME = 'Homeroom bot';

export function mentionSuggestionsPath(slug: string): string {
  return `/api/apps/${encodeURIComponent(slug)}/mention-suggestions`;
}

// `results=failing`: the Workshop's list form (AppView._listQS), so this
// reads the copy the board already holds; numbers and titles are all it needs.
export function promotedPath(slug: string): string {
  return `/api/apps/${encodeURIComponent(slug)}/promoted?results=failing`;
}

export function githubIssuesPath(slug: string): string {
  return `/api/apps/${encodeURIComponent(slug)}/github-issues`;
}

function usernamesOf(data: any): string[] {
  return Array.isArray(data?.users)
    ? data.users.map((u: any) => String((u && u.username) || '')).filter(Boolean)
    : [];
}

// ── People: one list per project, shared by every box ─────────────────

interface PeopleEntry { users: string[]; bot: boolean; fetchedAt: number }
const people = new Map<string, PeopleEntry>();
const peopleInflight = new Map<string, Promise<PeopleEntry>>();

/**
 * The project's people, from the cache or the endpoint. A refusal (a 404 for
 * a viewer who may not post) is kept as empty for the TTL; a failed fetch,
 * a 429 included, is not, so the next `@` asks again.
 */
export function loadChatPeople(slug: string): Promise<PeopleEntry> {
  const hit = people.get(slug);
  if (hit && Date.now() - hit.fetchedAt < CHAT_SOURCE_TTL_MS) return Promise.resolve(hit);
  const pending = peopleInflight.get(slug);
  if (pending) return pending;
  const p = (async () => {
    try {
      const res = await fetch(mentionSuggestionsPath(slug));
      if (res.status === 429) return { users: [], bot: false, fetchedAt: 0 };
      let entry: PeopleEntry = { users: [], bot: false, fetchedAt: Date.now() };
      if (res.ok) {
        const data = await res.json();
        // B9: Homeroom bot, when it answers this viewer on this project.
        entry = { users: usernamesOf(data), bot: !!(data?.bot && data.bot.username), fetchedAt: Date.now() };
      }
      people.set(slug, entry);
      return entry;
    } catch {
      return { users: [], bot: false, fetchedAt: 0 };
    } finally {
      peopleInflight.delete(slug);
    }
  })();
  peopleInflight.set(slug, p);
  return p;
}

/** The people matching `query` by prefix, asked of the server (#3361). */
async function askByPrefix(slug: string, query: string): Promise<string[]> {
  const res = await fetch(`${mentionSuggestionsPath(slug)}?q=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error(`mention lookup ${res.status}`);
  return usernamesOf(await res.json());
}

/**
 * Who `@` offers in a project's chat: Homeroom bot first whenever what was
 * typed matches it (a bare `@` does), then the project's people in the
 * server's order (friends, then who has spoken, then members). When the
 * whole list is full and a prefix does not fill the menu from it, the
 * people matching it are asked of the server too.
 */
export function chatPeople(slug: string): ComposerPeople {
  return {
    kind: 'lookup',
    key: `app:${slug}`,
    ask: async (query) => {
      const entry = await loadChatPeople(slug);
      const q = query.toLowerCase();
      const out: MentionPerson[] = [];
      const seen = new Set<string>();
      if (entry.bot && (BOT_HANDLE.startsWith(q) || BOT_NAME.toLowerCase().replace(' ', '').startsWith(q))) {
        out.push({ key: `@${BOT_HANDLE}`, id: 0, username: BOT_HANDLE, insert: BOT_NAME, match: BOT_HANDLE.startsWith(q) ? BOT_HANDLE : BOT_NAME.replace(' ', '') });
      }
      const add = (name: string) => {
        const lower = name.toLowerCase();
        if (lower === BOT_HANDLE || seen.has(lower) || (q && !lower.startsWith(q))) return;
        seen.add(lower);
        out.push({ key: `@${lower}`, id: 0, username: name });
      };
      for (const name of entry.users) {
        add(name);
        if (out.length >= CHAT_MENTION_LIMIT) return out;
      }
      if (q && entry.users.length >= MENTION_FULL_LIST) {
        for (const name of await askByPrefix(slug, query)) {
          add(name);
          if (out.length >= CHAT_MENTION_LIMIT) break;
        }
      }
      return out;
    },
  };
}

// ── Requests and changes: `#123`, `PR#123` and `#channel` ─────────────

interface RefOption { kind: 'pr' | 'issue'; number: number; title: string }
interface RefEntry { prs: RefOption[]; issues: RefOption[]; fetchedAt: number }
const refs = new Map<string, RefEntry>();
const refsInflight = new Map<string, Promise<RefEntry>>();

/**
 * The project's open changes and open requests, from the cache or the two
 * endpoints the Workshop already reads. Merged changes are not offered;
 * they still chip once their number is typed.
 */
export function loadChatRefs(slug: string): Promise<RefEntry> {
  const hit = refs.get(slug);
  if (hit && Date.now() - hit.fetchedAt < CHAT_SOURCE_TTL_MS) return Promise.resolve(hit);
  const pending = refsInflight.get(slug);
  if (pending) return pending;
  const p = (async () => {
    try {
      const [prRes, issueRes] = await Promise.all([fetch(promotedPath(slug)), fetch(githubIssuesPath(slug))]);
      const prData = prRes.ok ? await prRes.json() : {};
      const issueData = issueRes.ok ? await issueRes.json() : {};
      const prs: RefOption[] = (Array.isArray(prData.promoted) ? prData.promoted : [])
        .filter((pr: any) => pr && pr.pr_number != null)
        .map((pr: any) => ({ kind: 'pr', number: Number(pr.pr_number), title: pr.pr_title || translate('chat:group.ref.byUser', { username: pr.username || '' }) }));
      const issues: RefOption[] = (Array.isArray(issueData.issues) ? issueData.issues : [])
        .map((i: any) => ({ kind: 'issue', number: Number(i.number), title: i.title || '' }));
      const entry = { prs, issues, fetchedAt: Date.now() };
      refs.set(slug, entry);
      return entry;
    } catch {
      return { prs: [], issues: [], fetchedAt: 0 };
    } finally {
      refsInflight.delete(slug);
    }
  })();
  refsInflight.set(slug, p);
  return p;
}

/** The project's refs if they are held and fresh; null until they are. */
export function heldChatRefs(slug: string): RefEntry | null {
  const hit = refs.get(slug);
  return hit && Date.now() - hit.fetchedAt < CHAT_SOURCE_TTL_MS ? hit : null;
}

/**
 * Anchored at the caret: a boundary (start, or a character that is neither
 * a word character nor `&`), then `PR#` / `PR #` or a bare `#`, then digits
 * or a word. The `&` mirrors the renderer's own boundary, so the list never
 * offers what would not chip, and `[^\w]` excludes `@`.
 */
const REF_TRIGGER_RE = /(^|[^\w&])(pr ?#|#)(\d{0,7}|[A-Za-z][A-Za-z0-9-]{0,39})$/i;

/**
 * What `#` offers before the caret, from the refs held for `slug`: `PR#`
 * lists the open changes; a bare `#` the open requests, then the changes,
 * then the viewer's channels (#2783); and a word after it the channels
 * alone, the split the renderer makes. A change goes in as `PR#N` wherever
 * it was picked.
 */
export function chatRefMatch(before: string, held: RefEntry | null): ComposerRefMatch | null {
  const m = before.match(REF_TRIGGER_RE);
  if (!m || m.index === undefined) return null;
  const prMode = m[2].length > 1;
  const query = m[3].toLowerCase();
  // A change is a number, never a channel.
  if (prMode && !/^\d*$/.test(query)) return null;
  const items: ComposerRef[] = [];
  const word = /^[a-z]/.test(query);
  if (!word) {
    const pool = prMode ? (held?.prs || []) : [...(held?.issues || []), ...(held?.prs || [])];
    for (const item of pool) {
      if (query && !String(item.number).startsWith(query)) continue;
      const insert = item.kind === 'pr' ? `PR#${item.number}` : `#${item.number}`;
      items.push({ key: insert, insert, label: insert, ...(item.title ? { name: item.title } : {}) });
      if (items.length >= CHAT_REF_LIMIT) break;
    }
  }
  if (!prMode && items.length < CHAT_REF_LIMIT && !/^\d+$/.test(query)) {
    for (const item of channels()) {
      if (!item.handle.startsWith(query)) continue;
      items.push({
        key: `#${item.handle}`,
        insert: `#${item.handle}`,
        label: `#${item.handle}`,
        channel: item.handle,
        ...(item.kind === 'app' && item.name.toLowerCase() !== item.handle ? { name: item.name } : {}),
      });
      if (items.length >= CHAT_REF_LIMIT) break;
    }
  }
  return { start: m.index + m[1].length, items };
}

// ── Files ─────────────────────────────────────────────────────────────

/**
 * Upload one file to the project's chat, as the attachment the box holds
 * until it sends. The server answers its id and kind; the rest is the file's
 * own, and the address is the app-gated one a sent message's files use.
 */
export async function uploadChatFile(slug: string, file: File): Promise<MessageAttachment> {
  const res = await fetch(`/api/apps/${encodeURIComponent(slug)}/chat-attachments?filename=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || typeof data?.id !== 'string') {
    throw new Error(errorText(data) || translate('chat:group.attach.uploadFailedStatus', { status: res.status }));
  }
  return {
    id: data.id,
    name: file.name,
    size: file.size,
    contentType: file.type || '',
    kind: typeof data.kind === 'string' ? data.kind : null,
    url: `/api/apps/${encodeURIComponent(slug)}/chat-attachments/${data.id}`,
    viewUrl: null,
  };
}
