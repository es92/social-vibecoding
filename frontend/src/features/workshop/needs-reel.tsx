/**
 * The Communities screen's Needs you tab as one feed (#3270), and since #3488
 * THE SAME FEED a project's Needs you page is.
 *
 * It mixes everything: every decision owed by you across all the projects you
 * are a member of, newest first (GET /api/workshop/needs-feed,
 * src/routes/workshop-overview.js), each item naming the project it belongs
 * to. It used to draw its own cards (a Yes and a No at the foot of each, a
 * link to read the rest), so the two Needs you screens looked and answered
 * differently: the project's had the rail (Vote, Description, Comments, Ask,
 * Try it, More), the vote sheet, the swipe, the keys and the end card, and
 * this one had none of them. Now the rows are adapted here and drawn by the
 * project's own `NeedsFeed` (dev-board/workshop/workshop.tsx), so the two
 * cannot drift apart again.
 *
 * ── What a row can do from here ─────────────────────────────────────────
 *
 * A CHANGE is voted from the vote sheet with the platform's own vote
 * (AppView.castVote), carrying the approval epoch the server checks (#2038),
 * asking for a line on a No the way every vote does, and turning a
 * membership refusal into Join through the fetch wrapper. Description,
 * Comments and Ask are the project's own, addressed to the row's project.
 * A GROUP DECISION (a rename, a secret, closing a request) is decided on its
 * own page, where its options and consequences are shown: those votes can
 * apply the decision on the spot, and that belongs on the screen that
 * explains it. What the feed cannot do across projects it leaves as the
 * project's page does when it has nothing to offer: Try it opens a preview
 * inside the project's own view, so it is not lit here.
 *
 * ── Island rules ────────────────────────────────────────────────────────
 *
 * Rendered only while the tab shows, from data the controller loads in an
 * effect; nothing here is in the prerendered document.
 */

import { useEffect, useMemo, type ReactNode } from 'react';

import type { DevWorkshopView } from '../dev-board/card/model';
import { callAppView } from '../dev-board/card/fold';
import { NeedsFeed } from '../dev-board/workshop/workshop';
import { AppIconContent, AppIconLink, appIconKind } from '../apps/app-card-view';
import { agoStamp } from '../../lib/timestamp';

export type NeedsFeedItem = {
  kind: 'proposal' | 'governance';
  id: number;
  title: string;
  summary: string | null;
  author: string | null;
  number: number | null;
  epoch: number | null;
  at: string | null;
  yes: number | null;
  no: number | null;
  /**
   * #4270: a change on a project that is just yours whose Yes is the one it
   * needs (B7, the server's rule for `_cardVoteButtonSpecs`' `approve`).
   */
  approve?: boolean;
  /**
   * #4490: the card's picture, as a project's Needs you draws it: the
   * change's before & after shots run and legacy capture pair (shaped by
   * `AppView._workshopVisuals`, as there), its author's diagram, "What it
   * touches", and a group decision's own facts.
   */
  shots?: unknown;
  visuals?: unknown;
  diagram?: unknown;
  diagram_source?: string | null;
  touches?: unknown;
  nothing_visible?: boolean;
  decision?: unknown;
  app: { slug: string; name: string; icon_url: string | null; icon_emoji: string | null };
};

/**
 * The shots and legacy pair as the item draws them: the project page's own
 * shaping (`AppView._workshopVisuals`), so the two feeds cannot differ.
 * Null when AppView is not loaded or there is nothing to show.
 */
function feedVisuals(item: NeedsFeedItem): FeedRow['visuals'] {
  if (item.kind === 'governance' || (!item.shots && !item.visuals)) return null;
  const out = callAppView('_workshopVisuals', item.visuals || null, item.shots || null);
  return out && typeof out === 'object' ? (out as FeedRow['visuals']) : null;
}

type FeedRow = DevWorkshopView['queue'][number];

/**
 * A proposal's summary is Markdown written for its own page. On the item it
 * is a paragraph: headings, emphasis, code ticks and list markers go, a link
 * keeps its words, and the whitespace collapses. The Description sheet has
 * it rendered.
 */
