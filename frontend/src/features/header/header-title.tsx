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
 * ── On the app's Workshop the strip is the app switcher (#2768, #3295) ─
 *
 * The Workshop used to lead with a scope chip — the app's tile, its name and
 * a ⌄ — whose panel listed your other apps. Under this bar that was the same
 * tile and the same name twice, an inch apart. #2768 dropped the chip on a
 * phone and made the bar's tile and name the control there: a button with
 * the ⌄ that opened the same panel. A desktop kept the chip and the bar
 * dropped its tile instead.
 *
 * #3295 (the owner's request) makes the desktop the phone's: "on desktop,
 * put the community selector dropdown in the header, not either above the
 * community hub / workshop tabs or to the left of those if the screen is
 * wide". So the switcher is this bar's AT EVERY WIDTH, and the Workshop no
 * longer draws a chip.
 *
 * WHAT IT OPENS is "Your communities" now (features/workshop/
 * community-switcher.tsx), the same switcher the Communities tab opens when
 * pressed while lit: a sheet on a phone, a menu under this name on a wide
 * window. The in-page "Which project?" panel it used to drop is gone. On the
 * project page this bar wears the community's colour (app.css, "The
 * project's colour"), so the name and ⌄ read as the community's own.
 *
 * ── The Communities screen's switcher went with its list ──────────────
 *
 * The Communities screen's title was its switcher, "Communities ⌄"
 * (`#header-scope-switch`, #3271, #852), opening Your communities. One Home
 * (#6361) gave that list to Home and left the screen as Needs you, a page
 * whose bar says its name, so the switcher left the bar with it.
 */

import type { RefObject } from 'react';

import { ChevronDownIcon } from '@/components/ui/icons';
import { Wordmark } from '@/components/ui/wordmark';

import { useMessages } from '../../lib/i18n/react';
import { useStoreState } from '../../lib/use-store-state';
import { headerTitleStore } from './header-title-store.js';
import { improveStore } from '../improve/improve-store.js';
import { navStore } from '../nav/nav-store.js';
import { sessionHeaderStore } from '../dev-chat/session-header-store';
import { MergeStatusPill } from '../dev-chat/session-header';
import { AppIconContent, AppIconLink, appIconKind } from '../apps/app-card-view';
import { useDevViewMode } from '../dev-board/view-mode-store';
import { communityScopeStore, toggleSwitcher } from '../workshop/community-scope';
import { HeaderPlaceName } from '../dev-board/workshop/place-bar';
import { DrawerTitles, useDrawerMode } from '../nav-drawer/header-drawer';
import { useSidebarRows } from '../nav/sidebar-rows';

// The one string that means "this is naming the platform, not an app". It is
// header-title-store.js's INITIAL, which is why the prerendered document and
// the first client render agree about it without this component learning
// anything from anywhere.
const PLATFORM_NAME = 'Homeroom';

export function HeaderTitle({ titleRef }: { titleRef: RefObject<HTMLHeadingElement | null> }) {
  const t = useMessages();
  const { text, subtitle } = useStoreState(headerTitleStore);
  const { slug, tab, subTab, name, iconUrl, iconEmoji, selfHosted } = useStoreState(improveStore);
  const { screen } = useStoreState(navStore);
  const { life } = useStoreState(sessionHeaderStore);
  const viewMode = useDevViewMode();
    // "Your communities" (features/workshop/community-switcher.tsx): the
  // app's name opens it.
  const { switcher } = useStoreState(communityScopeStore);
  const switcherOpen = !!switcher;
  // THE PHONE'S DRAWER (../nav-drawer/): on a community's page under 768px
  // the title is the drawer's, "Communities", the community, or the
  // community over its page, moving with the drawer; on Messages,
  // "Messages" or the conversation over who it is with. Off until a drawer
  // has settled that it applies, after hydration.
  const drawerOn = useDrawerMode() !== null;

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
  // Its Kanban layout, a session and the general chat have no scope panel,
  // so the strip is left alone there.
  const onWorkshop = inApp && tab === 'dev' && subTab === 'forum' && viewMode === 'workshop';
  // A card opened from it (#3602): an item's page is still the community's,
  // so its name switches community there too.
  const onCard = inApp && tab === 'dev' && subTab === 'topic';
  // D (18 Oct 2026): ON A DESKTOP THE SIDEBAR LISTS YOUR COMMUNITIES
  // (../nav/sidebar-rows.ts, from 768px), so the bar's name is a name again
  // there: the community's tile and name, no chevron, and on All communities
  // its title. Under 768px the name is the switcher, as it was.
  const sidebarRows = useSidebarRows();
  const communityPage = onWorkshop || onCard;
  // At every width (#3295): the Workshop draws no chip of its own any more.
  const appSwitch = communityPage && !sidebarRows;
  // Beside the sidebar, the community's name where the switcher would be.
  const communityName = communityPage && sidebarRows;
  const showTile = inApp;

  /* `.app-icon-tile` + `data-icon` draw the box, and this call site adds no
     background or text colour of its own — app.css says tile call sites must
     not repaint the one tile face. 28px, which is the header's content row
     exactly, so the tile cannot be what pushes the bar past its pinned
     height. */
  const tile = showTile ? (
    <AppIconLink
      id="header-app-tile"
      // Inside the switcher button, the tile is a nested link. The h1 is
      // pointer-events-none, so the tile opts back in.
      nested={appSwitch}
      slug={slug}
      name={name || text}
      data-icon={appIconKind(record)}
      className="app-icon-tile pointer-events-auto shrink-0 w-7 h-7 rounded-lg overflow-hidden
                 flex items-center justify-center text-sm font-bold"
    >
      <AppIconContent app={record} />
    </AppIconLink>
  ) : null;

  return (
    <h1
      ref={titleRef}
      id="header-title"
      className={"flex-1 min-w-0 text-base font-semibold pointer-events-none truncate\n               text-start"}
      /* #6118: a community's name the bar ellipsises is readable on hover.
         On the heading rather than the name span so the switcher's own
         markup stays as the declared checks select it; never on the
         logotype, which already draws a word in the space. */
      title={communityPage && !selfHosted ? (name || text) || undefined : undefined}
    >
      {drawerOn ? <DrawerTitles /> : (
      <span className="inline-flex items-center gap-2 max-w-full align-middle">
        {appSwitch ? null : tile}
        {appSwitch ? (
          /* THE SWITCHER. `pointer-events-auto` because the h1 around it is
             `pointer-events-none` so its overlap never eats a tap meant for a
             control beside it — this is the one part of it that IS a
             control, and only the part the tile and the name cover. */
          <>
            <button
              id="header-app-switch"
              type="button"
              className="pointer-events-auto un-touch-target inline-flex items-center gap-2 min-w-0 max-w-full
                         text-start font-semibold"
              data-community-switch=""
              aria-haspopup="dialog"
              aria-expanded={switcherOpen ? 'true' : 'false'}
              aria-controls="community-switcher"
              aria-label={t('core:header.switchCommunity', { community: name || text })}
              onClick={(e) => toggleSwitcher('header', e.currentTarget)}
            >
              {tile}
              {/* THE APP'S NAME, not the screen's: the bar reads "Workshop" on this
                  route, and a switcher labelled with the screen it switches
                  within would not say which app you are in.

                  ON HOMEROOM'S OWN PAGES THE NAME IS THE LOGOTYPE (#3497): the
                  same drawing the bar names the platform with on Home, so the
                  community that is the platform is not the one place its name
                  is set as plain type. Keyed on the store's `selfHosted`, not
                  the name, so a project that happens to be called Homeroom
                  keeps its word. The button's aria-label already says the
                  name, so the drawing is aria-hidden, as on Home. */}
              <span id="header-title-name" className="min-w-0 truncate">
                {selfHosted
                  ? <Wordmark className="h-5 w-[77.5px]" aria-hidden="true" />
                  : name || text}
              </span>
              <ChevronDownIcon className="w-4 h-4 shrink-0" aria-hidden="true" />
            </button>
            {/* #4703: THE PLACE'S NAME, on a phone, on the project page —
                where the place bar's second row is gone and the header says
                both whose page this is and where on it you are. An item's
                page (onCard) has its own way back and draws none. Hidden
                from screen readers: the heading is named by the switcher's
                drawing already. */}
            {onWorkshop ? <HeaderPlaceName slug={slug} /> : null}
          </>
        ) : (
          <span className="min-w-0 flex items-baseline gap-1.5">
            <span id="header-title-name" className="min-w-0 truncate">
              {/* `aria-hidden` on the mark: the h1 takes its accessible name
                  from its contents, and the drawing IS the word "Homeroom" — a
                  title element or an sr-only span here would have it read
                  twice. The heading is still named, because `text` is what the
                  screens beside it publish.

                  BESIDE THE SIDEBAR, ON A COMMUNITY'S PAGE, the community's
                  own name (the switcher's words, without the switch), and
                  Homeroom's is the logotype there as well (#3497). An sr-only
                  copy names the heading under the drawing. */}
              {communityName
                ? (selfHosted
                  ? <><Wordmark className="h-5 w-[77.5px]" aria-hidden="true" /><span className="sr-only">{name || text}</span></>
                  : name || text)
                : showsWordmark
                  ? <Wordmark className="h-5 w-[77.5px]" aria-hidden="true" />
                  : text}
            </span>
            {showSubtitle && !communityName ? (
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
      )}
    </h1>
  );
}
