/**
 * `#profile-proposals-screen` — Your work (UI overhaul): Your changes, Your
 * requests or Your votes, the three rows of Profile's "Your work", one list
 * at a time.
 *
 * It was "Your proposals" alone (#5310). The overhaul gave Profile a record
 * of everything you did here, and the other two are the same kind of page (a
 * list in groups, each row opening the thing it names), so they are three
 * views of this one screen rather than three screens: one root, one set of
 * router hooks (`App.navigateToProfileProposals(kind)`, public/js/app.js),
 * one controller. The root keeps its id, which the router, the screen swap
 * and the declared checks name; `data-profile-work` says which view is up.
 *
 *   changes   #profile/your-changes (and #profile/proposals, its old address):
 *             GET /api/me/proposal-history, In progress / Merged / Closed.
 *             It took the Communities tab's "What you are working on".
 *   requests  #profile/your-requests: GET /api/me/requests, what you asked for
 *             from the Ask for a change dialog or a board, Open / Done, with
 *             the dialog one tap away at the foot.
 *   votes     #profile/your-votes: GET /api/me/history?type=votes, the changes
 *             and group decisions you voted on, Still open / Decided.
 *
 * The legacy router (`App.navigateToProfileProposals`) is a classic script
 * and cannot import from this bundle, so it reaches the controller below by
 * name through `window.UsernodeReact.profileProposals`, the same seam as
 * `window.UsernodeReact.workshop`.
 *
 * A fully React-owned sibling screen like `#workshop-screen`: no
 * `public/js/**` module writes inside this root. It ships hidden and EMPTY:
 * the rows arrive in the controller's open(), never in the first render, so
 * the prerender and the hydration agree.
 */

