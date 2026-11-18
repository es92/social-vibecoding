/**
 * The Homeroom bot tab's rows, built once for both of its faces (11 Nov
 * 2026): the standard list (./lists.tsx) and the list the looks draw
 * (./frame-list.tsx). A row is a `Line`: what it is, its project, the name
 * of its glyph, its number, its title, the one word on its right, its
 * tooltip, and its press. Which projects the chips offer, what is new, what
 * a search keeps, the counts over each list and the notes that stand in for
 * an empty one are decided here too, so the two faces cannot disagree.
 *
 * Nothing here draws: a glyph is a name (`Glyph`), and each face has its own
 * icon for it.
 */
import { dayNumber, inZone, zonedDay } from '../../lib/time-zone';
import { getDateLocale } from '../../lib/i18n/runtime';
import { useMessages } from '../../lib/i18n/react';
import { tabLacks, useTabBuild } from '../../lib/tab-build';
import { rowKey } from './column';
import { botTabAddress } from './door';
import { byMonth, historyGlyph, historyTooltip, historyWords, type HistoryRow, type HistoryState } from './history';
import {
  changeOnGithub, freshByProject, freshCount, nextWords, notMoving, prWord, railProjects, rankProjects, shortWords, threadWhy, whyOf, withProjects,
  type AiApp, type AiThread, type Phrase, type WorkRow,
} from './model';
import { cleanQuery, foundDay, markParts, type Found, type MarkPart } from './search';

/** What a row's glyph shows, by name. */
export type Glyph =
  | 'chat' | 'play' | 'hand' | 'check' | 'again' | 'warning' | 'lock' | 'ballot'
  | 'upload' | 'eye' | 'cog' | 'reply' | 'code' | 'clock' | 'camera' | 'x' | 'bubble';

export interface Line {
  key: string;
  /** What the row is, for the page's checks: need, plan, decide, … or a thread's `what`. */
  kind: string;
  app: AiApp | null;
  glyph: Glyph;
  number: number | null;
  /** The number names a change on GitHub: it reads "PR 12", never "#12". */
  pr?: boolean;
  title: string;
  /** #6421: how many requests the thread holds, for "· 10 requests" after the title. */
  requests?: number;
  right: string;
  tooltip: string;
  /** On a phone, a second line: the reason, where it is news. */
  why: string | null;
  /** Yours to do: the glyph and the word in the accent. */
  owe: boolean;
  /** Its chat is the one in the column beside the list: where you are. */
  lit?: boolean;
  /** #6262: someone has written in its thread since you last opened it. */
  fresh?: boolean;
  /** 18 Nov 2026: it moved while the page was up (./model.ts movedSince), so it is not folded. */
  moved?: boolean;
  open: () => void;
  /** #6159: a private thread's row: its ⋯ has Mark done. */
  done?: { rootId: number; mark: () => void } | null;
  /** History: a row in a private community the person left (its project's name says so). */
  left?: boolean;
  /** When it started needing the viewer, for the day its row is grouped under. */
  at?: string | null;
}

/**
 * A message the search found (13 Nov 2026, ./search.ts): a link to it, its
 * snippet split at the words that matched, where it is (its thread's name,
 * or the chat itself), its day, and the whole of that as its name.
 */
export interface FoundLine {
  key: string;
  /** The tab's address of the message: its thread, or the chat, at it (./door.ts). */
  href: string;
  /** The message the row opens, so its words can be marked there (./search-mark.ts). */
  messageId: number;
  /** The query it was found by, as the search asked it (./search.ts cleanQuery). */
  q: string;
  /** It is in a thread; otherwise in the chat itself. */
  thread: boolean;
  parts: MarkPart[];
  place: string;
  date: string;
  /** The row's accessible name and tooltip: who wrote it, its words, where and when. */
  name: string;
}

