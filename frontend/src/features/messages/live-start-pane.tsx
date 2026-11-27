/**
 * THE PREVIEW'S COLUMN, WAITING (26 Nov 2026). From 1500px, where the
 * Homeroom bot tab has room for list | chat | preview, a new chat does not
 * wait for a button in its head: the column a live preview runs in is
 * already there beside it (../ai/index.tsx draws it; ./new-thread.tsx START
 * LIVE PREVIEW says what the button does).
 *
 *   Live preview                       Live preview
 *   Garden club · not started          No project picked yet
 *   ┌────────────────────────┐         ┌────────────────────────┐
 *   │ See Garden club change │         │ Pick a project to      │
 *   │ as you talk            │         │ preview                │
 *   │ [▶ Start live preview] │         │ (Garden club) (Outreach)│
 *   └────────────────────────┘         │ [All projects ⌄]       │
 *                                      └────────────────────────┘
 *
 * With a project picked whose app can be changed live, Start is the new
 * chat's own live start: the first message, sent for the person. With About
 * on Any project (or on a project that has no live preview) the column asks
 * for one: the person's recent projects that can be previewed, and the same
 * picker the About chip opens. Picking only sets About; nothing starts until
 * Start is pressed.
 *
 * `opening` is the moment after Start: the thread is made and Homeroom bot
 * is opening the draft, so the column says so instead of going away and
 * coming back when the preview arrives.
 *
 * The new chat is another tree (the chat column), so what it is set to is
 * read from its store and acted on through its two functions. It is drawn
 * as the column's other cards are (../detail/detail-card.tsx): a head card,
 * then the thing in a card under it, so it takes their classes and paint.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { ChevronDownIcon, PlayIcon, XIcon } from '@/components/ui/icons';
import { useMessages } from '../../lib/i18n/react';
import { useStoreState } from '../../lib/use-store-state';
import { navStore } from '../nav/nav-store.js';
import { pinnedAppsStore } from '../nav/pinned-apps-store.js';
import { readKept } from '../nav/rail-communities';
import { communityScopeStore, loadCommunities, type CommunityInfo } from '../workshop/community-scope';
import { switcherRecent } from '../workshop/community-switcher';
import { platformSlug } from './channel-hub';
import { liveStartStore, offersLive, pickLiveProject, startLivePreview } from './new-thread';
import { ProjectPicker, Tile } from './project-picker';

/** How many recent projects the column offers before "All projects". */
export const LIVE_PICKS = 4;

/**
 * Pure: the projects the column offers while none is picked: the person's
 * recent ones (the picker's own Recent) that can be previewed live, at most
 * `LIVE_PICKS`.
 */
export function livePicks(
  recent: readonly string[],
  info: Record<string, (CommunityInfo & { selfHosted?: boolean }) | undefined>,
  who: { platformSlug?: string | null; isAdmin?: boolean },
): CommunityInfo[] {
  const out: CommunityInfo[] = [];
  for (const slug of recent) {
    const row = info[slug];
    if (!row || !offersLive(slug, info, who)) continue;
    out.push(row);
    if (out.length >= LIVE_PICKS) break;
  }
  return out;
}

/** The placeholder of an app's screen, behind the column's words. */
function Ghost(): ReactNode {
  return (
    <div className="live-start-ghost" aria-hidden="true">
      <span style={{ height: 44 }} />
      <span style={{ height: 150 }} />
      <div><span /><span /></div>
      <span style={{ height: 22, width: '60%' }} />
      <span style={{ height: 22, width: '82%' }} />
      <span style={{ height: 22, width: '46%' }} />
    </div>
  );
}

