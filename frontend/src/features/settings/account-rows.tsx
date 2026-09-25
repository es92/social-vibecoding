/**
 * Settings' account block — Admin & moderation and the native wallet, node
 * and staking rows, above Log out.
 *
 * ── Why these live in Settings now ────────────────────────────────────
 *
 * They were the bottom of the Me screen (features/profile/account-panel.tsx
 * until this change): a "Platform" group with Admin & moderation, and an
 * "Account" group with the three native readouts and Log out. The navigation
 * prototype's Me has none of that — a profile card, three stat cards, a
 * "More" list and your contributions — and the spec's table of retired places
 * says where the rest goes: "Me, with Admin and Validator inside Settings".
 * The prototype's Settings closes the same way, with the wallet under Money
 * and the admin console under Admin. Settings already had Log out.
 *
 * ── Where it sits, and why that is safe ───────────────────────────────
 *
 * Inside #settings-footer, above #settings-logout. That node is already where
 * this block belongs on both layouts: under the section list in the desktop
 * sidebar, and under the level-1 menu on a phone — Settings._syncFooter MOVES
 * it between the two columns, and hides it on a phone's level 2, which is
 * exactly when an account row should not show either.
 *
 * The move is why this component renders only INSIDE the footer and never
 * next to it. React inserts and removes nodes relative to a parent: every
 * change here happens inside #settings-footer, which is a valid parent
 * wherever settings.js has put it, while a sibling of the footer would be
 * inserted against a node that may no longer be in the column React thinks
 * it is in. The Log out button beside it is untouched: same element, same
 * id, so the click handler settings.js bound in init() survives.
 *
 * ── First render ──────────────────────────────────────────────────────
 *
 * Nothing until mounted. The footer is in the prerendered shell, and the
 * admin flag and the native stores can be published BEFORE hydration (the
 * admin flag by app.js as the session resolves), so reading them during the
 * first render could disagree with the document — React #418 on every
 * route. The block appears from an effect instead, and its rows are never in
 * the shell's markup.
 */

import { useEffect, useState, type ReactNode } from 'react';

import { GroupedList, SectionHeader } from '@/components/ui/grouped-list';
import { ChevronRightIcon } from '@/components/ui/icons';
import { useStoreState } from '../../lib/use-store-state';
import { useVisibility } from '../../lib/visibility-store';
import { NodePillRow } from '../header/node-pill-row';
import { nodePillStore } from '../header/node-pill-store';
import { navStore } from '../nav/nav-store.js';
import { WalletRow } from '../header/wallet-row';
import { walletSheetStore } from '../header/wallet-sheet-store';
import { StakingRow } from '../profile/staking-sheet';

/** The two nav hosts' heading insets, phone then desktop (settings-nav.tsx). */
const HEADING = 'px-4 pt-0 pb-1.5 md:px-3 md:pb-1';

/**
 * The Admin row wears each layout's own nav row, so it reads as one more
 * entry of the list it sits under: a level-1 MENU row on a phone (white card,
 * 44px, 17px text, a chevron — settings-nav.tsx's MENU_ROW over ListRow) and a
 * sidebar NAV row from md up (settings.js's `settings-nav-item`, no card, no
 * chevron). One anchor, two sets of classes; complete literals for Tailwind.
 */
const ADMIN_CARD = 'overflow-hidden rounded-2xl bg-white dark:bg-zinc-900 md:rounded-none md:bg-transparent md:dark:bg-transparent md:overflow-visible';
const ADMIN_ROW = 'flex w-full items-center gap-4 px-4 min-h-[44px] py-2 text-[1.0625rem] text-zinc-700 dark:text-zinc-200 '
  + 'hover:bg-zinc-50 dark:hover:bg-zinc-800/60 transition-colors '
  + 'md:min-h-0 md:gap-2 md:rounded-lg md:px-3 md:py-2 md:text-sm md:font-medium md:text-zinc-600 md:dark:text-zinc-300 '
  + 'md:hover:bg-zinc-100 md:dark:hover:bg-zinc-800';

export function SettingsAccountRows(): ReactNode {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  // A CAPABILITY, published rather than fetched: App.renderAdminButton in
  // public/js/app.js writes it after the session resolves. The id is a row's
  // from when the app menu held that row; the flag outlived it.
  const isAdmin = useVisibility('switcher-row-admin', false);
  const nodeVisible = (useStoreState(nodePillStore) as { visible: boolean }).visible;
  const walletVisible = (useStoreState(walletSheetStore) as { visible: boolean }).visible;
  // The Node row keeps itself current while Settings is on screen: status
  // events only fire on transitions, so it pulls on reveal and every few
  // seconds after (node-pill.js `setLiveRefresh`), and stops when hidden.
  // The router's last revealed screen (nav-store), which is Settings'
  // own truth: this screen does not publish through the visibility store.
  const settingsVisible = (useStoreState(navStore) as { screen: string | null }).screen === 'settings-screen';
  const liveNode = settingsVisible && nodeVisible;
  useEffect(() => {
    const pill = (window as any).NodePill;
    pill?.setLiveRefresh?.('settings', liveNode);
    return () => { pill?.setLiveRefresh?.('settings', false); };
  }, [liveNode]);
  if (!mounted) return null;
  // The native readouts ship hidden and reveal themselves when the bridge
  // reports the capability; their group heading follows them, so a browser
  // never shows a heading over nothing.
  const native = nodeVisible || walletVisible;
  return (
    <div id="settings-account-rows" className={isAdmin || native ? 'mb-6 space-y-5' : undefined}>
      {isAdmin ? (
        <section aria-label="Admin">
          <SectionHeader className={HEADING}>Admin</SectionHeader>
          <div className={ADMIN_CARD}>
            {/*
                A real anchor, like every row that navigates: #admin is a hash
                route the router resolves, and a modified click opens it in a
                new tab. Not rendered at all without the capability, which is
                safe here for the reason above: none of this is prerendered.
            */}
            <a id="settings-row-admin" href="#admin" className={ADMIN_ROW}>
              <span className="min-w-0 flex-1 truncate">Admin &amp; moderation</span>
              <ChevronRightIcon className="h-5 w-5 shrink-0 text-zinc-300 dark:text-zinc-600 md:hidden" aria-hidden="true" />
            </a>
          </div>
        </section>
      ) : null}
      <section aria-label="Wallet and node">
        {native ? <SectionHeader className={HEADING}>Wallet &amp; node</SectionHeader> : null}
        <GroupedList className="mx-0">
          <NodePillRow />
          <WalletRow />
          <StakingRow />
        </GroupedList>
      </section>
    </div>
  );
}
