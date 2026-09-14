/**
 * `#github-link-body` — the social-account ownership proofs and the daily
 * credit tier, as the only React writer below that host.
 *
 * settings.js keeps the fetch, the unlink DELETE, the `?demo=` variants and
 * the callback status line (a sibling); every branch that decides WHAT this
 * says is resolved there, in ./social-identity-store.js's shape. This file
 * spells it as markup, class string for class string.
 *
 * ── Local interaction state ──────────────────────────────────────────
 *
 * The Copy control's "Copied" flash and the configuration check's
 * in-flight/verdict line were local variables closed over by a listener,
 * mutating `textContent` and `className` on nodes the same closure had
 * created. They are `useState` here, which is allowed for exactly the reason
 * AGENTS.md gives: nothing outside React writes anywhere in this subtree, so
 * the region may hold state.
 * Native Connect launch feedback also stays here. The system browser owns
 * OAuth; the app reloads its account status when it returns to the foreground.
 *
 * ── The check posts to `/x/check`, for either provider ────────────────
 *
 * That is the shipped behaviour, not a slip in the port: the endpoint exists
 * for X's credential pair, and the diagnostics panel is only ever served for a
 * provider whose OAuth setup can fail invisibly on its own page (#1291).
 * Preserved verbatim; changing it would be a behaviour change wearing a
 * renderer swap's clothes.
 */

import { useEffect, useRef, useState } from 'react';

import { useStoreState } from '../../lib/use-store-state';
import { socialIdentityStore } from './social-identity-store.js';
import { openNativeSocialConnect, watchSocialConnectReturn } from './native-social-connect.js';

type TierCardView = { title: string; detail: string; tone: 'plain' | 'warn' | 'ok' };

type DiagnosticsView = {
  source: string;
  callbackUrl: string;
  warning: string;
  demo: boolean;
  name: string;
  provider: string;
};

type ProviderRowView = {
  provider: 'github' | 'x';
  name: string;
  heading: string;
  /** #1557 — the row's own state, as a pill. `null` when not connected. */
  badge: { text: string; tone: 'emerald' | 'amber' } | null;
  state: { text: string; tone: 'amber' | 'emerald' | 'muted' };
  linkedAt: string | null;
  noToken: string | null;
  /** `href: null` is the ?demo= variant — a disabled button, not a link. */
  connect: { label: string; href: string | null } | null;
  unlink: { disabled: boolean } | null;
  strandedNote: string | null;
  diagnostics: DiagnosticsView | null;
};

type SocialIdentityState = {
  phase: 'idle' | 'loading' | 'error' | 'ready';
  message: string | null;
  tier: TierCardView | null;
  providers: ProviderRowView[];
};

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).Settings : null) || null;
}

const TIER_TONE = {
  plain: '',
  warn: ' border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/20',
  ok: ' border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/20',
};

/**
 * The Connect control's surface, shared by BOTH spellings of it.
 *
 * The live one is an `<a href>` — normal browsers navigate directly, while
 * native taps open the system browser — and its ?demo= twin is a disabled `<button>`, because a
 * fixture must not navigate out of itself. They have to render identically,
 * and `@/components/ui/button` cannot spell an anchor (this install is
 * hand-rolled and has no `asChild`), so routing the button through the
 * primitive would leave the pair written two different ways and free to drift.
 * One constant instead, and this file is on
 * tests/shell-primitive-adoption.test.js's allow-list for exactly that reason.
 */
const CONNECT_SURFACE = 'rounded-md bg-violet-600 px-2 py-1 text-xs font-medium text-white';

const STATE_TONE = {
  amber: 'text-amber-800 dark:text-amber-400',
  emerald: 'text-emerald-700 dark:text-emerald-400',
  muted: 'text-zinc-500 dark:text-zinc-400',
};

/*
 * #1557: the connected badge, in the platform's read-only pill shape.
 *
 * A `<span>`, not @/components/ui/chip: that component is a
 * `<button aria-pressed>` for filter toggles, and announcing a status as a
 * pressed button is wrong for anyone on a screen reader. Same reasoning, and
 * the same class run, as the stage-2 survey's verified pill.
 *
 * Whole class strings, because Tailwind's extractor is a regex over source
 * text and a tint assembled at runtime never compiles.
 */
const BADGE_BASE =
  'shrink-0 inline-flex items-center rounded-full px-2 py-0.5 text-[0.65rem] font-medium';
const BADGE_TONE = {
  emerald: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  amber: 'bg-amber-500/10 text-amber-800 dark:text-amber-400',
};

