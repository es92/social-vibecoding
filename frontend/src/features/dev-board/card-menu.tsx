/**
 * The card's ⋯ overflow menu rows, as the only React writer below that host.
 *
 * See ./card-menu-store.ts for the split. Two things about this file are
 * deliberate and easy to undo by accident:
 *
 *   * NO onClick. The dispatch is a delegated `click` bound once on the host
 *     by `_toggleCardMenu`, and it must stay there: the menu SURVIVES a board
 *     repaint (the trigger it was anchored to is destroyed and a successor is
 *     found by key), and the handler deliberately reads the CURRENT descriptor
 *     list rather than the one captured when the menu opened. It also stamps
 *     `AppView._menuActEvent` so a popover the row opens is not dismissed by
 *     the same click as it finishes bubbling. A per-row handler would lose the
 *     first property and have to re-implement the second.
 *   * `data-menu-idx` is that handler's whole contract with these rows, and
 *     `data-menu-row` is what a screenshot request and a declared check aim
 *     at. Both are attributes rather than props for that reason.
 */

import { useStoreState } from '../../lib/use-store-state';
import { cardMenuStore, type CardMenuState } from './card-menu-store';
import { MenuIcon } from './menu-icons';

export function CardMenuView({ rows }: CardMenuState) {
  return (
    <>
      {rows.map((row, i) => (
        <button
          key={`${i}:${row.label}`}
          type="button"
          role="menuitem"
          className={row.danger ? 'dev-card-menu-item dev-card-menu-item-danger' : 'dev-card-menu-item'}
          data-menu-idx={i}
          {...(row.row ? { 'data-menu-row': row.row } : null)}
          {...(row.title ? { title: row.title } : null)}
          disabled={row.disabled}
        >
          {/*
              The icon is decorative: `aria-hidden`, and the label keeps its
              own element, so the button's accessible name is exactly the
              label text. A line icon in the row's ink (audit D08), from the
              same table the touch sheet's icons come from.
          */}
          <span className="dev-card-menu-icon" aria-hidden="true"><MenuIcon name={row.icon} /></span>
          <span className="dev-card-menu-label">{row.label}</span>
        </button>
      ))}
    </>
  );
}

export function CardMenu() {
  return <CardMenuView {...useStoreState<CardMenuState>(cardMenuStore)} />;
}
