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

import { Fragment, memo, useCallback, useEffect, useId, useInsertionEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from 'react';

import { Button } from '@/components/ui/button';
import { SectionHeader } from '@/components/ui/grouped-list';
import {
  ArrowUpIcon,
  BallotIcon,
  ChatBubbleTailIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  EllipsisHorizontalIcon,
  PlayIcon,
  SparklesIcon,
  SpeechCheckIcon,
  Squares2X2Icon,
  UserIcon,
  XIcon,
} from '@/components/ui/icons';

import { Html } from '../../../lib/html';
import { RichMessage, useMessages } from '../../../lib/i18n/react';
import { listText, t as translate } from '../../../lib/i18n/runtime';
import { agoStamp } from '../../../lib/timestamp';
import { useStoreState } from '../../../lib/use-store-state';
import { Improve } from '../../improve/improve-controller.js';
import { improveStore } from '../../improve/improve-store.js';
import { swatchFor } from '../../messages/format';
import { openBot } from '../../messages/store';
import type { StagedObject } from '../../messages/types';
import { devWorkshopStore } from '../card/cards-store';
import { DevKanban, StageStrip, syncStrip } from '../card/dev-kanban';
import { DevActionsRow, DevPlusMenu } from '../actions-row';
import { useDevActions } from '../actions-store';
import { callAppView, openHref } from '../card/fold';
import { FeedThread } from '../card/feed-thread';
import type { ActionRef, DevCardModel, DevWorkshopView, ListRow, WorkshopTheme } from '../card/model';
import { CardSkeleton } from '../card/skeleton';
import { VotePicker } from '../card/dev-card';
import { useWorkshopGroup } from './group-mode-store';
import { describe as describeCommunity, openSwitcher } from '../../workshop/community-scope';
import { registerLevel } from '../../workshop/tab-ladder';
import { firstUnseenIndex, markNeedsSeen, needsRowKey, unseenNeeds, useNeedsSeen } from '../../workshop/needs-seen';
import {
  ApprovalLine, CommunityCard, ShareItCard, canLeave,
  leaveCommunity, useCommunity,
} from './community-card';
import { FirstVersionCard, ForYouCard, RecentlyLive, hubAlone, hubWorkEmpty, owesVote } from './hub-cards';
import { ProjectDiscussion } from './project-discussion';
import {
  channelPlace, findChannel, isChannelPlace, isPlaceKey, placeHandle, placeHref, unreadTotal, type PlaceKey,
} from './places';
import { PlaceBar } from './place-bar';
import { PlacesTray, useEdgeSwipe } from './places-tray';
import { ProjectPlaces } from './project-places';
import { clearPlace, publishPlace, publishSide, registerPlaceOpener, registerTrayToggle, trayButton } from './place-store';
import { PlanPage } from './plan-page';
import { Diagram, decisionDiagram, readDiagram, type DecisionFacts, type DiagramRecord, type DiagramSource } from '../../../lib/diagram/diagram';
import { TouchesPicture, readTouches, touchesSaid, type Touches } from './touches';
import { PageBack } from './page-back';
import { readAskStream } from './ask-stream';
import {
  ActButton, ActRow, WorkList, primaryAct, rowWords, topicRef, type CardRow as WorkCardRow, type TopicRef,
} from './work-row';
import { TopicSidePanel } from './side-panel';
import { HappenedRow, ThisWeek, WEEKS_FIRST, WEEKS_STEP, WeekPage, WeekRow, catchUp, weekDate } from './week-pages';
import {
  commitDistance,
  swipeAxis,
  swipeProgress,
  swipeSide,
  swipeVerdict,
  type SwipeAxis,
  type SwipeSide,
} from './swipe-vote';

export type SortKey = 'people' | 'activity' | 'open';
// #4417: the page's places — a channel is `c:<handle>` (./places.ts).
type TabKey = PlaceKey;

/** Your work on the Workshop tab: its first rows, the rest behind a reveal. */
export const WORKSHOP_WORK_FIRST = 3;

/** The since list with nothing in it: a first visit's, which still has weeks. */
const EMPTY_SINCE: NonNullable<DevWorkshopView['since']> = {
  baseline: 0, through: 0, total: 0, shipped: 0, opened: 0, proposed: 0, rows: [], seen: { total: 0, rows: [] },
};

/**
 * THE PAGES OF A PROJECT: four tabs under its coloured header, and one page.
 *
 *   Hub · Discussion · Needs you · Workshop
 *
 * The HUB is the community's page: who is here and who it is for, what you
 * can do (Open app, Invite, the ⋯, Joined), how lively it has been, what
 * landed since you were last here, Needs you, the discussion's last two
 * messages, your work, and Start a new change. DISCUSSION is its channel,
 * whole. NEEDS YOU is one decision per screen. The WORKSHOP is three titled
 * parts: OVERVIEW, All items' numbers (whose See all opens ALL ITEMS, the
 * whole board), where most of the open work is, and the approval rule every
 * change goes through; WHAT'S HAPPENING, your work in full and what is new
 * for you since your last visit; WHAT HAPPENED, this week row by row and a
 * row for each week before it. All items is the one page, with its way back
 * to the Workshop, and the Workshop tab stays lit over it.
 *
 * The tabs came back as a BAND in the community's colour, continuing the
 * header, rather than the pill the hub once shared with the Workshop: the
 * hub then read as one of two peers, and a second Workshop. Here the hub is
 * the first of four places in one community, and the colour says which. The
 * keys and the `?ws=` deep links are the ones the tabs and doors had, and
 * `discussion`.
 */

/**
 * The tab the page should open on now (AppView._workshopTab: a `?ws=` link,
 * else the one last chosen), or null where AppView is not there to ask.
 */
export function freshTab(): TabKey | null {
  const tab = callAppView('_workshopTab');
  return isPlaceKey(tab) ? tab : null;
}

/**
 * Where a page's back button goes: All items to the Workshop, the rest (the
 * plan, #4074) to the hub. A channel, Needs you and the Workshop go to the
 * hub too (#4417: the places list's "up a level").
 */
export function pageParent(tab: TabKey): TabKey {
  return tab === 'all' ? 'workshop' : 'status';
}

/** A page's own title. A channel is its handle (`#general`, `#onboarding`). */
export function pageTitle(tab: TabKey): string {
  if (tab === 'needs') return translate('project:page.title.needsYou');
  if (tab === 'all') return translate('project:page.title.allItems');
  if (tab === 'plan') return translate('project:page.title.plan');
  const handle = placeHandle(tab);
  if (handle) return `#${handle}`;
  if (tab === 'status') return translate('project:page.title.hub');
  return translate('project:page.title.workshop');
}

/** Short independent facts on one line ("3 involved · 2 underway"), joined as the language on screen joins them. */
function factsLine(parts: readonly (string | null | undefined | false)[]): string {
  const said = parts.filter((part): part is string => typeof part === 'string' && part !== '');
  if (!said.length) return '';
  return said.reduce((first, second) => translate('project:facts.pair', { first, second }));
}

/** Whole sentences, one after another, as one short paragraph. */
function sentences(parts: readonly string[]): string {
  const said = parts.filter(Boolean);
  if (!said.length) return '';
  return said.reduce((first, second) => translate('project:sentences.pair', { first, second }));
}

/**
 * #3583: BACK TO THE HEAD OF THE PAGE, IN WHICHEVER ELEMENT SCROLLS IT.
 *
 * A tab press and a door both promise that the page they open starts at its
 * own head, and both kept it with `window.scrollTo`. That moves the page only
 * where the DOCUMENT scrolls: a phone or tablet browser, or a window under
 * 768px (../../../lib/browser-scroll.ts). On a computer, and in the installed
 * app and the native WebView, the page scrolls inside #dev-forum-scroll, so
 * the call moved nothing and the new tab opened at the old one's offset.
 * Press Hub from halfway down the Workshop and the hub came up scrolled past
 * its own hero, the tab strip already pinned over it on its band, and nothing
 * on screen to say why: "sometimes the hub looks like this".
 *
 * Both are reset; the one that is not scrolling has nothing to move. The
 * scroller is found from the page itself rather than by id from the
 * document, so a page that is not in one is left alone.
 */
export function scrollToHead(host: HTMLElement | null): void {
  try { window.scrollTo?.({ top: 0 }); } catch { /* no window to scroll */ }
  const feed = host?.closest<HTMLElement>('#dev-forum-scroll');
  if (feed && feed.scrollTop) feed.scrollTop = 0;
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

/**
 * One stage lane of a By category group: the group's items at that stage, as
 * the board's rows (#4486, ./work-row.tsx, variant `board`) under the lane's
 * stage label. No tile, since the label says the stage, and no category chip,
 * since the group is the category. A tap on a row opens its page, beside the
 * list on a wide window; nothing unfolds in place any more.
 */
function Lane({
  lane, slug, openKey, onOpen,
}: {
  lane: WorkshopTheme['lanes'][number];
  slug: string;
  openKey: string | null;
  onOpen: (event: ReactMouseEvent<HTMLAnchorElement>, ref: TopicRef) => void;
}): ReactNode {
  // "Shipped this week" is the one lane that is a RECORD rather than a
  // question — nothing in it needs anybody — so a theme opens on the work
  // that still wants someone and keeps the record one tap away (#1787). The
  // hook runs before the early return below, because a hook may not be
  // conditional; the lane still renders nothing when it holds nothing.
  const collapsible = lane.key === 'shipped';
  const [laneOpen, setLaneOpen] = useState(!collapsible);
  const t = useMessages('project');
  if (!lane.rows.length && !lane.more) return null;
  const total = lane.rows.length + lane.more;
  const rows = lane.rows.filter((row): row is WorkCardRow => row.t === 'card' && !!row.brief);
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
      {laneOpen && rows.length ? (
        <WorkList rows={rows} slug={slug} openKey={openKey} onOpen={onOpen} variant="board" category={false} />
      ) : null}
      {laneOpen && lane.more ? <div className="dev-ws-more">{t('project:allItems.lane.more', { count: lane.more })}</div> : null}
    </div>
  );
}

function Faces({ people }: { people: string[] }): ReactNode {
  const shown = people.slice(0, 4);
  const extra = people.length - shown.length;
  const [open, setOpen] = useState(false);
  const t = useMessages('project');
  if (!people.length) return null;
  return (
    <span className="dev-ws-faces-wrap">
      <button
        type="button"
        className="dev-ws-faces"
        aria-label={t('project:allItems.theme.whoInvolved', { people: listText(people) })}
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
  theme, slug, open, onToggle, openKey, onOpen, onChannel,
}: {
  theme: WorkshopTheme;
  slug: string;
  open: boolean;
  onToggle: () => void;
  /** `kind:id` of the item open in the panel beside the list. */
  openKey: string | null;
  onOpen: (event: ReactMouseEvent<HTMLAnchorElement>, ref: TopicRef) => void;
  /** #4417: open a topic's channel on this page. */
  onChannel?: (place: TabKey) => void;
}): ReactNode {
  const t = useMessages('project');
  const c = theme.counts;
  const openItems = c.open + c.underway + c.review;
  const chips: ReactNode[] = [];
  if (c.fresh) chips.push(<span key="fresh" className="dev-ws-cnt dev-ws-cnt-fresh"><RichMessage id="project:allItems.theme.chip.fresh" values={{ count: c.fresh }} components={[<b />]} /></span>);
  if (c.review) chips.push(<span key="review" className="dev-ws-cnt dev-ws-cnt-review"><span className="dev-ws-dot"></span><RichMessage id="project:allItems.theme.chip.review" values={{ count: c.review }} components={[<b />]} /></span>);
  if (c.underway) chips.push(<span key="underway" className="dev-ws-cnt dev-ws-cnt-underway"><span className="dev-ws-dot"></span><RichMessage id="project:allItems.theme.chip.underway" values={{ count: c.underway }} components={[<b />]} /></span>);
  chips.push(<span key="open" className="dev-ws-cnt"><span className="dev-ws-dot"></span><RichMessage id="project:allItems.theme.chip.open" values={{ count: c.open }} components={[<b />]} /></span>);
  if (c.shipped) chips.push(<span key="shipped" className="dev-ws-cnt dev-ws-cnt-shipped"><span className="dev-ws-dot"></span><RichMessage id="project:allItems.theme.chip.shipped" values={{ count: c.shipped }} components={[<b />]} /></span>);

  // `counts` rather than `rows.length`: the lane caps its rows at
  // WORKSHOP_LANE_MAX, so a theme with twelve underway used to report eight.
  const bits: string[] = [];
  if (c.underway) bits.push(t('project:allItems.theme.foot.underway', { count: c.underway }));
  if (c.review) bits.push(t('project:allItems.theme.foot.review', { count: c.review }));
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
    ? t('project:allItems.theme.foot.shippedIdle', { count: c.shipped })
    : (quietDays != null && quietDays > 14
      ? t('project:allItems.theme.foot.quiet', { count: quietDays })
      : t('project:allItems.theme.foot.idle'));
  // Each fact is a whole message; the line joins them.
  const foot = factsLine([
    t('project:allItems.theme.foot.involved', { count: theme.people.length }),
    ...(bits.length ? bits : [idle]),
  ]);

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
          <span className="dev-ws-stat"><RichMessage id="project:allItems.theme.stat.people" values={{ count: theme.people.length }} components={[<b />]} /></span>
          <span className="dev-ws-stat"><RichMessage id="project:allItems.theme.stat.items" values={{ count: openItems }} components={[<b />]} /></span>
        </div>
        {theme.saying ? (
          <p className="dev-ws-theme-say">{theme.saying}</p>
        ) : (theme.description ? <p className="dev-ws-theme-say">{theme.description}</p> : null)}
        <div className="dev-ws-theme-counts">{chips}</div>
        <div className="dev-ws-theme-foot">
          <Faces people={theme.people} />
          {/* #4417: A TOPIC'S FOOT IS ITS DOOR. The card is a category, and
              its channel is where the requests in it are talked about, so
              the foot's line gives way to "Discuss in #name". A link of its
              own inside the card's head: a press on it opens the channel
              and leaves the card shut. */}
          {theme.topic ? (
            <>
              <span className="flex-1 min-w-0 truncate"></span>
              <a
                className="dev-ws-link dev-ws-topic-link"
                data-ws-topic-channel={theme.topic.handle}
                href={placeHref(slug, channelPlace(theme.topic.handle))}
                onClick={(e) => {
                  e.stopPropagation();
                  const nav = (window as unknown as { NavLink?: { isNativeClick?: (ev: unknown) => boolean } }).NavLink;
                  if (nav?.isNativeClick?.(e)) return;
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0 || !onChannel) return;
                  e.preventDefault();
                  onChannel(channelPlace(theme.topic?.handle));
                }}
                onKeyDown={(e) => e.stopPropagation()}
              >
                {t('project:allItems.theme.discuss', { channel: theme.topic.handle })}
              </a>
            </>
          ) : (
            <span className="flex-1 min-w-0 truncate">{foot}</span>
          )}
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
              openKey={openKey}
              onOpen={onOpen}
            />
          ))}
          {/* The whole theme on the Board, at the bottom of the theme rather
              than under whichever lane happened to overflow: the filter it
              applies is the theme's, not a lane's. */}
          <div className="dev-ws-theme-more">
            {hidden ? (
              <RichMessage
                id="project:allItems.theme.hiddenThenOpen"
                values={{ count: hidden }}
                components={[
                  <span />,
                  <button type="button" className="dev-ws-link" onClick={() => callAppView('openBoardForTheme', theme.id)} />,
                ]}
              />
            ) : (
              <button type="button" className="dev-ws-link" onClick={() => callAppView('openBoardForTheme', theme.id)}>
                {t('project:allItems.theme.openOnBoard')}
              </button>
            )}
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
      ? translate('project:allItems.categories.draftedAt', { when: relTime(drafted) })
      : translate('project:allItems.categories.drafted'),
  ];
  const c = meta.coverage;
  if (c && c.pending) parts.push(translate('project:allItems.categories.pending', { count: c.pending }));
  if (c && c.unplaced) parts.push(translate('project:allItems.categories.unplaced', { count: c.unplaced }));
  if (meta.lastError) parts.push(translate('project:allItems.categories.lastError', { error: meta.lastError }));
  return sentences(parts);
}

/**
 * The no-items note, drawn where the items would have been.
 *
 * Two screens say it — the hub under its hero, and the All items pane under
 * its toolbar — and the second of those is the fix for #2090. The pane
 * used to be gated on having a theme to draw, so a search that matched
 * nothing unmounted the whole pane: the grouping tabs, the "+", and the
 * toolbar whose host the search field lives in. The one control that could
 * undo the search left the screen with the rows, and the viewer was stuck on
 * a board they could not widen back out. Now the pane stays, and this note
 * takes the rows' place beneath the box it is talking about.
 *
 * ── It says only what the screen can do ──────────────────────────────
 *
 * It read "Press + to propose a change or file an issue", and both halves had
 * stopped being true: the "+" was only in All items' search row, so on
 * Current status it pointed at nothing on screen, and it has had no propose
 * row since New change moved to Improve (#1490) and then to the Homeroom
 * menu (#2740 review), an owner decision this note does not undo. The "+"
 * became the hero's ⋯, on the hub, so the note names what it holds (and, on
 * All items, where it is), and sends "make one yourself" to the ⋯'s own
 * Build it now row. It sent it to the Homeroom menu's until that row
 * showed only for people who have built something themselves (first-session
 * run-through, 5 Oct 2026: ../../app-context/app-context-sheet.tsx
 * AgentChats), so a newcomer would have looked for a row they do not have.
 *
 * Gated on the same facts as what it names: "import a PR" only where the ⋯
 * carries that row (`canCollaborate`), and nothing to press at all for a
 * read-only viewer, whose ⋯ holds Fork alone (`AppView.readOnly`, the flag
 * the ⋯'s writable rows are gated on).
 *
 * UNDER THE START-HERE BANNER it stops at the ⋯. On the hub an empty
 * board is nearly always an app nobody has started, and #2573's banner right
 * above the note carries its own Start a new change button, so sending the
 * reader to a menu for the same thing would be the note talking past the
 * screen it is on. All items has no banner, so there it says the whole
 * thing.
 */
const EMPTY_PRESS: Record<'hub' | 'away', Record<'collab' | 'plain', Record<'full' | 'short', string>>> = {
  hub: {
    collab: { full: 'project:boardEmpty.press.hub.collab.full', short: 'project:boardEmpty.press.hub.collab.short' },
    plain: { full: 'project:boardEmpty.press.hub.plain.full', short: 'project:boardEmpty.press.hub.plain.short' },
  },
  away: {
    collab: { full: 'project:boardEmpty.press.away.collab.full', short: 'project:boardEmpty.press.away.collab.short' },
    plain: { full: 'project:boardEmpty.press.away.plain.full', short: 'project:boardEmpty.press.away.plain.short' },
  },
};

function EmptyNote({ filtered, loadFailed, underStartHere = false, onHub = false }: {
  filtered: boolean;
  loadFailed: boolean;
  underStartHere?: boolean;
  /** Drawn on the hub, under the hero whose ⋯ it names. */
  onHub?: boolean;
}): ReactNode {
  const { readOnly, canCollaborate } = useDevActions();
  const t = useMessages('project');
  // One whole sentence per case: where the ⋯ is, what it holds for this
  // viewer, and whether "make one yourself" is said.
  const press = EMPTY_PRESS[onHub ? 'hub' : 'away'][canCollaborate ? 'collab' : 'plain'][underStartHere ? 'short' : 'full'];
  const board = readOnly ? t('project:boardEmpty.readOnly') : (
    <RichMessage id={press} components={[<span className="font-medium text-violet-700 dark:text-violet-400" />]} />
  );
  return (
    <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-2" data-ws-empty="">
      {filtered ? (
        t('project:boardEmpty.filtered')
      ) : loadFailed ? (
        // The sentence about the board follows the one about the load, where
        // the message puts it.
        <RichMessage id="project:boardEmpty.loadFailed" components={[<>{board}</>]} />
      ) : board}
    </div>
  );
}

/**
 * #4896: what "Tell Homeroom bot what to change" hands the bot: this
 * project, as the object its chat attaches on the composer
 * (../../messages/store.ts openBot), so the bot reads which project is
 * meant and the box asks "What should change?". The name is the chip's
 * until the server's own reading of the project comes. Pure, for the tests.
 */
export function startHereBotReference(slug: string, name: string): StagedObject {
  return { type: 'app', appSlug: slug, title: name || null };
}

/**
 * #2573 — the start-here prompt, at the very top of Current status.
 *
 * ── When it is up ───────────────────────────────────────────────────────
 *
 * One state only: nothing open AND nothing ever landed. Both halves are
 * needed, and neither alone is this state. An app with no open items that
 * has shipped a hundred changes is FINISHED, not unstarted, and offering it
 * a "start working on this app" prompt reads as though the page had not
 * looked; an app with nothing shipped but a full board has already been
 * started, by whoever filed those. `everShipped` is the whole Done column,
 * not `shippedWeek` — see the model — because a quiet week on a busy app
 * zeroes the week count and would otherwise put this banner on it.
 *
 * There was a third condition, `meta.filtered`, because `dashboard.open`
 * used to count only the entries that survived the shared filter bar, so a
 * search matching nothing read as "no open items" on a board with plenty.
 * The search and filters narrow All items alone now (#2915) and the count is
 * the whole app's, so the two conditions above are the whole claim.
 *
 * ── Why the button is not a second "Start a new change" ─────────────────
 *
 * It is `Improve.startSession()`, the one the Homeroom menu's Start a new
 * change row calls (it was the Improve panel's New change) — imported, not re-implemented, so the navigate-then-create
 * sequence that entry point owns (features/improve/improve-controller.js)
 * can never drift from this copy of it. The gate is the same store field the
 * panel gates that row on, for the same reason: a viewer who may not start a
 * change from the panel must not be offered one here. They still get the
 * heading and the line, which say what the app's state IS — that part is not
 * a write action.
 *
 * The surface is `.dev-ws-strip` and its heading classes, unchanged, so the
 * prompt is another pane of this tab rather than a second visual language;
 * both themes come from the tokens every strip beside it already reads. The
 * action is the shell's own primary Button, which is the violet accent in
 * light and dark alike.
 *
 * ── Where Homeroom bot builds for you, it sends you to the bot (#4896) ──
 *
 * A newcomer reached this card at the end of the first-session tour
 * (onboarding run, 12 Oct 2026), and "Start working on this app … The first
 * change is yours to start" with Start a new change read like a developer
 * tool. So for a viewer Homeroom bot builds changes for here (`bot`, the
 * view's `mine.bot`, AppView._botDoor: the gate Your work's "tell Homeroom
 * bot" line uses) the card asks what they want changed and its one button
 * is "Tell Homeroom bot what to change": their chat with the bot, with this
 * project attached on the composer and the box asking "What should
 * change?" (../../messages/store.ts openBot, the change page's Ask for
 * changes' door; startHereBotReference). Building it yourself is not
 * offered twice: it is the hub's ⋯, Build it now, the same
 * Improve.startSession(). Everyone else (the bot does not build here, or
 * not for them) keeps the card as it was, with Start a new change.
 */
function StartHereBanner({ slug, name, bot }: { slug: string; name: string; bot: boolean }): ReactNode {
  const readOnly = useStoreState(improveStore).readOnly;
  const t = useMessages('project');
  if (bot && !readOnly && slug) {
    return (
      <section className="dev-ws-strip" data-ws-start-here="bot">
        <div className="dev-ws-head">
          <span className="dev-ws-head-title">{t('project:hub.startHere.bot.title')}</span>
        </div>
        <p className="dev-ws-strip-text">
          {t('project:hub.startHere.bot.text')}
        </p>
        <Button
          type="button"
          data-ws-start-here-bot=""
          size="sm"
          className="self-start"
          onClick={() => { void openBot(startHereBotReference(slug, name)); }}
        >
          {t('project:hub.startHere.bot.button')}
        </Button>
      </section>
    );
  }
  return (
    <section className="dev-ws-strip" data-ws-start-here="">
      <div className="dev-ws-head">
        <span className="dev-ws-head-title">{t('project:hub.startHere.title')}</span>
      </div>
      <p className="dev-ws-strip-text">
        {t('project:hub.startHere.text')}
      </p>
      {readOnly ? null : (
        <Button
          type="button"
          data-ws-start-here-btn=""
          size="sm"
          className="self-start"
          onClick={() => Improve.startSession()}
        >
          {t('project:hub.startHere.start')}
        </Button>
      )}
    </section>
  );
}

function sortThemes(themes: WorkshopTheme[], key: SortKey): WorkshopTheme[] {
  const list = themes.slice();
  // #4417: the project's topics lead, in dapp.json's order (the server's),
  // whatever the sort: they are the categories the group set itself.
  const topics = list.filter((t) => t.topic && !t.ungrouped);
  const real = list.filter((t) => !t.ungrouped && !t.topic);
  const tail = list.filter((t) => t.ungrouped);
  if (key === 'people') real.sort((a, b) => (b.people.length - a.people.length) || (b.lastActive - a.lastActive));
  if (key === 'activity') real.sort((a, b) => (b.lastActive - a.lastActive) || (b.people.length - a.people.length));
  if (key === 'open') real.sort((a, b) => (b.counts.open - a.counts.open) || (b.lastActive - a.lastActive));
  return topics.concat(real, tail);
}

