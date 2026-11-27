/**
 * `#app-permissions-list` — the App device permissions rows (#2219).
 *
 * The sibling of ./grants-list.tsx, written the same way: the host is STATIC
 * in the React tree (sections/app-permissions.tsx), settings.js keeps every
 * fetch and every DELETE/POST, and the handlers are called BY NAME on
 * `window.Settings` because that module is a classic script this bundle
 * cannot import.
 *
 * Rows are grouped BY APP rather than listed flat. A grant is per capability,
 * so a flat list would repeat the same app name four times and bury the
 * question a person actually came here to answer, which is "what does this
 * app have?".
 */

import { Button } from '@/components/ui/button';
import { GroupedList, ListRow } from '@/components/ui/grouped-list';

import { closeLiveApp, isLiveApp } from '../app-frame/live-apps';
import { useMessages } from '../../lib/i18n/react';
import { agoStamp } from '../../lib/timestamp';
import { useStoreState } from '../../lib/use-store-state';
import { appPermissionsStore } from './app-permissions-store.js';
import { PermissionsEmpty } from './permissions-empty';

type PermissionItem = {
  capability: string;
  label: string;
  revoked: boolean;
  /** When it was last allowed, or on a revoked row when it was revoked (#6512). */
  at?: string | null;
};
type PermissionAppView = {
  appId: number;
  appName: string;
  appSlug: string;
  items: PermissionItem[];
};
type AppPermissionsState = { phase: 'idle' | 'loading' | 'error' | 'ready'; apps: PermissionAppView[] };

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).Settings : null) || null;
}

/** A row's action at the end, at the 12px these controls are drawn for. */
const TRAILING = 'flex shrink-0 items-center gap-2 text-xs';

/**
 * #6512: what the riskier capabilities actually let an app do, in a line
 * under the row. Only these three: they see or hear the person and what is
 * around them, where a USB or MIDI device is a thing they plugged in on
 * purpose and location is already named by its label. Microphone is here
 * with the camera because it hears the room as well as the person, and
 * nothing on screen shows what it picked up.
 *
 * Each note says what the PERMISSION lets the app do, so it stays true on a
 * revoked row beside Re-enable, and it says the browser must allow it too:
 * the grant here only delegates the capability to the frame.
 *
 * Screen sharing is worded for how it is granted: the frame's `allow` only
 * DELEGATES `display-capture`, and `getDisplayMedia` opens the browser's own
 * picker on every call, so the app sees the screen, window or tab the
 * person picks there, never "your screen" on its own say-so.
 */
function capabilityNote(t: ReturnType<typeof useMessages>, capability: string): string {
  switch (capability) {
    case 'camera': return t('settings:appPermissions.note.camera');
    case 'microphone': return t('settings:appPermissions.note.microphone');
    case 'display-capture': return t('settings:appPermissions.note.screen');
    default: return '';
  }
}

