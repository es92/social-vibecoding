/**
 * The wallet sheet's body.
 * See ./wallet-sheet-store.ts for what the seam carries.
 *
 * ── The kit owns the panel; React owns what is in it ──────────────────
 *
 * Same seam as ./node-pill-sheet.tsx: `PlatformUI.sheet({ contentEl })`
 * reparents the element it is handed, so the panel stays the module's and the
 * BODY is a portal. What that folds away here is larger — roughly forty
 * `createElement` calls rebuilt from scratch on every repaint, and there are
 * many: the 60s refresh, the admission reset, `_manageStaking`'s three, and
 * the send flow's.
 *
 * ── Send and Receive keep their state HERE ────────────────────────────
 *
 * `_showSend`/`_showReceive` wrote into a `#wallet-sheet-expand` div and
 * `_clearExpand()` blanked it — so a wallet refresh landing mid-typing threw
 * away a half-entered address. The expand is a `useState` now and survives a
 * repaint, which is the same fix the dev chat's share popover got.
 *
 * Send calls `window.sendTransaction`, which maps to the exact admitted native
 * `submitTransaction` operation. Social owns the returned txId and receipt.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

import { useStoreState } from '../../lib/use-store-state';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';
import { walletSheetStore, type StakingView, type WalletSheetState } from './wallet-sheet-store';

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).WalletSheet : null) || null;
}

function ui(): any {
  return (typeof window !== 'undefined' ? (window as any).PlatformUI : null) || null;
}

const FIELD
  = 'w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700'
  + ' bg-transparent text-sm';

const ROW_LINE = 'flex items-center justify-between py-2 border-b border-zinc-100 dark:border-zinc-800 text-sm';

// ── the block-production card ──────────────────────────────────────────

/**
 * Android only (#3059): while this phone produces blocks, the app keeps a
 * background service running with a persistent notification. Say so in plain
 * words, and say it is off when production is delegated or not set up yet.
 * The Android permission's own name never appears here.
 */
export const BACKGROUND_SERVICE_ACTIVE
  = 'A background service keeps running so this phone can keep producing blocks'
  + ' and stay in sync with the network while you are not using the app.'
  + ' A notification stays visible while it is active.';
export const BACKGROUND_SERVICE_INACTIVE
  = 'The background service is not active. This phone is not producing blocks,'
  + ' so nothing keeps running while you are not using the app.';

/** Drawn as the soft warning box, the Node sheet's health notice. */
function BackgroundServiceNote({ active }: { active: boolean }): ReactNode {
  return (
    <Alert
      variant="notice" density="compact"
      data-background-service={active ? 'active' : 'inactive'}
    >
      {active ? BACKGROUND_SERVICE_ACTIVE : BACKGROUND_SERVICE_INACTIVE}
    </Alert>
  );
}

export const DELEGATION_DISCLOSURE
  = 'When delegated, you receive half the points you would earn by producing blocks directly from your phone.';
export const SELF_HOSTED_NODE
  = 'Want to run a node on your own laptop or server and monitor it from your phone?'
  + ' Start the node there using the same account you use on this phone.';

/** The plain card every non-warning box in this section uses. */
const CARD = 'rounded-lg border border-zinc-200 dark:border-zinc-800 p-3 text-sm';
const MUTED = 'mt-1 text-sm text-zinc-500 dark:text-zinc-400';

function StakingCard({ s }: { s: WalletSheetState }): ReactNode {
  const staking: StakingView = s.staking;
  if (staking.kind === 'absent') return null;
  // Order (#3059 follow-up): the phone's status, with the delegation
  // disclosure inside it; then the self-hosted node card; then, on Android,
  // the background service warning; then the action. Warnings use
  // `Alert notice`; every other box is the plain CARD.
  return (
    <section data-block-production className="mb-4 space-y-3">
      <div className="text-[0.9375rem] font-semibold text-zinc-500 dark:text-zinc-400">
        Block production
      </div>
      <div data-block-production-card="status" className={CARD}>
        {staking.kind === 'pending' ? (
          // Setup unfinished is NOT "not delegated": it offers a retry.
          <div className="text-base font-semibold">Wallet setup is still in progress</div>
        ) : (
          <>
            <div className="text-base font-semibold">
              {staking.kind === 'delegated' ? 'Delegated' : 'Producing blocks on this phone'}
            </div>
            <div className={MUTED}>
              {staking.kind === 'delegated'
                ? 'Block production on this phone is disabled.'
                : 'Producing blocks directly on this phone earns full points.'}
            </div>
            {staking.kind === 'delegated' ? (
              <>
                <div className="mt-2 font-mono text-xs">{staking.delegate}</div>
                {staking.since ? (
                  <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                    {`Delegated since ${staking.since}`}
                  </div>
                ) : null}
              </>
            ) : null}
          </>
        )}
        <div className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          {DELEGATION_DISCLOSURE}
        </div>
      </div>
      <div data-block-production-card="self-hosted" className={CARD}>
        {SELF_HOSTED_NODE}
      </div>
      {s.isAndroid
        ? <BackgroundServiceNote active={staking.kind === 'local'} />
        : null}
      {staking.kind === 'pending' ? (
        <Button
          layout="full" size="narrowBold"
          disabled={s.refreshPending}
          onClick={() => controller()?.retryState?.()}
        >{s.refreshPending ? 'Retrying…' : 'Retry'}</Button>
      ) : (
        <Button
          layout="full" size="narrowBold"
          disabled={s.stakingPending}
          onClick={() => controller()?._manageStaking?.()}
        >{s.stakingPending ? 'Opening…' : 'Manage delegation'}</Button>
      )}
    </section>
  );
}

