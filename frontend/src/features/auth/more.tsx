/**
 * `#auth-more-screen` — the stage-2 waitlist survey (#1080, step 2 chunk C,
 * screen 6 of 6).
 *
 * "Want in sooner?": four optional questions reached at `#more/<token>`, from
 * the stage-1 success state or the join email. Answers merge server-side, so the
 * form is re-openable and every show re-reads
 * `GET /api/public/waitlist/more/<token>` to render what is already stored.
 *
 * ── What the initial render must be ───────────────────────────────────
 *
 * Both outcomes of the token check start hidden — the form AND the bad-token
 * notice — because that is what the hand-written document shipped and the
 * prerender pass has to reproduce it byte for byte. Same for everything the
 * options payload fills: the two selects hold only their placeholder `<option>`,
 * the three chip rows are empty `<div>`s, the connect row is empty, the invite
 * link and its joined-count are empty, and the loss detail block keeps its
 * `hidden`. Nothing is fetched until the router shows the screen.
 *
 * ── Uncontrolled inputs, on purpose ──────────────────────────────────
 *
 * The free-text fields are refs, not React state: a `value` prop would put the
 * stored answers into the prerendered HTML (there aren't any at prerender time,
 * but an empty `value=""` attribute is still a byte difference), and the screen
 * only ever reads them at submit. So the load path assigns `.value` the way
 * `_renderMore` did — the form element is mounted from the first render, just
 * hidden, so its refs are live well before the fetch resolves.
 *
 * ── Saving ends the form ─────────────────────────────────────────────
 *
 * A successful POST used to write "Saved. Thanks." into `#more-msg` and leave
 * the whole questionnaire on screen under a heading still asking "Want in
 * sooner?". After three minutes of typing that is a footnote, not an ending.
 * `saved` now hides the intro and the form and reveals `#more-saved`.
 *
 * Editing is one button away rather than a dead end, because answers MERGE
 * server-side — reopening this form and adding to it is the intended path, not
 * a recovery. `moreOnShow` resets the flag so the emailed link always lands on
 * the form.
 *
 * ── ?connect= ────────────────────────────────────────────────────────
 *
 * GitHub / X / LinkedIn verification is a `/waitlist/connect/<provider>` OAuth
 * round trip
 * that comes back to `#more/<token>?connect=<outcome>` — inside the hash, so the
 * token never reaches a server log. The outcome is read on show and painted into
 * the same status line the submit uses. It proves the account is THEIRS; no
 * provider here can tell us whether they followed anything.
 *
 * ── Follow along ─────────────────────────────────────────────────────
 *
 * Which is why `#more-follow-row` is links plus a checkbox rather than a
 * second verification. The links come from WAITLIST_FOLLOW_<NETWORK>_URL,
 * so an unconfigured network renders nothing instead of a dead profile
 * link, and the tick is stored as `answers.followed_claim` — a claim,
 * beside `answers.verified` and never inside it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

import { Button } from '@/components/ui/button';

import { useMountedOnReveal } from '../../lib/mount-on-reveal';
import { useVisibilityHiddenClass } from '../../lib/visibility-store';
import { normalizeMadeUrl } from './made-url';
import { AUTH_SCREEN_IDS, hiddenFirst, hiddenLast, useAuthScreensPatch } from './shared';
import {
  ChipRow,
  MsgTone,
  MultiChipRow,
  msgClass,
  options as optionList,
  markSurveyAnswered,
  StatusPill,
  toggleChip,
  waitlistOptions,
  WaitlistOptions,
  WaitlistStatus,
} from './waitlist-shared';

/**
 * Did this submission actually say anything? (#1539)
 *
 * Every field on the form is optional and the endpoint accepts an empty body,
 * so pressing Save with nothing filled in used to store nothing and answer
 * with the same confirmation panel a full set of answers gets.
 *
 * "Something" is deliberately broad: a chip, a select, a handle, a tick on
 * "I followed along" — any one of them is an answer. The three shapes a field
 * can take (an `undefined`-or-string, an array of chips, the follow boolean)
 * are all handled here rather than at each call site, so a question added
 * later is covered by construction.
 */
export function hasAnyAnswer(payload: Record<string, unknown>): boolean {
  return Object.values(payload).some((v) => {
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'boolean') return v;
    return typeof v === 'string' && v.trim() !== '';
  });
}

/**
 * #1530: grow a long-answer box to fit what is in it.
 *
 * The two open questions ship `rows={3}`, and a three-line window is a poor
 * place to write the paragraph the prompt asks for — the answer scrolls away
 * from the person writing it. This resizes the box instead.
 *
 * Two details are load-bearing. `auto` FIRST, so deleting text can shrink the
 * box again: with an explicit height still set, `scrollHeight` can only ever
 * grow. And the height is only written when the element actually measures —
 * a screen that is still `hidden` reports `scrollHeight === 0`, and pinning
 * that would collapse the box to nothing. Leaving it alone there is safe:
 * `rows` governs until the first real measurement, and the reveal paths below
 * take one.
 *
 * The height is written imperatively rather than through a `style` prop
 * because the first render has to stay byte-identical to the prerendered
 * document (AGENTS.md); a rendered `style=""` is a difference.
 */
