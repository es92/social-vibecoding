/**
 * #header-title — the name of where you are, and nothing else.
 *
 * ── It was a button, and is not one any more ──────────────────────────
 *
 * ./app-switcher-chip.tsx made this heading a control: "(name) ⌄", opening
 * a menu that listed every platform destination. That was #1443's answer to
 * a bar with too many glyphs on it, and it held for as long as the menu was
 * the only way to reach anything. The tab bar (features/nav/) carries those
 * destinations now, so the menu behind the name holds the APP's options —
 * and a name that opens a menu about something else is a control whose label
 * lies about what it does. The menu moved to its own button
 * (./platform-mark.tsx); the name went back to being a name.
 *
 * What survives from the chip, unchanged, is everything that was about the
 * NAME rather than about the button:
 *
 *   - the h1 and its className, byte for byte, because
 *     ./use-header-layout.ts toggles `.is-centered` on this node via
 *     classList and a re-rendered class attribute would drop it;
 *   - `pointer-events-none`, so the heading's overlap never eats a tap meant
 *     for a control beside it;
 *   - the SUBTITLE BESIDE the name rather than under it — a destination
 *     inside an app (Board, Activity, a session's lifecycle) says which part
 *     of the app you are in without overwriting which app it is;
 *   - the LOGOTYPE when the name is the platform's own, drawn from the title
 *     string because that is the only fact available at first render. The
 *     chip's header carries the full argument for that test, including which
 *     screens it over-covers and why narrowing it would cost a flicker on
 *     every cold load to fix a screen where the drawing already says the
 *     right name.
 *
 * ── The app strip: a tile, and then the name ──────────────────────────
 *
 * Inside a running app the bar is that app's: close on the left, then its
 * icon and its name, then the bell and the mark. The tile is what makes the
 * difference read at a glance — the same artwork the launcher drew a moment
 * ago, so opening an app and being in it are visibly the same thing — and it
 * is drawn from ../improve/improve-store.js, which already carries the open
 * app's name, icon url and emoji for the panel that used to live in this bar.
 * No new fetch, no new publisher.
 *
 * It renders ONLY inside the app view, from features/nav's `screen`. The
 * store's INITIAL has no screen at all, so the prerendered document and the
 * first client render agree on no tile, and it arrives with the route.
 *
 * ── On the app's Workshop the strip is the app switcher (#2768) ───────
 *
 * The Workshop leads with a scope chip — the app's tile, its name and a ⌄ —
 * whose panel lists your other apps (features/workshop/workshop-chrome.tsx).
 * Under this bar that was the same tile and the same name twice, an inch
 * apart, so the two layouts each drop one copy:
 *
 *   - ABOVE 700px the chip stays and the bar loses the TILE. The name is
 *     still the heading; the chip below is the one picture of the app and
 *     the control.
 *   - BELOW IT the chip goes (app.css) and the bar's tile and name BECOME the
 *     control: a button with the ⌄ that opens the same panel, through the
 *     same flag (features/workshop/app-scope-store.js). A phone gets the row
 *     back and the switcher stays one tap from the top of the screen.
 *
 * The width is a media flag settled in an effect, so the first client render
 * is the prerender's (no button) and nothing here can mismatch hydration; by
 * the time anybody reaches a Workshop the flag has long since landed.
 */

import { useEffect, useState, type RefObject } from 'react';

import { ChevronDownIcon } from '@/components/ui/icons';
import { Wordmark } from '@/components/ui/wordmark';

import { useStoreState } from '../../lib/use-store-state';
import { headerTitleStore } from './header-title-store.js';
import { improveStore } from '../improve/improve-store.js';
import { navStore } from '../nav/nav-store.js';
import { sessionHeaderStore } from '../dev-chat/session-header-store';
import { MergeStatusPill } from '../dev-chat/session-header';
import { AppIconContent, appIconKind } from '../apps/app-card-view';
import { useDevViewMode } from '../dev-board/view-mode-store';
import { APP_SCOPE_PANEL_ID, appScopeStore } from '../workshop/app-scope-store.js';

// The one string that means "this is naming the platform, not an app". It is
// header-title-store.js's INITIAL, which is why the prerendered document and
// the first client render agree about it without this component learning
// anything from anywhere.
const PLATFORM_NAME = 'Homeroom';

/**
 * The phone layout, in the spelling app.css uses for the same breakpoint (the
 * Workshop's own `WIDE_QUERY` is its complement). False until mounted, so the
 * hydrating render agrees with the prerender whatever the window is.
 */
const PHONE_QUERY = '(max-width: 699.98px)';

function usePhone(): boolean {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia(PHONE_QUERY);
    const apply = () => setPhone(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);
  return phone;
}

