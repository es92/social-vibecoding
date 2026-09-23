/**
 * The Workshop's scope chip and the panel behind it (#2718, #2759, #2768).
 *
 * ── Where it lives now ────────────────────────────────────────────────
 *
 * On ONE APP's Workshop, and only there. It says which app's Workshop you are
 * in and its panel offers the others — and All apps, which is the way back up
 * to the all-apps Workshop screen.
 *
 * It used to lead that all-apps screen too, reading "All apps" and narrowing
 * by navigating. #2759 took it off: that screen IS a flat list of your apps,
 * each row the way into its Workshop, so a chip whose panel was the same list
 * again was the one fact on the screen said twice.
 *
 * ── Two controls, one panel (#2768) ───────────────────────────────────
 *
 * Above the 700px breakpoint the chip is the control, at the head of the
 * app's Workshop. On a phone the chip is hidden (app.css, `.dev-ws-scope`) and
 * the HEADER's icon and name open the same panel
 * (features/header/header-title.tsx) — the header already names the app, so a
 * chip under it naming it again spent a row of a small screen on nothing. The
 * panel still renders here, at the top of the page, which on a phone is right
 * under the header that opened it. The open flag is ./app-scope-store.js so
 * the two controls cannot disagree about it.
 *
 * ── Why the panel expands IN PLACE rather than presenting ─────────────
 *
 * The panel is an ordinary child of the page. Not a sheet, not a dialog and
 * not an anchored panel, and that is a deliberate three-way no:
 *
 *   - A kit sheet needs a root in the prerendered document to adopt, an id in
 *     the shell's frozen inventory and a controller with a dismiss contract —
 *     all of it to show a list of your own apps.
 *   - @/components/ui/anchored-panel is fixed to the window's top-right
 *     corner, which is where the bell's panel goes and nowhere near a chip
 *     sitting in the page.
 *   - A popover would unmount while closed, and the first render has to be
 *     the chip alone.
 *
 * Expanding in place costs none of that: the Workshop mounts client-side into
 * a legacy host, nothing in public/js/** writes inside it, and a panel that
 * renders only once somebody has tapped is a panel no prerender ever sees.
 */

import { useEffect, useState, type ReactNode } from 'react';

import {
  CheckIcon, ChevronDownIcon, Squares2X2Icon,
} from '@/components/ui/icons';

import { AppIconContent, appIconKind } from '../apps/app-card-view';
import { useStoreState } from '../../lib/use-store-state';
import { APP_SCOPE_PANEL_ID, appScopeStore } from './app-scope-store.js';

type PickerApp = {
  slug: string;
  name?: string;
  icon_url?: string | null;
  icon_emoji?: string | null;
};

const win = () => window as unknown as {
  App?: { navigateToApp?: (slug: string, tab?: string) => Promise<unknown> | void };
};

/**
 * Go to `slug`'s own Workshop.
 *
 * It took a MODE too, while the plus's two action rows landed here: the await
 * was load-bearing there, because `navigateToApp` resolves once the Improve
 * controller knows what the app view is about and calling `startSession()`
 * before that would start a change on whatever app the panel was last pointed
 * at. The scope chip is the only caller left and there is nothing after the
 * navigation — but the await stays, so a refused navigation cannot look like
 * a completed one.
 */
async function goToApp(slug: string): Promise<void> {
  appScopeStore.set({ open: false });
  try {
    await win().App?.navigateToApp?.(slug, 'dev');
  } catch {
    // A navigation that failed has already told the viewer. The panel is
    // closed either way, which is the state this screen wants.
  }
}

/**
 * Up to the all-apps Workshop screen.
 *
 * A HASH ASSIGNMENT, not a call into App: this is the same address the rail's
 * Workshop tab carries, so the two ways of getting there are one route and
 * the browser's own history records it.
 */
function goToAllApps(): void {
  appScopeStore.set({ open: false });
  window.location.hash = '#workshop';
}

