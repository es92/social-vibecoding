import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';
import { ChevronRightIcon } from './icons';

/**
 * The grouped list: SECTION LABEL over a white card of hairline-separated rows.
 *
 * This is the widget language's primary content shape — every screen in the
 * design deck is built out of it (the Changes list's Feedback/Previews/
 * Decisions groups, Home's "Your saved apps", the Activity feed's app card).
 *
 * ── Why this is a NEW primitive rather than a restyled old one ─────────
 *
 * Nothing in the shell drew this before. The pre-reskin shell separated
 * content with borders on a white page: a "card" was a bordered rectangle
 * flush against the same background as everything around it. The language
 * separates by FIGURE/GROUND instead — a white card floating on the grey page
 * ground now set in BODY_ATTRS (frontend/scripts/build-shell.mjs) — so the
 * card carries no border at all, and the only rule inside it is the row
 * separator.
 *
 * ── The separator is a pseudo-element, deliberately ───────────────────
 *
 * Rows are separated by a hairline INSET to the text column (it starts where
 * the title starts, not at the card's edge), and the last row has none. Three
 * ways to do that; this file uses the third:
 *
 *   * `divide-y` — can't inset, and would draw under the icon tile.
 *   * a border on every row but the last — needs the caller to know which row
 *     is last, which it usually doesn't (rows come from a `.map`).
 *   * `[&:not(:last-child)]:after:*` on the row — no caller knowledge needed,
 *     survives conditional rows, and insets to wherever we say.
 *
 * The inset (`start-[4.75rem]`) is the row's padding (1rem) + the icon tile
 * (2.75rem) + the gap (1rem). It is a literal rather than a computed value
 * because Tailwind's extractor is a regex over source text — see the note in
 * tailwind.config.js. A row rendered WITHOUT a leading tile passes
 * `inset="none"` and the hairline runs the full width.
 */

/**
 * THE SECTION LABEL IS SMALL CAPS: 12px, bold, uppercase, tracked. It names
 * the card under it; it is not a line of text in its own right, and at the
 * body's 15px in grey it read as one, the same size as the rows' own titles,
 * so a screen of three sections looked like a screen of three paragraphs.
 * Small and tracked is the label every grouped list in the design reference
 * wears (AGENTS.md, "Type and colour"), and it is the one place in the shell
 * that is uppercase. dark:text-zinc-400 for the contrast reason the row's
 * subtitle gives below.
 */
export function SectionHeader({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2
      className={cn('px-4 pb-2 pt-6 text-xs font-bold uppercase tracking-[0.06em] text-zinc-500 dark:text-zinc-400', className)}
      {...props}
    />
  );
}

/*
 * ── Tone ──────────────────────────────────────────────────────────────
 *
 * `card` (the default) is the white card the deck draws. `plane` is the warm
 * off-white the Discover pane and the sheets use: app.css `--dc-sheet-solid`,
 * the pane glass over the wallpaper made solid, which already follows the
 * dark theme. A screen that sits on the wallpaper asks for it so its lists
 * read as the same material as Discover rather than as white cutouts.
 * `PLANE_FILL` is the same class for a card that is not a list (a profile
 * header, a stat tile), so the literal lives once, here, where Tailwind's
 * extractor sees it.
 */
export const PLANE_FILL = 'bg-[color:var(--dc-sheet-solid)]';

/**
 * A CARD THAT IS NOT A LIST, in the list's own recipe: the plane colour, the
 * 20px radius and the one inset hairline below. The You page drew its hero,
 * stat cards and "This week" as `rounded-2xl` plane cards with no hairline
 * beside lists that had one, so half its cards had an edge and half did not
 * (phone review #99, 23 Nov 2026). One literal, here, beside the list's.
 */
export const PLANE_CARD = 'rounded-[20px] bg-[color:var(--dc-sheet-solid)] shadow-[inset_0_0_0_1px_var(--app-sheet-line)]';

/*
 * ONE HAIRLINE AND A 20px RADIUS (AGENTS.md, "Type and colour"). Figure and
 * ground still do the separating; the hairline is what keeps the card's edge
 * where it is when the ground under it is the pale end of the wallpaper and
 * the plane colour is a point or two off it, which is most of a phone
 * screen. Inset, as a shadow, so it adds no width and a row's own hairline
 * inset (below) still lands where the tile ends. The colour is
 * `--app-sheet-line`, the sheets' own edge, which already has its dark value.
 */
