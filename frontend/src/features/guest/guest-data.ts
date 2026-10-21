/**
 * The data behind the guest Discover and the guest project page: what a
 * visitor with no account reads (./guest-discover.tsx, ./guest-project.tsx).
 *
 * Both read the public API only. The directory is GET /api/public/apps,
 * which the landing already loads (features/auth/landing.tsx
 * loadLandingApps); a project's page adds GET /api/public/apps/:slug/overview
 * (src/services/public-project.js). Neither carries a person's name.
 *
 * Everything here is pure except the one fetch, so the sorting and filtering
 * Discover does are unit-tested (tests/guest-discover.test.js).
 */

import type { PublicApp } from '../auth/shared';

/** A row of GET /api/public/apps, with the fields the guest pages read. */
export interface GuestApp extends PublicApp {
  slug: string;
  name: string;
  description?: string | null;
  category?: string | null;
  featured?: boolean;
  featured_order?: number | null;
  icon_color?: string | null;
  illustration_url?: string | null;
  illustration_dark_url?: string | null;
  active_users?: number;
  member_count?: number;
  open_votes?: number;
  /** How many of its changes the group voted in and are live. */
  merged_count?: number;
  /** The title of the last of them, or null (none, or one still called by its placeholder). */
  latest_change?: string | null;
  created_at?: string | null;
  last_deploy_at?: string | null;
  last_merged_at?: string | null;
  guest_ready?: boolean;
  contributors?: unknown[];
}

export interface GuestVote {
  id: number;
  pr_number: number | null;
  title: string | null;
  summary: string | null;
  yes: number;
  no: number;
}

export interface GuestMerged {
  id: number;
  title: string | null;
  summary: string | null;
  merged_at: string | null;
}

export interface GuestOverview {
  app: GuestApp & { builders: number };
  votes: GuestVote[];
  merged: GuestMerged[];
  requests: { total: number; more: boolean; items: { number: number; title: string }[] } | null;
}

/** The sorts Discover offers, in the order its control shows them. */
export const SORTS = ['trending', 'new', 'built'] as const;
export type GuestSort = (typeof SORTS)[number];

/**
 * The kinds of app, in app-manifest.js APP_CATEGORIES order (the same list
 * Discover's type chips use, features/apps/browse.js CATEGORIES). Only the
 * kinds some app in the directory has get a chip (presentCategories).
 */
export const CATEGORIES = ['games', 'social', 'tools', 'learning', 'creative', 'other'] as const;

/** How many people built it: the directory's contributors, counted. */
export function buildersOf(app: GuestApp): number {
  return Array.isArray(app.contributors) ? app.contributors.length : 0;
}

/** Newest first by when it was made; an app with no date sorts last. */
function createdAt(app: GuestApp): number {
  const t = app.created_at ? Date.parse(app.created_at) : NaN;
  return Number.isFinite(t) ? t : 0;
}

/** The directory in a sort's order. Ties keep the directory's own order. */
export function sortApps(apps: readonly GuestApp[], sort: GuestSort): GuestApp[] {
  const indexed = apps.map((app, i) => ({ app, i }));
  const key = (app: GuestApp): number => {
    if (sort === 'new') return createdAt(app);
    if (sort === 'built') return buildersOf(app);
    return app.active_users || 0;
  };
  indexed.sort((a, b) => key(b.app) - key(a.app) || a.i - b.i);
  return indexed.map((x) => x.app);
}

/** The kinds of app the directory has, in CATEGORIES order. */
export function presentCategories(apps: readonly GuestApp[]): string[] {
  const have = new Set(apps.map((a) => a.category).filter(Boolean) as string[]);
  // A row of All and Other alone would sort nothing (the same rule as
  // Discover's own type chips).
  if (![...have].some((c) => c !== 'other')) return [];
  return CATEGORIES.filter((c) => have.has(c));
}

/** What a search and a kind leave of the directory. */
export function filterApps(apps: readonly GuestApp[], query: string, category: string | null): GuestApp[] {
  const q = query.trim().toLowerCase();
  return apps.filter((a) => {
    if (category && a.category !== category) return false;
    if (!q) return true;
    return `${a.name} ${a.description || ''}`.toLowerCase().includes(q);
  });
}

/** The row "Picked this week" shows: what an admin featured, in their order. */
export function featuredApps(apps: readonly GuestApp[]): GuestApp[] {
  return apps
    .filter((a) => a.featured)
    .slice()
    .sort((a, b) => (a.featured_order ?? Number.MAX_SAFE_INTEGER) - (b.featured_order ?? Number.MAX_SAFE_INTEGER));
}

/** Where a project's page is: its hub, the address a signed-in person lands on too. */
export function projectHash(slug: string): string {
  return `#app/${encodeURIComponent(slug)}/workshop`;
}

/** A project's overview, or null when it is not public (404) or cannot be read. */
export async function fetchOverview(slug: string): Promise<GuestOverview | null> {
  try {
    const res = await fetch(`/api/public/apps/${encodeURIComponent(slug)}/overview`);
    if (!res.ok) return null;
    return (await res.json()) as GuestOverview;
  } catch {
    return null;
  }
}
