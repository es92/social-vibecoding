/**
 * The community the Communities tab is on, and the switcher that changes it.
 *
 * ── What the tab is ────────────────────────────────────────────────────
 *
 * The fourth tab is the community you are in: its tile in a square ring and
 * how many votes it is waiting on you for, under the word Communities, which
 * it keeps wherever it is (#3709). With none chosen it is All communities, a
 * dark tile in the same ring, and its page is the list of every community you
 * are in.
 *
 * WHICH ONE is the router's answer, not a second memory: the tab already
 * reopens the project page you left (App._noteWorkshopView keeps it in
 * localStorage, App._forgetWorkshopView drops it when the list is shown), so
 * the scope is that same slug. app.js tells this store when either happens
 * (`setScope`), and on a cold load `hydrate()` reads the same key.
 *
 * WHAT IT LOOKS LIKE is described by whoever knows: a project page publishes
 * its own name, icon, colour and votes owed (`describe`), and the switcher's
 * read of every community fills in the rest. The chosen community's
 * description is kept beside the key, so the tab draws its tile on a cold
 * load without waiting for a read.
 *
 * THE VOTES OWED ARE THE ONES YOU HAVE NOT PASSED OVER (#3526). Both
 * describers hand in every vote owed (`owedCount`) and which ones (`owed`),
 * and `needs`, the number the tab's badge and the switcher draw, is worked
 * out here from those and ./needs-seen.ts: again whenever a vote is swiped
 * past anywhere on the page, so the badge drops as you go. A vote the server
 * SAVED anywhere (../dev-board/card/cards-store.ts voteSavedStore) leaves
 * them too, the moment it lands (#5468): the feed's card says "Voted yes"
 * at once, so the tab, the switcher and the sidebar's counts agree with it
 * instead of waiting for the next read, which is throttled to thirty seconds
 * and can be served from the service worker's cache.
 *
 * AND ONLY A COMMUNITY THAT IS YOURS PUTS THEM ON THE TAB (5 Oct 2026). One
 * you are in only because every account is, Homeroom, and have not taken
 * part in yet is UNCHOSEN (`unchosen`, from GET /api/workshop/counts): its
 * votes stay in `needs` and the switcher, and `tabVotes` leaves them off the
 * badge.
 *
 * ── The switcher ───────────────────────────────────────────────────────
 *
 * "Your communities": a search over every community you are in, then the
 * ones you use (Recent), then All communities, then "Join a community" and
 * "Start a community" (#5290). It opens from the community's name and ⌄
 * in the coloured header, from the header's "Communities ⌄" on the
 * Communities list and from ⌘K anywhere (./community-shortcut.ts) (the tab pressed while it is lit goes up a level instead,
 * ./tab-ladder.ts; held, it opens nothing since 18 Oct 2026).
 * `openSwitcher(from)` says where, so a wide window can hang the menu off
 * whatever opened it.
 *
 * ── Island rules ───────────────────────────────────────────────────────
 *
 * The store starts empty, which is what the prerendered tab bar draws (the
 * plain Communities tab), so hydration matches. What this device kept (the
 * community the tab is on, and the list of the viewer's communities) is
 * applied in the same task as hydration, before the first paint
 * (`hydrateCommunityScope`: from the tab bar's effect, which is flushed with
 * the hydration, and from lib/shell-snapshot-apply.ts once the viewer is
 * named); the rest arrives from effects and from app.js.
 */

import { createStore } from '../../lib/plain-store.js';
import { voteSavedStore } from '../dev-board/card/cards-store';
import { landKeepingPlace } from '../dev-board/workshop/place-store';
import { navStore } from '../nav/nav-store.js';
import { hydrateNeedsSeen, needsSeenStore, unseenNeeds } from './needs-seen';
import { orderRows } from './sections';

