/**
 * The card, folded — and the fold that opens it.
 *
 * One item on the Dev screen has two sizes: the one-line ROW (icon, title,
 * number and author, a mini status band, the vote button where there is
 * one) and the dense CARD the Board has always drawn. The Workshop's lanes
 * introduced the row and the fold between them (#1787); the Board's columns
 * use the same fold now, so a column of forty items is forty rows and the
 * one you tapped, rather than forty cards. This module is where both
 * surfaces get them from, so the two can never drift apart.
 *
 * ── Either the row or the card, never both ───────────────────────────
 *
 * `CardRowView` renders ONE of the two. The row is a compressed
 * representation of the card, so opening it swaps it for the card whole
 * rather than growing a hybrid with the row as a head and the card
 * de-chromed under it (#1799 did that; it read as a third object belonging
 * to neither size). The open card carries an "Open card" pill at the end of
 * its action band, and that pill is the item's full-screen route — the same
 * link, with the same label, on both surfaces (#1884 round two). It used to
 * open the topic screen's sections in place on the Workshop and relabel to
 * "Open page ›" on a second tap, which meant one word meant two things
 * depending on which screen you had reached the card from.
 *
 * ── The item's hooks stay on, at both sizes ──────────────────────────
 *
 * Every card carries `data-issue-row` / `data-proposal-row` / `data-gov-row`
 * / `data-shared-session-row` / `data-session-chip`, and things key off
 * them: the declared checks name items by them, the live chat-count bump
 * and the flash-after-action look them up. The folded row carries the same
 * hook, so an item is findable whichever size it is at.
 *
 * What those hooks USED to do on a click is open the item full-screen,
 * through the delegated click handler app-view.js binds on `#dev-body`.
 * That handler now stands aside for any click whose path passed through a
 * `.dev-ws-rowwrap` (`AppView._inFoldWrapper`): the fold owns its clicks,
 * and the full-screen route is the link on the open card. The Workshop used
 * to get the same effect by stripping the hooks off the open card's model
 * (`withoutOpenHooks`); checking for the wrapper does the same job without
 * the model losing what the checks select on.
 *
 * One subtlety decides how that check is written. This component renders
 * through a portal, and React listens on the portal host, which sits
 * BELOW `#dev-body` — so React's handler runs first, and the state update
 * it makes is flushed in a microtask, which a real click runs between
 * listeners. By the time the event reaches `#dev-body` the row (or card)
 * that was clicked has been swapped for its other size: the target is
 * detached, and `closest()` from it cannot find the wrapper. The handler
 * reads the event's composed path instead, which is captured at dispatch.
 */

import type { ReactNode } from 'react';

import { FoldMarkIcon } from '@/components/ui/icons';

import { useMessages } from '../../../lib/i18n/react';
import { t } from '../../../lib/i18n/runtime';

import { Badge, CardIcon, ChangeTag, DevCard, edgeFor, metaLineNodes, VoteButton, useSavedVote } from './dev-card';
import { FeedThread } from './feed-thread';
import type { ActionSpec, BadgeSpec, DevCardModel, ListRow, StatusPillState } from './model';
import { pillWithSavedVote, shownPill, votedSide } from './model';

export type CardRow = Extract<ListRow, { t: 'card' }>;

/**
 * Where the open card's "Open card" pill sits. `'actions'`: at the end of
 * the action band, the card's own actions staying where they are — both
 * surfaces today. `false`: no pill at all.
 */
export type DetailPlacement = 'actions' | false;

/**
 * Call an AppView method by name. Returns whatever it returned (undefined
 * when there is no such method), so a caller that needs the outcome, such as
 * the Needs-you deck waiting on `castVote`, can have it.
 */
export function callAppView(fn: string, ...args: unknown[]): unknown {
  const av = typeof window !== 'undefined' ? (window as any).AppView : null;
  if (av && typeof av[fn] === 'function') return av[fn](...args);
  return undefined;
}

