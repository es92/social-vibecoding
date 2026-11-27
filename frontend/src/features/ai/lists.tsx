/**
 * The Homeroom bot tab's list as three bands (24 Nov 2026, Evan's review of
 * the thread list, option D of the board drawn that day). Every thread is in
 * one of three places, and the list makes two things obvious: what is in
 * Needs you, and that an empty Needs you means you are finished.
 *
 *   [mark] Needs you: 23 · In progress: 5            ( + New chat )   ← the head card:
 *   ( 🔍 Search threads…              ⌘K ) ( ⫶ All projects ⌄ )        its line, then its tools
 *
 *   👤 Needs you  23                          ← a card a band, its strip first
 *   [ic] Homeroom   Rework challenges to match current goals   (Review plan)  ⋯
 *        #6277     Waiting for you to OK the plan · Sunday
 *               Show 17 more
 *
 *   🕒 In progress  5                         ← quiet grey state pills
 *   ✓ Done  80 this week                      ← a tick for what went live, else
 *                                               History's word; Show more runs
 *                                               on into History, 20 at a time
 *
 * FOUR CARDS, STACKED: the head, then one card a state, as this list has
 * always been drawn and as a thread is beside it. All three bands are always
 * open and none folds. Inside a band there are no project heads and no day
 * lines: its rows are newest first (./lines.ts newestFirst), and the band as
 * a whole shows its first few (BAND_FIRST) before its own Show more.
 *
 * DONE IS THE WHOLE PAST: this week's rows (Live this week, until today a
 * card of its own) and then History's (a card of its own too, by month),
 * each thread once. Show more adds twenty at a time and reads History's next
 * page when it runs out; its kind chips sit under the strip once it has been
 * pressed (or a kind was picked by an address). No month headings: each
 * row's second line says when.
 *
 * THE ROW, left to right: the project's tile; its name over the thread's
 * number (#6277, PR 7077; Only you for a private thread); the title over its
 * reason and time ("Waiting for you to OK the plan · Sunday"); and one thing
 * at its end (./lines.ts LineEnd): a verb pill in the accent in Needs you, a
 * grey state pill in In progress, a green tick for what went live, else
 * History's grey word. A private thread keeps its ⋯ with Mark done. The whole
 * row is one button; its pill is the same action, drawn as one.
 *
 * NARROW, UNDER 520PX OF LIST (app.css, the list's own container query, not
 * the window's): the default 352px beside a thread, and a phone. The project
 * column, the second line and the ⋯ go; the title takes up to two lines and
 * one small line under it keeps the project and the number ("Homeroom ·
 * #6277"). Mark done is then the thread's own ⋯, in its head.
 *
 * The open thread's row (`lit`, ./column.ts rowKey) is drawn where you are:
 * the lit tint behind it and its title in the lit ink, the accent's own.
 *
 * Rows here are 14px over 12, not the shell's 15 over 13 (AGENTS.md, "Type
 * and colour"): this page's exception, recorded there.
 */
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import type * as React from 'react';
import type { ReactNode } from 'react';

import { Chip, FadeRail as KindRail } from '@/components/ui/chip';
import { Skeleton, SkeletonGroup } from '@/components/ui/skeleton';
import {
  ChatIcon, CheckIcon, ChevronDownIcon, ClockIcon, FilterIcon, LockIcon, SearchIcon, UserIcon, XIcon,
} from '@/components/ui/icons';
import { StateTag } from '@/components/ui/state-tag';

import { RichMessage, useMessages } from '../../lib/i18n/react';
import { groupRows, holdOrder, openRows, type AiApp, type AiThread, type WorkRow } from './model';
import { ThreadDoneMenu } from '../messages/private-thread-done';
import { reload as reloadTab } from '../../lib/tab-build';
import { Marked, followFound } from './found';
import { BAND_FIRST, DONE_STEP, newestFirst, useAiLines, type FoundLine, type Line } from './lines';
import { lineBefore, newFirst, type LastVisit } from './visit';
import { usePhone } from './phone-drawer';
import { ProjectPicker } from './project-picker';
import { SmallTile } from './small-tile';
import { HISTORY_KINDS, type HistoryKind } from './filter-address';
import type { HistoryRow, HistoryState } from './history';
import type { Found } from './search';
import { BOT_AVATAR } from '../messages/format';

// The plane a list stands on, as GroupedList draws one: the sheet's solid
// fill, 20px, one inset hairline. Complete literals for Tailwind.
const PLANE = 'mx-4 rounded-[20px] bg-[color:var(--dc-sheet-solid)] shadow-[inset_0_0_0_1px_var(--app-sheet-line)]';
// A band's card: the plane, with the strip and the rows 6px inside it.
const BAND = `${PLANE} p-1.5`;
// A chip on a sheet: the sheet's own hairline round it, so a white chip does not melt into it.
const CHIP_EDGE = 'shadow-[inset_0_0_0_1px_var(--app-sheet-line)]';
// Keyboard focus on anything pressable here: the accent's ring, inside the
// card so a card's edge never clips it.
const FOCUS = 'outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--accent)]';

// ── The row ──────────────────────────────────────────────────────────────

/**
 * The row's own button. Its hover and press are the row's fill; its pill
 * (`group`) answers both, so the pill reads as the button it is. Complete
 * literals: Tailwind's extractor reads source text.
 */
const ROW = `group relative flex min-h-[44px] w-full min-w-0 items-center gap-3 rounded-xl px-3 py-2 text-start hover:bg-zinc-900/[0.035] active:bg-zinc-900/[0.06] dark:hover:bg-white/[0.05] dark:active:bg-white/[0.08] ${FOCUS}`;
// Where you are: the row whose thread is in the column, on the lit tint.
const LIT_ROW = `group relative flex min-h-[44px] w-full min-w-0 items-center gap-3 rounded-xl px-3 py-2 text-start bg-[color:var(--lit-tint)] text-[color:var(--lit-ink)] ${FOCUS}`;
// A row with its ⋯: lit whole, the ⋯ inside the tint (phone review #140).
const LIT_ROW_WHOLE = 'flex min-w-0 items-center rounded-xl bg-[color:var(--lit-tint)]';
const LIT_INK_ROW = `group relative flex min-h-[44px] w-full min-w-0 items-center gap-3 rounded-xl px-3 py-2 text-start text-[color:var(--lit-ink)] ${FOCUS}`;

/**
 * #6262: the dot in the row's leading padding, so rows with and without one
 * stay lined up. The accent the pills use. Mobile polish 05 (24 Nov 2026):
 * 7px, on every row new since your last visit as well as one with unread
 * messages.
 */
const DOT = 'absolute start-1 top-1/2 h-[7px] w-[7px] -translate-y-1/2 rounded-full bg-violet-600 dark:bg-violet-300';

