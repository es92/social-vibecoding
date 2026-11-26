/**
 * A project's PLACES (#4417), as keys and words.
 *
 * The page is navigated by one list: Hub, Needs you and Workshop, then its
 * channels — #general first, then each of its topics. Each entry is a PLACE
 * and has a key, which is what the page remembers, what its history entries
 * name and what `?ws=` links to:
 *
 *   status · needs · workshop   the three pages (Hub is `status`, as it was)
 *   discussion                  #general, the project's own channel
 *   c:<handle>                  a topic's channel (`c:onboarding`)
 *
 * and pages UNDER a place, which are not in the list: `all` (All items,
 * under the Workshop), `plan` (the first version's plan, under the Hub) and
 * `posts` (the Discussion whole, under the Hub: where a phone's Discussion
 * card opens, ./hub-discussion.tsx).
 *
 * A TOPIC is a lasting conversation about one part of the project, a channel
 * and a category at once. In the code it is a category with origin 'topic'
 * (the word "topic" already means one request or proposal here): the server
 * sends it as a PlaceChannel in the community record's `places`.
 *
 * Pure, so the tests drive it with plain objects.
 */

import { t as translate } from '../../../lib/i18n/runtime';
import type { PlaceChannel, PlacesPayload } from './community-card';

/** Every key the page can be on, places and the pages under them. */
export type PlaceKey = 'status' | 'discussion' | 'workshop' | 'needs' | 'all' | 'plan' | 'posts' | 'bot' | `c:${string}`;

/**
 * The three pages at the head of the list, in order. `label` is a message id
 * (frontend/locales/en/project.json), read when the list renders.
 */
export const PAGE_PLACES: ReadonlyArray<{ key: 'status' | 'needs' | 'workshop'; label: string }> = [
  { key: 'status', label: 'project:places.list.hub' },
  { key: 'needs', label: 'project:places.list.needsYou' },
  { key: 'workshop', label: 'project:places.list.workshop' },
];

// `bot`: Homeroom bot's slots, a page under the Workshop (./bot-slots.tsx).
// `posts`: the Discussion, #general as posts with replies
// (./hub-discussion.tsx): the place the list's Discussion row opens, where
// links to a #general message land. `discussion` is the same room as a chat
// ("Open as chat"), and lights the Discussion row.
const PAGE_KEYS = new Set(['status', 'discussion', 'workshop', 'needs', 'all', 'plan', 'posts', 'bot']);
/** A topic channel's handle, as dapp.json allows it (a letter first). */
const HANDLE_RE = /^[a-z][a-z0-9-]{0,39}$/;

