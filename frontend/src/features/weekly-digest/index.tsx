/**
 * `#weekly-digest-screen` — This week (#6371): what happened in the
 * viewer's projects over the last seven days, in one page.
 *
 * The Friday row in the bell ("Your weekly digest is ready") opened one
 * per-project row each; it opens this instead. The page is read-only, so it
 * has no primary action: a page under Home, named in the header, with the
 * arrow up to Home that Needs you has (`App._BACK_SLOT`). Each project is a
 * small-caps label over a card of rows; a change that went live says so
 * with its day, one up for a vote says that, and only a vote the viewer
 * still owes carries the blue Vote pill.
 *
 * ── The island rules it keeps ──────────────────────────────────────────
 *
 * Nothing in `public/js/**` writes inside this root, so the region may hold
 * state. Its FIRST render is the shipped document — `hidden`, and nothing
 * in it — and the read runs from `open()`, never during render. Screen
 * visibility is the shell's store (`#weekly-digest-screen` is in
 * App.REACT_SCREEN_IDS) and the root's `className` is a constant, so the
 * class has exactly one owner.
 */

import { useRef } from 'react';
import { flushSync } from 'react-dom';

import { GroupedList, ListRow, SectionHeader } from '@/components/ui/grouped-list';
import { Skeleton, SkeletonGroup } from '@/components/ui/skeleton';

import { useMessages } from '../../lib/i18n/react';
import { createStore } from '../../lib/plain-store.js';
import { useStoreState } from '../../lib/use-store-state';
import { useVisibilityHiddenClass } from '../../lib/visibility-store';

export type WeekItem = {
  sessionId: number;
  prNumber: number | null;
  title: string;
  mergedAt?: string;
  myVote?: boolean;
};

export type WeekProject = {
  slug: string;
  name: string;
  merged: WeekItem[];
  mergedTotal: number;
  open: WeekItem[];
  openTotal: number;
};

export type WeekData = {
  since: string;
  until: string;
  projects: WeekProject[];
  mergedTotal: number;
  projectCount: number;
};

type WeeklyDigestState = {
  open: boolean;
  loading: boolean;
  data: WeekData | null;
  error: boolean;
};

const INITIAL: WeeklyDigestState = { open: false, loading: false, data: null, error: false };

export const weeklyDigestStore = createStore(INITIAL);
// The legacy router reads the DOM on the line after it routes, so the
// store's notification has to land synchronously (the same install and the
// same reason as features/workshop/index.tsx).
weeklyDigestStore.setFlush(flushSync);

function demoQuery(): string {
  try {
    // `?demo=1` before the hash (the app's own links) or inside it
    // (`#week?demo=1`, the page's shots).
    const query = location.search || (location.hash.includes('?') ? location.hash.slice(location.hash.indexOf('?')) : '');
    return new URLSearchParams(query).get('demo') === '1' ? '?demo=1' : '';
  } catch {
    return '';
  }
}

/** The change a row names, opened the way a notification row opens it. */
function openChange(slug: string, item: WeekItem): void {
  const app = (window as any).App;
  const notifications = (window as any).Notifications;
  if (app?.openAppTab) {
    const ref = notifications?._changeRef?.(item.sessionId, item.prNumber)
      || { kind: 'proposal', id: item.sessionId };
    app.openAppTab(slug, 'dev', { subTab: 'topic', ref });
    return;
  }
  window.location.hash = `#app/${encodeURIComponent(slug)}/dev/proposals/${item.sessionId}`;
}

/** The project's Workshop, where the rest of the week is. */
function openWorkshop(slug: string): void {
  window.location.hash = `#app/${encodeURIComponent(slug)}/workshop`;
}

function dayName(value: string | undefined): string {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { weekday: 'short' });
}

function longDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export const weeklyDigestController = {
  open() {
    weeklyDigestStore.set({ open: true });
    return weeklyDigestController.reload();
  },
  close() {
    weeklyDigestStore.set({ open: false });
  },
  isOpen() {
    return weeklyDigestStore.get().open;
  },
  async reload() {
    weeklyDigestStore.set({ loading: true, error: false });
    const demo = demoQuery();
    try {
      const res = await fetch(`/api/me/weekly-digest${demo}`, { cache: 'no-cache' }).catch(() => null);
      if (!weeklyDigestStore.get().open) return;
      if (!res || !res.ok) throw new Error('read_failed');
      const data = await res.json();
      if (!weeklyDigestStore.get().open) return;
      if (!data || !Array.isArray(data.projects)) throw new Error('read_failed');
      weeklyDigestStore.set({ data: data as WeekData, loading: false, error: false });
    } catch {
      if (!weeklyDigestStore.get().open) return;
      weeklyDigestStore.set({ loading: false, error: true });
    }
  },
};

