/**
 * The weeks, on the Workshop tab (#4457, and #3947 before it; After-Workshop-B,
 * Oct 2026).
 *
 * The weeks used to unfold inside Since your last visit, and each week's
 * rows unfolded again inside the week ("Seen before", "Show 5 more · 25
 * left", "Show an earlier week"): two levels of the same gesture, nested,
 * and a quiet visit read "Nothing has changed since you were last here."
 * over thirty rows of history. The information hierarchy was right; the
 * nesting was not.
 *
 * Now the tab's What happened card leads with THIS WEEK (`ThisWeek`): its
 * name and dates, how many of its rows are new to you and how many changes
 * went live, then its rows newest first, one line each (`HappenedRow`: a
 * dot when it is new since your last visit, "You" on your own, "Going
 * live" on a merge still rolling out, and when), the new ones and a few
 * you have seen, then "All of this week". Every other week is ONE ROW
 * (`WeekRow`): its name and dates and how many went live. Either opens the
 * week as its own page inside the tab, with "‹ Workshop" to go back, and
 * the page groups the week: New since your last visit (when any), Waiting
 * for votes, Went live, New requests, Being worked on, under the week's
 * summary line. "Earlier weeks" adds rows to the same list. Nothing
 * unfolds inside anything; a long group shows its first few rows and "Show
 * all N" puts the rest under them.
 */

import { useState, type MouseEvent, type ReactNode } from 'react';

import { ChevronDownIcon, ChevronRightIcon, LockIcon, PencilSquareIcon, SparklesIcon } from '@/components/ui/icons';

import { RichMessage, useMessages } from '../../../lib/i18n/react';
import { getLanguage, t as translate } from '../../../lib/i18n/runtime';
import { agoStamp } from '../../../lib/timestamp';
import { openHref } from '../card/fold';
import type { RowBrief, RowTag } from '../card/model';
import { PageBack } from './page-back';
import { TILE, WorkList, lineTags, topicRef, type CardRow, type TopicRef } from './work-row';
import type { SinceWeek } from './workshop';

/**
 * "Aug 25", with the year where it is not this one: #3293 walks back to the
 * project's start, which for a project over a year old passes a second Aug
 * 25, and a range is an absolute fact only while it names one week.
 * In the interface's own language, the one the sentence around it is in
 * (#4818): "25 août" in a French interface, never "Aug 25" inside a French
 * sentence, whatever language the device itself is set to.
 */
export function weekDate(ms: number): string {
  const d = new Date(ms);
  const other = d.getUTCFullYear() !== new Date().getUTCFullYear();
  return d.toLocaleDateString(getLanguage(), {
    month: 'short', day: 'numeric', timeZone: 'UTC', ...(other ? { year: 'numeric' } : {}),
  });
}

/**
 * "Aug 25 – Aug 31" for a window whose `endMs` is the Monday after it
 * (EXCLUSIVE, so the caption names the Sunday before it), and "Sep 14 →
 * now" for the one that has not finished, whose end is the current instant.
 */
export function weekRange(startMs: number, endMs: number, live?: boolean): string {
  if (live) return translate('project:since.week.rangeLive', { start: weekDate(startMs) });
  return translate('project:since.week.range', { start: weekDate(startMs), end: weekDate(endMs - 86400000) });
}

/** A week's name: "This week", "Last week", or its dates. */
export function weekName(week: Pick<SinceWeek, 'title' | 'key' | 'startMs' | 'endMs'>): string {
  if (week.title) return week.title;
  if (week.key === 'lastWeek') return translate('project:weeks.lastWeek');
  return weekRange(week.startMs, week.endMs);
}

/**
 * Whether a row belongs to catching up at all. Your own work in flight is
 * Your work's, on the same tab, and so is a change Homeroom bot is building
 * from your request (#4538); once it is live, it is news like anyone's
 * (#4505: catch-up keeps your merged contributions).
 */
