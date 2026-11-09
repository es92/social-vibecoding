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

import { arrowStep } from '../../lib/i18n/direction';
import { t } from '../../lib/i18n/runtime';
import { isRepoAddress } from '../../lib/repo-link.js';
import { KUDOS_PARKED } from '../leaderboard/kudos-parked';
import { publishVisibility } from '../../lib/visibility-store';
import { openThreadAbout } from '../../lib/thread-about';

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
//
// `suspendDialog()` hands back the controller's promise that the dialog has
// finished leaving the screen — see captureBehindHiddenDialog below.
function suspendDialog() { return dialogController()?.suspend(); }
function resumeDialog() { dialogController()?.resume(); }

// #2346: how long a native capture waits for the suspended dialog's exit.
// The kit fades the card out over ~180ms and falls back to a 300ms timer when
// no transitionend arrives (animateDialog, public/usernode-native/v1/
// native.js); twice that fallback covers a slow render on either side. The
// bound is what matters: an exit callback that never lands must cost the
// viewer a dialog in the photo, not a capture that never happens.
export const DIALOG_EXIT_WAIT_MS = 600;

// #2346: one native capture, with the dialog out of the picture.
//
// The phone photographs whatever the web view shows at the moment of the
// call. Suspending the dialog used to remove its card on the spot, so two
// animation frames were enough to get it out of frame. Since the card rides
// the kit's exit animation (#1474) it is still on screen, mid-fade, for the
// length of that animation — and the screenshot attached to the feedback was
// a picture of the feedback dialog. So: wait for the exit, bounded, then for
// the frame that paints the page without it, then shoot.
//
// Exported for tests/feedback-mobile-screenshot.test.js, which runs this exact
// sequence rather than a copy of it.
export async function captureBehindHiddenDialog(
  hide, capture, waitForPaint, exitWaitMs = DIALOG_EXIT_WAIT_MS,
) {
  let timer;
  const bound = new Promise((resolve) => { timer = setTimeout(resolve, exitWaitMs); });
  try {
    await Promise.race([hide(), bound]);
  } finally {
    clearTimeout(timer);
  }
  await waitForPaint();
  return capture();
}