const groupedList = cva('ui-glist mx-4 overflow-hidden rounded-[20px] shadow-[inset_0_0_0_1px_var(--app-sheet-line)]', {
  variants: {
    tone: {
      card: 'bg-white dark:bg-zinc-900',
      plane: 'bg-[color:var(--dc-sheet-solid)]',
    },
  },
  defaultVariants: { tone: 'card' },
});

export function GroupedList({ className, tone, ...props }: React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof groupedList>) {
  return (
    <div
      className={cn(groupedList({ tone }), className)}
      {...props}
    />
  );
}

export const rowSeparator = cva('', {
  variants: {
    inset: {
      // The three inset depths the deck uses, as complete literals.
      tile: "[&:not(:last-child)]:after:absolute [&:not(:last-child)]:after:bottom-0 [&:not(:last-child)]:after:start-[4.75rem] [&:not(:last-child)]:after:end-0 [&:not(:last-child)]:after:h-px [&:not(:last-child)]:after:bg-zinc-200 dark:[&:not(:last-child)]:after:bg-zinc-800 [&:not(:last-child)]:after:content-['']",
      text: "[&:not(:last-child)]:after:absolute [&:not(:last-child)]:after:bottom-0 [&:not(:last-child)]:after:start-4 [&:not(:last-child)]:after:end-0 [&:not(:last-child)]:after:h-px [&:not(:last-child)]:after:bg-zinc-200 dark:[&:not(:last-child)]:after:bg-zinc-800 [&:not(:last-child)]:after:content-['']",
      none: '',
    },
  },
  defaultVariants: { inset: 'tile' },
});

export interface ListRowProps
  // `title` is omitted from the DOM attributes because ours is a ReactNode and
  // HTMLAttributes' is the tooltip string. Same reason in QuoteCard and
  // StackedTitle below — an intersection would silently narrow ours to string.
  //
  // AnchorHTMLAttributes rather than HTMLAttributes so `href`, `target` and
  // `rel` reach the element for `as="a"` (see below). Its own `type` — the
  // anchor's MIME hint — is omitted because this component writes a button's
  // `type`, and two meanings on one prop name is a trap rather than a union.
  extends Omit<React.AnchorHTMLAttributes<HTMLElement>, 'title' | 'type'>,
    VariantProps<typeof rowSeparator> {
  /**
   * The element to render. `button` for a row that DOES something — which is
   * most of them, and is why this exists: a row with an `onClick` on a `<div>`
   * is invisible to keyboard and assistive tech, and wrapping every call site
   * in its own button would put the focus ring around the row instead of on
   * it. `div` stays the default for a row that is only ever read.
   *
   * `a` for a row that NAVIGATES, and it is not interchangeable with `button`:
   * cmd/ctrl-click, middle-click, "open in new tab", the context menu, the
   * status bar and drag-to-bookmark are all the browser's to give, and only an
   * anchor with an href gets them. The shell takes that seriously enough that
   * #back-btn and the app chip's own menu rows are anchors for this reason —
   * so a grouped-list row that is a link should be one too, rather than a
   * button that assigns `location`.
   *
   * A row that WRAPS its own controls cannot be one (nested interactives are
   * invalid inside an anchor); features/apps/browse-list.tsx is that case, and
   * it keeps `div` plus NavLink's modified-click interception instead.
   *
   * `label` for a row that IS one setting: a switch or a checkbox in
   * `trailing`, and the whole row its label, so pressing the name or the
   * sentence under it toggles it as pressing the switch does (Settings'
   * notification and privacy switches). A label holds no block elements, so
   * the row's own lines are spans there.
   */
  as?: 'div' | 'button' | 'a' | 'label';
  /**
   * For `as="button"` only. Anchor attributes have no `disabled`, so it is
   * named here rather than smuggled through a cast: a ?demo= fixture renders
   * the control it cannot let navigate as a real, inert button
   * (features/settings/social-identity.tsx).
   */
  disabled?: boolean;
  /**
   * The DOM `title` TOOLTIP.
   *
   * It needs its own name because `title` is this component's row CONTENT (see
   * the Omit above), so a caller that wants a hover hint as well as a row
   * label has no other way to ask for one — and dropping the hint was the last
   * thing keeping the app detail page's rows hand-rolled (#2446). Rendered as
   * the attribute, so `undefined` writes nothing at all.
   *
   * #6118: a caller whose title can be ellipsised passes the same string here,
   * as `bot-slots.tsx` and `thread-items.tsx` do. It is opt-in rather than
   * implied by a string title: a fixed label ("Your work") truncates nothing,
   * and a hint on it is noise.
   */
  tooltip?: string;
  /** The leading rounded-square glyph tile. */
  leading?: React.ReactNode;
  title: React.ReactNode;
  /** The grey second line — "Private, 3m ago agent finished". */
  subtitle?: React.ReactNode;
  /** Unread/attention marker, drawn between the subtitle and the chevron. */
  dot?: boolean;
  /** Trailing disclosure chevron. On by default; a non-navigating row turns it off. */
  chevron?: boolean;
  /** Anything else on the trailing edge (a count pill, a switch, a state circle). */
  trailing?: React.ReactNode;
  /**
   * What sits UNDER the title and the subtitle, in the text column: a meter,
   * a line of controls, a short list (Settings' AI grants: the day's spend
   * bar and the cap field under the app's name). Nothing when absent, so the
   * row is the standard one or two lines.
   */
  children?: React.ReactNode;
  /**
   * Extra classes for the title line, merged over its defaults.
   *
   * The default is a 600 weight at 16px (15px from 768px), which is right for the rows this
   * primitive was built for — a conversation, an app, a notification — where
   * the title is the row's subject and a subtitle sits under it. A settings MENU is the
   * other kind of grouped list: every row is one word, there are no subtitles,
   * and bolding all of them makes a page of headings with nothing under them.
   * Rather than fork the primitive, such a caller passes a weight here.
   */
  titleClassName?: string;
  /** Optional layout hooks; defaults retain the standard single-line row. */
  contentClassName?: string;
  subtitleClassName?: string;
}