/**
 * The hooks the delegated `#dev-body` handler opens a card full-screen on,
 * and the ones the checks and the lookups name an item by. The folded row
 * carries them too — see the header.
 */
const ITEM_HOOKS = [
  'data-issue-row', 'data-proposal-row', 'data-gov-row',
  'data-shared-session-row', 'data-session-chip', 'data-discussion-row',
];

export function itemHooks(card: DevCardModel): Record<string, string> {
  const a = card.attrs || {};
  const out: Record<string, string> = {};
  for (const k of ITEM_HOOKS) if (a[k] != null) out[k] = String(a[k]);
  return out;
}

/**
 * Where "Open" leads: the card's own full-screen route, read off the hooks
 * the delegated handler reads, so the two can never disagree.
 */
export function openHref(slug: string, card: DevCardModel): string | null {
  const a = card.attrs || {};
  if (!slug) return null;
  if (a['data-issue-row']) return `#app/${slug}/dev/issues/${a['data-issue-row']}`;
  if (a['data-proposal-row']) return `#app/${slug}/dev/proposals/${a['data-proposal-row']}`;
  // #6439: a vote to close a request is decided on the request's page.
  if (a['data-close-request']) return `#app/${slug}/dev/issues/${a['data-close-request']}`;
  if (a['data-gov-row']) return `#app/${slug}/dev/governance/${a['data-gov-row']}`;
  if (a['data-shared-session-row']) return `#app/${slug}/dev/proposals/${a['data-shared-session-row']}`;
  if (a['data-session-chip']) return `#app/${slug}/dev/proposals/${a['data-session-chip']}`;
  return null;
}

/** How many of the card's own chips ride along on a folded row. */
export const ROW_BADGE_MAX = 3;

/**
 * The folded row's last line: the card's status row and facts row in one —
 * a chip of the composite pill's state, the state chips, and the vote
 * button at the right end, where the card's bar puts it. One line, clipped,
 * for the same reason the card's rows are: a band that wrapped would push
 * every row under it out of rhythm. (The message count is the meta line's,
 * with the tags, at both sizes.)
 *
 * The composite pill used to be flattened to `pill.state.label` and printed in
 * `.dev-ws-row-meta`, in the same muted grey the author's name wears — so
 * "Conflicts with main · 9 files", which is the one fact that decides whether
 * a proposal can merge at all, read like a byline. It has carried a `tone` all
 * along; this spends it.
 *
 * A `chipBtn` is rendered as a plain `chip`. The row's whole surface is the
 * disclosure, and a chip that swallowed the click to do something else would
 * make the card open sometimes and not others; the real control is still on
 * the card, one tap away.
 */
export function flatBadge(b: BadgeSpec): BadgeSpec {
  return b.t === 'chipBtn'
    ? { t: 'chip', key: b.key, cls: b.cls, label: b.label, title: b.title, spinner: b.spinner, data: b.data }
    : b;
}

/** The card's tags — priority, assignee, category — which ride on the meta line at both sizes. */
export function tagsOf(card: DevCardModel): BadgeSpec[] {
  return (card.badges || []).filter((b) => b && b.t === 'attr');
}

/**
 * The final counted vote of a change that is live (#6075): "3 yes · 1 no" (or "1/2 yes"
 * when it went live short of its threshold), read beside its "✓ Live" pill. The yes count is compared with the
 * threshold snapshotted at merge time (`StatusPillState.majority`, which
 * `statusPillState` already falls back to the live majority for legacy
 * rows); the no votes are shown only when there were some. A row with no
 * counted votes (an imported pull request) has no tally — it never reads
 * "0/1". History only: nothing here is a vote the viewer can cast again.
 */