export function catchUp(b: Pick<RowBrief, 'mine' | 'requested' | 'stage'>): boolean {
  return !(b.mine || b.requested) || b.stage === 'live';
}

/** What moved in a week since your last visit: the dots, and the week's "N new". */
export function weekFresh(week: Pick<SinceWeek, 'fresh'>): CardRow[] {
  return week.fresh.filter((r) => !!r.brief && catchUp(r.brief));
}

/** What moved in a week before your last visit, which you have seen. */
export function weekSeen(week: Pick<SinceWeek, 'seen'>): CardRow[] {
  return week.seen.filter((r) => !!r.brief && catchUp(r.brief));
}

/** How many changes went live in the week, where the server can stand behind it. */
function weekLive(week: SinceWeek): { count: number; partial: boolean } | null {
  if (!week.counts || !week.counts.closed) return null;
  return { count: week.counts.closed, partial: !!week.counts.partial };
}

export interface WeekGroup {
  key: 'new' | 'votes' | 'live' | 'requests' | 'worked';
  title: string;
  rows: CardRow[];
}

/**
 * A week's page, grouped: what other people did since your last visit
 * first, then everything else by where it is. A request made in the week
 * is a new request, whoever has picked it up since; work on an older one
 * is the week's work. Empty groups are left out.
 */
export function weekGroups(week: SinceWeek): WeekGroup[] {
  const fresh = weekFresh(week);
  const freshKeys = new Set(fresh.map((r) => r.key));
  const groups: WeekGroup[] = [
    { key: 'new', title: translate('project:weekPage.group.new'), rows: fresh },
    { key: 'votes', title: translate('project:weekPage.group.votes'), rows: [] },
    { key: 'live', title: translate('project:weekPage.group.live'), rows: [] },
    { key: 'requests', title: translate('project:weekPage.group.requests'), rows: [] },
    { key: 'worked', title: translate('project:weekPage.group.worked'), rows: [] },
  ];
  const by = (k: WeekGroup['key']) => groups.find((g) => g.key === k)!;
  for (const r of [...week.fresh, ...week.seen]) {
    if (freshKeys.has(r.key) || !r.brief) continue;
    const b = r.brief;
    if (b.stage === 'vote' && b.kind !== 'request') by('votes').rows.push(r);
    else if (b.stage === 'live') by('live').rows.push(r);
    else if (b.kind === 'request' && b.at >= week.startMs && b.at < week.endMs + 1) by('requests').rows.push(r);
    else by('worked').rows.push(r);
  }
  return groups.filter((g) => g.rows.length);
}

/** How many rows a group shows before its "Show all N". */
export const WEEK_GROUP_FIRST = 5;

function Group({ group, slug, openKey, onOpen }: {
  group: WeekGroup;
  slug: string;
  openKey: string | null;
  onOpen: (event: MouseEvent<HTMLAnchorElement>, ref: TopicRef) => void;
}): ReactNode {
  const t = useMessages('project');
  const [all, setAll] = useState(false);
  const extra = group.rows.length - WEEK_GROUP_FIRST;
  return (
    <section className="dev-ws-strip" data-ws-week-group={group.key}>
      <div className="dev-ws-head">
        <span className="dev-ws-head-title">{group.title}</span>
        <span className="dev-ws-head-n">{group.rows.length}</span>
      </div>
      <WorkList rows={all ? group.rows : group.rows.slice(0, WEEK_GROUP_FIRST)} slug={slug} openKey={openKey} onOpen={onOpen} />
      {extra > 0 && !all ? (
        <button type="button" className="dev-ws-reveal touch-target-32" data-ws-week-group-more="" onClick={() => setAll(true)}>
          <ChevronDownIcon className="dev-ws-reveal-chev" aria-hidden="true" />
          {t('project:weekPage.group.showAll', { count: group.rows.length })}
        </button>
      ) : null}
    </section>
  );
}

