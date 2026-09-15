/**
 * `#auth-waitlist-screen` — the stage-1 waitlist survey (#1080, step 2 chunk C,
 * screen 5 of 6).
 *
 * Two questions on their own screen (`#waitlist`), reached from the landing
 * CTA link and the persistent header's "Join waitlist" button. The chips and
 * the country list come from `GET /api/public/waitlist/options` so the form and
 * the server's validation share one definition — see waitlist-shared.tsx, which
 * stage 2 reads too.
 *
 * It asked four until 27 Aug 2026. The free-text city beside the country
 * select, the "which one?" follow-up under the discovery chips and the
 * "did someone refer you?" handle are gone: none was read back, and the
 * referral one asked for a claim the invite link already records as a row
 * reference (`invite_code` / `invited_by`).
 *
 * ── What the initial render must be ───────────────────────────────────
 *
 * Everything options-driven renders empty and everything conditional renders
 * hidden, because that is what the hand-written document shipped and the
 * prerender pass has to reproduce it byte for byte. So: the chip row is an
 * empty `<div>`, the country select holds only its placeholder `<option>`, and
 * the joined / offer / queued blocks keep the `hidden` in the exact position
 * their class attribute had it. The options fetch runs in an effect.
 *
 * ── One step at a time ───────────────────────────────────────────────
 *
 * The screen carries three states in one column, and until the two-step
 * waitlist only the
 * middle one ended visibly. The title and the two intro paragraphs stayed up
 * after a join — still selling the thing you had just said yes to, with the
 * one instruction that now mattered four blocks down — and confirming the code
 * merely HID `#waitlist-confirm`, so the control you were typing into vanished
 * with nothing in its place. A control that disappears without a word reads as
 * a failure.
 *
 * So: the pitch hides on `joined`, `#waitlist-confirmed` takes the confirm
 * block's place on `confirmed`, and `#waitlist-step` names which of the two
 * steps you are on. Two steps, not three — the stage-2 survey is offered after
 * both and counting it would make an optional thing look required.
 *
 * ── Joining first, confirmation second (#1528) ───────────────────────
 *
 * A successful POST saves the signup, so acknowledge that before asking for
 * the code. Email confirmation is an explicit second step: it proves we can
 * reach the address before releasing access. The optional survey offer stays
 * behind `confirmed`. Returning code entry has no join response to acknowledge
 * and keeps its own heading. None of this changes the write or release model.
 *
 * ── Check my status (#1538) ──────────────────────────────────────────
 *
 * The confirm step is also the check-my-status step. Somebody who joined on
 * another device types their address, asks for a code, and reads back where
 * they stand — no new screen, no new route, and no magic link in the mail.
 * That works because a code now gets minted for an ALREADY-CONFIRMED row
 * too (it used to mail a link instead, which was backwards: the person
 * checking their status is by definition already confirmed), and because the
 * confirm response carries the same `status` block `/more/:token` returns.
 *
 * So `#waitlist-confirmed` is status-driven rather than one fixed sentence.
 * A released signup is told it is in and pointed at sign-up or sign-in,
 * instead of being told to keep waiting for a mail that already came. What it
 * deliberately does NOT show is a queue position: nothing on the platform
 * ranks the waitlist (services/waitlist-signals.js computes no score, on the
 * stated grounds that weighting the signals is an unmade product decision),
 * so a number here would be invented — and as snait put it on the issue, a
 * position is a promise and it can go backwards.
 *
 * ── Two steps, not one form (#1876) ──────────────────────────────────
 *
 * That check-my-status errand asked for the address and the six-digit code in
 * one breath, and the control that actually SENDS the code was a tertiary
 * "Didn't get it?" link underneath the field somebody was being told to fill
 * in. So the hint claimed there was a code in your email before any mail had
 * been sent, and the one action that would have made the claim true read as a
 * footnote.
 *
 * Split, for the `codeOnly` path only: `#waitlist-confirm-address` collects
 * the address and sends the code, `#waitlist-confirm-code` takes the six
 * digits and carries a way back. The post-join path is untouched, because
 * there the join WAS step 1 and the mail is already out.
 *
 * Two things it is careful about. "I already have a code" skips the send
 * rather than decorating it: `issueVerificationCode` deletes every unconsumed
 * code for an address before minting the next one, so a forced send would
 * invalidate the code sitting in the inbox of the very person who followed
 * that mail's `?status=1` button here. And the step lives in the fragment
 * (`#waitlist?confirm=1&step=code`), derived in both directions on every
 * show, so Back walks the flow backwards and either step survives a reload.
 * A request the server accepted always advances, whatever the address was:
 * the response is one frozen body for everybody, and a step that advanced
 * only for addresses we hold would answer the question that body exists to
 * refuse.
 *
 * ── Screenshot state ─────────────────────────────────────────────────
 *
 * One per settled state, because a shot can only navigate.
 * `?shot=waitlist-joined` stops at the confirm step, where a real join now
 * stops; `?shot=waitlist-confirmed` carries the list place and the stage-2
 * offer; `?shot=waitlist-code-entry` is that same errand reached WITHOUT a
 * join, which since #1876 is its address step, and `?shot=waitlist-code-step`
 * is the code step that follows it; `?shot=waitlist-admitted` is the released
 * panel, which is the one state a screenshot cannot otherwise reach because
 * it needs a released row behind it. All of them are pure UI state: none
 * POSTs, none writes, and the stage-2 link keeps its inert prerendered href.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { ChevronLeftIcon } from '@/components/ui/icons';

import { useMountedOnReveal } from '../../lib/mount-on-reveal';
import { useVisibilityHiddenClass } from '../../lib/visibility-store';
import {
  AUTH_SCREEN_IDS,
  hasSession as sessionExists,
  hiddenFirst,
  hiddenLast,
  useAuthScreensPatch,
} from './shared';
import {
  ChipRow,
  MsgTone,
  msgClass,
  // Aliased: `options` is already the name of this screen's fetched
  // options object, and the helper renders a map of them.
  options as opts,
  StatusPill,
  useSurveyAnswered,
  useWaitlistOptions,
  WaitlistStatus,
} from './waitlist-shared';

/**
 * The advertised gap between code requests, in seconds, and where it is
 * remembered.
 *
 * The server's answer carries the same number (`cooldown_seconds`), and the
 * client counts it down locally rather than asking again — deliberately, and
 * it is the same reason the response body is a constant: a countdown the
 * SERVER reported per address would say "wait 47 more seconds" to a member
 * and "go ahead" to a stranger, which is a membership test with extra steps.
 * So the number is fixed, the real per-address gap lives in the mail
 * throttle, and this is a courtesy that stops a double-tap rather than a
 * security boundary.
 *
 * localStorage, not state: a reload is the obvious way to get a fresh button,
 * and a courtesy that a refresh defeats is not one. A browser that refuses
 * storage simply gets the un-persisted version, which is why every access is
 * wrapped.
 */
