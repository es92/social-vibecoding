/**
 * About — the second pane of the app-context sheet (#2718), drawn the way the
 * navigation prototype draws it (nav-prototype.html, `sheetHtml` case
 * 'about'): the app's page, as a pop-up.
 *
 * ── What it says, in the design's order ────────────────────────────────
 *
 *   1. WHO IT IS. A large tile, the name, the tagline, the builders' avatars
 *      and a "<version> · <updated>" pill.
 *   2. WHAT YOU CAN DO WITH IT (an app): Open — Resume for the app you
 *      parked, and nothing at all for the app already running — and Add to
 *      your apps. HOW BIG IT IS (the platform): apps, members, merged.
 *   3. HOW IT IS BUILT. One sentence, true for THIS app's approval rules
 *      (./about-model.ts says why it is assembled rather than fixed).
 *   4. WHO BUILDS IT. Contributors, each with what they have merged, each
 *      opening that person's page.
 *   5. MORE. Share, Add to home screen, View on GitHub, Fork this app.
 *
 * ── It is still a PANE, not a sheet ────────────────────────────────────
 *
 * The design presents About as a sheet of its own. Here it is the menu's
 * second pane, which #2740 settled: the kit cannot present a sheet while it
 * is still dismissing another, and "about" is where the menu goes rather than
 * something that opens over it. What matches the design is the CONTENT and
 * its order; the sheet's header row stays, as the way back.
 *
 * ── Every fact is the one the platform already has ─────────────────────
 *
 * Discover's app page (../apps/browse-detail.tsx) is the same page at full
 * size, so this reads its sources and nothing else: the app row, its ranked
 * contributors, and Home.menuItemsFor's action list — see ./about-data.ts.
 * Homeroom's pane adds GET /api/platform/about for its figures.
 *
 * ── The product's own truths, kept ─────────────────────────────────────
 *
 *   - `#improve-row-github` is the design's "Source code": View on GitHub,
 *     only where there is a repository, opening away from the shell.
 *   - `#improve-row-share` keeps its id and, for an app, its gate and its
 *     dialog: Share hands somebody the app's live address, so it appears
 *     whenever the app HAS one (`canShare` — running, with a URL), from its
 *     Workshop as much as from its frame. An app still being created,
 *     errored or waiting on secrets has no page to send anyone to, and a row
 *     that opened a dialog with an empty link would be worse than no row.
 *     Homeroom always has an address — this one — so its Share is always
 *     there, and hands over the platform's own link.
 *   - Add to home screen is a ROW now, as the design draws it, but it is the
 *     row the product already had: for an app, the per-app install page its
 *     card menu and its Discover page offer (#1508, #2320) — found in
 *     Home.menuItemsFor by key, not rebuilt; for Homeroom, which IS this
 *     page's PWA, the OS's own steps, because iOS exposes no install API and
 *     Android's prompt fires only when Chrome decides it should
 *     (../mobile-install/detect.ts). Wherever there is no home screen — a
 *     laptop, or an app already launched from one — there is no row.
 *
 * ── A viewer who is not served the platform's row ──────────────────────
 *
 * About Homeroom still opens for them (./platform-target.js): who it is, the
 * three figures, how it is built, Share and View on GitHub. The contributor
 * list is the platform row's, which the API does not serve them, so it is not
 * drawn rather than drawn as an error.
 */

import { useMemo, useState, type ReactNode } from 'react';

import {
  CheckIcon,
  Glyph,
  GitHubIcon,
  ShareIcon,
} from '@/components/ui/icons';

import { agoStamp } from '../../lib/timestamp';
import { useStoreState } from '../../lib/use-store-state';
import { AppIconContent, AppIconLink, appIconKind } from '../apps/app-card-view';
import { improveStore } from '../improve/improve-store.js';
import { A2HS_STEPS, detectMobileOs } from '../mobile-install/detect';
import { isNativeApp, isStandalone } from '../mobile-install/environment';
import { parkedStore } from '../nav/parked-store.js';
import { AppContext } from './app-context-controller.js';
import {
  appNote,
  contributorView,
  openLabel,
  platformNote,
  shortVersionOf,
  statCards,
  taglineOf,
  versionPillText,
  type AppRow,
} from './about-model';
import {
  listRowFor,
  useAboutApp,
  useContributors,
  usePlatformAbout,
} from './about-data';

