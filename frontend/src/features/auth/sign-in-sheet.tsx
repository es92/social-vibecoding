/**
 * Sign-in as a sheet: the email code, asked for over the screen that led
 * to it rather than on a screen of its own, so what you are joining stays in
 * view behind it. "Made for you" opens it from its Join button
 * (./invite-card.tsx), titled for the project.
 *
 * It is the same exchange as the sign-in screen's email-code panel
 * (./login.tsx), against the same routes:
 *
 *   email    POST /api/auth/otp/request sends a six-digit code.
 *   code     POST /api/auth/otp/verify. An account that has a password is
 *            signed straight in; a new one (or one with no password yet)
 *            moves on to
 *   account  POST /api/auth/otp/set-password: a password, and the username
 *            when the account has none, which mints the session.
 *
 * Continue with Apple and Continue with Google come first when an admin has
 * set them up (`providers`, from the waitlist options). Either leaves
 * the page for the provider (GET /api/auth/oauth/:provider/start) and comes
 * back to it signed in, or (`resume`) to this sheet: at
 *
 *   username POST /api/auth/oauth/finish, when the provider's sign-in made
 *            an account that has no username yet, which mints the session;
 *   or the first step again, with what went wrong.
 *
 * Inside the Homeroom app the providers' pages refuse its web view, so
 * (`native`) the buttons ask the app for its own sheet instead and never
 * leave the page (signInNatively): the same outcomes, answered in place.
 *
 * An invite's Join asks for a phone number first (`phone`, whenever the
 * server offers phone sign-in): an invite makes a private member, and a
 * private member signs up with a phone (services/community-invites.js
 * joinAsPrivateMember), against routes/phone-auth.js:
 *
 *   phone       Your name and a phone number. POST /api/auth/phone/request
 *               texts a code, after an invisible reCAPTCHA (./recaptcha.ts)
 *               Firebase asks of a web caller.
 *   phone-code  POST /api/auth/phone/verify with the code and the name. A
 *               number already on an account signs it straight in; a new
 *               one is made with that name, and a PROVISIONAL handle picked
 *               from it that only the inviting group sees, and signed in
 *               too: no username step (routes/phone-auth.js). The first
 *               public place asks for a username (username-first-run.js
 *               askForPublic). A public community's invite asks no name
 *               (`askName` false), and so, like a client that sends none or
 *               a name no handle could be picked from, moves on to
 *   username    POST /api/auth/phone/finish, the provider's step with the
 *               phone's own route, which mints the session.
 *
 * "Already on Homeroom? Sign in another way" leads to the other ways, for an
 * account made before; one made by email from here is not a private member
 * and waits in the queue.
 *
 * "Sign in with a password" is a step of its own here too:
 *
 *   password POST /api/auth/login with a username or an email, the sign-in
 *            screen's own exchange (passwordSignIn in ./shared.ts). "Forgot
 *            password?" still goes to that screen's reset (#login/forgot).
 *
 * A waitlist "you're in" link opens the sheet already at work
 * (`releaseToken`): the address its token names filled in and the code
 * sent, as the sign-in screen does for the same link (./login.tsx), with
 * the same once-per-tab record of the send.
 *
 * Every success ends in finishLogin(), so where the person lands is the
 * shell's decision (AuthScreens.finishLogin, then the invite link's path).
 * `followInvite` tells the verify route that this sign-in is the Join the
 * person just pressed on an invite's page: an account that already existed
 * follows the link too (routes/auth.js), rather than being asked again.
 *
 * ── The way out to "What do you want to make?" ─────────────────────────
 *
 * When a sign-in leads to the account's first session, the story hands
 * this sheet `handOff` from its `beforeFinish`. The sheet slides away while
 * the wallpaper the make screen stands on comes up behind it, and only then
 * does the shell sign in, opening that screen in the same tick
 * (../first-session/index.tsx), so nothing of Home shows between the two.
 * Transform and opacity only, with no delay, so a busy main thread cannot
 * hold the movement back on iOS; with reduced motion it is a cut.
 *
 * Rendered in place inside the landing's React-owned tree (no portal, for
 * the reasons ui/dialog.tsx gives), closed by default, and only ever opened
 * once the screen is up (a tap, a provider's way back, a release link),
 * never in the first render, so the prerendered document is unchanged.
 *
 * ── With the keyboard up ───────────────────────────────────────────────
 *
 * iPhone 17 simulator, iOS 26 Safari, 5 Oct 2026, the password step: the
 * Sign in button sat behind the keyboard and the password field half under
 * the keyboard's floating bar (Return still signed in). The sheet sat on the
 * page's foot with the keys over it, and iOS panned the page to the tapped
 * field alone. The panel is a `.platform-kb-sheet` now: while the keyboard
 * is open its foot is on the top of what covers the page and its height is
 * capped to what is visible (lib/keyboard-open.ts, app.css), and it scrolls
 * inside. Taps on its fields focus without the pan, and the focused field is
 * revealed in the panel with the step's button under it when the two fit
 * (lib/keyboard-surface.ts). Every focus here is `preventScroll`, so that
 * reveal is the only movement. Every step is the same: email, code, account,
 * username, password, phone and its code. Return walks a step's fields, as
 * on the make screen (#3904): from any but the last it goes to the next
 * empty one, and only the
 * last field's Return (the keyboard says "go") submits (`returnTarget`). The
 * Homeroom app is losing the keyboard's ‹ › bar (flutter-mobile-app #603),
 * and nothing here leans on that bar: what covers the page is measured from
 * the visual viewport, whatever iOS draws above the keys.
 *
 * ── Opening it in the app, and what it is made of ──────────────────────
 *
 * Homeroom iOS app, 5 Oct 2026, Get started (and Sign in) recorded at 20
 * fps: the sheet put the caret in Email as it started sliding up, and the
 * app's web view raises its keyboard for a field focused from code, so the
 * keys came up WHILE the sheet rose. For a moment the sheet was behind the
 * rising keys, iOS scrolled the story up behind it to reveal the field, and
 * the sheet then jumped up onto the keys: three movements fighting for half a
 * second. On a touch screen the sheet now opens without a caret and the tap
 * on the field raises the keys, after the sheet has arrived; the sheet then
 * rides up with them as one eased, transform-only movement
 * (lib/keyboard-surface.ts `ride`), and back down with them. It moves a
 * caret to the next step's field by itself only while the keys are already
 * up (they stay up across the hop), or on a desktop, where no keyboard
 * rises (`mayFocusByCode`). Behind it nothing moves: the dim takes no pan
 * (`touch-action: none`, as the kit's own backdrop) and the panel does not
 * pass its scroll on to the page (`overscroll-contain`).
 *
 * The panel was a flat system grey (`bg-zinc-100`, a utility of its own, not
 * a token the signed-out page lacked). It is the platform's sheet now: the
 * plane colour (`--dc-sheet-solid`, the GroupedList's PLANE_FILL), the 20px
 * radius, the `--app-sheet-line` hairline, and the 36px handle in `--border`
 * that the workshop's sheets carry. The fields sit on it as white cards with
 * the same hairline, as on the make screen.
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';

import { PLANE_FILL } from '@/components/ui/grouped-list';
import { AppleIcon, GoogleIcon, XIcon } from '@/components/ui/icons';
import { PasswordInput } from '@/components/ui/password-input';

import { KB_OPEN_CLASS } from '../../lib/keyboard-open';
import { useKeyboardSurface } from '../../lib/keyboard-surface';
import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { inviteEmailFromToken, readAutoSend, writeAutoSend } from './login';
import { NativeLoginDetailsLink } from './native-login-details';
import { PhoneInput, readPhone } from './phone-input';
import { phoneRecaptchaToken, RECAPTCHA_LINE } from './recaptcha';
import { SessionConfirmationNotice, useSessionConfirmation } from './session-confirmation';
import {
  blockedOffline,
  fetchSessionMint,
  HANDLE_FIELD,
  legacy,
  type NativeLoginFailureDetails,
  passwordSignIn,
  sessionMintFailureMessage,
  USERNAME_RULE,
} from './shared';
import { RecaptchaLine, TermsNotice } from './waitlist-shared';

type Step = 'choose' | 'email' | 'code' | 'account' | 'username' | 'password' | 'phone' | 'phone-code';

export type SignInProvider = 'apple' | 'google';

/** What the provider's way back left for the sheet (routes/sign-in-providers.js). */
export type SignInResume = 'username' | `error-${string}`;