import { useRef, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { GroupedList, ListRow, SectionHeader } from '@/components/ui/grouped-list';
import { AppIconContent, appIconKind } from '../apps/app-card-view';
import { createStore } from '../../lib/plain-store.js';
import { useStoreState } from '../../lib/use-store-state';
import { useVisibilityHiddenClass } from '../../lib/visibility-store';
import { proposalsView, requestsView, votesView } from './profile-store.js';

export type WorkKind = 'changes' | 'requests' | 'votes';

type WorkState = {
  open: boolean;
  kind: WorkKind;
  /** Each view's read, as it answered; null until it does. */
  data: Partial<Record<WorkKind, unknown>>;
  error: boolean;
};

const initial: WorkState = { open: false, kind: 'changes', data: {}, error: false };
const profileProposalsStore = createStore(initial);

/** Where each view reads from. */
const READS: Record<WorkKind, string> = {
  changes: '/api/me/proposal-history',
  requests: '/api/me/requests',
  votes: '/api/me/history?type=votes&limit=50',
};

/** What each view is called, on the bar and in its messages. */
export const WORK_TITLES: Record<WorkKind, string> = {
  changes: 'Your changes',
  requests: 'Your requests',
  votes: 'Your votes',
};

const EMPTY: Record<WorkKind, string> = {
  changes: 'You have not started a change yet.',
  requests: 'You have not asked for a change yet.',
  votes: 'You have not voted on anything yet.',
};

/** A folded group shows this many rows until "Show all" is pressed. */
export const FOLD_AT = 5;

/** The groups that fold, and what their "Show all" says. */
const FOLDS: Record<string, string> = {
  'changes:merged': 'Show all live',
  'votes:decided': 'Show all',
};

const TITLE = 'text-base font-semibold whitespace-normal line-clamp-2';
const SUBTITLE = 'text-[0.8125rem] whitespace-normal';
const NOTE = 'px-4 py-6 text-sm text-zinc-500 dark:text-zinc-400';

export function workKind(value: unknown): WorkKind {
  return value === 'requests' || value === 'votes' ? value : 'changes';
}

function demoQuery(url: string): string {
  try {
    if (new URLSearchParams(location.search).get('demo') !== '1') return url;
  } catch {
    return url;
  }
  return url + (url.includes('?') ? '&' : '?') + 'demo=1';
}

/** The project a Your changes row belongs to, in app-card.js's field names. */
type RowApp = { slug: string; name: string; icon_emoji: string | null; icon_url: string | null };
type Row = { key: string; href: string | null; title: string; meta: string; app?: RowApp };
type Section = { key: string; label: string; rows: Row[] };

/** The project's icon tile, drawn as the Communities list draws it. */
const ICON_TILE = 'app-icon-tile w-11 h-11 shrink-0 rounded-xl overflow-hidden '
  + 'flex items-center justify-center font-bold text-lg';

function viewOf(kind: WorkKind, data: unknown): { loaded: boolean; sections: Section[]; empty: boolean } {
  if (kind === 'requests') return requestsView(data);
  if (kind === 'votes') return votesView(data);
  return proposalsView(data);
}

function Group({ kind, section }: { kind: WorkKind; section: Section }): ReactNode {
  const foldLabel = FOLDS[`${kind}:${section.key}`];
  const [all, setAll] = useState(false);
  const folded = !!foldLabel && !all && section.rows.length > FOLD_AT;
  const rows = folded ? section.rows.slice(0, FOLD_AT) : section.rows;
  return (
    <section className="mt-2" data-profile-work-group={section.key}>
      <SectionHeader>{section.label}</SectionHeader>
      <GroupedList className="mx-0" tone="plane">
        {rows.map((row) => (
          <ListRow
            key={row.key}
            as={row.href ? 'a' : 'div'}
            href={row.href || undefined}
            // The tile is the project's icon, not a second link: the row
            // already opens the change, and the line under it names the
            // project for a screen reader, so the tile only carries a title.
            leading={row.app ? (
              <span
                className={ICON_TILE}
                data-icon={appIconKind(row.app as never)}
                data-profile-work-app={row.app.slug}
                title={row.app.name}
                aria-hidden="true"
              >
                <AppIconContent app={row.app as never} />
              </span>
            ) : undefined}
            title={row.title}
            titleClassName={TITLE}
            subtitle={row.meta}
            subtitleClassName={SUBTITLE}
            chevron={!!row.href}
          />
        ))}
        {folded ? (
          <ListRow
            as="button"
            data-profile-work-all={section.key}
            title={foldLabel}
            titleClassName="text-[0.9375rem] font-semibold text-violet-700 dark:text-violet-400"
            chevron={false}
            onClick={() => setAll(true)}
          />
        ) : null}
      </GroupedList>
    </section>
  );
}

export function ProfileProposalsScreen(): ReactNode {
  const screenRef = useRef<HTMLElement | null>(null);
  const state = useStoreState(profileProposalsStore) as WorkState;
  useVisibilityHiddenClass(screenRef, 'profile-proposals-screen', false);
  const kind = state.kind;
  const data = state.data[kind];
  const view = viewOf(kind, data ?? null);

  return (
    <main
      ref={screenRef}
      id="profile-proposals-screen"
      className="hidden flex-1 overflow-y-auto platform-safe-scroll"
      style={{ position: 'relative' }}
      data-page-bounce=""
      data-profile-work={kind}
    >
      {/* `pt-5` clears the header's notch, as on the Workshop screen. The bar
          is the title, so the screen draws no heading of its own.

          `px-4` IS PROFILE'S COLUMN (#3498). The lists below pass `mx-0`, as
          Profile's do, because #profile-root's own `px-4` is their gutter.
          This column copied the `mx-0` without the gutter, so the cards ran
          edge to edge on a phone with no margin. The column is now
          #profile-root's, class for class. */}
      <div className="max-w-2xl mx-auto px-4 pt-5 pb-8">
        {state.error ? (
          <div className={NOTE}>
            <p>{`${WORK_TITLES[kind]} could not be loaded.`}</p>
            <button
              type="button"
              className="mt-2 font-medium text-violet-600 dark:text-violet-400"
              onClick={() => { void profileProposalsController.reload(); }}
            >
              Try again
            </button>
          </div>
        ) : data == null || !view.loaded ? (
          state.open ? <p className={NOTE}>Loading…</p> : null
        ) : view.empty ? (
          <p className={NOTE}>{EMPTY[kind]}</p>
        ) : (
          // Keyed by view, so a fold opened on one list is not open on the next.
          view.sections.map((section) => (
            <Group key={`${kind}:${section.key}`} kind={kind} section={section} />
          ))
        )}
        {kind === 'votes' && view.loaded && !view.empty ? (
          <p className="px-4 mt-3 text-xs text-zinc-500 dark:text-zinc-400">
            A vote can be changed while it is open, so each row says your vote as it stands.
          </p>
        ) : null}
        {/* Your requests ends on the way to make another, the dialog every
            other door opens (App.openFeedbackModal). */}
        {kind === 'requests' && state.open ? (
          <div className="px-4 mt-4">
            <Button
              type="button"
              data-profile-work-ask=""
              className="w-full"
              onClick={() => { (window as any).App?.openFeedbackModal?.(); }}
            >
              Ask for a change
            </Button>
          </div>
        ) : null}
      </div>
    </main>
  );
}

/**
 * The legacy seam. `open` is the liveness flag a load checks before it
 * publishes, so an answer that lands after the viewer left cannot paint into
 * a screen they are no longer on; `kind` is checked the same way, so a
 * changes read cannot paint into the votes view.
 */
export const profileProposalsController = {
  open(kind?: unknown) {
    profileProposalsStore.set({ open: true, kind: workKind(kind), error: false });
    return profileProposalsController.reload();
  },
  close() {
    profileProposalsStore.set({ open: false });
  },
  isOpen(kind?: unknown) {
    const state = profileProposalsStore.get() as WorkState;
    return state.open && (kind === undefined || state.kind === workKind(kind));
  },
  async reload() {
    const kind = (profileProposalsStore.get() as WorkState).kind;
    profileProposalsStore.set({ error: false });
    let data: unknown = null;
    try {
      const res = await fetch(demoQuery(READS[kind]), { credentials: 'same-origin' });
      if (res.ok) data = await res.json();
    } catch {
      data = null;
    }
    const now = profileProposalsStore.get() as WorkState;
    if (!now.open || now.kind !== kind) return;
    if (!data) {
      profileProposalsStore.set({ error: true });
      return;
    }
    profileProposalsStore.set({ data: { ...now.data, [kind]: data }, error: false });
  },
};

if (typeof window !== 'undefined') {
  const host = (window as unknown as { UsernodeReact?: Record<string, unknown> });
  const bridge = (host.UsernodeReact ||= {});
  bridge.profileProposals = profileProposalsController;
}

export { profileProposalsStore };