/**
 * The week's own rows, fetched when the page opened (AppView.openWorkshopWeek,
 * filed in _workshopView's `week`), or null where there is no AppView to ask.
 * The page groups these through the unchanged weekGroups() rather than the
 * capped since-list rows, so a week the board had already dropped still
 * reads whole; `loading` and `failed` are the fetch's own states.
 */
export interface FetchedWeek {
  loading: boolean;
  failed: boolean;
  fresh: CardRow[];
  seen: CardRow[];
}

/** A week's own page inside the Workshop tab, with the way back. */
export function WeekPage({ week, fetched, slug, openKey, onOpen, onBack }: {
  week: SinceWeek;
  /** The page's own fetched rows, when AppView supplied them. */
  fetched?: FetchedWeek | null;
  slug: string;
  openKey: string | null;
  onOpen: (event: MouseEvent<HTMLAnchorElement>, ref: TopicRef) => void;
  onBack: () => void;
}): ReactNode {
  const t = useMessages('project');
  const live = weekLive(week);
  const full = fetched ? { ...week, fresh: fetched.fresh, seen: fetched.seen } : week;
  const groups = weekGroups(full);
  const loading = !!fetched && fetched.loading;
  const failed = !!fetched && fetched.failed;
  const liveBold = [<b className="dev-ws-week-live" />];
  const start = weekDate(week.startMs);
  const end = weekDate(week.endMs - 86400000);
  return (
    <div className="dev-ws-weekpage" data-ws-week-page={week.key}>
      <PageBack label={t('project:weekPage.back')} title={weekName(week)} onBack={onBack} />
      <section className="dev-ws-strip" data-ws-week-top="">
        <p className="dev-ws-week-meta">
          {!live ? weekRange(week.startMs, week.endMs, week.live) : week.live ? (
            <RichMessage
              id={live.partial ? 'project:weekPage.meta.nowLiveAtLeast' : 'project:weekPage.meta.nowLive'}
              values={{ start, count: live.count }}
              components={liveBold}
            />
          ) : (
            <RichMessage
              id={live.partial ? 'project:weekPage.meta.rangeLiveAtLeast' : 'project:weekPage.meta.rangeLive'}
              values={{ start, end, count: live.count }}
              components={liveBold}
            />
          )}
        </p>
        {week.line ? <p className="dev-ws-week-lead" data-ws-week-line="">{week.line}</p> : null}
        {loading ? <p className="dev-ws-none" data-ws-week-loading="">{t('project:weekPage.loading')}</p> : null}
        {failed ? <p className="dev-ws-none" data-ws-week-failed="">{t('project:weekPage.failed')}</p> : null}
        {!groups.length && !loading && !failed ? <p className="dev-ws-none">{t('project:weekPage.none')}</p> : null}
      </section>
      {groups.map((g) => <Group key={g.key} group={g} slug={slug} openKey={openKey} onOpen={onOpen} />)}
    </div>
  );
}

/** One week, as one row of What happened: its name, its dates, what went live. */
export function WeekRow({ week, onOpen }: { week: SinceWeek; onOpen: () => void }): ReactNode {
  const t = useMessages('project');
  const live = weekLive(week);
  const fresh = weekFresh(week).length;
  const name = weekName(week);
  const dated = !week.title && week.key !== 'lastWeek';
  return (
    <button type="button" className="dev-ws-week" data-ws-week={week.key} onClick={onOpen}>
      <span className="dev-ws-week-main">
        <span className="dev-ws-week-head">
          <b>{name}</b>
          {dated ? null : <span>{weekRange(week.startMs, week.endMs, week.live)}</span>}
          {fresh ? <span className="dev-ws-week-fresh">{t('project:weeks.row.fresh', { count: fresh })}</span> : null}
        </span>
      </span>
      {live ? <WeekLive live={live} /> : null}
      <ChevronRightIcon className="dev-ws-wrow-chev" aria-hidden="true" />
    </button>
  );
}

