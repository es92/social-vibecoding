import { SectionHeading, StatusLine } from '@/components/ui/field';
import { GroupedList, ListRow } from '@/components/ui/grouped-list';
import { Switch } from '@/components/ui/switch';

import { NotificationPrefsList } from '../notification-prefs-list';
import { useMessages } from '../../../lib/i18n/react';

/**
 * The Notifications page. First the phone push test: the button queues a
 * test push on the server, which sends it ten seconds later so the person
 * can switch away (wired in settings.js, POST /api/me/test-alert).
 *
 * Below it, the mobile push categories: the shared row (ListRow) as the
 * label of its switch, the category's name over its sentence, the switch at
 * the row's end. settings.js finds each switch as
 * `[data-mobile-push-category] input` and sets `.checked` and `.disabled`.
 *
 * They are seven WRITTEN-OUT rows rather than a map over a table, which
 * looks like the obvious deduplication and is not one:
 * tests/settings-mobile-push.test.js reads the label and blurb of every
 * category out of this file's SOURCE, and asserts that every row's title and
 * subtitle are catalog messages, so no internal notification identifier
 * (`mention`, `stale_pr`, `pr_proposed`, …) is ever a visible label. Hoisting
 * the copy into a table would leave that check matching nothing at all —
 * green, and no longer testing anything.
 */
export function AlertsSection() {
  const t = useMessages('settings');
  return (
    <div data-settings-section="alerts" className="hidden">
      <div id="settings-alerts-section">
        <SectionHeading title={t('settings:alerts.title')}>
          {t('settings:alerts.intro')}
        </SectionHeading>
        <button
          id="devchat-alerts-test"
          type="button"
          className="mt-3 rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
        >
          {t('settings:alerts.test')}
        </button>
        <StatusLine
          as="p"
          id="devchat-alerts-test-status"
          size="xs"
          className="text-zinc-500 dark:text-zinc-400"
        />

        <div
          id="settings-mobile-push-preferences"
          className="mt-6 pt-6 border-t border-zinc-200 dark:border-zinc-800"
        >
          <SectionHeading title={t('settings:alerts.push.title')} blurbClassName="leading-relaxed">
            {t('settings:alerts.push.intro')}
          </SectionHeading>
          {/* The shared rows, each the label of its switch: pressing the name
              or the sentence under it toggles it. */}
          <GroupedList className="mx-0">
            <ListRow
              as="label"
              data-mobile-push-category="messages"
              title={t('settings:alerts.push.messages.label')}
              subtitle={t('settings:alerts.push.messages.description')}
              subtitleClassName="whitespace-normal"
              trailing={<Switch disabled />}
              chevron={false}
            />
            <ListRow
              as="label"
              data-mobile-push-category="builds"
              title={t('settings:alerts.push.builds.label')}
              subtitle={t('settings:alerts.push.builds.description')}
              subtitleClassName="whitespace-normal"
              trailing={<Switch disabled />}
              chevron={false}
            />
            <ListRow
              as="label"
              data-mobile-push-category="invite_activity"
              title={t('settings:alerts.push.inviteActivity.label')}
              subtitle={t('settings:alerts.push.inviteActivity.description')}
              subtitleClassName="whitespace-normal"
              trailing={<Switch disabled />}
              chevron={false}
            />
            <ListRow
              as="label"
              data-mobile-push-category="direct_interactions"
              title={t('settings:alerts.push.directInteractions.label')}
              subtitle={t('settings:alerts.push.directInteractions.description')}
              subtitleClassName="whitespace-normal"
              trailing={<Switch disabled />}
              chevron={false}
            />
            <ListRow
              as="label"
              data-mobile-push-category="invitations"
              title={t('settings:alerts.push.invitations.label')}
              subtitle={t('settings:alerts.push.invitations.description')}
              subtitleClassName="whitespace-normal"
              trailing={<Switch disabled />}
              chevron={false}
            />
            <ListRow
              as="label"
              data-mobile-push-category="developer_sessions"
              title={t('settings:alerts.push.developerSessions.label')}
              subtitle={t('settings:alerts.push.developerSessions.description')}
              subtitleClassName="whitespace-normal"
              trailing={<Switch disabled />}
              chevron={false}
            />
            <ListRow
              as="label"
              data-mobile-push-category="proposal_alerts"
              title={t('settings:alerts.push.proposalAlerts.label')}
              subtitle={t('settings:alerts.push.proposalAlerts.description')}
              subtitleClassName="whitespace-normal"
              trailing={<Switch disabled />}
              chevron={false}
            />
            <ListRow
              as="label"
              data-mobile-push-category="app_alerts"
              title={t('settings:alerts.push.appAlerts.label')}
              subtitle={t('settings:alerts.push.appAlerts.description')}
              subtitleClassName="whitespace-normal"
              trailing={<Switch disabled />}
              chevron={false}
            />
            <ListRow
              as="label"
              data-mobile-push-category="lightweight_activity"
              title={t('settings:alerts.push.lightweightActivity.label')}
              subtitle={t('settings:alerts.push.lightweightActivity.description')}
              subtitleClassName="whitespace-normal"
              trailing={<Switch disabled />}
              chevron={false}
            />
          </GroupedList>
          <p data-mobile-push-status aria-live="polite" className="ui-note text-xs mt-3 text-zinc-500 dark:text-zinc-400">
            {t('settings:alerts.push.loading')}
          </p>
        </div>
        <div
          id="settings-notification-prefs"
          className="mt-6 pt-6 border-t border-zinc-200 dark:border-zinc-800"
        >
          <SectionHeading title={t('settings:alerts.apps.title')} blurbClassName="leading-relaxed">
            {t('settings:alerts.apps.intro')}
          </SectionHeading>
          <div id="notification-prefs-list">
            <NotificationPrefsList />
          </div>
          <StatusLine id="notification-prefs-status" />
        </div>
      </div>
    </div>
  );
}