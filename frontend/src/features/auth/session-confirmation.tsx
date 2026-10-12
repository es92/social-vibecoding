import { useCallback, useRef, useState } from 'react';

import { alertVariants } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useMessages } from '../../lib/i18n/react';
import { finishLogin as confirmSession, legacy, type LoginCompletionFailure } from './shared';

export interface SessionConfirmationDetails extends LoginCompletionFailure {
  timestamp: string;
  platformBuild: string | null;
  browser: string;
  operatingSystem: string;
  surface: 'web' | 'native';
  appVersion: string | null;
  appBuild: string | null;
}

/** Parse only known public version strings; never copy a raw user agent. */
export function browserVersions(agent: string): { browser: string; operatingSystem: string } {
  const ios = /(?:CPU (?:iPhone )?OS|iPhone OS) (\d+(?:_\d+){0,2})/.exec(agent);
  const android = /Android (\d+(?:\.\d+){0,2})/.exec(agent);
  const browser = /\b(CriOS|FxiOS|EdgiOS|Edg|Chrome|Firefox)\/(\d+(?:\.\d+){0,3})/.exec(agent);
  const safari = /Version\/(\d+(?:\.\d+){0,3})[^\n]*Safari\//.exec(agent);
  const names: Record<string, string> = {
    CriOS: 'Chrome iOS', FxiOS: 'Firefox iOS', EdgiOS: 'Edge iOS',
    Edg: 'Edge', Chrome: 'Chrome', Firefox: 'Firefox',
  };
  return {
    browser: browser ? `${names[browser[1]]} ${browser[2]}` : safari ? `Safari ${safari[1]}` : 'Unknown',
    operatingSystem: ios ? `iOS ${ios[1].replace(/_/g, '.')}` : android ? `Android ${android[1]}`
      : /Windows NT/.test(agent) ? 'Windows' : /Mac OS X/.test(agent) ? 'macOS' : 'Unknown',
  };
}

function buildLabel(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9]+(?:\.[0-9]+){0,3}$/.test(value) && value.length <= 40
    ? value : null;
}

function snapshot(failure: LoginCompletionFailure): SessionConfirmationDetails {
  let bridge: Record<string, unknown> | null = null;
  try {
    const value = legacy().usernode?.getBridgeDiagnostics?.();
    if (value && typeof value === 'object') bridge = value as Record<string, unknown>;
  } catch { /* optional native build metadata */ }
  const build = document.querySelector('meta[name="platform-build"]')?.getAttribute('content');
  return {
    ...failure,
    timestamp: new Date().toISOString(),
    platformBuild: build && /^(?:[0-9a-f]{7,40}|dev)$/.test(build) ? build : null,
    ...browserVersions(navigator.userAgent),
    surface: legacy().usernode?.isNative ? 'native' : 'web',
    appVersion: buildLabel(bridge?.appVersion),
    appBuild: buildLabel(bridge?.buildNumber),
  };
}

export function sessionConfirmationText(details: SessionConfirmationDetails): string {
  return [
    'Homeroom sign-in session diagnostics',
    `Time: ${details.timestamp}`,
    `Step: ${details.stage}`,
    `Result: ${details.code}`,
    `HTTP status: ${details.status ?? 'No response'}`,
    `Platform build: ${details.platformBuild ?? 'Unknown'}`,
    `Surface: ${details.surface}`,
    `Browser: ${details.browser}`,
    `Operating system: ${details.operatingSystem}`,
    `App version: ${details.appVersion ?? 'Unknown'}`,
    `App build: ${details.appBuild ?? 'Unknown'}`,
  ].join('\n');
}

// Message ids, read when the notice renders.
const MESSAGES: Record<LoginCompletionFailure['code'], string> = {
  'session-rejected': 'auth:session.failure.rejected',
  'server-response': 'auth:session.failure.serverResponse',
  'network-error': 'auth:session.failure.network',
  timeout: 'auth:session.failure.timeout',
  'invalid-response': 'auth:session.failure.invalidResponse',
  'client-error': 'auth:session.failure.client',
};

export function useSessionConfirmation() {
  const [failure, setFailure] = useState<SessionConfirmationDetails | null>(null);
  const [checking, setChecking] = useState(false);
  const pending = useRef<Promise<boolean> | null>(null);
  // Resolves true once the session is open (or the page is on its way to
  // the page that asked for the sign-in), false when the notice is up.
  // `beforeShell` is shared.ts's: the sign-in sheet's hand-off, run just
  // before the signed-in shell starts.
  const finishLogin = useCallback((beforeShell?: () => Promise<void>): Promise<boolean> => {
    if (pending.current) return pending.current;
    setChecking(true);
    const run = async () => {
      try {
        const result = await confirmSession(beforeShell);
        setFailure(result ? snapshot(result) : null);
        return !result;
      } catch {
        setFailure(snapshot({ stage: 'open-session', status: null, code: 'client-error' }));
        return false;
      } finally {
        setChecking(false);
        pending.current = null;
      }
    };
    pending.current = run();
    return pending.current;
  }, []);
  const clear = useCallback(() => { setFailure(null); }, []);
  return { failure, checking, finishLogin, clear };
}

export function SessionConfirmationNotice({ completion }: {
  completion: ReturnType<typeof useSessionConfirmation>;
}) {
  const [copyStatus, setCopyStatus] = useState('');
  const t = useMessages('auth');
  if (!completion.failure) return null;
  const details = sessionConfirmationText(completion.failure);
  return (
    <div className={`${alertVariants({ variant: 'notice', density: 'roomy' })} my-4 space-y-3`}>
      <p role="alert">{t(MESSAGES[completion.failure.code])}</p>
      <Button type="button" variant="neutral" ink="neutral" disabled={completion.checking}
        onClick={() => { setCopyStatus(''); void completion.finishLogin(); }}>
        {completion.checking ? t('auth:session.checking') : t('auth:session.retry')}
      </Button>
      <details>
        <summary className="min-h-11 cursor-pointer text-sm font-medium leading-[44px]">{t('auth:session.details')}</summary>
        <pre className="whitespace-pre-wrap break-words rounded-lg bg-zinc-100 p-3 text-xs text-zinc-800 select-text dark:bg-zinc-800 dark:text-zinc-100">{details}</pre>
        <Button type="button" variant="neutral" ink="neutral" onClick={async () => {
          try { await navigator.clipboard.writeText(details); setCopyStatus(t('auth:session.copied')); }
          catch { setCopyStatus(t('auth:session.copyFailed')); }
        }}>{t('auth:session.copy')}</Button>
        <p role="status" className="text-sm">{copyStatus}</p>
      </details>
    </div>
  );
}