export function LiveStartPane({ opening = null, onClose }: {
  opening?: { name: string } | null;
  /** The column's close, as a real preview's head has (../ai/live-column.ts keeps the choice). */
  onClose?: () => void;
}): ReactNode {
  const t = useMessages('messages');
  const chat = useStoreState(liveStartStore);
  const scope = useStoreState(communityScopeStore);
  const { viewer } = useStoreState(navStore) as { viewer?: unknown };
  const { apps: pins } = useStoreState(pinnedAppsStore) as { apps: { slug: string }[] };
  const [kept] = useState(() => readKept(viewer as never));
  const [picking, setPicking] = useState(false);
  const allRef = useRef<HTMLButtonElement | null>(null);
  // The projects to offer are the communities you are in, read once the column asks for one.
  const asks = !opening && !!chat && !chat.offered;
  useEffect(() => { if (asks) void loadCommunities(); }, [asks]);

  const info = chat?.project ? scope.info[chat.project] || null : null;
  const name = opening ? opening.name : chat?.name || '';
  const line = opening ? t('messages:newThread.live.pane.opening', { app: name })
    : chat?.offered ? t('messages:newThread.live.pane.notStarted', { app: name })
    : t('messages:newThread.live.pane.noProject');
  const picks = asks ? livePicks(
    switcherRecent(pins.map((app) => app.slug), kept, scope.list),
    scope.info as Record<string, (CommunityInfo & { selfHosted?: boolean }) | undefined>,
    { platformSlug: platformSlug(), isAdmin: typeof window !== 'undefined' && !!(window as any).App?.user?.isAdmin },
  ) : [];

  return (
    <div className="detail-card live-start" data-live-start={opening ? 'opening' : chat?.offered ? 'ready' : 'pick'}>
      <header className="detail-card-head live-start-head">
        {info && !opening ? <Tile info={info} className="live-start-head-tile" /> : null}
        <div className="min-w-0 flex-1">
          <h2 className="live-start-name">{t('messages:newThread.live.pane.title')}</h2>
          <p className="live-start-sub" data-live-start-line="">{line}</p>
        </div>
        {onClose ? (
          <span className="detail-card-exits">
            <Button type="button" variant="unstyled" size="icon" ink="none" className="detail-card-disc" data-live-start-close=""
              aria-label={t('messages:newThread.live.pane.close')} title={t('messages:newThread.live.pane.close')} onClick={onClose}>
              <XIcon className="h-4 w-4" aria-hidden="true" />
            </Button>
          </span>
        ) : null}
      </header>
      <div className="detail-card-body live-start-body">
        <Ghost />
        {opening ? (
          <div className="live-start-cta" role="status">
            <h3 className="live-start-title">{t('messages:newThread.live.pane.openingTitle', { app: name })}</h3>
            <p className="live-start-text">{t('messages:newThread.live.pane.openingBody')}</p>
          </div>
        ) : chat?.offered ? (
          <div className="live-start-cta">
            {info ? <Tile info={info} className="live-start-tile" /> : null}
            <h3 className="live-start-title">{t('messages:newThread.live.pane.startTitle', { app: name })}</h3>
            <p className="live-start-text">{t('messages:newThread.live.pane.startBody', { app: name })}</p>
            <Button type="button" variant="sun" size="none" ink="none" className="live-start-go" data-live-start-go="" disabled={chat.busy} onClick={() => startLivePreview()}>
              <PlayIcon aria-hidden="true" />
              <span>{t('messages:newThread.live.pane.start')}</span>
            </Button>
            <p className="live-start-note">{t('messages:newThread.live.pane.startNote', { app: name })}</p>
          </div>
        ) : (
          <div className="live-start-cta">
            <h3 className="live-start-title">{t('messages:newThread.live.pane.pickTitle')}</h3>
            <p className="live-start-text">{t('messages:newThread.live.pane.pickBody')}</p>
            {picks.length ? (
              <div className="live-start-picks" role="group" aria-label={t('messages:newThread.live.pane.pickTitle')}>
                {picks.map((row) => (
                  <Button key={row.slug} type="button" variant="unstyled" size="none" ink="none" className="live-start-pick" data-live-start-pick={row.slug} onClick={() => pickLiveProject(row.slug)}>
                    <Tile info={row} className="live-start-pick-tile" />
                    <span className="truncate">{row.name}</span>
                  </Button>
                ))}
              </div>
            ) : null}
            <Button
              type="button"
              variant="unstyled"
              size="none"
              ink="none"
              className="live-start-all"
              data-live-start-all=""
              aria-haspopup="dialog"
              aria-expanded={picking}
              ref={allRef}
              onClick={() => setPicking((open) => !open)}
            >
              <span>{t('messages:newThread.live.pane.pickAll')}</span>
              <ChevronDownIcon aria-hidden="true" />
            </Button>
            <p className="live-start-note">{t('messages:newThread.live.pane.pickNote')}</p>
          </div>
        )}
      </div>
      <ProjectPicker
        open={picking}
        slug={chat?.project || null}
        anchor={allRef.current}
        onPick={(slug) => { setPicking(false); pickLiveProject(slug || ''); }}
        onClose={() => setPicking(false)}
      />
    </div>
  );
}
