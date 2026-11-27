/**
 * HOMEROOM BOT BUILDING TIME, on Settings' "AI usage & models" page, under
 * the AI allowance.
 *
 * What the bot's building time is for this person this week: how much of
 * it they have used, when it starts again, and the requests that used it,
 * largest first, each a link to its request. It is the answer to "why did I
 * run out?", which nothing showed before but the message that said so.
 *
 *   Homeroom bot building time
 *   ┌───────────────────────────────────────────────┐
 *   │ 62% of this week's building time used          │
 *   │ ███████████████░░░░░░░░░                        │
 *   │ Resets Sunday at 8:00 PM.                      │
 *   ├───────────────────────────────────────────────┤
 *   │ A dark mode for the board                 31% │
 *   │ Board                                          │
 *   │ Water reminders                           12% │
 *   │ Garden · You asked for this                    │
 *   │ Show all 12                                    │
 *   └───────────────────────────────────────────────┘
 *
 * The five largest show; the rest wait behind "Show all" (#5284), and a
 * title wraps onto a second line rather than being cut at the first.
 *
 * Shares of the week, never money (GET /api/me/building-time words nothing
 * else). It is read when the section shows, not when the shell loads, and
 * nothing renders until it arrives: the shell's prerender has only an empty
 * marker here, so hydration has nothing to disagree with.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { GroupedList, ListRow } from '@/components/ui/grouped-list';

import { useMessages } from '../../lib/i18n/react';
import { resetMoment, resetUtc } from '../../lib/reset-time';

export interface BuildingTimeRequest {
  app: { slug: string; name: string };
  issueNumber: number;
  title: string | null;
  /** Of the week's building time, or of what was used when there is no limit. */
  share: number;
  /** They asked the bot to build somebody else's request. */
  asked: boolean;
  runs: number;
}

export interface BuildingTimeWeek {
  limited: boolean;
  usedShare: number | null;
  usedUp: boolean;
  resetsAt: string;
  requests: BuildingTimeRequest[];
  otherShare: number;
  demo?: boolean;
}

/** Where the week is read from. Pure. */
export function buildingTimeUrl(demo = false): string {
  return demo ? '/api/me/building-time?demo=1' : '/api/me/building-time';
}

/** A share as a whole percent, "Under 1%" for a sliver; never 0% for something. Pure. */
export function percentOf(share: number): { under: boolean; percent: number } {
  const pct = Math.max(0, Number(share) || 0) * 100;
  if (pct > 0 && pct < 1) return { under: true, percent: 1 };
  return { under: false, percent: Math.round(pct) };
}

/** How many requests show before "Show all". */
export const TOP_REQUESTS = 5;

/** Where a request is read. Pure. */
export function requestPath(slug: string, issueNumber: number): string {
  return `#app/${encodeURIComponent(slug)}/dev/issues/${issueNumber}`;
}

function demoAsked(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('demo') === '1';
  } catch {
    return false;
  }
}