function autoGrow(el: HTMLTextAreaElement | null | undefined): void {
  if (!el) return;
  el.style.height = 'auto';
  if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight}px`;
}

/**
 * The typed answers, parked across the OAuth round trip (#1533).
 *
 * Connecting GitHub / X / LinkedIn opens the provider in a NEW tab (#1532),
 * and that tab comes back to `#more/<token>?connect=<outcome>` — a cold
 * re-entry of this screen. The fields here are uncontrolled refs read only at
 * submit (see the header), so the landing tab paints an empty form: somebody
 * three minutes into the questions carries on where the provider left them,
 * and finds nothing they had typed.
 *
 * Parked in `sessionStorage` under the token, so two signups in one browser
 * cannot read each other's draft and nothing outlives the tab. Every access is
 * wrapped: Safari throws on storage in private mode, and a draft is never
 * worth failing a screen over.
 *
 * What comes back is only ever used to fill a field the SERVER left empty —
 * see `restoreDraft`. A stored answer always wins over a parked one, which is
 * what stops a stale draft overwriting something already saved.
 */
const DRAFT_PREFIX = 'usernode:waitlist-more-draft:';

type MoreDraft = Record<string, string>;

function draftKey(token: string | null): string | null {
  return token ? `${DRAFT_PREFIX}${token}` : null;
}

function saveDraft(token: string | null, draft: MoreDraft): void {
  const key = draftKey(token);
  if (!key) return;
  try {
    sessionStorage.setItem(key, JSON.stringify(draft));
  } catch { /* private mode, or storage denied */ }
}

function readDraft(token: string | null): MoreDraft | null {
  const key = draftKey(token);
  if (!key) return null;
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as MoreDraft) : null;
  } catch {
    return null;
  }
}

function clearDraft(token: string | null): void {
  const key = draftKey(token);
  if (!key) return;
  try { sessionStorage.removeItem(key); } catch { /* nothing to clear */ }
}

/** `GET /api/public/waitlist/more/<token>`. Every field is optional. */
interface MoreAnswers {
  made_url?: string;
  made_note?: string;
  group?: { name?: string; size?: string; role?: string; tools?: string[]; need?: string };
  loss?: { had?: string; product?: string; kind?: string[]; story?: string };
  handles?: { farcaster?: string; discord?: string; telegram?: string; other?: string };
  verified?: Record<string, string>;
  followed_claim?: boolean;
}

interface MorePayload {
  ok?: boolean;
  /** Also published at the top level of the payload; this is the same value. */
  admitted?: boolean;
  status?: WaitlistStatus;
  /**
   * The address this signup was made with (#1537). Present on the full read
   * only; the `?view=status` poll does not carry it.
   */
  email?: string;
  answers?: MoreAnswers;
  oauth?: Record<string, boolean>;
  /** Public profile URLs for "Follow along". A network with none is absent. */
  follow?: Record<string, string | null>;
  /** The signup's own share link, and who has joined through it so far. */
  invite?: { url?: string | null; count?: number; emails?: string[] };
}

/**
 * Which address this signup was made with (#1537). Same contract as the pill
 * above it: always in the markup, empty and `hidden` in the prerender, filled
 * by the load effect — contents rendered before the fetch would be a hydration
 * mismatch, and a mismatch console.errors, which fails proposal checks.
 *
 * Plain text, never a `mailto:` anchor. The address here is a fact being read
 * back, not a control, and a tappable one on a phone opens a mail composer
 * nobody asked for.
 */
function SignupEmail({ email }: { email: string }) {
  return (
    <p
      id="more-signup-email"
      className={`text-xs text-zinc-500 dark:text-zinc-400 break-words${email ? '' : ' hidden'}`}
    >
      {'Registered with '}
      <span className="font-medium text-zinc-700 dark:text-zinc-200">{email}</span>
    </p>
  );
}

