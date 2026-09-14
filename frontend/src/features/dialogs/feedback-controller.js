/**
 * Send-feedback dialog — the behaviour half (#feedback-modal).
 *
 * MOVED, NOT REWRITTEN, out of `App.bindEvents` in public/js/app.js by #1078
 * chunk I. It was ~810 lines in the middle of a 900-line method, sharing that
 * method's scope with the header, the tab switch and the pull-to-refresh
 * wiring; here it is the same code in a closure of its own, reached through
 * an `init()` the island calls from its layout effect.
 *
 * ── Why this one is a controller and not JSX ──────────────────────────
 *
 * Six of the nine dialogs became real components. This one is closer to
 * members: not because of its size, but because its state is genuinely
 * imperative and interlocking — a debounce timer plus a sequence counter for
 * the live title generation (#556/#732), an in-flight screenshot upload that
 * blocks submit and survives a failed POST as raw bytes (#683/#1054), an
 * offline outbox whose count reads can resolve out of order and must not
 * paint stale (#1054), and a status line four different code paths write with
 * an explicit "newer and more specific wins" rule. Every one of those is a
 * behaviour with a bug number attached, and #1078 is explicit that a
 * conversion is like-for-like. Turning them into `useState` is a rewrite of
 * exactly the logic those issues fixed, so it is a chunk of its own.
 *
 * So feedback.tsx renders a CONSTANT tree and this module writes into it —
 * the same one-owner-per-node arrangement app-secrets and members use. What
 * React owns is the lifecycle: reveal, the kit lift, dismiss.
 *
 * ── What changed in the move ──────────────────────────────────────────
 *
 *   * `App.openFeedbackModal` split into an entry point that forwards to the
 *     island's controller and a `_open` half the island calls back into;
 *     the `#feedback-cancel` listener split the same way into `_reset`.
 *     Neither half toggles `hidden` any more — `useStaticModal` does.
 *   * The `#feedback-modal` backdrop listener is `useDialog`'s backdropProps.
 *   * The screenshot capture hid the dialog by writing `hidden` on the root
 *     and put it back the same way. It suspends and resumes the island
 *     instead — see `suspendDialog` below for why that is not `close()`.
 *
 * Everything else is the code that was there, line for line — including the
 * two `setTimeout(() => document.getElementById('feedback-cancel').click(),
 * 1500)` calls, which still work because a programmatic click dispatches a
 * real event and React 19 delegates its listeners at document.body.
 */

// public/js/screenshot-select.js moved into the bundle in this chunk too, and
// this is its only consumer. Imported for the side effect: it publishes
// `window.ScreenshotSelect`, which the capture path below reads by name.
import './screenshot-select';

import { publishVisibility } from '../../lib/visibility-store';

// The shell globals this block reaches for. Resolved in `init()` rather than
// at module scope because the SSG prerender pass evaluates this module in
// Node, where there is no `window`.
let App;
let AppView;
let PlatformUI;

// The island's controller, or null before hydration. Registered by
// `useDialog('feedback')` — see use-dialog.ts.
function dialogController() {
  if (typeof window === 'undefined') return null;
  const dialogs = window.UsernodeReact && window.UsernodeReact.dialogs;
  return (dialogs && dialogs.feedback) || null;
}

// The screenshot has to photograph the page WITHOUT the dialog on top of it
// and then put the dialog back exactly as the user left it — draft text,
// chosen target, status line, attachment row and all. `close()`/`open()`
// would run the onClose/onOpen halves and wipe the very draft the screenshot
// is being attached to, so the island exposes this pair: the same visibility
// change without the lifecycle. (Before this chunk the capture path wrote
// `hidden` on the root directly and `adoptStaticModal`'s observer turned that
// into a dismiss + re-present; this is that round trip, made explicit.)
function suspendDialog() { dialogController()?.suspend(); }
function resumeDialog() { dialogController()?.resume(); }

// The two halves the island calls back into, populated by `init()`.
export const Feedback = {
  // Match the runtime replacement below so TypeScript's JS inference keeps
  // the island's legacy `{ fromDev }` payload in the public signature.
  _open: (_opts = {}) => {},
  _reset: () => {},
};

let wired = false;