// The one thing at a row's end (./lines.ts LineEnd). A tag never wraps: the
// title truncates instead, so the tags keep one right edge down a band.
function RowEnd({ line }: { line: Line }): ReactNode {
  const end = line.end;
  if (!end || !end.text) return null;
  // The row is what you tap, so its word is the one tag (@/components/ui/
  // state-tag): what asks for you ("Vote", "Read", "Review plan") in its
  // needs-you state, where a thing stands ("Up for a vote") plain.
  if (end.kind === 'act') return <StateTag state="needs" data-ai-row-end="act">{end.text}</StateTag>;
  if (end.kind === 'state') return <StateTag data-ai-row-end="state">{end.text}</StateTag>;
  if (end.kind === 'tick') {
    // A finished thing gets no fill: the tick alone, its word for a screen reader.
    return (
      <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center text-[color:var(--state-ok)]" data-ai-row-end="tick">
        <CheckIcon className="h-[18px] w-[18px]" aria-hidden="true" strokeWidth="2.25" />
        <span className="sr-only">{end.text}</span>
      </span>
    );
  }
  return <span className="shrink-0 whitespace-nowrap text-xs text-zinc-500 dark:text-zinc-400" data-ai-row-end="word">{end.text}</span>;
}

/** A row's tile: its project's, or a lock for a private thread in no project. */
function RowTile({ app }: { app: AiApp | null }): ReactNode {
  if (app) return <SmallTile app={app} size="band" />;
  return (
    <span className="ai-row-tile flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] bg-zinc-900/[0.06] text-zinc-500 dark:bg-white/[0.1] dark:text-zinc-400" aria-hidden="true">
      <LockIcon className="h-3.5 w-3.5" />
    </span>
  );
}

function RowButton({ line, inLitRow = false }: { line: Line; inLitRow?: boolean }): ReactNode {
  const t = useMessages('messages');
  // #6421: a thread that holds several requests says how many after its title.
  const many = Number(line.requests) > 1;
  const requestsWord = many ? t('messages:ai.row.requests', { count: line.requests }) : '';
  const tooltip = many ? `${line.tooltip} · ${requestsWord}` : line.tooltip;
  const project = line.project || '';
  const ref = line.ref || '';
  // The narrow row's one small line: the project, then its number, once.
  const where = ref && ref !== project ? t('messages:ai.row.whereShort', { project, ref }) : project;
  return (
    <button
      type="button"
      className={line.lit ? (inLitRow ? LIT_INK_ROW : LIT_ROW) : ROW}
      onClick={line.open}
      title={tooltip}
      data-ai-line={line.kind}
      data-ai-lit={line.lit ? '' : undefined}
      data-ai-fresh={line.fresh ? '' : undefined}
      data-ai-new={line.isNew ? '' : undefined}
      aria-current={line.lit ? 'true' : undefined}
    >
      {line.fresh || line.isNew ? <span className={DOT} aria-hidden="true" data-ai-dot="" /> : null}
      <RowTile app={line.app} />
      {/* The wide row's project column (app.css hides it under 520px of list). */}
      <span className="ai-row-project min-w-0 shrink-0" data-ai-row-project="">
        <span className="block truncate text-[13px] font-semibold leading-[18px] text-zinc-900 dark:text-zinc-100">{project}</span>
        <span className="block truncate text-xs leading-4 tabular-nums text-zinc-500 dark:text-zinc-400" data-ai-line-number="">{ref}</span>
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={`ai-row-title block truncate text-sm leading-[19px] ${line.lit
            ? 'font-semibold'
            : line.fresh
              // #6262: what is new is bold.
              ? 'font-bold text-zinc-900 dark:text-zinc-100'
              : 'font-semibold text-zinc-900 dark:text-zinc-100'}`}
          data-ai-line-title=""
        >
          {line.title}
          {many ? (
            <span className="ms-1 text-xs font-normal text-zinc-500 dark:text-zinc-400" data-ai-line-requests={line.requests}>
              {requestsWord}
            </span>
          ) : null}
        </span>
        {line.sub ? (
          <span className="ai-row-sub block truncate text-xs leading-4 text-zinc-500 dark:text-zinc-400" data-ai-line-why="">{line.sub}</span>
        ) : null}
        {where ? (
          <span className="ai-row-where truncate text-xs leading-4 text-zinc-500 dark:text-zinc-400" data-ai-line-where="">{where}</span>
        ) : null}
      </span>
      <RowEnd line={line} />
      {/* Mobile polish 05: the dot, said. */}
      {line.isNew ? <span className="sr-only" data-ai-new-spoken="">{t('messages:ai.row.newSpoken')}</span> : null}
      <span className="sr-only">{tooltip}</span>
    </button>
  );
}

/**
 * 24 Nov 2026 (mobile 04): Dismiss, beside Reply on a thread somebody named
 * you in: the one Needs you row that asks a courtesy rather than a
 * decision, so the one that can be waved off. Quiet, as Mark done is in a
 * private thread's ⋯: grey words, no fill, its own target at the row's end,
 * on a phone as well (it is outside `ai-row-menu`, which a narrow row drops).
 */
const DISMISS = `inline-flex min-h-[44px] md:min-h-[36px] shrink-0 items-center rounded-xl px-2.5 text-[13px] font-semibold text-zinc-500 hover:bg-zinc-900/[0.035] hover:text-zinc-700 active:bg-zinc-900/[0.06] dark:text-zinc-400 dark:hover:bg-white/[0.05] dark:hover:text-zinc-200 dark:active:bg-white/[0.08] ${FOCUS}`;

/**
 * A row, and its ⋯ where it has one (#6159: a private thread's, with Mark
 * done). Every wide row keeps the ⋯'s room (`ai-row-menu`), so the pills
 * line up down the band whichever rows have one; app.css takes it away on a
 * narrow row, where Mark done is the thread's own ⋯ in its head. A thread
 * somebody named you in has Dismiss after its Reply (mobile 04).
 */
function Row({ line }: { line: Line }): ReactNode {
  const t = useMessages('messages');
  const done = line.done;
  const dismiss = line.dismiss;
  // Lit whole, its ⋯ or its Dismiss inside the tint (phone review #140).
  const whole = !!line.lit && (!!done || !!dismiss);
  return (
    <div className={whole ? LIT_ROW_WHOLE : 'flex min-w-0 items-center'} data-ai-row="" data-ai-line-done={done ? '' : undefined}>
      <div className="min-w-0 flex-1"><RowButton line={line} inLitRow={whole} /></div>
      {dismiss ? (
        <button
          type="button"
          className={DISMISS}
          onClick={dismiss}
          aria-label={t('messages:ai.named.dismissLabel', { title: line.title })}
          title={t('messages:ai.named.dismissTitle')}
          data-ai-dismiss=""
        >
          {t('messages:ai.named.dismiss')}
        </button>
      ) : null}
      <span className="ai-row-menu flex w-8 shrink-0 items-center justify-center">
        {done ? (
          <ThreadDoneMenu rootId={done.rootId} done={false} name={line.title} onChanged={(state) => { if (state === 'done') done.mark(); }} className="shrink-0" />
        ) : null}
      </span>
    </div>
  );
}

// ── A band ───────────────────────────────────────────────────────────────

