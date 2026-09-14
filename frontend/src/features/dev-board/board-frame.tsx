
/**
 * The Dev board's frame, converted from the `innerHTML` template that used to
 * live in `AppView.renderDevView()`'s card-list branch (#1084 chunk G).
 *
 * ── What React owns here, and what it deliberately does not ────────────
 *
 * Exactly the split chunk F established: React owns the FRAME plus the one
 * piece of state that genuinely changes hands (the view mode), and every deep
 * subtree that a `public/js/**` module writes into stays that module's host.
 * Nothing below is a redesign — every element, id, class string, `data-*`
 * attribute and `hidden` semantic is the one the template emitted.
 *
 * React-owned, and now stateful:
 *   * the header bar — the "+" button and its dropdown, including every
 *     `data-plus` row and the two `data-plus-group` headings. The Feed/Kanban
 *     tab strip is NOT here any more: the Board's two layouts are a choice
 *     under the Improve panel's Board row now (see improve-panel.tsx), because
 *     a strip whose first tab restated the destination the header chip had
 *     just named was navigation drawn twice;
 *   * `#dev-forum-scroll` and, on the kanban only, the General-discussion
 *     card. See ./discussion-store.ts for why the board carries it and why the
 *     Feed draws the same fact as an activity row instead.
 *
 * Legacy-owned hosts, rendered by React but never reconciled into:
 *   * `#dev-body` — `AppView._repaintDevBody()` replaces its `innerHTML` on
 *     every tab switch and feed reload, so its initial content is a CONSTANT
 *     `dangerouslySetInnerHTML` OBJECT (`DEV_BODY_INITIAL`). React writes it
 *     once at mount and, because the object's identity never changes, never
 *     looks inside again. The identity is what matters: React 19 diffs host
 *     props by reference and re-assigns `innerHTML` whenever the `{__html}`
 *     wrapper is a new object, even for an identical string — an inline
 *     literal here made every tab click wipe the module's paint back to
 *     "Loading…". Rendering `#dev-feed` as a JSX child instead would make
 *     every view-mode re-render reconcile against nodes the module has since
 *     replaced.
 *   * `#dc-secrets-state` —
 *     a leaf the module writes text or `innerHTML` into. It is safe because
 *     React renders its
 *     `className` as a CONSTANT prop: React
 *     only writes an attribute when the prop CHANGES, so a re-render of this
 *     component does not clobber a class or a string the module has since
 *     written. That is the same rule the dialog islands run under — see the
 *     header of ../../lib/legacy-dom.ts.
 *
 * ── Why the wiring stays in app-view.js ────────────────────────────────
 *
 * `_wirePlusMenu`, `_wireViewToggle`'s companion behaviour, `_attrInit`,
 * `_cardMenuInit`, `PlatformUI.pullToRefresh` and the delegated `#dev-body`
 * click/keydown handlers all attach LISTENERS and toggle `hidden` — the two
 * mutations the migration explicitly sanctions on React-rendered nodes. Moving
 * them would be a rewrite, and this chunk is a conversion. The one exception is
 * `_updateViewToggleUI()`, which assigned `btn.className` outright; that is
 * retired in favour of ./view-mode-store.ts.
 *
 * The frame is mounted by an interim root (../../lib/interim-root.ts) rather
 * than by `<Shell/>`, because `#app-content` ships empty and this surface only
 * exists on the Dev route. Chunk H (#1085) folds it into the main tree.
 */

import { useRef } from 'react';

import type { ReactNode } from 'react';

import {
  AppWindowIcon, ChatIcon, ChevronRightIcon, GitHubIcon, KeyIcon,
  PencilSquareIcon, UserGroupIcon,
} from '@/components/ui/icons';

import { DevActionsRow } from './actions-row';
import { useStoreState } from '../../lib/use-store-state';
import { useDevViewMode } from './view-mode-store';
import { discussionStore, type DiscussionState } from './discussion-store';
import { skeletonKanbanHtml, skeletonListHtml } from './card/skeleton';
import { lockedNoticeStore, lockedNoticeText, type LockedNoticeState } from './locked-notice-store';

/** `AppView.DEV_CARD_CLS`, unchanged. Passed in so there is one source of truth. */
export interface DevBoardFrameProps {
  illustrationApp?: any;
  canManageIllustration?: boolean;
  /** `AppView.appData?.self_hosted` — gates the "Dev" caption and several rows. */
  selfHosted: boolean;
  /** `AppView.readOnly`. */
  readOnly: boolean;
  /** `AppView.appData?.can_collaborate` — gates the Import-from-PR row. */
  canCollaborate: boolean;
  /** `AppView._plusMenuShowsMembers()` — the full predicate stays in the module. */
  showsMembers: boolean;
  /** `AppView.DEV_CARD_CLS`. */
  cardCls: string;
  /** `AppView.DEV_CARD_HOVER_CLS`. */
  cardHoverCls: string;
}


