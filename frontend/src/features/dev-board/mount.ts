/**
 * The legacy → React seam for the Dev board's runtime-injected regions
 * (#1084 chunk G; folded into the main React tree by #1085 chunk H).
 *
 * `public/js/app-view.js` is a classic script that runs before this bundle, so
 * it cannot import anything from here. It calls by name instead:
 * `window.UsernodeReact.devBoard.mountBoard(host, props)` where it used to
 * assign `content.innerHTML = …`.
 *
 * ── Why this is published at module scope, not from an effect ───────────
 *
 * ../../lib/legacy-dom.ts's `useLegacyBridge` publishes an island's controller
 * from a mount effect and queues anything the legacy side called first. That
 * shape is wrong here: these functions are not a controller for an already-
 * mounted island, they are what CREATES the mount, so queueing a call would mean
 * the Dev route paints nothing until something else flushed the queue. Publishing
 * at module-evaluation time — main.tsx imports this file above its
 * `hydrateRoot` — means the API exists before hydration, and therefore long
 * before `App.switchTab()` can reach `renderDevView()` on DOMContentLoaded. That
 * is the same ordering guarantee `initOffline()` relies on, for the same reason.
 *
 * The `typeof window !== 'undefined'` guard is not decoration: the SSG prerender
 * pass (frontend/scripts/build-shell.mjs) evaluates the whole module graph in
 * Node, and this file is in it.
 */

import { createElement } from 'react';
import { flushSync } from 'react-dom';

import {
  mountLegacyPortal,
  unmountAllLegacyPortals,
  unmountLegacyPortal,
  legacyPortalCount,
} from '../../lib/legacy-portals';
import { AttrPopover } from './attr-popover';
import { attrPopoverStore, type AttrPopoverState } from './attr-popover-store';
import { DevBoardFrame, type DevBoardFrameProps } from './board-frame';
import { CardMenu } from './card-menu';
import { menuIconElement } from './menu-icons';
import { cardMenuStore, type CardMenuRowView } from './card-menu-store';
import { DevChatSubView } from './chat-frame';
import { KanbanFilters } from './kanban-filters';
import { mainPauseStore, type MainPauseState } from './main-pause-store';
import { releaseStallStore, type ReleaseStallState } from './release-stall-store';
import { codePauseStore, type CodePauseState } from './code-pause-store';
import { discussionStore, type DiscussionState } from './discussion-store';
import { kanbanFiltersStore, type KanbanFiltersState } from './kanban-filters-store';
import { DevSessionShell } from './session-frame';
import { VotingHelp, type VotingHelpProps } from './voting-help';
import { DevTopicSubView } from './topic-frame';
import { publishViewMode } from './view-mode-store';
import { publishDevActions } from './actions-store';
import { publishWorkshopGroup } from './workshop/group-mode-store';
import { publishInviteOffer, type InviteOffer } from './workshop/invite-offer';
import {
  aiEnabledStore,
  cardNowStore,
  publishVoteSaved,
  publishVoteSending,
  devKanbanStore,
  devWorkshopStore,
  voteSavedStore,
} from './card/cards-store';
import { DevKanban } from './card/dev-kanban';
import type { DevKanbanView, DevWorkshopView } from './card/model';
import { DevWorkshop, withoutSavedVotes } from './workshop/workshop';
import { TopicHead } from './topic/topic-head';
import { topicHeadStore, type TopicHeadState } from './topic/topic-store';
import { publishRequestThread } from './topic/request-model';
import { askVotesInView } from './topic/votes-in-view';
import type { TranscriptMessage } from '../group-chat/transcript-store';
import { AutoSessionModal } from './modals/auto-session-modal';
import { SessionChecks, type SessionChecksProps } from './modals/session-checks';
import { CreditOptionsModal } from './modals/credit-options-modal';
import { LlmConsentModal } from './modals/llm-consent-modal';
import { PermissionConsentModal } from './modals/permission-consent-modal';
import {
  autoSessionModalStore,
  creditOptionsModalStore,
  llmConsentModalStore,
  permissionConsentModalStore,
} from './modals/modals-store';
import type {
  AutoSessionModalView,
  CreditOptionsModalView,
  LlmConsentModalView,
  PermissionConsentModalView,
} from './modals/model';

/** What app-view.js passes for the card list. */
export interface MountBoardOptions extends DevBoardFrameProps {
  /** `AppView._getViewMode()`, used to seed the store before the first render. */
  viewMode: string;
}

