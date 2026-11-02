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
 *               "Up next" read as yours to do next).
 *   Live        yours that went live this week.
 *
 * The last four are GET /api/ai/work's, and where Homeroom bot works on a
 * request for you, its list is the bot's own word on it (services/ai-work.js
 * botStages), so this page and the bot's answer in Main agree (29 Oct 2026).
 *
 * A row's words are phrases (an id and its values), translated where they
 * are drawn, so this module needs no i18n runtime and its tests read it bare.
 */

export interface AiApp {
  slug: string;
  name: string;
  icon_url?: string | null;
  icon_emoji?: string | null;
}

export interface AiPrivate {
  rootId: number;
  title: string;
  kind: string;
  app: AiApp | null;
  at: string | null;
  /** 1 Nov 2026: what a thread opened from a request's or a change's page is about; its row carries the number. */
  about?: { kind: 'request' | 'change'; number: number } | null;
}

export interface AiThread {
  threadId: number;
  number: number | null;
  kind: string;
  title: string | null;
  app: AiApp | null;
  change: { id: number; number: number | null } | null;
  href: string;
  group: 'needs' | 'next' | 'waiting' | 'live';
  what:
    | 'plan' | 'decide' | 'build_stopped'
    | 'going_live' | 'merging' | 'fixing' | 'revising' | 'building' | 'reading'
    | 'vote' | 'checking' | 'decision' | 'fix_queued' | 'followup_queued' | 'build_queued' | 'held' | 'stalled' | 'queued' | 'on_hold'
    | 'not_picked_up' | 'awaiting_plan'
    | 'live';
  at: string | null;
  quietDays?: number;
  /** Up for a vote (a change's, or a decision's): how you voted, if you have. */
  myVote?: 'yes' | 'no' | null;
  /** Being made: by Homeroom bot, by you, or by someone else. */
  by?: 'bot' | 'you' | 'someone';
  /** Held back: until a change up for a vote is decided, or by the day's limit. */
  heldBy?: 'approvals' | 'daily';
  /** A request someone has claimed and has no change for yet: who. */
  claimedBy?: string | null;
  /** Held for a slot: how many of Homeroom bot's changes holding one wait on your vote (upNext). */
  yourVotes?: number;
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
  /** Who proposed it, by username: Homeroom bot's own changes hold its slots. */
  author?: string | null;
  /**
   * B17: the change is on a project that is just this person's, so their
   * yes alone approves it (workshop-overview.js approvedAlone). Its row says
   * Approve, as its card and the project's own Needs you do; Vote elsewhere.
   */
  approve?: boolean;
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
    if (t.what === 'held' && t.heldBy !== 'daily' && t.app) held.add(t.app.slug);
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
  /** Where the row goes: a page, or a private thread of Main. */
  href: string | null;
  rootId: number | null;
  /**
   * B06 (audit 2 Nov 2026): a plan of Homeroom bot's waiting for your Build
   * it. Its Build it is on the plan in Main Chat, so the row opens there, at
   * the plan; the request's page has no Build it.
   */
  plan?: { slug: string; number: number } | null;
}

/**
 * How many rows each project shows in a section before its own Show more
 * (./lists.tsx groups every section's rows by project). Needs you shows the
 * most: it is what you came for.
 */
export const GROUP_FIRST = { needs: 5, next: 3, waiting: 3, live: 3 } as const;

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
  plan: 'messages:ai.pill.buildIt',
  decide: 'messages:ai.pill.decide',
  build_stopped: 'messages:ai.pill.tryAgain',
};