/** Needs you's glyph, by what the row asks. */
function needGlyph(row: WorkRow): Glyph {
  const kind = row.key.startsWith('need:') ? row.key.split(':')[1] : row.key.split(':')[0];
  if (kind === 'question' || kind === 'bot_question') return 'chat';
  if (kind === 'plan') return 'play';
  if (kind === 'decide') return 'hand';
  // #6306: the ask is already there: nothing to decide, only to close.
  if (kind === 'works') return 'check';
  if (kind === 'stopped') return 'again';
  if (kind === 'fix_stopped') return 'again';
  if (kind === 'fix_yours') return 'warning';
  if (kind === 'bot_fix_failed') return 'warning';
  if (kind === 'private') return 'lock';
  return 'ballot';
}
/** In progress's glyph, by its stage. */
function nextGlyph(t: AiThread): Glyph {
  const code = t.work.line?.code;
  if (t.work.stage === 'going_live') return 'upload';
  if (t.work.stage === 'reading' || t.work.stage === 'planning') return 'eye';
  if (code === 'fixing') return 'cog';
  // #6282: an update is the bot following up on it.
  if (code === 'revising') return 'reply';
  return 'code';
}
/**
 * Waiting's glyph: a clock, or a camera while the only thing its change
 * waits on is its before & after screenshots.
 */
export function waitGlyph(t: AiThread): Glyph {
  return t.work.stage === 'checking' && t.work.line?.code === 'shots' ? 'camera' : 'clock';
}
/** A finished item's glyph: what became of it (./history.ts historyGlyph). */
const HISTORY_GLYPH: Record<ReturnType<typeof historyGlyph>, Glyph> = { live: 'check', closed: 'x', request: 'bubble', vote: 'ballot', private: 'lock' };

type Say = (id: string, values?: Record<string, string | number>) => string;

/** A live row's day: today, yesterday, or the weekday. */
function dayOf(at: string | null, t: Say): string {
  if (!at) return '';
  const d = new Date(at);
  // #6479: calendar days in the zone picked in Settings > Language.
  const days = dayNumber(new Date(Date.now())) - dayNumber(d);
  if (days <= 0) return t('messages:ai.short.today');
  if (days === 1) return t('messages:ai.short.yesterday');
  return d.toLocaleDateString(undefined, inZone({ weekday: 'short' }));
}

/**
 * Pure (6 Nov 2026): which day a row's divider says, "Today", "Yesterday", or
 * the weekday and date ("Tuesday 3 November"), read in the interface's own
 * language and the reader's time zone.
 */
export function dayHeading(at: string | null | undefined, t: Say, locale: string | undefined): string {
  const d = new Date(String(at || ''));
  if (!Number.isFinite(d.getTime())) return '';
  const today = new Date(Date.now());
  // #6479: calendar days in the zone picked in Settings > Language, the same
  // zone ./model.ts dayKey groups by, so a heading names its group's day.
  const days = dayNumber(today) - dayNumber(d);
  if (days <= 0) return t('messages:ai.short.today');
  if (days === 1) return t('messages:ai.short.yesterday');
  // The year too, only when it is another one (as History's months say it).
  const other = zonedDay(d).year !== zonedDay(today).year;
  return d.toLocaleDateString(locale, inZone({ weekday: 'long', day: 'numeric', month: 'long', ...(other ? { year: 'numeric' } : {}) }));
}

/** What the page hands its list, whichever face draws it (./lists.tsx AiLists says each). */
export interface AiLinesInput {
  query?: string;
  lit?: string | null;
  ready: boolean;
  rows: WorkRow[];
  owed: number;
  progress: AiThread[];
  waiting: AiThread[];
  live: AiThread[];
  openRow: (row: WorkRow) => void;
  openThread: (t: AiThread) => void;
  onDone?: (rootId: number) => void;
  picked?: readonly string[];
  onPick?: (slugs: string[]) => void;
  appFor?: (slug: string) => AiApp | null;
  history?: HistoryState | null;
  openHistory?: (row: HistoryRow) => void;
  /**
   * What the search in messages answered (./search.ts useBotSearch): null
   * while the first answer is on its way. Left out by a caller that has no
   * such search, for which only the threads are searched.
   */
  found?: Found | null;
}

