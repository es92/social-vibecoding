/**
 * Settings › Privacy: who can reach you, and who can find you (#5104).
 *
 * Two account settings, both safe by default for everyone:
 *
 *  - Who can message or invite me: "People in projects I'm in" (the
 *    default) or "Anyone". It decides who may start a new direct message,
 *    invite you to a group chat, a project or its approvers, or send a
 *    friend request. A conversation that already exists keeps working.
 *  - Who can find me › Let people find my profile (off by default):
 *    whether people outside your projects find your username in a search.
 *    It has its own heading (#5926): it is not about messaging.
 *    The line under each control says what is true now (#5926): the
 *    switch's explanation follows its state.
 *
 * The rules live on the server (src/services/contact-privacy.js and the
 * user_contactable_by / user_discoverable_by functions in schema.sql); this
 * pane reads and writes GET/POST /api/me/contact-privacy and owns nothing
 * else.
 *
 * It is a STATEFUL pane, like ./accessibility.tsx: nothing in
 * ../settings.js binds inside it. The initial render carries no selection
 * (the prerender cannot know the account), and the read happens in an
 * effect: on mount and every time a settings page is shown, so a change
 * made in another tab is what you see when you come back.
 *
 * Its part key is `contact-privacy` and its ids start `settings-who-can-`
 * and `settings-profile-`, so they stay apart from any other privacy
 * control a later change adds to this page.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { SectionHeading } from '@/components/ui/field';
import { GroupedList } from '@/components/ui/grouped-list';

import { useMessages } from '../../../lib/i18n/react';
import { useWindowEvent } from '../../../lib/legacy-dom';

import { ContactPreferencesSection } from './contact-preferences';
import { HELP, PrivacySwitch, SaveStatus, useSavedFlash } from './privacy-text';
import { UsageAnalyticsSection } from './usage-analytics';

type WhoCanContact = 'shared' | 'anyone';

interface ContactPrivacy {
  whoCanContact: WhoCanContact;
  discoverable: boolean;
}

const ENDPOINT = '/api/me/contact-privacy';

const OPTIONS: { value: WhoCanContact; label: string; description: string }[] = [
  {
    value: 'shared',
    label: 'settings:privacy.whoCanMessage.shared',
    description: 'settings:privacy.whoCanMessage.sharedDescription',
  },
  {
    value: 'anyone',
    label: 'settings:privacy.whoCanMessage.anyone',
    description: 'settings:privacy.whoCanMessage.anyoneDescription',
  },
];

const ROW_FIRST = 'ui-row flex items-start gap-3 cursor-pointer select-none py-2.5';
const ROW_NEXT = `${ROW_FIRST} border-t border-zinc-200 dark:border-zinc-800`;

function parse(value: unknown): ContactPrivacy | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (row.whoCanContact !== 'shared' && row.whoCanContact !== 'anyone') return null;
  return { whoCanContact: row.whoCanContact, discoverable: row.discoverable === true };
}

/** The input is the `peer` just before it, and sr-only: this is what focus shows on. */
const RADIO_FOCUS = 'peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[color:var(--accent)]';

function Radio({ on }: { on: boolean }) {
  return on ? (
    <span aria-hidden="true" className={`ui-chk ui-chk-on mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[color:var(--accent)] ${RADIO_FOCUS}`}>
      <span className="h-2 w-2 rounded-full bg-[color:var(--accent-ink)]" />
    </span>
  ) : (
    <span aria-hidden="true" className={`ui-chk mt-0.5 h-5 w-5 shrink-0 rounded-full ring-[1.5px] ring-inset ring-zinc-300 dark:ring-zinc-600 ${RADIO_FOCUS}`} />
  );
}