function TierCard({ tier }: { tier: TierCardView }) {
  return (
    <div
      className={`rounded-lg border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-3 py-2 mb-3${TIER_TONE[tier.tone]}`}
    >
      <div className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{tier.title}</div>
      <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{tier.detail}</div>
    </div>
  );
}

/**
 * "Don't take our word for it": the provider's own page lists what every
 * authorized OAuth app can reach, so the claim above is checkable in one
 * click. Deliberately a top-level link (`target=_blank` + `noopener`) — the
 * shell is framed, and neither provider allows being framed.
 */
function AuditNote({ provider }: { provider: 'github' | 'x' }) {
  const href = provider === 'github'
    ? 'https://github.com/settings/applications'
    : 'https://x.com/settings/connected_apps';
  const label = provider === 'github'
    ? 'github.com/settings/applications'
    : 'x.com/settings/connected_apps';
  return (
    <p
      {...(provider === 'github' ? { id: 'github-link-audit-note' } : null)}
      className="text-xs text-zinc-500 dark:text-zinc-500 mt-2"
    >
      {'Review or revoke this authorization at '}
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-violet-700 dark:text-violet-400 hover:underline"
      >
        {label}
      </a>
      .
    </p>
  );
}

/**
 * The admin-only configuration panel for a provider whose OAuth setup can fail
 * invisibly on the provider's own page (#1291): the credential pair in use,
 * the exact callback URL the developer app must register, and a live check of
 * the pair against the token endpoint.
 */
function Diagnostics({ view }: { view: DiagnosticsView }) {
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);
  const [verdict, setVerdict] = useState<{ tone: string; text: string } | null>(null);

  return (
    <div
      id={`${view.provider}-link-diagnostics`}
      className="mt-2 rounded-md border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-2.5 py-2 text-xs"
    >
      <div className="font-medium text-zinc-700 dark:text-zinc-300">{view.source}</div>
      <div className="mt-1 flex items-center gap-2 min-w-0">
        <span className="text-zinc-500 dark:text-zinc-400 shrink-0">Callback URI:</span>
        <code className="truncate text-zinc-700 dark:text-zinc-300 bg-zinc-100 dark:bg-zinc-800 rounded px-1 py-0.5">
          {view.callbackUrl}
        </code>
        <button
          type="button"
          className="shrink-0 rounded border border-zinc-300 dark:border-zinc-600 px-1.5 py-0.5 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(view.callbackUrl || '');
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch { /* clipboard unavailable — the address is still visible */ }
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="mt-1 text-zinc-500 dark:text-zinc-400">{view.warning}</p>
      <div className="mt-2 flex items-start gap-2">
        <button
          type="button"
          id={`${view.provider}-link-check`}
          disabled={checking}
          className="shrink-0 rounded-md border border-violet-400 dark:border-violet-700 px-2 py-1 font-medium text-violet-700 dark:text-violet-300 hover:bg-violet-50 dark:hover:bg-violet-950 disabled:opacity-50 transition-colors"
          onClick={async () => {
            setChecking(true);
            setVerdict({ tone: 'text-zinc-500 dark:text-zinc-400', text: 'Checking…' });
            try {
              let answer;
              if (view.demo) {
                answer = { clientAuth: 'ok' };
              } else {
                const response = await fetch('/api/me/social-identities/x/check', {
                  method: 'POST',
                  credentials: 'same-origin',
                  cache: 'no-store',
                });
                if (!response.ok) throw new Error(`Check failed (${response.status})`);
                answer = await response.json();
              }
              if (answer.clientAuth === 'ok') {
                setVerdict({
                  tone: 'text-emerald-700 dark:text-emerald-400',
                  text: `${view.name} accepted the platform’s client credentials. `
                    + `If connecting still fails on ${view.name}’s own page, the callback address above `
                    + `is not registered on the ${view.name} app.`,
                });
              } else if (answer.clientAuth === 'rejected') {
                setVerdict({
                  tone: 'text-red-700 dark:text-red-400',
                  text: `${view.name} rejected the platform’s client ID or secret. `
                    + 'the configured credential pair is wrong.',
                });
              } else {
                setVerdict({
                  tone: 'text-amber-800 dark:text-amber-400',
                  text: `Couldn’t reach ${view.name} to verify the credentials. Try again shortly.`,
                });
              }
            } catch {
              setVerdict({
                tone: 'text-red-700 dark:text-red-400',
                text: 'The configuration check failed to run. Try again shortly.',
              });
            } finally {
              setChecking(false);
            }
          }}
        >
          Run configuration check
        </button>
        <span className={`${verdict ? verdict.tone : 'text-zinc-500 dark:text-zinc-400'} pt-1`}>
          {verdict ? verdict.text : null}
        </span>
      </div>
    </div>
  );
}

