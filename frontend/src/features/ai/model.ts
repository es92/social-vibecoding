/**
 * The AI tab's main view (#6019 follow-up), its pure part: what each list
 * holds and what each row says. ./index.tsx draws it.
 *
 *   Needs you   what waits on you: the Needs you feed for the threads you
 *               are in (GET /api/workshop/needs-feed?in=threads), each with
 *               one pill for what you owe; then Homeroom bot's plans waiting
 *               for your Build it; then your private threads, with a lock on
 *               the tile.
 *   In progress yours being worked on, soonest first: the bot reading it, a
 *               change being made or fixed, merging, going live.
 *   Waiting     yours with nothing to do on the row: other people's votes, a
 *               free builder or slot, the clock. Each says which, and where
 *               a vote you owe would move it, says that too (30 Oct 2026:
 *               "Up next" read as yours to do next). #6160: In progress and
 *               Waiting are one card of their own on the page, work under
 *               way first, then what waits.
 *   Live        yours that went live this week.
 *
 * The last four are GET /api/ai/work's. Each row carries its request's (or
 * change's) stored work state, the one every screen draws (lib/work-state.ts,
 * services/work-state.js: 5 Nov 2026), so its words are the same stage words
 * the chat's drawer, the request's page and Homeroom bot's answers use.
 *
 * A row's words are phrases (an id and its values), translated where they
 * are drawn, so this module needs no i18n runtime and its tests read it bare.
 */

import { lineWords, stageWords } from '../../lib/work-state';
import type { WorkState } from '../../lib/work-state';

export interface AiApp {
  slug: string;
  name: string;
  icon_url?: string | null;
  icon_emoji?: string | null;
  /**
   * Where the project's code is hosted (services/ai-work.js): true on
   * GitHub, where a change's pull request number is GitHub's own and reads
   * "PR 12"; false on Homeroom's git host, where requests and changes share
   * one counter and both read "#12". Absent from an older server.
   */
  changesOnGithub?: boolean;
}

export interface AiPrivate {
  rootId: number;
  title: string;
  kind: string;
  app: AiApp | null;
  at: string | null;
  /** 1 Nov 2026: what a thread opened from a request's or a change's page is about; its row carries the number. */
  about?: { kind: 'request' | 'change'; number: number } | null;
  /**
   * #6153: where it went: a design thread stays listed once it is filed as
   * a request, or posted on one as its plan (absent from an older server).
   */
  /** #6159: `done` once finished; #6271: a done thread is Live this week's for a week. */
  state?: 'open' | 'filed' | 'posted' | 'dropped' | 'done';
  /** #6153: the number of the request it was filed as, or posted on. */
  resultRef?: number | null;
  /** #6271: the day it was marked done, for Live this week (absent from an older server). */
  doneAt?: string | null;
  /** Filed (or posted) as a request that has since finished: History's, not Needs you's. */
  resultDone?: boolean;
}

export interface AiThread {
  threadId: number;
  number: number | null;
  kind: string;
  title: string | null;
  app: AiApp | null;
  change: { id: number; number: number | null } | null;
  /**
   * #6421: how many requests the thread holds (a change for several requests
   * gathers their threads into one). Absent from an older server, which reads
   * as one.
   */
  requests?: number;
  href: string;
  group: 'needs' | 'next' | 'waiting' | 'live';
  /**
   * Where it stands: its request's stored work state, or its change's
   * (lib/work-state.ts). #6271: a private thread marked done this week is
   * `closed`.
   */
  work: WorkState;
  /**
   * Your own change (not Homeroom bot's) waits on your fix: its checks
   * failed, its preview did not build, or it conflicts. Needs you, with Fix
   * it; its stage stays the change's own (absent from an older server).
   */
  fixYours?: boolean;
  at: string | null;
  /**
   * #6233: on a Live row, when the change merged and its id, so the tab can
   * tell whether the build it loaded contains it (the "reload to get it"
   * wording). Absent on an older server.
   */
  mergedAt?: string | null;
  changeId?: number | null;
  quietDays?: number;
  /** #6282: what was asked for, on an Updating or Update queued row (one line, 80 characters at most). */
  ask?: string | null;
  /** Up for a vote (a change's, or a decision's): how you voted, if you have. */
  myVote?: 'yes' | 'no' | null;
  /** Being made: by Homeroom bot, by you, or by someone else (a claim's line names who). */
  by?: 'bot' | 'you' | 'someone';
  /** Held for a slot: how many of Homeroom bot's changes holding one wait on your vote (upNext). */
  yourVotes?: number;
  /**
   * #6153: the private thread its request was filed from (a design thread's
   * New request), which the row opens: the design and its story are there.
   */
  rootId?: number | null;
  /**
   * #6262: how many messages in the thread are new to the viewer (another
   * person's or Homeroom bot's, since they last opened it). Above zero, its
   * row gets a blue dot and a bold title. Absent from an older server, which
   * reads as 0.
   */
  unread?: number;
}

