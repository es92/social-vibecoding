/**
 * #apps-switcher-sheet — the menu behind the header chip (#1443).
 *
 * ── The rule ───────────────────────────────────────────────────────────
 *
 * ONE CONTROL NAMES WHERE YOU ARE, AND ITS MENU LISTS EVERYWHERE YOU CAN
 * GO. Everything in here has its own page. Nothing that isn't a destination
 * belongs in this sheet at all — an inbox's CONTENTS are not a destination,
 * which is why the notifications list is a sheet of its own and only the
 * Messages ROW is here. A row that is neither is the signal this menu is
 * decaying back into the hamburger it replaced.
 *
 * ── What #1431 built and what #1443 changed ────────────────────────────
 *
 * #1431 made this the Apps sheet: a title row with "Create New", a strip of
 * the viewer's apps, and a `Home | Explore` footer, presented as a kit bottom
 * sheet on touch by ./app-context-controller.js. All of that is kept — the
 * lifecycle, the strip, the create action.
 *
 * What changed is that it now carries the platform's destinations too, so it
 * is reachable from every screen rather than only from inside an app. The two
 * footer buttons became the first two rows of that list, and `canOpen`'s
 * `!!slug` gate went with the chip's — a menu you can only open inside an app
 * is not a way to get to an app.
 *
 * ── The app's own views ARE here, and so is the exception they make ────
 *
 * App / Board / Activity sat here for one round of #1443, moved out to the
 * Improve panel on the argument that this menu answers WHICH APP and those
 * three answer WHICH PART OF IT, and are back — in BOTH places, which is what
 * neither round tried. The second question is a fair one to ask from the
 * control that names where you are, and the strip is one module
 * (../improve/view-tabs.tsx) rendered twice rather than two implementations
 * of one decision.
 *
 * The strip is the one thing in this sheet drawn as a CONTROL rather than as a
 * row, deliberately: a segmented control is visibly a different kind of object
 * from the destinations, which keeps "everything in the list has its own page"
 * true of the list while the app's own views sit above it.
 *
 * The app's general chat spent one round here as a fourth row, because
 * Activity had taken its name and it was otherwise reachable only from a
 * notification. It is not here now: it belongs to the board, which carries it
 * as a card on the kanban and as an activity row in the Feed (see
 * ../dev-board/discussion-store.ts). A menu that lists the app's chat beside
 * Home and Settings is answering the WHICH-PART-OF-THIS-APP question in the
 * one place that exists to answer WHICH APP.
 *
 * ── Why the strip is horizontal, and why that is the scroll fix ────────
 *
 * The first cut of this menu (on the superseded #1436 branch) made the apps a
 * VERTICAL list, and with the 39 apps on a real account that list ran to
 * ~1800px inside an 844px panel: Home, Discover, Messages, Profile and
 * Settings were pushed past the fold and CLIPPED, with no scroller anywhere
 * to reach them. That is what "the menu is missing home and profile" was.
 *
 * #1431's horizontal strip makes the bug structurally impossible instead of
 * fixing it: 39 apps occupy exactly the vertical space that 2 do, so the
 * destinations below can never be pushed anywhere. The strip scrolls
 * sideways; the DESTINATIONS get the vertical scroller, so on a short
 * viewport they give way rather than clip. Nothing here is ever unreachable,
 * at any app count and any height.
 *
 * ── Where it comes from, per surface ───────────────────────────────────
 *
 * Three presentations, one always-mounted element, all of them in app.css
 * (the `#apps-switcher-sheet` block): a kit bottom sheet on touch, a CSS
 * bottom sheet below `sm`, and at `sm`+ for a mouse a DROPDOWN hanging under
 * the chip that opened it. That last one was a right-edge rail like the
 * Improve panel and the notifications sheet, and it is the one thing about
 * this surface that is not like them: those two are lists with no natural
 * end, this is a menu, and a menu that answers from the far edge of a wide
 * display leaves its trigger a foot away. Nothing in here changes with the
 * presentation — the markup is one panel and the CSS decides where it is,
 * which is why the desktop change is a media query and not a branch.
 *
 * ── Same MATERIAL as the two rails, different SHAPE ────────────────────
 *
 * It wears `.dc-lift dc-lift-panel`, which is the frosted fill, the hairline
 * colour and the shadow list the Improve rail and the notifications rail wear
 * — the lift's two layers plus the modal dim, which these panes cast outward
 * rather than painting behind themselves (see `.dc-lift-panel` in app.css for
 * why: a dim behind the panel lands inside its own backdrop-filter).
 *
 * This is the pane the dim treats least kindly, and it is worth knowing why:
 * the rails dock to a screen edge, where what shows through the frost is page
 * margin, while this one hangs in the middle of the content, where it is body
 * text. Blurred text behind a menu reads as a smudge rather than as depth. If
 * that ever needs fixing it is this surface's fill alpha, not the mechanism.
 * That is the whole of what it takes from them, and it is deliberate that it
 * is not more: `.dc-lift` rounds a DOCKED sheet — 1.75rem on the corners that
 * meet the page, square on the ones that run off the display — and at `sm`+
 * this thing docks to nothing. It hangs off the chip, so all four of its
 * corners are real and it keeps the kit's own 12px menu radius
 * (`--un-radius-card`) and the `--brand-line` hairline that ties it to the
 * chip's ring. Below `sm` it IS floor-docked, and there it takes the pane's
 * 1.75rem top corners like the other two.
 *
 * What this replaced was `bg-white dark:bg-zinc-900` with a zinc hairline and
 * `shadow-2xl` — a heavier, greyer drop than the lift's, and the last of the
 * pre-lift panel look in the shell's floating surfaces.
 *
 * First render is the prerender: closed, no apps, no app-scoped rows.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import {
  ChatBubbleTailIcon,
  ChevronRightIcon,
  CogIcon,
  HomeIcon,
  PlusWideIcon,
  SearchIcon,
  ShieldCheckIcon,
  UserIcon,
  XIcon,
} from '@/components/ui/icons';

import { AppIconContent, appIconKind } from '../apps/app-card-view';
import { useStoreState } from '../../lib/use-store-state';
import { useVisibilityHiddenClass } from '../../lib/visibility-store';
import { improveStore } from '../improve/improve-store.js';
import { appContextStore } from './app-context-store.js';
import { AppContext } from './app-context-controller.js';
import { recordAppUse, sortByRecency } from './app-recency';

type SwitcherApp = {
  slug: string; name?: string; icon_url?: string | null; icon_emoji?: string | null;
};

const ROW = 'flex items-center gap-3 px-5 min-h-[44px] text-sm '
  + 'text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800 '
  + 'transition-colors';

/**
 * A section label's TYPE, without the row it sits in.
 *
 * Split out because the Apps label cannot use SECTION: it shares its row with
 * Create New and the close button, so the row owns the padding and the label
 * owns only how it reads. Two constants rather than one string repeated, so
 * "the same as the other section labels" stays true by construction — it was
 * a `text-lg font-semibold` title until #1443's menu grew more labels
 * underneath it, and a heading above a list of labels reads as a different
 * kind of thing from the labels themselves.
 */