export function init() {
  if (typeof window === 'undefined') return;
  ({ App, AppView, PlatformUI } = window);
  if (!App || wired) return;
  wired = true;

    // Feedback
    const feedbackTitle = document.getElementById('feedback-title');
    const feedbackText = document.getElementById('feedback-text');

    /**
     * Lock the composer after a send, WITHOUT taking focus off it (#1492).
     *
     * This used to set `disabled`, and a disabled element cannot hold focus.
     * On a phone that blurs the textarea the moment Submit succeeds, which
     * tears the on-screen keyboard down — and the keyboard is what the visual
     * viewport is measured against. `html, body { height: 100dvh }` (app.css)
     * means the whole fixed column then reflows, the modal resizes under the
     * "Submitted" label, and 1.5s later the close reflows it a second time.
     * Two full relayouts around one tap is the stutter that was reported, and
     * it is a mobile-only symptom because only a phone has a keyboard taking
     * half the viewport.
     *
     * `readOnly` refuses typing exactly as #32 needs, and keeps focus, so the
     * keyboard comes down ONCE — when the dialog actually closes. It also
     * leaves the text selectable, so somebody whose send failed can still copy
     * what they wrote.
     *
     * The submit BUTTON stays `disabled`: it holds no caret and dismisses no
     * keyboard, and disabled is the honest state for a control that must not
     * fire.
     */
    const setComposerLocked = (locked) => {
      feedbackText.readOnly = locked;
      feedbackTitle.readOnly = locked;
    };
    const feedbackBtn = document.getElementById('feedback-submit');
    const feedbackStatus = document.getElementById('feedback-status');
    const feedbackForm = document.getElementById('feedback-form');
    const firstSuccess = document.getElementById('feedback-first-success');
    const firstNotice = document.getElementById('feedback-first-notice');
    const firstFix = document.getElementById('feedback-first-fix');
    const firstFixNote = document.getElementById('feedback-first-fix-note');
    const firstBoard = document.getElementById('feedback-first-board');
    let firstFeedback = null;
    let pendingFirstFeedback = null;
    let closeTimer = null;
    let presentation = 0;

    const showFirstFeedback = (moment, notice) => {
      if (!moment || Number(moment.userId) !== Number(App.user?.id)) return false;
      clearTimeout(closeTimer);
      firstFeedback = moment;
      pendingFirstFeedback = null;
      // readOnly, not disabled: disabling these two drops focus and takes
      // the keyboard down with it, which is the bug #1757 fixed on the send
      // paths. This path was added separately and kept the old writes, so
      // the two changes were green apart and red together.
      setComposerLocked(true);
      feedbackBtn.disabled = true;
      const hasBoard = typeof moment.appSlug === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(moment.appSlug);
      firstFix.disabled = !hasBoard || !moment.canFix || !Number.isSafeInteger(moment.issueNumber) || moment.issueNumber <= 0;
      firstBoard.disabled = !hasBoard;
      firstFixNote.textContent = firstFix.disabled
        ? (hasBoard ? 'You need collaborator access to try a fix. You can still explore the board.' : 'This repository does not have an app board you can access here.')
        : 'Start with a draft you can edit before sending it to the coding agent.';
      firstNotice.textContent = notice || 'Your feedback has been sent.';
      feedbackForm.classList.add('hidden');
      firstSuccess.classList.remove('hidden');
      firstSuccess.focus();
      return true;
    };

    const closeFeedback = () => document.getElementById('feedback-cancel').click();
    document.getElementById('feedback-first-done')?.addEventListener('click', closeFeedback);
    firstBoard?.addEventListener('click', () => {
      const moment = firstFeedback;
      if (!moment || firstBoard.disabled || Number(moment.userId) !== Number(App.user?.id)) return;
      closeFeedback();
      location.hash = `#app/${encodeURIComponent(moment.appSlug)}/board`;
    });
    firstFix?.addEventListener('click', async () => {
      const moment = firstFeedback;
      if (!moment || firstFix.disabled || Number(moment.userId) !== Number(App.user?.id)) return;
      firstFix.disabled = true;
      closeFeedback();
      try {
        await App.navigateToApp(moment.appSlug, 'dev', moment.issueNumber, 'issues');
        if (App.currentApp === moment.appSlug && AppView.appData?.slug === moment.appSlug
            && Number(moment.userId) === Number(App.user?.id)) {
          await AppView.createPrForIssue(moment.issueNumber);
        }
      } catch (err) {
        PlatformUI.toast('Could not open a fix just now. You can try again from the issue on the board.');
      }
    });
    // #1603: the inline refusal under the description. Rendered empty and
    // hidden by ./feedback.tsx; this module owns its text and its `hidden`.
    const feedbackTextError = document.getElementById('feedback-text-error');
    const feedbackTargetApp = document.getElementById('feedback-target-app');
    const feedbackTargetPlatform = document.getElementById('feedback-target-platform');
    const feedbackCaretApp = document.getElementById('feedback-caret-app');
    const feedbackCaretPlatform = document.getElementById('feedback-caret-platform');

    // Currently selected feedback target ('app' or 'platform'). The
    // "This app" button is only enabled when an app with a repo is open,
    // so this stays 'platform' on home/leaderboard. Reset on each open.
    let feedbackTarget = 'platform';
    // #685: whether the open app announced a usernode.issueState provider
    // from the mounted iframe. Computed on each modal open; the "Include
    // app state" row shows only while this holds AND the target is 'app'.
    let stateAvailable = false;
    const stateRow = document.getElementById('feedback-state-row');
    const stateCheckbox = document.getElementById('feedback-state-checkbox');
    // #964: the opt-in kudos-bounty row. Unlike the state row this shows for
    // BOTH targets — "This app" and "Homeroom Platform" alike file
    // into a repository the platform tracks as an app, so either can carry a
    // bounty.
    const bountyRow = document.getElementById('feedback-bounty-row');
    const bountyCheckbox = document.getElementById('feedback-bounty-checkbox');
    const bountyNote = document.getElementById('feedback-bounty-note');
    // Paint the row from the viewer's live weekly allowance and return it to
    // its unchecked default. Budget state is null only when the first-load
    // fetch failed — show the row enabled with no count rather than hiding a
    // working feature; the server is the real gate.
    const resetBountyRow = () => {
      bountyCheckbox.checked = false;
      const budget = window.Kudos?.Budget?.state || null;
      const remaining = budget ? budget.remaining : null;
      const limit = budget ? budget.limit : null;
      const exhausted = remaining === 0;
      bountyCheckbox.disabled = exhausted;
      bountyRow.classList.toggle('opacity-60', exhausted);
      // #1582: the row's own line says what a bounty DOES, so the price of
      // ticking the box is stated here, beside the live figure. It is on
      // screen in every state the box can be ticked in — including the one
      // where the budget fetch failed and there is no figure to show.
      if (remaining === null) bountyNote.textContent = 'Costs 1 kudos';
      else if (exhausted) bountyNote.textContent = `You've used all ${limit} kudos this week. Resets Monday 00:00 UTC.`;
      else bountyNote.textContent = `Costs 1 kudos. ${remaining} of ${limit} left this week`;
      bountyRow.classList.remove('hidden');
    };
    // The selected option uses a darker violet on hover so it keeps its
    // active look; the unselected option uses the neutral zinc hover.
    const activeTargetClasses = ['bg-violet-600', 'text-white', 'border-violet-600', 'hover:bg-violet-500'];
    const inactiveHoverClasses = ['hover:bg-zinc-100', 'dark:hover:bg-zinc-800'];
    const disabledTargetClasses = ['opacity-40', 'cursor-not-allowed'];
    // Toggle the active styling between the two buttons. Enabled/disabled
    // state of the "This app" button is owned by the open handler.
    const setFeedbackTarget = (target) => {
      feedbackTarget = target;
      const onApp = target === 'app';
      feedbackTargetApp.setAttribute('aria-checked', onApp ? 'true' : 'false');
      feedbackTargetPlatform.setAttribute('aria-checked', onApp ? 'false' : 'true');
      activeTargetClasses.forEach((c) => {
        feedbackTargetApp.classList.toggle(c, onApp);
        feedbackTargetPlatform.classList.toggle(c, !onApp);
      });
      // The neutral hover only applies to the unselected option, so the
      // selected one doesn't get its violet overridden on hover.
      inactiveHoverClasses.forEach((c) => {
        feedbackTargetApp.classList.toggle(c, !onApp);
        feedbackTargetPlatform.classList.toggle(c, onApp);
      });
      // Move the caret under the selected option.
      feedbackCaretApp.classList.toggle('hidden', !onApp);
      feedbackCaretPlatform.classList.toggle('hidden', onApp);
      // #685: app state only travels with app-targeted feedback — the
      // shell has no provider of its own, so the row hides on Platform.
      stateRow.classList.toggle('hidden', !(stateAvailable && onApp));
    };
    // Enable or gray-out the "This app" option. When disabled it stays
    // visible (so users see both choices) but isn't clickable/selectable.
    const setAppTargetEnabled = (enabled) => {
      feedbackTargetApp.disabled = !enabled;
      feedbackTargetApp.setAttribute('aria-disabled', enabled ? 'false' : 'true');
      disabledTargetClasses.forEach((c) => feedbackTargetApp.classList.toggle(c, !enabled));
    };
    feedbackTargetApp.addEventListener('click', () => {
      if (!feedbackTargetApp.disabled) setFeedbackTarget('app');
    });
    feedbackTargetPlatform.addEventListener('click', () => setFeedbackTarget('platform'));

    // #556: live title generation. As the user types the description,
    // a debounced POST /api/feedback/title fills the editable Title
    // field. At submit, a user-typed title is always used; an
    // auto-filled one is used only while it still matches the submitted
    // description — a stale fill from a partial description is dropped
    // so the server re-names from the full text (#732).
    // Guards: once the user types in the Title field themselves
    // (titleDirty) auto-fill stops — clearing the field re-arms it;
    // responses landing after a newer request or a takeover are
    // discarded via the sequence counter; a per-open cap plus a minimum
    // description length bound the Haiku spend. All failure modes are
    // silent (null title / network error / 429): an empty field is a
    // fully working state — the server names the issue at submit.
    const TITLE_GEN_DEBOUNCE_MS = 900;
    const TITLE_GEN_MIN_DESC = 12;
    const TITLE_GEN_MAX_PER_OPEN = 8;
    const titleIdlePlaceholder = feedbackTitle.placeholder;
    let titleDirty = false;
    let lastGeneratedFor = '';
    let titleGenSeq = 0;
    let titleGenCount = 0;
    let titleGenTimer = null;

    // Reset on modal open / cancel / successful submit. Bumping the
    // sequence invalidates any in-flight response so it can never fill
    // the field of a later modal session.
    const resetTitleGenState = () => {
      titleDirty = false;
      lastGeneratedFor = '';
      titleGenSeq++;
      titleGenCount = 0;
      if (titleGenTimer) { clearTimeout(titleGenTimer); titleGenTimer = null; }
      feedbackTitle.placeholder = titleIdlePlaceholder;
    };

    const generateTitlePreview = async () => {
      const desc = feedbackText.value.trim();
      if (desc.length < TITLE_GEN_MIN_DESC) return;
      if (titleDirty) return;
      if (desc === lastGeneratedFor) return;
      if (titleGenCount >= TITLE_GEN_MAX_PER_OPEN) return;
      titleGenCount++;
      const seq = ++titleGenSeq;
      feedbackTitle.placeholder = 'Generating title…';
      try {
        const res = await fetch('/api/feedback/title', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ description: desc }),
        });
        const data = res.ok ? await res.json() : {};
        // Stale (a newer request or a reset happened) or the user took
        // the field over mid-flight — drop the result.
        if (seq !== titleGenSeq || titleDirty) return;
        if (data.title) {
          // Programmatic fill — must NOT set titleDirty (dirty is set
          // only from the Title input's own 'input' event below).
          feedbackTitle.value = data.title;
          // Success only: a transient failure retries on the next pause.
          lastGeneratedFor = desc;
        }
      } catch { /* silent — field stays as-is, retried on the next pause */ }
      finally {
        if (seq === titleGenSeq) feedbackTitle.placeholder = titleIdlePlaceholder;
      }
    };

    const scheduleTitlePreview = () => {
      if (titleGenTimer) clearTimeout(titleGenTimer);
      titleGenTimer = setTimeout(() => {
        titleGenTimer = null;
        generateTitlePreview();
      }, TITLE_GEN_DEBOUNCE_MS);
    };
    feedbackText.addEventListener('input', () => {
      // #1603: typing is the fix, so the refusal goes as soon as it starts.
      clearDescriptionError();
      scheduleTitlePreview();
    });
    // Leaving the description flushes the pending debounce immediately —
    // the "type body → title appears → submit" happy path.
    feedbackText.addEventListener('blur', () => {
      if (titleGenTimer) { clearTimeout(titleGenTimer); titleGenTimer = null; }
      generateTitlePreview();
    });
    feedbackTitle.addEventListener('input', () => {
      // Typing marks the field user-owned; clearing it completely
      // re-arms auto-fill for the next description change.
      titleDirty = feedbackTitle.value.trim().length > 0;
    });

    // ── #683/#824: screenshot attachment ───────────────────────────
    // Desktop keeps drag-to-select. The mobile app can capture its visible
    // native window, and every surface keeps a PNG/JPEG picker as fallback.
    // All three sources converge here so preview/upload/offline semantics stay
    // exactly the same. One screenshot per issue.
    const screenshotBtn = document.getElementById('feedback-screenshot-btn');
    const screenshotLabel = screenshotBtn.querySelector('[data-screenshot-label]');
    const screenshotPickerBtn = document.getElementById('feedback-screenshot-picker-btn');
    const screenshotInput = document.getElementById('feedback-screenshot-input');
    const screenshotPreview = document.getElementById('feedback-screenshot-preview');
    const screenshotImg = document.getElementById('feedback-screenshot-img');
    const screenshotState = document.getElementById('feedback-screenshot-state');
    const screenshotRemove = document.getElementById('feedback-screenshot-remove');
    const screenshotTools = window.ScreenshotSelect;
    const displayCaptureSupported = !!screenshotTools && screenshotTools.isSupported();
    let nativeCaptureSupported = false;
    let screenshotProbeSequence = 0;
    let screenshotId = null;          // server row id, set once uploaded
    let screenshotUploading = false;  // blocks submit while in flight
    let screenshotObjectUrl = null;
    // #1054: the captured bytes, kept for as long as the attachment is
    // shown. The upload mints the id, but the id only exists on the server —
    // so an offline submit has to carry the blob itself into the outbox and
    // upload it at flush time. Held until the attachment is cleared.
    let screenshotBlob = null;
    // #1284: true for the whole round trip of a native capture — from the
    // moment the dialog is suspended until the attempt has resolved one way
    // or the other. `suspendDialog()` closes the kit presentation, and the
    // kit calls back when its exit animation ends (~300 ms); a capture that
    // fails faster than that has already resumed by then, so the late
    // dismissal is stale. useStaticModal's generation guard drops it — this
    // flag is the second belt: if a dismissal DOES reach `_reset` mid-capture,
    // the draft the screenshot was being attached to survives it.
    let captureInFlight = false;

    // #1284: the last-ditch copy of the draft, in sessionStorage, for the
    // failure the flag above cannot cover — a capture that takes the whole
    // page down with it (a native screenshot that OOMs the web view, a tab
    // evicted while the camera roll is open). Text only: never the screenshot
    // bytes, never the collected app state.
    const CAPTURE_DRAFT_KEY = 'usernode.feedbackCaptureDraft';
    // Older than this and handing the words back is a surprise, not a rescue.
    const CAPTURE_DRAFT_MAX_AGE_MS = 10 * 60 * 1000;
    // The ?shot= deep links are photographs of states, not real sessions —
    // stashing from one would hand a synthetic draft to the next real visit.
    const onShotRoute = () => {
      try { return new URLSearchParams(window.location.search).has('shot'); }
      catch { return false; }
    };
    const stashCaptureDraft = () => {
      if (onShotRoute()) return;
      try {
        const description = feedbackText.value;
        const title = feedbackTitle.value;
        if (!description.trim() && !title.trim()) return;
        window.sessionStorage.setItem(CAPTURE_DRAFT_KEY, JSON.stringify({
          description,
          title,
          titleDirty,
          target: feedbackTarget,
          savedAt: Date.now(),
        }));
      } catch { /* private mode or quota — the words are still on screen */ }
    };
    const clearCaptureDraft = () => {
      try { window.sessionStorage.removeItem(CAPTURE_DRAFT_KEY); } catch { /* ignore */ }
    };
    const readCaptureDraft = () => {
      try {
        const raw = window.sessionStorage.getItem(CAPTURE_DRAFT_KEY);
        if (!raw) return null;
        const draft = JSON.parse(raw);
        if (!draft || typeof draft.description !== 'string') return null;
        if (!(draft.savedAt > 0) || Date.now() - draft.savedAt > CAPTURE_DRAFT_MAX_AGE_MS) {
          clearCaptureDraft();
          return null;
        }
        return draft;
      } catch { return null; }
    };

    const showFeedbackNotice = (text, isError) => {
      feedbackStatus.textContent = text;
      feedbackStatus.className = `text-sm mt-2 ${isError ? 'text-red-400' : 'text-zinc-500 dark:text-zinc-400'}`;
      feedbackStatus.classList.remove('hidden');
    };

    // #1603: the empty-description refusal. Deliberately NOT routed through
    // showFeedbackNotice: #feedback-status has four writers with a "newer and
    // more specific wins" rule (see paintQueueState), so a validation message
    // there would either be suppressed by the offline hint or erase it. This
    // one lives on the field it is about, which is also where the fix is.
    const showDescriptionError = () => {
      if (!feedbackTextError) return;
      feedbackTextError.textContent = 'Please add a description.';
      feedbackTextError.classList.remove('hidden');
      feedbackText.setAttribute('aria-invalid', 'true');
      feedbackText.setAttribute('aria-describedby', 'feedback-text-error');
      // The field is the thing to fix, so put the caret in it.
      try { feedbackText.focus(); } catch { /* detached in tests */ }
    };

    const clearDescriptionError = () => {
      if (!feedbackTextError) return;
      feedbackTextError.classList.add('hidden');
      feedbackTextError.textContent = '';
      feedbackText.removeAttribute('aria-invalid');
      feedbackText.removeAttribute('aria-describedby');
    };

    const paintScreenshotActions = () => {
      const attached = !!screenshotBlob;
      const canCapture = nativeCaptureSupported || displayCaptureSupported;
      screenshotLabel.textContent = nativeCaptureSupported ? 'Take screenshot' : 'Attach screenshot';
      screenshotBtn.classList.toggle('hidden', attached || !canCapture);
      screenshotPickerBtn.classList.toggle('hidden', attached);
    };

    const setScreenshotActionsDisabled = (disabled) => {
      screenshotBtn.disabled = disabled;
      screenshotPickerBtn.disabled = disabled;
    };

    const resetScreenshotState = () => {
      screenshotId = null;
      screenshotUploading = false;
      screenshotBlob = null;
      if (screenshotObjectUrl) { URL.revokeObjectURL(screenshotObjectUrl); screenshotObjectUrl = null; }
      screenshotPreview.classList.add('hidden');
      screenshotPreview.classList.remove('flex');
      screenshotImg.removeAttribute('src');
      screenshotState.textContent = '';
      screenshotInput.value = '';
      setScreenshotActionsDisabled(false);
      paintScreenshotActions();
    };

    const attachScreenshotBlob = async (blob) => {
      // Thumbnail immediately; upload in the background with Submit blocked
      // (screenshotUploading) until the id lands.
      screenshotBlob = blob;
      screenshotObjectUrl = URL.createObjectURL(blob);
      screenshotImg.src = screenshotObjectUrl;
      paintScreenshotActions();
      screenshotPreview.classList.remove('hidden');
      screenshotPreview.classList.add('flex');
      screenshotState.textContent = 'Uploading…';
      screenshotUploading = true;
      try {
        const res = await fetch('/api/feedback/screenshot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: blob,
        });
        const data = res.ok ? await res.json() : await res.json().catch(() => ({}));
        if (res.ok && data.id) {
          screenshotId = data.id;
          screenshotState.textContent = '';
        } else {
          resetScreenshotState();
          showFeedbackNotice(data.error || 'Screenshot upload failed', true);
        }
      } catch {
        // #1054: keep the bytes when the network fails. The outbox uploads
        // them at flush time, and an online submit retries first.
        screenshotState.textContent = "Saved with your feedback. It'll upload when you're back online";
        showFeedbackNotice("Couldn't upload the screenshot yet. It'll be sent along with your feedback.", false);
      } finally {
        screenshotUploading = false;
      }
    };

    const waitForHiddenDialogPaint = () => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });

    const probeNativeCaptureSupport = async (sequence, retryOnDegraded) => {
      const bridge = window.usernode;
      if (!bridge?.isNative || typeof bridge.getBridgeInfo !== 'function'
          || typeof bridge.captureScreenshot !== 'function') return;
      try {
        const info = await bridge.getBridgeInfo();
        if (sequence !== screenshotProbeSequence) return;
        if (info?.degraded === true) {
          // A cold-start timeout is inconclusive, not a permanent "old app".
          if (retryOnDegraded) {
            setTimeout(() => probeNativeCaptureSupport(sequence, false), 750);
          }
          return;
        }
        nativeCaptureSupported = Array.isArray(info?.capabilities)
          && info.capabilities.includes('captureScreenshot');
        paintScreenshotActions();
      } catch { /* Photos remains available; the next open probes again. */ }
    };

    // #1284: one capture round trip, whatever produced the bytes. `capture`
    // is handed a `hide` callback so a display-capture attempt can suspend
    // the dialog only once the browser's grant lands, while a native attempt
    // has to suspend first (the phone photographs whatever is on screen).
    // Extracted from the button handler so the ?shot=feedback-capture-failed
    // reviewable state exercises this exact path — notice copy, dialog
    // restore and draft retention included — rather than a mock of it.
    const runCapture = async (capture, { nativeAttempt }) => {
      setScreenshotActionsDisabled(true);
      captureInFlight = true;
      // Where the cursor was. A suspend/resume moves focus off the textarea,
      // so without this the draft comes back with the caret at 0 and the
      // user's next keystroke lands at the top of their own sentence.
      const caretWasHere = document.activeElement === feedbackText;
      const caretStart = feedbackText.selectionStart;
      const caretEnd = feedbackText.selectionEnd;
      // The kit focuses the card itself one frame AFTER it presents (see the
      // requestAnimationFrame in presentModal, public/usernode-native/v1/
      // native.js), and the resume that re-presents it is a React state
      // update — so the caret has to be re-claimed over a few frames rather
      // than once. Re-focusing an element that already has focus is a no-op,
      // so the extra passes cost nothing when there is no kit to lose to.
      const restoreCaret = (framesLeft) => {
        if (feedbackText.readOnly) return;
        try {
          feedbackText.focus();
          feedbackText.setSelectionRange(caretStart, caretEnd);
        } catch { /* a browser that refuses the range still has the text */ }
        if (framesLeft > 0) requestAnimationFrame(() => restoreCaret(framesLeft - 1));
      };
      let modalHidden = false;
      const hideDialog = () => {
        if (modalHidden) return;
        // Armed before the dialog goes away, because from here on the page
        // itself might not come back.
        stashCaptureDraft();
        suspendDialog();
        modalHidden = true;
      };
      const restoreDialog = () => {
        if (!modalHidden) return;
        modalHidden = false;
        resumeDialog();
        // Not synchronously: `resume()` is a React state update, so the card
        // is reparented back into the kit shell on a later render — and
        // reparenting a focused node blurs it. (The selection offsets survive
        // the move; the focus does not.)
        if (caretWasHere) requestAnimationFrame(() => restoreCaret(2));
      };
      try {
        let blob;
        if (nativeAttempt) {
          hideDialog();
          await waitForHiddenDialogPaint();
          blob = await capture();
        } else {
          blob = await capture(hideDialog);
        }
        restoreDialog();
        await attachScreenshotBlob(blob);
      } catch (err) {
        restoreDialog();
        // Every one of these says what happened to the SCREENSHOT and then
        // says the words are still there, because the words are what a user
        // is afraid of losing — the screenshot they can retake (#1284).
        if (err && err.code === 'denied') {
          showFeedbackNotice('Screen capture was declined. Nothing was attached, and your feedback is safe.', false);
        } else if (err && err.code === 'register_failed') {
          showFeedbackNotice("Couldn't locate this page in the shared window. Keep it fully visible and try again. Your feedback is safe.", true);
        } else if (err && err.code === 'too-large') {
          showFeedbackNotice('That screenshot is larger than 4 MB. Your feedback is safe, attach a smaller one.', true);
        } else if (nativeAttempt) {
          showFeedbackNotice("Couldn't take a screenshot, but your feedback is safe. Choose one from Photos, or just send it as it is.", true);
        } else if (err && err.code !== 'cancelled') {
          showFeedbackNotice('Screenshot capture failed, but your feedback is safe. Try again, or send it without one.', true);
        }
      } finally {
        // The round trip is over: the page survived it, so the stash has
        // nothing left to rescue and a later close is a real close.
        captureInFlight = false;
        clearCaptureDraft();
        if (!screenshotBlob) setScreenshotActionsDisabled(false);
      }
    };

    screenshotBtn.addEventListener('click', () => {
      if (screenshotBtn.disabled) return;
      const nativeAttempt = nativeCaptureSupported;
      void runCapture(nativeAttempt
        ? async () => screenshotTools.blobFromNativeCapture(await window.usernode.captureScreenshot())
        // getDisplayMedia is called synchronously inside start() so the
        // click's transient activation is preserved; hide only after grant.
        : async (hide) => (await screenshotTools.start({ onCaptureStart: hide })).blob,
      { nativeAttempt });
    });

    screenshotPickerBtn.addEventListener('click', () => {
      if (screenshotPickerBtn.disabled) return;
      // #1284: the camera roll is a full-screen native surface and this tab
      // can be evicted behind it. Nothing suspends the dialog here, so there
      // is no dismissal to race — only the page's own death to insure
      // against. Cleared again by the change handler below.
      stashCaptureDraft();
      screenshotInput.click();
    });

    screenshotInput.addEventListener('change', async () => {
      const file = screenshotInput.files && screenshotInput.files[0];
      screenshotInput.value = '';
      // A cancelled pick came back with the page intact — nothing to rescue.
      if (!file) { clearCaptureDraft(); return; }
      setScreenshotActionsDisabled(true);
      try {
        const blob = await screenshotTools.prepareFile(file);
        await attachScreenshotBlob(blob);
      } catch (err) {
        if (err && err.code === 'invalid-type') {
          showFeedbackNotice('Choose a PNG or JPEG image.', true);
        } else if (err && err.code === 'too-large') {
          showFeedbackNotice('That image is larger than 4 MB.', true);
        } else {
          showFeedbackNotice("Couldn't attach that image. Please try another.", true);
        }
      } finally {
        clearCaptureDraft();
        if (!screenshotBlob) setScreenshotActionsDisabled(false);
      }
    });

    screenshotRemove.addEventListener('click', () => {
      // Client-side forget only — the orphaned server row (if the upload
      // already finished) is GC'd by the 24h sweeper.
      resetScreenshotState();
    });

    // ── #1054: the offline outbox seam ─────────────────────────────
    //
    // Feedback is the one thing a user types BECAUSE something is wrong, and
    // "something is wrong" very often means the network. The dialog used to
    // answer that with a red "Network error" and keep the text hostage in a
    // textarea that the next tap on the backdrop emptied. Now a submit that
    // can't reach the server is saved to public/js/feedback-queue.js and sent
    // when the connection is back.
    //
    // Two entry points into the same save: the pre-emptive one (we already
    // know we're offline, so don't even try — the button says "Save for
    // later") and the reactive one (the POST threw). They must feel
    // identical, so both go through saveForLater() below.
    const isOfflineNow = () => {
      try { return !!(window.Offline && window.Offline.isOffline && window.Offline.isOffline()); } catch (err) { return false; }
    };

    // A refused save is always explained — an invisible outbox that silently
    // drops things is worse than the bug this replaces.
    const queueRefusal = (code) => {
      if (code === 'duplicate') return "You've already saved this message. It'll send once you're back online.";
      if (code === 'full') return `Only ${window.FeedbackQueue?.MAX_ENTRIES || 10} messages can wait offline at once. The earlier ones send first.`;
      if (code === 'too-large') return "There isn't room to keep another screenshot offline. Remove it and save the text.";
      return "Couldn't save this message on this device.";
    };

    // The queue status line. One element (#feedback-status) says all three
    // things, in order of how much the user needs it: the offline hint, the
    // count already waiting, or nothing at all.
    let queueLineText = '';
    let queuePendingCount = 0;

    const queueStatusLine = () => {
      const offline = isOfflineNow();
      const n = queuePendingCount;
      // Written out per plural rather than assembled from fragments: these
      // exact sentences are what the dapp.json checks match on, and
      // tests/feedback-offline-ui.test.js verifies they exist verbatim here.
      if (offline && n > 0) {
        return n === 1
          ? "You're offline. 1 message saved on this device is waiting to send. This one will be saved too."
          : `You're offline. ${n} messages saved on this device are waiting to send. This one will be saved too.`;
      }
      if (offline) {
        return "You're offline. Your message will be saved on this device and sent automatically "
          + "when you're back online.";
      }
      if (n > 0) {
        return n === 1
          ? '1 message saved on this device, sending now.'
          : `${n} messages saved on this device, sending now.`;
      }
      return '';
    };

    // Repaint the hint and the button label. Never overwrites a submit
    // outcome ("Thanks! Filed against…", an error, the saved confirmation):
    // that is the newer and more specific thing to say, so the line is only
    // rewritten while it is hidden or still showing our own text.
    const paintQueueState = () => {
      if (!feedbackBtn.disabled) feedbackBtn.textContent = isOfflineNow() ? 'Save for later' : 'Submit';
      const owned = feedbackStatus.classList.contains('hidden')
        || (queueLineText && feedbackStatus.textContent === queueLineText);
      if (!owned) return;
      const line = queueStatusLine();
      if (!line) {
        feedbackStatus.classList.add('hidden');
        queueLineText = '';
        return;
      }
      feedbackStatus.textContent = line;
      feedbackStatus.className = 'text-sm mt-2 text-zinc-500 dark:text-zinc-400';
      feedbackStatus.classList.remove('hidden');
      queueLineText = line;
    };

    // The header's speech-bubble carries a small violet dot while anything is
    // waiting — the only ambient sign that unsent feedback exists. The dot is
    // a node inside the React header island, so this PUBLISHES rather than
    // toggling the class by id: a classList write that lands before the
    // header's hydration commit is a mismatch React 19 patches away — the
    // constant `className="hidden …"` comes back and nothing repaints,
    // because ?shot=feedback-queued pins connectivity and no later event
    // fires. That stomp is why the check flipped pass/fail ~50/50 by boot
    // timing (#1054). The store's mount-time apply makes either order paint
    // — same seam as the offline banner and the header's own visibility.
    const paintQueueDot = (n) => {
      publishVisibility('feedback-queue-dot', n > 0);
    };

    // Every count() is async (opening IndexedDB can take a moment) and three
    // things ask for one — the dialog opening, a connectivity change, and the
    // store's own change notifications. They can resolve OUT OF ORDER, and a
    // stale answer paints a count the store no longer has: that is exactly how
    // ?shot=feedback-queued lost its dot, because the offline-change fired
    // before the seed and its slower read landed after it. Only the newest
    // read is allowed to paint.
    let queueReadSeq = 0;
    const readQueueCount = () => {
      if (!window.FeedbackQueue) return Promise.resolve(null);
      const seq = ++queueReadSeq;
      return Promise.resolve(window.FeedbackQueue.count()).then((n) => {
        if (seq !== queueReadSeq) return null;
        queuePendingCount = n;
        paintQueueDot(n);
        return n;
      }).catch(() => null);
    };

    // Paint from the cached count now, then again from the store a tick later
    // (same guarded-late-paint shape as the bounty row's budget refresh).
    const refreshQueueState = () => {
      paintQueueState();
      readQueueCount().then((n) => {
        if (n === null) return;
        const modal = document.getElementById('feedback-modal');
        if (!modal.classList.contains('hidden')) paintQueueState();
      });
    };

    // Save `body` (the exact /api/feedback payload) for later, with the
    // screenshot bytes if one is attached. Mirrors the successful-submit
    // cleanup: the draft is consumed, the dialog locks, and it closes after
    // the same 1500 ms grace window — because from the user's side the job IS
    // done. Only the wording differs.
    const saveForLater = async (body) => {
      if (!window.FeedbackQueue) {
        showFeedbackNotice('Network error', true);
        return false;
      }
      try {
        await window.FeedbackQueue.enqueue({
          payload: body,
          // Already-uploaded screenshots travel as an id; a capture whose
          // upload failed travels as bytes and is uploaded at flush time.
          screenshot: screenshotId ? null : screenshotBlob,
        });
      } catch (err) {
        showFeedbackNotice(queueRefusal(err && err.code), true);
        return false;
      }
      feedbackStatus.textContent = "Saved on this device. We'll send it as soon as you're back online.";
      feedbackStatus.className = 'text-sm mt-2 text-emerald-700 dark:text-emerald-400';
      feedbackStatus.classList.remove('hidden');
      queueLineText = '';
      feedbackText.value = '';
      feedbackTitle.value = '';
      clearDescriptionError();
      // #1284: safe in the outbox now — the capture stash has nothing to add.
      clearCaptureDraft();
      resetTitleGenState();
      resetScreenshotState();
      setComposerLocked(true);
      feedbackBtn.disabled = true;
      feedbackBtn.textContent = 'Saved';
      // This count is the freshest thing anyone knows — invalidate any read
      // that was already in flight so it cannot paint the pre-save figure.
      queueReadSeq += 1;
      queuePendingCount += 1;
      paintQueueDot(queuePendingCount);
      // A probe now means a connection that quietly came back sends this
      // within seconds instead of at the next 60 s tick.
      try { window.Offline?.nudge?.(); } catch (err) { /* ignore */ }
      closeTimer = setTimeout(() => document.getElementById('feedback-cancel').click(), 1500);
      return true;
    };

    // Keep the dialog honest while it is open: the connectivity probe runs
    // every 15 s, so the state it described on open can be stale by the time
    // the user finishes typing.
    window.addEventListener('usernode:offline-change', () => {
      const modal = document.getElementById('feedback-modal');
      if (modal && !modal.classList.contains('hidden')) refreshQueueState();
      else readQueueCount();
    });

    // Arm the outbox: the dot follows the store, and a successful flush says
    // so out loud (the user filed this minutes or hours ago — silence would
    // read as "it never sent"). Same Dev-panel refresh as a live submit, so a
    // flushed issue appears in Open Issues without a reload.
    if (window.FeedbackQueue) {
      window.FeedbackQueue.init({
        onChange: () => { readQueueCount(); },
        onFlushed: (res) => {
          const n = res.sent;
          PlatformUI.toast(n === 1
            ? 'Your saved feedback has been sent.'
            : `Your ${n} saved feedback messages have been sent.`);
          const filedApp = res.filed.find((f) => f.target === 'app' && f.appSlug);
          const filedPlatform = res.filed.some((f) => f.target !== 'app');
          if (typeof AppView !== 'undefined' && App.currentTab === 'dev'
              && ((filedApp && App.currentApp === filedApp.appSlug)
                || (filedPlatform && AppView?.appData?.self_hosted))) {
            AppView.refreshDevData('issue');
          }
          const moment = res.filed.find((f) => f.firstFeedback)?.firstFeedback;
          if (moment && Number(moment.userId) === Number(App.user?.id)) {
            const open = !document.getElementById('feedback-modal').classList.contains('hidden');
            if (!open) App.openFeedbackModal({ firstFeedback: moment });
            // `readOnly`, because that is what the lock is made of now.
            // This read still probed `disabled` after #1757 stopped setting
            // it, so it was permanently false: a flush that landed on an
            // already-sent composer took the "someone is typing" branch and
            // the confirmation never appeared.
            else if (feedbackText.readOnly) showFirstFeedback(moment, 'Your saved feedback has been sent.');
            else pendingFirstFeedback = moment; // Keep the draft being typed intact.
          }
        },
      });
    }

    const submitFeedback = async () => {
      const text = feedbackText.value.trim();
      // #1603: this used to be a bare `return` — the one submit path that
      // refused and said nothing. It stays FIRST (ahead of the offline
      // branch below, which would otherwise queue an empty description).
      if (!text) { showDescriptionError(); return; }
      // Guard against double-submit while the request is in flight, and
      // also against submits after success (the textarea is disabled
      // then, but a stale cmd+enter on a focused button could still
      // land here).
      if (feedbackBtn.disabled) return;
      // #683: a screenshot upload is still in flight — the id isn't known
      // yet, so filing now would silently drop the attachment.
      if (screenshotUploading) {
        showFeedbackNotice('Screenshot is still uploading, one moment…', false);
        return;
      }
      // #732: freeze the title snapshot for this submit — cancel the
      // pending debounce and invalidate any in-flight preview (a Submit
      // click blurs the textarea, which flushes one) so a response
      // generated from a partial description can't rewrite the field
      // mid-submit. A failed submit re-arms normally: the next
      // description input reschedules the debounce.
      if (titleGenTimer) { clearTimeout(titleGenTimer); titleGenTimer = null; }
      titleGenSeq++;
      feedbackTitle.placeholder = titleIdlePlaceholder;
      feedbackBtn.disabled = true; feedbackBtn.textContent = 'Submitting...';
      const submittedPresentation = presentation;
      const submittedBy = App.user?.id;
      try {
        // Capture the target + slug at submit time so navigating away
        // while the modal is open can't retarget an in-flight request.
        const target = feedbackTarget;
        const body = { description: text, target };
        // #556: optional user-chosen title — omitted entirely when blank
        // so the server auto-generates one as before. #732: an
        // auto-filled title is trusted only when it was generated from
        // exactly the description being submitted (lastGeneratedFor);
        // a stale fill from a partial description is dropped so the
        // server names the issue from the full text. A title the user
        // typed or edited (titleDirty) is always sent verbatim.
        const customTitle = feedbackTitle.value.trim();
        if (customTitle && (titleDirty || text === lastGeneratedFor)) body.title = customTitle;
        if (target === 'app') body.appSlug = App.currentApp;
        // #964: pledge a kudos bounty on the issue this submit files.
        // Captured at submit time alongside the target, and only when the
        // box is both ticked and enabled — a disabled (allowance-spent)
        // checkbox must never send the flag. The server files the issue
        // regardless of what happens to the bounty.
        const wantBounty = bountyCheckbox.checked && !bountyCheckbox.disabled
          && !bountyRow.classList.contains('hidden');
        if (wantBounty) body.bounty = true;
        // #1054: a capture whose upload failed earlier still has its bytes
        // (screenshotBlob). Retry the upload now so a submit that goes
        // through keeps the attachment the thumbnail is still promising. A
        // second failure is not fatal — the offline branch below carries the
        // bytes, and an online submit files without the picture as before.
        if (!screenshotId && screenshotBlob && !isOfflineNow()) {
          try {
            const shotRes = await fetch('/api/feedback/screenshot', {
              method: 'POST',
              headers: { 'Content-Type': 'application/octet-stream' },
              body: screenshotBlob,
            });
            const shotData = await shotRes.json().catch(() => ({}));
            if (shotRes.ok && shotData.id) {
              screenshotId = shotData.id;
              screenshotState.textContent = '';
            }
          } catch (err) { /* still offline — handled below */ }
        }
        // #683: attach the uploaded screenshot — the server appends the
        // embed line and links the row to the filed issue.
        if (screenshotId) body.screenshotId = screenshotId;
        // #685: collect the app's state snapshot at submit time (fresh
        // state, and the modal only overlays the still-running iframe).
        // Never blocks filing: a null (provider gone, error, 5 s
        // timeout) files without state with a non-blocking notice.
        let stateNotice = '';
        const wantState = stateAvailable && target === 'app'
          && !stateRow.classList.contains('hidden') && stateCheckbox.checked;
        if (wantState && typeof AppView !== 'undefined'
            && typeof AppView.collectIssueState === 'function') {
          const pageState = await AppView.collectIssueState();
          if (pageState) {
            body.pageState = pageState.json;
            if (pageState.truncated) body.pageStateTruncated = true;
          } else {
            stateNotice = " Couldn't collect app state, so it was filed without it.";
            showFeedbackNotice("Couldn't collect app state, filing without it…", false);
          }
        }
        // #1054: we already know the network is down (the /health probe said
        // so, and the button says "Save for later") — so don't spend a doomed
        // round trip and a red error message finding out. Straight to the
        // outbox.
        if (isOfflineNow()) {
          if (await saveForLater(body)) return;
          feedbackBtn.disabled = false;
          feedbackBtn.textContent = isOfflineNow() ? 'Save for later' : 'Submit';
          return;
        }
        // #1054: the POST is caught on its own — narrowly — so a *transport*
        // failure can go to the outbox while a bad response body still falls
        // through to the generic error below. Enqueueing on anything wider
        // would risk filing twice: a 201 whose JSON failed to parse did
        // create the issue.
        let res;
        try {
          res = await fetch('/api/feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
        } catch (err) {
          if (await saveForLater(body)) return;
          feedbackBtn.disabled = false;
          feedbackBtn.textContent = isOfflineNow() ? 'Save for later' : 'Submit';
          return;
        }
        const data = await res.json();
        // An old response must not replace a reopened draft or another
        // account's dialog after sign-out/sign-in.
        if (submittedPresentation !== presentation || submittedBy !== App.user?.id) return;
        if (res.ok) {
          // #964: report both outcomes on one line. A declined bounty
          // (allowance ran out between opening and submitting, repo isn't
          // an app the platform can attach one to) never reads as a
          // failure — the issue IS filed, and the bounty can still be added
          // later from the Dev screen's Topics row.
          let bountyNotice = '';
          if (data.bounty) {
            if (data.bounty.placed) {
              bountyNotice = ` Pledged 1 kudos as a bounty. ${data.bounty.remaining} left this week.`;
              // The drawer's Kudos meter must show the number the user
              // just spent down to, not the one they saw before.
              window.Kudos?.Budget?.refresh?.();
            } else {
              bountyNotice = ` Couldn't add the bounty: ${data.bounty.error || 'the bounty could not be placed'}.`;
            }
          }
          const filedAgainst = (target === 'app'
            ? `Thanks! Filed against ${AppView?.appData?.name || 'this app'}`
            : 'Thanks! Filed against Homeroom');
          // Both variants end the first sentence before appending, so the
          // bounty outcome reads as its own sentence either way.
          feedbackStatus.textContent = `${filedAgainst}.${bountyNotice}${stateNotice}`;
          feedbackStatus.className = 'text-sm mt-2 text-emerald-700 dark:text-emerald-400';
          feedbackStatus.classList.remove('hidden');
          feedbackText.value = '';
          feedbackTitle.value = '';
          clearDescriptionError();
          // #1284: filed — there is nothing left to rescue.
          clearCaptureDraft();
          // Discard any in-flight title preview so it can't repopulate
          // the cleared field during the "Thanks!" grace window.
          resetTitleGenState();
          // #683: the screenshot now belongs to the filed issue.
          resetScreenshotState();
          // Lock the textarea and keep the submit button disabled for
          // the 1500ms "Thanks!" grace window so a user can't keep
          // typing (or re-fire cmd+enter) after their feedback has
          // already been filed — fixes #32. Both controls are
          // re-enabled when the modal is reopened below.
          setComposerLocked(true);
          feedbackBtn.textContent = 'Submitted';
          // #125: make the new issue show up in this app's "Open Issues"
          // panel without a reload. The server seeds its issues cache and
          // broadcasts an issue_update (handled in connectEvents) for
          // other clients; this direct refresh covers the submitting tab
          // even if its events socket is momentarily down. Platform-
          // targeted feedback lands in the self-hosted platform app's
          // issue list, so refresh that panel too when it's the one open.
          if (typeof AppView !== 'undefined' && App.currentTab === 'dev'
              && ((target === 'app' && body.appSlug && App.currentApp === body.appSlug)
                || (target === 'platform' && AppView?.appData?.self_hosted))) {
            AppView.refreshDevData('issue');
          }
          if (!showFirstFeedback(data.firstFeedback, feedbackStatus.textContent)) {
            closeTimer = setTimeout(() => document.getElementById('feedback-cancel').click(), 1500);
          }
          return;
        }
        feedbackStatus.textContent = data.error || 'Failed to submit';
        feedbackStatus.className = 'text-sm mt-2 text-red-400';
        feedbackStatus.classList.remove('hidden');
      } catch {
        // Reached only when the request itself completed and something about
        // the RESPONSE was unusable (non-JSON error body from a proxy, say).
        // A transport failure was already handled above, by saving.
        feedbackStatus.textContent = 'Network error';
        feedbackStatus.className = 'text-sm mt-2 text-red-400';
        feedbackStatus.classList.remove('hidden');
      }
      feedbackBtn.disabled = false;
      feedbackBtn.textContent = isOfflineNow() ? 'Save for later' : 'Submit';
    };

    // The state half of "open the Send Feedback modal", called by the
    // island's onOpen. Shared by the header feedback button (no opts) and
    // the dev view's plus-menu "File an issue" item, which passes
    // { fromDev: true } — see issue #226. The classList.remove('hidden')
    // that used to be this function's first line belongs to useStaticModal
    // now: by the time this runs the island has already revealed the root
    // and lifted the card into the kit shell.
    Feedback._open = (opts = {}) => {
      presentation += 1;
      clearTimeout(closeTimer);
      firstFeedback = null;
      // Every open hands back an editable composer (showFirstFeedback re-locks).
      setComposerLocked(false);
      firstSuccess?.classList.add('hidden');
      feedbackForm?.classList.remove('hidden');
      // Opening a queued success must not consume a failed outbox draft or
      // start screenshot/title probes behind the confirmation.
      if (opts.firstFeedback && showFirstFeedback(opts.firstFeedback, 'Your saved feedback has been sent.')) return;
      feedbackBtn.disabled = false; feedbackBtn.textContent = 'Submit';
      feedbackStatus.classList.add('hidden');
      // #1603: a refusal from a previous open never greets the next one.
      clearDescriptionError();
      resetTitleGenState();
      // #683/#824: each open starts screenshot-less. Photos is immediately
      // available; native capture appears after a fresh capability probe.
      const screenshotSession = ++screenshotProbeSequence;
      nativeCaptureSupported = false;
      resetScreenshotState();
      void probeNativeCaptureSupport(screenshotSession, true);

      // "This app" is only selectable when an app with a real repo is
      // open. Otherwise the button stays visible but grayed-out/disabled
      // so users can still see both choices, and we default to platform.
      const appData = (typeof AppView !== 'undefined' && AppView.appData) || null;
      const repoUrl = appData?.repo_url || '';
      const hasRepo = /github\.com\/[^/]+\/[^/]+/.test(repoUrl);
      // An app is "open" whenever its view is mounted — on the running
      // App tab OR the Dev screen. Both `currentApp` and `appData` are
      // cleared together by AppView.close() (on navigateHome /
      // navigateToLeaderboard), so they're never stale on the
      // home/leaderboard screens. This unifies the old fromDev-vs-header
      // split: the dev plus-menu's "File an issue" item (currentTab==='dev')
      // and the top-bar Send feedback button now resolve identically, so
      // the header button targets the app whose dev screen is open
      // instead of falling back to "No app open" (#312).
      const appIsOpen = !!App.currentApp && !!appData
        && (App.currentTab === 'app' || App.currentTab === 'dev');
      // The self-hosted platform app is excluded: targeting "this app"
      // would file into the same platform repo via a different
      // credential path and skip the usernode label, so we force the
      // Platform target instead. (Self-hosted apps hide their App tab
      // and land on Dev, so this only ever fires on the dev screen.)
      const canTargetApp = appIsOpen && hasRepo && !appData.self_hosted;
      // #685: "Include app state" — only when the open app registered a
      // state provider AND its announcing frame is still the mounted
      // production iframe (false on the Dev screen, where the App-tab
      // iframe is torn down). Reset to checked on each open; the row's
      // visibility is applied by the setFeedbackTarget call below.
      stateAvailable = canTargetApp
        && typeof AppView !== 'undefined'
        && typeof AppView.issueStateAvailable === 'function'
        && AppView.issueStateAvailable();
      stateCheckbox.checked = true;
      // #964: the bounty row paints from the budget the badge already
      // holds, then a refresh lands the current figure a moment later — a
      // long-lived tab could otherwise show an hour-stale count. Both the
      // immediate paint and the post-refresh repaint reset the checkbox to
      // unchecked, which is the whole point of the row: a pledge is always
      // a deliberate tick, never a side effect of filing feedback.
      resetBountyRow();
      Promise.resolve(window.Kudos?.Budget?.refresh?.()).then(() => {
        // Only if the dialog is still open and untouched by the user.
        const modal = document.getElementById('feedback-modal');
        if (!modal.classList.contains('hidden') && !bountyCheckbox.checked) resetBountyRow();
      }).catch(() => { /* budget unavailable — row stays as painted */ });
      if (canTargetApp) {
        feedbackTargetApp.textContent = appData?.name ? `This app (${appData.name})` : 'This app';
        setAppTargetEnabled(true);
        // Default to the app the user is looking at — most likely intent.
        setFeedbackTarget('app');
      } else {
        // With an app actually open (no repo yet, or self-hosted) keep
        // its name on the grayed label — "No app open" would be wrong
        // there. Only show "No app open" when no app is really open.
        feedbackTargetApp.textContent = appData
          ? (appData.name ? `This app (${appData.name})` : 'This app')
          : 'No app open';
        setAppTargetEnabled(false);
        setFeedbackTarget('platform');
      }

      // #1054: the outbox state — the offline hint, the "Save for later"
      // button label, and anything already waiting to send. Painted last so
      // none of the resets above overwrite the line, then refreshed from the
      // store a tick later.
      queueLineText = '';
      refreshQueueState();
      // A submit the server refused outright (a 400 no amount of retrying can
      // satisfy) is handed back here rather than disappearing: the user's own
      // words, their title and their target, with the reason above them.
      if (window.FeedbackQueue) {
        Promise.resolve(window.FeedbackQueue.takeFailed()).then((failed) => {
          const modal = document.getElementById('feedback-modal');
          if (!failed || modal.classList.contains('hidden')) return;
          // Live text always wins — a returned draft must never overwrite
          // what someone is typing right now.
          if (feedbackText.readOnly || feedbackText.value.trim()) return;
          const p = failed.payload || {};
          feedbackText.value = p.description || '';
          if (p.title) { feedbackTitle.value = p.title; titleDirty = true; }
          if (p.target === 'app' && !feedbackTargetApp.disabled) setFeedbackTarget('app');
          feedbackStatus.textContent = `This message couldn't be sent: ${failed.lastError || 'the server rejected it'}.`
            + ' Your text is back, so edit it and try again.';
          feedbackStatus.className = 'text-sm mt-2 text-red-400';
          feedbackStatus.classList.remove('hidden');
          queueLineText = '';
          feedbackText.focus();
        }).catch(() => { /* nothing to hand back */ });
      }

      // #1284: a capture that took the page down with it left the words in
      // sessionStorage. Hand them back — into an empty, editable field only,
      // the same "live text always wins" rule the outbox hand-back above
      // follows, and read once so a dismissed rescue does not keep returning.
      const rescued = readCaptureDraft();
      if (rescued) {
        clearCaptureDraft();
        if (!feedbackText.readOnly && !feedbackText.value.trim()) {
          feedbackText.value = rescued.description;
          if (rescued.title && !feedbackTitle.value.trim()) {
            feedbackTitle.value = rescued.title;
            titleDirty = rescued.titleDirty !== false;
          }
          if (rescued.target === 'app' && !feedbackTargetApp.disabled) setFeedbackTarget('app');
          showFeedbackNotice("The screenshot didn't make it, but your feedback is safe. Here it is again.", false);
          queueLineText = '';
        }
      }

      feedbackText.focus();
    };
    // The header's #feedback-btn used to be wired here. THE UI OVERHAUL
    // retired it: the dialog's entry point is the Improve panel's "Give
    // feedback" row now (features/improve/improve-controller.js's
    // giveFeedback(), which opens it with `fromDev: true` so the panel's own
    // app is preselected as the target). `App.openFeedbackModal` is unchanged
    // and still published below, so every other caller — the Dev "+" menu's
    // "File an issue", App._applyFeedbackShot, the rescued-draft notice — is
    // untouched.
    //
    // The button's outbox dot moved rather than went: #feedback-queue-dot
    // keeps its id and its writer (paintQueueDot) and now renders on
    // #improve-btn, which is the only way to reach this dialog from the
    // header.
    // Admin/moderation console (#588) is a drawer row now, not a header
    // button — its click handler is wired in HeaderMenu.init() (close the
    // drawer; the anchor's #admin href does the navigating). The row is
    // hidden for non-admins (see renderAdminButton) and
    // navigateToAdminConsole re-checks the flag, so a stray programmatic
    // hash change can't open it either.
    // The state half of the dismiss path, called by the island's onClose.
    // The Cancel button, the backdrop click, a kit dismiss and the two
    // `#feedback-cancel`.click() calls the success and save-for-later paths
    // fire after their 1500 ms grace window all arrive here now. The
    // classList.add('hidden') that used to be this handler's first line
    // belongs to useStaticModal.
    Feedback._reset = () => {
      presentation += 1;
      clearTimeout(closeTimer);
      firstFeedback = null;
      firstSuccess?.classList.add('hidden');
      feedbackForm?.classList.remove('hidden');
      // #1284: a dismissal that lands mid-capture is the stale teardown of
      // the presentation `suspendDialog()` closed, not the user closing the
      // dialog — so the draft, the title and the notice stay. (The screenshot
      // half below resets either way: that attempt is over.)
      if (!captureInFlight) {
        feedbackText.value = '';
        feedbackTitle.value = '';
        feedbackStatus.classList.add('hidden');
        clearDescriptionError();
        resetTitleGenState();
        clearCaptureDraft();
      }
      setComposerLocked(false);
      feedbackBtn.disabled = false; feedbackBtn.textContent = 'Submit';
      // #683: cancelling discards the attachment client-side; an already
      // uploaded (now orphaned) row is GC'd server-side after 24h.
      screenshotProbeSequence += 1;
      nativeCaptureSupported = false;
      resetScreenshotState();
      // #964: drop any pledge intent with the rest of the draft.
      bountyCheckbox.checked = false;
      const pending = pendingFirstFeedback;
      pendingFirstFeedback = null;
      if (pending) setTimeout(() => {
        if (Number(pending.userId) === Number(App.user?.id)) App.openFeedbackModal({ firstFeedback: pending });
      }, 0);
    };
    feedbackBtn.addEventListener('click', submitFeedback);
    // cmd+enter / ctrl+enter inside the textarea submits — fixes #34.
    // Textareas swallow Enter by default (it inserts a newline), so we
    // only intercept when the modifier key is held.
    feedbackText.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submitFeedback();
      }
    });
    // #556: same shortcut in the optional title input. Plain Enter is
    // NOT intercepted — the natural next step from the title is writing
    // the description, and there's no <form> for Enter to submit.
    feedbackTitle.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submitFeedback();
      }
    });

  // The entry point every caller uses — the header speech-bubble wired just
  // above, the Dev "+" menu's "File an issue" item, and `App._applyFeedbackShot`
  // for the ?shot=feedback deep links. Forwards to the island so React state
  // stays the source of truth.
  App.openFeedbackModal = (opts = {}) => {
    const island = dialogController();
    if (island) { island.open(opts); return; }
    Feedback._open(opts);
  };

  // #1284: a capture stash that survived a reload means the page died
  // mid-attempt, so say so at boot rather than leaving the user to guess that
  // reopening the dialog will bring their words back.
  //
  // Called from BOTH `App.enterAuthed()` (with `?.()`, since app.js boots
  // whether or not this island has mounted) and the end of this init(),
  // because their order is not fixed: hydration normally publishes this after
  // /api/auth/me has already run enterAuthed, and a slow bundle reverses it.
  // Hence the once-per-boot flag, and the session check — a visitor who is
  // not signed in has no feedback dialog to be pointed at.
  let bootDraftAnnounced = false;
  App.noticeRescuedFeedbackDraft = () => {
    if (bootDraftAnnounced || !App.user) return;
    if (!readCaptureDraft()) return;
    bootDraftAnnounced = true;
    try {
      PlatformUI?.toast?.('Your feedback draft was saved. Reopen Send feedback to finish it.');
    } catch { /* the draft is in the stash either way */ }
  };
  App.noticeRescuedFeedbackDraft();

  // #1284: the ?shot=feedback-capture-failed reviewable state. Runs the REAL
  // capture round trip with a capture that fails the way a phone's does, so
  // the retained draft, the restored dialog and the notice copy are all
  // photographed from the code that ships. Display-only: it touches no
  // bridge, uploads nothing and files nothing.
  App._simulateFeedbackCaptureFailure = () => runCapture(
    async () => { const err = new Error('capture failed'); err.code = 'capture_failed'; throw err; },
    { nativeAttempt: true },
  );

  // #1603: the ?shot=feedback-required reviewable state — the dialog after a
  // submit with an empty description. Same arrangement, and for the same
  // reason: it calls the REAL submitFeedback, so what gets photographed is
  // the shipped refusal rather than a mock of it. That path returns before
  // any fetch on an empty description, so this files nothing either.
  App._simulateEmptyFeedbackSubmit = () => { void submitFeedback(); };

  // Display-only review state: no feedback, session, or milestone is written.
  App._simulateFirstFeedback = () => showFirstFeedback({
    userId: App.user?.id, appSlug: App.currentApp || 'usernode-2d5619',
    issueNumber: 900008, canFix: true,
  }, 'Your feedback has been sent.');
}