export interface AiWork {
  private: AiPrivate[];
  /** The bot's plans waiting for your Build it (absent from an older server). */
  needs?: AiThread[];
  next: AiThread[];
  waiting: AiThread[];
  live: AiThread[];
}

/** One card of the Needs you feed, as much of it as a row needs. */
export interface NeedItem {
  kind: string;
  id: number;
  number?: number | null;
  title?: string | null;
  app?: AiApp | null;
  href?: string | null;
  /** A pick between competing changes: the request they compete for. */
  ballot?: { number?: number | null; title?: string | null } | null;
  /** A change for a request: the request it closes (absent from an older server). */
  request?: { number?: number | null; title?: string | null } | null;
  /**
   * A group decision's facts (routes/workshop-overview.js decisionFacts): what
   * kind it is, and for a vote to close a request, the request's number.
   */
  decision?: { kind?: string | null; issueNumber?: number | null } | null;
  /** Who proposed it, by username: Homeroom bot's own changes hold its slots. */
  author?: string | null;
  /**
   * B17: the change is on a project that is just this person's, so their
   * yes alone approves it (workshop-overview.js approvedAlone). Its row says
   * Approve, as its card and the project's own Needs you do; Vote elsewhere.
   */
  approve?: boolean;
  /**
   * #6389: a change the viewer made through a coding agent whose votes are
   * in but which waits on their fix (`checks` and/or `conflict`). Its row
   * says what it waits on instead of Vote.
   */
  waitingOn?: string[];
  /**
   * #6531: a conflicting change that only a yes can move. Its Vote row names
   * the conflict ("Homeroom resolves it once you approve"), so it does not
   * read as a plain vote.
   */
  conflictOnYes?: boolean;
  /** #6389: the coding tool the change was made in, such as `claude-code`. */
  agent?: string | null;
  /** #6262: the thread its page is, and how many messages in it are new. */
  threadId?: number | null;
  unread?: number;
  /** When it started needing the viewer: the day its row is grouped under. */
  at?: string | null;
}

/** Homeroom bot's account: its changes up for a vote hold a project's build slots. */
const BOT_USERNAME = 'homeroom_bot';

/** Pure: whether a Needs you card is a vote on one of Homeroom bot's changes, which holds a build slot until decided. */
function holdsSlot(item: NeedItem): boolean {
  return item.kind === 'proposal' && String(item.author || '').toLowerCase() === BOT_USERNAME;
}

/** Pure: the projects where a request of yours waits for one of those slots. */
function heldProjects(work: AiWork | null): Set<string> {
  const held = new Set<string>();
  for (const t of work?.waiting || []) {
    if (t.work.line?.code === 'held_waiting' && t.app) held.add(t.app.slug);
  }
  return held;
}

/** Pure: the request or change number a Needs you card is about, as its page is addressed. */
function needNumber(item: NeedItem): number | null {
  if (item.kind === 'ballot') return item.ballot?.number || item.number || null;
  return item.number || null;
}

/**
 * Pure: the number a Needs you row shows. A change for a request goes by the
 * request's, as Homeroom bot names it in Main and as the request's own rows
 * here do (30 Oct 2026: the tab said #6032 where the bot said #6038).
 */
function shownNumber(item: NeedItem): number | null {
  if (item.kind === 'proposal' && item.request?.number) return item.request.number;
  return needNumber(item);
}

export interface Phrase {
  id: string;
  values?: Record<string, string | number>;
  /** Values that are phrases themselves (a stage's words inside a row's line), translated first. */
  nested?: Record<string, Phrase>;
}

/** Who is in a thread, drawn on its tile: everyone in its community, only you inside one, or only you. */
export type Who = 'all' | 'me' | 'solo';

export interface WorkRow {
  key: string;
  title: string;
  app: AiApp | null;
  who: Who;
  sub: Phrase;
  /** What you owe, on the row's one pill. */
  pill: Phrase | null;
  /** The row's second line, where it is news (whyOf): a hand-back's reason, said by its stage. */
  why?: Phrase | null;
  /** Where the row goes: a page, or a private thread of Main. */
  href: string | null;
  rootId: number | null;
  /**
   * #6262: the thread whose page the row opens, where it has one (a private
   * thread has none: Main Chat's own "N new" covers it), and how many
   * messages in it are new. Above zero, the row draws a blue dot and a bold
   * title.
   */
  threadId: number | null;
  unread: number;
  /**
   * When it first needed the viewer: the day its row is grouped under (6 Nov
   * 2026, Needs you and Waiting & in progress split each project's rows by
   * day). A private thread's last activity; absent from an older server.
   */
  at: string | null;
}

/**
 * How many rows each project shows in a section before its own Show more
 * (./lists.tsx groups every section's rows by project). Needs you shows the
 * most: it is what you came for. Waiting & in progress is ONE section of the
 * work under way and the work waiting, so it keeps the same three.
 */
export const GROUP_FIRST = { needs: 5, busy: 3, live: 3 } as const;

