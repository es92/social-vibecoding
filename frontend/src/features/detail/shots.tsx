/**
 * A change's before and after viewer, inside the detail column (#6230).
 *
 * It used to be a popover (`popover` on `.dev-thread-shots-viewer`, opened by
 * thread-changes.tsx's Expand), which covered the thread it belonged to. The
 * markup is the same — `AppView.shotsHtml`'s thread reading, carried in the
 * store's payload — but it is drawn here, as the column's contents.
 *
 * #6381: the viewer's own toolbar has no way out of the column, so a small
 * head above it closes the before and after, as the design preview beside it
 * does: an × where the column is a column, a back arrow where it is the whole
 * screen (`layout` is the detail store's, ../ai/detail.ts). Clicking it only
 * closes the column: the before and after themselves are untouched.
 */

import { useMemo, type ReactNode } from 'react';

import { ChevronLeftIcon, XIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { closeDetail, type DetailEntry, type DetailLayout } from '../ai/detail';
import { useDetailCard, useDetailLabel } from './detail-card';

export function DetailPaneShots({ entry, layout = 'three' }: { entry: DetailEntry; layout?: DetailLayout }): ReactNode {
  const t = useMessages('chat');
  const c = useMessages('changes');
  const html = String((entry.payload as { html?: string } | undefined)?.html || '');
  const wrapper = useMemo(() => ({ __html: html }), [html]);
  const back = layout === 'full';
  // Beside a thread on the bot tab (20 Nov 2026): the head card says it and closes it.
  const card = useDetailCard();
  const m = useMessages('messages');
  useDetailLabel({ title: m('messages:detail.kind.shots'), line: null });
  const head = card ? null : (
    <div className="gc-detail-shots-head">
      {back ? (
        <button
          type="button"
          className="gc-detail-back"
          onClick={closeDetail}
          aria-label={c('changes:shots.pane.back')}
          title={c('changes:shots.pane.back')}
          data-shots-close="back"
        >
          <ChevronLeftIcon aria-hidden="true" />
        </button>
      ) : (
        <button
          type="button"
          className="gc-detail-shots-close"
          onClick={closeDetail}
          aria-label={c('changes:shots.pane.close')}
          title={c('changes:shots.pane.close')}
          data-shots-close="close"
        >
          <XIcon aria-hidden="true" />
        </button>
      )}
    </div>
  );
  if (!html) {
    // A reload's restored entry has no HTML yet: the request page fills it
    // when the change's ShotsPair renders. Say so rather than draw a blank.
    return (
      <>
        {head}
        <div className="gc-spec-panel-body">
          <div className="gc-spec-panel-error">{t('chat:group.spec.loading')}</div>
        </div>
      </>
    );
  }
  return (
    <>
      {head}
      <div
        className="dev-thread-shots-viewer gc-detail-shots"
        dangerouslySetInnerHTML={wrapper}
      />
    </>
  );
}
