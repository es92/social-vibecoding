/**
 * `#dev-actions` — the Dev screen's toolbar: the shared Board/Workshop filter
 * strip — and `DevPlusMenu`, the ⋯ (it was the "+") and its menu.
 *
 * ── The ⋯ lives in the project hub's hero ────────────────────────────
 *
 * On the Workshop the ⋯ is not in this row. It sat at the end of All items'
 * search row, then closed the view-tab strip on every tab; the strip is gone
 * (the hub is one page with doors), so it ends the hero's members row,
 * beside Invite: the project's own menu, on the project's own card, leading
 * with Suggest an improvement. workshop/workshop.tsx hands `DevPlusMenu` to the
 * hero (`inHero`) and renders this row with `withPlus={false}` in All items'
 * pane head.
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
 * the Workshop renders the ⋯ once, in the hub's hero, never in this row.
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
  AppWindowIcon, ArrowPathIcon, ArrowRightIcon, BookmarkIcon, BookmarkSolidIcon, ArrowUpTrayIcon, ChevronLeftIcon, ChevronRightIcon, CogIcon, EllipsisHorizontalIcon, EyeIcon, GitHubIcon, GlobeIcon, HashIcon, HomeIcon, KeyIcon, LightBulbIcon, LockIcon,
  PencilSparklesIcon, PencilSquareIcon, UserGroupIcon,
} from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { callAppView } from './card/fold';
import { Improve } from '../improve/improve-controller.js';
import { FeaturedIllustrationEditor } from '../apps/featured-illustration-editor';
import { SuggestBackDialog, suggestBackTarget, versionOfApp } from './suggest-back-dialog';
import { UpdatesSheet } from '../versions/updates-sheet';
import { VisitorView } from '../guest/visitor-view';

export interface DevActionsRowProps {
  illustrationApp?: any;
  canManageIllustration?: boolean;
  selfHosted: boolean;
  readOnly: boolean;
  canCollaborate: boolean;
  showsMembers: boolean;
  /**
   * Whether the row carries the ⋯ at its end. The Board frame's row does
   * (the default); the Workshop's pane-head row does not, because the
   * Workshop draws it in the hub's hero — see the header.
   */
  withPlus?: boolean;
  /**
   * Drawn in the project hero, beside Invite, rather than at the end of a
   * strip: the ⋯ then wears the hero's neutral pill fill so the two read as
   * one row of buttons. See `DevPlusMenu`.
   */
  inHero?: boolean;
  /**
   * #4666: "Who can see & change it", the first of Settings & rules when the
   * page passes it, to whoever may propose it: who can see the project and
   * how its changes are approved, in one sheet
   * (features/dialogs/who-decides.tsx). It took in "Make it public" and
   * "Make it private", which were rows here (and before that, hero
   * buttons). Absent everywhere else.
   */
  onWhoDecides?: (() => void) | null;
  /**
   * #4045: Leave, for a member who did not start the project
   * (community-card.tsx canLeave / leaveCommunity). It was the hero's
   * Joined pill, which a tap turned into the way out; the hub's row says
   * what you can do, and leaving is a setting of yours. Absent everywhere
   * else.
   */
  onLeave?: (() => void) | null;
  /** The project's name, for "Leave <name>". */
  appName?: string | null;
  /**
   * Pin the community to the desktop sidebar, or unpin it (18 Oct 2026,
   * ../nav/pin-actions.ts): for a member, beside the sidebar only, where
   * the pins are drawn. Null leaves the row out.
   */
  pin?: { pinned: boolean; onToggle: () => void } | null;
  /** ONE HOME (#6361): pin this project's APP to Home (its tile opens the app). */
  homeApp?: { pinned: boolean; onToggle: () => void } | null;
  /** ONE HOME (#6361): pin this COMMUNITY to Home (its tile opens this hub). */
  homeCommunity?: { pinned: boolean; onToggle: () => void } | null;
  /**
   * SEE WHAT VISITORS SEE (the hand-off of 11 Nov 2026): the menu's first
   * row, on a public project's hub, opening its signed-out page for the
   * member, read only (../guest/visitor-view.tsx). Null leaves it out:
   * a private project has no page for visitors, and the platform's own is
   * not in the public directory.
   */
  visitorView?: { slug: string } | null;
  /**
   * Drawn on the project card (workshop/community-card.tsx, for somebody who
   * has not joined): the ⋯ is the card's 52px round glass button beside
   * Open app and Join.
   */
  onCard?: boolean;
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
  'w-full text-start flex items-start gap-3 px-5 py-2.5 min-h-[44px] '
  + 'hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors';
