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
import { cardMenuStore, type CardMenuRowView } from './card-menu-store';
import { DevChatSubView } from './chat-frame';
import { IssueComments } from './issue-comments';
import { issueCommentsStore, type IssueCommentsState } from './issue-comments-store';
import { KanbanFilters } from './kanban-filters';
import { lockedNoticeStore } from './locked-notice-store';
import { discussionStore, type DiscussionState } from './discussion-store';
import { kanbanFiltersStore, type KanbanFiltersState } from './kanban-filters-store';
import { DevSessionShell } from './session-frame';
import { VotingHelp, type VotingHelpProps } from './voting-help';
import { DevTopicSubView } from './topic-frame';
import { publishViewMode } from './view-mode-store';
import { publishDevActions } from './actions-store';
import { publishWorkshopGroup } from './workshop/group-mode-store';
import {
  aiEnabledStore,
  cardNowStore,
  devKanbanStore,
  devWorkshopStore,
} from './card/cards-store';
import { DevKanban } from './card/dev-kanban';
import type { DevKanbanView, DevWorkshopView } from './card/model';
import { DevWorkshop } from './workshop/workshop';
import { TopicHead } from './topic/topic-head';
import { topicHeadStore, type TopicHeadState } from './topic/topic-store';
import { AutoSessionModal } from './modals/auto-session-modal';
import { SessionChecks, type SessionChecksProps } from './modals/session-checks';
import { CreditOptionsModal } from './modals/credit-options-modal';
import { LlmConsentModal } from './modals/llm-consent-modal';
import {
  autoSessionModalStore,
  creditOptionsModalStore,
  llmConsentModalStore,
} from './modals/modals-store';
import type {
  AutoSessionModalView,
  CreditOptionsModalView,
  LlmConsentModalView,
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
  publishLockedNotice(locked: boolean, inviteOnly?: boolean): void;
  publishDiscussion(state: DiscussionState): void;
  mountIssueComments(host: Element | null): void;
  publishIssueComments(state: IssueCommentsState): void;
  mountKanbanFilters(host: Element | null): void;
  publishKanbanFilters(patch: Partial<KanbanFiltersState>): void;
  mountVotingHelp(host: Element | null, props: VotingHelpProps): void;
  mountSessionShell(host: Element | null): void;
  mountWorkshop(host: Element | null): void;
  publishWorkshop(view: DevWorkshopView): void;
  mountKanban(host: Element | null): void;
  publishKanban(view: DevKanbanView): void;
  mountTopicHead(host: Element | null): void;
  mountChangePage(host: Element | null): void;
  publishTopicHead(state: TopicHeadState): void;
  mountAutoSessionModal(host: Element | null, view: AutoSessionModalView): void;
  mountSessionChecks(host: Element | null, props: SessionChecksProps): void;
  mountCreditOptionsModal(host: Element | null, view: CreditOptionsModalView): void;
  mountLlmConsentModal(host: Element | null, view: LlmConsentModalView): void;
  publishCardNow(now: number): void;
  publishAiEnabled(enabled: boolean): void;
  publishViewMode(mode: string): void;
  publishWorkshopGroup(mode: string): void;
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
// repaint that opened it, and `_loadIssueComments` mounts into the comment
// host the same way.
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

  // Like the chat sub-view above, and now for the same reason: the topic
  // page's own back bar retired in favour of the platform header's chevron,
  // so this takes no back-bar props either.
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

  publishLockedNotice(locked, inviteOnly = false) {
    lockedNoticeStore.set({ locked, inviteOnly: !!inviteOnly });
  },

  // Where the app's general chat is, and the last thing said in it — see
  // ./discussion-store.ts. Published on every card-list paint (so the card's
  // href follows an app-to-app hop immediately) and again when the one
  // request for the newest message lands.
  publishDiscussion(state) {
    discussionStore.set(state);
  },

  mountIssueComments(host) {
    mountLegacyPortal(host, createElement(IssueComments));
  },

  publishIssueComments(state) {
    issueCommentsStore.set(state);
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
    devWorkshopStore.set(view);
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

  mountChangePage(host) {
    mountLegacyPortal(host, createElement('div', { className: 'dev-change-overview platform-safe-scroll h-full' },
      createElement('div', { id: 'gc-thread-head' }, createElement(TopicHead, { conversation: true }))));
  },

  publishTopicHead(state) {
    topicHeadStore.set(state);
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

  // The 30s countdown tick (see card/dev-card.tsx's header).
  publishCardNow(now) {
    cardNowStore.set({ now });
  },

  // `/api/budget`'s aiEnabled answer, for the Explore pills.
  publishAiEnabled(enabled) {
    aiEnabledStore.set({ enabled });
  },

  publishViewMode,
  publishWorkshopGroup,
  unmount: unmountLegacyPortal,
  unmountAll: unmountAllLegacyPortals,
  rootCount: legacyPortalCount,
};

if (typeof window !== 'undefined') {
  const host = window as unknown as { UsernodeReact?: Record<string, unknown> };
  const bridge = (host.UsernodeReact ||= {});
  bridge.devBoard = devBoardBridge;
}
