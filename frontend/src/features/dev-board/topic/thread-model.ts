/**
 * #6019 (threads, stage 3): what a request's or a change's page says about
 * the thread it is in. Pure, so tests read it without a DOM; drawn by
 * ./thread-items.tsx.
 *
 * A thread is one piece of work: its requests, the changes built for them,
 * a vote to close, a decision (src/services/threads.js `threadPage`, read
 * from GET /api/apps/:slug/threads/:number). The page is one of those items;
 * this lists the others, oldest first, each with what it is and where it
 * stands in words, and the newest replies folded under a change's or a
 * vote's row. It also says which way the viewer's Notify me / Mute button
 * goes next.
 */

export type ThreadItemType = 'request' | 'change' | 'close' | 'decision';

export interface FoldedReply {
  id: number;
  username: string;
  bot?: boolean;
  text: string;
  at?: string | null;
}

/**
 * #6225: one request a change closes when it merges, as its Votes card lists
 * it. `confirmed` is whether its requester agreed to it: the change was built
 * for that request, or its filer made the change. A number the change claims
 * that is not a request here has a null title and filer.
 */
export interface ClosesRequest {
  number: number;
  title: string | null;
  by: string | null;
  confirmed: boolean;
}

export interface ThreadItem {
  type: ThreadItemType;
  id: number;
  number: number | null;
  title: string | null;
  status: string;
  /** A change's place in its life (issue-proposal-ref.js `stateOf`). */
  state?: 'underway' | 'review' | 'merged';
  /**
   * A change: when production first ran it (chat_sessions.live_at), the fact
   * its own pill reads. Null from the merge until the rollout ends; a change
   * sent without it reads as live, as merge-status.js does.
   */
  liveAt?: string | null;
  /** #6139, a change underway: built, with its checks passing on its current head and nothing working on it. */
  ready?: boolean;
  at?: string | null;
  replies: number;
  folded?: FoldedReply[];
  /** Stage 6, a change: the approval epoch a vote is cast under, and the viewer's vote on it (a close's too). */
  epoch?: number | null;
  myVote?: 'yes' | 'no' | null;
  /** Who made it: the request's asker, the change's builder, the vote's proposer. */
  by?: string | null;
  /** That maker is Homeroom bot (an account the platform runs). */
  byBot?: boolean;
  /** The viewer made it. */
  mine?: boolean;
  /** A close vote: the proposer's reason, and the request it was filed on. */
  reason?: string | null;
  target?: number | null;
  /**
   * #6439, a close vote: how an ended vote ended, off the governance
   * machine's audit (src/services/threads.js). `closed` it passed; `kept` it
   * was withdrawn or could not be applied; `elsewhere` the request closed
   * another way. Null while it is open.
   */
  outcome?: 'closed' | 'kept' | 'elsewhere' | null;
  /** A change: the requests it closes when it merges (its linked_issues). */
  closes?: number[];
  /** #6420: among `closes`, the requests whose requester answered "This doesn't close it". */
  notConfirmed?: number[];
  /** #6225: the same requests with their titles and filers, for the Votes card. */
  closesRequests?: ClosesRequest[];
  /**
   * 1 Nov 2026 (C2.3), a change: the plan it was built from, by that plan's
   * session and version (a person's plan on the request, or the bot's own
   * its requester approved: src/services/threads.js builtFrom).
   */
  builtFrom?: {
    sessionId: number;
    version: number | null;
    /** #6406: a newer plan on the request than the one this change follows. */
    newer?: { version: number; author: string | null; sameAuthor: boolean } | null;
  } | null;
}

export interface ThreadFollow {
  state: 'following' | 'muted' | 'none';
  chosen: boolean;
}

export interface ThreadPayload {
  thread: {
    id: number;
    number: number | null;
    kind: 'work' | 'decision';
    lead: 'request' | 'change' | 'decision';
    title: string | null;
    state: 'open' | 'closed';
    /** #6421: how many requests the thread holds. */
    requests?: number;
    /** #6421: the thread's name: its change's title while one lives there, else its first request's. */
    name?: string | null;
  };
  items: ThreadItem[];
  /** Null signed out: there is no one to notify. */
  follow: ThreadFollow | null;
  /** Stage 6: a merge or split waiting on this thread (services/thread-moves.js). */
  moves?: ThreadMove[];
  /**
   * 1 Nov 2026 (one page per thread, D4): changes for one of this thread's
   * requests that live on another request's page (services/threads.js
   * changesElsewhere): `request` is the one of ours it closes, `on` the
   * request whose page it is on.
   */
  elsewhere?: ThreadElsewhere[];
}