export function plainSummary(md: string | null | undefined): string {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_`>~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The feed's rows, in the shape a project's Needs you builds its own
 * (app-view.js `_workshopView`'s queue): the card's page, the question and
 * what Yes and No DO, who asked and when, the words, the ask box's address
 * and the thread's. A change's pair is `_cardVoteButtonSpecs`' (castVote with
 * the epoch, and on a project that is just yours the Yes marked `approve`, so
 * the item says Approve and Don't approve as its card does, #4270); a group
 * decision has none, and the vote sheet opens its page.
 * `html` renders a summary for the Description sheet (DevChat's renderer,
 * through AppView, where it is loaded).
 */
export function reelRows(
  items: NeedsFeedItem[],
  html: (md: string) => string = () => '',
): FeedRow[] {
  return items.map((item) => {
    const change = item.kind !== 'governance';
    const key = `${change ? 'proposal' : 'governance'}:${item.id}`;
    const rev = item.epoch == null ? [] : [item.epoch];
    const summary = plainSummary(item.summary) || null;
    const attrs: Record<string, string> = change ? { 'data-proposal-row': String(item.id) } : { 'data-gov-row': String(item.id) };
    const row: FeedRow = {
      t: 'card',
      key: `needs:${key}`,
      card: {
        key,
        cls: '',
        attrs,
        icon: null,
        title: { text: item.title || (change ? 'A change' : 'A group decision'), title: '' },
        meta: [],
        pill: null,
        linked: [],
        badges: [],
        chatCount: null,
        actions: [],
        actionPreview: null,
        // No menu of its own across projects: the ⋯ is "Open card" alone
        // (AppView._cardMenuItems), which an empty key still reaches.
        rail: { menuKey: '', chevron: false, preview: null },
        extra: [],
        dense: false,
        uncapped: false,
      },
      kind: 'vote',
      ask: change ? 'Should this change go in?' : 'Should this go ahead?',
      yes: change ? { label: 'Yes', act: { fn: 'castVote', args: [item.id, 'yes', ...rev] }, ...(item.approve ? { approve: true } : {}) } : null,
      no: change ? { label: 'No', act: { fn: 'castVote', args: [item.id, 'no', ...rev] } } : null,
      who: item.author || null,
      ago: item.at ? agoStamp(item.at).text : '',
      number: item.number,
      body: null,
      summary,
      descriptionHtml: item.summary ? html(item.summary) : '',
      visuals: feedVisuals(item),
      ...(item.diagram ? { diagram: item.diagram, diagramSource: item.diagram_source || 'author' } : {}),
      ...(item.touches ? { touches: item.touches } : {}),
      ...(item.nothing_visible ? { nothingVisible: true } : {}),
      ...(item.decision ? { decision: item.decision } : {}),
      askAbout: { kind: change ? 'proposal' : 'gov', ref: item.id },
      thread: { type: change ? 'session' : 'governance', ref: item.id },
      app: item.app,
      tally: { yes: Number(item.yes) || 0, no: Number(item.no) || 0 },
    };
    return row;
  });
}

/**
 * The project a row belongs to, over its by-line: its tile and name, a door
 * to its hub.
 */
function ReelApp(item: FeedRow): ReactNode {
  const app = item.app;
  if (!app) return null;
  const tile = { icon_url: app.icon_url, icon_emoji: app.icon_emoji, name: app.name };
  return (
    <a
      className="workshop-reel-app"
      data-ws-item-app=""
      href={`#app/${encodeURIComponent(app.slug)}/workshop`}
      onClick={() => { (window as any).AppView?._landOnHub?.(app.slug); }}
    >
      <AppIconLink nested slug={app.slug} name={app.name} className="app-icon-tile workshop-reel-tile" data-icon={appIconKind(tile as never)}>
        <AppIconContent app={tile as never} />
      </AppIconLink>
      <span className="min-w-0 truncate">{app.name}</span>
    </a>
  );
}

const NO_MODELS: DevWorkshopView['models'] = { list: [], selected: null };

export function NeedsReel({ items, error, capped, onDone }: {
  items: NeedsFeedItem[] | null;
  error: boolean;
  /** The read stopped at its bound: there may be more than these. */
  capped: boolean;
  /** The end card's way on: back to the list of communities. */
  onDone: () => void;
}) {
  const rows = useMemo(() => (items ? reelRows(items, (md) => {
    const out = callAppView('_proposalSummaryHtml', { pr_summary_md: md });
    return typeof out === 'string' ? out : '';
  }) : []), [items]);
  // The ask box's models: the dev session's own list, as on a project page.
  const models = useMemo(() => {
    const m = callAppView('_workshopModels') as DevWorkshopView['models'] | undefined;
    return m && Array.isArray(m.list) ? m : NO_MODELS;
  }, []);
  // The ⋯'s delegated handler, which a project page installs when it first
  // draws; this screen can be the first thing opened.
  useEffect(() => {
    callAppView('_attrInit');
    callAppView('_cardMenuInit');
  }, []);

  if (error) {
    return <p className="px-4 pt-3 text-sm text-zinc-500 dark:text-zinc-400" data-needs-error="">Couldn't load what is waiting on you. Each project's own Needs you page still has it.</p>;
  }
  if (!items) {
    return <div className="workshop-needs-feed workshop-reel-loading" data-needs-reel="" aria-busy="true" aria-label="Loading what needs you" />;
  }
  if (!items.length) {
    return <p className="px-4 pt-3 text-sm text-zinc-500 dark:text-zinc-400" data-needs-empty="">Nothing is waiting on your vote in any of your projects.</p>;
  }
  return (
    <>
      <div className="workshop-needs-feed" data-needs-reel="">
        <NeedsFeed
          rows={rows}
          total={rows.length}
          models={models}
          slug=""
          canPost
          onDone={onDone}
          doneLabel="Back to your communities"
          renderApp={ReelApp}
        />
      </div>
      {capped ? (
        <p className="px-4 pt-2 text-xs text-zinc-500 dark:text-zinc-400" data-needs-capped="">
          Showing the newest {items.length}. Each project's own Needs you page has the rest.
        </p>
      ) : null}
    </>
  );
}
