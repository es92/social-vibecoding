/**
 * The browse screen's level-2 page (#1191 slice 6, conversion 3).
 *
 * The only writer of the DOM below #browse-detail. ./browse.js decides what
 * the page says — which of loading / missing / ready it is in, which action
 * rows survive the Home.menuItemsFor filter, what state the contributors card
 * is in — and this file renders that descriptor, class string for class
 * string.
 *
 * Two things ride across the seam rather than being re-derived here:
 *
 *  - `versionPillHtml`. AppView.renderAppVersionPillHTML is a pure string
 *    builder in the still-legacy app view: it reads no DOM and mutates
 *    nothing, so rendering its output as markup keeps ONE owner for the build
 *    chip instead of a second implementation that would drift the day the
 *    deploy states change. It is the app's own version metadata, not user
 *    prose.
 *  - the action rows' `run` closures, which stay on Browse._detailActions.
 *    The descriptor carries an index; the click hands the clicked BUTTON back
 *    to Browse._runDetailAction, so a keepOpen item (Check for updates) can
 *    flip its label in place exactly as it does inside the home card's
 *    popover.
 *
 * SHARE leads that card (the prototype's About sheet lists "More": Share,
 * Add to home screen, Fork this app). It is not one of Home.menuItemsFor's
 * items, so it is its own row: a flag on the descriptor (`canShare`, the same
 * gate the mark menu's "Share app" uses) and Browse.shareDetailApp behind it.
 *
 * INITIAL RENDER: `detail === null` until the detail level is entered, and
 * that renders nothing — the empty, hidden #browse-detail the hand-written
 * shell shipped and the SSG prerender has to reproduce.
 */

import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { GroupedList, ListRow } from '@/components/ui/grouped-list';
import { ArrowRightShortIcon } from '@/components/ui/icons';

import { AppIconContent, AppIconLink, AppPills, appIconKind, hasAppPills } from './app-card-view';

type ContributorRowView = {
  who: string;
  rank: number;
  initial: string;
  merged: number;
  meta: string | null;
  pillTint: string;
};

type ContributorsView = {
  state: string;
  count: number | null;
  rows: ContributorRowView[];
  toggle: string | null;
  /** The fold is open (Browse._contribExpanded); drives aria-expanded. */
  expanded?: boolean;
  note: string | null;
};

type ActionView = {
  index: number;
  label: string;
  title: string | null;
  danger: boolean;
  disabled: boolean;
};

export type DetailView =
  | { state: 'loading' }
  | { state: 'missing' }
  | { state: 'blocked' }
  | {
    state: 'ready';
    app: Record<string, any>;
    name: string;
    slug: string;
    versionPillHtml: string;
    forkedFrom: { name: string; href: string | null } | null;
    updatedRel: string | null;
    canOpen: boolean;
    openLabel: string;
    isAdded: boolean;
    favLabel: string;
    /** The app has a public link to share (Browse.shareUrlFor). */
    canShare?: boolean;
    actions: ActionView[];
    contributors: ContributorsView;
  };

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).Browse : null) || null;
}

const NOTE_CLASS = 'px-4 py-3 text-sm text-zinc-500 dark:text-zinc-400';

// #2446: both of this page's cards ARE grouped lists — GroupedList carries the
// card (white, rounded-2xl, overflow-hidden) and ListRow the row, hairline
// included, so the hand-copied `[&:not(:last-child)]:after:*` rule that used to
// live here is gone. `mx-0` drops the primitive's page gutter: #browse-detail
// already has one, and `mt-5` is the gap from whatever the card follows.
const CARD_SPACING = 'mx-0 mt-5';

// The row hairline runs at the card's text inset (left-4) now rather than the
// hand-copy's left-3, so the heading's rule has to move with it or the two
// disagree by 4px down the same card edge.
const HEAD_RULE = "after:absolute after:bottom-0 after:left-4 after:right-0 after:h-px "
  + "after:bg-zinc-200 dark:after:bg-zinc-800 after:content-['']";

