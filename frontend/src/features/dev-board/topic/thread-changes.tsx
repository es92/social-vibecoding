/**
 * #6019, follow-up: a request's changes and its vote to close, on the
 * request's own page, under the request (./request-head.tsx). Plan v3 and
 * the 28 Oct decisions: the request leads; its changes follow under a rule,
 * each with the Votes and Testing cards its own page draws; changes that
 * compete are one short row each and ONE vote between them; an open vote to
 * close the request competes with them the same way (Close it in Neither's
 * place), or stands alone as its own Votes card.
 *
 *   ───────────────────────────────────────────────
 *   CHANGE #406 · DEWI                (a single change)
 *   Night mode by schedule             → its page
 *   [ Votes  1 of 2 yes   ▮▮▯ ] [Yes][No]
 *   [ Testing  All checks passed ] [Try it]
 *   ⌄ 2 earlier replies on this change
 *
 *   2 CHANGES FOR #403                  (competing)
 *   [A] Night mode toggle · bot · #405 · ✓ Checks passed · Try it
 *   [B] Night mode by schedule · dewi · #406 · Checks running
 *   [ Votes   A ▮▮▯ 1 · B ▮▯▯ 0 · Neither 0 ] [A][B][Neither]
 *
 * 31 Oct 2026: a change built from a plan says so under its name, with
 * the plan's Read (`plans`, ./request-head.tsx plansByChange), and the plan
 * is not listed again over the changes:
 *
 *   [A] Dark theme that follows the system setting · ana · #6067 · ✓ Checks passed
 *       📋 Built from the plan "Follow the system setting" · Read
 *
 * Each change is read the way its own page reads it (topic-head.tsx
 * readChangeDetail, then AppView._topicViewFor), so its cards are its page's
 * cards, with their buttons, and they move when its page would: on the
 * `change-detail-refresh` that names it. Nothing renders until the thread is
 * read (an effect in ./request-head.tsx), so the first paint is the page as
 * it was.
 *
 * 1 Nov 2026 (one page per thread): a change built for a request has no
 * page of its own any more; its address lands here, at it (AppView
 * _renderTopicSubView, ./votes-in-view.ts). So its section carries what
 * only its page had: its status pill and its own ⋯ on its line (the rows
 * its view registers, `detail:proposal:<id>`), its summary, a small before
 * and after with Expand into its page's viewer, and the sheets its ⋯ and
 * its Testing card open (topic-head.tsx ChangeSheets). Its replies are in
 * the request's one discussion now (../../group-chat/transcript.tsx
 * RequestRows), so the fold of its earlier replies is gone. Competing
 * changes fold under their ballot, with no Vote button of their own; a
 * change for this request that lives on another request's page is one
 * line that says where (`elsewhere`).
 *
 *   CHANGE #6063 · DEWI                       [Up for a vote] [⋯]
 *   Pin a message to the top of a channel
 *   │ Admins can pin one message per channel…
 *   [before] [after]  ⤢ Expand
 *   [ Votes  1 of 2 yes   ▮▮▯ ] [Yes][No]
 *   [ Testing  All checks passed ] [Try it]
 */

import { createContext, Fragment, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, ReactNode, RefObject } from 'react';

import { RichMessage, useMessages } from '../../../lib/i18n/react';
import { i18n, t as translate } from '../../../lib/i18n/runtime';
import { projectChangesOnGithub } from '../../../lib/change-ref';
import { reload as reloadTab } from '../../../lib/tab-build';
import { detailDrawn, detailEntry, markShotsArrival, takeShotsArrival } from '../../ai/detail';
import { CheckIcon, ChevronDownIcon, EllipsisHorizontalIcon, XIcon } from '@/components/ui/icons';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/ui/feed';
import { Skeleton, SkeletonGroup } from '@/components/ui/skeleton';
import { ActionButton, StatusPill } from '../card/dev-card';
import type { DevCardModel } from '../card/model';
import { ChangeGates } from './change-head';
import { changeDetailAsk, mergeChangePatch } from './change-detail-refresh';
import type { ChangeThreadView, TopicBody } from './model';
import { ChangeSheets, readChangeDetail } from './topic-head';
import { outcomeLine, type GovernanceView } from './governance-model';
import { RequestWords } from './request-head';
import { openRequestSpec, type RequestSpecCard } from './request-model';
import { holdVotesInView, onVotesAsked, takeVotesInView } from './votes-in-view';
import { pageSlug } from './thread-items';
import { swatchFor } from '../../group-chat/swatch';
import { WorkWithBotButton } from './work-with-bot';
import {
  alsoCloses,
  ballotOf,
  ballotVotes,
  closesList,
  elsewhereFor,
  type Ballot,
  type FoldedReply,
  type ThreadElsewhere,
  type ThreadItem,
  type ThreadPayload,
} from './thread-model';

function appView(): any {
  return typeof window !== 'undefined' ? (window as any).AppView : null;
}

/**
 * #6098: a vote sent from the keyboard leaves focus where it was. A button
 * that was `disabled` while its vote went out dropped focus to the page, so
 * the next Tab started again at the top. The buttons are `aria-disabled` now;
 * a redraw that replaced the node is found again by the key it carries —
 * `data-ballot-option` or `data-close-vote`.
 */
function refocusAfterVote(host: HTMLElement | null, attr: string, from: HTMLElement | null, wasFocused: boolean): void {
  if (!wasFocused || typeof document === 'undefined') return;
  const active = document.activeElement;
  if (active && active !== document.body) return;
  const key = from?.getAttribute(`data-${attr}`) || '';
  if (!key) return;
  host?.querySelector<HTMLElement>(`[data-${attr}="${key}"]`)?.focus({ preventScroll: true });
}

interface ChangeView {
  row: any;
  card: DevCardModel;
  body: TopicBody;
  v: ChangeThreadView;
}

/** Whether a change has cards to draw: it is up for a vote, or went in. */
const hasCards = (item: ThreadItem) => item.state === 'review' || item.state === 'merged';

/**
 * #6392: Homeroom bot is on this change, so its private-thread button is left
 * out: it is still building it, or it is fixing or about to fix its failing
 * checks (its Testing card's `botFix`; a fix it handed back, stopped or
 * found to be the platform's is no longer the bot at work).
 */
function changeBotAtWork(item: ThreadItem, view: ChangeView | null): boolean {
  if (item.byBot && item.state === 'underway' && !item.ready) return true;
  const fix = view?.v.testing.botFix;
  return fix === 'fixing' || fix === 'queued';
}

/**
 * Each change's own page read, and the view its page builds from it, in the
 * order given. Null until it is read. One hook for the list, so the count of
 * changes can move without moving the hooks. 1 Nov 2026: a change still
 * being built is read too, for its ⋯ (its page's rows, the Build door among
 * them); it draws its cards once it is up for a vote.
 */
