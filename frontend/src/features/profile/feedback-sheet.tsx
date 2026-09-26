/**
 * `#profile-feedback-sheet` — "Your feedback" (#3186): what the viewer sent
 * through the feedback dialog, where it went, its status, and a link to the
 * request each one became.
 *
 * The same presentation as ./profile-edit-sheet.tsx, on purpose: rendered
 * inside #profile-root while `feedbackOpen` is set, and handed to the native
 * kit's MODAL by lib/kit-surface.ts. The modal and not the bottom sheet for
 * the reason #1285 moved the editor: `.un-modal` is a real scroller, while the
 * kit sheet takes every vertical drag as a drag of the sheet, so a list longer
 * than the screen could not be scrolled in it. With no kit the card simply
 * stays where React put it, at the top of the screen.
 *
 * The constraints are the editor's, for the same reasons: the root and card
 * class strings are constants (the kit writes `platform-modal-adopted` and
 * `platform-modal-card` onto them), the root is the flagged node and the card
 * the lifted one, and the card is brought home in the layout-effect cleanup,
 * before React removes it.
 *
 * Everything the list SAYS is ./profile-store.js's feedbackListView, where the
 * node suite can reach it; this file only turns it into elements.
 */

import { useRef, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { GroupedList, ListRow } from '@/components/ui/grouped-list';
import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { adoptKitSurface, type KitAdoption } from '../../lib/kit-surface';
import { Profile } from './profile.js';

/** The no-kit card chrome, on the node the kit flags. Constant. */
const ROOT_CLASS = 'rounded-2xl bg-white dark:bg-zinc-900 mb-5';

/** The lifted card. Constant, and `flex flex-col` for the #1285 reason. */
const CARD_CLASS = 'flex flex-col px-4 pb-5';

const NOTE_CLASS = 'text-sm text-zinc-500 dark:text-zinc-400';

// × as a character: this is text, not HTML source.
const TIMES = '×';

export interface FeedbackRowView {
  key: string;
  title: string;
  meta: string;
  status: 'received' | 'counted';
  statusLabel: string;
  statusClassName: string;
  href: string | null;
}

export interface FeedbackListView {
  loaded: boolean;
  summary: string | null;
  truncated: boolean;
  rows: FeedbackRowView[];
}

function Rows({ view }: { view: FeedbackListView }): ReactNode {
  if (!view.loaded) {
    return (
      <p id="profile-feedback-error" className={`${NOTE_CLASS} py-6 text-center`}>
        Your feedback could not be loaded. Check your connection and try again.
      </p>
    );
  }
  if (!view.rows.length) {
    return (
      <p id="profile-feedback-empty" className={`${NOTE_CLASS} py-6 text-center`}>
        Nothing sent yet. Feedback you send shows up here, with its status.
      </p>
    );
  }
  return (
    <>
      <GroupedList id="profile-feedback-list" className="mx-0">
        {view.rows.map((row) => (
          <ListRow
            key={row.key}
            as={row.href ? 'a' : 'div'}
            href={row.href || undefined}
            data-feedback-report={row.key}
            data-feedback-status={row.status}
            // Leaving for the request closes the list first, as the editor's
            // links do; the back record is spent after the navigation lands.
            onClick={row.href ? () => Profile._dismissFeedback() : undefined}
            title={row.title}
            titleClassName="text-[0.9375rem] font-semibold whitespace-normal line-clamp-2"
            // The status leads the second line rather than taking the row's
            // trailing edge: on a phone a chip and a chevron side by side
            // left the title two words a line.
            subtitle={(
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className={row.statusClassName}>{row.statusLabel}</span>
                <span>{row.meta}</span>
              </span>
            )}
            subtitleClassName="mt-1 text-[0.8125rem] whitespace-normal"
            chevron={!!row.href}
          />
        ))}
      </GroupedList>
      {view.truncated ? (
        <p className={`${NOTE_CLASS} mt-3`}>Showing the 50 you sent most recently.</p>
      ) : null}
    </>
  );
}

export function FeedbackSheet({ view }: { view: FeedbackListView }): ReactNode {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Hand the card to the native kit, exactly once, and put it back before
  // React ever tries to remove it. Same shape as the editor's.
  useIsomorphicLayoutEffect(() => {
    const contentEl = panelRef.current;
    const flagEl = rootRef.current;
    if (!contentEl || !flagEl) return;
    let adoption: KitAdoption | null = null;
    adoption = adoptKitSurface({
      kind: 'modal',
      contentEl,
      adoptedOn: flagEl,
      home: 'placeholder',
      gate: 'kit',
      // The backdrop or Escape. The teardown below dismisses the kit too, and
      // that callback lands here after the exit fade; `adoption` is already
      // cleared by then, so it is ignored.
      onDismiss: () => {
        if (!adoption) return;
        adoption = null;
        Profile._dismissFeedback();
      },
    });
    return () => {
      if (!adoption) return;
      const handle = adoption;
      adoption = null;
      handle.release();
    };
  }, []);

  return (
    <div id="profile-feedback-root" ref={rootRef} className={ROOT_CLASS}>
      <div id="profile-feedback-sheet" ref={panelRef} className={CARD_CLASS}>
        <div className="flex items-center justify-between gap-3 pt-3">
          <h2 className="text-lg font-bold">Your feedback</h2>
          <Button
            id="profile-feedback-close"
            variant="neutral"
            size="sm"
            ink="neutral"
            aria-label="Close your feedback"
            onClick={() => Profile._dismissFeedback()}
          >
            {TIMES}
          </Button>
        </div>
        {view.summary ? (
          <p id="profile-feedback-summary" className={`${NOTE_CLASS} mt-0.5`}>{view.summary}</p>
        ) : null}
        {/* What the two statuses mean, once, above the rows that wear them. */}
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-2 mb-3">
          Received: it was filed as a request. Counted: it earned points in the
          feedback challenge.
        </p>
        <Rows view={view} />
      </div>
    </div>
  );
}