/**
 * #6744: which projects the chips show: any when none is picked, else only
 * a picked one. The lists and the hero under the bot's name both ask this,
 * so a saved project's counts cannot disagree with the list below them.
 */
export function showsPicked(picked: readonly string[]): (app: AiApp | null) => boolean {
  return (app) => !picked.length || (!!app && picked.includes(app.slug));
}

/**
 * The lists' rows and what is said around them, from what the page read. A
 * hook only because it reads the catalog and this tab's build (#6233).
 */
export function useAiLines({
  query = '', lit = null, ready, rows, owed, progress, waiting, live, openRow, openThread, onDone,
  picked: pickedIn = [], onPick, appFor, history = null, openHistory, found,
}: AiLinesInput) {
  const t = useMessages('messages');
  const say = (p: Phrase | null): string | null => {
    if (!p) return null;
    // A stage's words inside a row's line are translated first.
    const nested = p.nested ? Object.fromEntries(Object.entries(p.nested).map(([k, q]) => [k, say(q) || ''])) : null;
    return t(p.id, nested ? { ...p.values, ...nested } : p.values);
  };
  // SEARCH (#6398, 6 Nov 2026): a row matches when its title, its number
  // ("6011" or "#6011") or its project's name or address contains what was
  // typed, in either case. It narrows the rows the chips already chose, so
  // the two apply together. History is searched as far as it has loaded.
  const q = query.trim().toLowerCase();
  const searching = !!q;
  function matches(line: Line): boolean {
    if (!searching) return true;
    const number = line.number == null ? '' : String(line.number);
    return [line.title, number, number ? `#${number}` : '', line.app?.name || '', line.app?.slug || '']
      .some((text) => text.toLowerCase().includes(q));
  }
  function kept<T extends Line>(lines: T[]): T[] {
    return searching ? lines.filter(matches) : lines;
  }
  // The projects in any list, the ones that need you most first; the ones
  // picked; the chips the rail shows; and More, open under its chip.
  // 5 Nov 2026: History's projects too, after the rest, and any project a
  // link picked that no list names (its chip is there, and the lists say
  // there is nothing of yours in it, rather than falling back to All).
  const ranked = withProjects(rankProjects(rows, progress, waiting, live), [
    ...(history?.rows || []).map((row) => row.app),
    ...pickedIn.map((slug) => appFor?.(slug) || null),
  ]);
  const picked = pickedIn.filter((slug) => ranked.some((p) => p.app.slug === slug));
  const setOnly = (slugs: string[]) => onPick?.(slugs);
  const rail = railProjects(ranked, picked);
  const past = ranked.length - rail.length;
  const shows = showsPicked(picked);
  const toggle = (slug: string) => setOnly(picked.includes(slug) ? picked.filter((x) => x !== slug) : [...picked, slug]);
  // #6262: what is new. The heading and the hero follow the chips (as the
  // owed count does); each chip carries its project's own count, and All the
  // whole page's.
  const freshAll = freshCount(rows);
  const freshByApp = freshByProject(rows);
  const needRowsShown = rows.filter((row) => shows(row.app));
  const freshShown = freshCount(needRowsShown);
  const freshProjects = freshByProject(needRowsShown);

  const needLines: Line[] = kept(needRowsShown.map((row) => ({
    key: row.key,
    kind: row.key.startsWith('need:') ? 'need' : row.key.split(':')[0],
    app: row.app,
    glyph: needGlyph(row),
    number: Number(row.sub.values?.number) || null,
    pr: row.sub.id === 'messages:ai.row.privateAboutChangePr',
    title: row.title,
    // B07 (audit 2 Nov 2026): a private idea in no project sits under the
    // Only you heading already, so its row does not say it again.
    right: row.pill ? say(row.pill)! : row.app ? t('messages:ai.short.private') : '',
    tooltip: say(row.sub)!,
    why: say(whyOf(row)),
    owe: !!row.pill,
    lit: !!lit && rowKey(row) === lit,
    fresh: row.unread > 0,
    open: () => openRow(row),
    done: row.rootId && onDone ? { rootId: row.rootId, mark: () => onDone(row.rootId!) } : null,
    at: row.at,
  })));
  const threadLine = (glyph: (th: AiThread) => Glyph) => (th: AiThread): Line => ({
    key: String(th.threadId),
    kind: th.work.stage,
    app: th.app,
    glyph: glyph(th),
    number: th.number,
    pr: changeOnGithub(th),
    title: th.title || '',
    requests: th.requests || 0,
    right: say(shortWords(th))!,
    tooltip: say(nextWords(th))!,
    why: say(threadWhy(th)),
    owe: false,
    // #6153: a request filed from a private thread opens that thread, and
    // is where you are while it is in the column.
    lit: !!lit && rowKey(th) === lit,
    fresh: (th.unread || 0) > 0,
    moved: th.moved === true,
    open: () => openThread(th),
    at: th.at,
  });
  const progressShown = progress.filter((x) => shows(x.app));
  const waitingShown = waiting.filter((x) => shows(x.app));
  // 2 Nov 2026 (#6160): under way and waiting are one card of their own, in
  // that order within a project so the rows read work first, then the wait.
  // #6158: what is moving leads; the waiting rows nobody is moving fold away
  // under one head.
  const movingShown = waitingShown.filter((th) => !notMoving(th));
  const stillShown = waitingShown.filter((th) => notMoving(th));
  const waitingLine = threadLine(waitGlyph);
  // #6398: while searching, the rows nobody is moving join the ones under
  // way in the one card, so a match is never hidden inside the fold; and
  // nothing matching is folded away either (first = Infinity below).
  const movingLines: Line[] = [
    ...progressShown.map(threadLine(nextGlyph)),
    ...movingShown.map(waitingLine),
  ];
  const stillLines: Line[] = searching ? [] : stillShown.map(waitingLine);
  const busyLines: Line[] = kept(searching ? [...movingLines, ...stillShown.map(waitingLine)] : movingLines);
  const tab = useTabBuild();
  const liveLines: Line[] = kept(live.filter((x) => shows(x.app)).map((th) => {
    if (th.kind === 'private' && th.work.stage === 'closed') {
      // #6271: a private thread marked done this week: a lock, its title, the
      // day it closed, and no number. It opens the thread, where Reopen is.
      return {
        key: `closed:${th.rootId}`,
        kind: 'closed',
        app: th.app,
        glyph: 'lock',
        number: null,
        title: th.title || '',
        right: dayOf(th.at, t),
        tooltip: th.app
          ? t('messages:ai.live.closed', { project: th.app.name || th.app.slug })
          : t('messages:ai.live.closedSolo'),
        why: null,
        owe: false,
        lit: !!lit && rowKey(th) === lit,
        open: () => openThread(th),
      };
    }
    // #6233: Live, but this tab runs the build before it: the row asks for
    // the reload rather than a day the reader still cannot see.
    const lacks = tabLacks({ liveAt: th.at, mergedAt: th.mergedAt, id: th.changeId, appSlug: th.app?.slug }, tab);
    return {
      ...threadLine(() => 'check')(th),
      right: lacks ? t('messages:ai.short.reload') : dayOf(th.at, t),
      owe: lacks,
      tooltip: t(prWord('messages:ai.live.row', changeOnGithub(th)), { project: th.app?.name || '', number: th.number || '' }),
    };
  }));
  const liveBehind = liveLines.some((line) => line.owe);
  // A project picked with nothing of yours on any list: Needs you says so,
  // by its name, rather than the lists quietly showing every project.
  const onlyApp = picked.length === 1 ? ranked.find((p) => p.app.slug === picked[0])?.app || null : null;
  const nothingHere = !!onlyApp && !needLines.length && !busyLines.length && !stillLines.length && !liveLines.length;
  // HISTORY (5 Nov 2026, ./history.ts): what has finished, by month, then by
  // project, in the quiet rows Live this week draws. Narrowed by the chips
  // above, as every list is; its own chips pick a kind.
  const locale = getDateLocale();
  const historyLines = kept((history?.rows || []).filter((row) => shows(row.app)).map((row): Line & { at: string | null } => {
    const glyph = historyGlyph(row);
    return {
      key: row.key,
      kind: `history-${row.kind}`,
      app: row.app,
      glyph: HISTORY_GLYPH[glyph],
      number: row.number,
      pr: !!row.change && !!row.app?.changesOnGithub,
      title: row.title || '',
      right: say(historyWords(row, locale))!,
      tooltip: say(historyTooltip(row))!,
      why: null,
      owe: false,
      lit: !!lit && rowKey({ rootId: row.rootId ?? null, href: row.href }) === lit,
      open: () => openHistory?.(row),
      left: !!row.left,
      at: row.at,
    };
  }));
  const historyMonths = byMonth(historyLines);
  // #6398: the Needs you count over its rows is how many of them match; with
  // no project picked the heading still counts everything, unless a search
  // narrows it.
  const owedShown = picked.length || searching ? needLines.filter((line) => line.owe).length : owed;
  // One project picked: its chip names it, so its name is not said again over every section.
  const heads = picked.length !== 1;
  // MESSAGES (13 Nov 2026, ./search.ts): what was said in the chat with the
  // bot and its threads that matches, under the threads that do. The last
  // answer stays drawn while the next is read, so the list does not blink;
  // nothing is drawn with no search on.
  const asked = cleanQuery(query);
  const foundLines: FoundLine[] = searching && found && found.state === 'answered' ? found.rows.map((row) => {
    const place = row.rootId && row.threadTitle ? row.threadTitle : t('messages:ai.search.inChat');
    const date = foundDay(row.at, locale);
    return {
      key: `found:${row.messageId}`,
      href: botTabAddress({ threadRootId: row.rootId, focusMessageId: row.messageId }),
      messageId: row.messageId,
      q: found.q,
      thread: !!row.rootId,
      parts: markParts(row.snippet, row.ranges),
      place,
      date,
      name: t(row.mine ? 'messages:ai.search.rowYou' : 'messages:ai.search.rowBot', { snippet: row.snippet, place, date }),
    };
  }) : [];
  // The answer for what the box says now; an earlier query's is not it.
  const foundNow = searching && found && found.q === asked ? found : null;
  const foundMore = foundLines.length > 0 && !!found?.more;
  const foundFailed = foundNow?.state === 'failed';
  // Nothing on the page matches what was searched for: one short note says
  // so, in place of the rows (the Needs you warning, if there is one, stays).
  // It waits for the messages' answer, and says "messages" only when they
  // were searched: a query too short to ask, or a read that failed, is a
  // note about the threads alone.
  const noMatches = searching && ready
    && !needLines.length && !busyLines.length && !stillLines.length && !liveLines.length && !historyLines.length
    && !foundLines.length && (found === undefined || !!foundNow);
  const noneWords = foundNow?.state === 'answered'
    ? t('messages:ai.search.none', { query: query.trim() })
    : t('messages:ai.search.noneThreads', { query: query.trim() });

  return {
    say, searching, ranked, picked, rail, past, setOnly, toggle, freshAll, freshByApp, freshShown, freshProjects,
    needLines, busyLines, stillLines, liveLines, liveBehind, onlyApp, nothingHere, locale, historyLines, historyMonths,
    owedShown, heads, noMatches, noneWords, foundLines, foundMore, foundFailed,
    // #6744: the counts the project filter shows, for anything that summarises
    // the lists (the hero under the bot's name asks the same question).
    progressShown: progressShown.length,
  };
}

export type AiLines = ReturnType<typeof useAiLines>;