export interface ThreadElsewhere {
  id: number;
  number: number | null;
  title: string | null;
  /** #6420: the first sentence of the change's summary, or null for none. */
  summary?: string | null;
  on: number;
  request: number;
  /** #6420: the requester answered "This doesn't close it". */
  disputed?: boolean;
  /** #6420: the viewer is this request's requester, so "This doesn't close it" is theirs to press. */
  ask?: boolean;
  /** #6420: the viewer asked for this request, so the after-press line is theirs to read. */
  mine?: boolean;
}

/** D4: the changes for request `number` that live on another request's page. Pure. */
export function elsewhereFor(payload: ThreadPayload | null, number: number): ThreadElsewhere[] {
  const list = payload && Array.isArray(payload.elsewhere) ? payload.elsewhere : [];
  return list.filter((e) => Number(e.request) === Number(number) && Number(e.on) !== Number(number));
}

/**
 * #6224: the other requests a change closes besides `request`, ascending and
 * without duplicates, read from its `closes` (its linked_issues, the set its
 * merge closes). Empty when it does not close this request at all, so a
 * change living on another request's page says nothing here. Pure.
 */
export function alsoCloses(item: ThreadItem, request: number): number[] {
  const closes = Array.isArray(item.closes) ? item.closes.map(Number) : [];
  const here = Number(request);
  if (!closes.includes(here)) return [];
  return [...new Set(closes)].filter((n) => Number.isInteger(n) && n > 0 && n !== here).sort((a, b) => a - b);
}

/**
 * #6225: what a change's Votes card lists under its tally, while it is up for
 * a vote: every request a yes would close, ascending. Nothing before it is
 * proposed or after it merges, because the list describes what a yes would
 * do, and nothing when it closes only the one request it was built for. Pure.
 */
export function closesList(item: ThreadItem): ClosesRequest[] {
  const list = Array.isArray(item.closesRequests) ? item.closesRequests : [];
  if (item.state !== 'review') return [];
  if (list.length === 1 && list[0] && list[0].confirmed) return [];
  return [...list].sort((a, b) => Number(a.number) - Number(b.number));
}

export interface ThreadMove {
  id: number;
  kind: 'merge' | 'split' | 'breakup';
  state: 'pending' | 'voting' | 'applied' | 'refused';
  input: {
    into?: number; intoNumber?: number | null; items?: Array<{ type: ThreadItemType; number?: number; id?: number }>;
    /** A break-up (#6019 follow-up): the request, and the smaller ones it becomes. */
    request?: number; parts?: Array<{ title: string; doneWhen?: string }>;
  };
  deadline: string;
  agreed: number[];
  governanceId: number | null;
  /**
   * #6421: a change's consent question, asked of the request's other
   * requesters (services/thread-moves.js gather). Yes gathers the thread
   * into the change's; Keep separate leaves it linked where it is.
   */
  forChange?: { id: number | null; number: number | null };
  /** #6421: the requesters still to answer, by username. */
  askOf?: string[];
  /** #6421: the viewer is one of them. */
  canAnswer?: boolean;
}

/** The page the list is drawn on: a request by its number, the rest by id. */
export interface ThreadHere {
  type: ThreadItemType;
  id: number;
}

/** One message id and what it is read with. */
export interface Phrase {
  id: string;
  values?: Record<string, string | number>;
}

export interface ThreadRowView {
  key: string;
  type: ThreadItemType;
  /** The row's subject: the item's own title, else what it is. */
  title: Phrase | string;
  /** What it is, where it stands, and its replies, joined with " · ". */
  facts: Phrase[];
  /** Where a tap goes, as AppView.openTopic takes it. */
  open: { kind: 'issue' | 'proposal' | 'gov'; id: number };
  folded: FoldedReply[];
}

/** Whether `item` is the page this list is drawn on. */
function isHere(item: ThreadItem, here: ThreadHere | null): boolean {
  if (!here || here.type !== item.type) return false;
  return item.type === 'request' ? item.number === here.id : item.id === here.id;
}

function what(item: ThreadItem): Phrase {
  if (item.type === 'request') return { id: 'project:topic.thread.item.request', values: { number: item.number ?? 0 } };
  if (item.type === 'change') {
    return item.number
      ? { id: 'project:topic.thread.item.change', values: { number: item.number } }
      : { id: 'project:topic.thread.item.changeUnnumbered' };
  }
  if (item.type === 'close') return { id: 'project:topic.thread.item.close' };
  return { id: 'project:topic.thread.item.decision' };
}

