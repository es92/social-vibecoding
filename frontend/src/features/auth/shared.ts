/**
 * Shared plumbing for the anonymous shell's six screens (#1080, step 2
 * chunk C).
 *
 * These screens were `public/js/auth-screens.js`, a 1,965-line module that
 * owned both the routing between them and every screen's behaviour. The
 * conversion moves them one at a time, and while it runs the two halves have
 * to interoperate: the legacy module keeps `window.AuthScreens` (the router
 * `App.restoreFromHash` calls into) and each converted screen PATCHES its
 * per-screen entry points onto that object at hydration. `show()` looks its
 * hooks up on `AuthScreens` by name at call time, so a patched method is
 * indistinguishable from the original — and hydration runs before
 * DOMContentLoaded (see main.tsx), i.e. before the router's first call.
 *
 * The last chunk retires the module and this file grows the router itself.
 */

import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';

/** The route names `AuthScreens.show()` accepts, and their screen roots. */
export const AUTH_SCREEN_IDS: Record<string, string> = {
  landing: 'auth-landing-screen',
  login: 'auth-login-screen',
  signup: 'auth-login-screen', // sub-view of the login screen
  register: 'auth-register-screen',
  waiting: 'auth-waiting-screen',
  waitlist: 'auth-waitlist-screen',
  more: 'auth-more-screen',
  'reset-password': 'auth-login-screen',
};

/** One public app as `/api/public/apps` returns it. */
export interface PublicApp {
  slug?: string;
  name?: string;
  url?: string;
  icon_url?: string | null;
  icon_emoji?: string | null;
  requires_login?: boolean;
}

/** Full zoom opts, forwarded to the kit verbatim by {@link zoomFx}. */
export interface ZoomOpts {
  type: string;
  el?: Element | null;
  fromEl?: () => Element | null;
  outEl?: Element | null;
  fallback?: string;
  after?: () => void;
}

interface LegacyWindow {
  PlatformUI?: {
    transition(fn: () => void, opts: { type?: string } & Record<string, unknown>): void;
    pullToRefresh(
      el: Element | null,
      onRefresh: () => void,
      opts?: Record<string, unknown>,
    ): { detach(): void; refresh?(): void };
  };
  Offline?: { isOffline(): boolean; nudge(): void };
  App?: {
    user?: { username?: string; hasPlatformAccess?: boolean } | null;
    _setScreenVisible?(id: string, visible: boolean): void;
    _refreshOrReload?(fn: () => unknown): void;
    enterAuthed?(user: unknown): void;
    enterAnonymous?(): Promise<void> | void;
    clearSessionSnapshot?(): void;
    // Everything clearSessionSnapshot drops, plus the shell chrome snapshot
    // and the service worker's cached API responses. Called by the
    // stale-session recovery in fetchSessionMint.
    _dropCachedSession?(): void;
    restoreFromHash?(): void;
  };
  Settings?: { logout?(): void };
  NativeChrome?: {
    prepareForLogin?(): Promise<unknown>;
    lastSessionFailure?(): NativeSessionFailureRecord | null;
  };
  AppView?: {
    mountViewerCover?(
      viewer: Element,
      frame: Element | null,
      app: PublicApp,
      opts: { timers: number[]; isCurrent: () => boolean },
    ): void;
    forgetSafeAreaFrame?(id: string): void;
    scheduleSafeAreaBroadcast?(): void;
  };
  AuthScreens?: Record<string, unknown>;
  // The native bridge (usernode-native). Absent in a regular browser, which is
  // the NORMAL state for the wallet fast path — see LoginScreen's walletDetect.
  usernode?: { isNative?: boolean };
  getNodeAddress?(): Promise<string | null>;
  signMessage?(message: string): Promise<{ publicKey: string; signature: string }>;
}

interface NativeSessionFailureRecord {
  stage?: string | null;
  message?: string | null;
  code?: string | null;
  kind?: string | null;
}

