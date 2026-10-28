/**
 * One inbox out of three lists (#2718).
 *
 * ── What changed, and why here ────────────────────────────────────────
 *
 * Messages was the `conversations` domain and nothing else: people talking
 * to people. Two other kinds of thread existed and were reachable only from
 * inside the thing they belonged to — an app's own discussion, which lived
 * on that app's board, and an agent chat, which lived in the Improve panel's
 * list. Neither was findable from a screen called Messages, which is the one
 * screen somebody looking for "what was said to me" opens.
 *
 * The navigation change makes Messages the platform's one inbox, which is
 * what every host in the study does: Slack and Teams put a channel, a DM and
 * a bot thread in one sidebar and tell them apart with a mark rather than
 * with three sidebars.
 *
 * THIS MODULE IS THE MERGE, and it is pure on purpose. The ordering and the
 * filtering are the argument the screen makes, and a test should be able to
 * drive them with three arrays rather than three fetches and a database.
 *
 * ── Ordered by when something last happened ───────────────────────────
 *
 * One clock for all three, because an inbox sorted per-kind is three lists
 * stacked rather than one list. A row with no timestamp at all sorts last
 * rather than first: "we do not know when" is not "just now", and an agent
 * session that has never been opened would otherwise lead the inbox.
 *
 * ── Channels live in their communities now ────────────────────────────
 *
 * Messages is PEOPLE AND AGENTS. The channels — #general and one per app —
 * were a second section here (#2783, below), and they moved to the hub of
 * the community each belongs to (features/dev-board/workshop/hub-cards.tsx);
 * #general is the Homeroom community's. So the merge below draws the chats
 * section alone, and the Channels filter is gone with the section. A
 * channel keeps its address (`#messages/app/<slug>`, `#messages/<id>` for
 * #general), and opening one lights Communities rather than Messages.
 *
 * ── Two sections, Discord's (#2783, retired) ──────────────────────────
 *
 * The clock still orders the TOP of the list — direct messages, group chats
 * and agents, which are the threads a person is IN — but the channels come
 * after them as their own section: #general first, which every user is in,
 * then one channel per app the viewer is a member of. A channel is a room
 * you visit, not a conversation waiting on you, so it does not jump over a
 * DM because somebody said something in it. Within the section the clock
 * orders the app channels, and one nobody has spoken in sits at the end.
 *
 * ── Your apps first, the rest behind "Show more" (#2967) ──────────────
 *
 * The app channels split in two, the way Home's own list does: YOUR apps —
 * the ones you are a member of and have not hidden, and the ones you added —
 * and then every other app you have been active in (posted or reacted in its
 * chat, voted, proposed, filed a request). The server says which is which
 * (`section` on each row, src/routes/messages-overview.js); the second group
 * is marked `more` here and the view folds it behind "Show N more". A server
 * that sends no section is an older one whose rows are all member apps, so
 * they are all yours, in the order they always had.
 *
 * ── Three sections: Homeroom bot, Agents, People (16 Oct 2026) ────────
 *
 * One clock put the bot's news, an agent turning, and a person's message in
 * one queue, so a person was easily three screens down under bot news. The
 * list is three headed sections now, in a fixed order: the Homeroom bot's
 * chat (always first, as B5 pinned it), then Agents (the agent sessions
 * and the changes in flight), then People (direct messages
 * and group chats). Each is newest first on its own clock. The filter chips
 * (All, People, Agents) went with it: the headings say which is which, and
 * a section folds from its heading (./index.tsx).
 *
 * ── The bot leads Agents; Agents shows its week (16 Oct 2026) ─────────
 *
 * The Homeroom bot is an agent too, so it is Agents' first row rather than
 * a section of its own: pinned there, never folded away, so Agents is never
 * an empty heading. Under it Agents shows at most AGENTS_SHOWN of what was
 * active in the last AGENTS_RECENT_DAYS days, newest first, and whatever
 * asks for you or is open; the rest wait behind "N older chats".
 */

// `mayor` is an agent session (#2779): a conversation with the Mayor that
// works on any app, as opposed to `session` (one change's classic dev chat).
export type InboxKind = 'person' | 'channel' | 'app' | 'session' | 'mayor';

/** Which section of the list an entry is drawn in, in the order they are drawn. */
export type InboxSection = 'agents' | 'people';

/** The sections, in order. Exported so the view and its test share one list. */
export const INBOX_SECTIONS: ReadonlyArray<InboxSection> = ['agents', 'people'];

