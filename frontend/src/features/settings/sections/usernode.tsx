/**
 * "Homeroom app" — the mobile app's native App Settings, absorbed into this
 * modal. See ./usernode-store.ts for why this host had to convert at once and
 * what stays settings.js's.
 *
 * ── What the conversion simplified, rather than moved ─────────────────
 *
 * Three things the imperative version did by hand stop existing here:
 *
 *   - `box.isConnected` guards. The activity-notifications section listened
 *     for `usernode:social-push-state` and checked, on every event, whether
 *     its own host was still in the document before writing to it. A publish
 *     to an unmounted component is a no-op by construction.
 *   - `holder.textContent = ''` before each in-place repaint, in four local
 *     `render(state)` closures.
 *   - `box.remove()` — the activity section deleted itself from the document
 *     when `SocialPush.isSupported()` resolved false. It is a model state now
 *     (`{ kind: 'absent' }`), which is also the only version of that fact the
 *     rest of the screen can read.
 *
 * The retry ladders, the staleness tokens and every bridge call stay in
 * settings.js, where they were.
 */

import { type ReactNode } from 'react';

import { useStoreState } from '../../../lib/use-store-state';
import { faqTiles } from './usernode-faq';
import { UnBtn, UnP, UnRow, UnSection, UnSwitch } from './usernode-ui';
import { usernodeSectionStore, type UsernodeSectionState } from './usernode-store';

const NOTICE_TONE = {
  warn: 'mt-2 rounded-md border px-3 py-2 text-xs border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300',
  ok: 'mt-2 rounded-md border px-3 py-2 text-xs border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300',
  plain: 'mt-2 rounded-md border px-3 py-2 text-xs border-zinc-300 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300',
} as const;

function Connection({ s }: { s: UsernodeSectionState }): ReactNode {
  const c = s.connection;
  if (!c) return null;
  return (
    <UnSection
      id="settings-usernode-connection"
      title="Homeroom app: connection"
      description="What this screen can reach in the app, and what to do when it can’t."
    >
      {c.demo ? <UnP note={{ text: 'Staging demo: sample data', tone: 'demo' }} /> : null}
      <UnRow row={c.row} />
      <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-2">{c.reason}</p>
      <UnP note={{ text: c.build, tone: 'mono' }} />
      {c.message ? (
        <p className="text-xs font-mono text-zinc-500 dark:text-zinc-500 mt-1 break-words">{c.message}</p>
      ) : null}
      {c.walletRecovery ? (
        <div id="settings-usernode-wallet-recovery" className={NOTICE_TONE.warn}>
          <p>
            No new mobile wallet is available for this account, so secure app
            sign-in did not finish. If you previously joined with email, you
            can connect that account’s wallet instead.
          </p>
          <UnBtn btn={c.walletRecovery} />
        </div>
      ) : null}
      <div>
        <UnBtn btn={{
          id: 'settings-usernode-connection-retry', label: 'Try again',
          action: '_retryUsernodeConnection', disabled: c.retryDisabled,
        }} />
        <UnBtn btn={{
          id: 'settings-usernode-connection-copy', label: 'Copy diagnostics',
          action: '_copyUsernodeDiagnostics', disabled: c.retryDisabled,
        }} />
      </div>
    </UnSection>
  );
}