// What went wrong at the provider, in words. The codes are the server's.
const RESUME_ERRORS: Record<string, string> = {
  cancelled: 'Sign-in was cancelled.',
  expired: 'That sign-in took too long, or started somewhere else. Try again.',
  no_verified_email: 'That account has no verified email address to sign in with. Use your email instead.',
  password_required: 'This account signs in with a password. Use "Sign in with a password" below.',
  admin_password_required: 'This admin account signs in with a password. Use "Sign in with a password" below.',
  linked_elsewhere: 'Your Homeroom account is linked to a different account there. Use your email instead.',
  logout_required: 'You are already signed in. Reload the page.',
};
const RESUME_FALLBACK = 'That did not work. Try again, or use your email.';

export function resumeError(resume: SignInResume | null | undefined): string | null {
  if (!resume || !resume.startsWith('error-')) return null;
  return RESUME_ERRORS[resume.slice('error-'.length)] || RESUME_FALLBACK;
}

/** Where the provider's sign-in starts: carries what the sheet knows across the trip. */
export function providerStartUrl(provider: SignInProvider, { from, followInvite, returnTo }: {
  from: 'invite' | 'story' | 'signin';
  followInvite: boolean;
  returnTo: string;
}): string {
  const params = new URLSearchParams({ from, return: returnTo });
  if (followInvite) params.set('follow', '1');
  return `/api/auth/oauth/${provider}/start?${params.toString()}`;
}

/** What a sign-in from the app's own sheet came to. `error: null` is a sheet the person closed. */
export type NativeSignInOutcome =
  | { next: 'signed-in'; created: boolean }
  | { next: 'username' }
  | { error: string | null };

function nativeError(code: unknown): string {
  return resumeError(`error-${typeof code === 'string' && code ? code : 'failed'}`) || RESUME_FALLBACK;
}

/**
 * Inside the Homeroom app: a state and a nonce from the server, the app's
 * own sheet with that nonce (the bridge's signInWithProvider), and the ID
 * token it returns back to the server (routes/sign-in-providers.js).
 */
