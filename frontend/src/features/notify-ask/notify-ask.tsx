import { Suspense, lazy, useEffect, useRef, useState } from 'react';

import { Button, buttonVariants } from '@/components/ui/button';
import { BellIcon, CheckIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import {
  askOs,
  askTelemetry,
  claimAsk,
  openNotificationSettings,
  planAsk,
  recordAsk,
  type StoreLink,
} from './ask-state';
import type { NotifyMoment } from './decide';

/*
 * The notification ask: a small card at a moment when somebody has just
 * started waiting on something, saying what they will hear about and asking
 * whether they want to (./decide.ts has the rules, ./ask-state.ts the reads).
 *
 *   In the Homeroom app it is "Notify me / Not now", and only Notify me shows
 *   the phone's own permission prompt (iOS shows it once, Android twice).
 *   Allowed, the card settles to "✓ We'll let you know"; refused, it says
 *   notifications are off, with the way to the phone's settings.
 *   In a browser Homeroom has no push, so it is "Get the app": the store on a
 *   phone, a code to scan on a computer (./get-app-sheet.tsx), with "Until
 *   then, we'll email you" where email stands in for that moment.
 *
 * Renders nothing until the answers are read, from an effect: nothing of it
 * is in the prerendered shell, and nothing asks while a page draws. One card
 * per moment (claimAsk). Each answer is the account's
 * (POST /api/me/notification-asks), so a Not now holds on every device.
 *
 * The made screen's ask in the app stays the modal it was
 * (NativeChrome.askForPing, ../dialogs/ping-ask.ts): `app_building` draws
 * this card only in a browser.
 */

type Phase = 'hidden' | 'app' | 'web' | 'asking' | 'on' | 'off';

// The computer's "Get the app" sheet, loaded on the tap that opens it: the
// sheet's back-button seam (lib/back-stack.ts) listens on the window as it
// loads, which nothing that only asks should pay for.
const GetAppSheet = lazy(() => import('./get-app-sheet').then((m) => ({ default: m.GetAppSheet })));

/** Message ids, literal so each one can be found: title and body per moment, in the app. */
const APP_COPY: Record<Exclude<NotifyMoment, 'app_building' | 'community'>, { title: string; body: string }> = {
  invite_sent: { title: 'notifications:ask.invite_sent.title', body: 'notifications:ask.invite_sent.body' },
  suggestion: { title: 'notifications:ask.suggestion.title', body: 'notifications:ask.suggestion.body' },
  reply: { title: 'notifications:ask.reply.title', body: 'notifications:ask.reply.body' },
  project_opens: { title: 'notifications:ask.project_opens.title', body: 'notifications:ask.project_opens.body' },
};

/** In a browser: the title per moment. */
const WEB_TITLE: Record<NotifyMoment, string> = {
  app_building: 'notifications:ask.web.title.app_building',
  invite_sent: 'notifications:ask.web.title.invite_sent',
  suggestion: 'notifications:ask.web.title.suggestion',
  reply: 'notifications:ask.web.title.reply',
  community: 'notifications:ask.web.title.community',
  project_opens: 'notifications:ask.web.title.project_opens',
};

/** The app's words for a moment: title and body message ids. */
export function appCopy(moment: NotifyMoment, small: boolean): { title: string; body: string } | null {
  if (moment === 'app_building') return null;
  if (moment === 'community') {
    return {
      title: 'notifications:ask.community.title',
      body: small ? 'notifications:ask.community.small.body' : 'notifications:ask.community.large.body',
    };
  }
  return APP_COPY[moment];
}

/**
 * The card's ground: the plane colour (a card on the page), or white where it
 * stands on a sheet that is itself the plane's grey (the invite sheet's
 * preview card is white the same way).
 */
const TONE = {
  plane: 'bg-[color:var(--dc-sheet-solid)]',
  white: 'bg-white dark:bg-zinc-800',
} as const;

export function NotifyAsk({ moment, project = '', small = false, tone = 'plane', className = '' }: {
  moment: NotifyMoment;
  /** The project's name, for the moments that name it. */
  project?: string;
  /**
   * `community` only: a small private group, where every message in its chat
   * notifies everyone (services/group-channel-notify.js), so the promise
   * includes them.
   */
  small?: boolean;
  tone?: keyof typeof TONE;
  /** Spacing from where it sits. */
  className?: string;
}) {
  const [phase, setPhase] = useState<Phase>('hidden');
  const [email, setEmail] = useState(false);
  const [settings, setSettings] = useState(false);
  const [links, setLinks] = useState<StoreLink[]>([]);
  const [phone, setPhone] = useState(false);
  const [sheet, setSheet] = useState(false);
  const release = useRef<(() => void) | null>(null);

  useEffect(() => {
    let live = true;
    const letGo = claimAsk(moment);
    if (!letGo) return undefined;
    release.current = letGo;
    void planAsk(moment).then((ctx) => {
      if (!live) return;
      const { plan } = ctx;
      // The made screen's modal asks this one in the app.
      if (plan.show === 'app' && moment !== 'app_building') {
        setPhase('app');
        return;
      }
      if (plan.show === 'web') {
        setEmail(plan.email);
        setLinks(ctx.links);
        setPhone(ctx.os !== null);
        setPhase('web');
        return;
      }
      letGo();
      release.current = null;
    });
    return () => {
      live = false;
      letGo();
      release.current = null;
    };
  }, [moment]);

  const t = useMessages('notifications');
  if (phase === 'hidden') return null;
  const surface = phase === 'web' ? 'web' : 'app';

  const notNow = () => {
    askTelemetry().done('cancelled');
    void recordAsk(surface, moment, 'not_now');
    setPhase('hidden');
    release.current?.();
    release.current = null;
  };

  const notifyMe = async () => {
    if (phase !== 'app') return;
    setPhase('asking');
    const telemetry = askTelemetry();
    void recordAsk('app', moment, 'yes');
    const answer = await askOs();
    telemetry.done(answer.granted ? 'success' : 'failure', answer.granted ? {} : { errorCode: 'access_denied' });
    setSettings(answer.settings);
    setPhase(answer.granted ? 'on' : 'off');
  };

  // The web's yes: they were given the app. The card goes once it has.
  const gotApp = () => {
    askTelemetry().done('success');
    void recordAsk('web', moment, 'yes');
  };

  const copy = appCopy(moment, small);
  const vars = { project };
  const title = surface === 'web' ? t(WEB_TITLE[moment], vars) : copy ? t(copy.title, vars) : '';
  const body = surface === 'web'
    ? (email ? t('notifications:ask.web.bodyEmail') : t('notifications:ask.web.body'))
    : copy ? t(copy.body, vars) : '';

  return (
    <section
      data-notify-ask={moment}
      data-notify-ask-surface={surface}
      aria-live="polite"
      className={`rounded-[20px] ${TONE[tone]} p-4 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] ${className}`}
    >
      {phase === 'on' ? (
        <p data-notify-ask-done="" className="flex items-center gap-2 text-[15px] font-[650] leading-5 text-zinc-900 dark:text-zinc-100">
          <CheckIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{t('notifications:ask.on')}</span>
        </p>
      ) : phase === 'off' ? (
        <div className="flex flex-wrap items-center gap-3">
          <p data-notify-ask-off="" className="min-w-0 flex-1 text-[15px] leading-5 text-zinc-900 dark:text-zinc-100">{t('notifications:ask.off')}</p>
          {settings ? (
            <Button variant="pillNeutral" ink="neutral" size="sm" onClick={openNotificationSettings}>{t('notifications:ask.turnOn')}</Button>
          ) : null}
        </div>
      ) : (
        <>
          <div className="flex items-start gap-3">
            <BellIcon className="mt-0.5 h-5 w-5 shrink-0 text-violet-600 dark:text-violet-400" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p data-notify-ask-title="" className="text-[15px] font-[650] leading-5 text-zinc-900 dark:text-zinc-100">{title}</p>
              <p className="mt-0.5 text-[13px] leading-[18px] text-zinc-500 dark:text-zinc-400">{body}</p>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2 pl-8">
            {surface === 'app' ? (
              <Button
                variant="pillAccent"
                size="sm"
                data-notify-ask-yes=""
                disabled={phase === 'asking'}
                onClick={() => { void notifyMe(); }}
              >
                {t('notifications:ask.notifyMe')}
              </Button>
            ) : phone && links[0] ? (
              <a
                href={links[0].url}
                target="_blank"
                rel="noopener noreferrer"
                data-notify-ask-yes=""
                onClick={() => { gotApp(); setPhase('hidden'); release.current?.(); release.current = null; }}
                className={buttonVariants({ variant: 'pillAccent', size: 'sm' })}
              >
                {t('notifications:ask.web.getApp')}
              </a>
            ) : (
              <Button variant="pillAccent" size="sm" data-notify-ask-yes="" onClick={() => { gotApp(); setSheet(true); }}>
                {t('notifications:ask.web.getApp')}
              </Button>
            )}
            <Button variant="pillNeutral" ink="neutral" size="sm" data-notify-ask-no="" disabled={phase === 'asking'} onClick={notNow}>
              {t('notifications:ask.notNow')}
            </Button>
          </div>
        </>
      )}
      {sheet ? (
        <Suspense fallback={null}>
          <GetAppSheet
            links={links}
            onClose={() => {
              setSheet(false);
              setPhase('hidden');
              release.current?.();
              release.current = null;
            }}
          />
        </Suspense>
      ) : null}
    </section>
  );
}
