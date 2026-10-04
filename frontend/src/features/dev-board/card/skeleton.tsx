/**
 * The Dev board's LOADING state, for both surfaces.
 *
 * ── Why this exists ───────────────────────────────────────────────────
 *
 * The board's first paint used to be a lie. `_repaintDevBody` renders from
 * whatever is in AppView's caches, and several things call it before the
 * board's own fetches have landed — a `session-state` flush does, ~550ms
 * into a cold open, straight through `_repaintCards`. With empty caches
 * every column drew its own title, `· 0`, and the words "Nothing here yet".
 * That is not a slow screen; it is a WRONG one, and it stayed wrong for as
 * long as the network took. The report that started this was "content
 * loads without you realising it's loading", and an empty board is the
 * worst case of it: there is nothing to notice, because the screen looks
 * finished.
 *
 * So the view models carry a `loading` flag now (see ./model.ts), set by
 * `AppView._devDataReady`, and everything that would otherwise state a
 * fact about the data — the counts, the empty notes, the stream — defers
 * to these placeholders until the first load lands.
 *
 * ── Why a skeleton and not a spinner ──────────────────────────────────
 *
 * A spinner is a fixed mark that says "busy, somewhere". A skeleton says
 * WHERE the content is going and roughly HOW MUCH of it there is, which is
 * the part that stops a half-drawn screen reading as a finished one. These
 * are drawn at the real card's geometry — same `rounded-2xl`, same white /
 * `zinc-900` ground, same `px-3.5 py-3`, same 32px leading tile — so the
 * arriving cards land on top of their own outlines rather than replacing a
 * different-shaped grey block.
 *
 * The bars vary in width by index. Three identical rows read as a graphic;
 * uneven ones read as text that hasn't arrived. The widths are a table of
 * complete literals because Tailwind's extractor is a regex over source
 * text — a computed `w-${n}/4` compiles to nothing.
 *
 * `aria-hidden` on the geometry with one `role="status"` label beside it:
 * a screen reader should hear "Loading" once, not a description of six
 * decorative rectangles.
 */

import type { ReactNode } from 'react';

import { SECTION_TAB_ACTIVE } from '@/components/ui/tabs';

/** The card shell, matching `.gc-vote-item`'s box (see dev-card.tsx). */
export const SKELETON_CARD_CLS =
  'w-full flex items-center gap-3 rounded-2xl bg-white dark:bg-zinc-900 px-3.5 py-3';
/** The leading icon tile, at the real card's 32px `rounded-lg` box. */
export const SKELETON_TILE_CLS = 'w-8 h-8 rounded-lg bg-zinc-200 dark:bg-zinc-800 shrink-0';
/** Title line. */
export const SKELETON_LINE_CLS = 'h-3 rounded bg-zinc-200 dark:bg-zinc-800';
/** Sub-line — dimmer, as the real card's meta row is. */
export const SKELETON_SUBLINE_CLS = 'h-2.5 rounded bg-zinc-200/70 dark:bg-zinc-800/70';

/** Per-row widths, as complete class literals. Cycled by row index. */
const TITLE_W = ['w-3/4', 'w-1/2', 'w-2/3', 'w-5/6'];
const SUB_W = ['w-1/3', 'w-2/5', 'w-1/4', 'w-1/2'];

function SkeletonCard({ i }: { i: number }): ReactNode {
  return (
    <div className={SKELETON_CARD_CLS}>
      <div className={SKELETON_TILE_CLS}></div>
      <div className="min-w-0 flex-1 space-y-2">
        <div className={`${SKELETON_LINE_CLS} ${TITLE_W[i % TITLE_W.length]}`}></div>
        <div className={`${SKELETON_SUBLINE_CLS} ${SUB_W[i % SUB_W.length]}`}></div>
      </div>
    </div>
  );
}

/**
 * `n` placeholder cards, pulsing together. `label` is what a screen reader
 * hears — the surfaces pass something more specific than "Loading" where
 * they can, since the board announces four of these at once.
 */
export function CardSkeleton({ n, label }: { n: number; label: string }): ReactNode {
  return (
    <>
      <div className="sr-only" role="status">{label}</div>
      <div className="space-y-2 animate-pulse" aria-hidden="true">
        {Array.from({ length: n }, (_, i) => <SkeletonCard key={i} i={i} />)}
      </div>
    </>
  );
}

/**
 * A count that has not arrived yet: a short pulsing bar where the `· 12`
 * goes. Rendering `· 0` instead is the specific lie this replaces.
 */
export function CountSkeleton(): ReactNode {
  return (
    <span
      className="inline-block align-middle w-4 h-3 rounded bg-zinc-200 dark:bg-zinc-800 animate-pulse"
      aria-hidden="true"
    ></span>
  );
}