/**
 * Whether a caller's classes for a line set a size of their own. Then the
 * line is that size at every width: the desktop's step down (`md:`) is the
 * default ramp's, and left in it would outrank the caller's size from 768px,
 * because tailwind-merge keeps a breakpoint's class beside a plain one.
 */
function ownSize(extra?: string): boolean {
  return !!extra && !cn('text-base', extra).split(' ').includes('text-base');
}

/**
 * forwardRef because callers mount BEHAVIOUR on the row element: the browse
 * directory hands its node to NavLink so a modified click opens a new tab, and
 * a kit gesture would attach the same way. A primitive that swallows the ref
 * pushes those callers back into a wrapper div — which is the layout the row
 * exists to provide in the first place.
 */
export const ListRow = React.forwardRef<HTMLElement, ListRowProps>(function ListRow({
  className, leading, title, subtitle, dot, chevron = true, trailing, inset, as = 'div',
  titleClassName, contentClassName, subtitleClassName, tooltip, children, ...props
}, ref) {
  const Tag = as;
  // Inside a <label> the lines are spans (a label holds phrasing content
  // only); `block` keeps them the lines they are everywhere else.
  const Line = as === 'label' ? 'span' : 'div';
  // A row with no tile has nothing to inset the hairline PAST, so it falls back
  // to the text inset rather than leaving a gap the eye reads as a broken rule.
  const depth = inset ?? (leading ? 'tile' : 'text');
  return (
    <Tag
      ref={ref as React.Ref<HTMLDivElement & HTMLButtonElement & HTMLAnchorElement & HTMLLabelElement>}
      // `text-start w-full` only matter on a button — a button centres its
      // content and shrinks to it, which would break the row's layout the
      // moment `as` changed. Harmless on a div, so they are unconditional
      // rather than a second branch to keep in step. An anchor needs neither
      // (`flex` blockifies it) and takes no `type`.
      {...(as === 'button' ? { type: 'button' as const } : null)}
      className={cn(
        'ui-lrow relative flex w-full items-center gap-4 px-4 py-3.5 text-start',
        (props.onClick || as === 'button' || as === 'a' || as === 'label') && 'cursor-pointer active:bg-zinc-50 dark:active:bg-zinc-800',
        // A row that names the page open beside its list (a conversation in
        // the Messages column) is lit in the "where you are" tint, as the
        // sidebar's current row is (AGENTS.md, "One accent"). Only `page`:
        // `step` and `true` mark other things on other lists.
        'aria-[current=page]:bg-[color:var(--lit-tint)]',
        rowSeparator({ inset: depth }),
        className,
      )}
      title={tooltip}
      {...props}
    >
      {leading}
      <Line className={cn('ui-lrow-tx min-w-0 flex-1', as === 'label' && 'block', contentClassName)}>
        {/* 16 OVER 14 ON A PHONE, 15 OVER 13 FROM 768px (AGENTS.md, "Type
            and colour"; the design review of 25 Nov 2026). The title was 17px
            bold over a 15px subtitle: the size of a heading, on every row,
            so a list of five rows read as five headings and the one real
            heading above them had nothing left to be louder with. Then it
            was 15/650 over 13 everywhere, which on a phone read small beside
            the system's own lists. Now the row's subject is 16px at 600 and
            the fact under it 14px grey on a phone, a step down each at a
            desktop's reading distance. */}
        <Line className={cn(
          'ui-lrow-t truncate text-base font-semibold leading-[1.3125rem] text-zinc-900 dark:text-zinc-100',
          ownSize(titleClassName) ? null : 'md:text-[0.9375rem] md:leading-5',
          as === 'label' && 'block',
          titleClassName,
        )}>{title}</Line>
        {/* dark:text-zinc-400, not -500 (QA 2026-09-24 Q20): zinc-500 is
            3.54:1 on the #0b0b0c page and 3.06 on a zinc-900 card, the
            Discover rows' and the Me screen's meta lines. zinc-400 is 6.0 and
            5.2, and is still the quiet line under a bold title. */}
        {subtitle ? (
          <Line className={cn(
            'ui-lrow-s mt-0.5 truncate text-sm leading-[1.1875rem] text-zinc-500 dark:text-zinc-400',
            ownSize(subtitleClassName) ? null : 'md:text-[0.8125rem] md:leading-[1.125rem]',
            as === 'label' && 'block',
            subtitleClassName,
          )}>{subtitle}</Line>
        ) : null}
        {children}
      </Line>
      {dot ? (
        <span className="h-2 w-2 shrink-0 rounded-full bg-zinc-900 dark:bg-zinc-100" aria-hidden="true" />
      ) : null}
      {trailing}
      {chevron ? (
        <ChevronRightIcon className="ui-lrow-go h-5 w-5 shrink-0 text-zinc-300 dark:text-zinc-600" aria-hidden="true" />
      ) : null}
    </Tag>
  );
});