function useChangeViews(items: ThreadItem[], tick = 0): Array<ChangeView | null> {
  const [rows, setRows] = useState<Record<number, any>>({});
  const [revision, setRevision] = useState(0);
  // #6477: a caller's own bump (the ballot, after it picks) is a re-read after
  // a vote moved the figures, so it skips the cached copy the first read
  // painted.
  const seenTick = useRef(tick);
  // #6490: the status each change was last read at. When a merge arrives, the
  // item's status moves (promoted → merged) but the service worker may still
  // answer with its saved pre-merge copy, so a moved status asks past it.
  const seen = useRef<Record<number, string>>({});
  const key = items.map((i) => `${i.id}:${i.status}`).join(',');
  useEffect(() => {
    if (!items.length) return undefined;
    const bumped = seenTick.current !== tick;
    seenTick.current = tick;
    const abort = new AbortController();
    // #6441: a change's page is the request's page now, so a change drawn
    // here has been seen: its "ready to try" leaves the bell. The call is a
    // no-op while nothing is unread.
    for (const item of items) window.Notifications?.markProposalSeen?.(item.id);
    for (const item of items) {
      const before = seen.current[item.id];
      const fresh = bumped || (before !== undefined && before !== item.status);
      seen.current[item.id] = item.status;
      readChangeDetail({ id: item.id, status: item.status }, false, abort.signal, { fresh })
        .then((row) => { if (!abort.signal.aborted && row) setRows((was) => ({ ...was, [item.id]: row })); })
        .catch(() => {});
    }
    // Told the way its own page is (./change-detail-refresh.ts).
    const refresh = (event: Event) => {
      for (const item of items) {
        const ask = changeDetailAsk((event as CustomEvent).detail, item.id);
        if (!ask) continue;
        if ('row' in ask) setRows((was) => ({ ...was, [item.id]: ask.row }));
        else if ('patch' in ask) setRows((was) => ({ ...was, [item.id]: mergeChangePatch(was[item.id], item.id, ask.patch) }));
        else setRevision((n) => n + 1);
      }
    };
    window.addEventListener('change-detail-refresh', refresh);
    return () => { abort.abort(); window.removeEventListener('change-detail-refresh', refresh); };
  }, [key, revision, tick]);
  return useMemo(() => items.map((item) => {
    const av = appView();
    const row = rows[item.id];
    if (!row || !av || typeof av._topicViewFor !== 'function') return null;
    // A vote still on its way stays on the button, as on its own page.
    if (typeof av._overlayPendingVote === 'function') av._overlayPendingVote(row);
    const built = av._topicViewFor('proposal', row);
    const v = built && built.body && built.body.thread;
    return v ? { row, card: built.card, body: built.body, v } : null;
  }), [items, rows]);
}

/**
 * Whether the gate counts the viewer's own change as their Yes without a
 * vote (governance-rules.ts: proposing counts as a yes on the counted
 * rules), read off its proposal row: Two yeses and Open floor count every
 * person's change; You or the group counts the creator's. Anything else
 * (Group vote, a project's own rules) is not assumed: the viewer taps. Nor
 * is a change a coding agent submitted for them (`external_agent`): its
 * author taps Yes on it like anyone else.
 */
export function authorCounts(item: ThreadItem, row: any): boolean {
  if (!item.mine || item.byBot || item.myVote || !row || row.external_agent || row.approval_mode !== 'rules') return false;
  if (row.approval_preset === 'two_yeses' || row.approval_preset === 'open_floor') return true;
  return row.approval_preset === 'you_or_the_group' && !!row.creator_yes;
}

/** What a change's own page counts toward its rule, and needs. */
function tally(row: any): { yes: number; need: number } {
  const yes = Number(row?.qualified_yes_count ?? row?.yes_count) || 0;
  const need = Math.max(1, Number(row?.votes_required) || 1);
  return { yes, need };
}

const letterOf = (i: number) => String.fromCharCode(65 + i);

const KICKER = 'text-[12px] font-semibold uppercase tracking-[0.06em] text-zinc-500 dark:text-zinc-400';

/** The words over a change: who built it, and its number or its letter on a ballot. */
function useKicker(item: ThreadItem, letter: string | null): string {
  const t = useMessages('project');
  const by = item.by || t('project:topic.thread.page.someone');
  const github = projectChangesOnGithub();
  return letter
    ? t('project:topic.thread.page.changeLettered', { letter, by })
    : item.number
      ? t(github ? 'project:topic.thread.page.changeNumberedPr' : 'project:topic.thread.page.changeNumbered', { number: item.number, by })
      : t('project:topic.thread.page.change', { by });
}

/**
 * 1 Nov 2026: a change's own ⋯, its page's rows (AppView._topicCard
 * registers them under its view's key), which the document-level handler
 * opens as any `data-card-menu` disc.
 */
function ChangeMenu({ item, view }: { item: ThreadItem; view: ChangeView | null }): ReactNode {
  const t = useMessages('project');
  const key = view?.card.rail?.menuKey || '';
  if (!key) return null;
  const label = item.number
    ? t(projectChangesOnGithub() ? 'project:topic.thread.page.moreNumberedPr' : 'project:topic.thread.page.moreNumbered', { number: item.number })
    : t('project:topic.thread.page.more');
  return (
    <button type="button" className="dev-thread-change-menu" data-card-menu={key} aria-haspopup="true" aria-label={label} title={label}>
      <EllipsisHorizontalIcon aria-hidden="true" />
    </button>
  );
}

/**
 * A change's name where its section begins: who built it and its number,
 * its status pill and its ⋯ on that line, then its title. The title is not
 * a door any more: this is the change's page.
 */
export function ChangeLine({ item, view, letter = null }: { item: ThreadItem; view: ChangeView | null; letter?: string | null }): ReactNode {
  const t = useMessages('project');
  const kicker = useKicker(item, letter);
  const status = view?.v.status || null;
  // #6233: the change is live in the app, but this tab runs the version
  // before it: say so and offer the same reload the side menu does.
  const behind = !!status && (status.key === 'deployed_reload' || status.key === 'merged_reload');
  return (
    <div className="min-w-0" data-thread-change-line={item.id}>
      <div className="flex min-w-0 items-center gap-2">
        <div className={`${KICKER} min-w-0 flex-1 truncate`}>{kicker}</div>
        {status ? <span className="shrink-0" data-thread-change-status={status.key}><StatusPill s={status} inline /></span> : null}
        {behind ? (
          <button
            type="button"
            className="shrink-0 text-[13px] font-semibold text-violet-700 hover:underline dark:text-violet-300"
            onClick={() => reloadTab()}
            data-thread-change-reload={item.id}
          >
            {t('project:change.reload')}
          </button>
        ) : null}
        <ChangeMenu item={item} view={view} />
      </div>
      <h3 className="mt-0.5 min-w-0 text-[15px] font-[650] leading-snug text-zinc-900 dark:text-zinc-100" data-thread-change-title={item.id}>
        {item.title || t('project:topic.thread.item.changeUnnumbered')}
      </h3>
    </div>
  );
}

/** The plan a change was built from, under its name, with the plan's own Read. */
export function PlanLine({ plan, builtFrom }: { plan: RequestSpecCard; builtFrom?: ThreadItem['builtFrom'] }): ReactNode {
  const t = useMessages('project');
  const [loading, setLoading] = useState(false);
  const version = builtFrom?.version ?? null;
  const fromPlan = version
    ? t('project:topic.thread.page.fromPlanVersion', { version, title: plan.title })
    : t('project:topic.thread.page.fromPlan', { title: plan.title });
  const newer = builtFrom?.newer || null;
  const newerText = newer
    ? (newer.sameAuthor || !newer.author
      ? t('project:topic.thread.page.newerPlan', { version: newer.version })
      : t('project:topic.thread.page.newerPlanOther', { author: newer.author }))
    : null;
  return (
    <span className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[13px] text-zinc-500 dark:text-zinc-400" data-thread-change-plan={plan.key}>
      <span aria-hidden="true">📋</span>
      {/* The phrase truncates from its end, so "Built from v1 of the plan"
          always stays readable and only the plan's title is cut. */}
      <span className="min-w-0 truncate" title={fromPlan}>{fromPlan}</span>
      {/* On a phone the row is too narrow to hold this beside Read, so it
          drops to its own second line rather than squeezing the title out. */}
      {newer && newerText ? (
        <span className="shrink-0 font-semibold text-zinc-700 dark:text-zinc-300 max-sm:order-last max-sm:w-full" data-thread-change-newer-plan={newer.version}>
          <span aria-hidden="true">· </span>{newerText}
        </span>
      ) : null}
      <button
        type="button"
        className="shrink-0 font-semibold text-violet-700 hover:underline disabled:opacity-60 dark:text-violet-300"
        disabled={loading}
        aria-label={t('project:topic.request.spec.readNamed', { title: plan.title })}
        onClick={async () => {
          setLoading(true);
          try { await openRequestSpec(plan); } finally { setLoading(false); }
        }}
      >
        {loading ? t('project:topic.request.spec.opening') : t('project:topic.request.spec.read')}
      </button>
    </span>
  );
}

