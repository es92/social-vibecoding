/**
 * `#dev-actions` — the Dev screen's toolbar: the shared Board/Workshop filter
 * strip — and `DevPlusMenu`, the "+" and its menu.
 *
 * ── The "+" lives at the end of the Workshop's tab strip ──────────────
 *
 * On the Workshop the "+" is not in this row any more. It is the last item of
 * the view-tab strip — Current status · Needs you · All items · + — on all
 * three tabs, which is where the navigation prototype drew it (`wsTabs`, a
 * `.tplus` closing the `.tabs` row) and where the spec puts it: "a plus at the
 * end of the tab strip holds Add … and Manage". It sat at the end of All
 * items' search row, so two of the three tabs had no way to file an issue or
 * reach the app's settings, and the empty-state notes on those tabs pointed at
 * a "+" that was not on screen. workshop/workshop.tsx renders `DevPlusMenu`
 * inside the strip and this row with `withPlus={false}` in the pane head.
 *
 * The standalone Board surface (./board-frame.tsx), unreachable since 'kanban'
 * retired as a view mode, still draws the row with its "+" at the end — the
 * default — so that surface is unchanged until the sweep that removes it.
 *
 * ── Why it is its own file now ─────────────────────────────────────────
 *
 * It lived in ./board-frame.tsx, in the frame's own chrome above
 * `#dev-forum-scroll`, and that placement carried a hard constraint worth
 * repeating because it still holds HERE:
 *
 *   `_repaintDevBody()` assigns `body.innerHTML` on every view-mode switch, so
 *   anything inside `#dev-body` is destroyed and rebuilt. The "+" is React's —
 *   button, menu, listeners — so it must never be a child that the MODULE
 *   rewrites. What makes the Workshop placement legal is that `#dev-workshop`
 *   is React-owned end to end: the module creates that host once per surface
 *   occupancy and never writes inside it again, so a React subtree mounted
 *   there is reconciled, not clobbered. A Workshop↔Board switch does rebuild
 *   the host, which is why the filter bar is REMOUNTED across that switch and
 *   re-seeds from the persisted per-app filters rather than from the DOM.
 *
 * `#dev-kanban-filterbar` stays an innerHTML host that the module fills
 * (`_renderKanbanFilterBar()`); React renders it empty, with a constant
 * className, and never reconciles inside it. This row ASKS to be filled, on
 * the effect after it mounts — see the call below for why `_repaintDevBody`'s
 * own call cannot reach the host on the Workshop.
 *
 * EXACTLY ONE of the two call sites renders at a time — ./board-frame.tsx when
 * the Dev screen is on the Board, ./workshop/workshop.tsx when it is on the
 * Workshop — which is what keeps `#dev-actions`, `#dev-plus-btn` and
 * `#dev-plus-menu` unique ids. board-frame reads the view mode to decide, and
 * the Workshop renders the "+" once, in its tab strip, never in this row.
 *
 * tests/dev-plus-menu.test.js, tests/pr-import-menu.test.js and
 * tests/board-plus-menu-rows.test.js read this file's TEXT and compare row
 * positions, so the rows stay spelled out one per call rather than mapped from
 * a table.
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import type { ReactNode } from 'react';

import {
  AppWindowIcon, GitHubIcon, KeyIcon, LightBulbIcon, PencilSquareIcon, PlusIcon, UserGroupIcon,
} from '@/components/ui/icons';

import { callAppView } from './card/fold';
import { FeaturedIllustrationEditor } from '../apps/featured-illustration-editor';

export interface DevActionsRowProps {
  illustrationApp?: any;
  canManageIllustration?: boolean;
  selfHosted: boolean;
  readOnly: boolean;
  canCollaborate: boolean;
  showsMembers: boolean;
  /**
   * Whether the row carries the "+" at its end. The Board frame's row does
   * (the default); the Workshop's pane-head row does not, because the
   * Workshop draws the "+" in its tab strip — see the header.
   */
  withPlus?: boolean;
}