const CHIP = 'inline-flex items-center gap-2 max-w-full h-9 pl-2 pr-2.5 rounded-full '
  + 'un-touch-target font-semibold text-sm disabled:opacity-60 '
  + 'border border-[color:var(--brand-line)] bg-[color:var(--brand-tint)] '
  + 'text-[color:var(--brand-ink)]';

/**
 * "(icon) App name ⌄" — which app's Workshop this is, and the list behind it.
 *
 * It names the app rather than "All apps": the all-apps screen no longer
 * wears a chip (#2759), so this is only ever the scoped end of the control.
 * It is never disabled, because there is always somewhere to go — back up to
 * all of your apps.
 */
export function WorkshopScope({ open, id, scope, onToggle }: {
  open: boolean;
  id: string;
  /** The app this Workshop is showing. */
  scope: PickerApp;
  onToggle: (next: boolean) => void;
}) {
  return (
    <button
      id={id}
      type="button"
      className={CHIP}
      aria-haspopup="menu"
      aria-expanded={open ? 'true' : 'false'}
      aria-controls={`${id}-picker`}
      onClick={() => onToggle(!open)}
    >
      <span
        aria-hidden="true"
        className="app-icon-tile shrink-0 w-6 h-6 rounded-lg overflow-hidden flex items-center justify-center text-xs font-bold"
        data-icon={appIconKind(scope as never)}
      >
        <AppIconContent app={scope as never} />
      </span>
      <span className="min-w-0 truncate">{scope.name || scope.slug}</span>
      <ChevronDownIcon className="w-4 h-4 shrink-0" aria-hidden="true" />
    </button>
  );
}

const ROW = 'w-full flex items-center gap-3 px-4 min-h-[44px] py-2 text-left text-sm '
  + 'text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors';

function PanelRow({ id, leading, title, detail, trailing, onClick }: {
  id?: string;
  leading?: ReactNode;
  title: string;
  detail?: string;
  trailing?: ReactNode;
  onClick: () => void;
}) {
  return (
    <button id={id} type="button" className={ROW} onClick={onClick}>
      <span
        className="shrink-0 flex items-center justify-center w-8 h-8 text-zinc-500 dark:text-zinc-400"
        aria-hidden="true"
      >
        {leading}
      </span>
      <span className="min-w-0 flex-1 flex flex-col">
        <span className="truncate font-medium">{title}</span>
        {detail
          ? <span className="truncate text-xs text-zinc-500 dark:text-zinc-400">{detail}</span>
          : null}
      </span>
      {trailing}
    </button>
  );
}

/**
 * The scope chip's panel: which workshop you are looking at.
 *
 * All apps first — the way back up — then each of your apps, the one on
 * screen carrying the tick.
 */
export function WorkshopPicker({ apps, id, scope, onClose }: {
  apps: PickerApp[] | null;
  id: string;
  /** The app this Workshop is showing. */
  scope: PickerApp;
  onClose: () => void;
}) {
  const rows = apps || [];

  return (
    <div
      id={id}
      role="menu"
      className={'mx-4 mb-3 rounded-2xl overflow-hidden bg-white dark:bg-zinc-900 '
        + 'border border-zinc-200 dark:border-zinc-800'}
    >
      <p className="px-4 pt-3 pb-2 flex flex-col">
        <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Which workshop?</span>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">All apps, or one app’s.</span>
      </p>
      {/* ALL APPS IS THE WAY BACK UP — and the reason the app's Workshop
          needs no back arrow beyond the rail's own Workshop tab. */}
      <PanelRow
        id={`${id}-all`}
        leading={<Squares2X2Icon className="w-5 h-5" />}
        title="All apps"
        onClick={() => { onClose(); goToAllApps(); }}
      />
      {rows.map((app) => (
        <PanelRow
          key={app.slug}
          leading={(
            <span
              data-icon={appIconKind(app as never)}
              className="app-icon-tile w-8 h-8 rounded-lg overflow-hidden flex items-center justify-center text-sm font-bold"
            >
              <AppIconContent app={app as never} />
            </span>
          )}
          title={app.name || app.slug}
          trailing={scope.slug === app.slug
            ? <CheckIcon className="w-4 h-4 shrink-0" aria-hidden="true" />
            : undefined}
          // THE APP YOU ARE ALREADY IN closes the panel and goes nowhere. A
          // row that re-navigates to the current route would throw this
          // screen's scroll position and its open windows away to arrive
          // where it started.
          onClick={() => {
            onClose();
            if (scope.slug === app.slug) return;
            void goToApp(app.slug);
          }}
        />
      ))}
    </div>
  );
}


