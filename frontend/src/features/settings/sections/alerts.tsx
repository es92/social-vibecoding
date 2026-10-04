import { SectionHeading, StatusLine } from '@/components/ui/field';

import { NotificationPrefsList } from '../notification-prefs-list';
import { SwitchRow } from '@/components/ui/switch';

/**
 * #138: Dev-chat sound & alerts (default ON). Client-only preference
 * (localStorage key devchat_alerts_enabled); wired in settings.js. Plays a
 * chime when an AI dev-chat turn finishes while you're in the app, or a system
 * notification when it's in the background.
 *
 * Below it, the mobile push categories. Those rows are NOT SwitchRows: their
 * shape is the other way round (caption block first, switch right-aligned and
 * top-aligned) and their checkbox writes `type`/`class`/`disabled` in that
 * order, which the primitive's prop order does not produce. They stay literal
 * — the same call alert.tsx makes for the banner with a display conflict.
 *
 * They are also seven WRITTEN-OUT rows rather than a map over a table, which
 * looks like the obvious deduplication and is not one:
 * tests/settings-mobile-push.test.js reads the label and blurb of every
 * category out of this file's SOURCE, and asserts that no internal
 * notification identifier (`mention`, `stale_pr`, `pr_proposed`, …) ever
 * appears between a `>` and a `<`. Hoisting the copy into a table would leave
 * that last check matching nothing at all — green, and no longer testing
 * anything.
 */
export function AlertsSection() {
  return (
    <div data-settings-section="alerts" className="hidden">
      <div id="settings-alerts-section">
        <SectionHeading title={<>Dev-chat sound &amp; alerts</>}>
          Get a heads-up when a dev-chat AI agent finishes and is waiting for your reply.
        </SectionHeading>
        <SwitchRow id="devchat-alerts-toggle">
          Play a sound, and notify me when the app is in the background
        </SwitchRow>
        <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-2 leading-relaxed">
          When you're in the app a soft chime plays. A browser can show notifications while its tab stays open. To receive push notifications with the mobile app backgrounded or closed, enable Activity notifications on your phone and Developer sessions below. The test queues a phone push with a 10-second delay so you can switch away.
        </p>
        <button
          id="devchat-alerts-test"
          type="button"
          className="mt-3 rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
        >
          Send a test alert
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
          <SectionHeading title="Mobile push categories" blurbClassName="leading-relaxed">
            Choose which Social activity can send a phone notification. Your phone&apos;s Activity notifications switch remains the master control for that device.
          </SectionHeading>
          <div className="space-y-3">
            <label className="flex items-start justify-between gap-4 cursor-pointer select-none" data-mobile-push-category="messages">
              <span>
                <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">Messages</span>
                <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">Conversation invitations, messages, mentions, replies, and reactions.</span>
              </span>
              <input type="checkbox" className="un-switch mt-0.5 shrink-0" disabled />
            </label>
            <label className="flex items-start justify-between gap-4 cursor-pointer select-none" data-mobile-push-category="direct_interactions">
              <span>
                <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">Direct interactions</span>
                <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">Mentions and replies to your messages.</span>
              </span>
              <input type="checkbox" className="un-switch mt-0.5 shrink-0" disabled />
            </label>
            <label className="flex items-start justify-between gap-4 cursor-pointer select-none" data-mobile-push-category="invitations">
              <span>
                <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">Invitations</span>
                <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">Collaboration and approver invitations, including when yours are accepted.</span>
              </span>
              <input type="checkbox" className="un-switch mt-0.5 shrink-0" disabled />
            </label>
            <label className="flex items-start justify-between gap-4 cursor-pointer select-none" data-mobile-push-category="shared_work">
              <span>
                <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">Shared work</span>
                <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">Specs that someone privately shares with you.</span>
              </span>
              <input type="checkbox" className="un-switch mt-0.5 shrink-0" disabled />
            </label>
            <label className="flex items-start justify-between gap-4 cursor-pointer select-none" data-mobile-push-category="developer_sessions">
              <span>
                <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">Developer sessions</span>
                <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">Interactive and unattended coding sessions that finish while you are away.</span>
              </span>
              <input type="checkbox" className="un-switch mt-0.5 shrink-0" disabled />
            </label>
            <label className="flex items-start justify-between gap-4 cursor-pointer select-none" data-mobile-push-category="proposal_alerts">
              <span>
                <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">Change alerts</span>
                <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">Changes needing attention, failed previews, new changes waiting for approval, and votes on yours or yours going live.</span>
              </span>
              <input type="checkbox" className="un-switch mt-0.5 shrink-0" disabled />
            </label>
            <label className="flex items-start justify-between gap-4 cursor-pointer select-none" data-mobile-push-category="app_alerts">
              <span>
                <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">App alerts</span>
                <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">New issues filed on your apps, and apps that stop working.</span>
              </span>
              <input type="checkbox" className="un-switch mt-0.5 shrink-0" disabled />
            </label>
            <label className="flex items-start justify-between gap-4 cursor-pointer select-none" data-mobile-push-category="lightweight_activity">
              <span>
                <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">Lightweight activity</span>
                <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">Reactions and kudos on your work.</span>
              </span>
              <input type="checkbox" className="un-switch mt-0.5 shrink-0" disabled />
            </label>
          </div>
          <p data-mobile-push-status aria-live="polite" className="text-xs mt-3 text-zinc-500 dark:text-zinc-400">
            Loading mobile push preferences…
          </p>
        </div>
        <div
          id="settings-notification-prefs"
          className="mt-6 pt-6 border-t border-zinc-200 dark:border-zinc-800"
        >
          <SectionHeading title="What apps tell you about" blurbClassName="leading-relaxed">
            Your default for every app, and the apps you have set differently. Each of these covers the bell here and a notification on your phone, together. Change one app from its Notifications entry in the app menu.
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