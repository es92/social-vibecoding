/**
 * `#notification-prefs-list` — your account-wide notification defaults and
 * every app you have set differently (#1374).
 *
 * Two lists because there are two layers. The top one is what every app does
 * unless told otherwise; the bottom one is the exceptions, and it is the
 * reason this roll-up exists at all — without it there is no way to find an
 * app you muted months ago short of opening its tile menu and looking.
 *
 * settings.js keeps every fetch and every PATCH; this file keeps the markup,
 * and calls the handlers BY NAME on `window.Settings` for the same reason
 * ./grants-list.tsx does.
 */

import { Button } from '@/components/ui/button';
import { GroupedList, ListRow } from '@/components/ui/grouped-list';
import { Switch } from '@/components/ui/switch';

import { useMessages } from '../../lib/i18n/react';
import { useStoreState } from '../../lib/use-store-state';
import { notificationPrefsStore } from './notification-prefs-store.js';

type AccountCategory = {
  key: string;
  label: string;
  description: string;
  enabled: boolean;
  source: 'account' | 'default';
  appScoped: boolean;
};
type AppOverride = {
  appId: number;
  appSlug: string;
  appName: string;
  categories: { key: string; label: string; enabled: boolean }[];
};
type State = {
  phase: 'idle' | 'loading' | 'error' | 'ready';
  categories: AccountCategory[];
  apps: AppOverride[];
};

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).Settings : null) || null;
}

export function NotificationPrefsList() {
  const t = useMessages('settings');
  const state = useStoreState<State>(notificationPrefsStore);
  if (state.phase === 'idle') return null;
  if (state.phase === 'loading') {
    return <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('core:common.loading')}</p>;
  }
  if (state.phase === 'error') {
    return <p className="text-xs text-red-700 dark:text-red-400">{t('settings:alerts.apps.loadFailed')}</p>;
  }
  return (
    <>
      {/* The shared rows, each the label of its switch (one row language
          with the push categories above, ./sections/alerts.tsx). */}
      <GroupedList className="mx-0">
        {state.categories.map((category) => (
          <ListRow
            key={category.key}
            as="label"
            data-notification-default={category.key}
            title={category.label}
            titleClassName="whitespace-normal"
            subtitle={category.description}
            subtitleClassName="whitespace-normal"
            trailing={(
              <Switch
                checked={category.enabled}
                onChange={(event) => {
                  void controller()?._onNotificationDefaultChange?.(
                    category.key, event.currentTarget.checked
                  );
                }}
              />
            )}
            chevron={false}
          />
        ))}
      </GroupedList>

      <div className="mt-5 pt-5 border-t border-zinc-200 dark:border-zinc-800">
        <p className="ui-cap text-sm font-medium text-zinc-800 mb-2 dark:text-zinc-200">{t('settings:alerts.apps.overridesHeading')}</p>
        {state.apps.length ? (
          <GroupedList className="mx-0">
            {state.apps.map((app) => (
              // An app set differently: its name, what it does differently
              // (one line a category, under the name), and the way back.
              <ListRow
                key={app.appId}
                title={app.appName}
                subtitle={(
                  <ul>
                    {app.categories.map((category) => (
                      <li key={category.key}>
                        {category.enabled
                          ? t('settings:alerts.apps.categoryOn', { category: category.label })
                          : t('settings:alerts.apps.categoryOff', { category: category.label })}
                      </li>
                    ))}
                  </ul>
                )}
                subtitleClassName="whitespace-normal"
                trailing={(
                  <span className="shrink-0 text-xs">
                  <Button
                    type="button"
                    data-role="reset-app-notifications"
                    layout="shrink"
                    variant="compact"
                    size="xs"
                    onClick={() => {
                      void controller()?._onNotificationAppReset?.(app.appId, app.appSlug);
                    }}
                  >
                    {t('settings:alerts.apps.useDefaults')}
                  </Button>
                  </span>
                )}
                chevron={false}
              />
            ))}
          </GroupedList>
        ) : (
          <p className="ui-note text-xs text-zinc-500 dark:text-zinc-400">
            {t('settings:alerts.apps.noOverrides')}
          </p>
        )}
      </div>
    </>
  );
}