// THE ORDER HOLDS BETWEEN SORTS. The list was re-sorted on every refetch, so
// a vote, a verdict or a new card anywhere on the board could move the theme
// the reader was looking at — the largest layout shift measured on the
// Workshop was a card dropping 255 px when a draft became a proposal and its
// theme's counts moved. A chip press (or the first paint) sorts; a refetch
// keeps every theme where it was, drops the ones that are gone and adds new
// ones at the end, above "Not yet grouped".
export type HeldThemeOrder = { key: SortKey; ids: string[] } | null;
export function orderThemesStable(held: HeldThemeOrder, themes: WorkshopTheme[], key: SortKey): WorkshopTheme[] {
  const sorted = sortThemes(themes, key);
  if (!held || held.key !== key) return sorted;
  const byId = new Map(themes.map((t) => [t.id, t]));
  const kept = held.ids.map((id) => byId.get(id)).filter((t): t is WorkshopTheme => !!t);
  const keptIds = new Set(kept.map((t) => t.id));
  const all = kept.concat(sorted.filter((t) => !keptIds.has(t.id)));
  // The topics keep their own order at the head (sortThemes), held or not.
  const topics = themes.filter((t) => t.topic && !t.ungrouped);
  return topics.concat(all.filter((t) => !t.ungrouped && !t.topic), all.filter((t) => t.ungrouped));
}
function useStableThemeOrder(themes: WorkshopTheme[], key: SortKey): WorkshopTheme[] {
  const held = useRef<HeldThemeOrder>(null);
  return useMemo(() => {
    const ordered = orderThemesStable(held.current, themes, key);
    held.current = { key, ids: ordered.map((t) => t.id) };
    return ordered;
  }, [themes, key]);
}

// A chip press re-sorts, and the themes slide to their new places rather than
// jumping there (FLIP: the positions are read on the press, before the
// re-render, and each card animates from its old place to its new one).
function useThemeReorderMotion(listRef: { current: HTMLElement | null }, themes: WorkshopTheme[]) {
  const from = useRef<Map<string, number> | null>(null);
  const capture = () => {
    const list = listRef.current;
    if (!list || typeof window === 'undefined'
      || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
    const tops = new Map<string, number>();
    list.querySelectorAll<HTMLElement>(':scope > [data-ws-theme]').forEach((el) => {
      tops.set(el.dataset.wsTheme || '', el.getBoundingClientRect().top);
    });
    from.current = tops;
  };
  useLayoutEffect(() => {
    const tops = from.current;
    from.current = null;
    const list = listRef.current;
    if (!tops || !list) return;
    list.querySelectorAll<HTMLElement>(':scope > [data-ws-theme]').forEach((el) => {
      const was = tops.get(el.dataset.wsTheme || '');
      if (was == null || typeof el.animate !== 'function') return;
      const dy = was - el.getBoundingClientRect().top;
      if (Math.abs(dy) < 1) return;
      el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }],
        { duration: 260, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
    });
  }, [themes, listRef]);
  return capture;
}

// `label` is a message id (frontend/locales/en/project.json), read when the
// chips render.
const SORTS: { key: SortKey; label: string }[] = [
  { key: 'people', label: 'project:allItems.sort.people' },
  { key: 'activity', label: 'project:allItems.sort.activity' },
  { key: 'open', label: 'project:allItems.sort.open' },
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
    if (!n) return translate('project:workshop.pace.nonePartial');
    return translate('project:workshop.pace.atLeast', { count: n });
  }
  if (!n && !p) return translate('project:workshop.pace.noneFortnight');
  if (!p) return translate('project:workshop.pace.firstInFortnight', { count: n });
  if (n > p) return translate('project:workshop.pace.up', { count: n, previous: p });
  if (n < p) return translate('project:workshop.pace.down', { count: n, previous: p });
  return translate('project:workshop.pace.same', { count: n });
}

/**
 * The four figures, at the head of the Workshop's Overview card.
 *
 * They were prose ("58 open items across 11 themes... 4 proposals are waiting
 * on votes and 19 open items have nobody on them"), which is the slowest
 * possible way to read four integers. A tile is scanned; a clause has to be
 * parsed. These four and not others: how much is open, the part of it nobody
 * has taken, the decisions waiting on votes, and what actually landed.
 *
 * ── ONE ROW, NOT FOUR CARDS ──
 * Hairlines between the figures, no fill of their own, on the card's own
 * ground, four across at every width (5 Oct 2026): a phone draws them closer
 * together and a size smaller instead (app.css `.dev-ws-dash`). A label wraps
 * onto a second line there; it is never cut short.
 *
 * ── THE ORDER IS AN ARGUMENT ──
 * The backlog, then the part of it nobody has taken, then the decisions
 * waiting, then what actually landed. It ends on the one number that says
 * the app is moving.
 *
 * ── THE MARK CARRIES THE TONE; THE COLOUR RIDES ALONG ──
 * A dot beside the label carries the tone, so the number is free to take
 * the colour as well: redundant rather than load-bearing. Only the two
 * figures that are a CALL wear either, and a zero wears neither.
 *
 * ── AND A LINE UNDER TWO OF THEM (After-Workshop-B) ──
 * Waiting on votes says how many of those wait on YOU ("4 on you", the
 * place bar's own count, `owed`), and live this week what last week came to
 * ("from 382"), the rate `pace()` words in full on hover. Each is left out
 * when it would say zero, and the rate is left out of a paged history,
 * where the earlier week is a floor and the comparison would lie. Open and
 * unclaimed have no line: nothing stores what they were last week.
 *
 * "Live this week" wears a `+` when the merged history is paged, because the
 * number is then a floor and not a total.
 *
 * ── AND THE VOTES FIGURE OPENS THE VOTE (#4745) ──
 * With a change or a group decision up for a vote, "waiting on a vote" is a
 * button: one waiting opens that item's page, several open All items, where
 * every one of them is listed. The other three figures stay spans, and a
 * zero stays a plain number — there is nothing to open.
 */
function DashTiles({ d, owed, onVotes }: { d: Dash; owed: number; onVotes?: () => void }): ReactNode {
  const t = useMessages('project');
  const rate = !d.partial && d.shippedPrevWeek > 0 ? (d.shippedWeek > d.shippedPrevWeek ? 'up' : d.shippedWeek < d.shippedPrevWeek ? 'down' : 'same') : null;
  const cells: { key: string; n: number; label: string; tone?: string; title?: string; sub?: ReactNode }[] = [
    { key: 'open', n: d.open, label: t('project:workshop.dash.open', { count: d.open }) },
    { key: 'unclaimed', n: d.unclaimed, label: t('project:workshop.dash.unclaimed') },
    {
      key: 'votes',
      n: d.votesWaiting,
      label: t('project:workshop.dash.votes', { count: d.votesWaiting }),
      tone: d.votesWaiting ? 'warn' : undefined,
      sub: owed > 0 ? (
        <span className="dev-ws-dash-sub" data-ws-dash-sub="owed">{t('project:workshop.dash.onYou', { count: owed })}</span>
      ) : null,
    },
    {
      key: 'shipped',
      n: d.shippedWeek,
      label: t('project:workshop.dash.shipped'),
      tone: d.shippedWeek ? 'good' : undefined,
      title: d.partial
        ? t('project:workshop.dash.shippedPartial')
        : t('project:workshop.dash.shippedWeek'),
      sub: rate ? (
        <span className="dev-ws-dash-sub" data-ws-dash-sub="rate" data-dir={rate} title={pace(d)}>
          {rate === 'same' ? null : <ArrowUpIcon className="dev-ws-dash-trend" aria-hidden="true" />}
          {t('project:workshop.dash.fromLastWeek', { count: d.shippedPrevWeek })}
        </span>
      ) : null,
    },
  ];
  return (
    <div className="dev-ws-dash" data-ws-dash="">
      {cells.map((c) => {
        // #4745: only the votes figure, only while something actually waits,
        // and only when the caller can route the tap. The markup is otherwise
        // like-for-like with the span — the same class, the same attribute.
        const tappable = c.key === 'votes' && c.n > 0 && !!onVotes;
        const cls = c.tone ? `dev-ws-dash-cell dev-ws-dash-cell-${c.tone}` : 'dev-ws-dash-cell';
        const content = (
          <>
            <b>{c.key === 'shipped' && d.partial && c.n ? `${c.n}+` : c.n}</b>
            <span className="dev-ws-dash-label">
              {/* A GRID in app.css, not an inline run: the label wraps at phone
                  widths, and a centred mark floated to the middle of a two-line
                  label while its second line ran back underneath the dot. */}
              {c.tone ? <i className={`dev-ws-dash-dot dev-ws-dash-dot-${c.tone}`} aria-hidden="true" /> : null}
              <span>{c.label}</span>
            </span>
            {c.sub}
          </>
        );
        return tappable ? (
          <button
            key={c.key}
            type="button"
            className={cls}
            data-ws-dash-cell={c.key}
            data-ws-dash-open=""
            onClick={onVotes}
            title={c.title}
          >
            {content}
          </button>
        ) : (
          <span key={c.key} className={cls} data-ws-dash-cell={c.key} title={c.title}>
            {content}
          </span>
        );
      })}
    </div>
  );
}

/**
 * WHERE THE OPEN WORK IS, under the figures (After-Workshop-B): "Most open
 * work is in" and the four categories with the most of it, as chips
 * (`dashboard.openThemes`, ranked over the whole app, whatever All items is
 * searched for, #2915). It replaces the model's paragraph about the open
 * work and the sentence derived from the counts, which said the figures
 * over again in prose. A chip opens its topic the way a topic opens: a
 * project topic is its channel; any other category is its card on All
 * items, unfolded.
 */
