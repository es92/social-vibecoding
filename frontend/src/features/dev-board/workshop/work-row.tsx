/**
 * The Workshop's row (#4457, #4486): one item, in one hairline-divided list.
 *
 * ONE ROW, FOUR SURFACES. A week's page on the Workshop tab, All items'
 * board columns and its By category lanes all draw this row now (#4486),
 * and the Workshop tab's Your work draws it in What happened's one-line
 * shape (variant `line`, #4716); the Workshop tab's New for you draws its
 * shorter sibling, `ActRow`, below (After-Workshop-B), and its What happened
 * its own one-line row (./week-pages.tsx HappenedRow). The board and By
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

import { useRef, type MouseEvent, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import {
  BallotIcon, ChatBubbleTailIcon, CheckIcon, EyeIcon, LockIcon, PencilSquareIcon,
  SparklesIcon,
} from '@/components/ui/icons';

import { useMessages } from '../../../lib/i18n/react';
import { t as translate } from '../../../lib/i18n/runtime';
import { CategoryChip, ChatCount, ChecksBar, MenuTrigger, VoteButton } from '../card/dev-card';
import { callAppView, itemHooks, openHref, RowBand, StatePill, voteSpecs } from '../card/fold';
import type { ActionSpec, DevCardModel, ListRow, RowBrief, RowTag } from '../card/model';

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
export type RowVariant = 'list' | 'board' | 'line';

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
} = {}): string {
  const parts: string[] = [];
  for (const lead of typeof opts.lead === 'string' ? [opts.lead] : (opts.lead || [])) if (lead) parts.push(lead);
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

function Tag({ t }: { t: RowTag }): ReactNode {
  return (
    <span className="dev-ws-tag" data-tone={t.tone} title={t.title || (t.short ? t.label : undefined)}>
      {t.tone === 'run' ? <span className="dc-status-spinner-arc" aria-hidden="true" /> : null}
      {t.tone === 'ok' ? <CheckIcon aria-hidden="true" /> : null}
      {t.glyph === 'eye' ? <EyeIcon aria-hidden="true" /> : null}
      {t.glyph === 'lock' ? <LockIcon aria-hidden="true" /> : null}
      {t.glyph === 'bot' ? <SparklesIcon aria-hidden="true" /> : null}
      {t.short ? <><span aria-hidden="true">{t.short}</span><span className="sr-only">{t.label}</span></> : t.label}
      {t.progress ? <ChecksBar progress={t.progress} /> : null}
    </span>
  );
}

/**
 * Your work's tags line, most important first (#4716): what is wrong, then
 * what needs attention, what is running, what is done, then the rest. The
 * line keeps to one line and scrolls sideways, so what comes first is what
 * shows. A tag's tone says how much it matters, whatever its words.
 */
const TAG_RANK: Record<RowTag['tone'], number> = { bad: 0, warn: 1, run: 2, ok: 3, plain: 4 };

/**
 * A row's tags as the Workshop's own-work rows read them: what the work
 * needs, most important first (TAG_RANK), and apart from them who made it
 * when that is not simply you. Live work drops the tag its pill already
 * says (AppView._workshopBrief `settled`, "Going live…" on a release still
 * under way), and the preview tag stays on the item's page: these rows are
 * what the work needs, and a preview is there to open, not to act on.
 *
 * Who made it is said at most once, never as a name in the words. What you
 * made says nothing: everything here is yours unless it says otherwise.
 * Homeroom bot's change from your request says so with its tag (#4728),
 * and a private session of yours keeps its "Only you". A request you are
 * working on names nobody here: it is often somebody else's, its words say
 * who asked, and its "Picked up · you" already says you are on it.
 */
export function lineTags(b: RowBrief, card: DevCardModel): { ranked: RowTag[]; maker: RowTag | null } {
  const pill = card.pill?.state || null;
  const said = b.kind === 'live' && pill ? pill.label : null;
  const tags = (said !== null ? b.tags.filter((t) => t.tone !== 'ok' && t.label !== said) : b.tags)
    .filter((t) => t.glyph !== 'eye');
  const maker = b.kind === 'request' ? null
    : tags.find((t) => t.glyph === 'bot') || (b.mine ? tags.find((t) => t.glyph === 'lock') : undefined) || null;
  return { ranked: tags.filter((t) => t !== maker).sort((x, y) => TAG_RANK[x.tone] - TAG_RANK[y.tone]), maker };
}

/**
 * A change's vote on the Workshop tab (#4486): the card's own status pill,
 * with its own words ("0 of 1 approval"), at its words' width plus the 56px
 * the thin bar it replaces took (app.css `.dev-ws-wvote-state`), and the
 * card's own Vote button. #4718: the pair takes a line of its own under the
 * tags, at the row's far end, on every width — it never shares the tags'
 * line, so rows beside each other keep their pills lined up.
 */
