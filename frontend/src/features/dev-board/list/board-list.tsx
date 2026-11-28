/**
 * ALL ITEMS AS ONE LIST (28 Nov 2026): the board's second view, beside its
 * four columns (../card/dev-kanban.tsx). The same items, read as Needs
 * you, Waiting on others, In progress and Done, in the Homeroom bot tab's
 * short row: a tile, the title, one small line, and one thing at the end
 * (what you do, where it stands, a tick once it is live).
 *
 * Which row is in which group is ./model.ts. This file draws it.
 *
 * ALL WORK is the list's checkbox, ticked as the page first opens. UNTICKED,
 * the list is the viewer's own work: the Homeroom bot tab's own three lists
 * narrowed to this project: the tab's reads (../../ai/desk.ts readDesk), its rules
 * (../../ai/model.ts) and its rows' words (../../ai/lines.ts useAiLines),
 * drawn here. Nothing about what is yours is decided in this file, so the
 * two pages cannot disagree. Ticked, the same Needs you leads, each
 * thread drawn as the board's own row, and every other open row of the
 * project follows.
 *
 * A row opens its item beside the list on a wide window (the Workshop's
 * panel, `onOpen` and `openRef`) and as its page anywhere else. A private
 * thread of the viewer's opens in the Homeroom bot tab, where it lives.
 *
 * React owns everything under `#dev-board-list`.
 */

import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react';

import {
  ChatBubbleTailIcon, CheckIcon, ChevronRightIcon, ClockIcon, LockIcon, PencilSquareIcon, UserGroupIcon, UserIcon,
} from '@/components/ui/icons';
import { Button } from '@/components/ui/button';
import { StateTag } from '@/components/ui/state-tag';

import { useMessages } from '../../../lib/i18n/react';
import { useStoreState } from '../../../lib/use-store-state';
import { forgetDesk, readDesk } from '../../ai/desk';
import { botTabAddress } from '../../ai/door';
import { useAiLines, verbOf, type Line } from '../../ai/lines';
import {
  NEED_PILLS, inProgress, liveThisWeek, needsYou, owedCount, upNext,
  type AiApp, type AiThread, type AiWork, type NeedItem, type WorkRow,
} from '../../ai/model';
import { devKanbanStore } from '../card/cards-store';
import { openHref, voteSpecs } from '../card/fold';
import { FooterView } from '../card/footer';
import { ListRowView } from '../card/list-rows';
import { votedSide } from '../card/model';
import { CardSkeleton, CountSkeleton } from '../card/skeleton';
import { countWords } from '../card/dev-kanban';
import { kanbanFiltersStore } from '../kanban-filters-store';
import { TILE, rowWords, type TopicRef } from '../workshop/work-row';
import {
  BACKLOG_FIRST, entriesOf, groupAll, progressCount, restOf, threadOfHref,
  type Entry, type Item, type YourNeed,
} from './model';
import { setPrefs, usePrefs } from './prefs';

type Opens = (event: MouseEvent<HTMLAnchorElement>, ref: TopicRef) => void;

interface Desk {
  work: AiWork | null;
  needs: NeedItem[] | null;
  /** The two reads have answered, whatever they said. */
  settled: boolean;
}

const NO_DESK: Desk = { work: null, needs: null, settled: false };

/**
 * The Homeroom bot tab's two lists (../../ai/desk.ts keeps them a short
 * while, so this costs a read only now and then): after mount, when the
 * board publishes again, and when Homeroom bot's work moves.
 */
function useDeskLists(slug: string, bump: unknown): Desk {
  const [desk, setDesk] = useState<Desk>(NO_DESK);
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    if (!slug || !(window as unknown as { App?: { user?: unknown } }).App?.user) {
      setDesk({ work: null, needs: null, settled: true });
      return undefined;
    }
    let live = true;
    const read = () => {
      void readDesk().then(({ work, needs }) => {
        if (live) setDesk({ work, needs, settled: true });
      }, () => {
        if (live) setDesk({ work: null, needs: null, settled: true });
      });
    };
    read();
    const moved = () => { forgetDesk(); read(); };
    window.addEventListener('homeroom-bot-work-changed', moved);
    return () => { live = false; window.removeEventListener('homeroom-bot-work-changed', moved); };
  }, [slug, bump]);
  return desk;
}