/** "496 live", the figure in green; "496+ live" when it is a floor. */
function WeekLive({ live }: { live: { count: number; partial: boolean } }): ReactNode {
  return (
    <span className="dev-ws-week-n">
      <RichMessage
        id={live.partial ? 'project:weeks.row.liveAtLeast' : 'project:weeks.row.live'}
        values={{ count: live.count }}
        components={[<b />]}
      />
    </span>
  );
}

/** A merge still rolling out to the people using the app (statusPillState's keys). */
const GOING_LIVE = new Set(['deploying', 'delivery_pending', 'merging']);

/**
 * One row of this week, on one line: a dot when it moved since your last
 * visit, what it is (a request, a change, live work, a vote), its title (a
 * link to its page, stretched over the row, and opened beside the list on a
 * wide window), "You" on your own, "Going live" on a merge still rolling
 * out (or the pill's own words when it is stuck), and when it moved. On a
 * phone the title wraps and the rest goes under it (app.css).
 *
 * `standing`: What's happening's own-work rows (Waiting on you, Your work,
 * Going live) draw this same row, ending it with where the work stands
 * instead: its most important tag in its tone ("Checks failing", "With
 * Homeroom bot · it replied 42m ago", "Started"), then who made it when
 * that is not simply you ("Only you", Homeroom bot), as Your work's two
 * lines picked them (work-row.tsx lineTags). Everything here is yours, so
 * no row says You, and the tag already says when where it matters.
 */
export function HappenedRow({ row, fresh, slug, on = false, onOpen, standing = false }: {
  row: CardRow;
  fresh: boolean;
  slug: string;
  on?: boolean;
  onOpen?: (event: MouseEvent<HTMLAnchorElement>, ref: TopicRef) => void;
  standing?: boolean;
}): ReactNode {
  const t = useMessages('project');
  const b = row.brief;
  if (!b) return null;
  const card = row.card;
  const href = openHref(slug, card);
  const ref = topicRef(card);
  const s = card.pill?.state || null;
  const going = b.kind === 'live' && !!s && GOING_LIVE.has(s.key);
  const stuck = b.kind === 'live' && !!s && !going && s.tone === 'blocked';
  const Glyph = TILE[b.kind] || PencilSquareIcon;
  const at = Number(row.at) || 0;
  const when = at > 0 && !standing ? agoStamp(at) : null;
  // A merge going live (or stuck) already says where it stands; who made it
  // still follows (#4728: Homeroom bot's change from your request).
  const stand = standing ? lineTags(b, card) : null;
  const first = stand && !going && !stuck && stand.ranked.length ? stand.ranked[0] : null;
  const maker = stand ? stand.maker : null;
  return (
    <li
      className="dev-ws-hrow"
      data-ws-row={row.key}
      data-ws-kind={b.kind}
      data-ws-open={ref ? `${ref.kind}:${ref.id}` : undefined}
      data-new={fresh ? '' : undefined}
      data-on={on ? '1' : undefined}
    >
      {fresh
        ? <span className="dev-ws-hrow-dot" role="img" aria-label={t('project:happened.row.new')} />
        : <span className="dev-ws-hrow-dot" aria-hidden="true" />}
      <span className="dev-ws-hrow-glyph" data-kind={b.kind} aria-hidden="true">
        {going ? <span className="dc-status-spinner-arc" /> : <Glyph />}
      </span>
      <span className="dev-ws-hrow-main">
        {href ? (
          <a
            className="dev-ws-hrow-link"
            href={href}
            aria-current={on ? 'true' : undefined}
            onClick={ref && onOpen ? (e) => onOpen(e, ref) : undefined}
          >
            {card.title.text}
          </a>
        ) : <span className="dev-ws-hrow-link">{card.title.text}</span>}
        <span className="dev-ws-hrow-meta">
          {b.mine && !standing ? <span className="dev-ws-hrow-you">{t('project:happened.row.you')}</span> : null}
          {going ? <span className="dev-ws-hrow-tag" data-tone="run">{t('project:happened.row.goingLive')}</span> : null}
          {stuck && s ? <span className="dev-ws-hrow-tag" data-tone="bad">{s.label}</span> : null}
          {first ? <MetaTag tag={first} /> : null}
          {maker ? <MetaTag tag={maker} /> : null}
          {when && when.text ? (
            <time className="dev-ws-hrow-ago" dateTime={new Date(at).toISOString()} title={when.title}>{when.text}</time>
          ) : null}
        </span>
      </span>
    </li>
  );
}

