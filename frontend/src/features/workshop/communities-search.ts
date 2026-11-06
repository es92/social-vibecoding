/**
 * THE SIDEBAR'S SEARCH (D, 18 Oct 2026).
 *
 * The Recents heading in the desktop's sidebar of rows shows a search glyph
 * while it is hovered (../nav/rail-communities.tsx). It opened the
 * Communities screen with the search at the top of its list focused; that
 * list is Home's since One Home (#6361), so the glyph opens Home with its
 * search box focused, which finds your apps and communities by name
 * (Home.focusSearch).
 */

import { closeSwitcher } from './community-scope';

/** Home, with its search box focused. */
export function openCommunitiesSearch(): void {
  closeSwitcher();
  const win = window as unknown as { Home?: { focusSearch?: () => void }; App?: { navigateHome?: () => void } };
  if (win.Home?.focusSearch) win.Home.focusSearch();
  else win.App?.navigateHome?.();
}
