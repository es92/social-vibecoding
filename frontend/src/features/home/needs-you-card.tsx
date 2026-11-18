/**
 * Needs you: Home's card under Standard (WIP) (`#home-aside`, ./index.tsx),
 * a full-width row of its own, just above Challenges.
 *
 * It is drawn only while a vote waits on the viewer: the same count Home's
 * Needs you tile and the tab badge read (`badgeNeeds`,
 * ../workshop/community-scope.ts), which a vote cast anywhere lowers. With
 * something waiting it reads the Needs you feed
 * (GET /api/workshop/needs-feed, the page's own read) for what the count
 * cannot say: how many of them the viewer's vote decides, how many are
 * advisory, and which communities they are in.
 *
 * The whole card is one link to Needs you (`#needs`), the page of every
 * decision owed across the viewer's projects, one per screen.
 *
 * Nothing in the prerender: the count starts unknown. The feed is read in
 * an effect, and only where the column is displayed, so a phone asks for
 * nothing it does not draw.
 */

import { useEffect, useState, type ReactNode } from 'react';

import { useMessages } from '../../lib/i18n/react';
import { sharedJson } from '../../lib/shared-read';
import { useStoreState } from '../../lib/use-store-state';
import { placeHref } from '../dev-board/workshop/places';
import { communityScopeStore } from '../workshop/community-scope';
import { SectionHeading } from './panels/ui';
import { WipCard, WipHeadMore, WipSkelRow } from './wip-kit';

/** What the card reads of a feed item (../workshop/needs-reel.tsx NeedsFeedItem). */
export interface NeedsCardItem {
  kind: string;
  id: number;
  title: string;
  advisory?: boolean;
  uncounted?: boolean;
  app?: { slug: string; name: string; icon_url?: string | null; icon_emoji?: string | null } | null;
}

/** True for an item whose outcome the viewer's vote can change. */
export function decides(item: NeedsCardItem): boolean {
  return !item.advisory && !item.uncounted;
}

/**
 * The card's numbers. `waiting` is the count of votes waiting; once the feed
 * is read its own length is the total, so the two parts in words add up to
 * the number beside them.
 */
export function needsSummary(waiting: number, feed: NeedsCardItem[] | null): { total: number; decide: number; advisory: number } | null {
  if (!feed) return waiting > 0 ? { total: waiting, decide: 0, advisory: 0 } : null;
  if (!feed.length) return null;
  const decide = feed.filter(decides).length;
  return { total: feed.length, decide, advisory: feed.length - decide };
}

function demoQuery(): string {
  try {
    return new URLSearchParams(location.search).get('demo') === '1' ? '?demo=1' : '';
  } catch {
    return '';
  }
}

// The card is the look's own (./wip-kit.tsx, app.css "STANDARD (WIP)"): its
// label, the count and See all on one line, then what waits as rows in
// one to four columns by the screen's width, each with its whole title, opening its project's Needs you.

/** Where the count of the last visit is kept on the device, for the first paint's placeholder. */
export const NEEDS_HINT_KEY = 'homeroom:needs-waiting';
export function readNeedsHint(): number {
  try { return Math.max(0, Math.trunc(Number(window.localStorage.getItem(NEEDS_HINT_KEY)) || 0)); } catch { return 0; }
}
export function writeNeedsHint(count: number): void {
  try {
    if (count > 0) window.localStorage.setItem(NEEDS_HINT_KEY, String(count));
    else window.localStorage.removeItem(NEEDS_HINT_KEY);
  } catch { /* the next load draws no placeholder */ }
}

/** How many decisions the card lists (two lines of four on a wide screen); See all has the rest. */
export const NEEDS_ROWS = 8;

/** A plain tap opens the project on its Needs you; the browser keeps a new tab's click. */
function openNeeds(event: React.MouseEvent<HTMLAnchorElement>, slug: string) {
  const win = window as any;
  if (win.NavLink?.isNativeClick?.(event)) return;
  event.preventDefault();
  try { win.AppView?._landOnTab?.(slug, 'needs'); } catch { /* the page opens on what it remembers */ }
  win.App?.navigateToApp?.(slug, 'dev');
}

/** The communities that wait, once each, in the feed's order: four at most. */
export function waitingApps(feed: NeedsCardItem[] | null): NonNullable<NeedsCardItem['app']>[] {
  const seen = new Set<string>();
  const out: NonNullable<NeedsCardItem['app']>[] = [];
  for (const item of feed || []) {
    if (!item.app || seen.has(item.app.slug)) continue;
    seen.add(item.app.slug);
    out.push(item.app);
    if (out.length === 4) break;
  }
  return out;
}

