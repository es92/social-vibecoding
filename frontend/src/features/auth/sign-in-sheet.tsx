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
 *   code     POST /api/auth/otp/verify. An account that has a password, or
 *            has chosen its username, is signed straight in; a new one (or
 *            one that never chose a username) moves on to
 *            The code is six boxes over one real one-time-code field (#5253),
 *            so the keyboard's suggestion from the mail and a paste fill all
 *            six, and the sixth digit sends it with no Continue to press.
 *            "Sent to <address> · Change" says where it went, a button opens
 *            the address's own mail (Gmail, Outlook, …) when it is one of
 *            theirs, "Nothing? Check spam." sits beside the resend.
 *   account  POST /api/auth/otp/set-password: the username when the account
 *            has none, which mints the session. No password (#4891): the
 *            account signs in with an emailed code, and adds a password in
 *            Settings if it wants one. The handle field (#5255) wears an @,
 *            says live whether the name is free (GET
 *            /api/auth/username-available, `checkUsername`) beside its
 *            rules, shows how others will see it, and its button says
 *            "Create my account", with the code note under it.
 *
 * Continue with Apple and Continue with Google come first when an admin has
 * set them up (`providers`, from the waitlist options), then the terms line
 * (either makes an account in one tap), an "or", the email field with
 * Continue with email, which sends the code from there, and "Use a password"
 * (#5257: one "Continue to Homeroom" sheet for new and returning people).
 * Either provider leaves the page for the provider (GET /api/auth/oauth/:provider/start) and comes
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
 *               Firebase asks of a web caller. Above the name, one line
 *               says who sees it and that a public app asks for a
 *               username first (Evan, 20 Oct 2026).
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
 * Under the phone step, past an "or", Continue with Apple and Continue with
 * Google when an admin has set them up (the same buttons as the first step's
 * otherwise), then "Already on Homeroom? Sign in with email", for an account
 * made before; one made by email from here is not a private member and
 * waits in the queue. That step still leads on to "Use a password".
 *
 * "Use a password" is a step of its own here too:
 *
 *   password POST /api/auth/login with a username or an email, the sign-in
 *            screen's own exchange (passwordSignIn in ./shared.ts).
 *   forgot   "Forgot password?", inside the sheet (#5258): POST
 *            /api/auth/password-reset/request emails a link for choosing a
 *            new password, the sign-in screen's own reset (#login/forgot),
 *            without leaving for that screen and its own Back. One "‹ Sign
 *            in" above its title goes back (#5259); "Sign in with a code
 *            instead" beside the button skips the password altogether; and
 *            the note about mail that never comes shows once a link went.
 *
 * Where the sheet may be for an account somebody has (`firstStepLine`
 * 'password'), the email and password steps carry a switch at the top,
 * Email code | Password (#5258), in place of the small links that used to
 * lead from one to the other. The password and reset steps say nothing of
 * the terms: neither can make an account, and the account agreed to them
 * when it was made. Nor does the email step there, since sending a code
 * makes nothing (#5257): the code step, whose right code can, says it.
 * Every step that can make one still says it.
 *
 * A waitlist "you're in" link opens the sheet already at work
 * (`releaseToken`): the address its token names filled in and the code
 * sent, as the sign-in screen does for the same link (./login.tsx), with
 * the same once-per-tab record of the send. With such a link the account
 * step is not the sheet's: it hands the account to the story (`onAccount`),
 * which shows the full-page Welcome (./welcome-page.tsx).
 *
 * Every success ends in finishLogin(), so where the person lands is the
 * shell's decision (AuthScreens.finishLogin, then the invite link's path).
 * `followInvite` tells the verify route that this sign-in is the Join the
 * person just pressed on an invite's page: an account that already existed
 * follows the link too (routes/auth.js), rather than being asked again.
 *
 * ── The way out to "What do you want to make?" ─────────────────────────
 *
 * When a sign-in leads to the account's first session, the story's
 * `beforeFinish` answers true and the sheet hands off to that screen
 * (`handOff`). It stays up first, its button busy with a spinner, until the
 * make screen is ready to draw: the session confirmed and the page staying
 * on its build (AuthScreens.finishLogin's `beforeShell`). Only then does it
 * slide away while the wallpaper the make screen stands on comes up behind
 * it, and the shell signs in, opening that screen in the same tick
 * (../first-session/index.tsx), so nothing of Home shows between the two.
 * It used to leave before the session read, and the wallpaper alone stood
 * there, a blank page, for as long as the read took (iPhone 17 simulator,
 * iOS 26.5 Safari, 12 Oct 2026, #4892). The invite's "You're in" holds its
 * frame the same way (App._followInvite, holdWelcome).
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
import { AppleIcon, ChevronLeftIcon, EnvelopeIcon, GoogleIcon, PhoneIcon, SpinnerArcIcon, XIcon } from '@/components/ui/icons';
import { PasswordInput } from '@/components/ui/password-input';

import { KB_OPEN_CLASS } from '../../lib/keyboard-open';
import { useKeyboardSurface } from '../../lib/keyboard-surface';
import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { RichMessage, useMessages } from '../../lib/i18n/react';
import { t as translate } from '../../lib/i18n/runtime';
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
  ONE_TIME_CODE_FIELD,
  passwordSignIn,
  sessionMintFailureMessage,
} from './shared';
import { RecaptchaLine, TermsNotice } from './waitlist-shared';

type Step = 'choose' | 'email' | 'code' | 'account' | 'username' | 'password' | 'forgot' | 'phone' | 'phone-code' | 'link';

export type SignInProvider = 'apple' | 'google';

/** What the provider's way back left for the sheet (routes/sign-in-providers.js). */
export type SignInResume = 'username' | `error-${string}`;

// What went wrong at the provider, in words. The codes are the server's.
// Message ids, read when the error is shown.
const RESUME_ERRORS: Record<string, string> = {
  cancelled: 'auth:signInSheet.resume.cancelled',
  expired: 'auth:signInSheet.resume.expired',
  no_verified_email: 'auth:signInSheet.resume.noVerifiedEmail',
  password_required: 'auth:signInSheet.resume.passwordRequired',
  admin_password_required: 'auth:signInSheet.resume.adminPasswordRequired',
  linked_elsewhere: 'auth:signInSheet.resume.linkedElsewhere',
  logout_required: 'auth:signInSheet.resume.logoutRequired',
};
const RESUME_FALLBACK = 'auth:signInSheet.resume.fallback';

export function resumeError(resume: SignInResume | null | undefined): string | null {
  if (!resume || !resume.startsWith('error-')) return null;
  return translate(RESUME_ERRORS[resume.slice('error-'.length)] || RESUME_FALLBACK);
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
  return resumeError(`error-${typeof code === 'string' && code ? code : 'failed'}`) || translate(RESUME_FALLBACK);
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
  if (!bridge || typeof bridge.signInWithProvider !== 'function') return { error: translate(RESUME_FALLBACK) };
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
    return { error: translate(RESUME_FALLBACK) };
  }
  if (typeof idToken !== 'string' || !idToken) return { error: translate(RESUME_FALLBACK) };
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

/**
 * The ways to make an account, in the order the sheet offers them: Apple and
 * Google where an admin has set them up, a phone number where the server
 * offers phone sign-in, and email always. The guest Discover's hero shows
 * them as buttons (`SignUpButtons`, ./story.tsx), and each opens the sheet
 * at its own way in (`start`).
 */
export type SignUpMethod = SignInProvider | 'phone' | 'email';

export function signUpMethods(providers: readonly SignInProvider[], phone: boolean): SignUpMethod[] {
  return [...providers, ...(phone ? ['phone' as const] : []), 'email'];
}

const SIGN_UP_BUTTON: Record<SignUpMethod, string> = {
  apple: PROVIDER_BUTTON.apple,
  google: PROVIDER_BUTTON.google,
  phone: `${EMAIL_BUTTON} gap-2`,
  email: `${EMAIL_BUTTON} gap-2`,
};

/**
 * One button per way to make an account, as the sheet draws Apple's and
 * Google's: stacked on a phone, two to a row from `sm`. Where email is the
 * only way, its button is the page's primary one. Apple and Google make an
 * account in one tap, so the terms sit under them, as on the sheet's first
 * step (#5257).
 */
export function SignUpButtons({ methods, onPick, primaryClass, className = '' }: {
  methods: readonly SignUpMethod[];
  onPick: (method: SignUpMethod) => void;
  primaryClass: string;
  className?: string;
}) {
  const t = useMessages('auth');
  const label = (method: SignUpMethod) => (method === 'phone'
    ? t('auth:signUpButtons.phone')
    : method === 'email'
      ? t('auth:signUpButtons.email')
      : t('auth:signUpButtons.continueWith', { provider: PROVIDER_LABEL[method] }));
  const icon = (method: SignUpMethod) => (method === 'apple'
    ? <AppleIcon className="h-[18px] w-[18px] -mt-0.5" aria-hidden="true" />
    : method === 'google'
      ? <GoogleIcon className="h-[18px] w-[18px]" aria-hidden="true" />
      : method === 'phone'
        ? <PhoneIcon className="h-[18px] w-[18px]" aria-hidden="true" />
        : <EnvelopeIcon className="h-[18px] w-[18px]" aria-hidden="true" />);
  const oneTap = methods.some((m) => m === 'apple' || m === 'google');
  return (
    <div data-sign-up-methods="" className={`flex w-full flex-col gap-2.5 ${className}`}>
      <div className="grid w-full gap-2.5 sm:grid-cols-2 sm:[&>*:last-child:nth-child(odd)]:col-span-2">
        {methods.map((method) => (
          <button
            key={method}
            type="button"
            data-sign-up-method={method}
            className={methods.length === 1 ? primaryClass : SIGN_UP_BUTTON[method]}
            onClick={() => onPick(method)}
          >
            {methods.length === 1 ? null : icon(method)}
            {label(method)}
          </button>
        ))}
      </div>
      {oneTap ? <TermsNotice className="md:text-left" /> : null}
    </div>
  );
}

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
 * The spinner on Continue while it finishes a new account: the account is
 * saved, and a sheet bound for the make screen then waits there, up and
 * busy, until that screen is ready to draw (#4892). The label beside it
 * says "Finishing…". The full-page Welcome's Continue is the same
 * (./welcome-page.tsx).
 */
export function FinishingSpinner() {
  return <SpinnerArcIcon className="mr-2 h-[18px] w-[18px] shrink-0 animate-spin" aria-hidden="true" />;
}

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
 * `mayFocusByCode` for this device, now. The make screen asks it too
 * (../first-session/make.tsx, #4597): the sheet hands off with the keys
 * down, and a caret put in the description from code would raise them again
 * over a screen that is meant to open whole.
 */
export function mayFocusByCodeNow(): boolean {
  return mayFocusByCode({ touch: touchScreen(), keysUp: keyboardUp() });
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

/** A screen worked by touch, whose keyboard comes up over the page (the Welcome page folds for it). */
export function touchScreen(): boolean {
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

export function prefersReducedMotion(): boolean {
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
 * 7 October). Where the sheet only makes an account (an invite's Join) it is
 * the terms line alone, since continuing is agreeing
 * (tests/terms-first-run.test.js). Where it may be for an account somebody
 * has, it is "Use a password", and no terms under the email, since sending a
 * code makes nothing (#5257; the code step says them): Sign in, the story's
 * Continue (#5251: one button for new and returning people, so the password
 * way in is here now that the story has no Sign in of its own), and the
 * other ways after an invite's phone step.
 */
export function firstStepLine(from: 'invite' | 'story' | 'signin', phone = false): 'terms' | 'password' {
  return from === 'invite' && !phone ? 'terms' : 'password';
}

/**
 * Whether a step carries the Email code | Password switch (#5258): the email
 * and password steps, wherever the sheet may be for an account somebody has.
 * An invite's Join only makes an account, so it has no switch; a right code
 * for a password account still takes it to the password step, with the old
 * link back.
 */
export function hasMethodSwitch(step: string, from: 'invite' | 'story' | 'signin', phone = false): boolean {
  return (step === 'email' || step === 'password') && firstStepLine(from, phone) === 'password';
}

/** Whether a step's foot says the terms: not the password or reset steps, which make no account (#5258). */
export function stepSaysTerms(step: string): boolean {
  return step !== 'password' && step !== 'forgot';
}

/**
 * The reset link, as the sign-in screen asks for it (./login.tsx
 * onEmailReset). The server answers the same whether or not the address
 * matched (anti-enumeration), and so does the sheet: 'sent', or what went
 * wrong in words.
 */
export async function requestPasswordReset(address: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const email = address.trim();
  if (!email || !email.includes('@')) return { ok: false, error: translate('auth:signInSheet.forgot.emailMissing') };
  try {
    const res = await fetch('/api/auth/password-reset/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return { ok: false, error: data.error || translate('auth:signInSheet.forgot.sendFailed') };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: translate('auth:signInSheet.networkError') };
  }
}

/** The code's length (routes/auth.js sends six digits). */
export const CODE_LENGTH = 6;

/** What is typed or pasted into the code, as the six digits it can be: a pasted "583 914" or "Code: 583914" fills all six. */
export function codeDigits(value: string): string {
  return value.replace(/\D/g, '').slice(0, CODE_LENGTH);
}

/** A mail service whose own inbox a button can open, for the code step (#5253). */
export type MailApp = { name: string; url: string };

const MAIL_APPS: Array<{ name: string; domains: readonly string[]; url: (address: string) => string }> = [
  {
    name: 'Gmail',
    domains: ['gmail.com', 'googlemail.com'],
    // The account the code went to, and the last hour's mail in every folder, spam included.
    url: (address) => `https://mail.google.com/mail/?authuser=${encodeURIComponent(address)}#search/in%3Aanywhere+newer_than%3A1h`,
  },
  { name: 'Outlook', domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'], url: () => 'https://outlook.live.com/mail/' },
  { name: 'Yahoo Mail', domains: ['yahoo.com', 'ymail.com'], url: () => 'https://mail.yahoo.com/' },
  { name: 'iCloud Mail', domains: ['icloud.com', 'me.com', 'mac.com'], url: () => 'https://www.icloud.com/mail/' },
  { name: 'Proton Mail', domains: ['proton.me', 'protonmail.com', 'pm.me'], url: () => 'https://mail.proton.me/' },
];

/** The mail service an address belongs to, by its domain; null for any other (a work or school address). */
export function mailAppFor(address: string): MailApp | null {
  const at = address.lastIndexOf('@');
  if (at < 1) return null;
  const domain = address.slice(at + 1).trim().toLowerCase();
  const app = MAIL_APPS.find((a) => a.domains.includes(domain) || (a.name === 'Yahoo Mail' && domain.startsWith('yahoo.')));
  return app ? { name: app.name, url: app.url(address.trim()) } : null;
}

/** What the account step's live check says of a handle (#5255). */
export type UsernameCheck = { state: 'idle' } | { state: 'checking' } | { state: 'available' } | { state: 'taken'; error: string };

/**
 * Whether anybody holds `handle`, by the server's own rules and ledger
 * (GET /api/auth/username-available). 'idle' for an empty field and for a
 * check that could not be made (offline, throttled): the field then says
 * nothing, and Create my account still answers with the server's refusal.
 */
export async function checkUsername(handle: string, signal?: AbortSignal): Promise<UsernameCheck> {
  const value = handle.trim();
  if (!value) return { state: 'idle' };
  try {
    const res = await fetch(`/api/auth/username-available?username=${encodeURIComponent(value)}`, { credentials: 'same-origin', signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok !== true) return { state: 'idle' };
    return data.available === true ? { state: 'available' } : { state: 'taken', error: String(data.error || '') };
  } catch {
    return { state: 'idle' };
  }
}

// How long the field waits after the last keystroke before it asks.
export const USERNAME_CHECK_MS = 350;

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

/** A waitlist "you're in" link's one-time sign-in, spent (#4594). */
export type ReleaseSpend = {
  next: 'signed-in' | 'set-password'; email: string; needsUsername: boolean; suggestedUsername: string;
};

/** The account step's three facts: whose address, and its username to choose. */
export type AccountStep = { email: string; needsUsername: boolean; suggestedUsername: string };

/**
 * Spend the release mail's one-time sign-in link (src/services/release-links.js)
 * with a POST, never on the GET that opened the page, so a mail scanner's
 * prefetch cannot use it up. 'refused' when the server says the link is
 * expired, used or unknown; null on anything else (offline, a server
 * error). Either way the sheet falls back to the address and a code, and a
 * refused link says why.
 *
 * `newAccountOnly` is the story's spend as the page opens (./landing.tsx),
 * before any tap: the server then answers only `set-password`, and refuses
 * an account already set up (`account_set_up`, which comes back here as
 * null) without spending the link or making a session. The sheet, opened by
 * Get started, never sends it.
 */
export async function spendReleaseLink(key: string, { newAccountOnly = false }: { newAccountOnly?: boolean } = {}): Promise<ReleaseSpend | 'refused' | null> {
  try {
    const res = await fetchSessionMint('/api/auth/release-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(newAccountOnly ? { token: key, newAccountOnly: true } : { token: key }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 422 && data.code === 'invalid_release_link') return 'refused';
    if (!res.ok || !data.ok || typeof data.email !== 'string') return null;
    if (data.next !== 'signed-in' && data.next !== 'set-password') return null;
    return {
      next: data.next,
      email: data.email,
      needsUsername: data.needsUsername === true,
      suggestedUsername: typeof data.suggestedUsername === 'string' ? data.suggestedUsername : '',
    };
  } catch {
    return null;
  }
}

/**
 * The account step's request (#4891): the username when the account has
 * none, and no password (the account signs in with an emailed code, and adds
 * a password in Settings if it wants one; set-password takes a request with
 * none as exactly that). It mints the session, on the person's Continue.
 * The sheet's account step and the full-page Welcome (./welcome-page.tsx)
 * both send it. May throw what fetchSessionMint throws.
 */
export async function saveAccount(handle: string | null): Promise<{ ok: true } | { ok: false; error: string; field: string | null }> {
  const res = await fetchSessionMint('/api/auth/otp/set-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({
      ...(handle ? { username: handle } : {}),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.user) {
    return {
      ok: false,
      error: data.error || translate('auth:signInSheet.account.failed'),
      field: typeof data.field === 'string' ? data.field : null,
    };
  }
  return { ok: true };
}

/**
 * Whether that one-time sign-in is being spent right now, as `onSigningIn`
 * tells it: the open sheet on its `link` step, not on its way down, with
 * nothing gone wrong. It stays true while a spent link that signed straight
 * in finishes (the step is still `link`), and ends at every other outcome:
 * Welcome (the account step), the code a refused or failed spend falls back
 * to (the code or email step), an error that leaves the step where it was
 * (offline, a failed send), and a session the shell could not confirm. So
 * whatever covers the sheet for the moment is never over a step that asks
 * for something, or over the message that says what went wrong.
 */
export function linkSigningIn({ open, step, closing, error, failure }: {
  open: boolean; step: string; closing: boolean; error: string | null; failure: unknown;
}): boolean {
  return open && step === 'link' && !closing && !error && !failure;
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
// The Email code | Password switch (#5258): a grey track, the chosen one a
// white segment on it, as Settings' Light / Dark / System.
const SWITCH_TRACK = 'mt-4 grid grid-cols-2 gap-1 rounded-full bg-zinc-200 p-1 dark:bg-zinc-800';
const SWITCH_ON = 'h-9 rounded-full bg-white text-[15px] font-semibold text-zinc-900 shadow-sm dark:bg-zinc-600 dark:text-zinc-100';
// The code's six boxes (#5253): white cards with the sheets' hairline, the
// one the next digit goes into ringed in the accent while the field has focus.
const CODE_BOX = 'flex h-14 items-center justify-center rounded-xl bg-white text-[24px] font-semibold text-zinc-900 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900 dark:text-zinc-100';
const CODE_BOX_NEXT = 'flex h-14 items-center justify-center rounded-xl bg-white text-[24px] font-semibold text-zinc-900 ring-2 ring-violet-600 dark:bg-zinc-900 dark:ring-violet-400 dark:text-zinc-100';
const MAIL_BUTTON = 'flex h-[50px] w-full items-center justify-center rounded-full bg-violet-50 text-[17px] font-[650] text-violet-700 dark:bg-violet-950/50 dark:text-violet-300';
const SWITCH_OFF = 'h-9 rounded-full text-[15px] font-medium text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100';

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
   * Phone sign-in is offered, but not first: the first step's "Use a phone
   * number instead" leads to the phone step, as "New to Homeroom? Join with
   * your phone" does under an invite's. The signed-out front page's sheets
   * (./landing.tsx).
   */
  phoneLink?: boolean;
  /**
   * The phone step asks "Your name" (a private group's invite: the name makes
   * a provisional handle only that group sees). A public community's invite
   * passes false: the server asks for a username after the code instead.
   */
  askName?: boolean;
  /** Which screen opened it, carried across a provider's trip. */
  from?: 'invite' | 'story' | 'signin';
  /**
   * The way in a button outside the sheet chose (`SignUpButtons`): the email
   * step rather than the first step's choice, or Apple's or Google's sign-in
   * at once. The phone step is `phone`'s.
   */
  start?: SignUpMethod | null;
  /** Where a provider's trip comes back to: Home, or the invite link. */
  returnTo?: string;
  /** Back from a provider: the username step, or what went wrong. */
  resume?: SignInResume | null;
  /** Opened by a waitlist "you're in" link: the token that names the address to sign up with. */
  releaseToken?: string | null;
  /**
   * The same link's one-time sign-in (#4594): spent first, and on success
   * the sheet says "Welcome <address>" and goes straight to the account
   * step. Expired, used or unknown, it falls back to `releaseToken`'s code.
   */
  releaseSignIn?: string | null;
  /**
   * Told when that one-time sign-in starts and stops being spent
   * (`linkSigningIn`), for a screen that draws its own "Signing you in…"
   * over the sheet for that moment (./landing.tsx).
   */
  onSigningIn?: (signingIn: boolean) => void;
  /**
   * Keeps the panel and its dim down while that screen is up, so the step
   * that follows (Welcome, or the code) comes up as the screen goes.
   */
  held?: boolean;
  /**
   * The link was refused before the sheet opened: the story spent it as the
   * page opened and it was already used, or had expired (./landing.tsx). The
   * code step then says why a code came instead, as it does for a link the
   * sheet itself found used.
   */
  linkUsed?: boolean;
  /**
   * Given by a screen that shows the account step itself (the story's
   * full-page Welcome, ./welcome-page.tsx, for a "You're in" link): where the
   * sheet would go on to its own `account` step, after the link or a right
   * code, it hands the account to this instead and the screen closes it.
   */
  onAccount?: (account: AccountStep) => void;
  /**
   * Runs once the session exists and before the shell takes over:
   * 'existing' for an account that signed straight in, 'new' for one that
   * just set its password (in practice, one the code just made). Answers
   * whether the sign-in leads to the make screen: the sheet then stays up,
   * busy, until the shell is ready to draw it, and hands off to it then.
   */
  beforeFinish?: (kind: 'existing' | 'new') => boolean | Promise<boolean>;
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
  open, title, intro = '', followInvite = false, providers = [], native = false, phone = false, phoneLink = false, askName = true, from = 'signin',
  start = null, returnTo = '/', resume = null, releaseToken = null, releaseSignIn = null, onSigningIn, held = false, linkUsed = false, onAccount,
  beforeFinish, onClose, primaryClass,
}: SignInSheetProps) {
  const t = useMessages('auth');
  const otherWays: Step = providers.length ? 'choose' : 'email';
  const firstStep: Step = phone ? 'phone' : start === 'email' ? 'email' : otherWays;
  const [step, setStep] = useState<Step>(firstStep);
  const [email, setEmail] = useState('');
  // The number a code went to, as sent (E.164), and the verify leg's handle.
  const [phoneNumber, setPhoneNumber] = useState('');
  const phoneSession = useRef('');
  // Whose username step this is: a provider's (Apple, Google) or the phone's.
  const [usernameVia, setUsernameVia] = useState<'oauth' | 'phone'>('oauth');
  const [needsUsername, setNeedsUsername] = useState(false);
  // The address a release link signed in (#4594), for the account step's welcome.
  const [welcome, setWelcome] = useState<string | null>(null);
  // The release link was refused (used, or expired): the code step says so,
  // since that is why a code was sent instead.
  const [linkRefused, setLinkRefused] = useState(false);
  // The handle the account step's field arrives holding (#4596): made from
  // the address by the server, or '' for an empty field.
  const [suggestedUsername, setSuggestedUsername] = useState('');
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
  const nameField = useRef<HTMLInputElement>(null);
  const phoneField = useRef<HTMLInputElement>(null);
  // The phone step's two fields in order, for Return, and the name as typed.
  const phoneStepFields = [nameField, phoneField];
  const phoneName = useRef('');
  const phoneCodeField = useRef<HTMLInputElement>(null);
  const identifierField = useRef<HTMLInputElement>(null);
  const currentPasswordField = useRef<HTMLInputElement>(null);
  // The password step's fields in order, for Return (`returnWalks`).
  const passwordStepFields = [identifierField, currentPasswordField];
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
  // Read when they are needed, like the first step: the link's state when
  // the sheet opens, and the account's hand-off when a step gets there.
  const linkUsedRef = useRef(linkUsed);
  linkUsedRef.current = linkUsed;
  const onAccountRef = useRef(onAccount);
  onAccountRef.current = onAccount;
  const releaseSeen = useRef<string | null>(null);
  // The address an email code carried to the password step, for its first field.
  const identifierPrefill = useRef('');
  // The reset step's field, and whether its link went (#5258). What was typed
  // as the username goes to the reset with it and comes back on Back.
  const resetField = useRef<HTMLInputElement>(null);
  const typedIdentifier = useRef('');
  const [resetSent, setResetSent] = useState(false);
  // The code as typed, for its six boxes, whether its field has the caret,
  // and the last code the sixth digit sent, so one code is sent once.
  const [code, setCode] = useState('');
  const [codeFocused, setCodeFocused] = useState(false);
  const autoSent = useRef('');
  // The account step's handle as typed, and what the live check says of it (#5255).
  const [handleDraft, setHandleDraft] = useState('');
  const [handleCheck, setHandleCheck] = useState<UsernameCheck>({ state: 'idle' });

  useEffect(() => {
    // Closed, the link is not "seen" any more: opened again (Get started
    // again, Evan, 10 Oct 2026), it signs in from the email again rather
    // than falling back to a code.
    if (!open) { setShown(false); setLeaving(false); setClosing(false); releaseSeen.current = null; return undefined; }
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
    setWelcome(null);
    setLinkRefused(linkUsedRef.current);
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
    const focus = mayFocusByCodeNow();
    if (step === 'password' && identifierPrefill.current && identifierField.current) {
      identifierField.current.value = identifierPrefill.current;
      identifierPrefill.current = '';
      if (focus) currentPasswordField.current?.focus({ preventScroll: true });
      return;
    }
    // The address typed as the username, when it is one.
    if (step === 'forgot' && resetField.current && typedIdentifier.current.includes('@')) {
      resetField.current.value = typedIdentifier.current;
    }
    const field = step === 'email' ? firstField : step === 'code' ? codeField
      : step === 'forgot' ? resetField
      : step === 'username' ? providerUsernameField
        : step === 'password' ? identifierField
          : step === 'phone' ? (askName ? nameField : phoneField)
            : step === 'phone-code' ? phoneCodeField
              : usernameField;
    if (focus) field.current?.focus({ preventScroll: true });
  }, [open, step, needsUsername]);

  // The account step starts from the handle its field arrives holding.
  useEffect(() => {
    if (open && step === 'account' && needsUsername) setHandleDraft(suggestedUsername);
  }, [open, step, needsUsername, suggestedUsername]);

  // The live "✓ Available" (#5255): asked once typing pauses, and the answer
  // to an older draft is dropped.
  useEffect(() => {
    if (!open || step !== 'account' || !needsUsername) return undefined;
    if (!handleDraft.trim()) { setHandleCheck({ state: 'idle' }); return undefined; }
    setHandleCheck({ state: 'checking' });
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      void checkUsername(handleDraft, abort.signal).then((answer) => { if (!abort.signal.aborted) setHandleCheck(answer); });
    }, USERNAME_CHECK_MS);
    return () => { window.clearTimeout(timer); abort.abort(); };
  }, [open, step, needsUsername, handleDraft]);

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
    if (!value || !value.includes('@')) { setError(translate('auth:signInSheet.email.invalid')); return; }
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
          setError(data.error || translate('auth:signInSheet.email.tooMany'));
          const retryAfter = Number(res.headers.get('Retry-After'));
          setCooldownUntil(Date.now() + (Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter, 900) * 1000 : RESEND_COOLDOWN_MS));
          return;
        }
        setStep('email');
        setError(data.error || translate('auth:signInSheet.email.sendFailed'));
        return;
      }
      if (codeField.current) codeField.current.value = '';
      setCode('');
      autoSent.current = '';
      setStep('code');
      setCooldownUntil(Date.now() + RESEND_COOLDOWN_MS);
      setNow(Date.now());
    } catch {
      setError(translate('auth:signInSheet.networkError'));
    } finally {
      setBusy(false);
    }
  }, []);

  // A waitlist "you're in" link (`releaseToken`): the address its token
  // names, filled in, and the code sent once per tab, exactly what the
  // sign-in screen does for the same link (./login.tsx). A token that names
  // nothing leaves the email step as it is, to be filled in by hand.
  //
  // #4594: a link that also carries its one-time sign-in spends that first.
  // Spent, it is a proven mailbox, like a right code: the account step, with
  // "Welcome <address>", or straight in for an account with nothing to set
  // up. Expired, used or unknown, it is the prefill and the code as before,
  // and the code step says the link was used (Evan, 10 Oct 2026: a second
  // open, in another browser, asked for a code with no reason given).
  //
  // While it is spent the sheet says "Signing you in…" (the `link` step),
  // not the email step with its Send code button, which the first open
  // used to show for the length of the request. The story covers that step
  // with a plain "Signing you in…" screen of its own (`onSigningIn`, `held`;
  // ./landing.tsx SigningIn), and the step after it comes up as that goes:
  // the code, or the story's full-page Welcome (`onAccount`).
  //
  // A new account's link is usually spent before this sheet opens, by the
  // story as the page opens (Evan, 12 Oct 2026). The sheet still spends it
  // on Get started when the story did not: an account already set up, whose
  // link waits for that tap, and the rarer ways the page could not decide
  // or the spend ran long. A link the story found used comes here without
  // its one-time sign-in, and with `linkUsed`: the code, saying why.
  const finishRef = useRef<(kind: 'existing' | 'new') => Promise<void>>(async () => {});
  useEffect(() => {
    const seen = releaseSignIn || releaseToken;
    if (!open || !seen || releaseSeen.current === seen) return undefined;
    releaseSeen.current = seen;
    let live = true;
    setStep(releaseSignIn ? 'link' : 'email');
    const prefill = () => {
      if (!releaseToken) { setStep('email'); return; }
      void releaseArrival(releaseToken).then(arrive);
    };
    if (releaseSignIn) {
      setBusy(true);
      // Not dropped when the sheet re-renders mid-request: the link is spent
      // either way, so its answer must land.
      void spendReleaseLink(releaseSignIn).then(async (spent) => {
        setBusy(false);
        if (spent === 'refused') setLinkRefused(true);
        if (!spent || spent === 'refused') { prefill(); return; }
        setEmail(spent.email);
        if (spent.next === 'signed-in') { await finishRef.current('existing'); return; }
        if (onAccountRef.current) {
          onAccountRef.current({ email: spent.email, needsUsername: spent.needsUsername, suggestedUsername: spent.suggestedUsername });
          return;
        }
        setWelcome(spent.email);
        setNeedsUsername(spent.needsUsername);
        setSuggestedUsername(spent.suggestedUsername);
        setCooldownUntil(0);
        setStep('account');
      });
    } else {
      prefill();
    }
    function arrive(arrival: ReleaseArrival | null) {
      if (!live) return;
      if (!arrival) { setStep('email'); return; }
      setEmail(arrival.address);
      if (firstField.current) firstField.current.value = arrival.address;
      if (!arrival.send) {
        setStep('code');
        setCooldownUntil(arrival.cooldownUntil);
        setNow(Date.now());
        return;
      }
      void requestCode(arrival.address);
    }
    return () => { live = false; };
  }, [open, releaseToken, releaseSignIn, requestCode]);

  // Said to the screen that covers that moment (`onSigningIn`): true as it
  // starts, false as it ends, and false if the sheet goes first.
  const signingIn = linkSigningIn({ open, step, closing, error, failure: completion.failure });
  useEffect(() => {
    if (!signingIn || !onSigningIn) return undefined;
    onSigningIn(true);
    return () => onSigningIn(false);
  }, [signingIn, onSigningIn]);

  // Away to the make screen: the panel goes down while the wallpaper comes
  // up behind it. Resolves once that has had its time. Run by the shell's
  // sign-in once that screen is ready to draw (`finish` below).
  const handOff = useCallback((): Promise<void> => {
    // The keys go down with the sheet (#4597): Continue kept the caret in
    // its field (HOLD_FIELD_FOCUS), and the make screen opens whole, its
    // description waiting for a tap rather than under the keyboard.
    const active = document.activeElement;
    if (active instanceof HTMLElement && panelRef.current?.contains(active)) active.blur();
    setLeaving(true);
    const ms = prefersReducedMotion() ? 0 : HAND_OFF_MS;
    return new Promise((resolve) => { window.setTimeout(resolve, ms); });
  }, []);

  // Every sign-in ends here: what the screen that opened the sheet does
  // first (`beforeFinish`), then the shell's own sign-in. Bound for the make
  // screen, the sheet stays up, busy, through the session read and hands off
  // only once the shell is about to draw it (`beforeShell`): leaving first
  // left the bare wallpaper up for as long as the read took (#4892). A
  // session the shell cannot confirm leaves the sheet where it is, with the
  // notice that says so.
  const finish = useCallback(async (kind: 'existing' | 'new') => {
    clearConfirmation();
    const toMake = (await beforeFinish?.(kind)) === true;
    const opened = await confirmSession(toMake ? handOff : undefined);
    if (!opened) setLeaving(false);
  }, [beforeFinish, handOff, clearConfirmation, confirmSession]);
  finishRef.current = finish;

  const verify = useCallback(async () => {
    setError(null);
    const code = (codeField.current?.value || '').trim();
    if (!code) { setError(translate('auth:signInSheet.code.missing')); return; }
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
          setError(data.error || translate('auth:signInSheet.code.passwordAccount'));
          return;
        }
        setError(res.status === 429
          ? data.error || translate('auth:signInSheet.code.tooManyAttempts')
          : data.error || translate('auth:signInSheet.code.rejected'));
        return;
      }
      if (data.next === 'signed-in') {
        await finish('existing');
        return;
      }
      const suggested = typeof data.suggestedUsername === 'string' ? data.suggestedUsername : '';
      // A "You're in" link's code (one the story found used, say): the
      // story's full-page Welcome, not this sheet's account step.
      if (onAccountRef.current) {
        onAccountRef.current({ email, needsUsername: data.needsUsername === true, suggestedUsername: suggested });
        return;
      }
      setNeedsUsername(data.needsUsername === true);
      setSuggestedUsername(suggested);
      setCooldownUntil(0);
      setStep('account');
    } catch (err) {
      setError(sessionMintFailureMessage(err));
    } finally {
      setBusy(false);
    }
  }, [email, followInvite, finish]);

  // Each keystroke or paste: the digits it can be, in the field and the
  // boxes, and the sixth sends it (#5253). Not again for the same six, so
  // a refused code waits for a change rather than going round.
  const onCodeInput = useCallback((value: string) => {
    const digits = codeDigits(value);
    if (codeField.current && codeField.current.value !== digits) codeField.current.value = digits;
    setCode(digits);
    if (digits.length === CODE_LENGTH && digits !== autoSent.current && !busy) {
      autoSent.current = digits;
      void verify();
    }
  }, [busy, verify]);

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
          setError(data.error || translate('auth:signInSheet.phone.tooMany'));
          setCooldownUntil(Date.now() + RESEND_COOLDOWN_MS);
          setNow(Date.now());
          return;
        }
        setStep('phone');
        setError(data.error || translate('auth:signInSheet.phone.sendFailed'));
        return;
      }
      phoneSession.current = data.sessionInfo;
      setPhoneNumber(value);
      if (phoneCodeField.current) phoneCodeField.current.value = '';
      setStep('phone-code');
      setCooldownUntil(Date.now() + RESEND_COOLDOWN_MS);
      setNow(Date.now());
    } catch {
      setError(translate('auth:signInSheet.networkError'));
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
    if (!name) { setError(translate('auth:signInSheet.phone.nameMissing')); nameField.current?.focus({ preventScroll: true }); return; }
    if (name.length > PHONE_NAME_MAX) { setError(translate('auth:signInSheet.phone.nameTooLong', { count: PHONE_NAME_MAX })); return; }
    phoneName.current = name;
    if (!read.ok) { setError(read.error); return; }
    void requestPhoneCode(read.e164);
  }, [askName, requestPhoneCode]);

  const verifyPhone = useCallback(async () => {
    setError(null);
    const code = (phoneCodeField.current?.value || '').trim();
    if (!code) { setError(translate('auth:signInSheet.phoneCode.missing')); return; }
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
          ? data.error || translate('auth:signInSheet.phoneCode.tooManyAttempts')
          : data.error || translate('auth:signInSheet.phoneCode.rejected'));
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

  // #4891: the account step asks for the username and nothing else. The
  // password was optional (#4595), and still one more decision at the very
  // first step; the account signs in with an emailed code and adds a
  // password in Settings if it wants one (POST /api/me/password, which sets
  // a first password with no current one). set-password takes the request
  // with no password in it as exactly that (`saveAccount`).
  const finishAccount = useCallback(async () => {
    setError(null);
    const handle = needsUsername ? (usernameField.current?.value || '').trim() : null;
    if (handle === '') { setError(translate('auth:signInSheet.account.usernameMissing')); usernameField.current?.focus({ preventScroll: true }); return; }
    if (blockedOffline(setError)) return;
    setBusy(true);
    try {
      const saved = await saveAccount(handle);
      if (!saved.ok) {
        setError(saved.error);
        if (saved.field === 'username') usernameField.current?.focus({ preventScroll: true });
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

  // The reset step: the link that chooses a new password, emailed (#5258).
  const sendResetLink = useCallback(async () => {
    setError(null);
    setDetails(null);
    setResetSent(false);
    if (blockedOffline(setError)) return;
    setBusy(true);
    try {
      const result = await requestPasswordReset(resetField.current?.value || '');
      if (!result.ok) { setError(result.error); return; }
      setResetSent(true);
    } finally {
      setBusy(false);
    }
  }, []);

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

  // Opened by Apple's or Google's button outside the sheet (`start`): that
  // sign-in at once, as the first step's own button would start it. Once per
  // opening, and not when it opens again on the way back from the provider.
  const startedWith = useRef(false);
  useEffect(() => {
    if (!open) { startedWith.current = false; return; }
    if (startedWith.current || resume || (start !== 'apple' && start !== 'google')) return;
    startedWith.current = true;
    void continueWith(start);
  }, [open, start, resume, continueWith]);

  const finishProviderAccount = useCallback(async () => {
    setError(null);
    const handle = (providerUsernameField.current?.value || '').trim();
    if (!handle) { setError(translate('auth:signInSheet.username.missing')); providerUsernameField.current?.focus({ preventScroll: true }); return; }
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
          setError(data.error || translate('auth:signInSheet.username.refused'));
          providerUsernameField.current?.focus({ preventScroll: true });
          return;
        }
        // The continuation is gone: start over from the first step.
        setStep(firstStep);
        setError(data.error || translate('auth:signInSheet.username.expired'));
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

  const methodSwitch = hasMethodSwitch(step, from, phone);
  const toStep = (next: Step) => { setError(null); setDetails(null); setResetSent(false); setStep(next); };

  // The way to a password, where the sheet may be for an account somebody
  // has: under the first step's email, and nothing else under it (#5257).
  const passwordLink = firstStepLine(from, phone) === 'password' ? (
    <p className="text-center text-[13px] text-zinc-500 dark:text-zinc-400">
      <a
        href="#login"
        data-sign-in-sheet-password=""
        onClick={(e) => { e.preventDefault(); setError(null); setDetails(null); setStep('password'); }}
        className="font-medium text-violet-700 dark:text-violet-400 hover:underline"
      >
        {t('auth:signInSheet.withPassword')}
      </a>
    </p>
  ) : null;
  // Under the email step's button: the terms only where the sheet only makes
  // an account (an invite's Join). Elsewhere sending a code makes nothing;
  // the code step, whose right code can, says them (#5257).
  const emailFoot = firstStepLine(from, phone) === 'terms' ? <TermsNotice /> : null;

  // Apple and Google, in the order the server lists them: the first step's
  // own, or under the invite's phone step past an "or".
  const providerButtons = providers.map((provider) => (
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
      {t('auth:signInSheet.continueWith', { provider: PROVIDER_LABEL[provider] })}
    </button>
  ));

  const waitLeft = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));
  const heading = step === 'choose' || step === 'email' || step === 'phone' ? title
    : step === 'link' ? t('auth:signInSheet.link.title')
    : step === 'code' ? t('auth:signInSheet.code.title')
      : step === 'phone-code' ? t('auth:signInSheet.phoneCode.title')
        : step === 'password' ? (methodSwitch ? title : t('auth:signInSheet.password.title'))
          : step === 'forgot' ? t('auth:signInSheet.forgot.title')
          : step === 'username' ? t('auth:signInSheet.username.title')
            : needsUsername && !welcome ? t('auth:signInSheet.account.titleUsername')
              : welcome ? t('auth:signInSheet.account.welcome', { email: welcome }) : t('auth:signInSheet.account.title');
  // The first step says nothing under its title unless it is given a line:
  // "Make your account", "Join Sunday Run Club" and "Sign in" already say
  // it, and the field or the providers come next (#4037). With the phone
  // first, the other ways are for an account made before.
  const sub = step === firstStep
    ? intro
    : step === 'choose'
      ? t('auth:signInSheet.choose.lead')
      : step === 'email'
      ? t('auth:signInSheet.email.lead')
      : step === 'phone-code'
        ? t('auth:signInSheet.phoneCode.lead', { lastDigits: phoneNumber.slice(-4) })
      : step === 'link'
        ? ''
      : step === 'code'
        ? (linkRefused ? t('auth:signInSheet.code.leadLinkUsed', { email }) : '')
        : step === 'password'
          ? (methodSwitch ? '' : t('auth:signInSheet.password.lead'))
          : step === 'forgot'
          ? (resetSent ? '' : t('auth:signInSheet.forgot.lead'))
          : step === 'username'
            ? t('auth:signInSheet.username.lead')
            : (needsUsername ? t('auth:signInSheet.account.leadPublic') : '');
  // Up, on its way up, or leaving for the make screen: whole literals, for
  // the extractor. On a phone it slides; from md, where it is a centred
  // card, it fades. `held`, it stays down under the screen that covers it.
  const up = shown && !held;
  const panelState = leaving
    ? 'pointer-events-none translate-y-full md:-translate-x-1/2 md:-translate-y-1/2 md:opacity-0'
    : up ? 'translate-y-0 md:-translate-x-1/2 md:-translate-y-1/2' : 'translate-y-full md:-translate-x-1/2 md:-translate-y-1/2';
  const close = leaving ? undefined : requestClose;
  const mailApp = step === 'code' ? mailAppFor(email) : null;

  return (
    <div data-sign-in-sheet={step} data-sign-in-sheet-leaving={leaving ? '' : undefined} data-sign-in-sheet-closing={closing ? '' : undefined} className="fixed inset-0 z-50">
      {/* The dim takes no pan, so a drag on it does not scroll the story
          behind (the kit's backdrop rule); its tap still closes. */}
      <div
        aria-hidden="true"
        onClick={close}
        className={`absolute inset-0 touch-none bg-black/40 transition-opacity duration-200 motion-reduce:transition-none ${up ? 'opacity-100' : 'opacity-0'}`}
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
        {step === 'forgot' ? (
          <button type="button" data-sign-in-sheet-forgot-back="" className={`${QUIET} mt-2 -ml-1 flex items-center gap-0.5`} onClick={() => { identifierPrefill.current = typedIdentifier.current; toStep('password'); }}>
            <ChevronLeftIcon className="h-4 w-4" aria-hidden="true" />{t('auth:signInSheet.forgot.back')}
          </button>
        ) : null}
        <div className="mt-3 flex items-center gap-3">
          <h2 id="sign-in-sheet-title" className="min-w-0 flex-1 break-words text-[17px] font-semibold text-zinc-900 dark:text-zinc-100">{heading}</h2>
          <button
            type="button"
            onClick={close}
            aria-label={t('core:common.close')}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
          >
            <XIcon className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        {sub ? <p className="mt-1 text-[15px] leading-snug text-zinc-500 dark:text-zinc-400">{sub}</p> : null}
        {methodSwitch ? (
          <div role="radiogroup" aria-label={t('auth:signInSheet.method.label')} data-sign-in-sheet-method="" className={SWITCH_TRACK}>
            <button type="button" role="radio" aria-checked={step === 'email'} data-sign-in-sheet-method-email="" className={step === 'email' ? SWITCH_ON : SWITCH_OFF} onClick={() => { if (step !== 'email') toStep('email'); }}>
              {t('auth:signInSheet.method.emailCode')}
            </button>
            <button type="button" role="radio" aria-checked={step === 'password'} data-sign-in-sheet-method-password="" className={step === 'password' ? SWITCH_ON : SWITCH_OFF} onClick={() => { if (step !== 'password') toStep('password'); }}>
              {t('auth:signInSheet.method.password')}
            </button>
          </div>
        ) : null}

        {step === 'choose' ? (
          <div className="mt-5 flex flex-col gap-2.5">
            {providerButtons}
            {/* Apple and Google make an account in one tap, so their terms sit under them (#5257). */}
            <TermsNotice />
            <div data-sign-in-sheet-or="" className="flex items-center gap-3 text-[13px] text-zinc-500 dark:text-zinc-400">
              <span aria-hidden="true" className="h-px flex-1 bg-[color:var(--app-sheet-line)]" />
              {t('auth:signInSheet.or')}
              <span aria-hidden="true" className="h-px flex-1 bg-[color:var(--app-sheet-line)]" />
            </div>
            <form className="flex flex-col gap-2.5" onSubmit={(e) => { e.preventDefault(); void requestCode(firstField.current?.value || ''); }}>
              <div className={FIELD_GROUP}>
                <div className={FIELD}>
                  <label htmlFor="sign-in-sheet-email" className={LABEL}>{t('auth:signInSheet.email.label')}</label>
                  <input ref={firstField} id="sign-in-sheet-email" type="email" autoComplete="email" inputMode="email" enterKeyHint="go" defaultValue={email} className={INPUT} {...HANDLE_FIELD} />
                </div>
              </div>
              <button type="submit" data-sign-in-provider="email" disabled={busy} className={EMAIL_BUTTON} {...HOLD_FIELD_FOCUS}>
                {busy ? t('auth:signInSheet.email.sending') : t('auth:signInSheet.continueWithEmail')}
              </button>
            </form>
            {phone || phoneLink ? (
              <button type="button" data-sign-in-sheet-to-phone="" className={QUIET} onClick={() => { setError(null); setStep('phone'); }}>{phone ? t('auth:signInSheet.toPhone') : t('auth:signInSheet.toPhoneLink')}</button>
            ) : null}
            {passwordLink}
          </div>
        ) : null}

        {step === 'email' ? (
          <form className="mt-5 flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void requestCode(firstField.current?.value || ''); }}>
            <div className={FIELD_GROUP}>
              <div className={FIELD}>
                <label htmlFor="sign-in-sheet-email" className={LABEL}>{t('auth:signInSheet.email.label')}</label>
                <input ref={firstField} id="sign-in-sheet-email" type="email" autoComplete="email" inputMode="email" enterKeyHint="go" defaultValue={email} className={INPUT} {...HANDLE_FIELD} />
              </div>
            </div>
            <button type="submit" disabled={busy} className={`${primaryClass} disabled:opacity-60`} {...HOLD_FIELD_FOCUS}>{busy ? t('auth:signInSheet.email.sending') : t('auth:signInSheet.email.send')}</button>
            {emailFoot}
            {providers.length ? (
              <button type="button" className={QUIET} onClick={() => { setError(null); setStep('choose'); }}>{t('auth:signInSheet.email.otherWays')}</button>
            ) : null}
            {phone || phoneLink ? (
              <button type="button" data-sign-in-sheet-to-phone="" className={QUIET} onClick={() => { setError(null); setStep('phone'); }}>{phone ? t('auth:signInSheet.toPhone') : t('auth:signInSheet.toPhoneLink')}</button>
            ) : null}
          </form>
        ) : null}

        {step === 'phone' ? (
          <form className="mt-5 flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void submitPhoneStep(); }}>
            {askName ? (
              <p data-sign-in-sheet-name-note="" className="text-[13px] text-zinc-500 dark:text-zinc-400">{t('auth:signInSheet.phone.namePrivate')}</p>
            ) : null}
            <div className={FIELD_GROUP}>
              {askName ? (
                <div className={FIELD}>
                  <label htmlFor="sign-in-sheet-name" className={LABEL}>{t('auth:signInSheet.phone.nameLabel')}</label>
                  <input ref={nameField} id="sign-in-sheet-name" type="text" autoComplete="name" enterKeyHint="next" maxLength={PHONE_NAME_MAX} defaultValue={phoneName.current} onKeyDown={returnWalks(phoneStepFields, 0)} className={INPUT} />
                </div>
              ) : null}
              <div className={FIELD}>
                <label htmlFor="sign-in-sheet-phone" className={LABEL}>{t('auth:signInSheet.phone.numberLabel')}</label>
                <PhoneInput inputRef={phoneField} id="sign-in-sheet-phone" defaultValue={phoneNumber} />
              </div>
            </div>
            <button type="submit" disabled={busy} className={`${primaryClass} disabled:opacity-60`} {...HOLD_FIELD_FOCUS}>{busy ? t('auth:signInSheet.phone.sending') : t('auth:signInSheet.phone.send')}</button>
          </form>
        ) : null}

        {step === 'phone-code' ? (
          <form className="mt-5 flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void verifyPhone(); }}>
            <div className={FIELD_GROUP}>
              <div className={FIELD}>
                <label htmlFor="sign-in-sheet-phone-code" className={LABEL}>{t('auth:signInSheet.phoneCode.label')}</label>
                <input ref={phoneCodeField} id="sign-in-sheet-phone-code" {...ONE_TIME_CODE_FIELD} enterKeyHint="go" maxLength={6} className={`${INPUT} tracking-[0.4em]`} />
              </div>
            </div>
            <button type="submit" disabled={busy} className={`${primaryClass} disabled:opacity-60`} {...HOLD_FIELD_FOCUS}>{busy ? t('auth:signInSheet.phoneCode.checking') : t('auth:signInSheet.phoneCode.submit')}</button>
            <div className="flex items-center justify-between">
              <button type="button" className={QUIET} onClick={() => { setError(null); setStep('phone'); }}>{t('auth:signInSheet.phoneCode.changeNumber')}</button>
              <button type="button" className={`${QUIET} disabled:text-zinc-500 disabled:dark:text-zinc-400 disabled:no-underline`} disabled={busy || waitLeft > 0} onClick={() => { void requestPhoneCode(phoneNumber); }}>
                {waitLeft > 0 ? t('auth:signInSheet.phoneCode.resendIn', { count: waitLeft }) : t('auth:signInSheet.phoneCode.resend')}
              </button>
            </div>
          </form>
        ) : null}

        {step === 'username' ? (
          <form className="mt-5 flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void finishProviderAccount(); }}>
            <div className={FIELD_GROUP}>
              <div className={FIELD}>
                <label htmlFor="sign-in-sheet-provider-username" className={LABEL}>{t('auth:signInSheet.username.label')}</label>
                <input ref={providerUsernameField} id="sign-in-sheet-provider-username" autoComplete="username" enterKeyHint="go" className={INPUT} placeholder={t('auth:signInSheet.providerUsernamePlaceholder')} {...HANDLE_FIELD} />
              </div>
            </div>
            <button type="submit" disabled={busy} className={`${primaryClass} disabled:opacity-60`} {...HOLD_FIELD_FOCUS}>{busy ? <><FinishingSpinner />{t('auth:signInSheet.username.finishing')}</> : t('auth:signInSheet.username.submit')}</button>
          </form>
        ) : null}

        {step === 'code' ? (
          <form className="mt-1 flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void verify(); }}>
            {/* Where it went, and the way to fix a typo in it, on one line. */}
            <p data-sign-in-sheet-sent-to="" className="break-words text-[15px] leading-snug text-zinc-500 dark:text-zinc-400">
              <RichMessage id="auth:signInSheet.code.sentTo" values={{ email }} components={[
              <strong className="font-semibold text-zinc-900 dark:text-zinc-100" />,
              <button type="button" className="font-medium text-violet-700 dark:text-violet-400 hover:underline" onClick={() => { setError(null); setLinkRefused(false); setStep('email'); }} />,
              ]} />
            </p>
            {/* Six boxes drawn under one real field: the keyboard's code from the mail, and a paste, fill all six. */}
            <div className="relative mt-2">
              <div className="grid grid-cols-6 gap-2" aria-hidden="true">
                {Array.from({ length: CODE_LENGTH }, (_, i) => (
                  <span key={i} data-sign-in-sheet-code-box={i} className={codeFocused && i === Math.min(code.length, CODE_LENGTH - 1) ? CODE_BOX_NEXT : CODE_BOX}>{code[i] || ''}</span>
                ))}
              </div>
              <label htmlFor="sign-in-sheet-code" className="sr-only">{t('auth:signInSheet.code.label')}</label>
              <input ref={codeField} id="sign-in-sheet-code" {...ONE_TIME_CODE_FIELD} enterKeyHint="go" maxLength={6} onInput={(e) => onCodeInput(e.currentTarget.value)} onFocus={() => setCodeFocused(true)} onBlur={() => setCodeFocused(false)} className="absolute inset-0 h-full w-full border-0 bg-transparent text-transparent caret-transparent outline-none selection:bg-transparent" />
            </div>
            <p className="text-[13px] text-zinc-500 dark:text-zinc-400">{busy ? t('auth:signInSheet.code.checking') : t('auth:signInSheet.code.continuesItself')}</p>
            {mailApp ? (
              <a href={mailApp.url} target="_blank" rel="noopener noreferrer" data-sign-in-sheet-open-mail="" className={MAIL_BUTTON}>{t('auth:signInSheet.code.openMail', { app: mailApp.name })}</a>
            ) : null}
            <div className="flex items-center justify-between">
              <span className="text-[15px] text-zinc-500 dark:text-zinc-400">{t('auth:signInSheet.code.checkSpam')}</span>
              <button type="button" className={`${QUIET} disabled:text-zinc-500 disabled:dark:text-zinc-400 disabled:no-underline`} disabled={busy || waitLeft > 0} onClick={() => { void requestCode(email); }}>
                {waitLeft > 0 ? t('auth:signInSheet.code.resendIn', { count: waitLeft }) : t('auth:signInSheet.code.resend')}
              </button>
            </div>
          </form>
        ) : null}

        {step === 'password' ? (
          <form className="mt-5 flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void signInWithPassword(); }}>
            <div className={FIELD_GROUP}>
              <div className={FIELD}>
                <label htmlFor="sign-in-sheet-identifier" className={LABEL}>{t('auth:signInSheet.password.identifierLabel')}</label>
                <input ref={identifierField} id="sign-in-sheet-identifier" name="username" type="text" required autoComplete="username" enterKeyHint="next" onKeyDown={returnWalks(passwordStepFields, 0)} className={INPUT} {...HANDLE_FIELD} />
              </div>
              <div className={FIELD}>
                <label htmlFor="sign-in-sheet-current-password" className={LABEL}>{t('auth:signInSheet.password.label')}</label>
                <PasswordInput ref={currentPasswordField} id="sign-in-sheet-current-password" name="password" required autoComplete="current-password" enterKeyHint="go" box="card" hint="dim" ring="bare" />
              </div>
            </div>
            <button type="submit" disabled={busy} className={`${primaryClass} disabled:opacity-60`} {...HOLD_FIELD_FOCUS}>{busy ? t('auth:signInSheet.password.signingIn') : t('auth:signInSheet.password.submit')}</button>
            <div className="flex items-center justify-between">
              {/* Picking Password is choosing how to sign in, so this step offers no way back to
                  Apple and Google: closing the sheet does that (#5616). Without the switch, the
                  email code is the one other way, and the link goes to that step. */}
              {!methodSwitch ? (
                <button type="button" className={QUIET} onClick={() => toStep('email')}>
                  {t('auth:signInSheet.password.useEmailCode')}
                </button>
              ) : <span aria-hidden="true" />}
              {/* The reset opens here, in the sheet (#5258), not on the sign-in screen's own page. */}
              <button type="button" data-sign-in-sheet-forgot="" className={QUIET} onClick={() => { typedIdentifier.current = (identifierField.current?.value || '').trim(); toStep('forgot'); }}>{t('auth:signInSheet.password.forgot')}</button>
            </div>
          </form>
        ) : null}

        {step === 'forgot' ? (
          <form className="mt-5 flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void sendResetLink(); }}>
            <div className={FIELD_GROUP}>
              <div className={FIELD}>
                <label htmlFor="sign-in-sheet-reset-email" className={LABEL}>{t('auth:signInSheet.forgot.label')}</label>
                <input ref={resetField} id="sign-in-sheet-reset-email" type="email" autoComplete="email" inputMode="email" enterKeyHint="send" className={INPUT} {...HANDLE_FIELD} />
              </div>
            </div>
            {resetSent ? (
              <p role="status" data-sign-in-sheet-reset-sent="" className="text-[14px] font-medium text-green-700 dark:text-green-400">{t('auth:signInSheet.forgot.sent')}</p>
            ) : null}
            <button type="submit" disabled={busy} className={`${primaryClass} disabled:opacity-60`} {...HOLD_FIELD_FOCUS}>{busy ? t('auth:signInSheet.forgot.sending') : t('auth:signInSheet.forgot.submit')}</button>
            {/* The way out that needs no password at all (#5259): the email step, with the address carried over. */}
            <button type="button" data-sign-in-sheet-forgot-code="" className={MAIL_BUTTON} onClick={() => { const typed = (resetField.current?.value || '').trim(); if (typed.includes('@')) setEmail(typed.toLowerCase()); toStep('email'); }}>{t('auth:signInSheet.forgot.withCode')}</button>
            {/* Only once a link went: before then nobody has a problem to read about (#5259). */}
            {resetSent ? (
              <p data-sign-in-sheet-reset-support="" className="text-center text-[13px] text-zinc-500 dark:text-zinc-400">{t('auth:signInSheet.forgot.support')}</p>
            ) : null}
          </form>
        ) : null}

        {step === 'account' ? (
          <form className="mt-5 flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void finishAccount(); }}>
            {needsUsername ? (
              <>
                <div className={FIELD_GROUP}>
                  <div className={FIELD}>
                    <label htmlFor="sign-in-sheet-username" className={LABEL}>{t('auth:signInSheet.account.usernameLabel')}</label>
                    {/* The @ the name wears everywhere else (#5255), outside the field so it is never sent. */}
                    <div className="flex items-baseline">
                      <span aria-hidden="true" className="text-[17px] text-zinc-500 dark:text-zinc-400">@</span>
                      <input ref={usernameField} id="sign-in-sheet-username" defaultValue={suggestedUsername} autoComplete="username" enterKeyHint="go" className={INPUT} onInput={(e) => setHandleDraft(e.currentTarget.value)} aria-describedby="sign-in-sheet-username-check" placeholder={t('auth:signInSheet.usernamePlaceholder')} {...HANDLE_FIELD} />
                    </div>
                  </div>
                </div>
                {/* Whether it is free, live, and the rules, on one line under the field. */}
                <div id="sign-in-sheet-username-check" aria-live="polite" className="flex items-baseline justify-between gap-3 text-[13px]">
                  {handleCheck.state === 'available' ? (
                    <span data-sign-in-sheet-username-check="available" className="font-semibold text-green-700 dark:text-green-400">{t('auth:signInSheet.account.available')}</span>
                  ) : handleCheck.state === 'taken' ? (
                    <span data-sign-in-sheet-username-check="taken" className="text-red-600 dark:text-red-400">{handleCheck.error || t('auth:signInSheet.account.taken')}</span>
                  ) : handleCheck.state === 'checking' ? (
                    <span data-sign-in-sheet-username-check="checking" className="text-zinc-500 dark:text-zinc-400">{t('auth:signInSheet.account.checking')}</span>
                  ) : <span />}
                  <span className="shrink-0 text-zinc-500 dark:text-zinc-400">{t('auth:signInSheet.account.rules')}</span>
                </div>
                {/* How the name will look beside what they suggest and vote on. */}
                {handleDraft.trim() ? (
                  <div data-sign-in-sheet-username-preview="" className="rounded-2xl bg-white px-4 py-3 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900">
                    <p className="text-[12px] font-bold uppercase tracking-[0.06em] text-zinc-500 dark:text-zinc-400">{t('auth:signInSheet.account.previewLabel')}</p>
                    <div className="mt-2 flex items-center gap-3">
                      <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-violet-100 text-[15px] font-semibold text-violet-700 dark:bg-violet-950 dark:text-violet-300">{handleDraft.trim().charAt(0).toUpperCase()}</span>
                      <div className="min-w-0">
                        <p className="truncate text-[15px] font-[650] text-zinc-900 dark:text-zinc-100">@{handleDraft.trim()}</p>
                        <p className="text-[13px] text-zinc-500 dark:text-zinc-400">{t('auth:signInSheet.account.previewLine')}</p>
                      </div>
                    </div>
                  </div>
                ) : null}
              </>
            ) : null}
            <button type="submit" disabled={busy} className={`${primaryClass} disabled:opacity-60`} {...HOLD_FIELD_FOCUS}>{busy ? <><FinishingSpinner />{t('auth:signInSheet.account.finishing')}</> : needsUsername ? t('auth:signInSheet.account.create') : t('auth:signInSheet.account.submit')}</button>
            {/* No password here (#4891): how they sign in, and where a password is added, under the button (#5255) so the field's own line is free for what is wrong with it. */}
            <p data-sign-in-sheet-code-note="" className="text-[13px] text-zinc-500 dark:text-zinc-400">{t('auth:signInSheet.account.codeNote')}</p>
          </form>
        ) : null}

        {error ? (
          <div role="alert" className="mt-3 text-[14px] text-red-600 dark:text-red-400">
            {error}
            <NativeLoginDetailsLink details={details} />
          </div>
        ) : null}
        <SessionConfirmationNotice completion={completion} />

        {step === 'phone' && providers.length ? (
          <div data-sign-in-sheet-providers="" className="mt-4 flex flex-col gap-2.5">
            <div data-sign-in-sheet-or="" className="flex items-center gap-3 text-[13px] text-zinc-500 dark:text-zinc-400">
              <span aria-hidden="true" className="h-px flex-1 bg-[color:var(--app-sheet-line)]" />
              {t('auth:signInSheet.or')}
              <span aria-hidden="true" className="h-px flex-1 bg-[color:var(--app-sheet-line)]" />
            </div>
            {providerButtons}
          </div>
        ) : null}
        {step === 'phone' ? (
          <p className="mt-4 text-center text-[13px] text-zinc-500 dark:text-zinc-400">
            <RichMessage id="auth:signInSheet.phone.haveAccount" components={[
            <a
              href="#login"
              data-sign-in-sheet-to-email=""
              onClick={(e) => { e.preventDefault(); setError(null); setDetails(null); setStep('email'); }}
              className="font-medium text-violet-700 dark:text-violet-400 hover:underline"
            />,
              ]} />
          </p>
        ) : null}
        {/* The first step's terms sit in its group (above); every later step that can make an account keeps them here. */}
        {step === 'choose' || step === 'email' || !stepSaysTerms(step) ? null : (
          <TermsNotice className="mt-3" recaptcha={step === 'phone' || step === 'phone-code' ? RECAPTCHA_LINE : null} />
        )}
      </div>
    </div>
  );
}