function ProviderRow({ row }: { row: ProviderRowView }) {
  const opening = useRef(false);
  const [launchStatus, setLaunchStatus] = useState('');
  const [launchFailed, setLaunchFailed] = useState(false);
  return (
    <div className="rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <div className="text-sm font-semibold text-zinc-800 dark:text-zinc-200 truncate">
              {row.heading}
            </div>
            {row.badge ? (
              <span
                id={`${row.provider}-link-badge`}
                className={`${BADGE_BASE} ${BADGE_TONE[row.badge.tone]}`}
              >
                {row.badge.text}
              </span>
            ) : null}
          </div>
          <div className={`text-xs mt-1 ${STATE_TONE[row.state.tone]}`}>{row.state.text}</div>
          {row.linkedAt ? (
            <div className="text-xs text-zinc-500 dark:text-zinc-500 mt-1">{row.linkedAt}</div>
          ) : null}
          {row.noToken ? (
            <div
              {...(row.provider === 'github' ? { id: 'github-link-no-token' } : null)}
              className="text-xs text-zinc-500 dark:text-zinc-400 mt-1"
            >
              {row.noToken}
            </div>
          ) : null}
        </div>
        <div className="shrink-0 flex flex-wrap justify-end gap-2">
          {row.connect ? (
            row.connect.href ? (
              <a href={row.connect.href} className={`${CONNECT_SURFACE} hover:bg-violet-500 transition-colors`}
                onClick={async (e) => {
                  const bridge = (window as any).usernode;
                  if (!bridge?.isNative) return;
                  e.preventDefault();
                  if (opening.current) return;
                  opening.current = true;
                  setLaunchFailed(false);
                  setLaunchStatus('Opening your browser…');
                  try {
                    await openNativeSocialConnect({
                      bridge, provider: row.provider,
                      accountId: (window as any).App?.user?.id,
                      origin: window.location.origin,
                    });
                    setLaunchStatus('Finish connecting in your browser, then return to the app. Sign in with the same Homeroom account if asked.');
                  } catch (err) {
                    setLaunchFailed(true);
                    setLaunchStatus((err as Error).message);
                  } finally {
                    opening.current = false;
                  }
                }}
              >
                {row.connect.label}
              </a>
            ) : (
              // The ?demo= variant: the flow would leave the fixture, so the
              // control is present and inert rather than absent.
              <button type="button" disabled className={`${CONNECT_SURFACE} opacity-50`}>
                {row.connect.label}
              </button>
            )
          ) : null}
          {row.unlink ? (
            <button
              type="button"
              disabled={row.unlink.disabled}
              className="rounded-md border border-red-400 dark:border-red-700 px-2 py-1 text-xs font-medium text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950 disabled:opacity-50 transition-colors"
              onClick={(e) => {
                if (row.unlink?.disabled) return;
                controller()?._unlinkGithub?.(e.currentTarget, row.provider);
              }}
            >
              Disconnect
            </button>
          ) : null}
        </div>
      </div>
      {launchStatus ? (
        <p role="status" className={`text-xs mt-2 ${launchFailed ? 'text-red-700 dark:text-red-400' : 'text-zinc-600 dark:text-zinc-400'}`}>
          {launchStatus}
        </p>
      ) : null}
      <AuditNote provider={row.provider} />
      {/*
          A provider that rejects our callback address errors on its own page
          and never redirects back, so the only trace of that failure is the
          stranded attempt the server spotted (#1291).
      */}
      {row.strandedNote ? (
        <p
          id={`${row.provider}-link-pending-note`}
          className="text-xs text-amber-800 dark:text-amber-400 mt-2"
        >
          {row.strandedNote}
        </p>
      ) : null}
      {row.diagnostics ? <Diagnostics view={row.diagnostics} /> : null}
    </div>
  );
}

export function SocialIdentityView({ phase, message, tier, providers }: SocialIdentityState) {
  if (phase === 'idle') return null;
  // Bare text nodes, as the two `body.textContent = …` writes produced.
  if (phase === 'loading' || phase === 'error') return <>{message}</>;
  return (
    <>
      {tier ? <TierCard tier={tier} /> : null}
      {providers.map((row) => <ProviderRow key={row.provider} row={row} />)}
    </>
  );
}

export function SocialIdentity() {
  useEffect(() => {
    if (!(window as any).usernode?.isNative) return;
    return watchSocialConnectReturn({
      win: window, doc: document,
      refresh: () => {
        if (document.querySelector('#settings-screen:not(.hidden)')) {
          return controller()?._loadGithubLink?.();
        }
      },
    });
  }, []);
  return <SocialIdentityView {...useStoreState<SocialIdentityState>(socialIdentityStore)} />;
}