const SECTION_TYPE = 'text-[0.7rem] font-semibold uppercase tracking-wide '
  + 'text-zinc-400 dark:text-zinc-500';

/** A section label that owns its whole row. */
const SECTION = 'px-5 pt-4 pb-1 ' + SECTION_TYPE;

/**
 * One destination. An ANCHOR, always — whether clean-path or fragment-routed,
 * cmd/ctrl click, middle-click and "open in new tab" all have to work, the same
 * reason #back-btn is an <a>. `dismissForNav` closes the sheet on a plain
 * activation; a modified click never reaches it because the browser handles
 * it natively.
 */
function MenuRow({
  id, href, icon, label, trailing, onClick, elRef, shipsHidden,
}: {
  id: string;
  href: string;
  icon: ReactNode;
  label: string;
  trailing?: ReactNode;
  onClick?: (e: React.MouseEvent) => void;
  elRef?: React.Ref<HTMLAnchorElement>;
  // Ships `hidden` in the FIRST render, for a row a classic module reveals.
  // The className stays a constant either way — which is what keeps the
  // outside `hidden` toggle a sanctioned seam rather than a second owner.
  shipsHidden?: boolean;
}): ReactNode {
  return (
    <a
      ref={elRef}
      id={id}
      href={href}
      className={shipsHidden ? `hidden ${ROW}` : ROW}
      onClick={(e) => {
        if (onClick) { onClick(e); return; }
        AppContext.dismissForNav();
      }}
    >
      <span className="shrink-0 [&>svg]:h-5 [&>svg]:w-5 text-zinc-500 dark:text-zinc-400" aria-hidden="true">
        {icon}
      </span>
      <span className="flex-1 min-w-0 truncate font-medium">{label}</span>
      {trailing}
      <ChevronRightIcon className="w-4 h-4 shrink-0 text-zinc-300 dark:text-zinc-600" aria-hidden="true" />
    </a>
  );
}