/**
 * A change that has merged but is not running yet: the same fact its own pill
 * reads (merge-status.js), so the header never says Live before it does. A
 * change sent without `liveAt` reads as live, as it always did.
 */
function goingLive(item: ThreadItem): boolean {
  return item.state === 'merged' && item.liveAt === null;
}

function standing(item: ThreadItem): Phrase | null {
  if (item.type === 'request') {
    return { id: item.status === 'closed' ? 'project:topic.thread.state.closed' : 'project:topic.thread.state.open' };
  }
  if (item.type === 'change') {
    return item.state === 'merged'
      ? { id: goingLive(item) ? 'project:topic.thread.state.goingLive' : 'project:topic.thread.state.live' }
      : item.state === 'review' ? { id: 'project:topic.thread.state.voting' }
        : { id: item.ready ? 'project:topic.thread.state.ready' : 'project:topic.thread.state.underway' };
  }
  return { id: item.status === 'open' ? 'project:topic.thread.state.voting' : 'project:topic.thread.state.settled' };
}

/** The other items in the thread, oldest first. */
export function threadRows(payload: ThreadPayload | null, here: ThreadHere | null): ThreadRowView[] {
  if (!payload || !Array.isArray(payload.items)) return [];
  return payload.items
    .filter((item) => !isHere(item, here))
    .map((item) => {
      const facts: Phrase[] = [what(item)];
      const stands = standing(item);
      if (stands) facts.push(stands);
      // Zero says nothing.
      if (item.replies > 0) facts.push({ id: 'project:topic.thread.replies', values: { count: item.replies } });
      const open = item.type === 'request'
        ? { kind: 'issue' as const, id: item.number ?? 0 }
        : item.type === 'change'
          ? { kind: 'proposal' as const, id: item.id }
          : { kind: 'gov' as const, id: item.id };
      return {
        key: `${item.type}:${item.id}`,
        type: item.type,
        title: item.title || what(item),
        facts,
        open,
        folded: item.type === 'request' ? [] : (item.folded || []),
      };
    });
}

export interface FollowButtonView {
  label: string;
  hint: string;
  /** Muted is the pressed state, as a channel's Mute is. */
  pressed: boolean;
  /** What a press sends: Notify me (true), Mute (false), back to the rule (null). */
  next: boolean | null;
}

/**
 * The viewer's one button. Not following: Notify me. Following, for any
 * reason: Mute. Muted: pressing it again goes back to the rule, which
 * follows whoever asked, built, voted or posted.
 */
export function followButton(follow: ThreadFollow | null): FollowButtonView | null {
  if (!follow) return null;
  if (follow.state === 'muted') {
    return { label: 'project:topic.thread.follow.muted', hint: 'project:topic.thread.follow.mutedHint', pressed: true, next: null };
  }
  if (follow.state === 'following') {
    return { label: 'project:topic.thread.follow.mute', hint: 'project:topic.thread.follow.muteHint', pressed: false, next: false };
  }
  return { label: 'project:topic.thread.follow.notifyMe', hint: 'project:topic.thread.follow.notifyMeHint', pressed: false, next: true };
}

/**
 * Stage 6: what a waiting move says, in two phrases: what it would do, and
 * when it happens or why it waits. `now` is a clock in ms.
 */
export function moveLines(move: ThreadMove, now: number = Date.now()): { what: Phrase; when: Phrase } {
  const items = move.input.items || [];
  // #6421: a change's question to a request's other askers.
  if (move.forChange) {
    return {
      what: {
        id: 'project:topic.thread.move.consentAsk',
        values: { number: move.input.intoNumber ?? '?', change: move.forChange.number ?? '?' },
      },
      when: {
        id: 'project:topic.thread.move.consentWaiting',
        values: { names: (move.askOf || []).join(', ') },
      },
    };
  }
  const what: Phrase = move.kind === 'merge'
    ? { id: 'project:topic.thread.move.merge', values: { number: move.input.intoNumber ?? '?' } }
    : move.kind === 'breakup'
    ? { id: 'project:topic.thread.move.breakup', values: { number: move.input.request ?? '?', count: (move.input.parts || []).length } }
    : {
      id: 'project:topic.thread.move.split',
      values: { what: items.map((i) => (i.type === 'request' ? `#${i.number}` : i.type)).join(', ') },
    };
  if (move.state === 'voting') return { what, when: { id: 'project:topic.thread.move.voting' } };
  const hours = Math.max(1, Math.ceil((Date.parse(move.deadline) - now) / 3600000));
  return { what, when: { id: 'project:topic.thread.move.pending', values: { count: Number.isFinite(hours) ? hours : 24 } } };
}

