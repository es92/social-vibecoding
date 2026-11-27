/**
 * THE THREAD'S PAGE, ONE FOR PUBLIC AND PRIVATE THREADS (20 Nov 2026).
 *
 * A request's page, a change's, a governance vote's and a private thread
 * with Homeroom bot are one page: its way back, a head that floats over the
 * top of a scroller and tightens as it scrolls, the cards on the page's own
 * ground under it, and the reply box at its foot, as wide as the cards. The
 * public ones are filled by the group chat (./thread-shell.tsx RequestShell
 * hands it the hosts `GroupChat.mountThread` and the topic head portal
 * into); a private thread is filled by Messages (../messages/index.tsx
 * ReplyThreadPanel, alone in the bot tab's column).
 *
 * The private thread was a copy until now (#6863: "one compact sheet of
 * cards"), its own markup and thirty rules of its own, and it drifted from
 * the public page within a day. Both now render this, and app.css draws them
 * from one set of rules ("ONE THREAD, ONE HEADER" and the blocks after it),
 * which read these classes: `.dev-request` (`.dev-change`, `.dev-decision`,
 * `.dev-private-thread`), `.dev-request-back`, `.dev-request-sheet`,
 * `.dev-request-bar` and `.dev-request-scroll`.
 *
 * `hosts` gives the public page's elements the group chat's ids, which the
 * legacy module and the declared checks find them by. A private page has
 * none: two `#gc-thread-scroll`s in one document would be one too many.
 */

import type { HTMLAttributes, ReactNode, RefObject } from 'react';

export type ThreadPageKind = 'request' | 'change' | 'decision' | 'private';

const KIND_CLASS: Record<ThreadPageKind, string> = {
  request: 'dev-request platform-kb-column',
  change: 'dev-request dev-change platform-kb-column',
  decision: 'dev-request dev-decision platform-kb-column',
  // The bot tab's column already reserves the keyboard (its pane is the
  // `platform-kb-column`), so the page inside it does not do so twice.
  private: 'dev-request dev-private-thread',
};

export function ThreadPage({ kind, label, hosts = false, back = null, bar = null, sheet, sheetProps, scroller, scrollClassName = '', scrollProps, children = null, foot = null }: {
  kind: ThreadPageKind;
  /** The sheet's accessible name. */
  label: string;
  /** The public page: the hosts carry the group chat's ids. */
  hosts?: boolean;
  /** The way back, drawn as a disc at the head's start. */
  back?: ReactNode;
  /** The head card (../dev-board/topic/thread-head.tsx). */
  bar?: ReactNode;
  sheet?: RefObject<HTMLElement | null>;
  /** More on the sheet: a public page's drop zone (./thread-shell.tsx). */
  sheetProps?: HTMLAttributes<HTMLElement>;
  scroller: RefObject<HTMLDivElement | null>;
  /** More classes for the scroller (a chat's own, such as `platform-safe-scroll`). */
  scrollClassName?: string;
  scrollProps?: HTMLAttributes<HTMLDivElement>;
  /** What scrolls: the cards. */
  children?: ReactNode;
  /** After the scroller: Jump to latest, the status line, the reply box. */
  foot?: ReactNode;
}): ReactNode {
  return (
    <div className={KIND_CLASS[kind]} data-thread-page={kind}>
      <div id={hosts ? 'gc-thread-back' : undefined} className="dev-request-back">{back}</div>
      <section {...sheetProps} ref={sheet} className="dev-request-sheet dc-lift dc-lift-session" aria-label={label}>
        <div id={hosts ? 'gc-thread-bar' : undefined} className="dev-request-bar">{bar}</div>
        <div
          {...scrollProps}
          ref={scroller}
          id={hosts ? 'gc-thread-scroll' : undefined}
          className={`messages-thread-scroll dev-request-scroll overscroll-contain chat-transcript${scrollClassName ? ` ${scrollClassName}` : ''}`}
        >
          {children}
        </div>
        {foot}
      </section>
    </div>
  );
}