export function liveTally(s: StatusPillState | null): { text: string; title: string } | null {
  if (!s || s.tier !== 0 || (s.key !== 'deployed' && s.key !== 'merged')) return null;
  const yes = Math.max(0, s.yes || 0);
  const no = Math.max(0, s.no || 0);
  if (yes + no <= 0) return null;
  const needed = s.majority > 0 ? s.majority : 1;
  // V05 (audit, 2 Nov 2026): with the yes it needed, or more, the count
  // stands alone ("2 yes"); "2/1 yes" read as more votes than possible.
  // What it needed stays in the title.
  const passed = yes >= needed;
  const text = no > 0
    ? (passed ? t('project:card.tally.passedNo', { yes, no }) : t('project:card.tally.yesNo', { yes, needed, no }))
    : (passed ? t('project:card.tally.passed', { yes }) : t('project:card.tally.yes', { yes, needed }));
  return { text, title: t('project:card.tally.title', { yes, no, needed }) };
}

/** The live tally beside a "✓ Live" pill, or nothing. */
export function LiveTally({ s }: { s: StatusPillState | null }): ReactNode {
  const tally = liveTally(s);
  if (!tally) return null;
  return <span className="dev-ws-wrow-tally" title={tally.title}>{tally.text}</span>;
}

export function RowBand({ card, trailing, chips: withChips = true }: {
  card: DevCardModel;
  trailing?: ReactNode;
  /**
   * The card's state chips after the bar. The board's row (#4486) passes
   * false: what those chips say is the row's tags (`_workshopBrief`), on the
   * line above, so the band is the bar and Vote alone.
   */
  chips?: boolean;
}): ReactNode {
  const s = shownPill(card);
  // #7101: a vote this page has just saved is newer than the read the row
  // came from, so the approvals count is corrected in place until the next
  // read carries it. An uncounted or advisory vote moves the face, not the
  // count (dev-card.tsx VoteButton reads the same store for its face).
  const specs = voteSpecs(card);
  const savedSide = useSavedVote(specs ? specs.yes : null);
  const afterVote = pillWithSavedVote(
    s,
    specs ? (votedSide(specs.yes) || votedSide(specs.no)) : null,
    specs && (specs.yes.uncounted || specs.yes.advisory) ? null : savedSide,
    t,
  );
  // The state chips only: the tags and the linked-issue chips are the meta
  // line's (metaLineNodes), on the row as on the card.
  // `meta` chips (the status tags) ride the row's META line, which is
  // metaLineNodes' — the same seam as the card. The band is the bar, the
  // remaining state chips and the vote.
  const chips = withChips ? (card.badges || [])
    .filter((b) => b && b.t !== 'attr' && b.t !== 'issueChip' && !(b.t === 'chip' && b.meta))
    .slice(0, ROW_BADGE_MAX) : [];
  if (!afterVote && !chips.length && !trailing) return null;
  return (
    <span className="dev-ws-row-band">
      {afterVote ? <ChangeTag s={afterVote} detail={false} /> : null}
      {chips.map((b) => <Badge key={b.key} b={flatBadge(b)} />)}
      {trailing ? <span className="dev-ws-row-trailing" onClick={(e) => e.stopPropagation()}>{trailing}</span> : null}
    </span>
  );
}

/**
 * The fold mark: which SIZE the item is at, at the top right of both.
 *
 * The same glyph at both sizes — two chevrons pointing apart — and on the
 * open card it is STRETCHED: the chevrons pushed outward with a bar drawn
 * between them, so the mark itself gets taller when the card does. Nothing
 * rotates and nothing swaps. A chevron that turns promises a direction
 * (down → up is the accordion's, right → down the tree's) and the Vote
 * button's ▾ on this same card already means a menu; what changes here is
 * size, so the mark changes size.
 *
 * On a row it is decoration: the row is the disclosure control and carries
 * `aria-expanded`. On the open card it is a real button, the one
 * keyboard-reachable way to fold the card again — the wrapper's click folds
 * it, and a click was all there was.
 *
 * One SVG with three paths (icons.tsx `FoldMarkIcon`). The state is a
 * `data-open` attribute and the geometry is CSS transforms (app.css
 * `.dev-fold-mark`), which is what lets the open state play as a 150ms
 * stretch when the card mounts.
 */