/** Stage 6: the items a split may take, every one but the thread's lead. Pure. */
export function splittable(payload: ThreadPayload | null): ThreadItem[] {
  if (!payload) return [];
  const lead = payload.thread.number;
  return payload.items.filter((i) => !(lead != null && i.number === lead && (i.type === 'request' || i.type === 'change')));
}

/**
 * #6019, follow-up: what a request's page draws from its thread. Its
 * changes follow the request under a rule, each with its Votes and Tested
 * cards (or, when they compete, one ballot between them), then an open vote
 * to close it; the list under them (./thread-items.tsx) holds the rest:
 * other requests, decisions, and votes already settled. A change's own page
 * keeps the list as it was. Pure.
 */
export interface ThreadLayout {
  /** Every change in the thread, oldest first. */
  changes: ThreadItem[];
  /**
   * The vote to close the thread: the open one, else the latest one that
   * has ended (#6439: its card stays and says how it ended). Null when the
   * thread has never had one.
   */
  close: ThreadItem | null;
  /** The items the list under them still names. */
  listed: ThreadItem[];
}

export function threadLayout(payload: ThreadPayload | null, here: ThreadHere | null): ThreadLayout {
  const items = payload && Array.isArray(payload.items) ? payload.items : [];
  if (!here || here.type !== 'request') return { changes: [], close: null, listed: items };
  const changes = items.filter((i) => i.type === 'change');
  // #6439: an open vote to close leads; once every vote has ended, the
  // latest one keeps its card, so the request's page says how it ended.
  // Older ended votes stay in the list below, as they always have.
  const closes = items.filter((i) => i.type === 'close');
  const open = closes.find((i) => i.status === 'open') || null;
  const latest = closes.reduce<ThreadItem | null>(
    (best, i) => (!best || Number(i.id) > Number(best.id) ? i : best), null);
  const close = open || latest;
  const listed = items.filter((i) => i.type !== 'change' && i !== close);
  return { changes, close, listed };
}

/**
 * Stage 6: competing changes. Changes compete only when they would close the
 * same request (their `closes` overlap): being in one thread is not enough,
 * and a change that closes nothing, or closes another request of the thread,
 * is on no ballot (#5997 on prod, 29 Oct: it was "part of #5927" and closed
 * nothing, and #5995's merge closed it as superseded). The ballot is drawn
 * for `anchor`, the requests a page is about: the request's own number on its
 * page, a change's own `closes` on its page (the thread's number when none is
 * given). Two or more changes up for a vote that close one of them read as
 * one ballot: pick one, or Neither. An open vote to close, filed on one of
 * them, competes the same way, and Close it stands in for Neither.
 * Underneath each keeps its own vote, pinned to its own revision (a push
 * clears only that change's), and the first to pass its project's approval
 * rule goes in and closes the rest.
 *
 * Proposing counts as a yes (governance-rules.ts): on a project whose rule
 * counts yeses, a change's author is counted for it unless they voted No, so
 * the ballot shows their own change as their pick. `authorCounts` names the
 * changes whose author that is true of for this viewer (read off each
 * change's own proposal: its rule, and its author a person, not the bot).
 * Null when there is no ballot. Pure.
 */
export interface Ballot {
  options: ThreadItem[];
  /** The open vote to close it, standing in for Neither. */
  close: ThreadItem | null;
  pick: number | 'neither' | 'close' | null;
}

/** A change's vote as the gate counts it for the viewer: their own, or their authorship. */
function counted(o: ThreadItem, authorCounts: ReadonlySet<number>): 'yes' | 'no' | null {
  if (o.myVote) return o.myVote;
  return o.mine && authorCounts.has(o.id) ? 'yes' : null;
}

export function ballotOf(
  payload: ThreadPayload | null,
  authorCounts: ReadonlySet<number> = new Set(),
  anchor: readonly number[] | null = null,
): Ballot | null {
  if (!payload) return null;
  const lead = payload.thread.number;
  const on = new Set((anchor && anchor.length ? anchor : lead != null ? [lead] : []).map(Number));
  if (!on.size) return null;
  const closesHere = (i: ThreadItem) => (i.closes || []).some((n) => on.has(Number(n)));
  const options = payload.items.filter((i) => i.type === 'change' && i.state === 'review' && closesHere(i));
  const close = payload.items.find((i) => i.type === 'close' && i.status === 'open' && i.target != null && on.has(Number(i.target))) || null;
  if (options.length < (close ? 1 : 2)) return null;
  const votes = options.map((o) => counted(o, authorCounts));
  const yes = options.filter((_, i) => votes[i] === 'yes');
  const pick = close && close.myVote === 'yes' && !yes.length ? 'close'
    : yes.length === 1 ? yes[0].id
      : !close && votes.every((v) => v === 'no') ? 'neither' : null;
  return { options, close, pick };
}

