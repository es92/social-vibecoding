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
  BallotIcon,
  ChatBubbleTailIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  EllipsisHorizontalIcon,
  HandRaisedIcon,
  NewspaperIcon,
  PlayIcon,
  SparklesIcon,
  SpeechCheckIcon,
  Squares2X2Icon,
} from '@/components/ui/icons';

import { agoStamp } from '../../../lib/timestamp';
import { useStoreState } from '../../../lib/use-store-state';
import { devWorkshopStore } from '../card/cards-store';
import { CardIcon, Chevron, metaLineNodes } from '../card/dev-card';
import { DevKanban } from '../card/dev-kanban';
import { DevActionsRow } from '../actions-row';
import { useDevActions } from '../actions-store';
import { CardRowView, callAppView, openHref } from '../card/fold';
import { FeedThread } from '../card/feed-thread';
import type { DevCardModel, DevWorkshopView, WorkshopTheme } from '../card/model';
import { CardSkeleton } from '../card/skeleton';
import { ProgressRing } from '@/components/ui/progress-ring';
import { useWorkshopGroup } from './group-mode-store';
import { readAskStream } from './ask-stream';

type SortKey = 'people' | 'activity' | 'open';
type TabKey = 'status' | 'needs' | 'all';

/**
 * "Since your last visit", as a length rather than a disclosure.
 *
 * Three, because that is what fits above the fold beside the panes around it
 * and because a returning member's question is "did anything happen", which
 * three rows answer. The step is the same number so each press pays the same
 * scroll. There is no "show fewer", for the reason the week walk gives: this
 * is one pane with a way to ask for more, not a thing being opened and shut.
 *
 * #2183: the button no longer leaves when the new rows run out. The list it
 * walks is the WHOLE activity list, newest first, and the baseline is only a
 * line across it: above the line is what moved since the reader was last
 * here, below it is what they have already seen. `Show older` reveals three
 * more of the new rows while there are any, then crosses the line under a
 * "Seen before" mark and keeps going — so a quiet visit, or a visit just
 * after Clear, still has somewhere to look. It disables, rather than leaves,
 * when the rows it can draw are exhausted: a control that is sometimes there
 * is a control nobody learns to reach for. That is the notifications
 * sheet's split between Unread and the archive that holds what was read,
 * on one list instead of two tabs.
 */
const SINCE_FIRST = 3;
const SINCE_STEP = 3;

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
    parts.push(`${c.unplaced} ${c.unplaced === 1 ? 'card did' : 'cards did'} not fit a theme and ${c.unplaced === 1 ? 'waits' : 'wait'} for the next draft.`);
  }
  if (meta.lastError) parts.push(`The last attempt failed (${meta.lastError}); it is retried shortly.`);
  return parts.join(' ');
}

/**
 * Which paragraph is at the top of the page, and why.
 *
 * This used to be two clauses of the theme footnote under the themes,
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

/**
 * The no-items note, drawn where the items would have been.
 *
 * Two screens say it — the status tab over its strips, and the All items pane
 * under its toolbar — and the second of those is the fix for #2090. The pane
 * used to be gated on having a theme to draw, so a search that matched
 * nothing unmounted the whole pane: the grouping tabs, the "+", and the
 * toolbar whose host the search field lives in. The one control that could
 * undo the search left the screen with the rows, and the viewer was stuck on
 * a board they could not widen back out. Now the pane stays, and this note
 * takes the rows' place beneath the box it is talking about.
 */
