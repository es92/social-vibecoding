/**
 * The Needs you feed's rows (#3270, #3488): the adapter between a
 * GET /api/workshop/needs-feed item and the row the review flow draws.
 *
 * It mixes everything: every decision owed by you across all the projects you
 * are a member of, newest first (GET /api/workshop/needs-feed,
 * src/routes/workshop-overview.js), each item naming the project it belongs
 * to. `reelRows` builds those rows, and `plainSummary` flattens a change's
 * markdown summary to the one line a voter reads.
 *
 * ── Island rules ────────────────────────────────────────────────────────
 *
 * Pure helpers only: no component, no effect, nothing in the document.
 */

import type { ReactNode } from 'react';

import type { DevWorkshopView } from '../dev-board/card/model';
import { callAppView } from '../dev-board/card/fold';
import { AppIconContent, AppIconLink, appIconKind } from '../apps/app-card-view';
import { listText, t as translate } from '../../lib/i18n/runtime';
import { agoStamp } from '../../lib/timestamp';

/**
 * #6019: a ballot's choices (the server's ballotOf): the changes up for a
 * vote that would close the same request, and an open vote to close it.
 */
export type NeedsBallot = {
  number: number | null;
  title: string | null;
  options: Array<{ id: number; number: number | null; title: string; author: string | null; epoch: number | null }>;
  close: { id: number; title: string; reason: string | null; author: string | null } | null;
};

export type NeedsFeedItem = {
  /**
   * #6019: `ballot` is changes that compete, one card for them all (its
   * choices in `ballot`); `question` is one Homeroom bot asked the viewer
   * about their request. Both are decided on the request's page.
   */
  kind: 'proposal' | 'governance' | 'ballot' | 'question';
  ballot?: NeedsBallot;
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
   * #5365: the viewer's vote does not decide this change — `advisory`: they
   * are outside the project's deciders (#4747, the server's
   * `my_vote_advisory`); `uncounted`: a test account's vote, recorded but
   * not counted. The item is labelled as advisory and the feed puts the
   * rows whose vote decides first.
   */
  advisory?: boolean;
  uncounted?: boolean;
  /**
   * #6389: a change the viewer made through a coding agent whose votes are
   * in but which waits on their fix. It is left out here and in the review
   * flow, which show vote cards; the Homeroom bot tab's Needs you says what
   * it waits on.
   */
  waitingOn?: string[];
  /**
   * #6531: a conflicting change only a yes can move. Its row says so, as the
   * Homeroom bot tab's Vote row does.
   */
  conflictOnYes?: boolean;
  /** #6389: the coding tool the change was made in, such as `claude-code`. */
  agent?: string | null;
  /**
   * The change's code did not come across when Homeroom moved off GitHub
   * (src/services/code-missing.js): the item says "Code missing", as its
   * project's own card does. A vote on it is still recorded.
   */
  codeMissing?: boolean;
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
  if (item.kind !== 'proposal' || (!item.shots && !item.visuals)) return null;
  const out = callAppView('_workshopVisuals', item.visuals || null, item.shots || null);
  return out && typeof out === 'object' ? (out as FeedRow['visuals']) : null;
}

type FeedRow = DevWorkshopView['queue'][number];

/**
 * A proposal's summary is Markdown written for its own page. On the item it
 * is a paragraph: headings, emphasis, code ticks and list markers go, a link
 * keeps its words, and the whitespace collapses. The caption's "more" has
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
 * `html` renders a summary for the caption's "more" (DevChat's renderer,
 * through AppView, where it is loaded).
 */
/**
 * #6019: a ballot, or the bot's question, as the feed draws it: like a group
 * decision, with no Yes and No of its own, so its vote sheet opens the page
 * it is decided on, the request's (its `data-issue-row`), where the ballot's
 * choices are and the question was asked. A ballot's caption lists its
 * choices in the order the page letters them.
 */
