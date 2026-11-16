/**
 * The Messages list (#2718): the viewer's conversations with people.
 *
 * ── What it lists ─────────────────────────────────────────────────────
 *
 * Direct messages and group chats, under one People heading
 * (./index.tsx). Nothing else is a row here:
 *
 *   - #general and each app's channel are drawn on the hub of the
 *     community each belongs to (features/dev-board/workshop/hub-cards.tsx).
 *     A channel keeps its address (`#messages/app/<slug>`, `#messages/<id>`
 *     for #general), and opening one lights Communities rather than
 *     Messages.
 *   - The Homeroom bot's chat is the AI tab (#6019).
 *   - A change in flight was a second section, Agents, until 16 Nov 2026.
 *     The same changes are listed on the Homeroom bot tab, the Homeroom
 *     menu and each project's Workshop, so Messages is conversations alone
 *     and reads nothing from the Improve store.
 *
 * THIS MODULE IS THE MERGE, and it is pure on purpose. The ordering and the
 * filtering are the argument the screen makes, and a test should be able to
 * drive them with an array rather than a fetch and a database.
 *
 * ── Ordered by when something last happened ───────────────────────────
 *
 * Newest first. A row with no timestamp at all sorts last rather than
 * first: "we do not know when" is not "just now".
 */

export type InboxKind = 'person' | 'channel' | 'app';

export interface InboxEntry {
  /** Unique within the merged list; the kind is part of it because a
   *  conversation id and an app slug live in different namespaces. */
  key: string;
  kind: InboxKind;
  /** ISO, or null when the source has no clock (see the header). */
  at: string | null;
}

/**
 * An app's channel — its general discussion, `chat_messages` with a null
 * thread type. `channel` is its `#handle` (src/routes/messages-overview.js),
 * optional only because an older server did not send one.
 */
export interface AppDiscussion {
  slug: string;
  name: string;
  channel?: string;
  iconUrl: string | null;
  iconEmoji: string | null;
  lastMessage: string;
  lastAt: string | null;
  lastBy: string | null;
  /** #2967: one of Your apps, or another app the viewer has been active in. */
  section?: 'yours' | 'more';
  /** #2387: general-chat messages from others since the viewer last read it. */
  unreadCount?: number;
}

// ── The search above the list is remembered (#5459, 19 Oct 2026) ──────
//
// A person narrowed the list (to the changes waiting on them, while Messages
// listed changes), left, and came back: the search was gone and every row
// was back. The query is remembered per device in localStorage
// (`usernode:messages-query`), and read after mount through this helper. It is presentation, so it stays out of
// the route and the store — nothing else reads it, and the field itself is
// where the reason rows are missing shows. The helper rejects anything
// unusable, so a value storage holds that a person or an older version
// cannot have typed narrows nothing: not a string, empty, or past the cap,
// which keeps a pasted paragraph out of a device's storage rather than
// saving a cut-down copy. Clearing the search is remembered as cleared, by
// removing the key instead of storing ''.
export const INBOX_QUERY_MAX = 100;

/** Pure: the search to restore from a saved value, or '' when it is unusable. */
export function savedInboxQuery(raw: string | null | undefined): string {
  return typeof raw === 'string' && raw.length >= 1 && raw.length <= INBOX_QUERY_MAX ? raw : '';
}

function stamp(value: string | null | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
}

/** Newest first; a row with no clock last. Stable within a timestamp. */
function byClock(a: InboxEntry, b: InboxEntry): number {
  const diff = stamp(b.at) - stamp(a.at);
  return Number.isNaN(diff) ? 0 : diff;
}

/**
 * The conversations the list draws, newest first.
 *
 * The caller keeps its own array: this returns descriptors, not rows, so
 * each is still drawn by the component that knows how.
 *
 * #general and an app's channel are drawn on their communities' hubs, never
 * here, and #6019 sends the Homeroom bot's DM (`homeroomBot`, set by the
 * server) the same way: it is the AI tab, so its row is not in this list.
 */
export function buildInbox(input: {
  conversations: Array<{ id: number; lastActivityAt: string; kind?: string; homeroomBot?: boolean }>;
}): InboxEntry[] {
  const people: InboxEntry[] = [];
  for (const item of input.conversations) {
    // #general is the Homeroom community's channel, drawn on its hub; the
    // bot's chat is the AI tab.
    if (item.kind === 'channel' || item.homeroomBot) continue;
    people.push({ key: `person:${item.id}`, kind: 'person', at: item.lastActivityAt });
  }
  // Stable within a timestamp: `sort` is stable in every engine this ships
  // to, so two rows that happened in the same second keep the order the
  // server gave them.
  people.sort(byClock);
  return people;
}