export interface CommunityInfo {
  slug: string;
  name: string;
  iconUrl: string | null;
  iconEmoji: string | null;
  /** What dapp.json set (`icon.color`), if anything. */
  iconColor: string | null;
  audience?: 'open' | 'invited' | 'solo' | string;
  memberCount?: number;
  /**
   * Votes owed by the viewer here that they have not already passed over
   * (#3526): `owedCount` less the seen ones among `owed`. Worked out by
   * `derive`, never handed in.
   */
  needs?: number;
  /** Every vote owed here, seen or not. */
  owedCount?: number;
  /** Which ones, as ./needs-seen.ts keys them, when the describer knows. */
  owed?: string[];
  /**
   * Its votes do not put a number on the tab (5 Oct 2026): you are in it
   * only because every account is (Homeroom) and have not taken part there
   * yet. GET /api/workshop/counts says so (src/services/communities.js,
   * UNCHOSEN_COMMUNITIES_SQL). `needs` still counts them, for the switcher.
   */
  unchosen?: boolean;
  selfHosted?: boolean;
  lastActiveAt?: string | null;
}

/**
 * Where the switcher was opened from: the header (the phone's held tab no
 * longer opens it), or ⌘K (./community-shortcut.ts, #5290), which opens it
 * with its search focused.
 */
export type SwitcherFrom = 'header' | 'shortcut';

export interface CommunityScopeState {
  /** The community the tab is on, or null for All communities. */
  slug: string | null;
  /** What is known about each community, by slug. */
  info: Record<string, CommunityInfo>;
  /** Every community you are in, in the switcher's order, once read. */
  list: string[] | null;
  /** Votes owed across all of them, once counted. */
  totalNeeds: number | null;
  /**
   * The ones of those that ask for you: every community's but the unchosen
   * ones'. The tab's badge on All communities (`tabVotes`).
   */
  badgeNeeds: number | null;
  /** Where the open switcher was opened from; null when it is shut. */
  switcher: SwitcherFrom | null;
  /** The opener's box, for a menu that hangs off it on a wide window. */
  anchor: { top: number; left: number; right: number; bottom: number } | null;
}

const INITIAL: CommunityScopeState = {
  slug: null, info: {}, list: null, totalNeeds: null, badgeNeeds: null, switcher: null, anchor: null,
};

export const communityScopeStore = createStore(INITIAL);

/**
 * The two sums over every community you are in: every vote owed, which the
 * switcher's All communities line says, and the votes that ask for you,
 * which leave the unchosen communities out and are the tab's badge.
 */
function sums(list: string[], info: Record<string, CommunityInfo>): { totalNeeds: number; badgeNeeds: number } {
  let totalNeeds = 0;
  let badgeNeeds = 0;
  for (const s of list) {
    totalNeeds += Number(info[s]?.needs) || 0;
    badgeNeeds += votesWaiting(info[s]);
  }
  return { totalNeeds, badgeNeeds };
}

/**
 * THE ONE COUNT OF VOTES WAITING ON YOU (#5296), for one community: the
 * votes it owes you that you have not passed over or already cast (`needs`),
 * and none at all while it is UNCHOSEN (see `tabVotes`). The tab's badge, its
 * sum on All communities, and All communities' own "N votes waiting on you"
 * and each row's "N to vote" (./index.tsx `unseenRow`) all read it, so the
 * tab and the page can no longer say 13 and 14 for the same votes.
 */
export function votesWaiting(entry: { needs?: number; unchosen?: boolean } | null | undefined): number {
  return entry && !entry.unchosen ? Number(entry.needs) || 0 : 0;
}

/**
 * THE NUMBER ON THE TAB: the votes the community it is on is waiting on you
 * for, or on All communities the votes every community is. An UNCHOSEN
 * community's votes are left out of it (5 Oct 2026): the platform's own
 * community, which every account is put in, asked a brand-new account for
 * five or eight votes on the screen that asks what it wants to make. They
 * are still owed, and still in Needs you, the Communities list and the
 * switcher: they just do not summon anybody until the community is theirs.
 */
export function tabVotes(st: Pick<CommunityScopeState, 'slug' | 'info' | 'badgeNeeds'>): number {
  if (st.slug) return votesWaiting(st.info[st.slug]);
  return Number(st.badgeNeeds) || 0;
}

/**
 * GET /api/workshop/counts, read by All communities (./index.tsx), handed in
 * here too (#5296): the page and the tab then count from the same answer, so
 * a vote that lands while the page is open moves both at once rather than
 * the tab trailing by up to thirty seconds. Only the communities already
 * listed are touched; until the list is read there is nothing to sum.
 */