function AppIcon({ app }: { app: NeedsCardItem['app'] }) {
  if (app?.icon_url) {
    return <img src={app.icon_url} alt="" draggable={false} className="wip-item-icon" />;
  }
  return <span className="wip-item-icon" aria-hidden="true">{app?.icon_emoji || (app?.name || '').slice(0, 1).toUpperCase()}</span>;
}

export function NeedsYouCard(): ReactNode {
  const t = useMessages('home');
  const { badgeNeeds } = useStoreState(communityScopeStore) as { badgeNeeds?: number | null };
  // Until the count is known this load, the card stands on what the last
  // visit saw on this device, so its place is held from the first paint and
  // nothing under it moves when the count and the list arrive. Somebody with
  // nothing waiting last time gets no placeholder to flash and go.
  const [hint] = useState(readNeedsHint);
  const known = typeof badgeNeeds === 'number';
  const waiting = Math.max(0, known ? Number(badgeNeeds) || 0 : hint);
  useEffect(() => { if (known) writeNeedsHint(Number(badgeNeeds) || 0); }, [known, badgeNeeds]);
  const [feed, setFeed] = useState<NeedsCardItem[] | null>(null);
  // Read again whenever the count moves: a vote cast, or a new one opened.
  useEffect(() => {
    if (!waiting) { setFeed(null); return undefined; }
    // The remembered count draws the placeholder; the list is read once the
    // count is this load's own.
    if (!known) return undefined;
    let live = true;
    sharedJson<{ items?: NeedsCardItem[] }>(`/api/workshop/needs-feed${demoQuery()}`, { fresh: true })
      .then((body) => { if (live && body && Array.isArray(body.items)) setFeed(body.items); })
      .catch(() => { /* the card keeps its count; the page says what failed */ });
    return () => { live = false; };
  }, [waiting, known]);

  const summary = needsSummary(waiting, feed);
  if (!summary) return null;
  const rows = (feed || []).slice(0, NEEDS_ROWS);
  const more = (feed || []).length - rows.length;

  return (
    <section id="home-needs-card" aria-label={t('home:needsCard.eyebrow')} data-needs={String(summary.total)}>
      {/* The section's label line, on the page as every section's is: the
          label, the count beside it and a chevron, all one link that opens
          all of Needs you. */}
      <SectionHeading>
        <WipHeadMore
          id="home-needs-card-btn"
          direction="right"
          href="#needs"
          label={more > 0 ? t('home:needsCard.seeAllCount', { count: summary.total }) : t('home:needsCard.seeAll')}
        >
          <span id="home-needs-card-title" className="wip-head-words">{t('home:needsCard.eyebrow')}</span>
          <span className="wip-count" aria-hidden="true">{summary.total}</span>
        </WipHeadMore>
        <span className="sr-only">{t('home:needsCard.waiting', { count: summary.total })}</span>
      </SectionHeading>
      {/* What waits, in one to four columns by the room there is, each a row that opens its project's Needs you. */}
      {!feed ? (
        // The list is on its way: as many placeholder rows as wait (as far as
        // the card lists), in the same columns, so the card is its own height.
        <WipCard className="wip-panel animate-pulse" data-tone="ask" data-loading="" role="status" aria-label={t('home:grid.loading')}>
          <ul className="wip-rows wip-rows-cols">
            {Array.from({ length: Math.min(summary.total, NEEDS_ROWS) }, (_, i) => <li key={i}><WipSkelRow /></li>)}
          </ul>
        </WipCard>
      ) : rows.length ? (
        <WipCard className="wip-panel" data-tone="ask">
        <ul className="wip-rows wip-rows-cols" aria-labelledby="home-needs-card-title">
          {rows.map((item) => {
            const slug = item.app?.slug || '';
            return (
              <li key={`${item.kind}:${item.id}`}>
                <a
                  className="wip-row"
                  href={slug ? placeHref(slug, 'needs') : '#needs'}
                  data-needs-item={`${item.kind}:${item.id}`}
                  onClick={slug ? (event) => openNeeds(event, slug) : undefined}
                >
                  <AppIcon app={item.app} />
                  <span className="wip-item-text">
                    <b className="wip-item-title">{item.title}</b>
                    <span className="wip-item-meta">{item.app?.name || ''}</span>
                  </span>
                  <span className={decides(item) ? 'wip-pill wip-pill-action' : 'wip-pill'}>
                    {decides(item) ? t('home:needsCard.vote') : t('home:needsCard.advisoryPill')}
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
        </WipCard>
      ) : null}
    </section>
  );
}