export function PrivacySection() {
  const t = useMessages('settings');
  const [settings, setSettings] = useState<ContactPrivacy | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const { saved, flash, clear } = useSavedFlash();
  // A read that started before a save must not paint over the save.
  const generation = useRef(0);

  const load = useCallback(async () => {
    const seq = ++generation.current;
    try {
      const res = await fetch(ENDPOINT, { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const next = parse(await res.json());
      if (seq !== generation.current) return;
      if (next) { setSettings(next); setError(''); }
    } catch {
      if (seq === generation.current) setError(t('settings:privacy.loadFailed'));
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);
  // Read again when this page is opened, never when another one is (#6591:
  // every page of Settings re-read it, hidden, on each switch).
  useWindowEvent('usernode:settings-section', (event) => {
    if ((event as CustomEvent<{ section?: string }>).detail?.section === 'contact-privacy') void load();
  });

  const save = async (change: Partial<ContactPrivacy>) => {
    if (!settings || saving) return;
    const previous = settings;
    const seq = ++generation.current;
    setSettings({ ...settings, ...change });
    setSaving(true);
    setError('');
    clear();
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(change),
      });
      if (!res.ok) throw new Error(String(res.status));
      const next = parse(await res.json());
      if (seq === generation.current && next) setSettings(next);
      flash();
    } catch {
      if (seq === generation.current) {
        setSettings(previous);
        setError(t('settings:privacy.saveFailed'));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div data-settings-section="contact-privacy" className="hidden">
      <div id="settings-contact-privacy-section">
        <SectionHeading title={t('settings:privacy.whoCanMessage.title')} blurbClassName="dark:text-zinc-400">
          {t('settings:privacy.whoCanMessage.intro')}
        </SectionHeading>
        <div
          id="settings-who-can-message"
          role="radiogroup"
          aria-label={t('settings:privacy.whoCanMessage.title')}
          className="ui-card flex flex-col"
        >
          {OPTIONS.map((option, index) => {
            const on = settings?.whoCanContact === option.value;
            return (
              <label key={option.value} className={index === 0 ? ROW_FIRST : ROW_NEXT} data-who-can-message={option.value}>
                <input
                  type="radio"
                  className="peer sr-only"
                  name="settings-who-can-message"
                  value={option.value}
                  checked={on}
                  disabled={!settings || saving}
                  onChange={() => { void save({ whoCanContact: option.value }); }}
                />
                <Radio on={on} />
                <span className="ui-row-tx min-w-0">
                  <span className={`ui-row-t block text-sm text-zinc-800 dark:text-zinc-200 ${on ? 'font-semibold' : 'font-normal'}`}>
                    {t(option.label)}
                  </span>
                  <span className={`ui-row-s block ${HELP} mt-0.5`}>
                    {t(option.description)}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
        {/* #5926: who can find you is not who can message you, so it is a
            section of its own, with its own heading. */}
        <div className="mt-6 pt-6 border-t border-zinc-200 dark:border-zinc-800">
          <SectionHeading title={t('settings:privacy.discoverable.title')} blurbClassName="dark:text-zinc-400">
            {t('settings:privacy.discoverable.intro')}
          </SectionHeading>
          <GroupedList className="mx-0">
          <PrivacySwitch
            id="settings-profile-discoverable"
            label={t('settings:privacy.discoverable.label')}
            checked={!!settings?.discoverable}
            disabled={!settings || saving}
            describedBy="settings-profile-discoverable-description"
            description={t(settings?.discoverable
              ? 'settings:privacy.discoverable.descriptionOn'
              : 'settings:privacy.discoverable.descriptionOff')}
            onChange={(e) => { void save({ discoverable: e.currentTarget.checked }); }}
          />
          </GroupedList>
        </div>
        <SaveStatus id="settings-contact-privacy-status" saved={saved} error={error} />
      </div>
      {/* #6044: Email & texts, what Homeroom may send you; its own state and
          its own endpoint (./contact-preferences.tsx). */}
      <ContactPreferencesSection />
      {/* Usage data, the page's last block: what Homeroom keeps, and where to
          ask to be left out (./usage-analytics.tsx). */}
      <UsageAnalyticsSection />
    </div>
  );
}