function Body({ s }: { s: UsernodeSectionState }): ReactNode {
  const b = s.body;
  if (!b) return null;
  if (b.kind === 'loading') {
    return (
      <div id="settings-usernode-error" className="mt-6 pt-5 border-t border-zinc-200 dark:border-zinc-700">
        <p className="text-xs text-zinc-500 dark:text-zinc-400">Loading Homeroom app settings…</p>
      </div>
    );
  }
  if (b.kind === 'error') {
    return (
      <div id="settings-usernode-error" className="mt-6 pt-5 border-t border-zinc-200 dark:border-zinc-700">
        {/* Headline unchanged so existing reports stay recognisable. */}
        <p className="text-sm font-bold text-red-700 dark:text-red-400">
          Could not load Homeroom app settings.
        </p>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{b.reason}</p>
        {b.message ? (
          <p className="text-xs font-mono text-zinc-500 dark:text-zinc-500 mt-1 break-words">{b.message}</p>
        ) : null}
        <UnBtn btn={{ id: 'settings-usernode-retry', label: 'Try again', action: '_retryUsernodeRead' }} />
      </div>
    );
  }
  return (
    <UnSection title={b.heading} description={b.description}>
      {b.demo ? <UnP note={{ text: 'Staging demo: sample data', tone: 'demo' }} /> : null}
      <UnRow row={b.row} />
      {b.button ? <UnBtn btn={b.button} /> : null}
      {b.notice ? (
        <>
          <div id="settings-notif-notice" className={NOTICE_TONE[b.notice.tone]}>{b.notice.text}</div>
          {b.notice.settings ? (
            <UnBtn btn={{ label: 'Open notification settings', action: '_openNotifSettings' }} />
          ) : null}
        </>
      ) : null}
      {b.android ? (
        <>
          <UnRow row={b.android.row} />
          {b.android.button ? <UnBtn btn={b.android.button} /> : null}
          {b.android.device ? (
            <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-2">{b.android.device}</p>
          ) : null}
        </>
      ) : null}
    </UnSection>
  );
}

function SocialPush({ s }: { s: UsernodeSectionState }): ReactNode {
  const p = s.socialPush;
  if (p.kind === 'absent') return null;
  return (
    <UnSection
      title="Homeroom app: activity notifications"
      description="Get a device notification when a dev session or auto-solve run finishes. Notification content is loaded only after you open Social."
    >
      {p.kind === 'checking' ? <UnP note={{ text: 'Checking status…' }} /> : null}
      {p.kind === 'unavailable' ? (
        <>
          <UnP note={{ text: p.reason }} />
          {p.failure ? (
            <p className="text-xs font-mono text-zinc-500 dark:text-zinc-500 mt-1 break-words">{p.failure}</p>
          ) : null}
          {p.retry ? <UnBtn btn={{ label: 'Try again', action: '_retrySocialPush' }} /> : null}
        </>
      ) : null}
      {p.kind === 'ready' ? (
        <>
          <UnSwitch toggle={{
            label: 'Activity notifications', checked: p.enabled,
            action: '_setSocialPushEnabled', includeErrorDetail: true,
          }} />
          <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">{p.status}</p>
        </>
      ) : null}
    </UnSection>
  );
}

function BlockProduction({ s }: { s: UsernodeSectionState }): ReactNode {
  const bp = s.blockProduction;
  return (
    <UnSection
      title="Homeroom app: block production"
      description="Producing blocks earns points. Access is released manually, so ask below and an admin will release your keys in batches."
    >
      <div>
        {bp.kind === 'checking' ? <UnP note={{ text: 'Checking status…' }} /> : null}
        {bp.kind === 'note' ? <UnP note={{ text: bp.text }} /> : null}
        {bp.kind === 'ask' ? (
          <UnBtn btn={{ label: 'Ask to produce blocks', action: '_askForBlockProduction' }} />
        ) : null}
      </div>
    </UnSection>
  );
}