/** `window`, with the legacy globals these screens talk to declared. */
export function legacy(): LegacyWindow {
  return window as unknown as LegacyWindow;
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

/**
 * Screen transitions come from the platform's native kit via the PlatformUI
 * seam; when the kit failed to load the mutation just runs without animation.
 */
export function fx(fn: () => void, type?: string): void {
  const ui = legacy().PlatformUI;
  if (ui) ui.transition(fn, { type });
  else fn();
}

/**
 * Same seam, but forwarding the full zoom opts (el / fromEl / outEl /
 * fallback / after). Zoom callers split their mutation into fn (reveal the
 * incoming element) + after (conceal the outgoing one), so the no-kit path has
 * to run BOTH halves.
 *
 * Under a `?shot=` deep link the kit is skipped and the cut is instant. Shots
 * assert settled END-states (`?shot=anon-back` needs two full open/close
 * cycles stamped inside capture.js's shared ASSERT_MAX_MS window), and the
 * kit's zoom-out alone runs ~2s — cinematics would spend the whole assertion
 * budget. Real navigation never carries a shot param, so users always get the
 * kit path.
 */
function isShotUrl(): boolean {
  try {
    return new URLSearchParams(location.search).has('shot');
  } catch {
    return false;
  }
}

export function zoomFx(fn: () => void, opts: ZoomOpts): void {
  const ui = legacy().PlatformUI;
  if (ui && !isShotUrl()) {
    ui.transition(fn, opts as unknown as { type?: string } & Record<string, unknown>);
  } else {
    fn();
    if (typeof opts.after === 'function') opts.after();
  }
}

/**
 * Every credential exchange on these screens is a server round trip, so
 * offline they can only fail — and the user got a bare "Network error" that
 * read like a wrong password (#1021). Guard first, and say what's actually
 * wrong.
 *
 * The check is Offline's probe result, not navigator.onLine: the flag
 * false-positives behind captive portals, which is exactly where a submit would
 * hang. When it says nothing is wrong we let the request go — an unguarded real
 * failure still falls back to its own catch.
 */
export function blockedOffline(setError?: (msg: string) => void): boolean {
  let offline = false;
  try {
    const off = legacy().Offline;
    offline = !!(off && off.isOffline());
  } catch {
    offline = false;
  }
  if (!offline) return false;
  if (setError) setError("You're offline. Signing in needs a connection.");
  try {
    legacy().Offline?.nudge();
  } catch {
    /* ignore */
  }
  return true;
}

/** Does a (possibly waiting-room) session exist right now? */
export function hasSession(): boolean {
  return !!legacy().App?.user;
}

/** Are we inside the Homeroom native app (bridge present)? */
export function isNative(): boolean {
  const w = legacy();
  return !!(w.usernode && w.usernode.isNative);
}

const NATIVE_LOGIN_PREPARATION_MESSAGE =
  'Secure app session could not be prepared. Force-quit and reopen Homeroom, then try again.';
const NATIVE_DIAGNOSTIC_RE = /^[a-z][a-z0-9_-]{0,95}$/;

function diagnosticValue(value: unknown): string | null {
  return typeof value === 'string' && NATIVE_DIAGNOSTIC_RE.test(value) ? value : null;
}

function errorField(error: unknown, key: string): unknown {
  return error && typeof error === 'object'
    ? (error as Record<string, unknown>)[key]
    : null;
}

function nativePreparationDetails(
  chrome: LegacyWindow['NativeChrome'],
  error: unknown,
): { diagnostic: string | null; reason: string | null } {
  let failure: NativeSessionFailureRecord | null = null;
  try {
    const recorded = chrome?.lastSessionFailure?.();
    if (recorded?.stage === 'prepare-login') failure = recorded;
  } catch {
    /* use the rejection itself */
  }
  const diagnostic =
    diagnosticValue(failure?.code) ||
    diagnosticValue(failure?.kind) ||
    diagnosticValue(errorField(error, 'usernodeCode')) ||
    diagnosticValue(errorField(error, 'usernodeKind'));
  const rawReason = failure?.message ?? errorField(error, 'message');
  const reason = typeof rawReason === 'string' ? rawReason.trim() : '';
  return {
    diagnostic,
    reason: !diagnostic && reason.length <= 240 && !/[\u0000-\u001f\u007f]/.test(reason)
      ? reason || null
      : null,
  };
}

export class NativeLoginPreparationError extends Error {
  constructor(
    readonly diagnostic: string | null,
    message = NATIVE_LOGIN_PREPARATION_MESSAGE,
  ) {
    super(diagnostic ? `${message} Diagnostic: ${diagnostic}` : message);
    this.name = 'NativeLoginPreparationError';
  }
}

export function sessionMintFailureMessage(error: unknown): string {
  return error instanceof NativeLoginPreparationError ? error.message : 'Network error';
}

/**
 * Runs the native side of the session-mint boundary: an anonymous native
 * shell closes, drains and revokes any privately retained native session
 * before ANY ordinary mint request goes out — including the retry the
 * stale-session recovery below makes, which is a second such request.
 */
async function prepareNativeMint(w: LegacyWindow): Promise<void> {
  if (w.usernode?.isNative !== true) return;
  const chrome = w.NativeChrome;
  if (!chrome || typeof chrome.prepareForLogin !== 'function') {
    throw new NativeLoginPreparationError(
      null,
      'This Homeroom app version must be updated for secure sign-in',
    );
  }
  try {
    await chrome.prepareForLogin();
  } catch (error) {
    const { diagnostic, reason } = nativePreparationDetails(chrome, error);
    console.warn('[auth] native login preparation failed', {
      stage: 'prepare-login',
      diagnostic: diagnostic || 'unclassified',
    });
    throw new NativeLoginPreparationError(
      diagnostic,
      reason ? `${NATIVE_LOGIN_PREPARATION_MESSAGE} Reason: ${reason}` : undefined,
    );
  }
}

/** The API's code for "a live session already exists on this cookie". */
const LOGOUT_REQUIRED_CODE = 'logout_required';

/**
 * A response whose JSON body has already been read, handed back so the
 * caller's own `await res.json()` still works. Only built on the 409 path,
 * where the body has to be inspected before the response can be returned.
 */
function replayed(res: Response, body: unknown): Response {
  return {
    ok: false,
    status: res.status,
    async json() { return body; },
  } as unknown as Response;
}

/**
 * Ends the session the server still holds for this browser, so the
 * credentials that were just typed can be exchanged for a new one. Uses the
 * ordinary logout endpoint rather than a bare session delete: that is what
 * atomically revokes the native credentials bound to the same incarnation.
 * Returns false when the server would not let go, in which case the original
 * 409 is what the caller reports.
 */
async function clearStaleSession(w: LegacyWindow): Promise<boolean> {
  try {
    const res = await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
    });
    if (!res.ok) return false;
  } catch {
    return false;
  }
  // The same residue an explicit sign-out drops: the display-only session
  // snapshot, the remembered shell chrome, and the service worker's cached
  // API responses (which are per-URL, not per-user).
  try { w.App?._dropCachedSession?.(); } catch { /* nothing stored */ }
  return true;
}