function ContributorRow({ row }: { row: ContributorRowView }): ReactNode {
  return (
    <ListRow
      as="button"
      // `text`, not `tile`: the row leads with a rank number and a small
      // initial disc, not the 2.75rem app tile that depth is measured from.
      inset="text"
      chevron={false}
      className="browse-contrib-row transition-colors hover:bg-zinc-500/5"
      data-username={row.who}
      tooltip={`View @${row.who}’s changes`}
      onClick={() => controller()?.openContributor(row.who)}
      // Rank and disc travel together as ONE leading element, so the 12px
      // between them survives the row's own 16px gap.
      leading={(
        <div className="flex shrink-0 items-center gap-3">
          <div className="w-5 text-center text-xs font-mono text-zinc-500 dark:text-zinc-500">{row.rank}</div>
          <div className="w-8 h-8 rounded-full bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 flex items-center justify-center font-semibold text-xs">{row.initial}</div>
        </div>
      )}
      title={`@${row.who}`}
      // A handle is not a headline: medium, as the connectors list sets it.
      titleClassName="font-medium"
      subtitle={row.meta}
      trailing={(
        <div
          className={`shrink-0 inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${row.pillTint}`}
          title="Their changes that went live in this app"
        >{`${row.merged} live`}</div>
      )}
    />
  );
}

function Contributors({ view }: { view: ContributorsView }): ReactNode {
  return (
    <GroupedList id="browse-detail-contributors" className={CARD_SPACING}>
      {/* The heading paints in every state (including loading) so the page
          doesn't jump when the fetch lands. */}
      <h3
        className={`relative px-4 py-2.5 text-sm font-semibold text-zinc-900 dark:text-zinc-100 ${HEAD_RULE}`}
        title="The app&rsquo;s creator, its members, and everyone with a change that went live in it"
      >
        Contributors
        {view.count == null ? null : (
          <span className="text-zinc-500 dark:text-zinc-500 font-normal">{` · ${view.count}`}</span>
        )}
      </h3>
      {view.note ? <p className={NOTE_CLASS}>{view.note}</p> : null}
      {view.rows.length ? (
        // The rows keep their own wrapper: ListRow's hairline is
        // `:not(:last-child)`, so the LAST contributor must be the last child
        // of something that the toggle below is not inside — otherwise the
        // fold button would take the row rule and the list would end on one.
        <div id="browse-contrib-list">
          {view.rows.map((row) => <ContributorRow key={row.who} row={row} />)}
        </div>
      ) : null}
      {view.toggle ? (
        <button
          type="button"
          id="browse-contrib-toggle"
          // The fold's state for assistive tech, as Discover's list's own
          // "Show more" says it (./browse-list.tsx), #2991.
          aria-expanded={!!view.expanded}
          aria-controls="browse-contrib-list"
          className="w-full px-4 py-3.5 text-sm font-medium text-violet-700 dark:text-violet-400 text-left transition-colors hover:bg-zinc-500/5 border-t border-zinc-200 dark:border-zinc-800"
          onClick={() => controller()?.toggleContributors()}
        >{view.toggle}</button>
      ) : null}
    </GroupedList>
  );
}

function Missing(): ReactNode {
  return (
    <div className="text-sm text-zinc-500 dark:text-zinc-400">
      <p className="mb-3">That app isn&rsquo;t available.</p>
      {/* #1036: a real anchor, so a modified click stays the browser's. */}
      <a
        id="browse-detail-back"
        href="#apps"
        className="inline-block text-violet-700 hover:text-violet-400 dark:text-violet-400"
        onClick={(e) => {
          const nav = (window as any).NavLink;
          if (nav && nav.isNativeClick(e.nativeEvent)) return;
          e.preventDefault();
          location.hash = '#apps';
        }}
      >&larr; Back to all apps</a>
    </div>
  );
}