/**
 * `AppView._plusMenuHeading(label, key, divider)`, as JSX.
 *
 * Still a `<div>`, not a `<button>`, and for the same reason the template said
 * so: `_wirePlusMenu` collects `button[data-plus]` for the touch action sheet,
 * so anything that is not an action must not be a button or it would arrive in
 * that sheet as a tappable row that does nothing. It does carry
 * `data-plus-group`, which is how the sheet picks headings up in DOM order.
 */
function PlusMenuHeading({
  label,
  groupKey,
  divider,
}: {
  label: string;
  groupKey: string;
  divider: boolean;
}) {
  return (
    <div
      data-plus-group={groupKey}
      className={
        'px-3 pt-2.5 pb-1 text-[0.9375rem] font-semibold text-zinc-500 dark:text-zinc-500 select-none' +
        (divider ? ' border-t border-zinc-200 dark:border-zinc-800 mt-1' : '')
      }
    >
      {label}
    </div>
  );
}

/**
 * The shared row shell for every `data-plus` action.
 *
 * #1615: the same shape as the app chip's menu — a leading glyph, `gap-3`,
 * `px-5`, a 44px floor and that menu's hover tint — so the two lists in this
 * shell read as one kind of thing. What it deliberately does NOT copy is the
 * chip menu's single-line row: every action here has a subtitle explaining
 * what it does ("Renames are proposals, applied once voted in"), and those
 * lines are the reason this menu is legible at all.
 *
 * The row's title carries `data-plus-title`, and `AppView._wirePlusMenu` reads
 * THAT for its touch action sheet. It used to take `querySelector('span')` —
 * the first span in the row — which was the title only by accident of source
 * order, and any wrapper introduced above it (this layout needs one for the
 * text column) would have handed every sheet row the wrong label, or none.
 */
const PLUS_ROW_CLS =
  'w-full text-left flex items-start gap-3 px-5 py-2.5 min-h-[44px] '
  + 'hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors';
const PLUS_ROW_DIVIDER_CLS = ' border-t border-zinc-200 dark:border-zinc-800';
const PLUS_ICON_CLS = 'shrink-0 mt-0.5 w-5 h-5 text-zinc-500 dark:text-zinc-400';
const PLUS_TITLE_CLS = 'block text-sm font-medium text-zinc-800 dark:text-zinc-200';
const PLUS_SUB_CLS = 'block text-xs text-zinc-500 dark:text-zinc-400';

/**
 * One `data-plus` action, as the row shell above.
 *
 * The action and the divider come in spelled exactly as the markup spells
 * them, rather than as an `action` string and a boolean. Two reasons, and the
 * second is why it is worth the slightly odd prop name: the source stays
 * greppable per row, which is how tests/dev-plus-menu.test.js and
 * tests/pr-import-menu.test.js locate each one and prove its gate (they read
 * this file's TEXT and compare positions, so no example row name appears in
 * this comment); and the divider EXPRESSIONS stay visible at the call site,
 * where the condition ("does the members row render above me?") is the
 * interesting part.
 */
function PlusRow({
  'data-plus': action, icon, title, sub, dividerCls = '', titleNode, onClick,
}: {
  'data-plus': string;
  onClick?: () => void;
  icon: ReactNode;
  title?: string;
  sub: ReactNode;
  dividerCls?: string;
  /** For the one row whose title carries a legacy-owned leaf beside it. */
  titleNode?: ReactNode;
}): ReactNode {
  return (
    <button
      data-plus={action}
      onClick={onClick}
      className={PLUS_ROW_CLS + dividerCls}
    >
      {icon}
      <span className="min-w-0 flex-1">
        {titleNode ?? (
          <span data-plus-title className={PLUS_TITLE_CLS}>{title}</span>
        )}
        <span className={PLUS_SUB_CLS}>{sub}</span>
      </span>
    </button>
  );
}

