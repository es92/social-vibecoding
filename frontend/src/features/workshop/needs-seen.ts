/**
 * THE VOTES YOU HAVE ALREADY PASSED OVER (#3526).
 *
 * Every badge that says how many votes wait on you (a project's Needs you
 * tab, its hub card, the Communities tab and its switcher, the Communities
 * list's rows and its Needs you row, the app menu's Workshop row) counted
 * every vote owed, whether or not you had looked at it. So a feed you had
 * swiped all the way through still said 12, and the only way to quiet the
 * number was to vote on everything, which is not what the number is for: it
 * says what is NEW for you, the way an unread count does.
 *
 * A vote you swipe past without answering is SEEN now: this device remembers
 * it, and every one of those counts leaves it out. It stays in the feed, in
 * its place, and can still be voted on; nothing is sent anywhere and nothing
 * about the vote changes.
 *
 * ── What one entry names ───────────────────────────────────────────────
 *
 * A vote by its kind and id (`proposal:12`, `governance:4`) and, for a
 * change, the APPROVAL EPOCH it was seen at (`proposal:12@3`). The epoch
 * moves when somebody writes bytes nobody approved (#2038), which is when the
 * server stops counting earlier votes on it too, so a change that moved
 * under you counts again, and so does anything new. Where one side of a
 * comparison has no epoch (a row that was built without one) the id alone
 * decides, rather than a seen change counting twice over a missing number.
 *
 * ── Where the counts come from ─────────────────────────────────────────
 *
 * A project's page has its queue, so it knows which votes it is counting.
 * The server's per-project numbers (GET /api/workshop/counts) say which as
 * well since this: each project's `owed` lists the same keys, and
 * `unseenNeeds` takes the seen ones off its `needs`. A count with no list
 * (an older server, a ?demo=1 row without one) is left whole: a number this
 * cannot check is never lowered on a guess.
 *
 * ── The record ─────────────────────────────────────────────────────────
 *
 * localStorage, per device and per account (`needsSeen:v1:<user id>`), read
 * after the first paint and wrapped like every other reading position here
 * (`workshopSeen`, `sinceSummaryDismissed`): private mode or a full quota is
 * a count that is not lowered, never an error. Bounded by age and size, and
 * never pruned against a count: an entry nothing owes any more matches
 * nothing, so it cannot take anything off. Following you to another device
 * would need a table of its own; that is a later step.
 *
 * ── Where the feed opens (#4753) ───────────────────────────────────────
 *
 * The same record also says where Needs you OPENS when you come back to it:
 * `firstUnseenIndex` finds the first row of the feed you have not already
 * passed over or answered, and the feed lands there instead of on the first
 * one. Rows before it are seen rows, still in place and still votable by
 * swiping back; rows that are not votes are never recorded, so they always
 * count as not seen and the feed can stop at one.
 */

import { useEffect } from 'react';

import { createStore } from '../../lib/plain-store.js';
import { useStoreState } from '../../lib/use-store-state';

export const NEEDS_SEEN_KEY = 'needsSeen:v1';
/** How many entries one account keeps, newest first, and for how long. */
export const NEEDS_SEEN_MAX = 500;
export const NEEDS_SEEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** One vote seen: its epoch then (null when the row had none), and when. */
type Seen = { e: number | null; t: number };
/** By project, then by vote (`proposal:12`, `governance:4`). */
type SeenMap = Record<string, Record<string, Seen>>;

export interface NeedsSeenState {
  /** Whose record this is, so a shared device keeps two. */
  owner: string;
  seen: SeenMap;
}

export const needsSeenStore = createStore<NeedsSeenState>({ owner: '', seen: {} });

/** The key a vote is remembered by. See the header. */
export function needsKey(kind: string, id: number | string, epoch?: number | null): string {
  const k = kind === 'governance' || kind === 'gov' ? 'governance' : 'proposal';
  return k === 'proposal' && epoch != null && Number.isFinite(Number(epoch)) ? `${k}:${id}@${Number(epoch)}` : `${k}:${id}`;
}

/** `proposal:12@3` → the vote and its epoch. */
function parse(key: string): { id: string; e: number | null } {
  const at = key.lastIndexOf('@');
  if (at < 0) return { id: key, e: null };
  const e = Number(key.slice(at + 1));
  return { id: key.slice(0, at), e: Number.isFinite(e) ? e : null };
}

type RowLike = {
  kind?: string;
  askAbout?: { kind: string; ref: number | string } | null;
  yes?: { act?: { args?: unknown[] } | null } | null;
};

/**
 * A Needs you row's key: the vote its ask box is addressed to, and the epoch
 * its Yes carries (castVote's third argument). Null for anything that is not
 * a vote, which no badge counts.
 */