/** This project as the tab's lists name one, from the page's own record of it. */
function appOf(slug: string): AiApp {
  const data = typeof window === 'undefined' ? null
    : (window as unknown as { AppView?: { appData?: Record<string, unknown> | null } }).AppView?.appData || null;
  const same = data && data.slug === slug ? data : null;
  return {
    slug,
    name: same && typeof same.name === 'string' ? same.name : slug,
    icon_url: same && typeof same.icon_url === 'string' ? same.icon_url : null,
    icon_emoji: same && typeof same.icon_emoji === 'string' ? same.icon_emoji : null,
  };
}

/** The Needs you feed's kinds that ask for a vote, by their row's key (../../ai/model.ts needsYou). */
const VOTE_KEY = /^need:(proposal|governance|ballot):/;

/** What a request of the viewer's own waits on them for, as the tab's pill says it. */
function yoursPill(why: string | null): string {
  const kind = why === 'plan' ? 'plan' : why === 'decide' ? 'decide' : why === 'stopped' ? 'stopped' : 'detail';
  return verbOf({ id: NEED_PILLS[kind] || 'messages:ai.pill.needsYou' });
}

const WAITS: Readonly<Record<string, string>> = {
  plan: 'project:boardList.waits.plan',
  question: 'project:boardList.waits.question',
  decide: 'project:boardList.waits.decide',
  needs_detail: 'project:boardList.waits.detail',
};

// The Homeroom bot tab's row (../../ai/lists.tsx ROW, LIT_ROW), so a list of
// the same threads reads the same on both pages. Complete literals: the
// stylesheet's extractor reads source text.
const ROW = 'board-list-row group relative flex min-h-[44px] w-full min-w-0 items-center gap-3 rounded-xl px-3 py-2 text-start hover:bg-zinc-900/[0.035] active:bg-zinc-900/[0.06] dark:hover:bg-white/[0.05] dark:active:bg-white/[0.08] outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--accent)]';
const LIT_ROW = 'board-list-row group relative flex min-h-[44px] w-full min-w-0 items-center gap-3 rounded-xl px-3 py-2 text-start bg-[color:var(--lit-tint)] text-[color:var(--lit-ink)] outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--accent)]';
const TITLE = 'block truncate text-sm font-semibold leading-[19px]';
const TITLE_INK = 'text-zinc-900 dark:text-zinc-100';
const SUB = 'block truncate text-xs leading-4 text-zinc-500 dark:text-zinc-400';

// A row and a heading are pressed whole, and draw themselves: the primitive is the element, the look is theirs.
const OWN_CLASSES = { variant: 'unstyled', size: 'none', ink: 'none' } as const;

type End = { kind: 'act' | 'state' | 'tick'; text: string } | null;

function RowEnd({ end }: { end: End }): ReactNode {
  if (!end || !end.text) return null;
  if (end.kind === 'act') return <StateTag state="needs" data-board-list-end="act">{end.text}</StateTag>;
  if (end.kind === 'state') return <StateTag data-board-list-end="state">{end.text}</StateTag>;
  // A finished thing gets no fill: the tick alone, its word for a screen reader.
  return (
    <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center text-[color:var(--state-ok)]" data-board-list-end="tick">
      <CheckIcon className="h-[18px] w-[18px]" aria-hidden="true" strokeWidth="2.25" />
      <span className="sr-only">{end.text}</span>
    </span>
  );
}

function RowBody({ tile, title, sub, end, on }: {
  tile: ReactNode; title: string; sub: string; end: End; on: boolean;
}): ReactNode {
  return (
    <>
      {tile}
      <span className="min-w-0 flex-1">
        <span className={on ? TITLE : `${TITLE} ${TITLE_INK}`} data-board-list-title="">{title}</span>
        {sub ? <span className={SUB} data-board-list-sub="">{sub}</span> : null}
      </span>
      <RowEnd end={end} />
    </>
  );
}