export function takeCounts(counts: Record<string, { needs?: number; owed?: unknown; unchosen?: boolean } | undefined>): void {
  const cur = communityScopeStore.get();
  if (!cur.list || !counts || typeof counts !== 'object') return;
  const info = { ...cur.info };
  for (const slug of cur.list) {
    const prev = info[slug];
    if (!prev) continue;
    const c = counts[slug];
    const owed = c?.owed;
    info[slug] = derive({
      ...prev,
      owedCount: Number(c?.needs) || 0,
      owed: Array.isArray(owed) ? owed.map(String) : undefined,
      unchosen: c?.unchosen === true,
    });
  }
  communityScopeStore.set({ info, ...sums(cur.list, info) });
  if (cur.slug && info[cur.slug]) saveInfo(info[cur.slug]);
}

/** app.js's own key for the project page the tab reopens. */
const VIEW_KEY = 'usernode_workshop_view_v1';
/** The chosen community's description, kept for a cold paint. */
const INFO_KEY = 'communityScopeInfo:v1';

function readViewSlug(): string | null {
  try {
    const v = JSON.parse(window.localStorage.getItem(VIEW_KEY) || 'null');
    return v && typeof v.slug === 'string' && v.slug ? v.slug : null;
  } catch {
    return null;
  }
}

function saveInfo(info: CommunityInfo | null): void {
  try {
    if (info) window.localStorage.setItem(INFO_KEY, JSON.stringify(info));
    else window.localStorage.removeItem(INFO_KEY);
  } catch { /* a cold paint without the tile is the old behaviour */ }
}

/**
 * THE LIST OF YOUR COMMUNITIES as this device last read it, for whom, so a
 * cold paint can draw the desktop sidebar's rows (../nav/rail-communities.tsx)
 * and its "All 31 communities" count at once instead of 185px of rows
 * arriving under the page after GET /api/apps. Names and tiles only: the
 * votes owed are not kept, so a number is never shown before it is read.
 * Written for one viewer, and read back for that viewer alone.
 */
const LIST_KEY = 'communityScopeList:v1';

/** What a kept entry carries: what the row draws, nothing counted. */
function keptInfo(info: CommunityInfo): CommunityInfo {
  return {
    slug: info.slug,
    name: info.name,
    iconUrl: info.iconUrl ?? null,
    iconEmoji: info.iconEmoji ?? null,
    iconColor: info.iconColor ?? null,
    audience: info.audience,
    memberCount: info.memberCount,
    selfHosted: info.selfHosted,
    lastActiveAt: info.lastActiveAt ?? null,
  };
}

function saveList(viewer: string | null, list: string[], info: Record<string, CommunityInfo>): void {
  if (!viewer) return;
  try {
    const kept: Record<string, CommunityInfo> = {};
    for (const s of list) if (info[s]) kept[s] = keptInfo(info[s]);
    window.localStorage.setItem(LIST_KEY, JSON.stringify({ viewer, list, info: kept }));
  } catch { /* the rows arrive with the read, as they used to */ }
}

function readList(viewer: string | null): { list: string[]; info: Record<string, CommunityInfo> } | null {
  if (!viewer) return null;
  try {
    const raw = JSON.parse(window.localStorage.getItem(LIST_KEY) || 'null');
    if (!raw || raw.viewer !== viewer || !Array.isArray(raw.list) || !raw.info || typeof raw.info !== 'object') return null;
    const list = raw.list.filter((s: unknown): s is string => typeof s === 'string' && !!raw.info[s]
      && typeof raw.info[s].slug === 'string');
    const info: Record<string, CommunityInfo> = {};
    for (const s of list) info[s] = keptInfo(raw.info[s] as CommunityInfo);
    return { list, info };
  } catch {
    return null;
  }
}

let hydrated = false;
let listHydratedFor: string | null = null;
/**
 * Read what the last visit left: once, the community the tab is on and its
 * description; and once per viewer named, the list of their communities.
 * Both run in the same task as hydration and before the first paint: the tab
 * bar's own effect is flushed with the hydration itself, which names nobody
 * yet, and lib/shell-snapshot-apply.ts applyNavSnapshot calls again with the
 * session snapshot's viewer right after.
 */
