/**
 * The "More" list on the Me screen — the prototype's three rows, plus Your
 * feedback (#3186), each with a line that says what is behind it.
 *
 * ── How the rows got here ──────────────────────────────────────────────
 *
 * #1431 put Settings and Admin & moderation on Profile, because the drawer it
 * retired was their only entrance and Profile was the nearest screen that is
 * about the VIEWER rather than about an app. #1443 moved them into the app
 * chip's menu, on the rule that the menu lists every destination with its own
 * page. #2718 took that rule apart — the tab bar carries the platform's
 * places now — and put Challenges, Settings and the Admin console back here as
 * rows, with the native node, wallet and staking readouts and Log out under
 * them.
 *
 * The navigation prototype's Me settles it the other way round, and this is
 * that: three rows under "More" — Challenges & standings, Kudos, Settings —
 * and everything ELSE the account group held inside Settings, which is what
 * the spec's retired-chip table says ("Me, with Admin and Validator inside
 * Settings"). Admin & moderation, the node, the wallet, staking and Log out
 * render in Settings' own account block now
 * (features/settings/account-rows.tsx); Settings already had Log out.
 *
 * The row ids are the ones #2718 gave them, because dapp.json's checks and the
 * home tour select on them: #profile-row-challenges still leads to
 * #leaderboard/challenges, #profile-row-settings to #settings.
 * #profile-row-kudos is new; #profile-row-admin left with its row.
 *
 * Real anchors, not buttons: cmd/ctrl-click, middle-click, "open in new tab",
 * the context menu and drag-to-bookmark are the browser's to give, and only an
 * anchor with an href gets them. Every one is a plain hash route the shell's
 * router already resolves, so there is no click handler to write.
 *
 * #profile-row-feedback (#3186) is the one row with a handler. What it opens
 * is a card over this screen, "Your feedback" (./feedback-sheet.tsx), not a
 * screen of its own, so a plain click opens it in place rather than
 * re-entering the route and re-reading the whole profile. It is still an
 * anchor, to the card's own address (`#profile?feedback`, which
 * Profile.open() honours), so every modified click keeps the browser's
 * behaviour.
 *
 * Nothing here is in the prerendered shell: ProfileRoot returns null until its
 * store has data, so the admin flag read below cannot disagree with a first
 * render.
 */

import { type ReactNode } from 'react';

import { GroupedList, ListRow, SectionHeader } from '@/components/ui/grouped-list';
import { IconTile } from '@/components/ui/icon-tile';
import { ChatIcon, CogIcon, ThumbsUpIcon, TrophyIcon } from '@/components/ui/icons';
import { useStoreState } from '../../lib/use-store-state';
import { useVisibility } from '../../lib/visibility-store';
import { walletSheetStore } from '../header/wallet-sheet-store';
import { Profile } from './profile.js';

/** The rows' two lines are the primitive's, a size down, as the prototype sets them. */
const TITLE = 'text-base font-semibold';
const SUBTITLE = 'text-[0.8125rem]';

export function MorePanel({ rows }: {
  rows: { challenges: string | null; kudos: string | null; feedback?: string | null };
}): ReactNode {
  // A CAPABILITY, published rather than fetched: App.renderAdminButton in
  // public/js/app.js writes it after the session resolves. The Admin console
  // is a Settings row now; the flag only decides whether the Settings row's
  // own line mentions it.
  const isAdmin = useVisibility('switcher-row-admin', false);
  // The wallet is a Settings row only in the native app (its store reveals
  // it with the bridge's capability), so the line names it only there.
  const wallet = (useStoreState(walletSheetStore) as { visible: boolean }).visible;
  const settingsLine = ['Account', 'alerts', 'keys']
    .concat(wallet ? ['wallet'] : [], isAdmin ? ['admin'] : [])
    .join(', ');
  return (
    <section id="profile-more" className="mt-2">
      {/* SectionHeader's own `px-4`, on the rows' content edge (#2832) — see
          Contributions in ./profile-view.tsx. */}
      <SectionHeader>More</SectionHeader>
      <GroupedList className="mx-0" tone="plane">
        <ListRow
          as="a"
          id="profile-row-challenges"
          href="#leaderboard/challenges"
          leading={<IconTile size="sm"><TrophyIcon /></IconTile>}
          title="Challenges & standings"
          titleClassName={TITLE}
          subtitle={rows.challenges || 'This season’s challenges and standings'}
          subtitleClassName={SUBTITLE}
        />
        <ListRow
          as="a"
          id="profile-row-kudos"
          href="#leaderboard/kudos"
          leading={<IconTile size="sm"><ThumbsUpIcon /></IconTile>}
          title="Kudos"
          titleClassName={TITLE}
          subtitle={rows.kudos || 'Kudos on your proposals'}
          subtitleClassName={SUBTITLE}
        />
        <ListRow
          as="a"
          id="profile-row-feedback"
          href="#profile?feedback"
          onClick={(event) => {
            if (event.defaultPrevented || event.button !== 0
              || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            Profile.showFeedback();
          }}
          leading={<IconTile size="sm"><ChatIcon /></IconTile>}
          title="Your feedback"
          titleClassName={TITLE}
          subtitle={rows.feedback || 'What you sent, and whether it counted'}
          subtitleClassName={SUBTITLE}
        />
        <ListRow
          as="a"
          id="profile-row-settings"
          href="#settings"
          leading={<IconTile size="sm"><CogIcon /></IconTile>}
          title="Settings"
          titleClassName={TITLE}
          subtitle={settingsLine}
          subtitleClassName={SUBTITLE}
        />
      </GroupedList>
    </section>
  );
}