/**
 * THE ROW'S TRAILING FACTS: a short line level with the title (a time, "2h")
 * and, under it, an optional one level with the subtitle (a count, "2 new").
 * The Messages inbox drew this pair by hand inside its own row, the time at
 * the end of the name's line and the count at the end of the preview's; as
 * the row's `trailing` it is the same two facts in one column, so the title
 * and the subtitle keep the row's whole width to truncate in.
 *
 * Each line keeps its line's height (the title's and the subtitle's, at
 * both sizes), and the second is drawn even when it is empty, so the first
 * always sits on the title's line rather than drifting to the row's middle
 * when there is no count. `tone` says which line asks to be read: `strong`
 * puts the first in the ink (something new since you last looked), `quiet`
 * leaves both grey. The second line is grey and semibold either way: new to
 * read, not waiting on you (AGENTS.md, "One accent").
 */
const rowMetaTop = cva(
  'ui-lrow-mt whitespace-nowrap text-sm leading-[1.3125rem] tabular-nums md:text-[0.8125rem] md:leading-5',
  {
    variants: {
      tone: {
        quiet: 'text-zinc-500 dark:text-zinc-400',
        strong: 'font-semibold text-zinc-900 dark:text-zinc-100',
      },
    },
    defaultVariants: { tone: 'quiet' },
  },
);

export interface ListRowMetaProps extends VariantProps<typeof rowMetaTop> {
  /** The fact level with the title: usually a `<time>` with its whole instant in `title`. */
  top?: React.ReactNode;
  /** The fact level with the subtitle, or nothing (its line is kept). */
  bottom?: React.ReactNode;
  className?: string;
}

export function ListRowMeta({ top, bottom, tone, className }: ListRowMetaProps) {
  return (
    <span className={cn('ui-lrow-m flex shrink-0 flex-col items-end', className)}>
      <span className={rowMetaTop({ tone })}>{top}</span>
      <span className="ui-lrow-mb mt-0.5 min-h-[1.1875rem] whitespace-nowrap text-sm font-semibold leading-[1.1875rem] text-zinc-500 md:min-h-[1.125rem] md:text-[0.8125rem] md:leading-[1.125rem] dark:text-zinc-400">{bottom}</span>
    </span>
  );
}