/**
 * `#dev-body`'s initial content, as a constant string — see the header.
 *
 * A SKELETON, not the word "Loading…". The report this answers was that
 * content "loads without you realising it's loading": eleven characters of
 * `text-xs` grey in the top-left of an empty screen is not a state anybody
 * reads, and the eye takes the blank area for an empty board rather than a
 * pending one.
 *
 * TWO constants, one per mode, CHOSEN ONCE PER MOUNT — see `useBodyInitial`
 * below. It was one constant on the argument that "card-shaped rows are a
 * fair first frame for either mode", and they are not: a cold load of
 * `/app/<slug>/board` painted this single column and then became four columns
 * when <DevKanban/> mounted. A skeleton exists to predict the shape of what is
 * coming, so predicting the wrong one is the one thing it must not do.
 *
 * What made this look unavoidable is real and is handled a different way: the
 * prop's identity has to stay stable, because React 19 assigns `innerHTML`
 * whenever the object differs and would rewrite `#dev-body` out from under
 * whatever `_repaintDevBody` had just painted there. So these stay
 * module-scope constants — the same bytes on every render — and the CHOICE
 * between them is frozen at mount rather than followed live. A view toggle
 * does not re-pick: by then the real board owns the node.
 *
 * The list form is the Workshop's (`#dev-workshop`, features/dev-board/
 * workshop/workshop.tsx), which replaced the Activity feed as the Dev
 * screen's lander; the kanban Done column renders its own completed rows.
 */
const DEV_BODY_WORKSHOP_INITIAL = { __html: '<div id="dev-workshop">' + skeletonListHtml(3) + '</div>' };
const DEV_BODY_KANBAN_INITIAL = { __html: skeletonKanbanHtml() };

/**
 * Which of the two this mount opens with, decided ONCE.
 *
 * The mode is known by now: `restoreFromHash` applies `boardView` BEFORE it
 * dispatches, precisely so "a cold entry paints the right layout on the
 * board's first frame" — this is the frame that note is about.
 *
 * A ref rather than the live `useDevViewMode()` value, because the object
 * identity is the contract: re-reading it would hand React a different object
 * the moment somebody toggled the view, and React would assign `innerHTML`
 * over the real board.
 */
function useBodyInitial(): { __html: string } {
  const mode = useDevViewMode();
  const chosen = useRef<{ __html: string } | null>(null);
  if (!chosen.current) {
    chosen.current = mode === 'kanban' ? DEV_BODY_KANBAN_INITIAL : DEV_BODY_WORKSHOP_INITIAL;
  }
  return chosen.current;
}

/**
 * The General-discussion card — the kanban's door to the app's general chat.
 *
 * ── Why it is here and only on the kanban ──────────────────────────────
 *
 * The card shipped, was retired when Activity became a first-class hash for
 * the general chat, and is back because Activity stopped meaning the general
 * chat: the board's recency stream took the name, and the screen it displaced
 * was left reachable only from a notification.
 *
 * It draws on the KANBAN only. The Workshop draws the same fact as one of its
 * own rows (`AppView._discussionCardModel`), in its own place between the
 * strips and the themes, so a second copy above the host would be the
 * discussion twice. The kanban is a prioritised worklist with no such slot,
 * so there the card is chrome above the columns — which is exactly what it
 * always was.
 *
 * ── An anchor ──────────────────────────────────────────────────────────
 *
 * `#app/<slug>/dev/chat` is a real address, so cmd/ctrl-click and "open in new
 * tab" work on it — the rule tests/nav-new-tab.test.js pins across the shell,
 * and the reason the card it replaces (a `<button>` with a delegated handler)
 * is not simply restored as it was.
 *
 * `href: null` — no app open — renders nothing rather than a dead card.
 */
function DiscussionCard({ cardCls, cardHoverCls }: { cardCls: string; cardHoverCls: string }) {
  const mode = useDevViewMode();
  const { href, preview } = useStoreState<DiscussionState>(discussionStore);
  if (mode !== 'kanban' || !href) return null;
  return (
    <div className="px-3 pt-2">
      <a
        id="dev-chat-card"
        href={href}
        className={`${cardCls} ${cardHoverCls}`}
        title="Open the app's general chat"
      >
        <span className="w-9 h-9 rounded-lg bg-violet-600/15 text-violet-700 flex items-center justify-center shrink-0 dark:text-violet-400">
          <ChatIcon className="w-5 h-5" aria-hidden="true" />
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">
            General discussion
          </span>
          {/* The last thing said in it, or the standing description until the
              one request for it lands. RENDERED, not an innerHTML host: the
              card it replaces had `#dev-chat-card-preview` written into by
              `_loadChatCardPreview`, which is two owners of one node. The
              module publishes the line now (./discussion-store.ts). */}
          <span
            id="dev-chat-card-preview"
            className="block text-xs text-zinc-500 dark:text-zinc-400 truncate"
          >
            {preview}
          </span>
        </span>
        <ChevronRightIcon className="w-4 h-4 text-zinc-500 dark:text-zinc-500 shrink-0" />
      </a>
    </div>
  );
}