function Votes({ card }: { card: DevCardModel }): ReactNode {
  const s = card.pill?.state || null;
  const specs = voteSpecs(card);
  if (!s && !specs) return null;
  return (
    <span className="dev-ws-wvote" data-ws-vote="">
      {s ? <StatePill s={s} className="dev-ws-wvote-state" /> : null}
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
  const linkRef = useRef<HTMLAnchorElement>(null);
  const b = row.brief;
  if (!b) return null;
  const card = row.card;
  const board = variant === 'board';
  const href = openHref(slug, card);
  const ref = topicRef(card);
  const Tile = TILE[b.kind] || PencilSquareIcon;
  const pill = card.pill?.state || null;
  // Live work leads its tags with the card's own bar at its words' width
  // ("✓ Live"), in place of the small Live tag the brief carries. On a live
  // row that tag is the brief's one `ok` tag (AppView._workshopBrief: a merged
  // item carries only its settled state, and Live is the settled state that
  // is done), so it is left out by what it is, never by its words, which are
  // in the language on screen.
  const live = b.kind === 'live' && !!pill;
  const tags = live ? b.tags.filter((t) => t.tone !== 'ok') : b.tags;
  const hasChip = category && (card.badges || []).some((x) => x && x.t === 'attr' && x.field === 'category');
  const hasChat = (card.chatCount || 0) > 0;
  const chip = hasChip ? <CategoryChip card={card} /> : null;
  const chat = hasChat ? <ChatCount card={card} /> : null;
  // The Workshop tab's bar and Vote take a line of their own under the tags
  // (#4718), at the row's far end; the board's ride the band under it.
  const votes = !board && b.vote ? <Votes card={card} /> : null;
  const status = live || hasChip || hasChat || tags.length > 0;
  const menuKey = card.rail && card.rail.menuKey ? card.rail.menuKey : '';
  const specs = board && !live ? voteSpecs(card) : null;
  if (variant === 'line') {
    // #4716: Your work in This week's one-line row. The first line is the
    // small glyph, the title on one line and, at its end, the card's status
    // pill with Vote (live work: its "✓ Live" bar), as This week ends its
    // line with the time; the second is the item's number and what it is
    // for, its tags most important first, then who made it, on one line.
    // A narrow card wraps the title and moves the pill and Vote to the
    // row's end, under the tags, as a phone has them today (app.css
    // `.dev-ws-lrow`).
    const end = votes || (live && pill ? <StatePill s={pill} className="dev-ws-wrow-live" /> : null);
    // Live work's bar is on the first line, so its tags drop the one that
    // restates it; who made it goes after the status tags (lineTags).
    const request = b.kind === 'request';
    const { ranked, maker } = lineTags(b, card);
    return (
      <div
        className="dev-ws-wrow dev-ws-lrow"
        data-ws-row={row.key}
        data-ws-kind={b.kind}
        data-ws-open={ref ? `${ref.kind}:${ref.id}` : undefined}
        data-on={on ? '1' : undefined}
      >
        <span className="dev-ws-hrow-glyph" data-kind={b.kind} aria-hidden="true"><Tile aria-hidden="true" /></span>
        <span className="dev-ws-wrow-main">
          <span className="dev-ws-lrow-line">
            {href ? (
              <a
                ref={linkRef}
                className="dev-ws-wrow-link"
                href={href}
                aria-current={on ? 'true' : undefined}
                onClick={ref && onOpen ? (e) => onOpen(e, ref) : undefined}
              >
                {card.title.text}
              </a>
            ) : <span className="dev-ws-wrow-link">{card.title.text}</span>}
            {end}
          </span>
          {/* One line that scrolls sideways (app.css), so it sits above the
              row's stretched link; a click on it that is not on a chip opens
              the item, as a click anywhere else on the row does. */}
          <span
            className="dev-ws-wrow-status"
            onClick={(e) => {
              if ((e.target as Element).closest('a, button')) return;
              linkRef.current?.click();
            }}
          >
            <span className="dev-ws-wrow-sub">{rowWords(b, { by: request || !(maker || b.mine), ago: false })}</span>
            {ranked.map((t) => <Tag key={`${t.label}:${t.tone}`} t={t} />)}
            {maker ? <Tag t={maker} /> : null}
            {chip}
            {chat}
          </span>
        </span>
        {menuKey ? <span className="dev-ws-wrow-menu"><MenuTrigger menuKey={menuKey} /></span> : null}
      </div>
    );
  }
  return (
    <div
      className={board ? 'dev-ws-wrow dev-ws-brow' : 'dev-ws-wrow'}
      data-ws-row={row.key}
      data-ws-kind={b.kind}
      data-ws-open={ref ? `${ref.kind}:${ref.id}` : undefined}
      data-on={on ? '1' : undefined}
      {...(board ? itemHooks(card) : {})}
    >
      {board ? null : <span className="dev-ws-wrow-tile" data-kind={b.kind} aria-hidden="true"><Tile aria-hidden="true" /></span>}
      <span className="dev-ws-wrow-main">
        {href ? (
          <a
            className="dev-ws-wrow-link"
            href={href}
            aria-current={on ? 'true' : undefined}
            onClick={ref && onOpen ? (e) => onOpen(e, ref) : undefined}
          >
            {card.title.text}
          </a>
        ) : <span className="dev-ws-wrow-link">{card.title.text}</span>}
        <span className="dev-ws-wrow-sub">{rowWords(b)}</span>
        {status ? (
          <span className="dev-ws-wrow-status">
            {live && pill ? <StatePill s={pill} className="dev-ws-wrow-live" /> : null}
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

/**
 * The card's own next step, when it has one: a request's primary act (Ask
 * Homeroom bot to build this, Build it now, See progress, …:
 * AppView._issuePrimaryActionSpec) or an imported change's Ask for
 * approval. Never a disabled one ("Homeroom bot is building…"), which is a
 * state, and the row's line in words already says where it stands.
 */
export function primaryAct(card: DevCardModel): ActionSpec | null {
  return (card.actions || []).find((a) => (a.key === 'primary' || a.key === 'promote') && !!a.act && !a.disabled) || null;
}

/**
 * One of the card's acts as a row's button: the shell's neutral pill, which
 * calls the AppView method the act names, as the card's own pill does
 * (dev-card.tsx ActionButton), the button itself last when the act asks for
 * it. `label` replaces the act's words where the row says it shorter; the
 * act's own words are then its tooltip.
 */
export function ActButton({ a, label, accent = false }: { a: ActionSpec; label?: string; accent?: boolean }): ReactNode {
  return (
    <Button
      type="button"
      variant={accent ? 'pillAccent' : 'pillNeutral'}
      ink={accent ? 'solid' : 'neutral'}
      size="sm"
      className="un-touch-target"
      data-act={a.act?.fn}
      title={label ? (a.title || a.label) : a.title}
      onClick={(e) => {
        if (!a.act) return;
        callAppView(a.act.fn, ...(a.act.args || []), ...(a.passNode ? [e.currentTarget] : []));
      }}
    >
      {label || a.label}
    </Button>
  );
}

/**
 * A row with one thing to do (After-Workshop-B): the Workshop's Your work
 * and New for you. The tile, the title (the item's link, stretched over the
 * row, as WorkRow's is, and opened beside the list on a wide window through
 * `onOpen`), one line in words the caller words, and at most one action at
 * the row's end: a Vote, the card's own next step, or Build it. No tags
 * line and no ☰: everything else there is to do is on the item's page, a
 * tap away. On a phone the action goes under the words (app.css).
 */
export function ActRow({
  row, slug, sub, act = null, tone, on = false, onOpen,
}: {
  row: CardRow;
  slug: string;
  /** The row's one line in words. */
  sub: string;
  act?: ReactNode;
  /** `ask`: the item waits on the viewer, and its tile says so in the attention tint. */
  tone?: 'ask';
  on?: boolean;
  onOpen?: (event: MouseEvent<HTMLAnchorElement>, ref: TopicRef) => void;
}): ReactNode {
  // The line in words is read with `translate`; subscribe the row.
  useMessages('project');
  const b = row.brief;
  if (!b) return null;
  const card = row.card;
  const href = openHref(slug, card);
  const ref = topicRef(card);
  const Tile = TILE[b.kind] || PencilSquareIcon;
  return (
    <div
      className="dev-ws-wrow dev-ws-arow"
      data-ws-row={row.key}
      data-ws-kind={b.kind}
      data-ws-open={ref ? `${ref.kind}:${ref.id}` : undefined}
      data-on={on ? '1' : undefined}
    >
      <span className="dev-ws-wrow-tile" data-kind={b.kind} data-tone={tone} aria-hidden="true"><Tile aria-hidden="true" /></span>
      <span className="dev-ws-wrow-main">
        {href ? (
          <a
            className="dev-ws-wrow-link"
            href={href}
            aria-current={on ? 'true' : undefined}
            onClick={ref && onOpen ? (e) => onOpen(e, ref) : undefined}
          >
            {card.title.text}
          </a>
        ) : <span className="dev-ws-wrow-link">{card.title.text}</span>}
        {sub ? <span className="dev-ws-wrow-sub">{sub}</span> : null}
      </span>
      {act ? <span className="dev-ws-arow-act">{act}</span> : null}
    </div>
  );
}
