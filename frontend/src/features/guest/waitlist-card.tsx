/**
 * The card over Discover for an account that is signed in but not let in
 * yet (features/auth/landing.tsx `waitingGuest`): where it stands, and the
 * way back to the waiting room, which keeps the two questions, the invite
 * box and the check that lets it in (features/auth/waiting.tsx). Every
 * public project under it opens for this account, signed in; voting and
 * joining wait until it is let in.
 */

import { ChevronRightIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';

export function WaitlistCard({ email }: { email: string | null }) {
  const t = useMessages('auth');
  return (
    <section
      data-guest-waitlist=""
      className="mx-4 mt-4 flex flex-col gap-1.5 rounded-[20px] bg-white px-4 pt-4 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900"
    >
      <h1 className="text-[20px] font-extrabold leading-6 text-zinc-950 dark:text-white">{t('auth:waiting.title')}</h1>
      <p className="text-[14px] leading-5 text-zinc-500 dark:text-zinc-400">
        {email ? t('auth:guest.waitlist.leadEmail', { email }) : t('auth:guest.waitlist.lead')}
      </p>
      <a
        href="#waiting"
        data-guest-waitlist-room=""
        className="-mx-4 mt-1.5 flex min-h-[48px] items-center justify-between gap-3 px-4 text-[15px] font-semibold text-zinc-900 shadow-[inset_0_1px_0_var(--app-sheet-line)] dark:text-zinc-100"
      >
        {t('auth:landing.backToWaiting')}
        <ChevronRightIcon className="h-[18px] w-[18px] shrink-0 text-zinc-400 dark:text-zinc-500" aria-hidden="true" />
      </a>
    </section>
  );
}