export function DevBoardFrame({
  illustrationApp,
  canManageIllustration,
  selfHosted,
  readOnly,
  canCollaborate,
  showsMembers,
  cardCls,
  cardHoverCls,
}: DevBoardFrameProps) {
  const { locked, inviteOnly } = useStoreState<LockedNoticeState>(lockedNoticeStore);
  // The toolbar's home depends on the surface — see the DevActionsRow render
  // below. Subscribing the frame to the mode is safe for the one node this
  // file hands to the module: `#dev-body`'s `dangerouslySetInnerHTML` object
  // is ref-stable (useBodyInitial), so a re-render never rewrites it.
  const mode = useDevViewMode();
  const bodyInitial = useBodyInitial();
  return (
    <div className="flex flex-col h-full min-h-0 dc-lift dc-lift-strip">
      {/*
          THE BOARD IS THE STRIP. The dev area is drawn on the lift ladder the
          session view already uses (`.dc-lift` in app.css): this column is
          the frosted strip on the wallpaper, and a topic or the Discussion
          opens as the sheet rising on it (./topic-frame.tsx, ./chat-frame.tsx).
          Nothing inside the column changes.
      */}
      {/*
          THE "DEV" SUB-HEADER ROW IS GONE (#1367 follow-up).

          It carried three things: a "Dev" caption, the Feed/Kanban tabs, and
          the "+" menu. The caption named an area the header already names, the
          tabs are the header's App/Feed/Kanban toggle now (see the note above),
          and with both gone the row was a full-height strip of chrome holding
          one button — so the button moved down to sit with the filter controls
          and the row went.

          `#dev-actions` is that new row, and the "+" sits at its right end with
          the filter controls to its left. The controls are legacy-rendered, so
          the row carries an innerHTML HOST for them rather than the markup —
          the same seam `#dev-body` below already is.

          THE HOST IS OUTSIDE `#dev-body` ON PURPOSE, and it is the whole reason
          this row is shaped this way. `_repaintDevBody()` assigns
          `body.innerHTML` on every view switch; anything living in there is
          destroyed and rebuilt. The "+" is React's — button, menu, listeners —
          so it can never be a child of that node, and moving it in and out
          around each repaint would be a race waiting to happen. Keeping BOTH
          the filter host and the button up here means the row is stable, React
          never reconciles inside the host, and the module never writes outside
          it. `_renderKanbanFilterBar()` fills the shared Board/Activity strip.
      */}
      {/* The toolbar. On the WORKSHOP it renders inside that surface's own
          pane, directly above its By category / By stage tabs and sticky with
          them — see ./workshop/workshop.tsx — so this row would be an empty
          strip of chrome here. Rendering exactly one of the two is also what
          keeps #dev-actions / #dev-plus-btn / #dev-plus-menu unique ids. */}
      {mode === 'workshop' ? null : (
        <DevActionsRow
          illustrationApp={illustrationApp}
          canManageIllustration={canManageIllustration}
          selfHosted={selfHosted}
          readOnly={readOnly}
          canCollaborate={canCollaborate}
          showsMembers={showsMembers}
        />
      )}

      {/* The card list: locked notice, general-chat card, session rows, the
          intermixed feed, and the Completed section. */}
      <div
        id="dev-forum-scroll"
        className="flex-1 min-h-0 overflow-y-auto overscroll-contain platform-safe-scroll"
      >
        {/*
            The locked-app banner. It used to be one of the leaves above — a
            host the module toggled `hidden` on and wrote `innerHTML` into —
            which meant TWO owners of one node's class attribute, tolerated only
            because React rendered that class as a constant. It is a field on
            the view-mode store now, so the node has one writer and the banner
            has one spelling.
        */}
        <div id="dev-locked-notice" className={locked ? 'px-3 pt-2' : 'px-3 pt-2 hidden'}>
          {locked ? (
            // #1896: who can build here, not a warning. The old amber "locked"
            // line read as "you cannot build on this app", which was never
            // true — the lock only adds an admin's approval to the vote.
            <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-3.5 py-2.5 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
              {lockedNoticeText(inviteOnly)}
            </div>
          ) : null}
        </div>
        <DiscussionCard cardCls={cardCls} cardHoverCls={cardHoverCls} />
        {/* Body region: the Workshop mounts #dev-workshop here; Kanban mounts
            #dev-kanban-board. _repaintDevBody() owns the swap. The wrapper
            node is stable across tab switches so the delegated card-open
            handler (bound by the module) survives both. */}
        <div
          id="dev-body"
          className="px-3 py-2"
          dangerouslySetInnerHTML={bodyInitial}
        />
      </div>
    </div>
  );
}