function OpenTopics({ list, slug, onChannel, onTheme }: {
  list: Dash['openThemes'];
  slug: string;
  onChannel: (place: TabKey) => void;
  onTheme: (id: string) => void;
}): ReactNode {
  useMessages('project');
  if (!list || !list.length) return null;
  const chips = (
    <span className="dev-ws-ov-chips">
      {list.map((theme) => (theme.topic ? (
        <a
          key={theme.id}
          className="dev-ws-ov-chip un-touch-target"
          data-ws-topic-chip={theme.id}
          data-ws-topic-channel={theme.topic.handle}
          href={placeHref(slug, channelPlace(theme.topic.handle))}
          onClick={(e) => {
            const nav = (window as unknown as { NavLink?: { isNativeClick?: (ev: unknown) => boolean } }).NavLink;
            if (nav?.isNativeClick?.(e)) return;
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
            e.preventDefault();
            onChannel(channelPlace(theme.topic?.handle));
          }}
        >
          {theme.name}
        </a>
      ) : (
        <button
          key={theme.id}
          type="button"
          className="dev-ws-ov-chip un-touch-target"
          data-ws-topic-chip={theme.id}
          onClick={() => onTheme(theme.id)}
        >
          {theme.name}
        </button>
      )))}
    </span>
  );
  return (
    <p className="dev-ws-ov-topics" data-ws-open-topics="">
      <RichMessage id="project:workshop.overview.mostOpenIn" components={[<span className="dev-ws-ov-lead" />, chips]} />
    </p>
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
type CardRow = Extract<ListRow, { t: 'card' }>;

/** One week of the since list: its heading, its line, and what moved in it. */
export interface SinceWeek {
  key: string;
  /** "This week" for the live window; '' for the rest, which are their dates. */
  title: string;
  startMs: number;
  endMs: number;
  live: boolean;
  /** The week's summary (the digest's line for it), or '' where there is none. */
  line: string;
  counts: Dash['weeks'][number]['counts'];
  /** Moved since the viewer's last visit, newest first. */
  fresh: CardRow[];
  /** Moved before it, which they have seen. */
  seen: CardRow[];
}

const WEEK_MS = 7 * 86400000;

/** The Monday 00:00 UTC a moment falls in: the weeks' own anchor (AppView._weekStart). */
export function mondayUtc(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - ((d.getUTCDay() + 6) % 7) * 86400000;
}

/**
 * The since list, filed by week, newest week first.
 *
 * The weeks are the digest's (`dashboard.weeks`, back to the project's
 * first), each with its line, whether or not anything in the list moved in
 * it: a week's heading and line are its history. A row whose week the
 * digest has no line for (a week in which nothing landed, which the digest
 * skips, or a board with no digest at all) gets a heading of its own dates
 * and no line. Rows file by `at`, the moment they moved, clamped to now so a
 * server clock a moment ahead cannot open a week that has not started.
 */
export function sinceWeeks(
  since: NonNullable<DevWorkshopView['since']>,
  weeks: Dash['weeks'] | null | undefined,
  nowMs: number,
): SinceWeek[] {
  const byStart = new Map<number, SinceWeek>();
  const thisMonday = mondayUtc(nowMs);
  for (const w of weeks || []) {
    const start = mondayUtc(w.startMs);
    if (byStart.has(start)) continue;
    byStart.set(start, {
      key: w.key,
      title: w.title,
      startMs: start,
      endMs: w.endMs,
      live: w.key === 'thisWeek',
      line: w.line || '',
      counts: w.counts || null,
      fresh: [],
      seen: [],
    });
  }
  const file = (row: ListRow, side: 'fresh' | 'seen') => {
    if (row.t !== 'card') return;
    const at = Math.min(Number(row.at) || nowMs, nowMs);
    const start = mondayUtc(at);
    let week = byStart.get(start);
    if (!week) {
      const live = start >= thisMonday;
      week = {
        key: `week:${start}`,
        title: live ? translate('project:since.week.thisWeek') : '',
        startMs: start,
        endMs: live ? nowMs : start + WEEK_MS,
        live,
        line: '',
        counts: null,
        fresh: [],
        seen: [],
      };
      byStart.set(start, week);
    }
    week[side].push(row);
  };
  for (const row of since.rows) file(row, 'fresh');
  for (const row of since.seen.rows) file(row, 'seen');
  return [...byStart.values()].sort((a, b) => b.startMs - a.startMs);
}

/**
 * What a week's unfolded state is remembered by: its Monday. Not `key`,
 * which is `week:<Monday>` while the week is built from rows alone and
 * becomes `thisWeek` / `lastWeek` when the digest's weeks ride in behind the
 * board's data. Keyed by `key`, a week opened in between snapped shut as
 * they landed. Both constructions share the `mondayUtc` start.
 */
export function sinceWeekStateKey(week: Pick<SinceWeek, 'startMs'>): string {
  return String(week.startMs);
}

/* ═══════════════════════════════════════════════════════════════════════
 * `Needs you` — a review feed of what other people submitted.
 *
 * ── What it is ───────────────────────────────────────────────────────
 *
 * One decision fills the screen: a change, or a group decision, owed your
 * vote. Nothing else is in it: the requests nobody has picked up are the
 * group's to take, not yours to answer, and the Hub and the Workshop offer
 * them. A swipe (a wheel, an arrow key) snaps to the next, the way a feed of
 * short videos does, because the claims are the same: one thing at a time,
 * and the thing you look at is the whole screen.
 *
 * ── The item: the picture, with the caption over it ──────────────────
 *
 * The PICTURE fills the card, chosen in one order (usePicture): the run's
 * own outlined screen (ShotsPicture), the author's or a group decision's
 * diagram, a legacy before & after pair (BeforeAfter), then "What it
 * touches" (TouchesPicture). Over its foot, on a scrim that keeps it
 * legible whatever the picture is, sits the CAPTION, bottom-left as on a
 * reel: who and when, the title, the summary clamped to two lines with a
 * "more", and one line of facts ("0 of 1 approval · your yes puts it live ·
 * App creation & templates"), each part only when there is data for it.
 * "more" grows the caption over the picture, which dims: the summary in
 * full, What changes and what it touches, scrolling if it runs long, and
 * "less" puts it back. D does the same from the keyboard.
 *
 * ── The rail ─────────────────────────────────────────────────────────
 *
 * ONE rail, for the item in view, rather than one per item: the buttons stay
 * where the thumb learned they are while the items move under them. Vote,
 * Comments (with its count), Ask, Try it, More, top to bottom. Vote is one
 * control that opens the question — Yes and No live on its sheet, with the
 * tally — because a thumbs-up on a rail reads as "like", and this is not
 * that. More is the card's own ⋯ menu: the same `data-card-menu` hook the
 * Board's cards carry, so `_openCardMenu` finds it and the entries are
 * exactly the card's. Try it is the card's Preview affordance under a name
 * that says what it does.
 *
 * ── Comments and Ask share one sheet ─────────────────────────────────
 *
 * Below 700px it is a sheet from the floor over a scrim, with two tabs,
 * Comments and Ask; above, the same markup is a PANEL beside the card, with
 * the card's caption repeated at its top so the card can keep the picture.
 * The Comments button opens it on Comments, Ask on Ask; switching tabs keeps
 * it open, and the lit button pressed again closes it. Vote is its own sheet
 * (a popover on its button on a wide window). `useMediaFlag(WIDE_QUERY)` is
 * that breakpoint in the other language; the keys (↑ ↓ move, V vote, C
 * comments, A ask, T try it, M more) work everywhere and are only LISTED on
 * the wide layout, where a keyboard is likely.
 *
 * ── After a vote ─────────────────────────────────────────────────────
 *
 * Nothing advances on its own. The row leaves the queue on the click
 * (#2031), so the feed PINS a copy of it in place — the eyebrow becomes the
 * confirmation and the Vote button a tick — until you move on; a card that
 * vanished under the press read as a mis-tap. The scroller re-syncs to the
 * row you are on BY KEY, so a row leaving above you never shifts what you
 * are reading.
 *
 * ── Swipe to vote, on a phone (#3052) ────────────────────────────────
 *
 * Below 700px a proposal card the viewer can vote on also answers to a
 * SIDEWAYS drag: right is Yes, left is No, and a faint "Yes" or "No" fades
 * in as the card travels. Short of the threshold it snaps back and nothing
 * is sent; past it the card waits at the line while `answer()` runs, which
 * is the Vote sheet's own path: castVote asks a No for its line, and a
 * dismissed prompt casts nothing. The axis is picked once per press
 * (./swipe-vote.ts), so an upward drag still pages, a tap is still a tap,
 * and the wide layout never sees any of it.
 *
 * ── The end card (#2172) ─────────────────────────────────────────────
 *
 * One card PAST the last item, always: the swipe that would have hit the
 * end of the scroller lands on what the pass did instead — how many of the
 * decisions waiting on you it reviewed, and what each vote did, in words the
 * platform can stand behind (DoneItem). It is one more snap point in the
 * same scroller, not a footer, so on a phone it arrives the way every item
 * did. With nothing in the queue it is the whole screen. `?shot=needs-end`
 * opens on it, for the declared check.
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
/** Vote is its own sheet; Comments and Ask are the two tabs of one. */
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

/** A status in the end card's "What your votes did". Complete literals, as above. */
function statusTone(tone: string | undefined): string {
  switch (tone) {
    case 'ok': return 'dev-ws-done-status dev-ws-done-status-ok';
    case 'progress': return 'dev-ws-done-status dev-ws-done-status-progress';
    case 'blocked': return 'dev-ws-done-status dev-ws-done-status-blocked';
    default: return 'dev-ws-done-status';
  }
}
/** A fact's tone, as one word of the card's facts line. */
function factTone(tone: string | undefined): string {
  switch (tone) {
    case 'ok': return 'dev-ws-fact dev-ws-fact-ok';
    case 'progress': return 'dev-ws-fact dev-ws-fact-progress';
    case 'warn': case 'attention': return 'dev-ws-fact dev-ws-fact-warn';
    case 'blocked': case 'reject': return 'dev-ws-fact dev-ws-fact-blocked';
    default: return 'dev-ws-fact';
  }
}

/**
 * The key legend: the keys an item answers to, each a message id whose text
 * holds the keys as numbered tags and the word after them ("<0>V</0> vote"),
 * with how many keys it draws. In the rail's order. The end card answers to
 * the move keys alone.
 */
function legendFor(end: boolean): Array<{ id: string; keys: number }> {
  const keys: Array<{ id: string; keys: number }> = [{ id: 'project:needsYou.keys.move', keys: 2 }];
  if (end) return keys;
  keys.push(
    { id: 'project:needsYou.keys.vote', keys: 1 },
    { id: 'project:needsYou.keys.comments', keys: 1 },
    { id: 'project:needsYou.keys.ask', keys: 1 },
    { id: 'project:needsYou.keys.tryIt', keys: 1 },
    { id: 'project:needsYou.keys.more', keys: 1 },
  );
  return keys;
}

/**
 * The item's facts, as ONE line under its caption: how you voted, where the
 * vote stands, "your yes puts it live" when exactly one more Yes meets the
 * rule (`lastYes`), what the card's status pill says, and the category or
 * priority when one is set. Each only when there is data for it; five at
 * most. `topic` is the category or priority, which the line sets apart from
 * the vote's words on a wide window.
 */
type Fact = { key: string; tone: string | undefined; text: string; topic?: boolean };
/**
 * The pill states the facts line already says: the count itself ("1 / 2",
 * an at-least-N rule's "1 of 2 approvals") is the tally in words, and the
 * vote the viewer owes ("Vote · 0/2", a solo project's "Waiting for your
 * approval") is the eyebrow.
 */
const SAID_ELSEWHERE = new Set(['needs_vote', 'tally', 'approvals']);
function factsFor(row: QueueRow, voted: string | null): Fact[] {
  const out: Fact[] = [];
  const st = row.card.pill ? row.card.pill.state : null;
  // A no vote (and a "Not approved") is the blocked tone, not the ok one:
  // #4568. The existing factTone map gives the red classes.
  if (voted) out.push({ key: 'voted', tone: voted === 'no' ? 'blocked' : 'ok', text: youAnswered(row, voted) });
  if (st) {
    // The count in the change page's own words: an at-least-N rule's pill
    // reads "1 of 2 approvals" there (AppView.statusPillState), and every
    // rule's count reads the same way here.
    out.push({ key: 'tally', tone: undefined, text: translate('project:needsYou.fact.approvals', { yes: st.yes, count: st.majority }) });
  } else if (row.tally) {
    // The Communities feed's rows (#3488): the counts, without a threshold
    // it has not worked out for each project. A zero says nothing.
    const said = factsLine([
      row.tally.yes ? translate('project:needsYou.fact.yes', { count: row.tally.yes }) : '',
      row.tally.no ? translate('project:needsYou.fact.no', { count: row.tally.no }) : '',
    ]);
    if (said) out.push({ key: 'tally', tone: undefined, text: said });
  }
  if (!voted && lastYes(row)) out.push({ key: 'last', tone: undefined, text: translate('project:needsYou.fact.yourYesPutsItLive') });
  if (st && st.label && !st.plainVote && !SAID_ELSEWHERE.has(st.key)) out.push({ key: 'state', tone: st.tone, text: st.label });
  for (const b of row.card.badges) {
    if (b.t === 'attr' && (b.field === 'category' || b.field === 'priority') && b.label.text) {
      out.push({ key: b.key, tone: undefined, text: b.label.text, topic: true });
    }
  }
  return out.slice(0, 5);
}

/**
 * The facts as the caption sets them: the vote's words in a quiet pill with
 * the people glyph, and the topic after it. On a phone the pill holds the
 * whole line (app.css), on a wide window the topic stands beside it. Nothing
 * at all when there is nothing to say.
 */
function FactsLine({ facts }: { facts: Fact[] }): ReactNode {
  const vote = facts.filter((f) => !f.topic);
  const topic = facts.filter((f) => f.topic);
  if (!facts.length) return null;
  return (
    <p className="dev-ws-item-facts" data-ws-facts="">
      {vote.length ? (
        <span className="dev-ws-item-facts-vote">
          <UserIcon className="dev-ws-item-facts-icon" aria-hidden="true" />
          {vote.map((f) => <span key={f.key} className={factTone(f.tone)}>{f.text}</span>)}
        </span>
      ) : null}
      {topic.map((f) => <span key={f.key} className="dev-ws-fact dev-ws-fact-topic">{f.text}</span>)}
    </p>
  );
}

/**
 * #3977: a change on a project that is just yours, whose Yes is the one it
 * needs (B7: the row's `yes.approve`, from `_cardVoteButtonSpecs`), is
 * approved rather than voted on, here as on its card: the rail, the sheet,
 * the swipe and the confirmation say Approve and Don't approve. The
 * Communities feed's rows carry it too (#4270: the needs feed's `approve`,
 * features/workshop/needs-reel.tsx).
 */
function approves(row: QueueRow): boolean {
  return !!(row.yes && row.yes.approve);
}
/**
 * Whether the viewer's Yes is the one that meets the rule: a Just-you
 * change's approval, or a change exactly one Yes short of it whose rule
 * counts the viewer's (`lastYes`, AppView._yesPutsItLive).
 */
function lastYes(row: QueueRow): boolean {
  return !!(row.yes && row.yes.act) && (approves(row) || row.lastYes === true);
}
/**
 * The confirmation once the item is answered: "Voted yes", or "Approved" /
 * "Not approved". `where` is the place that says it: the item's own line,
 * or the rail's Vote button.
 */
function answeredWords(row: QueueRow, voted: string, where: 'item' | 'rail'): string {
  const yes = voted === 'yes';
  if (where === 'rail') {
    if (!approves(row)) return yes ? translate('project:needsYou.rail.votedYes') : translate('project:needsYou.rail.votedNo');
    return yes ? translate('project:needsYou.rail.approved') : translate('project:needsYou.rail.notApproved');
  }
  if (!approves(row)) return yes ? translate('project:needsYou.answered.votedYes') : translate('project:needsYou.answered.votedNo');
  return yes ? translate('project:needsYou.answered.approved') : translate('project:needsYou.answered.notApproved');
}
/** The same, as the facts line says it. */
function youAnswered(row: QueueRow, voted: string): string {
  const yes = voted === 'yes';
  if (!approves(row)) return yes ? translate('project:needsYou.fact.youVotedYes') : translate('project:needsYou.fact.youVotedNo');
  return yes ? translate('project:needsYou.fact.youApproved') : translate('project:needsYou.fact.youDidNotApprove');
}

/** The line under the vote question: where the vote stands, and what follows. */
/**
 * The vote sheet's form (#3613): the card's own `VotePicker`
 * (card/dev-card.tsx), drawn inline on the sheet — the Yes/No switch with
 * the tally, the line for the group under it (optional on a Yes, required
 * on a No), Cancel and one "Vote yes" / "Vote no". The line used to be
 * asked for AFTER the press, by castVote's prompt card on top of the sheet;
 * now it is written here and sent with the vote. The state is NeedsFeed's,
 * so a key can turn the switch; exported for the render test.
 */
export function NeedsVoteForm({ row, slug, side, line, boxRef, onSide, onLine, onBoxKey, onCancel, onSend }: {
  row: QueueRow;
  /** The open project's, for a row that does not name its own (rowSlug). */
  slug?: string;
  side: 'yes' | 'no';
  line: string;
  boxRef?: RefObject<HTMLTextAreaElement | null>;
  onSide: (side: 'yes' | 'no') => void;
  onLine: (line: string) => void;
  onBoxKey: (ev: globalThis.KeyboardEvent | { key: string; shiftKey: boolean; preventDefault: () => void }) => void;
  onCancel: () => void;
  onSend: () => void;
}): ReactNode {
  // #22: who the row's project is for. On a project that is just yours the
  // Yes side's optional line is a note, not a line for the group; the hub's
  // shared read, so the hero and this agree.
  const solo = useCommunity(rowSlug(row, slug || ''))?.audience === 'solo';
  const t = useMessages('project');
  return (
    <div className="dev-ws-vote-form" data-ws-vote-form="" data-side={side}>
      <VotePicker
        yes={{ key: 'yes', label: row.yes ? row.yes.label : t('project:needsYou.vote.yes'), tally: row.yes ? row.yes.tally : undefined, act: row.yes && row.yes.act ? row.yes.act as ActionRef : undefined }}
        no={{ key: 'no', label: row.no ? row.no.label : t('project:needsYou.vote.no'), tally: row.no ? row.no.tally : undefined, act: row.no && row.no.act ? row.no.act as ActionRef : undefined }}
        prior={null}
        side={side}
        line={line}
        reasonId={`dev-ws-vote-reason-${row.key.replace(/[^\w-]/g, '-')}`}
        boxRef={boxRef}
        tally={labelTally}
        withLine
        solo={solo}
        approve={approves(row)}
        onSide={onSide}
        onLine={onLine}
        onBoxKey={onBoxKey}
        onCancel={onCancel}
        onSend={onSend}
      />
    </div>
  );
}

/** The vote sheet's line under its question (tallyLine); exported for the render test. */
export function VoteSub({ row, voted }: { row: QueueRow; voted: string | null }): ReactNode {
  // Subscribed: tallyLine reads its words as it is called.
  useMessages('project');
  return <p className="dev-ws-vote-sub">{tallyLine(row, voted)}</p>;
}

/** "2/3" beside "Yes (2/3)": the count a vote spec carries on its own, as the card's picker reads it. */
function labelTally(a: { tally?: string }): string {
  return a.tally || '';
}

/**
 * #4313: on a project that is just yours (approves) there is nobody else to
 * count, so the line says whose answer it waits on, and once you have
 * answered, the answer ("Approved." / "Not approved."). A pill's own word
 * that is not the wait itself ("Checks failing") still follows it.
 */
function tallyLine(row: QueueRow, voted: string | null): string {
  const st = row.card.pill ? row.card.pill.state : null;
  if (approves(row)) {
    // The pill's own word, when it is not the wait itself. It arrives from
    // AppView.statusPillState already worded, so it is a parameter.
    const state = st && st.label && !st.plainVote && !SAID_ELSEWHERE.has(st.key) ? st.label : '';
    if (!voted) {
      return state ? translate('project:needsYou.voteSub.waitingState', { state }) : translate('project:needsYou.voteSub.waiting');
    }
    if (voted === 'yes') {
      return state ? translate('project:needsYou.voteSub.approvedState', { state }) : translate('project:needsYou.voteSub.approved');
    }
    return state ? translate('project:needsYou.voteSub.notApprovedState', { state }) : translate('project:needsYou.voteSub.notApproved');
  }
  if (!st) {
    if (!row.tally) return '';
    const { yes, no } = row.tally;
    if (!yes && !no) return translate('project:needsYou.voteSub.nobody');
    return translate('project:needsYou.voteSub.counts', { yes, no });
  }
  return st.label && !st.plainVote
    ? translate('project:needsYou.voteSub.ofNeededState', { count: st.yes, needed: st.majority, state: st.label })
    : translate('project:needsYou.voteSub.ofNeeded', { count: st.yes, needed: st.majority });
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

function visualSrc(id: string, protectedShots = false): string {
  return protectedShots ? id : `/visuals/${id}`;
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
async function diffPair(before: string | null, after: string | null, protectedShots = false): Promise<Geo> {
  const [a, b] = await Promise.all([
    before ? loadImage(visualSrc(before, protectedShots)) : Promise.resolve(null),
    after ? loadImage(visualSrc(after, protectedShots)) : Promise.resolve(null),
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
  const t = useMessages('project');
  const viewRef = useRef<HTMLDivElement>(null);
  const [side, setSide] = useState<Side>(v.after ? 'after' : 'before');
  const [geo, setGeo] = useState<Geo | null>(null);
  const [failed, setFailed] = useState(false);
  const [view, setView] = useState({ w: 0, h: 0 });
  useEffect(() => {
    if (!near || geo || failed) return undefined;
    let live = true;
    diffPair(v.before, v.after, v.protected === true)
      .then((g) => { if (live) setGeo(g); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [near, geo, failed, v.before, v.after, v.protected]);
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
  // The switch and the way out sit in a bar ABOVE the picture, never on it:
  // laid over the still they covered the very corner a change often is.
  return (
    <div className="dev-ws-media" data-ws-media="">
      <div className="dev-ws-media-bar">
        {v.before && v.after ? (
          <div className="dev-ws-seg" role="group" aria-label={t('project:shots.switch.label')}>
            <button type="button" className="dev-ws-seg-btn" aria-pressed={side === 'before'} onClick={() => setSide('before')}>{t('project:shots.switch.before')}</button>
            <button type="button" className="dev-ws-seg-btn" aria-pressed={side === 'after'} onClick={() => setSide('after')}>{t('project:shots.switch.after')}</button>
          </div>
        ) : (
          <span className="dev-ws-seg dev-ws-seg-one">{v.after ? t('project:shots.only.after') : t('project:shots.only.before')}</span>
        )}
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
        data-shots={v.protected ? 'true' : undefined}
        data-before-url={v.protected ? (v.before || undefined) : undefined}
        data-head-url={v.protected ? (v.after || undefined) : undefined}
        data-claim={v.protected ? (v.claim || v.path) : undefined}
        onClick={(e) => onFull(e.currentTarget)}
      >
        {cropped ? t('project:shots.fullPageCropped') : t('project:shots.fullPage')}
      </button>
      </div>
      <div className="dev-ws-media-view" ref={viewRef}>
        {id && style ? (
          <img
            className="dev-ws-media-img"
            src={visualSrc(id, v.protected === true)}
            alt={side === 'after' ? t('project:shots.alt.after') : t('project:shots.alt.before')}
            style={style}
            draggable={false}
          />
        ) : null}
        {spot ? <span className="dev-ws-media-spot" style={spot} aria-hidden="true" /> : null}
        {geo ? null : <span className="dev-ws-media-wait" aria-hidden="true" />}
      </div>
    </div>
  );
}

type ShotScreen = NonNullable<NonNullable<QueueRow['visuals']>['screens']>[number];
type Box = { x: number; y: number; w: number; h: number };

const isPhoneScreen = (screen: ShotScreen) => /phone|mobile/i.test(screen.viewport);

/**
 * The screen this reader sees: a phone's on a phone, a desktop one on a wide
 * window, whichever the run has when it has only one.
 */
function pickScreen(screens: ShotScreen[], wide: boolean): ShotScreen | null {
  return screens.find((s) => (wide ? !isPhoneScreen(s) : isPhoneScreen(s))) || screens[0] || null;
}

/** A region's rectangle on one side: its box, or a line where it begins. */
function regionRect(region: ShotScreen['regions'][number], side: Side): { box: Box; line: boolean } | null {
  const box = side === 'before' ? region.b : region.a;
  if (box && box.length === 4) return { box: { x: box[0], y: box[1], w: box[2], h: box[3] }, line: false };
  const mark = side === 'before' ? region.bMark : region.aMark;
  if (region.n > 0 && mark && mark.length === 3) return { box: { x: mark[0], y: mark[1], w: mark[2], h: 0 }, line: true };
  return null;
}

/**
 * The item's picture when its before & after run worked out its screens:
 * ONE screen, at the reader's own size, cropped to the areas the run found
 * different and outlined there, numbered as the declared changes are (the
 * proposal's own card draws the same outlines, services/shots-diff.js). The
 * picture fills the card, under the caption; the changes the numbers stand
 * for are in the caption's "more". Tap the picture, or the switch above it,
 * to flip between after and before.
 *
 * The outlines are drawn in the VIEW's pixels over the scaled still, not
 * inside it, so a line and a number stay crisp at any scale. Nothing loads
 * until the item is in view or next to it (`near`).
 */
function ShotsPicture({ v, near, wide }: {
  v: NonNullable<QueueRow['visuals']>;
  near: boolean;
  wide: boolean;
}): ReactNode {
  const t = useMessages('project');
  const viewRef = useRef<HTMLDivElement>(null);
  const [side, setSide] = useState<Side>('after');
  const [view, setView] = useState({ w: 0, h: 0 });
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
  const screen = pickScreen(v.screens || [], wide);
  if (!screen) return null;
  const W = screen.width;
  const H = Math.max(screen.before.height, screen.after.height);
  // The crop: every outlined area on either side, so a flip never moves it.
  const rects = screen.regions.flatMap((r) => [regionRect(r, 'before'), regionRect(r, 'after')])
    .filter((r): r is { box: Box; line: boolean } => !!r);
  let place: { scale: number; tx: number; ty: number } | null = null;
  if (view.w && view.h) {
    const pad = 16;
    const x0 = rects.length ? Math.max(0, Math.min(...rects.map((r) => r.box.x)) - pad) : 0;
    const y0 = rects.length ? Math.max(0, Math.min(...rects.map((r) => r.box.y)) - pad) : 0;
    const x1 = rects.length ? Math.min(W, Math.max(...rects.map((r) => r.box.x + r.box.w)) + pad) : W;
    const y1 = rects.length ? Math.min(H, Math.max(...rects.map((r) => r.box.y + Math.max(r.box.h, 2))) + pad) : H;
    const box = { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
    const scale = Math.min(1, view.w / box.w, view.h / box.h);
    const sw = W * scale;
    const sh = H * scale;
    const tx = sw <= view.w ? (view.w - sw) / 2 : Math.max(view.w - sw, Math.min(0, view.w / 2 - (box.x + box.w / 2) * scale));
    const ty = sh <= view.h ? (view.h - sh) / 2 : Math.max(view.h - sh, Math.min(0, view.h / 2 - (box.y + box.h / 2) * scale));
    place = { scale, tx, ty };
  }
  const flip = () => setSide((s) => (s === 'after' ? 'before' : 'after'));
  const sideShot = (which: Side) => {
    const shot = which === 'before' ? screen.before : screen.after;
    return (
      <span
        key={which}
        className={which === 'before' ? 'dev-ws-shot-side dev-ws-shot-before' : 'dev-ws-shot-side dev-ws-shot-after'}
        style={place ? { width: W, height: shot.height, transform: `translate(${place.tx}px, ${place.ty}px) scale(${place.scale})` } : undefined}
      >
        {near && place ? <img src={shot.url} alt={which === 'after' ? t('project:shots.alt.after') : t('project:shots.alt.before')} draggable={false} /> : null}
      </span>
    );
  };
  const outlines = (which: Side) => (place ? screen.regions.map((r, k) => {
    const rect = regionRect(r, which);
    if (!rect) return null;
    const p = place as { scale: number; tx: number; ty: number };
    const style = {
      left: rect.box.x * p.scale + p.tx,
      top: rect.box.y * p.scale + p.ty,
      width: rect.box.w * p.scale,
      height: rect.line ? 0 : rect.box.h * p.scale,
    };
    const cls = rect.line
      ? (which === 'before' ? 'dev-ws-shot-mark dev-ws-shot-on-before' : 'dev-ws-shot-mark dev-ws-shot-on-after')
      : r.n > 0
        ? (which === 'before' ? 'dev-ws-shot-box dev-ws-shot-on-before' : 'dev-ws-shot-box dev-ws-shot-on-after')
        : (which === 'before' ? 'dev-ws-shot-box dev-ws-shot-box-other dev-ws-shot-on-before' : 'dev-ws-shot-box dev-ws-shot-box-other dev-ws-shot-on-after');
    // The number sits on the outline's corner, pulled back inside the
    // picture when the outline meets its edge, so it is never cut in half.
    const badge = {
      left: Math.max(-9, 2 - style.left),
      top: Math.min(Math.max(-9, 2 - style.top), view.h - 22 - style.top),
    };
    return (
      <span key={`${which}-${k}`} className={cls} style={style} aria-hidden="true">
        {r.n > 0 ? <span className="dev-ws-shot-n" style={badge}>{r.n}</span> : null}
      </span>
    );
  }) : null);
  const size = isPhoneScreen(screen) ? t('project:shots.size.phone') : screen.viewport.charAt(0).toUpperCase() + screen.viewport.slice(1);
  return (
    <div className="dev-ws-media dev-ws-media-shots" data-ws-media="" data-ws-shots="" data-side={side}>
      <div className="dev-ws-media-bar">
        <div className="dev-ws-seg" role="group" aria-label={t('project:shots.switch.label')}>
          <button type="button" className="dev-ws-seg-btn dev-ws-seg-before" aria-pressed={side === 'before'} onClick={() => setSide('before')}>{t('project:shots.switch.before')}</button>
          <button type="button" className="dev-ws-seg-btn dev-ws-seg-after" aria-pressed={side === 'after'} onClick={() => setSide('after')}>{t('project:shots.switch.after')}</button>
        </div>
        <span className="dev-ws-media-size">{size}</span>
      </div>
      <div
        className="dev-ws-media-view"
        ref={viewRef}
        role="button"
        tabIndex={0}
        aria-label={side === 'after' ? t('project:shots.flip.toBefore') : t('project:shots.flip.toAfter')}
        onClick={flip}
        onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); } }}
      >
        {sideShot('before')}
        {sideShot('after')}
        {outlines('before')}
        {outlines('after')}
        {near && place ? null : <span className="dev-ws-media-wait" aria-hidden="true" />}
      </div>
    </div>
  );
}

/* ── One item of the feed ────────────────────────────────────────────── */

/**
 * Who and when, for an item, as a reel's caption opens: the initial in a
 * round avatar, then "name · 2h ago". A change Homeroom bot built reads as
 * its page's by-line does (#3854): "Homeroom bot", not its account's name.
 * The comments panel's head draws the same line.
 */
function ItemBy({ row }: { row: QueueRow }): ReactNode {
  // Its author arrives as that account's username on both feeds
  // (AppView._botBuilt reads the same).
  const bot = String(row.who || '').toLowerCase() === 'homeroom_bot';
  const t = useMessages('project');
  const who = bot ? t('project:needsYou.by.botName') : row.who;
  return (
    <p className="dev-ws-item-by">
      {who ? (
        <span className="dev-ws-item-avatar" style={{ background: swatchFor(who) }} aria-hidden="true">
          {who.slice(0, 1).toUpperCase()}
        </span>
      ) : null}
      <span className="dev-ws-item-by-text">
        {/* One whole by-line per shape: who and when are parameters, and the
            bold run is the message's numbered tag. */}
        {who ? (
          row.ago
            ? <RichMessage id="project:needsYou.by.at" values={{ name: who, when: row.ago }} components={[<b />]} />
            : <b>{who}</b>
        ) : (row.ago ? t('project:needsYou.by.anonymousAgo', { when: row.ago }) : t('project:needsYou.by.anonymous'))}
      </span>
    </p>
  );
}

/**
 * The project a feed row is about: its own, on the Communities screen's feed
 * of every project's (#3488), else the page's.
 */
function rowSlug(row: QueueRow, slug: string): string {
  return row.app && row.app.slug ? row.app.slug : slug;
}

/** The most items the progress line draws as segments. */
const SEGMENTS_MAX = 24;

/**
 * memo(): the feed holds the Ask tab's draft and its streamed answer, so it
 * renders on every keystroke and every token of an answer, and none of that
 * is any item's business. Every prop is a primitive, a row off the publish,
 * or a callback the feed keeps stable (`openFull`, `toggleMore`), so an item
 * renders again only when something it draws changed.
 */
const FeedItem = memo(function FeedItem({ row, index, count, tint, near, voted, wide, swipe, slug, open, onFull, onMore, onPrev, renderApp }: {
  row: QueueRow;
  index: number;
  count: number;
  /** 'a' or 'b': the row's own, for life (see `tintFor` in NeedsFeed). */
  tint: 'a' | 'b';
  near: boolean;
  voted: string | null;
  wide: boolean;
  /** Takes the sideways swipe to vote (see `useSwipeVote`). */
  swipe: boolean;
  slug: string;
  /** The caption is grown over the picture ("more"): the item in view only. */
  open: boolean;
  onFull: (el: HTMLElement) => void;
  /** "more" and "less", a tap on a drawn picture, and the D key: one toggle. */
  onMore: () => void;
  /**
   * Back to the item before, from the chevron beside the counter (#3517).
   * Handed down on a phone only, where the Previous and Next beside the
   * rail are hidden; unset on a wide window, which has those.
   */
  onPrev?: () => void;
  /** Draws the row's project over its by-line, where rows mix projects. */
  renderApp?: (row: QueueRow) => ReactNode;
}): ReactNode {
  const t = useMessages('project');
  const href = openHref(rowSlug(row, slug), row.card);
  const title = row.card.title.text || row.card.title.title;
  const facts = factsFor(row, voted);
  const summary = row.summary || null;
  // The progress line is one segment an item (app.css masks the gaps), lit
  // up to and including the one in view; one unbroken line past
  // SEGMENTS_MAX, where the segments would be slivers.
  const pct = Math.round(((index + 1) / Math.max(1, count)) * 1000) / 10;
  // #4490: THE PICTURE, in one order: the run's own screens, then its
  // author's diagram (or a group decision's, from its own facts), a legacy
  // capture pair, then "What it touches". A Mermaid diagram that cannot be
  // drawn falls back to "What it touches".
  const shots = !!(row.visuals && row.visuals.screens && row.visuals.screens.length);
  const picture = usePicture(row, shots);
  // NO PICTURE AT ALL (no verified shots, no diagram, no capture pair, no
  // "What it touches"): the card is led by its words instead. app.css lets
  // the summary run to eight lines on a phone and ten on a wide window and
  // sets the caption in the middle of the card, so the room is the words',
  // not an empty frame. Nothing is drawn in the picture's place.
  const pictureless = !shots && !row.visuals && picture.kind === 'none';
  // What "more" adds under the summary: the declared changes the outlines
  // are numbered by, and what it touches. The rendered description is the
  // summary's own words, so on its own it is "more" only when the summary is
  // cut short.
  const changes = row.visuals && row.visuals.changes ? row.visuals.changes : [];
  const touches = useMemo(() => readTouches(row.touches), [row.touches]);
  const said = touches ? touchesSaid(touches, !!row.nothingVisible) : '';
  const behind = !!(changes.length || said);
  // Whether the clamp cuts the summary short, measured where it is laid
  // out: a summary that fits, with nothing behind it, offers no "more".
  const textRef = useRef<HTMLParagraphElement>(null);
  const [clamped, setClamped] = useState(false);
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el || open) return undefined;
    const measure = () => setClamped((cur) => {
      const next = el.scrollHeight > el.clientHeight + 1;
      return cur === next ? cur : next;
    });
    measure();
    if (typeof ResizeObserver !== 'function') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [summary, open]);
  const canMore = behind || clamped;
  // Cut short, "more" FLOATS to the end of the second line (app.css), so it
  // comes first; whole, it simply follows the text.
  const moreBtn = canMore ? (
    <button type="button" className={clamped ? 'dev-ws-item-more dev-ws-item-more-end' : 'dev-ws-item-more'} data-ws-more="" aria-expanded={false} onClick={onMore}>
      {t('project:needsYou.caption.more')}
    </button>
  ) : null;
  return (
    <section
      className="dev-ws-item"
      data-ws-item={row.key}
      data-ws-kind={row.kind}
      data-ws-tint={tint}
      data-ws-swipeable={swipe ? '' : undefined}
      data-ws-open={open ? '' : undefined}
      data-ws-picture={pictureless ? 'none' : undefined}
      data-ws-app={row.app ? row.app.slug : undefined}
    >
      <div className="dev-ws-item-progress" style={{ '--ws-n': count <= SEGMENTS_MAX ? count : 1 } as CSSProperties} aria-hidden="true"><i style={{ width: `${pct}%` }} /></div>
      <div className="dev-ws-item-top">
        {voted ? (
          <span className="dev-ws-item-done" data-ws-item-done="" data-ws-voted={voted}>
            <CheckIcon className="dev-ws-item-tick" aria-hidden="true" />
            {factsLine([answeredWords(row, voted, 'item'), wide ? t('project:needsYou.next.wide') : t('project:needsYou.next.phone')])}
          </span>
        ) : (
          // First-session run-through, 5 Oct 2026: a newcomer read
          // "PROPOSAL · NEEDS YOUR VOTE" here and "Change · Waiting for your
          // approval" on the same change's page. The item says what the page
          // says: what it is, and that it waits on you
          // (AppView._summarizeRequirements' group headline).
          <span className="dev-ws-eyebrow">
            {row.card.attrs && row.card.attrs['data-gov-row'] ? t('project:needsYou.eyebrow.groupDecision') : t('project:needsYou.eyebrow.change')}
          </span>
        )}
        {/* #3517: THE WAY BACK, WHERE A PHONE CAN SEE IT. Swiping down was
            always the way back, but nothing on the card said so, and the
            Previous beside the rail is a wide window's. This is that
            button, on the line that already says where you are, from the
            second item on: it points the way it goes, and at the top of
            the card it is in nobody's swipe. */}
        {onPrev && index > 0 ? (
          <button type="button" className="dev-ws-item-prev" data-ws-item-prev="" aria-label={t('project:needsYou.previousItem')} onClick={onPrev}>
            <ChevronUpIcon className="dev-ws-item-prev-icon" aria-hidden="true" />
          </button>
        ) : null}
        <span className="dev-ws-item-of">{`${index + 1} / ${count}`}</span>
      </div>
      {shots && row.visuals ? <ShotsPicture v={row.visuals} near={near} wide={wide} />
        : picture.kind === 'diagram' ? (
          <Diagram d={picture.d} source={picture.source} onOpen={onMore} onFail={picture.fail} defer={!near} dark className="dev-ws-media-diagram" />
        )
          : row.visuals ? <BeforeAfter v={row.visuals} near={near} onFull={onFull} />
            : picture.kind === 'touches' ? <TouchesPicture t={picture.t} nothingVisible={!!row.nothingVisible} onOpen={onMore} />
              : <div className="dev-ws-item-spacer" aria-hidden="true" />}
      {/* What keeps the caption legible over any picture: a fade up from the
          card's foot, and the whole card dimmed while the caption is open. */}
      <span className="dev-ws-item-scrim" aria-hidden="true" />
      {/* THE CAPTION, bottom-left, as on a reel: who and when, the title (the
          door to the change's own page, with the checks, the thread and
          every affordance the card has), the summary in two lines with its
          "more", and the facts. Open, it grows over the picture and scrolls. */}
      <div className="dev-ws-item-caption">
        {row.app && renderApp ? renderApp(row) : null}
        <ItemBy row={row} />
        <h2 className="dev-ws-item-title">{href ? <a href={href}>{title}</a> : title}</h2>
        {open ? (
          <div className="dev-ws-item-summary dev-ws-item-summary-open">
            {row.descriptionHtml ? <Html className="dev-ws-item-words" html={row.descriptionHtml} />
              : summary ? <p className="dev-ws-item-summary-text">{summary}</p> : null}
          </div>
        ) : (
          <div className="dev-ws-item-summary">
            <p className={summary ? 'dev-ws-item-summary-text' : 'dev-ws-item-summary-text dev-ws-item-nosummary'} ref={textRef}>
              {clamped ? moreBtn : null}
              {summary || t('project:needsYou.noSummary.change')}
              {clamped ? null : moreBtn}
            </p>
          </div>
        )}
        {open && changes.length ? (
          <div className="dev-ws-item-part">
            <h3 className="dev-ws-item-part-head">{t('project:needsYou.caption.whatChanges')}</h3>
            <ol className="dev-ws-shot-changes dev-ws-item-changes">
              {changes.map((c) => (
                <li key={c.n} className="dev-ws-shot-change">
                  <span className="dev-ws-shot-n">{c.n}</span>
                  <span>{c.text}</span>
                </li>
              ))}
            </ol>
          </div>
        ) : null}
        {open && said ? <p className="dev-ws-item-touched">{said}</p> : null}
        <FactsLine facts={facts} />
        {open ? (
          <button type="button" className="dev-ws-item-less" data-ws-less="" aria-expanded onClick={onMore}>
            {t('project:needsYou.caption.less')}
          </button>
        ) : null}
      </div>
      {/* The swipe's two hints, last so the item's reading order is
          untouched. Hidden until a drag fades one in (app.css), and
          aria-hidden: the Vote sheet's buttons are the accessible way. */}
      {swipe ? <span className="dev-ws-swipe-hint dev-ws-swipe-yes" aria-hidden="true">{approves(row) ? t('project:needsYou.swipe.approve') : t('project:needsYou.swipe.yes')}</span> : null}
      {swipe ? <span className="dev-ws-swipe-hint dev-ws-swipe-no" aria-hidden="true">{approves(row) ? t('project:needsYou.swipe.dontApprove') : t('project:needsYou.swipe.no')}</span> : null}
    </section>
  );
});

type Picture =
  | { kind: 'diagram'; d: DiagramRecord; source: DiagramSource; fail: () => void }
  | { kind: 'touches'; t: Touches }
  | { kind: 'none' };

/**
 * #4490: which picture a row shows when it has no shots. The author's
 * diagram first (or a group decision's, drawn from its facts), then "What it
 * touches"; a Mermaid diagram that failed to draw drops to the second. The
 * legacy capture pair sits between the two in FeedItem itself.
 */
function usePicture(row: QueueRow, shots: boolean): Picture {
  const [failed, setFailed] = useState(false);
  const authored = useMemo(() => readDiagram(row.diagram), [row.diagram]);
  const decided = useMemo(
    () => (authored ? null : decisionDiagram(row.decision as DecisionFacts | null, row.app ? row.app.name : null)),
    [authored, row.decision, row.app],
  );
  const touches = useMemo(() => readTouches(row.touches), [row.touches]);
  const fail = useCallback(() => setFailed(true), []);
  if (shots) return { kind: 'none' };
  const d = authored || decided;
  if (d && !failed) return { kind: 'diagram', d, source: authored ? 'author' : 'decision', fail };
  return touches ? { kind: 'touches', t: touches } : { kind: 'none' };
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
/**
 * The `?shot=` an item is opened on, read at mount like `?shot=needs-end`.
 * `needs-approve` (#4313): the first item that asks for your approval (a
 * project that is just yours), with its vote sheet up, so a declared check
 * can read the sheet's line ("Waiting for your approval."). And (#4490)
 * `needs-diagram` / `needs-touches`, the first item whose picture is its
 * author's diagram or "What it touches", for the declared check and the
 * before & after shots of those pictures. Read at mount.
 */
function shotTarget(): 'approve' | 'diagram' | 'touches' | null {
  if (typeof window === 'undefined' || typeof window.location === 'undefined') return null;
  try {
    const shot = new URLSearchParams(window.location.search).get('shot');
    return shot === 'needs-approve' ? 'approve' : shot === 'needs-diagram' ? 'diagram' : shot === 'needs-touches' ? 'touches' : null;
  } catch { return null; }
}
/** Whether a row is the one a `?shot=` target opens on. */
function shotMatches(target: 'approve' | 'diagram' | 'touches', r: QueueRow): boolean {
  if (target === 'approve') return approves(r);
  if (r.visuals && r.visuals.screens && r.visuals.screens.length) return false;
  const drawn = !!readDiagram(r.diagram);
  return target === 'diagram' ? drawn : !drawn && !!readTouches(r.touches);
}

/**
 * Where a vote cast in this pass left its change, for the end card's "What
 * your votes did": in words the platform can stand behind, and whether this
 * viewer's Yes was the one that met the rule (`over`).
 *
 * READ FRESH WHERE IT CAN BE: the board rows the vote's own refresh brought
 * back (AppView._needsOutcome; a merged change is in the merged list), as
 * its pill reads them: Live, Going live, a stalled or failed release in the
 * pill's own words, "Waiting for N more" while the rule is short, and a
 * countdown's "Goes live in 2h". Where nothing fresh is loaded (another
 * project's change, on the Communities screen) it is what the row said
 * before the vote. A No is "Back to the author": a No always carries its
 * line (castVote asks for it, the server refuses one without it), and the
 * line goes to the change's author, in its thread and their notification.
 * Nothing here promises a note when a change goes live: the platform sends
 * that to its author, not to the people who voted. Exported for the test.
 */
type Outcome = { text: string; tone: string | undefined; over: boolean; live: boolean };
type Fresh = { key: string; yes: number; majority: number; label?: string };
const LIVE_KEYS = new Set(['deployed', 'merged']);
const GOING_KEYS = new Set(['merging', 'deploying', 'delivery_pending']);
const STUCK_KEYS = new Set(['deployment_stalled', 'delivery_failed']);

export function outcomeFor(row: QueueRow, voted: string): Outcome {
  if (voted === 'no') return { text: translate('project:needsYou.end.status.backToAuthor'), tone: undefined, over: false, live: false };
  const last = lastYes(row);
  const live = (): Outcome => ({ text: translate('project:needsYou.end.status.live'), tone: 'ok', over: last, live: true });
  const going = (over: boolean): Outcome => ({ text: translate('project:needsYou.end.status.goingLive'), tone: 'progress', over, live: false });
  const waiting = (count: number): Outcome => ({ text: translate('project:needsYou.end.status.waiting', { count }), tone: undefined, over: false, live: false });
  const said = (): Outcome => ({ text: youAnswered(row, 'yes'), tone: undefined, over: false, live: false });
  const ref = row.askAbout;
  const raw = ref && ref.kind === 'proposal' ? callAppView('_needsOutcome', 'proposal', ref.ref) : null;
  const now = raw && typeof raw === 'object' ? raw as Fresh : null;
  if (now) {
    if (LIVE_KEYS.has(now.key)) return live();
    if (GOING_KEYS.has(now.key)) return going(last);
    if (STUCK_KEYS.has(now.key) && now.label) return { text: now.label, tone: 'blocked', over: false, live: false };
    const missing = Math.max(0, now.majority - now.yes);
    if (missing > 0) return waiting(missing);
    // The rule is met and the change is not live yet: on a clock, the
    // pill's own countdown; otherwise it goes in on the vote that met it.
    if (now.key === 'merge_countdown' && now.label) return { text: now.label, tone: 'ok', over: false, live: false };
    return last ? going(true) : said();
  }
  if (last) return going(true);
  const st = row.card.pill ? row.card.pill.state : null;
  const missing = st ? st.majority - st.yes - 1 : 0;
  return missing > 0 ? waiting(missing) : said();
}

/**
 * The end of the feed: one card past the last item, and the reviewer's
 * reward for getting there (#2172).
 *
 * "All caught up" when the pass answered everything in it, "That's it for
 * now" when it went past some; how many of the decisions waiting on you it
 * reviewed; and WHAT YOUR VOTES DID, a row each for what you answered here
 * (outcomeFor). When your Yes was the one that met a change's rule, the card
 * leads with it: "Your yes put it over the line".
 *
 * #3526: WHAT THE PASS WENT PAST IS SKIPPED, NOT WAITING. A vote swiped past
 * unanswered stops counting on every badge (../../workshop/needs-seen.ts),
 * and "5 are still waiting on you above" under a Needs you count that had
 * just dropped by five said two things at once. The line says what the
 * reader did and where those items are: above, still open, for a change of
 * mind; the way back up says the same. Exported for the render test.
 */
export function DoneItem({ rows, answered, left, onDone, onBack, onHub, onSuggest, doneLabel }: {
  /** Every item of this pass, answered here or not, in the feed's order. */
  rows: QueueRow[];
  /** What this pass answered, by row: 'yes' or 'no'. */
  answered: Record<string, string>;
  /** What it went past, unanswered. */
  left: number;
  onDone: () => void;
  onBack: () => void;
  /** The project page's way back to its Hub; unset on the Communities screen. */
  onHub?: () => void;
  onSuggest?: () => void;
  doneLabel?: string;
}): ReactNode {
  const t = useMessages('project');
  const n = rows.length;
  const did = rows.filter((r) => !!answered[r.key]).map((row) => ({ row, out: outcomeFor(row, answered[row.key]) }));
  const acted = did.length;
  const over = did.find((d) => d.out.over) || null;
  const titleOf = (row: QueueRow) => row.card.title.text || row.card.title.title;
  const parts: string[] = [];
  if (acted > 0) {
    parts.push(left > 0
      ? t('project:needsYou.end.reviewedSome', { done: acted, count: n })
      : t('project:needsYou.end.reviewedAll', { count: n }));
  }
  if (left > 0) parts.push(t('project:needsYou.end.skipped', { count: left }));
  if (!acted && !left) parts.push(t('project:needsYou.end.allAnswered'));
  return (
    <section
      className="dev-ws-item dev-ws-needs-done"
      data-ws-item={END_KEY}
      data-ws-kind="done"
      data-ws-done-acted={acted}
      data-ws-done-left={left}
    >
      {over ? (
        <div className="dev-ws-done-over" role="status" data-ws-done-over="">
          <span className="dev-ws-done-over-ic" aria-hidden="true"><CheckIcon /></span>
          <span className="dev-ws-done-over-text">
            <span className="dev-ws-done-over-line">{t('project:needsYou.end.overTheLine')}</span>
            <span className="dev-ws-done-over-sub">
              {over.out.live
                ? t('project:needsYou.end.overLive', { title: titleOf(over.row) })
                : t('project:needsYou.end.overGoingLive', { title: titleOf(over.row) })}
            </span>
          </span>
        </div>
      ) : null}
      <div className="dev-ws-done-body">
        {left > 0 ? null : <span className="dev-ws-done-tick" aria-hidden="true"><CheckIcon /></span>}
        <p className="dev-ws-needs-done-line">{left > 0 ? t('project:needsYou.end.forNow') : t('project:needsYou.end.caughtUp')}</p>
        <p className="dev-ws-needs-done-sub">{sentences(parts)}</p>
        {did.length ? (
          <div className="dev-ws-done-did" data-ws-done-did="">
            <h3 className="dev-ws-done-did-head">{t('project:needsYou.end.didHeading')}</h3>
            <ul className="dev-ws-done-did-list">
              {did.map(({ row, out }) => (
                <li key={row.key} className="dev-ws-done-did-row" data-ws-done-row={row.key}>
                  <span className="dev-ws-done-did-title">{titleOf(row)}</span>
                  <span className={statusTone(out.tone)}>
                    {out.live ? <CheckIcon className="dev-ws-done-status-ic" aria-hidden="true" /> : null}
                    {out.text}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="dev-ws-done-actions">
          <button type="button" className="dev-ws-done-cta" onClick={onDone}>{doneLabel || t('project:needsYou.end.seeLive')}</button>
          {onHub ? <button type="button" className="dev-ws-done-hub" data-ws-done-hub="" onClick={onHub}>{t('project:needsYou.end.backToHub')}</button> : null}
        </div>
        {left > 0 ? (
          <button type="button" className="dev-ws-done-back" data-ws-done-back="" onClick={onBack}>
            {t('project:needsYou.end.backToSkipped')}
          </button>
        ) : null}
        {/* #4680: the quiet second action on this card, a project only — the
            Communities screen's feed of every project passes nothing. Same
            look as the back-up-the-feed link, and the same form the hub's ⋯
            row opens (a plain open, so comment mode is honoured). */}
        {onSuggest ? (
          <button type="button" className="dev-ws-done-back" data-ws-done-suggest="" onClick={onSuggest}>
            {t('project:needsYou.end.suggest')}
          </button>
        ) : null}
      </div>
    </section>
  );
}

/* ── Swipe to vote (#3052) ───────────────────────────────────────────── */

/**
 * Which rows take the swipe: a proposal whose Yes and No both cast a vote.
 * A governance item carries no pair here (it is decided on its own page),
 * so it is not swiped. NeedsFeed narrows it further to the phone layout and
 * to a card not already answered.
 */
function canSwipeVote(row: QueueRow): boolean {
  return !!(row.yes && row.yes.act) && !!(row.no && row.no.act);
}

/**
 * What the gesture asks of the feed, read at the moment of asking, so the
 * listeners below never close over a stale row. `can` is asked on the press;
 * `commit` once the drag has crossed the line, and it calls `settled` when
 * the card may go back to rest (the vote is on its way, or it was not cast).
 */
interface SwipeVoteHandle {
  can: (key: string) => boolean;
  commit: (key: string, which: SwipeSide, settled: () => void) => void;
}

/** The spring back's length in app.css, and a little over. */
const SWIPE_REST_MS = 320;

/**
 * The kit's gesture arbiter, through PlatformUI (`gestures()`): one owner per
 * finger, shared with the kit's own recognizers, the Dev scroller's
 * pull-to-refresh among them. Null where the kit is not loaded.
 */
type GestureArbiter = { claim: (seq: string | number, token: unknown) => boolean };
function gestureArbiter(): GestureArbiter | null {
  const ui = (typeof window !== 'undefined' ? window.PlatformUI : undefined) as
    { gestures?: () => GestureArbiter | null } | undefined;
  try {
    const g = ui && typeof ui.gestures === 'function' ? ui.gestures() : null;
    return g && typeof g.claim === 'function' ? g : null;
  } catch {
    return null;
  }
}
const SWIPE_VOTE_TOKEN = 'workshop-swipe-vote';

/**
 * The sideways drag on a Needs-you card, as native pointer listeners on the
 * feed's scroller.
 *
 * VERTICAL STAYS THE BROWSER'S. The card says `touch-action: pan-y`
 * (app.css), so a drag that starts upward is still the scroller's snap
 * paging, which takes the touch with a `pointercancel`, and one that starts
 * sideways is left to this. A press decides once, at `SWIPE_LOCK_PX`
 * (./swipe-vote.ts): until then it is still a tap, and a `y` verdict lets go
 * of it for good. A mouse drag on a narrow window goes the same way; the
 * wide layout binds nothing.
 *
 * THE CARD MOVES BY CUSTOM PROPERTIES, not by state: a render per pointer
 * move would re-render the feed, and `FeedItem` is memo()'d to avoid exactly
 * that. `data-ws-swiping` is up while the finger is down (no transition, no
 * text selection); `data-ws-swipe` says which hint is showing; both are
 * taken off once the card is back at rest, so a card nobody touched carries
 * no transform. How far it moves, and whether it moves at all where motion
 * is unwelcome, is app.css's decision.
 *
 * PAST THE LINE the card waits there, its hint at full strength, until
 * `commit` settles. For a No that is the whole of the "What's not working
 * for you?" prompt, so the reader can see what they are giving a reason
 * for, and a cancel springs it back with nothing sent. A sideways drag
 * never also clicks what it started on: the one click it would produce with
 * a mouse is swallowed.
 */
function useSwipeVote(
  scrollRef: { current: HTMLElement | null },
  enabled: boolean,
  handleRef: { current: SwipeVoteHandle },
) {
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!enabled || !scroller || typeof window === 'undefined') return undefined;
    let drag: {
      id: number; el: HTMLElement; key: string;
      x0: number; y0: number; width: number; axis: SwipeAxis | null;
    } | null = null;
    // The card waiting at the line while its vote is asked for.
    let held: HTMLElement | null = null;
    let swallow = false;
    let restTimer = 0;
    let resting: HTMLElement | null = null;

    const paint = (el: HTMLElement, x: number, p: number, side: SwipeSide | null) => {
      el.style.setProperty('--ws-swipe-x', `${Math.round(x)}px`);
      el.style.setProperty('--ws-swipe-p', p.toFixed(3));
      if (side) el.setAttribute('data-ws-swipe', side);
    };
    const clear = (el: HTMLElement) => {
      el.removeAttribute('data-ws-swiping');
      el.removeAttribute('data-ws-swipe');
      el.style.removeProperty('--ws-swipe-x');
      el.style.removeProperty('--ws-swipe-p');
    };
    // Cut a spring back short: the card about to move again keeps its
    // properties, any other is cleaned at once.
    const stopResting = (keep: HTMLElement | null) => {
      window.clearTimeout(restTimer);
      if (resting && resting !== keep) clear(resting);
      resting = null;
    };
    // Back to rest: to zero first, so app.css's transition runs, then clean.
    const rest = (el: HTMLElement) => {
      stopResting(el);
      el.removeAttribute('data-ws-swiping');
      paint(el, 0, 0, null);
      resting = el;
      restTimer = window.setTimeout(() => {
        if (resting === el) clear(el);
        resting = null;
      }, SWIPE_REST_MS);
    };

    const onDown = (e: PointerEvent) => {
      if (held || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
      // A new primary press means the last one is over, whether or not its
      // end reached this scroller (a mouse let go outside it, before a lock).
      if (drag) {
        if (drag.axis === 'x') rest(drag.el);
        drag = null;
      }
      const t = e.target as Element | null;
      const el = t && typeof t.closest === 'function' ? t.closest<HTMLElement>('[data-ws-swipeable]') : null;
      if (!el || !scroller.contains(el)) return;
      const key = el.getAttribute('data-ws-item') || '';
      if (!handleRef.current.can(key)) return;
      drag = { id: e.pointerId, el, key, x0: e.clientX, y0: e.clientY, width: el.clientWidth, axis: null };
    };
    const onMove = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x0;
      if (!drag.axis) {
        const axis = swipeAxis(dx, e.clientY - drag.y0);
        if (!axis) return;
        // Upward or downward: the feed's own gesture. Let go of this press.
        if (axis === 'y') { drag = null; return; }
        // Sideways: claim the finger at the lock, as the kit asks of an app
        // gesture, and back off if a kit recognizer already has it. The
        // arbiter lets go by itself on pointerup and pointercancel.
        const g = gestureArbiter();
        if (g && !g.claim(e.pointerType === 'touch' ? 'touch' : e.pointerId, SWIPE_VOTE_TOKEN)) { drag = null; return; }
        drag.axis = axis;
        stopResting(drag.el);
        drag.el.setAttribute('data-ws-swiping', '');
        try { drag.el.setPointerCapture(e.pointerId); } catch { /* still tracked while over the card */ }
        // A mouse drag that began on text had started a selection.
        const sel = window.getSelection ? window.getSelection() : null;
        if (sel && !sel.isCollapsed) sel.removeAllRanges();
      }
      paint(drag.el, dx, swipeProgress(dx, drag.width), swipeSide(dx));
    };
    const onUp = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      const { el, key, width, axis } = drag;
      const dx = e.clientX - drag.x0;
      drag = null;
      if (axis !== 'x') return;
      swallow = true;
      window.setTimeout(() => { swallow = false; }, 0);
      const which = swipeVerdict(dx, width);
      if (!which) { rest(el); return; }
      held = el;
      el.removeAttribute('data-ws-swiping');
      paint(el, which === 'yes' ? commitDistance(width) : -commitDistance(width), 1, which);
      let done = false;
      handleRef.current.commit(key, which, () => {
        if (done) return;
        done = true;
        if (held === el) held = null;
        rest(el);
      });
    };
    const onCancel = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      const { el, axis } = drag;
      drag = null;
      if (axis === 'x') rest(el);
    };
    const onClick = (e: MouseEvent) => {
      if (!swallow) return;
      swallow = false;
      e.preventDefault();
      e.stopPropagation();
    };
    // A mouse drag that began on the title's link or the picture would
    // otherwise start the browser's own drag and cancel this one.
    const onDragStart = (e: DragEvent) => { if (drag) e.preventDefault(); };

    scroller.addEventListener('pointerdown', onDown);
    scroller.addEventListener('pointermove', onMove);
    scroller.addEventListener('pointerup', onUp);
    scroller.addEventListener('pointercancel', onCancel);
    scroller.addEventListener('click', onClick, true);
    scroller.addEventListener('dragstart', onDragStart);
    return () => {
      scroller.removeEventListener('pointerdown', onDown);
      scroller.removeEventListener('pointermove', onMove);
      scroller.removeEventListener('pointerup', onUp);
      scroller.removeEventListener('pointercancel', onCancel);
      scroller.removeEventListener('click', onClick, true);
      scroller.removeEventListener('dragstart', onDragStart);
      stopResting(null);
      scroller.querySelectorAll<HTMLElement>('[data-ws-swipe], [data-ws-swiping]').forEach(clear);
      drag = null;
      held = null;
    };
  }, [enabled, scrollRef, handleRef]);
}

/* ── The feed ────────────────────────────────────────────────────────── */

/**
 * A project's Needs you, and the Communities screen's (#3488): ONE feed, so
 * the two cannot drift apart again. There the rows mix every project's, each
 * carrying its own (`row.app`), and every address the feed builds (the card's
 * page, the ask box, the thread) is that row's project rather than `slug`.
 * `renderApp` draws the project over a row's by-line. The end card's main
 * button is `doneLabel` (else "See what's live") and calls `onDone`; `onHub`,
 * where there is one, is its way back to the project's Hub.
 */
export function NeedsFeed({ rows, models, slug, canPost, onDone, onHub, onSuggest, doneLabel, renderApp, openOn = null, onAnswered }: {
  rows: DevWorkshopView['queue'];
  models: DevWorkshopView['models'];
  slug: string;
  canPost: boolean;
  onDone: () => void;
  onHub?: () => void;
  /** #4680: the end card's link to the Suggest an improvement form. A
   * project's feed passes it; the Communities screen's does not, where it
   * would not be clear which project the suggestion is for. */
  onSuggest?: () => void;
  doneLabel?: string;
  renderApp?: (row: QueueRow) => ReactNode;
  /**
   * The row to open on, by key, once: the Workshop's New for you opens a
   * vote here, landed on (`vote:<card key>`). Read at mount.
   */
  openOn?: string | null;
  /**
   * #4794: the Communities screen's hook on a vote this feed has SAVED —
   * called once, inside the `ok === true` branch, never on a cancel, a
   * refusal or a network failure. A project's own feed passes nothing: its
   * refresh already drops the row from its own store.
   */
  onAnswered?: (row: QueueRow, which: 'yes' | 'no') => void;
}): ReactNode {
  const t = useMessages('project');
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
  // The caption grown over the picture ("more"), for the item in view. It
  // folds back when the reader moves on.
  const [captionOpen, setCaptionOpen] = useState(false);
  // Whether the on-screen keyboard is up. The kit measures it and app.css
  // lifts the sheet's floor by `--un-kb-inset` on its own; this is only the
  // flag `[data-ws-kb]` needs to give the card the short sheet's full height.
  const [kbUp, setKbUp] = useState(false);
  // Answered here, this session: the pinned row's confirmation, and the end
  // card's "What your votes did".
  const [answered, setAnswered] = useState<Record<string, string>>({});
  // QA 2026-09-24 Q3: votes on their way, by row. Set when castVote commits
  // to sending (the line is in hand), cleared when the server answers. The
  // ref is the re-entry guard, read synchronously by a second press; the
  // state is what the rail button draws from.
  const [sending, setSending] = useState<Record<string, string>>({});
  const sendingRef = useRef<Set<string>>(new Set());
  // #3613: the vote sheet's own form — the card's VotePicker, inline: the
  // Yes/No switch, the line for the group and the send button, so the line
  // is written on the sheet rather than in a prompt card castVote raises
  // after the press.
  const [voteSide, setVoteSide] = useState<'yes' | 'no'>('yes');
  const [voteLine, setVoteLine] = useState('');
  const voteBoxRef = useRef<HTMLTextAreaElement>(null);
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
  // Still owed the `?shot=needs-approve` open (the effect below): true until
  // a row that approves has landed and the scroller has a height.
  const approveOpenRef = useRef<'approve' | 'diagram' | 'touches' | null>(endOnOpen ? null : shotTarget());
  // Still owed the open on `openOn`'s row (the effect below).
  const landRef = useRef<string | null>(endOnOpen ? null : openOn);
  // Still owed the resume open (#4753, the effect below): true only when no
  // other open is owed — the route asked for neither the end card
  // (`endOnOpen`), a shot target nor a New for you row (`openOn`).
  const resumeRef = useRef<boolean>(!endOnOpen && !approveOpenRef.current && !openOn);
  const moreRef = useRef<HTMLButtonElement>(null);
  const voteRef = useRef<HTMLButtonElement>(null);
  const commentsRef = useRef<HTMLDivElement>(null);
  const wide = useMediaFlag(WIDE_QUERY);
  // On a wide window the vote is a popover on its button, and the rail's
  // buttons sit at its foot: where the button is in the rail, measured
  // before the popover paints (app.css `--ws-vote-top`).
  const [voteTop, setVoteTop] = useState(0);

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
  // What the pass went past: still in the feed, unanswered.
  const left = items.filter((r) => !answered[r.key]).length;
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

  /**
   * The `?shot=needs-approve` open: once the first row that approves has
   * landed, land on it (instantly, as above) and put its vote sheet up.
   * Once; after that the re-sync follows the row by key.
   */
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const target = approveOpenRef.current;
    if (!target || !el || !el.clientHeight) return;
    const idx = items.findIndex((r) => shotMatches(target, r));
    if (idx < 0) return;
    approveOpenRef.current = null;
    curKeyRef.current = items[idx].key;
    setAt(idx);
    el.style.scrollBehavior = 'auto';
    el.scrollTop = idx * el.clientHeight;
    el.style.scrollBehavior = '';
    setLeaving(null);
    // #4490: the picture targets open on the item alone, no sheet over it.
    if (target !== 'approve') return;
    setSheet('vote');
    setVoteSide('yes');
    setVoteLine('');
  }, [items]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * The Workshop's Vote on a row of New for you: land on that row, once,
   * instantly, as the `?shot=needs-approve` open above lands on its own.
   * A row that is not in the feed (answered since, or not owed after all)
   * leaves the feed where it opens.
   */
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const key = landRef.current;
    if (!key || !el || !el.clientHeight) return;
    const idx = items.findIndex((r) => r.key === key);
    if (idx < 0) return;
    landRef.current = null;
    curKeyRef.current = key;
    setAt(idx);
    el.style.scrollBehavior = 'auto';
    el.scrollTop = idx * el.clientHeight;
    el.style.scrollBehavior = '';
  }, [items]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * #4753: come back to a feed you have already been part way through, and it
   * opens on the first item you have not already passed over or answered —
   * `firstUnseenIndex`, read off the record needs-seen.ts keeps — rather than
   * on the first one. The rows it jumps past are the seen ones, still in
   * place and reachable by swiping back up. Once, on the first publish that
   * has rows and a laid-out scroller, as the opens above land; after that the
   * re-sync follows the row by key. Off when another open is owed: the end
   * card, a shot target and `openOn` land where they ask. The jump does not
   * go through `landOn`, so the rows it passes are not marked seen HERE —
   * they were already seen, which is how the index was found.
   */
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!resumeRef.current || !el || !el.clientHeight || !items.length) return;
    resumeRef.current = false;
    const idx = firstUnseenIndex(items, (r) => rowSlug(r, slug));
    if (idx <= 0) return;
    curKeyRef.current = items[idx].key;
    setAt(idx);
    el.style.scrollBehavior = 'auto';
    el.scrollTop = idx * el.clientHeight;
    el.style.scrollBehavior = '';
  }, [items]); // eslint-disable-line react-hooks/exhaustive-deps

  const landOn = (idx: number) => {
    const c = Math.min(Math.max(idx, 0), items.length);
    // #3526: A VOTE YOU MOVE ON FROM UNANSWERED IS SEEN. Only the one you
    // were on, and only going forward: a swipe back up, the end card's way
    // back and a route that opens on the end card pass nothing over. It
    // stays where it is and can still be voted on; what changes is that the
    // badges stop counting it (../../workshop/needs-seen.ts), as an unread
    // count stops counting what you have read.
    if (c > i && row && !answered[row.key] && !sendingRef.current.has(row.key)) {
      markNeedsSeen(rowSlug(row, slug), needsRowKey(row));
    }
    curKeyRef.current = items[c] ? items[c].key : (items.length ? END_KEY : null);
    setAt(c);
    // The open caption is the item's: the next one arrives folded.
    if (c !== i) setCaptionOpen(false);
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
  // The chevron beside each item's counter (#3517). Stable, like `toggleMore`
  // below, so handing it to the memo()'d items costs no render; it reads
  // this render's `go` through a ref, refreshed the way `swipeHandle` is.
  const goRef = useRef(go);
  useLayoutEffect(() => { goRef.current = go; });
  const prevItem = useCallback(() => goRef.current(-1), []);

  const closeSheet = () => {
    if (!sheet) return;
    setLeaving(sheet);
    setSheet(null);
  };
  /**
   * A rail button's press: its sheet opens, or closes when it is the one up.
   * Comments and Ask are the two tabs of ONE sheet, so pressing the other
   * one's button switches the tab and the sheet stays where it is.
   */
  const toggleSheet = (kind: SheetKind) => {
    if (sheet === kind) { closeSheet(); return; }
    setLeaving(null);
    setSheet(kind);
    // The vote form opens fresh: on Yes, with an empty line.
    if (kind === 'vote') { setVoteSide('yes'); setVoteLine(''); }
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
  //
  // `platform-kb-open` counts as well (lib/keyboard-open.ts). In the Homeroom
  // app the web view is resized to end at the keys, nothing is covered, and
  // `un-kb` never comes on, so the card kept its resting two-thirds cap and
  // the vote form ran off the page behind the keys (5 October 2026). That
  // class is the page's own "the keyboard is up", however the host made room.
  useEffect(() => {
    if (!sheet || wide || typeof document === 'undefined') return undefined;
    const docEl = document.documentElement;
    const sync = () => {
      const up = docEl.classList.contains('un-kb') || docEl.classList.contains('platform-kb-open');
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
   * Answering the item: a vote. The row is pinned BEFORE the act, because
   * the act's publish removes it from the queue, and the pin is what keeps
   * it on screen with its confirmation.
   *
   * QA 2026-09-24 Q3: THE CONFIRMATION WAITS FOR THE SERVER. The card used
   * to be marked answered here, before `castVote` had even asked for a No's
   * line, so cancelling "What's not working for you?" left "Voted no · press
   * ↓ for the next" on a card nothing had been sent for, and a reload put it
   * back. `castVote` resolves true only once the server has the vote: until
   * then the rail says it is sending, a cancel leaves the card exactly as it
   * was (and drops a pin this press added), and a refusal or a network
   * failure is reported by `castVote`'s own toast.
   *
   * `settled` is the swipe's (#3052): called once the vote is on its way or
   * was not cast, whichever comes first, so a card held at the line goes
   * back as soon as the prompt closes. The swipe only reaches a vote row
   * with both acts and none in flight (`swipeHandle` checks), which is the
   * one path below that calls it.
   *
   * `reason` is the vote sheet's line (#3613): a string is sent with the
   * vote, null sends none, and leaving it out (the swipe) lets castVote ask
   * for it the way it always has.
   */
  const answer = (which: 'yes' | 'no', settled?: () => void, reason?: string | null) => {
    if (!row) return;
    const spec = which === 'yes' ? row.yes : row.no;
    if (!spec || !spec.act) return;
    const key = row.key;
    if (sendingRef.current.has(key)) return;
    sendingRef.current.add(key);
    // PINNED FOR THE SESSION, not until the next move. The vote makes the
    // row leave `rows` (it is no longer owed), and the pin keeps it in its
    // slot, so nothing under the viewer shifts: a row leaving ABOVE the
    // one in view moves every index after it, and with it the counter,
    // and the scroll position has to be corrected under the reader. The
    // pins used to go once the next card had settled, which was exactly
    // when that correction was most visible — the card you had just
    // arrived on re-numbered and slid.
    const pinnedHere = !pinsRef.current.has(row.key);
    if (pinnedHere) {
      pinsRef.current.set(row.key, { row, index: at });
      setPinsVersion((v) => v + 1);
    }
    closeSheet();
    // castVote(sessionId, vote, expectedEpoch, opts): the model leaves the
    // epoch out when the row has none, so the slots are padded to put the
    // options bag fourth (VoteButton's VOTE_ARITY does the same).
    const args = [...(spec.act.args as unknown[])];
    while (args.length < 3) args.push(null);
    const onSend = () => {
      setSending((cur) => ({ ...cur, [key]: which }));
      if (settled) settled();
    };
    const opts = reason === undefined ? { onSend } : { onSend, reason };
    Promise.resolve(callAppView(spec.act.fn, ...args, opts))
      .catch(() => false)
      .then((ok) => {
        sendingRef.current.delete(key);
        setSending((cur) => {
          if (!(key in cur)) return cur;
          const next = { ...cur };
          delete next[key];
          return next;
        });
        if (ok === true) {
          setAnswered((cur) => ({ ...cur, [key]: which }));
          // #4794: the vote is IN. Tell the screen that owns this feed's
          // store copy, so it drops the row while the viewer is still here —
          // its bookkeeping must not be able to undo a saved vote.
          if (onAnswered) {
            try { onAnswered(row, which); } catch { /* the vote stands whatever the hook did */ }
          }
        } else if (pinnedHere) {
          pinsRef.current.delete(key);
          setPinsVersion((v) => v + 1);
        }
        if (settled) settled();
      });
  };
  /**
   * The vote sheet's send (#3613): the switch's side with the line written
   * under it. A No needs its line, as on a card; a Yes may go without one,
   * and then sends none rather than asking.
   */
  const voteTrimmed = voteLine.replace(/\s+/g, ' ').trim();
  const submitVote = () => {
    if (voteSide === 'no' && !voteTrimmed) { voteBoxRef.current?.focus(); return; }
    answer(voteSide, undefined, voteTrimmed || null);
  };
  const onVoteBoxKey = (ev: globalThis.KeyboardEvent | { key: string; shiftKey: boolean; preventDefault: () => void }) => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); submitVote(); return; }
    // The window's keys stand down inside a field, so the box closes itself.
    if (ev.key === 'Escape') { ev.preventDefault(); closeSheet(); }
  };
  // The box takes focus the moment the switch lands on No, the side that
  // needs a line — as the card's picker does. Not on opening: a keyboard
  // rising over a one-tap "Vote yes" would be in the way, and the Y and N
  // keys only work while the box is not focused.
  useLayoutEffect(() => {
    if (sheet === 'vote' && voteSide === 'no') voteBoxRef.current?.focus();
  }, [sheet, voteSide]);

  /**
   * The swipe's way in (#3052): the card in view, when it is one the viewer
   * can vote on and has not answered here, with no vote of its own already
   * on the way. A commit that finds that no longer true (the feed moved, a
   * press got there first) lets the card go rather than leaving it held.
   */
  const swipeOk = (key: string) => !!(row && row.key === key && canSwipeVote(row)
    && !answered[key] && !sendingRef.current.has(key));
  const swipeHandle = useRef<SwipeVoteHandle>({ can: () => false, commit: (_k, _w, settled) => settled() });
  useLayoutEffect(() => {
    swipeHandle.current = {
      can: swipeOk,
      commit: (key, which, settled) => {
        if (!swipeOk(key)) { settled(); return; }
        answer(which, settled);
      },
    };
  });
  useSwipeVote(scrollRef, !wide, swipeHandle);

  const preview = row ? (row.card.rail.preview || row.card.actionPreview || null) : null;
  const canTry = !!(preview && preview.state === 'live');
  const tryIt = () => {
    if (preview && preview.state === 'live') callAppView('swapToStagingForSession', preview.sessionId, preview.url);
  };
  // The caption's "more" and "less", a tap on a drawn picture, and D. Stable,
  // like openFull below, so handing it to the memo()'d items costs no render.
  const toggleMore = useCallback(() => setCaptionOpen((o) => !o), []);
  // Stable, so the memo()'d items it is handed to skip a render of the feed.
  const openFull = useCallback((el: HTMLElement) => callAppView(
    el.dataset.shots === 'true' ? 'openShotsComparison' : 'openVisualComparison',
    el,
  ), []);
  const menuKey = row ? row.card.rail.menuKey : undefined;
  // The card's own page, offered under More as "Open card": here the item IS
  // the screen, so there is no card face to tap for it (app-view.js's
  // _toggleCardMenu reads it off the trigger).
  const cardHref = row ? openHref(rowSlug(row, slug), row.card) : null;
  // What is rendered: the open sheet, or the one still leaving. Never on
  // the end card, which has no item for a sheet to be about.
  const shown = row ? (sheet || leaving) : null;
  const talk = shown === 'comments' || shown === 'ask';
  // `inert` too: a sheet on its way out takes no focus, and app.css lets taps
  // through it, so the next tap lands on what it is uncovering.
  const leavingAttr = !sheet && leaving ? { 'data-ws-leaving': '', inert: true } : {};
  const commentCount = row ? (row.card.chatCount || 0) : 0;
  const headFacts = row ? factsFor(row, voted) : [];
  useLayoutEffect(() => {
    const btn = voteRef.current;
    if (shown !== 'vote' || !wide || !btn) return;
    setVoteTop((cur) => (cur === btn.offsetTop ? cur : btn.offsetTop));
  }, [shown, wide, row ? row.key : null]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * The keys. Every one is also a button on the rail (or, for D, the
   * caption's "more"), so nothing is ONLY a key; they are listed on the wide
   * layout, where a keyboard is likely. Ignored while a field has focus —
   * typing "v" in the ask box is typing. No dependency list on purpose: the
   * handler closes over this render's state, and re-binding is cheaper than
   * a stale row.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // Only while the feed is on screen. It stays mounted under a screen
      // that is hidden (the Communities tab's, #3488, while another tab is
      // up), and a V then a Y there would cast a vote nobody could see.
      const feed = scrollRef.current;
      if (!feed || !feed.offsetParent) return;
      const k = e.key;
      if (k === 'Escape') {
        if (sheet) { closeSheet(); e.preventDefault(); } else if (captionOpen) { setCaptionOpen(false); e.preventDefault(); }
        return;
      }
      if (k === 'ArrowDown' || k === 'j' || k === 'J') { go(1); e.preventDefault(); return; }
      if (k === 'ArrowUp' || k === 'k' || k === 'K') { go(-1); e.preventDefault(); return; }
      if (!row) return;
      if (k === 'v' || k === 'V') { toggleSheet('vote'); return; }
      // On the vote sheet Y and N turn its switch, and Enter sends it: the
      // line is written on the sheet, so a key no longer votes on its own.
      if ((k === 'y' || k === 'Y') && sheet === 'vote') { setVoteSide('yes'); return; }
      if ((k === 'n' || k === 'N') && sheet === 'vote') { setVoteSide('no'); return; }
      if (k === 'Enter' && sheet === 'vote' && !(t && (t.tagName === 'BUTTON' || t.tagName === 'A'))) {
        e.preventDefault();
        submitVote();
        return;
      }
      // D grows the caption over the picture, and folds it back: "more".
      if (k === 'd' || k === 'D') { toggleMore(); return; }
      if (k === 'a' || k === 'A') { toggleSheet('ask'); return; }
      // Claimed with preventDefault: C is also the experimental Suggest an
      // improvement shortcut (#4289), which leaves a key alone once a screen
      // has used it.
      if (k === 'c' || k === 'C') { e.preventDefault(); toggleSheet('comments'); return; }
      if ((k === 't' || k === 'T') && canTry) { tryIt(); return; }
      if ((k === 'm' || k === 'M') && moreRef.current) moreRef.current.click();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // The comments tab's GitHub thread is filled by the legacy observer, so
  // it is pointed at the sheet each time the tab comes up.
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
    fetch(`/api/apps/${encodeURIComponent(rowSlug(row, slug))}/workshop/ask/thread?${qs}`, {
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
      [key]: [...prior, { who: 'you', text: q }, { who: 'ai', text: t('project:needsYou.ask.reading'), pending: true }],
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
      const res = await fetch(`/api/apps/${encodeURIComponent(rowSlug(sending, slug))}/workshop/ask`, {
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
          : t('project:needsYou.ask.failed');
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
          text = t('project:needsYou.ask.failed');
        }
      }
    } catch {
      failed = true;
      text = t('project:needsYou.ask.failedOffline');
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
      aria-label={t('project:needsYou.ask.send')}
      disabled={!draft.trim() || !target || inFlight}
      // The field keeps focus through the press (lib/keyboard-open.ts).
      onMouseDown={(event) => event.preventDefault()}
    ><ArrowUpIcon className="dev-ws-ask-send-icon" aria-hidden="true" /></button>
  );

  /**
   * Moving by a press. On a phone the swipe is the move and app.css hides
   * these; on a wide window they stand beside the rail and do what the wheel
   * does. Disabled at the ends rather than wrapping: the end card is the
   * last slot, so Next goes dark there. Written once, because the rail on
   * the end card is these alone (see below).
   */
  const moveRow = (
    <div className="dev-ws-move" data-ws-move-row="">
      <button type="button" className="dev-ws-move-btn" data-ws-move="prev" aria-label={t('project:needsYou.move.previous')} disabled={i <= 0} onClick={() => go(-1)}>
        <ChevronUpIcon className="dev-ws-move-icon" aria-hidden="true" />
      </button>
      <button type="button" className="dev-ws-move-btn" data-ws-move="next" aria-label={t('project:needsYou.move.next')} disabled={i >= n} onClick={() => go(1)}>
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
      data-ws-end={row ? undefined : ''}
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
            swipe={!wide && canSwipeVote(r) && !answered[r.key]}
            slug={slug}
            open={k === i && captionOpen}
            onFull={openFull}
            onMore={toggleMore}
            onPrev={wide ? undefined : prevItem}
            renderApp={renderApp}
          />
        ))}
        {/* ALWAYS, after the last item: the swipe past the end lands here.
            With no items it is the whole screen. */}
        <DoneItem
          rows={items}
          answered={answered}
          left={left}
          onDone={onDone}
          onHub={onHub}
          onSuggest={onSuggest}
          doneLabel={doneLabel}
          onBack={() => go(items.findIndex((r) => !answered[r.key]) - i)}
        />
      </div>

      {row ? (
        <aside className="dev-ws-rail" data-ws-rail="" aria-label={t('project:needsYou.rail.label')}>
          <button
            ref={voteRef}
            type="button"
            className={voted ? 'dev-ws-rail-btn dev-ws-rail-vote is-on' : 'dev-ws-rail-btn dev-ws-rail-vote'}
            data-ws-rail-btn="vote"
            data-ws-voted={voted || undefined}
            aria-haspopup="dialog"
            aria-expanded={sheet === 'vote'}
            disabled={!voted && !!sending[row.key]}
            onClick={() => toggleSheet('vote')}
          >
            <span className="dev-ws-rail-ic">{voted ? <CheckIcon aria-hidden="true" /> : <BallotIcon aria-hidden="true" />}</span>
            <span className="dev-ws-rail-lab">{voted ? answeredWords(row, voted, 'rail') : (sending[row.key] ? t('project:needsYou.rail.sending') : (approves(row) ? t('project:needsYou.rail.approve') : t('project:needsYou.rail.vote')))}</span>
          </button>
          {/* Comments and Ask: the two tabs of one sheet (see the header). */}
          <button
            type="button"
            className="dev-ws-rail-btn dev-ws-rail-comments"
            data-ws-rail-btn="comments"
            aria-haspopup="dialog"
            aria-expanded={sheet === 'comments'}
            aria-label={commentCount ? t('project:needsYou.rail.commentsCount', { count: commentCount }) : undefined}
            onClick={() => toggleSheet('comments')}
          >
            <span className="dev-ws-rail-ic"><ChatBubbleTailIcon aria-hidden="true" /></span>
            <span className="dev-ws-rail-lab">{commentCount ? String(commentCount) : t('project:needsYou.rail.comments')}</span>
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
            <span className="dev-ws-rail-lab">{t('project:needsYou.rail.ask')}</span>
          </button>
          <button
            type="button"
            className="dev-ws-rail-btn dev-ws-rail-try"
            data-ws-rail-btn="try"
            disabled={!canTry}
            title={preview && preview.state !== 'live' ? preview.title : undefined}
            onClick={tryIt}
          >
            <span className="dev-ws-rail-ic"><PlayIcon aria-hidden="true" /></span>
            <span className="dev-ws-rail-lab">{t('project:needsYou.rail.tryIt')}</span>
          </button>
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
            aria-label={t('project:needsYou.rail.moreActions')}
          >
            <span className="dev-ws-rail-ic"><EllipsisHorizontalIcon aria-hidden="true" /></span>
            <span className="dev-ws-rail-lab">{t('project:needsYou.rail.more')}</span>
          </button>
          {moveRow}
          {/* The vote: the question, where it stands, and the two answers. A
              sheet from the floor on a phone, a popover on this button on a
              wide window (app.css). Cancel (Decide later, on a group decision)
              closes it. */}
          {shown === 'vote' ? (
            <div className="dev-ws-sheet-modal dev-ws-sheet-vote" data-ws-sheet="vote" role="dialog" aria-label={row.ask} style={wide ? { '--ws-vote-top': `${voteTop}px` } as CSSProperties : undefined} {...leavingAttr}>
              <button type="button" className="dev-ws-scrim" aria-label={t('core:common.close')} onClick={closeSheet} />
              <div className="dev-ws-sheet-card">
                <span className="dev-ws-sheet-handle" aria-hidden="true" />
                <p className="dev-ws-ask-q">{row.ask}</p>
                <VoteSub row={row} voted={voted} />
                {/* A group decision (a rename, a secret, closing a request)
                    carries no pair here: its votes can apply it on the spot,
                    so it is decided on its own page, which shows the options
                    and what follows. Two dead buttons said nothing of that. */}
                {row.yes || row.no || !cardHref ? (
                  /* #3613: the card's own vote picker, inline — the switch,
                     the line for the group under it, Cancel and the send —
                     rather than two buttons followed by castVote's prompt
                     card. Cancel is what Decide later was. */
                  <NeedsVoteForm
                    row={row}
                    slug={slug}
                    side={voteSide}
                    line={voteLine}
                    boxRef={voteBoxRef}
                    onSide={setVoteSide}
                    onLine={setVoteLine}
                    onBoxKey={onVoteBoxKey}
                    onCancel={closeSheet}
                    onSend={submitVote}
                  />
                ) : (
                  <>
                    <div className="dev-ws-answer-row">
                      <a className="dev-ws-answer-btn dev-ws-answer-open" data-ws-answer-open="" href={cardHref}>{t('project:needsYou.voteSheet.openToDecide')}</a>
                    </div>
                    <button type="button" className="dev-ws-vote-later" onClick={closeSheet}>{t('project:needsYou.voteSheet.later')}</button>
                  </>
                )}
                <p className="dev-ws-keys-hint" aria-hidden="true">{approves(row) ? t('project:needsYou.voteSheet.keysApprove') : t('project:needsYou.voteSheet.keysVote')}</p>
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
          <aside className="dev-ws-rail dev-ws-rail-end" data-ws-rail="" aria-label={t('project:needsYou.rail.endLabel')}>
            {moveRow}
          </aside>
        ) : null
      )}

      {/* The keys, listed once, where a keyboard is likely (app.css), in the
          rail's order. Each entry is one message: its keys are the numbered
          tags, and the word after them is one text run, so the prerender
          never emits two adjacent text nodes (React #418). */}
      {row || n ? (
        <p className="dev-ws-keys" aria-hidden="true">
          {legendFor(!row).map(({ id, keys }) => (
            <span key={id} className="dev-ws-key">
              <RichMessage id={id} components={keys === 2 ? [<kbd />, <kbd />] : [<kbd />]} />
            </span>
          ))}
        </p>
      ) : null}

      {/* ── Comments and Ask: one sheet, two tabs, about the item in view ──
          A sheet on a phone, a panel beside the rail on a wide window, where
          the card's caption is repeated at its top. Both tabs stay mounted
          while it is up, so a half-written comment survives a look at Ask.
          The Comments tab holds the app's own thread (the one the unfolded
          rows use) and the legacy filler's host, pointed at it when the tab
          comes up; the Ask tab is the private Q&A with the model, whose
          composer is the dev session's own (`.dc-card`). */}
      {row && talk ? (
      <div className="dev-ws-sheet-modal dev-ws-sheet-talk" data-ws-sheet={shown} role="dialog" aria-label={t('project:needsYou.talk.dialog')} {...leavingAttr}>
      <button type="button" className="dev-ws-scrim" aria-label={t('core:common.close')} onClick={closeSheet} />
      <section className="dev-ws-sheet-card dev-ws-talk" data-ws-talk="">
        <span className="dev-ws-sheet-handle" aria-hidden="true" />
        <div className="dev-ws-talk-head" data-ws-talk-head="">
          <ItemBy row={row} />
          <h3 className="dev-ws-talk-title">{row.card.title.text || row.card.title.title}</h3>
          {row.descriptionHtml ? <Html className="dev-ws-talk-words" html={row.descriptionHtml} />
            : row.summary ? <p className="dev-ws-talk-words">{row.summary}</p> : null}
          <FactsLine facts={headFacts} />
        </div>
        <div className="dev-ws-talk-tabs">
          <div className="dev-ws-talk-tablist" role="tablist" aria-label={t('project:needsYou.talk.tabs')}>
            <button
              type="button"
              role="tab"
              className="dev-ws-talk-tab"
              data-ws-talk-tab="comments"
              aria-selected={shown === 'comments'}
              onClick={() => setSheet('comments')}
            >
              {commentCount
                ? <RichMessage id="project:needsYou.talk.commentsCount" values={{ count: commentCount }} components={[<span className="dev-ws-talk-n" />]} />
                : t('project:needsYou.talk.comments')}
            </button>
            <button
              type="button"
              role="tab"
              className="dev-ws-talk-tab"
              data-ws-talk-tab="ask"
              aria-selected={shown === 'ask'}
              onClick={() => setSheet('ask')}
            >
              <SparklesIcon className="dev-ws-talk-tab-ic" aria-hidden="true" />
              {t('project:needsYou.talk.ask')}
            </button>
          </div>
          <button type="button" className="dev-ws-sheet-x" aria-label={t('core:common.close')} onClick={closeSheet}>
            <XIcon className="dev-ws-sheet-x-ic" aria-hidden="true" />
          </button>
        </div>
        <div className="dev-ws-sheet-body" data-ws-comments="" role="tabpanel" hidden={shown !== 'comments'} ref={commentsRef}>
          {row.commentsFor != null ? <div className="dev-feed-comments" data-comments-for={row.commentsFor} /> : null}
          {row.thread ? (
            <FeedThread slug={rowSlug(row, slug)} type={row.thread.type} refId={row.thread.ref} canPost={canPost} />
          ) : null}
          {!row.thread && row.commentsFor == null ? <p className="dev-ws-ask-hint">{t('project:needsYou.comments.none')}</p> : null}
        </div>
        <div className="dev-ws-ask" data-ws-ask="" role="tabpanel" hidden={shown !== 'ask'}>
          <p className="dev-ws-ask-private">{t('project:needsYou.ask.private')}</p>
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
                {target ? t('project:needsYou.ask.hint') : t('project:needsYou.ask.noDetails')}
              </p>
            )}
          </div>
          <form
            className="dev-ws-ask-composer dc-card"
            onSubmit={(e) => { e.preventDefault(); ask(); }}
          >
            <label className="sr-only" htmlFor="dev-ws-ask-input">{t('project:needsYou.ask.fieldLabel')}</label>
            {/* THE FIELD on a line of its own; the controls row is under it. */}
            <div className="dev-ws-ask-line">
              <input
                id="dev-ws-ask-input"
                className="dev-ws-ask-input"
                type="text"
                value={draft}
                placeholder={
                  !target ? t('project:needsYou.ask.placeholderNone')
                    : inFlight ? t('project:needsYou.ask.placeholderReading')
                      : t('project:needsYou.ask.placeholder')
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
                  <label className="sr-only" htmlFor="dev-ws-ask-model-select">{t('project:needsYou.ask.model')}</label>
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
        </div>
      </section>
      </div>
      ) : null}
    </div>
  );
}

/**
 * A part's head in What's happening's card: What happened's week head
 * (./week-pages.tsx ThisWeek), the part's name in This week's weight and its
 * count beside it, muted, or in the accent when the count asks for the
 * viewer (`ask`), as This week's "5 new" does.
 */
function PartHead({ title, count, ask = false }: { title: string; count: string | null; ask?: boolean }): ReactNode {
  return (
    <div className="dev-ws-hweek-head">
      <span className="dev-ws-week-head">
        <b>{title}</b>
        {count ? <span className={ask ? 'dev-ws-week-fresh' : undefined}>{count}</span> : null}
      </span>
    </div>
  );
}

/** The viewer's own work in What happened's one-line rows, ending with where each stands. */
function MineLines({ rows, slug, openKey, onOpen }: {
  rows: WorkCardRow[];
  slug: string;
  openKey: string | null;
  onOpen: (event: ReactMouseEvent<HTMLAnchorElement>, ref: TopicRef) => void;
}): ReactNode {
  return (
    <ul className="dev-ws-hlist">
      {rows.map((r) => {
        const ref = topicRef(r.card);
        return (
          <HappenedRow
            key={r.key}
            row={r}
            fresh={!!r.fresh}
            slug={slug}
            on={!!openKey && !!ref && openKey === `${ref.kind}:${ref.id}`}
            onOpen={onOpen}
            standing
          />
        );
      })}
    </ul>
  );
}

/**
 * #4772: one part of the viewer's own work in What's happening's card
 * (Waiting on you, Yours, up for a vote, Going live): its head over its
 * rows, its first WORKSHOP_WORK_FIRST and the rest behind Show N more.
 * Waiting on you and Going live are one line a row (MineLines); Yours, up
 * for a vote keeps the shared two-line work row (./work-row.tsx, variant
 * `line`), whose first line ends with the vote's pill and Vote. The caller
 * leaves out a part with no rows.
 */
function MineSection({ section, title, count, ask = false, rows, slug, openKey, onOpen }: {
  section: 'waiting' | 'vote' | 'live';
  title: string;
  count: string;
  ask?: boolean;
  rows: WorkCardRow[];
  slug: string;
  openKey: string | null;
  onOpen: (event: ReactMouseEvent<HTMLAnchorElement>, ref: TopicRef) => void;
}): ReactNode {
  const t = useMessages('project');
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, WORKSHOP_WORK_FIRST);
  return (
    <div className="dev-ws-hpart" data-ws-mine-section={section}>
      <PartHead title={title} count={count} ask={ask} />
      <div className="dev-ws-lane" data-ws-lane={`mine-${section}`}>
        {section === 'vote' ? (
          <WorkList rows={shown} slug={slug} openKey={openKey} onOpen={onOpen} variant="line" />
        ) : (
          <MineLines rows={shown} slug={slug} openKey={openKey} onOpen={onOpen} />
        )}
        {rows.length > WORKSHOP_WORK_FIRST ? (
          <button
            type="button"
            className="dev-ws-reveal touch-target-32"
            data-ws-mine-section-more={section}
            aria-expanded={all}
            onClick={() => setAll(!all)}
          >
            <ChevronDownIcon className="dev-ws-reveal-chev" aria-hidden="true" />
            {all ? t('project:workshop.mine.showLess') : t('project:workshop.mine.showMore', { count: rows.length - WORKSHOP_WORK_FIRST })}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The grouping strip — "By category" / "By stage".
 *
 * THE PANE HEAD'S FIRST ROW, at every width (#852). From 768px up it used to
 * hang off the pane's top-right corner as an "ear", level with the tab pill;
 * the tabs moved into the header, so there is no pill to sit beside and the
 * strip leads the head everywhere, as it always did on a phone. Written once:
 * `[data-ws-group]` is what the declared checks and `querySelector` reach for.
 */
function GroupStrip({ group }: { group: string }): ReactNode {
  const t = useMessages('project');
  return (
    <div className="dev-ws-group" role="tablist" aria-label={t('project:allItems.group.label')}>
      <button
        type="button"
        role="tab"
        className="dev-ws-group-tab"
        data-ws-group="category"
        aria-selected={group === 'category'}
        onClick={() => callAppView('_setWorkshopGroup', 'category')}
      >
        {t('project:allItems.group.category')}
      </button>
      <button
        type="button"
        role="tab"
        className="dev-ws-group-tab"
        data-ws-group="stage"
        aria-selected={group === 'stage'}
        onClick={() => callAppView('_setWorkshopGroup', 'stage')}
      >
        {t('project:allItems.group.stage')}
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
 * #4457: where a Workshop row opens its page in a panel beside the list
 * rather than as the page: room for the list and a 560px panel beside it.
 * #4417: the chrome beside the page is the 76px strip and the 264px places
 * column now, 116px more than the 224px rail. So under 1296px the column
 * steps aside while the panel is open (`placeStore.side`,
 * ../../nav/section-column.tsx) and the list keeps its room.
 */
const SIDE_QUERY = '(min-width: 1180px)';
/**
 * #4417: from here the project's places are the section column beside the
 * strip (../../nav/section-column.tsx); under it, the tray behind the bar.
 */
export const PLACES_COLUMN_QUERY = '(min-width: 768px)';

/** `matchMedia` where there is one — the vm the tests render in has none. */
function matchesQuery(query: string): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(query).matches
    : false;
}

/**
 * Is this the wide layout?
 *
 * READ AT MOUNT, not in an effect. Nothing here is prerendered: the Workshop
 * mounts client-side
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
 * Everything `useStripInsets` publishes, so the teardown cannot miss one.
 *
 * WHERE THE PANE HEAD COMES TO REST, under the pinned strip, and where the
 * band behind the pinned strip reaches (QA 2026-09-24 Q7): offsets from the
 * strip's own edges to the pane's, zero on By category, where the strip and
 * the pane share the reading column, and negative on By stage, where the pane
 * goes full-bleed and the band has to cover the board columns either side.
 */
const STRIP_PROPS = ['--dev-ws-head-top', '--dev-ws-band-left', '--dev-ws-band-right'];

/** The header's measured foot, published on the host (see `usePinnedStrip`).
 *  app.css's sticky offsets fall back from it to their token arithmetic. */
const HEAD_FOOT_PROP = '--dev-ws-head-foot';

/** The column gap between the strip and the pane below it (`.dev-ws`). */
const WS_GAP_PX = 10;

/**
 * #3726: HOW FAR THE HEADER'S FOOT IS BELOW WHATEVER SCROLLS THE PAGE.
 *
 * Every sticky offset on this page is an offset from the SCROLLPORT's own top
 * (`top:` on the band, the strip and the pane head), so the header's foot is
 * that bottom edge measured in the same frame: the bar's `bottom` less the
 * scrolling box's `top`. NEGATIVE is a real answer and the one this exists
 * for, because the two edges need not meet: in-flow chrome between the header
 * and the frame (the "View as non-admin" reminder, a strip where it is not
 * fixed) pushes the scrollport down past the bar, and a negative offset is
 * what lets the sticky band sit back up on the bar's foot instead of below it.
 *
 * Which box scrolls is asked the way `usePinnedStrip` already asks it, by the
 * live layout rather than the shell: the nearest ancestor set to scroll, which
 * in the dev frame is #dev-forum-scroll. Its RANGE is deliberately not
 * required: a short tab that cannot scroll is still framed by the same box, and
 * its top is where the band would pin the moment it did. No such box means the
 * DOCUMENT scrolls (a phone browser, lib/browser-scroll.ts, where the CSS
 * forces this scroller's own overflow open), the sticky header is measured from
 * the viewport's top, and app.css's `--platform-header-h` arithmetic is the
 * answer; this returns null and the offset falls back to that.
 */
function headerFoot(host: HTMLElement): number | null {
  if (typeof document === 'undefined') return null;
  const header = document.getElementById('platform-header');
  if (!header || !header.getBoundingClientRect().height) return null;
  for (let n: HTMLElement | null = host.parentElement; n && n !== document.body; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && n.clientHeight > 0) {
      return header.getBoundingClientRect().bottom - n.getBoundingClientRect().top;
    }
  }
  return null;
}

/**
 * The host app.css declares its offsets on (#dev-workshop), one level above the
 * React root. The measured value has to land HERE, not on `.dev-ws`: a custom
 * property inherits DOWN, and `#dev-workshop { --ws-pin-top: var(--dev-ws-head-foot) }`
 * is read on that node, so a value on its child would resolve to the fallback.
 */
function offsetHost(host: HTMLElement): HTMLElement {
  const root = host.closest('#dev-workshop');
  return root instanceof HTMLElement ? root : host;
}

/**
 * Measure the strip against the pane on All items, from 700px up, where the
 * strip is sticky and the pane head pins under it.
 *
 * THE EAR IS GONE (#852). The grouping tabs used to hang off the pane's top
 * right corner, level with the tab pill, which took four more measurements
 * (the ear's left bound, its tabs' width) and a clip on the pane's outline.
 * They are the pane head's first row now at every width, as they always were
 * on a phone, so only the two facts the pinned header still needs are
 * measured: how tall the strip is, and how far the pane reaches past it.
 *
 * NO DEPENDENCY ARRAY, deliberately: this runs after every render, because a
 * grouping switch moves the pane's edges (By stage is full-bleed) and a
 * centred column can move without changing size, which a ResizeObserver does
 * not report. The observer covers what changes between renders.
 */
function useStripInsets(
  bar: HTMLElement | null,
  hostRef: React.RefObject<HTMLDivElement | null>,
  enabled: boolean,
): void {
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const pane = host.querySelector<HTMLElement>('[data-ws-pane]');
    if (!enabled || !bar || !pane) {
      for (const k of STRIP_PROPS) host.style.removeProperty(k);
      return undefined;
    }
    const measure = () => {
      // EVERY READ, THEN EVERY WRITE, and the header's foot with them. A
      // custom property inherits, so one that changes on `.dev-ws` or on
      // #dev-workshop makes the browser re-apply the stylesheet to everything
      // under it at the next question it is asked: about 9,000 elements and
      // 75ms on the board with every card open. `usePinnedStrip` publishes
      // the foot itself, in a later effect, and asks about the strip on its
      // next line; published only there, a page's first frame paid for the
      // board three times over (these properties, then the foot, after the
      // pass that drew it). Published here as well, in the same breath as the
      // other three, it is twice, and `usePinnedStrip` finds the value it was
      // about to write already there.
      const foot = headerFoot(host);
      const n = bar.getBoundingClientRect();
      const p = pane.getBoundingClientRect();
      const cssHost = offsetHost(host);
      if (foot == null) cssHost.style.removeProperty(HEAD_FOOT_PROP);
      else cssHost.style.setProperty(HEAD_FOOT_PROP, `${Math.round(foot)}px`);
      if (!n.width || !p.width) return;
      host.style.setProperty('--dev-ws-head-top', `${Math.round(n.height) + WS_GAP_PX}px`);
      host.style.setProperty('--dev-ws-band-left', `${Math.round(p.left - n.left)}px`);
      host.style.setProperty('--dev-ws-band-right', `${Math.round(n.right - p.right)}px`);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(bar);
    ro.observe(pane);
    return () => ro.disconnect();
  });
}

/**
 * QA 2026-09-24 Q7: IS THE TAB STRIP PINNED?
 *
 * Above 700px the strip is `position: sticky` at the scroller's top, and the
 * pane head pins under it. What scrolled past them showed: the strip had no
 * z-index, so the pane (positioned, and later in the tree) painted OVER it and
 * the tabs went under the cards, and the air around the pill (the gap to the
 * ear, the 10px down to the head, the board columns either side of the column
 * on By stage) had nothing behind it. app.css now stacks the strip above the
 * cards and draws a band behind it, but only while it is pinned: at rest the
 * pill sits on the page beside the ear, and a band there would swallow the
 * ear's shape.
 *
 * Pinned means what follows the strip has started to slide up under it: the
 * tab body, or on All items the back bar above it (#3651). At rest that
 * starts one column gap below the strip, and it only comes closer once the
 * strip has stuck and the page keeps scrolling. Measured, rather than read off
 * a scrollTop, because which element scrolls depends on the shell (the dev
 * frame's own scroller, or the document on a touch browser); a capturing
 * listener on the document hears a scroll from either.
 *
 * #3651: AND WHETHER THE PANE HEAD IS. On All items the head pins too, under
 * the strip, and pinned it squares its top corners (app.css), whose curves
 * otherwise leave a notch against the strip's flat foot. That is a second
 * answer, not the first one again: the band goes up behind the strip as soon
 * as the back bar slides under it, while the head is still on its way up, a
 * rounded pane top. The head has stuck once it has left the top of its pane
 * (sticky holds it, the pane goes on), which is `data-ws-head-pinned`.
 *
 * AT EVERY WIDTH (#3651). It ran from 700px only, where the strip was the
 * one thing that pinned; a phone's band pins as well now (#3522), with the
 * head under it. The band behind the strip is the wide layout's, and app.css
 * draws it from 700px alone, so on a phone `data-ws-pinned` is read by
 * nothing and the head's corners are what this is for.
 *
 * The attributes are written straight onto the host, like useStripInsets's
 * properties: they change on scroll, and a React state for them would
 * re-render the whole Workshop, board included, on the frame the strip sticks.
 *
 * #3583: NOT PINNED WHILE THE PAGE IS NOT DRAWN. A door pressed from another
 * screen (the Communities tab, Messages) switches this page's tab while
 * #app-view is still hidden, and the effect re-measured then: a hidden page
 * has no box, every edge reads 0, and `0 < 0 + 10` said pinned. The page
 * then came into view at its top with no scroll to correct it, and its band
 * stood behind the tabs at rest. A strip with no height is not pinned (nor is
 * a head whose pane reads 0 like it); and the host is watched for size, which
 * is how the page coming back into view — a box again — is heard when no
 * scroll comes with it.
 */
function usePinnedStrip(
  bar: HTMLElement | null,
  hostRef: React.RefObject<HTMLDivElement | null>,
  tab: string,
): void {
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    if (!bar || typeof document === 'undefined') {
      host.removeAttribute('data-ws-pinned');
      host.removeAttribute('data-ws-head-pinned');
      offsetHost(host).style.removeProperty(HEAD_FOOT_PROP);
      return undefined;
    }
    let frame = 0;
    const check = () => {
      frame = 0;
      // #3726: the header's foot in the scrollport's frame, before the pinned
      // answers below, so a re-laid-out page is corrected on the same frame it
      // scrolls. Null where the document scrolls: app.css's own arithmetic is
      // the answer there, and the property is dropped so it takes over.
      const foot = headerFoot(host);
      const cssHost = offsetHost(host);
      if (foot == null) cssHost.style.removeProperty(HEAD_FOOT_PROP);
      else cssHost.style.setProperty(HEAD_FOOT_PROP, `${Math.round(foot)}px`);
      const below = bar.nextElementSibling;
      if (!below) return;
      const strip = bar.getBoundingClientRect();
      const pinned = strip.height > 0 && below.getBoundingClientRect().top < strip.bottom + WS_GAP_PX - 0.5;
      if (pinned !== host.hasAttribute('data-ws-pinned')) host.toggleAttribute('data-ws-pinned', pinned);
      const pane = host.querySelector<HTMLElement>(':scope > .dev-ws-tabbody > [data-ws-pane]');
      const head = pane && pane.querySelector<HTMLElement>(':scope > .dev-ws-pane-head');
      const headPinned = !!pane && !!head && pane.getBoundingClientRect().top < head.getBoundingClientRect().top - 0.5;
      if (headPinned !== host.hasAttribute('data-ws-head-pinned')) host.toggleAttribute('data-ws-head-pinned', headPinned);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(check);
    };
    document.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', schedule);
    const seen = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    seen?.observe(host);
    check();
    return () => {
      document.removeEventListener('scroll', schedule, { capture: true });
      window.removeEventListener('resize', schedule);
      seen?.disconnect();
      if (frame) cancelAnimationFrame(frame);
      host.removeAttribute('data-ws-pinned');
      host.removeAttribute('data-ws-head-pinned');
      offsetHost(host).style.removeProperty(HEAD_FOOT_PROP);
    };
  }, [bar, hostRef, tab]);
}

/**
 * Three facts about this page that app.css lays its HOSTS out by, written as
 * classes on those hosts: `dev-ws-has-board` and `dev-ws-on-needs` on
 * #dev-workshop, `dev-ws-has-band` on #dev-forum-scroll.
 *
 * app.css used to ask for them itself, with `#dev-workshop:has(.dev-ws-board)`,
 * `#dev-workshop:has(.dev-ws[data-ws-tab="needs"])` and `#dev-forum-scroll:not(
 * :has(.dev-ws-band))`, on rules that go on to pick what is INSIDE the host. A
 * `:has()` like that is asked again whenever a node is added anywhere under
 * the host, and its answer could move every element the rule reaches, so the
 * browser re-applied the stylesheet to the whole board after every such
 * write. With every card open that was 43 passes in one load, about 9,000
 * elements and 67ms each (October 2026). None of the three facts changes
 * unless this component says so, which is what a class is for.
 *
 * Neither host is this component's node: #dev-workshop is the mount point
 * public/js/app-view.js creates, #dev-forum-scroll the frame's scroller. So
 * the classes go on with classList, before paint, and no rendered className
 * is involved (frontend/src/lib/legacy-dom.ts says why that matters). They
 * come off when the component unmounts.
 *
 * AS EARLY AS THE COMMIT ALLOWS. Putting a class on a host is itself one pass
 * over everything under it, and a layout effect here runs AFTER the layout
 * effects of the cards this commit just mounted, whose first measurement has
 * already made the browser draw the board once. Set there, the class made it
 * draw the board again. An insertion effect runs before any layout effect of
 * the commit, so the class is in place for that first pass and costs nothing
 * of its own. The root is not attached yet on the very first mount, so the
 * layout effect stays for that case, and does nothing when the insertion
 * effect has already said the same.
 *
 * A body replaced WITHOUT unmounting this component takes #dev-workshop, and
 * its two classes, with it. The scroller outlives that, which is why the
 * pull-to-refresh reads the band again at the moment it starts
 * (app-view.js, the `topEl` it hands the kit).
 */
const HOST_HAS_BOARD = 'dev-ws-has-board';
const HOST_ON_NEEDS = 'dev-ws-on-needs';
const SCROLLER_HAS_BAND = 'dev-ws-has-band';

function syncWorkshopHosts(el: HTMLElement | null, band: boolean, board: boolean, needs: boolean): void {
  if (!el) return;
  const workshop = el.closest('#dev-workshop');
  if (workshop) {
    workshop.classList.toggle(HOST_HAS_BOARD, board);
    workshop.classList.toggle(HOST_ON_NEEDS, needs);
  }
  const scroller = el.closest('#dev-forum-scroll');
  if (scroller) scroller.classList.toggle(SCROLLER_HAS_BAND, band);
}

function useWorkshopHostState(
  hostRef: React.RefObject<HTMLDivElement | null>,
  band: boolean,
  board: boolean,
  needs: boolean,
): void {
  useInsertionEffect(() => {
    syncWorkshopHosts(hostRef.current, band, board, needs);
  }, [hostRef, band, board, needs]);
  useLayoutEffect(() => {
    syncWorkshopHosts(hostRef.current, band, board, needs);
  }, [hostRef, band, board, needs]);
  // The way out is its own effect, so a tab or a pane changing above does not
  // take the classes off and put them straight back on.
  useLayoutEffect(() => {
    const el = hostRef.current;
    const workshop = el ? el.closest('#dev-workshop') : null;
    const scroller = el ? el.closest('#dev-forum-scroll') : null;
    return () => {
      if (workshop) workshop.classList.remove(HOST_HAS_BOARD, HOST_ON_NEEDS);
      if (scroller) scroller.classList.remove(SCROLLER_HAS_BAND);
    };
  }, [hostRef]);
}

export function DevWorkshop(): ReactNode {
  const t = useMessages('project');
  const v = useStoreState(devWorkshopStore);
  // THE OPEN APP'S NAME AND ARTWORK, for the hero and the channel below. The
  // same store the header's own tile draws from, so the two cannot disagree
  // about which app this is, and no second fetch: the controller publishes
  // both `app_icon_*` columns here already.
  const app = useStoreState(improveStore);
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
  // #4457: What happened's weeks before this one — how many are out
  // ("Earlier weeks" adds more), and the week whose page is open in the
  // tab, by its Monday (sinceWeekStateKey), or null for the tab itself.
  const [weeksShown, setWeeksShown] = useState(WEEKS_FIRST);
  const [openWeek, setOpenWeek] = useState<string | null>(null);
  // New for you's rows past its first WORKSHOP_WORK_FIRST, put out in place.
  const [freshAll, setFreshAll] = useState(false);
  // The category an Overview chip opened on All items, unfolded and brought
  // into view once the page is up.
  const [focusTheme, setFocusTheme] = useState<string | null>(null);
  // #4457: the item whose page is open in the panel beside the list (wide
  // windows only; ./side-panel.tsx), as the kind and id AppView opens.
  const [sideItem, setSideItem] = useState<TopicRef | null>(null);
  const sideWide = useMediaFlag(SIDE_QUERY);
  // Whether the Workshop tab's Your work shows every row or its first
  // WORKSHOP_WORK_FIRST.
  const [mineAll, setMineAll] = useState(false);
  // Which of the three tabs is up. Seeded from the publish so a `?ws=` deep
  // link paints the right one on the FIRST frame rather than showing Current
  // status and then swapping — the same reason `openThemes` is seeded from
  // `autoExpand` rather than from an effect.
  // A CALLBACK REF, NOT `useRef`, AND THAT IS THE WHOLE BUG IT FIXES. While the
  // board is loading this component returns a skeleton, so the bar does not
  // exist: the marker's effect ran, found nothing and returned. When the data
  // landed and the bar finally rendered, a `useRef` had not changed — refs are
  // stable — so the effect never re-ran and the marker was never measured. The
  // selection was simply invisible the first time the Workshop was opened.
  //
  // State re-renders when the node arrives, which wakes the effect exactly
  // then.
  const [bar, setBar] = useState<HTMLElement | null>(null);
  // Seeded from a FRESH read of the remembered tab, not from the publish: the
  // store keeps the last view published, so a page opened again (Back, or a
  // door that has just set the hub) would otherwise open on a tab the viewer
  // has since left. The first render is the loading skeleton either way, so
  // the prerendered page is unchanged; the publish is the fallback where
  // AppView is not there to ask.
  const [tab, setTab] = useState<TabKey>(() => freshTab() || v.tab || 'status');
  // Moving between the hub and its pages, remembered the way a tab press
  // always was (AppView._setWorkshopTab), and back to the top: a page opened
  // from a door lower down should start at its own head — in the element
  // that actually scrolls it (#3583, scrollToHead).
  //
  // And the page's memory of where it was goes with it (#3583). AppView keeps
  // the feed's offset to put a reader back after an item and Back; that
  // offset was the OLD tab's, and coming back to the page later (Back from
  // another screen) laid it over the new one: the hub again, scrolled under
  // its own strip. A zero is how that memory is told the page is at its top.
  //
  // #3620: AND A PRESS IS A STEP BACK CAN UNDO. The tabs share the page's
  // address, so AppView._pushWorkshopTab pushes an entry at it naming the tab,
  // after writing the one being left onto the entry it leaves: Back from the
  // Workshop is the hub again, not the screen the project was opened from.
  // Up from All items to the Workshop (its back bar, or the Workshop tab lit
  // over it) is a step Back instead when the Workshop is the entry below
  // (AppView._upWorkshopTab), so it leaves no loop. `tabRef` is the tab up
  // now: it is read before the render this press causes, and by the listener
  // below, which outlives the render it was made in.
  const tabRef = useRef<TabKey>(tab);
  tabRef.current = tab;
  const openTab = (next: TabKey) => {
    setTab(next);
    callAppView('_setWorkshopTab', next);
    const was = tabRef.current;
    const up = was === 'all' && next === pageParent(was) && !!callAppView('_upWorkshopTab', v.slug, next);
    if (!up) callAppView('_pushWorkshopTab', v.slug, was, next);
    callAppView('_saveFeedScroll', v.slug, 0);
    scrollToHead(hostRef.current);
  };
  // #3701: THE LIT COMMUNITIES TAB ASKS THIS PAGE WHERE IT IS
  // (../../workshop/tab-ladder.ts). All items is a level below the Workshop
  // tab, so a press over it comes up to the Workshop, at its top, as a new
  // entry, the way a tab press pushes one; the page's own way up (openTab)
  // steps Back instead when the Workshop is the entry below. The host says
  // where the page scrolls, for the press that takes a tab to its top.
  const climb = () => {
    const was = tabRef.current;
    const next = pageParent(was);
    setTab(next);
    callAppView('_setWorkshopTab', next);
    callAppView('_pushWorkshopTab', v.slug, was, next);
    callAppView('_saveFeedScroll', v.slug, 0);
    scrollToHead(hostRef.current);
  };
  const climbRef = useRef(climb);
  climbRef.current = climb;
  useEffect(() => {
    if (!v.slug) return undefined;
    return registerLevel({
      slug: v.slug,
      // #4417: every place but the Hub is a step below it (a channel, Needs
      // you, the Workshop), and a page under a place (All items, the plan)
      // goes to that place first (pageParent).
      below: () => tabRef.current !== 'status',
      up: () => climbRef.current(),
      host: () => hostRef.current,
      depth: 1,
    });
  }, [v.slug]);
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
  const deepTabApplied = useRef<boolean>(!!v.tab || !!freshTab());
  useEffect(() => {
    if (deepTabApplied.current || !v.tab) return;
    deepTabApplied.current = true;
    setTab(v.tab);
  }, [v.tab]);
  // A DOOR TO THIS PROJECT'S HUB, pressed while its page is already open —
  // the logo menu's "Go to community hub" changes no address, so no route
  // runs. AppView._landOnHub says so; a door to another project is not ours.
  //
  // #3620: AND BACK OR FORWARD LANDING ON ONE OF THIS PAGE'S ENTRIES, which
  // the router announces the same way, marked `traversal`. That shows the
  // entry's tab and pushes nothing: Back and Forward are not doors, and a
  // traversal onto the tab already up leaves the page (and its scroll) alone.
  // A door pushes nothing here either: every door goes on to navigate to the
  // page's address, and that navigation is its entry.
  useEffect(() => {
    const onDoor = (event: Event) => {
      const door = (event as CustomEvent<{ slug: string | null; tab: TabKey; traversal?: boolean } | null>).detail;
      if (door && door.traversal && door.tab === tabRef.current) return;
      if (!door || (door.slug && door.slug !== v.slug)) return;
      setTab(door.tab);
      // #3583: the scroller that is really there (see scrollToHead). AppView
      // has forgotten the offset already (_landOnTab), and a door that goes
      // on to route reads this page at its top when it saves it.
      scrollToHead(hostRef.current);
    };
    window.addEventListener('usernode:workshop-tab', onDoor);
    return () => window.removeEventListener('usernode:workshop-tab', onDoor);
  }, [v.slug]);
  // ANOTHER PROJECT IN THE SAME PAGE (#3555). Going straight from one
  // project's page to another's keeps the host (#app-view keeps
  // #dev-workshop and republishes into it), so this is not mounted again,
  // and the seed above — which is how a door to ANOTHER project's tab is
  // read, since the listener leaves those alone — never ran for the new
  // one: it opened on whatever tab the last project was on. A Recents
  // channel's Discussion pressed beside one project's page, or the
  // community switcher's hub, landed on the previous project's tab. So when
  // the project changes, the tab is read afresh as a mount reads it, before
  // paint, so the old tab never shows under the new name.
  const tabSlug = useRef<string | null>(v.slug || null);
  useLayoutEffect(() => {
    if (!v.slug) return;
    const was = tabSlug.current;
    tabSlug.current = v.slug;
    if (was && was !== v.slug) setTab(freshTab() || 'status');
  }, [v.slug]);
  // Which pane is under the tabs. Lives in a module-global store rather than
  // here, because app-view.js has to read it: `_rerenderWorkshop()` publishes
  // the kanban view model only when the stage pane is up. See
  // ./group-mode-store.ts.
  const group = useWorkshopGroup();
  // From 700px the pane head pins under the strip at an offset only a
  // measurement knows (`useStripInsets`), and app.css draws a band behind
  // the strip while it is pinned (QA 2026-09-24 Q7). Whether it is pinned,
  // and whether the head is, is asked at every width (`usePinnedStrip`):
  // a phone's band and head pin too (#3522), at offsets app.css knows.
  const stripSticks = useMediaFlag(WIDE_QUERY);
  useStripInsets(bar, hostRef, stripSticks);
  usePinnedStrip(bar, hostRef, tab);
  // NO PULL HOOK HERE ANY MORE (pull-to-refresh under the tabs, evan,
  // 2026-10-01). #3514's usePullGap read the kit's transform off
  // #dev-forum-scroll and published it as `--ptr-gap` on <html>, so app.css
  // could paint the gap a pull opened between the header and the band. A pull
  // no longer moves the band or opens that gap: the kit publishes the pull
  // itself (`--dev-ptr-pull` on the scroller, public/js/app-view.js) and
  // app.css slides only what is under the band by it. Nothing in this
  // component takes part, which is how it stays the only writer of its tree.
  //
  // What it does say, here, is what app.css needs to know about this page on
  // its HOSTS, one of which is that there is a band at all (see
  // `useWorkshopHostState`). The loading skeleton below has no band, no board
  // and no tab, so none of the three holds while it is up. The board is the
  // All items page read by stage, and nothing else draws one.
  useWorkshopHostState(
    hostRef,
    !v.loading,
    !v.loading && tab === 'all' && group === 'stage',
    !v.loading && tab === 'needs',
  );
  // The toolbar's props reach this root through a store, not a prop — the
  // Workshop is a separate React root from the frame that receives them. See
  // ../actions-store.ts.
  const actions = useDevActions();

  const themes = useStableThemeOrder(v.themes, sortKey);
  const themesRef = useRef<HTMLDivElement | null>(null);
  const captureThemeTops = useThemeReorderMotion(themesRef, themes);
  // The eyebrow over the theme list: the count, then whatever the grouping
  // itself has to report. Named categories only — "Not yet grouped" is a
  // holding pen, not one of them — and counted here so the label can agree
  // with itself: it read "1 themes" before, which is the kind of thing a
  // reader trusts a screen slightly less for.
  const countOfThemes = themes.filter((theme) => !theme.ungrouped).length;
  // Each fact is a whole message; the eyebrow joins them.
  const groupingNote = factsLine([
    t('project:allItems.grouping.categories', { count: countOfThemes }),
    v.meta.source === 'category' ? t('project:allItems.grouping.byCategoryForNow') : '',
    v.meta.source === 'demo' ? t('project:allItems.grouping.demo') : '',
    v.meta.pending
      ? (v.meta.pendingStage === 'placement'
        ? t('project:allItems.grouping.placing')
        : (v.meta.source === 'ai' ? t('project:allItems.grouping.redrafting') : t('project:allItems.grouping.drafting')))
      : '',
  ]);
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

  // Clear moves the baseline to now (AppView owns the stamp and its storage,
  // and republishes): what was new is then in its week, a tap away (#2183).
  const clearSince = () => {
    if (!v.since) return;
    setFreshAll(false);
    callAppView('_workshopClearSince', slug, v.since.through);
  };

  // #4457: A ROW OPENS ITS ITEM'S PAGE. On a wide window a plain click opens
  // it in the panel beside the list (./side-panel.tsx), and a click on the
  // row already open closes it; anything else (a phone, a modified click, a
  // middle click) is the row's own link to the page's route.
  const openItem = (event: ReactMouseEvent<HTMLAnchorElement>, ref: TopicRef) => {
    const nav = (window as unknown as { NavLink?: { isNativeClick?: (e: unknown) => boolean } }).NavLink;
    if (nav?.isNativeClick?.(event)) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    if (!sideWide) return;
    event.preventDefault();
    setSideItem((cur) => (cur && cur.kind === ref.kind && cur.id === ref.id ? null : ref));
  };
  const closeSide = useCallback(() => setSideItem(null), []);
  const sideKey = sideItem ? `${sideItem.kind}:${sideItem.id}` : null;
  // The panel goes with a change of tab (it opens from the Workshop tab's
  // lists and, #4486, from All items), the project and the wide window; a
  // week's page goes with the tab and the project.
  useEffect(() => {
    setSideItem(null);
    if (tab !== 'workshop') setOpenWeek(null);
  }, [tab]);
  useEffect(() => {
    if (!sideWide) setSideItem(null);
  }, [sideWide]);
  // #4486: ON ALL ITEMS THE BOARD KEEPS ITS PLACE beside the panel. With the
  // panel open its columns are 316px and it scrolls sideways (app.css), so
  // the column the row was tapped in is brought beside the panel, by the
  // least scroll that shows it whole, and the strip over it follows.
  useLayoutEffect(() => {
    if (tab !== 'all' || !sideKey) return;
    const board = hostRef.current ? hostRef.current.querySelector<HTMLElement>('#dev-kanban') : null;
    const row = board ? board.querySelector<HTMLElement>(`[data-ws-open="${sideKey}"]`) : null;
    const col = row ? row.closest<HTMLElement>('.dev-kanban-col') : null;
    if (!board || !col) return;
    const b = board.getBoundingClientRect();
    const c = col.getBoundingClientRect();
    if (c.right > b.right) board.scrollLeft += Math.ceil(c.right - b.right);
    else if (c.left < b.left) board.scrollLeft -= Math.ceil(b.left - c.left);
    syncStrip(board);
  }, [tab, sideKey, group]);
  useEffect(() => {
    setSideItem(null);
    setOpenWeek(null);
    setWeeksShown(WEEKS_FIRST);
    setFreshAll(false);
  }, [v.slug]);
  // An Overview chip's category, once All items has drawn it: into view,
  // the way the page brings an item's row beside the side panel above.
  useLayoutEffect(() => {
    if (tab !== 'all' || !focusTheme) return;
    const card = hostRef.current
      ? hostRef.current.querySelector<HTMLElement>(`[data-ws-theme="${CSS.escape(focusTheme)}"]`)
      : null;
    setFocusTheme(null);
    if (card && typeof card.scrollIntoView === 'function') card.scrollIntoView({ block: 'start' });
  }, [tab, focusTheme]);

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
  // A week's presses are part of it (#3524): each one mounts rows the
  // fillers have not seen, so the count, not only which weeks, goes in.
  const openSig = `${Object.values(openRows).join('|')}|work:${mineAll}:${freshAll}`;
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    callAppView('_wireFeedComments', host);
    callAppView('_fillKudosHosts', host);
  }, [openSig, v]);

  // The project's community record — the hero, the hub's cards and the hub
  // tab's own label all read it. Before the loading return: it is a hook.
  const community = useCommunity(v.slug || '');
  // The improve store is the header's own record of the app, read only once
  // it is about this project, not the one the page was last pointed at.
  // THE COMMUNITY'S COLOUR is the header's (../../header/community-tint.ts):
  // it sets `--community-tint` on the root, and the band and Open app wear
  // that property, so the page works nothing out a second time.
  const own = !!v.slug && app.slug === v.slug;
  // The votes waiting on you: the band's Needs you count, the hub's row,
  // and the Communities tab's badge and switcher (features/workshop/
  // community-scope.ts), which learn it from here while the page is up.
  //
  // #3526: LESS THE ONES YOU HAVE SWIPED PAST. `owed` is the band's number,
  // so it counts only the votes not yet seen (../../workshop/needs-seen.ts,
  // which this re-renders on). The scope is handed every vote and which ones
  // rather than this page's answer, and works the same number out itself, so
  // the tab's badge and the band cannot disagree about a vote seen elsewhere.
  useNeedsSeen();
  const owedRows = (v.queue || []).filter((row) => row.kind === 'vote');
  const owedKeys = owedRows.map(needsRowKey).filter((k): k is string => !!k);
  const owed = unseenNeeds(v.slug || '', owedRows.length, owedKeys);
  const owedSig = owedKeys.join(' ');
  useEffect(() => {
    if (!v.slug || v.loading) return;
    describeCommunity(v.slug, {
      owedCount: owedRows.length,
      owed: owedKeys,
      ...(own && app.name ? { name: app.name, iconUrl: app.iconUrl, iconEmoji: app.iconEmoji, iconColor: app.iconColor } : {}),
      ...(community ? { audience: community.audience, memberCount: Number(community.member_count) || 0 } : {}),
    });
  }, [v.slug, v.loading, owedRows.length, owedSig, own, app.name, app.iconUrl, app.iconEmoji, app.iconColor, community]); // eslint-disable-line react-hooks/exhaustive-deps

  // #4417: THE PLACES TRAY (./places-tray.tsx), the list behind the place
  // bar's button, and a swipe from the left edge on a phone. It shuts when
  // the place or the project changes under it (a door, Back), and a press on
  // a place in it shuts it as a navigating close, so the Back claim it took
  // cannot undo the entry the press pushes.
  const [trayOpen, setTrayOpen] = useState(false);
  const trayNav = useRef(false);
  const placesBtn = useRef<HTMLButtonElement | null>(null);
  const trayId = useId();
  const placesInColumn = useMediaFlag(PLACES_COLUMN_QUERY);
  useEffect(() => { setTrayOpen(false); }, [tab, v.slug, placesInColumn]);
  useEdgeSwipe(!placesInColumn && !trayOpen && !!v.slug && !v.loading, () => {
    trayNav.current = false;
    setTrayOpen(true);
  });
  // THE PLACE ON SHOW, for what draws or moves it from outside this page
  // (./place-store.ts): the section column's list, a merged topic's card.
  const openTabRef = useRef(openTab);
  openTabRef.current = openTab;
  useEffect(() => {
    if (!v.slug) return undefined;
    const mine = v.slug;
    const undo = registerPlaceOpener(mine, (key) => {
      if (key === tabRef.current) scrollToHead(hostRef.current);
      else openTabRef.current(key);
    });
    return () => { undo(); clearPlace(mine); };
  }, [v.slug]);
  // What waits elsewhere: the channel on screen is being read. Computed ahead
  // of the publish below so the merged header's button carries it too (#4703).
  const here = isChannelPlace(tab) ? findChannel(community?.places, placeHandle(tab)) : null;
  const unreadElsewhere = Math.max(0, unreadTotal(community?.places)
    - (here && here.state === 'live' ? Math.max(0, Number(here.unread) || 0) : 0));
  useEffect(() => {
    if (v.slug && !v.loading) publishPlace(v.slug, tab, owed, unreadElsewhere, trayOpen);
  }, [v.slug, v.loading, tab, owed, unreadElsewhere, trayOpen]);
  // #4703: the merged header's places button (place-bar.tsx HeaderPlace)
  // presses the same toggle the bar's button does, published here so the
  // header need not own the tray.
  const trayToggleRef = useRef(() => {});
  trayToggleRef.current = () => { trayNav.current = false; setTrayOpen((open) => !open); };
  useEffect(() => {
    if (!v.slug) return undefined;
    const mine = v.slug;
    const undo = registerTrayToggle(mine, () => trayToggleRef.current());
    return () => { undo(); };
  }, [v.slug]);
  const sideOpen = !!sideItem && (tab === 'workshop' || tab === 'all');
  useEffect(() => {
    if (v.slug) publishSide(v.slug, sideOpen);
  }, [v.slug, sideOpen]);

  if (v.loading) return <div ref={hostRef}><CardSkeleton n={4} label={t('project:page.loading')} /></div>;
  const nextUp = v.nextUp && v.nextUp.t === 'card' ? v.nextUp : null;
  const slug = v.slug || '';
  const canPost = !!v.canPost;
  // #2573's start-here banner: nothing open and nothing ever shipped. (All
  // items' search no longer narrows the count, so it is not a condition:
  // #2915.) Named once because the empty note under it reads it too — see
  // EmptyNote.
  //
  // NOT WHILE HOMEROOM BOT BUILDS ITS FIRST VERSION (the hub's First version
  // card). Before its description is filed as a request the board is empty
  // too, and "The first change is yours to start" told its maker to start
  // the change the bot was already making. The same goes for the hub's
  // no-items note below.
  const building = !!(community && community.first_version);
  const startHere = !!(v.dashboard && v.dashboard.open === 0 && !v.dashboard.everShipped) && !building;
  // A project nobody else is in (hubAlone): its hub leaves out the zeros a
  // group's hub says (./hub-cards.tsx NothingToVote, hubWorkEmpty).
  const alone = hubAlone(community);
  // #4045, decision D: a project's FIRST WEEK (made under seven days ago,
  // never Homeroom's own), when its hub leaves out what is still empty: the
  // vote line, an empty Your work, and on the hero the audience line
  // (./community-card.tsx). The Discussion row stays, and asks for the first
  // word while it is empty (./hub-cards.tsx ForYouCard).
  const weekOne = !!(community && community.first_week);
  const workEmpty = hubWorkEmpty({
    alone, building, startHere, readOnly: !!actions.readOnly, bot: !!(v.mine && v.mine.bot), firstWeek: weekOne,
  });

  /* ── The place bar, the tray behind it, and on All items its back bar ──
     #4417: the four tabs are gone; the project's places are one list (Hub,
     Needs you, Workshop, then its channels: ./project-places.tsx). On a
     phone it is a tray behind the place bar's button, the bar naming where
     you are (./place-bar.tsx); on a wide window it is the section column
     beside the strip (../../nav/section-column.tsx) and the bar is the
     page's title row. Under the bar, All items leads with its way back to
     the Workshop it is a page of.

     THE BAR IS THE BAND'S BOX, ON EVERY PAGE (#3651). It is what pins, and
     what the pinned pane head and its band are measured against (`setBar`).
     The back bar scrolls away under it. */
  const projectName = app.name || community?.name || slug;
  const choosePlace = (key: TabKey) => {
    trayNav.current = true;
    setTrayOpen(false);
    if (key === tabRef.current) scrollToHead(hostRef.current);
    else openTab(key);
  };
  const band = (
    <PlaceBar
      name={projectName}
      place={tab}
      owed={owed}
      unread={unreadElsewhere}
      open={trayOpen}
      trayId={trayId}
      onToggle={() => { trayNav.current = false; setTrayOpen((open) => !open); }}
      barRef={setBar}
      buttonRef={placesBtn}
    />
  );
  const tray = trayOpen ? (
    <PlacesTray
      id={trayId}
      label={t('project:places.tray.name', { project: projectName })}
      onClose={() => { trayNav.current = false; setTrayOpen(false); }}
      // #4703: focus returns to the button that opened the tray — the merged
      // header's on a phone, the bar's own on a wide window — whichever is
      // connected and visible (the band's button is display:none under 768px,
      // so its offsetParent is null there).
      returnTo={() => {
        const header = trayButton();
        if (header && header.isConnected && header.offsetParent) return header;
        const bar = placesBtn.current;
        return bar && bar.isConnected && bar.offsetParent ? bar : null;
      }}
      navigating={() => trayNav.current}
    >
      <ProjectPlaces
        slug={slug}
        name={projectName}
        place={tab}
        owed={owed}
        places={community?.places}
        // #2915: not while All items is up, where the search box says so.
        filtered={!!v.meta.filtered && tab !== 'all'}
        onPlace={choosePlace}
        onSwitch={(el) => {
          trayNav.current = true;
          setTrayOpen(false);
          openSwitcher('header', el);
        }}
      />
    </PlacesTray>
  ) : null;

  // What happened: the since list, filed by week (sinceWeeks), this week
  // first. A first visit has no baseline and so nothing new, but the weeks
  // and their figures are still the history, so they are drawn without the
  // card's own controls.
  // #4772: the viewer's own work, by section (AppView._workshopView files
  // each row's `group`): what waits on them, then their work in flight, then
  // theirs up for a vote, then what is going live. `extra` is what Homeroom
  // bot waits on them for on items that are not otherwise theirs.
  const mineCards = (v.mine ? v.mine.rows : []).filter((r): r is WorkCardRow => r.t === 'card');
  const mineIn = (group: NonNullable<WorkCardRow['group']>) => mineCards.filter((r) => (r.group || 'work') === group);
  const waitingRows = [...mineIn('waiting'), ...((v.mine && v.mine.extra) || []).filter((r): r is WorkCardRow => r.t === 'card')];
  const workRows = mineIn('work');
  const voteRows = mineIn('vote');
  const liveRows = mineIn('live');
  const anyMine = waitingRows.length + workRows.length + voteRows.length + liveRows.length > 0;
  // Your work stays when the viewer has nothing anywhere (#2182: it says so);
  // with something in another section, an empty Your work is left out.
  const showWork = !!v.mine && (workRows.length > 0 || (!anyMine && !!v.mine.viewer));
  // A merged change of the viewer's still going live is Going live's until
  // it is live, and then What happened's news like anyone's: while it is
  // here, What happened and its weeks leave it out, so it is listed once.
  const rowKey = (r: WorkCardRow): string => {
    const ref = topicRef(r.card);
    return ref ? `${ref.kind}:${ref.id}` : r.key;
  };
  const goingLiveKeys = new Set(liveRows.map(rowKey));
  const notGoingLive = (r: { t: string }): boolean => r.t !== 'card' || !goingLiveKeys.has(rowKey(r as WorkCardRow));
  const sinceAll = v.since || EMPTY_SINCE;
  const sinceList = goingLiveKeys.size ? { ...sinceAll, rows: sinceAll.rows.filter(notGoingLive) } : sinceAll;
  const weeks = tab === 'workshop' ? sinceWeeks(sinceList, v.dashboard ? v.dashboard.weeks : null, Date.now()) : [];
  const thisWeek = weeks.length && weeks[0].live ? weeks[0] : null;
  const pastWeeks = thisWeek ? weeks.slice(1) : weeks;
  const firstWeek = v.dashboard ? v.dashboard.firstWeek : null;
  // #4457: the week whose page is open, while it is still in the list.
  const weekUp = openWeek ? weeks.find((w) => sinceWeekStateKey(w) === openWeek) || null : null;
  // Own ongoing work is already in What's happening. Once it merges, its
  // outcome belongs in catch-up too: it no longer appears in that ongoing
  // list. #4538: so is a bot change built from the viewer's request — What's
  // happening has it while it is in flight, and the bot remains its maker
  // either way. (week-pages.tsx `catchUp`, which files the dots and "N new"
  // the same way.) #4772: `sinceList` has already left out what is going
  // live, which is Going live's until it is live.
  const sinceRows = (v.since ? sinceList.rows : [])
    .filter((r): r is WorkCardRow => r.t === 'card' && !!r.brief && catchUp(r.brief));
  // NEW FOR YOU: of what moved since your last visit, the requests filed
  // since, newest first. Your own are Your work's. A vote waiting on yours is
  // Needs you's (#4716): it was here too, a second Vote for the same vote,
  // whose press only opened Needs you on it.
  const freshRows = sinceRows.filter((r) => !!r.brief && !r.brief.mine && !r.brief.requested
    && r.brief.kind === 'request' && !!r.fresh);
  const openWeekPage = (key: string) => {
    setOpenWeek(key);
    // A week further back than the since-list's capped rows draws nothing on
    // its own: opening one asks AppView to page the merged history back to
    // the week (openWorkshopWeek) and publish the week's rows as they land
    // (#4717). The key finds the week whose range is fetched.
    const week = weeks.find((w) => sinceWeekStateKey(w) === key);
    if (week) callAppView('openWorkshopWeek', week.startMs, week.endMs);
    scrollToHead(hostRef.current);
  };
  const closeWeekPage = () => {
    setOpenWeek(null);
    callAppView('closeWorkshopWeek');
    scrollToHead(hostRef.current);
  };
  // New for you's rows: lit while their page is open beside the list, as
  // WorkList lights its own.
  const rowOn = (r: WorkCardRow): boolean => {
    const ref = topicRef(r.card);
    return !!sideKey && !!ref && sideKey === `${ref.kind}:${ref.id}`;
  };
  // New for you's: Build it, the request card's own act when that act is
  // building it (asking Homeroom bot, or yourself).
  const freshAct = (r: WorkCardRow): ReactNode => {
    const a = primaryAct(r.card);
    if (a && a.act && (a.act.fn === 'askBotToBuild' || a.act.fn === 'chooseIssueWork')) {
      return <ActButton a={a} label={t('project:workshop.fresh.buildIt')} />;
    }
    return null;
  };
  // An Overview chip for a category that is not a topic: its card on All
  // items, unfolded, read By category.
  const openTheme = (id: string) => {
    callAppView('_setWorkshopGroup', 'category');
    setOpenThemes((cur) => ({ ...(cur || {}), [id]: true }));
    setFocusTheme(id);
    openTab('all');
  };

  return (
    <div
      ref={hostRef}
      className="dev-ws"
      data-ws-tab={tab}
      // #3583: whose page this is, beside which tab it is on. AppView reads
      // both when it saves the list's offset on the way out (renderDevView),
      // because by then App.currentApp already names the page coming in.
      data-ws-slug={slug || undefined}
      // #4457: an item's page is open in the panel beside the list, and the
      // list makes room for it (app.css). An attribute, not a class: the
      // host's classes are written by useWorkshopHostState.
      data-ws-side-open={sideItem && (tab === 'workshop' || tab === 'all') ? '' : undefined}
    >
      {band}
      {tray}
      {/* Everything but the bar lives in here. It is what carries the
          clearance under the last card: a sticky bar overlays whatever is
          beneath it while you scroll, so the content needs a bar's worth of
          empty space at its end or the final card can never be read clear of
          it. Above 700px the bar is not sticky and overlays nothing, so
          app.css takes the clearance back off. */}
      <div className="dev-ws-tabbody">
      {tab === 'status' ? (
      <>
      {/* ── The hero: what it is, who it is for, who is around ──
          FIRST ON THE PAGE, under the band: the tile and the name over
          "Public community · 266 members", the description, this week's
          faces, "40 active this week" and their names, and one row of
          actions (Open app in the community's colour, Invite, the ⋯) with
          Join at its far end; on a wide window the actions sit across from
          the name. See ./community-card.tsx.

          THE ⋯ IS THE HERO'S. It is ONE node (`DevPlusMenu`,
          ../actions-row.tsx) rendered here and nowhere else on this surface,
          which is what keeps `#dev-plus-btn` / `#dev-plus-menu` unique for
          `_wirePlusMenu`; it wires itself on mount, so arriving after the
          hero's read is no problem. */}
      {slug ? (
        <CommunityCard
          slug={slug}
          name={app.name || undefined}
          iconUrl={own ? app.iconUrl : null}
          iconEmoji={own ? app.iconEmoji : null}
          canOpenApp={!actions.selfHosted}
          // #3700: Join through the invite link this page was opened from
          // opens Needs you at its first card when votes are already
          // waiting on the new member, and otherwise stays on this hub.
          onJoinedByInvite={() => { if (owesVote(v.queue)) openTab('needs'); }}
          menu={(
            <DevPlusMenu
              illustrationApp={actions.illustrationApp}
              canManageIllustration={actions.canManageIllustration}
              selfHosted={actions.selfHosted}
              readOnly={actions.readOnly}
              canCollaborate={actions.canCollaborate}
              showsMembers={actions.showsMembers}
              inHero
              // #4666: who can see it and how its changes are approved, one
              // row and one sheet (features/dialogs/who-decides.tsx), for
              // whoever may propose it. It took "Make it public" and "Make it
              // private" in; Leave stays the ⋯'s, so the hero's row is what
              // you do with people: Invite.
              onWhoDecides={community?.can_manage
                ? () => { window.UsernodeReact?.dialogs?.whoDecides?.open({ slug }); }
                : null}
              onLeave={canLeave(community) ? () => { void leaveCommunity(slug); } : null}
              appName={community?.name || app.name || slug}
            />
          )}
        />
      ) : null}
      {/* ── First version: where Homeroom bot's build stands ──
          Under the hero while the bot builds the project from its
          description, so a new project's hub says what it is becoming and
          how far along it is, and opens the bot's chat when the bot waits on
          its maker. See ./hub-cards.tsx FirstVersionCard. */}
      {slug ? (
        <FirstVersionCard slug={slug} data={community} emoji={app.iconEmoji || null} onSeePlan={() => openTab('plan')} />
      ) : null}
      {/* #2573: ABOVE the empty note, because the two answer different
          questions on the same screen. The note says what the board holds;
          this says what to do about an app nobody has started on, and the
          product decision put it at the top of the page. See
          StartHereBanner for the three conditions. */}
      {startHere ? <StartHereBanner slug={slug} name={projectName} bot={!!(v.mine && v.mine.bot)} /> : null}
      {v.emptyNote && !building ? (
        <EmptyNote
          filtered={!!v.emptyNote.filtered}
          loadFailed={v.emptyNote.loadFailed}
          underStartHere={startHere}
          onHub
        />
      ) : null}

      {/* ── The hub, top to bottom: for you, then what went live ──
          One column at every width, each part under its small-caps label.
          FOR YOU is one card of doors: Needs you (the first vote you owe, a
          quiet line when none is, #3408), Your work (the first of yours and
          how many) and the Discussion (its last line), each opening its
          place. RECENTLY LIVE is the last three changes that went live, as
          pictures, and its door is the Workshop, where what landed since
          your last visit, your work in full and "live this week" are. No
          numbers or charts about how the project performs: who is around
          is the hero's faces and names. A project that is just yours keeps
          its Share it card, which is how it grows. On a project nobody else
          is in, the zeros are left out (`alone`, `workEmpty`). See
          ./hub-cards.tsx. */}
      {slug ? (
        <ForYouCard
          slug={slug}
          name={app.name || community?.name || slug}
          queue={v.queue}
          unclaimed={v.dashboard ? v.dashboard.unclaimed : 0}
          mine={v.mine}
          workEmpty={workEmpty}
          alone={alone || weekOne}
          data={community}
          canPost={canPost}
          onNeeds={() => openTab('needs')}
          onWork={() => openTab('workshop')}
          onDiscussion={() => openTab('discussion')}
        />
      ) : null}
      {slug ? <ShareItCard slug={slug} name={app.name || undefined} /> : null}
      {slug ? <RecentlyLive slug={slug} rows={v.recentLive} onAll={() => openTab('workshop')} /> : null}
      {/* Start a new change was the hub's last line; it is the hero's ⋯
          now (../actions-row.tsx), as well as the Homeroom menu's. */}
      </>
      ) : null}

      {/* ── THE PLAN, read only, for the people who joined (#4074) ──
          A page under the Hub, opened by the First version card's "See the
          plan"; Hub stays lit. See ./plan-page.tsx. */}
      {tab === 'plan' ? (
        <PlanPage
          name={community?.name || app.name || slug}
          data={community}
          onBack={() => openTab('status')}
          onDiscussion={() => openTab('discussion')}
        />
      ) : null}

      {/* ── DISCUSSION: the community's channel, whole ── (./project-discussion.tsx) */}
      {isChannelPlace(tab) ? (
        <ProjectDiscussion
          slug={slug}
          name={app.name || community?.name || slug}
          data={community}
          channel={placeHandle(tab)}
          onPlace={openTab}
        />
      ) : null}

      {/* ── THE WORKSHOP TAB, in three titled parts (After-Workshop-B) ──
          OVERVIEW: All items' numbers, where most of the open work is, and
          the approval rule in one line (whose See all opens All items, the
          page under this tab), then the notices panel when it has notices.
          WHAT'S HAPPENING: one card, your own work in flight, then what is
          new for you since your last visit and asks something of you, in
          parts headed and divided as What happened's weeks are. WHAT HAPPENED:
          this week, row by row, then each week before it as one row. */}
      {/* ── A WEEK'S OWN PAGE, inside the Workshop tab (#4457) ──
          This week's "All of this week", or an earlier week's row, opens it,
          with "‹ Workshop" back; the tab stays lit. See ./week-pages.tsx. */}
      {tab === 'workshop' && weekUp ? (
        <WeekPage
          week={weekUp}
          fetched={v.week && v.week.startMs === weekUp.startMs
            ? {
                loading: v.week.loading,
                failed: v.week.failed,
                fresh: v.week.fresh.filter((r): r is WorkCardRow => r.t === 'card' && notGoingLive(r)),
                seen: v.week.seen.filter((r): r is WorkCardRow => r.t === 'card' && notGoingLive(r)),
              }
            : null}
          slug={slug}
          openKey={sideKey}
          onOpen={openItem}
          onBack={closeWeekPage}
        />
      ) : null}
      {tab === 'workshop' && !weekUp ? (
      <>
      {/* ── OVERVIEW ── a label over the card, small caps (SectionHeader),
          the only uppercase on the page; the card's own heading is a
          sentence. The numbers are what somebody arriving asks first, so
          they are the first thing on the page, four across at any width. */}
      <SectionHeader className="px-1.5 pb-0 pt-2" data-ws-part="overview">{t('project:workshop.part.overview')}</SectionHeader>
      {v.dashboard ? (
        <section
          className="dev-ws-strip"
          data-ws-dashboard=""
        >
          <div className="dev-ws-head">
            <span className="dev-ws-head-title">{t('project:workshop.allItems.title')}</span>
            <button
              type="button"
              className="dev-ws-hub-open dev-ws-head-end un-touch-target"
              data-ws-all-open=""
              onClick={() => openTab('all')}
            >
              {/* #2915: A SEARCH OR FILTER IS WAITING ON ALL ITEMS. It
                  narrows that page alone, so from here it is out of sight,
                  and this dot is what says it is still on. The dot is
                  decoration; the words join the button's name, in the one
                  message that holds both. */}
              {v.meta.filtered ? (
                <RichMessage
                  id="project:workshop.allItems.seeAllFiltered"
                  components={[
                    <span className="dev-ws-filter-dot" data-ws-filtered="" aria-hidden="true" />,
                    <span className="sr-only" />,
                  ]}
                />
              ) : t('project:workshop.allItems.seeAll')}
              <ChevronRightIcon className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </div>
          {/* #4745: the votes figure routes its tap — the one waiting item's
              page when exactly one waits, All items otherwise, where every
              waiting change is listed. With nothing waiting the figure is
              not a button and the handler is never called. */}
          <DashTiles
            d={v.dashboard}
            owed={owed}
            onVotes={() => {
              const refs = v.dashboard?.votesWaitingRefs || [];
              if (refs.length === 1) callAppView('openTopic', refs[0].kind, refs[0].id);
              else openTab('all');
            }}
          />
          {/* Where the open work is: the categories with the most of it, as
              chips. It replaced the model's paragraph about the open work
              and the sentence derived from the counts, and the caption that
              said which of the two was on screen. */}
          <OpenTopics list={v.dashboard.openThemes} slug={slug} onChannel={openTab} onTheme={openTheme} />
          {/* How a change gets in, in one line: the three-step Approval
              rules card it was (#4457), folded into the sentence its steps
              spelled out, with Rules for whoever may change it (#4527). See
              ./community-card.tsx ApprovalLine. */}
          {slug ? <ApprovalLine slug={slug} /> : null}
        </section>
      ) : null}

      {/* ── WHAT'S HAPPENING ── what is yours, then what is new for you, in
          ONE card (After-Workshop-C, Oct 2026). Its parts are headed and
          divided the way What happened's weeks are: the part's name in This
          week's weight with its count beside it, a hairline over every row
          and a hairline between parts. They were a card each (#4772), five
          rounded boxes in a column with the same title over each, and each
          one's two-line rows made a short list read as a long one. */}
      {anyMine || showWork || freshRows.length ? (
        <>
        <SectionHeader className="px-1.5 pb-0 pt-3.5" data-ws-part="happening">{t('project:workshop.part.happening')}</SectionHeader>
        <section className="dev-ws-strip" data-ws-happening="">
          {/* ── Waiting on you ── (#4772) what needs the viewer's answer
              before it can move: Homeroom bot's plan for their request
              waiting for Build it, its question to them, a back and forth
              with it on a change or request, and a change of theirs that
              needs a fix. One line each; its count asks for the viewer, so
              it is in the accent. */}
          {waitingRows.length ? (
            <MineSection
              section="waiting"
              title={t('project:workshop.waiting.title')}
              count={t('project:workshop.waiting.count', { count: waitingRows.length })}
              ask
              rows={waitingRows}
              slug={slug}
              openKey={sideKey}
              onOpen={openItem}
            />
          ) : null}
          {/* ── Your work ──
              A returning member's own work in flight that waits on nobody's
              vote and none of their answers (#4772: those are the parts
              around it): their requests and their changes being made
              (AppView._workshopView), in What happened's one-line row
              (./week-pages.tsx HappenedRow, `standing`): the glyph, the
              title, and at the line's end where it stands. A request your
              change addresses is drawn as that change. Its first
              WORKSHOP_WORK_FIRST, the rest behind Show N more. */}
          {v.mine && showWork ? (
            <div className="dev-ws-hpart" data-ws-mine="">
              <PartHead
                title={t('project:workshop.mine.title')}
                count={workRows.length ? t('project:workshop.mine.open', { count: workRows.length }) : null}
              />
              <div className="dev-ws-lane" data-ws-lane="mine">
                {/* #2182: the part does not leave when the viewer has nothing
                    underway. It says so, and names the way in: asking
                    Homeroom bot where it builds for this viewer (`mine.bot`),
                    Build it now under the hub's ⋯ elsewhere, and nothing to
                    press for a read-only viewer or under the start-here
                    banner. */}
                {!workRows.length ? (
                  <p className="text-xs text-zinc-500 dark:text-zinc-400" data-ws-mine-empty="">
                    {actions.readOnly || startHere
                      ? t('project:workshop.mine.empty')
                      : v.mine.bot
                        ? t('project:workshop.mine.emptyBot')
                        : t('project:workshop.mine.emptyBuild')}
                  </p>
                ) : (
                  <MineLines
                    rows={workRows.slice(0, mineAll ? undefined : WORKSHOP_WORK_FIRST)}
                    slug={slug}
                    openKey={sideKey}
                    onOpen={openItem}
                  />
                )}
                {workRows.length > WORKSHOP_WORK_FIRST ? (
                  <button
                    type="button"
                    className="dev-ws-reveal touch-target-32"
                    data-ws-mine-more=""
                    aria-expanded={mineAll}
                    onClick={() => setMineAll(!mineAll)}
                  >
                    <ChevronDownIcon className="dev-ws-reveal-chev" aria-hidden="true" />
                    {mineAll ? t('project:workshop.mine.showLess') : t('project:workshop.mine.showMore', { count: workRows.length - WORKSHOP_WORK_FIRST })}
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
          {/* ── Yours, up for a vote ── (#4772) the viewer's own changes and
              group decisions up for a vote that need nothing from them. The
              one part that keeps two lines a row: the vote's pill and Vote
              end the first, its tags are the second. */}
          {voteRows.length ? (
            <MineSection
              section="vote"
              title={t('project:workshop.yourVotes.title')}
              count={t('project:workshop.yourVotes.count', { count: voteRows.length })}
              rows={voteRows}
              slug={slug}
              openKey={sideKey}
              onOpen={openItem}
            />
          ) : null}
          {/* ── Going live ── (#4715, #4772) the viewer's merged changes that
              are not live yet, until the release lands. They are left out of
              What happened meanwhile (`goingLiveKeys`), and are its news
              once live, so a change is listed once at any point. */}
          {liveRows.length ? (
            <MineSection
              section="live"
              title={t('project:workshop.goingLive.title')}
              count={t('project:workshop.goingLive.count', { count: liveRows.length })}
              rows={liveRows}
              slug={slug}
              openKey={sideKey}
              onOpen={openItem}
            />
          ) : null}
          {/* ── New for you ──
              Since your last visit, the requests filed since, whose Build it
              is the request card's own next step (ask Homeroom bot, or build
              it yourself). The votes waiting on yours are Needs you's
              (#4716). Not on a first visit, which has no last visit, and not
              when there is none. */}
          {freshRows.length ? (
            <div className="dev-ws-hpart" data-ws-fresh="">
              <PartHead
                title={t('project:workshop.fresh.title')}
                count={t('project:workshop.fresh.count', { count: freshRows.length })}
              />
              <div className="dev-ws-wlist">
                {(freshAll ? freshRows : freshRows.slice(0, WORKSHOP_WORK_FIRST)).map((r) => (
                  <ActRow
                    key={r.key}
                    row={r}
                    slug={slug}
                    sub={rowWords(r.brief!, { lead: t('project:workRow.state.newRequest'), replies: true })}
                    act={freshAct(r)}
                    on={rowOn(r)}
                    onOpen={openItem}
                  />
                ))}
              </div>
              {freshRows.length > WORKSHOP_WORK_FIRST ? (
                <button
                  type="button"
                  className="dev-ws-reveal touch-target-32"
                  data-ws-fresh-more=""
                  aria-expanded={freshAll}
                  onClick={() => setFreshAll(!freshAll)}
                >
                  <ChevronDownIcon className="dev-ws-reveal-chev" aria-hidden="true" />
                  {freshAll ? t('project:workshop.mine.showLess') : t('project:workshop.mine.showMore', { count: freshRows.length - WORKSHOP_WORK_FIRST })}
                </button>
              ) : null}
            </div>
          ) : null}
        </section>
        </>
      ) : null}

      {/* ── WHAT HAPPENED ──
          One card for what was Since your last visit and Week by week:
          this week, its new rows and a few seen ones, then "All of this
          week" (its page); then each week before it as one row that opens
          its page, back to the project's first (#3293). Mark all seen moves
          the line to now, and what was new is then the week's like the rest
          (#2183). Nothing new is one line. */}
      {weeks.length || v.since ? (
        <>
          <div className="dev-ws-parthead" data-ws-happened-head="">
            <SectionHeader className="px-1.5 pb-0 pt-3.5" data-ws-part="happened">{t('project:workshop.part.happened')}</SectionHeader>
            {v.since ? (
              <button
                type="button"
                className="dev-ws-since-clear un-touch-target"
                data-ws-since-clear=""
                disabled={!sinceRows.length}
                onClick={clearSince}
              >
                {t('project:since.markAllSeen')}
              </button>
            ) : null}
          </div>
          <section className="dev-ws-strip" data-ws-happened="">
            {v.since && !sinceRows.length ? (
              <p className="dev-ws-none" data-ws-since-none="">{t('project:since.none')}</p>
            ) : null}
            {thisWeek ? (
              <ThisWeek
                week={thisWeek}
                slug={slug}
                openKey={sideKey}
                onOpen={openItem}
                onAll={() => openWeekPage(sinceWeekStateKey(thisWeek))}
              />
            ) : null}
            {pastWeeks.length ? (
              <div className="dev-ws-wlist">
                {pastWeeks.slice(0, weeksShown).map((w) => (
                  <WeekRow key={sinceWeekStateKey(w)} week={w} onOpen={() => openWeekPage(sinceWeekStateKey(w))} />
                ))}
              </div>
            ) : null}
            {weeksShown < pastWeeks.length ? (
              <button
                type="button"
                className="dev-ws-reveal touch-target-32"
                data-ws-weeks-more=""
                onClick={() => setWeeksShown(weeksShown + WEEKS_STEP)}
              >
                <ChevronDownIcon className="dev-ws-reveal-chev" aria-hidden="true" />
                {t('project:happened.earlierWeeks')}
              </button>
            ) : firstWeek && pastWeeks.length ? (
              <p className="dev-ws-week-note" data-ws-week-start="">
                {t('project:since.projectStarted', { date: weekDate(firstWeek) })}
              </p>
            ) : null}
          </section>
        </>
      ) : null}
      </>
      ) : null}

      {/* ── The item's page, beside the list (#4457) or the board (#4486) ── ./side-panel.tsx */}
      {(tab === 'workshop' || tab === 'all') && sideItem ? <TopicSidePanel item={sideItem} onClose={closeSide} /> : null}

      {tab === 'needs' ? (
        <NeedsFeed
          rows={v.queue}
          models={v.models}
          slug={slug}
          canPost={canPost}
          onDone={() => openTab('workshop')}
          onHub={() => openTab('status')}
          // #4680: the end card's quiet way into the Suggest an improvement
          // form, the same open the hub's ⋯ row makes. No `intent: 'issue'`,
          // so the heading reads "Suggest an improvement".
          onSuggest={() => { (window as any).App?.openFeedbackModal?.({ fromDev: true }); }}
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
              The search and the filters used to sit in the frame's chrome
              above the scroller, two strips away from the list they narrow.
              (So did the "+", which is not a narrowing control: it adds to
              the board and manages the app, so it is the hub's ⋯ now.) They
              belong WITH the list — and with the grouping, because
              "which grouping" and "narrowed to what" are one question asked
              twice. The head pins, under the project's tabs (#3651: not
              under the back bar, which scrolls away): filtering a long list
              is exactly what you are doing when you are scrolled down, and a
              bar that scrolled away would leave no way back.

              THE TABS LEAD, and the order is the argument: they decide what
              the search is searching. With the search above them the control
              that sets the scope sat under the control that acts within it,
              and the pane had to be read bottom-up to be understood. Leading
              with the switch also gives the head a title bar — the two-state
              choice, then the tools for whichever state you picked. */}
          <div className="dev-ws-pane-head">
            {/* #4486: ONE ROW, the page's own bar: the way back and the
                page's name ("All items", no "Workshop" eyebrow: the lit
                Workshop tab above says where it hangs), the grouping, then
                the search and the filters. It wraps on a narrow window and
                on a phone (app.css `.dev-ws-allbar`). It used to be three:
                a back bar over the pane, which scrolled away, then the
                grouping, then the tools. The back bar is in the pinned head
                now, so the page's name stays on screen too.

                THE GROUPING STILL LEADS THE TOOLS IN THE DOCUMENT (#852):
                it decides what the search searches. The row lays the search
                out first (app.css), as the board was reviewed (#4486). */}
            <div className="dev-ws-allbar" data-ws-allbar="">
              <PageBack
                label={t('project:page.backToWorkshop')}
                title={pageTitle(tab)}
                onBack={() => openTab(pageParent(tab))}
                eyebrow={false}
              />
              <GroupStrip group={group} />
              {/* The search and the filters. NOT the ⋯: that is the hub's, in
                  its hero, so the row draws none of its own. */}
              <DevActionsRow
                illustrationApp={actions.illustrationApp}
                canManageIllustration={actions.canManageIllustration}
                selfHosted={actions.selfHosted}
                readOnly={actions.readOnly}
                canCollaborate={actions.canCollaborate}
                showsMembers={actions.showsMembers}
                withPlus={false}
              />
            </div>
            {/* #4486: BY STAGE, THE PIPELINE PINS WITH THE ROW. The board's
                column heads, as steps (../card/dev-kanban.tsx StageStrip),
                so the column names stay on screen down a long column; on a
                phone they are the tabs. */}
            {group === 'stage' ? <StageStrip /> : null}
          </div>
          {/* The pane's face is painted by its two PARTS, not by the pane —
              see app.css. A fill on the pane with a second one on the sticky
              head stacked 50% on 50% and drew a lighter band across the
              controls; giving head and body the same fill on the same
              backdrop makes them the same colour by construction. */}
          <div className="dev-ws-pane-body">
          {group === 'stage' ? (
            <div className="dev-ws-board" data-ws-stage="">
              <DevKanban openKey={sideKey} onOpen={openItem} />
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
            <div className="dev-ws-sort-opts" role="group" aria-label={t('project:allItems.sort.label')}>
              {SORTS.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  className="dev-ws-chip"
                  aria-pressed={sortKey === s.key}
                  onClick={() => { if (s.key !== sortKey) captureThemeTops(); setSortKey(s.key); }}
                >
                  {t(s.label)}
                </button>
              ))}
            </div>
          </div>
          {/* #4417: TOPICS, THEN OTHER CATEGORIES. A project's topics are the
              categories its members set, each with a channel, so they lead
              under a heading of their own, in dapp.json's order; whatever
              else the board is grouped into follows under its own. A project
              with no topics draws its categories as it always did, with no
              heading at all. */}
          <div className="dev-ws-themes" ref={themesRef}>
            {themes.some((theme) => theme.topic) ? (
              <SectionHeader className="pt-3" data-ws-themes-head="topics">{t('project:allItems.themes.topics')}</SectionHeader>
            ) : null}
            {themes.map((theme, i) => (
              <Fragment key={theme.id}>
                {themes.some((x) => x.topic) && !theme.topic && (i === 0 || themes[i - 1].topic) ? (
                  <SectionHeader className="pt-3" data-ws-themes-head="other">{t('project:allItems.themes.other')}</SectionHeader>
                ) : null}
                <ThemeCard
                  theme={theme}
                  slug={slug}
                  open={isOpen(theme.id)}
                  onToggle={() => toggleTheme(theme.id)}
                  openKey={sideKey}
                  onOpen={openItem}
                  onChannel={openTab}
                />
              </Fragment>
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
                ? t('project:allItems.categories.demo')
                : v.meta.pending
                  ? t('project:allItems.categories.beingDrafted')
                  : v.meta.lastError
                    ? t('project:allItems.categories.draftFailed', { error: v.meta.lastError })
                    : t('project:allItems.categories.noModel')}
          </div>
          </>
          )}
          </div>
          </section>
        </>
      ) : null}


      </div>
    </div>
  );
}