export function FoldMark({ open, onClick }: { open: boolean; onClick?: () => void }): ReactNode {
  const t = useMessages('project');
  const glyph = <FoldMarkIcon aria-hidden="true" />;
  if (!open) return <span className="dev-fold-mark" aria-hidden="true">{glyph}</span>;
  return (
    <button type="button" className="dev-fold-mark un-touch-target" data-open="1" aria-expanded="true" aria-label={t('project:card.fold.fold')} onClick={onClick}>
      {glyph}
    </button>
  );
}

/**
 * One folded row: a disclosure. It carries the item's own hooks
 * (`data-issue-row` and its siblings), and the delegated card-open handler
 * leaves it alone because it sits inside a `.dev-ws-rowwrap` — see the
 * header.
 *
 * A `div` with the button role rather than a `<button>`, because the row
 * carries real controls INSIDE it — the vote button, the number's link, the
 * tag chips — and a button cannot contain a button. A click on any of them
 * does its own job and does not toggle the row; Enter and Space on the row
 * itself toggle it.
 */
export function FoldedRow({
  row, open, onToggle,
}: { row: CardRow; open: boolean; onToggle: () => void }): ReactNode {
  const t = useMessages('project');
  const c = row.card;
  // The vote control belongs to the ROW, on every row that has one — not just
  // the ones in the vote strip. It used to ride in the dense card's status
  // band for a row inside a theme, which meant opening that row moved the
  // control from nowhere to somewhere while "Closes #N" moved the other way:
  // two objects, which is what this stops being. It sits at the right end of
  // the row's last line, which is where the card's bar puts it.
  const specs = voteSpecs(c);
  const trailing = specs ? <VoteButton yes={specs.yes} no={specs.no} /> : null;
  return (
    <div
      role="button"
      tabIndex={0}
      // The hover fill comes from the CARD's own utilities, so the two sizes
      // of one item cannot drift apart on it. app.css keeps the border.
      className={`dev-ws-row hover:bg-zinc-50 dark:hover:bg-zinc-800${open ? ' dev-ws-row-open' : ''}`}
      aria-expanded={open}
      // The card's own left edge, from the card's own function, so the two
      // sizes can never key off different state.
      data-edge={edgeFor(c)}
      data-ws-row={row.key}
      {...itemHooks(c)}
      onClick={(e) => {
        // The row's own controls do their own job: the number's link, a tag
        // chip, a "Closes #N" chip. Only the surface around them toggles.
        if ((e.target as HTMLElement | null)?.closest('a, button')) return;
        onToggle();
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); }
      }}
    >
      {/* The card's anatomy, line for line, as three SIBLINGS — which is how
          the card arranges them: a head (glyph + title), the meta line, then
          the bar row. The head holds the glyph and the title and nothing
          else, so the two lines below it start where the card's start: the
          meta line tabbed 30px in under the title (app.css mirrors the
          card's own `.dev-card-head:has(> .dev-card-icon) + .dev-card-meta`
          rule), and the bar row full-width on the padding edge.

          Both of those used to live in a text column beside the glyph, which
          started the bar row 30px in — so the one line that carries the
          state drew at two different lengths and two different left edges
          depending on which size you were looking at, and in a kanban column
          it ran out of room and ellipsised to a letter or two. The two sizes
          now differ only by the button row the card adds underneath. */}
      <span className="dev-ws-row-head">
        {c.icon ? <CardIcon spec={{ ...c.icon, small: true }} /> : null}
        <span className="dev-ws-row-title">
          {c.title.text}
          {row.fresh ? <span className="dev-ws-new">{t('project:card.fold.new')}</span> : null}
          {row.placing ? <span className="dev-ws-placing" title={t('project:card.fold.placingTitle')}>{t('project:card.fold.placing')}</span> : null}
        </span>
      </span>
      {/* The card's own meta line, node for node: number · author · when,
          the tags, the linked-issue chips. */}
      <span className="dev-ws-row-meta">{metaLineNodes(c)}</span>
      <RowBand card={c} trailing={trailing} />
      {/* The fold mark, not a chevron: a chevron promises a destination, and
          this row has none — the whole surface is a toggle that unfolds the
          card in place. A theme header still wears one, because that is
          what it does. */}
      <FoldMark open={false} />
    </div>
  );
}

