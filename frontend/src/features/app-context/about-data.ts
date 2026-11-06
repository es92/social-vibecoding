/**
 * What the About pane READS, and where each fact already lives.
 *
 * ── Nothing here is a second copy of Discover's app page ───────────────
 *
 * The pane is the app's page as a pop-up (the design's own note on it), so it
 * reads what that page reads (../apps/browse.js, ../apps/browse-detail.tsx):
 *
 *   the app row       GET /api/apps's row for the slug, Home._apps, when
 *                     this tab has loaded it, over the
 *                     open app's own GET /api/apps/:slug payload, which is
 *                     always in hand for the app the menu is about
 *                     (AppView.appData). The list row wins where both have a
 *                     field: only it knows whether the app is in Your apps.
 *   contributors      GET /api/apps/:slug/contributors, with the same ?demo=1
 *                     passthrough the page uses, so a staging preview shows
 *                     the page's demo roster here too;
 *   the actions       Home.menuItemsFor(app), the list the page renders its
 *                     action rows from — Add to Home Screen and Fork are
 *                     taken from it by key, not re-derived.
 *
 * Homeroom's pane adds GET /api/platform/about (src/routes/platform-about.js)
 * for the three figures and for the identity a viewer not served the
 * platform's row still needs.
 *
 * ── Read on open, never in the prerender ───────────────────────────────
 *
 * The pane is mounted by a tap (AppContext.showAbout) and never in the
 * prerendered document, so reading these in a state initializer is safe here
 * in a way it would not be in the menu pane. The fetches still run in
 * effects, and a small per-slug cache keeps a second open within the minute
 * from flashing "Loading" at the reader.
 */

import { useEffect, useState } from 'react';

import { owedWalk } from '../first-session/first-visit';
import { PlatformTarget } from './platform-target.js';
import type { AppRow } from './about-model';

/**
 * ./platform-target.js as this file reads it. A JS module's `_row: null`
 * infers as the null TYPE, so its getters are typed here for what they hold.
 */
const platform = PlatformTarget as unknown as {
  row(): AppRow | null;
  cachedAbout(): PlatformAbout | null;
  about(): Promise<PlatformAbout | null>;
};

type G = {
  Home?: { _apps?: AppRow[]; _appsLoaded?: boolean; load?: () => Promise<unknown> } & Record<string, any>;
  Browse?: { _apps?: AppRow[] };
  AppView?: { appData?: AppRow | null };
  App?: { _privateHomeVisited?: () => boolean; user?: { id?: number | string | null; homeWalkOwed?: boolean } | null };
};

function g(): G {
  return (typeof window === 'undefined' ? {} : window) as unknown as G;
}

function demoQS(): string {
  try {
    return new URLSearchParams(window.location.search).get('demo') === '1' ? '?demo=1' : '';
  } catch {
    return '';
  }
}

/**
 * Whether the mark menu is still offering a PRIVATE MEMBER "Go to Homeroom"
 * as their way on: they came in by an invite link before they were let in,
 * and have not used it yet on this device (App._privateNoClose,
 * public/js/app.js). While it is, the menu hides "Go to community" (#4216):
 * one way onward. It comes back once they have used it, or are let in
 * (`privateMember` goes false). About hid its Share too; Share is gone, and
 * the Invite that took its place is every member's, as the hub's is.
 *
 * Read during a render that runs after mount only: the visit is remembered
 * in this device's storage, which the prerender cannot see. The sheet
 * renders again on every open, which is when this can have changed.
 */
export function offeringGoToHomeroom(privateMember: boolean): boolean {
  if (!privateMember) return false;
  try {
    return !g().App?._privateHomeVisited?.();
  } catch {
    return true;
  }
}

/**
 * Whether this person is still owed the first session's walk on Home
 * (../first-session/first-visit.ts): a newcomer who made their first project
 * or came in by an invite, and has not yet reached Homeroom since. While it
 * is, the mark menu's way on is "Go to Homeroom" alone, which takes them
 * Home and runs the walk (firstSession.goHome), not "Go to community", which
 * opens the project's hub inside the app, where the walk does not run (Evan,
 * sign-up test, 19 Oct 2026). The tip under the mark says the same, and the
 * menu holds back news of a Homeroom update meanwhile (../improve/
 * actions.tsx): somebody who has not reached Homeroom yet has nothing to
 * update.
 *
 * Kept by the account too (App.user.homeWalkOwed, POST /api/me/home-walk),
 * so a second device agrees; read with this device's record. Read after
 * mount only, as offeringGoToHomeroom: the record is in this device's
 * storage, which the prerender cannot see.
 */
