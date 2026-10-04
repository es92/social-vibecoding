/**
 * ONE bundle exporting the Dev card components AND the stores they read.
 *
 * `loadTsx` bundles each entry point separately, so a test that loaded
 * `workshop/workshop.tsx` and `card/cards-store.ts` as two entries would get two
 * copies of the module graph and therefore two distinct store instances —
 * publishing into one and rendering the other. Re-exporting both from a
 * single entry is what keeps them the same objects. Same reason
 * ./group-chat-transcript-api.ts exists.
 */

export { ActionButton, DevCard, StatusPill, Badge, Preview, CardIcon, fmtCountdown, voteFillWidths, BADGE_MAX } from '../../frontend/src/features/dev-board/card/dev-card';
export { SessionCheckResults, SessionChecks } from '../../frontend/src/features/dev-board/modals/session-checks';
export { FooterView } from '../../frontend/src/features/dev-board/card/footer';
export { DevWorkshop, orderThemesStable } from '../../frontend/src/features/dev-board/workshop/workshop';
export { publishWorkshopGroup } from '../../frontend/src/features/dev-board/workshop/group-mode-store';
export { DevKanban } from '../../frontend/src/features/dev-board/card/dev-kanban';
// #2573: the Workshop's start-here banner gates its button on the SAME store
// field the Improve panel gates its own "New change" row on, so a test that
// wants the read-only viewer has to reach the instance the rendered tree
// reads — which is this bundle's, not a second copy of the module.
export { improveStore } from '../../frontend/src/features/improve/improve-store.js';
export { TopicHead, TopicBodySections, NoteBoxView, ChecksVerdictView, ProposalBody, DetailsBody } from '../../frontend/src/features/dev-board/topic/topic-head';
export { topicHeadStore } from '../../frontend/src/features/dev-board/topic/topic-store';
export { ListRowView } from '../../frontend/src/features/dev-board/card/list-rows';
export {
  devWorkshopStore,
  devKanbanStore,
  cardNowStore,
  aiEnabledStore,
} from '../../frontend/src/features/dev-board/card/cards-store';