/**
 * One app in the rail.
 *
 * THE APP'S OWN ARTWORK, never its initial if it has any. ../apps/app-card-view's
 * AppIconContent is the three-way `icon_url → icon_emoji → letter` walk Home
 * and the browse list already share; a letter is the LAST resort.
 *
 * `.app-icon-tile` + `data-icon` draw the box, and this call site adds no
 * background or text colour of its own — app.css says tile call sites must not
 * repaint the one tile face.
 */
function AppTile({ app, current }: { app: SwitcherApp; current: boolean }) {
  const label = app.name || app.slug;
  return (
    <a
      href={`/app/${encodeURIComponent(app.slug)}`}
      data-switcher-app={app.slug}
      aria-current={current ? 'page' : undefined}
      className="shrink-0 w-16 flex flex-col items-center gap-1.5"
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey
            || event.shiftKey || event.altKey) return;
        event.preventDefault();
        void AppContext.dismissForNav();
        if (!current) window.App?.navigateToApp?.(app.slug, 'app');
      }}
    >
      {/* The ring sits OUTSIDE the tile's own hairline, offset in the sheet's
          ground, so a selected tile reads as one edge rather than two. */}
      <span
        data-icon={appIconKind(app)}
        className={'app-icon-tile w-14 h-14 rounded-2xl overflow-hidden flex items-center justify-center text-xl font-bold'
          + (current
            ? ' ring-2 ring-violet-500 ring-offset-2 ring-offset-white dark:ring-offset-zinc-900'
            : '')}
      >
        <AppIconContent app={app} />
      </span>
      {/* Colour only, never weight — navigation.md forbids a weight change
          between nav item states. */}
      <span
        className={'w-full text-center text-[0.8125rem] truncate '
          + (current
            ? 'text-violet-600 dark:text-violet-400'
            : 'text-zinc-900 dark:text-zinc-100')}
      >
        {label}
      </span>
    </a>
  );
}

