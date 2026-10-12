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
 *   account  POST /api/auth/otp/set-password: the username when the account
 *            has none, which mints the session. No password (#4891): the
 *            account signs in with an emailed code, and adds a password in
 *            Settings if it wants one.
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
 * Under the phone step, past an "or", Continue with Apple and Continue with
 * Google when an admin has set them up (the same buttons as the first step's
 * otherwise), then "Already on Homeroom? Sign in with email", for an account
 * made before; one made by email from here is not a private member and
 * waits in the queue. That step still leads on to "Sign in with a password".
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
import { AppleIcon, GoogleIcon, SpinnerArcIcon, XIcon } from '@/components/ui/icons';
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

type Step = 'choose' | 'email' | 'code' | 'account' | 'username' | 'password' | 'phone' | 'phone-code' | 'link';

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
 * says "Finishing…".
 */
function FinishingSpinner() {
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

/** A waitlist "you're in" link's one-time sign-in, spent (#4594). */
export type ReleaseSpend = {
  next: 'signed-in' | 'set-password'; email: string; needsUsername: boolean; suggestedUsername: string;
};

/**
 * Spend the release mail's one-time sign-in link (src/services/release-links.js)
 * with a POST, never on the GET that opened the page, so a mail scanner's
 * prefetch cannot use it up. 'refused' when the server says the link is
 * expired, used or unknown; null on anything else (offline, a server
 * error). Either way the sheet falls back to the address and a code, and a
 * refused link says why.
 */
export async function spendReleaseLink(key: string): Promise<ReleaseSpend | 'refused' | null> {
  try {
    const res = await fetchSessionMint('/api/auth/release-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ token: key }),
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
  open, title, intro = '', followInvite = false, providers = [], native = false, phone = false, askName = true, from = 'signin',
  returnTo = '/', resume = null, releaseToken = null, releaseSignIn = null, onSigningIn, held = false, beforeFinish, onClose, primaryClass,
}: SignInSheetProps) {
  const t = useMessages('auth');
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
  const releaseSeen = useRef<string | null>(null);
  // The address an email code carried to the password step, for its first field.
  const identifierPrefill = useRef('');

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
    setLinkRefused(false);
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
    const field = step === 'email' ? firstField : step === 'code' ? codeField
      : step === 'username' ? providerUsernameField
        : step === 'password' ? identifierField
          : step === 'phone' ? (askName ? nameField : phoneField)
            : step === 'phone-code' ? phoneCodeField
              : usernameField;
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
  // ./landing.tsx SigningIn), and the step after it comes up as that goes.
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
      setNeedsUsername(data.needsUsername === true);
      setSuggestedUsername(typeof data.suggestedUsername === 'string' ? data.suggestedUsername : '');
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
  // with no password in it as exactly that.
  const finishAccount = useCallback(async () => {
    setError(null);
    const handle = needsUsername ? (usernameField.current?.value || '').trim() : null;
    if (handle === '') { setError(translate('auth:signInSheet.account.usernameMissing')); usernameField.current?.focus({ preventScroll: true }); return; }
    if (blockedOffline(setError)) return;
    setBusy(true);
    try {
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
        setError(data.error || translate('auth:signInSheet.account.failed'));
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

  const oneLine = firstStepLine(from, phone) === 'password' ? (
    <>
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
      <TermsNotice />
    </>
  ) : <TermsNotice />;

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
        : step === 'password' ? t('auth:signInSheet.password.title')
          : step === 'username' ? t('auth:signInSheet.username.title')
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
        ? (linkRefused ? t('auth:signInSheet.code.leadLinkUsed', { email }) : t('auth:signInSheet.code.lead', { email }))
        : step === 'password'
          ? t('auth:signInSheet.password.lead')
          : step === 'username'
            ? t('auth:signInSheet.username.lead')
            : (needsUsername ? t('auth:signInSheet.account.leadWithUsername') : '');
  // Up, on its way up, or leaving for the make screen: whole literals, for
  // the extractor. On a phone it slides; from md, where it is a centred
  // card, it fades. `held`, it stays down under the screen that covers it.
  const up = shown && !held;
  const panelState = leaving
    ? 'pointer-events-none translate-y-full md:-translate-x-1/2 md:-translate-y-1/2 md:opacity-0'
    : up ? 'translate-y-0 md:-translate-x-1/2 md:-translate-y-1/2' : 'translate-y-full md:-translate-x-1/2 md:-translate-y-1/2';
  const close = leaving ? undefined : requestClose;

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

        {step === 'choose' ? (
          <div className="mt-5 flex flex-col gap-2.5">
            {providerButtons}
            <button type="button" data-sign-in-provider="email" disabled={busy} className={EMAIL_BUTTON} onClick={() => { setError(null); setStep('email'); }}>
              {t('auth:signInSheet.continueWithEmail')}
            </button>
            {phone ? (
              <button type="button" data-sign-in-sheet-to-phone="" className={QUIET} onClick={() => { setError(null); setStep('phone'); }}>{t('auth:signInSheet.toPhone')}</button>
            ) : null}
            {oneLine}
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
            {oneLine}
            {providers.length ? (
              <button type="button" className={QUIET} onClick={() => { setError(null); setStep('choose'); }}>{t('auth:signInSheet.email.otherWays')}</button>
            ) : null}
            {phone ? (
              <button type="button" data-sign-in-sheet-to-phone="" className={QUIET} onClick={() => { setError(null); setStep('phone'); }}>{t('auth:signInSheet.toPhone')}</button>
            ) : null}
          </form>
        ) : null}

        {step === 'phone' ? (
          <form className="mt-5 flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void submitPhoneStep(); }}>
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
            <p className="text-[13px] text-zinc-500 dark:text-zinc-400">{t('auth:signInSheet.phoneCode.autofill')}</p>
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
          <form className="mt-5 flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void verify(); }}>
            <div className={FIELD_GROUP}>
              <div className={FIELD}>
                <label htmlFor="sign-in-sheet-code" className={LABEL}>{t('auth:signInSheet.code.label')}</label>
                <input ref={codeField} id="sign-in-sheet-code" {...ONE_TIME_CODE_FIELD} enterKeyHint="go" maxLength={6} className={`${INPUT} tracking-[0.4em]`} />
              </div>
            </div>
            <button type="submit" disabled={busy} className={`${primaryClass} disabled:opacity-60`} {...HOLD_FIELD_FOCUS}>{busy ? t('auth:signInSheet.code.checking') : t('auth:signInSheet.code.submit')}</button>
            <div className="flex items-center justify-between">
              <button type="button" className={QUIET} onClick={() => { setError(null); setLinkRefused(false); setStep('email'); }}>{t('auth:signInSheet.code.changeEmail')}</button>
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
              <button type="button" className={QUIET} onClick={() => { setError(null); setDetails(null); setStep(otherWays); }}>
                {providers.length ? t('auth:signInSheet.password.otherWays') : t('auth:signInSheet.password.useEmailCode')}
              </button>
              {/* The reset is the sign-in screen's (./login.tsx), reached by its own address. */}
              <a href="#login/forgot" onClick={() => { if (followInvite) rememberInviteJoin(); onClose(); }} className={QUIET}>{t('auth:signInSheet.password.forgot')}</a>
            </div>
          </form>
        ) : null}

        {step === 'account' ? (
          <form className="mt-5 flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void finishAccount(); }}>
            {needsUsername ? (
              <div className={FIELD_GROUP}>
                <div className={FIELD}>
                  <label htmlFor="sign-in-sheet-username" className={LABEL}>{t('auth:signInSheet.account.usernameLabel')}</label>
                  <input ref={usernameField} id="sign-in-sheet-username" defaultValue={suggestedUsername} autoComplete="username" enterKeyHint="go" className={INPUT} placeholder={t('auth:signInSheet.usernamePlaceholder')} {...HANDLE_FIELD} />
                </div>
              </div>
            ) : null}
            {/* No password here (#4891): how they sign in, and where a password is added. */}
            <p data-sign-in-sheet-code-note="" className="text-[13px] text-zinc-500 dark:text-zinc-400">{t('auth:signInSheet.account.codeNote')}</p>
            <button type="submit" disabled={busy} className={`${primaryClass} disabled:opacity-60`} {...HOLD_FIELD_FOCUS}>{busy ? <><FinishingSpinner />{t('auth:signInSheet.account.finishing')}</> : t('auth:signInSheet.account.submit')}</button>
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
        {/* The first step's terms sit in its group (above); every later step keeps them here. */}
        {step === 'choose' || step === 'email' ? null : (
          <TermsNotice className="mt-3" recaptcha={step === 'phone' || step === 'phone-code' ? RECAPTCHA_LINE : null} />
        )}
      </div>
    </div>
  );
}