export function HeaderTitle({ titleRef }: { titleRef: RefObject<HTMLHeadingElement | null> }) {
  const { text, subtitle } = useStoreState(headerTitleStore);
  const { tab, subTab, name, iconUrl, iconEmoji } = useStoreState(improveStore);
  const { screen } = useStoreState(navStore);
  const { life } = useStoreState(sessionHeaderStore);
  const viewMode = useDevViewMode();
  const { open: scopeOpen } = useStoreState(appScopeStore) as { open: boolean };
  const phone = usePhone();

  const onSession = tab === 'dev' && subTab === 'sessions';
  const sessionPill = onSession && life ? <MergeStatusPill life={life} /> : null;
  const showSubtitle = onSession ? !!sessionPill : !!subtitle;
  const showsWordmark = text === PLATFORM_NAME && !showSubtitle;

  // The app's own artwork, in the shape ../apps/app-card-view expects. The
  // improve store spells these camelCase because it is a store; the icon walk
  // is shared with the launcher and the browse list and reads the record's
  // own snake_case columns, so this is the one place the two meet.
  const inApp = screen === 'app-view';
  const record = { icon_url: iconUrl, icon_emoji: iconEmoji, name: name || text };
  // The app's Workshop: the Dev half's board route in its Workshop layout.
  // Its Kanban layout and the sub-views reached from it (a topic, a session,
  // the general chat) wear no scope chip, so the strip is left alone there.
  const onWorkshop = inApp && tab === 'dev' && subTab === 'forum' && viewMode === 'workshop';
  const switcher = onWorkshop && phone;
  const showTile = inApp && !(onWorkshop && !phone);

  /* `.app-icon-tile` + `data-icon` draw the box, and this call site adds no
     background or text colour of its own — app.css says tile call sites must
     not repaint the one tile face. 28px, which is the header's content row
     exactly, so the tile cannot be what pushes the bar past its pinned
     height. */
  const tile = showTile ? (
    <span
      id="header-app-tile"
      data-icon={appIconKind(record)}
      className="app-icon-tile shrink-0 w-7 h-7 rounded-lg overflow-hidden
                 flex items-center justify-center text-sm font-bold"
    >
      <AppIconContent app={record} />
    </span>
  ) : null;

  return (
    <h1
      ref={titleRef}
      id="header-title"
      className={"flex-1 min-w-0 text-base font-semibold pointer-events-none truncate\n               text-left"}
    >
      <span className="inline-flex items-center gap-2 max-w-full align-middle">
        {switcher ? null : tile}
        {switcher ? (
          /* THE SWITCHER. `pointer-events-auto` because the h1 around it is
             `pointer-events-none` so its overlap never eats a tap meant for a
             control beside it — this is the one part of it that IS a
             control, and only the part the tile and the name cover. */
          <button
            id="header-app-switch"
            type="button"
            className="pointer-events-auto un-touch-target inline-flex items-center gap-2 min-w-0 max-w-full
                       text-left font-semibold"
            aria-haspopup="menu"
            aria-expanded={scopeOpen ? 'true' : 'false'}
            aria-controls={APP_SCOPE_PANEL_ID}
            aria-label={`${name || text}, switch app`}
            onClick={() => appScopeStore.set({ open: !scopeOpen })}
          >
            {tile}
            {/* THE APP'S NAME, not the screen's: the bar reads "Workshop" on this
                route, and a switcher labelled with the screen it switches
                within would not say which app you are in. */}
            <span id="header-title-name" className="min-w-0 truncate">{name || text}</span>
            <ChevronDownIcon className="w-4 h-4 shrink-0" aria-hidden="true" />
          </button>
        ) : (
          <span className="min-w-0 flex items-baseline gap-1.5">
            <span id="header-title-name" className="min-w-0 truncate">
              {/* `aria-hidden` on the mark: the h1 takes its accessible name
                  from its contents, and the drawing IS the word "Homeroom" — a
                  title element or an sr-only span here would have it read
                  twice. The heading is still named, because `text` is what the
                  screens beside it publish. */}
              {showsWordmark
                ? <Wordmark className="h-5 w-[77.5px]" aria-hidden="true" />
                : text}
            </span>
            {showSubtitle ? (
              <span
                id="header-subtitle"
                className="shrink-0 text-[0.6875rem] leading-none font-medium
                           text-zinc-500 dark:text-zinc-400"
              >
                {/* `#header-status-pill` keeps its id and its seat: it is still
                    the lifecycle pill's, still inside #platform-header, and the
                    declared check that looks for it does not care which
                    descendant holds it. */}
                {onSession
                  ? <span id="header-status-pill" className="min-w-0 truncate">{sessionPill}</span>
                  : subtitle}
              </span>
            ) : null}
          </span>
        )}
      </span>
    </h1>
  );
}
