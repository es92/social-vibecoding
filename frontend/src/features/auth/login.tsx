/**
 * `#auth-login-screen` — the password form plus the three sub-views that share
 * its card (#1080, step 2 chunk C, screen 2 of 6).
 *
 * One screen element, four views, exactly as `public/js/auth-screens.js` had
 * it: `#login` shows the password form (with the optional wallet fast path
 * above it), `#signup` opens `#otp-view` (the email-code path, which is also
 * the account-creation path), "Forgot password?" opens `#recovery-view`, and
 * `#reset-password/<token>` opens `#reset-password-view`. The router calls one
 * per-route hook per navigation and the hook picks the view; here that is a
 * single `view` state and every `hidden` below is derived from it, so the four
 * views cannot be open at once no matter which order the hooks fire in.
 *
 * ── Like-for-like, including what is NOT in the shipped markup ─────────
 *
 * The ids, class strings, `hidden` semantics and `data-*` attributes are the
 * hand-written shell's, because `dapp.json` selects on them
 * (`body.is-offline #auth-login-screen:not(.hidden) .offline-only`) and
 * `public/css/app.css` styles `[data-offline-disabled]` / `.offline-only` /
 * `[data-auth-back]` by attribute.
 *
 * Two blocks are deliberately NOT in the initial render: `#recovery-email` (the
 * emailed-reset request form) and `#reset-password-view` (the redeem view the
 * emailed link lands on). `_ensureResetUi()` built both at runtime because the
 * shell's markup was frozen when the email reset shipped, and they stay out of
 * the prerendered document for the same reason it matters here: the id baseline
 * (`tests/baselines/shell-markup.json`) records what the hand-written shell
 * shipped, and this chunk is a conversion, not a markup change. So `resetUi`
 * starts false and flips on the first `ensureResetUi()` — the same trigger, the
 * same insertion points, the same class strings, and it also swaps
 * `#recovery-admin`'s lead paragraph to the "no confirmed email?" copy the way
 * the runtime build did.
 *
 * ── Inputs are uncontrolled ───────────────────────────────────────────
 *
 * Every field is read by ref on submit, never bound to state. React renders
 * `value=""` for a controlled input, which would show up in the prerendered
 * markup; the shipped markup has no `value` attribute, and a credential field
 * has no reason to re-render the screen per keystroke.
 *
 * ── Return walks each step's fields (#3907) ───────────────────────────
 *
 * The iOS app no longer shows the keyboard's up/down chevrons, so Return is
 * the way from one field to the next: each form and step carries
 * `returnKeyHandler` (lib/return-to-next.ts) on its container and an
 * `enterKeyHint` on every field ("next" until the last, which says what it
 * does). The password form and the reset view are real forms and submit
 * themselves from their last field; the code steps and the recovery views
 * are not, and their last field runs the step's own button.
 *
 * ── One documented behaviour difference ───────────────────────────────
 *
 * The wallet block's visibility is derived (`view === 'base' && walletUi`)
 * rather than written when the probe resolves. The legacy probe unhid
 * `#wallet-auth` whenever `#otp-view` and `#recovery-view` happened to be
 * hidden at that moment — which included the reset view, so a probe that
 * resolved while `#reset-password/<token>` was open dropped the wallet block on
 * top of it. Deriving it cannot do that.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { alertVariants } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { KeyIcon, WarningTriangleIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Wordmark } from '@/components/ui/wordmark';

import { useMountedOnReveal } from '../../lib/mount-on-reveal';
import { returnKeyHandler } from '../../lib/return-to-next';
import { useVisibilityHiddenClass } from '../../lib/visibility-store';
import { AuthBackButton, backToLanding } from './back-button';
import { NativeLoginDetailsLink } from './native-login-details';
import { SessionConfirmationNotice, useSessionConfirmation } from './session-confirmation';
import { TermsNotice } from './waitlist-shared';
import {
  AUTH_SCREEN_IDS,
  blockedOffline,
  fetchSessionMint,
  HANDLE_FIELD,
  hiddenFirst,
  hiddenLast,
  isNative,
  legacy,
  NativeLoginPreparationError,
  type NativeLoginFailureDetails,
  passwordSignIn,
  sessionMintFailureMessage,
  takeReleaseLink,
  useAuthScreensPatch,
  USERNAME_PUBLIC_NOTE,
  USERNAME_RULE,
} from './shared';

/** Which of the four views on this screen is showing. */
type LoginView = 'base' | 'otp' | 'recovery' | 'reset';

/** The forgot-password view's own address (QA 2026-09-24 Q16). */
const RECOVERY_ROUTE = 'login/forgot';
/** Marks the history entry the card pushed for it. */
const RECOVERY_ENTRY = 'loginRecovery';

/** Step within `#otp-view`. */
type OtpStep = 'email' | 'code' | 'password';

/**
 * What /api/auth/otp/verify said about the account behind a verified code,
 * for the set-password step (QA 2026-09-24 Q12). Null until a code verifies,
 * and for a server that predates the fields, which then reads exactly as it
 * always did.
 */
interface OtpSignup {
  /** The code just CREATED the account: no account used this address. */
  created: boolean;
  /**
   * The account has never chosen its handle, so this step asks for it. The
   * server will not finish the step without one.
   */
  needsUsername: boolean;
  /**
   * #4596: the handle the field arrives holding, made from the address by
   * the server and free when it was read; '' for an empty field. The person
   * can change it.
   */
  suggestedUsername: string;
  /** It will land in the waiting room; null when the server could not tell. */
  waitlisted: boolean | null;
}

// The set-password step's opening line, one per case. A brand-new account is
// told that is what is happening: it used to read "Now choose a password for
// your account" as if the account had been there all along.
const OTP_PASSWORD_INTRO = 'Code verified. Now choose a password for your account.';
const OTP_PASSWORD_INTRO_NEW =
  "Code verified. No account uses this email yet, so we'll create one. Choose a username and a password.";
const OTP_PASSWORD_INTRO_HANDLE = 'Code verified. Choose a username and a password for your account.';
// Said BEFORE the waiting room rather than by it: the person is about to be
// signed in to the waitlist, not to the platform. The waitlist's own words
// (#4073): a spot, a few at a time.
const OTP_WAITLIST_NOTE =
  'New accounts get a spot on the waitlist. We\u2019re letting people in a few at a time.';

/** Which reset path the recovery view offers. */
type RecoveryPath = 'wallet' | 'email';

// Class strings shared by the sub-views' fields. Copied verbatim from the
// hand-written markup (and, for the two lazily-mounted blocks, from the
// runtime build that used the same constants), so the compiled Tailwind
// already covers every one of them.
const P = 'text-sm text-zinc-500 dark:text-zinc-400';
// The email and code steps' body copy at the boards' reading size, 16/22,
// rather than the 14px `text-sm` the pre-reskin sub-views were written in.
// `mb-5` is boards 3 and 4's `margin-top: 20px` on the card, stated once from
// the paragraph's side: both steps are a copy block, then the card, and the
// step columns below carry no gap of their own precisely so each seam in that
// run can take the board's own figure.
const STEP_P = 'mb-5 text-[16px] leading-[22px] text-zinc-500 dark:text-zinc-400';
const LABEL = 'block text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1';
const QUIET_BUTTON = 'flex h-11 w-full items-center justify-center rounded-full bg-white text-[16px] font-semibold text-zinc-900 shadow-sm hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800 transition-colors';
// The secondary routes under the primary button — forgot password, the
// email code — as the language's neutral pills rather than text links: on
// the wallpaper a link is a line of grey in a screen of pills.
const PILL_LINK = 'flex h-11 w-full items-center justify-center rounded-full bg-white text-[16px] font-semibold text-zinc-900 shadow-sm hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800 transition-colors';
// The screen's one <h1>. `#recovery-view` and `#reset-password-view` bring
// their own <h2> and are out of this change's scope, so on those two views
// the <h1> is hidden rather than saying "Sign in" above a different title.
// Both arms are complete literals — Tailwind's extractor is a regex over
// source text, and a test on this screen bans a computed className outright.
//
// LEFT, under a CENTRED mark, which is the hierarchy boards 2, 3 and 4 draw:
// their <h1> carries no `text-align` at all, while the wordmark above it sits
// in a space-between row with a spacer opposite the back disc. The heading was
// centred here, so the two competed for the same axis and the column below —
// card rows, labels, body copy, every one of them left — started at a
// different edge from the thing announcing it.
//
// `mb-2.5` is the 10px the boards put between the heading and the line under
// it (their copy block's `gap`). Where the next thing is the card instead of a
// sentence — board 2's password step — the form adds the other 10 of that
// board's `margin-top: 20px`.
const SCREEN_H1 = 'text-[28px] font-extrabold leading-[32px] tracking-tight text-left mb-2.5 text-zinc-900 dark:text-zinc-100';
const SCREEN_H1_HIDDEN = 'text-[28px] font-extrabold leading-[32px] tracking-tight text-left mb-2.5 text-zinc-900 dark:text-zinc-100 hidden';

/**
 * What the retired `BUTTON` class constant is now: the same string, spelled as
 * <Button> props. `w-full rounded-lg bg-violet-600 hover:bg-violet-500 px-4
 * py-2 font-medium transition-colors text-white` — note `size="plain"` (these
 * forms set no text size of their own) and `ink="solidLate"` (the auth screens
 * write the colour after the transition; see button.tsx's header).
 *
 * Spread rather than repeated so the nine call sites stay a single decision,
 * exactly as the class constant made them.
 */
// The screen's primary button: the filled accent pill at 48px.
const SOLID = { layout: 'full', variant: 'pillAccent', size: 'pillLg', ink: 'solidLate' } as const;

/**
 * And the retired `INPUT` class constant, likewise: `w-full rounded-lg
 * bg-zinc-100 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700
 * px-3 py-2 text-zinc-900 dark:text-zinc-100 placeholder-zinc-500
 * focus:outline-none focus:ring-2 focus:ring-violet-500`.
 */
const FIELD = { box: 'auth', hint: 'dim' } as const;