// The two halves the island calls back into, populated by `init()`.
export const Feedback = {
  // Match the runtime replacement below so TypeScript's JS inference keeps
  // the island's legacy `{ fromDev }` payload in the public signature.
  _open: (_opts = {}) => {},
  _reset: () => {},
  // #5687: the full-size preview of an attached picture or clip. The island
  // replaces it with its own state setter (`_preview = setPreview`), the same
  // split as `_open`; the thumbnails built below call it on a tap.
  _preview: (_item = null) => {},
  /**
   * @returns {{ text: string, title: string, images: Blob[], bounty: boolean,
   *   target: 'app' | 'platform' | null, appSlug?: string, appName?: string }}
   */
  _takeDraft: () => ({ text: '', title: '', images: [], bounty: false, target: null }),
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
    // #3186: the ordinary confirmation; see showSent below.
    const sentSection = document.getElementById('feedback-sent');
    const sentNotice = document.getElementById('feedback-sent-notice');
    let firstFeedback = null;
    let pendingFirstFeedback = null;
    let closeTimer = null;
    let presentation = 0;
    let lastFiled = null;
    let editTimer = null;
    let editCountdown = null;
    let editing = null;
    let editActions = null;
    let editBusy = false;
    const editSection = document.getElementById('feedback-edit');
    const editTitle = document.getElementById('feedback-edit-title');
    const editText = document.getElementById('feedback-edit-text');
    const editStatus = document.getElementById('feedback-edit-status');
    const editWindow = document.getElementById('feedback-edit-window');
    const editSave = document.getElementById('feedback-edit-save');
    const editCancel = document.getElementById('feedback-edit-cancel');
    const editButtons = ['feedback-sent-edit', 'feedback-first-edit'].map(id => document.getElementById(id));
    const editNow = () => typeof performance !== 'undefined' ? performance.now() : Date.now();
    const rememberEdit = (edit) => edit ? { ...edit, deadline: editNow() + Number(edit.secondsLeft) * 1000 } : null;
    const editSeconds = (edit) => Math.max(0, (edit.deadline - editNow()) / 1000);
    const showEditStatus = (message) => {
      editStatus.textContent = message;
      editStatus.classList.toggle('hidden', !message);
    };
    const resetEdit = () => {
      clearTimeout(editTimer);
      clearInterval(editCountdown);
      lastFiled = null;
      editing = null;
      editActions = null;
      editBusy = false;
      editSection?.classList.add('hidden');
      if (editTitle) editTitle.value = '';
      if (editText) editText.value = '';
      for (const button of editButtons) button?.classList.add('hidden');
    };
    const armEditExpiry = (edit) => {
      clearTimeout(editTimer);
      clearInterval(editCountdown);
      if (editing === edit) editCountdown = setInterval(() => {
        const seconds = editSeconds(edit);
        if (seconds > 0) editWindow.textContent = t('dialogs:feedback.edit.window', { count: Math.ceil(seconds / 60) });
      }, 1000);
      editTimer = setTimeout(() => {
        clearInterval(editCountdown);
        for (const button of editButtons) button?.classList.add('hidden');
        if (editing === edit && !editSection.classList.contains('hidden')) {
          editWindow.textContent = '';
          editSave.disabled = true;
          showEditStatus(t('dialogs:feedback.edit.closed'));
        }
      }, editSeconds(edit) * 1000);
    };
    const offerEdit = (actions) => {
      clearInterval(editCountdown);
      editSection?.classList.add('hidden');
      editing = null;
      editActions = actions;
      const available = lastFiled && editSeconds(lastFiled) > 0;
      for (const button of editButtons) button?.classList.toggle('hidden', !available);
      if (available) armEditExpiry(lastFiled);
    };
    const openEdit = (edit, actions) => {
      if (!edit) return;
      setComposerLocked(true);
      editing = edit;
      editActions = actions;
      editBusy = false;
      editTitle.value = edit.title;
      editText.value = edit.description;
      editTitle.readOnly = editText.readOnly = false;
      editSave.disabled = editSeconds(edit) <= 0;
      editCancel.disabled = false;
      editSave.textContent = t('dialogs:feedback.edit.save');
      editWindow.textContent = t('dialogs:feedback.edit.window', { count: Math.max(1, Math.ceil(editSeconds(edit) / 60)) });
      showEditStatus(editSave.disabled ? t('dialogs:feedback.edit.closed') : '');
      feedbackForm.classList.add('hidden');
      firstSuccess.classList.add('hidden');
      sentSection.classList.add('hidden');
      editSection.classList.remove('hidden');
      armEditExpiry(edit);
      editTitle.focus();
    };
    for (const button of editButtons) button?.addEventListener('click', () => openEdit(lastFiled, editActions));
    editCancel?.addEventListener('click', () => { if (!editBusy) editActions?.cancel(); });
    editSave?.addEventListener('click', async () => {
      if (!editing || editBusy || editSave.disabled) return;
      const title = editTitle.value.trim();
      const description = editText.value.trim();
      if (!title || !description) { showEditStatus(t('dialogs:feedback.edit.required')); return; }
      const edit = editing;
      const actions = editActions;
      const opened = presentation;
      const userId = App.user?.id;
      const current = () => opened === presentation && userId === App.user?.id && editing === edit;
      editBusy = true;
      editSave.disabled = editCancel.disabled = true;
      editTitle.readOnly = editText.readOnly = true;
      editSave.textContent = t('dialogs:feedback.edit.saving');
      showEditStatus('');
      let blocked = false;
      try {
        const response = await fetch(`/api/feedback/${edit.reportId}`, {
          method: 'PATCH', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, description, version: edit.version }),
        });
        const data = await response.json();
        if (!current()) return;
        if (response.ok) {
          lastFiled = rememberEdit(data.edit);
          editBusy = false;
          actions.saved();
          return;
        }
        blocked = data.code === 'edit_window_closed' || data.code === 'edit_conflict';
        if (blocked) {
          clearInterval(editCountdown);
          editWindow.textContent = '';
          if (data.code === 'edit_window_closed') edit.deadline = editNow();
          else lastFiled = null;
        }
        showEditStatus(data.code === 'edit_window_closed' ? t('dialogs:feedback.edit.closed')
          : data.code === 'edit_conflict' ? t('dialogs:feedback.edit.conflict')
            : response.status === 400 ? t('dialogs:feedback.edit.tooLong') : t('dialogs:feedback.edit.failed'));
      } catch {
        if (!current()) return;
        showEditStatus(t('dialogs:feedback.edit.failed'));
      } finally {
        if (current()) {
          editBusy = false;
          editSave.disabled = blocked || editSeconds(edit) <= 0;
          editCancel.disabled = false;
          editTitle.readOnly = editText.readOnly = false;
          editSave.textContent = t('dialogs:feedback.edit.save');
        }
      }
    });
    editSection?.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault(); editSave.click();
      }
    });

    const showFirstFeedback = (moment, notice, edited = false) => {
      if (!moment || Number(moment.userId) !== Number(App.user?.id)) return false;
      clearTimeout(closeTimer);
      firstFeedback = moment;
      pendingFirstFeedback = null;
      // readOnly, not disabled: disabling these two drops focus and takes
      // the keyboard down with it, which is the bug #1757 fixed on the send
      // paths. This path was added separately and kept the old writes, so
      // the two changes were green apart and red together.
      setComposerLocked(true);
      disableSubmit();
      const hasBoard = typeof moment.appSlug === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(moment.appSlug);
      firstFix.disabled = !hasBoard || !moment.canFix || !Number.isSafeInteger(moment.issueNumber) || moment.issueNumber <= 0;
      firstBoard.disabled = !hasBoard;
      // 1 Nov 2026: Work on it with Homeroom bot, where it has a board.
      document.getElementById('feedback-first-work')?.classList.toggle('hidden',
        !hasBoard || !Number.isSafeInteger(moment.issueNumber) || moment.issueNumber <= 0);
      firstFixNote.textContent = firstFix.disabled
        ? (hasBoard ? t('dialogs:feedback.first.fixNote.needAccess') : t('dialogs:feedback.first.fixNote.noBoard'))
        : t('dialogs:feedback.first.fixNote.default');
      firstNotice.textContent = notice || t('dialogs:feedback.first.posted');
      if (edited) firstNotice.textContent = joinSentences([firstNotice.textContent, t('dialogs:feedback.edit.saved')]);
      feedbackForm.classList.add('hidden');
      // A queued first report can land while a filed one's confirmation is
      // up; the moment replaces it rather than stacking under it.
      sentSection?.classList.add('hidden');
      firstSuccess.classList.remove('hidden');
      firstSuccess.focus();
      offerEdit({ cancel: () => showFirstFeedback(moment, notice, edited),
        saved: () => showFirstFeedback(moment, notice, true) });
      return true;
    };

    const closeFeedback = () => document.getElementById('feedback-cancel').click();
    document.getElementById('feedback-first-done')?.addEventListener('click', closeFeedback);

    // #3186: "See your requests" (it was "See your feedback"), in both
    // confirmations: the ordinary one (#feedback-sent) and the first-request
    // moment (#feedback-first-mine). Both open Profile's Your requests by its
    // address, so the request just posted is on screen with its status one
    // tap after sending.
    //
    // The ordinary confirmation used to be the status line, and the dialog
    // closed itself 1.5 s later: "it vanished", in the report this answers,
    // and too soon to reach a link in. It is a section of its own now, drawn
    // the way the first-feedback moment is (the form hidden, the outcome, the
    // way on, Done), and it stays until Done, the backdrop, Escape or the
    // link. Only a FILED report gets it: the save-for-later path below still
    // closes on its own, because a saved report is not in the list yet.
    //
    // The address is written BEFORE the dialog closes, not after. Closing
    // spends the dialog's back-button record with a history.back() that lands
    // a task later; written after it, the new address was undone by that
    // traversal and the viewer ended up back where they sent the report from.
    // Closing second finds the page already moved off the record, and
    // lib/back-stack.ts leaves a record it is not standing on alone.
    // 5 Nov 2026: your requests are the Homeroom bot tab's (History lists the
    // finished ones; the lists above it what is still moving).
    const SEE_MINE_ROUTE = '#homeroom-bot';
    const openMine = () => {
      location.hash = SEE_MINE_ROUTE;
      closeFeedback();
    };
    document.getElementById('feedback-sent-mine')?.addEventListener('click', openMine);
    document.getElementById('feedback-first-mine')?.addEventListener('click', openMine);
    // #4680: the form's own link to it, under the intro line — seen before
    // any typing starts, not only on a confirmation afterwards.
    document.getElementById('feedback-form-mine')?.addEventListener('click', openMine);
    document.getElementById('feedback-sent-done')?.addEventListener('click', closeFeedback);
    // "Thanks! Posted to Run Club" / "Thanks! Posted to Homeroom" is the
    // heading; the notice under it carries only what else happened (a
    // bounty, the app's state), and says nothing when nothing did.
    const sentTitle = document.getElementById('feedback-sent-title');
    // B8: the bot's version of it. `bot` is the post's `homeroomBot`
    // ({ botWillBuild, typicalMinutes, canFix, appSlug, issueNumber }).
    const sentLine = document.getElementById('feedback-sent-line');
    const sentChat = document.getElementById('feedback-sent-chat');
    // 1 Nov 2026: "Work on it with Homeroom bot", under Done, for the
    // request just filed (the post's `filed`: { appSlug, issueNumber }).
    const sentWork = document.getElementById('feedback-sent-work');
    let sentFiled = null;
    const sentFix = document.getElementById('feedback-sent-fix');
    const sentMine = document.getElementById('feedback-sent-mine');
    // #3971: a first request the bot builds; see showSent's `firstApp`.
    const sentFirst = document.getElementById('feedback-sent-first');
    const sentFirstLine = document.getElementById('feedback-sent-first-line');
    // #3971: "Thanks!" went with #3400 and B8 made the bot's answer "Got it",
    // which read as bland next to what it replaced. Both say what happens
    // next now; the bot's line promises what its chat does ("I'll message
    // you here when it's ready to try").
    // Functions, not constants: the words are read when the confirmation is
    // shown, in the language then on screen.
    const sentLineText = () => t('dialogs:feedback.sent.line');
    const botTitle = () => t('dialogs:feedback.sent.botTitle');
    // `minutes` is the bot's typical build time (8 until it has five builds
    // to take a median of); 8 here too when the post did not say.
    const botLine = (minutes) => t('dialogs:feedback.sent.botLine', { count: minutes });
    let sentBot = null;
    // `firstApp`: `{ name }`, the app's name ('' when it has none), when this is the person's first request ever
    // and the bot builds it. The first-request moment used to be skipped for
    // the bot (B8), so the bot's confirmation carries it instead.
    const showSent = (title, notice = '', bot = null, firstApp = null, edited = false, filed = null) => {
      const building = !!bot?.botWillBuild;
      sentBot = building ? bot : null;
      sentFiled = filed && typeof filed.appSlug === 'string' && Number.isSafeInteger(Number(filed.issueNumber))
        && Number(filed.issueNumber) > 0 ? { appSlug: filed.appSlug, issueNumber: Number(filed.issueNumber) } : null;
      sentWork?.classList.toggle('hidden', !sentFiled);
      if (sentTitle) sentTitle.textContent = building ? botTitle() : title;
      if (sentLine) {
        const minutes = Number(bot?.typicalMinutes) > 0 ? Number(bot.typicalMinutes) : 8;
        sentLine.textContent = building ? botLine(minutes) : sentLineText();
      }
      const first = building && !!firstApp;
      if (sentFirstLine && first) {
        sentFirstLine.textContent = firstApp.name
          ? t('dialogs:feedback.sent.firstLine.named', { app: firstApp.name })
          : t('dialogs:feedback.sent.firstLine.unnamed');
      }
      sentFirst?.classList.toggle('hidden', !first);
      sentChat?.classList.toggle('hidden', !building);
      sentMine?.classList.toggle('hidden', building);
      sentFix?.classList.toggle('hidden', !(building && bot.canFix));
      // Homeroom bot builds it, so there is a "ready to try" to hear about:
      // the notification ask, under the line (../notify-ask/suggestion-ask.tsx).
      const ask = window.UsernodeReact?.notifyAsk;
      if (building) ask?.showSuggestion?.();
      else ask?.hideSuggestion?.();
      sentNotice.textContent = edited ? joinSentences([notice, t('dialogs:feedback.edit.saved')]) : notice;
      sentNotice.classList.toggle('hidden', !sentNotice.textContent);
      feedbackForm.classList.add('hidden');
      sentSection.classList.remove('hidden');
      // Off the composer, as the first-feedback moment's focus() is: the
      // keyboard comes down once, now, rather than whenever the viewer closes.
      sentSection.focus();
      offerEdit({ cancel: () => showSent(title, notice, bot, firstApp, edited, filed),
        saved: () => showSent(title, notice, bot, firstApp, true, filed) });
    };
    const hideSent = () => {
      sentSection?.classList.add('hidden');
      window.UsernodeReact?.notifyAsk?.hideSuggestion?.();
    };
    // 1 Nov 2026: a thread only they can see, about the request just filed
    // (../../lib/thread-about.ts), opened on the Homeroom bot tab. It is
    // their own request, so the bot waits for their plan before it builds.
    sentWork?.addEventListener('click', async () => {
      const filed = sentFiled;
      if (!filed || sentWork.disabled) return;
      sentWork.disabled = true;
      try {
        await openThreadAbout(filed.appSlug, filed.issueNumber, 'request', {
          failed: t('dialogs:feedback.sent.workWithBotFailed'),
          after: closeFeedback,
        });
      } finally {
        sentWork.disabled = false;
      }
    });
    const firstWork = document.getElementById('feedback-first-work');
    firstWork?.addEventListener('click', async () => {
      const moment = firstFeedback;
      if (!moment || firstWork.disabled || Number(moment.userId) !== Number(App.user?.id)) return;
      firstWork.disabled = true;
      try {
        await openThreadAbout(moment.appSlug, moment.issueNumber, 'request', {
          failed: t('dialogs:feedback.sent.workWithBotFailed'),
          after: closeFeedback,
        });
      } finally {
        firstWork.disabled = false;
      }
    });
    // B8: Open chat is the chat with Homeroom bot, where the request's card is.
    sentChat?.addEventListener('click', () => {
      closeFeedback();
      window.UsernodeReact?.messages?.openBot?.();
    });
    // B8: building it yourself instead, as the first-request moment's Try a
    // fix yourself does: the request on the board, and a change from it.
    sentFix?.addEventListener('click', async () => {
      const bot = sentBot;
      if (!bot?.canFix || !bot.appSlug || !Number.isSafeInteger(bot.issueNumber)) return;
      try {
        const opening = App.navigateToApp(bot.appSlug, 'dev', bot.issueNumber, 'issues');
        closeFeedback();
        await opening;
        if (App.currentApp === bot.appSlug && AppView.appData?.slug === bot.appSlug) {
          await AppView.createPrForIssue(bot.issueNumber);
        }
      } catch (err) {
        PlatformUI.toast(t('dialogs:feedback.fix.failedRequest'));
      }
    });
    // The first-request moment's two ways on write their address before the
    // dialog closes too, for the reason openMine does above (#3683).
    firstBoard?.addEventListener('click', () => {
      const moment = firstFeedback;
      if (!moment || firstBoard.disabled || Number(moment.userId) !== Number(App.user?.id)) return;
      location.hash = `#app/${encodeURIComponent(moment.appSlug)}/board`;
      closeFeedback();
    });
    firstFix?.addEventListener('click', async () => {
      const moment = firstFeedback;
      if (!moment || firstFix.disabled || Number(moment.userId) !== Number(App.user?.id)) return;
      firstFix.disabled = true;
      try {
        // navigateToApp writes the address before its first await, so the
        // dialog closes after that and before the wait.
        const opening = App.navigateToApp(moment.appSlug, 'dev', moment.issueNumber, 'issues');
        closeFeedback();
        await opening;
        if (App.currentApp === moment.appSlug && AppView.appData?.slug === moment.appSlug
            && Number(moment.userId) === Number(App.user?.id)) {
          await AppView.createPrForIssue(moment.issueNumber);
        }
      } catch (err) {
        PlatformUI.toast(t('dialogs:feedback.fix.failedIssue'));
      }
    });
    // #1603: the inline refusal under the description. Rendered empty and
    // hidden by ./feedback.tsx; this module owns its text and its `hidden`.
    const feedbackTextError = document.getElementById('feedback-text-error');
    const feedbackTargetApp = document.getElementById('feedback-target-app');
    const feedbackTargetPlatform = document.getElementById('feedback-target-platform');
    const feedbackTargetGroup = document.getElementById('feedback-target');
    const feedbackTargetHint = document.getElementById('feedback-target-hint');

    // Currently selected feedback target: 'app', 'platform', or — #2707 —
    // null while BOTH are selectable and the person has not picked yet.
    // Set on every open; the value here only covers the window before the
    // first one, where the dialog is not on screen.
    let feedbackTarget = 'platform';
    // #2707: true while the row is offering a real choice nobody has made.
    // A submit refuses for exactly as long as this holds (#2888: the button
    // stays live and the refusal says what is missing). It is never true in
    // the one-destination case — there is nothing to disambiguate there, and
    // charging a tax of one tap for it would only train people to tap past
    // the question this change exists to ask.
    let awaitingTarget = false;
    // #685: whether the open app announced a usernode.issueState provider
    // from the mounted iframe. Computed on each modal open; the "Include
    // app state" row shows only while this holds AND the target is 'app'.
    let stateAvailable = false;
    // #6485: the app the "This app" option stands for — the one the request
    // will be filed on. Captured when the person picks it (or when a comment
    // hands its app over), not read from whatever app is mounted at submit,
    // so moving between screens never retargets a request.
    let targetApp = null; // { slug, name } | null
    const stateRow = document.getElementById('feedback-state-row');
    const stateCheckbox = document.getElementById('feedback-state-checkbox');
    // #964: the opt-in kudos-bounty row. Unlike the state row this shows for
    // BOTH targets — "This app" and "Homeroom Platform" alike file
    // into a repository the platform tracks as an app, so either can carry a
    // bounty.
    const bountyRow = document.getElementById('feedback-bounty-row');
    const bountyCheckbox = document.getElementById('feedback-bounty-checkbox');
    const bountyNote = document.getElementById('feedback-bounty-note');
    // #5048: the full admin's "Private request" box. Ticked, the request is
    // kept in Homeroom (POST /api/private-requests) and never filed on
    // GitHub, so the rows that only mean something on a GitHub issue hide.
    const privateRow = document.getElementById('feedback-private-row');
    const privateCheckbox = document.getElementById('feedback-private-checkbox');
    const privateChosen = () => !!privateCheckbox && privateCheckbox.checked
      && !privateRow.classList.contains('hidden');
    // Paint the row from the viewer's live weekly allowance and return it to
    // its unchecked default. Budget state is null only when the first-load
    // fetch failed — show the row enabled with no count rather than hiding a
    // working feature; the server is the real gate.
    //
    // #5249: while kudos is parked the row never shows, so no submit carries
    // a bounty (the submit and the outbox both read the box, which stays
    // unticked). The markup stays, hidden, for when it comes back.
    const resetBountyRow = () => {
      bountyCheckbox.checked = false;
      if (KUDOS_PARKED) {
        bountyRow.classList.add('hidden');
        return;
      }
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
      // #3230: the reset in the viewer's own clock, the UTC instant on hover.
      const RT = window.ResetTime;
      bountyNote.removeAttribute('title');
      if (remaining === null) bountyNote.textContent = t('dialogs:feedback.bounty.cost');
      else if (exhausted) {
        bountyNote.textContent = RT
          ? t('dialogs:feedback.bounty.usedAll', { count: limit, ...RT.resetMoment('weekly') })
          : t('dialogs:feedback.bounty.usedAllUtc', { count: limit });
        if (RT) bountyNote.title = RT.resetUtc('weekly');
      } else bountyNote.textContent = t('dialogs:feedback.bounty.costRemaining', { count: remaining, limit });
      bountyRow.classList.remove('hidden');
    };
    // Shown to full admins only, unticked on every open.
    const resetPrivateRow = () => {
      privateCheckbox.checked = false;
      privateRow.classList.toggle('hidden', !App.user?.canAdminWrite);
    };
    privateCheckbox.addEventListener('change', () => {
      if (privateCheckbox.checked) {
        bountyCheckbox.checked = false;
        bountyRow.classList.add('hidden');
        stateRow.classList.add('hidden');
      } else {
        resetBountyRow();
        stateRow.classList.toggle('hidden', !(stateAvailable && feedbackTarget === 'app'));
      }
      if (!submitBusy) feedbackBtn.textContent = restingSubmitLabel();
    });
    // The selected option uses a darker violet on hover so it keeps its
    // active look; the unselected option uses the neutral zinc hover.
    const activeTargetClasses = ['bg-violet-600', 'text-white', 'border-violet-600', 'hover:bg-violet-500'];
    const inactiveHoverClasses = ['hover:bg-zinc-100', 'dark:hover:bg-zinc-800'];
    const disabledTargetClasses = ['opacity-40', 'cursor-not-allowed'];
    // #2888: the refusal under the row when Post request is pressed with no
    // destination. It was also the grey prompt while the choice was open
    // (#2707, "Choose where this feedback goes."); the row's label asks the
    // question now, so this is only the refusal. One message, read in one
    // place, because the declared dapp.json check matches on its English — see
    // tests/feedback-target-choice.test.js.
    const chooseTargetHint = () => t('dialogs:feedback.target.choose');
    // `feedbackBtn.disabled` means BUSY and nothing else: submitting, saved
    // for later, or behind the first-feedback confirmation. Taken by
    // disableSubmit(), and only the path that took it hands it back, with
    // enableSubmit().
    //
    // #2888: it used to have a second owner, the TARGET GATE — Submit stayed
    // disabled while the destination row waited for a tap (#2707). A dead
    // button with the reason in small grey type under a different control
    // read as a broken button: people pressed it, nothing happened, and
    // nothing said why. Now it is always pressable, and pressing it with no
    // destination is a refusal that SAYS so, the #1603 rule the description
    // follows — the row turns red, the hint turns red and is announced, and
    // focus lands on the row. See showTargetError().
    let submitBusy = false;
    const enableSubmit = () => { submitBusy = false; feedbackBtn.disabled = false; };
    const disableSubmit = () => { submitBusy = true; feedbackBtn.disabled = true; };
    // #2888: the missed-destination state, painted on top of the waiting
    // hint. The row's buttons and the hint carry constant React classNames,
    // so these are toggled on (and off) beside them — `!` so the red wins
    // over the border / text colour the className already sets, whichever
    // order the compiled utilities land in.
    const targetErrorClasses = ['!border-red-600', 'dark:!border-red-500', 'bg-red-50', 'dark:bg-red-950/40'];
    const hintErrorClasses = ['!text-red-700', 'dark:!text-red-400', 'font-medium'];
    const paintTargetError = (on) => {
      if (on) feedbackTargetGroup?.setAttribute('aria-invalid', 'true');
      else feedbackTargetGroup?.removeAttribute('aria-invalid');
      targetErrorClasses.forEach((c) => {
        feedbackTargetApp.classList.toggle(c, on);
        feedbackTargetPlatform.classList.toggle(c, on);
      });
      hintErrorClasses.forEach((c) => feedbackTargetHint.classList.toggle(c, on));
      // Announced when it appears, like #feedback-text-error (role="alert"
      // there is static; here the same node is also the quiet prompt, which
      // must not be read out on every open).
      if (on) feedbackTargetHint.setAttribute('role', 'alert');
      else feedbackTargetHint.removeAttribute('role');
    };
    // The line under the row, and the radiogroup pointed at it while it is up,
    // the way the empty description points the textarea at
    // #feedback-text-error.
    const showTargetHint = (on) => {
      feedbackTargetHint.textContent = on ? chooseTargetHint() : '';
      feedbackTargetHint.classList.toggle('hidden', !on);
      if (on) feedbackTargetGroup?.setAttribute('aria-describedby', 'feedback-target-hint');
      else feedbackTargetGroup?.removeAttribute('aria-describedby');
    };
    const setAwaitingTarget = (waiting) => {
      awaitingTarget = waiting;
      // A fresh question is asked quietly, by the row's own label ("Where
      // should this go?"); only a submit puts a line under it.
      showTargetHint(false);
      paintTargetError(false);
    };
    // #2888: Post request was pressed with no destination. Nothing is sent;
    // the row says what is missing and takes focus, because it is the thing
    // to fix — the first control, so the reading order agrees.
    const showTargetError = () => {
      setAwaitingTarget(true);
      showTargetHint(true);
      paintTargetError(true);
      try { feedbackTargetApp.focus(); } catch { /* detached in tests */ }
    };
    // Toggle the active styling between the two buttons. `target` is never
    // null after an open any more (#5992 preselects the open app, or the
    // platform when no app can take requests); the null case stays supported
    // as a defensive state. Enabled/disabled state of the "This app" button
    // is owned by the open handler.
    const setFeedbackTarget = (target) => {
      feedbackTarget = target;
      const onApp = target === 'app';
      const onPlatform = target === 'platform';
      feedbackTargetApp.setAttribute('aria-checked', onApp ? 'true' : 'false');
      feedbackTargetPlatform.setAttribute('aria-checked', onPlatform ? 'true' : 'false');
      activeTargetClasses.forEach((c) => {
        feedbackTargetApp.classList.toggle(c, onApp);
        feedbackTargetPlatform.classList.toggle(c, onPlatform);
      });
      // The neutral hover applies to every option that is not the selected
      // one, so the selected one doesn't get its violet overridden on hover.
      // With nothing selected both options keep it.
      inactiveHoverClasses.forEach((c) => {
        feedbackTargetApp.classList.toggle(c, !onApp);
        feedbackTargetPlatform.classList.toggle(c, !onPlatform);
      });
      // #685: app state only travels with app-targeted feedback — the
      // shell has no provider of its own, so the row hides on Platform.
      stateRow.classList.toggle('hidden', !(stateAvailable && onApp) || privateChosen());
      // #2707: a tap is the answer, so it clears the gate, the hint and —
      // #2888 — the red.
      if (target && awaitingTarget) setAwaitingTarget(false);
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
    // #2707: paint the destination row for the context the dialog opened in.
    //
    // #5992: with BOTH destinations selectable, the open app is selected by
    // default, because that is where the person was when they suggested the
    // improvement. Both options stay visible and tappable, so Homeroom is
    // still one tap away, and an explicit earlier pick (a restored draft, a
    // caller's own `target`) overrides it. Submit is live on open.
    //
    // With only the platform reachable there is nothing to disambiguate, so
    // it stays selected and Submit is live on open. A tap that has exactly
    // one possible answer teaches people to tap past the question.
    // The app option's two lines (UI overhaul): its NAME first, then "This
    // app" under it, mirroring "Homeroom / The platform itself". With no name
    // the first line says "This app" and the second goes; with no app open at
    // all it says so.
    const feedbackTargetAppName = document.getElementById('feedback-target-app-name');
    const feedbackTargetAppSub = document.getElementById('feedback-target-app-sub');
    // What the option was last labelled from, so a language change can label
    // it again.
    let labelledApp = null;
    const labelAppTarget = (appData) => {
      labelledApp = appData;
      const named = !!appData?.name;
      if (feedbackTargetAppName) {
        feedbackTargetAppName.textContent = named ? appData.name : (appData ? t('dialogs:feedback.target.thisApp') : t('dialogs:feedback.target.noApp'));
      }
      feedbackTargetAppSub?.classList.toggle('hidden', !named);
    };
    const applyTargetAvailability = (canTargetApp, appData) => {
      targetApp = canTargetApp ? { slug: App.currentApp, name: appData?.name || '' } : null;
      if (canTargetApp) {
        labelAppTarget(appData);
        setAppTargetEnabled(true);
        setAwaitingTarget(false);
        setFeedbackTarget('app');
      } else {
        // With an app actually open (no repo yet, or self-hosted) keep
        // its name on the grayed label — "No app open" would be wrong
        // there. Only show "No app open" when no app is really open.
        labelAppTarget(appData);
        setAppTargetEnabled(false);
        setAwaitingTarget(false);
        setFeedbackTarget('platform');
      }
    };
    // #6485: take the app a comment (or a returned draft) brought with it as
    // this open's destination, whatever app is mounted. The slug is what the
    // request is filed on, so it is checked before it becomes one; the name
    // is only for the option's own label, and falls back to the address.
    const APP_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
    const adoptTargetApp = (slug, name) => {
      if (typeof slug !== 'string' || !APP_SLUG_RE.test(slug)) return;
      targetApp = { slug, name: name || '' };
      const shown = typeof AppView !== 'undefined' && AppView.appData && AppView.appData.slug === slug
        ? AppView.appData.name
        : '';
      labelAppTarget({ name: name || shown || slug });
      setAppTargetEnabled(true);
      setAwaitingTarget(false);
      // #685: the state to collect is the mounted app's own, so it can only
      // travel with a request filed on that app.
      if (slug !== App.currentApp) {
        stateAvailable = false;
        stateRow.classList.add('hidden');
      }
      setFeedbackTarget('app');
    };
    // #2707: a destination that comes back with a returned draft is the
    // person's OWN earlier pick, not a default — handing it back is not an
    // accidental preselection, and re-asking for a decision they already
    // made would quietly lose it. It still wins over the open app's default
    // (#5992). 'platform' is restored as well as 'app': dropping it would
    // leave a rescued draft pointing somewhere other than the person chose.
    // #6485: with a slug, the app itself comes back, not the one open now.
    const restoreChosenTarget = (target, slug, name) => {
      if (target === 'app' && slug) adoptTargetApp(slug, name);
      else if (target === 'app' && !feedbackTargetApp.disabled) setFeedbackTarget('app');
      else if (target === 'platform') setFeedbackTarget('platform');
    };

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
    // #4194: the description may run to 64,000 characters now; the title is
    // named from its start, and the preview route refuses more than this
    // (TITLE_SOURCE_MAX in lib/issue-body-limit.ts and routes/feedback.js,
    // kept equal by tests/issue-body-limit.test.js). A literal, not an
    // import: the controller's tests run it with its imports stripped.
    const TITLE_GEN_SOURCE_MAX = 2000;
    const titleIdlePlaceholder = () => t('dialogs:feedback.title.placeholder');
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
      feedbackTitle.placeholder = titleIdlePlaceholder();
    };

    const generateTitlePreview = async () => {
      const desc = feedbackText.value.trim();
      if (desc.length < TITLE_GEN_MIN_DESC) return;
      if (titleDirty) return;
      if (desc === lastGeneratedFor) return;
      if (titleGenCount >= TITLE_GEN_MAX_PER_OPEN) return;
      titleGenCount++;
      const seq = ++titleGenSeq;
      feedbackTitle.placeholder = t('dialogs:feedback.title.generating');
      try {
        const res = await fetch('/api/feedback/title', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ description: desc.slice(0, TITLE_GEN_SOURCE_MAX) }),
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
        if (seq === titleGenSeq) feedbackTitle.placeholder = titleIdlePlaceholder();
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
    // exactly the same. #3027: up to MAX_SCREENSHOTS images per issue ("one
    // before saving and one after saving"), each its own thumbnail with its
    // own remove button, its own upload and its own id. The server enforces
    // the same limit on the ids it is sent (MAX_SCREENSHOTS_PER_ISSUE in
    // src/routes/feedback.js); this one is what keeps the dialog from ever
    // offering a slot the server would refuse.
    const MAX_SCREENSHOTS = 3;
    const screenshotBtn = document.getElementById('feedback-screenshot-btn');
    const screenshotLabel = screenshotBtn.querySelector('[data-screenshot-label]');
    const screenshotPickerBtn = document.getElementById('feedback-screenshot-picker-btn');
    const screenshotInput = document.getElementById('feedback-screenshot-input');
    // The thumbnail list. feedback.tsx renders it empty; the items inside are
    // this module's, like every other node inside the card.
    const screenshotPreview = document.getElementById('feedback-screenshot-preview');
    const screenshotCount = document.getElementById('feedback-screenshot-count');
    // #4127: Photos and the video picker are the two rows of a popover under
    // one paperclip button (feedback.tsx), so the row stays on one line. The
    // rows keep their own handlers below; this block only opens and closes
    // the popover and keeps the paperclip in step with the rows: shown while
    // either row is, inert while both are.
    const attachBtn = document.getElementById('feedback-attach-btn');
    const attachMenu = document.getElementById('feedback-attach-menu');
    const attachRows = [screenshotPickerBtn, document.getElementById('feedback-video-btn')];
    const attachMenuOpen = () => !!attachMenu && !attachMenu.classList.contains('hidden');
    const setAttachMenuOpen = (open) => {
      if (!attachMenu || !attachBtn) return;
      attachMenu.classList.toggle('hidden', !open);
      attachBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    const paintAttachButton = () => {
      if (!attachBtn) return;
      const shown = attachRows.filter((row) => row && !row.classList.contains('hidden'));
      attachBtn.classList.toggle('hidden', shown.length === 0);
      attachBtn.disabled = shown.length === 0 || shown.every((row) => row.disabled);
      if (attachBtn.disabled || attachBtn.classList.contains('hidden')) setAttachMenuOpen(false);
    };
    if (attachBtn && attachMenu) {
      attachBtn.addEventListener('click', (e) => {
        if (e && e.stopPropagation) e.stopPropagation();
        if (attachBtn.disabled) return;
        setAttachMenuOpen(!attachMenuOpen());
        if (attachMenuOpen()) {
          const first = attachRows.find((row) => row && !row.classList.contains('hidden') && !row.disabled);
          if (first) first.focus({ preventScroll: true });
        }
      });
      // Any click outside the paperclip and its popover closes it. Capture
      // phase, so a click something else stops still counts. (Escape is the
      // kit modal's: it closes the dialog, and _reset closes this with it.)
      document.addEventListener('click', (e) => {
        if (!attachMenuOpen()) return;
        const t = e && e.target;
        if (t && (attachBtn.contains(t) || attachMenu.contains(t))) return;
        setAttachMenuOpen(false);
      }, true);
    }
    const screenshotTools = window.ScreenshotSelect;
    const displayCaptureSupported = !!screenshotTools && screenshotTools.isSupported();
    let nativeCaptureSupported = false;
    let screenshotProbeSequence = 0;
    // One entry per attached image, in the order attached:
    //   { blob, objectUrl, id, uploading, node, img, stateEl, removeBtn }
    // `id` is the server row id, set once uploaded; `uploading` blocks submit
    // while in flight. #1054: `blob` is the captured bytes, kept for as long
    // as the thumbnail is shown. The upload mints the id, but the id only
    // exists on the server — so an offline submit has to carry the blob
    // itself into the outbox and upload it at flush time.
    let screenshots = [];
    const screenshotIds = () => screenshots.filter((shot) => shot.id).map((shot) => shot.id);
    const screenshotUploading = () => screenshots.some((shot) => shot.uploading);
    // #1284: true for the whole round trip of a native capture — from the
    // moment the dialog is suspended until the attempt has resolved one way
    // or the other. `suspendDialog()` closes the kit presentation, and the
    // kit calls back when its exit animation ends (~300 ms); a capture that
    // fails faster than that has already resumed by then, so the late
    // dismissal is stale. useStaticModal's generation guard drops it — this
    // flag is the second belt: if a dismissal DOES reach `_reset` mid-capture,
    // the draft the screenshot was being attached to survives it.
    //
    // Set when the dialog is actually suspended (`hideDialog`), not when the
    // attempt starts. A display capture keeps the dialog up until the browser
    // grants the share, so a close before then is the viewer's own and must
    // close for real; and a grant that never comes (Firefox can take a pick
    // in the system picker and never answer) used to leave this true for the
    // life of the page, so no later close ever cleared the dialog again.
    let captureInFlight = false;
    // The display capture the browser has not answered yet, as the
    // AbortController that gives it up. Choosing an image, closing the
    // dialog, or anything else that resets the screenshot row aborts it, so
    // a share that never comes is never something the viewer has to wait
    // out. ScreenshotSelect.start() stops a stream that arrives afterwards.
    let pendingCapture = null;
    const abandonPendingCapture = () => {
      if (!pendingCapture) return;
      const attempt = pendingCapture;
      pendingCapture = null;
      attempt.abort();
    };

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
          // #6485: the app the person picked, so it comes back with the words.
          ...(feedbackTarget === 'app' && targetApp
            ? { appSlug: targetApp.slug, appName: targetApp.name } : {}),
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

    // #2796: the draft itself — the title and description someone has typed
    // but not sent. Closing the dialog is not throwing the words away: the
    // backdrop, Cancel, the back gesture and a reload all keep them, and only
    // a send (or a save to the outbox, which owns them from then on) clears
    // them. localStorage, so a reload keeps them too, and keyed by the viewer
    // so a shared device never hands one person's words to another.
    //
    // One draft per viewer, NOT per app: the dialog files against the app or
    // the platform, and nothing is chosen until the person picks (#2707), so
    // a half-written platform report started from one app's screen is still
    // the same report on another's. The destination is deliberately not part
    // of the draft for the same reason.
    const SAVED_DRAFT_KEY_PREFIX = 'usernode.feedbackDraft.';
    const savedDraftKey = () => {
      const userId = App?.user?.id;
      return userId == null ? null : `${SAVED_DRAFT_KEY_PREFIX}${userId}`;
    };
    const clearSavedDraft = () => {
      const key = savedDraftKey();
      if (!key) return;
      try { window.localStorage.removeItem(key); } catch { /* ignore */ }
    };
    const saveDraft = () => {
      // A synthetic ?shot= state is not somebody's draft (see onShotRoute),
      // and a locked composer is showing words that have already been sent.
      if (onShotRoute() || feedbackText.readOnly) return;
      const key = savedDraftKey();
      if (!key) return;
      const description = feedbackText.value;
      const title = feedbackTitle.value;
      if (!description.trim() && !title.trim()) { clearSavedDraft(); return; }
      try {
        window.localStorage.setItem(key, JSON.stringify({
          description,
          title,
          titleDirty,
          // An auto-filled title is only valid for the text it was made
          // from (#732) — carried so a restored one is not dropped at submit.
          titleFor: lastGeneratedFor,
          savedAt: Date.now(),
        }));
      } catch { /* private mode or quota — the words are still on screen */ }
    };
    const readSavedDraft = () => {
      if (onShotRoute()) return null;
      const key = savedDraftKey();
      if (!key) return null;
      try {
        const draft = JSON.parse(window.localStorage.getItem(key) || 'null');
        if (!draft || typeof draft.description !== 'string') return null;
        return draft;
      } catch { return null; }
    };
    // Only the draft that was actually sent: words typed into a reopened
    // dialog while the old request was in flight are a new draft.
    const forgetSentDraft = (sentDescription) => {
      const draft = readSavedDraft();
      if (draft && draft.description.trim() === sentDescription) clearSavedDraft();
    };
    feedbackText.addEventListener('input', saveDraft);
    feedbackTitle.addEventListener('input', saveDraft);

    // Whole sentences said one after another on one line. What joins two of
    // them is a message too, so a language can space them its own way.
    const joinSentences = (parts) => parts.filter(Boolean)
      .reduce((first, second) => (first ? t('dialogs:feedback.notice.pair', { first, second }) : second), '');

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
      feedbackTextError.textContent = t('dialogs:feedback.description.required');
      feedbackTextError.classList.remove('hidden');
      feedbackText.setAttribute('aria-invalid', 'true');
      feedbackText.setAttribute('aria-describedby', 'feedback-text-error');
      // The field is the thing to fix, so put the caret in it.
      try { feedbackText.focus({ preventScroll: true }); } catch { /* detached in tests */ }
    };

    const clearDescriptionError = () => {
      if (!feedbackTextError) return;
      feedbackTextError.classList.add('hidden');
      feedbackTextError.textContent = '';
      feedbackText.removeAttribute('aria-invalid');
      feedbackText.removeAttribute('aria-describedby');
    };

    // #6127: the pictures can be dragged into the order the request should
    // show them in, and the first one is the one the request shows first.
    // The line that says so lives inside the thumbnail row (basis-full wraps
    // it under them), is created here rather than in feedback.tsx so no new
    // prerendered shell id is needed, and carries no [data-feedback-screenshot]
    // so the reorder kit ignores it.
    const screenshotOrderHint = document.createElement('p');
    screenshotOrderHint.id = 'feedback-screenshot-order-hint';
    screenshotOrderHint.className = 'basis-full text-xs text-zinc-500 dark:text-zinc-400';
    screenshotOrderHint.textContent = t('dialogs:feedback.screenshot.reorderHint');
    screenshotOrderHint.classList.add('hidden');

    const paintScreenshotActions = () => {
      const count = screenshots.length;
      const full = count >= MAX_SCREENSHOTS;
      const canCapture = nativeCaptureSupported || displayCaptureSupported;
      screenshotLabel.textContent = nativeCaptureSupported
        ? (count ? t('dialogs:feedback.screenshot.takeAnother') : t('dialogs:feedback.screenshot.take'))
        : (count ? t('dialogs:feedback.screenshot.attachAnother') : t('dialogs:feedback.screenshot.attach'));
      screenshotBtn.classList.toggle('hidden', full || !canCapture);
      screenshotPickerBtn.classList.toggle('hidden', full);
      paintAttachButton();
      // #3027: say how many fit, so the second picture is not a guess.
      if (screenshotCount) {
        screenshotCount.textContent = count === 0
          ? t('dialogs:feedback.screenshot.limit', { count: MAX_SCREENSHOTS })
          : full
            ? t('dialogs:feedback.screenshot.attachedFull', { attached: count, count: MAX_SCREENSHOTS })
            : t('dialogs:feedback.screenshot.attached', { attached: count, count: MAX_SCREENSHOTS });
        screenshotCount.classList.remove('hidden');
      }
      screenshotPreview.classList.toggle('hidden', count === 0);
      screenshotPreview.classList.toggle('flex', count > 0);
      // #6127: the hint appears once there is something to reorder, and once
      // it is in the row it stays its last child, so it wraps under the
      // pictures rather than sitting between them.
      const canReorder = count >= 2;
      screenshotOrderHint.classList.toggle('hidden', !canReorder);
      if (canReorder || screenshotOrderHint.parentNode === screenshotPreview) {
        screenshotPreview.appendChild(screenshotOrderHint);
      }
      // Numbered from what is on screen now, so removing the middle image
      // renumbers the rest rather than leaving a gap in the labels.
      screenshots.forEach((shot, i) => {
        shot.img.alt = t('dialogs:feedback.screenshot.previewAlt', { number: i + 1 });
        shot.removeBtn.setAttribute('aria-label', t('dialogs:feedback.screenshot.remove', { number: i + 1 }));
        shot.openBtn.setAttribute('aria-label', t('dialogs:feedback.screenshot.view', { number: i + 1 }));
        if (canReorder) shot.openBtn.setAttribute('aria-describedby', 'feedback-screenshot-order-hint');
        else shot.openBtn.removeAttribute('aria-describedby');
      });
    };

    const setScreenshotActionsDisabled = (disabled) => {
      screenshotBtn.disabled = disabled;
      screenshotPickerBtn.disabled = disabled;
      paintAttachButton();
    };

    // Forget one attachment client-side. An already uploaded (now orphaned)
    // row is GC'd by the server's 24h sweeper, as before.
    const discardScreenshot = (shot) => {
      if (shot.objectUrl) { URL.revokeObjectURL(shot.objectUrl); shot.objectUrl = null; }
      if (shot.node) shot.node.remove();
      shot.uploading = false;
      screenshots = screenshots.filter((s) => s !== shot);
    };

    const removeScreenshot = (shot) => {
      discardScreenshot(shot);
      paintScreenshotActions();
    };

    // #6127: put the picture at `from` at `to`, thumbnail and all. The kit's
    // onReorder arrives AFTER it has moved the node, so the node is only
    // moved here when the DOM order does not already match — the keyboard
    // path. The shot object travels whole, so an upload still in flight
    // (which finds its shot by identity) lands at its new position.
    const thumbnailNodes = () => {
      const nodes = [];
      const children = screenshotPreview.children;
      for (let i = 0; i < children.length; i += 1) {
        const child = children[i];
        if (child.getAttribute && child.getAttribute('data-feedback-screenshot') !== null) nodes.push(child);
      }
      return nodes;
    };
    const moveScreenshot = (from, to) => {
      const count = screenshots.length;
      if (from === to || from < 0 || to < 0 || from >= count || to >= count) return false;
      const shot = screenshots[from];
      screenshots.splice(from, 1);
      screenshots.splice(to, 0, shot);
      const dom = thumbnailNodes();
      const inOrder = dom.length === screenshots.length
        && screenshots.every((entry, i) => dom[i] === entry.node);
      if (!inOrder && shot.node) {
        const next = screenshots[to + 1];
        if (next && next.node) screenshotPreview.insertBefore(shot.node, next.node);
        else if (screenshotOrderHint.parentNode === screenshotPreview) {
          screenshotPreview.insertBefore(shot.node, screenshotOrderHint);
        } else screenshotPreview.appendChild(shot.node);
      }
      paintScreenshotActions();
      return true;
    };

    const resetScreenshotState = () => {
      abandonPendingCapture();
      for (const shot of screenshots.slice()) discardScreenshot(shot);
      screenshots = [];
      screenshotInput.value = '';
      setScreenshotActionsDisabled(false);
      paintScreenshotActions();
    };

    // One thumbnail: the preview, a status line for this image alone, and a
    // 48px remove button. Class strings are complete literals, so Tailwind's
    // scan of this file compiles them.
    const renderScreenshotThumb = (shot) => {
      const item = document.createElement('div');
      item.className = 'flex items-center gap-2';
      item.setAttribute('data-feedback-screenshot', '');
      const img = document.createElement('img');
      img.className = 'h-14 max-w-[8rem] rounded-md border border-zinc-300 dark:border-zinc-700 object-cover';
      img.src = shot.objectUrl;
      // #5687: the thumbnail opens its picture full size, over the form, so
      // what was attached can be checked before the request is posted. The
      // ✕ beside it stays its own target.
      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'shrink-0 rounded-md';
      openBtn.setAttribute('data-feedback-screenshot-open', '');
      openBtn.addEventListener('click', () => {
        Feedback._preview({ kind: 'image', src: shot.objectUrl, alt: shot.img.alt, pins: shot.pins || null });
      });
      // #6127: with a keyboard, a focused picture moves with the arrow keys.
      // Up moves it earlier and down later; left and right move it that way
      // on screen, which in Arabic, where the row starts on the right, is the
      // other way through the list. At either end it stays put (so the page
      // keeps its own scrolling there).
      openBtn.addEventListener('keydown', (e) => {
        const from = screenshots.indexOf(shot);
        const step = arrowStep(e && e.key);
        const to = step ? from + step : -1;
        if (from < 0 || to < 0 || to >= screenshots.length) return;
        if (e.preventDefault) e.preventDefault();
        if (moveScreenshot(from, to)) {
          try { openBtn.focus({ preventScroll: true }); } catch { /* detached in tests */ }
        }
      });
      const stateEl = document.createElement('span');
      stateEl.className = 'text-xs text-zinc-500 dark:text-zinc-400';
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'rounded-full w-12 h-12 flex shrink-0 items-center justify-center text-xs bg-zinc-200 dark:bg-zinc-700 hover:bg-zinc-300 dark:hover:bg-zinc-600 transition-colors';
      removeBtn.textContent = '✕';
      removeBtn.addEventListener('click', () => removeScreenshot(shot));
      // #4482: comments handed over from comment mode keep their pins beside
      // their picture, as data; the thumbnail shows them over the picture.
      if (shot.pins && shot.pins.length) {
        const frame = document.createElement('span');
        frame.className = 'relative inline-block shrink-0';
        frame.appendChild(img);
        for (const pin of shot.pins) {
          const dot = document.createElement('span');
          dot.className = 'absolute h-2.5 w-2.5 -translate-y-full rounded-[50%_50%_50%_0] bg-violet-600 shadow-[0_0_0_1.5px_#fff]';
          dot.style.left = `${pin.x * 100}%`;
          dot.style.top = `${pin.y * 100}%`;
          dot.setAttribute('aria-hidden', 'true');
          frame.appendChild(dot);
        }
        openBtn.appendChild(frame);
      } else {
        openBtn.appendChild(img);
      }
      item.appendChild(openBtn);
      item.appendChild(stateEl);
      item.appendChild(removeBtn);
      screenshotPreview.appendChild(item);
      Object.assign(shot, { node: item, img, stateEl, removeBtn, openBtn });
    };

    // #6127: dragging a picture reorders the row. No handle: on touch the
    // kit lifts on a long press (its default 400 ms), on a computer once the
    // pointer passes the slop, and it suppresses the click after a drag, so
    // a tap still opens the picture and the ✕ still removes it. onReorder
    // arrives after the kit has moved the node; moveScreenshot splices the
    // array (and repaints the labels) to match.
    if (window.unNative && typeof window.unNative.attachReorder === 'function') {
      window.unNative.attachReorder(screenshotPreview, {
        grid: true,
        itemSelector: '[data-feedback-screenshot]',
        onReorder: (from, to) => { moveScreenshot(from, to); },
      });
    }

    const uploadScreenshot = (blob) => fetch('/api/feedback/screenshot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: blob,
    });

    const attachScreenshotBlob = async (blob, pins = null) => {
      // Never a fourth: every caller checks the room first, and this is the
      // backstop behind them.
      if (screenshots.length >= MAX_SCREENSHOTS) return;
      // Thumbnail immediately; upload in the background with Submit blocked
      // (screenshotUploading) until the id lands. `pins` (#4482) are comment
      // mode's, each { x, y, n, note }, sent beside the picture at submit.
      const shot = { blob, objectUrl: URL.createObjectURL(blob), id: null, uploading: true, pins };
      screenshots.push(shot);
      renderScreenshotThumb(shot);
      paintScreenshotActions();
      shot.stateEl.textContent = t('dialogs:feedback.screenshot.uploading');
      try {
        const res = await uploadScreenshot(blob);
        const data = res.ok ? await res.json() : await res.json().catch(() => ({}));
        // Removed (or the dialog closed) while it was in flight: the answer
        // belongs to nothing on screen any more.
        if (!screenshots.includes(shot)) return;
        if (res.ok && data.id) {
          shot.id = data.id;
          shot.stateEl.textContent = '';
        } else {
          removeScreenshot(shot);
          showFeedbackNotice(data.error || t('dialogs:feedback.screenshot.uploadFailed'), true);
        }
      } catch {
        if (!screenshots.includes(shot)) return;
        // #1054: keep the bytes when the network fails. The outbox uploads
        // them at flush time, and an online submit retries first.
        shot.stateEl.textContent = t('dialogs:feedback.screenshot.savedOffline');
        showFeedbackNotice(t('dialogs:feedback.screenshot.uploadLater'), false);
      } finally {
        shot.uploading = false;
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
    //
    // How long a display capture waits for the browser before the dialog
    // says what to do if the answer is not coming (see pendingCapture). Long
    // enough for an unhurried pick in the browser's own prompt.
    const CAPTURE_WAIT_HINT_MS = 10 * 1000;
    const runCapture = async (capture, { nativeAttempt }) => {
      // Only the capture button for now. A display capture keeps the dialog
      // up until the browser answers, and Photos stays usable meanwhile: it
      // is the way out of a share that never comes. hideDialog disables the
      // rest of the row once the dialog actually goes.
      screenshotBtn.disabled = true;
      let suspended = false;
      const attempt = nativeAttempt ? null : new AbortController();
      let waitHintTimer = null;
      let waitHintText = null;
      if (attempt) {
        pendingCapture = attempt;
        waitHintTimer = setTimeout(() => {
          if (pendingCapture !== attempt) return;
          showFeedbackNotice(t('dialogs:feedback.capture.waiting'), false);
          waitHintText = feedbackStatus.textContent;
        }, CAPTURE_WAIT_HINT_MS);
      }
      // The browser has answered, or the attempt is over: the hint has
      // nothing left to say, and goes if it is still the line on show.
      const settleWait = () => {
        clearTimeout(waitHintTimer);
        if (attempt && pendingCapture === attempt) pendingCapture = null;
        if (waitHintText && feedbackStatus.textContent === waitHintText) feedbackStatus.classList.add('hidden');
        waitHintText = null;
      };
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
          feedbackText.focus({ preventScroll: true });
          feedbackText.setSelectionRange(caretStart, caretEnd);
        } catch { /* a browser that refuses the range still has the text */ }
        if (framesLeft > 0) requestAnimationFrame(() => restoreCaret(framesLeft - 1));
      };
      let modalHidden = false;
      // Returns the suspension's exit promise, which only the native attempt
      // waits on — see captureBehindHiddenDialog.
      const hideDialog = () => {
        if (modalHidden) return undefined;
        settleWait();
        setScreenshotActionsDisabled(true);
        captureInFlight = true;
        suspended = true;
        // Armed before the dialog goes away, because from here on the page
        // itself might not come back.
        stashCaptureDraft();
        const exited = suspendDialog();
        modalHidden = true;
        return exited;
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
          blob = await captureBehindHiddenDialog(hideDialog, capture, waitForHiddenDialogPaint);
        } else {
          // Not waited on here: the share has only just been granted, and
          // the frame comes from the selection overlay the viewer still has
          // to drag and confirm — long after the exit has finished.
          blob = await capture(hideDialog, attempt.signal);
        }
        restoreDialog();
        await attachScreenshotBlob(blob);
      } catch (err) {
        restoreDialog();
        // Every one of these says what happened to the SCREENSHOT and then
        // says the words are still there, because the words are what a user
        // is afraid of losing — the screenshot they can retake (#1284).
        if (err && err.code === 'abandoned') {
          // Given up before the browser answered (an image chosen instead,
          // the dialog closed): the viewer has moved on, so nothing is said.
        } else if (err && err.code === 'denied') {
          showFeedbackNotice(t('dialogs:feedback.capture.declined'), false);
        } else if (err && err.code === 'capture_blank') {
          // The share arrived with nothing in it — on a Mac, what window
          // capture hands over when the browser's screen-recording
          // permission is off or has lapsed. Retrying the same way can't help.
          showFeedbackNotice(t('dialogs:feedback.capture.blank'), true);
        } else if (err && err.code === 'wrong_surface') {
          // Something far smaller than this page was shared: on a Mac,
          // usually the browser's own "sharing" indicator, which the system
          // picker lists among the windows.
          showFeedbackNotice(t('dialogs:feedback.capture.smallWindow'), true);
        } else if (err && err.code === 'register_failed') {
          showFeedbackNotice(t('dialogs:feedback.capture.notFound'), true);
        } else if (err && err.code === 'too-large') {
          showFeedbackNotice(t('dialogs:feedback.capture.tooLarge'), true);
        } else if (nativeAttempt) {
          showFeedbackNotice(t('dialogs:feedback.capture.failedPickPhoto'), true);
        } else if (err && err.code !== 'cancelled') {
          showFeedbackNotice(t('dialogs:feedback.capture.failed'), true);
        }
      } finally {
        settleWait();
        // The round trip is over: the page survived it, so the stash has
        // nothing left to rescue and a later close is a real close. Only an
        // attempt that suspended the dialog armed either; one given up
        // before the browser answered leaves alone the stash Photos has just
        // armed for its own trip.
        if (suspended) {
          captureInFlight = false;
          clearCaptureDraft();
        }
        // Full, the buttons are hidden anyway; otherwise there is room for
        // another, so they come back.
        setScreenshotActionsDisabled(false);
        paintScreenshotActions();
      }
    };

    screenshotBtn.addEventListener('click', () => {
      if (screenshotBtn.disabled || screenshots.length >= MAX_SCREENSHOTS) return;
      const nativeAttempt = nativeCaptureSupported;
      void runCapture(nativeAttempt
        ? async () => screenshotTools.blobFromNativeCapture(await window.usernode.captureScreenshot())
        // getDisplayMedia is called synchronously inside start() so the
        // click's transient activation is preserved; hide only after grant.
        // `signal` gives the attempt up while the browser has not answered.
        : async (hide, signal) => (await screenshotTools.start({ onCaptureStart: hide, signal })).blob,
      { nativeAttempt });
    });

    screenshotPickerBtn.addEventListener('click', () => {
      // #4127: a choice closes the paperclip's popover.
      setAttachMenuOpen(false);
      if (screenshotPickerBtn.disabled || screenshots.length >= MAX_SCREENSHOTS) return;
      // An image instead of the share the browser has not answered: that
      // attempt is over (see pendingCapture).
      abandonPendingCapture();
      // #1284: the camera roll is a full-screen native surface and this tab
      // can be evicted behind it. Nothing suspends the dialog here, so there
      // is no dismissal to race — only the page's own death to insure
      // against. Cleared again by the change handler below.
      stashCaptureDraft();
      screenshotInput.click();
    });

    screenshotInput.addEventListener('change', () => {
      const files = Array.from((screenshotInput.files) || []);
      screenshotInput.value = '';
      // A cancelled pick came back with the page intact — nothing to rescue.
      if (!files.length) { clearCaptureDraft(); return; }
      void attachScreenshotFiles(files);
    });

    // #3027: the picker takes several files at once. Only as many as there
    // is room for are attached, in the order picked, and the rest are
    // named rather than silently dropped. #4065: images dropped on the form
    // come through here too.
    async function attachScreenshotFiles(files) {
      const room = Math.max(0, MAX_SCREENSHOTS - screenshots.length);
      const taken = files.slice(0, room);
      // Bumped by every open and every real close: a dialog closed while the
      // rest of a multi-pick was still being attached must not have them
      // attached (and uploaded) behind it.
      const session = screenshotProbeSequence;
      setScreenshotActionsDisabled(true);
      try {
        // One at a time: each is its own upload under the server's per-user
        // limiter, and a bad file only costs itself.
        for (const file of taken) {
          if (session !== screenshotProbeSequence) return;
          try {
            const blob = await screenshotTools.prepareFile(file);
            if (session !== screenshotProbeSequence) return;
            await attachScreenshotBlob(blob);
          } catch (err) {
            if (err && err.code === 'invalid-type') {
              showFeedbackNotice(t('dialogs:feedback.image.wrongType'), true);
            } else if (err && err.code === 'too-large') {
              showFeedbackNotice(t('dialogs:feedback.image.tooLarge'), true);
            } else {
              showFeedbackNotice(t('dialogs:feedback.image.failed'), true);
            }
          }
        }
        if (files.length > taken.length) {
          showFeedbackNotice(t('dialogs:feedback.image.onlyFirst', { count: taken.length, max: MAX_SCREENSHOTS }), true);
        }
      } finally {
        clearCaptureDraft();
        setScreenshotActionsDisabled(false);
        paintScreenshotActions();
      }
    }

    // ── #3940: video attachment ────────────────────────────────────
    // One clip per issue, chosen alongside the images above. MP4/WebM/MOV
    // only, up to 50 MB, and as long as fits in that: a narrated walkthrough
    // of a change runs a few minutes, and the size is what storage and the
    // upload actually pay for. The clip uploads on its own with a
    // progress bar — fetch gives no upload progress, so this one is an
    // XMLHttpRequest. The server re-checks size and magic bytes on every
    // upload and caps the issue at one clip (src/routes/feedback.js).
    const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
    const videoBtn = document.getElementById('feedback-video-btn');
    const videoLabel = videoBtn.querySelector('[data-video-label]');
    const videoInput = document.getElementById('feedback-video-input');
    // The thumbnail row. feedback.tsx renders it empty; the item inside is
    // this module's, like every other node inside the card.
    const videoPreview = document.getElementById('feedback-video-preview');
    // The one clip, or null:
    //   { blob, objectUrl, id, uploading, xhr, node, video, stateEl, progressEl, bar, removeBtn }
    // `id` is the server row id, set once uploaded; `uploading` blocks
    // submit while in flight. #1054: `blob` is the clip's bytes, kept so
    // an online submit can retry a failed upload.
    let video = null;
    const videoUploading = () => !!(video && video.uploading);

    const paintVideoActions = () => {
      videoBtn.classList.remove('hidden');
      // #4127: a row in the paperclip's popover, beside "Photo".
      videoLabel.textContent = video ? t('dialogs:feedback.video.replace') : t('dialogs:feedback.video.add');
      paintAttachButton();
      videoPreview.classList.toggle('hidden', !video);
      videoPreview.classList.toggle('flex', !!video);
    };

    const setVideoActionsDisabled = (disabled) => {
      videoBtn.disabled = disabled;
      paintAttachButton();
    };

    const discardVideo = (entry) => {
      if (!entry) return;
      if (entry.xhr) { try { entry.xhr.abort(); } catch { /* already done */ } entry.xhr = null; }
      if (entry.objectUrl) { URL.revokeObjectURL(entry.objectUrl); entry.objectUrl = null; }
      if (entry.node) entry.node.remove();
      entry.uploading = false;
      if (video === entry) video = null;
    };

    const resetVideoState = () => {
      if (video) discardVideo(video);
      videoInput.value = '';
      setVideoActionsDisabled(false);
      paintVideoActions();
    };

    // One thumbnail row: the first-frame preview, a progress bar for this
    // clip alone, its status line, and a 48px remove button. Class strings
    // are complete literals, so Tailwind's scan of this file compiles them.
    const buildVideoThumb = (entry) => {
      const item = document.createElement('div');
      item.className = 'flex items-center gap-2';
      item.setAttribute('data-feedback-video', '');
      const v = document.createElement('video');
      v.className = 'h-14 max-w-[8rem] rounded-md border border-zinc-300 dark:border-zinc-700 object-cover';
      // #t=0.1: a plain src paints the element black until play; seeking a
      // tenth of a second in is the standard trick that shows frame one.
      v.src = `${entry.objectUrl}#t=0.1`;
      v.muted = true;
      v.preload = 'metadata';
      v.playsInline = true;
      // #5687: the first frame is a button too, opening the clip full size
      // with the device's own video controls (it does not start on its own).
      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'shrink-0 rounded-md';
      openBtn.setAttribute('data-feedback-video-open', '');
      openBtn.setAttribute('aria-label', t('dialogs:feedback.video.view'));
      openBtn.addEventListener('click', () => {
        Feedback._preview({ kind: 'video', src: entry.objectUrl });
      });
      openBtn.appendChild(v);
      const progressEl = document.createElement('span');
      progressEl.className = 'hidden h-1 w-16 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700';
      const bar = document.createElement('span');
      bar.className = 'block h-full w-0 bg-violet-500 transition-[width]';
      progressEl.appendChild(bar);
      const stateEl = document.createElement('span');
      stateEl.className = 'text-xs text-zinc-500 dark:text-zinc-400';
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'rounded-full w-12 h-12 flex shrink-0 items-center justify-center text-xs bg-zinc-200 dark:bg-zinc-700 hover:bg-zinc-300 dark:hover:bg-zinc-600 transition-colors';
      removeBtn.textContent = '✕';
      removeBtn.setAttribute('aria-label', t('dialogs:feedback.video.remove'));
      removeBtn.addEventListener('click', () => removeVideo(entry));
      item.appendChild(openBtn);
      item.appendChild(progressEl);
      item.appendChild(stateEl);
      item.appendChild(removeBtn);
      Object.assign(entry, { node: item, video: v, stateEl, progressEl, bar, removeBtn, openBtn });
    };

    const showVideo = (entry) => {
      videoPreview.replaceChildren(entry.node);
      videoPreview.classList.remove('hidden');
      videoPreview.classList.add('flex');
    };

    const setVideoBar = (entry, fraction) => {
      entry.bar.style.width = `${Math.min(100, Math.max(0, Math.round(fraction * 100)))}%`;
    };

    const uploadVideo = (entry, onProgress) => new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      entry.xhr = xhr;
      xhr.open('POST', '/api/feedback/video');
      xhr.responseType = 'json';
      if (xhr.upload && onProgress) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress(e.loaded / e.total);
        };
      }
      xhr.onload = () => resolve({
        ok: xhr.status >= 200 && xhr.status < 300,
        data: xhr.response || {},
      });
      xhr.onerror = () => reject(new Error('network'));
      xhr.onabort = () => reject(new Error('aborted'));
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.send(entry.blob);
    });

    // Loading the clip's metadata proves the browser can decode it at all,
    // which is what the thumbnail's preview needs. A Blob-backed WebM
    // without a duration header reports Infinity until seeked past the
    // end — ask once, then read it back.
    const videoDurationSeconds = (objectUrl) => new Promise((resolve) => {
      const probe = document.createElement('video');
      probe.preload = 'metadata';
      probe.muted = true;
      const done = (seconds) => {
        probe.removeAttribute('src');
        resolve(Number.isFinite(seconds) && seconds > 0 ? seconds : null);
      };
      probe.onloadedmetadata = () => {
        if (probe.duration === Infinity) {
          probe.ontimeupdate = () => {
            probe.ontimeupdate = null;
            done(probe.duration);
          };
          try { probe.currentTime = 1e101; } catch { done(null); }
          return;
        }
        done(probe.duration);
      };
      probe.onerror = () => done(null);
      probe.src = objectUrl;
    });

    const attachVideoBlob = async (blob) => {
      // Validate before touching what's attached: a failed replacement
      // keeps the clip already there rather than leaving the form with
      // none.
      if (blob.size > MAX_VIDEO_BYTES) {
        showFeedbackNotice(t('dialogs:feedback.video.tooLarge'), true);
        return;
      }
      const previous = video;
      const entry = { blob, objectUrl: URL.createObjectURL(blob), id: null, uploading: true, xhr: null, node: null };
      buildVideoThumb(entry);
      video = entry;
      showVideo(entry);
      paintVideoActions();
      entry.stateEl.textContent = t('dialogs:feedback.video.checking');
      const abandon = (keepPrevious, message) => {
        entry.uploading = false;
        if (entry.objectUrl) { URL.revokeObjectURL(entry.objectUrl); entry.objectUrl = null; }
        if (entry.node) entry.node.remove();
        video = keepPrevious ? previous : null;
        if (video) showVideo(video);
        paintVideoActions();
        if (message) showFeedbackNotice(message, true);
      };
      const seconds = await videoDurationSeconds(entry.objectUrl);
      if (video !== entry) return;
      if (seconds === null) {
        abandon(true, t('dialogs:feedback.video.unreadable'));
        return;
      }
      entry.stateEl.textContent = t('dialogs:feedback.video.uploading');
      entry.progressEl.classList.remove('hidden');
      setVideoBar(entry, 0);
      try {
        const result = await uploadVideo(entry, (f) => setVideoBar(entry, f));
        if (video !== entry) return;
        if (result.ok && result.data && result.data.id) {
          entry.id = result.data.id;
          entry.uploading = false;
          entry.stateEl.textContent = '';
          entry.progressEl.classList.add('hidden');
        } else {
          abandon(true, (result.data && result.data.error) || t('dialogs:feedback.video.uploadFailed'));
        }
      } catch {
        if (video !== entry) return;
        // #1054: keep the bytes when the network fails. An online submit
        // retries them; a save-for-later drops the clip (too big for the
        // outbox) and says so.
        entry.uploading = false;
        entry.progressEl.classList.add('hidden');
        entry.stateEl.textContent = t('dialogs:feedback.video.savedOffline');
        showFeedbackNotice(t('dialogs:feedback.video.uploadLater'), false);
      }
    };

    const removeVideo = (entry) => {
      // An already uploaded (now orphaned) row is GC'd by the server's
      // 24h sweeper, like the images.
      discardVideo(entry);
      paintVideoActions();
    };

    videoBtn.addEventListener('click', () => {
      setAttachMenuOpen(false);
      if (videoBtn.disabled) return;
      // Same page-death insurance as the Photos picker above: the file
      // picker is a native surface and the tab can be evicted behind it.
      // Cleared again by the change handler below.
      stashCaptureDraft();
      videoInput.click();
    });

    const attachVideoFile = (file) => {
      void attachVideoBlob(file).catch((err) => {
        try { console.warn('[feedback] video attach failed', err && err.message); } catch { /* console is optional */ }
        if (video && video.uploading) discardVideo(video);
        paintVideoActions();
        showFeedbackNotice(t('dialogs:feedback.video.failed'), true);
      });
    };

    videoInput.addEventListener('change', () => {
      const file = (videoInput.files || [])[0] || null;
      videoInput.value = '';
      // A cancelled pick came back with the page intact — nothing to rescue.
      clearCaptureDraft();
      if (!file) return;
      attachVideoFile(file);
    });

    // ── #4065: drop files on the form ──────────────────────────────
    // Messages, group chat and agent sessions already take a dropped file;
    // this dialog only had its pickers, and a file dropped on it made the
    // browser navigate away to the file, taking the draft with it. A drop
    // anywhere on the form now goes where the pickers would send it: images
    // to the screenshot row (same room limit and checks), a clip to the
    // video slot. A control the dialog has switched off (an upload or a
    // submit under way) refuses the drop the way its button would, and a
    // full image row says so.
    const draggingFiles = (event) => {
      const types = event.dataTransfer && event.dataTransfer.types;
      return !!types && Array.from(types).includes('Files');
    };
    feedbackForm.addEventListener('dragover', (event) => {
      if (!draggingFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    });
    feedbackForm.addEventListener('drop', (event) => {
      if (!draggingFiles(event)) return;
      event.preventDefault();
      if (feedbackText.readOnly) return;
      const files = Array.from(event.dataTransfer.files || []);
      const images = files.filter((file) => /^image\//.test(file.type));
      const clip = files.find((file) => /^video\//.test(file.type));
      if (images.length && !screenshotPickerBtn.disabled) {
        if (screenshots.length >= MAX_SCREENSHOTS) {
          showFeedbackNotice(t('dialogs:feedback.image.dropLimit', { count: MAX_SCREENSHOTS }), true);
        } else {
          abandonPendingCapture();
          void attachScreenshotFiles(images);
        }
      }
      if (clip && !videoBtn.disabled) attachVideoFile(clip);
      if (!images.length && !clip && files.length) {
        showFeedbackNotice(t('dialogs:feedback.drop.wrongType'), true);
      }
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
      if (code === 'duplicate') return t('dialogs:feedback.queue.refused.duplicate');
      if (code === 'full') return t('dialogs:feedback.queue.refused.full', { count: window.FeedbackQueue?.MAX_ENTRIES || 10 });
      if (code === 'too-large') return t('dialogs:feedback.queue.refused.tooLarge');
      return t('dialogs:feedback.queue.refused.failed');
    };

    // The queue status line. One element (#feedback-status) says all three
    // things, in order of how much the user needs it: the offline hint, the
    // count already waiting, or nothing at all.
    let queueLineText = '';
    let queuePendingCount = 0;

    const queueStatusLine = () => {
      const offline = isOfflineNow();
      const n = queuePendingCount;
      // Whole messages, one per plural form, never assembled from fragments:
      // their exact English is what the dapp.json checks match on, and
      // tests/feedback-offline-ui.test.js verifies the catalog holds it verbatim.
      if (offline && n > 0) return t('dialogs:feedback.queue.offlineWaiting', { count: n });
      if (offline) return t('dialogs:feedback.queue.offline');
      // #3994: not "sending now". The outbox sends on its own schedule, which
      // can be ten minutes away, so the line says what is true and the
      // Try again under it (#feedback-queue-retry) sends it now.
      if (n > 0) return t('dialogs:feedback.queue.waiting', { count: n });
      return '';
    };

    // Repaint the hint and the button label. Never overwrites a submit
    // outcome ("Thanks! Filed against…", an error, the saved confirmation):
    // that is the newer and more specific thing to say, so the line is only
    // rewritten while it is hidden or still showing our own text.
    // The submit button's words while nothing is in flight.
    // A private request is never saved for later (#5048), so it keeps Post.
    const restingSubmitLabel = () => (isOfflineNow() && !privateChosen()
      ? t('dialogs:feedback.submit.saveForLater')
      : t('dialogs:feedback.submit.post'));

    const paintQueueState = () => {
      // #2707: `submitBusy`, not `feedbackBtn.disabled`. They are the same
      // thing again since #2888 made Submit live while the destination row
      // waits, but the busy flag is the one that says what it means.
      if (!submitBusy) feedbackBtn.textContent = restingSubmitLabel();
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
      paintQueueRetry();
    };

    // Every count() is async (opening IndexedDB can take a moment) and three
    // things ask for one — the dialog opening, a connectivity change, and the
    // store's own change notifications. They can resolve OUT OF ORDER, and a
    // stale answer paints a count the store no longer has: that is exactly how
    // ?shot=feedback-queued lost its dot, because the offline-change fired
    // before the seed and its slower read landed after it. Only the newest
    // read is allowed to paint.
    // #3994: "Try again" under the status line, while anything saved on
    // this device is still waiting. The outbox sends on its own triggers
    // (coming back online, signing in, a backoff timer), and every one of
    // them can miss a connection that is back, which left a person looking at
    // a stuck message with nothing to press. It is hidden while the composer
    // is locked (a message was just saved or filed), so it never sits under
    // the "Saved on this device" confirmation. The words stay in the outbox
    // throughout: a try that fails again only puts the message back on the
    // schedule, and one the server refuses outright comes back into the box.
    const queueRetryBtn = document.getElementById('feedback-queue-retry');
    let queueRetrying = false;
    const paintQueueRetry = () => {
      if (!queueRetryBtn) return;
      const show = queueRetrying || (queuePendingCount > 0 && !feedbackText.readOnly);
      queueRetryBtn.classList.toggle('hidden', !show);
      queueRetryBtn.disabled = queueRetrying;
      queueRetryBtn.textContent = queueRetrying ? t('dialogs:feedback.queue.retrying') : t('dialogs:feedback.queue.retry');
    };
    const retryQueuedNow = async () => {
      if (!window.FeedbackQueue?.retryNow || queueRetrying) return;
      queueRetrying = true;
      paintQueueRetry();
      // A probe too, so a connection that came back clears the offline
      // state (and the "Save for later" label) without waiting 15 s.
      try { window.Offline?.nudge?.(); } catch (err) { /* ignore */ }
      let res = null;
      try { res = await window.FeedbackQueue.retryNow(); } catch (err) { res = null; }
      queueRetrying = false;
      const n = await readQueueCount();
      paintQueueRetry();
      const modal = document.getElementById('feedback-modal');
      if (!modal || modal.classList.contains('hidden')) return;
      // A sent message is announced by onFlushed's toast; the line itself
      // goes back to describing what is left.
      // A message the server refused outright comes back into an empty,
      // editable box right away, as the open path's hand-back does. Someone
      // mid-sentence keeps their sentence, and the refused one waits in the
      // outbox for the next open.
      if (res && res.failed > 0 && !feedbackText.readOnly && !feedbackText.value.trim()) {
        const failed = await Promise.resolve(window.FeedbackQueue.takeFailed()).catch(() => null);
        // takeFailed() is a store read, and the box stayed editable while it
        // ran: typing that started meanwhile wins, and the record goes back.
        if (failed && (feedbackText.readOnly || feedbackText.value.trim() || feedbackTitle.value.trim())) {
          Promise.resolve(window.FeedbackQueue.putBack?.(failed)).catch(() => {});
        } else if (failed) {
          const p = failed.payload || {};
          feedbackText.value = p.description || '';
          if (p.title) { feedbackTitle.value = p.title; titleDirty = true; }
          restoreChosenTarget(p.target, p.appSlug, p.appName);
          showFeedbackNotice(failed.lastError
            ? t('dialogs:feedback.queue.rejectedReason', { reason: failed.lastError })
            : t('dialogs:feedback.queue.rejected'), true);
          queueLineText = '';
          feedbackText.focus({ preventScroll: true });
          return;
        }
      }
      if (n > 0 && (!res || res.remaining > 0)) {
        showFeedbackNotice(t('dialogs:feedback.queue.stillWaiting', { count: n }), true);
        queueLineText = '';
        return;
      }
      queueLineText = feedbackStatus.classList.contains('hidden') ? '' : feedbackStatus.textContent;
      paintQueueState();
    };
    queueRetryBtn?.addEventListener('click', () => { void retryQueuedNow(); });

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

    // QA 2026-09-24: what a refused submit says. A 5xx is the server's own
    // trouble (no GitHub token configured, GitHub refusing the issue, a
    // database error), and its wording was written for whoever runs the
    // server: the dialog printed "GitHub token not configured" under the
    // form. The person gets a plain sentence; the reason goes to the console
    // (a warning, not an error: an error there fails a proposal's checks).
    // A 4xx is about what was sent ("Description is required", "This app has
    // no repository yet…") and is already written for the person, so it is
    // shown as it is.
    // #5048: file the dialog's words as a private request. No outbox: an
    // offline or failed submit says so and keeps the words in the form,
    // because the outbox files on GitHub, in public.
    const submitPrivate = async (body, { submittedPresentation, submittedBy, telemetryAttempt }) => {
      const fail = (message, errorCode) => {
        window.UITelemetry?.outcome?.(telemetryAttempt, 'failure', { errorCode });
        feedbackStatus.textContent = message;
        feedbackStatus.className = 'text-sm mt-2 text-red-400';
        feedbackStatus.classList.remove('hidden');
        enableSubmit();
        feedbackBtn.textContent = restingSubmitLabel();
      };
      if (isOfflineNow()) return fail(t('dialogs:feedback.private.offline'), 'offline');
      let res;
      let data;
      try {
        res = await fetch('/api/private-requests', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            target: body.target,
            ...(body.appSlug ? { appSlug: body.appSlug } : {}),
            ...(body.title ? { title: body.title } : {}),
            description: body.description,
          }),
        });
        data = await res.json().catch(() => ({}));
      } catch {
        return fail(t('dialogs:feedback.private.offline'), 'network');
      }
      if (submittedPresentation !== presentation || submittedBy !== App.user?.id) {
        window.UITelemetry?.cancel?.(telemetryAttempt);
        return;
      }
      if (!res.ok) return fail(submitErrorText(res.status, data.error), window.UITelemetry?.errorCodeFor?.(res.status));
      window.UITelemetry?.outcome?.(telemetryAttempt, 'success');
      forgetSentDraft(body.description);
      feedbackText.value = '';
      feedbackTitle.value = '';
      clearDescriptionError();
      clearCaptureDraft();
      clearSavedDraft();
      resetTitleGenState();
      resetScreenshotState();
      resetVideoState();
      setComposerLocked(true);
      feedbackBtn.textContent = t('dialogs:feedback.submit.posted');
      // The Workshop's Private requests section lists it without a reload.
      window.dispatchEvent(new CustomEvent('usernode:private-requests-changed', {
        detail: { slug: data.appSlug || null },
      }));
      showSent(t('dialogs:feedback.private.sentTitle'), t('dialogs:feedback.private.sentNote'));
    };
    const submitErrorText = (status, error) => {
      if (status >= 500 || !error) {
        try { console.warn('[feedback] submit refused', status, error || '(no message)'); } catch { /* console is optional */ }
        return t('dialogs:feedback.error.file');
      }
      return error;
    };

    // Save `body` (the exact /api/feedback payload) for later, with the
    // screenshot bytes if one is attached. Mirrors the successful-submit
    // cleanup: the draft is consumed and the dialog locks. It closes after a
    // 1500 ms grace window, because from the user's side the job IS done; a
    // filed report stays on its confirmation instead (#3186), because it has
    // somewhere to go, "Your feedback", and a saved one is not there yet.
    const saveForLater = async (body) => {
      if (!window.FeedbackQueue) {
        showFeedbackNotice(t('dialogs:feedback.error.network'), true);
        return false;
      }
      // #3940: the outbox caps its bytes around a screenshot budget (12 MB,
      // MAX_SCREENSHOT_BYTES in feedback-queue.js), so a clip that never
      // uploaded is dropped here rather than queued — one that DID upload
      // travels as body.videoId with everything else.
      const droppedVideo = !!(video && !video.id && video.blob);
      try {
        await window.FeedbackQueue.enqueue({
          payload: body,
          // Already-uploaded screenshots travel as ids (body.screenshotIds);
          // a capture whose upload failed travels as bytes and is uploaded at
          // flush time.
          screenshots: screenshots.filter((shot) => !shot.id && shot.blob).map((shot) => shot.blob),
        });
      } catch (err) {
        showFeedbackNotice(queueRefusal(err && err.code), true);
        return false;
      }
      feedbackStatus.textContent = droppedVideo
        ? t('dialogs:feedback.queue.savedWithoutVideo')
        : t('dialogs:feedback.queue.saved');
      feedbackStatus.className = 'text-sm mt-2 text-emerald-700 dark:text-emerald-400';
      feedbackStatus.classList.remove('hidden');
      queueLineText = '';
      feedbackText.value = '';
      feedbackTitle.value = '';
      clearDescriptionError();
      // #1284: safe in the outbox now — the capture stash has nothing to add.
      clearCaptureDraft();
      // #2796: and the outbox owns the words now, so the saved draft goes too.
      clearSavedDraft();
      resetTitleGenState();
      resetScreenshotState();
      resetVideoState();
      setComposerLocked(true);
      disableSubmit();
      feedbackBtn.textContent = t('dialogs:feedback.submit.saved');
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
          PlatformUI.toast(t('dialogs:feedback.queue.flushed', { count: n }));
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
            else if (feedbackText.readOnly) showFirstFeedback(moment, t('dialogs:feedback.first.savedSent'));
            else pendingFirstFeedback = moment; // Keep the draft being typed intact.
          }
        },
      });
    }

    const submitFeedback = async () => {
      const text = feedbackText.value.trim();
      // #1603: this used to be a bare `return` — the one submit path that
      // refused and said nothing. The refusals stay FIRST (ahead of the
      // offline branch below, which would otherwise queue an empty
      // description, or one filed nowhere).
      //
      // #2888: no destination chosen. Submit is live on purpose, so this is
      // the ordinary path now, not a keyboard corner case: send nothing and
      // say what is missing. Both refusals are painted at once — fixing one
      // only to be told about the other is a second round trip — and the
      // destination row, the first control in the form, is painted last so
      // it is where focus ends up.
      const missingTarget = awaitingTarget || !feedbackTarget;
      if (!text || missingTarget) {
        if (!text) showDescriptionError();
        if (missingTarget) showTargetError();
        return;
      }
      // Guard against double-submit while the request is in flight, and
      // also against submits after success (the textarea is disabled
      // then, but a stale cmd+enter on a focused button could still
      // land here).
      if (feedbackBtn.disabled) return;
      // #683: a screenshot upload is still in flight — the id isn't known
      // yet, so filing now would silently drop the attachment.
      if (screenshotUploading()) {
        showFeedbackNotice(t('dialogs:feedback.screenshot.stillUploading'), false);
        return;
      }
      // #3940: same rule for the clip.
      if (videoUploading()) {
        showFeedbackNotice(t('dialogs:feedback.video.stillUploading'), false);
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
      feedbackTitle.placeholder = titleIdlePlaceholder();
      disableSubmit(); feedbackBtn.textContent = t('dialogs:feedback.submit.posting');
      const submittedPresentation = presentation;
      const submittedBy = App.user?.id;
      const telemetryAttempt = window.UITelemetry?.attempt?.('feedback_submit', {
        screen: 'feedback_dialog', appSlug: App.currentApp || undefined,
        timeoutMs: 15_000, abandonOnHide: true,
      });
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
        // #6485: the app the person picked when they picked it, not whatever
        // app happens to be mounted now.
        if (target === 'app') body.appSlug = targetApp?.slug || App.currentApp;
        // #5048: a private request goes to Homeroom alone. It never takes
        // the outbox or /api/feedback, both of which file a public GitHub
        // issue, and nothing attached goes with it.
        if (privateChosen()) {
          await submitPrivate(body, { submittedPresentation, submittedBy, telemetryAttempt });
          return;
        }
        // #964: pledge a kudos bounty on the issue this submit files.
        // Captured at submit time alongside the target, and only when the
        // box is both ticked and enabled — a disabled (allowance-spent)
        // checkbox must never send the flag. The server files the issue
        // regardless of what happens to the bounty.
        const wantBounty = bountyCheckbox.checked && !bountyCheckbox.disabled
          && !bountyRow.classList.contains('hidden');
        if (wantBounty) body.bounty = true;
        // #1054: a capture whose upload failed earlier still has its bytes
        // (shot.blob). Retry those uploads now so a submit that goes through
        // keeps the attachments the thumbnails are still promising. A second
        // failure is not fatal — the offline branch below carries the bytes,
        // and an online submit files without that picture as before.
        for (const shot of screenshots.slice()) {
          if (shot.id || !shot.blob || isOfflineNow()) continue;
          try {
            const shotRes = await uploadScreenshot(shot.blob);
            const shotData = await shotRes.json().catch(() => ({}));
            if (shotRes.ok && shotData.id) {
              shot.id = shotData.id;
              if (shot.stateEl) shot.stateEl.textContent = '';
            }
          } catch (err) { /* still offline — handled below */ }
        }
        // #3940: the clip whose upload failed earlier still has its bytes.
        // Same retry rule as the screenshots: a second failure is not
        // fatal, the offline branch below handles it.
        if (video && !video.id && video.blob && !isOfflineNow()) {
          const entry = video;
          try {
            const result = await uploadVideo(entry, null);
            if (video === entry && result.ok && result.data && result.data.id) {
              video.id = result.data.id;
              if (video.stateEl) video.stateEl.textContent = '';
            }
          } catch (err) { /* still offline — handled below */ }
        }
        // #683/#3027: attach the uploaded screenshots — the server appends
        // the embed lines and links every row to the filed issue.
        const shotIds = screenshotIds();
        if (shotIds.length) body.screenshotIds = shotIds;
        // #4482: comments handed over keep their pins beside their pictures,
        // which the server writes onto each picture's link.
        const pinned = screenshots.filter((shot) => shot.id && shot.pins && shot.pins.length)
          .flatMap((shot) => shot.pins.map((pin) => ({
            id: shot.id, x: pin.x, y: pin.y, ...(pin.n ? { n: pin.n } : {}), note: String(pin.note || ''),
          })));
        if (pinned.length) body.screenshotPins = pinned;
        // #3940: and the uploaded clip.
        if (video && video.id) body.videoId = video.id;
        // #685: collect the app's state snapshot at submit time (fresh
        // state, and the modal only overlays the still-running iframe).
        // Never blocks filing: a null (provider gone, error, 5 s
        // timeout) files without state with a non-blocking notice.
        let stateNotice = '';
        const wantState = stateAvailable && target === 'app'
          && body.appSlug === App.currentApp
          && !stateRow.classList.contains('hidden') && stateCheckbox.checked;
        if (wantState && typeof AppView !== 'undefined'
            && typeof AppView.collectIssueState === 'function') {
          const pageState = await AppView.collectIssueState();
          if (pageState) {
            body.pageState = pageState.json;
            if (pageState.truncated) body.pageStateTruncated = true;
          } else {
            stateNotice = t('dialogs:feedback.state.filedWithout');
            showFeedbackNotice(t('dialogs:feedback.state.filingWithout'), false);
          }
        }
        // #1054: we already know the network is down (the /health probe said
        // so, and the button says "Save for later") — so don't spend a doomed
        // round trip and a red error message finding out. Straight to the
        // outbox.
        if (isOfflineNow()) {
          if (await saveForLater(body)) {
            window.UITelemetry?.outcome?.(telemetryAttempt, 'success');
            return;
          }
          window.UITelemetry?.outcome?.(telemetryAttempt, 'failure', { errorCode: 'offline' });
          enableSubmit();
          feedbackBtn.textContent = restingSubmitLabel();
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
            headers: {
              'Content-Type': 'application/json',
              ...window.UITelemetry?.contextHeaders?.(telemetryAttempt),
            },
            body: JSON.stringify(body),
          });
        } catch (err) {
          if (await saveForLater(body)) {
            window.UITelemetry?.outcome?.(telemetryAttempt, 'success');
            return;
          }
          window.UITelemetry?.outcome?.(telemetryAttempt, 'failure', { errorCode: 'network' });
          enableSubmit();
          feedbackBtn.textContent = restingSubmitLabel();
          return;
        }
        const data = await res.json();
        // #2796: a dismissal while the POST was in flight saved these words
        // as a draft; they are filed now, so that draft must not come back
        // (the presentation check below returns before the cleanup does).
        if (res.ok && submittedBy === App.user?.id) forgetSentDraft(text);
        // An old response must not replace a reopened draft or another
        // account's dialog after sign-out/sign-in.
        if (submittedPresentation !== presentation || submittedBy !== App.user?.id) {
          window.UITelemetry?.cancel?.(telemetryAttempt);
          return;
        }
        if (res.ok) {
          window.UITelemetry?.outcome?.(telemetryAttempt, 'success');
          // #964: report both outcomes on one line. A declined bounty
          // (allowance ran out between opening and submitting, repo isn't
          // an app the platform can attach one to) never reads as a
          // failure — the issue IS filed, and the bounty can still be added
          // later from the Dev screen's Topics row.
          let bountyNotice = '';
          // #5249: parked, a `bounty` in the answer (an older server's, to a
          // request saved before parking) says nothing.
          if (data.bounty && !KUDOS_PARKED) {
            if (data.bounty.placed) {
              bountyNotice = t('dialogs:feedback.bounty.pledged', { count: Number(data.bounty.remaining) });
              // The drawer's Kudos meter must show the number the user
              // just spent down to, not the one they saw before.
              window.Kudos?.Budget?.refresh?.();
            } else {
              bountyNotice = data.bounty.error
                ? t('dialogs:feedback.bounty.failedReason', { reason: data.bounty.error })
                : t('dialogs:feedback.bounty.failed');
            }
          }
          const appName = targetApp?.name || '';
          // The confirmation's heading (no full stop) and the status line's
          // sentence are two messages, each whole, for each place it can go.
          const postedTo = target === 'app'
            ? (appName ? t('dialogs:feedback.sent.postedApp', { app: appName }) : t('dialogs:feedback.sent.postedThisApp'))
            : t('dialogs:feedback.sent.postedPlatform');
          const postedSentence = target === 'app'
            ? (appName ? t('dialogs:feedback.posted.app', { app: appName }) : t('dialogs:feedback.posted.thisApp'))
            : t('dialogs:feedback.posted.platform');
          // The bounty outcome and the app-state note are sentences of their
          // own, said after it.
          // #6121: a picture whose upload failed earlier and failed again on
          // the retry above kept its thumbnail until now and did not go with
          // the request. Filing without it is deliberate; not saying so was not.
          const lostPictures = screenshots.filter((shot) => !shot.id && shot.blob).length;
          const picturesNotice = lostPictures
            ? t('dialogs:feedback.screenshot.filedWithout', { count: lostPictures })
            : '';
          feedbackStatus.textContent = joinSentences([postedSentence, bountyNotice, stateNotice, picturesNotice]);
          feedbackStatus.className = 'text-sm mt-2 text-emerald-700 dark:text-emerald-400';
          feedbackStatus.classList.remove('hidden');
          lastFiled = rememberEdit(data.edit);
          feedbackText.value = '';
          feedbackTitle.value = '';
          clearDescriptionError();
          // #1284: filed — there is nothing left to rescue.
          clearCaptureDraft();
          // #2796: sent — the only thing that ends a saved draft.
          clearSavedDraft();
          // Discard any in-flight title preview so it can't repopulate
          // the cleared field while the "Thanks!" confirmation is up.
          resetTitleGenState();
          // #683: the screenshot now belongs to the filed issue.
          resetScreenshotState();
          // #3940: the clip now belongs to the filed issue.
          resetVideoState();
          // Lock the textarea and keep the submit button disabled while
          // the "Thanks!" confirmation is up so a user can't keep
          // typing (or re-fire cmd+enter) after their feedback has
          // already been filed — fixes #32. Both controls are
          // re-enabled when the modal is reopened below.
          setComposerLocked(true);
          feedbackBtn.textContent = t('dialogs:feedback.submit.posted');
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
          // B8: Homeroom bot is on it: its confirmation, first request or not.
          // #3971: a first request says so inside it, naming the app.
          if (data.homeroomBot?.botWillBuild) {
            const first = !!data.firstFeedback && Number(data.firstFeedback.userId) === Number(App.user?.id);
            // A request sent to Homeroom names Homeroom, not the app that
            // happened to be open.
            showSent(postedTo, joinSentences([bountyNotice, stateNotice, picturesNotice]), data.homeroomBot,
              first ? { name: target === 'platform' ? 'Homeroom' : appName } : null, false, data.filed || null);
            return;
          }
          // B8: the bot is theirs but does not build here: it went to the group.
          const thanks = data.homeroomBot && target === 'app'
            ? (appName ? t('dialogs:feedback.sent.thanksGroup', { app: appName }) : t('dialogs:feedback.sent.thanksThisGroup'))
            : target === 'app'
              ? (appName ? t('dialogs:feedback.sent.thanksApp', { app: appName }) : t('dialogs:feedback.sent.thanksThisApp'))
              : t('dialogs:feedback.sent.thanksPlatform');
          // #3186: the confirmation stays, with "See your requests" in it,
          // instead of closing itself (see showSent above). #3971: "Thanks!"
          // leads it again, as it did before #3400.
          if (!showFirstFeedback(data.firstFeedback, feedbackStatus.textContent)) {
            showSent(thanks, joinSentences([bountyNotice, stateNotice, picturesNotice]), null, null, false, data.filed || null);
          }
          return;
        }
        window.UITelemetry?.outcome?.(telemetryAttempt, 'failure', {
          errorCode: window.UITelemetry?.errorCodeFor?.(res.status),
        });
        feedbackStatus.textContent = submitErrorText(res.status, data.error);
        feedbackStatus.className = 'text-sm mt-2 text-red-400';
        feedbackStatus.classList.remove('hidden');
      } catch {
        window.UITelemetry?.outcome?.(telemetryAttempt, 'failure', { errorCode: 'invalid_response' });
        // Reached only when the request itself completed and something about
        // the RESPONSE was unusable (non-JSON error body from a proxy, say).
        // A transport failure was already handled above, by saving.
        feedbackStatus.textContent = t('dialogs:feedback.error.network');
        feedbackStatus.className = 'text-sm mt-2 text-red-400';
        feedbackStatus.classList.remove('hidden');
      }
      enableSubmit();
      feedbackBtn.textContent = restingSubmitLabel();
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
      resetEdit();
      window.UITelemetry?.screen?.('feedback_dialog', { appSlug: App.currentApp || undefined });
      clearTimeout(closeTimer);
      firstFeedback = null;
      // Every open hands back an editable composer (showFirstFeedback re-locks).
      setComposerLocked(false);
      // The heading is "Suggest an improvement" from every way in,
      // so it is the markup's own and nothing renames it; `opts.intent`
      // ('issue', from the hub's ⋯) is still accepted and changes nothing.
      firstSuccess?.classList.add('hidden');
      // #3186: the last filed report's confirmation never greets the next open.
      hideSent();
      feedbackForm?.classList.remove('hidden');
      if (opts.edit) {
        openEdit(rememberEdit(opts.edit), {
          cancel: closeFeedback,
          saved: () => {
            closeFeedback();
            PlatformUI?.toast?.(t('dialogs:feedback.edit.savedToast'));
            opts.onEditSaved?.();
          },
        });
        return;
      }
      // Opening a queued success must not consume a failed outbox draft or
      // start screenshot/title probes behind the confirmation.
      if (opts.firstFeedback && showFirstFeedback(opts.firstFeedback, t('dialogs:feedback.first.savedPosted'))) return;
      // #2707: clear the previous open's question (and #2888 its red) first;
      // the destination branch below asks again when it has to.
      setAwaitingTarget(false);
      enableSubmit(); feedbackBtn.textContent = t('dialogs:feedback.submit.post');
      feedbackStatus.classList.add('hidden');
      // #1603: a refusal from a previous open never greets the next one.
      clearDescriptionError();
      resetTitleGenState();
      // #683/#824: each open starts screenshot-less. Photos is immediately
      // available; native capture appears after a fresh capability probe.
      const screenshotSession = ++screenshotProbeSequence;
      nativeCaptureSupported = false;
      resetScreenshotState();
      // #3940: and clip-less, with the row repainted to "Video".
      resetVideoState();
      // #4127: every open starts with the paperclip's popover shut.
      setAttachMenuOpen(false);
      void probeNativeCaptureSupport(screenshotSession, true);

      // "This app" is only selectable when an app with a real repo is
      // open. Otherwise the button stays visible but grayed-out/disabled
      // so users can still see both choices, and we default to platform.
      // #5940: a repository address on any host counts, not only
      // github.com: app repositories live on Homeroom's own git host now.
      // One rule, shared with comment mode and tested against the server's
      // src/services/repo-ref.js (../../lib/repo-link.js, #6016).
      const appData = (typeof AppView !== 'undefined' && AppView.appData) || null;
      const hasRepo = isRepoAddress(appData?.repo_url);
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
      resetPrivateRow();
      resetBountyRow();
      Promise.resolve(window.Kudos?.Budget?.refresh?.()).then(() => {
        // Only if the dialog is still open and untouched by the user.
        const modal = document.getElementById('feedback-modal');
        if (!modal.classList.contains('hidden') && !bountyCheckbox.checked && !privateChosen()) resetBountyRow();
      }).catch(() => { /* budget unavailable — row stays as painted */ });
      applyTargetAvailability(canTargetApp, appData);
      // A caller whose own button already named the app opens on it, with
      // `target: 'app'` (Home's Getting started card's Suggest did, until
      // #4635 retired the card). That press was the choice #2707 asks for,
      // and #5992 makes the open app the default anyway; this stays as the
      // explicit form, applied only when "This app" is really there.
      // #6485: a comment hands over the app the person picked; it comes
      // first, so it is taken even with no app tab open behind it.
      if (opts.target === 'app' && opts.appSlug) adoptTargetApp(opts.appSlug, opts.appName);
      else if (opts.target === 'app' && canTargetApp) setFeedbackTarget('app');
      // The experimental C comment (features/comment-pin/) hands itself over
      // here when it cannot post on its own (offline, the server failing):
      // its words, its screenshot and the destination the person already
      // chose, so the outbox below takes it from there and nothing is lost.
      // The words go after anything already in the box, never over it.
      if (opts.target === 'platform') setFeedbackTarget('platform');
      if (typeof opts.description === 'string' && opts.description.trim()) {
        const typed = feedbackText.value.trim();
        feedbackText.value = typed ? `${typed}\n\n${opts.description}` : opts.description;
      }
      if (typeof Blob !== 'undefined' && opts.screenshotBlob instanceof Blob
          && screenshots.length < MAX_SCREENSHOTS) {
        void attachScreenshotBlob(opts.screenshotBlob);
      }
      // Comment mode handing a box over (features/comment-pin/post.ts
      // handOverOptions): its pictures, the pages' with their pins beside them
      // (#4482), the title the box showed, and its Kudos. A title the person
      // saw and kept is theirs, so it is not dropped as a stale suggestion.
      if (Array.isArray(opts.screenshots)) {
        for (const handed of opts.screenshots) {
          if (screenshots.length >= MAX_SCREENSHOTS) break;
          if (typeof Blob !== 'undefined' && handed && handed.blob instanceof Blob) {
            void attachScreenshotBlob(handed.blob, Array.isArray(handed.pins) ? handed.pins : null);
          }
        }
      }
      if (typeof opts.title === 'string' && opts.title.trim() && !feedbackTitle.value.trim()) {
        feedbackTitle.value = opts.title.trim().slice(0, 200);
        titleDirty = true;
      }
      if (opts.bounty === true && !KUDOS_PARKED && !bountyCheckbox.disabled) bountyCheckbox.checked = true;

      // #1054: the outbox state — the offline hint, the "Save for later"
      // button label, and anything already waiting to send. Painted last so
      // none of the resets above overwrite the line, then refreshed from the
      // store a tick later.
      queueLineText = '';
      refreshQueueState();
      // A submit the server refused outright (a 400 no amount of retrying can
      // satisfy) is handed back here rather than disappearing: the user's own
      // words, their title and their target, with the reason above them.
      //
      // #2796: not while a saved draft is about to be restored below.
      // takeFailed() removes the record from the outbox, so taking it into a
      // composer the draft then fills would lose one set of words or the
      // other; left where it is, it comes back on the first open after that
      // draft is sent.
      const saved = readSavedDraft();
      if (window.FeedbackQueue && !saved) {
        Promise.resolve(window.FeedbackQueue.takeFailed()).then((failed) => {
          const modal = document.getElementById('feedback-modal');
          if (!failed) return;
          // Live text always wins — a returned draft must never overwrite
          // what someone is typing right now. #3994: and takeFailed() has
          // already removed it, so a draft that cannot be shown goes back to
          // the outbox for the next open instead of being dropped.
          if (modal.classList.contains('hidden') || feedbackText.readOnly || feedbackText.value.trim()) {
            Promise.resolve(window.FeedbackQueue.putBack?.(failed)).catch(() => {});
            return;
          }
          const p = failed.payload || {};
          feedbackText.value = p.description || '';
          if (p.title) { feedbackTitle.value = p.title; titleDirty = true; }
          restoreChosenTarget(p.target, p.appSlug, p.appName);
          feedbackStatus.textContent = failed.lastError
            ? t('dialogs:feedback.queue.rejectedReason', { reason: failed.lastError })
            : t('dialogs:feedback.queue.rejected');
          feedbackStatus.className = 'text-sm mt-2 text-red-400';
          feedbackStatus.classList.remove('hidden');
          queueLineText = '';
          feedbackText.focus({ preventScroll: true });
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
          restoreChosenTarget(rescued.target, rescued.appSlug, rescued.appName);
          showFeedbackNotice(t('dialogs:feedback.screenshot.lost'), false);
          queueLineText = '';
        }
      }

      // #2796: the words this viewer typed and closed the dialog on — by the
      // backdrop, Cancel, back or a reload. Same "empty, editable field only"
      // rule as the two hand-backs above, and restored silently: this is
      // simply where they left off. The destination is NOT restored: #5992
      // opens on the default for the context (the open app, else Homeroom),
      // so an earlier tap is not carried over.
      if (saved && !feedbackText.readOnly && !feedbackText.value.trim() && !feedbackTitle.value.trim()) {
        feedbackText.value = saved.description;
        feedbackTitle.value = typeof saved.title === 'string' ? saved.title : '';
        titleDirty = saved.titleDirty === true && feedbackTitle.value.trim().length > 0;
        // A restored auto-filled title stays valid only for the text it was
        // generated from; any other text falls back to the server's naming.
        if (!titleDirty && saved.titleFor && saved.titleFor === saved.description.trim()) {
          lastGeneratedFor = saved.titleFor;
        }
      }

      // Without a scroll: a plain focus() had iOS pan the whole page to
      // reveal the field while the phone sheet was still sliding up and the
      // keys were rising, and the sheet bounced between the three before it
      // settled (iPhone 17 Pro simulator, 12 Oct 2026). The sheet stands on
      // the keys itself (`useKeyboardSurface`, app.css `[data-dialog-sheet]`).
      feedbackText.focus({ preventScroll: true });
    };
    // The header's #feedback-btn used to be wired here. THE UI OVERHAUL
    // retired it: the dialog's entry point is the Improve panel's "Give
    // feedback" row now (features/improve/improve-controller.js's
    // giveFeedback(), which opens it with `target: 'app'` so the panel's own
    // app is preselected as the target). `App.openFeedbackModal` is unchanged
    // and still published below, so every other caller — the Dev "+" menu's
    // "File an issue", App._applyFeedbackShot, the rescued-draft notice — is
    // untouched.
    //
    // The button's outbox dot moved rather than went: #feedback-queue-dot
    // keeps its id and its writer (paintQueueDot) through two moves — onto
    // #improve-btn, and onto the Homeroom mark when #2718 retired that pill.
    // It sits on whatever control is the way to reach this dialog from the
    // header, and the mark is that control now: "Give feedback" is the lead
    // row of its menu.
    // Admin/moderation console (#588) is a drawer row now, not a header
    // button — its click handler is wired in HeaderMenu.init() (close the
    // drawer; the anchor's #admin href does the navigating). The row is
    // hidden for non-admins (see renderAdminButton) and
    // navigateToAdminConsole re-checks the flag, so a stray programmatic
    // hash change can't open it either.
    // The state half of the dismiss path, called by the island's onClose.
    // The Cancel button, the backdrop click, a kit dismiss, and every
    // `#feedback-cancel`.click() (the confirmations' own buttons, and the
    // save-for-later path after its 1500 ms grace window) all arrive here
    // now. The classList.add('hidden') that used to be this handler's first
    // line belongs to useStaticModal.
    Feedback._reset = () => {
      presentation += 1;
      const wasEditing = !!editing;
      resetEdit();
      setAttachMenuOpen(false);
      clearTimeout(closeTimer);
      firstFeedback = null;
      firstSuccess?.classList.add('hidden');
      feedbackForm?.classList.remove('hidden');
      // #1284: a dismissal that lands mid-capture is the stale teardown of
      // the presentation `suspendDialog()` closed, not the user closing the
      // dialog — so the draft, the title and the notice stay. (The screenshot
      // half below resets either way: that attempt is over.)
      if (!captureInFlight) {
        // #2796: closing is not discarding — whatever is in the composer is
        // kept for the next open (saveDraft skips a locked, already-sent one).
        if (!wasEditing) saveDraft();
        feedbackText.value = '';
        feedbackTitle.value = '';
        feedbackStatus.classList.add('hidden');
        clearDescriptionError();
        resetTitleGenState();
        clearCaptureDraft();
      }
      setComposerLocked(false);
      hideSent();
      // #2707: a stale teardown mid-capture must not drop the question — the
      // same dialog, with the same unanswered row, is about to be presented
      // again.
      if (!captureInFlight) setAwaitingTarget(false);
      enableSubmit(); feedbackBtn.textContent = t('dialogs:feedback.submit.post');
      // #683: cancelling discards the attachments client-side; an already
      // uploaded (now orphaned) row is GC'd server-side after 24h. #3027: not
      // mid-capture, though — with room for several images, the ones already
      // attached are part of the draft that stale dismissal must not cost.
      if (!captureInFlight) {
        screenshotProbeSequence += 1;
        nativeCaptureSupported = false;
        resetScreenshotState();
        // #3940: the clip is part of the draft the stale dismissal must
        // not cost, same as the images.
        resetVideoState();
      }
      // #964: drop any pledge intent with the rest of the draft.
      bountyCheckbox.checked = false;
      const pending = pendingFirstFeedback;
      pendingFirstFeedback = null;
      if (pending) setTimeout(() => {
        if (Number(pending.userId) === Number(App.user?.id)) App.openFeedbackModal({ firstFeedback: pending });
      }, 0);
    };
    // The form's draft, taken for its switch to comment mode (feedback.tsx):
    // the words, a title the person wrote, the pictures (their bytes; comment
    // mode uploads them with its own), the Kudos and a destination the person
    // chose. TAKEN, not copied: the composer is emptied, so the close that
    // follows saves no draft (#2796) to come back as a second copy. Comment
    // mode asks before it drops words nobody has posted.
    Feedback._takeDraft = () => {
      const chosen = feedbackTargetApp.getAttribute('aria-checked') === 'true'
        ? 'app'
        : feedbackTargetPlatform.getAttribute('aria-checked') === 'true' ? 'platform' : null;
      const draft = {
        text: feedbackText.readOnly ? '' : feedbackText.value,
        title: titleDirty ? feedbackTitle.value.trim() : '',
        images: screenshots.map((shot) => shot.blob).filter(Boolean),
        bounty: !!(bountyCheckbox.checked && !bountyCheckbox.disabled),
        target: chosen,
        // #6485: the app the option stood for, so comment mode files on it
        // even with no app tab open.
        ...(chosen === 'app' && targetApp ? { appSlug: targetApp.slug, appName: targetApp.name } : {}),
      };
      if (!feedbackText.readOnly) {
        feedbackText.value = '';
        feedbackTitle.value = '';
        titleDirty = false;
        resetScreenshotState();
        bountyCheckbox.checked = false;
      }
      return draft;
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
    // #556: same shortcut in the optional title input. Plain Enter goes on
    // to the description, the natural next step (#3907): feedback.tsx's
    // `returnKeyHandler` on #feedback-form does that, and leaves a modified
    // Enter to this listener.
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
  //
  // #4289's comment mode: where the device has not turned it off, a plain
  // open is comment mode (features/improve/suggest-shortcut.ts decides,
  // `opensComment`), and this form is one switch away from it. Not
  // an open that carries something for the form (a handed-over comment, the
  // first-request moment) or that asks for the form by name (`mode: 'form'`,
  // comment mode's Form).
  App.openFeedbackModal = (opts = {}) => {
    const shortcut = window.UsernodeReact?.suggestShortcut;
    const plain = !opts.edit && !opts.firstFeedback && !opts.description && !opts.screenshotBlob && !opts.screenshots
      && opts.mode !== 'form';
    if (plain && shortcut?.opensComment?.()) {
      shortcut.openComment({ via: 'suggest' });
      return;
    }
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
      PlatformUI?.toast?.(t('dialogs:feedback.draftSaved'));
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

  // #5992: the ?shot=feedback-choose reviewable state — the dialog as
  // somebody with an app open meets it, where the open app is preselected
  // and both destinations stay tappable. It runs the SHIPPED
  // applyTargetAvailability rather than posing the row by hand, so the
  // photograph is of the branch that ships. Display-only: it pins a label,
  // nothing else, and files nothing.
  App._simulateFeedbackTargetChoice = (name) => applyTargetAvailability(true, { name });

  // The language changed, or this namespace's text arrived: repaint what
  // this module wrote from the state it already holds, while the dialog is
  // up (the next open paints all of it again). A line that reports something
  // that just happened (a notice, the confirmation) keeps its words.
  if (typeof document.addEventListener === 'function') {
    document.addEventListener('homeroom:language-changed', () => {
      const modal = document.getElementById('feedback-modal');
      if (!modal || modal.classList.contains('hidden')) return;
      labelAppTarget(labelledApp);
      paintScreenshotActions();
      paintVideoActions();
      paintQueueRetry();
      paintQueueState();
    });
  }

  // Display-only review state: no feedback, session, or milestone is written.
  App._simulateFirstFeedback = () => showFirstFeedback({
    userId: App.user?.id, appSlug: App.currentApp || 'usernode-2d5619',
    issueNumber: 900008, canFix: true,
  }, t('dialogs:feedback.first.posted'));

  // #3186: ?shot=feedback-sent. The composer locks as a real send locks it,
  // and the confirmation reads what a platform report's does. Writes nothing.
  App._simulateFeedbackSent = () => {
    setComposerLocked(true);
    disableSubmit();
    showSent(t('dialogs:feedback.sent.thanksPlatform'));
  };

  // B8: ?shot=feedback-bot, what a request Homeroom bot builds is answered
  // with. Writes nothing.
  App._simulateFeedbackBot = () => {
    setComposerLocked(true);
    disableSubmit();
    showSent('', '', {
      botWillBuild: true, typicalMinutes: 8, canFix: true,
      appSlug: App.currentApp || 'usernode-2d5619', issueNumber: 900008,
    });
  };
}
