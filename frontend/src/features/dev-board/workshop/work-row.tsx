/**
 * The Workshop's row (#4457, #4486): one item, in one hairline-divided list.
 *
 * ONE ROW, THREE SURFACES. A week's page on the Workshop tab, All items'
 * board columns and its By category lanes all draw this row now (#4486),
 * and the Workshop tab's What happened its own one-line row
 * (./week-pages.tsx HappenedRow). (5 Nov 2026: the Workshop's Your work and
 * New for you, which drew its `line` shape and its `ActRow` sibling, went:
 * your work is the Homeroom bot tab's, and New for you is What happened's.)
 * The board and By
 * category used to draw the folded card (../card/fold.tsx), which wore a
 * coloured edge and a coloured glyph the column already said, named its
 * author and its provenance twice, and unfolded in place under a ⇕. A row
 * here is:
 *
 *   - on the Workshop tab, a neutral tile (what kind of thing it is: the tab
 *     mixes requests, changes and live work in one list); none on the board,
 *     whose column says it;
 *   - the title, 15px;
 *   - one line in the board's words: "PR #4456 · evan · for #4452 and #4455
 *     · 4m ago", "#4417 · evan · 8h ago" (`rowWords`);
 *   - a tags line: on live work the card's own "✓ Live" bar at its words'
 *     width first, then the card's coloured category chip and its 💬 count
 *     (dev-card.tsx's own pieces, unchanged), then small tags for what is
 *     happening on it ("Picked up · zura", "Checks passed",
 *     AppView._workshopBrief), and on the Workshop tab the card's coloured
 *     category chip and its 💬 count. #4718: a change's status pill and
 *     Vote no longer ride this line — they take a line of their own under
 *     it, at the row's far end, on every width, so rows beside each other
 *     keep the same shape whatever the tags' length;
 *   - ☰, the card's own menu trigger with the card's own key, so
 *     `_toggleCardMenu`, the touch action sheet and every item in it work
 *     unchanged;
 *   - on the board, under all that, the card's status bar and Vote across
 *     the row (fold.tsx `RowBand`), except on live work.
 *
 * THE ROW OPENS THE ITEM'S PAGE. Its title is a real link to the page's
 * route, stretched over the row (app.css `.dev-ws-wrow-link::after`), so a
 * modified click, a middle click and "Open in new tab" are the browser's,
 * and on a phone a tap is that link: the page takes the screen. On a wide
 * window the Workshop catches the plain click and opens the same page in the
 * panel beside the list or the board (`onOpen`, ./side-panel.tsx). The chips,
 * the bar, Vote and ☰ sit above the stretched link, so each does its own job.
 *
 * THE HOOKS. A board row carries the item's `data-issue-row` and its
 * siblings, as the folded card it replaces did: the declared checks name an
 * item by them, and the Done column's scroll anchor and the attribute
 * popover's fallback anchor look items up by them. The delegated `#dev-body`
 * handler that opens a card full-screen on those hooks stands aside for a
 * click inside any row (`AppView._inFoldWrapper`), because the row's own
 * link does that job. The Workshop tab's rows carry none (`data-ws-open`
 * names the item instead), as they never have.
 */

import type { MouseEvent, ReactNode } from 'react';

import {
  BallotIcon, ChatBubbleTailIcon, CheckIcon, EyeIcon, LockIcon, PencilSquareIcon,
  SparklesIcon,
} from '@/components/ui/icons';
import { StateTag } from '@/components/ui/state-tag';

import { RichMessage, useMessages } from '../../../lib/i18n/react';
import { t as translate } from '../../../lib/i18n/runtime';
import { CategoryChip, ChangeTag, ChatCount, ChecksBar, MenuTrigger, VoteButton } from '../card/dev-card';
import { itemHooks, LiveTally, openHref, RowBand, voteSpecs } from '../card/fold';
import type { DevCardModel, ListRow, RowBrief, RowTag, StatusPillState } from '../card/model';

export type CardRow = Extract<ListRow, { t: 'card' }>;

/**
 * Which surface draws the row. `list`: the Workshop tab's week pages, with
 * the tile, the tags line and the vote on a line of its own under it.
 * `board`: All items' columns and By category's lanes, with no tile and the
 * card's bar across the row. `line`: the Workshop tab's Your work (#4716),
 * in This week's one-line row (./week-pages.tsx HappenedRow): the small
 * glyph, the title on one line and, at its end, the status pill and Vote;
 * under it a second line with the words and the tags.
 */
export type RowVariant = 'list' | 'board';

/** Which page a row opens: the kind `AppView.openTopic` takes, and its id. */
export interface TopicRef {
  kind: 'issue' | 'proposal' | 'gov';
  id: number;
}

