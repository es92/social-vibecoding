/**
 * Send-feedback dialog (#feedback-modal).
 *
 * Extracted verbatim from Shell.tsx by #1078 chunk A. The render output is
 * byte-identical to what the shell shipped before — same ids, same class
 * strings, same `hidden` semantics, same data-* attributes — and
 * tests/baselines/shell-markup.json plus the prerendered public/index.html
 * in this commit are the proof.
 *
 * ── What this island owns, and what it does not ───────────────────────
 *
 * OWNS: the open/close lifecycle. `useDialog` holds the `open` state,
 * `useStaticModal` performs the kit lift that `PlatformUI.adoptStaticModal`
 * used to do from outside React, and Cancel and the backdrop click are
 * rendered handlers rather than listeners `App.bindEvents` attached.
 *
 * DOES NOT OWN: anything inside the card, including the two confirmations
 * (the first-feedback moment and #3186's sent one). The target pills, the
 * title and description fields, the screenshot row, the two opt-in rows and the status
 * line are written by `./feedback-controller` — the retired ~810-line block
 * from `App.bindEvents`, whose header explains why it is still imperative.
 * React renders this tree once and never reconciles inside it, which is what
 * keeps the two owners from colliding.
 *
 * That controller is also why the fields below stay UNCONTROLLED: a rendered
 * `value` would both fight the controller and put a `value` attribute into
 * the prerendered public/index.html that the hand-written shell never had.
 */

