/**
 * `#dev-workshop` — the Dev screen's lander, as the only React writer below
 * that host. The host ELEMENT stays app-view.js's (`_repaintDevBody`
 * creates it inside #dev-body); everything under it renders from
 * `devWorkshopStore`, which `AppView._workshopView()` publishes on every
 * board repaint.
 *
 * ── What it replaced ─────────────────────────────────────────────────
 *
 * The Activity feed: the board's cards newest-first, each with a comment
 * preview and a reply box. A stream is the right shape for "what just
 * happened" and the wrong one for "what is this project about", and the
 * second question is the one a newcomer and a returning member both ask
 * first. So the lander groups the SAME cards by theme — what the work is
 * about, drafted by a model and corrected by the group — and keeps the
 * feed's two answers as strips above the themes: proposals waiting on this
 * viewer's vote, and what changed since they were last here.
 *
 * ── The row is the card, folded ──────────────────────────────────────
 *
 * A theme lists its items as one-line rows. Tapping a row unfolds it into
 * the Activity entry it always was — the dense card, the GitHub comment
 * preview and the app's own thread with its reply box (./card/feed-thread.tsx)
 * — so a reply from here lands in the same thread the Board and the topic
 * page show. One row per theme is open at a time, because a theme with
 * every row unfolded is the stream this replaced. The row, the open sheet
 * and the fold between them are ../card/fold.tsx's, shared with the Board's
 * columns, which fold their cards the same way now.
 *
 * Two slots inside an unfolded row stay legacy-FILLED, rendered here once,
 * empty, with constant classNames — the same seam the feed had:
 *
 * - `.dev-feed-comments[data-comments-for]` — `AppView._wireFeedComments`
 *   fills each when its entry scrolls into view. Rows unfold AFTER the
 *   publish, so the component re-wires the host from an effect (a call by
 *   name, like the footer buttons make).
 * - `[data-kudos-host]` inside merged cards — `_fillKudosHosts` + Kudos.
 *
 * Both sizes carry the item's `data-issue-row` / `data-proposal-row` hooks,
 * and the delegated `#dev-body` handler stands aside for clicks inside a
 * fold wrapper (see fold.tsx's header); the item's full-screen route is the
 * link on the open card.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import {
  ArrowUpIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  NewspaperIcon,
  SpeechCheckIcon,
  Squares2X2Icon,
} from '@/components/ui/icons';

import { agoStamp } from '../../../lib/timestamp';
import { useStoreState } from '../../../lib/use-store-state';
import { devWorkshopStore } from '../card/cards-store';
import { DevCard } from '../card/dev-card';
import { DevKanban } from '../card/dev-kanban';
import { DevActionsRow } from '../actions-row';
import { useDevActions } from '../actions-store';
import { CardRowView, callAppView } from '../card/fold';
import type { DevWorkshopView, WorkshopTheme } from '../card/model';
import { CardSkeleton } from '../card/skeleton';
import { ProgressRing } from '@/components/ui/progress-ring';
import { useWorkshopGroup } from './group-mode-store';
import { readAskStream } from './ask-stream';

type SortKey = 'people' | 'activity' | 'open';
type TabKey = 'status' | 'needs' | 'all';

/**
 * The lander's three tabs, in the order a person needs them: where the app
 * is, what it needs from you, everything there is. The bar sits at the
 * BOTTOM — this is a phone screen first, and the three destinations are
 * navigation, not a control acting on what is above them.
 *
 * EACH CARRIES A GLYPH, AND KEEPS ITS WORDS. A bottom rail is scanned, not
 * read, and three same-weight phrases gave the eye nothing to aim at; the
 * label stays under the glyph because none of the three is conventional
 * enough to stand alone, and dropping it would cost the tab its accessible
 * name as well.
 *
 * Why these three. The newspaper is the week as written, which is what the
 * status tab is — a digest, not a dashboard. The grid is everything, in
 * whichever grouping you pick. The bubble-with-a-tick is drawn for this bar
 * (see icons.tsx): a plain bubble reads as "messages", which is the wrong
 * destination, and a bare tick reads as the state after you have answered
 * rather than the asking. `BoardIcon` was the other candidate for status and
 * lost twice — it is the Kanban glyph, so it collides with All items' own
 * By-stage pane, and its 4-unit-wide bars close up at this size.
 */
const TABS: { key: TabKey; label: string; Icon: typeof NewspaperIcon }[] = [
  { key: 'status', label: 'Current status', Icon: NewspaperIcon },
  { key: 'needs', label: 'Needs you', Icon: SpeechCheckIcon },
  { key: 'all', label: 'All items', Icon: Squares2X2Icon },
];

/** The swatch a name gets everywhere (feed-thread's rule, kept in step). */
function swatchFor(name: string): string {
  const palette = ['#0a6ee0', '#8e44ad', '#1f8a4c', '#b4620a', '#c0392b', '#0e7c86', '#6d4c41'];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}

// The shared ago ladder (#1808) — this file used to carry its own, with a
// 90-second "just now" and a 48-hour bucket that read "36h ago" where every
// other surface said "1d ago". Both call sites drop it into a SENTENCE, so
// the degraded form lands as "drafted Jun 16" rather than "drafted 84d ago",
// which is the point.
//
// The epoch guard stays: these two take a millisecond number that is 0 when
// the thing never happened, and `agoStamp(0)` is a 1970 date, not nothing.
function relTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  return agoStamp(ms).text;
}

function Lane({
  lane, slug, canPost, openKey, onToggle, themeId,
}: {
  lane: WorkshopTheme['lanes'][number];
  slug: string;
  canPost: boolean;
  openKey: string | null;
  onToggle: (key: string) => void;
  themeId: string;
}): ReactNode {
  // "Shipped this week" is the one lane that is a RECORD rather than a
  // question — nothing in it needs anybody — so a theme opens on the work
  // that still wants someone and keeps the record one tap away (#1787). The
  // hook runs before the early return below, because a hook may not be
  // conditional; the lane still renders nothing when it holds nothing.
  const collapsible = lane.key === 'shipped';
  const [laneOpen, setLaneOpen] = useState(!collapsible);
  if (!lane.rows.length && !lane.more) return null;
  const total = lane.rows.length + lane.more;
  return (
    <div className={`dev-ws-lane dev-ws-lane-${lane.key}`} data-ws-lane={lane.key}>
      {collapsible ? (
        <h4
          className="dev-ws-lane-title"
          role="button"
          tabIndex={0}
          aria-expanded={laneOpen}
          onClick={() => setLaneOpen(!laneOpen)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setLaneOpen(!laneOpen); } }}
        >
          <span className="dev-ws-dot" aria-hidden="true"></span>{lane.title}
          <span className="dev-ws-lane-n">{total}</span>
          <ChevronRightIcon className="dev-ws-chev" aria-hidden="true" />
        </h4>
      ) : (
        <h4 className="dev-ws-lane-title"><span className="dev-ws-dot" aria-hidden="true"></span>{lane.title}</h4>
      )}
      {!laneOpen ? null : lane.rows.map((row) => (row.t === 'card' ? (
        <CardRowView
          key={row.key}
          row={row}
          slug={slug}
          canPost={canPost}
          open={openKey === row.key}
          onToggle={() => onToggle(row.key)}
        />
      ) : null))}
      {laneOpen && lane.more ? <div className="dev-ws-more">{`+${lane.more} more in this lane`}</div> : null}
    </div>
  );
}

function Faces({ people }: { people: string[] }): ReactNode {
  const shown = people.slice(0, 4);
  const extra = people.length - shown.length;
  const [open, setOpen] = useState(false);
  if (!people.length) return null;
  return (
    <span className="dev-ws-faces-wrap">
      <button
        type="button"
        className="dev-ws-faces"
        aria-label={`Who is involved: ${people.join(', ')}`}
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
      >
        {shown.map((p) => (
          <span key={p} className="dev-ws-face" style={{ backgroundColor: swatchFor(p) }} title={p}>
            {p.slice(0, 1).toUpperCase()}
          </span>
        ))}
        {extra > 0 ? <span className="dev-ws-face dev-ws-face-more">{`+${extra}`}</span> : null}
      </button>
      {open ? (
        <span className="dev-ws-roster" role="tooltip">
          {people.map((p) => <span key={p} className="dev-ws-roster-row">{p}</span>)}
        </span>
      ) : null}
    </span>
  );
}

