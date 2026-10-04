/**
 * The group chat composer's autocomplete menus, as view models.
 *
 * `@name` (MentionAutocomplete), `#123` / `PR#123` (RefAutocomplete) and
 * `:tada` (EmojiAutocomplete) are separate modules in
 * `public/js/group-chat.js` with the same shape: detect the
 * token under the caret, filter a candidate list, and draw a floating listbox
 * anchored to the composer. Both used to build that listbox with `innerHTML`
 * and then re-toggle a class per row on every arrow key. (The emoji menu came
 * later and was React from its first row.)
 *
 * ── One store, a slot per menu ────────────────────────────────────────
 *
 * They are separate menus, not one, because they are separate modules with
 * independent open/close state and independent dismiss bindings. They share a
 * store because they share a composer: a token under the caret is `@`-shaped,
 * `#`-shaped or `:`-shaped, never two at once, so no two slots are populated
 * together and keeping them side by side makes that visible rather than
 * incidental.
 *
 * ── What stays in group-chat.js ───────────────────────────────────────
 *
 * Everything that is not markup, which here is nearly everything: the token
 * detection, the candidate lists and their fetches, the accept-and-splice, the
 * capture-phase keydown, the dismiss listeners, and the POSITIONING — the menu
 * is `position: fixed` and its host is appended to `document.body`, measured
 * against the composer's rect. The host element is the module's; only its
 * CHILDREN are React's.
 */

import { createStore } from '../../lib/plain-store.js';

/** `you` is decided by the module, which knows the viewer. */
export interface MentionOption {
  username: string;
  you: boolean;
  /** B9: Homeroom bot's row: its name in place of a handle, its mark and an AI badge. */
  bot?: boolean;
  displayName?: string;
}

export interface RefOption {
  /** #2783: `channel` is a `#name` channel; its `number` is the handle. */
  kind: 'pr' | 'issue' | 'channel';
  number: number | string;
  title: string;
}

/** One `:shortcode` row: `👍 :thumbsup:`. */
export interface EmojiOption {
  emoji: string;
  /** Without colons: `thumbsup`. */
  shortcode: string;
}

export interface AutocompleteSlot<T> {
  items: T[];
  /** Highlighted row; -1 when closed. Arrow keys move it, they do not repaint. */
  active: number;
}

/** The emoji menu also heads its rows with what was typed: "Emoji matching :th". */
export interface EmojiSlot extends AutocompleteSlot<EmojiOption> {
  query: string;
}

export interface AutocompleteState {
  mention: AutocompleteSlot<MentionOption>;
  ref: AutocompleteSlot<RefOption>;
  emoji: EmojiSlot;
}

/** All closed. A menu's host ships empty and hidden, so this draws nothing. */
export const EMPTY_AUTOCOMPLETE: AutocompleteState = {
  mention: { items: [], active: -1 },
  ref: { items: [], active: -1 },
  emoji: { items: [], active: -1, query: '' },
};

export const autocompleteStore = createStore<AutocompleteState>(EMPTY_AUTOCOMPLETE);