/**
 * The login form's own two fields, which are the auth box again but with the
 * dialogs' lighter placeholder and the ring that also clears the border. Two
 * spellings of one field, hand-authored apart; kept apart here for the same
 * reason input.tsx keeps `default` and `auth` apart.
 */
// A field is a ROW of the white card the form is; the card is the box.
const AUTHFIELD = { box: 'card', hint: 'dim', ring: 'bare' } as const;
const AUTH_CARD = 'rounded-2xl bg-white dark:bg-zinc-900 overflow-hidden';
const AUTH_ROW = 'px-4 pt-3 pb-2 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-zinc-200 dark:[&:not(:last-child)]:border-zinc-800';
const AUTH_LABEL = 'block text-[13px] text-zinc-500 dark:text-zinc-400';
/**
 * Board 4's code field — the one row on the three sign-in screens whose value
 * is not prose. Monospace at 26px with 8px between the characters, so six
 * digits read as six separate things and a transcription slip is visible
 * without counting. The 28px line box on top of the `card` box's own `py-1`
 * is the board's 36px field.
 *
 * A whole literal, like every class string in this file, and it rides in
 * through `className` rather than a variant: `cn` is tailwind-merge, so
 * `text-[26px]` displaces the `card` box's own `text-[17px]` instead of
 * racing it for stylesheet order.
 */
const CODE_FIELD = 'font-mono text-[26px] leading-[28px] tracking-[8px]';
const ERROR = 'text-red-400 text-sm';
// The line under the set-password step's username field: its rule, or the
// server's sentence about the name (QA 2026-09-24 Q12). Two whole literals.
const FIELD_HINT = 'mt-1 text-sm text-zinc-500 dark:text-zinc-400';
const FIELD_HINT_ERROR = 'mt-1 text-sm text-red-600 dark:text-red-400';
const WAITLIST_NOTE = 'rounded-2xl bg-white dark:bg-zinc-900 px-4 py-3 text-[15px] leading-snug text-zinc-700 dark:text-zinc-300';
const STATUS = 'text-sm text-zinc-500 dark:text-zinc-400';
// The code and email steps' status line at the same 16/22 reading size as
// their body copy — `#otp-status` is where CODE_SENT_MSG lands, so the
// expiry sentence must not be a size smaller than the echo above it. Its own
// literal rather than a reuse of STEP_P: this is a status, not a paragraph,
// and the set-password step keeps STATUS because that step is out of scope.
const STEP_STATUS = 'text-[16px] leading-[22px] text-zinc-500 dark:text-zinc-400';

/**
 * The offline explanation's box (#2443). The SPELLING is the Alert primitive's
 * `notice` variant — one caution box for the whole shell — but it is spread
 * here rather than rendered as `<Alert>` for two reasons, both about the
 * rendered class attribute:
 *
 *   * `.offline-only` has to stay at the FRONT of it. `dapp.json` selects
 *     `body.is-offline #auth-login-screen:not(.hidden) .offline-only`, and the
 *     prerendered markup is probed for the literal `class="offline-only` by
 *     tests/offline-session-boot.test.js and tests/pwa-shell-wiring.test.js.
 *     `<Alert>` appends `className` AFTER its variants.
 *   * a module constant, not an inline template, because
 *     tests/signup-invite-link.test.js bans a computed `className={`…`}` in
 *     this file. Nothing here is computed in the sense that rule is about:
 *     every class in `alertVariants` is a complete literal in alert.tsx, which
 *     Tailwind scans, and `offline-only` is an app.css rule rather than a
 *     utility.
 */
const OFFLINE_NOTICE = `offline-only mb-8 ${alertVariants({ variant: 'notice', density: 'roomy' })}`;

/**
 * The terminal email-reset result. It lives on the login form, not beside the
 * now-spent reset controls: success has moved the person to their next action.
 * SENT_BOX is already the auth screen's durable positive-feedback treatment.
 */
const RESET_COMPLETE_TITLE = 'Password changed';
const RESET_COMPLETE_MSG =
  'For security, you’ve been signed out everywhere. Sign in with your new password.';

/**
 * ── Arriving from a waitlist-release email (#1548) ─────────────────────
 *
 * The release mail links to `#signup/<url-encoded address>`, and the router
 * hands that segment to `loginOnShow`. The screen prefills the field and asks
 * for a code straight away, because the old behaviour was a page that said "we
 * emailed you a code" next to a button that had not been pressed yet.
 *
 * The server suppresses a second code to the same address inside
 * `RULES.otp.minGapMs` (src/services/mail/rate-limit.js) and hands back the one
 * it already sent, so asking again inside that window mails nothing. Hold the
 * buttons for the same 60 seconds and say when they come back, rather than
 * letting somebody press a button that provably does nothing.
 */
const RESEND_COOLDOWN_MS = 60 * 1000;

/**
 * Per-tab record of the automatic send, so a reload of the invite link (or a
 * trip to #login and back) does not fire a second request. sessionStorage
 * rather than a ref: the reload is the case that has a ref back to `false`.
 * Shape: `{ email, sentAt }` — `sentAt` also restores the cooldown across the
 * reload, since the server's own gap survived it.
 */
const AUTO_SEND_KEY = 'usernode.signup.otp.v1';

/**
 * The standing confirmation on the code step. It stays put (unlike the
 * transient "Sending code..." status) because the whole point of arriving
 * here is knowing a code is on its way. The 10-minute figure must match
 * OTP_TTL_MS in src/services/email-signup.js.
 */
const CODE_SENT_MSG = 'We sent you a code. It expires in 10 minutes.';

/** The resend button while it is held. Whole class literals, both arms. */
const QUIET_BUTTON_WAITING =
  'w-full text-sm text-zinc-400 dark:text-zinc-600 cursor-not-allowed';

type AutoSendRecord = { email: string; sentAt: number };

