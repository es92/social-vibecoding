/**
 * The switcher menu's top half: where you can go (#1436).
 *
 * The drawer used to open onto notifications, because it was a catch-all and
 * "what happened while I was away" was the least bad thing to lead with. It is
 * the SWITCHER now, so it opens onto the thing it is for — your apps — with
 * Home and Discover under them and the account group below the divider.
 *
 * ── The rule this section exists to keep ───────────────────────────────
 *
 * A row here answers "where am I / where else can I go". A row in the group
 * below answers "you". Nothing else belongs in this menu at all: an inbox is
 * neither, which is why Messages and the notifications list both left in
 * #1436, and why a future row that is neither is the signal this drawer is
 * decaying back into the hamburger it replaced.
 *
 * ── ONE SCROLLER, AND IT IS THE APP LIST ───────────────────────────────
 *
 * The first cut made this whole section `shrink-0` inside an
 * `overflow-hidden` column. With a handful of apps that looks fine. With the
 * 39 on a real account the list alone ran to ~1800px in an 844px panel, and
 * every row after it — Home, Discover, Messages, Profile, Settings — was
 * pushed past the fold and CLIPPED. Not scrolled to: clipped, with no scroller
 * anywhere to reach them. That is what "the menu is missing home and profile"
 * was; it reproduced the moment the stub served 39 apps instead of two.
 *
 * So the fixed rows are pinned and the LIST is the only thing that flexes:
 * `flex-1 min-h-0 overflow-y-auto` on `#switcher-app-list`, `shrink-0` on
 * everything else. Home is reachable with one app or with two hundred.
 *
 * It is the same rule the notifications block followed while it lived in this
 * drawer, and it is worth stating as a rule rather than a fix: in a menu, the
 * NAVIGATION is unconditional and the collection is what gives way.
 *
 * ── First render is the prerender ──────────────────────────────────────
 *
 * The store ships empty and the list loads on `sv:drawer-open`, so the initial
 * render emits exactly what frontend/scripts/build-shell.mjs prerenders: the
 * two static rows and an empty app list. Rows appearing on first render would
 * be a hydration mismatch, and a mismatch is a console.error, which fails
 * proposal checks.
 *
 * Every row is a real ANCHOR. These are hash routes, so cmd/ctrl-click,
 * middle-click and "open in new tab" all have to work — the same reason
 * #back-btn is an `<a>` and not a `<button>`.
 */

import { AppWindowIcon, HomeIcon, SearchIcon } from '@/components/ui/icons';

import { useStoreState } from '../../lib/use-store-state';
import { switcherStore } from './switcher-store.js';

const ROW =
  'flex items-center gap-3 px-4 min-h-[44px] text-sm text-zinc-600 '
  + 'dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors';

const SECTION_LABEL =
  'px-4 pt-3 pb-1 text-[0.7rem] font-semibold text-zinc-500 dark:text-zinc-400';

export function SwitcherApps() {
  const { apps, loaded } = useStoreState(switcherStore);

  return (
    <div
      id="switcher-nav"
      className="flex-1 min-h-0 flex flex-col border-b border-zinc-100 dark:border-zinc-800"
    >
      {/* Home FIRST, and pinned. It is the one destination every person in
          the product shares, and it must not depend on how many apps you
          happen to have. */}
      <a id="switcher-row-home" className={`${ROW} shrink-0`} href="#home">
        <HomeIcon className="w-5 h-5 shrink-0" />
        <span className="font-medium">Home</span>
      </a>
      <div className={`${SECTION_LABEL} shrink-0`}>Your apps</div>
      {/* THE ONLY SCROLLER. See the header comment. */}
      <div id="switcher-app-list" className="flex-1 min-h-0 overflow-y-auto">
        {apps.map((app) => (
          <a key={app.slug} className={ROW} href={`#app/${app.slug}`} data-slug={app.slug}>
            <AppWindowIcon className="w-5 h-5 shrink-0" />
            <span className="flex-1 min-w-0 truncate font-medium">{app.name}</span>
          </a>
        ))}
        {/* Only once a load has RESOLVED. Between opening and the first
            answer this renders nothing at all, which is the honest state —
            an empty hint shown while the list is still arriving reads as
            "you have no apps" for exactly as long as the request takes. */}
        {loaded && apps.length === 0 ? (
          <div id="switcher-apps-empty" className="px-4 py-2 text-xs text-zinc-500 dark:text-zinc-400">
            No apps yet — Discover has some to add.
          </div>
        ) : null}
      </div>
      <a id="switcher-row-discover" className={`${ROW} shrink-0`} href="#apps">
        <SearchIcon className="w-5 h-5 shrink-0" />
        <span className="font-medium">Discover</span>
      </a>
    </div>
  );
}