/**
 * The "+" and its menu: `#dev-plus-btn` and `#dev-plus-menu`.
 *
 * ── Where it renders ────────────────────────────────────────────────────
 *
 * On the Workshop, as the LAST ITEM OF THE VIEW-TAB STRIP (workshop.tsx's
 * rail): Current status · Needs you · All items · +, on every tab. It is the
 * strip's own trailing control, drawn on the strip's metrics — app.css
 * `.dev-ws-plus-btn`, beside `.dev-ws-tab`, in a circle of its own a small
 * gap after the tab pill (#2934) — so it reads as part of the strip rather
 * than as the violet floating action it used to be at the end of All items'
 * search row. It is NOT inside the `role="tablist"`: a tab list owns
 * tabs, and a menu button among them is announced as a fourth tab that does
 * not select anything.
 *
 * On the (unreachable) Board, at the end of `#dev-actions`, as it always was.
 *
 * ── Who owns what ───────────────────────────────────────────────────────
 *
 * React renders the button, the menu and its rows; `AppView._wirePlusMenu`
 * (public/js/app-view.js) co-owns the two nodes for their listeners, the
 * menu's `hidden` and the button's `aria-expanded` — the two mutations the
 * migration sanctions on a React-rendered node. Both are looked up BY ID, so
 * exactly one of these may be mounted at a time.
 *
 * ── Why it asks to be wired (#2141) ─────────────────────────────────────
 *
 * `_wirePlusMenu` binds the button's handlers by looking `#dev-plus-btn` up,
 * and `_repaintDevBody` re-runs it right after `_rerenderWorkshop()`, which is
 * sound only while the button is in the DOM by then. It is not always: the
 * Workshop renders a skeleton until its data lands, and a deep-linked tab
 * reaches the lander through a late-arrival effect whose render lands a task
 * AFTER the synchronous publish `_rewirePlusMenu()` follows. A button that
 * arrived after the one call that wires it stayed dead until the next body
 * repaint — "sometimes need to refresh before it works". So the "+" asks for
 * itself on mount. `_rewirePlusMenu` aborts the previous controller before
 * binding, so this call on top of the module's own leaves exactly one handler
 * per node. In the effect BODY: it binds listeners and flushes nothing
 * through React, and the nodes it looks up are committed by the time any
 * effect runs — which is also before anyone can have tapped.
 */
