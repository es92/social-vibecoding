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
import { t } from '../../lib/i18n/runtime';

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

/**
 * The account rules, stated where a new account is made (QA 2026-09-24 Q11,
 * Q12). They are the server's, not new ones: `validateUsername` in
 * src/services/usernames.js and `validatePassword` in
 * src/services/password-policy.js, which now also gate POST
 * /api/auth/register and the email-code sign-up's username. The first-run
 * "Choose your username" step says the same thing in its own sentence.
 */
// The words are catalog entries now, one for each place they are said:
// auth:register.usernameRule and .passwordRule, auth:login.signup.usernameRule,
// auth:signInSheet.usernamePlaceholder and .providerUsernamePlaceholder.

/**
 * Said next to every field where a new account types its handle (#3575):
 * the register form, the email sign-up's set-password step, and the
 * first-run "Choose your username" gate. The requester's own sentence, in
 * the platform's sentence case. Its own line under the field rather than a
 * clause of the rule above, because the rule's line is swapped whole for
 * the server's refusal and this has to stay put while the person fixes the
 * name. username-first-run.js is a classic module with no imports, so it
 * spells the same words; tests/username-first-choice.test.js holds the two
 * copies together.
 */
// Catalog entries: auth:register.usernamePublic and auth:login.signup.usernamePublic.

/**
 * The attributes every username field carries, so a phone does not
 * capitalise, autocorrect or underline a handle (QA 2026-09-24 Q11).
 * Sign-in matches handles case-insensitively now, but a corrected or
 * capitalised name is still a different name in the register form.
 */
export const HANDLE_FIELD = { autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false } as const;

/**
 * A 6-digit code's field, said in every way a browser reads (Evan, 10 Oct
 * 2026: on iPhone the sheet's code field read as a password). A plain text
 * field, numeric keys, the one-time-code autofill (Messages and Mail offer
 * the code over the keyboard) and a name that says so, with nothing for
 * autocorrect or a password manager to take it for.
 */
export const ONE_TIME_CODE_FIELD = {
  type: 'text',
  name: 'one-time-code',
  inputMode: 'numeric',
  pattern: '[0-9]*',
  autoComplete: 'one-time-code',
  autoCapitalize: 'none',
  autoCorrect: 'off',
  spellCheck: false,
} as const;

/**
 * What blockedOffline says. Exported so a form can tell this error from any
 * other and clear it when the connection returns, in whatever language.
 */
export function offlineSignInText(): string {
  return t('auth:offline.signIn');
}

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
    toast?(message: string, opts?: { error?: boolean }): void;
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
    // A sign-in has begun here, so a stale build is no longer swapped in
    // under the signed-out screens (see noteSignInBegun below).
    noteSignInBegun?(): void;
    // Onto the live build before the signed-in shell starts, when this
    // page is behind it. Resolves false when it stays; never once it
    // reloads (public/js/app.js).
    _moveToLiveShell?(moment: 'signed-in' | 'signed-out'): Promise<boolean>;
  };
  Settings?: { logout?(): void };
  NativeChrome?: {
    prepareForLogin?(): Promise<unknown>;
    lastSessionFailure?(): NativeSessionFailureRecord | null;
  };
  AppView?: {
    _mintToken?(slug: string): Promise<string | null>;
    mountViewerCover?(
      viewer: Element,
      frame: Element | null,
      app: PublicApp,
      opts: { timers: number[]; isCurrent: () => boolean },
    ): void;
    forgetSafeAreaFrame?(id: string): void;
    scheduleSafeAreaBroadcast?(): void;
    // #3257: the theme the shell painted, for a frame URL's `un-theme`.
    resolvedTheme?(): 'light' | 'dark';
  };
  AuthScreens?: Record<string, unknown>;
  // The join step (./communities-first-run.js), asked whether an account
  // that has just signed in goes straight on to its first session.
  CommunitiesFirstRun?: { firstSessionNow?(user: unknown): boolean };
  // The native bridge (usernode-native). Absent in a regular browser, which is
  // the NORMAL state for the wallet fast path — see LoginScreen's walletDetect.
  usernode?: {
    isNative?: boolean;
    getBridgeDiagnostics?(): unknown;
    getBridgeInfo?(): Promise<{ capabilities?: unknown } | null>;
    // The app's own Apple or Google sheet (NATIVE-BRIDGE.md, Native sign-in).
    signInWithProvider?(options: { provider: string; nonce: string }): Promise<{ idToken?: unknown } | null>;
  };
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
  if (!offline) {
    // Every exchange on these screens runs this guard before it sends, so
    // this is where the shell hears that a sign-in has begun.
    noteSignInBegun();
    return false;
  }
  if (setError) setError(offlineSignInText());
  try {
    legacy().Offline?.nudge();
  } catch {
    /* ignore */
  }
  return true;
}

