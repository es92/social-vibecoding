/**
 * `#dc-composer-bar`'s children — the dev chat's whole composer — as a view
 * model.
 *
 * ── Why this is one chunk and not six ─────────────────────────────────
 *
 * The bar looks like six independent controls and is really one state. Six
 * writers reached into it, and every one of them was reading the SAME two
 * questions — is a turn running, and where is this session built:
 *
 *   - `_setStreamingUI` wrote the send button's `disabled`, three state
 *     classes, its `aria-label`, its `title` and its `innerHTML`; the
 *     textarea's `placeholder`; and the OpenRouter row's `disabled`.
 *   - `_syncSaveDraftBtn` wrote `hidden`, `disabled` and `title` on the save
 *     icon — and called `_syncShortcutHint`, which wrote the hint's
 *     `innerHTML`, because the two flip on exactly the same events. Both
 *     controls are gone now: the save icon folded into the one circle (see
 *     SendButtonView) and the hint went with it, its two spellings surviving
 *     as that circle's `title`. `_syncSaveDraftBtn` remains as the republish
 *     every keystroke goes through, because the circle's shape depends on
 *     whether the field has text.
 *   - `_renderSavedDrafts` rebuilt `#dc-drafts` and toggled its active class.
 *   - `_setAttachError` wrote the error line's text and its `hidden` class.
 *   - `_refreshModelSelect` rewrote the picker's `<option>`s in place so a
 *     server-side allowlist change reached an open composer.
 *
 * Splitting those across six stores would have been six copies of "is the
 * chat busy". One publish answers it once.
 *
 * ── What each side still owns ─────────────────────────────────────────
 *
 * The BAR is dev-chat.js's: `renderChatView` writes the element, and its
 * `border-t … p-2` run is dropped in a launchpad, where there is nothing to
 * frame. Everything between its edges is the component's.
 *
 * The LISTENERS stay the module's, bound on the line after the mount: the
 * form's submit, the textarea's input and keydown, the paperclip and the file
 * input, the drafts' delegated click, the quick-reply bar's. They are
 * listeners on nodes — they write no markup — which is what keeps one owner
 * for the draft, the shortcut routing and the attachment lifecycle. The same
 * arrangement the group chat's composer runs under.
 *
 * Two module writes survive on purpose and neither is a conflict:
 * `_setupTextareaResize` sets `style.height` on the field after every
 * keystroke (nothing here renders a `style` prop, so React never diffs that
 * attribute — the same tolerated overlap the group chat documents), and
 * `_restoreDraft` sets `.value`, a DOM property on an UNCONTROLLED field.
 */

import { createStore } from '../../lib/plain-store.js';

/** One entry of the chat-model picker, already labelled. */
export interface ModelOptionView {
  id: string;
  label: string;
  /** `changeSize.short` — "general coding work". '' when the server omits it. */
  blurb: string;
}

/**
 * The one circle at the end of the control row, in the five shapes it takes.
 *
 * It is ONE button because the composer has one primary action at a time, and
 * which one it is follows the turn: send while idle, stop while a turn runs,
 * save the moment there is text to park. That replaced a Send button beside a
 * separate save icon, where the two were laid out as peers and only one of
 * them was ever the thing to press.
 *
 * `stopping` and `busy` are both disabled spinners and are still separate:
 * #889's requested-but-not-yet-landed stop says so in words beside the
 * spinner, and #1378's un-stoppable turn must not paint a live red Stop the
 * click cannot honour.
 */
export type SendButtonView =
  /** Idle. Submitting sends. */
  | { kind: 'send' }
  /** A stoppable turn, nothing typed. Red square; submitting stops. */
  | { kind: 'stop' }
  /**
   * A turn is running AND there is text in the box, which is #810's state:
   * sending is impossible, so parking the text is the only thing to do with
   * it. Green; submitting saves the draft, which BLANKS the field — and a
   * blank field is `stop` again, which is how Stop comes back.
   *
   * It outranks `stop`, `stopping` and `busy`, all three: while a turn runs,
   * text in the box is always the more useful of the two actions, and the
   * user reaches Stop by clearing the field or by saving.
   */
  | { kind: 'save' }
  /** #889: the stop is in flight. Muted spinner and a word for it. */
  | { kind: 'stopping' }
  /** #1378 / wrap-up: still running, nothing to press. */
  | { kind: 'busy'; label: string; title: string };

/** One row of #798's saved-drafts list. */
export interface SavedDraftView {
  id: string;
  text: string;
}

export interface ComposerState {
  /** `BuildVenues.noteHtml`'s sentence. '' in the ordinary case. */
  venueNoteHtml: string;
  /** #1281: a launchpad stands in the composer's place, so it is hidden. */
  hidden: boolean;
  /**
   * Homeroom · Claude's chat-model picker. Null on every other venue.
   *
   * `selectedLabel` is the CLOSED control — a bare model name, and #1589's
   * finding stands on it: the guidance set the control's width and wrapped
   * the credit meter onto a second line. `options` is the OPEN sheet, where
   * each row has a whole line to itself, so the blurb rides along there.
   */
  models: {
    options: ModelOptionView[];
    selected: string;
    selectedLabel: string;
  } | null;
  /** OpenRouter's session-pinned model row. Null on every other venue. */
  openRouter: {
    /** Already defaulted to "No model is pinned". */
    model: string;
    changeDisabled: boolean;
    note: string;
  } | null;
  /** #798's saved drafts. `busy` disables each row's Send. */
  drafts: { rows: SavedDraftView[]; busy: boolean };
  /** The line under the pending strip. Null when there is nothing wrong. */
  attachError: string | null;
  /** The field's placeholder — the busy copy while a turn runs. */
  placeholder: string;
  send: SendButtonView;
}

export const composerStore = createStore<ComposerState>({
  venueNoteHtml: '',
  hidden: false,
  models: null,
  openRouter: null,
  drafts: { rows: [], busy: false },
  attachError: null,
  placeholder: '',
  send: { kind: 'send' },
});
