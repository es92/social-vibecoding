import { Button } from '@/components/ui/button';
import { SectionHeading, StatusLine } from '@/components/ui/field';
import { PasswordInput } from '@/components/ui/password-input';

/**
 * Change password (issue #282). Default form calls POST /api/me/password
 * (current password required). In the Homeroom native app with a linked
 * wallet, a "Use your wallet instead" link switches to wallet mode
 * (cp-wallet-mode shown, current password hidden) which signs a wallet-check
 * challenge and calls POST /api/me/wallet-change-password — the way back for a
 * logged-in user who's forgotten the password they'd need to type. settings.js
 * wires the mode switch and both submit paths.
 */
export function PasswordSection() {
  return (
    <div data-settings-section="password" className="hidden">
      <div id="change-password-section">
        <SectionHeading title="Change password">
          Set a new password for web login. If an admin gave you a temporary password, enter it as your current password here.
        </SectionHeading>
        {/* One card, the three fields as its rows. */}
        <div className="rounded-2xl bg-white dark:bg-zinc-900 overflow-hidden">
          <div id="cp-current-row" className="px-4 py-3 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-zinc-200 dark:[&:not(:last-child)]:border-zinc-800">
            <PasswordInput
              id="cp-current"
              autoComplete="current-password"
              placeholder="Current password"
              box="card"
              ring="bare"
              hint="dim"
            />
          </div>
          <div className="px-4 py-3 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-zinc-200 dark:[&:not(:last-child)]:border-zinc-800">
            <PasswordInput
              id="cp-new"
              autoComplete="new-password"
              placeholder="New password (at least 8 characters)"
              box="card"
              ring="bare"
              hint="dim"
            />
          </div>
          <div className="px-4 py-3 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-zinc-200 dark:[&:not(:last-child)]:border-zinc-800">
            <PasswordInput
              id="cp-confirm"
              autoComplete="new-password"
              placeholder="Confirm new password"
              box="card"
              ring="bare"
              hint="dim"
            />
          </div>
        </div>
        {/* Default (password) submit */}
        <Button id="cp-save" layout="stacked" variant="pillAccent" size="pillLg" className="mt-3">
          Change password
        </Button>
        {/* Wallet (signature) submit — shown only in wallet mode */}
        <Button id="cp-wallet-save" layout="hiddenStacked" variant="pillAccent" size="pillLg">
          Sign &amp; change password
        </Button>
        {/*
            Mode switches. cp-wallet-mode is itself hidden unless the user
            is in the native app with a linked wallet (settings.js).
        */}
        <p id="cp-wallet-mode" className="hidden text-xs text-center mt-2">
          <a id="cp-use-wallet" href="#" className="text-violet-700 hover:text-violet-400 dark:text-violet-400">
            Forgot it? Use your wallet instead
          </a>
        </p>
        <p id="cp-password-mode" className="hidden text-xs text-center mt-2">
          <a id="cp-use-password" href="#" className="text-violet-700 hover:text-violet-400 dark:text-violet-400">
            Use current password instead
          </a>
        </p>
        <StatusLine id="cp-status" />
      </div>
    </div>
  );
}