export interface BoardListProps {
  slug: string;
  /** `kind:id` of the item whose page is open beside the list, to light its row. */
  openKey?: string | null;
  /** A plain click on a row's link: the Workshop opens the item beside the list, or lets the link go. */
  onOpen?: Opens;
  /** Open an item beside the list from a row that is no link. False when there is no room: then its address is followed. */
  openRef?: (ref: TopicRef) => boolean;
}

export function BoardList({ slug, openKey = null, onOpen, openRef }: BoardListProps): ReactNode {
  const t = useMessages('project');
  const tm = useMessages('messages');
  const v = useStoreState(devKanbanStore);
  const filters = useStoreState(kanbanFiltersStore);
  const stored = usePrefs();
  const desk = useDeskLists(slug, v);
  // "Your own work" is somebody's: signed out, the list is all work whatever was stored.
  const signedIn = typeof window !== 'undefined' && !!(window as unknown as { App?: { user?: unknown } }).App?.user;
  const prefs = signedIn ? stored : { ...stored, allWork: true };
  const yours = !prefs.allWork;
  const [allBacklog, setAllBacklog] = useState(false);
  useEffect(() => { setAllBacklog(false); }, [slug]);

  const app = useMemo(() => appOf(slug), [slug]);
  const entries = useMemo(() => entriesOf(v.cols), [v.cols]);
  const filtering = !!filters.q || filters.count > 0 || !!(filters.quick && (filters.quick.assignedToMe || filters.quick.yours));

  // The tab's lists, by the tab's rules.
  const read = desk.settled && !!desk.work && !!desk.needs;
  const rows = useMemo(() => (read ? needsYou(desk.needs, desk.work) : []), [read, desk.needs, desk.work]);
  const progress = useMemo(() => (read ? inProgress(desk.needs, desk.work) : []), [read, desk.needs, desk.work]);
  const waiting = useMemo(() => (read ? upNext(desk.needs, desk.work) : []), [read, desk.needs, desk.work]);
  const live = useMemo(() => (read ? liveThisWeek(desk.work) : []), [read, desk.work]);

  // A row of the tab's opens beside the list where the board has room, and
  // as its own address otherwise; a private thread is the tab's to show.
  const follow = (href: string | null | undefined, rootId: number | null | undefined) => {
    if (typeof window === 'undefined') return;
    if (rootId) { window.location.hash = botTabAddress({ threadRootId: rootId }); return; }
    const ref = refOfHref(href, slug, entries);
    if (ref && openRef && openRef(ref)) return;
    if (href) window.location.hash = href;
  };
  const lit = litKey(openKey, slug, entries);
  const lines = useAiLines({
    query: yours ? filters.q : '',
    lit,
    ready: desk.settled,
    rows,
    owed: owedCount(rows),
    progress,
    waiting,
    live,
    openRow: (row: WorkRow) => follow(row.href, row.rootId),
    openThread: (th: AiThread) => follow(th.href, th.rootId ?? null),
    picked: [slug],
    appFor: (s: string) => (s === slug ? app : null),
  });

  const byKey = new Map(rows.map((row) => [row.key, row]));
  const yourNeeds: YourNeed<Line>[] | null = read ? lines.needLines.map((line) => {
    const row = byKey.get(line.key);
    return {
      key: line.key,
      thread: row && !row.rootId ? threadOfHref(row.href, slug, entries) : null,
      vote: VOTE_KEY.test(line.key),
      line,
    };
  }) : null;
  const groups = groupAll<Line>({ entries, needs: yourNeeds, filtering });

  const loading = !!v.loading;
  const pair = (first: string, second: string) => (first && second ? t('project:workRow.facts.pair', { first, second }) : first || second);

  // ── One row ────────────────────────────────────────────────────────────
  const entryEnd = (item: Item<Line>): End => {
    const e = item.entry!;
    const b = e.row.brief!;
    const end = item.end;
    if (end.kind === 'line') return item.line && item.line.end ? { kind: 'act', text: item.line.end.text } : null;
    if (end.kind === 'vote') return { kind: 'act', text: tm('messages:ai.pill.vote') };
    if (end.kind === 'yours') return { kind: 'act', text: tm(yoursPill(end.why)) };
    if (end.kind === 'waits') {
      return {
        kind: 'state',
        text: end.who
          ? t(WAITS[end.why || ''] || 'project:boardList.waits.plain', { who: end.who })
          : t('project:boardList.waits.someone'),
      };
    }
    if (end.kind === 'tick') return { kind: 'tick', text: t('project:boardList.live') };
    const pill = b.pill || e.row.card.pill?.state || null;
    // A change up for approval says where its vote stands, and the viewer's
    // own vote where they have cast one: its pill's own words unless those
    // are the bare tally, which alone ("1 / 3") says too little on a row.
    if (e.col === 'inreview' && b.vote) {
      const specs = voteSpecs(e.row.card);
      const mine = specs ? (votedSide(specs.yes) || votedSide(specs.no)) : null;
      const tally = { yes: b.vote.yes, need: b.vote.need };
      if (mine === 'yes') return { kind: 'state', text: t('project:boardList.vote.saidYes', tally) };
      if (mine === 'no') return { kind: 'state', text: t('project:boardList.vote.saidNo', tally) };
      if (!pill || pill.plainVote) return { kind: 'state', text: t('project:boardList.vote.open', tally) };
      return { kind: 'state', text: pill.label };
    }
    const word = b.tags[0]?.label || pill?.label || '';
    return word ? { kind: 'state', text: word } : null;
  };

  const entryRow = (item: Item<Line>): ReactNode => {
    const e = item.entry!;
    const b = e.row.brief!;
    const card = e.row.card;
    const Tile = TILE[b.kind] || PencilSquareIcon;
    const on = !!openKey && !!e.ref && `${e.ref.kind}:${e.ref.id}` === openKey;
    const href = openHref(slug, card);
    const body = (
      <RowBody
        tile={<span className="board-list-tile" data-kind={b.kind} aria-hidden="true"><Tile aria-hidden="true" /></span>}
        title={card.title.text}
        sub={rowWords(b, { whoFirst: true })}
        end={entryEnd(item)}
        on={on}
      />
    );
    return (
      <div key={item.key} className="flex min-w-0 items-center" data-board-list-row={e.key} data-board-list-kind={b.kind}>
        {href ? (
          <a
            className={on ? LIT_ROW : ROW}
            href={href}
            title={card.title.text}
            aria-current={on ? 'true' : undefined}
            onClick={e.ref && onOpen ? (event) => onOpen(event, e.ref!) : undefined}
          >
            {body}
          </a>
        ) : <span className={ROW} title={card.title.text}>{body}</span>}
      </div>
    );
  };

  // A row the tab lists that the board has no row for (a private thread, a
  // thread only the tab's lists reach), and every row of the viewer's own work.
  const lineRow = (line: Line): ReactNode => {
    const Tile = line.done ? LockIcon : line.pr ? PencilSquareIcon : ChatBubbleTailIcon;
    const end: End = line.end
      ? { kind: line.end.kind === 'act' ? 'act' : line.end.kind === 'tick' ? 'tick' : 'state', text: line.end.text }
      : null;
    return (
      <div key={line.key} className="flex min-w-0 items-center" data-board-list-row={line.key} data-board-list-kind="yours">
        <Button
          type="button"
          {...OWN_CLASSES}
          className={line.lit ? LIT_ROW : ROW}
          title={line.tooltip}
          aria-current={line.lit ? 'true' : undefined}
          onClick={line.open}
        >
          <RowBody
            tile={<span className="board-list-tile" data-kind={line.done ? 'private' : 'request'} aria-hidden="true"><Tile aria-hidden="true" /></span>}
            title={line.title}
            sub={pair(line.ref || '', line.sub || '')}
            end={end}
            on={!!line.lit}
          />
        </Button>
      </div>
    );
  };

  const itemRow = (item: Item<Line>): ReactNode => (item.entry ? entryRow(item) : item.line ? lineRow(item.line) : null);

  // ── The groups ─────────────────────────────────────────────────────────
  const head = (key: string, Icon: typeof CheckIcon, name: string, count: number | null, aside: ReactNode = null, pending = false) => (
    <>
      <span className="dev-kanban-step-tile" data-kind={key} aria-hidden="true"><Icon aria-hidden="true" /></span>
      <span className="dev-kanban-step-name">{name}</span>
      {pending
        ? <span className="dev-kanban-step-n"><CountSkeleton /></span>
        // A zero says nothing.
        : (count ? <span className="dev-kanban-step-n" data-board-list-count={key}>{countWords(count)}</span> : null)}
      {aside}
    </>
  );
  const group = (key: string, headRow: ReactNode, body: ReactNode) => (
    <section className="board-list-group" data-board-list-group={key}>
      <h3 className="board-list-head">{headRow}</h3>
      {body}
    </section>
  );
  const card = (children: ReactNode) => <div className="board-list-card">{children}</div>;
  const note = (text: string) => <p className="board-list-note">{text}</p>;
  const run = (label: string) => (
    <div className="dev-col-divider board-list-run"><span className="dev-col-divider-label">{label}</span></div>
  );
  const skeleton = (name: string) => card(<CardSkeleton n={2} label={t('project:kanban.column.loading', { column: name })} />);

  const names = {
    needs: t('project:boardList.group.needs'),
    others: t('project:boardList.group.others'),
    progress: t('project:boardList.group.progress'),
    done: t('project:boardList.group.done'),
  };

  // ── All work unticked: the tab's three lists for this project ──────────
  if (yours) {
    const waitingDesk = !desk.settled;
    return (
      <div id="dev-board-list" className="board-list" data-board-list="yours">
        {group('needs', head('needs', UserIcon, names.needs, lines.needCount, null, waitingDesk),
          waitingDesk ? skeleton(names.needs)
            : lines.needLines.length ? card(lines.needLines.map(lineRow)) : note(t('project:boardList.empty.needs')))}
        {group('progress', head('progress', ClockIcon, names.progress, lines.progressCount, null, waitingDesk),
          waitingDesk ? skeleton(names.progress)
            : lines.progressLines.length ? card(lines.progressLines.map(lineRow)) : note(t('project:boardList.empty.yourProgress')))}
        {group('done', head('done', CheckIcon, names.done, null,
          lines.weekCount ? <span className="board-list-aside">{t('project:boardList.done.thisWeek', { count: lines.weekCount })}</span> : null, waitingDesk),
          waitingDesk ? skeleton(names.done)
            : lines.doneLines.length ? card(lines.doneLines.map(lineRow)) : note(t('project:boardList.empty.yourDone')))}
      </div>
    );
  }

  // ── All work: the board's rows, what needs you first ───────────────────
  const waitingNeeds = loading || !desk.settled;
  const doneCol = v.cols.find((c) => c.key === 'done') || null;
  const issuesCol = v.cols.find((c) => c.key === 'issues') || null;
  const extras = restOf(v.cols, 'inprogress');
  const backlog = allBacklog || filtering ? groups.backlog : groups.backlog.slice(0, BACKLOG_FIRST);
  const inProgressCount = progressCount(groups);
  const othersOpen = prefs.othersOpen;
  return (
    <div id="dev-board-list" className="board-list" data-board-list="all">
      {group('needs', head('needs', UserIcon, names.needs, groups.needs.length, null, waitingNeeds),
        waitingNeeds ? skeleton(names.needs)
          : groups.needs.length ? card(groups.needs.map(itemRow)) : note(t('project:boardList.empty.needs')))}

      {!loading && groups.others.length ? (
        <section className="board-list-group" data-board-list-group="others" data-board-list-folded={othersOpen ? undefined : ''}>
          <h3 className="board-list-head">
            <Button
              type="button"
              {...OWN_CLASSES}
              className="board-list-fold"
              aria-expanded={othersOpen}
              aria-controls="dev-board-list-others"
              onClick={() => setPrefs({ othersOpen: !othersOpen })}
            >
              {head('others', UserGroupIcon, names.others, groups.others.length,
                <>
                  <span className="board-list-fold-word">{othersOpen ? t('project:boardList.fold.hide') : t('project:boardList.fold.show')}</span>
                  <ChevronRightIcon className="board-list-fold-caret" aria-hidden="true" />
                </>)}
            </Button>
          </h3>
          <div id="dev-board-list-others" hidden={!othersOpen}>
            {othersOpen ? card(groups.others.map(itemRow)) : null}
          </div>
        </section>
      ) : null}

      {group('progress', head('progress', ClockIcon, names.progress, inProgressCount, null, loading),
        loading ? skeleton(names.progress)
          : inProgressCount || extras.length ? card(
            <>
              {groups.making.map(itemRow)}
              {extras.map((row) => <div key={row.key} className="board-list-extra"><ListRowView row={row} /></div>)}
              {groups.review.length ? run(t('project:boardList.run.review', { count: groups.review.length, number: countWords(groups.review.length) })) : null}
              {groups.review.map(itemRow)}
              {groups.backlog.length ? run(t('project:boardList.run.backlog', { count: groups.backlog.length, number: countWords(groups.backlog.length) })) : null}
              {backlog.map(itemRow)}
              {backlog.length < groups.backlog.length ? (
                <div className="board-list-foot">
                  <Button type="button" {...OWN_CLASSES} className="dev-ws-reveal dev-kanban-more" data-board-list-more="backlog" onClick={() => setAllBacklog(true)}>
                    {t('project:boardList.run.backlogAll', { count: groups.backlog.length, number: countWords(groups.backlog.length) })}
                  </Button>
                </div>
              ) : null}
              {issuesCol && issuesCol.footer ? <div className="board-list-foot"><FooterView f={issuesCol.footer} /></div> : null}
            </>,
          ) : note(filtering ? t('project:boardList.empty.filtered') : t('project:boardList.empty.progress')))}

      {group('done', head('done', CheckIcon, names.done, doneCol ? doneCol.count : groups.done.length, null, loading || !!doneCol?.pending),
        loading || doneCol?.pending ? skeleton(names.done)
          : groups.done.length ? card(
            <>
              {doneCol && doneCol.status ? <p className="board-list-status" title={doneCol.status.title}>{doneCol.status.text}</p> : null}
              {groups.done.map(itemRow)}
              {doneCol && doneCol.footer ? <div className="board-list-foot"><FooterView f={doneCol.footer} /></div> : null}
            </>,
          ) : note(doneCol?.empty || t('project:boardList.empty.done')))}
    </div>
  );
}

