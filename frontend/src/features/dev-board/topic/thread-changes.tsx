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
import { useStoreState } from '../../../lib/use-store-state';
import { govVoteSavedStore } from '../card/cards-store';
import { projectChangesOnGithub } from '../../../lib/change-ref';
import { changeHref } from '../../../lib/change-href';
import { reload as reloadTab } from '../../../lib/tab-build';
import { detailDrawn, detailEntry, markShotsArrival, takeShotsArrival } from '../../ai/detail';
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, EllipsisHorizontalIcon, XIcon } from '@/components/ui/icons';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/ui/feed';
import { Skeleton, SkeletonGroup } from '@/components/ui/skeleton';
import { ActionButton, ChangeTag, VoteButton } from '../card/dev-card';
import type { Standing } from '../../../lib/work-state';
import type { ActionSpec, DevCardModel } from '../card/model';
import { ChangeFoot, ChangeGates, PreviousShotsLine, ShotsCard , headPill, phaseOf } from './change-head';
import { ballotHeadline, fixStanding } from './card-model';
import { StepLayer, ThreadCardContext, ThreadFoot , NoPicture } from './thread-card';
import { closeStep, openStep, publishLead, useOpenStep } from './step-store';
import { dotLine } from './topic-page';
import { changeDetailAsk, mergeChangePatch } from './change-detail-refresh';
import type { ChangeThreadView, TopicBody } from './model';
import { ChangeSheets, readChangeDetail } from './topic-head';
import { outcomeLine, type GovernanceView } from './governance-model';
import { RequestWords, sentences } from './request-head';
import { openRequestSpec, type RequestSpecCard } from './request-model';
import { holdVotesInView, onVotesAsked, takeVotesInView } from './votes-in-view';
import { openShotsDetail } from './shots-detail';
import { pageSlug } from './thread-items';
import { useThreadMenu } from './thread-menu';
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
 * a redraw that replaced the node is found again by the key it carries,
 * `data-ballot-option`.
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
 * #6599: a built draft of yours goes up for a vote from its own card. Before
 * this the only door was the old session view's Submit for review, and the
 * card said its votes open once it is put up without offering a way to do
 * it. Who may: its author, signed in on a screen that is not read-only — the
 * promote route loads the session by `user_id`, so an admin who is not its
 * author would only be refused. A draft still being built or checked has
 * nothing to put up. One whose checks failed may go up, as the promote route
 * allows: it merges only once they pass, and the line under the button says
 * so (`item.promotable`, services/threads.js).
 */
function canPropose(item: ThreadItem): boolean {
  if (item.state !== 'underway' || !(item.promotable ?? item.ready) || !item.mine) return false;
  if (typeof window === 'undefined') return false;
  const w = window as any;
  return !!w.App?.user && !w.App.user.isSynthetic && !w.AppView?.readOnly;
}

/**
 * What Homeroom said when it refused, in its own words: `proposal_not_ready`
 * carries a sentence in `message`, and other refusals put one in `error`.
 * A code such as `session_state_changed` is nothing to a reader, so it falls
 * back to the card's own sentence.
 */
function proposeRefusal(body: any): string {
  const message = body && typeof body.message === 'string' ? body.message.trim() : '';
  if (message) return message;
  const error = body && typeof body.error === 'string' ? body.error : '';
  if (/\s/.test(error)) return error;
  return translate('project:topic.thread.page.proposeFailed');
}

/**
 * The one call the old view's Submit for review made (POST
 * /api/sessions/:id/promote), resolving to the sentence to show when it
 * refused and to null when the change went up. It went up: the change's own
 * read is asked again, so its section becomes its vote card.
 */
export async function proposeChange(id: number): Promise<string | null> {
  let body: any = null;
  try {
    const res = await fetch(`/api/sessions/${id}/promote`, { method: 'POST', credentials: 'same-origin' });
    body = await res.json().catch(() => null);
    if (!res.ok || (body && body.ok === false)) return proposeRefusal(body);
  } catch {
    return translate('project:topic.thread.page.proposeFailed');
  }
  if (typeof window === 'undefined') return null;
  window.dispatchEvent(new CustomEvent('change-detail-refresh', { detail: Number(id) }));
  return null;
}

interface ProposeState {
  /** The card may put its change up for a vote, and the ⋯ offers it. */
  can: boolean;
  busy: boolean;
  /** Homeroom's sentence when it refused, or the card's own. */
  error: string | null;
  propose: () => void;
}

/** A line drawn without its card (`ChangeLine` on its own): nothing to put up. */
const NO_PROPOSE: ProposeState = Object.freeze({ can: false, busy: false, error: null, propose: () => {} });

/**
 * #6599: `busy` stays true once it went up, until the change leaves
 * `underway`, so the label never flashes back to Put it up for a vote while
 * the thread re-reads. `onDone` is the thread's own immediate re-read; the
 * card's own instance passes none, and the `change-detail-refresh` that
 * `proposeChange` dispatches makes the request's page re-read it too.
 */
function useProposeChange(item: ThreadItem, onDone?: () => void): ProposeState {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const can = canPropose(item);
  const propose = () => {
    if (busy || !can) return;
    setBusy(true);
    setError(null);
    void proposeChange(item.id).then((refusal) => {
      if (refusal) {
        setError(refusal);
        setBusy(false);
        return;
      }
      onDone?.();
    });
  };
  useEffect(() => {
    if (item.state === 'underway') return;
    setBusy(false);
    setError(null);
  }, [item.state]);
  return { can, busy, error, propose };
}