// Shared with the sign-in sheet (./sign-in-sheet.tsx), which opens the same
// link over the story: one record per tab, whichever of the two sent it.
export function readAutoSend(): AutoSendRecord | null {
  try {
    const raw = sessionStorage.getItem(AUTO_SEND_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AutoSendRecord;
    if (!parsed || typeof parsed.email !== 'string' || typeof parsed.sentAt !== 'number') {
      return null;
    }
    return parsed;
  } catch {
    // Private mode, or a value some other tab wrote. Treat it as absent.
    return null;
  }
}

export function writeAutoSend(email: string) {
  try {
    sessionStorage.setItem(AUTO_SEND_KEY, JSON.stringify({ email, sentAt: Date.now() }));
  } catch {
    // Storage refused: the send still happened, we just cannot remember it.
  }
}

/** The `?shot=` screenshot state on this document, or null. */
function currentShot(): string | null {
  try {
    return new URLSearchParams(location.search).get('shot');
  } catch {
    return null;
  }
}

/**
 * The `?t=` invite token from a waitlist-release link (#1548).
 *
 * The mail carries a TOKEN rather than the address. A fragment would be
 * dropped by link rewriters — that is the bug #1545 fixed on this same mail —
 * and the address in a query would put an email in server logs and referrers,
 * which for a waitlist is the membership fact itself.
 *
 * `more_token` is already an unguessable capability delivered to that address,
 * and `/api/public/waitlist/more/:token` already resolves it and already
 * returns the email, so nothing new is minted or exposed.
 *
 * AuthScreens.enter() takes the mail's query off the address as it lands,
 * so the token is usually the one it kept (takeReleaseLink): this screen
 * only gets it when the story is switched off and the landing hands the
 * link on (./landing.tsx). The query is still read first, for a `?t=` that
 * arrives some other way.
 */
function inviteTokenFromQuery(): string | null {
  try {
    const t = new URLSearchParams(location.search).get('t') || takeReleaseLink()?.token || null;
    return t && /^[A-Za-z0-9_-]{8,128}$/.test(t) ? t : null;
  } catch {
    return null;
  }
}

/**
 * Resolve an invite token to its address. Null on anything unexpected: a
 * prefill is a convenience, and the screen is perfectly usable without it.
 */
export async function inviteEmailFromToken(token: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/public/waitlist/more/${encodeURIComponent(token)}`);
    if (!res.ok) return null;
    const data = await res.json();
    const email = typeof data?.email === 'string' ? data.email.trim().toLowerCase() : '';
    return email.includes('@') && email.length <= 255 ? email : null;
  } catch {
    return null;
  }
}

/**
 * The `#signup/<address>` segment, or null if it is not an address.
 *
 * Kept after #1548 moved the MAIL to a token, because the `signup-code-sent`
 * screenshot state still uses it: a check URL cannot carry a live token, and
 * the shot has to paint without a network round trip to stay deterministic.
 * Harmless as a general entry point too — it prefills a field, and the code
 * still only goes to the address that was typed.
 */
function inviteFromSegment(seg?: string | null): string | null {
  if (!seg) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(seg);
  } catch {
    // A stray '%' in the fragment. Nothing to prefill.
    return null;
  }
  const email = decoded.trim().toLowerCase();
  return email.includes('@') && email.length <= 255 ? email : null;
}

const EXPIRED_MSG =
  'This reset link is invalid or has expired. Go back to login and request a new one from "Forgot password?".';

/**
 * The emailed-reset confirmation is a success state, not ambient status text:
 * a green-tinted rounded box (both palettes) so "the link was sent" is
 * unmistakable. Whole class literals — the Tailwind extractor is a regex.
 */
const SENT_BOX =
  'rounded-lg border border-green-300 bg-green-100 px-3 py-2 text-sm font-medium text-green-800 dark:border-green-800 dark:bg-green-950/60 dark:text-green-300';
/** Anti-enumeration: the same copy whether or not the address matched. */
const SENT_MSG =
  'If that address matches an account, a reset link is on its way. It expires in 30 minutes.';

/**
 * The fallback for the two branches where a correct email code cannot sign you
 * in (issue #1586), and the copy `?shot=email-code-password-account` paints.
 * Kept in step with `PASSWORD_REQUIRED_MESSAGE` in
 * `src/services/email-signup.js`, which is what a real refusal carries.
 */
const PASSWORD_ACCOUNT_MSG =
  'This account signs in with a password. Enter it below to continue.';

/** The pre-email copy the frozen markup shipped, and its replacement. */
const ADMIN_LEAD_SHIPPED =
  "Accounts here have no email on file, so a password can't be reset automatically from the web.";
/**
 * The confirmed-email fallback copy (#2969): explains why the reset email
 * never arrives, then how to recover. Two sentences, both inside the same
 * warning card — see ADMIN_LEAD_NOTICE_BOX below.
 */
const ADMIN_LEAD_WITH_EMAIL =
  'If you did not confirm your email account, you will not receive the reset email.';
const ADMIN_LEAD_SUPPORT_INSTRUCTIONS =
  'If this happens to you, ask Homeroom support team to issue you a temporary password (support@usernodelabs.org).';

/**
 * The warning-card treatment for ADMIN_LEAD_WITH_EMAIL (#2958): a caution box
 * instead of ambient body text, so the confirmed-email gap reads as a helpful
 * notice rather than blending into the surrounding copy. Same `notice`
 * spelling as OFFLINE_NOTICE above — one caution box for the whole shell.
 * #2969 moved the support-team follow-up sentence inside the same box, so
 * the whole message reads as one warning rather than a card plus a stray
 * paragraph below it.
 */
const ADMIN_LEAD_NOTICE_BOX = `flex items-start gap-2 ${alertVariants({ variant: 'notice', density: 'compact' })}`;

export function LoginScreen() {
  const rootRef = useRef<HTMLElement>(null);
  useVisibilityHiddenClass(rootRef, AUTH_SCREEN_IDS.login, false);
  // The screen's interior mounts on its first reveal, not in the prerender —
  // see lib/mount-on-reveal.ts. AuthScreens.show() asks for it (through
  // window.UsernodeReact.mount) before it wires or reveals the screen, so the
  // hooks this component patches onto AuthScreens are installed and the
  // interior's nodes exist by the time the on-show hook runs.
  const mounted = useMountedOnReveal(AUTH_SCREEN_IDS.login);

  // Everything below starts at the value the prerendered markup shipped with:
  // the base view, no wallet, no errors, and the reset UI unbuilt.
  const [view, setView] = useState<LoginView>('base');
  const [otpStep, setOtpStep] = useState<OtpStep>('email');
  const [recoveryPath, setRecoveryPath] = useState<RecoveryPath>('email');
  const [resetUi, setResetUi] = useState(false);
  const [walletUi, setWalletUi] = useState(false);
  const [walletControls, setWalletControls] = useState(false);

  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginDetails, setLoginDetails] = useState<NativeLoginFailureDetails | null>(null);
  const [passwordResetComplete, setPasswordResetComplete] = useState(false);
  const [otpError, setOtpError] = useState<string | null>(null);
  const [otpDetails, setOtpDetails] = useState<NativeLoginFailureDetails | null>(null);
  const [otpStatus, setOtpStatus] = useState<string | null>(null);
  const [otpEmailEcho, setOtpEmailEcho] = useState('');
  const [otpSignup, setOtpSignup] = useState<OtpSignup | null>(null);
  const [otpUsernameError, setOtpUsernameError] = useState<string | null>(null);
  // The address a waitlist-release link carried, and the moment the resend
  // buttons come back. Both start empty, so the first render is still exactly
  // the markup the hand-written shell shipped.
  const [inviteEmail, setInviteEmail] = useState<string | null>(null);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [cooldownNow, setCooldownNow] = useState(0);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [walletStatus, setWalletStatus] = useState('');
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [recoveryStatus, setRecoveryStatus] = useState<string | null>(null);
  const [emailResetError, setEmailResetError] = useState<string | null>(null);
  const [emailResetStatus, setEmailResetStatus] = useState<string | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const completion = useSessionConfirmation();
  const { finishLogin, clear: clearConfirmation } = completion;

  // Non-render state, mirroring the legacy module's fields one for one.
  const st = useRef({
    walletPubkey: null as string | null,
    cachedChallenge: null as string | null,
    walletLinked: false,
    walletDetectRan: false,
    resetToken: null as string | null,
    otpEmail: null as string | null,
  }).current;

  /**
   * Whole seconds left on the resend cooldown, 0 when there is none. Derived
   * rather than stored so the two buttons and their labels cannot disagree,
   * and 0 on the very first render, which is what keeps that render identical
   * to the markup the hand-written shell shipped.
   */
  const cooldownLeft = cooldownUntil
    ? Math.max(0, Math.ceil((cooldownUntil - cooldownNow) / 1000))
    : 0;

  // The probe resolves long after its own render, and it needs the view that is
  // showing THEN. Assigned during render so it is never a frame stale.
  const viewRef = useRef(view);
  viewRef.current = view;

  const username = useRef<HTMLInputElement>(null);
  const password = useRef<HTMLInputElement>(null);
  const otpEmailInput = useRef<HTMLInputElement>(null);
  const otpCode = useRef<HTMLInputElement>(null);
  const otpNewPassword = useRef<HTMLInputElement>(null);
  const otpUsername = useRef<HTMLInputElement>(null);
  const otpConfirmPassword = useRef<HTMLInputElement>(null);
  const recoveryNewPassword = useRef<HTMLInputElement>(null);
  const recoveryConfirmPassword = useRef<HTMLInputElement>(null);
  const recoveryEmailInput = useRef<HTMLInputElement>(null);
  const resetNewPassword = useRef<HTMLInputElement>(null);
  const resetConfirmPassword = useRef<HTMLInputElement>(null);

  // ── View switching (the router's per-route hooks) ─────────────────────

  const showLoginBaseView = useCallback(() => {
    setPasswordResetComplete(false);
    setLoginDetails(null);
    setOtpDetails(null);
    setView('base');
  }, []);

  const otpShowStep = useCallback((step: OtpStep) => {
    setOtpError(null);
    setOtpDetails(null);
    setOtpUsernameError(null);
    // What a verified code said belongs to the password step only; any
    // other step is a new attempt, possibly for a different address.
    if (step !== 'password') setOtpSignup(null);
    setOtpStep(step);
  }, []);

  const showOtpView = useCallback(() => {
    setOtpStatus(null);
    otpShowStep('email');
    setView('otp');
  }, [otpShowStep]);

  /**
   * The lazily-mounted half of the reset UI (see the file header). Idempotent,
   * like the `_resetUiBuilt` guard it replaces.
   */
  const ensureResetUi = useCallback(() => {
    setResetUi(true);
  }, []);

  const showRecovery = useCallback(() => {
    setRecoveryError(null);
    setRecoveryStatus(null);
    ensureResetUi();
    // Wallet self-reset only when in the native app with a linked wallet;
    // everyone else gets the emailed magic link, with the admin-temporary-
    // password instructions as the fallback below it.
    setRecoveryPath(isNative() && st.walletPubkey && st.walletLinked ? 'wallet' : 'email');
    setView('recovery');
  }, [ensureResetUi, st]);

  /**
   * "Forgot password?" is a PLACE, `#login/forgot` (QA 2026-09-24 Q16). It
   * used to swap the card's view on the same `#login` entry, so the browser's
   * Back had no Sign in to return to and skipped straight past it to the
   * landing page. Pushed rather than routed: the card is already on screen,
   * and the router only has to answer the address when it is loaded or
   * traversed to (loginOnShow's `seg`). The state marks the entry as the one
   * this card pushed, which is what lets "Back to login" undo it.
   */
  const openRecovery = useCallback(() => {
    try {
      history.pushState({ [RECOVERY_ENTRY]: true }, '', `#${RECOVERY_ROUTE}`);
    } catch { /* an address that will not move still gets the view */ }
    showRecovery();
  }, [showRecovery]);

  /** "Back to login": the entry openRecovery pushed, or the bare route. */
  const leaveRecovery = useCallback(() => {
    const state = history.state as Record<string, unknown> | null;
    if (state && state[RECOVERY_ENTRY] && typeof history.back === 'function') {
      history.back();
      return;
    }
    if (window.location.hash === `#${RECOVERY_ROUTE}`) {
      try { history.replaceState(null, '', '#login'); } catch { /* the view still changes */ }
    }
    showLoginBaseView();
  }, [showLoginBaseView]);

  /**
   * Per-route side effect for `#reset-password/<token>`. The inputs it clears
   * may not be mounted yet on the first call — `ensureResetUi()` has only just
   * queued their render — and that is fine: a fresh mount is empty, and a
   * `resetError` set now paints with them.
   */
  const resetOnShow = useCallback(
    (token?: string) => {
      ensureResetUi();
      st.resetToken = token || null;
      setResetError(null);
      if (resetNewPassword.current) resetNewPassword.current.value = '';
      if (resetConfirmPassword.current) resetConfirmPassword.current.value = '';
      setView('reset');
      // A mangled link can be refused without a round trip — same message the
      // server would return.
      if (!st.resetToken || !/^[0-9a-f]{64}$/.test(st.resetToken)) {
        setResetError(EXPIRED_MSG);
      }
    },
    [ensureResetUi, st],
  );

  // ── The wallet fast-path probe ───────────────────────────────────────
  //
  // Strictly OPTIONAL and additive: the standard login form stays visible
  // throughout, and every failure mode (no wallet in a fresh shell, transport
  // error, non-genesis, unlinked) quietly leaves the standard form as the only
  // option. Wallet custody follows platform login (custodial provisioning over
  // the bridge), so a wallet-less shell at login time is the NORMAL state, not
  // an error.
  const walletDetect = useCallback(async () => {
    const w = legacy();
    if (!isNative()) return;
    try {
      st.walletPubkey = (await w.getNodeAddress?.()) || null;
    } catch (e) {
      console.warn(
        '[auth-login] no native wallet available:',
        e instanceof Error ? e.message : e,
      );
      return;
    }
    if (!st.walletPubkey) return;

    try {
      const checkRes = await fetch('/api/auth/wallet-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pubkey: st.walletPubkey }),
      });
      const checkData = await checkRes.json();
      if (!checkRes.ok) {
        console.warn('[auth-login] wallet-check failed (HTTP ' + checkRes.status + ')');
        return;
      }

      // Track link status independent of the genesis gate: password RESET is
      // allowed for any linked wallet (no genesis requirement, issue #282).
      // This lets a linked non-genesis wallet still reach the wallet-reset path
      // from "Forgot password?".
      st.walletLinked = checkData.status === 'linked';

      // Only a linked, genesis wallet gets the sign-in fast path.
      if (checkData.isGenesis === false) return;
      if (checkData.status !== 'linked' || !checkData.challenge) return;

      st.cachedChallenge = checkData.challenge;
      setWalletUi(true);
      // Don't fight the email-code / recovery sub-views if one is open (e.g.
      // arrived on #signup) — the base view brings the wallet UI back with it.
      if (viewRef.current === 'base') setWalletControls(true);
    } catch (e) {
      console.warn('[auth-login] wallet probe failed:', e instanceof Error ? e.message : e);
    }
  }, [st]);

  const loginOnShow = useCallback(
    (openSignup?: boolean, seg?: string | null) => {
      clearConfirmation();
      // Reset to the requested base view every time the route changes — login
      // ↔ signup share the screen element.
      if (openSignup) showOtpView();
      else showLoginBaseView();
      // Screenshot-state deep link (`?shot=password-recovery#login`): boots
      // straight into the forgot-password view, pinned to the emailed-link
      // path so the shot is deterministic regardless of wallet state
      // (issue #1158). Same idiom as ?shot=waitlist-joined; display-only,
      // no writes, so it works in every environment.
      const shot = currentShot();
      // `#login/forgot`: the recovery view has its own address (see
      // openRecovery), reached here by a reload or a Back / Forward to it.
      if (!openSignup && seg === 'forgot') showRecovery();
      // The terminal state after the magic-link form succeeds. A real reset
      // reaches this through onResetConfirm; the shot paints the same state
      // without consuming a token, so proposal checks can see it.
      if (!openSignup && shot === 'password-reset-complete') {
        setPasswordResetComplete(true);
      }
      if (!openSignup && (shot === 'password-recovery' || shot === 'password-recovery-sent')) {
        showRecovery();
        setRecoveryPath('email');
        // `password-recovery-sent` also paints the post-submit confirmation
        // so the green success box is URL-reachable for screenshots and
        // checks. Display-only, no writes, works in every environment.
        setEmailResetStatus(shot === 'password-recovery-sent' ? SENT_MSG : null);
      }
      // `?shot=email-code-password-account#login`: the state an email code
      // hands you when the account can only sign in with its password
      // (issue #1586) — the base form carrying the server's explanation.
      // Reached by typing a code in production, so the link is display-only
      // and writes nothing, which keeps it working in every environment.
      if (!openSignup && shot === 'email-code-password-account') {
        setLoginError(PASSWORD_ACCOUNT_MSG);
      }
      if (openSignup) {
        // #signup/<address> from a waitlist-release email. Prefill by ref
        // (the field is uncontrolled); the send itself is in the effect
        // below, so it is not fired from inside a router callback.
        // #1548: the address arrives either as the shot's hash segment or,
        // in the real mail, as a token that has to be resolved. Everything
        // downstream is identical, so the shared tail runs in both cases —
        // once synchronously, once when the lookup lands.
        const applyInvite = (invited: string | null) => {
        if (invited && otpEmailInput.current) otpEmailInput.current.value = invited;
        // Two ways to already be past the send, and both paint the code step
        // HERE rather than from an effect: showOtpView() above has just reset
        // this screen to the email step, and the router calls this hook again
        // on a re-entry that leaves `inviteEmail` unchanged — so an effect
        // keyed on the address would not run a second time to undo it.
        //
        //  - `signup-code-sent` (#1548), the screenshot state. Sends nothing:
        //    the shot has to be deterministic, and staging mail is log-only,
        //    so a real request would prove nothing anyway.
        //  - a reload of the invite link, or a trip out to #login and back.
        //    The code from the first visit is still the live one.
        const prior = invited ? readAutoSend() : null;
        const alreadySent = shot === 'signup-code-sent'
          ? Date.now()
          : (prior && prior.email === invited ? prior.sentAt : 0);
        if (alreadySent) {
          const shown = invited || '';
          st.otpEmail = shown;
          setOtpEmailEcho(shown);
          otpShowStep('code');
          setOtpStatus(CODE_SENT_MSG);
          const until = alreadySent + RESEND_COOLDOWN_MS;
          setCooldownUntil(until > Date.now() ? until : 0);
        }
        setInviteEmail(invited);
        };
        const segEmail = inviteFromSegment(seg);
        const token = segEmail ? null : inviteTokenFromQuery();
        if (token) {
          // Asynchronous, and that is fine: the send is in an effect keyed on
          // `inviteEmail`, so it fires when the address lands rather than
          // needing to be known inside this router callback.
          void inviteEmailFromToken(token).then(applyInvite);
        } else {
          applyInvite(segEmail);
        }
      }
      // Wallet detection runs once, the first time the screen appears (needs
      // the native bridge; quietly does nothing on desktop web).
      if (!st.walletDetectRan) {
        st.walletDetectRan = true;
        void walletDetect();
      }
    },
    [clearConfirmation, otpShowStep, showLoginBaseView, showOtpView, showRecovery, st, walletDetect],
  );

  // ── Password login ───────────────────────────────────────────────────

  const onLoginSubmit = useCallback(async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    clearConfirmation();
    setLoginError(null);
    setLoginDetails(null);
    if (blockedOffline(setLoginError)) return;
    // The same exchange the sign-in sheet's password step sends (shared.ts).
    const result = await passwordSignIn(username.current?.value.trim() || '', password.current?.value || '');
    if (!result.ok) {
      setLoginError(result.error);
      setLoginDetails(result.details);
      return;
    }
    await finishLogin();
  }, [clearConfirmation, finishLogin]);

  // ── Email-code sign-in (the #signup route) ───────────────────────────
  //
  // Steps: request a code → verify into a narrow HttpOnly signup cookie →
  // choose a password. Password setup atomically creates the web session.

  /**
   * `explicitEmail` is the invite address, for the automatic send and the
   * resend: both know the address already, and the resend fires from a step
   * where the email field is not the thing on screen.
   */
  const otpRequestCode = useCallback(async (explicitEmail?: string) => {
    setOtpError(null);
    setOtpDetails(null);
    const email = (explicitEmail || otpEmailInput.current?.value || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      setOtpError('Enter a valid email address');
      return;
    }
    if (blockedOffline(setOtpError)) return;
    // Whichever step we end on, the email field should carry the address —
    // a rejected send drops back here and retyping it would be busywork.
    if (otpEmailInput.current) otpEmailInput.current.value = email;
    setOtpStatus('Sending code...');
    try {
      const res = await fetch('/api/auth/otp/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      setOtpStatus(null);
      if (!res.ok || !data.ok) {
        // Throttled. A code was sent recently and is still the live one, so
        // the code step is where they should be; hold the resend for as long
        // as the limiter says, and fall back to our own gap if it says
        // nothing. Note otpShowStep clears the error, so it goes first.
        if (res.status === 429) {
          st.otpEmail = email;
          setOtpEmailEcho(email);
          otpShowStep('code');
          setOtpError(data.error || 'Too many requests. Wait a moment and try again.');
          const retryAfter = Number(res.headers.get('Retry-After'));
          setCooldownUntil(
            Date.now() +
              (Number.isFinite(retryAfter) && retryAfter > 0
                ? Math.min(retryAfter, 900) * 1000
                : RESEND_COOLDOWN_MS),
          );
          return;
        }
        // Refused (an address the server will not accept, and anything else):
        // the email step, with the address still in the field.
        otpShowStep('email');
        setOtpError(data.error || 'Could not send a code');
        return;
      }
      st.otpEmail = email;
      setOtpEmailEcho(email);
      if (otpCode.current) otpCode.current.value = '';
      otpShowStep('code');
      // A standing confirmation, not a flash: somebody who arrived from an
      // invite link never pressed anything, so the screen has to say what it
      // just did on their behalf.
      setOtpStatus(CODE_SENT_MSG);
      setCooldownUntil(Date.now() + RESEND_COOLDOWN_MS);
    } catch {
      setOtpStatus(null);
      otpShowStep('email');
      setOtpError('Network error');
    }
  }, [otpShowStep, st]);

  const onOtpResend = useCallback(async () => {
    // Held for the server's own gap: inside it the request mails nothing and
    // the button would just be lying. The label counts it down.
    if (cooldownUntil > Date.now()) return;
    // Same request, from the code step — jump back visually so the user sees
    // the send happen, then land back on the code entry.
    if (otpEmailInput.current) otpEmailInput.current.value = st.otpEmail || '';
    await otpRequestCode(st.otpEmail || undefined);
  }, [cooldownUntil, otpRequestCode, st]);

  const onOtpVerify = useCallback(async () => {
    clearConfirmation();
    setOtpError(null);
    setOtpDetails(null);
    const code = (otpCode.current?.value || '').trim();
    if (!code) {
      setOtpError('Enter the code from the email');
      return;
    }
    if (blockedOffline(setOtpError)) return;
    setOtpStatus('Verifying...');
    try {
      // Verification can now mint an ordinary session (an account that already
      // has a password is signed straight in), so it crosses the session-mint
      // boundary like /api/auth/login does — issue #1586.
      const res = await fetchSessionMint('/api/auth/otp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email: st.otpEmail, code }),
      });
      const data = await res.json();
      setOtpStatus(null);
      if (!res.ok || !data.ok) {
        // A correct code the server will not sign in with (an admin account,
        // or one whose email address was never confirmed) is not a mistyped
        // code: carry the address over to the password form rather than
        // leaving the person on a step that cannot succeed.
        if (data.code === 'password_required' || data.code === 'admin_password_required') {
          showLoginBaseView();
          if (username.current) username.current.value = st.otpEmail || '';
          setLoginError(data.error || PASSWORD_ACCOUNT_MSG);
          return;
        }
        // NOT on a 429: the limiter's message already says exactly how long
        // to wait.
        setOtpError(
          res.status === 429
            ? data.error || 'Too many code attempts. Try again shortly.'
            : data.error || 'Invalid or expired code.',
        );
        return;
      }
      if (data.next === 'signed-in') {
        await finishLogin();
        return;
      }
      otpShowStep('password');
      setOtpSignup({
        created: data.created === true,
        needsUsername: data.needsUsername === true,
        suggestedUsername: typeof data.suggestedUsername === 'string' ? data.suggestedUsername : '',
        waitlisted: typeof data.waitlisted === 'boolean' ? data.waitlisted : null,
      });
      // Past the code: nothing left to resend, and setOtpStatus(null) above
      // has already taken the "we sent you a code" confirmation down.
      setCooldownUntil(0);
    } catch (error) {
      setOtpStatus(null);
      setOtpError(sessionMintFailureMessage(error));
      setOtpDetails(error instanceof NativeLoginPreparationError ? error.details : null);
    }
  }, [clearConfirmation, finishLogin, otpShowStep, showLoginBaseView, st]);

  const onOtpSetPassword = useCallback(async () => {
    clearConfirmation();
    setOtpError(null);
    setOtpDetails(null);
    setOtpUsernameError(null);
    // The handle rides along only when this step asked for it; the server
    // validates it exactly as the first-run "Choose your username" step does.
    const handle = otpSignup?.needsUsername ? (otpUsername.current?.value || '').trim() : null;
    if (handle === '') {
      setOtpUsernameError('Enter a username.');
      otpUsername.current?.focus();
      return;
    }
    const value = otpNewPassword.current?.value || '';
    const confirm = otpConfirmPassword.current?.value || '';
    if (value.length < 8) {
      setOtpError('Password must be at least 8 characters');
      return;
    }
    if (value !== confirm) {
      setOtpError('Passwords do not match');
      return;
    }
    if (blockedOffline(setOtpError)) return;
    setOtpStatus('Setting password...');
    try {
      const res = await fetchSessionMint('/api/auth/otp/set-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          password: value,
          passwordConfirmation: confirm,
          ...(handle ? { username: handle } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.user) {
        setOtpStatus(null);
        // A refused name leaves the signup session unspent: fix the field,
        // submit again.
        if (data.field === 'username' && data.error) {
          setOtpUsernameError(data.error);
          otpUsername.current?.focus();
          return;
        }
        setOtpError(data.error || 'Could not set the password');
        return;
      }
      setOtpStatus(null);
      await finishLogin();
    } catch (error) {
      setOtpStatus(null);
      setOtpError(sessionMintFailureMessage(error));
      setOtpDetails(error instanceof NativeLoginPreparationError ? error.details : null);
    }
  }, [clearConfirmation, finishLogin, otpSignup, st]);

  // ── Wallet sign-in ───────────────────────────────────────────────────

  const onWalletSignIn = useCallback(async () => {
    clearConfirmation();
    setWalletError(null);
    if (blockedOffline(setWalletError)) return;
    setWalletStatus('Verifying identity...');
    setWalletControls(false);

    const fail = (msg: string) => {
      setWalletStatus('');
      setWalletControls(true);
      setWalletError(msg);
    };

    try {
      if (!st.cachedChallenge) {
        const checkRes = await fetch('/api/auth/wallet-check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pubkey: st.walletPubkey }),
        });
        const checkData = await checkRes.json();
        st.cachedChallenge = checkData.challenge;
      }

      if (!st.cachedChallenge) {
        fail('Could not get challenge from server');
        return;
      }

      const sigResult = await legacy().signMessage!(st.cachedChallenge);
      const verifyRes = await fetchSessionMint('/api/auth/wallet-verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pubkey: st.walletPubkey,
          publicKey: sigResult.publicKey,
          challenge: st.cachedChallenge,
          signature: sigResult.signature,
        }),
      });
      const verifyData = await verifyRes.json();
      st.cachedChallenge = null;

      if (verifyRes.ok) {
        setWalletStatus('');
        await finishLogin();
        return;
      }
      fail(verifyData.error || 'Verification failed');
    } catch (e) {
      st.cachedChallenge = null;
      if (e instanceof NativeLoginPreparationError) {
        fail(e.message);
        return;
      }
      const message = e instanceof Error ? e.message : String(e);
      if (message && message.includes('denied')) fail('Signature request was denied.');
      else fail('Signature failed: ' + message);
    }
  }, [clearConfirmation, finishLogin, st]);

  // ── Wallet password reset (issue #282) ───────────────────────────────

  const onWalletReset = useCallback(async () => {
    clearConfirmation();
    setRecoveryError(null);
    const value = recoveryNewPassword.current?.value || '';
    const confirm = recoveryConfirmPassword.current?.value || '';
    if (value.length < 8) {
      setRecoveryError('Password must be at least 8 characters');
      return;
    }
    if (value !== confirm) {
      setRecoveryError('Passwords do not match');
      return;
    }
    setRecoveryStatus('Verifying identity...');
    try {
      // Get a fresh challenge — the sign-in cached one may be consumed or
      // absent. wallet-check returns one for any linked wallet.
      const checkRes = await fetch('/api/auth/wallet-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pubkey: st.walletPubkey }),
      });
      const checkData = await checkRes.json();
      const challenge = checkData.challenge;
      if (!challenge) {
        setRecoveryStatus(null);
        setRecoveryError('Could not get a challenge from the server');
        return;
      }

      const sigResult = await legacy().signMessage!(challenge);
      const res = await fetchSessionMint('/api/auth/wallet-reset-verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pubkey: st.walletPubkey,
          publicKey: sigResult.publicKey,
          challenge,
          signature: sigResult.signature,
          newPassword: value,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setRecoveryStatus(null);
        setRecoveryError(data.error || 'Reset failed');
        return;
      }
      setRecoveryStatus(null);
      await finishLogin();
    } catch (e) {
      setRecoveryStatus(null);
      if (e instanceof NativeLoginPreparationError) {
        setRecoveryError(e.message);
        return;
      }
      const message = e instanceof Error ? e.message : String(e);
      if (message && message.includes('denied')) {
        setRecoveryError('Signature request was denied.');
      } else {
        setRecoveryError('Reset failed: ' + message);
      }
    }
  }, [clearConfirmation, finishLogin, st]);

  // ── Emailed password reset (magic link) ──────────────────────────────

  const onEmailReset = useCallback(async () => {
    setEmailResetError(null);
    setEmailResetStatus(null);
    if (blockedOffline(setEmailResetError)) return;
    const email = (recoveryEmailInput.current?.value || '').trim();
    if (!email || email.indexOf('@') === -1) {
      setEmailResetError('Enter the email address on your account');
      return;
    }
    setBusy('btn-email-reset');
    try {
      const res = await fetch('/api/auth/password-reset/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setEmailResetError(data.error || 'Could not send the link. Try again in a minute');
        return;
      }
      // Anti-enumeration: the server answers the same whether or not the
      // address matched, and so does this copy.
      setEmailResetStatus(SENT_MSG);
    } catch {
      setEmailResetError('Network error');
    } finally {
      setBusy(null);
    }
  }, []);

  const onResetConfirm = useCallback(async () => {
    setResetError(null);
    if (blockedOffline(setResetError)) return;
    const value = resetNewPassword.current?.value || '';
    const confirm = resetConfirmPassword.current?.value || '';
    if (value.length < 8) {
      setResetError('Password must be at least 8 characters');
      return;
    }
    if (value !== confirm) {
      setResetError('Passwords do not match');
      return;
    }
    setBusy('btn-reset-confirm');
    try {
      const res = await fetch('/api/auth/password-reset/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: st.resetToken, newPassword: value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setResetError(res.status === 401 ? EXPIRED_MSG : data.error || 'Reset failed. Try again');
        return;
      }
      // The token is single-use and the reset revoked every session on
      // purpose. Clear every remaining copy of the new password/token, scrub
      // the spent capability from browser history, then use the existing
      // same-screen router to put the next action in front of the user.
      if (resetNewPassword.current) resetNewPassword.current.value = '';
      if (resetConfirmPassword.current) resetConfirmPassword.current.value = '';
      if (password.current) password.current.value = '';
      st.resetToken = null;
      setLoginError(null);

      const screens = legacy().AuthScreens as undefined | {
        deepLinkUrl?: (target: string) => string;
        show?: (route: string) => void;
      };
      try {
        history.replaceState(null, '', screens?.deepLinkUrl?.('#login') || '/#login');
      } catch {
        location.hash = '#login';
      }
      if (screens?.show) screens.show('login');
      else showLoginBaseView();
      // AuthScreens.show('login') clears any previous completion state as it
      // resets the base view, so publish the new result after that call.
      setPasswordResetComplete(true);
      window.requestAnimationFrame(() => username.current?.focus());
    } catch {
      setResetError('Network error');
    } finally {
      setBusy(null);
    }
  }, [showLoginBaseView, st]);

  // ── The invite link's automatic send (#1548) ─────────────────────────

  /**
   * One second of clock while a cooldown is running, and not a tick more —
   * the interval only exists between `setCooldownUntil` and the moment it
   * lapses, and unmounting clears it.
   */
  useEffect(() => {
    if (!cooldownUntil) return undefined;
    setCooldownNow(Date.now());
    const id = window.setInterval(() => {
      const now = Date.now();
      setCooldownNow(now);
      if (now >= cooldownUntil) setCooldownUntil(0);
    }, 1000);
    return () => window.clearInterval(id);
  }, [cooldownUntil]);

  /**
   * Arriving on `#signup/<address>` sends the code once. In an effect rather
   * than in `loginOnShow` so the request is not fired from inside the
   * router's callback, and keyed on the address so revisiting the same link
   * in the same tab is a no-op.
   */
  useEffect(() => {
    if (!inviteEmail) return;
    // The screenshot state paints this screen instead of sending.
    if (currentShot() === 'signup-code-sent') return;
    // Already sent for this address in this tab. Deliberately re-read rather
    // than remembered in a ref: a reload is exactly the case a ref forgets,
    // and loginOnShow has already painted the code step from the same record.
    const prior = readAutoSend();
    if (prior && prior.email === inviteEmail) return;
    writeAutoSend(inviteEmail);
    void otpRequestCode(inviteEmail);
  }, [inviteEmail, otpRequestCode]);

  // ── The seam back into public/js/** ──────────────────────────────────
  //
  // `AuthScreens.show()` looks these up by name at call time, so patching them
  // here replaces the legacy login half wholesale. Forwarders keep the
  // installed identity stable while reading the current closures.
  const live = useRef({ loginOnShow, resetOnShow, showLoginBaseView, showOtpView });
  live.current = { loginOnShow, resetOnShow, showLoginBaseView, showOtpView };
  useAuthScreensPatch({
    _wireLogin: () => {},
    _loginOnShow: (openSignup?: boolean, seg?: string | null) =>
      live.current.loginOnShow(openSignup, seg),
    _resetOnShow: (token?: string) => live.current.resetOnShow(token),
    _showLoginBaseView: () => live.current.showLoginBaseView(),
    _showOtpView: () => live.current.showOtpView(),
  });

  /**
   * Coming back online re-enables the controls via CSS (`body.is-offline` drops
   * off), so the "you're offline" error left on screen would be the only thing
   * still saying otherwise. Clear it — the legacy module did this for this
   * screen's three error slots plus the register screen's, which still owns its
   * own until that chunk lands.
   */
  useEffect(() => {
    const dropOfflineMessage = (current: string | null) =>
      current && /offline/i.test(current) ? null : current;
    const onOfflineChange = (e: Event) => {
      const detail = (e as CustomEvent<{ offline?: boolean }>).detail;
      if (!detail || detail.offline !== false) return;
      // Only the offline message goes; a real "wrong password" stays put.
      setLoginError(dropOfflineMessage);
      setOtpError(dropOfflineMessage);
      setWalletError(dropOfflineMessage);
    };
    window.addEventListener('usernode:offline-change', onOfflineChange);
    return () => window.removeEventListener('usernode:offline-change', onOfflineChange);
  }, []);

  // ── Derived visibility ───────────────────────────────────────────────

  const base = view === 'base';

  /*
      One heading for the screen, its words derived from the view and the step
      rather than four headings switched by `hidden`. It covers `#login` and
      the three otp steps only: the recovery and reset views bring their own
      <h2> and are out of this change's scope, so the <h1> is hidden there
      rather than stacking "Sign in" above "Reset your password". The
      set-password step keeps the words its retired <h2> gave it, because that
      step's look is out of scope too.
  */
  const heading =
    view === 'otp'
      ? otpStep === 'code'
        ? 'Check your email'
        : 'Sign in with email'
      : 'Sign in';

  /*
      #btn-otp-back is ONE control under all three otp steps, so its words are
      the step's: from the email step the way back is the password form, from
      the code step it is a mistyped address. The set-password step keeps what
      it shipped.
  */
  const backLabel =
    otpStep === 'email'
      ? 'Sign in with a password'
      : otpStep === 'code'
        ? 'Wrong address? Go back'
        : 'Back to login';

  return (
    <main
      ref={rootRef}
      id="auth-login-screen"
      className="hidden fixed inset-0 z-40 overflow-y-auto platform-safe-scroll"
    >
      {mounted ? (
        <>
      {/*
          The corner Back disc, shared with register and the waitlist
          (./back-button, #2444). `backToLanding` assigns `location.hash`
          rather than letting the anchor's own href do it: the href is '#' so
          the link is inert without JS, exactly as shipped. auth-screens.js
          delegates the same click for the screens it still owns; both do the
          same thing, and this one outlives it. It is `absolute` inside this
          screen, so it moves down with the screen when the install strip is
          up (QA 2026-09-24 Q8).
      */}
      <AuthBackButton href="#" onClick={backToLanding} />
      {/*
          FOUR BANDS, TOP TO BOTTOM: the mark, the heading, the content, and
          the one tertiary line each step ends on, pinned to the foot.

          This was `items-center justify-center`, which centred the whole
          stack as a single cluster: at 390x844 every step rendered as a tight
          bob in the middle with roughly 250px of dead air above it and 250px
          below. A flex COLUMN top-anchors instead (justify-content starts at
          flex-start), and one `grow` spacer per step spends the leftover
          height on the foot rather than splitting it above and below.

          min-h-full, not h-full: the root is `overflow-y-auto`, so a short
          viewport has to scroll rather than clip. The percentage resolves
          because the root is `fixed inset-0`, and it resolves against the
          height INSIDE it (.platform-safe-scroll puts the safe-area inset in
          the root's own padding), so the pin adds no overflow of its own.
      */}
      <div className="min-h-full flex flex-col">
        {/*
            `px-4`, not the boards' 20px: the landing's header carries a
            mandatory px-4 parity class, so aligning this column to it beats
            matching the board by 4px, and the four logged-out screens
            disagreeing with each other would be the worse outcome. One
            recorded deviation for all of them.

            THE TOP PADDING IS THE MARK BAND. The floating back disc is
            `top: calc(env(safe-area-inset-top, 0px) + 0.75rem)` and h-11, so
            its centre sits 34px below the safe-area top; seating a 24px
            wordmark on that same band puts its top at 34 - 12 = 22px, which
            is the 1.375rem below. It rides in an inline style for the reason
            the disc's own `top` does: the value is an env() expression, and
            this is that expression re-stated rather than a second rule.

            `pb-[34px]` is the clearance above the home indicator, the figure
            board 1's landing ends on. The inset itself is already the root's
            padding, and it is zero on a desktop or an Android without one, so
            the foot needs air of its own either way.
        */}
        <div
          className="w-full max-w-sm mx-auto flex grow flex-col px-4 pb-[34px]"
          style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 1.375rem)' }}
        >
          {/*
              The mark carries the name, so it is a named figure and not
              decoration: the <h1> under it says which step this is, not which
              product, and nothing else on the screen says "Homeroom" (see
              wordmark.tsx's note on the two accessible paths).

              It STAYS 24px. The complaint that the name reads small is not
              answered by growing it into the 28px heading it already sits a
              hair under, which is what made the two compete and left neither
              leading; it is answered by giving it a band of its own, where a
              small mark reads as a logo instead of as undersized text.

              `self-center` states the centring in the flex column's own
              terms. `mx-auto` alone already does it, and does one more thing
              worth keeping deliberate: auto cross-axis margins are what
              suppress `align-items: stretch`, without which an svg at
              `w-auto` would be stretched to the column's full width.
          */}
          <Wordmark
            title="Homeroom"
            className="mx-auto self-center mb-10 h-6 w-auto text-zinc-950 dark:text-white"
          />
          <h1 className={view === 'recovery' || view === 'reset' ? SCREEN_H1_HIDDEN : SCREEN_H1}>
            {heading}
          </h1>
          {/*
              Offline explanation (#1021). Signing in REQUIRES the network —
              the credential check happens on the server — so an offline
              visitor previously typed a password, waited, and got a bare
              "Network error" with no hint that the whole screen was
              unusable. Shown by `body.is-offline` (app.css); the controls
              below carry data-offline-disabled so it's obvious which parts
              are the ones that can't work.
          */}
          <div className={OFFLINE_NOTICE}>
            <h2 className="text-sm font-semibold text-amber-800 dark:text-amber-400">
              You're offline
            </h2>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              Signing in needs a connection. Your username and password are checked on the server.
            Reconnect and try again; if you were signed in on this device before, reloading once
            you're back online will take you straight in.
            </p>
            <button
              type="button"
              data-offline-retry=""
              className="mt-3 rounded-lg border border-amber-500/50 px-3 py-1.5 text-sm font-medium text-amber-800 dark:text-amber-300 hover:bg-amber-500/10 transition-colors"
            >
              Try again
            </button>
          </div>
          <SessionConfirmationNotice completion={completion} />
          {/* Wallet auth status (shown when native bridge detected) */}
          <div id="wallet-auth" className={hiddenFirst(!(base && walletUi), 'space-y-4')}>
            <div id="wallet-status" className="text-center text-sm text-zinc-500 dark:text-zinc-400">
              {walletStatus}
            </div>
            <div id="wallet-error" className={hiddenLast(!walletError, ERROR)}>
              {walletError}
            </div>
            <div id="wallet-sign-in" className={hiddenFirst(!walletControls, 'space-y-3')}>
              <Button
                id="btn-wallet-sign-in"
                data-offline-disabled=""
                {...SOLID}
                className="flex items-center justify-center gap-2"
                onClick={onWalletSignIn}
              >
                <KeyIcon className="w-5 h-5" />
                Sign in with Wallet
              </Button>
            </div>
            <div
              id="wallet-divider"
              className={hiddenFirst(!walletControls, 'flex items-center gap-3 text-xs text-zinc-500 dark:text-zinc-400')}
            >
              <div className="flex-1 h-px bg-zinc-300 dark:bg-zinc-800">
              </div>
              or
              <div className="flex-1 h-px bg-zinc-300 dark:bg-zinc-800">
              </div>
            </div>
          </div>
          {/*
              Standard login form (always available; wallet sign-in above is
              an optional fast path when the native app carries a linked
              wallet)
          */}
          {/*
              `flex flex-col gap-4`, not `space-y-4`. Same 16px, but a gap is
              only drawn between items that are actually laid out, and
              `space-y` is a margin on every child after the first whether or
              not the one before it rendered. #login-reset-success is the
              first child and is hidden on all but one state, so `space-y`
              put a phantom 16px at the top of the form. Under the old block
              column it collapsed out through the form's edge and nobody saw
              it; a flex item establishes its own formatting context, so it
              would now show as 16px of dead air under the heading on the
              password step and on that step only, while #otp-view starts
              flush. The gap keeps all three steps opening at the same y.

              `mt-2.5` is the second half of board 2's `margin-top: 20px` on
              the card; the <h1>'s own `mb-2.5` is the first. Split that way
              because the heading's margin is shared with the two steps whose
              next line is a sentence at 10 (boards 3 and 4), and this is the
              one step where the card follows the heading directly.
          */}
          <form
            id="login-form"
            className={hiddenLast(!base, 'mt-2.5 flex flex-col gap-4')}
            onSubmit={onLoginSubmit}
            onKeyDown={returnKeyHandler()}
          >
            <div
              id="login-reset-success"
              role="status"
              aria-live="polite"
              aria-atomic="true"
              className={hiddenLast(!passwordResetComplete, SENT_BOX)}
            >
              <strong className="block font-semibold">{RESET_COMPLETE_TITLE}</strong>
              <span className="mt-1 block">{RESET_COMPLETE_MSG}</span>
            </div>
            {/*
                NO PLACEHOLDER ON THESE TWO ROWS. The label above each field is
                persistent, not a floating one that vanishes on focus, so a
                placeholder repeating it says the same words twice in the same
                box — "Username or email" over "username or email". The boards
                draw it that way and it is still lazy; the rows that keep a
                placeholder are the ones where it does different work (an
                example address, an example code, a length rule), never an echo
                of the label.
            */}
            <div className={AUTH_CARD}>
            <div className={AUTH_ROW}>
              <label
                htmlFor="login-username"
                className={AUTH_LABEL}
              >
                Username or email
              </label>
              <Input
                ref={username}
                id="login-username"
                name="username"
                type="text"
                required={true}
                autoComplete="username"
                enterKeyHint="next"
                {...HANDLE_FIELD}
                {...AUTHFIELD}
              />
            </div>
            <div className={AUTH_ROW}>
              <label
                htmlFor="login-password"
                className={AUTH_LABEL}
              >
                Password
              </label>
              <PasswordInput
                ref={password}
                id="login-password"
                name="password"
                required={true}
                autoComplete="current-password"
                enterKeyHint="go"
                {...AUTHFIELD}
              />
            </div>
            </div>
            <div id="login-error" className={hiddenLast(!loginError, ERROR)}>
              {loginError}
              <NativeLoginDetailsLink details={loginDetails} />
            </div>
            <Button type="submit" data-offline-disabled="" {...SOLID}>
              Sign in
            </Button>
            <TermsNotice verb="signing in" />
          </form>
          {/*
              The rest of board 2's action group: `gap: 10px` under the 16 the
              form's own `gap-4` already draws between the card and the primary
              button. Three separately-hidden wrappers rather than one flex
              column, because #forgot-link-wrap and #otp-link-wrap are ids the
              inventory resolves and each carries its own `hidden`.
          */}
          <p id="forgot-link-wrap" className={hiddenLast(!base, 'mt-2.5')}>
            <a
              id="forgot-password-link"
              href={`#${RECOVERY_ROUTE}`}
              className={PILL_LINK}
              onClick={(e) => {
                e.preventDefault();
                openRecovery();
              }}
            >
              Forgot password?
            </a>
          </p>
          <p id="otp-link-wrap" className={hiddenLast(!base, 'mt-2.5')}>
            <a id="otp-link" href="#signup" className={PILL_LINK}>
              Sign in with an email code
            </a>
          </p>
          {/*
              #2979: the password step no longer ends on a tertiary line — the
              "Have an activation code? Register" foot pin (#register-link)
              is gone, along with the spacer that pinned it to the foot. This
              step now simply stops after the two link wraps above; the
              leftover height is unclaimed space rather than a fourth band.

              Email-code sign-in sub-view below (thin-shell migration). The
              ONE email-code path, backed by the web-auth endpoints. It serves
              both first-time sign-ups (otp/verify creates the account — this
              is the #signup route) and migrated password-less participants.
          */}
          {/*
              `flex grow flex-col gap-4` where this was `space-y-4`. `grow` is
              what lets the email and code steps reach the foot of the screen:
              this block is the whole of those two steps, so the spacer that
              pins #btn-otp-back has to live inside it. `gap-4` is the same
              16px as before, drawn only between the steps that are actually
              showing, so the code step opens at the same y as the email step
              rather than 16px lower for the hidden step above it.

              `hidden` still wins over `flex` when the view is closed: they
              are both display utilities, and Tailwind emits `hidden` last of
              them. #app-viewer on the landing screen has shipped on that
              same pair since step 2 chunk A.
          */}
          <div id="otp-view" className={hiddenFirst(view !== 'otp', 'flex grow flex-col gap-4')}>
            {/*
                Boards 3 and 4 run each step as three figures at three
                different distances — the copy block, the card at
                `margin-top: 20px`, then the action group at
                `padding-top: 16px`. `space-y-3` drew one 12px everywhere, so
                the card floated between its sentence and its button with
                nothing saying which it belonged to. A plain column, with each
                seam carrying its own board figure, is what says it.
            */}
            <div
              id="otp-step-email"
              className={hiddenFirst(otpStep !== 'email', 'flex flex-col')}
              onKeyDown={returnKeyHandler({ submit: () => { if (!cooldownLeft) void otpRequestCode(); } })}
            >
              <p className={STEP_P}>
                We'll email you a 6-digit code to sign in. New here? You'll get
                an account and a place on the waitlist.
              </p>
              {/*
                  One field, one card — the same white grouped card the
                  password form above is, so the three sign-in screens are
                  three views of one surface rather than three field
                  treatments. AUTH_CARD / AUTH_ROW / AUTH_LABEL / AUTHFIELD
                  are that form's own constants, reused rather than
                  re-spelled.
              */}
              <div className={AUTH_CARD}>
                <div className={AUTH_ROW}>
                  <label htmlFor="otp-email" className={AUTH_LABEL}>
                    Email
                  </label>
                  <Input
                    ref={otpEmailInput}
                    id="otp-email"
                    type="email"
                    autoComplete="email"
                    enterKeyHint="send"
                    {...AUTHFIELD}
                    placeholder="you@example.com"
                  />
                </div>
              </div>
              <Button
                id="btn-otp-request"
                type="button"
                data-offline-disabled=""
                {...SOLID}
                className="mt-4"
                disabledStyle={cooldownLeft ? 'dim' : 'off'}
                disabled={cooldownLeft > 0}
                onClick={() => {
                  // Wrapped: otpRequestCode's first argument is an address
                  // now, and a click handler would hand it a MouseEvent.
                  void otpRequestCode();
                }}
              >
                {cooldownLeft ? `Email me a code in ${cooldownLeft}s` : 'Email me a code'}
              </Button>
            </div>
            <div
              id="otp-step-code"
              className={hiddenFirst(otpStep !== 'code', 'flex flex-col')}
              onKeyDown={returnKeyHandler({ submit: () => { void onOtpVerify(); } })}
            >
              <p className={STEP_P}>
                {'Enter the 6-digit code we sent to '}
                <span id="otp-email-echo" className="font-medium text-zinc-700 dark:text-zinc-300">
                  {otpEmailEcho}
                </span>
                .
              </p>
              {/*
                  The same one-field card as the email step, with the value
                  spelled as a code (CODE_FIELD). Left-aligned like every
                  other row of this card: the label sits at the row's left
                  edge, and `tracking-[8px]` puts its 8px after the last
                  character too, which centring would then read as off-centre.
              */}
              <div className={AUTH_CARD}>
                <div className={AUTH_ROW}>
                  <label htmlFor="otp-code" className={AUTH_LABEL}>
                    6-digit code
                  </label>
                  <Input
                    ref={otpCode}
                    id="otp-code"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    enterKeyHint="go"
                    {...AUTHFIELD}
                    className={CODE_FIELD}
                    placeholder="123456"
                  />
                </div>
              </div>
              {/*
                  Board 4's action group, the one place on these three screens
                  where two buttons sit together: `padding-top: 16px` off the
                  card and `gap: 10px` between them, which is board 2's action
                  group again. A wrapper rather than margins on the two
                  buttons, because the resend button's className is already a
                  choice between two complete literals and a third copy of
                  that recipe is how the two stop matching.
              */}
              <div className="mt-4 flex flex-col gap-2.5">
                <Button
                  id="btn-otp-verify"
                  type="button"
                  data-offline-disabled=""
                  {...SOLID}
                  onClick={onOtpVerify}
                >
                  Verify code
                </Button>
                <button
                  id="btn-otp-resend"
                  type="button"
                  data-offline-disabled=""
                  className={cooldownLeft ? QUIET_BUTTON_WAITING : QUIET_BUTTON}
                  disabled={cooldownLeft > 0}
                  onClick={onOtpResend}
                >
                  {cooldownLeft ? `Send a new code in ${cooldownLeft}s` : 'Send a new code'}
                </button>
              </div>
            </div>
            <div
              id="otp-step-password"
              className={hiddenFirst(otpStep !== 'password', 'space-y-3')}
              onKeyDown={returnKeyHandler({ submit: () => { void onOtpSetPassword(); } })}
            >
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                {otpSignup?.created
                  ? OTP_PASSWORD_INTRO_NEW
                  : otpSignup?.needsUsername
                    ? OTP_PASSWORD_INTRO_HANDLE
                    : OTP_PASSWORD_INTRO}
              </p>
              {/*
                  QA 2026-09-24 Q12: the handle, asked HERE. An account made by
                  a code used to get a derived name and meet it for the first
                  time in the waiting room ("Your account qaflowfive doesn't
                  have platform access yet"); the first-run gate that asks for
                  it only runs at release.

                  #4596 (overturning #3575 for this step): the field arrives
                  holding a suggestion the server made from the address, the
                  letters and digits before the @, free when it was read, or
                  empty when none fits. The person can change it, the server
                  refuses to finish without one (`username_required`), and
                  the line under the field says who will see it. That line is its own <p>, ahead of the
                  rule: the rule's line is swapped whole for the server's
                  refusal, and the public note has to stay put meanwhile.
              */}
              {otpSignup?.needsUsername ? (
                <div>
                  <label htmlFor="otp-username" className="block text-[15px] font-medium text-zinc-500 dark:text-zinc-400 mb-1">
                    Username
                  </label>
                  <Input
                    ref={otpUsername}
                    id="otp-username"
                    type="text"
                    defaultValue={otpSignup.suggestedUsername}
                    autoComplete="username"
                    maxLength={32}
                    enterKeyHint="next"
                    {...HANDLE_FIELD}
                    aria-describedby="otp-username-public otp-username-hint"
                    aria-invalid={otpUsernameError ? true : undefined}
                    onInput={() => setOtpUsernameError(null)}
                    {...FIELD}
                    placeholder="yourname"
                  />
                  <p id="otp-username-public" className={FIELD_HINT}>
                    {USERNAME_PUBLIC_NOTE}
                  </p>
                  <p id="otp-username-hint" className={otpUsernameError ? FIELD_HINT_ERROR : FIELD_HINT}>
                    {otpUsernameError || USERNAME_RULE}
                  </p>
                </div>
              ) : null}
              <div>
                <label className="block text-[15px] font-medium text-zinc-500 dark:text-zinc-400 mb-1">
                  New password
                </label>
                <PasswordInput
                  ref={otpNewPassword}
                  id="otp-new-password"
                  autoComplete="new-password"
                  enterKeyHint="next"
                  {...FIELD}
                  placeholder="at least 8 characters"
                />
              </div>
              <div>
                <label className="block text-[15px] font-medium text-zinc-500 dark:text-zinc-400 mb-1">
                  Confirm password
                </label>
                <PasswordInput
                  ref={otpConfirmPassword}
                  id="otp-confirm-password"
                  autoComplete="new-password"
                  enterKeyHint="go"
                  {...FIELD}
                  placeholder="re-enter password"
                />
              </div>
              {otpSignup?.waitlisted ? (
                <p id="otp-waitlist-note" className={WAITLIST_NOTE}>
                  {OTP_WAITLIST_NOTE}
                </p>
              ) : null}
              <Button
                id="btn-otp-set-password"
                type="button"
                data-offline-disabled=""
                {...SOLID}
                onClick={onOtpSetPassword}
              >
                {otpSignup?.created ? 'Create account & sign in' : 'Set password & sign in'}
              </Button>
            </div>
            <div id="otp-error" className={hiddenLast(!otpError, ERROR)}>
              {otpError}
              <NativeLoginDetailsLink details={otpDetails} />
            </div>
            <div
              id="otp-status"
              className={hiddenLast(!otpStatus, otpStep === 'password' ? STATUS : STEP_STATUS)}
            >
              {otpStatus}
            </div>
            {/*
                THE FOOT PIN for the email and code steps, whose one tertiary
                line is #btn-otp-back. Hidden on the set-password step, which
                is out of this change's scope: that step keeps its controls in
                one run, top-anchored, exactly as they sat before.
            */}
            <div className={otpStep === 'password' ? 'hidden' : 'grow'} />
            <button
              id="btn-otp-back"
              type="button"
              className={QUIET_BUTTON}
              onClick={() => {
                // Route change so browser back stays coherent (#signup → #login).
                location.hash = '#login';
              }}
            >
              {backLabel}
            </button>
          </div>
          {/*
              Password recovery sub-view (issue #282). Hidden until "Forgot
              password?" is tapped. Picks one of two paths by context: a
              wallet-signature self-reset when running inside the Homeroom
              app with a linked wallet, otherwise the emailed magic link
              with the "ask an admin" message as its fallback.
          */}
          <div id="recovery-view" className={hiddenFirst(view !== 'recovery', 'space-y-4')}>
            <h2 className="text-lg font-bold text-center">
              Reset your password
            </h2>
            <div
              id="recovery-wallet"
              className={hiddenFirst(!(view === 'recovery' && recoveryPath === 'wallet'), 'space-y-3')}
              onKeyDown={returnKeyHandler({ submit: () => { void onWalletReset(); } })}
            >
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                Your wallet is linked to this account. Approve a signature request, then choose a new password.
              </p>
              <div>
                <label className="block text-[15px] font-medium text-zinc-500 dark:text-zinc-400 mb-1">
                  New password
                </label>
                <PasswordInput
                  ref={recoveryNewPassword}
                  id="recovery-new-password"
                  autoComplete="new-password"
                  enterKeyHint="next"
                  {...FIELD}
                  placeholder="at least 8 characters"
                />
              </div>
              <div>
                <label className="block text-[15px] font-medium text-zinc-500 dark:text-zinc-400 mb-1">
                  Confirm new password
                </label>
                <PasswordInput
                  ref={recoveryConfirmPassword}
                  id="recovery-confirm-password"
                  autoComplete="new-password"
                  enterKeyHint="go"
                  {...FIELD}
                  placeholder="re-enter new password"
                />
              </div>
              <div id="recovery-error" className={hiddenLast(!recoveryError, ERROR)}>
                {recoveryError}
              </div>
              <div id="recovery-status" className={hiddenLast(!recoveryStatus, STATUS)}>
                {recoveryStatus}
              </div>
              <Button id="btn-wallet-reset" type="button" {...SOLID} onClick={onWalletReset}>
                Reset password with your wallet
              </Button>
            </div>
            {/*
                The emailed-reset request form. Mounted on the first
                ensureResetUi() — see the file header — and rendered where
                _ensureResetUi inserted it: directly above the admin block.
            */}
            {resetUi ? (
              <div
                id="recovery-email"
                className={hiddenFirst(!(view === 'recovery' && recoveryPath === 'email'), 'space-y-3')}
                onKeyDown={returnKeyHandler({ submit: () => { if (busy !== 'btn-email-reset') void onEmailReset(); } })}
              >
                {/*
                    The instruction line steps aside while the sent
                    confirmation is up, so the message reads from exactly one
                    place — the success box below the field (dev-chat request:
                    it appeared to render twice).
                */}
                <p className={hiddenFirst(!!emailResetStatus, P)}>
                  Enter the email address on your account and we'll send you a link to choose a new password.
                </p>
                <div>
                  <label className={LABEL} htmlFor="recovery-email-input">Email</label>
                  <Input
                    ref={recoveryEmailInput}
                    id="recovery-email-input"
                    type="email"
                    autoComplete="email"
                    enterKeyHint="send"
                    {...FIELD}
                    placeholder="you@example.com"
                  />
                </div>
                <div id="recovery-email-error" className={hiddenLast(!emailResetError, ERROR)}>
                  {emailResetError}
                </div>
                <div id="recovery-email-status" className={hiddenLast(!emailResetStatus, SENT_BOX)}>
                  {emailResetStatus}
                </div>
                <Button
                  id="btn-email-reset"
                  type="button"
                  {...SOLID}
                  disabled={busy === 'btn-email-reset'}
                  onClick={onEmailReset}
                >
                  Email me a reset link
                </Button>
              </div>
            ) : null}
            <div
              id="recovery-admin"
              className={hiddenFirst(!(view === 'recovery' && recoveryPath === 'email'), 'space-y-3')}
            >
              {/*
                  Once the email path exists, the admin route is the FALLBACK:
                  the shipped lead still claimed accounts have no email on
                  file, which stopped being true when email became a login
                  identifier. _ensureResetUi rewrote this paragraph; the same
                  flag rewrites it here.
              */}
              {/*
                  The divider marks the admin route as the separated, final
                  alternative below the email flow (issue #1158).
              */}
              <hr className="border-zinc-200 dark:border-zinc-800" />
              <div className={resetUi ? ADMIN_LEAD_NOTICE_BOX : ''}>
                {resetUi ? (
                  <WarningTriangleIcon
                    className="h-4 w-4 mt-0.5 shrink-0 text-amber-800 dark:text-amber-300"
                    aria-hidden="true"
                  />
                ) : null}
                {resetUi ? (
                  <div className="space-y-1">
                    <p>{ADMIN_LEAD_WITH_EMAIL}</p>
                    <p>{ADMIN_LEAD_SUPPORT_INSTRUCTIONS}</p>
                  </div>
                ) : (
                  <p className="text-sm text-zinc-500 dark:text-zinc-400">{ADMIN_LEAD_SHIPPED}</p>
                )}
              </div>
              {resetUi ? null : (
                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                  {/* JSX drops a line-ending space, so the separators before the
                      inline elements must live inside the string expressions —
                      without them the text renders as "atemporary" /
                      "fromSettings" (issue #1158). */}
                  {'Ask a Homeroom platform admin to issue you a '}
                  <span className="font-medium text-zinc-700 dark:text-zinc-300">
                    temporary password
                  </span>
                  {". Once you're back in, set a password you choose from "}
                  <a href="#settings/password" className="text-violet-700 hover:text-violet-400 underline dark:text-violet-400">
                    Settings → Change password
                  </a>
                  .
                </p>
              )}
            </div>
            <button
              id="btn-recovery-back"
              type="button"
              className="w-full text-sm text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-300"
              onClick={leaveRecovery}
            >
              Back to login
            </button>
          </div>
          {/*
              The redeem view the emailed link lands on — a sibling sub-view
              of #recovery-view on the same login card, where _ensureResetUi
              inserted it.
          */}
          {resetUi ? (
            <form
              id="reset-password-view"
              className={hiddenFirst(view !== 'reset', 'space-y-4')}
              onSubmit={(e) => {
                e.preventDefault();
                void onResetConfirm();
              }}
              onKeyDown={returnKeyHandler()}
            >
              <h2 className="text-lg font-bold text-center">Choose a new password</h2>
              <div>
                <label className={LABEL} htmlFor="reset-new-password">New password</label>
                <PasswordInput
                  ref={resetNewPassword}
                  id="reset-new-password"
                  autoComplete="new-password"
                  enterKeyHint="next"
                  {...FIELD}
                  placeholder="at least 8 characters"
                />
              </div>
              <div>
                <label className={LABEL} htmlFor="reset-confirm-password">Confirm new password</label>
                <PasswordInput
                  ref={resetConfirmPassword}
                  id="reset-confirm-password"
                  autoComplete="new-password"
                  enterKeyHint="go"
                  {...FIELD}
                  placeholder="re-enter new password"
                />
              </div>
              <div id="reset-error" className={hiddenLast(!resetError, ERROR)}>
                {resetError}
              </div>
              <Button
                id="btn-reset-confirm"
                type="submit"
                {...SOLID}
                disabled={busy === 'btn-reset-confirm'}
              >
                Set new password
              </Button>
              <button
                id="btn-reset-back"
                type="button"
                className={QUIET_BUTTON}
                onClick={() => {
                  // Route change so browser back stays coherent; the direct
                  // call covers the no-hashchange case (already on #login).
                  location.hash = '#login';
                  showLoginBaseView();
                }}
              >
                Back to login
              </button>
            </form>
          ) : null}
        </div>
      </div>
        </>
      ) : null}
    </main>
  );
}