export type BallotVote =
  | { kind: 'change'; sessionId: number; vote: 'yes' | 'no' | null; epoch: number | null }
  | { kind: 'close'; issueId: number; vote: 'yes' | null };

/**
 * The votes a pick casts. A change: Yes on it, and its Yes taken back from
 * every other (a No would count against it). The viewer's own change, which
 * counts as their Yes without a vote, takes a No to stop counting. Neither,
 * or Close it: No on every change, and Close it is Yes on the close. Only
 * what changes is cast; a close's Yes is taken back by voting it again (the
 * server's toggle). Pure.
 */
export function ballotVotes(ballot: Ballot, pick: number | 'neither' | 'close', authorCounts: ReadonlySet<number> = new Set()): BallotVote[] {
  const out: BallotVote[] = [];
  for (const o of ballot.options) {
    const now = counted(o, authorCounts);
    const implicit = !o.myVote && now === 'yes';
    let want: 'yes' | 'no' | null;
    if (pick === 'neither' || pick === 'close') want = 'no';
    else if (o.id === pick) want = 'yes';
    else want = now === 'yes' ? (implicit ? 'no' : null) : now;
    if (want === now) continue;
    out.push({ kind: 'change', sessionId: o.id, vote: want, epoch: o.epoch ?? null });
  }
  if (ballot.close) {
    const want = pick === 'close' ? 'yes' : null;
    const now = ballot.close.myVote === 'yes' ? 'yes' : null;
    if (want !== now) out.push({ kind: 'close', issueId: ballot.close.id, vote: want });
  }
  return out;
}

/**
 * #6019, follow-up: the pill beside a request's number in its page's bar,
 * in the status pill's own shape and tones (../card/model.ts
 * StatusPillState): where the work in its thread stands. Nothing once it is
 * closed (the bar's own line says how it ended) or before anything moved.
 * `stand` is 'closed', or the bot's track state ('building', …), or null;
 * `say` words a message id. Pure.
 */
export function requestPill(
  layout: ThreadLayout,
  stand: string | null,
  say: (id: string) => string = (id) => id,
): { tier: number; key: string; label: string; tone: string; yes: number; no: number; majority: number; advisory: number; lock: boolean; spinner?: boolean } | null {
  if (stand === 'closed') return null;
  const base = { tier: 1, yes: 0, no: 0, majority: 1, advisory: 0, lock: false };
  // #6439: an ended vote to close still draws its card, but the header only
  // says a vote is on while one is open.
  const close = layout.close && layout.close.status === 'open' ? layout.close : null;
  const review = layout.changes.filter((c) => c.state === 'review').length;
  if (review >= 2 || (review >= 1 && close)) return { ...base, key: 'choosing', label: say('project:topic.thread.pill.choosing'), tone: 'neutral' };
  if (review === 1) return { ...base, key: 'vote', label: say('project:topic.thread.pill.vote'), tone: 'neutral' };
  if (close) return { ...base, key: 'close', label: say('project:topic.thread.pill.close'), tone: 'neutral' };
  const underway = layout.changes.filter((c) => c.state === 'underway');
  if (underway.some((c) => !c.ready) || stand === 'building') {
    return { ...base, key: 'building', label: say('project:topic.thread.pill.building'), tone: 'progress', spinner: true };
  }
  // #6532: a build that is ready and waits its turn is not being built yet.
  if (stand === 'ready_to_build') {
    return { ...base, key: 'ready_to_build', label: say('project:topic.thread.pill.readyToBuild'), tone: 'neutral' };
  }
  // #6139: every change underway has finished; only putting one up is left.
  if (underway.length) return { ...base, key: 'ready', label: say('project:topic.thread.pill.ready'), tone: 'neutral' };
  // Merged is live only once production runs it, the fact each change's own
  // pill reads: until then the header says Going live, never Live.
  if (layout.changes.some(goingLive)) {
    return { ...base, key: 'going_live', label: say('project:topic.thread.pill.goingLive'), tone: 'progress', spinner: true };
  }
  if (layout.changes.some((c) => c.state === 'merged')) return { ...base, key: 'live', label: say('project:topic.thread.pill.live'), tone: 'ok' };
  return null;
}