/**
 * The board's four columns, which are FIXED and therefore knowable before any
 * fetch: `AppView._repaintDevBody` builds this same list every time.
 *
 * The skeleton names them rather than drawing four grey bars, and that is the
 * difference between "something is coming" and "this board has a Requests
 * column and it is filling". Only the counts are unknown, so only the counts
 * pulse — see `COUNT_BAR` below, the string form of <CountSkeleton/>.
 */
const KANBAN_COLS = ['Requests', 'Underway', 'Waiting for approval', 'Done'];

/** <CountSkeleton/> as a string, for the HTML builders below. */
const COUNT_BAR =
  '<span class="inline-block align-middle w-4 h-3 rounded bg-zinc-200 '
  + 'dark:bg-zinc-800 animate-pulse" aria-hidden="true"></span>';

/** One card's markup, shared by both string builders. */
function cardHtml(i: number): string {
  return `<div class="${SKELETON_CARD_CLS}">`
    + `<div class="${SKELETON_TILE_CLS}"></div>`
    + '<div class="min-w-0 flex-1 space-y-2">'
    + `<div class="${SKELETON_LINE_CLS} ${TITLE_W[i % TITLE_W.length]}"></div>`
    + `<div class="${SKELETON_SUBLINE_CLS} ${SUB_W[i % SUB_W.length]}"></div>`
    + '</div></div>';
}

/**
 * The KANBAN's loading state as an HTML string, for `#dev-body`'s initial
 * content on a board route.
 *
 * ── Why this exists at all ────────────────────────────────────────────
 *
 * `#dev-body` opened with `skeletonListHtml` on every route, so a cold load
 * of `/app/<slug>/board` painted a single column of three cards and THEN
 * became four columns when <DevKanban/> mounted — measured at ~270ms apart on
 * a throttled desktop, longer on a phone. A skeleton whose whole job is to
 * predict the shape of what is coming was predicting the wrong shape.
 *
 * ── It reuses the REAL classes, and that is the point ─────────────────
 *
 * `.dev-kanban-col` and the `#dev-kanban` wrapper carry their layout in
 * app.css, behind media queries: at >=640px every column sits in one row, and
 * below that all but `.dev-kanban-col-active` are `display:none` with a tab
 * strip above instead. Borrowing the classes means the skeleton is responsive
 * for free and CANNOT disagree with the real board about how many columns a
 * given width shows — which a hand-rolled grid would, the first time those
 * breakpoints moved.
 *
 * The first column carries `dev-kanban-col-active` for exactly that reason:
 * without it a phone would show no columns at all.
 *
 * No ids. The real board's `#dev-kanban` / `#dev-kanban-col-*` arrive when
 * <DevKanban/> replaces this, and two live elements answering one
 * `getElementById` for even a frame is not worth the tidiness.
 */
export function skeletonKanbanHtml(): string {
  const tabs = KANBAN_COLS.map((title, i) => (
    '<div class="dev-kanban-tab flex-1 basis-0 min-w-0 min-h-[44px] px-1 py-1.5 '
    + 'flex flex-col items-center justify-center rounded-full font-semibold '
    + (i === 0 ? SECTION_TAB_ACTIVE : 'text-zinc-500 dark:text-zinc-400')
    + '">'
    + `<span class="text-xs leading-tight truncate max-w-full">${title}</span>`
    + `<span class="font-mono text-[11px] leading-tight">${COUNT_BAR}</span>`
    + '</div>'
  )).join('');

  const cols = KANBAN_COLS.map((title, i) => (
    `<div class="dev-kanban-col${i === 0 ? ' dev-kanban-col-active' : ''}">`
    + '<div class="dev-kanban-col-head text-[0.9375rem] font-semibold '
    + 'text-zinc-500 dark:text-zinc-400 mb-2 px-0.5">'
    + `${title} <span class="text-zinc-500 dark:text-zinc-500 font-mono">· ${COUNT_BAR}</span>`
    + '</div>'
    + '<div class="space-y-2 animate-pulse" aria-hidden="true">'
    + cardHtml(i) + cardHtml(i + 1)
    + '</div></div>'
  )).join('');

  return '<div class="sr-only" role="status">Loading the board</div>'
    + '<div class="sm:hidden flex items-stretch gap-0.5 mb-2 rounded-full '
    + `bg-white dark:bg-zinc-900 p-0.5" aria-hidden="true">${tabs}</div>`
    + `<div class="flex gap-3 overflow-x-auto pb-2" aria-hidden="true">${cols}</div>`;
}

/**
 * The same rows as an HTML STRING, for `#dev-body`'s initial content —
 * board-frame.tsx writes that through `dangerouslySetInnerHTML` before any
 * of these components can mount, and this keeps the two from drifting
 * apart the first time the card geometry changes.
 */
export function skeletonListHtml(n: number): string {
  let rows = '';
  for (let i = 0; i < n; i += 1) rows += cardHtml(i);
  return '<div class="sr-only" role="status">Loading</div>'
    + `<div class="space-y-2 animate-pulse" aria-hidden="true">${rows}</div>`;
}