/**
 * Sends an ordinary session-mint request only after a native anonymous shell
 * has closed, drained, and revoked any privately retained native session.
 * Desktop browsers have no native authority.
 *
 * ── The stale-session dead end (#1608) ────────────────────────────────
 *
 * The API refuses to mint a second session onto a cookie that still names a
 * live one (`409 logout_required`, src/routes/auth.js). That boundary is
 * right — it is what keeps the native A -> B hand-off ordered — but it was
 * reported from a shell that had NO sign-out to offer: the browser was
 * looking at the sign-in screen, so there was no Settings screen to reach,
 * and the message asked for the one action the user could not perform.
 *
 * So when the shell is anonymous, the 409 is not a refusal to relay, it is a
 * repair: sign the stale session out and send the credentials again. A live
 * `App.user` keeps the original message, because that viewer really can
 * reach Settings and the explicit flow is the one the native protocol wants.
 */
export async function fetchSessionMint(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const w = legacy();
  await prepareNativeMint(w);
  const res = await fetch(input, init);
  if (res.status !== 409) return res;

  let body: unknown = null;
  try { body = await res.json(); } catch { body = null; }
  const code = (body as { code?: unknown } | null)?.code;
  if (code !== LOGOUT_REQUIRED_CODE || hasSession()) return replayed(res, body);

  if (!(await clearStaleSession(w))) return replayed(res, body);
  // A retry is an ordinary mint request too, so it re-runs the native
  // preparation. `init.body` is a string at every call site, which is what
  // makes replaying it safe.
  await prepareNativeMint(w);
  return fetch(input, init);
}

/**
 * Reload-free login completion, called after ANY successful credential
 * exchange. Still the legacy router's method — it re-fetches /api/auth/me and
 * hands over to `App.enterAuthed` — so it is reached by name, like every other
 * hook on that object, until the router itself crosses over.
 */
export function finishLogin(): void {
  const fn = legacy().AuthScreens?.finishLogin as undefined | (() => unknown);
  if (fn) void fn();
}

/**
 * Patch per-screen entry points onto `window.AuthScreens`.
 *
 * Registered in a LAYOUT effect, not a passive one: `flushSync` in main.tsx
 * guarantees layout effects have run when hydration returns, which is still
 * before DOMContentLoaded and therefore before the router's first `show()`.
 * The previous values are restored on unmount so a hot reload can't leave a
 * dead closure installed.
 */
export function useAuthScreensPatch(patch: Record<string, unknown>): void {
  useIsomorphicLayoutEffect(() => {
    const host = legacy().AuthScreens;
    if (!host) return;
    const previous: Record<string, unknown> = {};
    for (const key of Object.keys(patch)) {
      previous[key] = host[key];
      host[key] = patch[key];
    }
    return () => {
      for (const key of Object.keys(previous)) host[key] = previous[key];
    };
    // The patch object is rebuilt every render; its identity is not the
    // dependency, the mount is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** `hidden` first, exactly where the hand-written markup had it. */
export function hiddenFirst(hidden: boolean, rest: string): string {
  return hidden ? `hidden ${rest}` : rest;
}

/** `hidden` appended, as `classList.add('hidden')` would have left it. */
export function hiddenLast(hidden: boolean, rest: string): string {
  return hidden ? `${rest} hidden` : rest;
}