function EmptyNote({ filtered, loadFailed }: { filtered: boolean; loadFailed: boolean }): ReactNode {
  return (
    <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-2" data-ws-empty="">
      {filtered ? (
        'Nothing here matches the current search and filters.'
      ) : (
        <>
          {loadFailed ? "Couldn't load open issues right now. " : ''}
          {'Nothing on the board yet. Press '}
          <span className="font-medium text-violet-700 dark:text-violet-400">+</span>
          {' to propose a change or file an issue.'}
        </>
      )}
    </div>
  );
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
 * call failed. Same relationship the voted-category fallback has to the themes.
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
/**
 * The general discussion, as one row at the foot of the dashboard pane.
 *
 * It replaces a whole section — eyebrow, frosted surface, and a `DevCard`
 * inside it — whose only job was to navigate to the chat. The card's own
 * model is still what supplies it, node for node (the same glyph, the same
 * meta line naming who spoke last and when), so the row and the screen it
 * opens cannot drift apart; what it drops is the three surfaces that were
 * wrapped around that one line.
 *
 * `data-discussion-row` is load-bearing and not decoration: the delegated
 * handler on `#dev-body` (app-view.js) selects on it to switch to the chat
 * sub-view. A `<button>` carries it rather than the card's `div`, because
 * with the card gone this row IS the control.
 *
 * The chevron is the one the card wore (`DEV_CARD_CHEVRON` / `Chevron`),
 * kept deliberately. Every other rounded surface on this tab is something
 * you read, so without a mark the only thing saying this one is a door was
 * the cursor — which a phone does not have.
 */
function DiscussionRow({ card }: { card: DevCardModel }): ReactNode {
  return (
    <button
      type="button"
      className="dev-ws-chat-row"
      data-ws-chat-row=""
      data-discussion-row="1"
      title={card.title.title}
    >
      {card.icon ? <CardIcon spec={{ ...card.icon, small: true }} /> : null}
      <span className="dev-ws-chat-said">{metaLineNodes(card)}</span>
      <Chevron />
    </button>
  );
}

/**
 * The four figures.
 *
 * ── ONE ROW, NOT FOUR CARDS ──
 * They were four floating tiles inside the pane, each with its own fill,
 * hairline and drop shadow, sitting above a fifth box holding the summary
 * line — six surfaces inside one surface, which is what made the pane read
 * as a stack of things rather than one answer. They are one ruled row now:
 * hairlines between the figures, no fill of their own, on the pane's own
 * ground. Two up on a phone and four across from 420px, which is the
 * breakpoint they already used.
 *
 * ── THE ORDER IS AN ARGUMENT ──
 * The backlog, then the part of it nobody has taken, then the decision
 * waiting on you, then what actually landed. It reads as a progression and
 * it ends on the one number that says the app is moving. The old order —
 * open, shipped, votes, unclaimed — put the outcome second and buried the
 * unclaimed count at the end, away from the total it qualifies.
 *
 * ── THE MARK IS BESIDE THE LABEL, NOT ON THE NUMBER ──
 * Tone used to be a colour on the integer itself: a green `6`, an amber `3`.
 * That is state carried by hue alone, which says nothing to a reader who
 * cannot separate the two, and it puts a status colour on text where the
 * rest of the product keeps text in text ink. The number takes
 * `--text-primary` like every other figure and a dot beside the label
 * carries the state. Only the two figures that are a CALL wear one: a zero
 * is not a warning, and "nobody on them" is a fact about the backlog, not an
 * alarm — it had no tone before and gains none here.
 */
function DashTiles({ d }: { d: Dash }): ReactNode {
  const cells: { key: string; n: number; label: string; dot?: string; title?: string }[] = [
    { key: 'open', n: d.open, label: d.open === 1 ? 'open item' : 'open items' },
    { key: 'unclaimed', n: d.unclaimed, label: 'nobody on them' },
    {
      key: 'votes',
      n: d.votesWaiting,
      label: d.votesWaiting === 1 ? 'waiting on a vote' : 'waiting on votes',
      dot: d.votesWaiting ? 'dev-ws-dash-dot-warn' : undefined,
    },
    {
      key: 'shipped',
      n: d.shippedWeek,
      label: 'shipped this week',
      dot: d.shippedWeek ? 'dev-ws-dash-dot-good' : undefined,
      title: d.partial
        ? 'At least this many: the merged history is longer than the page loaded.'
        : 'This calendar week, counted from Monday 00:00 UTC.',
    },
  ];
  return (
    <div className="dev-ws-dash" data-ws-dash="">
      {cells.map((c) => (
        <span
          key={c.key}
          className="dev-ws-dash-cell"
          data-ws-dash-cell={c.key}
          title={c.title}
        >
          <b>{c.key === 'shipped' && d.partial && c.n ? `${c.n}+` : c.n}</b>
          <span className="dev-ws-dash-label">
            {/* A GRID in app.css, not an inline run: the label wraps at phone
                widths, and a centred mark floated to the middle of a two-line
                label while its second line ran back underneath the dot. */}
            {c.dot ? <i className={`dev-ws-dash-dot ${c.dot}`} aria-hidden="true" /> : null}
            <span>{c.label}</span>
          </span>
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
/**
 * "Aug 25 – Aug 31" for a window whose `endMs` is the Monday after it, and
 * "Sep 14 → now" for the one that has not finished.
 *
 * THE LIVE WINDOW IS NOT A RANGE OF TWO DATES. Its `endMs` is the current
 * instant, so the completed-week arithmetic named yesterday and the caption
 * read "Sep 14 – Sep 15" on a Tuesday — a two-day week, and a range whose
 * right end moves every midnight for no reason the reader can see. It runs
 * from its Monday to NOW, so that is what it says.
 */
function weekRange(startMs: number, endMs: number, live?: boolean): string {
  const fmt = (ms: number) => new Date(ms)
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  if (live) return `${fmt(startMs)} → now`;
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
 * So NOTHING is drawn until it is asked for, and each press reveals the
 * next-oldest window BELOW the stack, with the control moving down with it.
 * The live window is behind the first press like every other: what the pane
 * always shows is the lead paragraph above this walk, which is a sentence
 * about now rather than a window. It grew upwards first, on the
 * reasoning that a column of dated cards reads oldest-at-the-top like any
 * timeline. It does, but this is not a timeline being read: it is one card
 * with a way to ask for more, and growing upwards pushed the card you were
 * looking at further down the screen on every press. Downwards, the present
 * stays where it is and the history unrolls under it.
 *
 * `Open issues` used to be the default entry, and it was never a week — so
 * the first press of "Show past week" revealed THIS week, which is not a
 * past week. It is the pane's lead paragraph now, above this walk and
 * outside it, and the button's label is true on every press.
 *
 * The walk ends where the server's lines end, and SAYS SO. `firstWeek` is
 * the app's beginning and the server has never sent one, so the only thing
 * that ever happened when the lines ran out was the button silently
 * leaving — which reads as a control that broke. "As far back as the
 * summary goes" is the weaker statement and the true one: it is a fact
 * about the summary's reach, not a claim about the app's age, and it can
 * always be made.
 */
export function WeekWalk({ weeks, firstWeek, note, initialShown = 0 }: {
  weeks: Dash['weeks'];
  firstWeek: number | null;
  /** Why the summary is what it is, when something is wrong with it. */
  note?: string;
  /**
   * How many windows are open on the first render. The pane passes nothing
   * and gets none, which is the product behaviour; this exists so the suite
   * can assert what an OPENED walk draws.
   *
   * It is a test seam and worth saying so plainly. The alternative was to
   * leave a window drawn unasked purely so a static render could see one —
   * which is letting the tests choose the product's default state, and this
   * walk's default is the whole question. `renderToStaticMarkup` runs no
   * effects and dispatches no events (tests/lib/render-tsx.js says so in its
   * header), so there is no press for a test to make.
   */
  initialShown?: number;
}): ReactNode {
  // How many windows are on screen. NONE, until asked: the pane opens on its
  // lead paragraph — what the open work is about — and the whole history,
  // the live week included, is behind the press. That is the bargain this
  // walk has always made; what changed is only WHAT is always on screen,
  // because `open` is a sentence about now rather than a window and has left
  // the walk for the paragraph above it.
  //
  // The label stays "Show past week" on every press, which makes its first
  // press the one place it overstates: This week is not a past week. The
  // alternative — drawing the live window unasked — buys that one word at
  // the cost of opening every visit on a block nobody asked for, and reads
  // as a pane that forgot to collapse.
  const [shown, setShown] = useState(initialShown);
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
            {/* ONE NAMED WINDOW, THE REST DATED. A window with a title keeps
                it and wears its range as a gloss; every other window IS its
                dates, and the range takes the heading slot. "Last week" and
                "3 weeks ago" are both relative counts a reader decodes
                against today, and the second is arithmetic nobody should be
                asked to do — a range is an absolute fact that stays true
                however deep the walk goes. */}
            {w.title
              ? (
                <>
                  {w.title}
                  {w.startMs ? (
                    <span className="dev-ws-card-range">
                      {weekRange(w.startMs, w.endMs, w.key === 'thisWeek')}
                    </span>
                  ) : null}
                </>
              )
              : <span className="dev-ws-card-dates">{weekRange(w.startMs, w.endMs)}</span>}
          </h4>
          {/* What the window COST and what it PAID, where the server can
              stand behind the figure. Drawn small: it is a footnote to the
              tiles above, not a second dashboard. A window the server has
              written no count for draws none rather than a zero. */}
          {w.counts ? (
            <p className="dev-ws-card-counts" data-ws-card-counts="">
              <span className="dev-ws-card-count">
                <CheckIcon className="dev-ws-card-count-ic" aria-hidden="true" />
                <b>{w.counts.partial && w.counts.closed ? `${w.counts.closed}+` : w.counts.closed}</b>
                {w.counts.closed === 1 ? 'change landed' : 'changes landed'}
              </span>
            </p>
          ) : null}
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
      {/* The walk's floor. `atStart` is the app's BEGINNING and needs the
          server's `firstWeek`, which it has never sent — so the only thing
          that ever happened when the lines ran out was the button silently
          leaving, which reads as a control that broke. The weaker statement
          is the true one and can always be made: this is as far as the
          SUMMARY reaches, which is not a claim about the app's age. */}
      {atStart ? (
        <p className="dev-ws-week-note" data-ws-week-start="">The first week this app had any activity.</p>
      ) : null}
      {!more && !atStart ? (
        <p className="dev-ws-week-note" data-ws-week-end="">That is as far back as the summary goes.</p>
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
    + (d.themes ? ` across ${d.themes} ${d.themes === 1 ? 'theme' : 'themes'}` : '');
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
  // `total`, not `rows.length`: the rows are capped for drawing and this
  // sentence describes the whole population the head counts.
  return bits.length ? bits.join(', ') : `${s.total} things moved`;
}

/* ═══════════════════════════════════════════════════════════════════════
 * `Needs you` — a feed of decisions.
 *
 * ── What it is ───────────────────────────────────────────────────────
 *
 * One item fills the screen: a proposal owed a vote, or an issue nobody has
 * picked up. A swipe (a wheel, an arrow key) snaps to the next, and nothing
 * inside an item scrolls. Everything that acts on the item or says more
 * about it is a button on a RAIL at the right edge — Vote, comments, Ask,
 * Try it, More — and each opens a sheet over the item rather than a page
 * away from it. The shape is the short-video feed's, because its two claims
 * are the ones this screen makes: one thing at a time, and the thing you
 * look at is the whole screen.
 *
 * ── The item, top to bottom ──────────────────────────────────────────
 *
 * A progress line and an eyebrow that says what kind of item this is and
 * where you are ("1 / 59"); the TITLE; the plain-language SUMMARY under it as
 * the sub-hero (`pr_summary_md`, or an issue's own words); the PICTURE, when
 * the checks shot one (see BeforeAfter); and a CAPTION with who, when, and
 * the state chips. The text sits at the top so the picture can take the
 * rest — a proposal with captures is mostly its picture.
 *
 * ── The rail ─────────────────────────────────────────────────────────
 *
 * ONE rail, for the item in view, rather than one per item: the buttons stay
 * where the thumb learned they are while the items move under them. Vote is
 * one control that opens the question — Yes and No live on its sheet, with
 * the tally — because a thumbs-up on a rail reads as "like", and this is not
 * that. More is the card's own ⋯ menu: the same `data-card-menu` hook the
 * Board's cards carry, so `_openCardMenu` finds it and the entries are
 * exactly the card's (Open session, Withdraw, Explore in dev chat, View PR
 * on GitHub…). Try it is the card's Preview affordance under a name that
 * says what it does.
 *
 * ── Sheets on a phone; panels and a popover on a wide window ─────────
 *
 * The same markup, placed by app.css. Below 700px a sheet rises from the
 * floor over a scrim and the tab pill hides under it. Above, Ask and the
 * comments take a PANEL beside the rail and the stage slides over, so the
 * item stays readable while you use them, and Vote is a popover on its own
 * button. `useMediaFlag(WIDE_QUERY)` is that breakpoint in the other language; the keys
 * (↑ ↓ move, V vote, A ask, C comments, T try it, M more) work everywhere
 * and are only LISTED on the wide layout, where a keyboard is likely.
 *
 * ── After a vote ─────────────────────────────────────────────────────
 *
 * Nothing advances on its own. The row leaves the queue on the click
 * (#2031), so the feed PINS a copy of it in place — the eyebrow becomes the
 * confirmation and the Vote button a tick — until you move on; a card that
 * vanished under the press read as a mis-tap. Moving to another item drops
 * the pin, and the scroller re-syncs to the row you are on BY KEY, so a row
 * leaving above you never shifts what you are reading.
 *
 * ── The end card (#2172) ─────────────────────────────────────────────
 *
 * One card PAST the last item, always: the swipe that would have hit the
 * end of the scroller lands on a summary instead — how many decisions this
 * pass answered, how many were passed over and are still waiting above,
 * and the way back to the lander. It is one more snap point in the same
 * scroller, not a footer, so on a phone it arrives the way every item did.
 * With nothing in the queue it is the whole screen, which is what the
 * empty state already was. The counter and the progress line count only
 * the decisions ("3 / 7"); the end card is where you are once they are
 * behind you. `?shot=needs-end` opens on it, for the declared check.
 *
 * ── Two rules kept from the deck this replaces ───────────────────────
 *
 * The ask thread loads in an EFFECT, never in render — a first paint that
 * differs from the shipped markup is a hydration mismatch, a console error
 * and a failed check — and the composer is written once (`sendBtn`) so its
 * two homes cannot drift. Every item stays in the DOM, so the legacy comment
 * filler (`_wireFeedComments`) can find its hosts.
 * ═══════════════════════════════════════════════════════════════════════ */

type QueueRow = Extract<DevWorkshopView['queue'][number], { t: 'card' }>;
type SheetKind = 'vote' | 'ask' | 'comments';
type Side = 'before' | 'after';

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

/** The status pill's tone as a caption chip. Complete literals, as above. */
function chipTone(tone: string | undefined): string {
  switch (tone) {
    case 'ok': return 'dev-ws-chip dev-ws-chip-ok';
    case 'progress': return 'dev-ws-chip dev-ws-chip-progress';
    case 'warn': case 'attention': return 'dev-ws-chip dev-ws-chip-warn';
    case 'blocked': case 'reject': return 'dev-ws-chip dev-ws-chip-blocked';
    default: return 'dev-ws-chip';
  }
}

/**
 * The caption's chips: what the card's status pill says, the tally, and the
 * category or priority when one is set. Four at most — this is a caption,
 * not the card's badge band, and the rail already says a vote is owed.
 */
/** The key legend for an item of this kind: the keys it answers to. */
function legendFor(kind: QueueRow['kind'] | 'done'): Array<[string[], string]> {
  const keys: Array<[string[], string]> = [[['↑', '↓'], 'move']];
  // The end card answers to the move keys alone.
  if (kind === 'done') return keys;
  if (kind === 'vote') keys.push([['V'], 'vote']);
  keys.push([['A'], 'ask'], [['C'], 'comments']);
  if (kind === 'vote') keys.push([['T'], 'try it']);
  keys.push([['M'], 'more']);
  return keys;
}

function chipsFor(row: QueueRow, voted: string | null): { key: string; cls: string; text: string }[] {
  const out: { key: string; cls: string; text: string }[] = [];
  const st = row.card.pill ? row.card.pill.state : null;
  if (row.kind === 'vote' && st) {
    if (voted) out.push({ key: 'voted', cls: 'dev-ws-chip dev-ws-chip-ok', text: `You voted ${voted}` });
    if (st.label && !/^Vote\b/.test(st.label)) out.push({ key: 'state', cls: chipTone(st.tone), text: st.label });
    out.push({ key: 'tally', cls: 'dev-ws-chip', text: `${st.yes} of ${st.majority} yes` });
  }
  for (const b of row.card.badges) {
    if (b.t === 'attr' && (b.field === 'category' || b.field === 'priority' || b.field === 'theme') && b.label.text) {
      out.push({ key: b.key, cls: 'dev-ws-chip dev-ws-chip-info', text: b.label.text });
    }
  }
  return out.slice(0, 4);
}

/** The line under the vote question: where the vote stands, and what follows. */
function tallyLine(row: QueueRow): string {
  const st = row.card.pill ? row.card.pill.state : null;
  if (!st) return '';
  const said = `${st.yes} of ${st.majority} have said yes so far.`;
  return st.label && !/^Vote\b/.test(st.label) ? `${said} ${st.label}.` : said;
}

/* ── The picture: two stills, cropped to what changed ───────────────── */

type Geo = { w: number; h: number; box: { x: number; y: number; w: number; h: number } | null };

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`could not load ${src}`));
    img.src = src;
  });
}

/**
 * Where the two stills differ, as a box in the image's own pixels.
 *
 * Both sides are drawn at 320px wide and compared pixel for pixel — a small
 * job, and the region it finds is what the item shows near actual size. Null
 * box means "show the whole page": the sides are missing or differently
 * sized, they are identical, or the change covers most of the page (a theme,
 * a redesign), where a crop would frame nothing.
 */
async function diffPair(before: string | null, after: string | null): Promise<Geo> {
  const [a, b] = await Promise.all([
    before ? loadImage(`/visuals/${before}`) : Promise.resolve(null),
    after ? loadImage(`/visuals/${after}`) : Promise.resolve(null),
  ]);
  const main = b || a;
  if (!main) throw new Error('no still');
  const w = main.naturalWidth;
  const h = main.naturalHeight;
  if (!a || !b || a.naturalWidth !== w || a.naturalHeight !== h || !w || !h) return { w, h, box: null };
  const k = Math.min(1, 320 / w);
  const cw = Math.max(1, Math.round(w * k));
  const ch = Math.max(1, Math.round(h * k));
  const pixels = (img: HTMLImageElement): Uint8ClampedArray | null => {
    const c = document.createElement('canvas');
    c.width = cw;
    c.height = ch;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, cw, ch);
    return ctx.getImageData(0, 0, cw, ch).data;
  };
  const pa = pixels(a);
  const pb = pixels(b);
  if (!pa || !pb) return { w, h, box: null };
  let x0 = cw; let y0 = ch; let x1 = -1; let y1 = -1;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const p = (y * cw + x) * 4;
      const d = Math.abs(pa[p] - pb[p]) + Math.abs(pa[p + 1] - pb[p + 1]) + Math.abs(pa[p + 2] - pb[p + 2]);
      if (d > 48) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return { w, h, box: null };
  const box = { x: x0 / k, y: y0 / k, w: (x1 - x0 + 1) / k, h: (y1 - y0 + 1) / k };
  if (box.w * box.h > 0.6 * w * h) return { w, h, box: null };
  return { w, h, box };
}

/**
 * The item's picture: the two stills the checks shot, CROPPED TO THE CHANGE.
 *
 * The captures are 1280×800 desktop stills (capture/capture.js), and at a
 * phone's width a whole page is a third of its size — unreadable, whatever
 * the arrangement. So the region that differs is what fills the box, near
 * actual size, with an outline around it and a Before / After switch inside
 * it; when the change is the whole page the outline goes and the page fits
 * the box instead. "Full page" opens the platform's comparison overlay
 * (`openVisualComparison`), which reads the pair off the button's data-*.
 *
 * The diff runs in an EFFECT, and only for the item in view and its two
 * neighbours (`near`) — never for the fifty behind them.
 */
function BeforeAfter({ v, near, onFull }: {
  v: NonNullable<QueueRow['visuals']>;
  near: boolean;
  onFull: (el: HTMLElement) => void;
}): ReactNode {
  const viewRef = useRef<HTMLDivElement>(null);
  const [side, setSide] = useState<Side>(v.after ? 'after' : 'before');
  const [geo, setGeo] = useState<Geo | null>(null);
  const [failed, setFailed] = useState(false);
  const [view, setView] = useState({ w: 0, h: 0 });
  useEffect(() => {
    if (!near || geo || failed) return undefined;
    let live = true;
    diffPair(v.before, v.after)
      .then((g) => { if (live) setGeo(g); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [near, geo, failed, v.before, v.after]);
  useLayoutEffect(() => {
    const el = viewRef.current;
    if (!el || typeof ResizeObserver !== 'function') return undefined;
    const measure = () => setView((cur) => (
      cur.w === el.clientWidth && cur.h === el.clientHeight ? cur : { w: el.clientWidth, h: el.clientHeight }
    ));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  if (failed) return null;
  const id = side === 'after' ? v.after : v.before;
  let style: { width: number; height: number; transform: string } | null = null;
  let spot: { left: number; top: number; width: number; height: number } | null = null;
  let cropped = false;
  if (geo && view.w && view.h) {
    const { w, h, box } = geo;
    if (box) {
      const pad = 24;
      const scale = Math.min(1, view.w / (box.w + pad * 2), view.h / (box.h + pad * 2));
      const sw = w * scale;
      const sh = h * scale;
      // On an axis the still overflows, slide it so the change is centred
      // (clamped to the still's edges); on one it does not, centre the still.
      const tx = sw <= view.w ? (view.w - sw) / 2 : Math.max(view.w - sw, Math.min(0, view.w / 2 - (box.x + box.w / 2) * scale));
      const ty = sh <= view.h ? (view.h - sh) / 2 : Math.max(view.h - sh, Math.min(0, view.h / 2 - (box.y + box.h / 2) * scale));
      style = { width: w, height: h, transform: `translate(${tx}px, ${ty}px) scale(${scale})` };
      spot = { left: box.x * scale + tx, top: box.y * scale + ty, width: box.w * scale, height: box.h * scale };
      cropped = sw > view.w + 1 || sh > view.h + 1;
    } else {
      const scale = Math.min(view.w / w, view.h / h);
      style = { width: w, height: h, transform: `translate(${(view.w - w * scale) / 2}px, ${(view.h - h * scale) / 2}px) scale(${scale})` };
    }
  }
  return (
    <div className="dev-ws-media" data-ws-media="">
      <div className="dev-ws-media-view" ref={viewRef}>
        {id && style ? (
          <img
            className="dev-ws-media-img"
            src={`/visuals/${id}`}
            alt={side === 'after' ? 'After the change' : 'Before the change'}
            style={style}
            draggable={false}
          />
        ) : null}
        {spot ? <span className="dev-ws-media-spot" style={spot} aria-hidden="true" /> : null}
        {geo ? null : <span className="dev-ws-media-wait" aria-hidden="true" />}
      </div>
      <button
        type="button"
        className="dev-ws-media-full"
        data-before-png={v.before || undefined}
        data-after-png={v.after || undefined}
        data-before-webm={v.beforeWebm || undefined}
        data-after-webm={v.afterWebm || undefined}
        data-path={v.path}
        data-viewport={v.mobile ? 'mobile' : undefined}
        data-side={side}
        onClick={(e) => onFull(e.currentTarget)}
      >
        {cropped ? 'Cropped to the change · Full page ↗' : 'Full page ↗'}
      </button>
      {v.before && v.after ? (
        <div className="dev-ws-seg" role="group" aria-label="Before or after">
          <button type="button" className="dev-ws-seg-btn" aria-pressed={side === 'before'} onClick={() => setSide('before')}>Before</button>
          <button type="button" className="dev-ws-seg-btn" aria-pressed={side === 'after'} onClick={() => setSide('after')}>After</button>
        </div>
      ) : (
        <span className="dev-ws-seg dev-ws-seg-one">{v.after ? 'After' : 'Before'}</span>
      )}
    </div>
  );
}

/* ── One item of the feed ────────────────────────────────────────────── */

function FeedItem({ row, index, count, tint, near, voted, wide, slug, onFull }: {
  row: QueueRow;
  index: number;
  count: number;
  /** 'a' or 'b': the row's own, for life (see `tintFor` in NeedsFeed). */
  tint: 'a' | 'b';
  near: boolean;
  voted: string | null;
  wide: boolean;
  slug: string;
  onFull: (el: HTMLElement) => void;
}): ReactNode {
  const isVote = row.kind === 'vote';
  const href = openHref(slug, row.card);
  const title = row.card.title.text || row.card.title.title;
  const chips = chipsFor(row, voted);
  const summary = isVote ? row.summary : (row.body || null);
  const pct = Math.max(2, Math.round(((index + 1) / Math.max(1, count)) * 100));
  return (
    <section className="dev-ws-item" data-ws-item={row.key} data-ws-kind={row.kind} data-ws-tint={tint}>
      <div className="dev-ws-item-progress" aria-hidden="true"><i style={{ width: `${pct}%` }} /></div>
      <div className="dev-ws-item-top">
        {voted ? (
          <span className="dev-ws-item-done" data-ws-item-done="">
            <CheckIcon className="dev-ws-item-tick" aria-hidden="true" />
            {`Voted ${voted} · ${wide ? 'press ↓ or scroll' : 'swipe up'} for the next`}
          </span>
        ) : (
          <span className="dev-ws-eyebrow">{isVote ? 'Proposal · needs your vote' : 'Open issue · nobody on it'}</span>
        )}
        <span className="dev-ws-item-of">{`${index + 1} / ${count}`}</span>
      </div>
      {/* The title is the headline and the door to the full card: its own
          page, with the checks, the thread and every affordance the card
          has. Same route the Board's rows open. */}
      <h2 className="dev-ws-item-title">{href ? <a href={href}>{title}</a> : title}</h2>
      {summary ? (
        <p className="dev-ws-item-summary">{summary}</p>
      ) : (
        <p className="dev-ws-item-summary dev-ws-item-nosummary">
          {isVote ? 'No plain-language summary was written for this change.' : 'This issue has no description.'}
        </p>
      )}
      {row.visuals ? <BeforeAfter v={row.visuals} near={near} onFull={onFull} /> : <div className="dev-ws-item-spacer" aria-hidden="true" />}
      <div className="dev-ws-item-caption">
        <p className="dev-ws-item-by">
          {row.who ? (
            <span className="dev-ws-item-avatar" style={{ background: swatchFor(row.who) }} aria-hidden="true">
              {row.who.slice(0, 1).toUpperCase()}
            </span>
          ) : null}
          <span>
            {isVote ? (
              <>{row.who ? <b>{row.who}</b> : 'Proposed'}{row.ago ? ` · ${row.who ? 'proposed ' : ''}${row.ago}` : ''}</>
            ) : (
              <>
                {row.number != null ? <b>{`#${row.number}`}</b> : null}
                {row.who ? <>{row.number != null ? ' · filed by ' : 'Filed by '}<b>{row.who}</b></> : null}
                {row.ago ? ` · ${row.ago}` : ''}
              </>
            )}
          </span>
        </p>
        {chips.length ? (
          <div className="dev-ws-item-chips">
            {chips.map((c) => <span key={c.key} className={c.cls}>{c.text}</span>)}
          </div>
        ) : null}
      </div>
    </section>
  );
}

/**
 * The scroll position the end card is keyed under (see `curKeyRef` in
 * NeedsFeed): a row key names an item, and this names the slot after them.
 */
const END_KEY = 'done';

/**
 * `?shot=needs-end`: open the feed ON the end card. The declared check's
 * route, and the only way to a state that otherwise takes a swipe past
 * every item. Read at mount, guarded for the vm the tests render in.
 */
function wantsEnd(): boolean {
  if (typeof window === 'undefined' || typeof window.location === 'undefined') return false;
  try { return new URLSearchParams(window.location.search).get('shot') === 'needs-end'; } catch { return false; }
}

/** "3 proposals", "1 proposal": a count with its noun. */
function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The end of the feed: one card past the last item, and the only place a
 * total appears.
 *
 * `acted` is what this pass answered, `left` what it passed over (still in
 * the feed, above), and `leftVotes` the proposals among those, so the ring
 * can say where the viewer stands against `total` — everything they could
 * vote on, answered or not. The headline is one of three: the pass had
 * things in it and answered them all, it left some waiting, or there was
 * nothing to begin with.
 */
function DoneItem({ total, acted, left, leftVotes, onDone, onBack }: {
  total: number;
  acted: number;
  left: number;
  leftVotes: number;
  onDone: () => void;
  onBack: () => void;
}): ReactNode {
  const done = Math.max(0, Math.min(total, total - leftVotes));
  const line = left > 0 ? 'That’s it for now.' : (acted > 0 ? 'That’s it!' : 'You’re all caught up.');
  const parts: string[] = [];
  if (acted > 0) parts.push(`You voted on ${plural(acted, 'proposal', 'proposals')} this time.`);
  if (left > 0) parts.push(`${left} ${left === 1 ? 'is' : 'are'} still waiting on you above.`);
  else if (acted > 0) parts.push('Nothing else needs you right now.');
  else parts.push('Every proposal you can vote on has your answer, and every open issue has somebody on it.');
  return (
    <section
      className="dev-ws-item dev-ws-needs-done"
      data-ws-item={END_KEY}
      data-ws-kind="done"
      data-ws-done-acted={acted}
      data-ws-done-left={left}
    >
      {total ? (
        <ProgressRing
          className="dev-ws-done-ring"
          pct={Math.round((done / total) * 100)}
          label={`${done}/${total}`}
          title={done === total ? `All ${total} open proposals voted on` : `${done} of ${total} open proposals voted on`}
          arcClassName={done === total ? 'stroke-emerald-500' : undefined}
        />
      ) : null}
      <p className="dev-ws-needs-done-line">{line}</p>
      <p className="dev-ws-needs-done-sub">{parts.join(' ')}</p>
      <button type="button" className="dev-ws-done-cta" onClick={onDone}>See what changed this week</button>
      {left > 0 ? (
        <button type="button" className="dev-ws-done-back" data-ws-done-back="" onClick={onBack}>
          Back to the first one waiting
        </button>
      ) : null}
    </section>
  );
}

/* ── The feed ────────────────────────────────────────────────────────── */

function NeedsFeed({ rows, total, models, slug, canPost, onDone }: {
  rows: DevWorkshopView['queue'];
  total: number;
  models: DevWorkshopView['models'];
  slug: string;
  canPost: boolean;
  onDone: () => void;
}): ReactNode {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Whether the route asked to open on the end card. Read once, at mount:
  // the URL does not change for the life of the feed, and a state seed is
  // the one place a render-time read of it is evaluated once.
  const [endOnOpen] = useState(wantsEnd);
  // Which slot is in view: an item's index, or `n` for the end card. The
  // `?shot=needs-end` route opens on the end card, so the seed is the count
  // of rows the publish already holds (the re-sync below corrects it by key
  // when rows land later).
  const [at, setAt] = useState(() => (endOnOpen ? rows.filter((r) => r.t === 'card').length : 0));
  const [sheet, setSheet] = useState<SheetKind | null>(null);
  // The sheet on its way out. It stays mounted, marked `data-ws-leaving`,
  // for as long as app.css's leave animation runs, then is dropped.
  const [leaving, setLeaving] = useState<SheetKind | null>(null);
  // Whether the on-screen keyboard is up. The kit measures it and app.css
  // lifts the sheet's floor by `--un-kb-inset` on its own; this is only the
  // flag `[data-ws-kb]` needs to give the card the short sheet's full height.
  const [kbUp, setKbUp] = useState(false);
  // Answered here, this session: the pinned row's confirmation.
  const [answered, setAnswered] = useState<Record<string, string>>({});
  // The pins, keyed by row, with the index each held when it was answered.
  // A ref with a version counter rather than state, because a pin is set in
  // the same breath as the vote and read back in the very next publish.
  const pinsRef = useRef<Map<string, { row: QueueRow; index: number }>>(new Map());
  const [pinsVersion, setPinsVersion] = useState(0);
  // Which row the reader is ON, by key — the thing the list is re-synced to
  // when rows leave or arrive above it. `END_KEY` is the end card, the slot
  // after every row, and it is the seed when the route asked for it.
  const curKeyRef = useRef<string | null>(endOnOpen ? END_KEY : null);
  // Still owed the instant scroll to the end card (the effect below): true
  // until the scroller has a height to scroll by.
  const endScrollRef = useRef<boolean>(endOnOpen);
  const moreRef = useRef<HTMLButtonElement>(null);
  const commentsRef = useRef<HTMLDivElement>(null);
  const wide = useMediaFlag(WIDE_QUERY);

  // Keyed by row, so moving to the next proposal does not carry the last
  // one's conversation with it.
  const [threads, setThreads] = useState<Record<string, AskMsg[]>>({});
  const [draft, setDraft] = useState('');
  // Which row has a question in flight. Keyed like the threads rather than a
  // bare boolean: the feed still moves while an answer is coming, and an
  // answer that lands after you have moved on belongs to the row it was
  // asked about.
  const [asking, setAsking] = useState<Record<string, boolean>>({});
  // Which rows have had their stored thread fetched. Marked BEFORE the
  // request goes out, so moving away and back does not fire a second one.
  // A REF, NOT STATE: as state it would be a dependency of the effect that
  // writes it, and the effect would tear itself down on every write.
  const loadedRef = useRef<Set<string>>(new Set());
  // Which model answers. The dev session's own list and its own default —
  // see `_workshopModels`.
  const [model, setModel] = useState<string>(() => models.selected || '');

  const items = useMemo<QueueRow[]>(() => {
    const live = rows.filter((r): r is QueueRow => r.t === 'card');
    const have = new Set(live.map((r) => r.key));
    const out = live.slice();
    for (const [key, pin] of pinsRef.current) {
      if (!have.has(key)) out.splice(Math.min(pin.index, out.length), 0, pin.row);
    }
    return out;
  }, [rows, pinsVersion]);
  const n = items.length;
  // `n + 1` slots: the items, then the end card (#2172). `i === n` is the
  // end card, and `row` is null there.
  const i = Math.min(at, n);
  const row = i < n ? items[i] : null;
  // What the pass amounts to, for the end card: answered here this session
  // (the pinned rows), and passed over (still in the feed, unanswered).
  const acted = items.filter((r) => !!answered[r.key]).length;
  const left = n - acted;
  const leftVotes = items.filter((r) => r.kind === 'vote' && !answered[r.key]).length;
  /**
   * Each row's tint, decided the first time it is seen and kept for life.
   * The tints alternate so a swipe reads as a new item, and a row seen for
   * the first time takes the opposite of the row before it, so a list seen
   * whole alternates perfectly and a row that arrives later still differs
   * from its neighbour above. Keyed on the index of the moment instead, a
   * row leaving above the one in view would flip every tint after it, and
   * the card in front of the reader would change colour for nothing.
   */
  const tintRef = useRef<Map<string, 'a' | 'b'>>(new Map());
  const tints = useMemo<Array<'a' | 'b'>>(() => {
    const seen = tintRef.current;
    const out: Array<'a' | 'b'> = [];
    let prev: 'a' | 'b' | null = null;
    for (const r of items) {
      let tint = seen.get(r.key);
      if (!tint) { tint = prev === 'a' ? 'b' : 'a'; seen.set(r.key, tint); }
      out.push(tint);
      prev = tint;
    }
    return out;
  }, [items]);
  const voted = row ? answered[row.key] || null : null;

  /**
   * Stay on the row you were on when the list changes under you.
   *
   * A layout effect, so the scroll position is corrected in the same frame
   * the rows shift: a row leaving ABOVE the current one would otherwise slide
   * the next row into view for a paint. By key, because indexes are what the
   * change moves.
   */
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const key = curKeyRef.current;
    if (key) {
      const idx = key === END_KEY ? items.length : items.findIndex((r) => r.key === key);
      if (idx >= 0) {
        if (idx !== at) {
          setAt(idx);
          // INSTANTLY. The scroller has `scroll-behavior: smooth`, which
          // applies to this assignment too, so the correction would ANIMATE
          // from where the shifted rows left the view to where the row is —
          // a card sliding through for a third of a second, which is the
          // "reset" a viewer saw. Off for the one assignment, then back.
          if (el && el.clientHeight) {
            el.style.scrollBehavior = 'auto';
            el.scrollTop = idx * el.clientHeight;
            el.style.scrollBehavior = '';
          }
        }
        return;
      }
    }
    // The end card is a place to BE only once there are rows to be past:
    // with none, the key stays unset, so the first rows to land are what the
    // reader opens on rather than the card after them.
    const clamped = Math.min(at, items.length);
    curKeyRef.current = items[clamped] ? items[clamped].key : null;
    if (clamped !== at) setAt(clamped);
  }, [items]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * The `?shot=needs-end` open: the seed put `at` on the end card, and this
   * puts the scroller there in the same frame, instantly (see the re-sync
   * above for why not smoothly). Once — but on the first publish that finds
   * the scroller laid out, not necessarily the first render, because a
   * scroller with no height yet has nothing to scroll by. After that, rows
   * landing later are the re-sync's job, which follows `END_KEY` to wherever
   * the end moves.
   */
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!endScrollRef.current || !el || !el.clientHeight) return;
    endScrollRef.current = false;
    el.style.scrollBehavior = 'auto';
    el.scrollTop = items.length * el.clientHeight;
    el.style.scrollBehavior = '';
  }, [items]);

  const landOn = (idx: number) => {
    const c = Math.min(Math.max(idx, 0), items.length);
    curKeyRef.current = items[c] ? items[c].key : (items.length ? END_KEY : null);
    setAt(c);
    // A sheet stays with its item: arriving on the end card closes it, so
    // the way back up shows the card and not a panel about the row above.
    if (c >= items.length && sheet) { setLeaving(null); setSheet(null); }
  };
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el || !el.clientHeight) return;
    const idx = Math.round(el.scrollTop / el.clientHeight);
    if (idx !== at) landOn(idx);
  };
  /**
   * Moving through the feed by a press rather than a swipe. No wrap: the
   * ends are the ends, and the counter says which one you are at.
   */
  const go = (delta: number) => {
    const el = scrollRef.current;
    const idx = Math.min(Math.max(i + delta, 0), n);
    if (idx === i) return;
    if (el && el.clientHeight) el.scrollTo({ top: idx * el.clientHeight, behavior: 'smooth' });
    landOn(idx);
  };

  const closeSheet = () => {
    if (!sheet) return;
    setLeaving(sheet);
    setSheet(null);
  };
  const toggleSheet = (kind: SheetKind) => {
    if (sheet === kind) { closeSheet(); return; }
    setLeaving(null);
    setSheet(kind);
  };
  // The leave animation's length, then the sheet is gone. Nothing to wait
  // for where motion is unwelcome — app.css runs no animation there.
  useEffect(() => {
    if (!leaving) return undefined;
    const still = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const t = window.setTimeout(() => setLeaving(null), still ? 0 : 220);
    return () => window.clearTimeout(t);
  }, [leaving]);
  // THE KEYBOARD. A fixed sheet is laid out against the layout viewport, which
  // the on-screen keyboard does not shrink — so on a phone the card's floor,
  // and the field on it, sat under the keys. app.css lifts that floor by
  // `--un-kb-inset`, and the kit maintains it from ONE visualViewport tracker
  // for the whole page.
  //
  // This screen used to measure the viewport itself, which is how it ended up
  // with its own `innerHeight - vv.height - vv.offsetTop` — the expression
  // #1938 proved wrong on iOS, where `innerHeight` collapses to the visual
  // viewport and the result goes negative. `Math.max(0, …)` turned that into a
  // confident zero, so the sheet simply never lifted on an iPhone and nothing
  // looked broken enough to notice. Reading the kit's number is what stops a
  // fourth copy of that arithmetic drifting out of step with the other three.
  //
  // What is left is the part CSS cannot do: the sheet got shorter, so the
  // field inside it has to be scrolled back into view. `un-kb` lands on <html>
  // from the kit's own rAF, so this observes the class rather than racing it
  // through a second viewport listener. Only while a sheet is up, and only
  // below the breakpoint: a panel on a wide window is not fixed at all.
  useEffect(() => {
    if (!sheet || wide || typeof document === 'undefined') return undefined;
    const docEl = document.documentElement;
    const sync = () => {
      const up = docEl.classList.contains('un-kb');
      setKbUp((cur) => (cur === up ? cur : up));
      if (!up) return;
      const active = document.activeElement as HTMLElement | null;
      if (active && active.closest('.dev-ws-sheet-modal')) active.scrollIntoView({ block: 'nearest' });
    };
    const observer = new MutationObserver(sync);
    observer.observe(docEl, { attributes: true, attributeFilter: ['class'] });
    sync();
    return () => {
      observer.disconnect();
      setKbUp(false);
    };
  }, [sheet, wide]);

  /**
   * Answering the item: a vote, or taking an issue. The row is pinned BEFORE
   * the act, because the act's publish removes it from the queue, and the
   * pin is what keeps it on screen with its confirmation.
   */
  const answer = (which: 'yes' | 'no') => {
    if (!row) return;
    const spec = which === 'yes' ? row.yes : row.no;
    if (!spec) return;
    if (row.kind === 'vote') {
      // PINNED FOR THE SESSION, not until the next move. The vote makes the
      // row leave `rows` (it is no longer owed), and the pin keeps it in its
      // slot, so nothing under the viewer shifts: a row leaving ABOVE the
      // one in view moves every index after it, and with it the counter,
      // and the scroll position has to be corrected under the reader. The
      // pins used to go once the next card had settled, which was exactly
      // when that correction was most visible — the card you had just
      // arrived on re-numbered and slid.
      if (!pinsRef.current.has(row.key)) {
        pinsRef.current.set(row.key, { row, index: i });
        setPinsVersion((v) => v + 1);
      }
      setAnswered((cur) => ({ ...cur, [row.key]: which }));
    }
    closeSheet();
    if (spec.act) callAppView(spec.act.fn, ...(spec.act.args as unknown[]));
  };

  const preview = row ? (row.card.rail.preview || row.card.actionPreview || null) : null;
  const canTry = !!(preview && preview.state === 'live');
  const tryIt = () => {
    if (preview && preview.state === 'live') callAppView('swapToStagingForSession', preview.sessionId, preview.url);
  };
  const openFull = (el: HTMLElement) => callAppView('openVisualComparison', el);
  const menuKey = row ? row.card.rail.menuKey : undefined;
  // The card's own page, offered under More as "Open card": here the item IS
  // the screen, so there is no card face to tap for it (app-view.js's
  // _toggleCardMenu reads it off the trigger).
  const cardHref = row ? openHref(slug, row.card) : null;
  // What is rendered: the open sheet, or the one still leaving. Never on
  // the end card, which has no item for a sheet to be about.
  const shown = row ? (sheet || leaving) : null;
  const leavingAttr = !sheet && leaving ? { 'data-ws-leaving': '' } : {};
  const commentCount = row ? (row.card.chatCount || 0) : 0;

  /**
   * The keys. Every one is also a button on the rail, so nothing is ONLY a
   * key; they are listed on the wide layout, where a keyboard is likely.
   * Ignored while a field has focus — typing "v" in the ask box is typing.
   * No dependency list on purpose: the handler closes over this render's
   * state, and re-binding is cheaper than a stale row.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key;
      if (k === 'Escape') { if (sheet) { closeSheet(); e.preventDefault(); } return; }
      if (k === 'ArrowDown' || k === 'j' || k === 'J') { go(1); e.preventDefault(); return; }
      if (k === 'ArrowUp' || k === 'k' || k === 'K') { go(-1); e.preventDefault(); return; }
      if (!row) return;
      if ((k === 'v' || k === 'V') && row.kind === 'vote') { toggleSheet('vote'); return; }
      if ((k === 'y' || k === 'Y') && sheet === 'vote') { answer('yes'); return; }
      if ((k === 'n' || k === 'N') && sheet === 'vote') { answer('no'); return; }
      if (k === 'a' || k === 'A') { toggleSheet('ask'); return; }
      if (k === 'c' || k === 'C') { toggleSheet('comments'); return; }
      if ((k === 't' || k === 'T') && canTry) { tryIt(); return; }
      if ((k === 'm' || k === 'M') && moreRef.current) moreRef.current.click();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // The comments sheet's GitHub thread is filled by the legacy observer, so
  // it is pointed at the sheet each time one opens.
  useLayoutEffect(() => {
    if (sheet !== 'comments') return;
    const host = commentsRef.current;
    if (host) callAppView('_wireFeedComments', host);
  }, [sheet, row ? row.key : null]); // eslint-disable-line react-hooks/exhaustive-deps

  const target = row ? row.askAbout || null : null;
  const thread = row ? threads[row.key] || [] : [];
  const engaged = thread.length > 0;
  const inFlight = !!(row && asking[row.key]);

  /**
   * Bring back what this viewer already asked about this item. In an effect
   * and never in render — the shell's rule for a stateful island. It never
   * overwrites a thread that already has turns in it.
   */
  useEffect(() => {
    if (!row || sheet !== 'ask' || !target || loadedRef.current.has(row.key)) return undefined;
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
      // is the state it opens in anyway.
      .catch(() => {});
    return () => { live = false; };
    // PRIMITIVES ONLY: `target` is an object off the view model, and a
    // republish that rebuilds it would otherwise tear the effect down.
  }, [slug, sheet, row ? row.key : null, target ? target.kind : null, target ? target.ref : null]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Send one question and write the answer in under it. THE ROW IS CAPTURED,
   * not read back at resolve time: the feed keeps moving while an answer is
   * on its way, and an answer about item A appended to item B's thread is
   * worse than no answer at all.
   */
  const ask = async () => {
    const q = draft.trim();
    if (!row || !q || !target || inFlight) return;
    const key = row.key;
    const sending = row;
    const prior = threads[key] || [];
    setThreads((cur) => ({
      ...cur,
      [key]: [...prior, { who: 'you', text: q }, { who: 'ai', text: 'Reading the change…', pending: true }],
    }));
    setAsking((cur) => ({ ...cur, [key]: true }));
    setDraft('');

    // Writes the trailing bubble in place: the LAST one on this row's
    // thread, and only while it is still pending.
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
        // No transcript rides along. The server keeps this viewer's own
        // thread and reads it back itself, so the history cannot be
        // rewritten by whoever is asking.
        body: JSON.stringify({ target: sending.askAbout, question: q, model: model || undefined }),
      });
      // A refusal the server could make BEFORE opening the stream is still
      // ordinary JSON with a real status, so that shape is handled first.
      const isStream = (res.headers.get('content-type') || '').includes('text/event-stream');
      if (!res.ok || !isStream || !res.body) {
        const data = await res.json().catch(() => ({}));
        failed = true;
        // The server's own sentence wherever it wrote one: it is the only
        // thing that can say WHICH of "out of allowance", "too many at once"
        // and "no model is configured" happened.
        text = (typeof data.error === 'string' && data.error.trim())
          ? data.error.trim()
          : 'That did not go through. Try asking again.';
      } else {
        const parsed = await readAskStream(res.body, (sofar) => {
          writeTail({ who: 'ai', text: sofar, pending: true });
        });
        if (parsed.error) {
          failed = true;
          text = parsed.error;
        } else if (parsed.text.trim()) {
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

  /**
   * ONE send circle, rendered in one of two places: the resting line while
   * the composer is a single row, the controls row once it opens. Written
   * once so the disabled rule and the classes cannot drift between the two.
   */
  const sendBtn = (
    <button
      type="submit"
      className="dc-send-btn dc-circle-send dev-ws-ask-send"
      aria-label="Ask"
      disabled={!draft.trim() || !target || inFlight}
    ><ArrowUpIcon className="dev-ws-ask-send-icon" aria-hidden="true" /></button>
  );

  /**
   * Moving by a press. On a phone the swipe is the move and app.css hides
   * these; on a wide window they sit under the rail and do what the wheel
   * does. Disabled at the ends rather than wrapping: the end card is the
   * last slot, so Next goes dark there. Written once, because the rail on
   * the end card is these alone (see below).
   */
  const moveRow = (
    <div className="dev-ws-move" data-ws-move-row="">
      <button type="button" className="dev-ws-move-btn" data-ws-move="prev" aria-label="Previous" disabled={i <= 0} onClick={() => go(-1)}>
        <ChevronUpIcon className="dev-ws-move-icon" aria-hidden="true" />
      </button>
      <button type="button" className="dev-ws-move-btn" data-ws-move="next" aria-label="Next" disabled={i >= n} onClick={() => go(1)}>
        <ChevronDownIcon className="dev-ws-move-icon" aria-hidden="true" />
      </button>
    </div>
  );

  return (
    <div
      className="dev-ws-needs"
      data-ws-needs=""
      data-ws-sheet={shown || undefined}
      data-ws-kb={kbUp ? '' : undefined}
    >
      {/* THE FEED. A real scroll container with snap points, not a swap of one
          rendered card: every row stays in the DOM (the legacy fillers find
          their hosts, a deep link can name a row that is not in view), a
          drag pages it with `scroll-snap`, and the index is read back from
          the scroll position so a swipe and a press cannot disagree. */}
      <div className="dev-ws-needs-scroll" data-ws-feed="" ref={scrollRef} onScroll={onScroll}>
        {items.map((r, k) => (
          <FeedItem
            key={r.key}
            row={r}
            index={k}
            count={n}
            tint={tints[k]}
            near={Math.abs(k - i) <= 1}
            voted={answered[r.key] || null}
            wide={wide}
            slug={slug}
            onFull={openFull}
          />
        ))}
        {/* ALWAYS, after the last item: the swipe past the end lands here.
            With no items it is the whole screen. */}
        <DoneItem
          total={total}
          acted={acted}
          left={left}
          leftVotes={leftVotes}
          onDone={onDone}
          onBack={() => go(items.findIndex((r) => !answered[r.key]) - i)}
        />
      </div>

      {row ? (
        <aside className="dev-ws-rail" data-ws-rail="" aria-label="This item">
          {row.kind === 'vote' ? (
            <button
              type="button"
              className={voted ? 'dev-ws-rail-btn dev-ws-rail-vote is-on' : 'dev-ws-rail-btn dev-ws-rail-vote'}
              data-ws-rail-btn="vote"
              aria-haspopup="dialog"
              aria-expanded={sheet === 'vote'}
              onClick={() => toggleSheet('vote')}
            >
              <span className="dev-ws-rail-ic">{voted ? <CheckIcon aria-hidden="true" /> : <BallotIcon aria-hidden="true" />}</span>
              <span className="dev-ws-rail-lab">{voted ? `Voted ${voted}` : 'Vote'}</span>
              <kbd className="dev-ws-rail-key" aria-hidden="true">V</kbd>
            </button>
          ) : (
            <button
              type="button"
              className="dev-ws-rail-btn dev-ws-rail-take"
              data-ws-rail-btn="take"
              disabled={!row.yes}
              onClick={() => answer('yes')}
            >
              <span className="dev-ws-rail-ic"><HandRaisedIcon aria-hidden="true" /></span>
              <span className="dev-ws-rail-lab">Take it</span>
            </button>
          )}
          <button
            type="button"
            className="dev-ws-rail-btn dev-ws-rail-comments"
            data-ws-rail-btn="comments"
            aria-haspopup="dialog"
            aria-expanded={sheet === 'comments'}
            onClick={() => toggleSheet('comments')}
          >
            <span className="dev-ws-rail-ic"><ChatBubbleTailIcon aria-hidden="true" /></span>
            <span className="dev-ws-rail-lab">{commentCount ? String(commentCount) : 'Comments'}</span>
            <kbd className="dev-ws-rail-key" aria-hidden="true">C</kbd>
          </button>
          <button
            type="button"
            className="dev-ws-rail-btn dev-ws-rail-ask"
            data-ws-rail-btn="ask"
            aria-haspopup="dialog"
            aria-expanded={sheet === 'ask'}
            onClick={() => toggleSheet('ask')}
          >
            <span className="dev-ws-rail-ic"><SparklesIcon aria-hidden="true" /></span>
            <span className="dev-ws-rail-lab">Ask</span>
            <kbd className="dev-ws-rail-key" aria-hidden="true">A</kbd>
          </button>
          {row.kind === 'vote' ? (
            <button
              type="button"
              className="dev-ws-rail-btn dev-ws-rail-try"
              data-ws-rail-btn="try"
              disabled={!canTry}
              title={preview && preview.state !== 'live' ? preview.title : undefined}
              onClick={tryIt}
            >
              <span className="dev-ws-rail-ic"><PlayIcon aria-hidden="true" /></span>
              <span className="dev-ws-rail-lab">Try it</span>
              <kbd className="dev-ws-rail-key" aria-hidden="true">T</kbd>
            </button>
          ) : null}
          {/* The card's own ⋯ menu, on the rail. Same hook, same class, so
              the delegated handler and the declared checks find it. */}
          <button
            ref={moreRef}
            type="button"
            className="dev-ws-rail-btn dev-ws-rail-more dev-card-menu-btn"
            data-ws-rail-btn="more"
            data-card-menu={menuKey}
            data-card-menu-open={cardHref || undefined}
            disabled={!menuKey && !cardHref}
            aria-haspopup="true"
            aria-label="More actions"
          >
            <span className="dev-ws-rail-ic"><EllipsisHorizontalIcon aria-hidden="true" /></span>
            <span className="dev-ws-rail-lab">More</span>
            <kbd className="dev-ws-rail-key" aria-hidden="true">M</kbd>
          </button>
          {moveRow}
          {/* The vote: the question, where it stands, and the two answers. A
              sheet from the floor on a phone, a popover on this button on a
              wide window (app.css). Decide later closes it. */}
          {row.kind === 'vote' && shown === 'vote' ? (
            <div className="dev-ws-sheet-modal dev-ws-sheet-vote" data-ws-sheet="vote" role="dialog" aria-label={row.ask} {...leavingAttr}>
              <button type="button" className="dev-ws-scrim" aria-label="Close" onClick={closeSheet} />
              <div className="dev-ws-sheet-card">
                <span className="dev-ws-sheet-handle" aria-hidden="true" />
                <p className="dev-ws-ask-q">{row.ask}</p>
                <p className="dev-ws-vote-sub">{tallyLine(row)}</p>
                <div className="dev-ws-answer-row">
                  <button type="button" className="dev-ws-answer-btn dev-ws-answer-yes" data-ws-answer-btn="yes" disabled={!row.yes} onClick={() => answer('yes')}>Vote yes</button>
                  <button type="button" className="dev-ws-answer-btn dev-ws-answer-no" data-ws-answer-btn="no" disabled={!row.no} onClick={() => answer('no')}>Vote no</button>
                </div>
                <button type="button" className="dev-ws-vote-later" onClick={closeSheet}>Decide later</button>
                <p className="dev-ws-keys-hint" aria-hidden="true">Y yes · N no · Esc close</p>
              </div>
            </div>
          ) : null}
        </aside>
      ) : (
        /* THE END CARD'S RAIL: the move pair alone, so the way back up is
           where the thumb learned it is, and on a wide window the stage
           keeps its width rather than re-centring when the rail goes. On a
           phone the pair is hidden (app.css) and the rail draws nothing.
           Only once there are rows to go back to: an empty queue has no
           rail, as before. */
        n ? (
          <aside className="dev-ws-rail dev-ws-rail-end" data-ws-rail="" aria-label="The end of the feed">
            {moveRow}
          </aside>
        ) : null
      )}

      {/* The keys, listed once, where a keyboard is likely (app.css). Only
          the keys this item answers to: an issue has no vote and nothing
          to try, so those two are left off rather than listed and dead.
          Each pair is one child with one text run, so the prerender never
          emits two adjacent text nodes (React #418). */}
      {row || n ? (
        <p className="dev-ws-keys" aria-hidden="true">
          {legendFor(row ? row.kind : 'done').map(([keys, word]) => (
            <span key={word} className="dev-ws-key">
              {keys.map((k) => <kbd key={k}>{k}</kbd>)}
              {` ${word}`}
            </span>
          ))}
        </p>
      ) : null}

      {/* ── Ask: the private Q&A with the model, about the item in view ──
          A sheet on a phone, a panel beside the rail on a wide window. The
          composer is the dev session's own (`.dc-card`), as far as this pane
          needs it — see the note on `sendBtn`. */}
      {row && shown === 'ask' ? (
      <div className="dev-ws-sheet-modal dev-ws-sheet-ask" data-ws-sheet="ask" role="dialog" aria-label="Ask about this item" {...leavingAttr}>
      <button type="button" className="dev-ws-scrim" aria-label="Close" onClick={closeSheet} />
      <section className="dev-ws-ask dev-ws-sheet-card" data-ws-ask="">
        <span className="dev-ws-sheet-handle" aria-hidden="true" />
        <div className="dev-ws-sheet-head">
          <span><span className="dev-ws-sheet-title">{row.kind === 'vote' ? 'Ask about this change' : 'Ask about this issue'}</span><span className="dev-ws-sheet-sub">private to you</span></span>
          <button type="button" className="dev-ws-sheet-x" onClick={closeSheet}>Close</button>
        </div>
        <div className="dev-ws-ask-log" data-ws-ask-log="">
          {engaged ? thread.map((m, k) => (
            <p
              key={k}
              className={askMsgClass(m)}
              /* The answer is the one thing here nobody in this app wrote,
                 so it is announced. Polite, not assertive. */
              aria-live={m.who === 'ai' ? 'polite' : undefined}
            >
              {m.text}
            </p>
          )) : (
            <p className="dev-ws-ask-hint">
              {target ? 'Ask what this changes, who it affects, or what happens if it goes in. Answered from what the platform knows about it.' : 'There are no details to ask about on this one.'}
            </p>
          )}
        </div>
        <form
          className="dev-ws-ask-composer dc-card"
          onSubmit={(e) => { e.preventDefault(); ask(); }}
        >
          <label className="sr-only" htmlFor="dev-ws-ask-input">Ask about this change</label>
          {/* THE FIELD on a line of its own; the controls row is under it. */}
          <div className="dev-ws-ask-line">
            <input
              id="dev-ws-ask-input"
              className="dev-ws-ask-input"
              type="text"
              value={draft}
              placeholder={
                !target ? 'No details to ask about on this one'
                  : inFlight ? 'Reading the change…'
                    : 'Ask a question…'
              }
              disabled={!target || inFlight}
              onChange={(e) => setDraft(e.target.value)}
            />
          </div>
          {/* THE CONTROLS ROW is there at every width: the model picker, and
              the send circle as the card's last thing. It used to wait for a
              tap on the field on a phone, and a picker behind a tap nobody
              knows to make is a picker nobody uses. */}
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
                  {models.list.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
                <ChevronDownIcon className="dev-ws-ask-model-chev" aria-hidden="true" />
              </span>
            ) : null}
            {/* `margin-left: auto` in app.css, so the circle is at the card's
                right edge whether or not the model picker is beside it. */}
            {sendBtn}
          </div>
        </form>
      </section>
      </div>
      ) : null}

      {/* ── Comments: the app's own thread, and an issue's GitHub thread ──
          The thread component is the one the unfolded rows use; the GitHub
          slot is the legacy filler's host, pointed at this sheet when it
          opens. */}
      {row && shown === 'comments' ? (
      <div className="dev-ws-sheet-modal dev-ws-sheet-comments" data-ws-sheet="comments" role="dialog" aria-label="Comments" {...leavingAttr}>
      <button type="button" className="dev-ws-scrim" aria-label="Close" onClick={closeSheet} />
      <section className="dev-ws-sheet-card" data-ws-comments="">
        <span className="dev-ws-sheet-handle" aria-hidden="true" />
        <div className="dev-ws-sheet-head">
          <span><span className="dev-ws-sheet-title">{commentCount ? `${commentCount} ${commentCount === 1 ? 'comment' : 'comments'}` : 'Comments'}</span><span className="dev-ws-sheet-sub">{row.kind === 'vote' ? 'on this proposal' : 'on this issue'}</span></span>
          <button type="button" className="dev-ws-sheet-x" onClick={closeSheet}>Close</button>
        </div>
        <div className="dev-ws-sheet-body" ref={commentsRef}>
          {row.commentsFor != null ? <div className="dev-feed-comments" data-comments-for={row.commentsFor} /> : null}
          {row.thread ? (
            <FeedThread slug={slug} type={row.thread.type} refId={row.thread.ref} canPost={canPost} />
          ) : null}
          {!row.thread && row.commentsFor == null ? <p className="dev-ws-ask-hint">No comments yet.</p> : null}
        </div>
      </section>
      </div>
      ) : null}
    </div>
  );
}

/**
 * The grouping strip — "By theme" / "By stage".
 *
 * ONE NODE, RENDERED IN ONE OF TWO PLACES, which is the arrangement the tab
 * bar above it already uses (see `useRailHost`). Below 768px it is a row of
 * the pane's sticky head, full width, as it has always been. From 768px up it
 * moves into `.dev-ws-ear` — a surface hanging off the pane's top-right
 * corner, beside the lander's tab pill — and app.css shrinks it to its labels
 * there. Rendered in ONE place at a time rather than twice with one hidden:
 * `[data-ws-group]` is what the declared checks and `querySelector` reach
 * for, and a hidden twin is the copy they would find first.
 */
function GroupStrip({ group }: { group: string }): ReactNode {
  return (
    <div className="dev-ws-group" role="tablist" aria-label="Group the board by">
      <button
        type="button"
        role="tab"
        className="dev-ws-group-tab"
        data-ws-group="theme"
        aria-selected={group === 'theme'}
        onClick={() => callAppView('_setWorkshopGroup', 'theme')}
      >
        By theme
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
  );
}

/**
 * The breakpoint, in one place. app.css's `@media (min-width: 700px)` block is
 * the same decision written in the other language, and the two move together:
 * above it the tab strip is a segmented control at the head of the column and
 * the feed's sheets are panels beside it; below it the strip is a bar stuck to
 * the floor and the sheets rise from it, stopping above the keyboard.
 */
const WIDE_QUERY = '(min-width: 700px)';

/**
 * The OTHER breakpoint, and it is deliberately not that one.
 *
 * From 768px up the grouping strip leaves the pane head and sits beside the
 * tab pill as an ear on the pane's top-right corner (app.css, "The grouping
 * strip as an EAR"). 768 rather than 700 because the reading column tops out
 * at 760px there: above it the row has exactly one appearance — a 444px pill,
 * a 233px ear, 83px of air — at every width, and below it the two would close
 * on each other through a 60px band before the rail breakpoint took the pill
 * away. Those three numbers are measured, not chosen.
 */
const EAR_QUERY = '(min-width: 768px)';

/** `matchMedia` where there is one — the vm the tests render in has none. */
function matchesQuery(query: string): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(query).matches
    : false;
}

/**
 * Is this the wide layout?
 *
 * READ AT MOUNT, not in an effect — which is the opposite of `useRailHost`
 * below, and the difference is worth stating. That hook returns null until
 * after mount because the node it moves has to agree with markup that may
 * have been prerendered. NOTHING here is: the Workshop mounts client-side
 * into a host `_repaintDevBody()` creates, so there is no first paint to
 * disagree with, and the component's own header says so. The seed matters
 * because the composer's resting state differs by width: a collapsed frame
 * followed a tick later by an expanded one is a flash on every visit to the
 * Needs-you tab.
 *
 * The effect is still there for the CROSSING — a rotated phone, a resized
 * window — which the seed alone cannot see.
 */
function useMediaFlag(query: string): boolean {
  const [on, setOn] = useState(() => matchesQuery(query));
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia(query);
    const apply = () => setOn(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [query]);
  return on;
}

/**
 * The air between the tab pill and the ear, once the ear claims the rest.
 *
 * The two surfaces are level and adjacent, so this is the seam between them
 * rather than a layout gap — the same 10px the ear spends on its own
 * horizontal padding, so the distance from the pill to the first label reads
 * as one step.
 */
const EAR_GAP_PX = 10;

/**
 * Everything `useEarInset` publishes, so the teardown cannot miss one.
 *
 * They are all derived from the same measurement and all read by app.css; a
 * stale one left on the host would be inherited by the next crossing, which
 * is why this is a list rather than four remove calls written out.
 */
const EAR_PROPS = ['--dev-ws-ear-left', '--dev-ws-group-w', '--dev-ws-head-top'];

/** The ear's own horizontal padding (`padding: 5px 10px`, app.css). */
const EAR_PAD_X = 10;

/** The column gap between the tab strip and the pane below it (`.dev-ws`). */
const WS_GAP_PX = 10;

/**
 * The narrowest the ear is allowed to be, which is what its labels need.
 *
 * Measured: "By category" + "By stage" plus the rail's padding come to 233px.
 * The clamp matters at the bottom of the ear's range — just above 768px the
 * pill is 444px of a 760px column, so the honest answer for `left` would
 * leave the ear 306px, but a longer translation of either label (or a user
 * font scale) narrows that fast. Past the clamp the ear stops growing
 * leftward and keeps its content rather than crushing it; `right: 0` is never
 * given up, so the pane's right edge is still tracked.
 */
const EAR_MIN_PX = 240;

/**
 * WHY THE SURFACE MAY GROW AND THE LABELS MAY NOT.
 *
 * The ear's right edge is the pane's, in CSS (`right: 0` on a child of the
 * head), so on By stage — where the pane goes full-bleed — the surface grows
 * with it. For one round it was measured off the tab strip's column instead,
 * to stop it "shifting right with the pane growth"; that held the ear at a
 * fixed 306px and needed three more custom properties to put the pane's
 * outline back to the right of it.
 *
 * What makes the simpler anchor work now is that the TABS no longer share the
 * surface (`flex: 0 0 auto`, app.css). Sharing it is what made a full-bleed
 * pane produce 268px and 348px tabs — a title bar with a label in it — and
 * what the retired width cap existed to prevent. With the labels hugging at
 * the surface's left end, the control sits at the same coordinates under
 * either grouping and only the surface behind it changes width, so there is
 * nothing left for a cap to catch.
 *
 * The cost is deliberate: on By theme the labels no longer fill their
 * surface, leaving empty ear to the right of "By stage".
 */

/**
 * Stretch the ear leftward to meet the tab pill.
 *
 * The ear used to hug its two labels, which left a wide band of dead space
 * between it and the pill — 83px at the narrow end and the same at every
 * width, because both boxes were content-sized inside a column that tops out
 * at 760px. It now spans from just clear of the pill to the pane's right
 * edge, and the two tabs share that width (`flex: 1 1 0` in app.css).
 *
 * WHY THIS IS MEASURED RATHER THAN WRITTEN IN CSS. The pill is
 * `.dev-ws-tabtrack` inside `.dev-ws-tabs`, and the ear is a child of the
 * pane: different subtrees, so no selector can hand one the other's width.
 * The nav is left-aligned on the same reading column as the pane (see the
 * `justify-content: flex-start` note in app.css), which is what makes the
 * pill's right edge the ear's left bound in the first place — but its width
 * is three text labels, so only a measurement knows it.
 *
 * NO FEEDBACK LOOP HERE, unlike the filter strip's measurement: the ear is
 * absolutely positioned and therefore out of flow, so its width cannot
 * change the pill's or the pane's. The observer watches the two boxes it
 * reads and writes a property neither of them consults.
 *
 * The value lands as a custom property on `.dev-ws` and is inherited by the
 * ear, so React renders no style of its own — the same rule the rest of the
 * shell follows for anything written at runtime.
 */
function useEarInset(
  bar: HTMLElement | null,
  hostRef: React.RefObject<HTMLDivElement | null>,
  earUp: boolean,
): void {
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    // Down at phone width the strip is back in the pane head and the ear does
    // not exist. Clear the property rather than leave a stale number on the
    // host for the next crossing to inherit.
    if (!earUp || !bar) {
      for (const k of EAR_PROPS) host.style.removeProperty(k);
      return undefined;
    }
    const track = bar.querySelector<HTMLElement>('.dev-ws-tabtrack');
    const pane = host.querySelector<HTMLElement>('[data-ws-pane]');
    if (!track || !pane) return undefined;
    const measure = () => {
      const t = track.getBoundingClientRect();
      const n = bar.getBoundingClientRect();
      const p = pane.getBoundingClientRect();
      if (!t.width || !n.width || !p.width) return;
      // ONE NUMBER LEFT. The ear's right edge is the pane's, in CSS, so only
      // its left bound needs measuring: reach the pill, unless that would
      // leave the surface narrower than the two labels — then stop and let
      // the seam widen instead. `right` and the two the pane's outline used
      // to need went with the column anchoring that produced them.
      const wanted = Math.max(0, t.right - p.left + EAR_GAP_PX);
      const left = Math.min(wanted, Math.max(0, p.width - EAR_MIN_PX));
      host.style.setProperty('--dev-ws-ear-left', `${Math.round(left)}px`);
      // HOW WIDE THE TABS ARE, and it is the same number under both
      // groupings — which is the whole point. They fill the ear on By
      // category, where the surface stops at the reading column; on By stage
      // the SURFACE grows with the full-bleed pane and the tabs keep the size
      // they had, rather than stretching to 268px apiece or shrinking to their
      // labels.
      //
      // So it is measured to the NAV's right edge rather than the pane's. The
      // nav keeps the reading column in both groupings and the ear's left edge
      // sits beside the pill in both, so this is one width: 286px at 1280,
      // whether the ear around it is 306px or 562px.
      const groupW = Math.max(0, Math.round(n.right - (p.left + left) - EAR_PAD_X * 2));
      host.style.setProperty('--dev-ws-group-w', `${groupW}px`);
      // WHERE THE HEAD COMES TO REST, which is under the pinned tab strip
      // rather than at the top of the scroller. Both stick, so the offset has
      // to be the strip's own height — three text labels and a glyph, so a
      // measurement again rather than a literal — plus the column gap between
      // them. Pinned too high, the head would slide under the strip; too low
      // and a band of the list shows through between the two.
      host.style.setProperty('--dev-ws-head-top', `${Math.round(n.height) + WS_GAP_PX}px`);
    };
    measure();
    if (typeof ResizeObserver !== 'function') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(track);
    // The pane too: By category is the reading column and By stage is the
    // full-bleed card, so the right edge this is measured back from moves
    // when the grouping does.
    ro.observe(pane);
    return () => ro.disconnect();
    // NO DEPENDENCY ARRAY, deliberately: this runs after EVERY render, and a
    // narrow one is what broke it. With `[bar, hostRef, earUp]` the effect
    // could not re-run on a grouping switch, so the number measured against
    // the 760px column — where the pane's left edge is 260 at 1280 — was
    // still in force once By stage made the pane full-bleed and moved that
    // edge to 4. The ear then began 250px further left than it should and
    // overlapped the tab pill.
    //
    // It is also what covers a pane or a pill that arrives AFTER the first
    // run (the observer is attached to whatever is there at the time) and any
    // viewport change the observed boxes do not register, since a centred
    // column can MOVE without changing size and a ResizeObserver reports
    // size alone.
    //
    // The cost is one observer teardown and setup per render of the Workshop,
    // which re-renders on data changes rather than on a timer. Correctness
    // over that: the version with deps shipped a visible bug.
  });
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
 * ── ONLY ONE OF THE THREE IS WORTH ANIMATING ───────────────────────────
 *
 * `slide` is the difference, and it is why the box carries a fourth field
 * that is not a coordinate. These are OFFSETS INTO THE BAR, not screen
 * positions, so the bar moving or resizing re-expresses a tab that has not
 * budged — and the marker then animated across the strip to arrive exactly
 * where it already was. Switching the All-items pane between By theme and
 * By stage did it every time: the two panes gave the nav two different
 * widths, and under the centred strip that alone moved the measurement 158px
 * for an unmoved tab. app.css takes that particular 158 away; this takes away
 * the whole CLASS of it, for the breakpoint crossing and the late webfont and
 * whatever moves under the bar next.
 *
 * So a measurement animates only when the SELECTION is what changed. Three
 * rules, and each is one line below:
 *   - unchanged geometry keeps the previous box identity, so the
 *     ResizeObserver's delivery on `observe()` cannot clear a slide that is
 *     still running;
 *   - a resize that DID move the numbers snaps, because the tab did not move;
 *   - the first measurement snaps too — there is no previous box, so there is
 *     nothing to have slid from. That is the placement the null-until-measured
 *     render is for, and it was animating anyway: `data-ws-marker-at` used to
 *     carry the transition and arrives in the same commit as the transform, so
 *     a cold open on All items slid the marker in from the nav's left edge at
 *     zero width. It lands instantly now, which is what that render always
 *     claimed.
 *
 * It returns `null` until the first measurement lands so the marker can render
 * hidden rather than at the left edge — otherwise it slides in from nowhere on
 * the first paint, which reads as a bug rather than a flourish.
 */
interface TabMarkerBox {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Whether moving to this box is a selection change, and so worth animating. */
  slide: boolean;
}

function useTabMarker(
  bar: HTMLElement | null,
  tab: TabKey,
): TabMarkerBox | null {
  const [box, setBox] = useState<TabMarkerBox | null>(null);
  useLayoutEffect(() => {
    if (!bar) return;
    const measure = (selectionChanged: boolean) => {
      const el = bar.querySelector<HTMLElement>('[data-ws-tab-btn][aria-selected="true"]');
      if (!el) return;
      // offsetLeft/Top resolve against the nearest positioned ancestor, which
      // is the bar itself — see app.css, where it is the containing block at
      // both widths precisely so these numbers mean what they look like.
      setBox((prev) => {
        const next = { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
        if (prev && prev.x === next.x && prev.y === next.y
          && prev.w === next.w && prev.h === next.h) return prev;
        return { ...next, slide: !!prev && selectionChanged };
      });
    };
    // The effect's own run is the tab having changed — it depends on `tab`.
    // Everything the observer reports afterwards is the layout moving.
    measure(true);
    const ro = new ResizeObserver(() => measure(false));
    ro.observe(bar);
    return () => ro.disconnect();
  }, [bar, tab]);
  return box;
}

function useRailHost(): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const mq = window.matchMedia(WIDE_QUERY);
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
  // How many of "since your last visit" are drawn. It was a collapsed row you
  // had to open; the first three are simply on screen now and the rest are a
  // press away, which is the WeekWalk's bargain one pane down.
  const [sinceShown, setSinceShown] = useState(SINCE_FIRST);
  // #2183: how many of the rows the reader has ALREADY seen are drawn under
  // the new ones. Zero until `Show older` has no new row left to reveal.
  const [seenShown, setSeenShown] = useState(0);
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
  // Where the grouping strip renders: beside the tab pill from 768px up, in
  // the pane's sticky head below it. See `EAR_QUERY` and `GroupStrip`.
  const earUp = useMediaFlag(EAR_QUERY);
  // ...and how wide it is: from just clear of the pill to the pane's right
  // edge, which only a measurement knows. See `useEarInset`.
  useEarInset(bar, hostRef, earUp);
  // The toolbar's props reach this root through a store, not a prop — the
  // Workshop is a separate React root from the frame that receives them. See
  // ../actions-store.ts.
  const actions = useDevActions();

  const themes = useMemo(() => sortThemes(v.themes, sortKey), [v.themes, sortKey]);
  // The eyebrow over the theme list: the count, then whatever the grouping
  // itself has to report. Named themes only — "Not yet grouped" is a
  // holding pen, not one of them — and counted here so the label can agree
  // with itself: it read "1 themes" before, which is the kind of thing a
  // reader trusts a screen slightly less for.
  const countOfThemes = themes.filter((t) => !t.ungrouped).length;
  const groupingNote = [
    `${countOfThemes} ${countOfThemes === 1 ? 'theme' : 'themes'}`,
    v.meta.source === 'category' ? 'grouped by category for now' : '',
    v.meta.source === 'demo' ? 'staging demo grouping' : '',
    v.meta.pending
      ? (v.meta.pendingStage === 'placement'
        ? 'placing new cards…'
        : (v.meta.source === 'ai' ? 're-drafting themes…' : 'drafting themes…'))
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

  // The since-list's two controls (#2183). `Show older` walks down the list:
  // the rest of the new rows first, three a press, then the rows from before
  // the baseline. `Clear` moves the baseline to now — AppView owns the stamp
  // and its storage, and republishes — and folds the walk back to its start,
  // so what the reader dismissed is under `Show older` rather than gone.
  //
  // #2240 widened WHEN it is offered, not what it does. With nothing new the
  // baseline move is inert — the line is already past every row — so folding
  // the walk is the whole of the press, and it stays one handler with one
  // meaning: the list back as you found it.
  const sinceMore = !!v.since
    && (v.since.rows.length > sinceShown || v.since.seen.rows.length > seenShown);
  const showOlder = () => {
    if (!v.since) return;
    if (v.since.rows.length > sinceShown) setSinceShown(sinceShown + SINCE_STEP);
    else setSeenShown(seenShown + SINCE_STEP);
  };
  const clearSince = () => {
    if (!v.since) return;
    setSinceShown(SINCE_FIRST);
    setSeenShown(0);
    setOpenRows((cur) => ({ ...cur, since: '' }));
    callAppView('_workshopClearSince', slug, v.since.through);
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
  const openSig = `${Object.values(openRows).join('|')}|since:${sinceShown}|seen:${seenShown}`;
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
              than a flourish.

              TWO ATTRIBUTES, TWO QUESTIONS. `data-ws-marker-at` says the box
              has been measured and is what the opacity waits for;
              `data-ws-marker-slide` says this box is where the SELECTION
              moved to, and is what app.css hangs the transition on. A
              re-measure of the tab you are already on carries the first and
              not the second, so it lands without replaying the slide — see
              useTabMarker. */}
          <span
            className="dev-ws-tab-marker"
            data-ws-tab-marker=""
            aria-hidden="true"
            {...(markerBox ? { 'data-ws-marker-at': '' } : {})}
            {...(markerBox && markerBox.slide ? { 'data-ws-marker-slide': '' } : {})}
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
              pane beside it is the 760px theme list or the full-bleed board.
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
        <EmptyNote filtered={!!v.emptyNote.filtered} loadFailed={v.emptyNote.loadFailed} />
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
          {/* THE HEADING IS A SENTENCE, NOT AN EYEBROW. Three all-caps
              labels and one sentence-case header were doing the same job in
              four different weights, and the caps one is the weaker of the
              two: it reads as a tag on a box rather than a name for what is
              in it. Every section on this tab wears this now, so the only
              thing that distinguishes them is what they hold. */}
          <div className="dev-ws-head">
            <span className="dev-ws-head-title">Where the app is</span>
          </div>
          <DashTiles d={v.dashboard} />
          {/* THE LEAD PARAGRAPH. It was the first card of the week walk,
              titled "Open issues" — so the pane's one always-visible
              sentence lived inside a control about history, and the button
              under it opened on This week. It is not a window; it does not
              sit in a list of windows. The derived sentence is still the
              fallback for a board that has never had a line written for it
              — see summarise(). */}
          {/* PRECEDENCE, unchanged from when this was the walk's first card:
              the model's own line, then the flattened paragraph a row
              written under the previous prompt still holds, then the
              sentence derived from the counts. The fallbacks only apply
              when there is NO walk — a board whose `open` window is empty
              but whose weeks are not has a summary already, and dropping
              the paragraph in above it would state the same thing twice. */}
          {v.dashboard.openLine || (!v.dashboard.weeks.length && summarise(v.dashboard)) ? (
            <>
              <p className="dev-ws-open-line" data-ws-open-line="">
                {v.dashboard.openLine || summarise(v.dashboard)}
              </p>
              {/* The note belongs to whichever sentence is on screen, and
                  with no walk below there is nothing else to hang it on.
                  This is the very case it exists for: "no draft yet" and
                  "the call keeps failing" both leave the derived sentence up
                  there and are otherwise indistinguishable. */}
              {!v.dashboard.weeks.length
                && digestNote(v.meta, !!(v.dashboard.cards || v.dashboard.summary)) ? (
                  <p className="dev-ws-digest-note" data-ws-digest-note="">
                    {digestNote(v.meta, !!(v.dashboard.cards || v.dashboard.summary))}
                  </p>
                ) : null}
            </>
          ) : null}
          {/* The weeks, the live one on screen and the rest one press away.
              The note about the summary rides INSIDE the walk (above "Show
              past week"), with the card it is about — see WeekWalk. */}
          {v.dashboard.weeks.length ? (
            <WeekWalk
              weeks={v.dashboard.weeks}
              firstWeek={v.dashboard.firstWeek}
              note={digestNote(v.meta, !!(v.dashboard.cards || v.dashboard.summary))}
            />
          ) : null}
          {/* ── The door to the general chat, at the foot of this pane ──
              It had a section of its own: an eyebrow, a frosted surface and
              a card inside it, all to carry one row whose only job is to
              navigate somewhere else — and the card it held already draws
              its own surface, so it was a card inside a card inside a
              section. It belongs HERE because it is the same subject: this
              pane says where the app is, and this is where people are
              talking about it. None of it is about you, which is what the
              pane below is for.

              It keeps no pill of its own. A rounded capsule on a rounded
              pane is a shape inside a shape, and this pane already has an
              internal rhythm — hairline, block, hairline — that the weeks
              above it use. The row joins that rhythm. */}
          {v.discussion && v.discussion.t === 'card' ? (
            <DiscussionRow card={v.discussion.card} />
          ) : null}
        </section>
      ) : null}

      {/* ── Yours, first ──
          The first question a returning member has is about their OWN work,
          and the lander answered every other one before it: what the app is
          doing, what the group needs, what nobody has picked up. A
          half-finished session of theirs was somewhere down inside a theme,
          under a heading about the theme. */}
      {v.mine && (v.mine.rows.length || v.mine.viewer) ? (
        <section className="dev-ws-strip" data-ws-mine="">
          <div className="dev-ws-head">
            <span className="dev-ws-head-title">What you are working on</span>
            {v.mine.count ? <span className="dev-ws-head-n">{v.mine.count}</span> : null}
          </div>
          <div className="dev-ws-lane" data-ws-lane="mine">
            {/* #2182: the strip does not leave when the viewer has nothing
                underway. It says so instead, so the pane keeps one shape
                and the place your work will appear is always the same. */}
            {!v.mine.rows.length ? (
              <p className="text-xs text-zinc-500 dark:text-zinc-400" data-ws-mine-empty="">
                You have no work going on. Pick up an open item below, or start something from the + button.
              </p>
            ) : null}
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
            {/* THE SAME CONTROL AS THE OTHER TWO. This was a left-aligned
                grey pill (`gc-vote-btn`) while "Show past week" and "Show
                older" — which do the identical thing one pane up and one
                pane down — were centred muted text with a caret. Three
                spellings of one gesture. It is `.dev-ws-reveal` now, and the
                caret turns over when there is nothing left to reveal, which
                is what that class already does for the since list. */}
            {v.mine.rows.length > v.mine.shown ? (
              <button
                type="button"
                className="dev-ws-reveal dev-ws-mine-more"
                aria-expanded={allMine}
                data-ws-mine-more=""
                onClick={() => setAllMine(!allMine)}
              >
                {/* No flip class: `.dev-ws-reveal[aria-expanded="true"]`
                    already turns the caret over, and this button carries
                    that attribute. */}
                <ChevronDownIcon className="dev-ws-reveal-chev" aria-hidden="true" />
                {allMine ? 'Show fewer' : `${v.mine.count - v.mine.shown} more of yours`}
              </button>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* The general discussion had its own section here. It is a row at the
          foot of the dashboard pane now (DiscussionRow) — same subject as
          that pane, and one row does not earn a section. */}
      {/* ── What moved while you were away ──
          SHOWN, not offered. It was one collapsed line — the label, the count
          and a caret — on the reasoning that most visits do not need the
          fact. What that produced was a strip nobody opened: the count said
          something had moved and the rows saying WHAT were behind a press,
          so the one thing on the lander addressed to this reader personally
          was also the only thing they had to ask for.

          So the pane is open and the LENGTH is what is bargained instead,
          the way the week walk one pane up bargains its history: the newest
          three on screen, the rest under a button that reveals three more
          each press. Same control, same chevron, pointing down at what it
          is about to show. Since #2183 the button stays once the new rows
          are out and goes on down into what the reader has already seen,
          and a Clear on the heading moves the line between the two up to
          now — see the note on SINCE_FIRST. */}
      {v.since ? (
        <section className="dev-ws-strip" data-ws-since="">
          {/* NOT A BUTTON ANY MORE. It opens nothing, so it must not look
              like it does — a row that reads as tappable and is not is worse
              than a plain heading. The label and the count keep their
              classes; the caret went with the press. Clear rides the far
              end of the same row, as "Mark all read" rides the notifications
              sheet's title row: an action on the list, drawn small, and
              disabled rather than absent when there is nothing to clear so
              the row does not reflow.

              #2240: "nothing to clear" IS NOT "no new rows". `Show older` is
              live on a quiet day by design, and it walks straight across the
              baseline into what the reader has already seen — so the one
              state with the most on screen to fold was the one state where
              Clear was dead, because new rows were the only thing it gated
              on. It is live while there is a walk below the line too. */}
          <div className="dev-ws-since-head" data-ws-since-head="">
            <span className="dev-ws-since-label">Since your last visit</span>
            {/* THE WHOLE POPULATION, not the page of it that is drawn.
                `rows` is capped at WORKSHOP_SINCE_MAX, so on a busy week the
                head said 30 over a list the reader could keep revealing. */}
            <span className="dev-ws-since-n">{v.since.total}</span>
            <button
              type="button"
              className="dev-ws-since-clear"
              data-ws-since-clear=""
              disabled={!v.since.rows.length && !seenShown}
              onClick={clearSince}
            >
              Clear
            </button>
          </div>
          {/* WHAT MOVED, IN WORDS — under the heading that gives it an
              antecedent. This was a green `N shipped since` pill on the
              DASHBOARD pane's head, four blocks up the page: a sentence
              fragment whose object was missing, next to numbers about the
              board rather than about you. `sinceWords` has been in this file
              since the strip was written and had no caller; it says all
              three of what landed, what opened and what was proposed, where
              the pill said one. */}
          {v.since.rows.length ? (
            <p className="dev-ws-since-sum" data-ws-since-sum="">{sinceWords(v.since)}</p>
          ) : null}
          {v.since.rows.slice(0, sinceShown).map((row) => (row.t === 'card' ? (
            <CardRowView
              key={row.key}
              row={row}
              slug={slug}
              canPost={canPost}
              open={openRows.since === row.key}
              onToggle={() => toggleRow('since', row.key)}
            />
          ) : null))}
          {/* An empty pane would be a heading over nothing, and "nothing
              moved" is a fact worth one line — it is the answer to the
              question the heading asks. */}
          {v.since.rows.length ? null : (
            <p className="dev-ws-week-note" data-ws-since-none="">
              Nothing has changed since you were last here.
            </p>
          )}
          {/* Below the line: rows from before the baseline, drawn only once
              `Show older` has walked past the new ones, under a mark that
              says which side of the line they are on. Same rows, same fold,
              same one-open-at-a-time scope as the rows above. */}
          {seenShown > 0 && v.since.seen.rows.length ? (
            <>
              <div className="dev-ws-since-seen" data-ws-since-seen="">
                <span className="dev-ws-since-seen-label">Seen before</span>
                <span className="dev-ws-since-seen-n">{v.since.seen.total}</span>
              </div>
              {v.since.seen.rows.slice(0, seenShown).map((row) => (row.t === 'card' ? (
                <CardRowView
                  key={row.key}
                  row={row}
                  slug={slug}
                  canPost={canPost}
                  open={openRows.since === row.key}
                  onToggle={() => toggleRow('since', row.key)}
                />
              ) : null))}
            </>
          ) : null}
          {/* ALWAYS DRAWN. Disabled, not absent, once there is nothing left
              to draw: the reader who cleared the list or arrived on a quiet
              day is exactly the one who wants a way back into what they
              already saw, and a control that is sometimes there is one
              nobody learns to reach for. */}
          <button
            type="button"
            className="dev-ws-reveal dev-ws-since-more"
            data-ws-since-more=""
            disabled={!sinceMore}
            onClick={showOlder}
          >
            {/* Pointing DOWN, at where the rows it reveals appear — the
                week walk's own reading of the same control. */}
            <ChevronDownIcon className="dev-ws-reveal-chev" aria-hidden="true" />
            Show older
          </button>
        </section>
      ) : null}

      </>
      ) : null}

      {tab === 'needs' ? (
        <NeedsFeed
          rows={v.queue}
          total={v.votes.total}
          models={v.models}
          slug={slug}
          canPost={canPost}
          onDone={() => { setTab('status'); callAppView('_setWorkshopTab', 'status'); }}
        />
      ) : null}

      {/* WHENEVER THE TAB IS UP, not only while there is a theme to draw. This
          was `tab === 'all' && themes.length`, and the second half was #2090:
          a search that matched nothing emptied `themes`, the whole pane went
          with them, and the search box — a node of the toolbar the pane's
          head renders — was gone before it could be cleared. The pane is the
          tab; its body is what may be empty (see EmptyNote). */}
      {tab === 'all' ? (
        <>
          {/* ── The two ways to read the same board ──────────────────────
              The eyebrow here used to say "12 themes" and nothing else:
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
          {/* THE EAR, on a wide window: the grouping strip on its own surface
              at the pane's top-right corner, level with the tab pill.

              A CHILD OF THE HEAD, not of the pane, and that is what makes it
              travel. The head PINS while the list scrolls under it, and the
              ear hangs off the head's top edge (`bottom: 100%`) — so an ear
              anchored to the pane would have scrolled away and left the
              pinned controls with their own grouping tabs gone. The head is
              positioned, so it is the containing block; unscrolled, its top
              edge IS the pane's top edge, which is why this reads exactly as
              it did when the pane owned it.

              Rendered only when it is up, so the strip below is the same one
              node moved rather than a second copy of it. */}
          {earUp ? (
            <div className="dev-ws-ear" data-ws-ear="">
              <GroupStrip group={group} />
            </div>
          ) : null}
          {/* NO TITLE LINE HERE. The head used to open with an "All items"
              eyebrow, on the argument that the tabs named the CHOICE without
              naming what the choice was being made about. The selected TAB
              says it — it is the thing reading "All items", right above this
              — so the eyebrow was the same word twice, one line apart, and
              the head now leads with the tools. */}
          {/* The strip's narrow home. Above the breakpoint it is in the ear
              instead — one node, two places. */}
          {earUp ? null : <GroupStrip group={group} />}
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
          ) : !themes.length ? (
            /* The rows' place, under the controls that emptied it. `filtered`
               is the live filter state rather than `emptyNote`'s: that note
               is about the BOARD having no entries, and a board whose every
               open item a search has hidden still has them, so it stays null
               while the theme list is bare. The stage pane needs none of
               this — the columns say "No matching cards" for themselves. */
            <EmptyNote filtered={v.meta.filtered} loadFailed={!!(v.emptyNote && v.emptyNote.loadFailed)} />
          ) : (
          <>
          <div className="dev-ws-sort">
            {groupingNote ? <span className="dev-ws-eyebrow">{groupingNote}</span> : null}
            <div className="dev-ws-sort-opts" role="group" aria-label="Order themes">
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
                ? 'Staging demo grouping: in production the themes are drafted by the model from the board.'
                : v.meta.pending
                  ? 'Categories are being drafted from the board now. They replace this grouping when they land.'
                  : v.meta.lastError
                    ? `The last attempt to draft themes failed (${v.meta.lastError}). Items stay grouped by their voted category until the next attempt.`
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
