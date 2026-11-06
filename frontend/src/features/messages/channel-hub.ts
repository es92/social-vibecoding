/**
 * A CHANNEL'S WAY BACK TO ITS HUB (#3407). A channel is a level inside its
 * community's hub (the hub's Channel card is its door), so its pane leads
 * with the same round chevron the hub's own pages (Needs you, the Workshop)
 * lead with. The header's arrow names the same place (store.ts channelHub);
 * this is the one in the page, where the reader already is.
 *
 * It is a door that says where it goes, so it lands on the hub itself, not
 * the tab that project page was last left on: AppView._landOnHub first, then
 * the hub's address (App._hubHref's spelling, the one Discover's rows follow).
 *
 * #general is the Homeroom community's channel, whose hub is the platform
 * project's. That slug is not known on a cold load: PlatformTarget.slug()
 * reads it off reads that may still be in flight (/api/version,
 * /api/platform/about, its own lookup), so the header SUBSCRIBES to it
 * (PlatformTarget.onSlug, fired wherever it becomes known) and draws the
 * label and the press from that one value (`generalHubBack`), so the two
 * can never disagree. Before anything knows it, the way back is Home, where
 * the communities are (One Home, #6361).
 */

import { useEffect, useSyncExternalStore } from 'react';

import { t } from '../../lib/i18n/runtime';

type PlatformTargetLike = {
  slug?: () => string | null;
  known?: () => { restricted?: boolean } | null;
  cachedAbout?: () => { served?: boolean } | null;
  resolve?: () => Promise<unknown> | unknown;
  onSlug?: (listener: (slug: string | null) => void) => () => void;
};

function platformTarget(): PlatformTargetLike | undefined {
  return typeof window !== 'undefined'
    ? (window as unknown as { PlatformTarget?: PlatformTargetLike }).PlatformTarget
    : undefined;
}

/** The platform project's slug, if anything has said it yet. */
export function platformSlug(): string | null {
  try { return platformTarget()?.slug?.() || null; } catch { return null; }
}

/**
 * May this viewer open the platform project's page? Not when the platform
 * has said its row is not served to them (PlatformTarget's restricted
 * target: not an admin, and SELF_APP_PUBLIC_VOTING off), whose hub would
 * not load. Unknown counts as yes, as the hub's other doors assume.
 */
export function platformHubServed(): boolean {
  try {
    const target = platformTarget();
    if (target?.known?.()?.restricted) return false;
    return target?.cachedAbout?.()?.served !== false;
  } catch {
    return true;
  }
}

/** Open `slug`'s hub, or Home when there is no slug. */
export function openChannelHub(slug: string | null): void {
  const win = window as unknown as { AppView?: { _landOnHub?: (slug: string) => void }; App?: { navigateHome?: () => void } };
  if (!slug) {
    // One Home (#6361): the communities are Home's.
    if (win.App?.navigateHome) win.App.navigateHome();
    else window.location.hash = '';
    return;
  }
  win.AppView?._landOnHub?.(slug);
  // The Hub's own address, as the header's arrow (messages/store.ts channelHub).
  window.location.hash = `#app/${encodeURIComponent(slug)}/dev/hub`;
}

/** Hear when the platform's slug changes; the unsubscribe. */
export function subscribePlatformSlug(onChange: () => void): () => void {
  try { return platformTarget()?.onSlug?.(() => onChange()) || (() => {}); }
  catch { return () => {}; }
}

/**
 * #general's way back, from ONE slug: the disc's label and where it goes
 * are read off the same value, so a render cannot say Communities and go to
 * Homeroom's hub.
 */
export function generalHubBack(slug: string | null): { label: string; onBack: () => void } {
  return {
    label: slug ? 'Homeroom' : t('core:tabs.home'),
    onBack: () => openChannelHub(slug),
  };
}

/**
 * The platform's slug for a header that needs it (`enabled`), kept current
 * through PlatformTarget.onSlug. It also asks for the lookup (shared, and
 * asked once at a time), in case nothing else on this load has yet.
 */
export function usePlatformSlug(enabled: boolean): string | null {
  const slug = useSyncExternalStore(subscribePlatformSlug, platformSlug, () => null);
  useEffect(() => {
    if (!enabled || platformSlug()) return;
    try { void Promise.resolve(platformTarget()?.resolve?.()).catch(() => null); } catch { /* offline */ }
  }, [enabled]);
  return enabled ? slug : null;
}
