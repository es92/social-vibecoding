/**
 * Standard (WIP)'s kit: the few components Home draws only under that look
 * (lib/skin.ts 'wip').
 *
 * Each is a class from app.css's "STANDARD (WIP)" block, which reads every
 * colour, radius, size and gap from that block's tokens (`--wip-*`), and
 * those from the shell's own (`--dc-sheet-solid`, `--app-sheet-line`,
 * `--accent`, `--text-muted`). A piece of Home that needs a card, the page's
 * filled action or a heading's link under this look takes it from here
 * instead of spelling the classes again, so the look changes in one place.
 */
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';

import { ChevronDownIcon, ChevronRightIcon, ChevronUpIcon, PlusWideIcon } from '@/components/ui/icons';

/** The look's card: the plane colour, the card radius, one inset hairline. */
export const WIP_CARD = 'wip-card';

/** A card. `on` false draws the bare box, for a caller mounted under every look. */
export function WipCard({ on = true, className, children, ...rest }: HTMLAttributes<HTMLDivElement> & { on?: boolean }) {
  const cls = [on ? WIP_CARD : '', className || ''].filter(Boolean).join(' ');
  return <div className={cls || undefined} {...rest}>{children}</div>;
}

/** A filled action: the accent gradient pill and its words, after a plus unless `glyph` is false. */
export function WipCta({ children, glyph = true, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode; glyph?: boolean }) {
  return (
    <button type="button" className="wip-cta" {...rest}>
      {glyph ? <PlusWideIcon className="wip-cta-glyph" strokeWidth="2.6" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

/**
 * A section's label as the way to all of what the section shows a part of:
 * the label's own words (and a count beside them), then a chevron, all one
 * thing to press. Right, it is a link to that page; down and up, a button
 * that unfolds the section in place and folds it back. The words on screen
 * are the section's name, so `label` says what pressing does ("See all
 * challenges").
 */
export function WipHeadMore({ direction, label, href, onClick, id, expanded, children }: {
  direction: 'right' | 'down' | 'up';
  label: string;
  /** With an address it is a link; without, a button. */
  href?: string;
  onClick?: () => void;
  id?: string;
  /** For a button that unfolds: whether the section is unfolded now. */
  expanded?: boolean;
  children: ReactNode;
}) {
  const Glyph = direction === 'down' ? ChevronDownIcon : direction === 'up' ? ChevronUpIcon : ChevronRightIcon;
  const inner = (
    <>
      {/* Plain words get a span of their own, so a look can mark the words
          alone (a count beside them is its caller's own element). */}
      {typeof children === 'string' ? <span className="wip-head-words">{children}</span> : children}
      <span className="wip-head-chevron" aria-hidden="true">
        <Glyph className="wip-head-chevron-glyph" strokeWidth="2.4" />
      </span>
    </>
  );
  if (href) {
    return <a id={id} href={href} className="wip-head-more" aria-label={label} title={label}>{inner}</a>;
  }
  return (
    <button type="button" id={id} className="wip-head-more" aria-label={label} title={label} aria-expanded={expanded} onClick={onClick}>
      {inner}
    </button>
  );
}

/**
 * A placeholder: the shape of something still on its way, so the page holds
 * its place and nothing under it moves when it lands. `shape` is what it
 * stands for (an icon, a line of words, a shorter one, a pill, a whole
 * card). Decorative: whoever draws them says "loading" once, in words.
 */
export function WipSkel({ shape }: { shape: 'icon' | 'line' | 'line-short' | 'pill' | 'card' }) {
  return <span className={`wip-skel wip-skel-${shape}`} aria-hidden="true" />;
}

/** A list row's placeholder: its icon, its two lines and its pill. */
export function WipSkelRow() {
  return (
    <span className="wip-row" aria-hidden="true">
      <WipSkel shape="icon" />
      <span className="wip-item-text wip-skel-lines">
        <WipSkel shape="line" />
        <WipSkel shape="line-short" />
      </span>
      <WipSkel shape="pill" />
    </span>
  );
}