export interface DevBoardBridge {
  mountBoard(host: Element | null, options: MountBoardOptions): void;
  mountChatSubView(host: Element | null): void;
  mountTopicSubView(
    host: Element | null,
    options: { backHref: string; onBackClick: (event: MouseEvent) => void },
  ): void;
  mountAttrPopover(host: Element | null): void;
  publishAttrPopover(patch: Partial<AttrPopoverState>): void;
  mountCardMenu(host: Element | null): void;
  publishCardMenu(rows: CardMenuRowView[]): void;
  /** A ⋯ row's line icon as a detached svg element, for the kit's action sheet (`iconEl`). */
  menuIconElement(key: string): Element | null;
  publishMainPause(state: MainPauseState): void;
  publishReleaseStall(state: ReleaseStallState): void;
  publishCodePause(state: CodePauseState): void;
  publishDiscussion(state: DiscussionState): void;
  mountKanbanFilters(host: Element | null): void;
  publishKanbanFilters(patch: Partial<KanbanFiltersState>): void;
  mountVotingHelp(host: Element | null, props: VotingHelpProps): void;
  mountSessionShell(host: Element | null): void;
  mountWorkshop(host: Element | null): void;
  publishWorkshop(view: DevWorkshopView): void;
  mountKanban(host: Element | null): void;
  publishKanban(view: DevKanbanView): void;
  mountTopicHead(host: Element | null): void;
  publishTopicHead(state: TopicHeadState): void;
  /** #4453: a request's stream, as `GroupChat.renderThread` publishes it — for its spec cards. */
  publishRequestThread(number: number, rows: TranscriptMessage[]): void;
  mountAutoSessionModal(host: Element | null, view: AutoSessionModalView): void;
  mountSessionChecks(host: Element | null, props: SessionChecksProps): void;
  mountCreditOptionsModal(host: Element | null, view: CreditOptionsModalView): void;
  mountLlmConsentModal(host: Element | null, view: LlmConsentModalView): void;
  mountPermissionConsentModal(host: Element | null, view: PermissionConsentModalView): void;
  publishCardNow(now: number): void;
  publishAiEnabled(enabled: boolean): void;
  /** #3984: a vote on its way, by `<fn>:<id>`; null clears it (cards-store.ts). */
  publishVoteSending(key: string, side: 'yes' | 'no' | null): void;
  /** #5463: a vote the server saved, by session id and epoch (cards-store.ts). */
  publishVoteSaved(sessionId: number, vote: 'yes' | 'no' | null, epoch: number | null): void;
  /** Run four (13 Oct 2026): the next page of change `sessionId` opens at its Votes card (topic/votes-in-view.ts). */
  showVotes(sessionId: number): void;
  publishViewMode(mode: string): void;
  publishWorkshopGroup(mode: string): void;
  /** #3700: the invite link a project's page was opened from (App._followInvite). */
  publishInviteOffer(offer: InviteOffer | null): void;
  unmount(host: Element | null): void;
  unmountAll(): void;
  /** Live portal count — the leak assertion in tests reads this. */
  rootCount(): number;
}

/**
 * `setFlush(flushSync)` on the picker's store, and it is load-bearing twice:
 * `_renderAttrPopoverBody` focuses (and sometimes selects) the add box on the
 * line after it publishes, and `_openAttrPopover` re-measures the popover's
 * height once the real body has replaced the "Loading…" line — a popover
 * anchored low in the viewport has to flip above its chip, and a measurement
 * taken against the previous frame would place it off screen.
 */
attrPopoverStore.setFlush(flushSync);

/**
 * And the ⋯ menu's, for two reads on the lines after the publish:
 * `_positionCardMenu` measures the menu's width and height to decide whether
 * it flips above its trigger, and `_toggleCardMenu` focuses the first enabled
 * row. Both would run against an empty menu if the update were batched.
 */
cardMenuStore.setFlush(flushSync);

/**
 * The filter bar's too: `_renderKanbanFilterBar` mounts and publishes, and the
 * kanban entry path reads the bar back — and dismissing the Search chip
 * publishes a new `seq` and then repaints the board, which must not see a
 * half-applied bar.
 */
kanbanFiltersStore.setFlush(flushSync);

/**
 * And every card surface: each publish replaces what used to be an
 * `innerHTML` assignment whose caller's NEXT LINES read the fresh DOM —
 * `_rerenderWorkshop` wires the comment observer and fills the kudos hosts,
 * `_repaintKanbanBoard` re-binds drag and re-anchors an open ⋯ menu, and
 * `_renderTopicHead` binds the transcript toggle it just painted around
 * the card. cardNowStore ticks inside no such read, but flushing it keeps
 * a countdown label and its expiry refetch on the same beat.
 */