/** The item a page address names, as the Workshop's panel opens one: by its number for a request or a decision, by the change's own id for a change. */
export function refOfHref(href: string | null | undefined, slug: string, entries: readonly Entry[]): TopicRef | null {
  const match = /^#?\/?app\/([^/?#]+)\/dev\/(issues|changes|governance)\/(\d{1,10})/.exec(String(href || ''));
  if (!match) return null;
  let named = match[1];
  try { named = decodeURIComponent(named); } catch { /* as written */ }
  if (named !== slug) return null;
  const n = Number(match[3]);
  if (match[2] === 'issues') return { kind: 'issue', id: n };
  if (match[2] === 'governance') return { kind: 'gov', id: n };
  const found = entries.find((e) => {
    const b = e.row.brief!;
    return b.kind !== 'request' && b.kind !== 'vote' && Number(b.n) === n && !!e.ref && e.ref.kind === 'proposal';
  });
  return found ? found.ref : null;
}

/** The tab's own key for the page open beside the list (../../ai/column.ts columnKey), so its row is lit. */
export function litKey(openKey: string | null, slug: string, entries: readonly Entry[]): string | null {
  const match = /^(issue|proposal|gov):(\d+)$/.exec(String(openKey || ''));
  if (!match) return null;
  const id = Number(match[2]);
  const app = `app/${slug}/dev`;
  if (match[1] === 'issue') return `page:${app}/issues/${id}`;
  if (match[1] === 'gov') return `page:${app}/governance/${id}`;
  const entry = entries.find((e) => !!e.ref && e.ref.kind === 'proposal' && e.ref.id === id);
  const n = entry ? Number(entry.row.brief!.n) : 0;
  // A change made for a request is its request's thread, and that is the row the tab lists.
  const linked = entry ? entry.row.brief!.linked : [];
  if (linked.length) return `page:${app}/issues/${linked[0]}`;
  return n ? `page:${app}/changes/${n}` : null;
}
