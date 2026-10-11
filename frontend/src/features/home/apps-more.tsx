/**
 * `#home-apps-more` — "Show all N apps", the collapsed grid's way out.
 *
 * It has always lived OUTSIDE `#app-list` so the grid's re-render could not
 * take the button away mid-click. That is still why it is a separate host;
 * what changes is that it is no longer re-rendered by hand on every paint,
 * so the listener that `_renderAppsMore` re-attached each time is attached
 * once, by React, to an element that survives.
 */

import { useMessages } from '../../lib/i18n/react';
import { useStoreState } from '../../lib/use-store-state';
import { chromeStore } from './chrome-store';
import { CreateCompact } from './create-tile';
import type { CreateTileView } from './grid-store';
import { gridStore } from './grid-store';

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).Home : null) || null;
}

const MORE_BTN = 'rounded-lg px-3 py-1.5 text-xs font-medium text-violet-700 '
  + 'dark:text-violet-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors';

/**
 * The host, as a pure function of what drives it: the count and, since #4757,
 * the held-back Create view. Split from the store-connected wrapper below for
 * the same reason `WidgetStripBody` is: the button's behaviour was executed
 * coverage before the conversion (it was a listener `_renderAppsMore`
 * attached), and a component that reads a store through a hook cannot be
 * called as a function to get at its handler.
 *
 * #4757: when the collapsed grid held the Create tile back (#3047) it used to
 * vanish entirely. Now the "Show all N apps" line carries a compact New
 * project entry beside the button, so creating stays one tap away without
 * expanding the grid — and without adding a tile row (#3047's point). With
 * the tile in the grid, or no more apps to show, the markup is exactly what
 * it always was.
 */
export function AppsMoreBody({ moreCount, create = null }: {
  moreCount: number; create?: CreateTileView | null;
}) {
  const t = useMessages('home');
  // A held-back view arrives only with apps behind the button (a collapsed
  // grid that hid the tile is collapsed), so the pair is checked together.
  const compact = Boolean(moreCount) && Boolean(create?.heldBack);
  return (
    <div id="home-apps-more" className={moreCount ? 'px-2 pb-1 sm:px-3' : 'hidden px-2 pb-1 sm:px-3'}>
      {moreCount ? (
        compact ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              id="home-apps-more-btn"
              className={`flex-1 ${MORE_BTN}`}
              onClick={() => {
                const home = controller();
                if (!home) return;
                home._appsExpanded = true;
                home.render();
              }}
            >
              {t('home:grid.showAll', { count: moreCount })}
            </button>
            <CreateCompact view={create} />
          </div>
        ) : (
          <button
            type="button"
            id="home-apps-more-btn"
            className={`w-full ${MORE_BTN}`}
            onClick={() => {
              const home = controller();
              if (!home) return;
              home._appsExpanded = true;
              home.render();
            }}
          >
            {t('home:grid.showAll', { count: moreCount })}
          </button>
        )
      ) : null}
    </div>
  );
}

export function AppsMore() {
  const { moreCount } = useStoreState(chromeStore);
  // The Create view rides the grid store — it is the launcher's own model,
  // and Home.render() pushes both stores on the same pass.
  const { create } = useStoreState(gridStore);
  return <AppsMoreBody moreCount={moreCount} create={create} />;
}