devWorkshopStore.setFlush(flushSync);
devKanbanStore.setFlush(flushSync);
cardNowStore.setFlush(flushSync);
// The topic head's too, and it is load-bearing three times:
// `_renderTopicHead` fills the kudos hosts it just rendered,
// `_loadSessionTranscript` fills the transcript body on the line after the
// repaint that opened it, and a request's page portals its header and back
// chip into the thread shell's hosts in the same paint (#4453).
topicHeadStore.setFlush(flushSync);

/**
 * And the three body-mounted modals'. Each `_show*Modal` appends its scrim to
 * `<body>` and then binds the dialog's dismissal by querying inside it, so
 * the card has to be in the DOM on the next line — the same contract the
 * `innerHTML` assignment these replace gave them.
 */
autoSessionModalStore.setFlush(flushSync);
creditOptionsModalStore.setFlush(flushSync);
llmConsentModalStore.setFlush(flushSync);
permissionConsentModalStore.setFlush(flushSync);

export const devBoardBridge: DevBoardBridge = {
  mountBoard(host, options) {
    // Seed before the first render so a cold `?view=kanban` deep link paints
    // kanban immediately rather than list-then-kanban.
    publishViewMode(options.viewMode);
    // The toolbar's six flags, for the Workshop's separate root — see
    // ./actions-store.ts. Published BEFORE the frame renders, so whichever
    // surface draws the row has them on its first paint.
    publishDevActions({
      illustrationApp: options.illustrationApp,
      canManageIllustration: options.canManageIllustration,
      selfHosted: options.selfHosted,
      readOnly: options.readOnly,
      canCollaborate: options.canCollaborate,
      showsMembers: options.showsMembers,
    });
    // `viewMode` seeds the store and is not a frame prop — the frame draws no
    // Kanban|Feed control any more (the choice lives under the Improve panel's
    // Board row), so it is dropped here rather than forwarded.
    const { viewMode: _viewMode, ...rest } = options;
    mountLegacyPortal(host, createElement(DevBoardFrame, rest));
  },

  // Activity is a first-class destination with no in-frame back control
  // (Streamlined Concept), so the mount takes no back-bar props.
  mountChatSubView(host) {
    mountLegacyPortal(host, createElement(DevChatSubView));
  },

  // Like the chat sub-view above: the frame takes no back-bar props. The
  // topic page's back control is the "‹ Workshop" chip at the top of its
  // head (#2916, topic/topic-back.tsx), rendered by TopicHead, not this frame.
  mountTopicSubView(host) {
    mountLegacyPortal(host, createElement(DevTopicSubView));
  },

  // The metadata picker a card's chip opens. Its host is created and removed
  // by app-view.js on every open, so this mounts once per open; the previous
  // open's entry is swept by `pruneDetachedLegacyPortals`.
  mountAttrPopover(host) {
    mountLegacyPortal(host, createElement(AttrPopover));
  },

  // A patch, not a whole publish: the typeahead updates `suggestions` and
  // nothing else, and it runs while the rows are already on screen.
  publishAttrPopover(patch) {
    attrPopoverStore.set((s) => ({ ...s, ...patch }));
  },

  // The card's ⋯ menu. Its host is created on open and removed on close, but
  // it SURVIVES a board repaint — see ./card-menu-store.ts — so the rows are a
  // publish rather than a re-mount.
  mountCardMenu(host) {
    mountLegacyPortal(host, createElement(CardMenu));
  },

  publishCardMenu(rows) {
    cardMenuStore.set({ rows });
  },

  // The touch sheet's rows are the kit's, built from data by app-view.js; it
  // asks here for each row's icon (./menu-icons.tsx, audit D08).
  menuIconElement(key) {
    return menuIconElement(key);
  },

  // Whether a red main is pausing the app's merges, and for whom the banner
  // carries the resume verb — see ./main-pause-store.ts. Published with the
  // promoted list.
  publishMainPause(state) {
    mainPauseStore.set(state);
  },

  // A merged commit of the platform's own app that has not become the
  // running release — see ./release-stall-store.ts. Published with the
  // promoted list, beside the two notices above.
  publishReleaseStall(state) {
    releaseStallStore.set(state);
  },

  // Whether changes to this project's code are paused while Homeroom moves
  // off GitHub — see ./code-pause-store.ts. Published from the app record,
  // beside the two notices above.
  publishCodePause(state) {
    codePauseStore.set(state);
  },

  // Where the app's general chat is, and the last thing said in it — see
  // ./discussion-store.ts. Published on every card-list paint (so the card's
  // href follows an app-to-app hop immediately) and again when the one
  // request for the newest message lands.
  publishDiscussion(state) {
    discussionStore.set(state);
  },

  // The shared Board/Activity filter strip. Its initial `mounted: false`
  // state draws no children while data loads; the frame keeps the host's
  // one-row reservation in place until this mount and publish fill it.
  mountKanbanFilters(host) {
    mountLegacyPortal(host, createElement(KanbanFilters));
  },

  publishKanbanFilters(patch) {
    kanbanFiltersStore.set((s) => ({ ...s, ...patch }));
  },

  // Read-only, computed once at open: the props ARE the publish.
  mountVotingHelp(host, props) {
    mountLegacyPortal(host, createElement(VotingHelp, props));
  },

  mountSessionShell(host) {
    mountLegacyPortal(host, createElement(DevSessionShell));
  },

  // ── The card surfaces ──────────────────────────────────────────────
  //
  // Both list hosts stay app-view.js's (`_repaintDevBody` writes them into
  // #dev-body); the module mounts once per host occupancy and PUBLISHES on
  // every repaint. The stores flush synchronously (below) because the
  // repaint paths read the fresh DOM on their next lines — `Kudos.attach`,
  // `_wireFeedComments`, `_initKanbanDrag`, `_reanchorCardMenu`.
  mountWorkshop(host) {
    mountLegacyPortal(host, createElement(DevWorkshop));
  },

  publishWorkshop(view) {
    // #5466: the queue goes through the saved-vote strip at the door, the
    // same rule the store listener in workshop.tsx applies after a vote
    // lands (voteSavedStore). `_overlayPendingVote` already fills a read
    // that started before the vote; this keeps the store honest whatever
    // list the publish came from, so a later publish built from a pre-vote
    // list cannot bring the row back.
    devWorkshopStore.set({ ...view, queue: withoutSavedVotes(view.queue, voteSavedStore.get()) });
  },

  mountKanban(host) {
    mountLegacyPortal(host, createElement(DevKanban));
  },

  publishKanban(view) {
    devKanbanStore.set(view);
  },

  // The opened topic's whole head — the card AND everything under it.
  // `_renderTopicHead` mounts per paint into `#gc-thread-head`, which the
  // thread panel owns; the previous entry is swept as detached.
  mountTopicHead(host) {
    mountLegacyPortal(host, createElement(TopicHead));
  },

  publishTopicHead(state) {
    topicHeadStore.set(state);
  },

  publishRequestThread(number, rows) {
    publishRequestThread(Number(number), rows || []);
  },

  // The three body-mounted modals. Each host is created by app-view.js on
  // every open and removed on close, so the view rides in with the mount
  // rather than through a separate publish: there is no "already open"
  // state to update, and a mount-then-publish pair would render the scrim
  // empty for one frame.
  mountAutoSessionModal(host, view) {
    autoSessionModalStore.set({ view });
    mountLegacyPortal(host, createElement(AutoSessionModal));
  },

  mountSessionChecks(host, props) {
    mountLegacyPortal(host, createElement(SessionChecks, props));
  },

  mountCreditOptionsModal(host, view) {
    creditOptionsModalStore.set({ view });
    mountLegacyPortal(host, createElement(CreditOptionsModal));
  },

  mountLlmConsentModal(host, view) {
    llmConsentModalStore.set({ view });
    mountLegacyPortal(host, createElement(LlmConsentModal));
  },

  mountPermissionConsentModal(host, view) {
    permissionConsentModalStore.set({ view });
    mountLegacyPortal(host, createElement(PermissionConsentModal));
  },

  // The 30s countdown tick (see card/dev-card.tsx's header).
  publishCardNow(now) {
    cardNowStore.set({ now });
  },

  // `/api/budget`'s aiEnabled answer, for the Explore pills.
  publishAiEnabled(enabled) {
    aiEnabledStore.set({ enabled });
  },

  // #3984: a vote on its way (castVote / castIssueVote), for the Vote button.
  publishVoteSending,

  // #5463: a vote the server took, for every Needs you surface that did not
  // cast it — the Communities feed's kept copy and its counts, and a board
  // read from before the vote (cards-store.ts voteSavedStore).
  publishVoteSaved,

  // A door that sends someone to vote: the change's page opens at its Votes card.
  showVotes: (sessionId: number) => askVotesInView(sessionId),

  publishViewMode,
  publishWorkshopGroup,
  publishInviteOffer,
  unmount: unmountLegacyPortal,
  unmountAll: unmountAllLegacyPortals,
  rootCount: legacyPortalCount,
};

if (typeof window !== 'undefined') {
  const host = window as unknown as { UsernodeReact?: Record<string, unknown> };
  const bridge = (host.UsernodeReact ||= {});
  bridge.devBoard = devBoardBridge;
}