function CapabilityRow({ app, item }: { app: PermissionAppView; item: PermissionItem }) {
  const t = useMessages('settings');
  const note = capabilityNote(t, item.capability);
  // #6512: when it was allowed, or revoked, in the card form Blocked apps
  // uses ("3d ago", a date from a week on) with the full stamp on hover.
  // When it was last USED is not something Homeroom records: the browser
  // hands the camera to the app's frame and tells nobody.
  const when = agoStamp(item.at);
  return (
    <ListRow
      inset="text"
      title={item.label}
      // An item under its app's row: the list's lighter weight (the app's
      // name is the bold one), struck through and greyed once revoked.
      titleClassName={item.revoked
        ? 'font-normal text-zinc-400 line-through dark:text-zinc-500'
        : 'font-normal'}
      subtitle={when.text || note ? (
        <>
          {when.text ? (
            <time data-role="permission-at" dateTime={item.at ?? undefined} title={when.title} className="block">
              {item.revoked
                ? t('settings:appPermissions.revokedAt', { when: when.text })
                : t('settings:appPermissions.allowedAt', { when: when.text })}
            </time>
          ) : null}
          {note ? (
            <span data-role="capability-note" className="mt-0.5 block">
              {note}
            </span>
          ) : null}
        </>
      ) : undefined}
      subtitleClassName="whitespace-normal"
      chevron={false}
      trailing={<span className={TRAILING}>{item.revoked ? (
        // The way back, for the same reason grants-list.tsx grew one (#1957):
        // re-approving otherwise depends on the app asking again, and an app
        // that never asks again never opens the prompt. Same control as that
        // file's Re-enable, because the two sections sit next to each other.
        <Button
          type="button"
          aria-label={t('settings:appPermissions.reEnableLabel', { permission: item.label, app: app.appName })}
          data-role="re-enable"
          layout="shrink"
          variant="compact"
          size="xs"
          onClick={() => { void controller()?._onPermissionReenable?.(app.appId, app.appSlug, item.capability); }}
        >
          {t('settings:appPermissions.reEnable')}
        </Button>
      ) : (
        /*
            The red-tinted box from grants-list.tsx's Revoke, not an outlined
            Button: the language draws no outlined control (see the `neutral`
            variant in @/components/ui/button.tsx), and these rows render
            directly beside that section's.
        */
        <button
          type="button"
          // #6512: an app's rows each say "Revoke", so the name a screen
          // reader hears says which permission and which app.
          aria-label={t('settings:appPermissions.revokeLabel', { permission: item.label, app: app.appName })}
          data-role="revoke"
          className="shrink-0 rounded bg-red-50 hover:bg-red-100 dark:bg-red-950 dark:hover:bg-red-900 px-2 py-0.5 text-xs font-medium text-red-700 dark:text-red-400 transition-colors touch-target-32"
          onClick={() => {
            // #6512: an app open in this tab keeps what its frame was given
            // until the frame goes, so the revoke closes it too. A question,
            // not a value: Settings asks it when the dialog opens and again
            // once the revoke is through, since the app can open or close
            // in between.
            const target = {
              slug: app.appSlug,
              name: app.appName,
              permission: item.label,
              isOpen: () => isLiveApp(app.appSlug),
              close: () => closeLiveApp(app.appSlug),
            };
            void controller()?._onPermissionRevoke?.(app.appId, item.capability, target);
          }}
        >
          {t('settings:appPermissions.revoke')}
        </button>
      )}</span>}
    />
  );
}

/**
 * #6512 item 4: the app's name, and Revoke all once it holds two or more
 * active permissions (with one, the row's own Revoke is the same act). It
 * hands Settings the active capabilities as they are drawn now and the same
 * live "is it open in this tab" question a single revoke does.
 */
function AppHead({ app }: { app: PermissionAppView }) {
  const t = useMessages('settings');
  const active = app.items.filter((item) => !item.revoked).map((item) => item.capability);
  return (
    <ListRow
      inset="text"
      title={app.appName}
      tooltip={app.appName}
      chevron={false}
      trailing={active.length >= 2 ? (
        <button
          type="button"
          aria-label={t('settings:appPermissions.revokeAllLabel', { app: app.appName })}
          data-role="revoke-all"
          className="shrink-0 rounded bg-red-50 hover:bg-red-100 dark:bg-red-950 dark:hover:bg-red-900 px-2 py-0.5 text-xs font-medium text-red-700 dark:text-red-400 transition-colors touch-target-32"
          onClick={() => {
            const target = {
              slug: app.appSlug,
              name: app.appName,
              isOpen: () => isLiveApp(app.appSlug),
              close: () => closeLiveApp(app.appSlug),
            };
            void controller()?._onPermissionRevokeAll?.(app.appId, active, target);
          }}
        >
          {t('settings:appPermissions.revokeAll')}
        </button>
      ) : undefined}
    />
  );
}

export function AppPermissionsListView(state: AppPermissionsState) {
  const t = useMessages('settings');
  if (state.phase === 'idle') return null;
  if (state.phase === 'loading') {
    return <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('core:common.loading')}</p>;
  }
  if (state.phase === 'error') {
    return <p className="text-xs text-red-700 dark:text-red-400">{t('settings:appPermissions.loadFailed')}</p>;
  }
  if (!state.apps.length) {
    return <PermissionsEmpty kind="device">{t('settings:appPermissions.empty')}</PermissionsEmpty>;
  }
  return (
    <>
      {state.apps.map((app) => (
        // One grouped list an app: its name, then a row a permission.
        <GroupedList key={app.appId} className="mx-0">
          <AppHead app={app} />
          {app.items.map((item) => (
            <CapabilityRow key={item.capability} app={app} item={item} />
          ))}
        </GroupedList>
      ))}
    </>
  );
}

export function AppPermissionsList() {
  return <AppPermissionsListView {...useStoreState<AppPermissionsState>(appPermissionsStore)} />;
}
