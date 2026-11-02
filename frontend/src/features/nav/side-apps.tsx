/**
 * The apps in iPhone Duo's side strip: the one on screen, lit, and the one
 * you left, to resume (24 Oct 2026, Evan's design).
 *
 * On the Duo the tabs stand as one pill down the strip (../../lib/
 * side-strip.ts, app.css THE SIDE STRIP). Under Communities it has an
 * Apps section with a small heading: the app you are in, drawn the way a
 * tab is and lit by the bar's own marker (./tab-bar.tsx targets it while no
 * tab is lit), and the app you left with its ✕, which is what the phone's
 * Resume strip (./parked-strip.tsx) offers and which the strip hides there.
 * Nothing is drawn when neither is there, so the heading only ever names
 * something.
 *
 * IN THE BAR, AND FIRST IN IT. The marker can only light what is inside the
 * bar, so this renders inside #platform-tabs. It is the bar's first child
 * after the marker rather than between Communities and you: the declared
 * checks pin the tabs' sibling chain from Home to the cog, and app.css puts
 * it under Communities with `order`. Off the strip it is never drawn.
 *
 * The stores are empty on the prerender (both start with no app; the parked
 * one reads storage in the Resume strip's effect), so the first render is
 * the shipped one.
 */

import { XIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { useStoreState } from '../../lib/use-store-state';
import { AppIconContent, appIconKind } from '../apps/app-card-view';
import { useNamedApp } from './app-names';
import { forgetParked } from './parked-strip';
import { parkedStore, runningAppStore } from './parked-store.js';
import { noteResumeOrigin } from './resume-motion';

type StripApp = { slug: string; name: string; iconUrl: string | null; iconEmoji: string | null };

function record(app: StripApp) {
  return { icon_url: app.iconUrl, icon_emoji: app.iconEmoji, name: app.name };
}

function isModifiedClick(event: React.MouseEvent): boolean {
  return event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
}

// The icon loads at once: the strip is always on screen, and a lazy image in
// it stayed its first letter for as long as Home was up (1 Nov 2026).
function AppTile({ app }: { app: StripApp }) {
  return (
    <>
      <span className="platform-tab-mark">
        <span data-icon={appIconKind(record(app))} className="app-icon-tile platform-side-app-tile">
          <AppIconContent app={record(app)} eager />
        </span>
      </span>
      <span className="platform-tab-label">{app.name}</span>
    </>
  );
}

export function SideApps() {
  const t = useMessages();
  // Each by its name while this device remembers it, never its slug
  // (./app-names.ts).
  const running = useNamedApp(useStoreState(runningAppStore).app as StripApp | null);
  const parked = useNamedApp(useStoreState(parkedStore).app as StripApp | null);
  const left = parked && parked.slug !== running?.slug ? parked : null;
  return (
    <div className={'platform-side-apps' + (running || left ? '' : ' hidden')}>
      <span className="platform-side-apps-head" aria-hidden="true">{t('core:tabs.stripApps')}</span>
      {running ? (
        // The app on screen: a place you are at, like a lit tab. A press
        // stays where it is.
        <a
          className="platform-side-app"
          data-side-app={running.slug}
          href={`/app/${encodeURIComponent(running.slug)}`}
          aria-current="page"
          aria-label={running.name}
          onClick={(event) => { if (!isModifiedClick(event)) event.preventDefault(); }}
        >
          <AppTile app={running} />
        </a>
      ) : null}
      {left ? (
        <div className="platform-side-app-row">
          <a
            className="platform-side-app"
            data-side-app={left.slug}
            href={`/app/${encodeURIComponent(left.slug)}`}
            aria-label={t('core:tabs.stripResume', { app: left.name })}
            onClick={(event) => {
              if (isModifiedClick(event)) return;
              event.preventDefault();
              // It grows out of the tile, where its close lands
              // (./resume-motion.ts resumeHandleFor), not the whole row.
              noteResumeOrigin(left.slug, event.currentTarget.querySelector('.platform-side-app-tile') || event.currentTarget);
              window.App?.openAppTab?.(left.slug, 'app');
            }}
          >
            <AppTile app={left} />
          </a>
          <button
            type="button"
            className="platform-side-app-x"
            aria-label={t('core:parked.forget', { app: left.name })}
            onClick={() => forgetParked(left)}
          >
            <XIcon className="w-3 h-3" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