const ROW = 'flex items-center gap-3 px-5 min-h-[44px] text-sm w-full text-left '
  + 'text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800 '
  + 'transition-colors';

/** The menu's own section label (./app-context-sheet.tsx SECTION). */
const SECTION = 'px-5 pt-4 pb-1 text-[0.7rem] font-semibold uppercase tracking-wide '
  + 'text-zinc-400 dark:text-zinc-500';

const NOTE = 'px-5 py-2 text-sm text-zinc-500 dark:text-zinc-400';

/**
 * The two glyphs the icon set has no name for, drawn on its grid through its
 * escape hatch: the design's fork, and its "add to home screen" plus-in-a-
 * phone. A table because that is what `Glyph` is for.
 */
const GLYPHS = {
  fork: 'M6 7a2 2 0 100-4 2 2 0 000 4zm12 0a2 2 0 100-4 2 2 0 000 4zm-6 14a2 2 0 100-4 2 2 0 000 4zM6 7v1a4 4 0 004 4h4a4 4 0 004-4V7m-6 5v5',
  homeScreen: 'M7 3h10a3 3 0 013 3v12a3 3 0 01-3 3H7a3 3 0 01-3-3V6a3 3 0 013-3zm5 5v8m-4-4h8',
} as const;

/** How many contributors show before "Show all" — Discover's own fold. */
const CONTRIB_FOLD = 5;

type HomeApi = {
  isYours?: (app: AppRow) => boolean;
  toggleAdded?: (slug: string, desired: boolean, onChange?: () => void) => unknown;
  menuItemsFor?: (app: AppRow) => Array<{ key: string; label: string; run: (el?: unknown) => void }>;
};

function home(): HomeApi | null {
  return (typeof window === 'undefined' ? null : (window as unknown as { Home?: HomeApi }).Home) || null;
}

function Icon({ children }: { children: ReactNode }): ReactNode {
  return (
    <span className="shrink-0 [&>svg]:h-5 [&>svg]:w-5 text-zinc-500 dark:text-zinc-400" aria-hidden="true">
      {children}
    </span>
  );
}

/** A MORE row that does something (a button), dismissing the menu first when asked. */
function ActionRow({ id, icon, label, onClick }: {
  id: string;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}): ReactNode {
  return (
    <button id={id} type="button" className={ROW} onClick={onClick}>
      <Icon>{icon}</Icon>
      <span className="flex-1 min-w-0 truncate font-medium">{label}</span>
    </button>
  );
}

/**
 * The menu dismisses before anything that presents a surface of its own —
 * the share dialog, the fork dialog, the install page — because the kit
 * cannot present one while it is still tearing the other down (the ordering
 * the terminal and Share rows already keep).
 */
function afterDismiss(then: () => void): void {
  void AppContext.dismissForNav().then(then);
}

/** A person's initial in the roster's circle — Discover's contributor disc. */
function Avatar({ who, size }: { who: string; size: 'sm' | 'xs' }): ReactNode {
  const box = size === 'xs'
    ? 'w-6 h-6 text-[0.625rem] ring-2 ring-white dark:ring-zinc-900'
    : 'w-7 h-7 text-xs';
  return (
    <span
      aria-hidden="true"
      className={`${box} shrink-0 rounded-full bg-violet-100 dark:bg-violet-900/40 `
        + 'text-violet-700 dark:text-violet-300 font-semibold flex items-center justify-center'}
    >
      {(who[0] || '?').toUpperCase()}
    </span>
  );
}