const RESEND_COOLDOWN_KEY = 'usernode:waitlist-resend-until';
const RESEND_COOLDOWN_SECONDS = 60;

function readCooldownUntil(): number {
  try {
    const raw = window.localStorage.getItem(RESEND_COOLDOWN_KEY);
    const at = raw ? Number(raw) : 0;
    return Number.isFinite(at) && at > Date.now() ? at : 0;
  } catch {
    return 0;
  }
}

function writeCooldownUntil(at: number): void {
  try {
    window.localStorage.setItem(RESEND_COOLDOWN_KEY, String(at));
  } catch {
    /* private mode, or storage denied to a third-party frame */
  }
}

/**
 * "14 March 2026" from an ISO timestamp, or '' when there isn't one. Used for
 * the joined-on line in the status panel (#1538).
 */
function formatJoinedOn(iso: string | null | undefined): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  try {
    return at.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  } catch {
    return '';
  }
}

export function WaitlistScreen() {
  const rootRef = useRef<HTMLElement>(null);
  useVisibilityHiddenClass(rootRef, AUTH_SCREEN_IDS.waitlist, false);
  // The screen's interior mounts on its first reveal, not in the prerender —
  // see lib/mount-on-reveal.ts. AuthScreens.show() asks for it (through
  // window.UsernodeReact.mount) before it wires or reveals the screen, so the
  // hooks this component patches onto AuthScreens are installed and the
  // interior's nodes exist by the time the on-show hook runs.
  const mounted = useMountedOnReveal(AUTH_SCREEN_IDS.waitlist);

  const options = useWaitlistOptions();

  const [hasSession, setHasSession] = useState(false);
  const [joined, setJoined] = useState(false);
  // The stage-2 offer and its token are separate: `?shot=waitlist-confirmed`
  // shows the offer with no token at all, and its link keeps the inert
  // prerendered href.
  const [offer, setOffer] = useState(false);
  const [moreToken, setMoreToken] = useState<string | null>(null);
  // #1535: this card outlives a trip to the survey and back. Once those
  // questions have been answered it stops asking for answers and offers to
  // edit them instead. False until the survey says otherwise, which is also
  // what the prerendered document renders.
  const surveyAnswered = useSurveyAnswered(moreToken);
  const [msg, setMsg] = useState<{ text: string; tone: MsgTone } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [discovery, setDiscovery] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  /**
   * The address the code went to, echoed back in the confirm step AND in the
   * settled `#waitlist-confirmed` panel — "which address did I use?" is the
   * question that panel used to leave open (#1537). Empty at first render, and
   * both readers resolve to their address-less form when it is: the prerendered
   * document has no address to name.
   *
   * Stored lower-cased, matching what the server normalizes and stores, so the
   * two surfaces that name the address agree with each other and with the
   * stage-2 screen at `#more/<token>`.
   */
  const [sentTo, setSentTo] = useState('');
  /**
   * Did this visit reach the confirm step WITHOUT joining here?
   *
   * That is the whole returning-user case: the code expired fifteen minutes
   * after a join that may have been last week, and until now the only way
   * back to this control was to submit the join form again. So "Already
   * joined? Enter your code" jumps straight to it — and because nothing was
   * typed on this device, the step has to ask which address, which is what
   * #waitlist-confirm-email is for. A join sets `sentTo` instead and never
   * shows the field.
   */
  const [codeOnly, setCodeOnly] = useState(false);
  /**
   * Which half of that errand is on screen (#1876): `'address'` collects the
   * address and sends the code, `'code'` takes the six digits.
   *
   * Only ever read together with `codeOnly`, because the post-join path has
   * no split to be on. Initialised from a literal and derived from the
   * fragment in `waitlistOnShow` rather than here: the interior's first
   * render has to be the markup the hand-written shell shipped, and a step
   * read off `location` is not that.
   */
  const [flowStep, setFlowStep] = useState<'address' | 'code'>('address');
  /**
   * Where this signup actually stands, from the confirm response (#1538).
   * Null until a code lands, which is what keeps `#waitlist-confirmed`
   * rendering its prerendered shape: the pill and the joined-on date are
   * empty and `hidden` in the initial render, because contents rendered
   * before the fetch are a hydration mismatch, and a mismatch console.errors,
   * which fails proposal checks.
   */
  const [status, setStatus] = useState<WaitlistStatus | null>(null);
  /**
   * Released, and the day they joined (#1538). Both read off the status
   * block, so both are false/empty until a code lands and the panel keeps
   * its prerendered shape until then.
   *
   * The date is formatted in the visitor's own locale rather than pinned to
   * one: it is a plain fact being read back, and a fact is more readable in
   * the format its reader already uses. A malformed value collapses to '',
   * which hides the line rather than printing "Invalid Date".
   */
  const admitted = !!status?.admitted;
  const joinedOn = formatJoinedOn(status?.joined_at);
  /** The resend button's own status line. Kept apart from #waitlist-msg so a
   *  resend result and a wrong-code error cannot overwrite each other. */
  const [resendNote, setResendNote] = useState<{ text: string; tone: MsgTone } | null>(null);
  /**
   * The address step's own status line (#1876). A request that failed stays
   * on step 1 and says why here; one that succeeded advances and says so on
   * #waitlist-resend-note, beside the field it is about.
   */
  const [requestNote, setRequestNote] = useState<{ text: string; tone: MsgTone } | null>(null);
  const [resending, setResending] = useState(false);
  /** Epoch ms the cooldown ends, and the seconds left, ticked once a second. */
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [cooldownLeft, setCooldownLeft] = useState(0);
  /**
   * Re-entrancy guard for the confirm POST. `submitting` is state and
   * `onConfirmCode` closes over the mount's value of it, so on a slow network
   * the auto-submit below would fire a second request while the first was
   * still open. A ref reads live.
   */
  const busy = useRef(false);

  const email = useRef<HTMLInputElement>(null);
  const code = useRef<HTMLInputElement>(null);
  /** The address, when the confirm step was reached without a join. */
  const confirmEmail = useRef<HTMLInputElement>(null);
  const country = useRef<HTMLSelectElement>(null);
  /**
   * The inviter's code, from `/#waitlist?ref=<code>`. It rides in the hash's
   * own query segment — after the `?` INSIDE the fragment — the same place
   * the OAuth connect round trip puts its status, so it never reaches a
   * server log, ours or a proxy's. Read on show rather than at mount: this
   * screen stays mounted across navigations.
   *
   * A link SHARED today lands on the marketing site's /waitlist page
   * instead (src/services/marketing-links.js), which carries the same code
   * through to the join endpoint. This keeps working because links minted
   * before that move point here, and their code must still attribute.
   */
  const inviteRef = useRef<string | null>(null);

  /**
   * Form vs "you're already on the list", plus the screen title. A
   * waiting-room session already HAS an account in the queue, so the join form
   * is wrong for them — the same predicate the landing header uses.
   */
  const waitlistOnShow = useCallback(() => {
    let shot: string | null = null;
    try {
      shot = new URLSearchParams(location.search).get('shot');
    } catch {
      shot = null;
    }
    // The two settled states, painted without a submit. `waitlist-joined`
    // stops at the confirm step, because that is now where a real join
    // stops; `waitlist-confirmed` is the one that carries the offer.
    const shotJoined = shot === 'waitlist-joined';
    const shotConfirmed = shot === 'waitlist-confirmed';
    // The third settled state: the confirm step reached WITHOUT a join, which
    // is what `#waitlist?confirm=1` and the "Already joined?" link paint. It
    // is the one that shows the address field, so it is the one worth a
    // screenshot of its own — a shot of `waitlist-joined` cannot show it.
    const shotCodeEntry = shot === 'waitlist-code-entry';
    // And its other half since #1876: the code step, with a request behind
    // it. A shot of its own because the two halves cannot be photographed at
    // once, and this is the one that carries the way back.
    const shotCodeStep = shot === 'waitlist-code-step';
    // The fourth: released (#1538). It is the one settled state a shot cannot
    // reach by any other route, because it needs a row with a released_at
    // behind it. Painted from a literal, same as the others.
    const shotAdmitted = shot === 'waitlist-admitted';
    // The fifth: confirmed, read back through check-my-status rather than
    // reached by confirming just now. Same panel as `waitlist-confirmed`
    // with the celebration swapped for the state pill, which is the
    // difference `codeOnly` makes and the state most status readers are in.
    const shotStatus = shot === 'waitlist-status';
    if (shotJoined || shotConfirmed || shotAdmitted || shotStatus) {
      setMsg(null);
      setJoined(true);
      // A stand-in address, so both settled states paint the line that names
      // it. Deliberately a literal and not a fetch: these branches only ever
      // set state, because a shot has no join behind it to read an address
      // from.
      setSentTo('you@example.com');
    }
    if (shotConfirmed) {
      setConfirmed(true);
      setOffer(true);
      setStatus({ state: 'confirmed', admitted: false, confirmed: true, has_account: false });
    }
    if (shotStatus) {
      setConfirmed(true);
      setCodeOnly(true);
      // The offer stands: a confirmed signup can still move up, and this is
      // the panel that says so.
      setOffer(true);
      setStatus({
        state: 'confirmed',
        admitted: false,
        confirmed: true,
        has_account: false,
        joined_at: '2026-03-14T10:00:00.000Z',
      });
    }
    if (shotAdmitted) {
      setConfirmed(true);
      setCodeOnly(true);
      // No stage-2 offer: it is an offer to improve a position this signup
      // no longer has.
      setOffer(false);
      setStatus({
        state: 'admitted',
        admitted: true,
        confirmed: true,
        has_account: false,
        joined_at: '2026-03-14T10:00:00.000Z',
      });
    }
    if (shotCodeEntry) {
      setMsg(null);
      setJoined(true);
      setCodeOnly(true);
      // The address step (#1876), which is where the errand starts.
      setFlowStep('address');
      // No `sentTo`: nothing was sent on this device, and claiming otherwise
      // is exactly the bug this branch exists to fix.
      setSentTo('');
    }
    if (shotCodeStep) {
      setMsg(null);
      setJoined(true);
      setCodeOnly(true);
      setFlowStep('code');
      // A stand-in address, so the step names where the code went. A literal
      // and not a fetch: this branch only ever sets state.
      setSentTo('you@example.com');
    }

    // Who invited them, if they arrived on somebody's share link. A code
    // that doesn't resolve is dropped server-side rather than refused, so a
    // stale link never blocks a join.
    try {
      const hashQuery = new URLSearchParams(location.hash.split('?')[1] || '');
      const ref = hashQuery.get('ref');
      inviteRef.current = ref && /^[a-z0-9]{10}$/.test(ref) ? ref : null;
      // `#waitlist?confirm=1` — the link the platform can put in front of
      // somebody whose code expired, and what the "Already joined?" button
      // writes into the hash so the state survives a reload. The fragment's
      // own query, same as `ref`, so it never reaches a server log.
      if (hashQuery.get('confirm') === '1') {
        setJoined(true);
        setCodeOnly(true);
        // Which half of the split (#1876). Derived in BOTH directions on
        // every show, so the browser's own Back button walks the flow
        // backwards and a reload lands on the step it left.
        setFlowStep(hashQuery.get('step') === 'code' ? 'code' : 'address');
      }
    } catch {
      inviteRef.current = null;
    }

    const session = sessionExists();
    setHasSession(session);
    // Never resurrect the form over the success state (a re-show after a join,
    // e.g. back-then-forward).
    if (shotCodeEntry || shotCodeStep || shotAdmitted) {
      // A shot has to paint a settled state, and a focus ring is not one.
    } else if (!session && !joined && !shotJoined && !shotConfirmed) {
      email.current?.focus({ preventScroll: true });
    }
    // Mirror into the tab title so the Flutter WebView's AppBar follows the
    // screen, same as the landing header does for the landing page.
    try {
      document.title = 'Join the waitlist';
    } catch {
      /* ignore */
    }
  }, [joined]);

  /** Arm the cooldown, in state and in storage, from now. */
  const startCooldown = useCallback(() => {
    const until = Date.now() + RESEND_COOLDOWN_SECONDS * 1000;
    setCooldownUntil(until);
    setCooldownLeft(RESEND_COOLDOWN_SECONDS);
    writeCooldownUntil(until);
  }, []);

  /**
   * Adopt any cooldown left over from a previous visit, and tick it down.
   *
   * Read in an effect rather than as initial state on purpose: the interior's
   * first render has to be the markup the hand-written shell shipped, and a
   * button whose label depends on localStorage is not that.
   */
  useEffect(() => {
    const stored = readCooldownUntil();
    if (stored) setCooldownUntil(stored);
  }, []);

  useEffect(() => {
    if (!cooldownUntil) return undefined;
    const tick = () => {
      const left = Math.ceil((cooldownUntil - Date.now()) / 1000);
      setCooldownLeft(left > 0 ? left : 0);
      if (left <= 0) setCooldownUntil(0);
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [cooldownUntil]);

  const onSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const emailVal = email.current?.value.trim() || '';
      // Client preflight mirroring the server's stage-1 rules. Only the
      // address is required now, so this is the only miss worth catching
      // without a round trip.
      if (!emailVal) return setMsg({ text: 'Please enter your email.', tone: 'error' });

      setSubmitting(true);
      try {
        const res = await fetch('/api/public/waitlist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: emailVal,
            country: country.current?.value || undefined,
            discovery_source: discovery || undefined,
            invite_code: inviteRef.current || undefined,
          }),
        });
        const data = await res.json().catch(() => null);
        if (res.ok) {
          // A saved signup gets its acknowledgement before the confirm step.
          setMsg(null);
          setJoined(true);
          // Lower-cased to match the stored form: the server normalizes before
          // it writes, so echoing back what was typed would disagree with the
          // address the stage-2 screen names.
          setSentTo(emailVal.toLowerCase());
          // Six digits is the whole of what is left to do, so put the caret
          // there. On a REAL join only: the `?shot=` states have to paint a
          // settled state for the declared checks, and a focus ring is not one.
          window.setTimeout(() => code.current?.focus({ preventScroll: true }), 0);
          // Keep the token for the optional survey, offered after confirmation.
          const token = (data && data.more_token) || null;
          if (token) setMoreToken(token);
          // A code just went out, on this path as much as on the resend one
          // (a re-join re-sends). Start the same gap, so the button they see
          // next is honest about it rather than promising an instant resend
          // the mail throttle would swallow.
          startCooldown();
        } else {
          setMsg({
            text: (data && data.error) || 'Something went wrong. Try again.',
            tone: 'error',
          });
        }
      } catch {
        setMsg({ text: 'Connection issue. Try again.', tone: 'error' });
      }
      setSubmitting(false);
    },
    [discovery, startCooldown],
  );

  /**
   * Which address the confirm step is working on.
   *
   * After a join it is the join form's own field: hidden, not cleared, so it
   * still holds what was typed. Reached any other way there is nothing in it,
   * and #waitlist-confirm-email is where the address comes from instead.
   */
  const confirmAddress = useCallback(
    () => (codeOnly ? confirmEmail.current?.value.trim() : email.current?.value.trim()) || '',
    [codeOnly],
  );

  /**
   * Move to the code step, in state and in the fragment (#1876).
   *
   * Assigning the hash pushes a history entry, which is what makes the
   * browser's Back a working "wrong address" undo, and `waitlistOnShow`
   * re-derives the step from it — so the URL and the screen cannot disagree.
   */
  const goToCodeStep = useCallback(() => {
    setFlowStep('code');
    try {
      if (location.hash !== '#waitlist?confirm=1&step=code') {
        location.hash = '#waitlist?confirm=1&step=code';
      }
    } catch {
      /* ignore */
    }
    window.setTimeout(() => code.current?.focus({ preventScroll: true }), 0);
  }, []);

  /** Back to the address step, the same way and for the same reason. */
  const backToAddress = useCallback(() => {
    setMsg(null);
    setFlowStep('address');
    try {
      if (location.hash !== '#waitlist?confirm=1') location.hash = '#waitlist?confirm=1';
    } catch {
      /* ignore */
    }
    window.setTimeout(() => confirmEmail.current?.focus({ preventScroll: true }), 0);
  }, []);

  /**
   * Ask for a fresh code.
   *
   * The endpoint answers the same body to everybody, so there is nothing here
   * to branch on and nothing to report beyond "it is on its way if it applies
   * to you". That vagueness is the feature: a message that said "no such
   * address" would turn this button into a membership oracle. Whether the
   * address is already confirmed is said in the mail instead, which only its
   * owner reads.
   */
  const onResend = useCallback(async () => {
    if (resending || cooldownLeft > 0) return;
    const emailVal = confirmAddress();
    if (!emailVal) {
      return setResendNote({ text: 'Enter your email address first.', tone: 'error' });
    }
    setResending(true);
    setResendNote(null);
    try {
      const res = await fetch('/api/public/waitlist/resend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailVal }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        setResendNote({
          text: (data && data.message)
            || 'If that address is on our waitlist, a six-digit code is on its way.',
          tone: 'ok',
        });
        // Name the address the confirm copy is about, now that we have one.
        setSentTo(emailVal.toLowerCase());
        startCooldown();
      } else {
        setResendNote({
          text: (data && data.error) || 'Something went wrong. Try again.',
          tone: 'error',
        });
      }
    } catch {
      setResendNote({ text: 'Connection issue. Try again.', tone: 'error' });
    }
    setResending(false);
  }, [confirmAddress, cooldownLeft, resending, startCooldown]);

  /**
   * Send the code from the address step (#1876).
   *
   * Same endpoint and same frozen body as the resend above, so there is
   * nothing here to branch on: a request the server accepted ALWAYS advances,
   * whatever the address was. A step that advanced only for addresses we hold
   * would answer the membership question that constant body exists to refuse.
   * The "if that address is on our waitlist" line travels to the next step,
   * where the field it is about is.
   */
  const onRequestCode = useCallback(async () => {
    if (resending || cooldownLeft > 0) return;
    const emailVal = confirmAddress();
    if (!emailVal) {
      return setRequestNote({ text: 'Enter your email address first.', tone: 'error' });
    }
    setRequestNote(null);
    setResending(true);
    try {
      const res = await fetch('/api/public/waitlist/resend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailVal }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        setResendNote({
          text: (data && data.message)
            || 'If that address is on our waitlist, a six-digit code is on its way.',
          tone: 'ok',
        });
        // Name the address the next step's copy is about, now that we have one.
        setSentTo(emailVal.toLowerCase());
        startCooldown();
        setResending(false);
        goToCodeStep();
        return;
      }
      setRequestNote({
        text: (data && data.error) || 'Something went wrong. Try again.',
        tone: 'error',
      });
    } catch {
      setRequestNote({ text: 'Connection issue. Try again.', tone: 'error' });
    }
    setResending(false);
  }, [confirmAddress, cooldownLeft, goToCodeStep, resending, startCooldown]);

  /**
   * Carry on with a code already in hand (#1876).
   *
   * Not decoration: `issueVerificationCode` deletes every unconsumed code for
   * an address before minting the next one, so making this button send would
   * invalidate the code in the inbox of the person who just followed that
   * mail's own status button here. It sends nothing, and it leaves `sentTo`
   * alone so the next step says "the code from your email" rather than
   * claiming we mailed one just now.
   */
  const onHaveCode = useCallback(() => {
    const emailVal = confirmAddress();
    if (!emailVal) {
      return setRequestNote({ text: 'Enter your email address first.', tone: 'error' });
    }
    setRequestNote(null);
    goToCodeStep();
  }, [confirmAddress, goToCodeStep]);

  /**
   * Jump straight to the confirm step, for somebody who joined on another
   * device or whose code expired. It writes the state into the hash as well,
   * so a reload lands back here instead of on the join form.
   *
   * Also the check-my-status entry (#1538) — one control, because entering a
   * code to confirm and entering a code to read your status are the same six
   * digits typed into the same field. Two links for it would be two doors
   * into one room.
   */
  const onEnterCode = useCallback(() => {
    setMsg(null);
    setJoined(true);
    setCodeOnly(true);
    // At the address step (#1876): nothing has been sent from this device, so
    // there is nothing to type six digits of yet.
    setFlowStep('address');
    try {
      if (location.hash !== '#waitlist?confirm=1') location.hash = '#waitlist?confirm=1';
    } catch {
      /* ignore */
    }
    window.setTimeout(() => confirmEmail.current?.focus({ preventScroll: true }), 0);
  }, []);

  /**
   * Confirm the address with the six-digit code from the join mail. The link
   * in that same mail does the same thing; whichever is used first wins.
   *
   * The email input keeps its value after a join — the form is hidden, not
   * cleared — so `email.current` is still the address the code went to.
   */
  const onConfirmCode = useCallback(async () => {
    if (busy.current) return;
    const codeVal = code.current?.value.trim() || '';
    // A link straight to the code step has no address behind it (#1876): an
    // address never travels in a URL. Back to the step that collects one,
    // rather than a POST the server can only refuse in the one shape that
    // deliberately says nothing.
    if (codeOnly && !confirmAddress()) {
      backToAddress();
      return setMsg({ text: 'Enter the email address you joined with first.', tone: 'error' });
    }
    if (!/^[0-9]{6}$/.test(codeVal)) {
      return setMsg({ text: 'Enter the six-digit code from your email.', tone: 'error' });
    }
    busy.current = true;
    setSubmitting(true);
    try {
      const res = await fetch('/api/public/waitlist/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: confirmAddress(), code: codeVal }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        setMsg(null);
        setConfirmed(true);
        // Confirming is what puts somebody on the list, so it is also what
        // unlocks the questions that move them up it. The token may have
        // arrived on the join response instead of this one, so raise the
        // offer either way.
        const token = (data && data.more_token) || null;
        if (token) setMoreToken(token);
        // Where they actually stand (#1538). Both surfaces that describe a
        // signup derive this from the same server-side helper, so this panel
        // and `#more/<token>` cannot disagree about one row.
        const next: WaitlistStatus | null = (data && data.status) || null;
        setStatus(next);
        // The stage-2 questions move you UP the list, so they are not an
        // offer worth making to somebody already off it.
        setOffer(!next?.admitted);
      } else {
        setMsg({ text: (data && data.error) || 'That code did not work.', tone: 'error' });
      }
    } catch {
      setMsg({ text: 'Connection issue. Try again.', tone: 'error' });
    }
    busy.current = false;
    setSubmitting(false);
  }, [backToAddress, codeOnly, confirmAddress]);

  /**
   * Keep the field to six digits, and confirm as soon as it has them.
   *
   * The address bar is not where this code comes from: people paste it out of
   * a mail app, which brings "123 456" or "Code: 123456" with it. Strip rather
   * than reject — and because the strip is what enforces the length, the
   * field's own `maxLength` is loose enough that a pasted string reaches it
   * intact instead of being truncated mid-number.
   *
   * The Confirm button stays. Auto-submit is the fast path, not the only one:
   * a wrong code has to be correctable, and correcting one digit of six is an
   * edit, not a sixth keystroke.
   */
  const onCodeInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const el = e.currentTarget;
      const digits = el.value.replace(/[^0-9]/g, '').slice(0, 6);
      if (digits !== el.value) el.value = digits;
      setMsg(null);
      if (digits.length === 6) void onConfirmCode();
    },
    [onConfirmCode],
  );

  const live = useRef({ waitlistOnShow });
  live.current = { waitlistOnShow };
  useAuthScreensPatch({
    _wireWaitlist: () => {},
    _waitlistOnShow: () => live.current.waitlistOnShow(),
  });

  return (
    <main
      ref={rootRef}
      id="auth-waitlist-screen"
      className="hidden fixed inset-0 z-40 overflow-y-auto platform-safe-scroll"
    >
      {mounted ? (
        <>
      {/*
          #1875: the Back control SCROLLS WITH THE PAGE. It was a `fixed`,
          transparent "← Back" text link, so on a phone the step label, the
          heading and the form all slid underneath it and the two texts
          painted over each other. `absolute` inside the screen's own scroller
          keeps it at the top-left corner above the content and lets it leave
          with the rest of the page — nothing can pass under it. It takes the
          sign-in and register screens' 44px round chevron, so it is a real
          tap target and the three auth screens share one Back.
      */}
      <a
        href="#landing"
        data-auth-back=""
        className="absolute left-4 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-white text-zinc-900 shadow-sm hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
        style={{ top: 'calc(env(safe-area-inset-top, 0px) + 0.75rem)' }}
        aria-label="Back"
      >
        <ChevronLeftIcon className="w-6 h-6" aria-hidden="true" />
      </a>
      <div className="max-w-2xl mx-auto px-6 py-16">
        {/*
            Where you are. Hidden for a waiting-room session, which is shown
            `#waitlist-queued` rather than a flow it is already past.
        */}
        <p
          id="waitlist-step"
          className={hiddenLast(
            hasSession,
            'text-xs font-semibold uppercase tracking-widest text-violet-700 dark:text-violet-400',
          )}
        >
          {confirmed
            ? (codeOnly ? 'Your status' : 'All done')
            : joined
              ? codeOnly
                ? flowStep === 'code'
                  ? 'Step 2 of 2 · Enter your code'
                  : 'Step 1 of 2 · Your email address'
                : 'Step 1 complete · Joined the waitlist'
              : 'Step 1 of 2 · Your email'}
        </p>
        {/*
            The pitch. It answers "why would I join", so it belongs to step 1
            only — after the join it is four blocks of answered question sitting
            on top of the one instruction that still matters.
        */}
        <h1 className={hiddenLast(joined, 'mt-1 text-2xl font-bold')}>
          Join the waitlist
        </h1>
        {/*
            #1541: the same four facts, as a lead and a list.

            This was two paragraphs of roughly seventy-five words, and the
            report was simply that the screen is too much reading. Nothing has
            been dropped: what the place is, who built the apps, what the chain
            and the share mean, and how access opens are all still here. They
            are four separate claims, and a reader scanning for "what is this
            and what does joining cost me" was having to take them as prose.
        */}
        <p className={hiddenLast(joined, 'mt-3 text-sm text-zinc-500 dark:text-zinc-400')}>
          Describe the app you want in chat, an AI builds it, and the group
        votes the changes in.
        </p>
        <ul
          className={hiddenLast(
            joined,
            'mt-3 space-y-1.5 text-sm text-zinc-500 dark:text-zinc-400 list-disc pl-5',
          )}
        >
          <li>
            Every app in the directory was built here, by the people who use it.
          </li>
          <li>
            They run on the Homeroom chain, and contributors own a share of what
          they build.
          </li>
          <li>
            Access opens in batches. The public apps are open to everyone now.
          </li>
        </ul>
        <p className={hiddenLast(joined, 'mt-3 text-sm font-medium text-zinc-700 dark:text-zinc-200')}>
          Just your email to join.
        </p>
        {/*
            Stage-1 waitlist survey (two-stage waitlist, ported from the
            original topochain waitlist): email, something you've made,
            where you are, how you found us. Option chips and the country
            list render from GET /api/public/waitlist/options so the form
            and server validation share one definition.
        */}
        <form
          id="waitlist-form"
          className={hiddenLast(hasSession || joined, 'mt-8 space-y-5')}
          onSubmit={onSubmit}
        >
          <div>
            <label htmlFor="waitlist-email" className="block text-sm font-medium text-zinc-700 dark:text-zinc-200">
              {/* #1877: the marker sits a hair off the word rather than
                  touching it, and is hidden from screen readers — the input's
                  own `required` is what announces the field as required. */}
              Your email address
              <span className="ml-0.5 text-red-700 dark:text-red-400" aria-hidden="true">
                *
              </span>
            </label>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 mb-1.5">
              We only email you when your spot comes up. No newsletter.
            </p>
            <input
              ref={email}
              id="waitlist-email"
              type="email"
              required={true}
              maxLength={255}
              placeholder="you@example.com"
              autoComplete="email"
              className="w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500"
            />
          </div>
          <div>
            {/* #1877: JSX drops the line break between a label's text and the
                span after it, so without its own margin "Optional" rendered
                glued to the word ("CountryOptional"). */}
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-200">
              Country
              <span className="ml-1.5 text-xs text-zinc-500 font-normal dark:text-zinc-400">
                Optional
              </span>
            </label>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 mb-1.5">
              We&rsquo;re building early groups across different regions.
            </p>
            {/*
                #1529: the focused state COLOURS the border rather than making
                it transparent.

                Every field on both waitlist screens used
                `focus:ring-2 focus:border-transparent`, which draws the
                indicator entirely with a box-shadow ring and removes the
                resting border to make room for it. iOS Safari does not paint
                box-shadow on a natively-styled control, so on a phone the
                border vanished on tap and nothing replaced it — the outline
                "disappearing when clicked" that was reported. The ring still
                draws everywhere it is supported; the border colour is what
                guarantees a visible focus on the surfaces that ignore it.
            */}
            <select
              ref={country}
              id="waitlist-country"
              className="w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500"
            >
              <option value="">
                Select a country&hellip;
              </option>
              {/* One flat alphabetical list of all 249 ISO 3166-1 countries
                  and territories. It was six <optgroup> region buckets until
                  #1527: they left ~200 places unselectable and hid the ones
                  they did carry from an alphabetical scan. The server sends
                  the map already sorted by English name, so insertion order
                  IS display order and nothing sorts here. */}
              {opts(options?.countries)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-200">
              How did you find us?
              <span className="ml-1.5 text-xs text-zinc-500 font-normal dark:text-zinc-400">
                Optional
              </span>
            </label>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 mb-1.5">
              Pick the closest one.
            </p>
            <ChipRow
              id="waitlist-discovery-chips"
              options={options?.discovery_sources || {}}
              value={discovery}
              onChange={setDiscovery}
            />
          </div>
          <Button
            type="submit"
            id="waitlist-submit"
            disabled={submitting}
            disabledStyle="dim"
            size="lg"
          >
            Join the waitlist
          </Button>
        </form>
        <p id="waitlist-msg" className={msgClass(msg ? msg.tone : null)}>
          {msg ? msg.text : null}
        </p>
        {/*
            The way back in. A code expires fifteen minutes after a join that
            may have been weeks ago, and before this the only route to the
            control that accepts one was to submit the join form again — which
            said "we sent a code" while the idempotent join sent nothing. Step
            1 only: past it, the control is already on screen.

            It is also the check-my-status entry (#1538): the same six digits
            typed into the same field, whether the errand is confirming an
            address or reading back where you stand. So the label names the
            errand people arrive with rather than the mechanism.
        */}
        <p className={hiddenLast(hasSession || joined, 'mt-4 text-sm text-zinc-500 dark:text-zinc-400')}>
          {'Already joined? '}
          <button
            id="waitlist-enter-code"
            type="button"
            onClick={onEnterCode}
            className="font-medium text-violet-700 dark:text-violet-400 hover:underline"
          >
            Check your status
          </button>
        </p>
        {/*
            Acknowledge the saved signup first, then present confirmation.
            Returning code entry has no new join to acknowledge.
        */}
        <div id="waitlist-joined" className={hiddenFirst(!joined, 'mt-8')}>
          <h2 className={hiddenLast(confirmed, 'text-2xl font-bold')}>
            {codeOnly ? 'Check your status' : "You're on the waitlist!"}
          </h2>
          <p className={hiddenLast(confirmed, 'mt-1 text-sm text-zinc-500 dark:text-zinc-400')}>
            {/*
                The lede follows the step (#1876). On step 2 the address field
                is not on screen, so the original sentence was instructing the
                reader to do something they could no longer see. It keeps the
                claim and drops the instruction, and says nothing about a mail
                having been sent: "I already have a code" arrives here with no
                send behind it.
            */}
            {codeOnly
              ? flowStep === 'code'
                ? 'This shows where you stand, and confirms your address if it still needs it.'
                : 'Enter the address you joined with and we\u2019ll email you a code. It shows where you stand, and confirms your address if it still needs it.'
              : 'Your signup is saved. Next, confirm your email so we can let you know when your spot opens.'}
          </p>
          {/*
              Confirming by code, for the phone: leaving for the mail app and
              coming back loses the WebView's place, so typing six digits
              beats following a link. The same mail carries both, and the
              first one used stamps confirmed_at.
          */}
          <div id="waitlist-confirm" className={hiddenLast(confirmed, 'mt-4')}>
            {/*
                Step 1 of the check-my-status errand (#1876): which address,
                and the send. Only ever on screen on that path, so the group
                carries `codeOnly` as well as the step — after a join the mail
                is already out and there is nothing here to ask for.

                Plain `hidden` rather than `hiddenFirst`, because this one
                ships hidden AND stays hidden for a whole path; and a wrapper
                rather than `display: contents`, which `.hidden` cannot
                override.
            */}
            <div
              id="waitlist-confirm-address"
              className={codeOnly && flowStep === 'address' ? '' : 'hidden'}
            >
              <label
                htmlFor="waitlist-confirm-email"
                className="block text-sm font-medium text-zinc-700 dark:text-zinc-200"
              >
                Your email address
              </label>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 mb-1.5">
                Enter the address you joined with. We will email you a six-digit code.
              </p>
              {/*
                  Which address, when this step was reached without a join.
                  Always in the markup and hidden until it is needed: the id is
                  part of the shell's inventory, so rendering it conditionally
                  would take it out of the document. After a join the join
                  form's own field still holds the address, so asking again
                  would be asking somebody to retype what they just typed.
              */}
              <input
                ref={confirmEmail}
                id="waitlist-confirm-email"
                type="email"
                maxLength={255}
                placeholder="you@example.com"
                autoComplete="email"
                className={hiddenFirst(
                  !codeOnly,
                  'w-full mb-2 rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500',
                )}
              />
              <Button
                id="waitlist-request-code"
                type="button"
                disabled={resending || cooldownLeft > 0}
                disabledStyle="dim"
                size="lg"
                onClick={onRequestCode}
              >
                {cooldownLeft > 0
                  ? `Email me a code (${cooldownLeft}s)`
                  : resending
                    ? 'Sending\u2026'
                    : 'Email me a code'}
              </Button>
              {/*
                  For the reader who arrived from the status mail, which
                  carries a code already. Sends nothing on purpose: issuing a
                  new code deletes the unconsumed one, so a send here would
                  invalidate the code they came to type.
              */}
              <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
                <button
                  id="waitlist-have-code"
                  type="button"
                  onClick={onHaveCode}
                  className="font-medium text-violet-700 dark:text-violet-400 hover:underline"
                >
                  I already have a code
                </button>
              </p>
              {/*
                  This step's own answer. A request that failed says why here
                  and stays put; one that succeeded advances, and says so on
                  the next step beside the field it is about.
              */}
              <p
                id="waitlist-request-note"
                className={msgClass(requestNote ? requestNote.tone : null)}
              >
                {requestNote ? requestNote.text : null}
              </p>
            </div>
            {/*
                Step 2 (#1876): the six digits. Visible by default, because
                that is what the post-join path shows and what the shell
                shipped; the split only hides it while the address step is up.
            */}
            <div
              id="waitlist-confirm-code"
              className={codeOnly && flowStep === 'address' ? 'hidden' : ''}
            >
              {/*
                  The way back, for the address that was a typo. Assigning the
                  fragment is what makes the browser's own Back do the same
                  thing, so the two cannot disagree.
              */}
              <p className={hiddenFirst(!codeOnly, 'mb-1.5')}>
                <button
                  id="waitlist-change-email"
                  type="button"
                  onClick={backToAddress}
                  className="text-sm font-medium text-violet-700 dark:text-violet-400 hover:underline"
                >
                  {'\u2190 Back to your email address'}
                </button>
              </p>
              <label
                htmlFor="waitlist-code"
                className="block text-sm font-medium text-zinc-700 dark:text-zinc-200"
              >
                {codeOnly ? 'Your six-digit code' : 'Step 2 of 2 · Confirm your email'}
              </label>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 mb-1.5">
                {codeOnly && !sentTo
                  ? 'Enter the six-digit code from your email. Codes work for 15 minutes, so if yours has expired, ask for a new one below.'
                  : sentTo
                    ? `We sent a six-digit code to ${sentTo}. You can also just click the link in that email.`
                    : 'We sent a six-digit code. You can also just click the link in that email.'}
              </p>
              <div className="flex gap-2">
                <input
                  ref={code}
                  id="waitlist-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={32}
                  placeholder="000000"
                  onChange={onCodeInput}
                  className="w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm font-mono placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500"
                />
                <Button
                  id="waitlist-code-submit"
                  type="button"
                  disabled={submitting}
                  disabledStyle="dim"
                  layout="shrink"
                  size="narrow"
                  onClick={onConfirmCode}
                >
                  Confirm
                </Button>
              </div>
              {/*
                  A new code, for the expired one. The gap is a courtesy that
                  collapses a double-tap, not a security boundary: the real
                  per-address ceiling lives in the mail throttle, where a
                  countdown cannot be read off the page as a membership test.
              */}
              <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                {"Didn't get it, or has it expired? "}
                <button
                  id="waitlist-resend"
                  type="button"
                  disabled={resending || cooldownLeft > 0}
                  onClick={onResend}
                  className="font-medium text-violet-700 dark:text-violet-400 hover:underline disabled:opacity-50 disabled:no-underline disabled:cursor-default"
                >
                  {cooldownLeft > 0
                    ? `Send a new code (${cooldownLeft}s)`
                    : resending
                      ? 'Sending\u2026'
                      : 'Send a new code'}
                </button>
              </p>
              {/*
                  The resend's own answer. Separate from #waitlist-msg so a
                  wrong code and a resend result cannot overwrite each other:
                  they are the two things somebody does here, often in that
                  order, and one line for both loses whichever came first.
              */}
              <p
                id="waitlist-resend-note"
                className={msgClass(resendNote ? resendNote.tone : null)}
              >
                {resendNote ? resendNote.text : null}
              </p>
            </div>
          </div>
          {/*
              What replaces the block above. `confirmed` used to only hide it,
              so a correct code deleted the control and said nothing — the
              reading of which is that something went wrong.
          */}
          <div
            id="waitlist-confirmed"
            className={hiddenFirst(
              !confirmed,
              'mt-4 rounded-lg border border-emerald-200 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/10 p-4',
            )}
          >
            {/*
                The celebration belongs to the moment somebody joins and
                confirms, which is what this panel used to be for. A visitor
                who typed their address to READ their state joined weeks ago,
                so congratulating them reads as a machine that has lost track
                — and it says the same thing the pill below says. So the
                headline is the confirm path's and the pill is the status
                path's. `codeOnly` is false in the prerender, which is the
                document's own shape: it always shipped this line visible.
            */}
            <p
              id="waitlist-confirmed-headline"
              className={hiddenFirst(
                codeOnly,
                'text-sm font-medium text-emerald-700 dark:text-emerald-400',
              )}
            >
              {admitted ? "You\u2019re in \ud83c\udf89" : 'You\u2019re on the list \ud83c\udf89'}
            </p>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">
              {admitted
                ? (status?.has_account
                  ? 'Your account already has access. Sign in any time.'
                  : 'Access is open for you. Create your account with this address and you\u2019re straight in.')
                : 'We\u2019re opening access in small groups. We\u2019ll email you when yours comes up.'}
            </p>
            {/*
                The same three-state vocabulary the stage-2 screen shows, from
                the same table in waitlist-shared.tsx (#1538) — two copies of
                it is how one row starts being described two ways. Empty and
                `hidden` until a code lands, because the prerender has no
                status to render and contents rendered before the fetch are a
                hydration mismatch.
            */}
            <div className="mt-2">
              <StatusPill
                id="waitlist-status-pill"
                status={codeOnly ? status : null}
                note={false}
              />
            </div>
            {/*
                When they joined. A fact the row actually knows, offered in
                place of the queue position this panel deliberately does not
                show: nothing ranks the waitlist, so a number would be made up.
                Same always-in-the-markup contract as the address line below.
            */}
            <p
              id="waitlist-status-since"
              className={hiddenFirst(
                !joinedOn,
                'mt-2 text-sm text-zinc-500 dark:text-zinc-400',
              )}
            >
              {joinedOn ? 'On the list since ' + joinedOn : null}
            </p>
            {/*
                Which address that mail goes to (#1537). Always in the markup and
                hidden until there is an address to name: the prerendered
                document has none, and the id is part of the shell's inventory,
                so rendering the node conditionally would take it out of the
                document entirely. An empty "Registered with" reads as a bug,
                hence `hidden` rather than an empty line. `break-words` so a long
                address wraps instead of widening the card on a phone.
            */}
            <p
              id="waitlist-confirmed-email"
              className={hiddenFirst(
                !sentTo,
                'mt-2 text-sm text-zinc-500 dark:text-zinc-400 break-words',
              )}
            >
              {'Registered with '}
              <span className="font-medium text-zinc-700 dark:text-zinc-200">{sentTo}</span>
            </p>
            {/*
                The one thing a released signup can act on (#1538). Before
                this, somebody who lost the "your access is ready" mail was
                told to keep waiting for it. Hash routes rather than the
                mail's `/?signup=1` spelling: same destination, and
                AuthScreens.enter() rewrites the query form to exactly this
                one on arrival, so taking it directly skips a document reload.
                Which of the two depends on whether the invite has already
                been redeemed into an account, which is a different question
                from having been admitted.

                No `data-offline-disabled`: that attribute greys a control out
                AND swallows its clicks, and it is confined to the landing and
                login screens on purpose (tests/pwa-shell-wiring.test.js). This
                is a hash navigation to a screen that carries its own offline
                affordances, so blocking it here would only strand the reader
                on this panel.
            */}
            <a
              id="waitlist-status-action"
              href={status?.has_account ? '#login' : '#signup'}
              className={hiddenFirst(
                !admitted,
                'mt-3 inline-block rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-medium text-white transition-colors',
              )}
            >
              {status?.has_account ? 'Sign in' : 'Create my account'}
            </a>
          </div>
          <div
            id="waitlist-more-offer"
            // Hidden once admitted (#1538): moving up a list you are already
            // off is not an offer worth making.
            className={hiddenFirst(
              !offer || admitted,
              'mt-4 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/60 p-4',
            )}
          >
            <p className="text-xs font-semibold uppercase tracking-widest text-violet-700 dark:text-violet-400">
              Optional (moves you up the list)
            </p>
            <h3 className="mt-1 text-base font-semibold">
              Want in sooner?
            </h3>
            <p className="mt-1.5 text-sm text-zinc-500 dark:text-zinc-400">
              {surveyAnswered
                ? 'Your answers are saved. Add to them any time, and they merge, so nothing you already wrote is lost.'
                : 'Four more questions, about three minutes: the group you\u2019d bring, a tool you\u2019ve lost, where else you are. These are the answers we actually read when we pick the next group.'}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
              <a
                id="waitlist-more-link"
                href={moreToken ? '#more/' + moreToken : '#landing'}
                className="rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-medium text-white transition-colors"
              >
                {surveyAnswered ? 'Edit my answers' : 'Answer them now'}
              </a>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                Or stop here. You&rsquo;re on the list either way, and the link is in your email.
              </span>
            </div>
          </div>
        </div>
        {/*
            Swapped in for the form when a (waiting-room) session exists —
            they already have an account in the queue, so asking them to
            join again is wrong. Mirrors #landing-cta-queued.
        */}
        <p
          id="waitlist-queued"
          className={hiddenFirst(!hasSession, 'mt-8 text-sm text-zinc-500 dark:text-zinc-400')}
        >
          You're already on the waitlist. We'll email you when your spot opens.
        </p>
      </div>
        </>
      ) : null}
    </main>
  );
}