/* ════════════════════════════════════════════════════════════════════
   THE CHIP ON THE APP'S OWN WORKSHOP (#2718 review, #2768)
   ════════════════════════════════════════════════════════════════════

   "The workshop view, when clicked into an app, should preserve the app
   switcher, and should preserve the side bar."

   Picking an app NAVIGATES rather than filtering: one app's Workshop is its
   own screen inside that app, where its board, sessions and discussion
   already live. The rail stays up (App._syncPlatformTabs) with the Workshop
   tab lit, and this chip — or, on a phone, the header's icon and name — says
   which app you are in and is the way to another.

   ── Its open state is a store ────────────────────────────────────────

   ./app-scope-store.js, because two controls open this one panel: the chip
   above 700px, the header below it. The flag is closed again whenever the
   app on screen changes or the Workshop unmounts, so a panel left open is
   never waiting on the next visit.

   ── And its own fetch ────────────────────────────────────────────────

   GET /api/apps, partitioned by Home.partitionApps exactly as the all-apps
   screen does — "which apps are mine" is a decision the platform already
   makes once. It runs in an effect and never during render, so the chip
   draws with the app it already knows and the list arrives under it.
*/

/** The demo flag every board fetch forwards, in the same spelling. */
function demoQuery(): string {
  try {
    return new URLSearchParams(location.search).get('demo') === '1' ? '?demo=1' : '';
  } catch {
    return '';
  }
}

/**
 * The scope chip and its panel, for the Workshop of ONE app.
 *
 * `slug` is the app on screen; `name`, `iconUrl` and `iconEmoji` are what the
 * chip draws before the list has loaded, so it never starts as a bare slug
 * and then changes under the reader. Once the list arrives the row for this
 * app wins, because it is the same record every other surface draws from.
 */
export function AppWorkshopScope({ slug, name, iconUrl, iconEmoji }: {
  slug: string;
  name?: string;
  iconUrl?: string | null;
  iconEmoji?: string | null;
}) {
  const { open } = useStoreState(appScopeStore) as { open: boolean };
  const [apps, setApps] = useState<PickerApp[] | null>(null);
  const setOpen = (next: boolean) => appScopeStore.set({ open: next });

  // A panel left open does not outlive the app it was opened on, nor the
  // Workshop: the header's control would otherwise find it already open on
  // the next visit.
  useEffect(() => {
    appScopeStore.set({ open: false });
    return () => appScopeStore.set({ open: false });
  }, [slug]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/apps${demoQuery()}`);
        if (!res.ok) return;
        const data = await res.json();
        const home = (window as unknown as {
          Home?: { partitionApps?: (rows: unknown[]) => { yours: PickerApp[] } };
        }).Home;
        const rows = home?.partitionApps
          ? home.partitionApps(data.apps || []).yours
          : ((data.apps || []) as PickerApp[]);
        if (!cancelled) setApps(rows);
      } catch {
        // OFFLINE IS SILENCE. The chip still names this app and still offers
        // the way back to all of them — the list of the others is the only
        // thing a refused request costs, and a control that works is worth
        // more than an error where a menu should be.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // The app this Workshop is showing. The fetched record when there is one,
  // so the tile and the name match every other surface; the props until then.
  const scope: PickerApp = apps?.find((a) => a.slug === slug)
    || { slug, name, icon_url: iconUrl, icon_emoji: iconEmoji };

  return (
    <div className="dev-ws-scope" data-ws-scope="">
      <WorkshopScope
        id="dev-ws-scope-chip"
        open={open}
        scope={scope}
        onToggle={setOpen}
      />
      {open ? (
        <WorkshopPicker
          id={APP_SCOPE_PANEL_ID}
          apps={apps}
          scope={scope}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}