export function owedHomeWalk(): boolean {
  try {
    const app = g().App;
    const uid = app?.user?.id;
    if (uid == null) return false;
    // Owed on the account (App.user.homeWalkOwed) or on this device, and not
    // once they have reached Homeroom on any device (App._privateHomeVisited
    // reads the account's mark with this device's).
    const owed = owedWalk(uid) != null || app?.user?.homeWalkOwed === true;
    return owed && !app?._privateHomeVisited?.();
  } catch {
    return false;
  }
}

/** The list row for `slug`, from whichever copy of GET /api/apps this tab holds. */
export function listRowFor(slug: string | null): AppRow | null {
  if (!slug) return null;
  for (const list of [g().Home?._apps]) {
    if (!Array.isArray(list)) continue;
    const row = list.find((a) => a && a.slug === slug);
    if (row) return row;
  }
  return null;
}

/**
 * Everything this tab knows about the app: the list row over the detail
 * payload (the open app's, or the platform's row ./platform-target.js
 * fetched). Null only when neither has been loaded.
 */
export function knownAppRow(slug: string | null): AppRow | null {
  if (!slug) return null;
  const list = listRowFor(slug);
  const open = g().AppView?.appData;
  const platformRow = platform.row();
  const detail = open && open.slug === slug
    ? open
    : (platformRow && platformRow.slug === slug ? platformRow : null);
  if (!list && !detail) return null;
  return { ...(detail || {}), ...(list || {}) };
}

/**
 * The app row, and whether it is in the viewer's apps.
 *
 * A cold link straight into an app loads that app and not the list, and only
 * the list knows "Your apps" — so when this tab has never loaded it, the pane
 * asks Home to (Home.load, the call a dozen event paths already make from any
 * screen) and reads the row again when it lands.
 */
export function useAboutApp(slug: string | null, enabled: boolean): AppRow | null {
  const [row, setRow] = useState<AppRow | null>(() => knownAppRow(slug));
  useEffect(() => {
    if (!enabled || !slug) return undefined;
    setRow(knownAppRow(slug));
    const home = g().Home;
    if (listRowFor(slug) || !home || home._appsLoaded || typeof home.load !== 'function') {
      return undefined;
    }
    let live = true;
    Promise.resolve(home.load()).catch(() => {}).then(() => {
      if (live) setRow(knownAppRow(slug));
    });
    return () => { live = false; };
  }, [slug, enabled]);
  return row;
}

export interface ContributorsEntry {
  state: 'loading' | 'ready' | 'error';
  items: AppRow[];
  total: number;
}

const CACHE_MS = 60 * 1000;
const contribCache = new Map<string, { at: number; entry: ContributorsEntry }>();

/** GET /api/apps/:slug/contributors — Discover's app page's read. */
export function useContributors(slug: string | null, enabled: boolean): ContributorsEntry {
  const cached = slug ? contribCache.get(slug) : undefined;
  const [entry, setEntry] = useState<ContributorsEntry>(
    cached ? cached.entry : { state: 'loading', items: [], total: 0 },
  );
  useEffect(() => {
    if (!enabled || !slug) return undefined;
    const hit = contribCache.get(slug);
    if (hit && Date.now() - hit.at < CACHE_MS) {
      setEntry(hit.entry);
      return undefined;
    }
    let live = true;
    (async () => {
      let next: ContributorsEntry;
      try {
        const res = await fetch(`/api/apps/${encodeURIComponent(slug)}/contributors${demoQS()}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const items = Array.isArray(data && data.contributors) ? data.contributors : [];
        next = {
          state: 'ready',
          items,
          total: Number.isFinite(data && data.total) ? data.total : items.length,
        };
        contribCache.set(slug, { at: Date.now(), entry: next });
      } catch {
        next = { state: 'error', items: [], total: 0 };
      }
      if (live) setEntry(next);
    })();
    return () => { live = false; };
  }, [slug, enabled]);
  return enabled ? entry : { state: 'ready', items: [], total: 0 };
}

export interface PlatformAbout {
  name: string;
  tagline: string | null;
  repoUrl: string | null;
  version: string | null;
  updatedAt: string | null;
  stats: { apps: number; members: number; merged: number };
  selfAppSlug?: string | null;
  served?: boolean;
}

/**
 * GET /api/platform/about — Homeroom's identity and its three figures.
 *
 * The same read ./platform-target.js makes to find the platform on a cold
 * load, and the same cached answer: a pane opened after the menu found its
 * subject costs no request at all.
 */
export function usePlatformAbout(enabled: boolean): PlatformAbout | null {
  const [value, setValue] = useState<PlatformAbout | null>(() => platform.cachedAbout());
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    void platform.about().then((data) => {
      if (live && data) setValue(data);
    });
    return () => { live = false; };
  }, [enabled]);
  return value;
}