export async function signInNatively(provider: SignInProvider, { from, followInvite }: {
  from: 'invite' | 'story' | 'signin';
  followInvite: boolean;
}): Promise<NativeSignInOutcome> {
  const bridge = legacy().usernode;
  if (!bridge || typeof bridge.signInWithProvider !== 'function') return { error: RESUME_FALLBACK };
  const started = await fetch(`/api/auth/oauth/${provider}/native/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ from, follow: followInvite }),
  });
  const start = await started.json().catch(() => ({}));
  if (!started.ok || typeof start.state !== 'string' || typeof start.nonce !== 'string') {
    return { error: nativeError(start.code) };
  }
  let idToken: unknown = null;
  try {
    const answer = await bridge.signInWithProvider({ provider, nonce: start.nonce });
    idToken = answer?.idToken;
  } catch (err) {
    if ((err as { usernodeCode?: unknown } | null)?.usernodeCode === 'cancelled') return { error: null };
    return { error: RESUME_FALLBACK };
  }
  if (typeof idToken !== 'string' || !idToken) return { error: RESUME_FALLBACK };
  const res = await fetchSessionMint(`/api/auth/oauth/${provider}/native`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ state: start.state, idToken }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.next === 'signed-in') return { next: 'signed-in', created: data.created === true };
  if (res.ok && data.next === 'username') return { next: 'username' };
  return { error: nativeError(data.code) };
}

const PROVIDER_LABEL: Record<SignInProvider, string> = { apple: 'Apple', google: 'Google' };
// Apple's button is solid black (white on dark), Google's is white with a
// hairline, as their sign-in guidelines draw them; both the sheet's pill shape.
const PROVIDER_BUTTON: Record<SignInProvider, string> = {
  apple: 'flex h-[50px] w-full items-center justify-center gap-2 rounded-full bg-black text-[17px] font-[650] text-white dark:bg-white dark:text-black disabled:opacity-60',
  google: 'flex h-[50px] w-full items-center justify-center gap-2 rounded-full bg-white text-[17px] font-[650] text-zinc-900 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.15)] dark:bg-zinc-800 dark:text-zinc-100 dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.15)] disabled:opacity-60',
};
const EMAIL_BUTTON = 'flex h-[50px] w-full items-center justify-center rounded-full bg-zinc-200 text-[17px] font-[650] text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100 disabled:opacity-60';

// The server holds a second code back for this long (routes/auth.js); the
// resend counts it down rather than pretending to send.
const RESEND_COOLDOWN_MS = 60 * 1000;

// How long the sheet takes to leave for the make screen (`handOff`): the
// panel's and the cover's own 200ms, and a frame for the last of it to paint.
export const HAND_OFF_MS = 240;

// How long a close takes before the screen that opened the sheet drops it:
// the panel's slide down and the dim's fade (200ms), and a frame. Dropped at
// once, it was gone in a frame while it had slid up (iOS app, 5 Oct 2026).
export const CLOSE_MS = 240;

/**
 * Whether the sheet may put the caret in a step's field by itself. On a
 * touch screen a field focused from code raises the keyboard in the app's
 * web view, and doing that as the sheet opens (or as a step changes with
 * the keys down) brings the keys up under a moving sheet; there the tap on
 * the field does it, unless the keys are up already, when moving the caret
 * keeps them up. Anywhere else (a mouse and a hardware keyboard) the caret
 * is simply put where the typing goes.
 */
export function mayFocusByCode({ touch, keysUp }: { touch: boolean; keysUp: boolean }): boolean {
  return !touch || keysUp;
}

/**
 * Where Return in field `at` of a step's fields goes (5 Oct 2026: the
 * Homeroom app is losing the keyboard's ‹ › bar, flutter-mobile-app #603,
 * so Return is the way from one field to the next). From any field but the
 * last, the next field after it that is still empty, or the last field when
 * none is; null from the last field, whose Return submits the step. Never a
 * submit from an earlier field: the account step used to submit from its
 * username and fail on the empty password, and the password step leaned on
 * the browser's own "fill out this field".
 */
export function returnTarget(values: readonly string[], at: number): number | null {
  if (at < 0 || at >= values.length - 1) return null;
  for (let i = at + 1; i < values.length; i += 1) if (!values[i]) return i;
  return values.length - 1;
}

/** The keydown that walks a step's fields on Return (Shift+Return and an IME's Return are left alone). */
export function returnWalks(fields: readonly RefObject<HTMLInputElement | null>[], at: number) {
  return (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    const live = fields.map((f) => f.current).filter((el): el is HTMLInputElement => !!el);
    const here = live.indexOf(e.currentTarget);
    const target = returnTarget(live.map((el) => el.value), here < 0 ? at : here);
    if (target == null) return; // the last field: the form submits
    e.preventDefault();
    live[target].focus({ preventScroll: true });
  };
}

function touchScreen(): boolean {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

function keyboardUp(): boolean {
  const root = document.documentElement.classList;
  return root.contains(KB_OPEN_CLASS) || root.contains('un-kb');
}

function prefersReducedMotion(): boolean {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** A name's length on the profile (routes/profile.js MAX_DISPLAY_NAME). */
export const PHONE_NAME_MAX = 40;

// The "+…" number as the server takes it, now kept with the shared field.
export { phoneE164 } from './phone-input';

/**
 * What sits under the first step's button (#4037, the owner's ruling of
 * 7 October). Where the sheet makes an account (the story's Make an account,
 * an invite's Join) it is the terms line alone, since continuing is agreeing
 * (tests/terms-first-run.test.js); somebody with an account signs in from
 * the story's own Sign in, or with the same email code. The story's Sign in,
 * and the other ways after an invite's phone step, are for an account
 * somebody has: "Sign in with a password" right under the button, then the
 * terms line.
 */
export function firstStepLine(from: 'invite' | 'story' | 'signin', phone = false): 'terms' | 'password' {
  return from === 'signin' || phone ? 'password' : 'terms';
}

/** The line Google asks for where its reCAPTCHA badge is not shown (./recaptcha.ts). */
export function RecaptchaNotice() {
  return <RecaptchaLine notice={RECAPTCHA_LINE} data={{ 'data-sign-in-sheet-recaptcha': '' }} />;
}

/** Where a waitlist "you're in" link's sheet starts. */
export type ReleaseArrival =
  | { address: string; send: true }
  | { address: string; send: false; cooldownUntil: number };

/**
 * The address a release link's token names, through the sign-in screen's
 * own lookup (inviteEmailFromToken, GET /api/public/waitlist/more/:token),
 * and whether its code still has to go. Once per tab, on the sign-in
 * screen's record (./login.tsx's AUTO_SEND_KEY), so a reload, or the screen
 * and the sheet both opening the link, sends one code: a code that already
 * went to this address starts at the code step with what is left of the
 * wait. Null when the token names nothing; the email step then stays empty.
 */
export async function releaseArrival(token: string, now = Date.now()): Promise<ReleaseArrival | null> {
  const address = await inviteEmailFromToken(token);
  if (!address) return null;
  const prior = readAutoSend();
  if (prior && prior.email === address) {
    const until = prior.sentAt + RESEND_COOLDOWN_MS;
    return { address, send: false, cooldownUntil: until > now ? until : 0 };
  }
  // Written before the request, as the screen does, so a failed send is not
  // retried on a loop.
  writeAutoSend(address);
  return { address, send: true };
}

/**
 * On a step's main button: the press keeps the caret where it is until its
 * click. iPhone Safari, 7 Oct 2026 (#4214): with the keyboard up, a tap on
 * "Text me a code" only closed the keyboard. The press blurred the field,
 * the sheet rode down with the keys before the click was dispatched, and the
 * click landed on nothing. A mousedown whose default is prevented moves no
 * focus, so the sheet stays put under the finger and the one tap submits;
 * the next step's field then takes the caret with the keys still up, or the
 * keys go down with the field when the step has none. Messages' and the
 * composers' Send do the same (lib/keyboard-open.ts).
 */
export const HOLD_FIELD_FOCUS = {
  onMouseDown: (event: { preventDefault(): void }) => { event.preventDefault(); },
} as const;

// White cards with the sheets' hairline, on the sheet's plane colour (the make screen's own field card).
const FIELD_GROUP = 'overflow-hidden rounded-2xl bg-white shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900';
const FIELD = 'px-4 pt-3 pb-2 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-zinc-200 dark:[&:not(:last-child)]:border-zinc-800';
const LABEL = 'block text-[13px] text-zinc-500 dark:text-zinc-400';
const INPUT = 'w-full border-0 bg-transparent px-0 py-1 text-[17px] text-zinc-900 dark:text-zinc-100 placeholder-zinc-500 focus:outline-none';
const QUIET = 'py-1 text-[15px] font-medium text-violet-700 dark:text-violet-400 hover:underline';

export type SignInSheetProps = {
  open: boolean;
  /** "Join Sunday Run Club", "Make your account", "Sign in" */
  title: string;
  /**
   * A line under the title on the first step. Nobody passes one now: the
   * title, the field and the button say it, and the phone sign-up's own
   * copy is trimmed (#4326, #4037).
   */
  intro?: string;
  /** This sign-in is the Join pressed on an invite's page. */
  followInvite?: boolean;
  /** Apple and Google, when an admin has set them up (inside the app, those its build can show). */
  providers?: readonly SignInProvider[];
  /** Inside the Homeroom app: the providers sign in with the app's own sheet. */
  native?: boolean;
  /** An invite's Join: a phone number first, since a private member signs up with one. */
  phone?: boolean;
  /**
   * The phone step asks "Your name" (a private group's invite: the name makes
   * a provisional handle only that group sees). A public community's invite
   * passes false: the server asks for a username after the code instead.
   */
  askName?: boolean;
  /** Which screen opened it, carried across a provider's trip. */
  from?: 'invite' | 'story' | 'signin';
  /** Where a provider's trip comes back to: Home, or the invite link. */
  returnTo?: string;
  /** Back from a provider: the username step, or what went wrong. */
  resume?: SignInResume | null;
  /** Opened by a waitlist "you're in" link: the token that names the address to sign up with. */
  releaseToken?: string | null;
  /**
   * Runs once the session exists and before the shell takes over:
   * 'existing' for an account that signed straight in, 'new' for one that
   * just set its password (in practice, one the code just made).
   * `handOff` sends the sheet on its way to the make screen; it resolves
   * once the sheet has gone.
   */
  beforeFinish?: (kind: 'existing' | 'new', handOff: () => Promise<void>) => void | Promise<void>;
  onClose: () => void;
  primaryClass: string;
};

/**
 * Join was pressed on an invite's own page and the person chose "Sign in with
 * a password" instead of the code: the shell follows the link once they are
 * in (App._followInvite) without asking them to join a second time. Kept for
 * this tab only, and read once.
 */
function rememberInviteJoin() {
  try {
    if (/^\/invite\/[^/]+\/?$/.test(location.pathname)) {
      sessionStorage.setItem('usernode:invite-join', location.pathname.replace(/\/$/, ''));
    }
  } catch { /* asked to join again, as before */ }
}

export function SignInSheet({
  open, title, intro = '', followInvite = false, providers = [], native = false, phone = false, askName = true, from = 'signin',
  returnTo = '/', resume = null, releaseToken = null, beforeFinish, onClose, primaryClass,
}: SignInSheetProps) {
  const otherWays: Step = providers.length ? 'choose' : 'email';
  const firstStep: Step = phone ? 'phone' : otherWays;
  const [step, setStep] = useState<Step>(firstStep);
  const [email, setEmail] = useState('');
  // The number a code went to, as sent (E.164), and the verify leg's handle.
  const [phoneNumber, setPhoneNumber] = useState('');
  const phoneSession = useRef('');
  // Whose username step this is: a provider's (Apple, Google) or the phone's.
  const [usernameVia, setUsernameVia] = useState<'oauth' | 'phone'>('oauth');
  const [needsUsername, setNeedsUsername] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<NativeLoginFailureDetails | null>(null);
  const [busy, setBusy] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  // Slides up one frame after it mounts, so the transition has a start.
  const [shown, setShown] = useState(false);
  // On its way to the make screen (`handOff`).
  const [leaving, setLeaving] = useState(false);
  // On its way down after the ✕, the dim, or Escape (`requestClose`).
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef<number | null>(null);
  const completion = useSessionConfirmation();
  const { finishLogin: confirmSession, clear: clearConfirmation } = completion;
  const firstField = useRef<HTMLInputElement>(null);
  const codeField = useRef<HTMLInputElement>(null);
  const usernameField = useRef<HTMLInputElement>(null);
  const providerUsernameField = useRef<HTMLInputElement>(null);
  const passwordField = useRef<HTMLInputElement>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const phoneField = useRef<HTMLInputElement>(null);
  // The phone step's two fields in order, for Return, and the name as typed.
  const phoneStepFields = [nameField, phoneField];
  const phoneName = useRef('');
  const phoneCodeField = useRef<HTMLInputElement>(null);
  const confirmField = useRef<HTMLInputElement>(null);
  const identifierField = useRef<HTMLInputElement>(null);
  const currentPasswordField = useRef<HTMLInputElement>(null);
  // Each multi-field step's fields in order, for Return (`returnWalks`).
  const passwordStepFields = [identifierField, currentPasswordField];
  const accountStepFields = [usernameField, passwordField, confirmField];
  // The panel scrolls its fields; with the keyboard up they are revealed in
  // it, with the step's button, and tapped without iOS's pan. It rides the
  // keys up and down as one eased movement.
  const panelRef = useRef<HTMLDivElement>(null);
  useKeyboardSurface(panelRef, { ride: true });
  // Read when it opens, not followed while it is open: the options that
  // name the providers can land after a release link has opened the sheet,
  // and must not send it back from the code to the first step.
  const firstStepRef = useRef(firstStep);
  firstStepRef.current = firstStep;
  const releaseSeen = useRef<string | null>(null);
  // The address an email code carried to the password step, for its first field.
  const identifierPrefill = useRef('');

  useEffect(() => {
    if (!open) { setShown(false); setLeaving(false); setClosing(false); return undefined; }
    const raf = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // Closed: down the way it came up, and only then gone. The keys go down
  // with it rather than after it, and a second tap on the fading dim is
  // the same close.
  const requestClose = useCallback(() => {
    if (closeTimer.current != null) return;
    const active = document.activeElement as HTMLElement | null;
    if (active && panelRef.current?.contains(active)) active.blur();
    if (prefersReducedMotion()) { onClose(); return; }
    setClosing(true);
    setShown(false);
    closeTimer.current = window.setTimeout(() => { closeTimer.current = null; onClose(); }, CLOSE_MS);
  }, [onClose]);
  useEffect(() => () => {
    if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);

  // A fresh start each time it opens: the address stays, the rest goes. Back
  // from a provider, it opens where that left off.
  useEffect(() => {
    if (!open) return;
    setStep(resume === 'username' ? 'username' : firstStepRef.current);
    if (resume === 'username') setUsernameVia('oauth');
    setError(resumeError(resume));
    setDetails(null);
    setBusy(false);
  }, [open, resume]);

  // The step's first field, and the caret in it when that raises no keys
  // under a moving sheet (`mayFocusByCode`). In the commit, so a hop from a
  // field whose keys are up lands before anything can take them down.
  useIsomorphicLayoutEffect(() => {
    if (!open || step === 'choose') return;
    const focus = mayFocusByCode({ touch: touchScreen(), keysUp: keyboardUp() });
    if (step === 'password' && identifierPrefill.current && identifierField.current) {
      identifierField.current.value = identifierPrefill.current;
      identifierPrefill.current = '';
      if (focus) currentPasswordField.current?.focus({ preventScroll: true });
      return;
    }
    const field = step === 'email' ? firstField : step === 'code' ? codeField
      : step === 'username' ? providerUsernameField
        : step === 'password' ? identifierField
          : step === 'phone' ? (askName ? nameField : phoneField)
            : step === 'phone-code' ? phoneCodeField
              : (needsUsername ? usernameField : passwordField);
    if (focus) field.current?.focus({ preventScroll: true });
  }, [open, step, needsUsername]);

  // Back from the provider's page by the browser's Back button, the page can
  // come out of the back-forward cache as it was left: busy. Undo that.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => { if (e.persisted) setBusy(false); };
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, []);

  // Escape closes, like every sheet in the shell; not once it is leaving
  // for the make screen, which is a sign-in already under way.
  useEffect(() => {
    if (!open || leaving) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') requestClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, leaving, requestClose]);

  // The resend's countdown.
  useEffect(() => {
    if (!open || cooldownUntil <= Date.now()) return undefined;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [open, cooldownUntil]);

  const requestCode = useCallback(async (address: string) => {
    setError(null);
    const value = address.trim().toLowerCase();
    if (!value || !value.includes('@')) { setError('Enter a valid email address'); return; }
    if (blockedOffline(setError)) return;
    setBusy(true);
    try {
      const res = await fetch('/api/auth/otp/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email: value }),
      });
      const data = await res.json().catch(() => ({}));
      setEmail(value);
      if (!res.ok || !data.ok) {
        // A code went out a moment ago and is still the live one: the code
        // step is where they should be, with the resend held as long as the
        // limiter says.
        if (res.status === 429) {
          setStep('code');
          setError(data.error || 'Too many requests. Wait a moment and try again.');
          const retryAfter = Number(res.headers.get('Retry-After'));
          setCooldownUntil(Date.now() + (Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter, 900) * 1000 : RESEND_COOLDOWN_MS));
          return;
        }
        setStep('email');
        setError(data.error || 'Could not send a code');
        return;
      }
      if (codeField.current) codeField.current.value = '';
      setStep('code');
      setCooldownUntil(Date.now() + RESEND_COOLDOWN_MS);
      setNow(Date.now());
    } catch {
      setError('Network error');
    } finally {
      setBusy(false);
    }
  }, []);

  // A waitlist "you're in" link (`releaseToken`): the address its token
  // names, filled in, and the code sent once per tab, exactly what the
  // sign-in screen does for the same link (./login.tsx). A token that names
  // nothing leaves the email step as it is, to be filled in by hand.
  useEffect(() => {
    if (!open || !releaseToken || releaseSeen.current === releaseToken) return undefined;
    releaseSeen.current = releaseToken;
    let live = true;
    setStep('email');
    void releaseArrival(releaseToken).then((arrival) => {
      if (!live || !arrival) return;
      setEmail(arrival.address);
      if (firstField.current) firstField.current.value = arrival.address;
      if (!arrival.send) {
        setStep('code');
        setCooldownUntil(arrival.cooldownUntil);
        setNow(Date.now());
        return;
      }
      void requestCode(arrival.address);
    });
    return () => { live = false; };
  }, [open, releaseToken, requestCode]);

  // Away to the make screen: the panel goes down while the wallpaper comes
  // up behind it. Resolves once that has had its time.
  const handOff = useCallback((): Promise<void> => {
    setLeaving(true);
    const ms = prefersReducedMotion() ? 0 : HAND_OFF_MS;
    return new Promise((resolve) => { window.setTimeout(resolve, ms); });
  }, []);

  // Every sign-in ends here: what the screen that opened the sheet does
  // first (`beforeFinish`), then the shell's own sign-in. A session the
  // shell cannot confirm brings the sheet back with the notice that says so.
  const finish = useCallback(async (kind: 'existing' | 'new') => {
    clearConfirmation();
    await beforeFinish?.(kind, handOff);
    const opened = await confirmSession();
    if (!opened) setLeaving(false);
  }, [beforeFinish, handOff, clearConfirmation, confirmSession]);

  const verify = useCallback(async () => {
    setError(null);
    const code = (codeField.current?.value || '').trim();
    if (!code) { setError('Enter the code from the email'); return; }
    if (blockedOffline(setError)) return;
    setBusy(true);
    try {
      const res = await fetchSessionMint('/api/auth/otp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email, code, ...(followInvite ? { followInvite: true } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        // A right code for an account that signs in with its password (an
        // admin's, or one whose address was never confirmed): its password
        // step, with the address carried over, as the sign-in screen does.
        if (data.code === 'password_required' || data.code === 'admin_password_required') {
          identifierPrefill.current = email;
          setStep('password');
          setError(data.error || 'This account signs in with its password.');
          return;
        }
        setError(res.status === 429
          ? data.error || 'Too many code attempts. Try again shortly.'
          : data.error || 'Invalid or expired code.');
        return;
      }
      if (data.next === 'signed-in') {
        await finish('existing');
        return;
      }
      setNeedsUsername(data.needsUsername === true);
      setCooldownUntil(0);
      setStep('account');
    } catch (err) {
      setError(sessionMintFailureMessage(err));
    } finally {
      setBusy(false);
    }
  }, [email, followInvite, finish]);

  // The phone's code (`phone`): a reCAPTCHA token first, then the text.
  // `value` is the E.164 number the field built (./phone-input.tsx), or one
  // sent before, for the code step's resend.
  const requestPhoneCode = useCallback(async (value: string) => {
    setError(null);
    if (blockedOffline(setError)) return;
    setBusy(true);
    try {
      const recaptchaToken = await phoneRecaptchaToken();
      const res = await fetch('/api/auth/phone/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ phoneNumber: value, ...(recaptchaToken ? { recaptchaToken } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok || typeof data.sessionInfo !== 'string') {
        // Asked again too soon for a number a code already went to: that
        // code is still the one to type, with the resend held.
        if (res.status === 429 && phoneSession.current && value === phoneNumber) {
          setStep('phone-code');
          setError(data.error || 'Too many requests. Wait a moment and try again.');
          setCooldownUntil(Date.now() + RESEND_COOLDOWN_MS);
          setNow(Date.now());
          return;
        }
        setStep('phone');
        setError(data.error || 'Could not send a code');
        return;
      }
      phoneSession.current = data.sessionInfo;
      setPhoneNumber(value);
      if (phoneCodeField.current) phoneCodeField.current.value = '';
      setStep('phone-code');
      setCooldownUntil(Date.now() + RESEND_COOLDOWN_MS);
      setNow(Date.now());
    } catch {
      setError('Network error');
    } finally {
      setBusy(false);
    }
  }, [phoneNumber]);

  // The phone step: a name for the group, then the number's code.
  const submitPhoneStep = useCallback(async () => {
    setError(null);
    const read = await readPhone(phoneField.current);
    if (!askName) {
      phoneName.current = '';
      if (!read.ok) { setError(read.error); return; }
      void requestPhoneCode(read.e164);
      return;
    }
    const name = (nameField.current?.value || '').replace(/\s+/g, ' ').trim();
    if (!name) { setError('Enter your name.'); nameField.current?.focus({ preventScroll: true }); return; }
    if (name.length > PHONE_NAME_MAX) { setError(`Your name can be up to ${PHONE_NAME_MAX} characters.`); return; }
    phoneName.current = name;
    if (!read.ok) { setError(read.error); return; }
    void requestPhoneCode(read.e164);
  }, [askName, requestPhoneCode]);

  const verifyPhone = useCallback(async () => {
    setError(null);
    const code = (phoneCodeField.current?.value || '').trim();
    if (!code) { setError('Enter the code from the text'); return; }
    if (blockedOffline(setError)) return;
    setBusy(true);
    try {
      const res = await fetchSessionMint('/api/auth/phone/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          sessionInfo: phoneSession.current,
          code,
          ...(phoneName.current ? { name: phoneName.current } : {}),
          ...(followInvite ? { followInvite: true } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setError(res.status === 429
          ? data.error || 'Too many code attempts. Try again shortly.'
          : data.error || 'Invalid or expired code.');
        return;
      }
      if (data.next === 'signed-in') {
        await finish(data.created === true ? 'new' : 'existing');
        return;
      }
      setCooldownUntil(0);
      setUsernameVia('phone');
      setStep('username');
    } catch (err) {
      setError(sessionMintFailureMessage(err));
    } finally {
      setBusy(false);
    }
  }, [followInvite, finish]);

  const finishAccount = useCallback(async () => {
    setError(null);
    const handle = needsUsername ? (usernameField.current?.value || '').trim() : null;
    if (handle === '') { setError('Enter a username.'); usernameField.current?.focus({ preventScroll: true }); return; }
    const password = passwordField.current?.value || '';
    const confirm = confirmField.current?.value || '';
    if (password.length < 8) { setError('Password must be at least 8 characters'); return; }
    if (password !== confirm) { setError('Passwords do not match'); return; }
    if (blockedOffline(setError)) return;
    setBusy(true);
    try {
      const res = await fetchSessionMint('/api/auth/otp/set-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ password, passwordConfirmation: confirm, ...(handle ? { username: handle } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.user) {
        setError(data.error || 'Could not finish setting up your account');
        if (data.field === 'username') usernameField.current?.focus({ preventScroll: true });
        return;
      }
      await finish('new');
    } catch (err) {
      setError(sessionMintFailureMessage(err));
    } finally {
      setBusy(false);
    }
  }, [needsUsername, finish]);

  // The password step: the sign-in screen's own exchange (./shared.ts).
  const signInWithPassword = useCallback(async () => {
    setError(null);
    setDetails(null);
    if (blockedOffline(setError)) return;
    setBusy(true);
    try {
      const result = await passwordSignIn(
        (identifierField.current?.value || '').trim(),
        currentPasswordField.current?.value || '',
      );
      if (!result.ok) {
        setError(result.error);
        setDetails(result.details);
        return;
      }
      // A password sign-in does not follow an invite by itself
      // (routes/auth.js): the Join pressed on its page is remembered, so the
      // shell follows it once they are in without asking a second time.
      if (followInvite) rememberInviteJoin();
      await finish('existing');
    } finally {
      setBusy(false);
    }
  }, [followInvite, finish]);

  // Off to the provider. The page leaves, so busy stays on until it does.
  // Inside the app it stays: the app's own sheet answers in place.
  const continueWith = useCallback(async (provider: SignInProvider) => {
    setError(null);
    if (blockedOffline(setError)) return;
    setBusy(true);
    if (!native) {
      window.location.assign(providerStartUrl(provider, { from, followInvite, returnTo }));
      return;
    }
    try {
      const outcome = await signInNatively(provider, { from, followInvite });
      if ('next' in outcome && outcome.next === 'signed-in') {
        await finish(outcome.created ? 'new' : 'existing');
        return;
      }
      if ('next' in outcome && outcome.next === 'username') {
        setUsernameVia('oauth');
        setStep('username');
        return;
      }
      if ('error' in outcome) setError(outcome.error);
    } catch (err) {
      setError(sessionMintFailureMessage(err));
    } finally {
      setBusy(false);
    }
  }, [native, from, followInvite, returnTo, finish]);

  const finishProviderAccount = useCallback(async () => {
    setError(null);
    const handle = (providerUsernameField.current?.value || '').trim();
    if (!handle) { setError('Enter a username.'); providerUsernameField.current?.focus({ preventScroll: true }); return; }
    if (blockedOffline(setError)) return;
    setBusy(true);
    try {
      // The same step for both: the continuation is the phone's own cookie
      // or the provider's (routes/phone-auth.js, routes/sign-in-providers.js).
      const res = await fetchSessionMint(usernameVia === 'phone' ? '/api/auth/phone/finish' : '/api/auth/oauth/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ username: handle }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.user) {
        if (data.field === 'username') {
          setError(data.error || 'Choose another username.');
          providerUsernameField.current?.focus({ preventScroll: true });
          return;
        }
        // The continuation is gone: start over from the first step.
        setStep(firstStep);
        setError(data.error || 'Your sign-in expired. Start again.');
        return;
      }
      await finish('new');
    } catch (err) {
      setError(sessionMintFailureMessage(err));
    } finally {
      setBusy(false);
    }
  }, [finish, firstStep, usernameVia]);

  if (!open) return null;

  const oneLine = firstStepLine(from, phone) === 'password' ? (
    <>
      <p className="text-center text-[13px] text-zinc-500 dark:text-zinc-400">
        <a
          href="#login"
          data-sign-in-sheet-password=""
          onClick={(e) => { e.preventDefault(); setError(null); setDetails(null); setStep('password'); }}
          className="font-medium text-violet-700 dark:text-violet-400 hover:underline"
        >
          Sign in with a password
        </a>
      </p>
      <TermsNotice />
    </>
  ) : <TermsNotice />;

  const waitLeft = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));
  const heading = step === 'choose' || step === 'email' || step === 'phone' ? title
    : step === 'code' ? 'Check your email'
      : step === 'phone-code' ? 'Check your texts'
        : step === 'password' ? 'Sign in'
          : step === 'username' ? 'Pick a username' : 'Finish your account';
  // The first step says nothing under its title unless it is given a line:
  // "Make your account", "Join Sunday Run Club" and "Sign in" already say
  // it, and the field or the providers come next (#4037). With the phone
  // first, the other ways are for an account made before.
  const sub = step === firstStep
    ? intro
    : step === 'choose'
      ? 'Sign in to the account you have.'
      : step === 'email'
      ? 'We\'ll email you a 6-digit code.'
      : step === 'phone-code'
        ? `We sent a 6-digit code to the number ending ${phoneNumber.slice(-4)}.`
      : step === 'code'
        ? `We sent a 6-digit code to ${email}. It expires in 10 minutes.`
        : step === 'password'
          ? 'With your username or email, and your password.'
          : step === 'username'
            ? 'Your username is public on Homeroom. It is how people @mention you.'
            : (needsUsername ? 'Pick a username and a password. Your username is public on Homeroom.' : 'Pick a password for next time.');
  // Up, on its way up, or leaving for the make screen: whole literals, for
  // the extractor. On a phone it slides; from md, where it is a centred
  // card, it fades.
  const panelState = leaving
    ? 'pointer-events-none translate-y-full md:-translate-x-1/2 md:-translate-y-1/2 md:opacity-0'
    : shown ? 'translate-y-0 md:-translate-x-1/2 md:-translate-y-1/2' : 'translate-y-full md:-translate-x-1/2 md:-translate-y-1/2';
  const close = leaving ? undefined : requestClose;

  return (
    <div data-sign-in-sheet={step} data-sign-in-sheet-leaving={leaving ? '' : undefined} data-sign-in-sheet-closing={closing ? '' : undefined} className="fixed inset-0 z-50">
      {/* The dim takes no pan, so a drag on it does not scroll the story
          behind (the kit's backdrop rule); its tap still closes. */}
      <div
        aria-hidden="true"
        onClick={close}
        className={`absolute inset-0 touch-none bg-black/40 transition-opacity duration-200 motion-reduce:transition-none ${shown ? 'opacity-100' : 'opacity-0'}`}
      />
      {/*
          The make screen's own ground (../first-session/make.tsx paints the
          same --home-wallpaper over the same full-screen box), brought up
          behind the leaving panel so the story is gone by the time the shell
          signs in, and the make screen arrives on what is already there.
          It takes the taps while it is up, so nothing under it is pressed.
      */}
      <div
        aria-hidden="true"
        data-sign-in-sheet-cover=""
        className={leaving
          ? 'absolute inset-0 touch-none opacity-100 transition-opacity duration-200 ease-out motion-reduce:transition-none'
          : 'pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-200 ease-out motion-reduce:transition-none'}
        style={{ background: 'var(--home-wallpaper)' }}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sign-in-sheet-title"
        className={`platform-kb-sheet absolute inset-x-0 bottom-0 max-h-[92%] overflow-y-auto overscroll-contain rounded-t-[20px] ${PLANE_FILL} shadow-[inset_0_0_0_1px_var(--app-sheet-line)] px-4 pt-2 pb-[max(2rem,env(safe-area-inset-bottom))] transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none md:inset-x-auto md:left-1/2 md:bottom-auto md:top-1/2 md:w-full md:max-w-md md:rounded-[20px] md:pb-6 ${panelState}`}
      >
        <div className="mx-auto h-1 w-9 rounded-full bg-[color:var(--border)] md:hidden" aria-hidden="true" />
        <div className="mt-3 flex items-center gap-3">
          <h2 id="sign-in-sheet-title" className="min-w-0 flex-1 text-[17px] font-semibold text-zinc-900 dark:text-zinc-100">{heading}</h2>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
          >
            <XIcon className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        {sub ? <p className="mt-1 text-[15px] leading-snug text-zinc-500 dark:text-zinc-400">{sub}</p> : null}

        {step === 'choose' ? (
          <div className="mt-5 flex flex-col gap-2.5">
            {providers.map((provider) => (
              <button
                key={provider}
                type="button"
                data-sign-in-provider={provider}
                disabled={busy}
                className={PROVIDER_BUTTON[provider]}
                onClick={() => continueWith(provider)}
              >
                {provider === 'apple'
                  ? <AppleIcon className="h-[18px] w-[18px] -mt-0.5" aria-hidden="true" />
                  : <GoogleIcon className="h-[18px] w-[18px]" aria-hidden="true" />}
                {`Continue with ${PROVIDER_LABEL[provider]}`}
              </button>
            ))}
            <button type="button" data-sign-in-provider="email" disabled={busy} className={EMAIL_BUTTON} onClick={() => { setError(null); setStep('email'); }}>
              Continue with email
            </button>
            {phone ? (
              <button type="button" data-sign-in-sheet-to-phone="" className={QUIET} onClick={() => { setError(null); setStep('phone'); }}>New to Homeroom? Join with your phone</button>
            ) : null}
            {oneLine}
          </div>
        ) : null}

        {step === 'email' ? (
          <form className="mt-5 flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void requestCode(firstField.current?.value || ''); }}>
            <div className={FIELD_GROUP}>
              <div className={FIELD}>
                <label htmlFor="sign-in-sheet-email" className={LABEL}>Email</label>
                <input ref={firstField} id="sign-in-sheet-email" type="email" autoComplete="email" inputMode="email" enterKeyHint="go" defaultValue={email} className={INPUT} {...HANDLE_FIELD} />
              </div>
            </div>
            <button type="submit" disabled={busy} className={`${primaryClass} disabled:opacity-60`} {...HOLD_FIELD_FOCUS}>{busy ? 'Sending code…' : 'Send code'}</button>
            {oneLine}
            {providers.length ? (
              <button type="button" className={QUIET} onClick={() => { setError(null); setStep('choose'); }}>Other ways to continue</button>
            ) : null}
            {phone ? (
              <button type="button" data-sign-in-sheet-to-phone="" className={QUIET} onClick={() => { setError(null); setStep('phone'); }}>New to Homeroom? Join with your phone</button>
            ) : null}
          </form>
        ) : null}

        {step === 'phone' ? (
          <form className="mt-5 flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void submitPhoneStep(); }}>
            <div className={FIELD_GROUP}>
              {askName ? (
                <div className={FIELD}>
                  <label htmlFor="sign-in-sheet-name" className={LABEL}>Your name</label>
                  <input ref={nameField} id="sign-in-sheet-name" type="text" autoComplete="name" enterKeyHint="next" maxLength={PHONE_NAME_MAX} defaultValue={phoneName.current} onKeyDown={returnWalks(phoneStepFields, 0)} className={INPUT} />
                </div>
              ) : null}
              <div className={FIELD}>
                <label htmlFor="sign-in-sheet-phone" className={LABEL}>Phone number</label>
                <PhoneInput inputRef={phoneField} id="sign-in-sheet-phone" defaultValue={phoneNumber} />
              </div>
            </div>
            <button type="submit" disabled={busy} className={`${primaryClass} disabled:opacity-60`} {...HOLD_FIELD_FOCUS}>{busy ? 'Sending code…' : 'Text me a code'}</button>
          </form>
        ) : null}

        {step === 'phone-code' ? (
          <form className="mt-5 flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void verifyPhone(); }}>
            <div className={FIELD_GROUP}>
              <div className={FIELD}>
                <label htmlFor="sign-in-sheet-phone-code" className={LABEL}>Code</label>
                <input ref={phoneCodeField} id="sign-in-sheet-phone-code" inputMode="numeric" autoComplete="one-time-code" enterKeyHint="go" maxLength={6} className={`${INPUT} tracking-[0.4em]`} />
              </div>
            </div>
            <p className="text-[13px] text-zinc-500 dark:text-zinc-400">The code fills itself in on most phones.</p>
            <button type="submit" disabled={busy} className={`${primaryClass} disabled:opacity-60`} {...HOLD_FIELD_FOCUS}>{busy ? 'Checking…' : 'Continue'}</button>
            <div className="flex items-center justify-between">
              <button type="button" className={QUIET} onClick={() => { setError(null); setStep('phone'); }}>Use another number</button>
              <button type="button" className={`${QUIET} disabled:text-zinc-500 disabled:dark:text-zinc-400 disabled:no-underline`} disabled={busy || waitLeft > 0} onClick={() => { void requestPhoneCode(phoneNumber); }}>
                {waitLeft > 0 ? `Send a new code in ${waitLeft}s` : 'Send a new code'}
              </button>
            </div>
          </form>
        ) : null}

        {step === 'username' ? (
          <form className="mt-5 flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void finishProviderAccount(); }}>
            <div className={FIELD_GROUP}>
              <div className={FIELD}>
                <label htmlFor="sign-in-sheet-provider-username" className={LABEL}>Username</label>
                <input ref={providerUsernameField} id="sign-in-sheet-provider-username" autoComplete="username" enterKeyHint="go" className={INPUT} placeholder={USERNAME_RULE} {...HANDLE_FIELD} />
              </div>
            </div>
            <button type="submit" disabled={busy} className={`${primaryClass} disabled:opacity-60`} {...HOLD_FIELD_FOCUS}>{busy ? 'Finishing…' : 'Continue'}</button>
          </form>
        ) : null}

        {step === 'code' ? (
          <form className="mt-5 flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void verify(); }}>
            <div className={FIELD_GROUP}>
              <div className={FIELD}>
                <label htmlFor="sign-in-sheet-code" className={LABEL}>Code</label>
                <input ref={codeField} id="sign-in-sheet-code" inputMode="numeric" autoComplete="one-time-code" enterKeyHint="go" maxLength={6} className={`${INPUT} tracking-[0.4em]`} />
              </div>
            </div>
            <button type="submit" disabled={busy} className={`${primaryClass} disabled:opacity-60`} {...HOLD_FIELD_FOCUS}>{busy ? 'Checking…' : 'Continue'}</button>
            <div className="flex items-center justify-between">
              <button type="button" className={QUIET} onClick={() => { setError(null); setStep('email'); }}>Use another email</button>
              <button type="button" className={`${QUIET} disabled:text-zinc-500 disabled:dark:text-zinc-400 disabled:no-underline`} disabled={busy || waitLeft > 0} onClick={() => { void requestCode(email); }}>
                {waitLeft > 0 ? `Send a new code in ${waitLeft}s` : 'Send a new code'}
              </button>
            </div>
          </form>
        ) : null}

        {step === 'password' ? (
          <form className="mt-5 flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void signInWithPassword(); }}>
            <div className={FIELD_GROUP}>
              <div className={FIELD}>
                <label htmlFor="sign-in-sheet-identifier" className={LABEL}>Username or email</label>
                <input ref={identifierField} id="sign-in-sheet-identifier" name="username" type="text" required autoComplete="username" enterKeyHint="next" onKeyDown={returnWalks(passwordStepFields, 0)} className={INPUT} {...HANDLE_FIELD} />
              </div>
              <div className={FIELD}>
                <label htmlFor="sign-in-sheet-current-password" className={LABEL}>Password</label>
                <PasswordInput ref={currentPasswordField} id="sign-in-sheet-current-password" name="password" required autoComplete="current-password" enterKeyHint="go" box="card" hint="dim" ring="bare" />
              </div>
            </div>
            <button type="submit" disabled={busy} className={`${primaryClass} disabled:opacity-60`} {...HOLD_FIELD_FOCUS}>{busy ? 'Signing in…' : 'Sign in'}</button>
            <div className="flex items-center justify-between">
              <button type="button" className={QUIET} onClick={() => { setError(null); setDetails(null); setStep(otherWays); }}>
                {providers.length ? 'Other ways to continue' : 'Use an email code'}
              </button>
              {/* The reset is the sign-in screen's (./login.tsx), reached by its own address. */}
              <a href="#login/forgot" onClick={() => { if (followInvite) rememberInviteJoin(); onClose(); }} className={QUIET}>Forgot password?</a>
            </div>
          </form>
        ) : null}

        {step === 'account' ? (
          <form className="mt-5 flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void finishAccount(); }}>
            <div className={FIELD_GROUP}>
              {needsUsername ? (
                <div className={FIELD}>
                  <label htmlFor="sign-in-sheet-username" className={LABEL}>Username</label>
                  <input ref={usernameField} id="sign-in-sheet-username" autoComplete="username" enterKeyHint="next" onKeyDown={returnWalks(accountStepFields, 0)} className={INPUT} placeholder={USERNAME_RULE} {...HANDLE_FIELD} />
                </div>
              ) : null}
              <div className={FIELD}>
                <label htmlFor="sign-in-sheet-password" className={LABEL}>Password</label>
                <input ref={passwordField} id="sign-in-sheet-password" type="password" autoComplete="new-password" enterKeyHint="next" onKeyDown={returnWalks(accountStepFields, 1)} className={INPUT} placeholder="At least 8 characters" />
              </div>
              <div className={FIELD}>
                <label htmlFor="sign-in-sheet-confirm" className={LABEL}>Password again</label>
                <input ref={confirmField} id="sign-in-sheet-confirm" type="password" autoComplete="new-password" enterKeyHint="go" className={INPUT} />
              </div>
            </div>
            <button type="submit" disabled={busy} className={`${primaryClass} disabled:opacity-60`} {...HOLD_FIELD_FOCUS}>{busy ? 'Finishing…' : 'Continue'}</button>
          </form>
        ) : null}

        {error ? (
          <div role="alert" className="mt-3 text-[14px] text-red-600 dark:text-red-400">
            {error}
            <NativeLoginDetailsLink details={details} />
          </div>
        ) : null}
        <SessionConfirmationNotice completion={completion} />

        {step === 'phone' ? (
          <p className="mt-4 text-center text-[13px] text-zinc-500 dark:text-zinc-400">
            {'Already on Homeroom? '}
            <a
              href="#login"
              data-sign-in-sheet-other-ways=""
              onClick={(e) => { e.preventDefault(); setError(null); setDetails(null); setStep(otherWays); }}
              className="font-medium text-violet-700 dark:text-violet-400 hover:underline"
            >
              Sign in another way
            </a>
          </p>
        ) : null}
        {/* The first step's terms sit in its group (above); every later step keeps them here. */}
        {step === 'choose' || step === 'email' ? null : (
          <TermsNotice className="mt-3" recaptcha={step === 'phone' || step === 'phone-code' ? RECAPTCHA_LINE : null} />
        )}
      </div>
    </div>
  );
}