/** Pure: rows under their project, once each, in the order the projects first come. */
export function byProject<T extends { app: AiApp | null }>(rows: T[]): { app: AiApp | null; items: T[] }[] {
  const groups: { app: AiApp | null; items: T[] }[] = [];
  const at = new Map<string, number>();
  for (const row of rows) {
    const key = row.app?.slug || '';
    if (!at.has(key)) { at.set(key, groups.length); groups.push({ app: row.app, items: [] }); }
    groups[at.get(key)!].items.push(row);
  }
  return groups;
}

/**
 * Pure (6 Nov 2026): the reader's own calendar day a row belongs to, as
 * `YYYY-MM-DD`, or '' when its moment is missing or unreadable. Needs you and
 * Waiting & in progress split each project's rows by it (./lists.tsx), so a
 * row joins the day it first needed the viewer, read in their own time zone.
 */
export function dayKey(at: string | null | undefined): string {
  const d = new Date(String(at || ''));
  if (!Number.isFinite(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Pure (6 Nov 2026): rows by their day, the newest day first and each day's
 * rows in the order they came in, so a project's day headings are one run
 * each rather than Today, Yesterday, Today. A row with no day goes last.
 */
export function byDay<T extends { at?: string | null }>(rows: readonly T[]): T[] {
  return rows
    .map((row, i) => ({ row, i, key: dayKey(row.at) }))
    .sort((a, b) => {
      if (!a.key || !b.key) {
        if (a.key) return -1;
        if (b.key) return 1;
        return a.i - b.i;
      }
      return a.key === b.key ? a.i - b.i : (a.key < b.key ? 1 : -1);
    })
    .map(({ row }) => row);
}

/**
 * Pure (#6245): the order a list was drawn in, kept while the person is
 * using it. Rows still present keep their drawn place; rows that arrived
 * since follow in their incoming order; rows that left drop out at once.
 * So a live refresh never slides a row out from under the pointer or the
 * keyboard, and the list settles into its new order when they move away.
 */
export function holdOrder<T extends { key: string }>(rows: T[], drawn: readonly string[]): T[] {
  const seen = new Set(drawn);
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const kept = drawn.map((key) => byKey.get(key)).filter((row) => row !== undefined) as T[];
  return [...kept, ...rows.filter((row) => !seen.has(row.key))];
}

/**
 * Pure (#6245): a group's rows as it draws them. Folded, the row you are on
 * is lifted to just below the first few, so where you are is never hidden.
 * Opened, every row keeps its own place: pressing one past the fold no
 * longer slides it up under the pointer.
 *
 * #6262: a row with something new is never folded either. Show more is for
 * what you have already seen; hiding a new row behind it is what the dot was
 * meant to stop. That fits Needs you, where new means it wants you.
 *
 * #6408: Live this week calls it with `liftFresh` false. There, new only
 * means a change went live since the viewer last looked, which is most of the
 * list on a busy day, so it folds after its first few whatever is new.
 */
export function groupRows<T extends { lit?: boolean; fresh?: boolean }>(items: T[], first: number, open: boolean, liftFresh = true): { items: T[]; shown: number; hidden: number } {
  const litAt = open ? -1 : items.findIndex((row) => row.lit);
  // Which rows past the first few must still be shown: the fresh ones and
  // the one you are on. They keep their order; the rest folds away.
  const lifted = new Set<number>();
  if (!open) {
    if (litAt >= first) lifted.add(litAt);
    if (liftFresh) items.forEach((row, i) => { if (row.fresh && i >= first) lifted.add(i); });
  }
  const rest = items.slice(first);
  const drawn = open
    ? items
    : [...items.slice(0, first), ...rest.filter((_, k) => lifted.has(first + k)), ...rest.filter((_, k) => !lifted.has(first + k))];
  const shown = open ? first : first + lifted.size;
  return { items: drawn, shown, hidden: Math.max(0, drawn.length - shown) };
}

// ── #6262: what is new in a thread ───────────────────────────────────────

/** Pure: rows with something new, for a heading's or the hero's count. */
export function freshCount(rows: { unread?: number }[]): number {
  return (rows || []).filter((row) => (Number(row.unread) || 0) > 0).length;
}

/** Pure: how many new rows each project has, by slug, for its chip. */
export function freshByProject(rows: { app: AiApp | null; unread?: number }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows || []) {
    if (!row.app || (Number(row.unread) || 0) <= 0) continue;
    counts[row.app.slug] = (counts[row.app.slug] || 0) + 1;
  }
  return counts;
}

/**
 * Pure: a group's rows with the new ones first (a stable sort: equally new
 * rows keep the order they came in), so Needs you opens on what changed.
 */
export function freshFirst<T extends { fresh?: boolean }>(lines: T[]): T[] {
  return [...(lines || [])].sort((a, b) => Number(!!b.fresh) - Number(!!a.fresh));
}

/** How many projects the filter shows as chips before its More (./lists.tsx). */
export const RAIL_PROJECTS = 3;

/** A project in any list, with how many of its rows each list holds: what the filter says about it. */
export interface ProjectTally {
  app: AiApp;
  needs: number;
  progress: number;
  waiting: number;
  live: number;
}

/**
 * Pure: the projects in any list, once each, the ones that need you most
 * first: by Needs you, then In progress, then Waiting, then name. The
 * filter's chips are the first few and its More lists them all (30 Oct 2026,
 * Evan: a chip a project, in the order they first came, was a rail nobody
 * could use with dozens of projects).
 */
export function rankProjects(rows: WorkRow[], progress: AiThread[], waiting: AiThread[], live: AiThread[]): ProjectTally[] {
  const at = new Map<string, ProjectTally>();
  const count = (app: AiApp | null, list: 'needs' | 'progress' | 'waiting' | 'live') => {
    if (!app) return;
    let tally = at.get(app.slug);
    if (!tally) { tally = { app, needs: 0, progress: 0, waiting: 0, live: 0 }; at.set(app.slug, tally); }
    tally[list] += 1;
  };
  rows.forEach((r) => count(r.app, 'needs'));
  progress.forEach((t) => count(t.app, 'progress'));
  waiting.forEach((t) => count(t.app, 'waiting'));
  live.forEach((t) => count(t.app, 'live'));
  const name = (p: ProjectTally) => p.app.name || p.app.slug;
  return [...at.values()].sort((a, b) => (b.needs - a.needs) || (b.progress - a.progress) || (b.waiting - a.waiting)
    || name(a).localeCompare(name(b)));
}

/**
 * Pure (5 Nov 2026): the ranking, then any project it does not name, once
 * each and in their order, needing nothing: History's projects, and one a
 * link picked (#homeroom-bot?project=…) that no list names yet. Their chips
 * come after the rest, under More; a picked one leads the rail (railProjects).
 */
export function withProjects(ranked: ProjectTally[], apps: readonly (AiApp | null | undefined)[]): ProjectTally[] {
  const out = [...ranked];
  const seen = new Set(ranked.map((p) => p.app.slug));
  for (const app of apps) {
    if (!app || !app.slug || seen.has(app.slug)) continue;
    seen.add(app.slug);
    out.push({ app, needs: 0, progress: 0, waiting: 0, live: 0 });
  }
  return out;
}

/**
 * Pure: the projects the rail shows as chips: any picked from More, then the
 * first few of the ranking. A pick from More comes first, beside All, so
 * what the lists are narrowed to is on screen even where a phone's rail
 * shows two chips; the first few keep their places, so a chip pressed there
 * does not move.
 */
export function railProjects(ranked: ProjectTally[], picked: string[]): AiApp[] {
  const past = ranked.slice(RAIL_PROJECTS).filter((p) => picked.includes(p.app.slug));
  return [...past, ...ranked.slice(0, RAIL_PROJECTS)].map((p) => p.app);
}

const PILLS: Record<string, string> = {
  proposal: 'messages:ai.pill.vote',
  governance: 'messages:ai.pill.vote',
  ballot: 'messages:ai.pill.pick',
  question: 'messages:ai.pill.answer',
  bot_question: 'messages:ai.pill.answer',
};

/**
 * #6389: what a change the viewer made through a coding agent waits on once
 * its votes are in: its pill, its tooltip, and the phone's second line. The
 * pill says one reason (tests first); the tooltip and second line say both
 * when both are true, so the row still fits on a phone.
 */
function waitingRow(reasons: string[]) {
  const checks = reasons.includes('checks');
  const conflict = reasons.includes('conflict');
  if (checks) {
    return {
      pill: 'messages:ai.pill.testsFailing',
      sub: conflict ? 'messages:ai.row.waitsOnFixBoth' : 'messages:ai.row.waitsOnFixTests',
    };
  }
  return { pill: 'messages:ai.pill.conflicts', sub: 'messages:ai.row.waitsOnFixConflict' };
}

/**
 * Pure: which hand-back a Needs you row of the bot's is, by its stage: the
 * row's key and pill. A plan waits for Build it; a decision, for a person;
 * #6306: one already there only needs closing; a stopped build, for a
 * restart; #6284: failing checks it stopped fixing, for one more try.
 */
function needKind(work: WorkState): string {
  if (work.stage === 'stopped') return work.reason === 'fix_stopped' ? 'fix_stopped' : 'stopped';
  if (work.why === 'plan') return 'plan';
  if (work.why === 'already_works') return 'works';
  if (work.why === 'needs_detail') return 'detail';
  return 'decide';
}

const NEED_PILLS: Record<string, string> = {
  plan: 'messages:ai.pill.buildIt',
  decide: 'messages:ai.pill.decide',
  works: 'messages:ai.pill.proposeClose',
  stopped: 'messages:ai.pill.tryAgain',
  fix_stopped: 'messages:ai.pill.letTryAgain',
  detail: 'messages:ai.pill.needsYou',
  fix_yours: 'messages:ai.pill.fixIt',
};

/**
 * Pure: the page a Needs you card is decided on. A change built for a
 * request has no page of its own (one page per thread): its address lands on
 * the request's page, so a Vote row links there too, and the row it lights is
 * that page's (3 Nov 2026, #6227: the numbers can differ, so matching the
 * change's own route never lit it).
 */
export function needHref(item: NeedItem): string | null {
  if (item.href) return item.href;
  const slug = item.app?.slug;
  if (!slug) return null;
  const app = encodeURIComponent(slug);
  if (item.kind === 'governance') {
    // 6 Nov 2026 (#6439): a vote to close a request is decided on the
    // request's page, where it already draws, not on the old governance
    // page. Every other decision keeps its own page.
    const closing = item.decision && item.decision.kind === 'close_issue'
      ? Number(item.decision.issueNumber) : 0;
    if (closing > 0) return `#app/${app}/dev/issues/${closing}`;
    return `#app/${app}/dev/governance/${Number(item.id)}`;
  }
  const closes = item.kind === 'proposal' ? Number(item.request?.number) : 0;
  if (closes > 0) return `#app/${app}/dev/issues/${closes}`;
  const number = needNumber(item);
  if (number) {
    // A ballot is decided on its request's page, where its changes are.
    return item.kind === 'proposal'
      ? `#app/${app}/dev/changes/${number}`
      : `#app/${app}/dev/issues/${number}`;
  }
  return `#app/${app}/workshop`;
}

function where(app: AiApp | null, number: number | null | undefined): Record<string, string | number> {
  return { project: app?.name || app?.slug || '', number: number || '' };
}

/** Pure: a row's project and number, or its project alone when it has none (a decision). */
function whereLine(app: AiApp | null, number: number | null | undefined): Phrase {
  return number
    ? { id: 'messages:ai.row.where', values: where(app, number) }
    : { id: 'messages:ai.row.project', values: where(app, null) };
}

/** Pure: what the feed's cards are about, as `slug#number`, so a thread already owed there is not listed twice. */
export function owedKeys(needs: NeedItem[] | null): Set<string> {
  const owed = new Set<string>();
  for (const item of needs || []) {
    if (!item.app) continue;
    for (const number of [needNumber(item), shownNumber(item)]) {
      if (number) owed.add(`${item.app.slug}#${number}`);
    }
  }
  return owed;
}

/** Pure: whether a thread is one the feed already lists, by its request's number or its change's. */
function isOwed(owed: Set<string>, t: AiThread): boolean {
  if (!t.app) return false;
  return (!!t.number && owed.has(`${t.app.slug}#${t.number}`))
    || (!!t.change?.number && owed.has(`${t.app.slug}#${t.change.number}`));
}

/**
 * Pure (#6153): the request a private thread was filed as, or posted its
 * plan on, on a project, as `slug#number`; null for any other thread.
 */
export function filedKey(p: AiPrivate): string | null {
  if ((p.state !== 'filed' && p.state !== 'posted') || !p.app || !(Number(p.resultRef) > 0)) return null;
  return `${p.app.slug}#${Number(p.resultRef)}`;
}

/**
 * Pure (#6153): each request's private thread, by `slug#number`: the newest
 * thread filed as it or posted on it (the list comes newest first).
 */
function filedThreads(work: AiWork | null): Map<string, number> {
  const filed = new Map<string, number>();
  for (const p of work?.private || []) {
    if (p.state === 'done') continue;
    const key = filedKey(p);
    if (key && !filed.has(key)) filed.set(key, p.rootId);
  }
  return filed;
}

/** Pure (#6153): a request's row, carrying the private thread it was filed from, which it opens. */
function withThread(filed: Map<string, number>, t: AiThread): AiThread {
  const rootId = t.app && t.number ? filed.get(`${t.app.slug}#${t.number}`) : undefined;
  return rootId ? { ...t, rootId } : t;
}

/** Pure (#6153): every request with a row in any list, as `slug#number`. */
function listedKeys(needs: NeedItem[] | null, work: AiWork | null): Set<string> {
  const listed = owedKeys(needs);
  for (const t of [...(work?.needs || []), ...(work?.next || []), ...(work?.waiting || []), ...(work?.live || [])]) {
    if (t.app && t.number) listed.add(`${t.app.slug}#${t.number}`);
  }
  return listed;
}

/**
 * Pure: Needs you, in order: the feed's cards, the bot's plans waiting for
 * Build it, then your private threads. #6153: a design thread filed as a
 * request is that request's row once the request has one, in any list (in
 * In progress, Waiting or Live it opens the thread: inProgress, upNext,
 * liveThisWeek), never a second "Only you" row. One whose request is in no
 * list (closed, live long ago) is still listed here.
 */
export function needsYou(needs: NeedItem[] | null, work: AiWork | null): WorkRow[] {
  const rows: WorkRow[] = [];
  const owed = owedKeys(needs);
  const held = heldProjects(work);
  const filed = filedThreads(work);
  const listed = listedKeys(needs, work);
  for (const item of needs || []) {
    const app = item.app || null;
    // #6389: your own change made through a coding agent, its votes in and
    // its fix still owed. It keeps its row because you are the one to act,
    // and says what it waits on in place of Vote.
    const waiting = item.waitingOn && item.waitingOn.length ? waitingRow(item.waitingOn) : null;
    // #6531: a conflicting change only a yes can move says so on its Vote row.
    const conflicted = item.kind === 'proposal' && item.conflictOnYes === true;
    rows.push({
      key: `need:${item.kind}:${item.id}`,
      title: (item.kind === 'ballot' && item.ballot?.title) || item.title || '',
      app,
      who: 'all',
      // A vote on a change of Homeroom bot's, where a request of yours waits
      // for one of its slots: deciding it lets that request be built.
      sub: conflicted
        ? { id: 'messages:ai.row.voteConflict', values: where(app, shownNumber(item)) }
        : waiting
          ? { id: waiting.sub, values: where(app, shownNumber(item)) }
          : app && held.has(app.slug) && holdsSlot(item)
            ? { id: 'messages:ai.row.voteFreesSlot', values: where(app, shownNumber(item)) }
            : whereLine(app, shownNumber(item)),
      // A phone shows it under the title where nothing hovers.
      ...(conflicted ? { why: { id: 'messages:ai.why.voteConflict' } } : {}),
      pill: waiting
        ? { id: waiting.pill }
        : item.kind === 'proposal' && item.approve === true
          ? { id: 'messages:ai.pill.approve' }
          : { id: PILLS[item.kind] || 'messages:ai.pill.needsYou' },
      href: needHref(item),
      rootId: null,
      // #6262: a feed item's thread, and what is new in it.
      threadId: item.threadId ?? null,
      unread: Math.max(0, Number(item.unread) || 0),
      at: item.at || null,
    });
  }
  for (const t of work?.needs || []) {
    if (isOwed(owed, t)) continue;
    const kind = t.fixYours ? 'fix_yours' : needKind(t.work);
    rows.push({
      key: `${kind}:${t.threadId}`,
      title: t.title || '',
      app: t.app,
      who: 'all',
      // Homeroom bot handed it back (a plan, a decision, already there, more
      // detail), or stopped: nothing moves until a person does, so it is
      // Needs you's, and says so in its stage's words.
      // Your own change waiting on your fix says so, in the change's words
      // ("PR 12" on GitHub).
      sub: t.fixYours
        ? { id: prWord('messages:ai.row.fixYours', changeOnGithub(t)), values: where(t.app, t.number) }
        : stageLine(t),
      pill: { id: NEED_PILLS[kind] || 'messages:ai.pill.needsYou' },
      // A phone shows it under the title, where nothing hovers: its second
      // line where it has one (the bot's own reason), else its stage.
      why: t.fixYours
        ? { id: 'messages:ai.why.fixYours' }
        : lineWords(t.work) || stageWords(t.work, { yours: true }),
      href: t.href,
      rootId: null,
      threadId: t.threadId,
      unread: Math.max(0, Number(t.unread) || 0),
      at: t.at,
    });
  }
  for (const p of work?.private || []) {
    // #6159: a done thread is the only one left out (the server leaves it out too).
    if (p.state === 'done') continue;
    // 5 Nov 2026: and one filed as a request that has finished: History's.
    if (p.resultDone) continue;
    const key = filedKey(p);
    if (key && filed.get(key) === p.rootId && listed.has(key)) continue;
    // 1 Nov 2026: a thread about a request or a change is drawn by it, its
    // number before its title as a request's row is ("#18 Dark mode").
    const about = p.about && p.about.number > 0 && p.app ? p.about : null;
    // #6250: a filed, posted or put-away thread stays listed and says where
    // it went. One whose request already has a row was folded above.
    const project = p.app ? p.app.name || p.app.slug : '';
    const went: Phrase | null = !p.app
      ? null
      : p.state === 'filed' && p.resultRef
        ? { id: 'messages:ai.row.privateFiled', values: { project, number: p.resultRef } }
        : p.state === 'posted' && p.resultRef
          ? { id: 'messages:ai.row.privatePosted', values: { project, number: p.resultRef } }
          : p.state === 'dropped'
            ? { id: 'messages:ai.row.privatePutAway', values: { project } }
            : null;
    rows.push({
      key: `private:${p.rootId}`,
      title: p.title,
      app: p.app,
      who: p.app ? 'me' : 'solo',
      sub: about
        ? {
          id: about.kind === 'change'
            ? (p.app?.changesOnGithub ? 'messages:ai.row.privateAboutChangePr' : 'messages:ai.row.privateAboutChange')
            : 'messages:ai.row.privateAbout',
          values: { project: p.app!.name || p.app!.slug, number: about.number },
        }
        : went || (p.app
          ? { id: 'messages:ai.row.privateDraft', values: { project } }
          : { id: 'messages:ai.row.privateIdea' }),
      pill: null,
      href: null,
      rootId: p.rootId,
      // A private thread is not a `threads` row: Main Chat's "N new" counts it.
      threadId: null,
      unread: 0,
      at: p.at || null,
    });
  }
  return rows;
}

/** Pure: how many rows of Needs you ask something of you (a pill): the heading's and the hero's count. */
export function owedCount(rows: WorkRow[]): number {
  return rows.filter((row) => row.pill).length;
}

/** The phone's second line for a Needs you row, by the reason its tooltip gives. */
const WHY: Record<string, string> = {
  'messages:ai.row.voteFreesSlot': 'messages:ai.why.voteFreesSlot',
  // #6389: the phone's second line for a change waiting on its author's fix.
  'messages:ai.row.waitsOnFixTests': 'messages:ai.why.fixTests',
  'messages:ai.row.waitsOnFixConflict': 'messages:ai.why.fixConflict',
  'messages:ai.row.waitsOnFixBoth': 'messages:ai.why.fixBoth',
};

/**
 * Pure: a Needs you row's reason, where it is news: a phone shows it under
 * the title, where nothing hovers to show the tooltip. A plain vote or a
 * plan says nothing more than its pill does, so it has none.
 */
export function whyOf(row: WorkRow): Phrase | null {
  // A hand-back of the bot's says its stage's second line (#6306: an
  // already-done row's reason is the bot's own sentence).
  if (row.why) return row.why;
  const id = WHY[row.sub.id];
  return id ? { id } : null;
}

/** Pure: the same for an In progress or Waiting row: a slot your votes can free. */
export function threadWhy(t: AiThread): Phrase | null {
  if (t.work.line?.code === 'held_waiting' && t.yourVotes) return { id: 'messages:ai.why.heldYours', values: { count: t.yourVotes } };
  if (t.myVote === 'yes') return { id: 'messages:ai.why.votedYes' };
  if (t.myVote === 'no') return { id: 'messages:ai.why.votedNo' };
  // #6282: what was asked for, on an update on its way.
  if (t.ask) return { id: 'messages:ai.why.asked', values: { ask: t.ask } };
  if (t.quietDays) return { id: 'messages:ai.why.quiet', values: { count: t.quietDays } };
  if (t.by === 'bot' && t.work.stage === 'building' && !t.work.line) return { id: 'messages:ai.why.botBuilding' };
  if (t.by === 'you' && t.work.stage === 'building' && !t.work.line) return { id: 'messages:ai.why.youBuilding' };
  return lineWords(t.work);
}

/**
 * Pure: In progress, less any thread the feed already lists. #6153: a
 * request filed from a private thread of yours carries that thread
 * (`rootId`), which its row opens.
 */
export function inProgress(needs: NeedItem[] | null, work: AiWork | null): AiThread[] {
  const owed = owedKeys(needs);
  const filed = filedThreads(work);
  return (work?.next || []).filter((t) => !isOwed(owed, t)).map((t) => withThread(filed, t));
}

/**
 * Pure: Waiting, less any thread the feed already lists. A request held for
 * one of Homeroom bot's slots counts the bot's changes on its project that
 * wait on your vote: those votes are what frees one. #6153: and a request
 * filed from a private thread carries it, as In progress does.
 */
export function upNext(needs: NeedItem[] | null, work: AiWork | null): AiThread[] {
  const owed = owedKeys(needs);
  const filed = filedThreads(work);
  return (work?.waiting || []).filter((t) => !isOwed(owed, t)).map((t) => {
    const row = withThread(filed, t);
    if (row.work.line?.code !== 'held_waiting' || !row.app) return row;
    const yourVotes = (needs || []).filter((item) => item.app?.slug === row.app!.slug && holdsSlot(item)).length;
    return yourVotes ? { ...row, yourVotes } : row;
  });
}

/** How long a done private thread stays under Live this week. */
const CLOSED_DAYS = 7;

/**
 * Pure: Live this week; #6153: a request filed from a private thread carries
 * it, as In progress does. #6271: then the private threads marked done in the
 * last seven days (newest closed first), each with the thread it opens. One
 * whose filed request already has a row in any list stays that row, never a
 * second one (#6153).
 */
export function liveThisWeek(work: AiWork | null, now = Date.now()): AiThread[] {
  const filed = filedThreads(work);
  const rows = (work?.live || []).map((t) => withThread(filed, t));
  const listed = listedKeys(null, work);
  const closed: AiThread[] = [];
  for (const p of work?.private || []) {
    if (p.state !== 'done' || !p.doneAt) continue;
    const done = new Date(p.doneAt).getTime();
    if (!Number.isFinite(done) || now - done > CLOSED_DAYS * 86400000) continue;
    if (p.app && Number(p.resultRef) > 0 && listed.has(`${p.app.slug}#${Number(p.resultRef)}`)) continue;
    closed.push({
      threadId: 0,
      number: null,
      kind: 'private',
      title: p.title,
      app: p.app,
      change: null,
      href: '',
      group: 'live',
      work: { stage: 'closed', since: p.doneAt },
      at: p.doneAt,
      rootId: p.rootId,
    });
  }
  closed.sort((a, b) => new Date(b.at as string).getTime() - new Date(a.at as string).getTime());
  return [...rows, ...closed];
}

/**
 * The twin of a row's wording on a GitHub-hosted project, where a change's
 * number is written "PR 12" and never "#12" (lib/change-ref.ts). One literal
 * table, so every id stays a whole literal for the language inventory. Ids
 * not in the table are unaffected.
 */
const PR_TWIN: Record<string, string> = {
  'messages:ai.row.stage': 'messages:ai.row.stagePr',
  'messages:ai.row.stageLine': 'messages:ai.row.stageLinePr',
  'messages:ai.live.row': 'messages:ai.live.rowPr',
  'messages:ai.row.fixYours': 'messages:ai.row.fixYoursPr',
};

/** Whether a row names a change on a project whose code is on GitHub. */
export function changeOnGithub(t: AiThread): boolean {
  return t.kind === 'change' && !!t.app?.changesOnGithub;
}

/** Pure: `id`'s twin where a change on GitHub is written "PR N", else `id`. */
export function prWord(id: string, onGithub: boolean): string {
  return onGithub ? (PR_TWIN[id] || id) : id;
}

/** Pure: whether the viewer reads a row as its requester (Needs you's rows are theirs). */
const yours = (t: AiThread) => t.group === 'needs';

/**
 * Pure: a row's whole line: its project and number, its stage, and the
 * stage's second line when it has one ("Seed swap · #12 · Ready to build ·
 * Number 2 in line"). A decision has no number.
 */
function stageLine(t: AiThread): Phrase {
  const values = where(t.app, t.number);
  const stage = stageWords(t.work, { yours: yours(t) });
  const line = lineWords(t.work);
  if (!t.number) {
    return line
      ? { id: 'messages:ai.row.stageLineBare', values: { project: values.project }, nested: { stage, line } }
      : { id: 'messages:ai.row.stageBare', values: { project: values.project }, nested: { stage } };
  }
  return line
    ? { id: 'messages:ai.row.stageLine', values, nested: { stage, line } }
    : { id: 'messages:ai.row.stage', values, nested: { stage } };
}

/** Pure: one In progress or Waiting row's whole line (its tooltip): its project, and where it stands. */
export function nextWords(t: AiThread): Phrase {
  const words = stageLine(t);
  return changeOnGithub(t) ? { ...words, id: prWord(words.id, true) } : words;
}

/**
 * #6158: the Waiting rows nobody is moving, which the tab folds under one
 * "Not moving" head: not started on, or waiting on somebody else's move.
 */
export function notMoving(t: AiThread): boolean {
  return (t.work.stage === 'reading' && t.work.line?.code === 'waiting')
    || t.work.stage === 'waiting_for_you' || t.work.stage === 'stopped';
}

/**
 * Pure: the word on the right of an In progress or Waiting row (./lists.tsx):
 * who is building it, or its stage. The whole line (nextWords) is its tooltip.
 */
export function shortWords(t: AiThread): Phrase {
  if (t.work.stage === 'building' && !t.work.line && t.by === 'bot') return { id: 'messages:ai.short.bot' };
  if (t.work.stage === 'building' && !t.work.line && t.by === 'you') return { id: 'messages:ai.short.you' };
  if (t.work.line?.code === 'claimed' && t.work.line.by) return { id: 'messages:ai.short.claimed', values: { username: t.work.line.by } };
  return stageWords(t.work, { yours: yours(t) });
}

/**
 * Pure: the hero's line under the bot's name: what needs you, what is in
 * progress. A zero says nothing (Y03, audit 2 Nov 2026): each half is said
 * only above zero, and with neither there is no line ("In progress: 0" was).
 * #6262: `fresh` is how many of those threads have something new, said
 * between the two, and only when there is any.
 */
export function heroWords(needs: number, next: number, fresh = 0): Phrase | null {
  const anyFresh = fresh > 0;
  if (needs > 0 && anyFresh && next > 0) return { id: 'messages:ai.hero.bothFresh', values: { needs, fresh, next, count: fresh } };
  if (needs > 0 && anyFresh) return { id: 'messages:ai.hero.needsFresh', values: { needs, fresh, count: fresh } };
  if (needs > 0 && next > 0) return { id: 'messages:ai.hero.both', values: { needs, next } };
  if (needs > 0) return { id: 'messages:ai.hero.needs', values: { needs } };
  if (next > 0) return { id: 'messages:ai.hero.next', values: { next } };
  return null;
}

/**
 * Pure: whether `href` opens a topic page (a request, a change, a decision),
 * whose back chip can name this page as where it was opened from
 * (Improve.enterTopicFrom). A Workshop address is not one: the origin would
 * wait there for the next topic opened from anywhere.
 */
export function isTopicHref(href: string | null | undefined): boolean {
  return /^#?app\/[^/]+\/dev\/(issues|changes|proposals|governance|shared)\/\d+$/.test(String(href || ''));
}
