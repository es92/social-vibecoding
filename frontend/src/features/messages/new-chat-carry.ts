/**
 * WHAT A DOOR CARRIES INTO A NEW CHAT (14 Nov 2026). A door that used to put
 * an item in Main Chat's box (Ask for changes on a change, Ask privately on
 * a vote) opens a new chat with Homeroom bot instead, and the item goes with
 * it: a chip in the new chat's box, sent with the first message
 * (./new-thread.tsx). The address that opens the new chat can name a project
 * but not an item (../ai/door.ts botNewAddress), so the item waits here for
 * the chat that address opens, and only for a moment: a door whose address
 * never opened one must not hand its item to a chat started later.
 *
 * Its own module so the store (the door's half) and the panel (the taker)
 * can both import it without importing each other.
 *
 * WORDS AND A START TOO (24 Nov 2026). A project's Workshop asks "What
 * should change in Garden club?" over a box of its own and four starts
 * (../dev-board/workshop/front-page.tsx). What was typed there, and which
 * start was pressed, wait here the same way, for the same moment: the new
 * chat opens with the words in its box and the start chosen, exactly as
 * pressing that start inside New chat would (./new-thread.tsx `begin`).
 * Nothing is sent for the person.
 *
 * A LIVE START, SENT (27 Nov 2026). An app's own menu has a Start editor
 * card (../app-context/app-context-sheet.tsx): it opens a new chat about the
 * app and starts its live preview at once, as pressing the new chat's own
 * Live preview button would. That request waits here too (`send`), with no
 * words: the new chat writes the live start's words itself, in the app's
 * name, when it sends them.
 */

import type { StagedObject } from './types';

/** How long a carried item waits for its new chat. */
export const CARRY_MS = 10_000;

/** What waits for the new chat: an item and the question asked over it, or words and a start. */
export interface Carried {
  object: StagedObject | null;
  placeholder: string | null;
  /** Words for the box, as typed (none for an item's door). */
  words: string | null;
  /** The key of a start to choose (./new-thread.tsx NEW_THREAD_STARTS, LIVE_START), or null. */
  start: string | null;
  /** Start the live preview at once, as the new chat's Live preview button does. */
  send: boolean;
}

let carried: (Carried & { at: number }) | null = null;

/** Hand an item to the new chat about to open; null takes back what was waiting. */
export function carryToNewChat(object: StagedObject | null | undefined, placeholder: string | null = null, now: number = Date.now()): void {
  carried = object ? { object, placeholder, words: null, start: null, send: false, at: now } : null;
}

/** Hand words for the box, and a start to choose, to the new chat about to open. */
export function carryWordsToNewChat(words: string | null | undefined, start: string | null = null, now: number = Date.now()): void {
  const said = typeof words === 'string' ? words.slice(0, 8000) : '';
  carried = said.trim() || start ? { object: null, placeholder: null, words: said.trim() ? said : null, start, send: false, at: now } : null;
}

/** Ask the new chat about to open to start its live preview at once. */
export function carryLiveStartToNewChat(now: number = Date.now()): void {
  carried = { object: null, placeholder: null, words: null, start: null, send: true, at: now };
}

/** What is waiting, once: null when there is none, or it waited too long. */
export function takeCarried(now: number = Date.now()): Carried | null {
  const held = carried;
  carried = null;
  return held && now - held.at < CARRY_MS
    ? { object: held.object, placeholder: held.placeholder, words: held.words, start: held.start, send: held.send }
    : null;
}