function WidgetIcons({ s }: { s: UsernodeSectionState }): ReactNode {
  const w = s.widgetIcons;
  if (!w) return null;
  return (
    <UnSection
      title="Homeroom app: widget icons"
      description="What the homescreen widget was told to show, and what it reports back."
    >
      {w.demo ? <UnP note={{ text: 'Staging demo: sample data', tone: 'demo' }} /> : null}
      {w.rows.map((row) => <UnRow key={row.id || row.label} row={row} />)}
      {w.notes.map((n, i) => <UnP key={`${n.tone || 'muted'}-${i}`} note={n} />)}
      {w.entries.length === 1 && w.entries[0].empty ? (
        <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-2">{w.entries[0].empty}</p>
      ) : (
        <div id="settings-widget-icon-entries" className="mt-3 space-y-1">
          {w.entries.map((e) => (
            <div key={e.key} className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${e.ok ? 'bg-emerald-500' : 'bg-amber-500'}`}></span>
              <span className="text-zinc-700 dark:text-zinc-300">{e.name}</span>
              <span className="ml-auto">{e.note}</span>
            </div>
          ))}
        </div>
      )}
      {w.recheck ? <UnBtn btn={{ label: 'Re-check icons', action: '_recheckWidgetIcons' }} /> : null}
    </UnSection>
  );
}

function Tail({ s }: { s: UsernodeSectionState }): ReactNode {
  return (
    <>
      {s.nodeSleep ? (
        <UnSection
          title="Homeroom app: node"
          description="The node pauses when the app has been inactive for a while and wakes on your next interaction."
        ><UnSwitch toggle={s.nodeSleep} /></UnSection>
      ) : null}
      <BlockProduction s={s} />
      {s.privacy ? (
        <UnSection
          title="Homeroom app: privacy & identity"
          description="Controls for the ZK passport identity flow."
        >
          <UnSwitch toggle={s.privacy.facematch} />
          {s.privacy.open ? <UnBtn btn={s.privacy.open} /> : null}
          <UnBtn btn={s.privacy.reset} />
        </UnSection>
      ) : null}
      <WidgetIcons s={s} />
      {s.diagnostics ? (
        <UnSection
          title="Homeroom app: diagnostics"
          description="Debugging tools for the app and its embedded node."
        >
          {s.diagnostics.debugMode ? <UnSwitch toggle={s.diagnostics.debugMode} /> : null}
          <div>{s.diagnostics.actions.map((a) => <UnBtn key={a.action} btn={a} />)}</div>
        </UnSection>
      ) : null}
      {s.about ? (
        <UnSection title="Homeroom app: about & legal">
          {s.about.notes.map((n, i) => (
            <p key={i} className="text-xs text-zinc-500 dark:text-zinc-400 font-mono">{n.text}</p>
          ))}
          <div>{s.about.actions.map((a) => <UnBtn key={a.action} btn={a} />)}</div>
          <Faq s={s} />
        </UnSection>
      ) : null}
      {s.account ? (
        <UnSection title="Homeroom app: account">
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            The app signs in automatically with your platform account. If this message persists, try closing and reopening the app.
          </p>
        </UnSection>
      ) : null}
    </>
  );
}

function Faq({ s }: { s: UsernodeSectionState }): ReactNode {
  const perms = s.body && s.body.kind === 'permissions' ? s.body : null;
  const isAndroid = !!(perms && perms.android);
  const device = perms && perms.android ? perms.android.device : null;
  return (
    <div className="mt-3">
      <div className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 mb-1">Help &amp; Info</div>
      {faqTiles(isAndroid, device).map((tile) => (
        <details key={tile.title} className="rounded-lg border border-zinc-200 dark:border-zinc-800 px-3 py-2 mb-2">
          <summary className="text-sm font-medium cursor-pointer select-none">{tile.title}</summary>
          {tile.paragraphs.map((p, i) => (
            <p key={i} className="text-xs text-zinc-500 dark:text-zinc-400 mt-2 leading-relaxed">{p}</p>
          ))}
        </details>
      ))}
    </div>
  );
}

export function UsernodeSectionBody({ s }: { s: UsernodeSectionState }): ReactNode {
  return (
    <>
      {/* First, so a refused handshake explains itself ABOVE the failures it
          causes rather than below them. */}
      <Connection s={s} />
      <Body s={s} />
      {/* The demo link renders the permissions rows and stops: everything
          below reads the live bridge, which a browser does not have. */}
      {s.belowDemoCut ? <><SocialPush s={s} /><Tail s={s} /></> : null}
    </>
  );
}

export function UsernodeSection(): ReactNode {
  const s = useStoreState(usernodeSectionStore);
  return (
    <div data-settings-section="usernode" className="hidden">
      {/* #settings-usernode-section's `hidden` is a CAPABILITY GATE, separate
          from the wrapper's routing `hidden` above, and
          Settings._visibleSections() reads it back to decide menu membership. */}
      <div id="settings-usernode-section" className={s.gated ? '' : 'hidden'}>
        <UsernodeSectionBody s={s} />
      </div>
    </div>
  );
}