/** The place key of a channel: `discussion` for #general, `c:<handle>` for a topic. */
export function channelPlace(handle: string | null | undefined): PlaceKey {
  const h = String(handle || '').trim().replace(/^#/, '').toLowerCase();
  if (!h || h === 'general') return 'discussion';
  return HANDLE_RE.test(h) ? `c:${h}` : 'discussion';
}

/** The channel handle a place key names, or null for a page. */
export function placeHandle(key: string | null | undefined): string | null {
  if (key === 'discussion') return 'general';
  if (typeof key === 'string' && key.startsWith('c:')) {
    const h = key.slice(2);
    return HANDLE_RE.test(h) ? h : null;
  }
  return null;
}

/** Whether `key` is a place (or a page under one) the page can show. */
export function isPlaceKey(key: unknown): key is PlaceKey {
  if (typeof key !== 'string') return false;
  if (PAGE_KEYS.has(key)) return true;
  return key.startsWith('c:') && placeHandle(key) !== null;
}

/** A channel place: #general or a topic's. */
export function isChannelPlace(key: string | null | undefined): boolean {
  return placeHandle(key) !== null;
}

/**
 * The place an entry in the list lights for `key`: All items and the bot's
 * slots light the Workshop, the plan the Hub, #general's chat the
 * Discussion (the same room, drawn as a chat), anything else itself.
 */
export function litPlace(key: PlaceKey): PlaceKey {
  if (key === 'all' || key === 'bot') return 'workshop';
  if (key === 'plan') return 'status';
  if (key === 'discussion') return 'posts';
  return key;
}

/** The project's channels, as its record sends them, or none. */
export function channelsOf(places: PlacesPayload | null | undefined): PlaceChannel[] {
  return places && Array.isArray(places.channels) ? places.channels : [];
}

/** The live topics, in dapp.json's order: what the list draws under Topics. */
export function liveTopics(places: PlacesPayload | null | undefined): PlaceChannel[] {
  return channelsOf(places).filter((c) => c.kind === 'topic' && c.state === 'live');
}

/**
 * The channel a handle names: #general, a topic by its handle, or one by a
 * handle it had before a rename. Retired topics too: their channels stay
 * readable. Null when nothing answers to it (or the record has not landed).
 */
export function findChannel(places: PlacesPayload | null | undefined, handle: string | null | undefined): PlaceChannel | null {
  const h = String(handle || '').trim().replace(/^#/, '').toLowerCase();
  if (!h) return null;
  const list = channelsOf(places);
  if (h === 'general') return list.find((c) => c.kind === 'general') || null;
  return list.find((c) => c.kind === 'topic' && c.handle === h)
    || list.find((c) => c.kind === 'topic' && Array.isArray(c.aliases) && c.aliases.includes(h))
    || null;
}

/** The topics merged into `topic`, oldest merge first: the cards its channel draws. */
export function mergedInto(places: PlacesPayload | null | undefined, topic: PlaceChannel | null): PlaceChannel[] {
  if (!topic || topic.kind !== 'topic' || !topic.key) return [];
  return channelsOf(places)
    .filter((c) => c.kind === 'topic' && c.state === 'merged' && c.merged_into === topic.key && !!c.merged_at)
    .sort((a, b) => Date.parse(a.merged_at || '') - Date.parse(b.merged_at || ''));
}

/** What a place is called on its own bar: the page's name, or the channel's handle. */
export function placeName(key: PlaceKey): string {
  if (key === 'status' || key === 'plan') return translate('project:places.bar.hub');
  if (key === 'posts') return translate('project:places.bar.discussion');
  if (key === 'needs') return translate('project:places.bar.needsYou');
  if (key === 'workshop' || key === 'all' || key === 'bot') return translate('project:places.bar.workshop');
  return placeHandle(key) || 'general';
}

/** Unread across the project's live channels: what the bar's dot says is waiting. */
export function unreadTotal(places: PlacesPayload | null | undefined): number {
  return channelsOf(places)
    .filter((c) => c.state === 'live')
    .reduce((n, c) => n + (Number(c.unread) > 0 ? Number(c.unread) : 0), 0);
}

/**
 * The address of a place a new tab can open. A channel has one of its own,
 * `/app/<slug>/dev/c/<handle>` (#general's is `/app/<slug>/dev/discussion`),
 * which the router turns into the page on that place; a page is the
 * project's own address with its `?ws=`.
 */
export function placeHref(slug: string, key: PlaceKey): string {
  const app = `/app/${encodeURIComponent(slug)}`;
  if (key === 'discussion') return `${app}/dev/discussion`;
  const handle = placeHandle(key);
  if (handle) return `${app}/dev/c/${handle}`;
  // The Hub has its own address (App._placeAddress): a bare /workshop opens
  // the Workshop.
  return key === 'status' ? `${app}/dev/hub` : `${app}/workshop?ws=${encodeURIComponent(key)}`;
}

/**
 * Every handle a `#name` in this project's chat can mean a topic by — its
 * handle, and the ones it had before a rename — to the handle it has now.
 * Retired topics too: a link to one opens its channel, read only. #general
 * is not here: it is one of the platform's own channels.
 */
export function topicHandleMap(places: PlacesPayload | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const topics = channelsOf(places).filter((c) => c.kind === 'topic' && HANDLE_RE.test(c.handle));
  // Aliases first, so a handle in use now always wins over one a topic left.
  for (const t of topics) for (const a of Array.isArray(t.aliases) ? t.aliases : []) {
    if (HANDLE_RE.test(a)) out[a] = t.handle;
  }
  for (const t of topics) out[t.handle] = t.handle;
  return out;
}
