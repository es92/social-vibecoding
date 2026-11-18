/**
 * What the Workshop's side panel (./side-panel.tsx) offers the page it holds
 * (18 Nov 2026): close the panel, or open the same item as a full page.
 *
 * The page in the panel draws its own header pill (../topic/thread-exits.tsx)
 * with these two controls at its end, so the panel needs no bar of its own.
 * The page is mounted by AppView into a host React never looks inside, so it
 * is a separate tree: it reads the panel's actions here, at the moment of the
 * press, rather than through a context.
 */

export interface WorkshopSideActions {
  close: () => void;
  openFull: () => void;
}

let current: WorkshopSideActions | null = null;

/** The panel publishes its actions while it is open, and takes them back as it goes. */
export function setWorkshopSideActions(actions: WorkshopSideActions | null): void {
  current = actions;
}

/** The open panel's actions, or null when no panel is open. */
export function workshopSideActions(): WorkshopSideActions | null {
  return current;
}