export interface InboxEntry {
  /** Unique within the merged list; the kind is part of it because a
   *  conversation id and an app slug live in different namespaces. */
  key: string;
  kind: InboxKind;
  section: InboxSection;
  /** ISO, or null when the source has no clock (see the header). */
  at: string | null;
  /** The Homeroom bot's chat: first in Agents, and always drawn. */
  pinned?: boolean;
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

/**
 * A change in flight — a dev session, or a work order handed to an agent
 * elsewhere (#2770).
 *
 * A CHANGE IS AN AGENT CONVERSATION: the viewer talks to the agent that
 * builds, the same as in an agent session, so it is listed under Agents
 * beside them. The row is ../improve/session-row.tsx's, drawn from the Improve
 * store's own list, so this shape is only the part the merge needs — the
 * view carries the rest through untouched.
 */
export interface AgentSession {
  key: string;
  lastActivityAt?: string | null;
}

/**
 * Agents shows at most five of what was active this week (16 Oct 2026): the
 * agent sessions pile up (one per thing somebody started). The week keeps a
 * quiet one from padding the list with chats nobody has touched in a
 * month; the five keep a busy one from pushing People down.
 */
export const AGENTS_RECENT_DAYS = 7;
export const AGENTS_SHOWN = 5;
const RECENT_MS = AGENTS_RECENT_DAYS * 24 * 60 * 60 * 1000;

// ── The search above the list is remembered (#5459, 19 Oct 2026) ──────
//
// A daily voter narrows the list to the changes waiting on them, leaves to
// vote, and comes back: until now the search was gone and every row was
// back. The query is remembered per device in localStorage
// (`usernode:messages-query`), the way the folded sections are, and read
// after mount through this helper. It is presentation, so it stays out of
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

/**
 * The shown entries as consecutive runs of one section, in the order given.
 * Exported and pure so the grouping is tested without a render.
 */
export function sectionRuns<T extends { section: InboxSection }>(entries: T[]) {
  const runs: Array<{ section: InboxSection; entries: T[] }> = [];
  for (const entry of entries) {
    const last = runs[runs.length - 1];
    if (last && last.section === entry.section) last.entries.push(entry);
    else runs.push({ section: entry.section, entries: [entry] });
  }
  return runs;
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
 * Merge the lists into one, in two sections: Agents, the Homeroom bot's
 * chat first, then People, each newest first.
 *
 * The caller keeps its own arrays — this returns descriptors, not rows, so
 * each kind is still drawn by the component that knows how, and each entry
 * says which section it belongs to so the view can head them.
 *
 * #general and an app's channel are drawn on their communities' hubs, never
 * here. #18 (WP3): the Homeroom bot's DM (`homeroomBot`, set by the server)
 * is drawn as the DM it is (`kind: 'person'`), pinned first in Agents.
 */
export function buildInbox(input: {
  conversations: Array<{ id: number; lastActivityAt: string; kind?: string; homeroomBot?: boolean }>;
  /** Optional so a caller with no Improve store still merges the others. */
  sessions?: AgentSession[];
  /** Agent sessions (#2779), newest activity first like everything else. */
  mayors?: Array<{ id: number; lastActivityAt: string | null }>;
}): InboxEntry[] {
  const bot: InboxEntry[] = [];
  const agents: InboxEntry[] = [];
  const people: InboxEntry[] = [];
  for (const item of input.conversations) {
    // #general is the Homeroom community's channel, drawn on its hub.
    if (item.kind === 'channel') continue;
    const key = `person:${item.id}`;
    const entry: InboxEntry = item.homeroomBot
      ? { key, kind: 'person', section: 'agents', at: item.lastActivityAt, pinned: true }
      : { key, kind: 'person', section: 'people', at: item.lastActivityAt };
    (item.homeroomBot ? bot : people).push(entry);
  }
  for (const item of input.sessions || []) {
    agents.push({ key: `session:${item.key}`, kind: 'session', section: 'agents', at: item.lastActivityAt || null });
  }
  for (const item of input.mayors || []) {
    agents.push({ key: `mayor:${item.id}`, kind: 'mayor', section: 'agents', at: item.lastActivityAt || null });
  }
  // Stable within a timestamp: `sort` is stable in every engine this ships
  // to, so two rows that happened in the same second keep the order their
  // own source gave them — which for conversations is the server's.
  agents.sort(byClock);
  people.sort(byClock);
  return [...bot, ...agents, ...people];
}

/**
 * Which of a section's entries are drawn. A folded section draws its pinned
 * row alone (the bot's, in Agents). Agents draws the pinned row, the newest
 * AGENTS_SHOWN of what was active in the last AGENTS_RECENT_DAYS days, the
 * open one wherever it sits, and every one `keep` names (a change waiting on
 * you, an agent at work: nothing that asks for you is folded away). The
 * rest are `older`:
 * counted for the "N older chats" link, and drawn below it, in `olderShown`,
 * once it is pressed, so the link stays where it was and marks where this
 * week ends. A search draws every match, and People all of its rows. Pure.
 */
export function shownInSection<T extends InboxEntry>(section: InboxSection, entries: T[], {
  expanded = false, searching = false, folded = false, openKey = null, keep = null, now = Date.now(),
}: {
  expanded?: boolean;
  searching?: boolean;
  folded?: boolean;
  openKey?: string | null;
  keep?: ((entry: T) => boolean) | null;
  now?: number;
} = {}): { shown: T[]; older: number; olderShown: T[] } {
  if (searching) return { shown: entries, older: 0, olderShown: [] };
  if (folded) return { shown: entries.filter((entry) => entry.pinned), older: 0, olderShown: [] };
  if (section !== 'agents') return { shown: entries, older: 0, olderShown: [] };
  const shown: T[] = [];
  const older: T[] = [];
  let slots = AGENTS_SHOWN;
  for (const entry of entries) {
    // The bot's row is drawn whatever its age and takes none of the five.
    const thisWeek = !entry.pinned && now - stamp(entry.at) <= RECENT_MS && slots > 0;
    if (thisWeek) slots -= 1;
    if (entry.pinned || thisWeek || entry.key === openKey || keep?.(entry)) shown.push(entry);
    else older.push(entry);
  }
  return { shown, older: older.length, olderShown: expanded ? older : [] };
}