/**
 * The open row: the SAME card the Board draws, at the size the Board draws
 * it, with the comment slot and the thread under it where the row carries
 * them — which, since #1884, is every surface that builds a card row.
 *
 * It used to be a hybrid — the compressed row stayed above and this card had
 * its head, meta line and status band hidden so as not to repeat it — which
 * made the open state a third object belonging to neither. The row is a
 * compressed representation OF this card, so opening one swaps it for the
 * card whole rather than growing a chimera.
 */
export function UnfoldedRow({
  row, slug, canPost, detail: placement = 'actions', onFold,
}: {
  row: CardRow; slug: string; canPost: boolean; detail?: DetailPlacement;
  /** Folds the card back to its row: what the fold mark at the card's top right does. */
  onFold?: () => void;
}): ReactNode {
  // ── "Open card" goes to the item's own page, on both surfaces ───────
  //
  // It used to do two different things under one word. On the Board it was a
  // link out. On the Workshop it opened a THIRD size in place — the card,
  // and under it every section the topic screen draws (the ledger, the About
  // sheet with its before/after tiles, the transcript), built on demand from
  // `AppView._topicViewFor` via `_workshopCardBody` — and only once that was
  // open did the same pill become the link, relabelled "Open page ›" (#1886).
  //
  // #1884 round two: one control, one action. A reader who learns what "Open
  // card" does on one screen now knows what it does on the other, which is
  // the part of that request a shared component could not deliver by itself
  // — the two surfaces were already drawing the same card, and disagreeing
  // about what its pill meant. What it costs is reading the ledger and the
  // transcript without leaving the lander; what it buys is that the word
  // stops meaning two things two taps apart. The sections did not go
  // anywhere — they are the item's page, which is where this now lands.
  //
  // Two kinds never opened in place anyway: `_workshopCardBody` answers null
  // for a session, a merged change and a governance item, so those already
  // went to the page rather than answering a tap with nothing. They were the
  // exception; this is the rule now.
  const t = useMessages('project');
  const href = openHref(slug, row.card);
  // ── Where the toggle sits ──────────────────────────────────────────
  //
  // In the card's action band, after its own pills and before the hamburger
  // and Preview (dev-card.tsx `actionEnd`), on both surfaces. The Workshop
  // used to seat it on the facts line (`statusLead`), which moved the card's
  // primary actions up beside it — right on a sheet 760px wide, but in a
  // kanban column of ~300px that ran "Create proposal · Claim this issue ·
  // Open card · Preview" past the band's clip and defeated the fold the
  // Board's card does by measuring its band. The band seat works at both
  // widths: the pills stay where the column has always drawn them and the
  // band's own measurement folds them into the menu around the toggle. So
  // it is the default now and the two surfaces draw one card, which is the
  // point of the fold.
  //
  // The one thing the fold cannot do: the item's own page, for a link
  // somebody wants to share. "Open card" IS that link, on both surfaces —
  // one anchor, one destination, and a real one, so it middle-clicks and
  // copies like any other. It used to be a second line under the sheet on
  // the Workshop ("Open on its own page ›") beside a pill that also said
  // Open, which read as the same action twice; #1886 folded the two into
  // one control and this makes that control mean one thing. Folding the
  // card back is the fold mark's job.
  // No chevron on the open card. It is the Board's "this opens" mark at the
  // card's right edge, and inside a fold a click on the card FOLDS it; the
  // way out is the link under the card. The row it folds to wears none
  // either, so nothing on the item promises a destination it does not have.
  // What both wear instead is the fold mark (`FoldMark`): stretched open
  // here, and the button that folds the card.
  const card: DevCardModel = { ...row.card, rail: { ...row.card.rail, chevron: false } };
  const openBtn = placement && href
    ? <a className="gc-vote-btn dev-ws-open-btn" href={href} data-ws-open-card={row.key}>{t('project:card.fold.openCard')}</a>
    : undefined;
  return (
    <div className="dev-feed-entry dev-ws-sheet" data-ws-sheet={row.key}>
      <DevCard model={card} actionEnd={placement ? openBtn : undefined} headEnd={<FoldMark open onClick={onFold} />} />
      {row.commentsFor != null ? (
        <div className="dev-feed-comments" data-comments-for={String(row.commentsFor)}></div>
      ) : null}
      {row.thread && slug ? (
        <FeedThread slug={slug} type={row.thread.type} refId={row.thread.ref} canPost={canPost} />
      ) : null}
    </div>
  );
}