export function DevPlusMenu({
  illustrationApp,
  canManageIllustration,
  selfHosted,
  readOnly,
  canCollaborate,
  showsMembers,
}: DevActionsRowProps): ReactNode {
  const [editingIllustration, setEditingIllustration] = useState(false);
  useEffect(() => {
    callAppView('_rewirePlusMenu');
  }, []);
  /*
      #2478 — ONE string for the "+" button's tooltip and its accessible
      name. The button's only child is a glyph, so a screen reader announced
      it as "+": `title` is a tooltip, and no assistive technology is obliged
      to fall back to it for a name (VoiceOver in Safari does not). Every
      other glyph-only trigger on this board already pairs the two —
      `MenuTrigger` in card/dev-card.tsx, the rail's "More" in
      workshop/workshop.tsx — and this was the last one without.
      Held in a const rather than written twice so the tooltip and the name
      cannot drift apart.

      `aria-label` is a STATIC attribute here and nothing outside React writes
      it. `_wirePlusMenu` (public/js/app-view.js) co-owns this node, but only
      its listeners and `aria-expanded`; it never sets `aria-label` and never
      replaces the node's attributes wholesale, so the two owners do not meet.
  */
  const plusLabel = readOnly
    ? 'Fork this app'
    : 'File an issue, import a PR or manage this app';
  return (
    <>
  {/* The native modal reparents its card under body. Portal there too so React's delegated events stay on the card's ancestor. */}
  {editingIllustration && illustrationApp ? createPortal(<FeaturedIllustrationEditor key={illustrationApp.slug} app={illustrationApp} onClose={() => setEditingIllustration(false)} />, document.body) : null}
    {/*
        The wrapper is the menu's containing block (`.dev-ws-plus` is
        `position: relative` in app.css). Hidden outright for a read-only
        viewer of the self-hosted app: that viewer gets no Fork (the platform
        is not forkable) and no board writes, so the menu would be empty.
    */}
    <div className={`dev-ws-plus ${readOnly && selfHosted ? 'hidden' : ''}`}>
      <button
        id="dev-plus-btn"
        type="button"
        aria-haspopup="true"
        aria-expanded="false"
        aria-label={plusLabel}
        className="dev-ws-plus-btn un-touch-target"
        title={plusLabel}
      >
        {/* The same glyph the Messages strip's own "+" draws (#2778), so
            the two strips end on one mark. Decoration: the name is the
            label above. */}
        <PlusIcon className="dev-ws-plus-glyph" aria-hidden="true" />
      </button>
      {/*
          The desktop dropdown. `right-0` hangs it off the right edge of the
          "+"'s circle (this wrapper, #2934), so it opens leftward into the
          column from the end of the strip, and `top-full mt-2` sets it 8px
          under that circle at either size of the strip. On touch
          `_wirePlusMenu` presents the same rows as the kit's action sheet
          instead and this stays hidden.
      */}
      <div
        id="dev-plus-menu"
        className="hidden absolute right-0 top-full mt-2 z-30 w-64 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-2xl overflow-hidden"
      >
        {readOnly ? null : (
          <>
            {/*
                New change lives in Improve (#1490) — the Homeroom menu's New
                change button now (#2740 review). Filing an issue is back
                HERE as well (#1900): #1490 folded it into Improve's Give
                feedback beside New change, and people on the board could not
                find "create an issue" any more. Same dialog, opened with the
                open app preselected — the row needs nothing of the viewer
                beyond a writeable board, so it is the one action in this group
                that is not gated on canCollaborate, and the group heading is
                unconditional because of it.
            */}
            <PlusMenuHeading label="Add to the board" groupKey="build" divider={false} />
            <PlusRow
              data-plus="issue"
              icon={<LightBulbIcon className={PLUS_ICON_CLS} aria-hidden="true" />}
              title="File an issue"
              sub="Report a problem or idea without building it yourself"
            />
            {canCollaborate ? (
              <PlusRow
                data-plus="import-pr"
                icon={<GitHubIcon className={PLUS_ICON_CLS} aria-hidden="true" />}
                title="Import Feature from a PR"
                sub={(
                  <>
                    Your computer &middot; your own tools. You have already built it, so
                    there is no chat for this one
                  </>
                )}
                dividerCls={PLUS_ROW_DIVIDER_CLS}
              />
            ) : null}
            <PlusMenuHeading
              label="Settings &amp; rules"
              groupKey="settings"
              divider={true}
            />
            {typeof window !== 'undefined' && ((window.AppView?.appData?.can_manage && !selfHosted)
              || window.AppView?.appData?.can_delete
              || window.AppView?.appData?.delete_block === 'shared') ? <PlusRow
              data-plus="app-settings"
              icon={<KeyIcon className={PLUS_ICON_CLS} aria-hidden="true" />}
              title="App settings"
              sub="Manage who can use and build this app"
            /> : null}
            {canManageIllustration ? <PlusRow
              data-plus="featured-illustration"
              icon={<PencilSquareIcon className={PLUS_ICON_CLS} aria-hidden="true" />}
              title="Featured illustration"
              sub="Preview and adjust the Discover card image"
              onClick={() => setEditingIllustration(true)}
            /> : null}
            {showsMembers ? (
              <>
                {selfHosted ? (
                  <PlusRow
                    data-plus="members"
                    icon={<UserGroupIcon className={PLUS_ICON_CLS} aria-hidden="true" />}
                    title="Proposal approvals"
                    sub="Who approves proposals and how many approvals are needed"
                  />
                ) : (
                  <PlusRow
                    data-plus="members"
                    icon={<UserGroupIcon className={PLUS_ICON_CLS} aria-hidden="true" />}
                    title="Members &amp; approvals"
                    sub="Manage collaborators, app admins and proposal approvals"
                  />
                )}
              </>
            ) : null}
            <PlusRow
              data-plus="rename"
              icon={<PencilSquareIcon className={PLUS_ICON_CLS} aria-hidden="true" />}
              title="App display name"
              sub="Renames are proposals, applied once voted in"
              dividerCls={showsMembers ? PLUS_ROW_DIVIDER_CLS : ''}
            />
            <PlusRow
              data-plus="secrets"
              icon={<KeyIcon className={PLUS_ICON_CLS} aria-hidden="true" />}
              titleNode={(
                <span
                  data-plus-title
                  className="flex items-center gap-2 text-sm font-medium text-zinc-800 dark:text-zinc-200"
                >
                  {selfHosted ? 'Platform variables' : 'App secrets'}
                  {/* Filled by AppView.refreshDevChatSecretsState() — a
                      legacy-owned leaf, so it renders empty and React never
                      writes its text again. */}
                  <span
                    id="dc-secrets-state"
                    className="text-xs font-normal text-zinc-500 dark:text-zinc-500"
                  ></span>
                </span>
              )}
              sub={selfHosted
                ? "The platform's own env, applied on its next deploy"
                : 'Set or update secret values'}
              dividerCls={PLUS_ROW_DIVIDER_CLS}
            />
          </>
        )}
        {selfHosted ? null : (
          <PlusRow
            data-plus="fork"
            icon={<AppWindowIcon className={PLUS_ICON_CLS} aria-hidden="true" />}
            title="Fork this app"
            sub="Stand up your own independent copy"
            dividerCls={readOnly ? '' : PLUS_ROW_DIVIDER_CLS}
          />
        )}
      </div>
    </div>
    </>
  );
}