export function MoreScreen() {
  const rootRef = useRef<HTMLElement>(null);
  useVisibilityHiddenClass(rootRef, AUTH_SCREEN_IDS.more, false);
  // The screen's interior mounts on its first reveal, not in the prerender —
  // see lib/mount-on-reveal.ts. AuthScreens.show() asks for it (through
  // window.UsernodeReact.mount) before it wires or reveals the screen, so the
  // hooks this component patches onto AuthScreens are installed and the
  // interior's nodes exist by the time the on-show hook runs.
  const mounted = useMountedOnReveal(AUTH_SCREEN_IDS.more);

  // 'idle' is the prerendered state: neither the form nor the notice is shown.
  // 'throttled' is a rate-limited load — the token may be perfectly fine, so
  // it gets its own copy instead of the bad-link notice (#1296).
  const [status, setStatus] = useState<'idle' | 'invalid' | 'throttled' | 'ready'>('idle');
  const [retryText, setRetryText] = useState('a few minutes');
  const [opts, setOpts] = useState<WaitlistOptions | null>(null);
  const [tools, setTools] = useState<string[]>([]);
  const [lossHad, setLossHad] = useState<string | null>(null);
  const [lossKinds, setLossKinds] = useState<string[]>([]);
  const [connect, setConnect] = useState<{
    verified: Record<string, string>;
    oauth: Record<string, boolean>;
  }>({ verified: {}, oauth: {} });
  /**
   * "Follow along" targets. Empty at first render, which is also the
   * prerendered state: the row emits no links until the load effect fills
   * it, so the initial markup stays what the hand-written shell shipped.
   */
  const [follow, setFollow] = useState<Record<string, string | null>>({});
  /**
   * The queue-position pill. `null` is the prerendered state and renders
   * NOTHING: the interior mounts on reveal, so a pill with data in it before
   * the fetch resolves is a hydration mismatch, which console.errors and
   * fails proposal checks.
   */
  const [queue, setQueue] = useState<WaitlistStatus | null>(null);
  /**
   * The address behind this token, for the same reason the pill is here: this
   * screen is where the mailed confirm link lands, so it is the "you're on the
   * list" surface a returning visitor actually sees, and until now it named
   * every fact about the signup except which address it was made with (#1537).
   * Empty is the prerendered state and renders nothing.
   */
  const [signupEmail, setSignupEmail] = useState('');
  const [inviteUrl, setInviteUrl] = useState('');
  const [inviteCount, setInviteCount] = useState(0);
  const [inviteEmails, setInviteEmails] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const [msg, setMsg] = useState<{ text: string; tone: MsgTone } | null>(null);
  const [saving, setSaving] = useState(false);
  /** Answers are in. The form steps aside for `#more-saved`. */
  const [saved, setSaved] = useState(false);

  const madeUrl = useRef<HTMLInputElement>(null);
  const madeNote = useRef<HTMLInputElement>(null);
  const groupName = useRef<HTMLInputElement>(null);
  const groupSize = useRef<HTMLSelectElement>(null);
  const groupRole = useRef<HTMLSelectElement>(null);
  const groupNeed = useRef<HTMLTextAreaElement>(null);
  const lossProduct = useRef<HTMLInputElement>(null);
  const lossStory = useRef<HTMLTextAreaElement>(null);
  const farcaster = useRef<HTMLInputElement>(null);
  const discord = useRef<HTMLInputElement>(null);
  const telegram = useRef<HTMLInputElement>(null);
  const other = useRef<HTMLInputElement>(null);
  const followed = useRef<HTMLInputElement>(null);

  // The token from `#more/<token>`.
  const token = useRef<string | null>(null);

  /**
   * Read the OAuth round trip's outcome out of the hash's own query string.
   * Returns null when there wasn't one, which is the "clear the line" case.
   */
  const connectMsg = useCallback((): { text: string; tone: MsgTone } | null => {
    let outcome: string | null = null;
    try {
      outcome = new URLSearchParams(location.hash.split('?')[1] || '').get('connect');
    } catch {
      outcome = null;
    }
    if (outcome === 'ok') return { text: 'Account verified. Thanks.', tone: 'ok' };
    if (outcome === 'failed' || outcome === 'denied' || outcome === 'unavailable') {
      return {
        text:
          outcome === 'unavailable'
            ? 'That sign-in is not available yet.'
            : 'Could not verify that account. Please try again.',
        tone: 'warn',
      };
    }
    return null;
  }, []);

  /** Apply a loaded payload: state for the rendered bits, refs for the text. */
  const render = useCallback(
    (payload: MorePayload) => {
      const a = payload.answers || {};
      const group = a.group || {};
      const loss = a.loss || {};
      const handles = a.handles || {};

      if (groupName.current) groupName.current.value = group.name || '';
      if (groupSize.current) groupSize.current.value = group.size || '';
      if (groupRole.current) groupRole.current.value = group.role || '';
      setTools(group.tools || []);
      if (groupNeed.current) groupNeed.current.value = group.need || '';

      setLossHad(loss.had || null);
      if (lossProduct.current) lossProduct.current.value = loss.product || '';
      setLossKinds(loss.kind || []);
      if (lossStory.current) lossStory.current.value = loss.story || '';

      // Stored answers arrive by assignment, which fires no input event, so
      // the boxes are sized here too — otherwise reopening the form shows a
      // long saved answer through a three-line window (#1530).
      autoGrow(groupNeed.current);
      autoGrow(lossStory.current);

      if (farcaster.current) farcaster.current.value = handles.farcaster || '';
      if (discord.current) discord.current.value = handles.discord || '';
      if (telegram.current) telegram.current.value = handles.telegram || '';
      if (other.current) other.current.value = handles.other || '';

      setConnect({ verified: a.verified || {}, oauth: payload.oauth || {} });
      setFollow(payload.follow || {});
      setQueue(payload.status || null);
      setSignupEmail(payload.email || '');

      if (madeUrl.current) madeUrl.current.value = a.made_url || '';
      if (madeNote.current) madeNote.current.value = a.made_note || '';

      // The share link and its joined-count. Both start empty so the first
      // render matches the prerender; this effect is the only thing that
      // fills them.
      setInviteUrl(payload.invite?.url || '');
      setInviteCount(payload.invite?.count || 0);
      setInviteEmails(Array.isArray(payload.invite?.emails) ? payload.invite.emails : []);

      if (followed.current) followed.current.checked = !!a.followed_claim;

      setMsg(connectMsg());
    },
    [connectMsg],
  );

  /**
   * Both requests for a show, together: the memoised options and this token's
   * stored answers. Anything missing — no token, a network failure, a rejected
   * token — lands on the bad-link notice with the form hidden.
   */
  const loadMore = useCallback(async () => {
    const value = token.current;
    if (!value) {
      setStatus('invalid');
      return;
    }
    const [loaded, res] = await Promise.all([
      waitlistOptions(),
      fetch('/api/public/waitlist/more/' + encodeURIComponent(value)).catch(() => null),
    ]);
    if (!loaded || !res || !res.ok) {
      // A 429 is the rate limiter talking, not a verdict on the token —
      // clicking the emailed confirm link right after joining and saving
      // the survey can land here. Say so instead of "bad link" (#1296).
      if (res && res.status === 429) {
        const body = await res.json().catch(() => null);
        const secs = Number(body?.retryAfterSeconds);
        if (Number.isFinite(secs) && secs > 0) {
          const mins = Math.ceil(secs / 60);
          setRetryText(mins > 1 ? `about ${mins} minutes` : 'about a minute');
        } else {
          setRetryText('a few minutes');
        }
        setStatus('throttled');
        return;
      }
      setStatus('invalid');
      return;
    }
    const data: MorePayload | null = await res.json().catch(() => null);
    if (!data || !data.ok) {
      setStatus('invalid');
      return;
    }
    // The options have to be in the DOM before the stored answers are assigned:
    // setting `.value` on a <select> whose <option>s don't exist yet is silently
    // dropped, which is exactly why `_renderMore` called `_fillSelect` first.
    // flushSync reproduces that order — options rendered, then values assigned,
    // all in this tick, so the reveal below is still a single paint.
    flushSync(() => {
      setOpts(loaded);
    });
    render(data);
    setStatus('ready');
  }, [render]);

  /**
   * Every free-text field, as one flat object (#1533). Chip and select state
   * is deliberately absent: those live in React state, which the landing tab
   * does not have either, but they are one tap to re-pick where a paragraph
   * is not.
   */
  const snapshotDraft = useCallback((): MoreDraft => ({
    made_url: madeUrl.current?.value || '',
    made_note: madeNote.current?.value || '',
    group_name: groupName.current?.value || '',
    group_need: groupNeed.current?.value || '',
    loss_product: lossProduct.current?.value || '',
    loss_story: lossStory.current?.value || '',
    farcaster: farcaster.current?.value || '',
    discord: discord.current?.value || '',
    telegram: telegram.current?.value || '',
    other_handle: other.current?.value || '',
  }), []);

  /**
   * Fill EMPTY fields from a parked draft, and only empty ones.
   *
   * The load path has just written whatever the server holds. A stored answer
   * is the authoritative one — it survived a save — so a parked draft may only
   * fill what the server left blank. That is the same "live text always wins"
   * rule the feedback dialog's rescue follows, and it is what stops a stale
   * draft from undoing an edit made on another device.
   */
  const restoreDraft = useCallback(() => {
    const draft = readDraft(token.current);
    if (!draft) return;
    const fields: Array<[string, React.RefObject<HTMLInputElement | HTMLTextAreaElement | null>]> = [
      ['made_url', madeUrl], ['made_note', madeNote],
      ['group_name', groupName], ['group_need', groupNeed],
      ['loss_product', lossProduct], ['loss_story', lossStory],
      ['farcaster', farcaster], ['discord', discord],
      ['telegram', telegram], ['other_handle', other],
    ];
    for (const [key, ref] of fields) {
      const el = ref.current;
      const parked = draft[key];
      if (el && parked && !el.value.trim()) el.value = parked;
    }
    autoGrow(groupNeed.current);
    autoGrow(lossStory.current);
    // Read once. A draft that has been handed back must not keep returning
    // over answers the reader has since deleted on purpose.
    clearDraft(token.current);
  }, []);

  const moreOnShow = useCallback(
    (value?: string) => {
      token.current = value || null;
      // Reopening the link from the waitlist mail is a visit to the FORM. A
      // previous save in this tab must not be what a later show paints.
      setSaved(false);
      // #1533: the parked draft is handed back AFTER the load, never before —
      // the load writes what the server holds, and the draft may only fill
      // what it left empty. Coming back from a connect round trip is exactly
      // this path, since the callback re-enters the screen.
      void loadMore().then(restoreDraft);
    },
    [loadMore, restoreDraft],
  );

  const toggleTool = useCallback((key: string) => {
    setTools((prev) => toggleChip(prev, key));
  }, []);
  const toggleLossKind = useCallback((key: string) => {
    setLossKinds((prev) => toggleChip(prev, key));
  }, []);

  /**
   * Copy the invite link. clipboard.writeText rejects on an insecure origin
   * and is absent in some in-app WebViews, so a failure selects the text for
   * the person to copy by hand rather than silently doing nothing.
   */
  const onCopyInvite = useCallback(async () => {
    const el = document.getElementById('more-invite-url') as HTMLInputElement | null;
    if (!el || !el.value) return;
    try {
      await navigator.clipboard.writeText(el.value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      el.select();
    }
  }, []);

  /**
   * Make a bare domain useful before the browser or API gets a chance to
   * reject it. Writing the canonical value back also makes the assistance
   * visible instead of silently changing what is saved.
   */
  const normalizeMadeUrlInput = useCallback(() => {
    const input = madeUrl.current;
    if (!input) return '';
    const normalized = normalizeMadeUrl(input.value);
    input.value = normalized;
    return normalized;
  }, []);

  const onSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const value = token.current;
      const normalizedMadeUrl = normalizeMadeUrlInput();
      const answers = {
        made_url: normalizedMadeUrl || undefined,
        made_note: madeNote.current?.value.trim() || undefined,
        group_name: groupName.current?.value.trim() || undefined,
        group_size: groupSize.current?.value || undefined,
        group_role: groupRole.current?.value || undefined,
        group_tools: tools,
        group_need: groupNeed.current?.value.trim() || undefined,
        had_loss: lossHad || undefined,
        loss_product: lossProduct.current?.value.trim() || undefined,
        loss_kind: lossKinds,
        loss_story: lossStory.current?.value.trim() || undefined,
        farcaster: farcaster.current?.value.trim() || undefined,
        discord: discord.current?.value.trim() || undefined,
        telegram: telegram.current?.value.trim() || undefined,
        other_handle: other.current?.value.trim() || undefined,
        followed_claim: !!followed.current?.checked,
      };

      // #1539: an empty save was accepted, and answered with the same "thanks"
      // panel as a full one — so the one thing this form exists to collect
      // could be skipped by pressing the button, and nothing said so.
      //
      // The guard is on SUBMIT rather than a disabled button: every field here
      // is uncontrolled by design (see the header comment), so a live-disabled
      // control would mean putting all sixteen of them into React state to
      // answer a question that only matters once. Every question stays
      // optional — this asks for one of them, not for any particular one.
      if (!hasAnyAnswer(answers)) {
        setMsg({ text: 'Answer at least one question before saving.', tone: 'warn' });
        return;
      }

      setSaving(true);
      try {
        const res = await fetch('/api/public/waitlist/more/' + encodeURIComponent(value || ''), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(answers),
        });
        const data = await res.json().catch(() => null);
        if (res.ok) {
          // The confirmation is a whole panel now, so the one-line status this
          // used to write would only be a second, quieter copy of it.
          setMsg(null);
          setSaved(true);
          // #1535: the waitlist screen's offer card outlives a trip here and
          // back, so tell it these questions have been answered — otherwise it
          // keeps inviting you to answer them.
          markSurveyAnswered(value);
          // #1533: the answers are stored now, so the parked copy is stale by
          // definition and must not come back over a later edit.
          clearDraft(value);
        } else {
          setMsg({
            text: (data && data.error) || 'Something went wrong. Try again.',
            tone: 'error',
          });
        }
      } catch {
        setMsg({ text: 'Connection issue. Try again.', tone: 'error' });
      }
      setSaving(false);
    },
    [lossHad, lossKinds, normalizeMadeUrlInput, tools],
  );

  /**
   * Back to the form. Every field is still mounted and still holds what was
   * typed — the form is hidden, never unmounted — so this needs no reload and
   * loses nothing.
   */
  const onEditAgain = useCallback(() => {
    setSaved(false);
  }, []);

  const live = useRef({ moreOnShow });
  live.current = { moreOnShow };
  useAuthScreensPatch({
    _wireMore: () => {},
    _moreOnShow: (value?: string) => live.current.moreOnShow(value),
  });

  // A "no" (or nothing picked) hides the follow-up, exactly as the chip row's
  // onChange used to toggle it.
  const lossDetailHidden = !lossHad || lossHad === 'no';

  // The loss story sits inside that block, so a stored answer is measured for
  // the first time when the block is revealed — before then it has no height
  // to read (#1530).
  useEffect(() => {
    if (!lossDetailHidden) autoGrow(lossStory.current);
  }, [lossDetailHidden]);

  // Which networks actually have a link to offer. Drives whether the
  // self-report checkbox is shown at all: "I followed along" with nothing
  // to follow is a question with no answer.
  const followTargets = ['x', 'linkedin', 'instagram'].filter((k) => follow[k]);

  return (
    <main
      ref={rootRef}
      id="auth-more-screen"
      className="hidden fixed inset-0 z-40 overflow-y-auto platform-safe-scroll"
    >
      {mounted ? (
        <>
      <a
        href="#landing"
        className="fixed left-4 z-10 text-sm text-zinc-500 dark:text-zinc-400 hover:text-violet-400"
        style={{ top: 'calc(env(safe-area-inset-top, 0px) + 1rem)' }}
      >
        &larr; Back
      </a>
      <div className="max-w-2xl mx-auto px-6 py-16">
        <p
          className={hiddenLast(
            saved,
            'text-xs font-semibold uppercase tracking-widest text-violet-700 dark:text-violet-400',
          )}
        >
          Optional (moves you up the list)
        </p>
        <h1 className={hiddenLast(saved, 'mt-1 text-2xl font-bold')}>
          Want in sooner?
        </h1>
        {/*
            #1541: two sentences, from four. The middle one said the same
            thing twice ("the answers we actually read" and "worth more than
            the order you signed up in"), and "every one is optional" is
            already the label directly above this heading.
        */}
        <p className={hiddenLast(saved, 'mt-3 text-sm text-zinc-500 dark:text-zinc-400')}>
          Four questions, about three minutes. These are what we read when we
        pick the next group, and you can come back and add to them any time.
        </p>
        {/* Bad/expired token state — also hosts the rate-limited copy */}
        <div
          id="more-invalid"
          className={hiddenFirst(
            status !== 'invalid' && status !== 'throttled',
            'mt-6 rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 p-4 text-sm text-amber-800 dark:text-amber-300',
          )}
        >
          {status === 'throttled' ? (
            <>
              Your link is fine, we&rsquo;re limiting requests from your
              address right now. Try again in {retryText}, or just reopen the
              link from your waitlist email then.
            </>
          ) : (
            <>
              {"This link doesn't look right. Use the one from your waitlist email, or "}
              <a href="#landing" className="underline">
                join the waitlist
              </a>
              {' first.'}
            </>
          )}
        </div>
        <form
          id="more-form"
          className={hiddenFirst(status !== 'ready' || saved, 'mt-6 space-y-8')}
          onSubmit={onSubmit}
        >
          {/* Where this signup stands, and which address it was made with. */}
          <div className="space-y-1.5">
            <StatusPill id="more-status-pill" status={queue} />
            <SignupEmail email={signupEmail} />
          </div>
          {/* 4 · Something you've made — relocated from the join form, where
              it used to be required. Joining takes an email now; this is one
              of the things that helps you move up instead. */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-zinc-400 dark:text-zinc-500 mb-1.5">
              Question 1 of 4
            </p>
            <label
              htmlFor="more-made-url"
              className="block text-sm font-medium text-zinc-700 dark:text-zinc-200"
            >
              Link something you&rsquo;ve made
            </label>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 mb-1.5">
              A repo, a site, a bot, a mod, a newsletter, a spreadsheet that runs your fantasy league. Built with AI counts, we care that it exists, not how you made it.
            </p>
            <input
              ref={madeUrl}
              id="more-made-url"
              type="text"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              maxLength={2000}
              placeholder="https://"
              onBlur={normalizeMadeUrlInput}
              className="w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500"
            />
            <input
              ref={madeNote}
              id="more-made-note"
              type="text"
              maxLength={140}
              placeholder="What is it, in one line? (optional)"
              className="mt-2 w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500"
            />
          </div>
          {/* 5 · The group */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-zinc-400 dark:text-zinc-500 mb-1.5">
              Question 2 of 4
            </p>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-200">
              Tell us about a group you&rsquo;re part of that could use its own app.
            </label>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 mb-2">
              A team, a server, a club, a group chat, a co-op, a band, a league, a neighbourhood. Not a hypothetical one, a real group you&rsquo;re actually in.
            </p>
            <input
              ref={groupName}
              id="more-group-name"
              type="text"
              maxLength={255}
              placeholder="A 200-person Discord for indie game devs in Lagos"
              className="w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500"
            />
            <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
              <select
                ref={groupSize}
                id="more-group-size"
                className="w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500"
              >
                <option value="">
                  Roughly how many people?
                </option>
                {optionList(opts?.group_sizes)}
              </select>
              <select
                ref={groupRole}
                id="more-group-role"
                className="w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500"
              >
                <option value="">
                  Your role in it
                </option>
                {optionList(opts?.group_roles)}
              </select>
            </div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-3 mb-1.5">
              What does it run on today? (pick any)
            </p>
            <MultiChipRow
              id="more-group-tools"
              options={opts?.group_tools || {}}
              value={tools}
              onToggle={toggleTool}
            />
            <textarea
              ref={groupNeed}
              id="more-group-need"
              rows={3}
              onInput={(e) => autoGrow(e.currentTarget)}
              maxLength={800}
              placeholder="What would its own app do that those tools can't? Money, membership, voting, scheduling, reputation, records…"
              className="mt-3 w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500"
            >
            </textarea>
          </div>
          {/* 6 · The loss */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-zinc-400 dark:text-zinc-500 mb-1.5">
              Question 3 of 4
            </p>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-200">
              Ever had a tool you relied on get killed, paywalled, or ruined?
            </label>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 mb-2">
              An app, a platform, a service, a game, a community. The kind of thing that made you look for something like this in the first place.
            </p>
            <ChipRow
              id="more-loss-had"
              options={opts?.loss_answers || {}}
              value={lossHad}
              onChange={setLossHad}
            />
            <div
              id="more-loss-detail"
              className={hiddenFirst(lossDetailHidden, 'mt-3 space-y-2')}
            >
              <input
                ref={lossProduct}
                id="more-loss-product"
                type="text"
                maxLength={255}
                placeholder="Which one? Google Reader, a Discord server, a game's private servers, an API…"
                className="w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500"
              />
              <p className="text-xs text-zinc-500 dark:text-zinc-400 pt-1">
                What happened? (pick any)
              </p>
              <MultiChipRow
                id="more-loss-kinds"
                options={opts?.loss_kinds || {}}
                value={lossKinds}
                onToggle={toggleLossKind}
              />
              <textarea
                ref={lossStory}
                id="more-loss-story"
                rows={3}
                onInput={(e) => autoGrow(e.currentTarget)}
                maxLength={800}
                placeholder="What happened, and what did you do next? Where did everyone go? Did you move them somewhere? Rebuild it? Give up?"
                className="w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500"
              >
              </textarea>
            </div>
          </div>
          {/* 7 · Handles */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-zinc-400 dark:text-zinc-500 mb-1.5">
              Question 4 of 4
            </p>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-200">
              Where else are you?
            </label>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 mb-2">
              Connecting an account proves you&rsquo;re a person with a history, which is most of what gets a signup read quickly. It confirms the account is yours and nothing else, so follow us if you want to, but we won&rsquo;t claim we checked.
            </p>
            {/*
                GitHub / X / LinkedIn: a verified pill when connected, a connect
                link when the platform has OAuth creds for the provider, nothing
                otherwise (the text handles below still work).

                "Verified" here means the account is THEIRS. The onboarding doc
                asks to verify that the follow itself happened; LinkedIn and
                Instagram expose no API that reports it, and X only does on a
                paid tier with the follows.read scope, so the copy above stops
                at what we can actually stand behind.
            */}
            <div id="more-connect-row" className="flex flex-wrap gap-2 mb-3">
              {[
                ['github', 'GitHub'],
                ['x', 'X'],
                ['linkedin', 'LinkedIn'],
              ].map(([provider, label]) =>
                connect.verified[provider] ? (
                  <span
                    key={provider}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-300 dark:border-emerald-500/40 bg-emerald-50 dark:bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-300"
                  >
                    {'✓ ' + label + ' · ' + connect.verified[provider]}
                  </span>
                ) : connect.oauth[provider] ? (
                  <a
                    key={provider}
                    className="inline-flex items-center rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:border-zinc-400 dark:hover:border-zinc-500"
                    href={
                      '/waitlist/connect/' +
                      provider +
                      '?token=' +
                      encodeURIComponent(token.current || '')
                    }
                    /*
                        #1532: the OAuth round trip leaves in a NEW TAB.

                        It used to navigate this one away, and the form's
                        fields are uncontrolled and unsaved (see the header
                        comment), so a provider that asked for a password, or
                        a phone where getting back means finding the tab
                        again, cost the reader whatever they had typed. The
                        new tab carries the whole flow and lands on
                        `#more/<token>?connect=<outcome>`; this tab keeps the
                        half-filled form exactly as it was.

                        Verification is recorded server-side by the callback,
                        so saving from EITHER tab afterwards stores it. The
                        `rel` is not optional: `target="_blank"` without it
                        hands the opened page a live `window.opener`.

                        #1533 parks the typed answers on the way out, which is
                        what the tab that LANDS finds: it re-enters the screen
                        cold, and without the draft it paints an empty form
                        beside the account it just connected.
                    */
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => saveDraft(token.current, snapshotDraft())}
                  >
                    {'Connect ' + label}
                  </a>
                ) : null,
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <input
                ref={farcaster}
                id="more-handle-farcaster"
                type="text"
                maxLength={255}
                placeholder="Farcaster (@handle)"
                className="w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500"
              />
              <input
                ref={discord}
                id="more-handle-discord"
                type="text"
                maxLength={255}
                placeholder="Discord (username)"
                className="w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500"
              />
              <input
                ref={telegram}
                id="more-handle-telegram"
                type="text"
                maxLength={255}
                placeholder="Telegram (@handle)"
                className="w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500"
              />
              <input
                ref={other}
                id="more-handle-other"
                type="text"
                maxLength={255}
                placeholder="Anywhere else: Twitch, YouTube, Mastodon…"
                className="w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500"
              />
            </div>
            {/*
                Follow along. The links come from WAITLIST_FOLLOW_*_URL, so a
                network nobody has configured renders nothing rather than a
                dead profile link — the same degradation the connect row
                above gets when a provider has no OAuth credentials. The row
                is empty at first render, which is what the prerender pass
                has to reproduce.

                The checkbox is a SELF-REPORT and the copy says so. None of
                the three will confirm a follow: LinkedIn's follower
                statistics are aggregate-only, Instagram exposes a count and
                no relationship lookup, and X retired its boolean friendship
                endpoint. Saying "verified" here would be a claim we cannot
                stand behind, and `answers.followed_claim` is kept out of
                `answers.verified` for the same reason.
            */}
            <div id="more-follow-row" className="mt-3 flex flex-wrap gap-2">
              {[
                ['x', 'X'],
                ['linkedin', 'LinkedIn'],
                ['instagram', 'Instagram'],
              ].map(([key, label]) =>
                follow[key] ? (
                  <a
                    key={key}
                    href={follow[key] as string}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:border-zinc-400 dark:hover:border-zinc-500"
                  >
                    {'Follow on ' + label}
                  </a>
                ) : null,
              )}
            </div>
            <label
              className={hiddenFirst(
                !followTargets.length,
                'mt-3 flex items-start gap-2 text-sm text-zinc-600 dark:text-zinc-300 cursor-pointer',
              )}
            >
              <input
                ref={followed}
                id="more-followed"
                type="checkbox"
                className="mt-0.5 size-4 shrink-0 rounded accent-violet-600"
              />
              I followed along
            </label>
          </div>
          {/* 8 · Friends. The typed-address rows that used to live here sent
              nothing and attributed nothing; this is a real link, and a join
              through it sets waitlist_signups.invited_by. Everything below
              renders empty until the load effect fills it, so the first
              render still matches the prerender. */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-zinc-400 dark:text-zinc-500 mb-1.5">
              One more thing
            </p>
            <label
              htmlFor="more-invite-url"
              className="block text-sm font-medium text-zinc-700 dark:text-zinc-200"
            >
              Bring someone you&rsquo;d build with
            </label>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 mb-2">
              We try to admit people together. Things are more fun with people you know. Share your link, and if they join we&rsquo;ll connect your applications so we can try to bring you in together.
            </p>
            <div className="flex gap-2">
              <input
                id="more-invite-url"
                type="text"
                readOnly={true}
                value={inviteUrl}
                placeholder="Your link appears here"
                className="w-full rounded-lg bg-zinc-50 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm font-mono text-zinc-700 dark:text-zinc-200 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500"
              />
              <Button
                type="button"
                id="more-invite-copy"
                layout="shrink"
                size="narrow"
                onClick={onCopyInvite}
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <div id="more-invite-joined" className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
              {inviteCount > 0 ? (
                <>
                  <span className="font-medium text-zinc-700 dark:text-zinc-200">
                    {`${inviteCount} ${inviteCount === 1 ? 'person' : 'people'} from your invite joined 🎉 `}
                  </span>
                  {inviteEmails.join(', ')}
                </>
              ) : null}
            </div>
          </div>
          <div className="border-t border-zinc-200 dark:border-zinc-800 pt-5">
            <Button
              type="submit"
              id="more-save"
              disabled={saving}
              disabledStyle="dim"
              size="xl"
            >
              Save my answers
            </Button>
            <p id="more-msg" className={msgClass(msg ? msg.tone : null)}>
              {msg ? msg.text : null}
            </p>
            <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-3">
              A blank answer just means we have less to go on, and nothing here is required.
            </p>
          </div>
        </form>
        {/*
            The ending. Everything above is hidden when this is up, so the
            screen says one thing: you're done. The two controls after it are
            the only two things left to want — change an answer, or leave.
        */}
        <div id="more-saved" className={hiddenFirst(!saved, 'mt-6')}>
          <div className="rounded-lg border border-emerald-200 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/10 p-5">
            <h2 className="text-xl font-bold text-emerald-700 dark:text-emerald-400">
              Saved, thanks &#127881;
            </h2>
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
              These are the answers we actually read when we pick the next
            group. Your spot is safe either way, and we&rsquo;ll email you when
            it opens.
            </p>
            <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
              Thought of something later? The link in your waitlist email
            reopens this form, and answers merge, so nothing you already typed
            is lost.
            </p>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button
              type="button"
              id="more-saved-edit"
              variant="neutral"
              ink="neutral"
              size="narrow"
              onClick={onEditAgain}
            >
              Edit my answers
            </Button>
            <a
              id="more-saved-back"
              href="#landing"
              className="text-sm text-zinc-500 dark:text-zinc-400 hover:text-violet-400"
            >
              Back to Homeroom
            </a>
          </div>
        </div>
      </div>
        </>
      ) : null}
    </main>
  );
}
