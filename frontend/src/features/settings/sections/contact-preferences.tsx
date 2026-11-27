/**
 * Settings › Privacy › Email & texts (#6044): what Homeroom may send you.
 * Three switches, each saved on its own through GET/PUT
 * /api/me/contact-preferences (src/services/contact-preferences.js), which
 * records every change as proof of consent:
 *
 *   Homeroom news by email   marketing email, off until switched on. Needs a
 *                            confirmed address; without one the switch is off
 *                            and disabled, with a line saying why.
 *   Activity emails          the emails that stand in for a push
 *                            (users.activity_email), on by default as before.
 *                            The same choice as the unsubscribe link at the
 *                            foot of each of those emails.
 *   Homeroom news by text    marketing texts to the account's verified phone
 *                            number, off until switched on. Turning it off is
 *                            the same answer as replying STOP. Shown only when
 *                            the account has a verified number.
 *
 * Sign-in codes and security messages are not choices: they always arrive,
 * and the intro says so.
 *
 * Stateful like the rest of this page (./usage-analytics.tsx is the model):
 * the initial render is every switch off and disabled, the markup the
 * prerender ships, and the saved choices are read in an effect and again each
 * time the page opens.
 */

import { useCallback, useEffect, useState } from 'react';

import { SectionHeading } from '@/components/ui/field';
import { GroupedList } from '@/components/ui/grouped-list';

import { useMessages } from '../../../lib/i18n/react';
import { useWindowEvent } from '../../../lib/legacy-dom';

import { HELP, PrivacySwitch, SaveStatus, useSavedFlash } from './privacy-text';

type Choice = 'marketingEmail' | 'activityEmail' | 'marketingSms';

interface Prefs {
  marketingEmail: boolean;
  activityEmail: boolean;
  marketingSms: boolean;
  /** A confirmed address to send to. */
  email: boolean;
  /** The verified number, masked ("•••• 1234"), or null when there is none. */
  phone: string | null;
}

const NONE: Prefs = { marketingEmail: false, activityEmail: false, marketingSms: false, email: false, phone: null };

function fromBody(body: Record<string, unknown>): Prefs {
  return {
    marketingEmail: body.marketingEmail === true,
    activityEmail: body.activityEmail === true,
    marketingSms: body.marketingSms === true,
    email: body.email === true,
    phone: typeof body.phone === 'string' ? body.phone : null,
  };
}

export function ContactPreferencesSection() {
  const t = useMessages('settings');
  const [prefs, setPrefs] = useState<Prefs>(NONE);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState<Choice | null>(null);
  const [error, setError] = useState('');
  const { saved, flash, clear } = useSavedFlash();

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/me/contact-preferences', { credentials: 'same-origin' });
      if (!res.ok) return;
      setPrefs(fromBody((await res.json()) as Record<string, unknown>));
      setLoaded(true);
    } catch { /* stays as it was; the next visit reads it again */ }
  }, []);

  useEffect(() => { void load(); }, [load]);
  // Read again each time the page is opened: another device, or an
  // unsubscribe link or a STOP reply, may have changed it.
  useWindowEvent('usernode:settings-section', (event) => {
    if ((event as CustomEvent<{ section?: string }>).detail?.section === 'contact-privacy') void load();
  });

  async function change(choice: Choice, next: boolean) {
    const previous = prefs;
    setPrefs({ ...prefs, [choice]: next });
    setSaving(choice);
    setError('');
    clear();
    try {
      const res = await fetch('/api/me/contact-preferences', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [choice]: next }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setPrefs(fromBody((await res.json()) as Record<string, unknown>));
      flash();
    } catch {
      setPrefs(previous);
      setError(t('settings:privacy.contact.saveFailed'));
    } finally {
      setSaving(null);
    }
  }

  return (
    <div id="settings-contact-preferences-section" className="mt-6 pt-6 border-t border-zinc-200 dark:border-zinc-800">
      <SectionHeading title={t('settings:privacy.contact.title')} blurbClassName="dark:text-zinc-400">
        {t('settings:privacy.contact.intro')}
      </SectionHeading>
      {/* The shared rows, one a switch (./privacy-text.tsx's PrivacySwitch). */}
      <GroupedList className="mx-0">
        <PrivacySwitch
          id="settings-contact-marketing-email"
          label={t('settings:privacy.contact.marketingEmail.label')}
          checked={prefs.marketingEmail}
          disabled={!loaded || saving !== null || (!prefs.email && !prefs.marketingEmail)}
          describedBy="settings-contact-marketing-email-help"
          description={loaded && !prefs.email
            ? t('settings:privacy.contact.marketingEmail.noEmail')
            : t('settings:privacy.contact.marketingEmail.help')}
          onChange={(e) => void change('marketingEmail', e.currentTarget.checked)}
        />
        <PrivacySwitch
          id="settings-contact-activity-email"
          label={t('settings:privacy.contact.activityEmail.label')}
          checked={prefs.activityEmail}
          disabled={!loaded || saving !== null}
          describedBy="settings-contact-activity-email-help"
          description={t('settings:privacy.contact.activityEmail.help')}
          onChange={(e) => void change('activityEmail', e.currentTarget.checked)}
        />
        {prefs.phone ? (
          <PrivacySwitch
            id="settings-contact-marketing-sms"
            label={t('settings:privacy.contact.marketingSms.label')}
            checked={prefs.marketingSms}
            disabled={!loaded || saving !== null}
            describedBy="settings-contact-marketing-sms-help"
            description={t('settings:privacy.contact.marketingSms.help', { phone: prefs.phone })}
            onChange={(e) => void change('marketingSms', e.currentTarget.checked)}
          />
        ) : null}
      </GroupedList>
      {/* Under the switches, not among them: the same 16px in the standard
          look, and a note under the card under one of the frame's looks. */}
      {!prefs.phone && loaded ? (
        <p data-settings-contact-no-phone="" className={`ui-note mt-4 ${HELP}`}>{t('settings:privacy.contact.marketingSms.noPhone')}</p>
      ) : null}
      {error ? <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-400">{error}</p> : null}
      <SaveStatus saved={saved} />
    </div>
  );
}