/**
 * Each change's own page read, and the view its page builds from it, in the
 * order given. Null until it is read. One hook for the list, so the count of
 * changes can move without moving the hooks. 1 Nov 2026: a change still
 * being built is read too, for its ⋯ (its page's rows); it draws its cards
 * once it is up for a vote.
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

/** What a change's own page counts toward its rule, and needs. */
function tally(row: any): { yes: number; need: number } {
  const yes = Number(row?.qualified_yes_count ?? row?.yes_count) || 0;
  const need = Math.max(1, Number(row?.votes_required) || 1);
  return { yes, need };
}

export const letterOf = (i: number) => String.fromCharCode(65 + i);

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
 * opens as any `data-card-menu` disc. #6599: a built draft of the viewer's
 * gets Put it up for a vote among them too, the same call its card's button
 * makes.
 */
function ChangeMenu({ item, view, propose }: { item: ThreadItem; view: ChangeView | null; propose: ProposeState }): ReactNode {
  const t = useMessages('project');
  const key = view?.card.rail?.menuKey || '';
  useThreadMenu(propose.can ? key : null, 'propose', propose.can
    ? [{ label: t('project:topic.thread.page.proposeAction'), icon: 'default', act: propose.propose }]
    : []);
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
export function ChangeLine({ item, view, propose = NO_PROPOSE, letter = null, footed = false, sole = false }: {
  item: ThreadItem; view: ChangeView | null; propose?: ProposeState; letter?: string | null;
  /** The card look, with the change's foot under it: the foot says where it stands, so no pill here. */
  footed?: boolean;
  /** The request's one change: the card's own title and summary speak for it, so no second title. */
  sole?: boolean;
}): ReactNode {
  const t = useMessages('project');
  const kicker = useKicker(item, letter);
  const status = view?.v.status || null;
  // The pill is the change's stored row's words while that row is not up
  // for a vote ("Taking screenshots", never "Vote · 0/2"), as the change's
  // own page draws it (./change-head.tsx headPill, AppView._workPill).
  const pill = view ? headPill(view.v) : null;
  // #6233: the change is live in the app, but this tab runs the version
  // before it: say so and offer the same reload the side menu does.
  const behind = !!status && (status.key === 'deployed_reload' || status.key === 'merged_reload');
  return (
    <div className="min-w-0" data-thread-change-line={item.id}>
      <div className="flex min-w-0 items-center gap-2">
        <div className={`${KICKER} min-w-0 flex-1 truncate`}>{kicker}</div>
        {status && pill && !footed ? <span className="shrink-0" data-thread-change-status={status.key}><ChangeTag s={pill} /></span> : null}
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
        <ChangeMenu item={item} view={view} propose={propose} />
      </div>
      <h3 className={sole ? 'sr-only' : 'mt-0.5 min-w-0 text-[15px] font-[650] leading-snug text-zinc-900 dark:text-zinc-100'} data-thread-change-title={item.id}>
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
 * Expand: the one before & after viewer (review-flow/shots-viewer.tsx)
 * opens in the detail column beside the thread (#6230).
 *
 * #6315: the column is drawn by every page that has one (a request's, the
 * Workshop's panel, the general chat), and by the bot page. Where a surface
 * has none — Expand pressed on a page that hosts no detail — the person is
 * sent to the change's page instead, and the arrival below opens the before
 * and after as soon as the change is drawn. A restored address (a reload
 * while the before and after were open) has a shots entry with no shots:
 * this page carries them, so the effect fills them in rather than leaving
 * "Loading…".
 */
function ShotsPair({ id, number, s }: {
  id: number; number: number | null; s: NonNullable<ChangeThreadView['shots']>;
}): ReactNode {
  const t = useMessages('project');
  const thumbs = s.state === 'verified' ? s.thumbs : null;
  const source = s.source || null;
  const open = () => { if (source) openShotsDetail(source); };
  useEffect(() => {
    if (!thumbs || !source) return;
    const entry = detailEntry();
    // A reload's restored entry: the same change, no shots yet.
    if (entry && entry.kind === 'shots' && entry.ref.changeId === id && !entry.payload?.shots) open();
    else if (takeShotsArrival(id)) open();
    // `open` is rebuilt with `source`, which is the dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, source, thumbs]);
  if (!thumbs || !source) return null;
  // #6230: Expand opens the change's before and after in the detail column
  // beside the thread, as a design's preview and a plan do, instead of in a
  // popover over the page.
  const expand = () => {
    open();
    // #6315: two frames for the column to open where this page has one; if
    // nothing drew it, go to the change's page, where the arrival opens it.
    const slug = pageSlug();
    const target = number && slug ? changeHref(slug, id, number).replace(/^#/, '') : '';
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
      {/* The previous version's pair, while this version's are taken. */}
      {s.previous ? <PreviousShotsLine s={s} /> : null}
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
      // A lone change under the card look votes from its foot; its Votes
      // card is in the layer (./thread-card.tsx), put away until opened.
      const card = el ? (el.querySelector<HTMLElement>('.dev-thread-foot') || el.querySelector<HTMLElement>(target) || el) : null;
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
 * #6605: a change that is not live yet and closes only requests that are
 * already closed says so under its title, so it does not read as that
 * request's open work. The numbers link to their pages.
 */
function AlreadyClosed({ item }: { item: ThreadItem }): ReactNode {
  const t = useMessages('project');
  const list = Array.isArray(item.closesRequests) ? item.closesRequests : [];
  if (!list.length) return null;
  if (item.state === 'merged' || item.status === 'merging' || item.status === 'merged') return null;
  if (!list.every((r) => r.closed === true)) return null;
  const slug = appView()?.appData?.slug || '';
  const numbers = list.map((r) => Number(r.number)).filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b);
  if (!numbers.length) return null;
  const linkClass = 'font-semibold text-violet-700 hover:underline dark:text-violet-300';
  const parts: ReactNode[] = numbers.map((n) => (
    <a
      key={`c${n}`}
      href={slug ? `#app/${encodeURIComponent(slug)}/dev/issues/${n}` : `#${n}`}
      className={linkClass}
      data-thread-change-closed-on={n}
    >
      {`#${n}`}
    </a>
  ));
  const locale = i18n.language || 'en';
  return (
    <p className="mt-1 text-[13px] text-zinc-500 dark:text-zinc-400" data-thread-change-closed={item.id}>
      <RichMessage
        id="project:topic.thread.page.alreadyClosed"
        values={{ count: numbers.length, numbers: numberText(numbers, locale) }}
        components={[<Joined key="closed" parts={joinParts(parts, locale)} />]}
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
        {/* #6604: the summary's lines, a before/after pair and the two cards
            below them, at the size they are once loaded, so the page does not
            change height as they fill in. */}
        <div className="mt-2 flex flex-col gap-1.5">
          <Skeleton className="h-2.5 w-full" />
          <Skeleton className="h-2.5 w-11/12" />
          <Skeleton className="h-2.5 w-3/5" />
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <Skeleton shape="block" className="h-24 rounded-xl" />
          <Skeleton shape="block" className="h-24 rounded-xl" />
        </div>
        <ChangeGatesSkeleton />
      </SkeletonGroup>
    </section>
  );
}

/** The Votes and Testing cards' place, until the change's own read lands. */
function ChangeGatesSkeleton(): ReactNode {
  return (
    <div className="dev-change-pair">
      <Skeleton shape="block" className="h-20 rounded-2xl" />
      <Skeleton shape="block" className="h-20 rounded-2xl" />
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
/** Two facts about a competing change, under its summary: how its tests went and how many said yes. */
function LookFacts({ v }: { v: ChangeThreadView }): ReactNode {
  const t = useMessages('project');
  const yes = Number(v.status?.yes) || 0;
  const tests = v.testing;
  return (
    <p className="dev-thread-facts" data-thread-look-facts="">
      {tests.tone === 'bad' ? (
        <span className="dev-thread-fact" data-tone="bad"><XIcon className="h-3.5 w-3.5" aria-hidden="true" />{tests.figure || tests.name}</span>
      ) : tests.done ? (
        <span className="dev-thread-fact" data-tone="ok"><CheckIcon className="h-3.5 w-3.5" aria-hidden="true" />{t('project:topic.rail.tested')}</span>
      ) : (
        <span className="dev-thread-fact">{tests.figure ? `${tests.name} · ${tests.figure}` : tests.name}</span>
      )}
      <span className="dev-thread-fact">{t('project:topic.card.look.yes', { count: yes })}</span>
    </p>
  );
}

function ChangeBody({ item, view, plan = null, ballot = false, request, tail = null, covered = false, look = false, row = null }: {
  /** Opened from its row in a ballot (the card look's Look): its summary, two facts and its picture. */
  look?: boolean;
  /** The request's own stored row, for the foot of its one change (./change-head.tsx ChangeFoot). */
  row?: Standing | null;
  item: ThreadItem; view: ChangeView | null; plan?: RequestSpecCard | null; ballot?: boolean; request: number;
  /** The card's summary already speaks for this change (the request's one change): its own is left out. */
  covered?: boolean;
  /** A quiet row at the end of the change's foot (./change-head.tsx ChangeFoot). */
  tail?: ReactNode;
}): ReactNode {
  const t = useMessages('project');
  const propose = useProposeChange(item);
  const summary = covered ? '' : view?.body.summaryHtml || '';
  const threadRequests = useContext(ThreadRequests);
  const thread = useContext(ThreadCardContext);
  const lone = thread.card && !ballot;
  return (
    <>
      <AlreadyClosed item={item} />
      <AlsoCloses item={item} request={request} />
      <ClosesOf item={item} requests={threadRequests} />
      {summary ? <div className="dev-thread-change-summary" data-thread-change-summary={item.id}><RequestWords html={summary} /></div> : null}
      {view?.body.summaryStale && summary
        ? <p className="dev-change-stale" role="note" data-thread-change-stale={item.id}>{t('project:topic.change.summaryStale')}</p>
        : null}
      {look && view ? <LookFacts v={view.v} /> : null}
      {/* Under the card look the plan is the timeline's Planned step. */}
      {plan && !thread.card ? <PlanLine plan={plan} builtFrom={item.builtFrom} /> : null}
      {/* Under the card look the picture is the card's one picture, with the
          Before and After switch on it, as a change's own page draws it. */}
      {view?.v.shots ? (thread.card
        ? <ShotsCard s={view.v.shots} single status={view.v.status?.key || null} />
        : <ShotsPair id={item.id} number={item.number ?? null} s={view.v.shots} />)
        : lone && view && item.state !== 'underway' && hasCards(item)
          ? <NoPicture none={!!view.v.shotsNone} phase={phaseOf(view.v)} stopped={fixStanding(view.v.testing) === 'stopped'} diagram={view.body.diagram} /> : null}
      {/* On its own under the request's card, its foot says where it stands;
          the pair below is then the content of the layer the timeline's
          steps open (change-head.tsx ChangeGates). */}
      {lone && view && item.state !== 'underway' && hasCards(item)
        ? <ChangeFoot id={item.id} card={view.card} v={view.v} page={thread.page} tail={tail} row={row} /> : null}
      {item.state === 'underway' || !hasCards(item) ? (
        propose.can ? (
          // #6599: its one action, where the Votes card will appear, with the
          // shorter line under it; a refusal keeps its sentence here too.
          <div className="mt-2" data-thread-change-propose={item.id}>
            <button
              type="button"
              className="dev-vote-btn"
              disabled={propose.busy}
              aria-busy={propose.busy || undefined}
              onClick={() => propose.propose()}
            >
              {t(propose.busy ? 'project:topic.thread.page.proposing' : 'project:topic.thread.page.proposeAction')}
            </button>
            <p className="mt-1 text-[13px] text-zinc-500 dark:text-zinc-400" data-thread-change-waiting={item.ready ? 'ready' : 'failing'}>
              {t(item.ready ? 'project:topic.thread.page.readyMine' : 'project:topic.thread.page.failingMine')}
            </p>
            {propose.error ? (
              <p className="mt-1 text-[13px] text-[color:var(--state-blocked)]" role="alert" data-thread-change-propose-error>
                {propose.error}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="mt-1 text-[13px] text-zinc-500 dark:text-zinc-400" data-thread-change-waiting={item.ready ? 'ready' : 'building'}>
            {t(item.ready ? 'project:topic.thread.page.ready' : 'project:topic.thread.page.underway')}
          </p>
        )
      ) : look ? null : view ? (
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
function ChangeBlock({ item, plan = null, request, onChanged, sole = false }: {
  item: ThreadItem; plan?: RequestSpecCard | null; request: number; onChanged?: () => void;
  /** The request's one change (./thread-changes.tsx ThreadChanges). */
  sole?: boolean;
}): ReactNode {
  const [view] = useChangeViews([item]);
  const box = useRef<HTMLDivElement>(null);
  const propose = useProposeChange(item, onChanged);
  const thread = useContext(ThreadCardContext);
  useInView(item.id, !!view || item.state === 'underway', box);
  // Under the card look a change that is past being built has a foot, which
  // says where it stands and holds what there is to press.
  const footed = thread.card && !!view && item.state !== 'underway' && hasCards(item);
  // The request's one change tells the request's timeline where it stands
  // (./step-store.ts leadStore), so the timeline ends on this foot's phase.
  const leads = footed && sole;
  // As text, so a re-read that changes nothing publishes nothing: the view
  // is a new object on every render, and the request's head re-renders on
  // each publish.
  const leadText = leads && view ? JSON.stringify({
    id: item.id,
    author: item.by || view.v.author || null,
    at: item.at || view.v.at || null,
    plan: null,
    status: view.v.status ? { key: view.v.status.key, label: view.v.status.label, yes: view.v.status.yes, majority: view.v.status.majority } : null,
    votes: view.v.votes || null,
    testing: view.v.testing || null,
    merge: view.v.merge || null,
    fixNote: view.v.testing?.authorNote || null,
    liveAt: view.v.liveAt || item.liveAt || null,
    // T2.3: the change's stored row, so the request's timeline ends on the
    // words the change's foot says, never "Up for a vote" while it is not.
    work: view.v.work || null,
    // #7117 discussion: the change's updates, so the request's timeline
    // shows them too.
    updates: view.v.updates || null,
  }) : '';
  useEffect(() => { publishLead(thread.page, leadText ? JSON.parse(leadText) : null); }, [leadText, thread.page]);
  useEffect(() => () => publishLead(thread.page, null), [thread.page]);
  // 1 Nov 2026: ask about it, or sketch a revision, privately. #6392: the
  // words say so, and the bot building or fixing it leaves this out.
  const workWithBot = (
    <WorkWithBotButton
      slug={pageSlug()}
      number={item.number}
      voting={!!view?.v.votes.facts?.length}
      botAtWork={changeBotAtWork(item, view)}
    />
  );
  return (
    <div ref={box} className="mt-3" data-thread-change={item.id} data-thread-change-state={item.state || ''}>
      <ChangeLine item={item} view={view} propose={propose} footed={footed} sole={thread.card && sole} />
      {/* The request's one change: its foot says where the REQUEST stands
          (the request's own row), as the timeline's last step does. */}
      <ChangeBody item={item} view={view} plan={plan} request={request} tail={footed ? workWithBot : null} covered={thread.card && sole && !!thread.covers} row={sole ? thread.row || null : null} />
      {footed ? null : workWithBot}
    </div>
  );
}

/**
 * D5: a competing change, folded under the ballot: its line, which opens
 * the rest of its section. `open` is the ballot's, so a tap on the change's
 * row in the ballot opens it too.
 */
export function FoldedChange({ item, i, view, plan, request, open, onToggle, onChanged }: {
  item: ThreadItem; i: number; view: ChangeView | null; plan: RequestSpecCard | null; request: number; open: boolean; onToggle: () => void;
  onChanged?: () => void;
}): ReactNode {
  const t = useMessages('project');
  const kicker = useKicker(item, letterOf(i));
  const status = view?.v.status || null;
  // The row's words while it is not up for a vote, as ChangeLine draws it.
  const pill = view ? headPill(view.v) : null;
  const propose = useProposeChange(item, onChanged);
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
        {status && pill ? <span className="shrink-0" data-thread-change-status={status.key}><ChangeTag s={pill} /></span> : null}
        <ChangeMenu item={item} view={view} propose={propose} />
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
  async function answer(e: ThreadElsewhere, action: 'not-closing' | 'confirm-closing') {
    if (sending != null || !current) return;
    setSending(e.id);
    setFailed(null);
    try {
      const res = await fetch(
        `/api/apps/${encodeURIComponent(current)}/issues/${e.request}/changes/${e.id}/${action}`,
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
            {e.closed ? (
              <p className="mt-1 text-[13px] text-zinc-500 dark:text-zinc-400" data-thread-elsewhere-closed={e.id}>
                {t('project:topic.thread.page.claimClosed', { number: e.request })}
              </p>
            ) : null}
            {e.stays ? (
              <p className="mt-1 text-[13px] text-zinc-500 dark:text-zinc-400" data-thread-elsewhere-stays={e.id}>
                {t('project:topic.thread.page.claimStays', { on: e.on })}
              </p>
            ) : null}
            {e.ask ? (
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="pillAccent"
                  size="sm"
                  disabled={sending === e.id}
                  data-thread-elsewhere-confirm={e.id}
                  onClick={() => void answer(e, 'confirm-closing')}
                >
                  {t('project:topic.thread.page.claimConfirm')}
                </Button>
                <Button
                  type="button"
                  variant="pillNeutral"
                  size="sm"
                  ink="neutral"
                  disabled={sending === e.id}
                  data-thread-elsewhere-dispute={e.id}
                  onClick={() => void answer(e, 'not-closing')}
                >
                  {t('project:topic.thread.page.claimDispute')}
                </Button>
              </div>
            ) : null}
            {e.confirmed && e.mine ? (
              <p className="mt-2.5 text-[13px] text-zinc-500 dark:text-zinc-400" data-thread-elsewhere-confirmed={e.id}>
                {t('project:topic.thread.page.claimConfirmed')}
              </p>
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
/**
 * The card look's row for a competing change: its picture (the After shot,
 * or its letter until there is one), its letter and name, who built it, what
 * its tests say and its yes votes, and Look. The whole row opens the change
 * over the card (LookedChange).
 */
function OptionRow({ item, i, view, yes, on, onLook }: {
  item: ThreadItem; i: number; view: ChangeView | null; yes: number; on: boolean; onLook: () => void;
}): ReactNode {
  const t = useMessages('project');
  const letter = letterOf(i);
  const shots = view?.v.shots && view.v.shots.state === 'verified' ? view.v.shots.thumbs : null;
  const pic = shots ? (shots.after || shots.before || null) : null;
  const testing = view ? view.v.testing : null;
  const bad = !!testing && testing.tone === 'bad';
  return (
    <button
      type="button"
      role="listitem"
      className="dev-thread-opt"
      data-change-row={letter}
      data-thread-change-row={item.id}
      data-change-row-open={item.id}
      aria-expanded={on}
      onClick={onLook}
    >
      <span className="dev-thread-opt-pic" aria-hidden="true">
        {pic ? <img src={pic} alt="" loading="lazy" decoding="async" /> : letter}
      </span>
      <span className="dev-thread-opt-main">
        <span className="dev-thread-opt-name">{t('project:topic.card.opt.name', { letter, title: item.title || t('project:topic.thread.item.changeUnnumbered') })}</span>
        {/* Who built it, what its tests say, its yes votes; failed tests are
            said on a line of their own, in the colour that means stopped. */}
        <span className="dev-thread-opt-line" data-thread-change-testing={testing ? testing.tone : undefined}>
          {dotLine([
            item.by ? t('project:topic.card.opt.by', { name: item.by }) : null,
            testing && !bad ? testing.figure : null,
            t('project:topic.card.opt.yes', { count: yes }),
          ])}
        </span>
        {testing && bad ? <span className="dev-thread-opt-line"><span data-opt-tests="bad">{testing.figure}</span></span> : null}
      </span>
      <span className="dev-thread-opt-look">
        {t('project:topic.card.opt.look')}
        <ChevronRightIcon className="h-4 w-4 rtl:-scale-x-100" aria-hidden="true" />
      </span>
    </button>
  );
}

/**
 * A competing change, opened over the request's card from its row or from
 * its step in the timeline: its status and its ⋯, then the section its fold
 * held (its summary, its picture, its tests). It is voted on in the ballot,
 * the card's foot, so there is nothing to vote with here.
 */
function LookedChange({ item, i, view, plan, request, open, onChanged }: {
  item: ThreadItem; i: number; view: ChangeView | null; plan: RequestSpecCard | null; request: number; open: boolean;
  onChanged?: () => void;
}): ReactNode {
  const kicker = useKicker(item, letterOf(i));
  const propose = useProposeChange(item, onChanged);
  return (
    <div data-thread-change={item.id} data-thread-change-state={item.state || ''} data-thread-look={item.id} data-thread-fold={open ? 'open' : 'shut'}>
      {/* What it is and what it does, two facts, then its picture: it is
          voted on with the card's one Vote button, so no Votes card and no
          status pill stand here (17 Nov 2026). */}
      <div className="flex min-w-0 items-center gap-2" data-thread-change-line={item.id}>
        <span className={`${KICKER} min-w-0 flex-1 truncate`}>{kicker}</span>
        <ChangeMenu item={item} view={view} propose={propose} />
      </div>
      {open ? <ChangeBody item={item} view={view} plan={plan} ballot look request={request} /> : null}
    </div>
  );
}

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
  /** The No votes, for the picker's No side. */
  no: number;
  need: number;
  myVote: 'yes' | 'no' | null;
  /** The revision this read was asked for (#6990: a vote's re-read settles its applied value). */
  at: number;
}

/** A vote to close's own read (routes/issues.js GET governance/:id): its tally and the viewer's vote. */
function useCloseRow(slug: string | null, close: ThreadItem | null, revision: number): CloseRow | null {
  const [row, setRow] = useState<CloseRow | null>(null);
  useEffect(() => {
    if (!slug || !close) { setRow(null); return undefined; }
    let live = true;
    // #6990: a re-read after a vote asks for the CURRENT answer, not the
    // worker's saved copy from before it.
    fetch(`/api/apps/${encodeURIComponent(slug)}/governance/${close.id}`, { credentials: 'same-origin', cache: 'no-cache' })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        const p = json && json.proposal;
        if (!live || !p) return;
        setRow({
          yes: Number(p.qualified_yes_count ?? p.up_count) || 0,
          no: Number(p.qualified_no_count ?? p.down_count) || 0,
          need: Math.max(1, Number(p.votes_required) || 1),
          myVote: p.my_vote === 'up' ? 'yes' : p.my_vote === 'down' ? 'no' : null,
          at: revision,
        });
      })
      .catch(() => {});
    return () => { live = false; };
  }, [slug, close?.id, revision]);
  return row;
}

/** What a saved vote (#6990) asks a Votes card to show before its re-read lands. */
export interface AppliedVote {
  mine: 'yes' | 'no' | null;
  yes: number;
}

/**
 * #6990: a Votes card's own tally with the vote `castIssueVote` just saved
 * applied to it. `yes` moves by one only when the viewer's side changes —
 * +1 going to yes, −1 leaving yes — and stays inside 0..need, so a "need of
 * 1" never reads 2 of 1. A null `vote` (the server toggled the same side
 * off) clears `mine` and takes back the yes it was counting.
 */
export function applyVote(
  yes: number,
  mine: 'yes' | 'no' | null,
  need: number,
  vote: 'yes' | 'no' | null,
): AppliedVote {
  const cap = Math.max(1, Number(need) || 1);
  const from = Math.max(0, Math.min(cap, Number(yes) || 0));
  if (vote === null) return { mine: null, yes: mine === 'yes' ? Math.max(0, from - 1) : from };
  let next = from;
  if (vote === 'yes' && mine !== 'yes') next = Math.min(cap, from + 1);
  else if (vote === 'no' && mine === 'yes') next = Math.max(0, from - 1);
  return { mine: vote, yes: next };
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
  const thread = useContext(ThreadCardContext);
  // The card look's foot asks "Which one should go live?" after Vote is pressed.
  const [asking, setAsking] = useState(false);
  // A door to one of these changes (./votes-in-view.ts) lands on the ballot,
  // where it is voted on.
  useBallotInView(options, box);
  const ballot: Ballot | null = ballotOf(data, anchor);
  if (!ballot) return null;
  const toggle = (id: number) => setOpen((was) => {
    const next = new Set(was);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  // The card look opens a change over the card (./step-store.ts), from its
  // row here or from its step in the timeline.
  const openNow = useOpenStep(thread.page);
  const looked = thread.card && openNow?.kind === 'change' ? openNow.changeId : null;
  const reveal = (id: number) => {
    if (thread.card) {
      if (looked !== id) openStep(thread.page, { kind: 'change', changeId: id });
      return;
    }
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
      for (const v of ballotVotes(ballot, pick)) {
        if (v.kind === 'close') await av.castIssueVote?.(v.issueId, 'up', { reason: null });
        else if (v.vote === null) await av.retractVote?.(v.sessionId, v.epoch);
        else await av.castVote?.(v.sessionId, v.vote, v.epoch, { reason: null });
      }
    } finally {
      setBusy(false);
      setAsking(false);
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
      {thread.card ? (
        // The card look: a row per change, its picture first, and Look.
        <div className="dev-thread-opts" role="list" aria-label={heading} data-thread-opts={options.length}>
          {options.map((o, i) => (
            <OptionRow key={o.id} item={o} i={i} view={views[i]} yes={tally(views[i]?.row).yes} on={looked === o.id}
              onLook={() => openStep(thread.page, { kind: 'change', changeId: o.id })} />
          ))}
        </div>
      ) : <div className={KICKER}>{heading}</div>}
      <div className={thread.card && !close ? 'hidden' : 'mt-2 overflow-hidden rounded-2xl bg-[color:var(--messages-surface)]'} role="list" aria-label={t('project:topic.thread.ballot.label')}>
        {thread.card ? null : options.map((o, i) => <CompetingRow key={o.id} item={o} i={i} view={views[i]} plan={plans?.get(o.id) || null} onOpen={() => reveal(o.id)} />)}
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
      {thread.card ? (
        // The card look: the ballot is the card's foot. It says who leads,
        // and one Vote button asks the question after the press.
        <div data-change-gate="ballot" data-done="false" data-tone={ballot.pick === null ? 'ask' : 'muted'} role="group" aria-label={t('project:topic.thread.ballot.label')}>
          <ThreadFoot
            what="ballot"
            headline={ballotHeadline(choices.slice(0, options.length), (id, values) => t(id, values))}
            // The counts and the viewer's own line. The rule (the first to
            // pass goes live, the others close) is the note under the
            // timeline's current step (./rail-model.ts nowStep).
            sub={dotLine([
              ...choices.map((c) => t('project:topic.card.ballot.count', { choice: c.label, yes: c.yes })),
              ballot.pick === null ? t('project:topic.card.ballot.notVoted') : t('project:topic.thread.ballot.picked'),
            ])}
            extra={asking ? (
              <div className="dev-thread-foot-ask" role="radiogroup" aria-label={t('project:topic.thread.ballot.label')}>
                <p className="dev-thread-foot-q">{t('project:topic.card.ballot.which')}</p>
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
                      style={on ? { minWidth: 0 } : { minWidth: 0, background: 'var(--state-neutral-bg)', color: 'var(--text-primary)', boxShadow: 'none' }}
                      onClick={(e) => { if (on) setAsking(false); else void choose(c.pick, e.currentTarget); }}
                    >
                      {on ? <CheckIcon className="h-3.5 w-3.5" aria-hidden="true" /> : null}{c.label}
                    </button>
                  );
                })}
                <button type="button" className="dev-change-gate-link" data-ballot-cancel="" onClick={() => setAsking(false)}>
                  {t('project:topic.card.ballot.cancel')}
                </button>
              </div>
            ) : null}
          >
            {asking ? null : ballot.pick === null ? (
              <button type="button" className="dev-vote-btn" data-ballot-vote="" onClick={() => setAsking(true)}>
                {t('project:topic.card.ballot.vote')}
              </button>
            ) : (
              <button type="button" className="dev-change-gate-link" data-ballot-vote="change" onClick={() => setAsking(true)}>
                {t('project:topic.card.ballot.change')}
              </button>
            )}
          </ThreadFoot>
        </div>
      ) : (
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
                  style={on ? { minWidth: 0 } : { minWidth: 0, background: 'var(--state-neutral-bg)', color: 'var(--text-primary)', boxShadow: 'none' }}
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
      )}
      {thread.card ? (
        // The card look: nothing under the foot. Each change opens over the
        // card, kept in the page while shut so a door to it still finds it.
        options.map((o, i) => (
          <StepLayer
            key={o.id}
            keep
            open={looked === o.id}
            name="look"
            title={t('project:topic.card.opt.name', { letter: letterOf(i), title: o.title || t('project:topic.thread.item.changeUnnumbered') })}
            sub={t('project:topic.card.opt.lookSub', {
              who: o.number ? t(projectChangesOnGithub() ? 'project:topic.thread.page.rowByPr' : 'project:topic.thread.page.rowBy', { by: o.by || t('project:topic.thread.page.someone'), number: o.number }) : (o.by || t('project:topic.thread.page.someone')),
              count: options.length,
            })}
            onClose={closeStep}
          >
            <LookedChange item={o} i={i} view={views[i]} plan={plans?.get(o.id) || null} request={Number(anchor[0])} open={looked === o.id} onChanged={onChanged} />
          </StepLayer>
        ))
      ) : (
      /* D5: each change folded under the ballot, its section one tap away. */
      <div className="mt-2 flex flex-col" data-thread-folds={options.length}>
        {options.map((o, i) => (
          <FoldedChange key={o.id} item={o} i={i} view={views[i]} plan={plans?.get(o.id) || null} request={Number(anchor[0])}
            open={open.has(o.id)} onToggle={() => toggle(o.id)} onChanged={onChanged} />
        ))}
      </div>
      )}
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
 * A decision's Yes and No as the one vote control takes them: the Vote the
 * change page's bar draws (../card/dev-card.tsx VoteButton), which opens the
 * same "Your vote" picker it opens everywhere and sends the line written in
 * it with `castIssueVote`. The tallies are the card's own counts.
 */
export function decisionVoteSpecs(id: number, votes: { yes: number; no?: number | null; mine: 'yes' | 'no' | null }): { yes: ActionSpec; no: ActionSpec } {
  const av = appView();
  const solo = av && typeof av._voteSolo === 'function' ? av._voteSolo() : {};
  return {
    yes: {
      key: 'yes',
      label: '',
      cls: `gc-vote-btn gc-vote-btn-yes${votes.mine === 'yes' ? ' gc-vote-active' : ''}`,
      tally: String(Math.max(0, Number(votes.yes) || 0)),
      act: { fn: 'castIssueVote', args: [id, 'up'] },
      ...solo,
    },
    no: {
      key: 'no',
      label: '',
      cls: `gc-vote-btn gc-vote-btn-no${votes.mine === 'no' ? ' gc-vote-active' : ''}`,
      tally: votes.no == null ? '' : String(Math.max(0, Number(votes.no) || 0)),
      act: { fn: 'castIssueVote', args: [id, 'down'] },
    },
  };
}

/**
 * #6990: the vote the server saved on decision `id` (`castIssueVote`
 * publishes it, ../card/cards-store.ts govVoteSavedStore), heard once each
 * time it moves, so the card that cast it shows it at once and reads again.
 */
function useDecisionVoteSaved(id: number, onSaved: (vote: 'yes' | 'no' | null) => void): void {
  const saved = useStoreState(govVoteSavedStore)[String(id)] || null;
  const seq = saved ? saved.seq : 0;
  const seen = useRef(seq);
  const latest = useRef(onSaved);
  latest.current = onSaved;
  useEffect(() => {
    if (seq === seen.current) return;
    seen.current = seq;
    latest.current(saved ? saved.vote : null);
  }, [seq]);
}

/**
 * A vote to close the request: who proposed it and why, then the bar a
 * change's page ends with (./thread-card.tsx ThreadFoot): where the vote
 * stands, and its one Vote. While it is open that Vote is the place to vote;
 * once it has ended (#6439) the bar stays, reading how it ended, with no
 * Vote. Replies people posted on the vote are shown under it, so nothing
 * posted there is lost.
 */
function CloseVote({ slug, close, onChanged }: { slug: string | null; close: ThreadItem; onChanged: () => void }): ReactNode {
  const t = useMessages('project');
  const [revision, setRevision] = useState(0);
  const [all, setAll] = useState<FoldedReply[] | null>(null);
  const [loadingAll, setLoadingAll] = useState(false);
  // #6990: the vote just saved, shown until the re-read below replaces it.
  const [applied, setApplied] = useState<AppliedVote | null>(null);
  const row = useCloseRow(slug, close, revision);
  // The revision the vote's own re-read will answer at; `applied` holds the
  // card until a read asked for at least that one lands (a read already on
  // its way from before the vote cannot overwrite it).
  const appliedAt = useRef(-1);
  const box = useRef<HTMLDivElement>(null);
  useCloseInView(close, box);
  const done = close.status !== 'open';
  useEffect(() => {
    if (applied && row && row.at >= appliedAt.current) setApplied(null);
  }, [row, applied]);
  const mine = applied ? applied.mine : row ? row.myVote : close.myVote || null;
  useDecisionVoteSaved(close.id, (vote) => {
    const base = applied || { mine: row ? row.myVote : close.myVote || null, yes: row ? row.yes : 0 };
    appliedAt.current = revision + 1;
    setApplied(applyVote(base.yes, base.mine, row ? row.need : 1, vote));
    setRevision((n) => n + 1);
    onChanged();
  });
  const showAll = async () => {
    if (loadingAll) return;
    setLoadingAll(true);
    try { setAll(await readCloseReplies(slug, close.id)); } finally { setLoadingAll(false); }
  };
  const yes = applied ? applied.yes : row ? row.yes : 0;
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
  const said = mine ? t(mine === 'yes' ? 'project:topic.thread.close.saidYes' : 'project:topic.thread.close.saidNo') : null;
  const specs = done ? null : decisionVoteSpecs(close.id, { yes, no: row ? row.no : null, mine });
  return (
    <div ref={box} className="mt-3" data-close-proposal={close.id} data-close-outcome={close.outcome || undefined}>
      <div className={KICKER}>{t('project:topic.thread.close.kicker', { by: close.by || t('project:topic.thread.page.someone') })}</div>
      <p className="mt-0.5 block min-w-0 text-start text-[15px] font-[650] leading-snug text-zinc-900 dark:text-zinc-100">
        {close.reason || close.title || t('project:topic.thread.item.close')}
      </p>
      <div data-change-gate="close" data-done={done ? 'true' : 'false'} data-tone={done || mine ? 'muted' : 'ask'} role="group" aria-label={t('project:topic.thread.close.votes')}>
        <ThreadFoot
          what="close"
          headline={done ? outcome : t('project:topic.thread.close.figure', { yes, need })}
          sub={done ? said : (said || t('project:topic.thread.close.note'))}
          tone={done ? 'muted' : null}
          progress={done ? null : Math.min(1, yes / Math.max(1, need))}
        >
          {specs ? <VoteButton yes={specs.yes} no={specs.no} /> : null}
        </ThreadFoot>
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
 * #6440: a governance vote on its decision's page, as the bar a change's page
 * ends with (./thread-card.tsx ThreadFoot): the tally and the votes the rule
 * needs, and the one Vote, while it counts; once it has ended it says how
 * (passed and applied, rejected, withdrawn, no longer needed) and offers no
 * Vote. The `data-change-gate="close"` a close vote's card has always carried
 * stays, so the checks on it keep selecting the same things.
 */
export function GovVote({ g }: { g: GovernanceView }): ReactNode {
  const t = useMessages('project');
  const [revision, setRevision] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  // While the vote is open the tally is the page's own; a vote sent here
  // re-reads it, because the row the page was drawn from is now one behind.
  const [sent, setSent] = useState<GovernanceView['votes'] | null>(null);
  // #6990: the vote just saved, shown until the re-read below replaces it.
  const [applied, setApplied] = useState<AppliedVote | null>(null);
  useEffect(() => {
    // #6990: run on every vote sent (revision > 0).
    if (revision <= 0) return undefined;
    const id = Number(g.id);
    if (!id) return undefined;
    let live = true;
    // #6990: ask for the CURRENT answer, not the worker's pre-vote copy.
    fetch(`/api/apps/${encodeURIComponent(pageSlug() || '')}/governance/${id}`, { credentials: 'same-origin', cache: 'no-cache' })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        const p = json && json.proposal;
        if (!live || !p) return;
        setSent({
          yes: Number(p.qualified_yes_count ?? p.up_count) || 0,
          no: Number(p.qualified_no_count ?? p.down_count) || 0,
          need: Math.max(1, Number(p.approvals_required ?? p.votes_required) || 1),
          mine: p.my_vote === 'up' ? 'yes' : p.my_vote === 'down' ? 'no' : null,
          open: g.votes.open,
          outcome: g.votes.outcome,
        });
        // The re-read wins, even when it disagrees (someone else voted too).
        setApplied(null);
      })
      .catch(() => {});
    return () => { live = false; };
  }, [revision]);
  const base = sent && sent.open === g.votes.open ? sent : g.votes;
  const votes = applied ? { ...base, mine: applied.mine, yes: applied.yes } : base;
  useDecisionVoteSaved(g.id, (vote) => {
    const cur = applied || base;
    setApplied(applyVote(cur.yes, cur.mine, base.need, vote));
    setRevision((n) => n + 1);
    (window as any).AppView?._renderTopicHead?.();
  });
  const ending = outcomeLine(votes.outcome);
  const open = votes.open;
  const mine = votes.mine;
  const figure = t('project:topic.decision.votes.figure', { yes: votes.yes, need: votes.need });
  const said = mine ? t(mine === 'yes' ? 'project:topic.thread.close.saidYes' : 'project:topic.thread.close.saidNo') : null;
  const specs = open ? decisionVoteSpecs(g.id, { yes: votes.yes, no: votes.no, mine }) : null;
  return (
    <div ref={box} className="mt-3" data-gov-vote={g.id}>
      <div
        data-change-gate="close"
        data-gov-outcome={votes.outcome}
        data-done={open ? 'false' : 'true'}
        data-tone={open ? (mine ? 'muted' : 'ask') : 'muted'}
        role="group"
        aria-label={t('project:topic.decision.votes.label')}
      >
        <ThreadFoot
          what="decision"
          headline={open ? figure : (ending ? translate(ending) : figure)}
          sub={open ? (said || t('project:topic.decision.votes.note', { need: votes.need })) : (ending ? figure : null)}
          tone={open ? null : 'muted'}
          progress={open ? Math.min(1, votes.yes / Math.max(1, votes.need)) : null}
          busy={!open && votes.outcome === 'applying'}
        >
          {specs ? <VoteButton yes={specs.yes} no={specs.no} /> : null}
        </ThreadFoot>
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
  const ballot = ballotOf(data, anchor);
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
        {rest.map((item) => <Fragment key={item.id}><ChangeBlock item={item} plan={plans?.get(item.id) || null} request={number} onChanged={onChanged} sole={!ballot && changes.length === 1} /></Fragment>)}
        {closeAlone ? <CloseVote slug={slug} close={closeAlone} onChanged={onChanged} /> : null}
        <Elsewhere list={elsewhere} slug={slug} onChanged={onChanged} />
      </section>
    </ThreadRequests.Provider>
  );
}