/** The item a card is about, read off the hooks the Board's handler reads. */
export function topicRef(card: DevCardModel): TopicRef | null {
  const a = card.attrs || {};
  const num = (v: string | undefined) => {
    const n = parseInt(String(v || ''), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  if (num(a['data-issue-row'])) return { kind: 'issue', id: num(a['data-issue-row']) };
  // #6439: a vote to close a request opens the request's page, where its vote is.
  if (num(a['data-close-request'])) return { kind: 'issue', id: num(a['data-close-request']) };
  if (num(a['data-gov-row'])) return { kind: 'gov', id: num(a['data-gov-row']) };
  const change = num(a['data-proposal-row']) || num(a['data-shared-session-row']) || num(a['data-session-chip']);
  return change ? { kind: 'proposal', id: change } : null;
}

/**
 * "#4455", "#4455 and #4452", "#1, #2 and #3": request numbers as a list,
 * the way the language on screen writes one. A number is a reference, not
 * a word, so only what stands between them is a message.
 */
function numbers(list: number[]): string {
  const s = list.map((n) => `#${n}`);
  if (s.length < 2) return s.join('');
  const lead = s.slice(0, -1).reduce((first, second) => translate('project:workRow.numbers.pair', { first, second }));
  return translate('project:workRow.numbers.last', { first: lead, last: s[s.length - 1] });
}

/**
 * The item's number as the board says it: "#4417", "PR #4456", "Vote #7";
 * alone, what it is ("Change"). Message ids, read when the row renders.
 */
const NOUN: Record<RowBrief['noun'], { plain: string; numbered: string }> = {
  change: { plain: 'project:workRow.name.change', numbered: 'project:workRow.name.changeNumbered' },
  request: { plain: 'project:workRow.name.request', numbered: 'project:workRow.name.requestNumbered' },
  vote: { plain: 'project:workRow.name.vote', numbered: 'project:workRow.name.voteNumbered' },
};

function numberWords(b: RowBrief): string {
  const noun = NOUN[b.noun] || NOUN.change;
  return b.n ? translate(noun.numbered, { number: b.n }) : translate(noun.plain);
}

/** An item's number as a short code: "R#6465" for a request, "PR#5990" for a change; anything else in its usual words. */
function codeWords(b: RowBrief): string {
  if (b.n && b.noun === 'request') return translate('project:workRow.code.request', { number: b.n });
  if (b.n && b.noun === 'change') return translate('project:workRow.code.change', { number: b.n });
  return numberWords(b);
}

/**
 * The row's one line, in the board's words (#4486): the number, who made it,
 * the requests a change is for (or a live one closed), and when.
 * "PR #4456 · evan · for #4452 and #4455 · 4m ago", "#4417 · evan · 8h ago",
 * "PR #4454 · evan · closed #4453 · 1h ago". The category and the replies
 * are the coloured chip and the 💬 count on the tags line, so they are not
 * said here too. It names the maker everywhere, Your work included, where
 * #4485 had dropped "yours": the board's words say who, not whose, and a
 * change Homeroom bot built from your request (#4538) says Homeroom bot.
 */
export function rowWords(b: RowBrief, opts: {
  /** What the row is waiting on or where it stands, said first ("In progress", "Only you"). */
  lead?: string | readonly string[];
  /** Name the maker (the default). Your work leaves out a maker who is the viewer. */
  by?: boolean;
  /** Say how many replies it has, in words ("5 comments"). */
  replies?: boolean;
  /** Say how long ago it was made (the default). Your work leaves it out (#4716). */
  ago?: boolean;
  /**
   * Standard (WIP): who and when first, then the item's number as a short
   * code, "snait · 29 Oct · PR#5990" (a request is "R#6465"), then what a
   * change is for or closed. The other looks keep the number first.
   */
  whoFirst?: boolean;
} = {}): string {
  const parts: string[] = [];
  for (const lead of typeof opts.lead === 'string' ? [opts.lead] : (opts.lead || [])) if (lead) parts.push(lead);
  if (opts.whoFirst) {
    if (b.by && opts.by !== false) parts.push(b.by);
    if (b.ago && opts.ago !== false) parts.push(b.ago);
    parts.push(codeWords(b));
    if (b.linked.length && b.kind !== 'live') {
      parts.push(translate('project:workRow.for', { count: b.linked.length, requests: numbers(b.linked) }));
    }
    if (b.closed.length && b.kind === 'live') {
      parts.push(translate('project:workRow.closed', { count: b.closed.length, requests: numbers(b.closed) }));
    }
    return parts.reduce((first, second) => translate('project:workRow.facts.pair', { first, second }));
  }
  parts.push(numberWords(b));
  if (b.by && opts.by !== false) parts.push(b.by);
  if (b.linked.length && b.kind !== 'live') {
    parts.push(translate('project:workRow.for', { count: b.linked.length, requests: numbers(b.linked) }));
  }
  if (b.closed.length && b.kind === 'live') {
    parts.push(translate('project:workRow.closed', { count: b.closed.length, requests: numbers(b.closed) }));
  }
  if (opts.replies && b.replies > 0) parts.push(translate('project:workRow.replies', { count: b.replies }));
  if (b.ago && opts.ago !== false) parts.push(b.ago);
  return parts.reduce((first, second) => translate('project:workRow.facts.pair', { first, second }));
}

/** The glyph for what a row is: a request, a change, live work, a vote. */
export const TILE: Record<RowBrief['kind'], typeof CheckIcon> = {
  request: ChatBubbleTailIcon,
  change: PencilSquareIcon,
  live: CheckIcon,
  vote: BallotIcon,
};

/**
 * A small tag for what is happening on an item ("Picked up · zura", "Checks
 * passed", AppView._workshopBrief): the one tag (@/components/ui/state-tag),
 * turning while the work is under way (`run`, and Homeroom bot's own `bot`),
 * plain otherwise. `dev-ws-tag` stays for the declared checks that name it.
 */
function Tag({ t }: { t: RowTag }): ReactNode {
  return (
    <StateTag
      state={t.tone === 'run' || t.tone === 'bot' ? 'working' : 'plain'}
      className="dev-ws-tag"
      title={t.title || (t.short ? t.label : undefined)}
    >
      {t.tone === 'ok' ? <CheckIcon aria-hidden="true" /> : null}
      {t.glyph === 'eye' ? <EyeIcon aria-hidden="true" /> : null}
      {t.glyph === 'lock' ? <LockIcon aria-hidden="true" /> : null}
      {t.glyph === 'bot' ? <SparklesIcon aria-hidden="true" /> : null}
      {t.short ? <><span aria-hidden="true">{t.short}</span><span className="sr-only">{t.label}</span></> : t.label}
      {t.progress ? <ChecksBar progress={t.progress} /> : null}
    </StateTag>
  );
}

/**
 * A change's vote on the Workshop tab (#4486): the card's own status pill,
 * with its own words ("0 of 1 approval"), at its words' width plus the 56px
 * the thin bar it replaces took (app.css `.dev-ws-wvote-state`), and the
 * card's own Vote button. #4718: the pair takes a line of its own under the
 * tags, at the row's far end, on every width — it never shares the tags'
 * line, so rows beside each other keep their pills lined up.
 */
function Votes({ card, pill = null }: { card: DevCardModel; pill?: StatusPillState | null }): ReactNode {
  // T2.5: the change's stored row's words while it is not up for a vote.
  const s = pill || card.pill?.state || null;
  const specs = voteSpecs(card);
  if (!s && !specs) return null;
  return (
    <span className="dev-ws-wvote" data-ws-vote="">
      {s ? <ChangeTag s={s} detail={false} className="dev-ws-wvote-state" /> : null}
      {specs ? <span className="dev-ws-wvote-btn"><VoteButton yes={specs.yes} no={specs.no} /></span> : null}
    </span>
  );
}

export function WorkRow({
  row, slug, on = false, onOpen, variant = 'list', category = true,
}: {
  row: CardRow;
  slug: string;
  /** Its page is open in the panel beside the list. */
  on?: boolean;
  /** A plain click on the row: the Workshop opens it beside the list, or lets the link go. */
  onOpen?: (event: MouseEvent<HTMLAnchorElement>, ref: TopicRef) => void;
  variant?: RowVariant;
  /** Draw the card's category chip. By category's lanes pass false: the group is the category. */
  category?: boolean;
}): ReactNode {
  // The line in words is read with `translate` (rowWords); subscribe the row.
  useMessages('project');
  // The line row's title link, which a click on its tags line opens (#4716).
  const b = row.brief;
  if (!b) return null;
  const card = row.card;
  const board = variant === 'board';
  const href = openHref(slug, card);
  const ref = topicRef(card);
  const Tile = TILE[b.kind] || PencilSquareIcon;
  const pill = card.pill?.state || null;
  // Live work leads its tags with the card's own bar at its words' width
  // ("✓ Live", "Going live…", "Blocked"), in place of the brief's small tag
  // for the same state. On a live row the brief carries only its settled
  // state (AppView._workshopBrief's merged branch), so the pill drawn first
  // already says it, whatever that state is, and the brief's tags are left
  // out entirely — never by their words, which are in the language on screen.
  const live = b.kind === 'live' && !!pill;
  const tags = live ? [] : b.tags;
  const hasChip = category && (card.badges || []).some((x) => x && x.t === 'attr' && x.field === 'category');
  const hasChat = (card.chatCount || 0) > 0;
  const chip = hasChip ? <CategoryChip card={card} /> : null;
  const chat = hasChat ? <ChatCount card={card} /> : null;
  // The Workshop tab's bar and Vote take a line of their own under the tags
  // (#4718), at the row's far end; the board's ride the band under it.
  const votes = !board && b.vote ? <Votes card={card} pill={b.pill || null} /> : null;
  const status = live || hasChip || hasChat || tags.length > 0;
  const menuKey = card.rail && card.rail.menuKey ? card.rail.menuKey : '';
  const specs = board && !live ? voteSpecs(card) : null;
  return (
    <div
      className={board ? 'dev-ws-wrow dev-ws-brow' : 'dev-ws-wrow'}
      data-ws-row={row.key}
      data-ws-kind={b.kind}
      data-ws-open={ref ? `${ref.kind}:${ref.id}` : undefined}
      data-on={on ? '1' : undefined}
      {...(board ? itemHooks(card) : {})}
      // On the board: what the row is and what it is for, for the ties drawn
      // while a card is rested on (./board-links.ts).
      {...(board && b.n ? {
        'data-ws-noun': b.noun,
        'data-ws-num': String(b.n),
        'data-ws-for': (b.kind === 'live' ? b.closed : b.linked).join(',') || undefined,
      } : {})}
    >
      {board ? null : <span className="dev-ws-wrow-tile" data-kind={b.kind} aria-hidden="true"><Tile aria-hidden="true" /></span>}
      <span className="dev-ws-wrow-main">
        {href ? (
          <a
            className="dev-ws-wrow-link"
            href={href}
            title={card.title.text}
            aria-current={on ? 'true' : undefined}
            onClick={ref && onOpen ? (e) => onOpen(e, ref) : undefined}
          >
            {card.title.text}
          </a>
        ) : <span className="dev-ws-wrow-link" title={card.title.text}>{card.title.text}</span>}
        <span className="dev-ws-wrow-sub">{rowWords(b, { whoFirst: true })}</span>
        {b.twin && slug ? (
          <span className="relative z-[1] text-[13px] leading-snug text-zinc-500 dark:text-zinc-400" data-ws-twin={b.twin.number}>
            <RichMessage id="project:workRow.twin" values={{ number: b.twin.number }} components={[
              <a key="twin" className="font-semibold text-violet-700 hover:underline dark:text-violet-300" href={`#app/${encodeURIComponent(slug)}/dev/issues/${b.twin.number}`} title={b.twin.title} onClick={onOpen ? (e) => onOpen(e, { kind: 'issue', id: b.twin!.number }) : undefined} />,
            ]} />
          </span>
        ) : null}
        {status ? (
          <span className="dev-ws-wrow-status">
            {live && pill ? <ChangeTag s={pill} detail={false} className="dev-ws-wrow-live" /> : null}
            {live ? <LiveTally s={pill} /> : null}
            {chip}
            {chat}
            {tags.map((t) => <Tag key={`${t.label}:${t.tone}`} t={t} />)}
          </span>
        ) : null}
        {votes ? <span className="dev-ws-wrow-votes">{votes}</span> : null}
      </span>
      {menuKey ? <span className="dev-ws-wrow-menu"><MenuTrigger menuKey={menuKey} /></span> : null}
      {board && !live ? (
        <RowBand card={card} chips={false} trailing={specs ? <VoteButton yes={specs.yes} no={specs.no} /> : null} />
      ) : null}
    </div>
  );
}

/** A hairline-divided list of rows. */
export function WorkList({ rows, slug, openKey, onOpen, variant = 'list', category = true }: {
  rows: CardRow[];
  slug: string;
  /** `kind:id` of the item open in the panel, to highlight its row. */
  openKey?: string | null;
  onOpen?: (event: MouseEvent<HTMLAnchorElement>, ref: TopicRef) => void;
  variant?: RowVariant;
  category?: boolean;
}): ReactNode {
  return (
    <div className="dev-ws-wlist">
      {rows.map((r) => {
        const ref = topicRef(r.card);
        return (
          <WorkRow
            key={r.key}
            row={r}
            slug={slug}
            on={!!openKey && !!ref && openKey === `${ref.kind}:${ref.id}`}
            onOpen={onOpen}
            variant={variant}
            category={category}
          />
        );
      })}
    </div>
  );
}