/**
 * Homeroom's link, handed over the way the device offers: the OS share sheet
 * where there is one, the clipboard where there is not. Called straight from
 * the tap — both APIs refuse a call that is not inside a user gesture, so
 * this cannot wait for the menu to close first.
 */
async function sharePlatform(name: string): Promise<'shared' | 'copied' | 'failed'> {
  const url = `${window.location.origin}/`;
  const nav = navigator as Navigator & { share?: (data: ShareData) => Promise<void> };
  if (typeof nav.share === 'function') {
    try {
      await nav.share({ title: name, url });
      return 'shared';
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return 'shared';
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    return 'copied';
  } catch {
    return 'failed';
  }
}

/**
 * The roster's rows and its fold. The rows sit in their own wrapper so the
 * toggle can name what it opens (aria-controls) and say whether it is open
 * (aria-expanded), as Discover's list's "Show more" does (#2991). The wrapper
 * adds no box of its own: each row is already a full-width flex line.
 */
export function ContributorsFold({ people, total, showAll, onToggle }: {
  people: ReturnType<typeof contributorView>[];
  total: number;
  showAll: boolean;
  onToggle: () => void;
}): ReactNode {
  const shown = showAll ? people : people.slice(0, CONTRIB_FOLD);
  return (
    <>
      {shown.length ? (
        <div id="app-about-contributors-list">
          {shown.map((c) => (
            <a
              key={c.who}
              data-contributor={c.who}
              href={`#leaderboard/users/${encodeURIComponent(c.who)}`}
              className={ROW}
              onClick={() => { void AppContext.dismissForNav(); }}
            >
              <Avatar who={c.who} size="sm" />
              <span className="flex-1 min-w-0 truncate font-medium">{`@${c.who}`}</span>
              <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">{`${c.merged} live`}</span>
            </a>
          ))}
        </div>
      ) : null}
      {people.length > CONTRIB_FOLD ? (
        <button
          id="app-about-contributors-toggle"
          type="button"
          aria-expanded={showAll}
          aria-controls="app-about-contributors-list"
          className="w-full px-5 min-h-[40px] text-left text-sm font-medium text-violet-700 dark:text-violet-400 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
          onClick={onToggle}
        >
          {showAll ? 'Show fewer' : `Show all ${total} contributors`}
        </button>
      ) : null}
    </>
  );
}

export function AboutPane({ label }: { label: string }): ReactNode {
  const {
    slug, target, restricted, repoUrl, canShare, version, iconUrl, iconEmoji, tab, deploying,
  } = useStoreState(improveStore);
  const { app: parked } = useStoreState(parkedStore);
  const platform = target === 'platform';
  const isApp = target === 'app';

  const row = useAboutApp(slug, !!slug && !restricted);
  const contributors = useContributors(slug, !!slug && !restricted);
  const about = usePlatformAbout(platform);

  const [added, setAdded] = useState<boolean | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [a2hsOpen, setA2hsOpen] = useState(false);
  const [shareSaid, setShareSaid] = useState<string | null>(null);

  // Read once per mount rather than per render: neither the user agent nor
  // the touch-point count changes while a sheet is open, and this pane is
  // mounted and unmounted by the view switch above it.
  const os = useMemo(() => (typeof navigator === 'undefined'
    ? null
    : detectMobileOs(navigator.userAgent, navigator.maxTouchPoints || 0)), []);

  // The card menu's items for this app — the list Discover's page draws its
  // action rows from. Two of them are About's MORE rows.
  const items = useMemo(() => {
    const menuItemsFor = home()?.menuItemsFor;
    if (!isApp || !row || typeof menuItemsFor !== 'function') return [];
    try { return menuItemsFor(row) || []; } catch { return []; }
  }, [isApp, row]);
  const homeScreenItem = items.find((i) => i && (i.key === 'add-to-homescreen' || i.key === 'install'));
  const forkItem = items.find((i) => i && i.key === 'fork');

  // ── Identity ──────────────────────────────────────────────────────
  const tagline = platform ? (about?.tagline || taglineOf(row)) : taglineOf(row);
  const shortSha = platform
    ? (about?.version || version || shortVersionOf(row))
    : (shortVersionOf(row) || version);
  const updatedAt = platform
    ? (about?.updatedAt || row?.last_deploy_at || null)
    : (row?.last_deploy_at || row?.created_at || null);
  const updated = updatedAt ? agoStamp(updatedAt) : null;
  const pill = deploying && !platform
    ? 'Deploying…'
    : versionPillText(shortSha || null, updated?.text || null);
  const ready = contributors.state === 'ready' ? contributors.items : [];
  const stack = ready.slice(0, 4).map(contributorView);
  const record = {
    icon_url: row?.icon_url || iconUrl || (row?.icon_image_id ? `/app-icons/${row.icon_image_id}` : null),
    icon_emoji: row?.icon_emoji || iconEmoji || null,
    name: label,
  };

  // ── Actions (an app) ──────────────────────────────────────────────
  const running = isApp && tab === 'app';
  const isParked = !!parked && parked.slug === slug;
  const open = openLabel(row?.status || (canShare ? 'running' : null), isParked);
  const listRow = listRowFor(slug);
  const yours = added ?? !!(
    (listRow && home()?.isYours?.(listRow))
    || (!listRow && row && ((row.is_collaborator && !row.your_apps_hidden) || row.is_favorited))
  );

  // ── More ──────────────────────────────────────────────────────────
  const repo = platform ? (about?.repoUrl || repoUrl) : (repoUrl || row?.repo_url || null);
  const showShare = platform || canShare;
  const platformA2hs = platform && !!os
    && typeof window !== 'undefined' && !isStandalone() && !isNativeApp();
  const showHomeScreen = platform ? platformA2hs : !!homeScreenItem;
  const showFork = isApp && !!forkItem;

  // The platform's rules are its row's, which a cold tab may still be loading
  // (./about-data.ts asks Home for the list): no sentence until they are here,
  // rather than the default rules for a moment and then the platform's own.
  const note = platform
    ? (restricted || row ? platformNote(row, !!restricted) : null)
    : appNote(row);
  const people = ready.map(contributorView);

  return (
    <div id="app-about-pane" className="pb-1">
      {/*
          WHO IT IS. The name is always here, so the pane never opens empty
          whatever else is missing: an app with no manifest description shows
          its ADDRESS in the tagline's place — what a URL says, what a support
          conversation quotes, and the only name two apps called the same thing
          do not share.
      */}
      <div id="app-about-identity" className="flex items-start gap-3.5 px-5 pt-2 pb-3">
        {platform ? (
          <img
            src="/brand/homeroom-mark.png"
            alt=""
            aria-hidden="true"
            draggable="false"
            width={64}
            height={64}
            className="platform-mark-tile w-16 h-16 rounded-2xl shrink-0"
          />
        ) : (
          <AppIconLink
            // The Open button's destination and exit: the sheet closes first.
            slug={isApp && open.canOpen && !running ? slug : null}
            name={label}
            onOpen={(s) => afterDismiss(() => window.App?.openAppTab?.(s, 'app'))}
            className="app-icon-tile w-16 h-16 shrink-0 rounded-2xl overflow-hidden flex items-center justify-center font-bold text-2xl"
            data-icon={appIconKind(record)}
          >
            <AppIconContent app={record} />
          </AppIconLink>
        )}
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="text-[1.0625rem] leading-snug font-semibold text-zinc-900 dark:text-zinc-100 break-words">
            {label}
          </div>
          {/* #3572: three lines at most. A description made on the create
              screen fits two lines of the hub hero (services/create-options.js
              DESCRIPTION_MAX); this column, beside the icon and a size
              smaller, needs a third for the same line. A longer one from a
              repository's own dapp.json stops there with an ellipsis. */}
          {tagline ? (
            <p id="app-about-tagline" className="mt-0.5 line-clamp-3 text-[0.8125rem] leading-snug text-zinc-500 dark:text-zinc-400">
              {tagline}
            </p>
          ) : (!platform && slug ? (
            <p className="mt-0.5 text-[0.8125rem] text-zinc-500 dark:text-zinc-400 truncate">
              {`/app/${slug}`}
            </p>
          ) : null)}
          {stack.length || pill ? (
            <div id="app-about-pills" className="mt-2 flex flex-wrap items-center gap-2">
              {stack.length ? (
                <span className="flex -space-x-1.5" aria-hidden="true">
                  {stack.map((c) => <Avatar key={c.who} who={c.who} size="xs" />)}
                </span>
              ) : null}
              {pill ? (
                <span
                  id="app-about-version"
                  title={[shortSha ? `Version ${shortSha}` : null, updated?.title ? `live since ${updated.title}` : null]
                    .filter(Boolean).join(', ') || undefined}
                  className="inline-flex items-center rounded-full bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 text-xs font-medium text-zinc-500 dark:text-zinc-400 whitespace-nowrap"
                >
                  {pill}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {isApp ? (
        <div id="app-about-actions" className="flex items-stretch gap-2 px-5 pb-2">
          {running ? null : (open.canOpen ? (
            <a
              id="app-about-open"
              href={slug ? `/app/${encodeURIComponent(slug)}` : '#'}
              className="inline-flex flex-1 basis-0 min-w-0 items-center justify-center h-10 px-4 rounded-full text-sm font-semibold bg-violet-600 hover:bg-violet-500 text-white transition-colors"
              onClick={(event) => {
                const nav = (window as unknown as {
                  NavLink?: { isNativeClick?: (e: unknown) => boolean };
                }).NavLink;
                if (nav?.isNativeClick?.(event)) return;
                event.preventDefault();
                if (!slug) return;
                // The router's own "this app, this tab": it switches tabs for
                // the open app and navigates for any other — the parked
                // strip's Resume, for the same reason.
                afterDismiss(() => window.App?.openAppTab?.(slug, 'app'));
              }}
            >
              {open.label}
            </a>
          ) : (
            <span
              id="app-about-open"
              aria-disabled="true"
              className="inline-flex flex-1 basis-0 min-w-0 items-center justify-center h-10 px-4 rounded-full text-sm font-semibold bg-zinc-200 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400"
            >
              {open.label}
            </span>
          ))}
          <button
            id="app-about-add"
            type="button"
            data-added={String(yours)}
            disabled={yours}
            // The design's proportions: "✓ Added" is a compact state; "Add to
            // Shortcuts" is sized to its words beside Open — a phone's sheet
            // has not room for both at half width without truncating it —
            // and takes the whole row when Open is gone.
            className={`inline-flex ${!yours && running ? 'flex-1 basis-0' : 'shrink-0'} min-w-0 items-center justify-center gap-1.5 h-10 px-4 rounded-full text-sm font-semibold whitespace-nowrap `
              + 'bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 '
              + 'hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:hover:bg-white dark:disabled:hover:bg-zinc-900 '
              + 'text-zinc-900 dark:text-zinc-100 disabled:text-zinc-500 dark:disabled:text-zinc-400 transition-colors'}
            onClick={() => {
              const api = home();
              if (!slug || !api?.toggleAdded) return;
              setAdded(true);
              // Home keeps both copies of the list honest and says what
              // happened (a toast either way). The pane reads the answer back
              // from the list, so a refused add un-ticks itself.
              api.toggleAdded(slug, true, () => {
                const now = listRowFor(slug);
                if (now && api.isYours) setAdded(!!api.isYours(now));
              });
            }}
          >
            {yours ? (
              <>
                <CheckIcon className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span className="truncate">Added</span>
              </>
            ) : <span className="truncate">Add to Shortcuts</span>}
          </button>
        </div>
      ) : null}

      {platform ? (
        // `data-loaded` once GET /api/platform/about has answered: the cards
        // hold their place with a dash until then, and a check can tell a
        // figure from a placeholder.
        <div
          id="app-about-stats"
          data-loaded={about ? '' : undefined}
          className="grid grid-cols-3 gap-2 px-5 pb-2"
        >
          {statCards(about?.stats || null).map((card) => (
            <div
              key={card.key}
              data-stat={card.key}
              className="rounded-xl border border-zinc-200 dark:border-zinc-700/70 bg-white/70 dark:bg-zinc-800/50 px-1.5 py-2.5 text-center"
            >
              <b className="block text-lg leading-tight font-semibold text-zinc-900 dark:text-zinc-100">
                {about ? card.value : '–'}
              </b>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">{card.label}</span>
            </div>
          ))}
        </div>
      ) : null}

      {(isApp || platform) && note ? (
        <p id="app-about-note" className="px-5 pt-1 pb-1 text-[0.8125rem] leading-relaxed text-zinc-600 dark:text-zinc-300">
          {note}
        </p>
      ) : null}

      {/*
          WHO BUILDS IT — GET /api/apps/:slug/contributors, the list Discover's
          page ranks, in the order it arrives. Each row opens that person's
          page: the leaderboard's drill-in, where Discover's rows go too
          (Browse.openContributor).
      */}
      {(isApp || platform) && !restricted ? (
        <section id="app-about-contributors" aria-label="Contributors">
          <h4 className={SECTION}>Contributors</h4>
          {contributors.state === 'loading' ? <p className={NOTE}>Loading contributors…</p> : null}
          {contributors.state === 'error' ? <p className={NOTE}>Couldn’t load contributors.</p> : null}
          {contributors.state === 'ready' && !people.length ? <p className={NOTE}>No contributors yet.</p> : null}
          <ContributorsFold
            people={people}
            total={contributors.total || people.length}
            showAll={showAll}
            onToggle={() => setShowAll((v) => !v)}
          />
        </section>
      ) : null}

      {showShare || showHomeScreen || repo || showFork ? (
        <section id="app-about-more" aria-label="More">
          <h4 className={SECTION}>More</h4>
          {showShare ? (
            <ActionRow
              id="improve-row-share"
              icon={<ShareIcon />}
              label={shareSaid || 'Share'}
              onClick={() => {
                if (!platform) {
                  // The app's live address, in the share dialog the Improve
                  // panel's footer opened — same method, same gate.
                  afterDismiss(() => {
                    (window as unknown as { Improve?: { share?: () => void } }).Improve?.share?.();
                  });
                  return;
                }
                void sharePlatform(label).then((how) => {
                  const said = how === 'copied' ? 'Link copied' : (how === 'failed' ? 'Could not copy the link' : null);
                  if (!said) return;
                  setShareSaid(said);
                  window.setTimeout(() => setShareSaid(null), 1800);
                });
              }}
            />
          ) : null}
          {showHomeScreen ? (
            <ActionRow
              id="app-about-a2hs"
              icon={<Glyph d={GLYPHS.homeScreen} />}
              label="Add to home screen"
              onClick={() => {
                if (platform) {
                  setA2hsOpen((v) => !v);
                  return;
                }
                if (homeScreenItem) afterDismiss(() => homeScreenItem.run());
              }}
            />
          ) : null}
          {platform && a2hsOpen && os ? (
            <p id="app-about-a2hs-steps" className={NOTE}>{A2HS_STEPS[os]}</p>
          ) : null}
          {repo ? (
            <a
              id="improve-row-github"
              href={repo}
              target="_blank"
              rel="noreferrer"
              className={ROW}
              onClick={() => { void AppContext.dismissForNav(); }}
            >
              <Icon><GitHubIcon /></Icon>
              <span className="flex-1 min-w-0 truncate font-medium">View on GitHub</span>
            </a>
          ) : null}
          {showFork && forkItem ? (
            <ActionRow
              id="app-about-fork"
              icon={<Glyph d={GLYPHS.fork} />}
              label="Fork this app"
              onClick={() => afterDismiss(() => forkItem.run())}
            />
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