export function hydrateCommunityScope(viewer: string | null = null): void {
  if (typeof window === 'undefined') return;
  const cur = communityScopeStore.get();
  let slug = cur.slug;
  let info = cur.info;
  if (!hydrated) {
    hydrated = true;
    const viewSlug = readViewSlug();
    let described: CommunityInfo | null = null;
    try {
      const raw = JSON.parse(window.localStorage.getItem(INFO_KEY) || 'null');
      if (raw && typeof raw.slug === 'string') described = raw as CommunityInfo;
    } catch { /* nothing kept */ }
    slug = cur.slug || viewSlug;
    if (described && viewSlug && described.slug === viewSlug && !cur.info[viewSlug]) {
      info = { ...info, [viewSlug]: described };
    }
  }
  let list: string[] | null = null;
  if (viewer && listHydratedFor !== viewer && !cur.list) {
    listHydratedFor = viewer;
    const kept = readList(viewer);
    // What anybody has said since wins over the kept copy: a describer, or
    // the chosen community's own description, votes and all.
    if (kept) { info = { ...kept.info, ...info }; list = kept.list; }
  }
  communityScopeStore.set({ slug, info, ...(list ? { list } : {}) });
}

/** The router's word: the tab is now on `slug`, or on All communities. */
export function setScope(slug: string | null): void {
  const cur = communityScopeStore.get();
  if (cur.slug === slug) return;
  communityScopeStore.set({ slug });
  saveInfo(slug ? cur.info[slug] || null : null);
}

/**
 * The keys of `owed` a vote the server SAVED (cards-store.ts voteSavedStore)
 * has already answered (#5468), matched the way `savedVoteFor` matches a
 * card: a `proposal:<id>` or `proposal:<id>@<epoch>` key is answered when a
 * saved vote names its session id, and where either side has no epoch the id
 * alone decides — a different epoch is the change moved under the vote,
 * asking again. A `governance:` key is a group decision, which no saved vote
 * here answers.
 */
export function owedLessSaved(
  owed: readonly string[],
  saved: Record<string, { epoch: number | null }>,
): string[] {
  return owed.filter((key) => {
    if (!key.startsWith('proposal:')) return true;
    const at = key.indexOf('@');
    const id = key.slice('proposal:'.length, at < 0 ? key.length : at);
    const entry = saved[id];
    if (!entry) return true;
    const raw = at < 0 ? '' : key.slice(at + 1);
    const keyEpoch = raw === '' ? null : Number(raw);
    const savedEpoch = entry.epoch == null ? null : Number(entry.epoch);
    return !(keyEpoch == null || savedEpoch == null || keyEpoch === savedEpoch);
  });
}

/**
 * `needs` from what was handed in: every vote owed, less the ones passed
 * over (#3526) and the ones a saved vote has answered (#5468). An entry
 * nobody has counted keeps whatever it had, and one with a count but no list
 * of which votes keeps its number too: a count this cannot check is never
 * lowered on a guess, as in `unseenNeeds` and `stripAnsweredCounts`. The
 * stored `owedCount` / `owed` stay what the describer handed in, so
 * re-deriving after either store moves lands on the same number.
 */
function derive(info: CommunityInfo): CommunityInfo {
  if (info.owedCount == null) return info;
  let count = info.owedCount;
  let owed = info.owed;
  if (Array.isArray(owed) && owed.length) {
    const left = owedLessSaved(owed, voteSavedStore.get());
    const answered = owed.length - left.length;
    if (answered > 0) count = Math.max(0, count - answered);
    owed = left;
  }
  const needs = unseenNeeds(info.slug, count, owed);
  return needs === info.needs ? info : { ...info, needs };
}

/** The list of votes compares by what is in it, not by which array it is. */
const same = (a: unknown, b: unknown): boolean => a === b
  || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, k) => x === b[k]));