/**
 * 1 Nov 2026: a verified run's first screen, before and after, small, with
 * Expand: the change page's own viewer (AppView.shotsHtml's `thread`
 * reading) opens in the detail column beside the thread (#6230).
 *
 * #6315: the column is drawn by every page that has one (a request's, the
 * Workshop's panel, the general chat), and by the bot page. Where a surface
 * has none — Expand pressed on a page that hosts no detail — the person is
 * sent to the change's page instead, and the arrival below opens the before
 * and after as soon as the change is drawn. A restored address (a reload
 * while the before and after were open) has a shots entry with no html: this
 * page carries it, so the effect fills it in rather than leaving "Loading…".
 */
function ShotsPair({ id, number, s }: {
  id: number; number: number | null; s: NonNullable<ChangeThreadView['shots']>;
}): ReactNode {
  const t = useMessages('project');
  const thumbs = s.state === 'verified' ? s.thumbs : null;
  const html = s.html;
  const open = () => {
    (window as any).UsernodeReact?.detail?.open({
      kind: 'shots',
      ref: { changeId: id },
      version: null,
      payload: { html },
    });
  };
  useEffect(() => {
    if (!thumbs || !html) return;
    const entry = detailEntry();
    // A reload's restored entry: the same change, no html yet.
    if (entry && entry.kind === 'shots' && entry.ref.changeId === id && !entry.payload?.html) open();
    else if (takeShotsArrival(id)) open();
    // `open` is rebuilt with `html` and `id`, which are the dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, html, thumbs]);
  if (!thumbs || !html) return null;
  // #6230: Expand opens the change's before and after in the detail column
  // beside the thread, as a design's preview and a plan do, instead of in a
  // popover over the page.
  const expand = () => {
    open();
    // #6315: two frames for the column to open where this page has one; if
    // nothing drew it, go to the change's page, where the arrival opens it.
    const slug = pageSlug();
    const target = number && slug ? `app/${encodeURIComponent(slug)}/dev/changes/${number}` : '';
    const after = () => {
      if (detailDrawn() || !target) return;
      if (window.location.hash.replace(/^#/, '') === target) return;
      markShotsArrival(id);
      window.location.hash = target;
    };
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => window.requestAnimationFrame(after));
    } else {
      window.setTimeout(after, 32);
    }
  };
  return (
    <div className="dev-thread-shots" data-thread-change-shots={id}>
      <button type="button" className="dev-thread-shots-pair" onClick={expand} aria-label={t('project:topic.thread.page.shotsOpen')}>
        {(['before', 'after'] as const).map((side) => (
          <span key={side} className="dev-thread-shot" data-thread-shot={side}>
            {thumbs[side]
              ? <img src={thumbs[side] as string} alt="" loading="lazy" decoding="async" />
              : <span className="dev-thread-shot-none" aria-hidden="true" />}
            <span className="dev-thread-shot-label">{side === 'before' ? t('project:topic.thread.page.shotBefore') : t('project:topic.thread.page.shotAfter')}</span>
          </span>
        ))}
      </button>
      <button type="button" className="dev-thread-shots-expand" data-thread-shots-expand={id} onClick={expand}>
        {t('project:topic.thread.page.shotsExpand')}
      </button>
    </div>
  );
}

/**
 * The page a door asked for this change (./votes-in-view.ts): once its
 * section is drawn, its Votes card (or, still being built, its section) is
 * brought into view and held there while the page settles.
 */
function useInView(id: number, ready: boolean, box: RefObject<HTMLElement | null>, target = '[data-change-gate="votes"]'): void {
  useEffect(() => {
    if (!ready) return undefined;
    let release: (() => void) | null = null;
    const show = () => {
      const el = box.current;
      const card = el ? (el.querySelector<HTMLElement>(target) || el) : null;
      if (!card || !takeVotesInView(id)) return;
      release?.();
      release = holdVotesInView(card);
    };
    show();
    const off = onVotesAsked(show);
    return () => { off(); release?.(); };
  }, [id, ready, target]);
}

/** "#6159, #6210, #6212, and 6 more": the numbers, as the language lists them. */
function numberText(numbers: number[], locale: string): string {
  const all = numbers.map((n) => `#${n}`);
  try {
    return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(all);
  } catch {
    return all.join(', ');
  }
}

/**
 * The parts, joined the way the language joins a list: its `literal` parts
 * are the punctuation between the links, and each `element` is one of them.
 */
function joinParts(parts: ReactNode[], locale: string): ReactNode[] {
  try {
    const marks = parts.map((_, i) => `\u0000${i}\u0000`);
    // formatToParts is ES2021 and may be missing from an older TypeScript lib.
    const formatter: { formatToParts(values: string[]): Array<{ type: string; value: string }> } = new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' });
    return formatter.formatToParts(marks).map((part) => (part.type === 'element'
      ? parts[Number(part.value.replace(/\u0000/g, ''))]
      : part.value));
  } catch {
    return parts.flatMap((part, i) => (i ? [', ', part] : [part]));
  }
}

/** RichMessage's one tag: the list, joined by joinParts. */
function Joined({ parts }: { parts: ReactNode[] }): ReactNode {
  return <>{parts}</>;
}

/**
 * #6224: a change for several requests lives on its first request's page,
 * so its section says which other requests it closes when it merges, from
 * its own `closes` (linked_issues, exactly what the merge closes). The first
 * three link to their pages; "N more" unfolds the rest in place. Nothing
 * unless it closes this request and another.
 */
function AlsoCloses({ item, request }: { item: ThreadItem; request: number }): ReactNode {
  const t = useMessages('project');
  const [open, setOpen] = useState(false);
  const others = alsoCloses(item, request);
  if (!others.length) return null;
  const shown = open || others.length <= 3 ? others : others.slice(0, 3);
  const rest = others.length - shown.length;
  const slug = appView()?.appData?.slug || '';
  const merged = item.state === 'merged';
  const linkClass = 'font-semibold text-violet-700 hover:underline dark:text-violet-300';
  const parts: ReactNode[] = shown.map((n) => (
    <Fragment key={`n${n}`}>
      <a
        href={slug ? `#app/${encodeURIComponent(slug)}/dev/issues/${n}` : `#${n}`}
        className={linkClass}
        data-thread-change-also-on={n}
      >
        {`#${n}`}
      </a>
      {item.notConfirmed?.includes(n) ? ` ${t('project:topic.thread.page.claimNotConfirmed')}` : null}
    </Fragment>
  ));
  if (rest > 0) {
    parts.push(
      <button
        key="more"
        type="button"
        className={linkClass}
        aria-expanded="false"
        data-thread-change-also-more={rest}
        onClick={() => setOpen(true)}
      >
        {t('project:topic.thread.page.alsoMore', { count: rest })}
      </button>,
    );
  }
  const locale = i18n.language || 'en';
  return (
    <p className="mt-1 text-[13px] text-zinc-500 dark:text-zinc-400" data-thread-change-also={item.id} data-thread-change-also-state={merged ? 'closed' : 'closes'}>
      <RichMessage
        id={merged ? 'project:topic.thread.page.alsoClosed' : 'project:topic.thread.page.alsoCloses'}
        values={{ numbers: numberText(others, locale) }}
        components={[<Joined key="also" parts={joinParts(parts, locale)} />]}
      />
    </p>
  );
}

/**
 * #6387: the change section's shape while the request's thread is still being
 * read (./request-head.tsx `holding`): its line — the small-caps kicker and
 * its status pill — its title, then its Votes and Testing cards. The loaded
 * section fills the same place, so nothing swaps or jumps.
 */
export function ChangeSectionSkeleton(): ReactNode {
  const t = useMessages('project');
  return (
    <section className="mt-4 border-t border-[color:var(--app-sheet-line)]" data-thread-change-skeleton="">
      <SkeletonGroup label={t('project:topic.thread.page.changeLoading')} className="mt-3">
        <div className="flex items-center gap-2">
          <Skeleton shape="muted" className="w-32" />
          <Skeleton shape="block" className="h-5 w-24 rounded-full" />
        </div>
        <Skeleton className="mt-2.5 h-3.5 w-3/5" />
        <ChangeGatesSkeleton />
      </SkeletonGroup>
    </section>
  );
}

/** The Votes and Testing cards' place, until the change's own read lands. */
function ChangeGatesSkeleton(): ReactNode {
  return (
    <div className="dev-change-pair">
      <Skeleton shape="block" className="h-16 rounded-2xl" />
      <Skeleton shape="block" className="h-16 rounded-2xl" />
    </div>
  );
}

/**
 * #6421: how many requests the thread holds, for the changes drawn in it.
 * `ThreadChanges` sets it from the thread's read; 0 elsewhere, where there
 * is no thread around the change to count.
 */
const ThreadRequests = createContext(0);

/**
 * #6421: when a thread holds several requests, a change that closes only
 * some of them says so under its title ("Closes 3 of the 10 requests in this
 * thread"), from its own `closes` and the thread's request count. Nothing on
 * a thread of one request, or on a change that closes all of them.
 */
function ClosesOf({ item, requests }: { item: ThreadItem; requests: number }): ReactNode {
  const t = useMessages('project');
  const closes = Array.isArray(item.closes) ? item.closes.filter((n) => Number(n) > 0) : [];
  if (requests <= 1 || !closes.length || closes.length >= requests) return null;
  return (
    <p className="mt-1 text-[13px] text-zinc-500 dark:text-zinc-400" data-thread-change-closes-of={item.id}
      data-thread-change-closes-of-count={closes.length} data-thread-change-closes-of-total={requests}>
      {t('project:topic.thread.page.closesOf', { count: closes.length, total: requests })}
    </p>
  );
}

/**
 * What a change's section draws under its line: which other requests it
 * also closes, its summary, the plan it was built from, its before and
 * after, then its Votes and Testing cards (or, still being built, the line
 * that says so), and the sheets its ⋯ opens. `ballot`: folded under the
 * ballot, which is where it is voted on.
 */
function ChangeBody({ item, view, plan = null, ballot = false, request }: {
  item: ThreadItem; view: ChangeView | null; plan?: RequestSpecCard | null; ballot?: boolean; request: number;
}): ReactNode {
  const t = useMessages('project');
  const summary = view?.body.summaryHtml || '';
  const threadRequests = useContext(ThreadRequests);
  return (
    <>
      <AlsoCloses item={item} request={request} />
      <ClosesOf item={item} requests={threadRequests} />
      {summary ? <div className="dev-thread-change-summary" data-thread-change-summary={item.id}><RequestWords html={summary} /></div> : null}
      {view?.body.summaryStale && summary
        ? <p className="dev-change-stale" role="note" data-thread-change-stale={item.id}>{t('project:topic.change.summaryStale')}</p>
        : null}
      {plan ? <PlanLine plan={plan} builtFrom={item.builtFrom} /> : null}
      {view?.v.shots ? <ShotsPair id={item.id} number={item.number ?? null} s={view.v.shots} /> : null}
      {item.state === 'underway' || !hasCards(item) ? (
        <p className="mt-1 text-[13px] text-zinc-500 dark:text-zinc-400" data-thread-change-waiting={item.ready ? 'ready' : 'building'}>
          {t(item.ready ? 'project:topic.thread.page.ready' : 'project:topic.thread.page.underway')}
        </p>
      ) : view ? (
        <ChangeGates id={item.id} card={view.card} v={view.v} ballot={ballot} closes={closesList(item)} />
      ) : (
        // #6387: the cards keep their place while the change's own read is
        // still landing, so they fill in rather than pushing the page down.
        <ChangeGatesSkeleton />
      )}
      {view ? <ChangeSheets id={item.id} row={view.row} body={view.body} /> : null}
    </>
  );
}

/** One change, on its own: its line, then everything its page had. */
function ChangeBlock({ item, plan = null, request }: { item: ThreadItem; plan?: RequestSpecCard | null; request: number }): ReactNode {
  const [view] = useChangeViews([item]);
  const box = useRef<HTMLDivElement>(null);
  useInView(item.id, !!view || item.state === 'underway', box);
  return (
    <div ref={box} className="mt-3" data-thread-change={item.id} data-thread-change-state={item.state || ''}>
      <ChangeLine item={item} view={view} />
      <ChangeBody item={item} view={view} plan={plan} request={request} />
      {/* 1 Nov 2026: ask about it, or sketch a revision, privately. #6392: the
          words say so, and the bot building or fixing it leaves this out. */}
      <WorkWithBotButton
        slug={pageSlug()}
        number={item.number}
        voting={!!view?.v.votes.facts?.length}
        botAtWork={changeBotAtWork(item, view)}
      />
    </div>
  );
}

/**
 * D5: a competing change, folded under the ballot: its line, which opens
 * the rest of its section. `open` is the ballot's, so a tap on the change's
 * row in the ballot opens it too.
 */
function FoldedChange({ item, i, view, plan, request, open, onToggle }: {
  item: ThreadItem; i: number; view: ChangeView | null; plan: RequestSpecCard | null; request: number; open: boolean; onToggle: () => void;
}): ReactNode {
  const t = useMessages('project');
  const kicker = useKicker(item, letterOf(i));
  const status = view?.v.status || null;
  return (
    <div className="dev-thread-fold" data-thread-change={item.id} data-thread-change-state={item.state || ''} data-thread-fold={open ? 'open' : 'shut'}>
      <div className="flex min-w-0 items-center gap-2" data-thread-change-line={item.id}>
        <button type="button" className="dev-thread-fold-head min-w-0 flex-1 text-start" aria-expanded={open} data-thread-fold-toggle={item.id} onClick={onToggle}>
          <span className="flex min-w-0 items-center gap-1.5">
            <ChevronDownIcon className="dev-ws-reveal-chev h-4 w-4 shrink-0" aria-hidden="true" style={open ? { transform: 'rotate(180deg)' } : undefined} />
            <span className={`${KICKER} min-w-0 truncate`}>{kicker}</span>
          </span>
          <span className="mt-0.5 block min-w-0 ps-[22px] text-[15px] font-[650] leading-snug text-zinc-900 dark:text-zinc-100" data-thread-change-title={item.id}>
            {item.title || t('project:topic.thread.item.changeUnnumbered')}
          </span>
        </button>
        {status ? <span className="shrink-0" data-thread-change-status={status.key}><StatusPill s={status} inline /></span> : null}
        <ChangeMenu item={item} view={view} />
      </div>
      {open ? <div className="ps-[22px]"><ChangeBody item={item} view={view} plan={plan} ballot request={request} /></div> : null}
    </div>
  );
}

/**
 * #6420: a change for this request that lives on another request's page (a
 * change for several requests is on its first one's): a small card that says
 * the change claims to close this request, names it, and gives the requester
 * "This doesn't close it". Pressing the number or the title opens the change
 * where it lives. Nothing is unlinked.
 */
export function Elsewhere({ list, slug = null, onChanged }: {
  list: ThreadElsewhere[];
  slug?: string | null;
  onChanged?: () => void;
}): ReactNode {
  const t = useMessages('project');
  const [sending, setSending] = useState<number | null>(null);
  const [failed, setFailed] = useState<number | null>(null);
  const current = slug || appView()?.appData?.slug || '';
  const github = projectChangesOnGithub();
  if (!list.length) return null;
  async function dispute(e: ThreadElsewhere) {
    if (sending != null || !current) return;
    setSending(e.id);
    setFailed(null);
    try {
      const res = await fetch(
        `/api/apps/${encodeURIComponent(current)}/issues/${e.request}/changes/${e.id}/not-closing`,
        { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      );
      if (!res.ok) throw new Error(String(res.status));
      onChanged?.();
    } catch {
      setFailed(e.id);
    } finally {
      setSending(null);
    }
  }
  const linkClass = 'font-semibold text-violet-700 hover:underline dark:text-violet-300';
  return (
    <div className="mt-3 flex flex-col gap-2" data-thread-elsewhere={list.length}>
      {list.map((e) => {
        const href = current ? `#app/${encodeURIComponent(current)}/dev/issues/${e.on}` : `#${e.on}`;
        const keep = (event: ReactMouseEvent<HTMLAnchorElement>) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          appView()?._openChangeOnRequest?.(e.on, e.id);
        };
        return (
          <div key={e.id} className="rounded-[20px] bg-[color:var(--dc-sheet-solid)] px-3.5 py-3 shadow-[inset_0_0_0_1px_var(--app-sheet-line)]" data-thread-elsewhere-change={e.id}>
            <p className="text-[13px] text-zinc-500 dark:text-zinc-400">
              <RichMessage
                id={e.number
                  ? (github ? 'project:topic.thread.page.claimsPr' : 'project:topic.thread.page.claims')
                  : 'project:topic.thread.page.claimsUnnumbered'}
                values={e.number ? { number: e.number } : {}}
                components={[<a key="n" href={href} className={linkClass} data-thread-elsewhere-on={e.on} onClick={keep} />]}
              />
            </p>
            <p className="mt-0.5 text-[15px] font-[650] leading-snug text-zinc-900 dark:text-zinc-100">
              <a href={href} className="hover:underline" onClick={keep}>{e.title || t('project:topic.thread.item.changeUnnumbered')}</a>
            </p>
            {e.summary ? <p className="mt-0.5 truncate text-[13px] text-zinc-500 dark:text-zinc-400">{e.summary}</p> : null}
            {e.ask ? (
              <Button
                type="button"
                variant="pillNeutral"
                size="sm"
                ink="neutral"
                className="mt-2.5"
                disabled={sending === e.id}
                data-thread-elsewhere-dispute={e.id}
                onClick={() => void dispute(e)}
              >
                {t('project:topic.thread.page.claimDispute')}
              </Button>
            ) : null}
            {e.disputed && e.mine ? (
              <p className="mt-2.5 text-[13px] text-zinc-500 dark:text-zinc-400" data-thread-elsewhere-disputed={e.id}>
                {t('project:topic.thread.page.claimDisputed')}
              </p>
            ) : null}
            {failed === e.id ? (
              <p className="mt-1 text-[13px] text-[color:var(--state-blocked)]" role="alert">
                {t('project:topic.thread.page.claimDisputeFailed')}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * One competing change's row, with its Testing in a word and its preview.
 * 1 Nov 2026: its title opens the change's section folded under the ballot
 * (`onOpen`), the change's page now.
 */
function CompetingRow({ item, i, view, plan = null, onOpen }: {
  item: ThreadItem; i: number; view: ChangeView | null; plan?: RequestSpecCard | null; onOpen: () => void;
}): ReactNode {
  const t = useMessages('project');
  const preview = view ? (view.card.actions || []).find((a) => a.preview) : null;
  const testing = view ? view.v.testing : null;
  return (
    <div role="listitem" className={`flex items-start gap-3 px-3.5 py-3${i ? ' border-t border-[color:var(--app-sheet-line)]' : ''}`} data-change-row={letterOf(i)} data-thread-change-row={item.id}>
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-zinc-200/80 text-[13px] font-bold text-zinc-700 dark:bg-zinc-700/80 dark:text-zinc-200" aria-hidden="true">{letterOf(i)}</span>
      <span className="min-w-0 flex-1">
        <button type="button" className="block min-w-0 text-start text-[15px] font-[650] leading-snug text-zinc-900 hover:underline dark:text-zinc-100" data-change-row-open={item.id} onClick={onOpen}>
          {item.title || t('project:topic.thread.item.changeUnnumbered')}
        </button>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[13px] text-zinc-500 dark:text-zinc-400">
          <span>{item.number ? t(projectChangesOnGithub() ? 'project:topic.thread.page.rowByPr' : 'project:topic.thread.page.rowBy', { by: item.by || t('project:topic.thread.page.someone'), number: item.number }) : (item.by || '')}</span>
          {testing ? (
            <span className={testing.done ? 'inline-flex items-center gap-0.5 font-semibold text-[color:var(--state-ok)]' : testing.tone === 'bad' ? 'font-semibold text-[color:var(--state-blocked)]' : ''} data-thread-change-testing={testing.tone}>
              {testing.done ? <CheckIcon className="h-3.5 w-3.5" aria-hidden="true" /> : null}{testing.figure}
            </span>
          ) : null}
        </span>
        {plan ? <PlanLine plan={plan} builtFrom={item.builtFrom} /> : null}
      </span>
      {preview ? <span className="shrink-0"><ActionButton a={preview} /></span> : null}
    </div>
  );
}

interface CloseRow {
  yes: number;
  need: number;
  myVote: 'yes' | 'no' | null;
}

/** A vote to close's own read (routes/issues.js GET governance/:id): its tally and the viewer's vote. */
function useCloseRow(slug: string | null, close: ThreadItem | null, revision: number): CloseRow | null {
  const [row, setRow] = useState<CloseRow | null>(null);
  useEffect(() => {
    if (!slug || !close) { setRow(null); return undefined; }
    let live = true;
    fetch(`/api/apps/${encodeURIComponent(slug)}/governance/${close.id}`, { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        const p = json && json.proposal;
        if (!live || !p) return;
        setRow({
          yes: Number(p.qualified_yes_count ?? p.up_count) || 0,
          need: Math.max(1, Number(p.votes_required) || 1),
          myVote: p.my_vote === 'up' ? 'yes' : p.my_vote === 'down' ? 'no' : null,
        });
      })
      .catch(() => {});
    return () => { live = false; };
  }, [slug, close?.id, revision]);
  return row;
}

/** A Votes card's bar, one segment per yes the rule needs. #6439: an ended card's bar is full and drawn done. */
function Bar({ yes, need, label, done = false }: { yes: number; need: number; label: string; done?: boolean }): ReactNode {
  return (
    <div className="dev-change-bar" role="img" aria-label={label}>
      {Array.from({ length: need }, (_, i) => (
        <span key={i} className="dev-change-bar-seg" style={{ flexGrow: 1, flexBasis: 0 }}>
          <span className="dev-change-bar-fill" data-state={done ? 'done' : 'moving'} style={{ width: i < (done ? need : yes) ? '100%' : '0%' }} />
        </span>
      ))}
    </div>
  );
}

/**
 * Changes that compete, and an open vote to close that competes with them:
 * a short row each, then ONE Votes card with a bar per choice and a button
 * per choice. A pick is ordinary votes (./thread-model.ts ballotVotes): Yes
 * on the pick, the others' Yes taken back, and No on every change for
 * Neither or Close it. The first to pass its project's rule wins and closes
 * the rest (services/threads.js closeRivals, closeThreadChanges).
 */
export function Competing({ slug, data, anchor, options, close, onChanged, plans = null }: {
  slug: string | null;
  data: ThreadPayload;
  /** The requests the page is about (./thread-model.ts ballotOf). */
  anchor: readonly number[];
  options: ThreadItem[];
  close: ThreadItem | null;
  onChanged: () => void;
  /** The plan each change was built from, by its id. */
  plans?: ReadonlyMap<number, RequestSpecCard> | null;
}): ReactNode {
  const t = useMessages('project');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  // D5: which changes are open under the ballot; each starts folded.
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set());
  const box = useRef<HTMLDivElement>(null);
  const views = useChangeViews(options, revision);
  const closeRow = useCloseRow(slug, close, revision);
  // A door to one of these changes (./votes-in-view.ts) lands on the ballot,
  // where it is voted on.
  useBallotInView(options, box);
  const counts = new Set(options.filter((o, i) => authorCounts(o, views[i]?.row)).map((o) => o.id));
  const ballot: Ballot | null = ballotOf(data, counts, anchor);
  if (!ballot) return null;
  const toggle = (id: number) => setOpen((was) => {
    const next = new Set(was);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const reveal = (id: number) => {
    setOpen((was) => (was.has(id) ? was : new Set([...was, id])));
    // Once it has opened: its line at the top of what the reader sees.
    window.setTimeout(() => {
      const fold = box.current?.querySelector<HTMLElement>(`[data-thread-fold][data-thread-change="${id}"]`);
      if (fold && typeof fold.scrollIntoView === 'function') fold.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }, 50);
  };
  const project = appView()?.appData?.name || '';
  const choose = async (pick: number | 'neither' | 'close', from: HTMLElement | null = null) => {
    const av = appView();
    if (busy || !av) return;
    // #6098: keep the reader's place. The button is `aria-disabled` while the
    // votes are on their way, so it keeps focus; a redraw that replaced it
    // is found again by the key it carries.
    const wasFocused = !!from && document.activeElement === from;
    setBusy(true);
    try {
      for (const v of ballotVotes(ballot, pick, counts)) {
        if (v.kind === 'close') await av.castIssueVote?.(v.issueId, 'up', { reason: null });
        else if (v.vote === null) await av.retractVote?.(v.sessionId, v.epoch);
        else await av.castVote?.(v.sessionId, v.vote, v.epoch, { reason: null });
      }
    } finally {
      setBusy(false);
      setRevision((n) => n + 1);
      onChanged();
      refocusAfterVote(box.current, 'ballot-option', from, wasFocused);
    }
  };
  const choices = [
    ...options.map((o, i) => ({ key: String(o.id), label: letterOf(i), pick: o.id as number | 'neither' | 'close', ...tally(views[i]?.row) })),
    close
      ? { key: 'close', label: t('project:topic.thread.ballot.close'), pick: 'close' as const, yes: closeRow?.yes ?? 0, need: closeRow?.need ?? 1 }
      : { key: 'neither', label: t('project:topic.thread.ballot.neither'), pick: 'neither' as const, yes: 0, need: 1 },
  ];
  const heading = close
    ? (options.length === 1 ? t('project:topic.thread.ballot.headingClose') : t('project:topic.thread.ballot.headingCloseMany', { n: options.length }))
    : t('project:topic.thread.ballot.heading', { n: options.length, number: anchor[0] ?? data.thread.number ?? '' });
  return (
    <div ref={box} className="mt-3" data-thread-ballot={options.length} data-thread-ballot-close={close ? close.id : undefined} aria-busy={busy}>
      <div className={KICKER}>{heading}</div>
      <div className="mt-2 overflow-hidden rounded-2xl bg-[color:var(--messages-surface)]" role="list" aria-label={t('project:topic.thread.ballot.label')}>
        {options.map((o, i) => <CompetingRow key={o.id} item={o} i={i} view={views[i]} plan={plans?.get(o.id) || null} onOpen={() => reveal(o.id)} />)}
        {close ? (
          <div role="listitem" className="flex items-start gap-3 border-t border-[color:var(--app-sheet-line)] px-3.5 py-3" data-change-row="close">
            <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-zinc-200/80 text-zinc-700 dark:bg-zinc-700/80 dark:text-zinc-200" aria-hidden="true"><XIcon className="h-4 w-4" /></span>
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-[650] leading-snug text-zinc-900 dark:text-zinc-100">{t('project:topic.thread.ballot.close')}</span>
              <span className="mt-0.5 block text-[13px] text-zinc-500 dark:text-zinc-400">
                {close.reason
                  ? t('project:topic.thread.close.byWhy', { by: close.by || t('project:topic.thread.page.someone'), reason: close.reason })
                  : t('project:topic.thread.close.by', { by: close.by || t('project:topic.thread.page.someone') })}
              </span>
            </span>
          </div>
        ) : null}
      </div>
      <div className="dev-change-pair mt-2">
        <div className="dev-change-gate" data-change-gate="ballot" data-done="false" data-tone={ballot.pick === null ? 'ask' : 'muted'} role="group" aria-label={t('project:topic.thread.ballot.label')}>
          <div className="dev-change-gate-main">
            <div className="dev-change-gate-head">
              <span className="dev-change-gate-name">{t('project:topic.thread.ballot.votes')}</span>
              <span className="dev-change-gate-figure">{ballot.pick === null ? t('project:topic.thread.ballot.yourPick') : t('project:topic.thread.ballot.picked')}</span>
            </div>
            <div className="mt-2.5 flex flex-col gap-2">
              {choices.map((c) => (
                <div key={c.key} className="grid grid-cols-[66px_minmax(0,1fr)_18px] items-center gap-2.5 text-[13px]" data-ballot-tally={c.key}>
                  <span className="truncate font-semibold text-zinc-700 dark:text-zinc-200">{c.label}</span>
                  <Bar yes={c.yes} need={c.need} label={t('project:topic.thread.ballot.tally', { choice: c.label, yes: c.yes, need: c.need })} />
                  <span className="text-end tabular-nums text-zinc-500 dark:text-zinc-400">{c.yes}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="dev-change-gate-act" role="radiogroup" aria-label={t('project:topic.thread.ballot.label')}>
            {choices.map((c) => {
              const on = ballot.pick === c.pick;
              return (
                <button
                  key={c.key}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  className="dev-vote-btn"
                  data-ballot-option={c.key}
                  aria-disabled={busy || undefined}
                  style={on ? { minWidth: 0 } : { minWidth: 0, background: 'var(--state-neutral-bg)', color: 'var(--text-primary)' }}
                  onClick={(e) => { if (!on) void choose(c.pick, e.currentTarget); }}
                >
                  {on ? <CheckIcon className="h-3.5 w-3.5" aria-hidden="true" /> : null}{c.label}
                </button>
              );
            })}
          </div>
          <p className="dev-change-gate-note">{close
            ? t('project:topic.thread.ballot.aboutClose', { project })
            : t('project:topic.thread.ballot.about', { project })}</p>
        </div>
      </div>
      {/* D5: each change folded under the ballot, its section one tap away. */}
      <div className="mt-2 flex flex-col" data-thread-folds={options.length}>
        {options.map((o, i) => (
          <FoldedChange key={o.id} item={o} i={i} view={views[i]} plan={plans?.get(o.id) || null} request={Number(anchor[0])}
            open={open.has(o.id)} onToggle={() => toggle(o.id)} />
        ))}
      </div>
    </div>
  );
}

/** A door asked for one of the ballot's changes: the ballot's Votes card comes into view. */
function useBallotInView(options: ThreadItem[], box: RefObject<HTMLElement | null>): void {
  const ids = options.map((o) => o.id).join(',');
  useEffect(() => {
    let release: (() => void) | null = null;
    const show = () => {
      const card = box.current?.querySelector<HTMLElement>('[data-change-gate="ballot"]') || box.current;
      if (!card) return;
      if (!options.some((o) => takeVotesInView(o.id))) return;
      release?.();
      release = holdVotesInView(card);
    };
    show();
    const off = onVotesAsked(show);
    return () => { off(); release?.(); };
  }, [ids]);
}

/**
 * #6439: a door that sends someone straight to a vote to close opens the
 * request's page at its close card, not at the top (./votes-in-view.ts).
 * The ask is `close:<id>`, a key of its own so it never collides with a
 * change's id.
 */
function useCloseInView(close: ThreadItem, box: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    let release: (() => void) | null = null;
    const show = () => {
      const card = box.current?.querySelector<HTMLElement>('[data-change-gate="close"]') || box.current;
      if (!card) return;
      if (!takeVotesInView(`close:${close.id}`)) return;
      release?.();
      release = holdVotesInView(card);
    };
    show();
    const off = onVotesAsked(show);
    return () => { off(); release?.(); };
  }, [close.id]);
}

/** The newest replies posted on a vote to close, read from its own thread (#6439). */
async function readCloseReplies(slug: string | null, closeId: number): Promise<FoldedReply[]> {
  if (!slug) return [];
  const qs = `thread_type=governance&thread_ref=${encodeURIComponent(String(closeId))}&limit=200`;
  const res = await fetch(`/api/apps/${encodeURIComponent(slug)}/messages?${qs}`, { credentials: 'same-origin' });
  if (!res.ok) return [];
  const data = await res.json();
  const rows = Array.isArray(data && data.messages) ? data.messages : [];
  return rows
    .filter((m: { msg_type?: string; deleted_at?: string | null; content?: string }) => m && m.msg_type === 'message' && !m.deleted_at && m.content)
    .map((m: { id: number; username?: string | null; content: string; is_synthetic?: boolean; created_at?: string | null }) => ({
      id: Number(m.id),
      username: m.username || 'someone',
      bot: !!m.is_synthetic || m.username === 'homeroom_bot',
      text: String(m.content || '').slice(0, 280),
      at: m.created_at || null,
    }));
}

/**
 * A vote to close the request: who proposed it and why, then its Votes card.
 * While it is open the card is the place to vote; once it has ended (#6439)
 * it stays, reading how it ended, with no buttons. Replies people posted on
 * the vote are shown under it, so nothing posted there is lost.
 */
function CloseVote({ slug, close, onChanged }: { slug: string | null; close: ThreadItem; onChanged: () => void }): ReactNode {
  const t = useMessages('project');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [all, setAll] = useState<FoldedReply[] | null>(null);
  const [loadingAll, setLoadingAll] = useState(false);
  const row = useCloseRow(slug, close, revision);
  const box = useRef<HTMLDivElement>(null);
  useCloseInView(close, box);
  const done = close.status !== 'open';
  const vote = async (side: 'up' | 'down', from: HTMLElement | null = null) => {
    const av = appView();
    if (busy || done || !av || typeof av.castIssueVote !== 'function') return;
    // #6098: the same rule as the ballot's: the button keeps focus while the
    // vote is sent, and is found again if a redraw replaced it.
    const wasFocused = !!from && document.activeElement === from;
    setBusy(true);
    try { await av.castIssueVote(close.id, side); } finally {
      setBusy(false);
      setRevision((n) => n + 1);
      onChanged();
      refocusAfterVote(box.current, 'close-vote', from, wasFocused);
    }
  };
  const showAll = async () => {
    if (loadingAll) return;
    setLoadingAll(true);
    try { setAll(await readCloseReplies(slug, close.id)); } finally { setLoadingAll(false); }
  };
  const mine = row ? row.myVote : close.myVote || null;
  const yes = row ? row.yes : 0;
  const need = row ? row.need : 1;
  const folded = close.folded || [];
  const replies = all || folded;
  const more = !all && Number(close.replies) > folded.length;
  // How an ended vote ended (src/services/threads.js `outcome`): closed by
  // the vote, kept open, or ended because the request closed another way.
  const outcome = close.outcome === 'closed'
    ? t('project:topic.thread.close.closedByVote')
    : close.outcome === 'elsewhere'
      ? t('project:topic.thread.close.closedElsewhere')
      : t('project:topic.thread.close.keptOpen');
  return (
    <div ref={box} className="mt-3" data-close-proposal={close.id} data-close-outcome={close.outcome || undefined}>
      <div className={KICKER}>{t('project:topic.thread.close.kicker', { by: close.by || t('project:topic.thread.page.someone') })}</div>
      <p className="mt-0.5 block min-w-0 text-start text-[15px] font-[650] leading-snug text-zinc-900 dark:text-zinc-100">
        {close.reason || close.title || t('project:topic.thread.item.close')}
      </p>
      <div className="dev-change-pair mt-2">
        <div className="dev-change-gate" data-change-gate="close" data-done={done ? 'true' : 'false'} data-tone={done ? 'muted' : mine ? 'muted' : 'ask'} role="group" aria-label={t('project:topic.thread.close.votes')}>
          <div className="dev-change-gate-main">
            <div className="dev-change-gate-head">
              <span className="dev-change-gate-name">{t('project:topic.thread.ballot.votes')}</span>
              <span className="dev-change-gate-figure">{t('project:topic.thread.close.figure', { yes, need })}</span>
            </div>
            <Bar yes={yes} need={need} label={t('project:topic.thread.close.figure', { yes, need })} done={done} />
          </div>
          {done ? null : (
            <div className="dev-change-gate-act">
              {(['up', 'down'] as const).map((side) => {
                const on = mine === (side === 'up' ? 'yes' : 'no');
                return (
                  <button
                    key={side}
                    type="button"
                    className="dev-vote-btn"
                    aria-pressed={on}
                    aria-disabled={busy || undefined}
                    data-close-vote={side}
                    style={on || (!mine && side === 'up') ? { minWidth: 0 } : { minWidth: 0, background: 'var(--state-neutral-bg)', color: 'var(--text-primary)' }}
                    onClick={(e) => { void vote(side, e.currentTarget); }}
                  >
                    {side === 'up' ? <CheckIcon className="h-3.5 w-3.5" aria-hidden="true" /> : <XIcon className="h-3.5 w-3.5" aria-hidden="true" />}
                    {side === 'up' ? t('project:topic.thread.close.yes') : t('project:topic.thread.close.no')}
                  </button>
                );
              })}
            </div>
          )}
          <p className="dev-change-gate-note">
            {done
              ? <><strong>{outcome}</strong>{mine ? ` ${t(mine === 'yes' ? 'project:topic.thread.close.saidYes' : 'project:topic.thread.close.saidNo')}` : null}</>
              : (mine
                ? t(mine === 'yes' ? 'project:topic.thread.close.saidYes' : 'project:topic.thread.close.saidNo')
                : t('project:topic.thread.close.note'))}
          </p>
        </div>
      </div>
      {replies.length ? (
        <div className="flex flex-col gap-1 px-1 pt-2" data-thread-fold={`close:${close.id}`}>
          {replies.map((reply) => (
            <span key={reply.id} className="msgx-thread-line">
              <span className="msgx-thread-face">
                <Avatar shape="square" size="sm" color={swatchFor(reply.username)} aria-hidden="true">
                  {reply.username.charAt(0).toUpperCase()}
                </Avatar>
              </span>
              <strong className="msgx-thread-line-name">{reply.bot ? reply.username : `@${reply.username}`}</strong>
              <span className="msgx-thread-line-text">{reply.text}</span>
            </span>
          ))}
        </div>
      ) : null}
      {more ? (
        <button type="button" className="mt-1 text-[13px] font-semibold text-[color:var(--accent)] hover:underline" data-close-show-all={close.id} aria-disabled={loadingAll || undefined} onClick={() => { void showAll(); }}>
          {t('project:topic.thread.close.showAll')}
        </button>
      ) : null}
    </div>
  );
}

/**
 * #6440: a governance vote's Votes card — the card a change's page has,
 * for a decision. While the vote counts it draws the tally, the votes the
 * rule needs, and Yes and No; once it has ended it says how (passed and
 * applied, rejected, withdrawn, no longer needed) and offers no vote. The
 * `data-close-*` attributes a close vote's card has always carried stay, so
 * the checks on it keep selecting the same things.
 */
export function GovVote({ g }: { g: GovernanceView }): ReactNode {
  const t = useMessages('project');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const av = appView();
  // While the vote is open the tally is the page's own; a vote sent here
  // re-reads it, because the row the page was drawn from is now one behind.
  const [sent, setSent] = useState<GovernanceView['votes'] | null>(null);
  useEffect(() => {
    if (!sent) return undefined;
    const id = Number(g.id);
    if (!id) return undefined;
    let live = true;
    fetch(`/api/apps/${encodeURIComponent(pageSlug() || '')}/governance/${id}`, { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        const p = json && json.proposal;
        if (!live || !p) return;
        setSent({
          yes: Number(p.qualified_yes_count ?? p.up_count) || 0,
          need: Math.max(1, Number(p.approvals_required ?? p.votes_required) || 1),
          mine: p.my_vote === 'up' ? 'yes' : p.my_vote === 'down' ? 'no' : null,
          open: g.votes.open,
          outcome: g.votes.outcome,
        });
      })
      .catch(() => {});
    return () => { live = false; };
  }, [revision]);
  const votes = sent && sent.open === g.votes.open ? sent : g.votes;
  const vote = async (side: 'up' | 'down', from: HTMLElement | null = null) => {
    if (busy || !av || typeof av.castIssueVote !== 'function') return;
    const wasFocused = !!from && document.activeElement === from;
    setBusy(true);
    try { await av.castIssueVote(g.id, side); } finally {
      setBusy(false);
      setRevision((n) => n + 1);
      (window as any).AppView?._renderTopicHead?.();
      refocusAfterVote(box.current, 'close-vote', from, wasFocused);
    }
  };
  const ending = outcomeLine(votes.outcome);
  const open = votes.open;
  const mine = votes.mine;
  const figure = t('project:topic.decision.votes.figure', { yes: votes.yes, need: votes.need });
  return (
    <div ref={box} className="mt-3" data-gov-vote={g.id}>
      <div className="dev-change-pair mt-2">
        <div
          className="dev-change-gate"
          data-change-gate="close"
          data-gov-outcome={votes.outcome}
          data-done={open ? 'false' : 'true'}
          data-tone={open ? (mine ? 'muted' : 'ask') : 'muted'}
          role="group"
          aria-label={t('project:topic.decision.votes.label')}
        >
          <div className="dev-change-gate-main">
            <div className="dev-change-gate-head">
              <span className="dev-change-gate-name">
                {open ? null : <CheckIcon className="dev-change-gate-check" aria-hidden="true" />}
                {t('project:topic.decision.votes.name')}
              </span>
              <span className="dev-change-gate-figure">{figure}</span>
            </div>
            <Bar yes={votes.yes} need={votes.need} label={figure} />
          </div>
          {open ? (
            <div className="dev-change-gate-act">
              {(['up', 'down'] as const).map((side) => {
                const on = mine === (side === 'up' ? 'yes' : 'no');
                return (
                  <button
                    key={side}
                    type="button"
                    className="dev-vote-btn"
                    aria-pressed={on}
                    aria-disabled={busy || undefined}
                    data-close-vote={side}
                    style={on || (!mine && side === 'up') ? { minWidth: 0 } : { minWidth: 0, background: 'var(--state-neutral-bg)', color: 'var(--text-primary)' }}
                    onClick={(e) => { void vote(side, e.currentTarget); }}
                  >
                    {side === 'up' ? <CheckIcon className="h-3.5 w-3.5" aria-hidden="true" /> : <XIcon className="h-3.5 w-3.5" aria-hidden="true" />}
                    {side === 'up' ? t('project:topic.thread.close.yes') : t('project:topic.thread.close.no')}
                  </button>
                );
              })}
            </div>
          ) : null}
          <p className="dev-change-gate-note">
            {!open && votes.outcome === 'applying'
              ? <span className="dc-status-spinner-arc" aria-hidden="true" />
              : null}
            {open
              ? (mine
                ? t(mine === 'yes' ? 'project:topic.thread.close.saidYes' : 'project:topic.thread.close.saidNo')
                : t('project:topic.decision.votes.note', { need: votes.need }))
              : (ending ? translate(ending) : null)}
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * The request's changes and its vote to close, under a rule. The changes
 * that would close THIS request and are up for a vote compete (with the vote
 * to close it, when that is open): one ballot. Every other change (one still
 * being built, one gone live, one that closes another request of the thread
 * or nothing at all) is drawn on its own, with its own cards. Nothing when
 * the thread holds neither.
 */
export function ThreadChanges({ slug, data, number, changes, close, onChanged, plans = null }: {
  slug: string | null;
  data: ThreadPayload;
  /** The request the page is: what its ballot is about. */
  number: number;
  changes: ThreadItem[];
  close: ThreadItem | null;
  onChanged: () => void;
  /** The plan each change was built from, by its id (./request-head.tsx plansByChange). */
  plans?: ReadonlyMap<number, RequestSpecCard> | null;
}): ReactNode {
  const elsewhere = elsewhereFor(data, number);
  if (!changes.length && !close && !elsewhere.length) return null;
  const anchor = [number];
  // Who counts as whose pick is settled inside the ballot, from each change's
  // own read; which changes compete is not, so ask without it.
  const ballot = ballotOf(data, new Set(), anchor);
  const competing = ballot ? new Set(ballot.options.map((o) => o.id)) : new Set<number>();
  const rest = changes.filter((c) => !competing.has(c.id));
  const closeAlone = close && !(ballot && ballot.close && ballot.close.id === close.id) ? close : null;
  return (
    <ThreadRequests.Provider value={Number(data.thread.requests) || 0}>
      <section className="mt-4 border-t border-[color:var(--app-sheet-line)]" data-thread-changes={changes.length}>
        {ballot ? (
          <Competing key={ballot.options.map((o) => o.id).join(',')} slug={slug} data={data} anchor={anchor}
            options={ballot.options} close={ballot.close} onChanged={onChanged} plans={plans} />
        ) : null}
        {rest.map((item) => <Fragment key={item.id}><ChangeBlock item={item} plan={plans?.get(item.id) || null} request={number} /></Fragment>)}
        {closeAlone ? <CloseVote slug={slug} close={closeAlone} onChanged={onChanged} /> : null}
        <Elsewhere list={elsewhere} slug={slug} onChanged={onChanged} />
      </section>
    </ThreadRequests.Provider>
  );
}