import { Button } from '@/components/ui/button';
import { DialogCard, DialogRoot } from '@/components/ui/dialog';
import { CameraIcon, PhotoIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { Feedback, init as initFeedback } from './feedback-controller';
import { useDialog } from './use-dialog';

/** Reserved for callers that still pass `{ fromDev: true }` — see #226/#312. */
interface OpenOptions {
  fromDev?: boolean;
  /**
   * QA 2026-09-24: what the person asked for. The Workshop "+" menu's "File
   * an issue" row passes 'issue'; everything else is feedback.
   */
  intent?: 'issue' | 'feedback';
  firstFeedback?: { userId: number; appSlug: string | null; issueNumber: number; canFix: boolean };
}

export function FeedbackDialog() {
  const dialog = useDialog<OpenOptions>('feedback', {
    onOpen: (opts) => Feedback._open(opts || {}),
    onClose: () => Feedback._reset(),
  });

  // Was the middle of `App.bindEvents`. Layout effect, so the header's
  // speech-bubble button and the ?shot=feedback deep link are both live
  // before the first paint that could act on them.
  useIsomorphicLayoutEffect(() => {
    initFeedback();
  }, []);

  return (
    <DialogRoot
      id="feedback-modal"
      ref={dialog.rootRef}
      {...dialog.backdropProps}
    >
      <DialogCard size="sm">
        <div id="feedback-form">
        {/* QA 2026-09-24: the resting heading. The controller renames it on
            each open to match the way in ("File an issue" from the Workshop
            "+" menu), like every other string inside this card. */}
        <h2 className="text-lg font-bold mb-4">
          Send feedback
        </h2>
        {/*
            Target toggle: file this feedback against the app being viewed
            or against the Homeroom platform. The "This app" button
            is always visible but rendered disabled/grayed-out when no app
            with a repo is open (see ./feedback-controller).

            #2707: BOTH options render `aria-checked="false"`, because when
            both are selectable nothing is selected until the person taps
            one. The old markup pre-checked Platform, and the controller
            then pre-selected "This app" on open wherever it was available —
            so the dialog always arrived with a destination already made up,
            and a report about the app could be filed against the platform
            (or the reverse) by nobody's decision. The controller still
            selects the single available destination when there is only one:
            an extra tap that cannot disambiguate anything is just a tax.
        */}
        <div id="feedback-target" className="flex gap-2 mb-3" role="radiogroup" aria-label="Feedback target">
          <div className="flex-1 flex flex-col items-center">
            <button
              type="button"
              role="radio"
              aria-checked="false"
              data-feedback-target="app"
              id="feedback-target-app"
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-xs font-medium transition-colors"
            >
              This app
            </button>
            {/* Caret indicating the selected option; shown/hidden by the controller. */}
            <div
              id="feedback-caret-app"
              className="hidden mt-1 w-0 h-0 border-l-4 border-r-4 border-b-4 border-l-transparent border-r-transparent border-b-violet-600"
            >
            </div>
          </div>
          <div className="flex-1 flex flex-col items-center">
            <button
              type="button"
              role="radio"
              aria-checked="false"
              data-feedback-target="platform"
              id="feedback-target-platform"
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-xs font-medium transition-colors"
            >
              Homeroom Platform
            </button>
            <div
              id="feedback-caret-platform"
              className="hidden mt-1 w-0 h-0 border-l-4 border-r-4 border-b-4 border-l-transparent border-r-transparent border-b-violet-600"
            >
            </div>
          </div>
        </div>
        {/*
            #2707: what the row is asking while no destination is chosen —
            and, #2888, the red "choose one" the controller turns it into when
            Submit is pressed anyway (Submit stays live; it refuses and says
            why rather than sitting disabled). Renders EMPTY and hidden for the same two reasons #feedback-text-error
            does — the controller owns the text, and a prompt on the initial
            render would both lie (the one-destination case never shows it)
            and mismatch on hydration. The controller also points the
            radiogroup's `aria-describedby` at it while it is up.

            #1603 is the precedent this follows: a control that refuses and
            says nothing reads as a broken control, so the reason is on
            screen beside the thing to fix.
        */}
        <p id="feedback-target-hint" className="hidden -mt-1 mb-3 text-xs text-zinc-600 dark:text-zinc-400">
        </p>
        {/*
            #556: editable title, auto-filled live from the description
            (the controller debounces POST /api/feedback/title as you type).
            Left blank at submit, the server names the issue as before.
        */}
        <div className="mb-2">
          <Label id="feedback-title-label" htmlFor="feedback-title" className="mb-1">
            Title
            <span className="font-normal text-zinc-500 dark:text-zinc-500">
              {' optional'}
            </span>
          </Label>
          <Input
            id="feedback-title"
            type="text"
            maxLength={200}
            placeholder="Suggested as you type"
          />
        </div>
        {/*
            #1603: the description was always mandatory — the controller's
            submit returned early on an empty one and said nothing, so the
            button looked dead. The requirement is on screen now (this label
            and its asterisk) and the refusal is too (#feedback-text-error,
            filled and revealed by ./feedback-controller on an empty submit).

            `aria-required`, not the HTML `required` attribute: these fields
            are not inside a <form>, so `required` buys no native behaviour
            here while switching :invalid on for a field nobody has touched.

            The error node renders EMPTY and hidden, exactly like
            #feedback-status above it — the controller owns its text, and an
            initial render that already carried the message would both lie on
            open and mismatch on hydration.
        */}
        <div>
          <Label id="feedback-text-label" htmlFor="feedback-text" className="mb-1">
            Description
            <span id="feedback-text-required" aria-hidden="true" className="text-red-700 dark:text-red-400">
              *
            </span>
          </Label>
          <Textarea
            id="feedback-text"
            rows={4}
            maxLength={2000}
            aria-required="true"
            placeholder="Describe the issue or suggestion..."
            className="resize-none"
          >
          </Textarea>
          <p id="feedback-text-error" role="alert" className="hidden mt-1 text-xs text-red-700 dark:text-red-400">
          </p>
        </div>
        {/*
            #683/#824: desktop drag-to-select, native mobile capture, and a
            Photos fallback all converge on one preview/upload row.
        */}
        <div className="mt-2">
          <div className="flex flex-wrap gap-2">
            <button
              id="feedback-screenshot-btn"
              type="button"
              className="hidden inline-flex min-h-[48px] items-center gap-1.5 rounded-lg bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-900 dark:text-zinc-100 transition-colors"
            >
              <CameraIcon className="w-3.5 h-3.5" />
              <span data-screenshot-label="">Attach screenshot</span>
            </button>
            <button
              id="feedback-screenshot-picker-btn"
              type="button"
              className="hidden inline-flex min-h-[48px] items-center gap-1.5 rounded-lg bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-900 dark:text-zinc-100 transition-colors"
            >
              <PhotoIcon className="w-3.5 h-3.5" />
              Choose from Photos
            </button>
            <input
              id="feedback-screenshot-input"
              type="file"
              accept="image/png,image/jpeg"
              className="hidden"
              tabIndex={-1}
              aria-hidden="true"
            />
          </div>
          <div id="feedback-screenshot-preview" className="hidden items-center gap-2">
            <img
              id="feedback-screenshot-img"
              alt="Screenshot preview"
              className="h-14 max-w-[8rem] rounded-md border border-zinc-300 dark:border-zinc-700 object-cover"
            />
            <span id="feedback-screenshot-state" className="text-xs text-zinc-500 dark:text-zinc-400">
            </span>
            <button
              id="feedback-screenshot-remove"
              type="button"
              aria-label="Remove screenshot"
              className="rounded-full w-12 h-12 flex shrink-0 items-center justify-center text-xs bg-zinc-200 dark:bg-zinc-700 hover:bg-zinc-300 dark:hover:bg-zinc-600 transition-colors"
            >
              ✕
            </button>
          </div>
        </div>
        {/*
            #685: opt-in app state snapshot. Hidden unless the open app has
            registered a state provider via usernode.issueState.register()
            AND the feedback target is "This app" (wired in the controller).
        */}
        <div id="feedback-state-row" className="hidden mt-2">
          <label className="flex items-start gap-2 cursor-pointer select-none">
            <input
              id="feedback-state-checkbox"
              type="checkbox"
              defaultChecked={true}
              className="accent-violet-500 w-4 h-4 mt-0.5"
            />
            <span className="text-xs text-zinc-600 dark:text-zinc-400">
              <span className="font-medium text-zinc-700 dark:text-zinc-300">
                Include app state:
              </span>
              this app can attach a snapshot of its current state to help debugging
            </span>
          </label>
        </div>
        {/*
            #964: opt-in kudos bounty on the issue this dialog is about to
            file. Starts UNCHECKED on every open (the controller's _open) —
            filing feedback must never quietly spend someone's weekly
            allowance. The note under it carries the viewer's live remaining
            figure, and the checkbox is disabled at zero; the server is the
            real gate either way, and a bounty that can't be placed never
            costs the user their filed issue. Same utility classes as
            #feedback-state-row above, so no new Tailwind names appear.

            #1582 shortened this line to what a bounty DOES. What it used to
            also carry — that ticking the box spends 1 of the viewer's weekly
            kudos — moved into the note below rather than going away: this
            control spends a real allowance, so the cost has to stay on
            screen. The note already had the live remaining figure and is the
            right place for it.

            #2586 made that line one sentence about the person it thanks:
            "Put a kudos on this to thank whoever solves it". The emphasised
            run no longer ends in a colon, so the separating space rides
            inside the plain run's string — a bare whitespace expression
            between the two would be two adjacent text children, which
            cannot survive hydration (React #418) and the shell build
            refuses it.
        */}
        <div id="feedback-bounty-row" className="hidden mt-2">
          <label className="flex items-start gap-2 cursor-pointer select-none">
            <input id="feedback-bounty-checkbox" type="checkbox" className="accent-violet-500 w-4 h-4 mt-0.5" />
            <span className="text-xs text-zinc-600 dark:text-zinc-400">
              <span className="font-medium text-zinc-700 dark:text-zinc-300">
                Put a kudos on this
              </span>
              {' to thank whoever solves it'}
              <br />
              <span id="feedback-bounty-note" className="text-zinc-500 dark:text-zinc-500">
              </span>
            </span>
          </label>
        </div>
        <div id="feedback-status" className="text-sm mt-2 hidden">
        </div>
        <div className="flex gap-3 mt-4">
          {/*
              The controller's success and save-for-later paths still close
              the dialog by clicking this button after their 1500 ms grace
              window (`setTimeout(() => …('feedback-cancel').click(), 1500)`).
              That keeps working through a rendered handler: a programmatic
              click dispatches a real event, and React 19 delegates its
              listeners at document.body.
          */}
          <button
            id="feedback-cancel"
            className="flex-1 rounded-lg bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 px-4 py-2 text-sm font-medium text-zinc-900 dark:text-zinc-100 transition-colors"
            onClick={() => dialog.close()}
          >
            Cancel
          </button>
          <Button id="feedback-submit" layout="flex">
            Submit
          </Button>
        </div>
        </div>
        <section id="feedback-first-success" className="hidden" aria-labelledby="feedback-first-title" tabIndex={-1}>
          <h2 id="feedback-first-title" className="text-xl font-bold mb-3">
            Congratulations on your first feedback!
          </h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-4">
            You’ve helped make this app better. Want to take the next step?
          </p>
          <p id="feedback-first-notice" className="text-sm text-emerald-700 dark:text-emerald-400 mb-4" role="status"></p>
          <div className="flex flex-col gap-3">
            <Button id="feedback-first-fix" disabledStyle="block" className="min-h-[44px]">Try a fix yourself</Button>
            <p id="feedback-first-fix-note" className="text-xs text-zinc-500 dark:text-zinc-400">
              Start with a draft you can edit before sending it to the coding agent.
            </p>
            <Button id="feedback-first-board" variant="neutral" ink="neutral" disabledStyle="block" className="min-h-[44px]">See this app’s board</Button>
            {/* #3186: the Me screen's list, where this report now is. */}
            <Button id="feedback-first-mine" variant="neutral" ink="neutral" className="min-h-[44px]">See your feedback</Button>
            <Button id="feedback-first-done" variant="unstyled" ink="muted" className="min-h-[44px]">Done</Button>
          </div>
        </section>
        {/*
            #3186: every other filed report's confirmation. It was the status
            line, and the dialog closed itself 1.5 s later; now it is this
            section, drawn like the first-feedback moment above, and it stays
            until Done. The controller fills the notice (the "Thanks! Filed
            against …" line, with any bounty outcome) and reveals it, so it
            renders empty and hidden for the reason #feedback-status does.
        */}
        <section id="feedback-sent" className="hidden" aria-labelledby="feedback-sent-title" tabIndex={-1}>
          <h2 id="feedback-sent-title" className="text-lg font-bold mb-3">
            Feedback sent
          </h2>
          <p id="feedback-sent-notice" className="text-sm text-emerald-700 dark:text-emerald-400 mb-2" role="status"></p>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-4">
            It is in Your feedback on your profile, with its status.
          </p>
          <div className="flex flex-col gap-3">
            <Button id="feedback-sent-mine" variant="neutral" ink="neutral" className="min-h-[44px]">See your feedback</Button>
            <Button id="feedback-sent-done" variant="unstyled" ink="muted" className="min-h-[44px]">Done</Button>
          </div>
        </section>
      </DialogCard>
    </DialogRoot>
  );
}