/**
 * A tag at the end of a one-line row: its words in its tone, no pill (the
 * row is one line of type), with the lock or Homeroom bot's glyph where the
 * tag has one, and its fewer words where it has them, saying the rest to a
 * screen reader as the tags line does (work-row.tsx Tag).
 */
function MetaTag({ tag }: { tag: RowTag }): ReactNode {
  return (
    <span className="dev-ws-hrow-tag" data-tone={tag.tone} title={tag.title || (tag.short ? tag.label : undefined)}>
      {tag.glyph === 'lock' ? <LockIcon aria-hidden="true" /> : null}
      {tag.glyph === 'bot' ? <SparklesIcon aria-hidden="true" /> : null}
      {tag.short ? <><span aria-hidden="true">{tag.short}</span><span className="sr-only">{tag.label}</span></> : tag.label}
    </span>
  );
}

/** How many of this week's new rows What happened draws, and how many seen ones after them. */
export const THIS_WEEK_NEW_MAX = 10;
export const THIS_WEEK_SEEN = 3;

/**
 * This week, at the head of What happened: its name and dates, "5 new"
 * (what moved since your last visit), "496 live", then its rows newest
 * first, the new ones and a few you have seen, then "All of this week",
 * which opens the week's own page. A quiet visit has no new ones to draw;
 * a first visit has no rows at all, only the week and its figure.
 */
export function ThisWeek({ week, slug, openKey, onOpen, onAll }: {
  week: SinceWeek;
  slug: string;
  openKey: string | null;
  onOpen: (event: MouseEvent<HTMLAnchorElement>, ref: TopicRef) => void;
  onAll: () => void;
}): ReactNode {
  const t = useMessages('project');
  const live = weekLive(week);
  const fresh = weekFresh(week);
  const rows = [
    ...fresh.slice(0, THIS_WEEK_NEW_MAX).map((row) => ({ row, fresh: true })),
    ...weekSeen(week).slice(0, THIS_WEEK_SEEN).map((row) => ({ row, fresh: false })),
  ];
  const keyOf = (row: CardRow) => {
    const ref = topicRef(row.card);
    return ref ? `${ref.kind}:${ref.id}` : null;
  };
  return (
    <div className="dev-ws-hweek" data-ws-this-week={week.key}>
      <div className="dev-ws-hweek-head">
        <span className="dev-ws-week-head">
          <b>{weekName(week)}</b>
          <span>{weekRange(week.startMs, week.endMs, week.live)}</span>
          {fresh.length ? <span className="dev-ws-week-fresh">{t('project:weeks.row.fresh', { count: fresh.length })}</span> : null}
        </span>
        {live ? <WeekLive live={live} /> : null}
      </div>
      {rows.length ? (
        <ul className="dev-ws-hlist">
          {rows.map(({ row, fresh: isNew }) => (
            <HappenedRow
              key={row.key}
              row={row}
              fresh={isNew}
              slug={slug}
              on={!!openKey && keyOf(row) === openKey}
              onOpen={onOpen}
            />
          ))}
        </ul>
      ) : null}
      {week.fresh.length || week.seen.length || week.line ? (
        <button type="button" className="dev-ws-reveal touch-target-32" data-ws-week={week.key} data-ws-week-all="" onClick={onAll}>
          {t('project:happened.allOfWeek')}
          <ChevronRightIcon className="dev-ws-reveal-chev" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

/** How many weeks before this one What happened lists, and how many each "Earlier weeks" adds. */
export const WEEKS_FIRST = 2;
export const WEEKS_STEP = 4;