const PLUS_ROW_DIVIDER_CLS = ' border-t border-zinc-200 dark:border-zinc-800';
const PLUS_ICON_CLS = 'shrink-0 mt-0.5 w-5 h-5 text-zinc-500 dark:text-zinc-400';
const PLUS_TITLE_CLS = 'block text-sm font-medium text-zinc-800 dark:text-zinc-200';
/** The ⋯ in the hero: Invite's pill fill (`pillNeutral`), as a circle. */
const HERO_BTN_CLS = 'dev-ws-plus-btn dev-ws-plus-btn-hero un-touch-target '
  + 'bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-zinc-900 dark:text-zinc-100';
/** The ⋯ on the project card: its round glass button, on the project's colour. */
const CARD_BTN_CLS = 'dev-ws-plus-btn dev-ws-plus-btn-card un-touch-target bg-white/15 hover:bg-white/25 text-white';
const PLUS_SUB_CLS = 'block text-xs text-zinc-500 dark:text-zinc-400';
/** The menu's one lit row, Suggest an improvement (the owner, 8 Oct 2026):
    the accent's tint behind it and its title bold. Every other row stays plain. */
const PLUS_ROW_LIT_CLS =
  'w-full text-start flex items-start gap-3 px-5 py-2.5 min-h-[44px] '
  + 'bg-violet-50 hover:bg-violet-100 dark:bg-violet-900/30 dark:hover:bg-violet-900/40 transition-colors';
const PLUS_TITLE_LIT_CLS = 'block text-sm font-bold text-zinc-900 dark:text-zinc-100';

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
  'data-plus': action, icon, title, sub, dividerCls = '', titleNode, onClick, group, trailing, lit = false,
}: {
  'data-plus': string;
  /** The highlighted row: a tint behind it and a bold title (PLUS_ROW_LIT_CLS). */
  lit?: boolean;
  /** #4045: a row that opens a group of rows (Settings & rules) carries
      the group's `data-plus-group` marker, and a chevron as `trailing`. */
  group?: string;
  trailing?: ReactNode;
  onClick?: () => void;
  icon: ReactNode;
  title?: string;
  /** The line under the title; a row whose title says it all has none. */
  sub?: ReactNode;
  dividerCls?: string;
  /** For the one row whose title carries a legacy-owned leaf beside it. */
  titleNode?: ReactNode;
}): ReactNode {
  return (
    <button
      data-plus={action}
      data-plus-group={group}
      data-plus-lit={lit ? '' : undefined}
      aria-haspopup={group ? 'true' : undefined}
      onClick={onClick}
      className={(lit ? PLUS_ROW_LIT_CLS : PLUS_ROW_CLS) + dividerCls}
    >
      {icon}
      <span className="min-w-0 flex-1">
        {titleNode ?? (
          <span data-plus-title className={lit ? PLUS_TITLE_LIT_CLS : PLUS_TITLE_CLS}>{title}</span>
        )}
        {sub ? <span className={PLUS_SUB_CLS}>{sub}</span> : null}
      </span>
      {trailing}
    </button>
  );
}