const STRIP = 'flex min-h-[40px] items-center gap-2 rounded-[14px] px-3 py-2';
const STRIP_OWE = `${STRIP} bg-[color:var(--accent-tint)] text-[color:var(--accent-tint-ink)]`;
const STRIP_QUIET = `${STRIP} bg-zinc-900/[0.04] text-zinc-900 dark:bg-white/[0.06] dark:text-zinc-100`;
const COUNT = 'inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-white px-1.5 text-xs font-bold tabular-nums dark:bg-zinc-900';
/**
 * Mobile polish 05 (24 Nov 2026): what is new since your last visit, at the
 * heading's end ("2 new"): a small pill filled with the accent, for what
 * Show more hides. Beside the band's own count, never added to it.
 */
const NEW_COUNT = 'ms-auto inline-flex h-5 shrink-0 items-center rounded-full bg-[color:var(--accent)] px-2 text-[11px] font-bold leading-5 tabular-nums text-[color:var(--accent-ink)]';

/**
 * A band's header strip: its icon, its name and its count (or what stands
 * for one), as a heading whose spoken name carries the count.
 */
function BandHead({ owe = false, icon, name, count, aside, spoken, news = 0, extra = null }: {
  owe?: boolean;
  icon: ReactNode;
  name: string;
  /** Beside the name, in a pill: the band's count. */
  count?: number | null;
  /** After it, in the lighter weight: what stands for a count ("all done", "80 this week"). */
  aside?: string | null;
  /** The heading's whole name for a screen reader: its name and its count. */
  spoken: string;
  /** Mobile polish 05: how many of its rows are new since your last visit; zero says nothing. */
  news?: number;
  extra?: ReactNode;
}): ReactNode {
  const t = useMessages('messages');
  return (
    <div className={owe ? STRIP_OWE : STRIP_QUIET} data-ai-band="">
      <h3 className="m-0 flex min-w-0 items-center gap-2 text-[15px] font-semibold leading-5">
        <span className="flex shrink-0 [&>svg]:h-[18px] [&>svg]:w-[18px]" aria-hidden="true">{icon}</span>
        <span className="truncate" aria-hidden="true">{name}</span>
        {count ? <span className={`${COUNT} ${owe ? 'text-[color:var(--accent-tint-ink)]' : 'text-zinc-500 dark:text-zinc-400'}`} aria-hidden="true" data-ai-band-count="">{count}</span> : null}
        {aside ? (
          <span className={`truncate text-[13px] font-medium ${owe ? '' : 'text-zinc-500 dark:text-zinc-400'}`} aria-hidden="true" data-ai-band-aside="">{aside}</span>
        ) : null}
        <span className="sr-only">{news > 0 ? t('messages:ai.band.withNew', { heading: spoken, count: news }) : spoken}</span>
      </h3>
      {news > 0 ? <span className={NEW_COUNT} aria-hidden="true" data-ai-band-new="">{t('messages:ai.band.newCount', { count: news })}</span> : null}
      {extra}
    </div>
  );
}

/**
 * #6312 (4 Nov 2026): the box the fold clips while it opens and shuts; its
 * rows keep their own padding, so a row with something new shows its dot
 * folded and open alike.
 */
const FOLD_CLIP = 'min-h-0 overflow-hidden';

/**
 * 19 Nov 2026: how a band's Show more opens and shuts. Its height eases on
 * one curve both ways. Opening, its rows fade in as the room opens. Shutting,
 * they stay drawn while the clip takes them from the bottom up, and turn
 * transparent only once the room is gone.
 */
const FOLD_OPEN = 'grid-rows-[1fr] opacity-100 [transition:grid-template-rows_300ms_cubic-bezier(0.4,0,0.2,1),opacity_200ms_ease-out]';
const FOLD_SHUT = 'grid-rows-[0fr] opacity-0 [transition:grid-template-rows_300ms_cubic-bezier(0.4,0,0.2,1),opacity_0s_linear_300ms]';

const MORE = `flex w-full min-h-[44px] md:min-h-[36px] items-center justify-center gap-1 rounded-xl py-2 text-[13px] font-semibold text-violet-700 hover:bg-zinc-900/[0.035] hover:text-violet-800 active:bg-zinc-900/[0.06] disabled:opacity-60 dark:text-violet-300 dark:hover:bg-white/[0.05] dark:hover:text-violet-200 ${FOCUS}`;

// Waiting on you's way back, at the end of its accent-tinted strip.
const WAITING_BACK = `ms-auto inline-flex min-h-[32px] shrink-0 items-center rounded-lg px-2 text-[13px] font-semibold hover:bg-white/50 active:bg-white/70 dark:hover:bg-white/[0.1] dark:active:bg-white/[0.16] ${FOCUS}`;
// The head's Needs you count, as the link it is: the accent's ink, underlined.
const HEAD_LINK = 'rounded-[3px] text-sm font-semibold text-[color:var(--accent)] underline underline-offset-[3px] hover:text-violet-700 dark:hover:text-violet-300 focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--accent)]';

/**
 * Mobile polish 05 (24 Nov 2026): the line under a band's last new row.
 * Everything above it is new since your last visit, everything below it you
 * have seen. A 1.5px rule in the accent across the band, inset as the rows
 * are, with the time of the last visit at its end ("New since 9:40"). A real
 * element, so a screen reader hears it. The rule is a filled bar, not a
 * border: Chrome draws a 1.5px border 1px wide (it snaps border widths to
 * whole pixels) and leaves a bar's height alone.
 */
function NewLine({ since }: { since: string }): ReactNode {
  const t = useMessages('messages');
  const words = t('messages:ai.band.newSince', { time: since });
  return (
    <div role="separator" aria-label={words} className="flex items-center gap-2 px-3 py-1.5" data-ai-new-line="">
      <span className="h-[1.5px] min-w-0 flex-1 rounded-full bg-[color:var(--accent)]" aria-hidden="true" />
      <span className="shrink-0 whitespace-nowrap text-[11px] font-semibold leading-[18px] text-[color:var(--accent)]" aria-hidden="true">{words}</span>
    </div>
  );
}

/** Rows, with the band's line before `before` (./visit.ts lineBefore) when it is one of them. */
function RowsWithLine({ lines, before, since }: { lines: Line[]; before: string | null; since: string }): ReactNode {
  return (
    <>
      {lines.map((line) => (
        <Fragment key={line.key}>
          {before && since && line.key === before ? <NewLine since={since} /> : null}
          <Row line={line} />
        </Fragment>
      ))}
    </>
  );
}

/**
 * A band's rows: its first few, then the rest folded under its own Show
 * more, which opens them in place (Show less shuts them). The row you are on
 * is never folded away; nor, in Needs you, is one with something new (#6262)
 * or one that moved while the page was up (PR 6792): past the first few they
 * join them, in their order (./model.ts groupRows). In progress passes
 * `lift` `'moved'` (#7138): a row that is only new since the last visit stays
 * behind Show more, so the band keeps its default length.
 * Opened, the rows that were in sight stay where they were (openRows).
 */