/**
 * A sign-in has begun on this page: a credential exchange is about to go out,
 * or a provider's trip came back to finish one. From here the shell stops
 * offering to swap a stale build in under the signed-out screens
 * (App.noteSignInBegun in public/js/app.js): a request in flight is never cut
 * off, and the sign-in moves to the live build once it has succeeded
 * (AuthScreens.finishLogin), before the signed-in shell starts.
 */
export function noteSignInBegun(): void {
  try {
    legacy().App?.noteSignInBegun?.();
  } catch {
    /* no shell to tell: nothing on this page would swap the build */
  }
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

const NATIVE_DIAGNOSTIC_RE = /^[a-z][a-z0-9_-]{0,95}$/;
const BRIDGE_STATES = new Set([
  'ready', 'blocked-frame', 'unsupported', 'inconclusive', 'unattached', 'unknown',
]);

/** A bounded snapshot of public bridge diagnostics, captured at failure time. */
export interface NativeLoginFailureDetails {
  stage: 'prepare-login';
  code: string | null;
  kind: string | null;
  nativeMessage: string | null;
  bridgeState: string | null;
  pageOrigin: string | null;
  appVersion: string | null;
  buildNumber: string | null;
  bridgeVersion: number | null;
}

function diagnosticValue(value: unknown): string | null {
  return typeof value === 'string' && NATIVE_DIAGNOSTIC_RE.test(value) ? value : null;
}

function errorField(error: unknown, key: string): unknown {
  return error && typeof error === 'object'
    ? (error as Record<string, unknown>)[key]
    : null;
}

function safeNativeMessage(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const message = value.trim();
  // Native messages should contain no secrets; discard unexpected text rather
  // than placing a URL, credential or unbounded string in a copyable report.
  return message.length > 0 && message.length <= 240 &&
    !/[\u0000-\u001f\u007f@]/.test(message) &&
    !/https?:\/\/|\b(?:password|token|cookie|secret|authorization)\b/i.test(message)
    ? message : null;
}

function safeBuildLabel(value: unknown): string | null {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,39}$/.test(value)
    ? value : null;
}