/** The card's Yes/No vote specs, when it carries a vote (the dense card's rule). */
export function voteSpecs(card: DevCardModel): { yes: ActionSpec; no: ActionSpec } | null {
  const yes = card.actions.find((a) => /\bgc-vote-btn-yes\b/.test(a.cls || ''));
  const no = card.actions.find((a) => /\bgc-vote-btn-no\b/.test(a.cls || ''));
  return yes && no ? { yes, no } : null;
}

/**
 * One card, in whichever size it is currently at: the head, and — when it is
 * open — the body under it, inside the same sheet.
 *
 * This was five near-identical copies (one per Workshop strip) plus a
 * `VoteRow` that differed only in passing the vote button down. The vote
 * button belongs to every row now (see `FoldedRow`), so the copies had
 * nothing left to differ about — and the Board's columns are a sixth caller.
 */
export function CardRowView({
  row, slug, canPost, open, onToggle, detail,
}: {
  row: CardRow; slug: string; canPost: boolean; open: boolean; onToggle: () => void;
  /** Where "Open card" sits on the open card: the action band, on both surfaces. */
  detail?: DetailPlacement;
}): ReactNode {
  // EITHER the compressed row OR the card — never both. The two are one item
  // at two sizes, and drawing them together is what made the open state read
  // as a panel hanging off a row.
  //
  // Clicking the open card closes it. Everything interactive inside it is
  // excluded by the same guard the delegated handler uses, plus the thread's
  // composer and the chips that are real buttons: a click on Vote, on the ⋯,
  // on "Closes #12" or in the reply box must do its own job and nothing else.
  //
  // The handler goes on the wrapper rather than on a div around the sheet:
  // the sheet is a DIRECT child of `.dev-ws-rowwrap-open`, and a declared
  // check selects it that way. An intermediate element to hang onClick on
  // is invisible in a diff and breaks that selector.
  return (
    <div
      className={open ? 'dev-ws-rowwrap dev-ws-rowwrap-open' : 'dev-ws-rowwrap'}
      onClick={open ? (e) => {
        const el = e.target as HTMLElement | null;
        // Controls do their own job. So do the two REGIONS below the card:
        // with a thread and a comment list open under it there is a lot of
        // prose to land on, and collapsing the whole item because somebody
        // selected a word in it is not a fold, it is losing their place.
        //
        // `details` is the merge-requirements checklist (#2061, dev-card.tsx
        // RequirementsRow). Its summary line — "Nothing needs you", "Waiting
        // on an admin" — is the disclosure a reader taps to see the steps,
        // and the same tap used to fold the card, which unmounted the list
        // they had just opened (#2128). The whole element is excluded, not
        // the summary alone: once open it is a list to read, like the three
        // regions below.
        if (el && el.closest(
          'a, button, input, textarea, select, form, details, [data-attr-chip], [data-issue-chip],'
          + ' .dev-feed-thread, .dev-feed-comments',
        )) return;
        onToggle();
      } : undefined}
    >
      {open ? (
        <UnfoldedRow row={row} slug={slug} canPost={canPost} detail={detail} onFold={onToggle} />
      ) : (
        <FoldedRow row={row} open={open} onToggle={onToggle} />
      )}
    </div>
  );
}