export function AppsSwitcherSheet(): ReactNode {
  const { open, adopted } = useStoreState(appContextStore);
  const { slug } = useStoreState(improveStore);
  const [apps, setApps] = useState<SwitcherApp[] | null>(null);

  // Both flags arrive from classic modules through the visibility store —
  // App.renderAdminButton for the console, settings.js for the BYOK dot — and
  // both elements ship `hidden` with a CONSTANT className, which is what makes
  // a `hidden` toggle from outside React sanctioned rather than a second owner.
  const adminRef = useRef<HTMLAnchorElement | null>(null);
  const byokRef = useRef<HTMLSpanElement | null>(null);
  useVisibilityHiddenClass(adminRef, 'switcher-row-admin', false);
  useVisibilityHiddenClass(byokRef, 'switcher-byok-dot', false);

  const close = useCallback(() => AppContext.close(), []);

  // The viewer's apps, in the home grid's own "Your apps" order — the one
  // answer to "which apps are mine" the platform already has. Revalidated on
  // EVERY open: create/import reloads Home and Discover's add/remove action
  // updates Home's app cache, but this island keeps its own state for the
  // lifetime of the shell. Treating the first response as permanent left that
  // copy stale until a page reload.
  // Keep the previous rows while this fetch runs, so reopening never flashes an
  // empty strip. Nothing loads during the first render: the prerender ships an
  // empty strip and a fetch there would be a hydration mismatch.
  useEffect(() => {
    if (!open) return;
    let live = true;
    (async () => {
      try {
        const demo = new URLSearchParams(location.search).get('demo') === '1' ? '?demo=1' : '';
        const res = await fetch(`/api/apps${demo}`);
        if (!res.ok) return;
        const data = await res.json();
        const home = (window as any).Home;
        const mine = home?.partitionApps
          ? home.partitionApps(data.apps || []).yours
          : (data.apps || []);
        if (live) setApps(mine);
      } catch {
        // Offline is a state, not a failure: no strip, the rows still work.
      }
    })();
    return () => { live = false; };
  }, [open]);

  // Every way into an app funnels through improveStore.slug, so recording
  // recency here rather than in AppTile's click handler counts a home tile, an
  // /app/<slug> deep link and a notification tap as uses too — not just the
  // two entries that happen to go through this menu.
  useEffect(() => {
    if (slug) recordAppUse(slug);
  }, [slug]);

  // Most-recently-used first, which on a horizontal strip is left-to-right.
  // Safe to read storage during render here and nowhere else in this island:
  // `apps` is null until the sheet's first open, so this only ever runs on a
  // client render, never in the prerender that would mismatch on hydration.
  const rows = useMemo(() => sortByRecency(apps || []), [apps]);

  return (
    <>
      {/* The overlay is the WEB presentation's dim. Adopted into a kit sheet
          the kit's own backdrop owns it — see lib/sheet-controller.js. */}
      <div
        id="apps-switcher-overlay"
        aria-hidden="true"
        {...(open && !adopted ? { 'data-open': '' } : {})}
        className="fixed inset-0 z-40"
        onClick={close}
      >
      </div>
      <div
        id="apps-switcher-sheet"
        role="dialog"
        aria-label="Menu"
        aria-hidden={open ? undefined : 'true'}
        {...(open ? { 'data-open': '' } : {})}
        className="fixed z-50 flex flex-col dc-lift dc-lift-panel app-context-transition"
      >
        {/* The Apps label's row. `pt-4 pb-1` is SECTION's own padding, applied
            here because the row holds two controls beside the label — so the
            spacing is the same as every other label in this menu even though
            the class string cannot be. */}
        <div className="flex items-center gap-3 px-5 pt-4 pb-1 shrink-0">
          <span className={'flex-1 min-w-0 block ' + SECTION_TYPE}>
            Apps
          </span>
          <button
            id="apps-switcher-create"
            type="button"
            className="inline-flex items-center gap-1 text-sm font-medium text-violet-600 dark:text-violet-400 hover:underline un-touch-target"
            // `Home.openCreateApp` never existed — the optional call swallowed
            // it, so this button closed the sheet and did nothing else. The
            // create dialog is reached through App.showCreateModal(), which
            // forwards to the `create` entry of the UsernodeReact.dialogs
            // bridge (../dialogs/create-app.tsx).
            //
            // The await is load-bearing on touch: dismissForNav() resolves
            // when the kit sheet has actually torn down (up to
            // DISMISS_SAFETY_MS in lib/sheet-controller.js), and presenting a
            // modal into a kit that is still dismissing a sheet loses the
            // modal. Same ordering AppTile uses for navigation.
            //
            // At-limit viewers still open the dialog: its quota row explains
            // the state and its submit button is disabled. Keeping a toast
            // gate here would make this entry disagree with the home Create
            // button and hide the exact usage the viewer came to inspect.
            onClick={() => {
              const win = window as any;
              void AppContext.dismissForNav().then(() => {
                win.App?.showCreateModal?.();
              });
            }}
          >
            <PlusWideIcon className="w-3.5 h-3.5 shrink-0" strokeWidth="2.5" aria-hidden="true" />
            Create New
          </button>
          <button
            id="apps-switcher-close"
            type="button"
            className="text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 un-touch-target"
            aria-label="Close"
            onClick={close}
          >
            <XIcon className="w-5 h-5" />
          </button>
        </div>
        {/* The apps, as a horizontal strip — vertically BOUNDED, which is what
            keeps every row below reachable at any app count. See the header.

            THE PADDING IS NOT SYMMETRIC AND IT LOOKS IT. Equal air above and
            below the tiles takes 16px above and none below, for two reasons
            that pull the same way:

            4px OF THE TOP PADDING PAINTS NOTHING. `overflow-x-auto` makes this
            a scroll container on BOTH axes (overflow-y computes to `auto`), so
            anything drawn above the content box is clipped — and the current
            app's tile carries `ring-2 ring-offset-2`, which paints 4px outside
            its border box. That 4px is clearance, not gap: with `pt-1`, which
            is exactly the outset and was all this used to carry, the ring was
            saved from being sliced flat and the tiles sat hard against the
            label. `pt-4` is that same clearance plus 12px that the eye reads.

            AND THE LABEL BELOW BRINGS ITS OWN. Whatever follows the strip
            opens with SECTION's `pt-4`, so 16px under the tiles is already
            there — `pb-5` on top of it made the gap below more than three
            times the gap above. It reads as balanced at `pb-0`. */}
        <div
          id="apps-switcher-list"
          className="shrink-0 flex gap-4 px-5 pt-4 pb-0 overflow-x-auto overscroll-contain platform-no-scrollbar"
        >
          {rows.map((app) => (
            <AppTile key={app.slug} app={app} current={app.slug === slug} />
          ))}
          {apps && rows.length === 0 ? (
            <span className="py-4 text-sm text-zinc-500 dark:text-zinc-400">
              No apps yet. Discover finds the ones you can join.
            </span>
          ) : null}
        </div>
        {/* THE APP'S THREE VIEWS ARE NOT HERE ANY MORE.

            An "In this app" caption over an App | Board | Activity strip sat
            between the app list and the platform rows. It answered a
            different question from the one this menu is for: this menu picks
            WHICH APP, and the strip picked which part of the app you are
            already in — so opening it to switch apps meant reading past a
            control about the app you were leaving.

            The strip is not gone, it is single-homed. The Improve panel
            renders it (`#improve-views`, ../improve/view-tabs.tsx), which is
            where the rest of "what can I do to this app" lives, and the
            header's own back arrow is the fast path out of a Board or an
            Activity feed now — see ../header/platform-header.tsx. Two copies
            of one control was the thing view-tabs.tsx's own header called
            "two owners of one decision"; this leaves one. */}
        {/* THE ONLY VERTICAL SCROLLER. Everything above is `shrink-0`. */}
        <nav
          id="switcher-nav"
          className="flex-1 min-h-0 overflow-y-auto pb-2 platform-safe-sheet"
        >
          {/* The one group that had no label. Apps and the viewer's own rows
              each announced themselves; Home, Discover and Messages opened
              straight off the hairline, which read as rows left over above
              "You" rather than as a group of their own.

              "Platform" because that is what they are — the places that are
              not inside an app — which is the distinction this whole menu is
              organised on now that the app's own views have left it. Not
              "You": that label means the viewer's own things, and Home is
              nobody's. */}
          <div className={SECTION}>Platform</div>
          <MenuRow
            id="switcher-row-home"
            href="/"
            icon={<HomeIcon />}
            label="Home"
            onClick={(e) => {
              if ((window as any).NavLink?.isNativeClick?.(e)) return;
              e.preventDefault();
              AppContext.dismissForNav();
              (window as any).App?.navigateHome?.();
            }}
          />
          <MenuRow
            id="switcher-row-discover"
            href="#apps"
            icon={<SearchIcon />}
            label="Discover"
          />
          {/* Messages carries NO count. It wore #drawer-messages-badge from
              #1431's header bubble through #1443's row, and the argument for
              it was that a per-conversation number beats the bell's. The
              argument the number lost is about WHERE, not how good it is: an
              unread count tells you something happened, and this menu is
              where you say where you are going. A message notification is a
              notification, so it is counted on the bell and listed in the
              notifications sheet with the rest of them — leaving this a plain
              destination like Home, Discover and Profile beside it. The
              per-conversation counts still exist where they read as counts:
              on the conversation rows inside Messages. */}
          <MenuRow
            id="switcher-row-messages"
            href="#messages"
            icon={<ChatBubbleTailIcon />}
            label="Messages"
          />
          <div className={SECTION}>You</div>
          <MenuRow
            id="switcher-row-profile"
            href="#profile"
            icon={<UserIcon />}
            label="Profile"
          />
          <MenuRow
            id="switcher-row-settings"
            href="#settings"
            icon={<CogIcon />}
            label="Settings"
            trailing={(
              <span
                ref={byokRef}
                id="switcher-byok-dot"
                className="hidden w-2 h-2 rounded-full bg-emerald-500 shrink-0"
                aria-hidden="true"
              >
              </span>
            )}
          />
          {/*
              Admin & moderation. Ships `hidden`; App.renderAdminButton()
              publishes the flag for platform admins AND view-only admins —
              gated on `App.user.isAdmin`, which both roles carry, and
              deliberately NOT on `canAdminWrite` (the full-admin mutation
              gate, which would hide the console from exactly the moderation
              audience). Never gated on USERNODE_ENV: the row must exist
              identically in staging and production. Navigation rides the
              anchor's #admin hash, which navigateToAdminConsole re-gates
              server-side.
          */}
          <MenuRow
            elRef={adminRef}
            shipsHidden
            id="switcher-row-admin"
            href="#admin"
            icon={<ShieldCheckIcon />}
            label="Admin & moderation"
          />
        </nav>
      </div>
    </>
  );
}