function BandRows({ lines, first, since = '', lift = true }: { lines: Line[]; first: number; since?: string; lift?: boolean | 'moved' }): ReactNode {
  const t = useMessages('messages');
  // The rows in sight when Show more was pressed, by key: open while kept.
  const [kept, setKept] = useState<string[] | null>(null);
  const open = !!kept;
  const { items, shown, hidden } = kept ? openRows(lines, kept) : groupRows(lines, first, false, lift);
  const visible = hidden ? items.slice(0, shown) : items;
  const folded = hidden ? items.slice(shown) : [];
  // Mobile polish 05: the line goes before the first seen row after the last
  // new one, in whichever part it is: under Show more, it opens with it.
  const before = lineBefore(items);
  return (
    <>
      <RowsWithLine lines={visible} before={before} since={since} />
      {hidden ? (
        <div
          className={`grid motion-reduce:transition-none ${open ? FOLD_OPEN : FOLD_SHUT}`}
          aria-hidden={open ? undefined : true}
          inert={!open}
          data-ai-group-rest=""
        >
          <div className={FOLD_CLIP}>
            <RowsWithLine lines={folded} before={before} since={since} />
          </div>
        </div>
      ) : null}
      {hidden ? (
        <button
          type="button"
          className={MORE}
          onClick={() => setKept(open ? null : items.slice(0, shown).map((line) => line.key))}
          aria-expanded={open}
          data-ai-group-more=""
        >
          {open ? t('messages:ai.work.showLess') : t('messages:ai.work.showMore', { count: hidden })}
          <ChevronDownIcon className={`h-4 w-4 transition-transform motion-reduce:transition-none${open ? ' rotate-180' : ''}`} aria-hidden="true" />
        </button>
      ) : null}
    </>
  );
}

/**
 * #6245: while the pointer is over Needs you or a row in it has keyboard
 * focus, keep the order it was drawn in, so a live refresh cannot slide a row
 * out from under the one being pressed. Rows that arrived meanwhile follow
 * the drawn ones; anything that left drops out at once. On release the band
 * settles into the incoming order.
 */
function useHeld(lines: Line[]) {
  const ref = useRef<HTMLElement | null>(null);
  const drawn = useRef<string[] | null>(null);
  const [holding, setHolding] = useState(false);
  const held = holding && drawn.current ? holdOrder(lines, drawn.current) : lines;
  const start = () => {
    if (!drawn.current) drawn.current = lines.map((line) => line.key);
    setHolding(true);
  };
  const end = () => {
    drawn.current = null;
    setHolding(false);
  };
  const within = (node: EventTarget | null) => !!ref.current && node instanceof Node && ref.current.contains(node);
  const handlers = {
    onPointerEnter: start,
    onPointerLeave: end,
    onFocus: (e: React.FocusEvent) => { if (!within(e.relatedTarget)) start(); },
    onBlur: (e: React.FocusEvent) => { if (!within(e.relatedTarget)) end(); },
  };
  return { ref, held, handlers };
}

/**
 * Offline test, 2 Nov 2026: the lists could not be read and this device kept
 * no copy of them, so Needs you says why it shows nothing, in words, with a
 * way to read them again. Plain, not red: being offline is a state.
 */
function ListsFailed({ failed, onRetry }: { failed: 'unreachable' | 'failed'; onRetry: () => void }): ReactNode {
  const t = useMessages('messages');
  return (
    <div className="px-3 py-3" data-ai-failed={failed} role="status">
      <p className="m-0 text-sm text-zinc-500 dark:text-zinc-400">
        {failed === 'unreachable' ? t('messages:ai.work.unreachable') : t('messages:ai.work.failed')}
      </p>
      <button
        type="button"
        className={`mt-1 inline-flex min-h-[44px] md:min-h-0 items-center rounded-md py-1 text-[13px] font-semibold text-violet-700 hover:text-violet-800 dark:text-violet-300 dark:hover:text-violet-200 ${FOCUS}`}
        onClick={onRetry}
        data-ai-retry=""
      >
        {t('core:common.tryAgain')}
      </button>
    </div>
  );
}

/** Two rows' lines while a band's rows are on their way: two bars, no more. */
function LoadingLines({ label, ...props }: { label: string } & React.HTMLAttributes<HTMLDivElement>): ReactNode {
  return (
    <SkeletonGroup label={label} className="flex flex-col gap-8 px-3 py-4" {...props}>
      <Skeleton className="w-1/2" />
      <Skeleton className="w-2/5" />
    </SkeletonGroup>
  );
}

/**
 * WAITING ON YOU (24 Nov 2026): the list the head's Needs you count opens
 * (#7103). One card, one row for every thing that needs the person, each
 * with the action pill it has in Needs you and opening the request or change
 * it is about. Nothing folds and there is no Show more: the count the head
 * gave and the rows here are one number. Its way back is All threads.
 */