function ThemeCard({
  theme, slug, canPost, open, onToggle, openKey, onToggleRow,
}: {
  theme: WorkshopTheme;
  slug: string;
  canPost: boolean;
  open: boolean;
  onToggle: () => void;
  openKey: string | null;
  onToggleRow: (key: string) => void;
}): ReactNode {
  const c = theme.counts;
  const openItems = c.open + c.underway + c.review;
  const chips: ReactNode[] = [];
  if (c.fresh) chips.push(<span key="fresh" className="dev-ws-cnt dev-ws-cnt-fresh"><b>{`+${c.fresh}`}</b> new</span>);
  if (c.review) chips.push(<span key="review" className="dev-ws-cnt dev-ws-cnt-review"><span className="dev-ws-dot"></span><b>{c.review}</b> in review</span>);
  if (c.underway) chips.push(<span key="underway" className="dev-ws-cnt dev-ws-cnt-underway"><span className="dev-ws-dot"></span><b>{c.underway}</b> underway</span>);
  chips.push(<span key="open" className="dev-ws-cnt"><span className="dev-ws-dot"></span><b>{c.open}</b> open</span>);
  if (c.shipped) chips.push(<span key="shipped" className="dev-ws-cnt dev-ws-cnt-shipped"><span className="dev-ws-dot"></span><b>{c.shipped}</b> shipped this week</span>);

  // `counts` rather than `rows.length`: the lane caps its rows at
  // WORKSHOP_LANE_MAX, so a theme with twelve underway used to report eight.
  const bits: string[] = [];
  if (c.underway) bits.push(`${c.underway} underway`);
  if (c.review) bits.push(`${c.review} in review`);
  const quietDays = theme.lastActive ? Math.floor((Date.now() - theme.lastActive) / 86400000) : null;
  const hidden = theme.lanes.reduce((n, l) => n + l.more, 0);
  // "nobody building yet" said something this cannot know. The condition is
  // only that nothing is in flight RIGHT NOW — a theme that shipped a dozen
  // changes and has a quiet week reads identically to one nobody has ever
  // touched, and the "yet" told newcomers the second story about both. What
  // the data actually supports is the present tense, so that is what it says;
  // where the theme shipped something this week it can say that instead, which
  // is the same fact with the history the old line was inventing.
  const idle = c.shipped
    ? `${c.shipped} shipped this week, nothing in flight now`
    : (quietDays != null && quietDays > 14 ? `quiet for ${quietDays} days` : 'nothing in flight right now');
  const foot = `${theme.people.length} involved · ${bits.length ? bits.join(' · ') : idle}`;

  return (
    <article
      className={open ? 'dev-ws-theme dev-ws-theme-open' : 'dev-ws-theme'}
      data-ws-theme={theme.id}
      data-ws-ungrouped={theme.ungrouped ? '1' : undefined}
    >
      <div
        className="dev-ws-theme-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
      >
        {/* The model picks the glyph, so it means the part of the product
            rather than hashing to a stable-but-arbitrary one. With none —
            an older row, or an answer the sanitiser rejected — the theme's
            initial on its own swatch, which is the treatment `Faces` already
            uses and reads as deliberate where a random emoji would not. */}
        <div className="dev-ws-theme-name">
          {theme.icon
            ? <span className="dev-ws-theme-icon" aria-hidden="true">{theme.icon}</span>
            : (
              <span
                className="dev-ws-theme-icon dev-ws-theme-icon-letter"
                aria-hidden="true"
                style={{ backgroundColor: swatchFor(theme.name) }}
              >{theme.name.slice(0, 1).toUpperCase()}</span>
            )}
          {theme.name}
        </div>
        {/* Two stats, not one: how many people, and how big. `counts` is
            incremented before the lane cap in the publisher, so this is the
            theme's real size and not what happens to be drawn. SHIPPED is
            excluded on purpose — the question the number answers is "how
            much is left in here", and work that landed is not left. */}
        <div className="dev-ws-theme-people">
          <span className="dev-ws-stat"><b>{theme.people.length}</b>{theme.people.length === 1 ? 'person' : 'people'}</span>
          <span className="dev-ws-stat"><b>{openItems}</b>{openItems === 1 ? 'item' : 'items'}</span>
        </div>
        {theme.saying ? (
          <p className="dev-ws-theme-say">{theme.saying}</p>
        ) : (theme.description ? <p className="dev-ws-theme-say">{theme.description}</p> : null)}
        <div className="dev-ws-theme-counts">{chips}</div>
        <div className="dev-ws-theme-foot">
          <Faces people={theme.people} />
          <span className="flex-1 min-w-0 truncate">{foot}</span>
          <ChevronRightIcon className="dev-ws-chev" aria-hidden="true" />
        </div>
      </div>
      {open ? (
        <div className="dev-ws-theme-body">
          {theme.lanes.map((lane) => (
            <Lane
              key={lane.key}
              lane={lane}
              slug={slug}
              canPost={canPost}
              openKey={openKey}
              onToggle={onToggleRow}
              themeId={theme.id}
            />
          ))}
          {/* The whole theme on the Board, at the bottom of the theme rather
              than under whichever lane happened to overflow: the filter it
              applies is the theme's, not a lane's. */}
          <div className="dev-ws-theme-more">
            {hidden ? <span>{`+${hidden} not shown · `}</span> : null}
            <button type="button" className="dev-ws-link" onClick={() => callAppView('openBoardForTheme', theme.id)}>
              Open on Board ›
            </button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

/**
 * The footnote under the model's grouping: when the themes were drafted and
 * on what schedule, then how much of the board they hold right now — cards
 * on their way into a theme, cards the placer could not fit, and the last
 * failure if there was one. Each is a fact the viewer can see on the page
 * ("placing…" markers, the trailing group), so the note names it.
 */
function aiFootnote(meta: DevWorkshopView['meta'], written: boolean): string {
  const drafted = meta.discoveredAt ? Date.parse(meta.discoveredAt) : NaN;
  const parts: string[] = [
    Number.isFinite(drafted)
      ? `Categories were drafted ${relTime(drafted)} and are re-drafted daily, or sooner when a tenth of the board changes.`
      : 'Categories are drafted from the board and re-drafted daily, or sooner when a tenth of the board changes.',
  ];
  const c = meta.coverage;
  if (c && c.pending) parts.push(`${c.pending} new ${c.pending === 1 ? 'card is' : 'cards are'} being placed.`);
  if (c && c.unplaced) {
    parts.push(`${c.unplaced} ${c.unplaced === 1 ? 'card did' : 'cards did'} not fit a category and ${c.unplaced === 1 ? 'waits' : 'wait'} for the next draft.`);
  }
  if (meta.lastError) parts.push(`The last attempt failed (${meta.lastError}); it is retried shortly.`);
  return parts.join(' ');
}

/**
 * Which paragraph is at the top of the page, and why.
 *
 * This used to be two clauses of the category footnote under the themes,
 * which worked while the summary and the themes were on one scroll. They are
 * two TABS now, and an explanation of the summary sitting on the screen that
 * does not contain the summary explains nothing — so it moved to the
 * dashboard it is about.
 *
 * Without it the two failure states are indistinguishable on screen: a model
 * that has never run and one whose call keeps failing both leave the derived
 * sentence up there, and the only way to tell them apart was to read the
 * database.
 */
function digestNote(meta: DevWorkshopView['meta'], written: boolean): string {
  // The healthy case says NOTHING. It said "Written by the model on its last
  // pass over the board" — provenance under every board that was working,
  // answering a question nobody had asked and costing a line to do it.
  if (written) return '';
  if (meta.digestError) {
    // The failure that used to be a log line and a day of silence. Naming it
    // here is what turned "could something be up with the summarizer?" from a
    // question about the database into one the page answers.
    return `The model\u2019s summary could not be written (${meta.digestError}); it is retried within the hour, and this is worked out from the board meanwhile.`;
  }
  return 'Worked out from the board; the model writes one on the next pass.';
}

function sortThemes(themes: WorkshopTheme[], key: SortKey): WorkshopTheme[] {
  const list = themes.slice();
  const real = list.filter((t) => !t.ungrouped);
  const tail = list.filter((t) => t.ungrouped);
  if (key === 'people') real.sort((a, b) => (b.people.length - a.people.length) || (b.lastActive - a.lastActive));
  if (key === 'activity') real.sort((a, b) => (b.lastActive - a.lastActive) || (b.people.length - a.people.length));
  if (key === 'open') real.sort((a, b) => (b.counts.open - a.counts.open) || (b.lastActive - a.lastActive));
  return real.concat(tail);
}

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'people', label: 'By people' },
  { key: 'activity', label: 'By activity' },
  { key: 'open', label: 'By open items' },
];

type Dash = NonNullable<DevWorkshopView['dashboard']>;

/** The rate, as a sentence: this week's merges against last week's. */
function pace(d: Dash): string {
  const n = d.shippedWeek;
  const p = d.shippedPrevWeek;
  // ── Why a partial history states no rate ──────────────────────────
  //
  // Both weeks are counted from the SAME page of merged history, and when
  // there is more behind it the earlier week is the one more likely to fall
  // off the end. So a truncated page reads as a drought that never happened:
  // an app merging twenty changes a week was told "20 landed this week, the
  // first in a fortnight", which is not a hedge away from true, it is
  // backwards. `At least` was already on the COUNT and it was never enough,
  // because the fault is in the COMPARISON.
  //
  // With a partial page the honest sentence is the floor and nothing else.
  if (d.partial) {
    if (!n) return 'Nothing has landed this week.';
    return `At least ${n} ${n === 1 ? 'change' : 'changes'} landed this week.`;
  }
  if (!n && !p) return 'Nothing has landed in the last fortnight.';
  if (!p) return `${n} ${n === 1 ? 'change' : 'changes'} landed this week, the first in a fortnight.`;
  if (n > p) return `${n} landed this week, up from ${p} the week before.`;
  if (n < p) return `${n} landed this week, down from ${p} the week before.`;
  return `${n} landed this week, the same as the week before.`;
}

/**
 * The app in two sentences, written by the model on the same reconcile that
 * drafted the themes — from the same board snapshot, so the paragraph and the
 * grouping under it can never describe different boards. `describe()` below is
 * what runs when there is none: no model configured, no draft yet, or that one
 * call failed. Same relationship the category grouping has to the themes.
 */
/**
 * The four numbers, as tiles.
 *
 * They were prose ("58 open items across 11 themes... 4 proposals are waiting
 * on votes and 19 open items have nobody on them"), which is the slowest
 * possible way to read four integers and the reason the paragraph never got
 * to say anything else. A tile is scanned; a clause has to be parsed.
 *
 * These four and not others: they are the ones somebody arriving asks. How
 * much is open, is it moving, is anything blocked on ME, and is anything
 * going begging. `themes` and `people` are already on screen — the sort bar
 * counts the themes, and every theme header carries its own roster.
 *
 * "Shipped this week" wears a `+` when the merged history is paged, because
 * the number is then a floor and not a total. That is the same fact `pace()`
 * refuses to compare on, said in one character.
 */
function DashTiles({ d }: { d: Dash }): ReactNode {
  const cells: { key: string; n: number; label: string; cls?: string; title?: string }[] = [
    { key: 'open', n: d.open, label: d.open === 1 ? 'open item' : 'open items' },
    {
      key: 'shipped',
      n: d.shippedWeek,
      label: 'shipped this week',
      cls: d.shippedWeek ? 'dev-ws-dash-good' : undefined,
      title: d.partial ? 'At least this many: the merged history is longer than the page loaded.' : undefined,
    },
    {
      key: 'votes',
      n: d.votesWaiting,
      label: d.votesWaiting === 1 ? 'waiting on a vote' : 'waiting on votes',
      cls: d.votesWaiting ? 'dev-ws-dash-warn' : undefined,
    },
    { key: 'unclaimed', n: d.unclaimed, label: 'with nobody on them' },
  ];
  return (
    <div className="dev-ws-dash" data-ws-dash="">
      {cells.map((c) => (
        <span
          key={c.key}
          className={c.cls ? `dev-ws-dash-cell ${c.cls}` : 'dev-ws-dash-cell'}
          data-ws-dash-cell={c.key}
          title={c.title}
        >
          <b>{c.key === 'shipped' && d.partial && c.n ? `${c.n}+` : c.n}</b>
          {c.label}
        </span>
      ))}
    </div>
  );
}

/**
 * The three cards: what landed last week, what has landed this week, what
 * the open work is about — one model-written line each, under a title.
 *
 * They replaced a single paragraph that was answering all three questions at
 * once, and answering them badly: asked to cover a week, its meaning and the
 * work in flight inside 100 words, the model picked a headline and
 * generalised from the top of its list. Three fields give each window its own
 * sentence and its own budget, and — the half that actually fixed the
 * accuracy — its own complete input, fetched per calendar week rather than
 * filtered out of a board snapshot that was capped at a hundred merges.
 *
 * A window that held nothing gets no card, which is what the empty string
 * from the server means. All three empty is not a card set at all (the
 * client's normaliser returns null), so the pane falls through to the
 * paragraph and then to the derived sentence, and never renders an empty box.
 */
/** "Aug 25 – Aug 31" for a window whose `endMs` is the Monday after it. */
function weekRange(startMs: number, endMs: number): string {
  const fmt = (ms: number) => new Date(ms)
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  // `endMs` is EXCLUSIVE — the next Monday — so the caption names the Sunday
  // before it. Captioning a Monday–Sunday week with two Mondays is the kind
  // of off-by-one a reader notices and cannot explain.
  return `${fmt(startMs)} – ${fmt(endMs - 86400000)}`;
}

/**
 * The weeks, as a walk backwards from now.
 *
 * All three windows used to be drawn at once, and three was the whole
 * history the lander could hold: a reader who wanted the week before last
 * had nowhere to go, and a reader who wanted none of them still paid three
 * cards of vertical space before reaching the board.
 *
 * So the present is the default — `Open issues`, the one entry that is not a
 * week at all — and everything earlier is one step behind a button. Each
 * press reveals the next-oldest window BELOW the stack, and the control
 * moves down with it. It grew upwards first, on the reasoning that a column
 * of dated cards reads oldest-at-the-top like any timeline. It does, but
 * this is not a timeline being read: it is one card with a way to ask for
 * more, and growing upwards pushed the card you were looking at further
 * down the screen on every press. Downwards, the present stays where it is
 * and the history unrolls under it.
 *
 * The walk ends where the server's lines end. When the server has also said
 * when the app's first week was (`firstWeek`) and the walk has reached it,
 * the pane says so — otherwise running out of lines is silent, because "no
 * more written yet" and "no more to write" are different facts and only one
 * of them is the app's beginning.
 */
function WeekWalk({ weeks, firstWeek, note }: {
  weeks: Dash['weeks'];
  firstWeek: number | null;
  /** Why the summary is what it is, when something is wrong with it. */
  note?: string;
}): ReactNode {
  // How many entries from the END of the list are on screen. The list is
  // oldest-first, so one means `open` alone.
  const [shown, setShown] = useState(1);
  if (!weeks.length) return null;
  const drawn = weeks.slice(0, shown);
  const more = weeks.length - drawn.length;
  const oldest = drawn[drawn.length - 1];
  const atStart = !more && !!firstWeek && !!oldest && oldest.startMs === firstWeek;
  return (
    <div className="dev-ws-cards" data-ws-cards="">
      {drawn.map((w) => (
        <article key={w.key} className="dev-ws-card" data-ws-card={w.key}>
          <h4 className="dev-ws-card-title">
            {w.title}
            {/* The dates only where the NAME stops being one. "This week" and
                "Last week" are unambiguous to anyone reading them on the day;
                "4 weeks ago" is a count the reader would otherwise have to do
                the arithmetic for. */}
            {w.startMs && w.key.startsWith('week:')
              ? <span className="dev-ws-card-range">{weekRange(w.startMs, w.endMs)}</span>
              : null}
          </h4>
          <p className="dev-ws-card-line">{w.line}</p>
        </article>
      ))}
      {note ? <p className="dev-ws-digest-note" data-ws-digest-note="">{note}</p> : null}
      {more ? (
        <button
          type="button"
          className="dev-ws-reveal dev-ws-week-more"
          data-ws-week-more=""
          onClick={() => setShown(shown + 1)}
        >
          {/* Pointing DOWN, because that is where the window it reveals
              appears — under the card you are reading, not above it. */}
          <ChevronDownIcon className="dev-ws-reveal-chev" aria-hidden="true" />
          Show past week
        </button>
      ) : null}
      {atStart ? (
        <p className="dev-ws-week-note" data-ws-week-start="">The first week this app had any activity.</p>
      ) : null}
    </div>
  );
}

/**
 * The paragraph, for a board whose row predates the cards. `d.summary` is the
 * three lines flattened, which is all a row last written under the previous
 * digest prompt has; `describe` is the derived sentence under that again.
 */
function summarise(d: Dash): string {
  return d.summary || describe(d);
}

/**
 * The derived sentence — what the pane says when the model has not written
 * one.
 *
 * Round four cut this down to the two things the tiles cannot show and let
 * it return an EMPTY string when it could say neither, on the reasoning that
 * a blank beats prose repeating the numbers directly above it. That was
 * right about the duplication and wrong about the outcome: the model
 * paragraph is written on a reconcile pass, an app can sit for a long time
 * without one, and what a reader actually got was a pane with a heading, four
 * tiles and nothing that reads like a sentence — which looks like a broken
 * feature rather than a deliberate silence.
 *
 * So the full sentence is back, as the FALLBACK only. When the model has
 * written a paragraph that paragraph stands alone and states no counts (the
 * prompt spends most of its length on that). When it has not, this repeats
 * two of the tiles and is worth it, because the alternative is a blank.
 *
 * The footnote at the bottom of the lander says which of the two is on
 * screen, so "the summarizer looks broken" and "no draft yet" are
 * distinguishable without reading the database.
 */
function describe(d: Dash): string {
  const parts: string[] = [];
  const scale = `${d.open} open ${d.open === 1 ? 'item' : 'items'}`
    + (d.themes ? ` across ${d.themes} ${d.themes === 1 ? 'category' : 'categories'}` : '');
  parts.push(d.busiest ? `${scale}, most of the movement in ${d.busiest}.` : `${scale}.`);
  parts.push(pace(d));
  const waiting: string[] = [];
  if (d.votesWaiting) {
    waiting.push(`${d.votesWaiting} ${d.votesWaiting === 1 ? 'proposal is' : 'proposals are'} waiting on votes`);
  }
  if (d.unclaimed) {
    waiting.push(`${d.unclaimed} open ${d.unclaimed === 1 ? 'item has nobody on it' : 'items have nobody on them'}`);
  }
  if (waiting.length) parts.push(`${waiting.join(' and ').replace(/^./, (c) => c.toUpperCase())}.`);
  return parts.join(' ');
}

/** "1 change landed, 2 new proposals" — what moved while you were away. */
function sinceWords(s: NonNullable<DevWorkshopView['since']>): string {
  if (!s.rows.length) return 'nothing has changed';
  const bits = [
    s.shipped ? `${s.shipped} ${s.shipped === 1 ? 'change' : 'changes'} landed` : null,
    s.opened ? `${s.opened} new ${s.opened === 1 ? 'issue' : 'issues'}` : null,
    s.proposed ? `${s.proposed} new ${s.proposed === 1 ? 'proposal' : 'proposals'}` : null,
  ].filter(Boolean);
  return bits.length ? bits.join(', ') : `${s.rows.length} things moved`;
}

/**
 * The vote badge: a ring, beside the heading whose lane it counts.
 *
 * It was "4 to vote on" in the warning tint, which stated a debt. The ring
 * says the same population as PROGRESS — how many of the app's open
 * proposals this viewer has answered — using the primitive the home
 * screen's Challenges block uses.
 *
 * A ring alone is a fraction with no subject: "0/5" does not say what the
 * five are, and a reader should not have to hover a donut to find out. So
 * the words are still there (`voteWords` below) — under the deck's own
 * heading in the `Needs you` tab, which is where the ring went when voting
 * became a screen of its own rather than one lane of three.
 *
 * There is no × any more. A count that can be closed is a count somebody
 * stops seeing while it is still true, and this one is the whole reason the
 * pane exists.
 */
function voteWords(owed: number): string {
  return `${owed} ${owed === 1 ? 'proposal needs' : 'proposals need'} your vote`;
}

function VoteRing({ owed, total }: { owed: number; total: number }): ReactNode {
  const done = Math.max(0, total - owed);
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <ProgressRing
      className="dev-ws-vote-ring"
      pct={pct}
      label={`${done}/${total}`}
      title={`${done} of ${total} open proposals voted on`}
      arcClassName={owed ? 'stroke-amber-500' : 'stroke-emerald-500'}
    />
  );
}

/**
 * One offer at a time, paged sideways.
 *
 * "Needs your vote" and "Nobody has picked this up" were vertical lists with
 * a "N more" button under each, so a viewer owing four votes read a column
 * four cards tall before reaching anything else — and the pane's whole claim
 * is that it holds what you could do in five minutes, which is ONE thing.
 * Paged, the strip is a constant height whatever it holds, and the count is
 * in the control rather than in the scroll.
 *
 * It is a real horizontal SCROLLER, not a swap of one rendered row:
 *
 *   - every row stays in the DOM, so the two legacy fillers keep finding
 *     their hosts (`_wireFeedComments` observes `.dev-feed-comments` and
 *     `_fillKudosHosts` fills `[data-kudos-host]`) and the `?shot=` deep
 *     link can still name a row that is not the visible one;
 *   - a touch drag pages it for free, with `scroll-snap`, which is the
 *     gesture the surface already invites on a phone.
 *
 * The buttons drive `scrollTo` and the index is read back from the scroll
 * position, so a swipe and a press cannot disagree about which card is up.
 */
function RowPager({
  rows, scope, title, titleExtra, note, slug, canPost, openKey, onToggle,
}: {
  rows: DevWorkshopView['votes']['rows'];
  scope: string;
  /** The lane's heading. The pager owns it, because the control rides it. */
  title: string;
  /** A badge that belongs to the heading itself, after the words. */
  titleExtra?: ReactNode;
  /** The line under the heading, where a lane has one. */
  note?: string;
  slug: string;
  canPost: boolean;
  openKey: string;
  onToggle: (key: string) => void;
}): ReactNode {
  const trackRef = useRef<HTMLDivElement>(null);
  const [i, setI] = useState(0);
  const cards = rows.filter((r) => r.t === 'card');
  if (!cards.length) return null;
  const go = (n: number) => {
    const t = trackRef.current;
    const at = Math.max(0, Math.min(cards.length - 1, n));
    setI(at);
    if (t) t.scrollTo({ left: at * t.clientWidth, behavior: 'smooth' });
  };
  const onScroll = () => {
    const t = trackRef.current;
    if (!t || !t.clientWidth) return;
    const at = Math.round(t.scrollLeft / t.clientWidth);
    if (at !== i) setI(Math.max(0, Math.min(cards.length - 1, at)));
  };
  return (
    <>
      {/* The control rides the HEADING, not the space under the deck. Below
          the card it was a free-floating row of three small things with a
          card above and a heading below, belonging to neither; on the
          heading it is plainly the control FOR this lane, and the deck and
          the lane under it stay one block. */}
      <div className="dev-ws-lane-head">
        <h4 className="dev-ws-lane-title">
          <span className="dev-ws-dot" aria-hidden="true"></span>{title}
          {titleExtra}
        </h4>
        {cards.length > 1 ? (
          <div className="dev-ws-pager-ctl" data-ws-pager-ctl="">
            <button
              type="button"
              className="dev-ws-pager-btn"
              aria-label="Previous"
              disabled={i === 0}
              onClick={() => go(i - 1)}
            ><ChevronLeftIcon className="dev-ws-pager-chev" aria-hidden="true" /></button>
            <span className="dev-ws-pager-n">{`${Math.min(i + 1, cards.length)} of ${cards.length}`}</span>
            <button
              type="button"
              className="dev-ws-pager-btn"
              aria-label="Next"
              disabled={i >= cards.length - 1}
              onClick={() => go(i + 1)}
            ><ChevronRightIcon className="dev-ws-pager-chev" aria-hidden="true" /></button>
          </div>
        ) : null}
      </div>
      {note ? <p className="dev-ws-lane-note">{note}</p> : null}
      <div className="dev-ws-pager" data-ws-pager={scope}>
        <div className="dev-ws-pager-track" ref={trackRef} onScroll={onScroll}>
          {cards.map((row) => (
            <div className="dev-ws-pager-item" key={row.key}>
              <CardRowView
                row={row}
                slug={slug}
                canPost={canPost}
                open={openKey === row.key}
                onToggle={() => onToggle(row.key)}
              />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

/**
 * `Needs you` — one question, filling the screen.
 *
 * The lander's other two tabs are things you READ. This one is a thing you
 * ANSWER, and it is built to make that the only thing on offer: one proposal
 * at a time, the whole screen, no list to skim past it and nothing else
 * competing for the tap. A deck of decisions rather than a page about them.
 *
 * ── Two panes, and why the bottom one grows ──────────────────────────
 *
 * The top pane is the thing being asked about; the bottom is where you can
 * ask about it. It opens at a third of the height — enough to say it is
 * there and to take a question — and grows to half once you have asked
 * something, because from that point the conversation is what you are
 * reading and the card is context for it. It stops at half: the card is the
 * subject, and a chat that swallows its own subject is a chat about nothing.
 *
 * ── The card leads with the SUMMARY, not the title ───────────────────
 *
 * A card's title is a pull-request title. `pr_summary_md` is the sentence
 * written for the person voting — what changes for somebody using the app —
 * and on a screen whose whole job is a decision, that is the first thing
 * that should be read. A proposal without one says so rather than leaving a
 * gap, because "no summary was written" is a fact a voter should have.
 *
 * ── What the chat answers, and what it is not ────────────────────────
 *
 * `POST /api/apps/:slug/workshop/ask` — one question about the card in
 * front of you, answered from what the SERVER knows about that card. It is
 * not the app's LLM proxy (that is for apps, billed to their own budgets)
 * and it is not `dev-chat` (that is the agent's session transcript).
 *
 * The request carries an ADDRESS and a question: `row.askAbout` is a kind
 * and a reference, and the server looks the item up from that pair. Nothing
 * this component says about the card reaches the model — see
 * services/workshop-ask.js for why that boundary is where it is.
 *
 * Each press is an LLM call billed to the asker, so the route is rate
 * limited per user and a failure is SHOWN rather than swallowed: a voter
 * who thinks they have an answer and does not is the one bad outcome here.
 *
 * ── The thread is the SERVER'S, and it is private ────────────────────
 *
 * Each exchange is stored per viewer per card (workshop_ask_messages,
 * `staging:private`), so walking back to a card brings its conversation
 * with it. Two consequences worth knowing here:
 *
 * It is loaded in an EFFECT and never in the initial render — the shell's
 * rule for a stateful island, because a first paint that differs from the
 * shipped markup is a hydration mismatch and a console error, which fails
 * proposal checks.
 *
 * And this component no longer sends its transcript back as history. The
 * server reads the thread it wrote, which is both why a reload keeps the
 * conversation and why nobody can put words in their own mouth — or the
 * model's — and have them replayed as established context.
 *
 * Nothing here is shared: a voter's questions about a change they have not
 * voted on say what they are unsure about, and only they can read them.
 */
/** One turn in the ask box. `pending` is the answer still being written. */
type AskMsg = { who: 'you' | 'ai'; text: string; pending?: boolean; failed?: boolean };

/**
 * The classes for one turn. Complete literals, never assembled from parts:
 * Tailwind's extractor is a regex over source text, and `dev-ws-ask-*` is
 * hand-written CSS whose rules an editor greps for the same way.
 */
function askMsgClass(m: AskMsg): string {
  if (m.who === 'you') return 'dev-ws-ask-msg dev-ws-ask-you';
  if (m.pending) return 'dev-ws-ask-msg dev-ws-ask-ai dev-ws-ask-pending';
  if (m.failed) return 'dev-ws-ask-msg dev-ws-ask-ai dev-ws-ask-failed';
  return 'dev-ws-ask-msg dev-ws-ask-ai';
}

function NeedsDeck({
  rows, owed, total, models, slug,
}: {
  rows: DevWorkshopView['queue'];
  owed: number;
  total: number;
  models: DevWorkshopView['models'];
  slug: string;
}): ReactNode {
  // THE DECK KEEPS ITS ORDER. Skip used to send a card to the back, which was
  // the only way to come back to something without losing your place; with
  // arrows you walk back to it yourself, and a deck that reorders itself as
  // you browse is one you can never reach the end of.
  const cards = rows.filter((r) => r.t === 'card');
  const [at, setAt] = useState(0);
  // Keyed by row, so moving to the next proposal does not carry the last
  // one's conversation with it.
  const [threads, setThreads] = useState<Record<string, AskMsg[]>>({});
  const [draft, setDraft] = useState('');
  // Which row has a question in flight. Keyed like the threads rather than a
  // bare boolean: the arrows still work while an answer is coming, and an
  // answer that lands after you have walked to the next card belongs to the
  // card it was asked about.
  const [asking, setAsking] = useState<Record<string, boolean>>({});
  // Which rows have had their stored thread fetched. Marked BEFORE the
  // request goes out, so moving away and back does not fire a second one,
  // and so a row whose fetch failed is not retried on every render.
  //
  // A REF, NOT STATE, and that is load-bearing rather than an optimisation.
  // As state it would have to be a dependency of the effect that writes it,
  // and then: the effect runs, sets it, the new object re-renders, the
  // dependency has changed, React tears the effect down — running the
  // cleanup that marks the in-flight request stale — and the response is
  // discarded on arrival. Every time. A ref changes no identity and appears
  // in no dependency list, so the effect runs exactly once per row.
  const loadedRef = useRef<Set<string>>(new Set());
  // Which model answers. The dev session's own list and its own default —
  // see `_workshopModels`. It appears when the box is in use, because a
  // picker over an empty composer is a setting nobody has a use for yet.
  const [model, setModel] = useState<string>(() => models.selected || '');
  const [focused, setFocused] = useState(false);
  // Answered here, this session: an answer moves the deck on, and the card
  // stays in the list so a mis-tap can be walked back to.
  const [answered, setAnswered] = useState<Record<string, string>>({});

  if (!cards.length) {
    return (
      <div className="dev-ws-needs dev-ws-needs-done" data-ws-needs="">
        <p className="dev-ws-needs-done-line">Nothing is waiting on you.</p>
        <p className="dev-ws-needs-done-sub">
          Every proposal you can vote on has your answer, and every open issue has somebody on it.
        </p>
      </div>
    );
  }

  const i = Math.min(at, cards.length - 1);
  const row = cards[i];
  const thread = threads[row.key] || [];
  const engaged = thread.length > 0;
  const answer = (which: string, act: { fn: string; args: unknown[] } | null) => {
    if (act) callAppView(act.fn, ...(act.args as unknown[]));
    setAnswered((cur) => ({ ...cur, [row.key]: which }));
    // A beat before the next question, so the press is SEEN. Advancing on
    // the same frame made a vote feel like the card had simply vanished,
    // with nothing to say whether it had registered.
    if (i < cards.length - 1) window.setTimeout(() => setAt(i + 1), 550);
  };
  /**
   * Moving through the deck, which is a separate act from answering it.
   *
   * The two rows say so: the top one is what you can DO about this card, the
   * bottom one is which card you are looking at. Skip used to sit among the
   * answers and was neither — it read as a third verdict while doing nothing
   * but advancing, and it could only ever go forwards.
   *
   * No wrap. The ends are the ends, and the counter above says which one you
   * are at; an arrow that silently returns you to the first card is how you
   * lose track of a queue you are working through.
   */
  const go = (delta: number) => setAt(Math.min(Math.max(i + delta, 0), cards.length - 1));
  // The verbs, per kind. "Yes" over a card is only clear if you already
  // know what the card is asking; "Vote yes" and "I'll take it" say what
  // the press DOES, which is the thing a first-time reader is missing.
  // A CLAIM HAS TWO ANSWERS. "Not me" and "Skip" were the same press wearing
  // two labels — neither recorded anything, both moved the deck on — and
  // offering them side by side asked the reader to tell apart a distinction
  // the app does not make. A vote keeps three, because there yes and no are
  // both real, recorded acts and skip is the third thing.
  const verbs = row.kind === 'vote'
    ? { yes: 'Vote yes', no: 'Vote no' }
    : { yes: "Let's take it", no: null };
  const done = answered[row.key];
  const target = row.askAbout || null;
  const inFlight = !!asking[row.key];

  /**
   * Bring back what this viewer already asked about this card.
   *
   * In an effect and never in render, which is the shell's rule for a
   * stateful island: the first paint has to be the empty pane the
   * hand-written markup shipped, or hydration mismatches and a console
   * error fails the proposal checks.
   *
   * It never overwrites a thread that already has turns in it. The local
   * copy is the live one — a question asked while this was in flight would
   * otherwise vanish when the stored (older) version landed on top of it.
   */
  useEffect(() => {
    if (!target || loadedRef.current.has(row.key)) return undefined;
    const key = row.key;
    const { kind, ref } = target;
    let live = true;
    loadedRef.current.add(key);
    const qs = `kind=${encodeURIComponent(kind)}&ref=${encodeURIComponent(String(ref))}`;
    fetch(`/api/apps/${encodeURIComponent(slug)}/workshop/ask/thread?${qs}`, {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!live || !data || !Array.isArray(data.messages) || !data.messages.length) return;
        setThreads((cur) => {
          if (cur[key] && cur[key].length) return cur;
          return {
            ...cur,
            [key]: data.messages.map((m: { who?: string; text?: string }) => ({
              who: m.who === 'ai' ? 'ai' as const : 'you' as const,
              text: String(m.text || ''),
            })),
          };
        });
      })
      // A thread that will not load is a pane with no history in it, which
      // is the state it opens in anyway. Nothing to say to the reader.
      .catch(() => {});
    return () => { live = false; };
    // PRIMITIVES ONLY. `target` is an object off the view model, and a
    // republish that rebuilds it with the same contents would otherwise
    // count as a change, tear the effect down and strand the request in
    // flight exactly as the state version did.
  }, [slug, row.key, target?.kind, target?.ref]);
  /**
   * Send one question and write the answer in under it.
   *
   * THE ROW IS CAPTURED, not read back at resolve time. The arrows stay live
   * while an answer is on its way, so by the time it lands the deck may be
   * showing a different card — and an answer about proposal A appended to
   * proposal B's thread is worse than no answer at all. `key` and `sending`
   * are both closed over for that reason.
   *
   * The pending row is a real message rather than a spinner beside the box:
   * it holds the place the answer will occupy, so the pane does not jump
   * when it arrives, and it reads as "this is coming" rather than "the
   * button did nothing".
   */
  const ask = async () => {
    const q = draft.trim();
    if (!q || !target || inFlight) return;
    const key = row.key;
    const sending = row;
    const prior = threads[key] || [];
    setThreads((cur) => ({
      ...cur,
      [key]: [...prior, { who: 'you', text: q }, { who: 'ai', text: 'Reading the change…', pending: true }],
    }));
    setAsking((cur) => ({ ...cur, [key]: true }));
    setDraft('');

    // Writes the trailing bubble in place. Every update goes through here
    // so there is one rule about which bubble is being written: the LAST
    // one on this row's thread, and only while it is still pending.
    const writeTail = (patch: AskMsg) => setThreads((cur) => {
      const t = cur[key];
      if (!t || !t.length) return cur;
      const last = t.length - 1;
      if (!t[last].pending) return cur;
      const next = t.slice();
      next[last] = patch;
      return { ...cur, [key]: next };
    });

    let text: string;
    let failed = false;
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(slug)}/workshop/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        credentials: 'same-origin',
        body: JSON.stringify({
          // No transcript rides along. The server keeps this viewer's own
          // thread and reads it back itself, so the history cannot be
          // rewritten by whoever is asking.
          target: sending.askAbout,
          question: q,
          model: model || undefined,
        }),
      });

      // A refusal the server could make BEFORE opening the stream is still
      // ordinary JSON with a real status, so that shape is handled first.
      const isStream = (res.headers.get('content-type') || '').includes('text/event-stream');
      if (!res.ok || !isStream || !res.body) {
        const data = await res.json().catch(() => ({}));
        failed = true;
        // The server's own sentence wherever it wrote one: it is the only
        // thing that can say WHICH of "you are out of allowance", "too many
        // at once" and "no model is configured" happened, and a generic
        // "something went wrong" would hide the two the reader can act on.
        text = (typeof data.error === 'string' && data.error.trim())
          ? data.error.trim()
          : 'That did not go through. Try asking again.';
      } else {
        const parsed = await readAskStream(res.body, (sofar) => {
          // Still pending while it grows: the bubble keeps its live styling
          // until `done` says the answer is complete.
          writeTail({ who: 'ai', text: sofar, pending: true });
        });
        if (parsed.error) {
          failed = true;
          text = parsed.error;
        } else if (parsed.text.trim()) {
          // `done`'s assembled text wins over what was accumulated — a
          // dropped chunk costs a flicker rather than a wrong answer.
          text = parsed.text.trim();
        } else {
          failed = true;
          text = 'That did not go through. Try asking again.';
        }
      }
    } catch {
      failed = true;
      text = 'That did not go through. Check your connection and try again.';
    }

    writeTail({ who: 'ai', text, failed });
    setAsking((cur) => {
      const next = { ...cur };
      delete next[key];
      return next;
    });
  };

  return (
    <div
      className={engaged ? 'dev-ws-needs dev-ws-needs-engaged' : 'dev-ws-needs'}
      data-ws-needs=""
      data-ws-engaged={engaged ? '' : undefined}
    >
      <section className="dev-ws-needs-subject">
        <div className="dev-ws-needs-head">
          <span className="dev-ws-eyebrow">{owed ? voteWords(owed) : 'Nothing owed'}</span>
          {total ? <VoteRing owed={owed} total={total} /> : null}
        </div>
        {/* The card, then the sentence explaining it. The summary led at
            first, which put the explanation above the thing it explains and
            made the card read as a footnote to its own description. */}
        <div className="dev-ws-needs-scroll">
          <DevCard model={row.card} />
          {row.kind === 'vote' ? (
            row.summary
              ? <p className="dev-ws-needs-summary">{row.summary}</p>
              : (
                <p className="dev-ws-needs-summary dev-ws-needs-nosummary">
                  No plain-language summary was written for this change.
                </p>
              )
          ) : null}
        </div>
        {/* The question, and the three answers to it. Big, because this is
            the one thing the screen is for and a decision should not be a
            small target; and three rather than two, because "not now" is a
            real answer and a queue that only accepts yes or no is answered
            carelessly. */}
        <div className="dev-ws-answer" data-ws-answer="">
          <p className="dev-ws-ask-q">{row.ask}</p>
          <div className="dev-ws-answer-row">
            <button
              type="button"
              className="dev-ws-answer-btn dev-ws-answer-yes"
              data-ws-answer-btn="yes"
              disabled={!row.yes}
              aria-pressed={done === 'yes'}
              onClick={() => answer('yes', row.yes ? row.yes.act : null)}
            >{done === 'yes' ? `${verbs.yes} ✓` : verbs.yes}</button>
            {verbs.no ? (
            <button
              type="button"
              className="dev-ws-answer-btn dev-ws-answer-no"
              data-ws-answer-btn="no"
              disabled={!row.no}
              aria-pressed={done === 'no'}
              onClick={() => answer('no', row.no ? row.no.act : null)}
            >{done === 'no' ? `${verbs.no} ✓` : verbs.no}</button>
            ) : null}
          </div>
          {/* ── The second row: WHICH card, not what about it ──────────────
              Two rows because they are two different questions. The top one
              is what you can do about the thing in front of you and every
              press there records something; this one only changes what is in
              front of you, and records nothing. Skip used to sit among the
              answers and belonged to neither: it read as a third verdict
              while doing nothing but advancing, and it could only go
              forwards, so a card passed by accident was gone.

              Disabled at the ends rather than wrapping. The counter above
              says which end you are at, and an arrow that silently returns
              you to the first card is how you lose your place in a queue you
              are working through. */}
          <div className="dev-ws-move-row" data-ws-move-row="">
            <button
              type="button"
              className="dev-ws-move-btn"
              data-ws-move="prev"
              disabled={i <= 0}
              onClick={() => go(-1)}
            ><ChevronLeftIcon className="dev-ws-move-icon" aria-hidden="true" />Previous</button>
            {/* THE COUNT LIVES HERE NOW, not in the eyebrow. It is the answer
                to "where am I", which is the question these two buttons
                change — and up there it was a second small number competing
                with the sentence that says how many need you. It also fills
                the gap the edge-anchored boxes leave. */}
            <span className="dev-ws-needs-of">{`${i + 1} / ${cards.length}`}</span>
            <button
              type="button"
              className="dev-ws-move-btn"
              data-ws-move="next"
              disabled={i >= cards.length - 1}
              onClick={() => go(1)}
            >Next<ChevronRightIcon className="dev-ws-move-icon" aria-hidden="true" /></button>
          </div>
        </div>
      </section>

      {/* Until you use it, this is ONE ROW — the box and nothing else. It
          opened as a third of the screen with a heading and a hint in it,
          which spent a third of a decision screen on an invitation nobody
          had accepted. It earns its height when it is used. */}
      <section className="dev-ws-ask" data-ws-ask="">
        {engaged ? (
          <div className="dev-ws-ask-log">
            {thread.map((m, n) => (
              <p
                key={n}
                className={askMsgClass(m)}
                /* The answer is the one thing here nobody in this app wrote,
                   so it is announced: a reader on a screen reader otherwise
                   has no way to know the reply has arrived. Polite, not
                   assertive — it must not cut across the card's own text. */
                aria-live={m.who === 'ai' ? 'polite' : undefined}
              >
                {m.text}
              </p>
            ))}
          </div>
        ) : null}
        {/* THE DEV SESSION'S COMPOSER, as far as this pane needs it:
            `.dc-card` is the white surface with the field and one row of
            controls under it, `.dc-model-select` / `.dc-model-name` the
            stripped model button, `.dc-send-btn .dc-circle-send` the pale
            blue circle with its halo. Three shared classes rather than three
            approximations of them — the alternative drifts away from the
            composer the first time either is tuned.

            The one thing not shared is the model MENU: the session opens the
            native kit's sheet from a <button>, and this is a <select>, which
            is why the caret is a sibling rather than a child. */}
        <form
          className="dev-ws-ask-composer dc-card"
          onSubmit={(e) => { e.preventDefault(); ask(); }}
        >
          <label className="sr-only" htmlFor="dev-ws-ask-input">Ask about this change</label>
          {/* THE RESTING LINE, and it keeps the send circle. An earlier cut
              put the whole controls row behind focus, which took the send
              button with it and left a card that looked like a text box and
              nothing else — no sign it would do anything. The button never
              MOVES, either: it is on this line whether the row below is there
              or not, so tapping the field adds a row rather than relocating
              the thing you were about to press. */}
          <div className="dev-ws-ask-line">
            <input
              id="dev-ws-ask-input"
              className="dev-ws-ask-input"
              type="text"
              value={draft}
              /* Three states, three placeholders. A box that says "Ask a
                 question…" while it cannot answer one is the version of
                 this that wastes somebody's time. */
              placeholder={
                !target ? 'No details to ask about on this one'
                  : inFlight ? 'Reading the change…'
                    : 'Ask a question…'
              }
              disabled={!target || inFlight}
              onFocus={() => setFocused(true)}
              onBlur={() => { if (!draft.trim()) setFocused(false); }}
              onChange={(e) => setDraft(e.target.value)}
            />
            <button
              type="submit"
              className="dc-send-btn dc-circle-send dev-ws-ask-send"
              aria-label="Ask"
              disabled={!draft.trim() || !target || inFlight}
            ><ArrowUpIcon className="dev-ws-ask-send-icon" aria-hidden="true" /></button>
          </div>
          {/* ONE LINE until it is tapped. The MODEL is what makes the card two
              lines tall, and it is no use before there is something to send —
              the picker on the dev session screen is the same bargain. */}
          {focused || engaged ? (
          <div className="dev-ws-ask-row">
            {models.list.length ? (
              <span className="dev-ws-ask-model" data-ws-ask-model="">
                <label className="sr-only" htmlFor="dev-ws-ask-model-select">Model</label>
                <select
                  id="dev-ws-ask-model-select"
                  className="dc-model-select dc-model-name"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                >
                  {/* The LABEL only, as the session shows it. The "what kind
                      of work is this for" blurb belongs to the picker's own
                      sheet, not to the row it collapses to. */}
                  {models.list.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
                <ChevronDownIcon className="dev-ws-ask-model-chev" aria-hidden="true" />
              </span>
            ) : null}
          </div>
          ) : null}
        </form>
      </section>
    </div>
  );
}

/**
 * WHERE THE PHONE'S TAB BAR RENDERS.
 *
 * It has to pin to the real viewport, and it cannot do that in place:
 * `position: fixed` resolves against the nearest ancestor that establishes a
 * containing block, and the Dev board's frame wears `.dc-lift-strip`, whose
 * `backdrop-filter` is one — so `bottom: 0` there means the bottom of a
 * frosted panel, not of the screen. Walking the rail's real ancestor chain,
 * that wrapper is the ONLY blocker, and it is shared with the chat and topic
 * frames and three panels, so the bar comes out to #dev-ws-rail-host — an
 * empty anchor the shell keeps outside the frost (Shell.tsx) — rather than
 * the blur coming off.
 *
 * TWO RULES THIS HOOK EXISTS TO KEEP:
 *
 * 1. IT RETURNS null UNTIL AFTER MOUNT, so the first render is always the
 *    in-place one and never disagrees with markup that was prerendered. A
 *    hydration mismatch is a console error, and a console error on any route
 *    fails proposal checks.
 *
 * 2. IT ONLY PORTALS BELOW THE BREAKPOINT. Above 700px the strip is the
 *    segmented control at the head of the column — in flow, in place, not
 *    fixed — so there is nothing to lift out. This query and app.css's
 *    `@media (min-width: 700px)` are one decision in two places and have to
 *    move together.
 */
/**
 * THE SLIDING SELECTION MARKER.
 *
 * The selected tab used to draw its own fill, so the selection jumped between
 * tabs. One element draws it now, and it MEASURES the selected tab rather than
 * being told where to go — which is what lets a single implementation cover
 * both bars: the phone's pill has three equal-width 58px tabs, the desktop
 * strip has content-width 32px ones, and neither geometry is written down
 * here. Every number comes off the live element.
 *
 * `useLayoutEffect`, not `useEffect`: the marker is positioned from a
 * measurement, and a paint between the two is a visible flash of it in the
 * wrong place.
 *
 * THREE THINGS RE-MEASURE IT, and each has actually moved the tabs:
 *   - the tab changing, which is the point;
 *   - a ResizeObserver on the bar, which covers a rotation, a window drag
 *     across the 700px breakpoint, and a late webfont reflowing the labels;
 *   - the portal remount, because crossing that breakpoint tears the bar out
 *     of one parent and into another, and the old offsets belong to neither.
 *
 * It returns `null` until the first measurement lands so the marker can render
 * hidden rather than at the left edge — otherwise it slides in from nowhere on
 * the first paint, which reads as a bug rather than a flourish.
 */
function useTabMarker(
  bar: HTMLElement | null,
  tab: TabKey,
): { x: number; y: number; w: number; h: number } | null {
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    if (!bar) return;
    const measure = () => {
      const el = bar.querySelector<HTMLElement>('[data-ws-tab-btn][aria-selected="true"]');
      if (!el) return;
      // offsetLeft/Top resolve against the nearest positioned ancestor, which
      // is the bar itself — see app.css, where it is the containing block at
      // both widths precisely so these numbers mean what they look like.
      setBox((prev) => {
        const next = { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
        return prev && prev.x === next.x && prev.y === next.y
          && prev.w === next.w && prev.h === next.h ? prev : next;
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(bar);
    return () => ro.disconnect();
  }, [bar, tab]);
  return box;
}

function useRailHost(): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 700px)');
    const apply = () => {
      setHost(mq.matches ? null : document.getElementById('dev-ws-rail-host'));
    };
    apply();
    // `change` rather than a resize listener: it fires once per crossing
    // instead of on every intermediate width, and it is what the breakpoint
    // actually means.
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);
  return host;
}

export function DevWorkshop(): ReactNode {
  const v = useStoreState(devWorkshopStore);
  const hostRef = useRef<HTMLDivElement>(null);
  const [sortKey, setSortKey] = useState<SortKey>('people');
  // Which themes are unfolded, keyed by id. The FIRST theme opens by
  // default: a lander whose every theme is shut is a list of headings.
  // Seeded once the first real publish lands, then the viewer's.
  // Seeded FROM the publish, not from an effect: `autoExpand` is how the
  // `?shot=` deep links reach a theme now that every one starts shut, and an
  // effect would paint the closed state first. Nothing hydrates this component
  // — it mounts client-side into a legacy host and is absent from the
  // prerendered shell — so there is no mismatch to cause. The effect below
  // still handles the case where the themes land after the first paint.
  const [openThemes, setOpenThemes] = useState<Record<string, boolean> | null>(
    () => (v.autoExpand ? { [v.autoExpand.theme]: true } : null),
  );
  // At most one unfolded row per theme (and one for the since strip).
  const [openRows, setOpenRows] = useState<Record<string, string>>(
    () => (v.autoExpand && v.autoExpand.key ? { [v.autoExpand.theme]: v.autoExpand.key } : {}),
  );
  const [sinceOpen, setSinceOpen] = useState(false);
  // Which of the three tabs is up. Seeded from the publish so a `?ws=` deep
  // link paints the right one on the FIRST frame rather than showing Current
  // status and then swapping — the same reason `openThemes` is seeded from
  // `autoExpand` rather than from an effect.
  const railHost = useRailHost();
  // A CALLBACK REF, NOT `useRef`, AND THAT IS THE WHOLE BUG IT FIXES. While the
  // board is loading this component returns a skeleton, so the bar does not
  // exist: the marker's effect ran, found nothing and returned. When the data
  // landed and the bar finally rendered, a `useRef` had not changed — refs are
  // stable — so the effect never re-ran and the marker was never measured. The
  // selection was simply invisible the first time the Workshop was opened.
  //
  // State re-renders when the node arrives, which wakes the effect exactly
  // then. It also makes `railHost` unnecessary as a dependency: the portal
  // remount unmounts the bar and mounts a new one, so this fires twice on its
  // own, with the right node each time.
  const [bar, setBar] = useState<HTMLElement | null>(null);
  const [tab, setTab] = useState<TabKey>(() => v.tab || 'status');
  const markerBox = useTabMarker(bar, tab);
  // ...AND AGAIN WHEN THE PUBLISH LANDS, which is what the seed alone could
  // not do. The seed runs against whatever the store holds AT MOUNT, and that
  // is EMPTY_WORKSHOP_VIEW: the module publishes `_workshopView()` after its
  // data load, so on a cold open `v.tab` is undefined in that first frame and
  // the deep link was dropped on the floor. `autoExpand` has carried the same
  // late-arrival effect since it shipped, for exactly this reason — which is
  // why `?shot=themes` worked on staging while `?ws=all` silently did not,
  // and why 25 declared checks failed on a route that reads correctly.
  //
  // ONCE, guarded by the ref. `v.tab` is read from the URL, so it never
  // changes for the life of the page, while `_rerenderWorkshop()` republishes
  // on every data change: without the guard each republish would yank a
  // reader who had tapped another tab back to the deep-linked one.
  const deepTabApplied = useRef<boolean>(!!v.tab);
  useEffect(() => {
    if (deepTabApplied.current || !v.tab) return;
    deepTabApplied.current = true;
    setTab(v.tab);
  }, [v.tab]);
  // "N more of yours" reveals them HERE. It used to set a board filter and
  // navigate, which left the lander and changed the view mode to read a list
  // the strip was already showing the top of. The vote and free-to-take
  // lanes had the same toggle and no longer need one: they are paged decks
  // now (RowPager), which hold every row without a reveal.
  const [allMine, setAllMine] = useState(false);
  // Which pane is under the tabs. Lives in a module-global store rather than
  // here, because app-view.js has to read it: `_rerenderWorkshop()` publishes
  // the kanban view model only when the stage pane is up. See
  // ./group-mode-store.ts.
  const group = useWorkshopGroup();
  // The toolbar's props reach this root through a store, not a prop — the
  // Workshop is a separate React root from the frame that receives them. See
  // ../actions-store.ts.
  const actions = useDevActions();

  const themes = useMemo(() => sortThemes(v.themes, sortKey), [v.themes, sortKey]);
  // The eyebrow over the theme list: the count, then whatever the grouping
  // itself has to report. Named categories only — "Not yet grouped" is a
  // holding pen, not one of them — and counted here so the label can agree
  // with itself: it read "1 themes" before, which is the kind of thing a
  // reader trusts a screen slightly less for.
  const countOfThemes = themes.filter((t) => !t.ungrouped).length;
  const groupingNote = [
    `${countOfThemes} ${countOfThemes === 1 ? 'category' : 'categories'}`,
    v.meta.source === 'category' ? 'grouped by category for now' : '',
    v.meta.source === 'demo' ? 'staging demo grouping' : '',
    v.meta.pending
      ? (v.meta.pendingStage === 'placement'
        ? 'placing new cards…'
        : (v.meta.source === 'ai' ? 're-drafting categories…' : 'drafting categories…'))
      : '',
  ].filter(Boolean).join(' · ');
  // Every theme starts SHUT. The first one used to open itself, on the
  // reasoning that a lander whose every theme is closed is a list of
  // headings — but a list of headings is exactly what this screen is for,
  // and opening one of them for you spends the top of the page on whichever
  // theme happened to sort first rather than on the shape of the whole board.
  const isOpen = (id: string) => !!(openThemes && openThemes[id]);
  const toggleTheme = (id: string) => {
    setOpenThemes((cur) => ({ ...(cur || {}), [id]: !(cur && cur[id]) }));
  };
  const toggleRow = (scope: string, key: string) => {
    setOpenRows((cur) => (cur[scope] === key ? { ...cur, [scope]: '' } : { ...cur, [scope]: key }));
  };

  // A deep link that names a row (the ?shot= captures): open its theme and
  // unfold it once, on the publish that carries it.
  const autoKey = v.autoExpand ? `${v.autoExpand.theme}:${v.autoExpand.key}` : null;
  useEffect(() => {
    if (!v.autoExpand) return;
    const { theme, key } = v.autoExpand;
    setOpenThemes((cur) => ({ ...(cur || {}), [theme]: true }));
    // `?shot=themes` names a theme and no row: the lanes are the subject, and
    // every row in them stays folded.
    if (key) setOpenRows((cur) => ({ ...cur, [theme]: key }));
  }, [autoKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // The two legacy fillers, re-run whenever the set of unfolded entries
  // changes — see the header. `_wireFeedComments` replaces its observer, so
  // calling it again is idempotent; `_fillKudosHosts` skips filled hosts.
  // A layout effect, so a merged card's kudos pill is in its band on the
  // card's first frame rather than popping in after it (dev-kanban.tsx has
  // the same note).
  const openSig = Object.values(openRows).join('|') + (sinceOpen ? '|since' : '');
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    callAppView('_wireFeedComments', host);
    callAppView('_fillKudosHosts', host);
  }, [openSig, v]);

  if (v.loading) return <div ref={hostRef}><CardSkeleton n={4} label="Loading the workshop" /></div>;
  const nextUp = v.nextUp && v.nextUp.t === 'card' ? v.nextUp : null;
  const slug = v.slug || '';
  const canPost = !!v.canPost;

  /* ── The three destinations ──
     ONE NODE, RENDERED IN ONE OF TWO PLACES. Above the breakpoint it stays
     here, in flow at the head of the column, as the segmented control. Below
     it, `useRailHost` hands back the shell's out-of-frost anchor and the same
     element is portalled there so it can be `position: fixed` to the real
     viewport — see app.css, and the hook for why the frost forces it out.

     It LEADS the markup either way. Focus follows the DOM rather than the
     painting, so a nav announced before the content it navigates is the
     better half of that trade, and on the narrow width the portal puts it
     last in the body — which is the same answer, reached the other way.

     NO `.platform-safe-bar` HERE, deliberately. That rule adds the
     home-indicator inset to the element's own bottom PADDING, which on this
     pill landed 8px under the tabs against 6px over them. The bar floats — a
     rounded pill with air beneath it — so the inset belongs in the offset
     that positions it, not inside it. */
  const railNode = (
        <nav
          ref={setBar}
          className="dev-ws-tabs"
          data-ws-tabs=""
          role="tablist"
          aria-label="Workshop sections"
        >
          {/* THE SELECTION, drawn once and moved, rather than redrawn per tab.
              It is `aria-hidden` and not focusable: `aria-selected` on the tab
              is what announces the state, and a decorative box claiming it too
              would say the same thing twice.

              Rendered BEFORE the buttons so it paints behind them without a
              z-index race — the tabs raise themselves one step in app.css and
              this stays at the floor of the stacking context.

              No inline style until it has been measured. `markerBox` is null
              on the first render, so the element renders hidden and only
              becomes visible once it knows where to be; otherwise it slides in
              from the left edge on first paint, which reads as a bug rather
              than a flourish. */}
          <span
            className="dev-ws-tab-marker"
            data-ws-tab-marker=""
            aria-hidden="true"
            {...(markerBox ? { 'data-ws-marker-at': '' } : {})}
            style={markerBox ? {
              transform: `translate(${markerBox.x}px, ${markerBox.y}px)`,
              width: `${markerBox.w}px`,
              height: `${markerBox.h}px`,
            } : undefined}
          />
          {/* The TRACK, separate from the nav, and `display: contents` on a
              phone so the bar there is byte-identical to what it was: the nav
              itself is the pill, edge to edge.

              Above 700px the two have different jobs. The nav is the POSITIONING
              box — it inherits the 760px reading column and its centring, which
              is what keeps the strip anchored to the same left edge whether the
              pane beside it is the 760px category list or the full-bleed board.
              The track is the pill, and it hugs its three labels: a segmented
              control spanning the reading column would read as a header bar
              rather than as a control, which is the same reason
              @/components/ui/tabs.tsx makes SECTION_TABS_LIST `inline-flex`. */}
          <div className="dev-ws-tabtrack">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              className="dev-ws-tab"
              data-ws-tab-btn={t.key}
              aria-selected={tab === t.key}
              onClick={() => { setTab(t.key); callAppView('_setWorkshopTab', t.key); }}
            >
              {/* The glyph is decoration over a label that is already there, so
                  it is hidden from the accessibility tree rather than given a
                  name of its own — otherwise every tab announces twice. Its
                  size comes from the class, not a prop: icons.tsx has no size
                  variant on purpose, and every other `.dev-ws-*` measurement
                  lives in app.css beside its neighbours. */}
              <t.Icon className="dev-ws-tab-glyph" aria-hidden="true" />
              <span className="dev-ws-tab-label">{t.label}</span>
            </button>
          ))}
          </div>
        </nav>
  );

  return (
    <div ref={hostRef} className="dev-ws" data-ws-tab={tab}>
      {railHost ? null : railNode}
      {/* Everything but the rail lives in here. It is what carries the
          clearance under the last card: a sticky bar overlays whatever is
          beneath it while you scroll, so the content needs a rail's worth of
          empty space at its end or the final card can never be read clear of
          it. Putting that padding on the LANDER instead would push the rail
          up off the bottom on a short tab, which is the thing that was just
          fixed. Above 700px the bar is not sticky and overlays nothing, so
          app.css takes the clearance back off. */}
      <div className="dev-ws-tabbody">
      {tab === 'status' ? (
      <>
      {v.emptyNote ? (
        <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-2">
          {v.emptyNote.filtered ? (
            'Nothing here matches the current search and filters.'
          ) : (
            <>
              {v.emptyNote.loadFailed ? "Couldn't load open issues right now. " : ''}
              {'Nothing on the board yet. Press '}
              <span className="font-medium text-violet-700 dark:text-violet-400">+</span>
              {' to propose a change or file an issue.'}
            </>
          )}
        </div>
      ) : null}

      {/* ── One pane: where the app is, and what moved while you were away ──
          These were two strips asking one question. The description leads —
          the app says what it is about the way a theme does — and the personal
          line sits under it, because "what changed for me" only means anything
          against "what this is". Both hooks ride on the one section now. */}
      {v.dashboard ? (
        <section
          className="dev-ws-strip"
          data-ws-dashboard=""
        >
          <div className="dev-ws-strip-head">
            <span className="dev-ws-eyebrow">Where the app is</span>
            {v.since && v.since.shipped
              ? <span className="dev-ws-pill dev-ws-pill-good">{`${v.since.shipped} shipped since`}</span>
              : null}
          </div>
          <DashTiles d={v.dashboard} />
          {/* The weeks, newest on screen and the rest one press away. The
              derived sentence is still the fallback for a board that has
              never had a line written for it — see summarise(). */}
          {v.dashboard.weeks.length
            ? (
              <WeekWalk
                weeks={v.dashboard.weeks}
                firstWeek={v.dashboard.firstWeek}
                note={digestNote(v.meta, !!(v.dashboard.cards || v.dashboard.summary))}
              />
            )
            : summarise(v.dashboard)
              ? (
                <>
                  <p className="dev-ws-strip-text">{summarise(v.dashboard)}</p>
                  {/* The note belongs to whichever sentence is on screen. With
                      no cards there is no walk to hang it inside, and this is
                      the very case it exists for: "no draft yet" and "the call
                      keeps failing" both leave the derived sentence up there
                      and are otherwise indistinguishable. */}
                  {digestNote(v.meta, !!(v.dashboard.cards || v.dashboard.summary)) ? (
                    <p className="dev-ws-digest-note" data-ws-digest-note="">
                      {digestNote(v.meta, !!(v.dashboard.cards || v.dashboard.summary))}
                    </p>
                  ) : null}
                </>
              )
              : null}
          {/* The note about the summary rides INSIDE the walk (above "Show
              past week"), with the card it is about — see WeekWalk. */}
        </section>
      ) : null}

      {/* ── Yours, first ──
          The first question a returning member has is about their OWN work,
          and the lander answered every other one before it: what the app is
          doing, what the group needs, what nobody has picked up. A
          half-finished session of theirs was somewhere down inside a theme,
          under a heading about the theme. */}
      {v.mine && v.mine.rows.length ? (
        <section className="dev-ws-strip" data-ws-mine="">
          <div className="dev-ws-strip-head">
            <span className="dev-ws-eyebrow">What you are working on</span>
          </div>
          <div className="dev-ws-lane" data-ws-lane="mine">
            {(allMine ? v.mine.rows : v.mine.rows.slice(0, v.mine.shown)).map((row) => (row.t === 'card' ? (
              <CardRowView
                key={row.key}
                row={row}
                slug={slug}
                canPost={canPost}
                open={openRows.mine === row.key}
                onToggle={() => toggleRow('mine', row.key)}
              />
            ) : null))}
            {v.mine.rows.length > v.mine.shown ? (
              <button
                type="button"
                className="gc-vote-btn dev-ws-lane-btn"
                aria-expanded={allMine}
                data-ws-mine-more=""
                onClick={() => setAllMine(!allMine)}
              >
                {allMine ? 'Show fewer' : `${v.mine.count - v.mine.shown} more of yours`}
              </button>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* ── The door to the general chat ──
          The card used to sit bare between the strips: same width, no
          surface of its own, and therefore the one thing on the lander that
          belonged to no pane. It reads as a stray row of the pane above it.
          Its own strip, with its own eyebrow, says what it is before you
          reach the card — and gives the lander one shape all the way down:
          every block is an eyebrow and what is under it. */}
      {v.discussion && v.discussion.t === 'card' ? (
        <section className="dev-ws-strip" data-ws-discussion="">
          <div className="dev-ws-strip-head">
            <span className="dev-ws-eyebrow">Talk about the app</span>
          </div>
          <div className="dev-ws-discussion"><DevCard model={v.discussion.card} /></div>
        </section>
      ) : null}
      {/* ── What moved while you were away ──
          ONE LINE until you want it. It was a pane with a heading and a
          summary line under it — a whole section of the status tab spent on
          a fact most visits do not need, above the door to the app's chat.
          Collapsed it is a row: the label, the count, and a caret. Opening
          it makes it the pane it used to be, with the rows in it. */}
      {v.since ? (
        sinceOpen ? (
          <section className="dev-ws-strip" data-ws-since="">
            <button
              type="button"
              className="dev-ws-since-row"
              data-ws-since-btn=""
              aria-expanded={true}
              onClick={() => setSinceOpen(false)}
            >
              <ChevronRightIcon className="dev-ws-since-chev" aria-hidden="true" />
              <span className="dev-ws-since-label">Since your last visit</span>
              <span className="dev-ws-since-n">{v.since.rows.length}</span>
            </button>
            {v.since.rows.map((row) => (row.t === 'card' ? (
              <CardRowView
                key={row.key}
                row={row}
                slug={slug}
                canPost={canPost}
                open={openRows.since === row.key}
                onToggle={() => toggleRow('since', row.key)}
              />
            ) : null))}
          </section>
        ) : (
          <button
            type="button"
            className="dev-ws-since-row dev-ws-since-shut"
            data-ws-since-btn=""
            aria-expanded={false}
            disabled={!v.since.rows.length}
            onClick={() => setSinceOpen(true)}
          >
            <ChevronRightIcon className="dev-ws-since-chev" aria-hidden="true" />
            <span className="dev-ws-since-label">Since your last visit</span>
            <span className="dev-ws-since-n">{v.since.rows.length}</span>
          </button>
        )
      ) : null}

      </>
      ) : null}

      {tab === 'needs' ? (
        <NeedsDeck rows={v.queue} owed={v.votes.count} total={v.votes.total} models={v.models} slug={slug} />
      ) : null}

      {tab === 'all' && themes.length ? (
        <>
          {/* ── The two ways to read the same board ──────────────────────
              The eyebrow here used to say "12 categories" and nothing else:
              a count of a grouping the viewer had no say in. The grouping is
              a CHOICE, so it is a control. "By stage" is not a second board
              — it renders the very same <DevKanban/> the Board view mode
              does, from the same published view model (../card/cards-store),
              nested under the summary rather than replacing it. Everything
              above stays put under either tab, which is the whole point:
              the tiles, the three summary lines, the votes waiting on you
              and the general discussion are facts about the app, not about
              how you happen to be sorting it. */}
          <section className="dev-ws-pane" data-ws-pane="">
          {/* ── The sticky head: the controls that act on what is below ──
              The search, the filters and the "+" used to sit in the frame's
              chrome above the scroller, two strips away from the list they
              narrow. They belong WITH it — and with the tab strip, because
              "which grouping" and "narrowed to what" are one question asked
              twice. Both pin together: filtering a long list is exactly what
              you are doing when you are scrolled down, and a tab strip that
              scrolled away would leave no way back to the other pane.

              THE TABS LEAD, and the order is the argument: they decide what
              the search is searching. With the search above them the control
              that sets the scope sat under the control that acts within it,
              and the pane had to be read bottom-up to be understood. Leading
              with the switch also gives the head a title bar — the two-state
              choice, then the tools for whichever state you picked. */}
          <div className="dev-ws-pane-head">
          {/* The pane's own title. Everything above this point is a selection
              — your work, what needs you, what moved — and this is the whole
              board, however you choose to read it. Without the line the tabs
              were the first thing in the pane and named only the CHOICE,
              leaving what the choice was being made about unsaid. */}
          <span className="dev-ws-eyebrow dev-ws-pane-eyebrow">All items</span>
          <div className="dev-ws-group" role="tablist" aria-label="Group the board by">
            <button
              type="button"
              role="tab"
              className="dev-ws-group-tab"
              data-ws-group="category"
              aria-selected={group === 'category'}
              onClick={() => callAppView('_setWorkshopGroup', 'category')}
            >
              By category
            </button>
            <button
              type="button"
              role="tab"
              className="dev-ws-group-tab"
              data-ws-group="stage"
              aria-selected={group === 'stage'}
              onClick={() => callAppView('_setWorkshopGroup', 'stage')}
            >
              By stage
            </button>
          </div>
            <DevActionsRow
              illustrationApp={actions.illustrationApp}
              canManageIllustration={actions.canManageIllustration}
              selfHosted={actions.selfHosted}
              readOnly={actions.readOnly}
              canCollaborate={actions.canCollaborate}
              showsMembers={actions.showsMembers}
            />
          </div>
          {/* The pane's face is painted by its two PARTS, not by the pane —
              see app.css. A fill on the pane with a second one on the sticky
              head stacked 50% on 50% and drew a lighter band across the
              controls; giving head and body the same fill on the same
              backdrop makes them the same colour by construction. */}
          <div className="dev-ws-pane-body">
          {group === 'stage' ? (
            <div className="dev-ws-board" data-ws-stage="">
              <DevKanban />
            </div>
          ) : (
          <>
          <div className="dev-ws-sort">
            {groupingNote ? <span className="dev-ws-eyebrow">{groupingNote}</span> : null}
            <div className="dev-ws-sort-opts" role="group" aria-label="Order categories">
              {SORTS.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  className="dev-ws-chip"
                  aria-pressed={sortKey === s.key}
                  onClick={() => setSortKey(s.key)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          <div className="dev-ws-themes">
            {themes.map((t) => (
              <ThemeCard
                key={t.id}
                theme={t}
                slug={slug}
                canPost={canPost}
                open={isOpen(t.id)}
                onToggle={() => toggleTheme(t.id)}
                openKey={openRows[t.id] || null}
                onToggleRow={(key) => toggleRow(t.id, key)}
              />
            ))}
          </div>
          {/* Four honest states for the fallback, because the first cut said
              "once an AI model is available" while the model was mid-draft —
              and, on the model's grouping, when it was drafted and how much
              of the board it holds. */}
          <div className="dev-ws-foot-note">
            {v.meta.source === 'ai'
              ? aiFootnote(v.meta, !!(v.dashboard && (v.dashboard.cards || v.dashboard.summary)))
              : v.meta.source === 'demo'
                ? 'Staging demo grouping: in production the categories are drafted by the model from the board.'
                : v.meta.pending
                  ? 'Categories are being drafted from the board now. They replace this grouping when they land.'
                  : v.meta.lastError
                    ? `The last attempt to draft categories failed (${v.meta.lastError}). Items stay grouped by their voted category until the next attempt.`
                    : 'No AI model is configured, so items are grouped by their voted category.'}
          </div>
          </>
          )}
          </div>
          </section>
        </>
      ) : null}

      </div>

      {/* The same node, lifted out of the frost. `railHost` is null above the
          breakpoint and until after mount, so in both of those cases the rail
          renders in place above and this is nothing. */}
      {railHost ? createPortal(railNode, railHost) : null}
    </div>
  );
}