/** The card, from a week as the endpoint answers it. Pure but for the reset's clock. */
export function BuildingTimeView({ week, reset, showAll = false }: {
  week: BuildingTimeWeek;
  /** The reset in the viewer's own clock, worked out in an effect. */
  reset: { day: string; time: string; utc: string } | null;
  /** Start with every request showing, not only the top five. */
  showAll?: boolean;
}): ReactNode {
  const t = useMessages('settings');
  const [all, setAll] = useState(showAll);
  // The endpoint answers largest first (services/building-time.js), so the
  // first five are the five that used the most.
  const folded = !all && week.requests.length > TOP_REQUESTS;
  const shown = folded ? week.requests.slice(0, TOP_REQUESTS) : week.requests;
  const pct = (share: number) => {
    const p = percentOf(share);
    return p.under ? t('settings:usage.buildingTime.underOne') : t('settings:usage.buildingTime.percent', { percent: p.percent });
  };
  const used = week.usedShare == null ? null : percentOf(week.usedShare);
  let summary: string;
  if (!week.limited) summary = t('settings:usage.buildingTime.unlimited');
  else if (week.usedUp) summary = t('settings:usage.buildingTime.usedUp');
  else if (!week.requests.length && !week.otherShare) summary = t('settings:usage.buildingTime.none');
  else summary = t('settings:usage.buildingTime.used', { percent: used ? used.percent : 0 });
  const fill = Math.min(100, Math.max(0, Math.round((week.usedShare || 0) * 100)));

  return (
    <div className="mb-3" data-building-time="">
      <div className="ui-cap px-1 pb-1 text-[15px] text-zinc-500 dark:text-zinc-500">
        {t('settings:usage.buildingTime.title')}
      </div>
      <GroupedList className="mx-0">
        <div className="px-4 py-3 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-zinc-200 dark:[&:not(:last-child)]:border-zinc-800">
          <div className="text-[0.9375rem] font-[650] leading-5 text-zinc-900 dark:text-zinc-100" data-building-time-summary="">
            {summary}
          </div>
          {week.limited ? (
            <div
              className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
              role="progressbar"
              aria-label={t('settings:usage.buildingTime.title')}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={fill}
            >
              <div
                className={week.usedUp
                  ? 'h-full rounded-full bg-[color:var(--state-attention)]'
                  : 'h-full rounded-full bg-[color:var(--lit-ink)]'}
                style={{ width: `${fill}%` }}
              />
            </div>
          ) : null}
          {week.limited && reset ? (
            <div className="mt-2 text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400" title={reset.utc}>
              {t('settings:usage.buildingTime.resets', { day: reset.day, time: reset.time })}
            </div>
          ) : null}
        </div>
        {shown.map((r) => (
          <ListRow
            key={`${r.app.slug}#${r.issueNumber}`}
            as="a"
            href={requestPath(r.app.slug, r.issueNumber)}
            data-building-time-request={`${r.app.slug}#${r.issueNumber}`}
            title={r.title || t('settings:usage.buildingTime.untitled', { number: r.issueNumber })}
            subtitle={r.asked ? t('settings:usage.buildingTime.askedFor', { app: r.app.name }) : r.app.name}
            titleClassName="line-clamp-2 whitespace-normal [overflow-wrap:anywhere]"
            chevron={false}
            trailing={<span className="shrink-0 tabular-nums text-[0.9375rem] text-zinc-500 dark:text-zinc-400">{pct(r.share)}</span>}
          />
        ))}
        {folded ? (
          // A row of the list, not a link: it opens the rest in place.
          <ListRow
            as="button"
            onClick={() => setAll(true)}
            data-building-time-show-all=""
            title={t('settings:usage.buildingTime.showAll', { count: week.requests.length })}
            titleClassName="text-center font-semibold text-violet-700 dark:text-violet-300"
            chevron={false}
          />
        ) : null}
        {/* "Other requests" is the list's past its end, so it follows the
            whole list: under a folded one it would read as the hidden rows. */}
        {!folded && week.otherShare > 0 ? (
          <ListRow
            title={t('settings:usage.buildingTime.others')}
            chevron={false}
            trailing={<span className="shrink-0 tabular-nums text-[0.9375rem] text-zinc-500 dark:text-zinc-400">{pct(week.otherShare)}</span>}
          />
        ) : null}
      </GroupedList>
      <p className="ui-note mt-1.5 px-1 text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400">
        {week.limited
          ? t('settings:usage.buildingTime.explainLimited')
          : t('settings:usage.buildingTime.explainUnlimited')}
      </p>
      {week.demo ? (
        <p className="ui-note mt-1 px-1 text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400" data-building-time-demo="">
          {t('settings:usage.buildingTime.demo')}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The card as the page mounts it: an empty marker until the section shows
 * (the page keeps every section in the shell and hides the ones not open),
 * then the week, read each time it shows.
 */
export function BuildingTime(): ReactNode {
  const marker = useRef<HTMLDivElement>(null);
  const [week, setWeek] = useState<BuildingTimeWeek | null>(null);
  const [reset, setReset] = useState<{ day: string; time: string; utc: string } | null>(null);

  useEffect(() => {
    const el = marker.current;
    if (!el || typeof ResizeObserver !== 'function') return undefined;
    let ctl: AbortController | null = null;
    let shown = false;
    const load = () => {
      ctl?.abort();
      ctl = typeof AbortController === 'function' ? new AbortController() : null;
      fetch(buildingTimeUrl(demoAsked()), { credentials: 'same-origin', ...(ctl ? { signal: ctl.signal } : {}) })
        .then((res) => (res.ok ? res.json() : null))
        .then((body: BuildingTimeWeek | null) => {
          if (!body || !Array.isArray(body.requests)) return;
          setWeek(body);
          const m = resetMoment('weekly', { at: body.resetsAt });
          setReset({ ...m, utc: resetUtc('weekly', { at: body.resetsAt }) });
        })
        .catch(() => { /* no card: the page reads the same without it */ });
    };
    // The section is display:none until it is opened, so the marker has no
    // width until then. It takes one the moment the section shows, wherever
    // the page is scrolled (a deep link to a later part of the page scrolls
    // past this one), and the week is read each time it does.
    const sized = new ResizeObserver((entries) => {
      const visible = entries.some((e) => e.contentRect.width > 0);
      if (visible && !shown) load();
      shown = visible;
    });
    sized.observe(el);
    return () => {
      sized.disconnect();
      ctl?.abort();
    };
  }, []);

  return (
    <>
      <div ref={marker} aria-hidden="true" className="h-0" />
      {week ? <BuildingTimeView week={week} reset={reset} /> : null}
    </>
  );
}
