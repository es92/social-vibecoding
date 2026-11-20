/**
 * THE DETAIL COLUMN'S CONTENTS (#6230, 3 Nov 2026): what a thread opened to
 * read beside it, drawn by kind. One column, three tenants —
 *
 *   design   a design's preview, ../messages/design-pane.tsx, unchanged
 *   plan     the shared-spec reader's contents, ../group-chat/spec-panel.tsx,
 *            unchanged (its two tabs, Copy markdown, its ×)
 *   shots    a change's before and after viewer, rendered inline instead of
 *            in the popover it used to open
 *   preview  a change's running preview, which the staging overlay draws
 *            over this column's placeholder
 *
 * The store is ../ai/detail.ts; this module only draws it.
 */

import type { ReactNode } from 'react';

import { DetailPaneShots } from './shots';
import { DetailCard, useDetailLabel } from './detail-card';
import { DesignPane } from '../messages/design-pane';
import { RequestDraftPane } from '../messages/request-draft-pane';
import { SpecPanelView } from '../group-chat/spec-panel';
import { closeDetail, useDetailState, type DetailLayout, type DetailState } from '../ai/detail';
import { useMessages } from '../../lib/i18n/react';
import { useStoreState } from '../../lib/use-store-state';
import { stagingStore } from '../staging/staging-store.js';

/** #6248: a draft preview with no copy of its own (it always carries one). */
const EMPTY_DRAFT_COPY = { title: '', project: '', details: '', appSlug: null };

/**
 * `card` (20 Nov 2026): beside a thread on the Homeroom bot tab, drawn as
 * cards with a head card and its picker (./detail-card.tsx). The other
 * surfaces (a request's page, the Workshop) keep the panel they had.
 */
export function DetailPane({ layout, card = false }: { layout: DetailLayout; card?: boolean }): ReactNode {
  const state = useDetailState();
  const entry = state.entry;
  if (!entry) return null;
  const body = <DetailBody state={state} layout={layout} />;
  return card ? <DetailCard key={entry.owner || ''} entry={entry} layout={layout}>{body}</DetailCard> : body;
}

/** A running preview's place, and its words for the head card. */
function PreviewSlot(): ReactNode {
  const t = useMessages('messages');
  const staging = useStoreState(stagingStore) as { changeTitle?: string | null; appName?: string | null };
  useDetailLabel({ title: staging.changeTitle || t('messages:detail.kind.preview'), line: staging.appName || null });
  return <div className="detail-preview-slot" data-preview-slot="" aria-hidden="true" />;
}

function DetailBody({ state, layout }: { state: DetailState; layout: DetailLayout }): ReactNode {
  const entry = state.entry;
  if (!entry) return null;
  if (entry.kind === 'design') {
    return (
      <DesignPane
        conversationId={entry.ref.conversationId!}
        rootId={entry.ref.rootId!}
        view="preview"
        onView={() => {}}
        version={entry.version}
        seq={entry.seq}
        onClose={closeDetail}
        closeAs={layout === 'full' ? 'back' : 'close'}
      />
    );
  }
  if (entry.kind === 'draft') {
    return (
      <RequestDraftPane
        actionId={entry.ref.actionId!}
        copy={entry.payload?.draft || EMPTY_DRAFT_COPY}
        seq={entry.seq}
        onClose={closeDetail}
        closeAs={layout === 'full' ? 'back' : 'close'}
      />
    );
  }
  if (entry.kind === 'shots') return <DetailPaneShots entry={entry} layout={layout} />;
  // A change's running preview: the column makes room and draws nothing of
  // its own. The staging overlay stands over this placeholder, because the
  // preview's frame must never move (../staging/placement.ts).
  if (entry.kind === 'preview') return <PreviewSlot />;
  return (
    <SpecPanelView
      open
      title={state.title}
      subtitle={state.subtitle}
      canCopy={state.canCopy}
      body={state.body}
      raw={state.raw}
      closeAs={layout === 'full' ? 'back' : 'close'}
    />
  );
}
