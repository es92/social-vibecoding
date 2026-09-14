/**
 * Recovery for a pre-merge email account's current-season wallet.
 *
 * Native admission is still the only path that publishes wallet authority.
 * When that path reports that the seeded pool is empty, native-chrome.js
 * RECORDS the failure (NativeChrome.lastSessionFailure()) and nothing more;
 * Settings → Homeroom app → connection reads that record and offers a
 * "Connect existing wallet" button, whose press is the ONLY thing that opens
 * this dialog (Settings._openWalletRecovery → UsernodeReact.dialogs
 * .walletRecovery.open). It used to open itself — on a
 * `usernode:wallet-recovery-required` event and again on mount — and, since
 * admission is retried on every online / pageshow / visibilitychange, that
 * meant a modal nobody asked for popping up several times a session over a
 * minor feature. The dialog proves the legacy email through the existing OTP
 * service, asks the database transaction to move the wallet, then replays the
 * SAME native admission attempt. No handoff ticket or wallet secret enters
 * React.
 */

import { useEffect, useRef, useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { DialogCard, DialogRoot } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

import { useDialog } from './use-dialog';

/**
 * Settings passes the signed-in user's id so the dialog can notice a session
 * change under it (see stillOwns); a bare open() falls back to the current
 * user.
 */
interface RecoveryRequest {
  userId?: string;
}

interface ApiBody {
  ok?: boolean;
  success?: boolean;
  claimed?: boolean;
  error?: string;
  code?: string;
}

interface NativeChromeRecovery {
  recoverSessionAdmission?(): Promise<unknown>;
}

function nativeChrome(): NativeChromeRecovery | undefined {
  return (window as unknown as { NativeChrome?: NativeChromeRecovery }).NativeChrome;
}

function currentUserId(): string | null {
  const raw = window.App?.user?.id;
  const id = raw == null ? '' : String(raw);
  return /^[1-9][0-9]*$/.test(id) ? id : null;
}

async function readBody(response: Response): Promise<ApiBody> {
  try {
    return await response.json() as ApiBody;
  } catch {
    return {};
  }
}

function claimError(body: ApiBody): string {
  if (body.code === 'wallet_claim_requires_key_rotation') {
    return 'That wallet was already installed elsewhere. Moving it safely requires key rotation, which is not available yet.';
  }
  return body.error || 'Could not connect that wallet. Check the email and code, then try again.';
}

export function WalletRecoveryDialog() {
  const emailRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const targetUserId = useRef<string | null>(null);
  const recoveryGeneration = useRef(0);
  const busyRef = useRef(false);

  const [busyAction, setBusyAction] = useState<'send' | 'claim' | 'resume' | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [claimed, setClaimed] = useState(false);

  function setBusy(action: 'send' | 'claim' | 'resume' | null) {
    busyRef.current = action !== null;
    setBusyAction(action);
  }

  function resetFields() {
    setBusy(null);
    setError('');
    setStatus('');
    setClaimed(false);
    if (emailRef.current) emailRef.current.value = '';
    if (codeRef.current) codeRef.current.value = '';
  }

  const dialog = useDialog<RecoveryRequest>('walletRecovery', {
    canClose: () => !busyRef.current,
    onOpen: (request) => {
      recoveryGeneration.current++;
      targetUserId.current = request?.userId || currentUserId();
      resetFields();
    },
    onClose: () => {
      recoveryGeneration.current++;
      targetUserId.current = null;
      resetFields();
    },
  });

  function stillOwns(userId: string, generation: number): boolean {
    return recoveryGeneration.current === generation
      && targetUserId.current === userId
      && currentUserId() === userId;
  }

  function forceClose() {
    recoveryGeneration.current++;
    targetUserId.current = null;
    setBusy(null);
    dialog.close();
  }

  // Nothing here OPENS the dialog — see the header comment. The one listener
  // left is the close: a sign-out (or any realm close) while the form is up
  // must not leave it addressing a user who is no longer signed in.
  useEffect(() => {
    const onRealmClose = () => forceClose();
    window.addEventListener('sv:native-realm-close', onRealmClose);
    return () => {
      window.removeEventListener('sv:native-realm-close', onRealmClose);
    };
  }, [dialog.close]);

  async function sendCode() {
    if (busyRef.current) return;
    const userId = targetUserId.current;
    const generation = recoveryGeneration.current;
    const email = emailRef.current?.value.trim().toLowerCase() || '';
    if (!userId || !stillOwns(userId, generation)) return forceClose();
    if (!email || !email.includes('@')) {
      setError('Enter the email address used by your previous account.');
      return;
    }

    setError('');
    setStatus('');
    setBusy('send');
    try {
      const response = await fetch('/api/auth/otp/request', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const body = await readBody(response);
      if (!stillOwns(userId, generation)) return;
      if (!response.ok || body.ok !== true) {
        setError(body.error || 'Could not send a code. Please try again.');
        return;
      }
      setStatus('Check that email for a six-digit code.');
      codeRef.current?.focus();
    } catch {
      if (stillOwns(userId, generation)) {
        setError('Could not send a code. Please try again.');
      }
    } finally {
      if (recoveryGeneration.current === generation) setBusy(null);
    }
  }

  async function resumeNativeSession(userId: string, generation: number) {
    const chrome = nativeChrome();
    if (!chrome || typeof chrome.recoverSessionAdmission !== 'function') {
      setError('Update the Homeroom app to finish connecting this wallet.');
      return;
    }

    setBusy('resume');
    const result = await chrome.recoverSessionAdmission().catch(() => null);
    if (!stillOwns(userId, generation)) return;
    if (!result) {
      setError('The wallet is connected, but app sign-in did not finish. Try again.');
      return;
    }
    setBusy(null);
    dialog.close();
  }

  async function claimWallet(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current) return;
    const userId = targetUserId.current;
    const generation = recoveryGeneration.current;
    if (!userId || !stillOwns(userId, generation)) return forceClose();
    if (claimed) {
      await resumeNativeSession(userId, generation);
      if (recoveryGeneration.current === generation) setBusy(null);
      return;
    }

    const email = emailRef.current?.value.trim().toLowerCase() || '';
    const code = codeRef.current?.value.trim() || '';
    if (!email || !email.includes('@')) {
      setError('Enter the email address used by your previous account.');
      return;
    }
    if (!/^\d{6}$/.test(code)) {
      setError('Enter the six-digit code from the email.');
      return;
    }

    setError('');
    setStatus('');
    setBusy('claim');
    try {
      const response = await fetch('/api/v4/mobile/wallet/claim', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code }),
      });
      const body = await readBody(response);
      if (!stillOwns(userId, generation)) return;

      // A concurrent tab may have completed the same recovery. The ordinary
      // native admission API is the authority on whether this user can now
      // enter, so a target-wallet conflict can safely take the same path.
      const ready = response.ok && body.success === true && body.claimed === true;
      if (!ready && body.code !== 'wallet_claim_conflict') {
        setError(claimError(body));
        return;
      }

      setClaimed(true);
      setStatus('Wallet connected. Finishing app sign-in…');
      await resumeNativeSession(userId, generation);
    } catch {
      if (stillOwns(userId, generation)) {
        setError('Could not connect that wallet. Please try again.');
      }
    } finally {
      if (recoveryGeneration.current === generation) setBusy(null);
    }
  }

  return (
    <DialogRoot
      id="wallet-recovery-modal"
      ref={dialog.rootRef}
      {...dialog.backdropProps}
    >
      <DialogCard size="sm">
        <h2 className="text-lg font-bold mb-1 text-zinc-900 dark:text-zinc-100">
          Connect your existing wallet
        </h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">
          No new mobile wallet is available. If you previously joined with email,
          prove that address to connect its current-season wallet.
        </p>
        <form className="space-y-4" onSubmit={claimWallet}>
          <label className="block">
            <span className="block text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1">
              Previous account email
            </span>
            <div className="flex gap-2">
              <Input
                ref={emailRef}
                type="email"
                autoComplete="email"
                width="flex"
                box="dialog"
                hint="muted"
                ring="seamless"
                disabled={claimed}
                placeholder="you@example.com"
              />
              <Button
                type="button"
                layout="shrink"
                disabledStyle="block"
                disabled={busyAction !== null || claimed}
                onClick={sendCode}
              >
                {busyAction === 'send' ? 'Sending…' : 'Send code'}
              </Button>
            </div>
          </label>
          <label className="block">
            <span className="block text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1">
              Email code
            </span>
            <Input
              ref={codeRef}
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              pattern="[0-9]{6}"
              box="dialog"
              hint="muted"
              ring="seamless"
              disabled={claimed}
              placeholder="123456"
            />
          </label>
          {status ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              {status}
            </p>
          ) : null}
          {error ? (
            <p className="text-sm text-red-600 dark:text-red-400" role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex gap-3">
            <Button
              type="button"
              layout="flex"
              variant="neutral"
              ink="neutral"
              disabled={busyAction !== null}
              onClick={() => dialog.close()}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              layout="flex"
              disabledStyle="block"
              disabled={busyAction !== null}
            >
              {busyAction === 'claim' || busyAction === 'resume'
                ? 'Connecting…'
                : claimed ? 'Try again' : 'Connect wallet'}
            </Button>
          </div>
        </form>
      </DialogCard>
    </DialogRoot>
  );
}