// ── send / receive ─────────────────────────────────────────────────────

function ReceivePanel({ address }: { address: string }): ReactNode {
  const qrRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = qrRef.current;
    const QR = (window as any).QRCode;
    if (!el || !QR) return;
    el.textContent = '';
    // The QR library writes its own canvas/img into this node. It is the one
    // element in this subtree React does not own, which is why it is empty in
    // render and filled from an effect on a ref.
    // eslint-disable-next-line no-new
    new QR(el, { text: address, width: 160, height: 160 });
  }, [address]);
  return (
    <div className="flex flex-col items-center gap-2 p-4 mb-4 rounded-lg border border-zinc-200 dark:border-zinc-800">
      <div ref={qrRef} className="bg-white p-2 rounded"></div>
      <div className="font-mono text-xs break-all text-center text-zinc-500 dark:text-zinc-400">
        {address}
      </div>
    </div>
  );
}

function SendForm({ onSent }: { onSent: () => void }): ReactNode {
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [sending, setSending] = useState(false);
  const toRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { toRef.current?.focus(); }, []);

  const submit = async () => {
    const addr = to.trim();
    const n = parseInt(amount.trim(), 10);
    if (!addr || !addr.startsWith('ut1')) { ui()?.toast?.('Enter a valid ut1… address'); return; }
    if (!Number.isFinite(n) || n <= 0) { ui()?.toast?.('Enter a positive amount'); return; }
    setSending(true);
    const ok = await controller()?.sendFromSheet?.(addr, n);
    if (ok) onSent(); else setSending(false);
  };

  return (
    <div className="flex flex-col gap-2 p-4 mb-4 rounded-lg border border-zinc-200 dark:border-zinc-800">
      <input
        ref={toRef} placeholder="Recipient address (ut1…)"
        className={`${FIELD} font-mono`}
        value={to} onChange={(e) => setTo(e.target.value)}
      />
      <input
        placeholder="Amount" inputMode="numeric" className={FIELD}
        value={amount} onChange={(e) => setAmount(e.target.value)}
      />
      <Button size="flushBold" disabled={sending} onClick={submit}>Send</Button>
      <div className="text-xs text-zinc-500 dark:text-zinc-400">
        You will confirm this transaction on the next screen.
      </div>
    </div>
  );
}

// ── the body ───────────────────────────────────────────────────────────

export function WalletSheetBody(): ReactNode {
  const s = useStoreState(walletSheetStore);
  const [expand, setExpand] = useState<'none' | 'send' | 'receive'>('none');
  return (
    <>
      <div className="text-3xl font-bold mb-1">{s.balanceLabel}</div>
      <div className="flex items-center gap-2 mb-4 text-sm text-zinc-500 dark:text-zinc-400">
        <span className="font-mono">{s.shortAddress}</span>
        {s.address ? (
          <button
            className="text-violet-700 hover:text-violet-400 text-xs font-medium dark:text-violet-400"
            onClick={() => controller()?.copyAddress?.()}
          >Copy</button>
        ) : null}
      </div>
      <div className="flex gap-2 mb-4">
        <Button
          layout="flex" size="flushBold" disabled={!s.submissionSupported}
          onClick={() => setExpand('send')}
        >Send</Button>
        <button
          className="flex-1 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 text-sm font-semibold text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          onClick={() => setExpand('receive')}
        >Receive</button>
      </div>
      {!s.walletSupported ? (
        <div className="mb-4 rounded-lg border border-zinc-200 dark:border-zinc-800 p-3 text-sm text-zinc-500 dark:text-zinc-400">
          Wallet state is unavailable in this app version.
        </div>
      ) : null}
      {!s.submissionSupported ? (
        <div className="mb-4 rounded-lg border border-zinc-200 dark:border-zinc-800 p-3 text-sm text-zinc-500 dark:text-zinc-400">
          Transaction submission is unavailable in this app version.
        </div>
      ) : null}
      {s.stateError ? (
        <div className="mb-4 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">
          {s.stateError}
        </div>
      ) : null}
      <StakingCard s={s} />
      <div id="wallet-sheet-expand">
        {expand === 'receive' && s.address ? <ReceivePanel address={s.address} /> : null}
        {expand === 'send' ? <SendForm onSent={() => setExpand('none')} /> : null}
      </div>
      <div className="text-sm font-semibold text-zinc-500 dark:text-zinc-400 mt-2 mb-1">
        Recent
      </div>
      <div>
        {s.receipts == null
          ? <div className="text-sm text-zinc-500 py-2 dark:text-zinc-400">Loading…</div>
          : s.receipts.length === 0
            ? <div className="text-sm text-zinc-500 py-2 dark:text-zinc-400">No recent transactions yet.</div>
            : s.receipts.slice(0, 20).map((r) => (
              <div key={r.key} className={ROW_LINE}>
                <div className="min-w-0">
                  <div className="font-medium truncate">{r.line1}</div>
                  <div className="text-xs text-zinc-500 dark:text-zinc-400">{r.line2}</div>
                </div>
              </div>
            ))}
      </div>
    </>
  );
}

/** Mount helpers, so ./wallet-sheet.js needs no `createElement` of its own. */
export function mountWalletSheet(host: Element | null): void {
  mountLegacyPortal(host, <WalletSheetBody />);
}

export function unmountWalletSheet(host: Element | null): void {
  unmountLegacyPortal(host);
}