/** Pure: the page a Needs you card is decided on. */
export function needHref(item: NeedItem): string | null {
  if (item.href) return item.href;
  const slug = item.app?.slug;
  if (!slug) return null;
  const app = encodeURIComponent(slug);
  if (item.kind === 'governance') return `#app/${app}/dev/governance/${Number(item.id)}`;
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

/** Pure: Needs you, in order: the feed's cards, the bot's plans waiting for Build it, then your private threads. */
export function needsYou(needs: NeedItem[] | null, work: AiWork | null): WorkRow[] {
  const rows: WorkRow[] = [];
  const owed = owedKeys(needs);
  const held = heldProjects(work);
  for (const item of needs || []) {
    const app = item.app || null;
    rows.push({
      key: `need:${item.kind}:${item.id}`,
      title: (item.kind === 'ballot' && item.ballot?.title) || item.title || '',
      app,
      who: 'all',
      // A vote on a change of Homeroom bot's, where a request of yours waits
      // for one of its slots: deciding it lets that request be built.
      sub: app && held.has(app.slug) && holdsSlot(item)
        ? { id: 'messages:ai.row.voteFreesSlot', values: where(app, shownNumber(item)) }
        : whereLine(app, shownNumber(item)),
      pill: item.kind === 'proposal' && item.approve === true
        ? { id: 'messages:ai.pill.approve' }
        : { id: PILLS[item.kind] || 'messages:ai.pill.needsYou' },
      href: needHref(item),
      rootId: null,
    });
  }
  for (const t of work?.needs || []) {
    if (isOwed(owed, t)) continue;
    rows.push({
      key: `${t.what === 'decide' ? 'decide' : t.what === 'build_stopped' ? 'stopped' : 'plan'}:${t.threadId}`,
      title: t.title || '',
      app: t.app,
      who: 'all',
      // Homeroom bot read it and handed it back (its verdict "a person must
      // decide"): nothing moves until a person does, so it is Needs you's,
      // and says why rather than "Nobody is building it yet" (30 Oct 2026).
      // A build of Homeroom bot's that came to nothing waits on somebody
      // asking again, so it is here too, with Try again.
      sub: t.what === 'decide'
        ? { id: 'messages:ai.row.decide', values: where(t.app, t.number) }
        : t.what === 'build_stopped'
          ? { id: 'messages:ai.row.buildStopped', values: where(t.app, t.number) }
          : whereLine(t.app, t.number),
      pill: { id: PILLS[t.what] || 'messages:ai.pill.needsYou' },
      href: t.href,
      rootId: null,
      ...(t.what === 'plan' && t.app && t.number ? { plan: { slug: t.app.slug, number: t.number } } : {}),
    });
  }
  for (const p of work?.private || []) {
    // 1 Nov 2026: a thread about a request or a change is drawn by it, its
    // number before its title as a request's row is ("#18 Dark mode").
    const about = p.about && p.about.number > 0 && p.app ? p.about : null;
    rows.push({
      key: `private:${p.rootId}`,
      title: p.title,
      app: p.app,
      who: p.app ? 'me' : 'solo',
      sub: about
        ? {
          id: about.kind === 'change' ? 'messages:ai.row.privateAboutChange' : 'messages:ai.row.privateAbout',
          values: { project: p.app!.name || p.app!.slug, number: about.number },
        }
        : p.app
          ? { id: 'messages:ai.row.privateDraft', values: { project: p.app.name || p.app.slug } }
          : { id: 'messages:ai.row.privateIdea' },
      pill: null,
      href: null,
      rootId: p.rootId,
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
  'messages:ai.row.decide': 'messages:ai.why.decide',
  'messages:ai.row.buildStopped': 'messages:ai.why.buildStopped',
  'messages:ai.row.voteFreesSlot': 'messages:ai.why.voteFreesSlot',
};

/**
 * Pure: a Needs you row's reason, where it is news: a phone shows it under
 * the title, where nothing hovers to show the tooltip. A plain vote or a
 * plan says nothing more than its pill does, so it has none.
 */
export function whyOf(row: WorkRow): Phrase | null {
  const id = WHY[row.sub.id];
  return id ? { id } : null;
}

/** Pure: the same for an In progress or Waiting row: a slot your votes can free. */
export function threadWhy(t: AiThread): Phrase | null {
  if (t.what === 'held' && t.yourVotes) return { id: 'messages:ai.why.heldYours', values: { count: t.yourVotes } };
  return null;
}

/** Pure: In progress, less any thread the feed already lists. */
export function inProgress(needs: NeedItem[] | null, work: AiWork | null): AiThread[] {
  const owed = owedKeys(needs);
  return (work?.next || []).filter((t) => !isOwed(owed, t));
}

/**
 * Pure: Waiting, less any thread the feed already lists. A request held for
 * one of Homeroom bot's slots counts the bot's changes on its project that
 * wait on your vote: those votes are what frees one.
 */
export function upNext(needs: NeedItem[] | null, work: AiWork | null): AiThread[] {
  const owed = owedKeys(needs);
  return (work?.waiting || []).filter((t) => !isOwed(owed, t)).map((t) => {
    if (t.what !== 'held' || t.heldBy === 'daily' || !t.app) return t;
    const yourVotes = (needs || []).filter((item) => item.app?.slug === t.app!.slug && holdsSlot(item)).length;
    return yourVotes ? { ...t, yourVotes } : t;
  });
}

/** The words of an In progress or Waiting row's tooltip, by what it waits on. */
const THREAD_WORDS: Record<string, string> = {
  going_live: 'messages:ai.next.goingLive',
  merging: 'messages:ai.next.merging',
  fixing: 'messages:ai.next.fixing',
  revising: 'messages:ai.next.revising',
  building: 'messages:ai.next.building',
  reading: 'messages:ai.next.reading',
  vote: 'messages:ai.up.vote',
  checking: 'messages:ai.up.checking',
  fix_queued: 'messages:ai.up.fixQueued',
  followup_queued: 'messages:ai.up.followUpQueued',
  build_queued: 'messages:ai.up.buildQueued',
  held: 'messages:ai.up.held',
  stalled: 'messages:ai.up.stalled',
  queued: 'messages:ai.up.queued',
  on_hold: 'messages:ai.up.onHold',
  not_picked_up: 'messages:ai.up.notPickedUp',
  // 1 Nov 2026: their own request, which the bot waits to plan with them.
  awaiting_plan: 'messages:ai.up.awaitingPlan',
};

/** Pure: one In progress or Waiting row's whole line (its tooltip): its project, and what it waits on. */
export function nextWords(t: AiThread): Phrase {
  const values = where(t.app, t.number);
  if (t.what === 'not_picked_up') {
    if (!t.number) return { id: 'messages:ai.up.notPickedUpBare', values: { project: values.project } };
    if (t.quietDays) return { id: 'messages:ai.up.quiet', values: { ...values, count: t.quietDays } };
  }
  if (t.what === 'vote' && t.myVote === 'yes') return { id: 'messages:ai.up.voteYes', values };
  if (t.what === 'vote' && t.myVote === 'no') return { id: 'messages:ai.up.voteNo', values };
  // A decision has no number: its project, and that it waits for votes.
  if (t.what === 'decision') {
    const project = { project: values.project };
    if (t.myVote === 'yes') return { id: 'messages:ai.up.decisionYes', values: project };
    if (t.myVote === 'no') return { id: 'messages:ai.up.decisionNo', values: project };
    return { id: 'messages:ai.up.decision', values: project };
  }
  if (t.what === 'held' && t.heldBy === 'daily') return { id: 'messages:ai.up.heldDaily', values };
  if (t.what === 'held' && t.yourVotes) return { id: 'messages:ai.up.heldYours', values: { ...values, count: t.yourVotes } };
  if (t.what === 'building' && t.by === 'bot') return { id: 'messages:ai.next.botBuilding', values };
  if (t.what === 'building' && t.by === 'you') return { id: 'messages:ai.next.youBuilding', values };
  // Claimed, with no change yet: who has it, not "Nobody is building it yet".
  if (t.what === 'building' && t.claimedBy) return { id: 'messages:ai.next.claimed', values: { ...values, username: t.claimedBy } };
  return { id: THREAD_WORDS[t.what] || 'messages:ai.row.where', values };
}

/** The one word on the right of an In progress or Waiting row, by what it waits on. Whole ids, so the inventory finds them. */
const SHORT_WORDS: Record<string, string> = {
  going_live: 'messages:ai.short.goingLive',
  merging: 'messages:ai.short.merging',
  fixing: 'messages:ai.short.fixing',
  revising: 'messages:ai.short.revising',
  reading: 'messages:ai.short.reading',
  building: 'messages:ai.short.building',
  vote: 'messages:ai.short.votes',
  checking: 'messages:ai.short.checks',
  decision: 'messages:ai.short.votes',
  fix_queued: 'messages:ai.short.builder',
  followup_queued: 'messages:ai.short.builder',
  queued: 'messages:ai.short.builder',
  build_queued: 'messages:ai.short.turn',
  held: 'messages:ai.short.slot',
  stalled: 'messages:ai.short.stalled',
  on_hold: 'messages:ai.short.monday',
  not_picked_up: 'messages:ai.short.nobody',
  awaiting_plan: 'messages:ai.short.yourPlan',
};

/**
 * Pure: the one word on the right of an In progress or Waiting row
 * (./lists.tsx): who is at it, or what it waits on. The whole line
 * (nextWords) is its tooltip.
 */
export function shortWords(t: AiThread): Phrase {
  if (t.what === 'building' && t.by === 'bot') return { id: 'messages:ai.short.bot' };
  if (t.what === 'building' && t.by === 'you') return { id: 'messages:ai.short.you' };
  if (t.what === 'building' && t.claimedBy) return { id: 'messages:ai.short.claimed', values: { username: t.claimedBy } };
  if (t.what === 'held' && t.heldBy === 'daily') return { id: 'messages:ai.short.tomorrow' };
  return { id: SHORT_WORDS[t.what] || 'messages:ai.short.waiting' };
}

/**
 * Pure: the hero's line under the bot's name: what needs you, what is in
 * progress. A zero says nothing (Y03, audit 2 Nov 2026): each half is said
 * only above zero, and with neither there is no line ("In progress: 0" was).
 */
export function heroWords(needs: number, next: number): Phrase | null {
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