/** What someone knows about a community: merged into what is known. */
export function describe(slug: string, patch: Partial<CommunityInfo>): void {
  if (!slug) return;
  const cur = communityScopeStore.get();
  const prev = cur.info[slug];
  const base: CommunityInfo = prev || { slug, name: slug, iconUrl: null, iconEmoji: null, iconColor: null };
  const next: CommunityInfo = derive({
    ...base,
    ...(Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<CommunityInfo>),
    slug,
  });
  if (prev && Object.keys(next).every((k) => same((next as any)[k], (prev as any)[k]))) return;
  const info = { ...cur.info, [slug]: next };
  communityScopeStore.set({ info, ...(cur.list ? sums(cur.list, info) : {}) });
  if (cur.slug === slug) saveInfo(next);
}

export function openSwitcher(from: SwitcherFrom, anchorEl?: Element | null): void {
  let anchor: CommunityScopeState['anchor'] = null;
  try {
    const r = anchorEl?.getBoundingClientRect();
    if (r) anchor = { top: r.top, left: r.left, right: r.right, bottom: r.bottom };
  } catch { /* no box: the sheet needs none */ }
  communityScopeStore.set({ switcher: from, anchor });
  void loadCommunities();
}

export function closeSwitcher(): void {
  communityScopeStore.set({ switcher: null, anchor: null });
}

export function toggleSwitcher(from: SwitcherFrom, anchorEl?: Element | null): void {
  if (communityScopeStore.get().switcher) closeSwitcher();
  else openSwitcher(from, anchorEl);
}

function demoQuery(): string {
  try {
    return new URLSearchParams(window.location.search).get('demo') === '1' ? '?demo=1' : '';
  } catch {
    return '';
  }
}

type AppRow = {
  slug: string;
  name?: string;
  icon_url?: string | null;
  icon_emoji?: string | null;
  icon_color?: string | null;
  audience?: string;
  member_count?: number;
  last_active_at?: string | null;
  self_hosted?: boolean;
  demo?: boolean;
  is_member?: boolean;
};

let loading: Promise<void> | null = null;
let loadedAt = 0;

/**
 * Every community you are in, with what each is waiting on you for: GET
 * /api/apps (the rows the Communities list reads, joined the way it joins
 * them) and GET /api/workshop/counts (votes owed, `needs`). At most every
 * thirty seconds; the switcher asks on each open.
 */
