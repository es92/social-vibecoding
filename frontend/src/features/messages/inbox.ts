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
 * chat that has never been opened would otherwise lead the inbox.
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
 */

// `mayor` is an agent session (#2779): a conversation with the Mayor that
// works on any app, as opposed to `agent` (a Global Chat thread) and
// `session` (one change's classic dev chat).
export type InboxKind = 'person' | 'channel' | 'app' | 'agent' | 'session' | 'mayor';

/** Which part of the list an entry is drawn in. */
export type InboxSection = 'chats' | 'channels';

export interface InboxEntry {
  /** Unique within the merged list; the kind is part of it because a
   *  conversation id and an app slug live in different namespaces. */
  key: string;
  kind: InboxKind;
  section: InboxSection;
  /** ISO, or null when the source has no clock (see the header). */
  at: string | null;
  /** An app channel outside Your apps, folded behind "Show more" (#2967). */
  more?: boolean;
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

export interface AgentChat {
  id: string;
  title: string;
  busy?: boolean;
  summary?: string | null;
  updatedAt?: string | null;
  createdAt?: string | null;
}

/**
 * A change in flight — a dev session, or a work order handed to an agent
 * elsewhere (#2770).
 *
 * A CHANGE IS AN AGENT CONVERSATION: the viewer talks to the agent that
 * builds, the same as in an agent chat, so it is listed under Agents beside
 * them. The row is ../improve/session-row.tsx's, drawn from the Improve
 * store's own list, so this shape is only the part the merge needs — the
 * view carries the rest through untouched.
 */
export interface AgentSession {
  key: string;
  lastActivityAt?: string | null;
}

export type InboxFilter = 'all' | 'people' | 'channels' | 'agents';

/** The filter row, in order. Exported so the view and its test share one list. */
export const INBOX_FILTERS: ReadonlyArray<readonly [InboxFilter, string]> = [
  ['all', 'All'],
  ['people', 'People'],
  ['agents', 'Agents'],
];

/**
 * The shown entries as consecutive runs of one section, each with whether it
 * is headed. Exported and pure so the grouping is tested without a render.
 * Under a filter nothing is headed and the runs still split by section, so a
 * row never lands in another section's card.
 */
export function sectionRuns<T extends { section: InboxSection }>(entries: T[], headed: boolean) {
  const runs: Array<{ section: InboxSection; head: boolean; entries: T[] }> = [];
  for (const entry of entries) {
    const last = runs[runs.length - 1];
    if (last && last.section === entry.section) last.entries.push(entry);
    else runs.push({ section: entry.section, head: headed, entries: [entry] });
  }
  return runs;
}

/** Which kinds a filter admits. `all` admits every one. */
export function admits(filter: InboxFilter, kind: InboxKind): boolean {
  if (filter === 'all') return true;
  if (filter === 'people') return kind === 'person';
  // #general and the app channels are one section, and one filter (#2783).
  if (filter === 'channels') return kind === 'channel' || kind === 'app';
  // A session is an agent conversation (#2770), and so is a conversation
  // with the Mayor (#2779): Agents admits all three.
  return kind === 'agent' || kind === 'session' || kind === 'mayor';
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

/** B5: entries back in the order things happened, the bot's pin undone (search results). */
export function inClockOrder<T extends InboxEntry>(entries: T[]): T[] {
  return [...entries].sort(byClock);
}

/**
 * Merge the lists into one, filtered: the chats newest first, then the
 * channels — #general, then the app channels newest first.
 *
 * The caller keeps its own arrays — this returns descriptors, not rows, so
 * each kind is still drawn by the component that knows how, and each entry
 * says which section it belongs to so the view can head them.
 *
 * A conversation whose kind is `channel` (#general) is a channel, not a
 * person, however it arrived.
 *
 * #18 (WP3): the Homeroom bot's DM (`homeroomBot`, set by the server) is an
 * agent conversation, as a change is: Agents lists it and People does not.
 * It is still drawn as the DM it is (`kind: 'person'`), so only the filter
 * reads it differently.
 */
export function buildInbox(input: {
  conversations: Array<{ id: number; lastActivityAt: string; kind?: string; homeroomBot?: boolean }>;
  discussions: AppDiscussion[];
  agents: AgentChat[];
  /** Optional so a caller with no Improve store still merges three kinds. */
  sessions?: AgentSession[];
  /** Agent sessions (#2779), newest activity first like everything else. */
  mayors?: Array<{ id: number; lastActivityAt: string | null }>;
  filter: InboxFilter;
}): InboxEntry[] {
  const chats: InboxEntry[] = [];
  for (const item of input.conversations) {
    // #general is the Homeroom community's channel, drawn on its hub; and
    // an app's channel (`input.discussions`) is drawn on its own hub.
    if (item.kind === 'channel') continue;
    if (admits(input.filter, item.homeroomBot ? 'agent' : 'person')) {
      chats.push({ key: `person:${item.id}`, kind: 'person', section: 'chats', at: item.lastActivityAt });
    }
  }
  if (admits(input.filter, 'agent')) {
    for (const item of input.agents) {
      chats.push({
        key: `agent:${item.id}`,
        kind: 'agent',
        section: 'chats',
        at: item.updatedAt || item.createdAt || null,
      });
    }
  }
  if (admits(input.filter, 'session')) {
    for (const item of input.sessions || []) {
      chats.push({ key: `session:${item.key}`, kind: 'session', section: 'chats', at: item.lastActivityAt || null });
    }
  }
  if (admits(input.filter, 'mayor')) {
    for (const item of input.mayors || []) {
      chats.push({ key: `mayor:${item.id}`, kind: 'mayor', section: 'chats', at: item.lastActivityAt || null });
    }
  }
  // Stable within a timestamp: `sort` is stable in every engine this ships
  // to, so two rows that happened in the same second keep the order their
  // own source gave them — which for conversations is the server's.
  chats.sort(byClock);
  // B5: the Homeroom bot's DM is always the first row, whatever was said
  // last, on every filter that lists it. Not a general pin: it is the one
  // conversation everybody has with the platform itself.
  const bot = input.conversations.find((item) => item.homeroomBot && item.kind !== 'channel');
  const at = bot ? chats.findIndex((entry) => entry.key === `person:${bot.id}`) : -1;
  if (at > 0) chats.unshift(...chats.splice(at, 1));
  return chats;
}