if (typeof window !== 'undefined') {
  const host = (window as unknown as { UsernodeReact?: Record<string, unknown> });
  const bridge = (host.UsernodeReact ||= {});
  bridge.weeklyDigest = weeklyDigestController;
}

function WeekRow({ project, item }: { project: WeekProject; item: WeekItem }) {
  const t = useMessages('weekly-digest');
  const vote = item.mergedAt === undefined && !item.myVote;
  return (
    <ListRow
      as="button"
      onClick={() => openChange(project.slug, item)}
      title={item.title}
      subtitle={item.mergedAt === undefined ? t('upForVote') : t('wentLive', { day: dayName(item.mergedAt) })}
      trailing={vote ? (
        <span className="shrink-0 rounded-full bg-violet-600 px-2.5 py-0.5 text-[13px] font-semibold text-white dark:bg-violet-500">
          {t('vote')}
        </span>
      ) : null}
    />
  );
}

function ProjectCard({ project }: { project: WeekProject }) {
  const t = useMessages('weekly-digest');
  const rest = project.mergedTotal + project.openTotal - project.merged.length - project.open.length;
  return (
    <div>
      <SectionHeader>{project.name}</SectionHeader>
      <GroupedList>
        {project.merged.map((item) => (
          <WeekRow key={`m-${item.sessionId}`} project={project} item={item} />
        ))}
        {project.open.map((item) => (
          <WeekRow key={`o-${item.sessionId}`} project={project} item={item} />
        ))}
        {rest > 0 ? (
          <ListRow
            as="button"
            chevron={false}
            onClick={() => openWorkshop(project.slug)}
            title={<span className="text-violet-600 dark:text-violet-400">{t('more', { count: rest })}</span>}
          />
        ) : null}
      </GroupedList>
    </div>
  );
}

export function WeeklyDigestScreen() {
  const t = useMessages('weekly-digest');
  const state = useStoreState(weeklyDigestStore) as WeeklyDigestState;
  const screenRef = useRef<HTMLElement | null>(null);
  useVisibilityHiddenClass(screenRef, 'weekly-digest-screen', false);

  return (
    <main
      id="weekly-digest-screen"
      ref={screenRef}
      className="hidden flex-1 overflow-y-auto platform-safe-scroll"
      data-page-bounce=""
      style={{ position: 'relative' }}
    >
      <div className="max-w-2xl mx-auto pb-8">
        <div className="pt-5" aria-hidden="true" />
        {state.open ? (
          <div data-weekly-digest-pane="">
            {state.loading && !state.data ? (
              <SkeletonGroup label={t('loading')} className="pt-3">
                {[0, 1].map((i) => (
                  <div key={i} className="mb-5">
                    <Skeleton shape="muted" className="mx-4 mb-2 w-24" />
                    <GroupedList>
                      {[0, 1, 2].map((r) => (
                        <div
                          key={r}
                          className={r < 2
                            ? 'border-b border-[color:var(--app-sheet-line)] px-4 py-3'
                            : 'px-4 py-3'}
                        >
                          <Skeleton shape="line" className="mb-2 w-3/4" />
                          <Skeleton shape="muted" className="w-1/3" />
                        </div>
                      ))}
                    </GroupedList>
                  </div>
                ))}
              </SkeletonGroup>
            ) : state.error ? (
              <div className="px-4 pt-3" role="status">
                <p className="text-sm text-zinc-500 dark:text-zinc-400">{t('error')}</p>
                <button
                  type="button"
                  className="mt-1 inline-flex min-h-[44px] items-center py-1 text-[13px] font-semibold text-violet-700 hover:text-violet-800 dark:text-violet-300 dark:hover:text-violet-200 md:min-h-0"
                  onClick={() => weeklyDigestController.reload()}
                >
                  {t('retry')}
                </button>
              </div>
            ) : !state.data || !state.data.projects.length ? (
              <p className="px-4 pt-3 text-sm text-zinc-500 dark:text-zinc-400">{t('empty')}</p>
            ) : (
              <>
                <p className="px-4 pb-2 text-[13px] text-zinc-500 dark:text-zinc-400">
                  {t('range', { from: longDate(state.data.since), to: longDate(state.data.until) })}
                  {' · '}
                  {t('wentLiveCount', { count: state.data.mergedTotal })
                    + ' ' + t('inProjects', { count: state.data.projectCount })}
                </p>
                {state.data.projects.map((project) => (
                  <ProjectCard key={project.slug} project={project} />
                ))}
              </>
            )}
          </div>
        ) : null}
      </div>
    </main>
  );
}