function requestRow(item: NeedsFeedItem): FeedRow {
  const ballot = item.kind === 'ballot' ? item.ballot || null : null;
  const number = ballot ? ballot.number : item.number;
  const letter = (i: number) => String.fromCharCode(65 + i);
  const choices = ballot ? listText([
    ...ballot.options.map((o, i) => translate('communities:reel.ballot.choice', { letter: letter(i), title: o.title || translate('communities:reel.fallbackTitle.change') })),
    ballot.close ? translate('communities:reel.ballot.close') : null,
  ]) : '';
  const attrs: Record<string, string> = {
    ...(number ? { 'data-issue-row': String(number) } : {}),
    ...(ballot ? { 'data-ballot': String(item.id) } : { 'data-bot-question': String(item.id) }),
  };
  const key = `${item.kind}:${item.id}`;
  return {
    t: 'card',
    key: `needs:${key}`,
    card: {
      key,
      cls: '',
      attrs,
      icon: null,
      title: {
        text: ballot
          ? (ballot.title || translate('communities:reel.ballot.fallbackTitle', { number: number ?? '' }))
          : (item.title || translate('communities:reel.fallbackTitle.question')),
        title: '',
      },
      meta: [],
      pill: null,
      linked: [],
      badges: [],
      chatCount: null,
      actions: [],
      actionPreview: null,
      rail: { menuKey: '', chevron: false, preview: null },
      extra: [],
      dense: false,
      uncapped: false,
    },
    kind: 'vote',
    ask: ballot ? translate('communities:reel.ask.ballot') : translate('communities:reel.ask.question'),
    yes: null,
    no: null,
    who: ballot ? null : (item.author || null),
    ago: item.at ? agoStamp(item.at).text : '',
    number,
    summary: ballot ? translate('communities:reel.ballot.choices', { choices }) : null,
    descriptionHtml: '',
    visuals: null,
    // A ballot is addressed to its oldest change: the row its count keys on
    // (`proposal:<id>`, the seen record's key, needs-seen.ts needsRowKey). A
    // question is no vote, so it has no address: never recorded as seen, it
    // counts until it is answered.
    askAbout: ballot ? { kind: 'proposal', ref: item.id } : null,
    thread: number ? { type: 'issue', ref: number } : null,
    app: item.app,
    tally: { yes: 0, no: 0 },
  } as FeedRow;
}

export function reelRows(
  items: NeedsFeedItem[],
  html: (md: string) => string = () => '',
): FeedRow[] {
  return items
    // #6389: a change waiting on its author's fix has nothing to vote on.
    .filter((item) => !(item.waitingOn && item.waitingOn.length))
    .map((item) => {
    if (item.kind === 'ballot' || item.kind === 'question') return requestRow(item);
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
        title: { text: item.title || (change ? translate('communities:reel.fallbackTitle.change') : translate('communities:reel.fallbackTitle.decision')), title: '' },
        // #6531: a conflicting change only a yes can move names the conflict
        // here, as the Homeroom bot tab's Vote row does.
        meta: change && item.conflictOnYes ? [{ t: 'text', s: translate('core:work.line.conflictOnYes') }] : [],
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
      ask: change ? translate('communities:reel.ask.change') : translate('communities:reel.ask.decision'),
      yes: change
        ? {
          label: translate('communities:reel.yes'),
          act: { fn: 'castVote', args: [item.id, 'yes', ...rev] },
          ...(item.approve ? { approve: true } : {}),
          // #5365: the flags the sheet's picker reads its line from, next to
          // `approve` — only ever set together on a real server, and the
          // test-account line wins in the picker.
          ...(item.uncounted ? { uncounted: true } : {}),
          ...(item.advisory ? { advisory: true } : {}),
        }
        : null,
      no: change ? { label: translate('communities:reel.no'), act: { fn: 'castVote', args: [item.id, 'no', ...rev] } } : null,
      ...(change && item.codeMissing ? { codeMissing: true } : {}),
      who: item.author || null,
      ago: item.at ? agoStamp(item.at).text : '',
      number: item.number,
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