export function DevActionsRow({
  withPlus = true,
  ...plusProps
}: DevActionsRowProps): ReactNode {
  /**
   * FILL THE FILTER HOST THE FRAME BELOW RENDERS, as soon as it exists.
   *
   * `_renderKanbanFilterBar()` is called from `_repaintDevBody()`, and on the
   * Workshop that call runs BEFORE the surface it is filling has rendered:
   * the branch creates an empty `#dev-workshop` and then calls the filler,
   * but `#dev-kanban-filterbar` is a node of THIS row, which the Workshop's
   * All-items pane renders — so the filler found no host, returned, and the
   * search field only appeared on whatever repaint happened to come next.
   * A WebSocket push or a pull-to-refresh, which is why it read as "the
   * search is missing for a few seconds, then it is there".
   *
   * So the host asks to be filled itself, on the effect after it mounts.
   * `mountKanbanFilters` is idempotent per host (legacy-portals keeps one
   * entry per element and reconciles on a re-mount), and the publish that
   * follows it is the same view model `_repaintDevBody` would have sent.
   *
   * IN A MICROTASK, which is React's own advice and not a superstition. The
   * mount publishes inside `flushSync` (lib/legacy-portals.tsx — that is
   * where the module's synchronous-DOM contract comes from), and React
   * answers a `flushSync` raised while it is still committing with "flushSync
   * was called from inside a lifecycle method… Consider moving this call to a
   * scheduler task or micro task". An effect body is inside that commit,
   * passive or not. Verified both ways in a browser against a DEVELOPMENT
   * React build, which is the only build that carries the complaint: from the
   * effect body it fires, from the microtask it does not. The shipped shell
   * is a production build, so this is not what stands between the app and a
   * green check — it is the difference between calling this where React says
   * it is legal and calling it where React says it is not.
   *
   * Nothing waits on the microtask: it runs as soon as React's work loop
   * unwinds, and the host below holds the field's row open with `min-h-8`
   * from the frame's first paint, so arriving a beat later shifts nothing.
   *
   * The "+" asks to be WIRED on its own mount now (#2141) — see
   * `DevPlusMenu` — because on the Workshop it is no longer in this row.
   */
  useEffect(() => {
    let live = true;
    queueMicrotask(() => { if (live) callAppView('_renderKanbanFilterBar'); });
    return () => { live = false; };
  }, []);
  return (
  <div id="dev-actions" className="flex items-center gap-2 px-3 pt-2 shrink-0">
    {/*
        Legacy portal host for the filter strip. It ships EMPTY because the
        store is published only after the first data load, but `min-h-8`
        reserves the search field's one-row height from the frame's first
        paint. Without that reservation, a read-only self-hosted view —
        where the "+" is hidden — grows by 32px when the search arrives and
        pushes the scrolling board down. `min-height`, rather than a fixed
        height, still lets active chips wrap onto extra rows.
    */}
    <div id="dev-kanban-filterbar" className="flex-1 min-w-0 min-h-8" />
    {/*
        The filter host's `flex-1` places the "+" at the right edge of the
        Board's row. On the Workshop there is no "+" here: it is the last
        item of the view-tab strip above the pane.
    */}
    {withPlus ? <DevPlusMenu {...plusProps} /> : null}
  </div>
  );
}
