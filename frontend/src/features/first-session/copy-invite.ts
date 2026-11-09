/**
 * Copy link, in the made screen's invite sheet (./made.tsx InviteSheet):
 * the note and the link on the clipboard, the first press included, when the
 * link is still being made.
 *
 * Safari copies only while it is handling the press itself. The sheet makes
 * its link on the first press (POST /api/apps/:slug/invite-links), and a
 * press that has waited on that request is no longer one Safari will copy
 * for: `writeText` after it is refused (#4180). So a link still on its way
 * goes on the clipboard from inside the press, as a promise:
 * `clipboard.write` with a `ClipboardItem` whose text arrives later, and the
 * browser holds the write open until it does (the way Safari asks for it).
 * A link already made is written at once. Without ClipboardItem, or when that
 * write is refused, the text is copied once it is here, by `writeText` and
 * then the hidden textarea (../message-actions/clipboard.ts legacyCopy),
 * which other browsers still allow that soon after a press.
 *
 * The link is never made early to have it ready. Making one is the invite
 * going out as far as anything counts it: the `invite_link_created` event,
 * and the admin Journey's first-session "invited", which is the maker's first
 * link for the project (services/journey.js). Opening the sheet and closing
 * it again sends nothing, so it makes nothing.
 */

import { legacyCopy } from '../message-actions/clipboard';

/** 'no-link': the promise brought no text (the link was not made; the caller says why). */
export type CopyOutcome = 'copied' | 'no-link' | 'refused';

type ClipboardLike = {
  write?: (items: unknown[]) => Promise<void>;
  writeText?: (text: string) => Promise<void>;
};

type ClipboardItemLike = new (items: Record<string, Promise<Blob>>) => unknown;

/** What copying uses: the browser's own, unless a test hands in its own. */
export type CopyEnv = {
  clipboard?: ClipboardLike | null;
  Item?: ClipboardItemLike | null;
  fallback?: (text: string) => boolean;
};

function browserEnv(): CopyEnv {
  const host = globalThis as unknown as { navigator?: { clipboard?: ClipboardLike }; ClipboardItem?: ClipboardItemLike };
  return { clipboard: host.navigator?.clipboard ?? null, Item: host.ClipboardItem ?? null, fallback: legacyCopy };
}

/** What is copied: their note, then the link, as the share sheet sends them. */
export function inviteText(note: string, url: string): string {
  const said = note.trim();
  return said ? `${said} ${url}` : url;
}

/**
 * The link with its short `via` tag (#6540): how it went out. A chat app
 * that names no referrer still leaves this, so the invite landing can say
 * whether the link was copied or shared. The address is unchanged when it
 * cannot be parsed.
 */
export function withVia(url: string, via: 'copied' | 'shared'): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('via', via);
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Put `text` on the clipboard. Call it in the press, before anything is
 * awaited: a string is written at once, and a promise is handed to the
 * clipboard there and then.
 */
export async function copyText(text: string | Promise<string | null>, env: CopyEnv = browserEnv()): Promise<CopyOutcome> {
  const { clipboard, Item, fallback } = env;
  let now: string | null;
  if (typeof text === 'string') {
    now = text;
  } else {
    if (clipboard && typeof clipboard.write === 'function' && typeof Item === 'function') {
      const blob = text.then((t) => {
        if (t == null) throw new Error('no link');
        return new Blob([t], { type: 'text/plain' });
      });
      // The write settles it; a write that never took it must not leave an
      // unhandled rejection behind (a console error on the page).
      blob.catch(() => {});
      try {
        await clipboard.write([new Item({ 'text/plain': blob })]);
        return 'copied';
      } catch { /* refused, or no link: below */ }
    }
    now = await text.catch(() => null);
    if (now == null) return 'no-link';
  }
  try {
    if (clipboard && typeof clipboard.writeText === 'function') {
      await clipboard.writeText(now);
      return 'copied';
    }
  } catch { /* the hidden textarea */ }
  return fallback && fallback(now) ? 'copied' : 'refused';
}