function bridgeDiagnostics(w: LegacyWindow): Record<string, unknown> | null {
  try {
    const value = w.usernode?.getBridgeDiagnostics?.();
    return value && typeof value === 'object' ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function nativePreparationDetails(
  w: LegacyWindow,
  chrome: LegacyWindow['NativeChrome'],
  error: unknown,
): { diagnostic: string | null; details: NativeLoginFailureDetails } {
  let failure: NativeSessionFailureRecord | null = null;
  try {
    const recorded = chrome?.lastSessionFailure?.();
    if (recorded?.stage === 'prepare-login') failure = recorded;
  } catch {
    /* use the rejection itself */
  }
  const snapshot = bridgeDiagnostics(w);
  const privileged = snapshot && errorField(snapshot, 'privileged');
  const code = diagnosticValue(failure?.code) ||
    diagnosticValue(errorField(error, 'usernodeCode')) ||
    diagnosticValue(errorField(privileged, 'code'));
  const kind = diagnosticValue(failure?.kind) ||
    diagnosticValue(errorField(error, 'usernodeKind')) ||
    diagnosticValue(errorField(privileged, 'kind'));
  const state = errorField(privileged, 'state');
  const origin = snapshot?.origin;
  const version = snapshot?.bridgeVersion;
  return {
    diagnostic: code || kind,
    details: {
      stage: 'prepare-login',
      code,
      kind,
      nativeMessage: safeNativeMessage(failure?.message ?? errorField(error, 'message')) ||
        safeNativeMessage(errorField(privileged, 'message')),
      bridgeState: typeof state === 'string' && BRIDGE_STATES.has(state) ? state : null,
      pageOrigin: typeof origin === 'string' && origin.length <= 200 &&
        /^https?:\/\/[a-zA-Z0-9.-]+(?::\d{1,5})?$/.test(origin) ? origin : null,
      appVersion: safeBuildLabel(snapshot?.appVersion),
      buildNumber: safeBuildLabel(snapshot?.buildNumber),
      bridgeVersion: typeof version === 'number' && Number.isInteger(version) &&
        version >= 0 && version <= 9999 ? version : null,
    },
  };
}

export class NativeLoginPreparationError extends Error {
  constructor(
    readonly diagnostic: string | null,
    message = t('auth:native.sessionNotPrepared'),
    readonly details: NativeLoginFailureDetails | null = null,
  ) {
    super(message);
    this.name = 'NativeLoginPreparationError';
  }
}

export function sessionMintFailureMessage(error: unknown): string {
  return error instanceof NativeLoginPreparationError ? error.message : t('auth:session.networkError');
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
      t('auth:native.updateRequired'),
    );
  }
  try {
    await chrome.prepareForLogin();
  } catch (error) {
    const { diagnostic, details } = nativePreparationDetails(w, chrome, error);
    console.warn('[auth] native login preparation failed', {
      stage: 'prepare-login',
      diagnostic: diagnostic || 'unclassified',
    });
    throw new NativeLoginPreparationError(diagnostic, undefined, details);
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
  noteSignInBegun();
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
export interface LoginCompletionFailure {
  stage: 'session-check' | 'session-response' | 'open-session';
  status: number | null;
  code: 'session-rejected' | 'server-response' | 'network-error' | 'timeout' | 'invalid-response' | 'client-error';
}

/**
 * `beforeShell` runs once the session is confirmed and the page stays on its
 * build, just before the signed-in shell starts: the sign-in sheet's
 * hand-off to the make screen (./sign-in-sheet.tsx), held until then.
 */
export async function finishLogin(beforeShell?: () => Promise<void>): Promise<LoginCompletionFailure | null> {
  const fn = legacy().AuthScreens?.finishLogin as undefined |
    ((opts?: { beforeShell?: () => Promise<void> }) => Promise<LoginCompletionFailure | null>);
  if (!fn) return { stage: 'open-session', status: null, code: 'client-error' };
  return beforeShell ? fn({ beforeShell }) : fn();
}

/** What a password sign-in came to: in, or what to say and (in the app) the bridge's report. */
export type PasswordSignIn =
  | { ok: true }
  | { ok: false; error: string; details: NativeLoginFailureDetails | null };

/**
 * The password exchange, `POST /api/auth/login` with a username or an email
 * and the password: the sign-in screen's form (./login.tsx) and the sign-in
 * sheet's password step (./sign-in-sheet.tsx) both send it through here, so
 * they cannot disagree about the route, the session-mint boundary or what a
 * refusal says. The caller checks `blockedOffline` first and calls
 * finishLogin after, as it does for every other exchange.
 */
export async function passwordSignIn(username: string, password: string): Promise<PasswordSignIn> {
  try {
    const res = await fetchSessionMint('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error || t('auth:signIn.failed'), details: null };
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: sessionMintFailureMessage(error),
      details: error instanceof NativeLoginPreparationError ? error.details : null,
    };
  }
}

/**
 * What a waitlist "you're in" mail's link asked for. The mail links to
 * `/?signup=1&t=<token>[&key=<one-time link>]` for a new account and `/?login=1` for one that
 * exists (src/services/mail/index.js); AuthScreens.enter() reads either off
 * the query, keeps it here and puts the address back to `/`, so the story
 * (./landing.tsx) opens with it: a new account's Get started takes it to
 * the sheet, and an existing account's Sign in sheet is open over it.
 */
export interface ReleaseLink {
  route: 'signup' | 'login';
  /** The waitlist row's more_token, which names the address to sign up with. */
  token: string | null;
  /**
   * #4594: the mail's one-time sign-in link (src/services/release-links.js),
   * spent by the sheet's POST to /api/auth/release-link. Null when the mail
   * carried none; an expired or used one falls back to `token`'s code.
   */
  signIn?: string | null;
}

const RELEASE_TOKEN_RE = /^[A-Za-z0-9_-]{8,128}$/;
const RELEASE_SIGN_IN_RE = /^[A-Za-z0-9_-]{43}$/;

/** The release link, once: whoever shows it takes it. */
export function takeReleaseLink(): ReleaseLink | null {
  const host = legacy().AuthScreens;
  const link = host?._releaseLink as Partial<ReleaseLink> | null | undefined;
  if (!host || !link) return null;
  host._releaseLink = null;
  if (link.route !== 'signup' && link.route !== 'login') return null;
  const token = typeof link.token === 'string' && RELEASE_TOKEN_RE.test(link.token) ? link.token : null;
  const signIn = link.route === 'signup' && typeof link.signIn === 'string' && RELEASE_SIGN_IN_RE.test(link.signIn)
    ? link.signIn : null;
  return { route: link.route, token, signIn };
}

/** Hand the link on, for the sign-in screen to take when the story is switched off. */
export function keepReleaseLink(link: ReleaseLink): void {
  const host = legacy().AuthScreens;
  if (host) host._releaseLink = link;
}

/**
 * Does signing in with the session that now exists lead straight to its
 * first session, "What do you want to make?" (../first-session)? Asked of
 * /api/auth/me the way AuthScreens.finishLogin will ask it, and answered by
 * the join step that opens it (./communities-first-run.js), so the two
 * cannot disagree. False on anything unexpected: the sign-in then finishes
 * as it always has.
 */
export async function firstSessionNext(): Promise<boolean> {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) return false;
    const data = await res.json();
    return legacy().CommunitiesFirstRun?.firstSessionNow?.(data?.user) === true;
  } catch {
    return false;
  }
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