function Ready({ view }: { view: Extract<DetailView, { state: 'ready' }> }): ReactNode {
  const warm = () => controller()?.warmDetailApp(view.slug);
  return (
    <>
      <div className="flex items-start gap-4">
        <AppIconLink
          slug={view.canOpen ? view.slug : null}
          name={view.name}
          className="app-icon-tile w-16 h-16 shrink-0 rounded-2xl overflow-hidden flex items-center justify-center font-bold text-2xl"
          data-icon={appIconKind(view.app)}
        >
          <AppIconContent app={view.app} />
        </AppIconLink>
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100 break-words">{view.name}</h2>
          <p className="text-xs font-mono text-zinc-500 dark:text-zinc-500 break-all">{view.slug}</p>
          {view.versionPillHtml ? (
            <div className="mt-2" dangerouslySetInnerHTML={{ __html: view.versionPillHtml }} />
          ) : null}
          {/*
              Fork lineage, directly under the version it qualifies — the row
              that used to be the drawer footer's last line, moved to the app's
              own page (see Browse._renderDetail). Amber is retained as the
              lineage colour, and it stays TEXT rather than a filled pill: it
              is a note about where this app came from, not a status.

              A deleted source resolves to `href: null` and renders inert,
              which is also why the name is a text child and never markup.
          */}
          {view.forkedFrom ? (
            <p id="browse-detail-fork" className="mt-1 text-xs text-amber-600 dark:text-amber-400 truncate">
              {view.forkedFrom.href ? (
                <a
                  href={view.forkedFrom.href}
                  className="hover:underline"
                  title={`Forked from ${view.forkedFrom.name}: open the original`}
                >
                  {`\u2442 Forked from ${view.forkedFrom.name}`}
                </a>
              ) : (
                <span className="opacity-90" title="The original app no longer exists">
                  {`\u2442 Forked from ${view.forkedFrom.name}`}
                </span>
              )}
            </p>
          ) : null}
          {view.updatedRel ? (
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{`Updated ${view.updatedRel}`}</p>
          ) : null}
          {hasAppPills(view.app) ? (
            <div className="flex flex-wrap items-center gap-1 mt-2">
              <AppPills app={view.app} />
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 mt-4">
        <Button
          type="button"
          id="browse-detail-open"
          layout="iconRow"
          variant="roundedFull"
          size="lg"
          ink={view.canOpen ? 'fillLate' : 'unavailableLate'}
          disabled={!view.canOpen}
          onClick={() => controller()?.openDetailApp(view.slug)}
          onPointerDown={view.canOpen ? warm : undefined}
          onMouseEnter={view.canOpen ? warm : undefined}
        >
          {view.canOpen ? <ArrowRightShortIcon className="w-4 h-4" aria-hidden="true" /> : null}
          {view.openLabel}
        </Button>
        <button
          type="button"
          id="browse-detail-fav"
          // Filled neutral in both states, beside the filled accent "Open".
          // It was an emerald or violet OUTLINE, which is the shape the
          // language does not draw — and the emerald read as a success cue on
          // a control whose whole job is to be pressed again to undo.
          //
          // WHITE, not zinc-100: this pill sits on the PAGE GROUND, and in
          // this palette zinc-100 IS that ground (#eaeaea) — the fill was
          // invisible. zinc-100 is the neutral fill for a control on a white
          // card (the profile buttons, the browse rows' Add); on the ground
          // itself the neutral surface is white, the same as the header's
          // hamburger disc and an unselected chip.
          className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-colors bg-white hover:bg-zinc-50 dark:bg-zinc-900 dark:hover:bg-zinc-800 text-zinc-900 dark:text-zinc-100"
          data-added={String(view.isAdded)}
          onClick={() => controller()?.toggleDetailAdded(view.app)}
        >{view.favLabel}</button>
      </div>

      {view.actions.length || view.canShare ? (
        <GroupedList className={CARD_SPACING}>
          {view.canShare ? (
            <ListRow
              as="button"
              id="browse-detail-share"
              inset="text"
              className="browse-detail-share transition-colors hover:bg-zinc-500/5"
              // The action rows' own weight and ink (see them just below):
              // Share is one more entry in the same list, not a headline.
              titleClassName="font-normal text-zinc-700 dark:text-zinc-200"
              tooltip="Share a link to this app"
              title="Share"
              onClick={() => controller()?.shareDetailApp(view.app)}
            />
          ) : null}
          {view.actions.map((a) => (
            <ListRow
              key={a.index}
              as="button"
              inset="text"
              className="browse-detail-action transition-colors hover:bg-zinc-500/5"
              // A menu entry, not a headline — the same weight the settings
              // nav's grouped rows take. The colour has to ride HERE rather
              // than on the row, because ListRow's title carries its own
              // zinc-900 and would win over an inherited one.
              titleClassName={a.danger
                ? 'font-normal text-red-700 dark:text-red-400'
                : 'font-normal text-zinc-700 dark:text-zinc-200'}
              data-action-index={a.index}
              tooltip={a.title || undefined}
              disabled={a.disabled}
              title={a.label}
              onClick={(e) => controller()?._runDetailAction(a.index, e.currentTarget)}
            />
          ))}
        </GroupedList>
      ) : null}

      <Contributors view={view.contributors} />
    </>
  );
}

export function BrowseDetail({ detail }: { detail: DetailView | null }): ReactNode {
  if (!detail) return null;
  if (detail.state === 'loading') {
    return <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading&hellip;</p>;
  }
  if (detail.state === 'blocked') return <div className={NOTE_CLASS}>
    <p>You blocked this app. Unblock it to open it again.</p>
    <a href="#settings/blocked-apps" className="text-violet-600 dark:text-violet-400 underline">Open blocked apps in Settings</a>
  </div>;
  if (detail.state === 'missing') return <Missing />;
  return <Ready key={detail.slug} view={detail} />;
}
