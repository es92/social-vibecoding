import { useCallback, useState } from 'react';

import { SectionHeading } from '@/components/ui/field';
import { ListRow } from '@/components/ui/grouped-list';
import { CameraIcon } from '@/components/ui/icons';

import { ProfileDetailsCard } from '../../profile/profile-details-card';
import { useMessages } from '../../../lib/i18n/react';
import { useIsomorphicLayoutEffect, useWindowEvent } from '../../../lib/legacy-dom';
import { displayNameOf, initialOf } from '../../profile/profile-store.js';

/**
 * The Profile part — the head of the Account page.
 *
 * Name, photo, bio and the public page are edited in Me's Edit profile
 * sheet, which Settings had no way to reach: someone who came to Settings to
 * change their name found a username form and nothing else. This part is
 * that way in. It shows who is signed in and links to `#profile?edit`, which
 * opens Me with the sheet already up (features/profile/profile.js,
 * `_takeSheetAsk('edit')`), the same address shape as `#profile?friends`.
 *
 * STATEFUL, like ./theme.tsx and for the same reason: settings.js binds
 * nothing inside it, so React is the only writer here. It reads App.user on
 * mount and again whenever a page is shown (`usernode:settings-section`), so
 * a name changed in the sheet is current when the viewer comes back. It
 * renders the empty card until then; the panes mount on reveal, never in the
 * prerender, so there is no server markup to match.
 */

interface ProfileUser {
  username?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
  bio?: string | null;
}

function readUser(): ProfileUser | null {
  const user = (window as { App?: { user?: ProfileUser | null } }).App?.user;
  return user && typeof user === 'object' ? user : null;
}

function Avatar({ user }: { user: ProfileUser | null }) {
  if (user?.avatarUrl) {
    return (
      <img
        className="w-11 h-11 rounded-full object-cover bg-zinc-100 dark:bg-zinc-800 shrink-0"
        src={user.avatarUrl}
        alt=""
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="w-11 h-11 text-lg rounded-full shrink-0 flex items-center justify-center font-bold bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300"
    >
      {initialOf(user)}
    </span>
  );
}

export function ProfileSection() {
  const t = useMessages('settings');
  const [user, setUser] = useState<ProfileUser | null>(null);
  const sync = useCallback(() => setUser(readUser()), []);
  useIsomorphicLayoutEffect(() => { sync(); }, [sync]);
  useWindowEvent('usernode:settings-section', sync);

  // The handle line only when a display name is the headline; otherwise the
  // name already IS the handle (displayNameOf falls back to "@username").
  const named = !!(user?.displayName && String(user.displayName).trim());
  const handle = named && user?.username ? `@${user.username}` : null;

  return (
    <div data-settings-section="profile" className="hidden">
      <div id="settings-profile-section">
        <SectionHeading title={t('settings:profile.title')}>
          {t('settings:profile.intro')}
        </SectionHeading>
        <div className="settings-profile-layout">
        {/* The shared row, as the link it is: your picture (with the camera
            that says it can change), your name over your handle, and Edit.
            One row and no list round it: under the editorial pages it is a
            large picture over the Edit link (app.css, PROFILE). */}
        <ListRow
          as="a"
          id="settings-profile-card"
          href="#profile?edit"
          inset="none"
          className="ui-card rounded-2xl bg-white dark:bg-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-800/60 transition-colors"
          leading={(
            <>
              <Avatar user={user} />
              <span className="settings-profile-camera" aria-hidden="true"><CameraIcon /></span>
            </>
          )}
          title={displayNameOf(user)}
          subtitle={handle || undefined}
          trailing={<span className="ui-link text-[15px] font-medium text-violet-700 dark:text-violet-400 shrink-0">{t('settings:profile.edit')}</span>}
        />
        {user ? <ProfileDetailsCard
          key={`${user.username}:${user.displayName || ''}:${user.bio || ''}`}
          id="settings-profile-details" embedded user={user} onSaved={sync}
        /> : null}
        </div>
      </div>
    </div>
  );
}
