/**
 * A project's name, kept with its slug wherever the shell remembers it
 * (offline test, 2 Nov 2026).
 *
 * ── The problem, stated as somebody hit it ────────────────────────────
 *
 * With the internet off, the Resume strip above the tab bar read
 * "neighbourhood-swap-0…" with an "N" tile where it had read "Neighbourhood
 * Swap", and it kept saying so after the network came back.
 *
 * The router names the app you are in, and the one you leave, from a record:
 * the one the app view read (GET /api/apps/:slug) or the launcher's cached row
 * (GET /api/apps). Offline neither may have loaded, and then it hands over the
 * slug as the name (`App._parkRecord` in public/js/app.js), because a handle
 * named after its slug beats no handle. That stand-in was WRITTEN OVER the
 * name this device already had, in the strip and in the apps you left, and
 * nothing parks an app again until you open it and leave it.
 *
 * ── The rule ─────────────────────────────────────────────────────────
 *
 * A slug is never taken as a name while this device remembers one. What it
 * remembers was already kept, each for its own reasons and each for the
 * viewer it was written for:
 *   - your communities (../workshop/community-scope.ts, kept as
 *     `communityScopeList:v1`, and described by each project page you open);
 *   - the app on screen and the app you left (./parked-store.js);
 *   - the apps you left (./recent-apps-store.js);
 *   - your pinned communities (./pinned-apps-store.js).
 * Nothing new is stored, so nothing new has to be cleared: each of those is
 * swept the way it always was.
 *
 * Three callers:
 *   - the bridge's writers (./mount.ts `park`, `running`, `collapse`), so a
 *     stand-in never replaces a name in storage;
 *   - the strips' renders (`useNamedApp`: ./parked-strip.tsx,
 *     ./side-apps.tsx), so an entry stored by its slug alone (before this,
 *     or while no name was known yet) is drawn by its name as soon as any of
 *     those stores knows it;
 *   - the router, through the bridge's `knownApp`, to name the App tab's
 *     header when no list of apps has loaded.
 *
 * MEMORY ONLY, never storage. Every store above is read back from storage for
 * the viewer when the viewer is named (mount.ts `setViewer`, and
 * hydrateCommunityScope for the communities), so nothing here reads storage,
 * and a render may call it. On the prerender every store is empty and the
 * strips have no app, so the first client render is the shipped one.
 */

import { useStoreState } from '../../lib/use-store-state';
import { communityScopeStore } from '../workshop/community-scope';
import { parkedStore, runningAppStore } from './parked-store.js';
import { pinnedAppsStore } from './pinned-apps-store.js';
import { recentAppsStore } from './recent-apps-store.js';

/** What the strips draw an app with. */
export type AppFace = { slug: string; name: string; iconUrl: string | null; iconEmoji: string | null };

type Named = { slug?: string; name?: string | null; iconUrl?: string | null; iconEmoji?: string | null };

type Community = { name?: string; iconUrl?: string | null; iconEmoji?: string | null; selfHosted?: boolean };

/** Where a name may be remembered, in the order they are asked. */
export type NameSources = {
  /** Your communities, by slug: the server's last word on each. */
  info: Record<string, Community | undefined>;
  /** Lists of remembered apps: the strips' own, the apps you left, your pins. */
  lists: ReadonlyArray<ReadonlyArray<Named | null | undefined>>;
};

/** Whether `app` has a name of its own, and not its slug standing in for one. */
export function hasOwnName(app: Named | null | undefined): boolean {
  const name = typeof app?.name === 'string' ? app.name.trim() : '';
  return !!name && name !== app?.slug;
}

/** Every source, as it is now. */
function sourcesNow(): NameSources {
  return {
    info: communityScopeStore.get().info,
    lists: [
      [runningAppStore.get().app, parkedStore.get().app],
      recentAppsStore.get().apps,
      pinnedAppsStore.get().apps,
    ],
  };
}

/**
 * The name and face remembered for `slug`, or null when none is. The
 * community list answers first: it is read again at every sign-in and
 * described by every project page, so it is the freshest of them.
 */
export function knownFace(slug: string, sources: NameSources = sourcesNow()): AppFace | null {
  if (!slug) return null;
  const community = sources.info[slug];
  if (community && hasOwnName({ slug, name: community.name })) {
    return {
      slug,
      name: String(community.name),
      iconUrl: community.iconUrl || null,
      iconEmoji: community.iconEmoji || null,
    };
  }
  for (const list of sources.lists) {
    for (const app of list || []) {
      if (app && app.slug === slug && hasOwnName(app)) {
        return { slug, name: String(app.name), iconUrl: app.iconUrl || null, iconEmoji: app.iconEmoji || null };
      }
    }
  }
  return null;
}

/**
 * `app`, named: unchanged when it has a name of its own, which always wins
 * (it is the record the router just read); otherwise with the remembered name,
 * and the remembered artwork where it has none. Unchanged when nothing is
 * remembered either, so the slug still names a handle nobody ever named.
 */
export function withKnownName<T extends AppFace>(app: T, sources?: NameSources): T;
export function withKnownName<T extends AppFace>(app: T | null, sources?: NameSources): T | null;
export function withKnownName<T extends AppFace>(app: T | null, sources?: NameSources): T | null {
  if (!app || !app.slug || hasOwnName(app)) return app;
  const known = knownFace(app.slug, sources);
  if (!known) return app;
  return {
    ...app,
    name: known.name,
    iconUrl: app.iconUrl || known.iconUrl,
    iconEmoji: app.iconEmoji || known.iconEmoji,
  };
}

/**
 * For the router (the bridge's `knownApp`): the remembered name and face, and
 * whether the community list says the slug is the platform's own row, which
 * is never named as an app.
 */
export function knownApp(slug: string): (AppFace & { selfHosted: boolean }) | null {
  const face = knownFace(String(slug || ''));
  if (!face) return null;
  return { ...face, selfHosted: !!communityScopeStore.get().info[face.slug]?.selfHosted };
}

/**
 * `app` as a strip draws it: named from what is remembered when it was
 * stored by its slug alone. Subscribes to the sources, so the strip changes
 * the moment one learns the name (the community list read after sign-in).
 * The strips' own app is the one being drawn, so it is not asked about
 * itself.
 */
export function useNamedApp<T extends AppFace>(app: T | null): T | null {
  const { info } = useStoreState(communityScopeStore);
  const { apps: recents } = useStoreState(recentAppsStore);
  const { apps: pins } = useStoreState(pinnedAppsStore);
  if (!app || hasOwnName(app)) return app;
  return withKnownName(app, { info, lists: [recents, pins] });
}
