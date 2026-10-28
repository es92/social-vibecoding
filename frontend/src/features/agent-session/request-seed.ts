// Start work on a request card opens an UNSENT conversation (store.ts,
// openDraft). It used to open with only the request's number in its hint:
// the Mayor learned the request from the session's focus once the first
// message was sent, but the screen said nothing about it and the box was
// empty, so it read as a blank conversation. Now the screen names the
// request and the box holds a first message for it, unsent and editable, as
// the dev chat's Start work seeds its box (app-view.js, createPrForIssue).
//
// The title rides in the hint from the card that had it. It is the screen's
// alone: the server resolves the request from its number (serverHint in
// ./api.ts drops the title), and the Mayor reads the request in full itself,
// which is why the seed names it rather than pasting its description.

import { t } from '../../lib/i18n/runtime';
import type { AgentHint } from './api';

/** The request an unsent conversation was started from. */
export interface DraftRequest {
  number: number;
  /** Null when the entry point did not have it; the number still names it. */
  title: string | null;
}

// A title is one line of a message, not a document: a card's title is short,
// and a pasted wall of text should not become the whole box.
const TITLE_MAX = 200;

function cleanTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const flat = raw.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX - 1).trimEnd()}…` : flat;
}

export function draftRequest(hint: AgentHint | null | undefined): DraftRequest | null {
  const number = Number(hint?.issueNumber);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return { number, title: cleanTitle(hint?.issueTitle) };
}

/** The first message an unsent conversation started from a request offers, or '' when it was not. */
export function requestSeed(hint: AgentHint | null | undefined): string {
  const request = draftRequest(hint);
  if (!request) return '';
  return request.title
    ? t('agent:session.requestSeed.titled', { number: request.number, title: request.title })
    : t('agent:session.requestSeed.untitled', { number: request.number });
}

// A handed-over message is the user's own request or one the platform
// wrote (Explore's), so it is kept whole, up to the length
// a turn accepts (MAX_MESSAGE_CHARS in src/routes/agent-sessions.js).
const MESSAGE_MAX = 20000;

/**
 * The first message an unsent conversation offers: the one its entry point
 * handed over (the hint's `message`), else a request's (requestSeed), else ''.
 */
export function draftSeed(hint: AgentHint | null | undefined): string {
  const message = typeof hint?.message === 'string' ? hint.message.trim() : '';
  if (message) return message.length > MESSAGE_MAX ? message.slice(0, MESSAGE_MAX) : message;
  return requestSeed(hint);
}