export function loadCommunities(force = false): Promise<void> {
  if (loading) return loading;
  if (!force && Date.now() - loadedAt < 30_000 && communityScopeStore.get().list) return Promise.resolve();
  const q = demoQuery();
  loading = (async () => {
    try {
      const [appsRes, countsRes] = await Promise.all([
        // Joined rows only (#5023), the ones kept below.
        fetch(`/api/apps?scope=joined${q.replace('?', '&')}`, { credentials: 'same-origin' }),
        // A refresh asks for the current numbers, never the copy the service
        // worker saved (request 6500); an unforced read keeps its own cache.
        fetch(`/api/workshop/counts${q}`, {
          credentials: 'same-origin',
          ...(force ? { cache: 'no-cache' as const } : {}),
        }).catch(() => null),
      ]);
      if (!appsRes.ok) return;
      const body = await appsRes.json();
      const rows: AppRow[] = Array.isArray(body) ? body : (body && Array.isArray(body.apps) ? body.apps : []);
      const home = (window as any).Home;
      const joined = rows.filter((r) => r && r.slug && (
        typeof home?.isJoined === 'function' ? home.isJoined(r) : !!r.is_member
      ));
      let counts: Record<string, { needs?: number; owed?: unknown; unchosen?: boolean }> = {};
      if (countsRes && countsRes.ok) {
        const c = await countsRes.json().catch(() => null);
        counts = (c && c.counts) || {};
      }
      // Newest first, the order the Communities list and its sections use.
      const ordered = orderRows(joined as any) as unknown as AppRow[];
      hydrateNeedsSeen();
      const cur = communityScopeStore.get();
      const info = { ...cur.info };
      for (const r of ordered) {
        const owed = counts[r.slug]?.owed;
        info[r.slug] = derive({
          ...(info[r.slug] || {}),
          slug: r.slug,
          name: r.name || r.slug,
          iconUrl: r.icon_url || null,
          iconEmoji: r.icon_emoji || null,
          iconColor: r.icon_color || null,
          audience: r.audience,
          memberCount: Number(r.member_count) || 0,
          // #3526: which votes, so the ones passed over can be left out.
          owedCount: Number(counts[r.slug]?.needs) || 0,
          owed: Array.isArray(owed) ? owed.map(String) : undefined,
          // Read fresh on every load: the first vote cast there ends it.
          unchosen: counts[r.slug]?.unchosen === true,
          selfHosted: !!r.self_hosted,
          lastActiveAt: r.last_active_at || null,
        });
      }
      const list = ordered.map((r) => r.slug);
      communityScopeStore.set({ info, list, ...sums(list, info) });
      if (cur.slug && info[cur.slug]) saveInfo(info[cur.slug]);
      saveList(navStore.get().viewer, list, info);
      loadedAt = Date.now();
    } catch {
      /* the switcher says it could not load; the tab keeps what it had */
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/**
 * Read every community a moment after sign-in, so the tab's badge can say
 * what is waiting before anybody opens the switcher. Returns a cancel.
 */
export function warmCommunities(delayMs = 1500): () => void {
  const timer = window.setTimeout(() => { void loadCommunities(); }, delayMs);
  return () => window.clearTimeout(timer);
}

/**
 * Go to a community from the switcher: All communities is Home's (and
 * forgets the page the tab reopened); a community opens on the place you
 * were on when it has it, else its hub (landKeepingPlace).
 *
 * ALL COMMUNITIES IS HOME'S (One Home, #6361): its Pinned communities, with
 * the section's All communities open (Home.showCommunities), where the
 * Communities screen's list was. The Hub's grid button and the lit tab's
 * last step both come here.
 */
export function goToCommunity(slug: string | null): void {
  closeSwitcher();
  const app = (window as any).App;
  if (!slug) {
    setScope(null);
    try { app?._forgetWorkshopView?.(); } catch { /* nothing to forget */ }
    const home = (window as any).Home;
    if (home?.showCommunities) home.showCommunities({ all: true });
    else app?.navigateHome?.();
    return;
  }
  setScope(slug);
  // Already on its page (the lander, not a card or a session under it): it
  // stays on the place it shows, and there is nowhere to go.
  const onPage = app?.currentApp === slug
    && !!document.querySelector('#app-view:not(.hidden) #dev-workshop > .dev-ws');
  if (onPage) return;
  landKeepingPlace(slug);
  void app?.navigateToApp?.(slug, 'dev');
}

/**
 * Re-derive every entry and publish the result when any number moved: the
 * tab's badge and the switcher's and sidebar's lines drop here and now, not
 * at the next read. Both subscriptions below share this body.
 */
function rederiveAll(): void {
  const cur = communityScopeStore.get();
  let changed = false;
  const info: Record<string, CommunityInfo> = {};
  for (const [slug, entry] of Object.entries(cur.info)) {
    info[slug] = derive(entry);
    if (info[slug] !== entry) changed = true;
  }
  if (!changed) return;
  communityScopeStore.set({ info, ...(cur.list ? sums(cur.list, info) : {}) });
  if (cur.slug && info[cur.slug]) saveInfo(info[cur.slug]);
}

/**
 * A vote passed over anywhere on the page (./needs-seen.ts) lowers every
 * count it was in, here and now: the tab's badge and the switcher's lines
 * drop as the feed is swiped through, not at the next read.
 */
needsSeenStore.subscribe(rederiveAll);

/**
 * A vote the server SAVED anywhere (#5468, cards-store.ts voteSavedStore —
 * the change's page, a notification's "Still yes", a chat's proposal card, a
 * Needs you feed) lowers every count it was in the moment it lands, the same
 * way: the card says "Voted yes" at once, so the tab, the switcher and the
 * sidebar agree with it instead of waiting for the next read.
 */
voteSavedStore.subscribe(rederiveAll);

if (typeof window !== 'undefined') {
  const host = window as unknown as { UsernodeReact?: Record<string, unknown> };
  const bridge = (host.UsernodeReact ||= {});
  bridge.communityScope = { setScope, describe, openSwitcher, closeSwitcher, loadCommunities };
}