function WaitingCard({ lines, count, ready, failed, onRetry, onClose, searching, noneWords }: {
  lines: Line[];
  count: number;
  ready: boolean;
  failed: 'unreachable' | 'failed' | null;
  onRetry?: () => void;
  onClose?: () => void;
  searching: boolean;
  noneWords: string;
}): ReactNode {
  const t = useMessages('messages');
  return (
    <div className={BAND} data-ai-sheet="waiting">
      <section data-ai-list="waiting">
        <BandHead
          owe
          icon={<UserIcon />}
          name={t('messages:ai.waiting.title')}
          count={count || null}
          spoken={t('messages:ai.waiting.titleCount', { count })}
          extra={onClose ? (
            <button type="button" className={WAITING_BACK} onClick={onClose} data-ai-waiting-close="">
              <span aria-hidden="true">‹ </span>{t('messages:ai.waiting.all')}
            </button>
          ) : null}
        />
        <div className="pt-1">
          {failed ? <ListsFailed failed={failed} onRetry={() => onRetry?.()} /> : null}
          {lines.length ? (
            <BandRows lines={lines} first={Infinity} />
          ) : !ready ? (
            failed ? null : <LoadingLines label={t('messages:ai.waiting.loading')} data-ai-loading="" />
          ) : searching ? (
            <p className="m-0 px-3 py-3 text-[13px] text-zinc-500 dark:text-zinc-400" data-ai-empty="waiting">{noneWords}</p>
          ) : (
            <p className="m-0 flex items-start gap-2.5 px-3 py-3 text-[13px] leading-5 text-zinc-500 dark:text-zinc-400" data-ai-empty="waiting">
              <CheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--state-ok)]" aria-hidden="true" strokeWidth="2.25" />
              <span>{t('messages:ai.waiting.empty')}</span>
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

/**
 * IN PROGRESS (25 Nov 2026, #7157): the list the head's In progress count
 * opens, Waiting on you's sibling. One card, one row for every thread being
 * built, checked or waiting on somebody else, each as its band draws it.
 * Nothing folds and there is no Show more, so the count the head gave and
 * the rows here are one number. Its way back is All threads.
 */
function ProgressCard({ lines, ready, failed, onRetry, onClose, searching, noneWords }: {
  lines: Line[];
  ready: boolean;
  failed: 'unreachable' | 'failed' | null;
  onRetry?: () => void;
  onClose?: () => void;
  searching: boolean;
  noneWords: string;
}): ReactNode {
  const t = useMessages('messages');
  const count = lines.length;
  return (
    <div className={BAND} data-ai-sheet="progress">
      <section data-ai-list="progress">
        <BandHead
          icon={<ClockIcon />}
          name={t('messages:ai.band.progress')}
          count={count || null}
          spoken={count ? t('messages:ai.band.progressCount', { count }) : t('messages:ai.band.progress')}
          extra={onClose ? (
            <button type="button" className={WAITING_BACK} onClick={onClose} data-ai-progress-close="">
              <span aria-hidden="true">‹ </span>{t('messages:ai.waiting.all')}
            </button>
          ) : null}
        />
        <div className="pt-1">
          {failed ? <ListsFailed failed={failed} onRetry={() => onRetry?.()} /> : null}
          {lines.length ? (
            <BandRows lines={lines} first={Infinity} />
          ) : !ready ? (
            failed ? null : <LoadingLines label={t('messages:ai.progress.loading')} data-ai-loading="" />
          ) : searching ? (
            <p className="m-0 px-3 py-3 text-[13px] text-zinc-500 dark:text-zinc-400" data-ai-empty="progress">{noneWords}</p>
          ) : (
            <p className="m-0 px-3 py-3 text-[13px] text-zinc-500 dark:text-zinc-400" data-ai-empty="progress">{t('messages:ai.band.progressEmpty')}</p>
          )}
        </div>
      </section>
    </div>
  );
}

// ── Search's messages ────────────────────────────────────────────────────

/**
 * 13 Nov 2026: the words the search found, in a message's snippet. The
 * accent's own tint behind them (a token, so it follows the theme) and the
 * title's ink and weight, so they stand out of the quiet line round them.
 */
const FOUND_MARK = 'rounded-[3px] bg-[color:var(--accent-tint)] font-semibold text-zinc-900 dark:text-zinc-100';
const FOUND_ROW = `flex w-full min-h-[44px] md:min-h-[36px] items-center gap-3 rounded-xl px-3 py-1.5 text-start hover:bg-zinc-900/[0.035] active:bg-zinc-900/[0.06] dark:hover:bg-white/[0.05] dark:active:bg-white/[0.08] ${FOCUS}`;

/**
 * 13 Nov 2026 (./search.ts): a message the search found, as one of the
 * list's quiet rows, and a link to it: its snippet with the found words
 * marked, where it is (its thread's name, or the chat itself) and its day.
 * Where the list is narrow, where it is goes on a second line (app.css). The
 * link's name says all of it, and who wrote it.
 */
function FoundRow({ line }: { line: FoundLine }): ReactNode {
  return (
    <a
      href={line.href}
      className={FOUND_ROW}
      title={line.name}
      aria-label={line.name}
      onClick={(e) => followFound(e, line.href, { messageId: line.messageId, q: line.q })}
      data-ai-found={line.thread ? 'thread' : 'chat'}
    >
      <span className="flex shrink-0 text-zinc-400 dark:text-zinc-500" aria-hidden="true"><ChatIcon className="h-[18px] w-[18px]" /></span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] leading-5 text-zinc-600 dark:text-zinc-400" data-ai-found-words="">
          <Marked parts={line.parts} className={FOUND_MARK} />
        </span>
        <span className="ai-found-place-under block truncate text-xs leading-4 text-zinc-500 dark:text-zinc-400">{line.place}</span>
      </span>
      <span className="ai-found-place max-w-[40%] shrink truncate text-[13px] text-zinc-500 dark:text-zinc-400" data-ai-found-place="">{line.place}</span>
      <span className="shrink-0 whitespace-nowrap text-[13px] text-zinc-500 dark:text-zinc-400">{line.date}</span>
    </a>
  );
}

// ── The list ─────────────────────────────────────────────────────────────

/** The head's counts, as its line says them: a zero says nothing (Y03). */
function headWords(needs: number, next: number): { id: string; values: Record<string, number> } {
  if (needs > 0) return next > 0
    ? { id: 'messages:ai.head.counts', values: { needs, next } }
    : { id: 'messages:ai.head.needs', values: { needs } };
  return next > 0 ? { id: 'messages:ai.head.clear', values: { next } } : { id: 'messages:ai.head.clearAlone', values: {} };
}

export function AiLists({
  newChat = null, search = null, query = '', onQueryClear, found, onFoundRetry, lit = null, ready, failed = null, onRetry, rows, owed, progress, waiting, live,
  openRow, openThread, onDone, onDismiss, picked: pickedIn = [], onPick, appFor, history = null, historyKind = null, onHistoryKind, openHistory, historyRef, doneOpen = 0,
  visit = null, waitingOpen = false, onOpenWaiting, onCloseWaiting, progressOpen = false, onOpenProgress, onCloseProgress,
}: {
  /** The head's New chat (./new-chat-button.tsx), at the end of its line. */
  newChat?: ReactNode;
  /** The head's search field (./index.tsx), first on its tools line. */
  search?: ReactNode;
  /**
   * Empty the search box (phone review, 23 Nov 2026, #3): what the chip on
   * Done's strip does, so a search that is narrowing it can be seen and
   * ended there, with the box itself a long scroll above.
   */
  onQueryClear?: () => void;
  /**
   * #6398: what the page's search box says. The bands keep only the threads
   * whose title, number or project name contains it, upper and lower case
   * alike; a band with no match is not drawn. '' filters nothing.
   */
  query?: string;
  /**
   * 13 Nov 2026: the messages in the person's threads with the bot that
   * match what the box says (./search.ts useBotSearch), listed under the
   * bands; null while the first answer is on its way.
   */
  found?: Found | null;
  /** Search the messages again: the Try again of the note that says they could not be. */
  onFoundRetry?: () => void;
  /**
   * What the column shows (./column.ts columnKey): `private:<root>` or
   * `page:<route>`. The row that opens it is lit.
   */
  lit?: string | null;
  /** The lists have been read: until then Needs you says nothing, not "nothing needs you". */
  ready: boolean;
  /** A list could not be read and none was kept: Needs you says so (index.tsx ListsFailure). */
  failed?: 'unreachable' | 'failed' | null;
  /** Read the lists again: the note's Try again. */
  onRetry?: () => void;
  rows: WorkRow[];
  owed: number;
  progress: AiThread[];
  waiting: AiThread[];
  live: AiThread[];
  openRow: (row: WorkRow) => void;
  openThread: (t: AiThread) => void;
  /** #6159: a private thread's row was marked done from its ⋯: it leaves the lists at once. */
  onDone?: (rootId: number) => void;
  /** Mobile 04: Dismiss on a thread somebody named you in: it leaves Needs you at once. */
  onDismiss?: (row: WorkRow) => void;
  /**
   * The projects the filter narrows every band to (none: All). The page
   * keeps them in its address (./filter-address.ts), so a link can open the
   * tab narrowed to a project: a project's Workshop and Hub do.
   */
  picked?: readonly string[];
  onPick?: (slugs: string[]) => void;
  /** A project the lists do not name (one picked by a link), for the filter's name. */
  appFor?: (slug: string) => AiApp | null;
  /** History's rows (./history.ts useHistory), which Done runs on into; none, this week's alone. */
  history?: HistoryState | null;
  historyKind?: HistoryKind | null;
  onHistoryKind?: (kind: HistoryKind | null) => void;
  openHistory?: (row: HistoryRow) => void;
  /** Done's card, which #homeroom-bot/history scrolls to. */
  historyRef?: React.Ref<HTMLDivElement>;
  /** Bumped by #homeroom-bot/history: Done opens past its first rows, its kind chips shown. */
  doneOpen?: number;
  /**
   * Mobile polish 05 (24 Nov 2026): your last visit (./use-visit.ts), which
   * each band marks what is new since: a dot on each new row, the new rows
   * first with a line under them, and a count in its heading. Null on a
   * first visit, and until it is read: no marks.
   */
  visit?: LastVisit | null;
  /**
   * 24 Nov 2026 (#7103): Waiting on you, drawn in place of the three bands.
   * The head, its search and its project filter stay above it.
   */
  waitingOpen?: boolean;
  /** The head's Needs you count pressed: open Waiting on you. */
  onOpenWaiting?: () => void;
  /** Waiting on you's All threads: back to the head and the three bands. */
  onCloseWaiting?: () => void;
  /**
   * 25 Nov 2026 (#7157): In progress, drawn in place of the three bands from
   * the head's other count, as Waiting on you is. Only one of the two is open.
   */
  progressOpen?: boolean;
  /** The head's In progress count pressed: open In progress. */
  onOpenProgress?: () => void;
  /** In progress's All threads: back to the head and the three bands. */
  onCloseProgress?: () => void;
}): ReactNode {
  const t = useMessages('messages');
  const {
    searching, ranked, picked, setOnly, toggle, needLines, progressLines, doneLines, liveBehind, onlyApp, nothingHere,
    noMatches, noneWords, foundLines, foundMore, foundFailed, needCount, progressCount, weekCount,
    needNew, progressNew, doneNew, newSince,
  } = useAiLines({ query, lit, ready, rows, owed, progress, waiting, live, openRow, openThread, onDone, onDismiss, picked: pickedIn, onPick, appFor, history, openHistory, historyKind, found, visit });
  // The project picker, open under the filter.
  const [more, setMore] = useState<DOMRect | null>(null);
  const phone = usePhone();
  // Needs you, newest first, its order held while it is being used (#6245).
  // Mobile polish 05: what is new since your last visit before the rest.
  const needs = useHeld(newFirst(newestFirst(needLines)));

  // DONE'S PAGING. How many of its rows are drawn: five at rest, twenty more
  // a press. A door that asks for History opens it past its first rows.
  const [doneShown, setDoneShown] = useState<number>(() => (doneOpen ? BAND_FIRST.done + DONE_STEP : BAND_FIRST.done));
  useEffect(() => { if (doneOpen) setDoneShown((n) => Math.max(n, BAND_FIRST.done + DONE_STEP)); }, [doneOpen]);
  const doneMore = doneShown > BAND_FIRST.done;
  // Show more reads History's next page when what is read runs out, and
  // keeps reading until the press's twenty are there or nothing is older. A
  // search lists what has loaded, as History did; its Show more reads on.
  const wantMore = !!history && history.ready && !history.loading && !history.failed && !!history.next && !searching
    && doneMore && doneLines.length < doneShown;
  const readMore = history?.more;
  useEffect(() => { if (wantMore && readMore) readMore(); }, [wantMore, readMore]);
  const done = searching
    ? { items: doneLines, shown: doneLines.length, hidden: 0 }
    : groupRows(doneLines, doneShown, false, false);
  const doneDrawn = done.items.slice(0, done.shown);
  const doneLoading = !!history && (!history.ready || history.loading) && !history.failed
    && (searching ? false : doneDrawn.length < doneShown);
  // More to show: rows already read past what is drawn, or an older page.
  const historyCan = !!history && history.ready && !history.loading && !!history.next;
  const doneCan = searching ? historyCan : (done.hidden > 0 || historyCan);
  const showDoneMore = useCallback(() => {
    if (searching) { history?.more(); return; }
    setDoneShown((n) => n + DONE_STEP);
  }, [searching, history]);
  const kindsShown = doneMore || !!historyKind;

  const counts = ready ? headWords(needCount, progressCount) : null;
  // #7103: the Needs you count is the way into Waiting on you. A zero has
  // nothing to open, and says Nothing needs you in the plain weight.
  const needsLink = needCount > 0 && !!onOpenWaiting;
  // #7157: and the In progress count is the way into its own list, drawn
  // the same way, in the counts and in the Nothing needs you wording. A zero
  // is not a link, and the wordings without one draw no <1> at all.
  const progressLink = progressCount > 0 && !!onOpenProgress;
  // The filter at rest says what it shows: All projects, the one picked, or how many.
  const onlyPicked = picked.length === 1 ? ranked.find((p) => p.app.slug === picked[0])?.app || null : null;
  const filterWords = !picked.length
    ? t('messages:ai.filter.allProjects')
    : onlyPicked ? onlyPicked.name || onlyPicked.slug : t('messages:ai.filter.someProjects', { count: picked.length });
  const progressSpoken = progressLines.length
    ? t('messages:ai.band.progressCount', { count: progressLines.length })
    : t('messages:ai.band.progress');
  return (
    <div className="ai-lists flex flex-col gap-3 pt-4" data-ai-lists="">
      <div className={`${PLANE} pb-3`} data-ai-sheet="head">
        {/* THE HEAD'S LINE: the Homeroom mark, the counts the bands below
            carry, and New chat. The page is named once on screen, by the bar
            above (phone review, 23 Nov 2026, S14): the heading stays for a
            screen reader, by role and not as an <h1>, because this screen
            is in the served document while hidden (request #7166). */}
        <section className="flex items-center gap-3 px-4 pt-3" data-ai-hero="">
          <img src={BOT_AVATAR} alt="" className="h-10 w-10 shrink-0 rounded-[13px] object-cover" />
          <span className="flex min-w-0 flex-1 flex-col">
            <div role="heading" aria-level={1} className="sr-only">{t('messages:ai.hero.name')}</div>
            {counts ? (
              <span className="truncate text-[13px] text-zinc-500 dark:text-zinc-400" data-ai-hero-sub="">
                <RichMessage
                  id={counts.id}
                  values={counts.values}
                  components={[needsLink
                    ? (
                      <button
                        type="button"
                        className={HEAD_LINK}
                        onClick={onOpenWaiting}
                        aria-label={t('messages:ai.waiting.open', { count: needCount })}
                        data-ai-waiting-open=""
                      />
                    )
                    : <strong className="text-sm font-semibold text-zinc-900 dark:text-zinc-100" />,
                  progressLink
                    ? (
                      <button
                        type="button"
                        className={HEAD_LINK}
                        onClick={onOpenProgress}
                        aria-label={t('messages:ai.progress.open', { count: progressCount })}
                        data-ai-progress-open=""
                      />
                    )
                    : <span />]}
                />
              </span>
            ) : null}
          </span>
          {newChat}
        </section>
        {/* THE TOOLS LINE: the search, always there, and one project filter
            that opens the picker (./project-picker.tsx). No sort and no
            status filter: the bands are the status. */}
        <div className="flex flex-wrap items-center gap-2 px-4 pt-3" data-ai-tools="">
          {search}
          <button
            type="button"
            // One look: a menu chip, the shared part (white, the small sticker edge).
            className={`inline-flex h-9 min-w-0 max-w-full shrink items-center gap-1.5 rounded-[10px] px-3 text-[13px] font-semibold text-zinc-900 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] hover:bg-zinc-900/[0.04] active:bg-zinc-900/[0.07] disabled:text-zinc-400 dark:text-zinc-100 dark:hover:bg-white/[0.06] dark:active:bg-white/[0.1] dark:disabled:text-zinc-500 ${FOCUS} one-chip`}
            aria-haspopup="dialog"
            aria-expanded={!!more}
            aria-label={t('messages:ai.filter.button', { shown: filterWords })}
            disabled={!ranked.length}
            onClick={(e) => setMore(more ? null : e.currentTarget.getBoundingClientRect())}
            data-ai-project-more=""
            data-ai-picked={picked.length ? picked.join(' ') : undefined}
          >
            {onlyPicked ? <SmallTile app={onlyPicked} /> : <FilterIcon className="ai-filter-glyph h-4 w-4 shrink-0 text-zinc-500 dark:text-zinc-400" aria-hidden="true" />}
            <span className="min-w-0 truncate">{filterWords}</span>
            <ChevronDownIcon className="h-4 w-4 shrink-0 text-zinc-500 dark:text-zinc-400" aria-hidden="true" />
          </button>
        </div>
      </div>
      {more ? (
        <ProjectPicker
          sheet={phone}
          anchor={more}
          ranked={ranked}
          picked={picked}
          onToggle={toggle}
          onClear={() => setOnly([])}
          onClose={() => setMore(null)}
        />
      ) : null}
      {/* #7103: WAITING ON YOU replaces the three cards below the head: one
          list of everything that needs the person, nothing else. */}
      {waitingOpen ? (
        <WaitingCard
          lines={needs.held}
          count={needLines.length}
          ready={ready}
          failed={failed}
          onRetry={onRetry}
          onClose={onCloseWaiting}
          searching={searching}
          noneWords={noneWords}
        />
      ) : progressOpen ? (
        // #7157: IN PROGRESS replaces the three cards, as Waiting on you does.
        <ProgressCard
          lines={progressLines}
          ready={ready}
          failed={failed}
          onRetry={onRetry}
          onClose={onCloseProgress}
          searching={searching}
          noneWords={noneWords}
        />
      ) : (
      <>
      {/* #6398: one short note says when nothing on the page matched: no
          thread, and (13 Nov 2026) no message either. */}
      {noMatches ? (
        <div className={`${PLANE} px-4 py-3`} data-ai-search-empty="">
          <p className="m-0 text-sm text-zinc-500 dark:text-zinc-400">{noneWords}</p>
        </div>
      ) : null}

      {/* NEEDS YOU. Its strip is the accent's tint, the one band that is
          your job. While searching it is drawn only with a match, so its
          empty line is never the search's answer. */}
      {!searching || !ready || needLines.length || failed ? (
        <div className={BAND} data-ai-sheet="open">
          <section
            ref={needs.ref}
            data-ai-list="work"
            {...needs.handlers}
          >
            <BandHead
              owe
              icon={<UserIcon />}
              name={t('messages:ai.work.title')}
              count={needLines.length || null}
              aside={ready && !failed && !needLines.length ? t('messages:ai.band.allDone') : null}
              spoken={needLines.length
                ? t('messages:ai.work.titleCount', { count: needLines.length })
                : ready && !failed ? t('messages:ai.band.allDoneSpoken') : t('messages:ai.work.title')}
              news={needNew}
            />
            <div className="pt-1">
              {failed ? <ListsFailed failed={failed} onRetry={() => onRetry?.()} /> : null}
              {needLines.length ? (
                // Rows that arrived are drawn, under the note when the other
                // list could not be read.
                <BandRows lines={needs.held} first={searching ? Infinity : BAND_FIRST.needs} since={newSince} />
              ) : !ready ? (
                // L06 (overnight audit, 2 Nov 2026): until the lists are read
                // the band shows its rows' shape: two bars and no more, as the
                // screen is in the prerendered document. A read that failed
                // says so in its note instead: no rows are coming.
                failed ? null : <LoadingLines label={t('messages:ai.work.loading')} data-ai-loading="" />
              ) : nothingHere && !doneLines.length && onlyApp ? (
                <p className="m-0 px-3 py-3 text-sm text-zinc-500 dark:text-zinc-400" data-ai-empty="project">
                  {t('messages:ai.filter.emptyProject', { project: onlyApp.name || onlyApp.slug })}
                </p>
              ) : failed ? null : (
                // NOTHING NEEDS YOU: you are finished; the platform is doing
                // the rest, and says how much of it.
                <p className="m-0 flex items-start gap-2.5 px-3 py-3 text-[13px] leading-5 text-zinc-500 dark:text-zinc-400" data-ai-empty="">
                  <CheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--state-ok)]" aria-hidden="true" strokeWidth="2.25" />
                  <span>
                    <RichMessage
                      id={progressCount ? 'messages:ai.band.clear' : 'messages:ai.band.clearAlone'}
                      values={{ count: progressCount }}
                      components={[<strong className="font-semibold text-zinc-900 dark:text-zinc-100" />]}
                    />
                  </span>
                </p>
              )}
            </div>
          </section>
        </div>
      ) : null}

      {/* IN PROGRESS: everything being built, checked or waiting on somebody
          else, the threads nobody is moving among them (Not moving). It and
          Done follow Needs you once the lists are read (or rows of theirs
          arrived): the prerender is the head and Needs you's two bars, as
          it was with the cards they replace (tests/mount-on-reveal.test.js
          bounds the document). */}
      {(ready || progressLines.length) && (!searching || progressLines.length) ? (
        <div className={BAND} data-ai-sheet="busy">
          <section data-ai-list="busy">
            <BandHead
              icon={<ClockIcon />}
              name={t('messages:ai.band.progress')}
              count={progressLines.length || null}
              spoken={progressSpoken}
              news={progressNew}
            />
            <div className="pt-1">
              {ready && !progressLines.length ? (
                <p className="m-0 px-3 py-3 text-[13px] text-zinc-500 dark:text-zinc-400" data-ai-empty="">{t('messages:ai.band.progressEmpty')}</p>
              ) : (
                <BandRows lines={progressLines} first={searching ? Infinity : BAND_FIRST.busy} since={newSince} lift="moved" />
              )}
            </div>
          </section>
        </div>
      ) : null}

      {/* DONE: the whole past, newest first. */}
      {(ready || doneLines.length) && (!searching || doneLines.length) ? (
        <div ref={historyRef} className={`${BAND} scroll-mt-4`} data-ai-sheet="live">
          <section data-ai-list="live">
            <BandHead
              icon={<CheckIcon strokeWidth="2.25" />}
              name={t('messages:ai.band.done')}
              aside={weekCount ? t('messages:ai.band.thisWeek', { count: weekCount }) : null}
              spoken={weekCount ? t('messages:ai.band.doneCount', { count: weekCount }) : t('messages:ai.band.done')}
              news={doneNew}
              extra={searching && onQueryClear ? (
                // #3 (phone review, 23 Nov 2026): Done is searched like every
                // band, and the search box is far above it. So while a search
                // narrows it, its strip says so, with the way to end it: the
                // chip idiom's selection, but a press clears it.
                <Chip
                  size="bar"
                  selected
                  aria-pressed={undefined}
                  className="-my-1 ms-auto h-8 min-w-0 max-w-[60%] gap-1.5 ps-2.5 pe-2 text-[13px] [&>svg]:h-3.5 [&>svg]:w-3.5 [&>svg]:shrink-0"
                  aria-label={t('messages:ai.history.searching.clear', { query: query.trim() })}
                  title={t('messages:ai.history.searching.clear', { query: query.trim() })}
                  onClick={onQueryClear}
                  data-ai-history-search=""
                >
                  <SearchIcon aria-hidden="true" />
                  <span className="min-w-0 truncate">{t('messages:ai.history.searching.chip', { query: query.trim() })}</span>
                  <XIcon aria-hidden="true" strokeWidth="2.25" />
                </Chip>
              ) : null}
            />
            {/* History's kind chips, once Show more has been pressed (or an
                address picked a kind): a kind narrows the whole of Done. */}
            {kindsShown ? (
              <KindRail role="group" aria-label={t('messages:ai.history.kind.label')} className="gap-1.5 px-1.5 pt-2 pb-1" data-ai-history-kinds="">
                <Chip size="bar" className={`h-8 px-3 text-[13px] whitespace-nowrap ${CHIP_EDGE}`} selected={!historyKind} onClick={() => onHistoryKind?.(null)} data-ai-history-kind="all">
                  {t('messages:ai.history.kind.all')}
                </Chip>
                {HISTORY_KINDS.map((kind) => (
                  <Chip key={kind} size="bar" className={`h-8 px-3 text-[13px] whitespace-nowrap ${CHIP_EDGE}`} selected={historyKind === kind} onClick={() => onHistoryKind?.(kind)} data-ai-history-kind={kind}>
                    {kind === 'change' ? t('messages:ai.history.kind.change')
                      : kind === 'request' ? t('messages:ai.history.kind.request')
                        : kind === 'vote' ? t('messages:ai.history.kind.vote')
                          : t('messages:ai.history.kind.solo')}
                  </Chip>
                ))}
              </KindRail>
            ) : null}
            <div className="pt-1">
              {/* Mobile polish 05: its line only where the rows drawn hold
                  both new and seen ones; past Show more the count says how
                  many more are new. */}
              <RowsWithLine lines={doneDrawn} before={lineBefore(doneDrawn)} since={newSince} />
              {/* While a page loads, two bars sit where its rows will be; if
                  it fails, one line with Try again. Neither moves the rows
                  above. */}
              {doneLoading ? <LoadingLines label={t('messages:ai.history.loading')} data-ai-history-loading="" /> : null}
              {history && history.ready && history.failed ? (
                <div className="px-3 py-3" role="status" data-ai-history-failed="">
                  <p className="m-0 text-sm text-zinc-500 dark:text-zinc-400">{t('messages:ai.history.failed')}</p>
                  <button
                    type="button"
                    className={`mt-1 inline-flex min-h-[44px] md:min-h-0 items-center rounded-md py-1 text-[13px] font-semibold text-violet-700 hover:text-violet-800 dark:text-violet-300 dark:hover:text-violet-200 ${FOCUS}`}
                    onClick={history.rows.length ? history.more : history.retry}
                  >
                    {t('core:common.tryAgain')}
                  </button>
                </div>
              ) : null}
              {ready && !doneLines.length && (!history || (history.ready && !history.failed && !history.next)) ? (
                <p className="m-0 px-3 py-3 text-[13px] text-zinc-500 dark:text-zinc-400" data-ai-history-empty="">{t('messages:ai.history.empty')}</p>
              ) : null}
              {/* #6233: one Reload under Done's rows, for every row this tab
                  is older than. */}
              {liveBehind ? (
                <div className="mx-3 mt-1 flex items-center gap-2 border-t border-zinc-900/[0.07] pt-2 pb-1 dark:border-white/[0.08]" data-ai-older-tab="">
                  <span className="min-w-0 flex-1 text-[13px] text-zinc-500 dark:text-zinc-400">{t('messages:ai.live.olderTab')}</span>
                  <button
                    type="button"
                    className={`shrink-0 rounded-md text-[13px] font-semibold text-violet-700 hover:underline dark:text-violet-300 ${FOCUS}`}
                    onClick={() => reloadTab()}
                    data-ai-older-tab-reload=""
                  >
                    {t('messages:ai.short.reload')}
                  </button>
                </div>
              ) : null}
              {/* Show more: twenty more, into older work. No count: the
                  archive's size is not known. Gone once nothing is older. */}
              {doneCan ? (
                <button type="button" className={MORE} onClick={showDoneMore} data-ai-history-more="">
                  {t('messages:ai.band.showMore')}
                  <ChevronDownIcon className="h-4 w-4" aria-hidden="true" />
                </button>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}

      {/* 13 Nov 2026: the messages that match, under the bands: a card of
          its own, its rows links to each message. Drawn only while a search
          is on and has found some (nothing in the prerender). */}
      {foundLines.length ? (
        <div className={BAND} data-ai-sheet="found">
          <section data-ai-list="found">
            <BandHead
              icon={<ChatIcon />}
              name={t('messages:ai.search.messagesTitle')}
              count={foundLines.length}
              spoken={t('messages:ai.search.messages', { count: foundLines.length })}
            />
            <div className="pt-1">
              {foundLines.map((line) => <FoundRow key={line.key} line={line} />)}
              {foundMore ? (
                <p className="m-0 px-3 py-2 text-[13px] text-zinc-500 dark:text-zinc-400" data-ai-found-more="">{t('messages:ai.search.more')}</p>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
      {/* The messages could not be searched: said plainly, with a way to ask
          again, as a list that could not be read says it (ListsFailed). */}
      {foundFailed ? (
        <div className={`${PLANE} px-4 py-3`} data-ai-search-failed="" role="status">
          <p className="m-0 text-sm text-zinc-500 dark:text-zinc-400">{t('messages:ai.search.failed')}</p>
          <button
            type="button"
            className={`mt-1 inline-flex min-h-[44px] md:min-h-0 items-center rounded-md py-1 text-[13px] font-semibold text-violet-700 hover:text-violet-800 dark:text-violet-300 dark:hover:text-violet-200 ${FOCUS}`}
            onClick={() => onFoundRetry?.()}
            data-ai-search-retry=""
          >
            {t('core:common.tryAgain')}
          </button>
        </div>
      ) : null}
      </>
      )}
    </div>
  );
}