export function needsRowKey(row: RowLike | null | undefined): string | null {
  if (!row || row.kind !== 'vote' || !row.askAbout || row.askAbout.ref == null) return null;
  const args = row.yes && row.yes.act && Array.isArray(row.yes.act.args) ? row.yes.act.args : [];
  const epoch = typeof args[2] === 'number' ? args[2] : null;
  return needsKey(row.askAbout.kind, row.askAbout.ref, epoch);
}

function viewer(): string {
  try {
    const id = (window as unknown as { App?: { user?: { id?: unknown } } }).App?.user?.id;
    return id == null || id === '' ? '' : String(id);
  } catch {
    return '';
  }
}

function storageKey(owner: string): string {
  return `${NEEDS_SEEN_KEY}:${owner}`;
}

/** Old entries off, then the oldest past the cap. */
function trim(seen: SeenMap, now: number): SeenMap {
  const all: Array<[string, string, Seen]> = [];
  for (const [slug, votes] of Object.entries(seen)) {
    for (const [id, s] of Object.entries(votes || {})) {
      if (s && typeof s.t === 'number' && now - s.t < NEEDS_SEEN_TTL_MS) all.push([slug, id, s]);
    }
  }
  all.sort((a, b) => b[2].t - a[2].t);
  const out: SeenMap = {};
  for (const [slug, id, s] of all.slice(0, NEEDS_SEEN_MAX)) (out[slug] ||= {})[id] = s;
  return out;
}

/**
 * Read this account's record, once per account: after the first paint (the
 * hook's effect) or the first time a count is worked out outside React.
 */
export function hydrateNeedsSeen(): void {
  if (typeof window === 'undefined') return;
  const owner = viewer();
  if (needsSeenStore.get().owner === owner) return;
  let seen: SeenMap = {};
  if (owner) {
    try {
      const raw = JSON.parse(window.localStorage.getItem(storageKey(owner)) || 'null');
      if (raw && typeof raw === 'object') seen = trim(raw as SeenMap, Date.now());
    } catch { /* nothing kept: every vote counts, as before */ }
  }
  needsSeenStore.set({ owner, seen });
}

function seenEntry(slug: string, key: string): boolean {
  const votes = needsSeenStore.get().seen[slug];
  if (!votes) return false;
  const { id, e } = parse(key);
  const s = votes[id];
  return !!s && (s.e == null || e == null || s.e === e);
}

/** Whether this vote, as it stands now, was passed over here. */
export function isNeedsSeen(slug: string | null | undefined, key: string | null | undefined): boolean {
  return !!slug && !!key && seenEntry(slug, key);
}

/**
 * The row of `rows` the feed opens on (#4753): the FIRST one you have not
 * already passed over or answered here, this account on this device. A row
 * that is not a vote has a null key, which is never recorded as seen, so the
 * scan always stops at one of those. Every row seen — or the list empty — is
 * index 0: the feed opens on the first item, as it does with nothing seen.
 * `slugOf` names each row's project, which is the row's own on the
 * Communities reel and the page's inside a project. Reads the record after
 * the first paint: call it from an effect, never during render.
 */
export function firstUnseenIndex<Row extends RowLike>(
  rows: readonly Row[],
  slugOf: (row: Row) => string | null | undefined,
): number {
  hydrateNeedsSeen();
  for (let idx = 0; idx < rows.length; idx++) {
    if (!isNeedsSeen(slugOf(rows[idx]), needsRowKey(rows[idx]))) return idx;
  }
  return 0;
}

/** Remember a vote passed over. A no-op for one already remembered as it is. */
export function markNeedsSeen(slug: string | null | undefined, key: string | null | undefined): void {
  if (!slug || !key || typeof window === 'undefined') return;
  hydrateNeedsSeen();
  const { owner, seen } = needsSeenStore.get();
  if (!owner) return;
  const { id, e } = parse(key);
  const had = seen[slug] && seen[slug][id];
  if (had && had.e === e) return;
  const next = trim({ ...seen, [slug]: { ...(seen[slug] || {}), [id]: { e, t: Date.now() } } }, Date.now());
  needsSeenStore.set({ seen: next });
  try {
    window.localStorage.setItem(storageKey(owner), JSON.stringify(next));
  } catch { /* private mode: seen for this page only */ }
}

/**
 * A count of votes owed, less the ones among `owed` passed over here. With no
 * list to check against, the count stands.
 */
export function unseenNeeds(slug: string, count: number, owed?: readonly string[] | null): number {
  const n = Math.max(0, Number(count) || 0);
  if (!owed || !owed.length) return n;
  const seen = owed.filter((key) => seenEntry(slug, key)).length;
  return Math.max(0, n - seen);
}

/**
 * The record, for a component whose count reads it: re-renders when a vote
 * is passed over anywhere on the page, and reads the record after the first
 * paint rather than during it (the island rule).
 */
export function useNeedsSeen(): NeedsSeenState {
  useEffect(() => { hydrateNeedsSeen(); }, []);
  return useStoreState(needsSeenStore);
}