/**
 * The ⋯ and its menu: `#dev-plus-btn` and `#dev-plus-menu` (the ids are the
 * "+"'s, kept, because the wiring and the declared checks look them up).
 *
 * ── Where it renders ────────────────────────────────────────────────────
 *
 * On the Workshop, at the END OF THE HUB HERO'S MEMBERS ROW, beside Invite
 * (community-card.tsx), in Invite's own neutral pill fill as a 32px circle
 * (`inHero`), so the two read as one row of buttons. Its menu hangs below
 * it, opening leftward from the row's end, and the hero lifts over the
 * cards under it while it is open (app.css).
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
  inHero = false,
  onWhoDecides = null,
  onLeave = null,
  appName = null,
  pin = null,
  homeApp = null,
  homeCommunity = null,
  visitorView = null,
  onCard = false,
}: DevActionsRowProps): ReactNode {
  const t = useMessages('project');
  const [editingIllustration, setEditingIllustration] = useState(false);
  const [visiting, setVisiting] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [updating, setUpdating] = useState(false);
  useEffect(() => {
    callAppView('_rewirePlusMenu');
  }, []);
  // The pin row's glyph: filled while it is pinned.
  const PinIcon = pin?.pinned ? BookmarkSolidIcon : BookmarkIcon;
  // "Suggest to <original>": on a version (docs/plans/versions.md), for its
  // owner, some of its own changes sent to the app it was made from, picked
  // one by one (./suggest-back-dialog.tsx). The open app's payload is
  // `illustrationApp` (AppView.appData), which carries the resolved
  // `upstream_link` (or, from an older server, `forked_from`) and
  // `created_by`.
  const viewerId = typeof window === 'undefined'
    ? null
    : ((window as unknown as { App?: { user?: { id?: number } } }).App?.user?.id ?? null);
  const suggestTarget = selfHosted ? null : suggestBackTarget(illustrationApp, viewerId);
  // "Updates from <original>": on any version whose original is still
  // there, whether it gets the original's updates and, on a private one,
  // whether it shares what it makes (../versions/updates-sheet.tsx).
  const versionOf = selfHosted ? null : versionOfApp(illustrationApp);
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
    ? t('project:menu.button.remix')
    : t('project:menu.button.manage');
  return (
    <>
  {/* The native modal reparents its card under body. Portal there too so React's delegated events stay on the card's ancestor. */}
  {editingIllustration && illustrationApp ? createPortal(<FeaturedIllustrationEditor key={illustrationApp.slug} app={illustrationApp} onClose={() => setEditingIllustration(false)} />, document.body) : null}
  {suggesting && suggestTarget && illustrationApp ? createPortal(<SuggestBackDialog key={illustrationApp.slug} slug={illustrationApp.slug} copyName={illustrationApp.name || illustrationApp.slug} original={suggestTarget} onClose={() => setSuggesting(false)} />, document.body) : null}
  {updating && versionOf && illustrationApp ? createPortal(<UpdatesSheet key={illustrationApp.slug} slug={illustrationApp.slug} original={versionOf} onClose={() => setUpdating(false)} />, document.body) : null}
  {visiting && visitorView ? createPortal(<VisitorView key={visitorView.slug} slug={visitorView.slug} onClose={() => setVisiting(false)} />, document.body) : null}
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
        className={onCard ? CARD_BTN_CLS : inHero ? HERO_BTN_CLS : 'dev-ws-plus-btn un-touch-target'}
        title={plusLabel}
      >
        {/* A ⋯, not a "+": on the hub the button sits in the hero beside
            Invite and holds the project's settings as much as anything to
            add, and a "+" there read as "add a member". Decoration: the
            name is the label above. */}
        <EllipsisHorizontalIcon className="dev-ws-plus-glyph" aria-hidden="true" />
      </button>
      {/*
          The desktop dropdown. `end-0` hangs it off the right edge of the
          "+"'s circle (this wrapper, #2934), so it opens leftward into the
          column from the end of the strip, and `top-full mt-2` sets it 8px
          under that circle at either size of the strip. On touch
          `_wirePlusMenu` presents the same rows as the kit's action sheet
          instead and this stays hidden.
      */}
      <div
        id="dev-plus-menu"
        className="hidden absolute end-0 top-full mt-2 z-30 w-64 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-2xl overflow-hidden"
      >
        {readOnly ? null : (
          <>
            {/*
                New change lives in Improve (#1490) — the Homeroom menu's New
                change button now (#2740 review). Asking for a change is
                HERE as well (#1900): #1490 folded it into Improve's Give
                feedback beside New change, and people on the board could not
                find "create an issue" any more. Same dialog, opened with the
                open app preselected — the row needs nothing of the viewer
                beyond a writeable board, so it is the one action in this group
                that is not gated on canCollaborate.

                It was "File an issue" under an "Add to the board" heading.
                The hub's ⋯ leads with it now, in the words a member would use
                for what they want, and the group needs no heading: it is the
                menu's first, and "Settings & rules" below says where the
                rest begins.

                START A NEW CHANGE comes first (#852 review): it was the
                hub's last line, a dashed button under the cards, and it is
                the ⋯'s now. The Homeroom menu's own action
                (Improve.startSession), which keeps its row there too.
            */}
            {/* SEE WHAT VISITORS SEE (the hand-off of 11 Nov 2026), first:
                this project's signed-out page, for the member, read only,
                with the way back to the hub on it. Plain, not lit: Suggest
                an improvement stays the menu's one lit row. */}
            {visitorView ? (
              <PlusRow
                data-plus="visitor-view"
                icon={<EyeIcon className={PLUS_ICON_CLS} aria-hidden="true" />}
                title={t('project:menu.visitorView.title')}
                sub={t('project:menu.visitorView.sub')}
                onClick={() => { callAppView('_closePlusMenu'); setVisiting(true); }}
              />
            ) : null}
            {/* B8: Suggest an improvement leads (it goes to Homeroom bot,
                or to the group as a request); building it yourself is
                second. */}
            <PlusRow
              data-plus="issue"
              lit
              icon={<LightBulbIcon className={PLUS_ICON_CLS} aria-hidden="true" />}
              title={t('project:menu.suggest.title')}
              sub={t('project:menu.suggest.sub')}
              dividerCls={visitorView ? PLUS_ROW_DIVIDER_CLS : ''}
            />
            <PlusRow
              data-plus="new-change"
              icon={<PencilSparklesIcon className={PLUS_ICON_CLS} aria-hidden="true" />}
              title={t('project:menu.build.title')}
              sub={t('project:menu.build.sub')}
              onClick={() => { callAppView('_closePlusMenu'); void Improve.startSession(); }}
            />
            {canCollaborate ? (
              <PlusRow
                data-plus="import-pr"
                icon={<GitHubIcon className={PLUS_ICON_CLS} aria-hidden="true" />}
                title={t('project:menu.importPr.title')}
                sub={t('project:menu.importPr.sub')}
                dividerCls={PLUS_ROW_DIVIDER_CLS}
              />
            ) : null}
            {/* ONE HOME (#6361): THE TWO HOME PINS, separate acts. The app's
                tile opens the app; the community's opens this hub. Neither
                joins, and neither needs you to have joined. */}
            {homeApp ? (
              <PlusRow
                data-plus="home-app"
                icon={<HomeIcon className={PLUS_ICON_CLS} aria-hidden="true" />}
                title={homeApp.pinned ? t('project:menu.homeApp.remove') : t('project:menu.homeApp.add')}
                sub={homeApp.pinned ? undefined : t('project:menu.homeApp.sub')}
                dividerCls={PLUS_ROW_DIVIDER_CLS}
                onClick={() => { callAppView('_closePlusMenu'); homeApp.onToggle(); }}
              />
            ) : null}
            {homeCommunity ? (
              <PlusRow
                data-plus="home-community"
                icon={<HomeIcon className={PLUS_ICON_CLS} aria-hidden="true" />}
                title={homeCommunity.pinned ? t('project:menu.homeCommunity.remove') : t('project:menu.homeCommunity.add')}
                sub={homeCommunity.pinned ? undefined : t('project:menu.homeCommunity.sub')}
                onClick={() => { callAppView('_closePlusMenu'); homeCommunity.onToggle(); }}
              />
            ) : null}
            {/* PIN TO SIDEBAR (18 Oct 2026): a pin is a community's, so the
                community's own menu makes and takes it, as its row's
                right-click menu does in the sidebar. */}
            {pin ? (
              <PlusRow
                data-plus="pin"
                icon={<PinIcon className={PLUS_ICON_CLS} aria-hidden="true" />}
                title={pin.pinned ? t('project:menu.pin.remove') : t('project:menu.pin.add')}
                sub={pin.pinned ? undefined : t('project:menu.pin.sub')}
                dividerCls={PLUS_ROW_DIVIDER_CLS}
                onClick={() => { callAppView('_closePlusMenu'); pin.onToggle(); }}
              />
            ) : null}
            {/*
                SETTINGS & RULES IS ONE ROW (#4045, the owner, 7 Oct): the
                menu stays short, and the project's settings open on top of
                it. On desktop the row turns the dropdown to its settings
                panel (#dev-plus-settings, with a way back); on touch it
                presents them as a second action sheet. `_wirePlusMenu`
                (public/js/app-view.js) does both, and leaves the rows inside
                the panel out of the first sheet. It keeps
                `data-plus-group="settings"`, the group's marker, so the
                menu still names where its settings begin.
            */}
            <PlusRow
              data-plus="settings"
              group="settings"
              icon={<CogIcon className={PLUS_ICON_CLS} aria-hidden="true" />}
              title={t('project:menu.settings.title')}
              trailing={<ChevronRightIcon className="shrink-0 mt-0.5 w-4 h-4 text-zinc-500 dark:text-zinc-400" aria-hidden="true" />}
              dividerCls={PLUS_ROW_DIVIDER_CLS}
            />
            <div id="dev-plus-settings" data-plus-settings="" className="dev-plus-settings">
            <button
              type="button"
              data-plus-back=""
              aria-label={t('project:menu.settings.back')}
              className="w-full text-start flex items-center gap-2 px-3 py-2.5 min-h-[44px] text-[0.9375rem] font-semibold text-zinc-500 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
            >
              <ChevronLeftIcon className="shrink-0 w-4 h-4" aria-hidden="true" />
              {t('project:menu.settings.heading')}
            </button>
            {onWhoDecides ? (
              <PlusRow
                data-plus="who-decides"
                icon={<LockIcon className={PLUS_ICON_CLS} aria-hidden="true" />}
                title={t('project:menu.whoDecides.title')}
                sub={t('project:menu.whoDecides.sub')}
                // Rendered after the menu was wired (once the community read
                // answers), so it closes the menu itself.
                onClick={() => { callAppView('_closePlusMenu'); onWhoDecides(); }}
              />
            ) : null}
            {onLeave ? (
              <PlusRow
                data-plus="leave"
                icon={<ArrowRightIcon className={PLUS_ICON_CLS} aria-hidden="true" />}
                title={appName ? t('project:menu.leave.named', { project: appName }) : t('project:menu.leave.plain')}
                // Home.setMembership asks before it takes them out.
                onClick={() => { callAppView('_closePlusMenu'); onLeave(); }}
              />
            ) : null}
            {typeof window !== 'undefined' && ((window.AppView?.appData?.can_manage && !selfHosted)
              || window.AppView?.appData?.can_delete
              || window.AppView?.appData?.delete_block === 'shared') ? <PlusRow
              data-plus="app-settings"
              icon={<KeyIcon className={PLUS_ICON_CLS} aria-hidden="true" />}
              title={t('project:menu.appSettings.title')}
              sub={t('project:menu.appSettings.sub')}
            /> : null}
            {/* #4405: a project's own web address. Owner-set, like secrets,
                so the same people who manage the app see it; never for the
                platform's own app, which the deploy pipeline addresses. */}
            {typeof window !== 'undefined' && window.AppView?.appData?.can_manage && !selfHosted ? <PlusRow
              data-plus="domain"
              icon={<GlobeIcon className={PLUS_ICON_CLS} aria-hidden="true" />}
              title={t('project:menu.domain.title')}
              sub={t('project:menu.domain.sub')}
            /> : null}
            {canManageIllustration ? <PlusRow
              data-plus="featured-illustration"
              icon={<PencilSquareIcon className={PLUS_ICON_CLS} aria-hidden="true" />}
              title={t('project:menu.illustration.title')}
              sub={t('project:menu.illustration.sub')}
              onClick={() => setEditingIllustration(true)}
            /> : null}
            {showsMembers ? (
              <>
                {selfHosted ? (
                  <PlusRow
                    data-plus="members"
                    icon={<UserGroupIcon className={PLUS_ICON_CLS} aria-hidden="true" />}
                    title={t('project:menu.approvals.title')}
                    sub={t('project:menu.approvals.sub')}
                  />
                ) : (
                  <PlusRow
                    data-plus="members"
                    icon={<UserGroupIcon className={PLUS_ICON_CLS} aria-hidden="true" />}
                    title={t('project:menu.members.title')}
                    sub={t('project:menu.members.sub')}
                  />
                )}
              </>
            ) : null}
            <PlusRow
              data-plus="rename"
              icon={<PencilSquareIcon className={PLUS_ICON_CLS} aria-hidden="true" />}
              title={t('project:menu.rename.title')}
              sub={t('project:menu.rename.sub')}
              dividerCls={showsMembers ? PLUS_ROW_DIVIDER_CLS : ''}
            />
            {/* #4417: the project's topics, its lasting conversations: each
                is a channel and a category. A change to them is a proposal
                against dapp.json's `topics` (features/dialogs/topics.tsx).
                Its own onClick, so it works however the menu was wired. */}
            <PlusRow
              data-plus="topics"
              icon={<HashIcon className={PLUS_ICON_CLS} aria-hidden="true" />}
              title={t('project:menu.topics.title')}
              sub={t('project:menu.topics.sub')}
              onClick={() => {
                callAppView('_closePlusMenu');
                window.UsernodeReact?.dialogs?.topics?.open({ slug: window.AppView?.appData?.slug });
              }}
            />
            <PlusRow
              data-plus="secrets"
              icon={<KeyIcon className={PLUS_ICON_CLS} aria-hidden="true" />}
              titleNode={(
                <span
                  data-plus-title
                  className="flex items-center gap-2 text-sm font-medium text-zinc-800 dark:text-zinc-200"
                >
                  {selfHosted ? t('project:menu.secrets.platformTitle') : t('project:menu.secrets.appTitle')}
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
                ? t('project:menu.secrets.platformSub')
                : t('project:menu.secrets.appSub')}
              dividerCls={PLUS_ROW_DIVIDER_CLS}
            />
            {/* Updates from, Suggest to and Make your own (#4045, the owner,
                7 Oct; docs/plans/versions.md): the last rows of the Settings
                & rules sheet, so the ⋯ itself ends at that row. The first
                two are a version's, about the original it was made from. */}
            {versionOf ? (
              <PlusRow
                data-plus="updates"
                icon={<ArrowPathIcon className={PLUS_ICON_CLS} aria-hidden="true" />}
                title={t('project:menu.updates.title', { project: versionOf.name })}
                sub={versionOf.following ? t('project:menu.updates.on') : t('project:menu.updates.off')}
                dividerCls={PLUS_ROW_DIVIDER_CLS}
                onClick={() => { callAppView('_closePlusMenu'); setUpdating(true); }}
              />
            ) : null}
            {suggestTarget ? (
              <PlusRow
                data-plus="suggest-back"
                icon={<ArrowUpTrayIcon className={PLUS_ICON_CLS} aria-hidden="true" />}
                title={t('project:menu.suggestBack.title', { project: suggestTarget.name })}
                sub={t('project:menu.suggestBack.sub')}
                dividerCls={versionOf ? '' : PLUS_ROW_DIVIDER_CLS}
                onClick={() => { callAppView('_closePlusMenu'); setSuggesting(true); }}
              />
            ) : null}
            {selfHosted ? null : (
              <PlusRow
                data-plus="fork"
                icon={<AppWindowIcon className={PLUS_ICON_CLS} aria-hidden="true" />}
                title={t('project:menu.remix.title')}
                sub={t('project:menu.remix.sub')}
                dividerCls={PLUS_ROW_DIVIDER_CLS}
              />
            )}
            </div>
          </>
        )}
        {/* A read-only viewer has no settings: Make your own is the menu's one row. */}
        {readOnly && !selfHosted ? (
          <PlusRow
            data-plus="fork"
            icon={<AppWindowIcon className={PLUS_ICON_CLS} aria-hidden="true" />}
            title={t('project:menu.remix.title')}
            sub={t('project:menu.remix.sub')}
          />
        ) : null}
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
