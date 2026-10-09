/**
 * The Kudos pane — `#leaderboard-root` (#1191 slice 6, conversion 6, the
 * second of the Leaderboard screen's three panes).
 *
 * The only writer of the DOM below that root. ./leaderboard.js still owns
 * everything that makes the pane WORK — the tab and window state, the pane
 * cache, the six fetches, the keyset cursor, the `kudos_update` refresh, the
 * hash sync — and hands over two descriptors, `chromeView()` and `bodyView()`.
 * This file spells them as markup, class string for class string.
 *
 * ── Two descriptors, not one ───────────────────────────────────────────
 *
 * Because the pane always re-rendered at two rates: `_render()` rebuilds the
 * chrome when the tab selection changes, `_renderBody()` rebuilds the body on
 * every load, cache hit and load-more toggle. Keeping them apart means a body
 * refresh cannot re-key the sub-tab strip out from under a click. See
 * ./kudos-pane-store.js's header.
 *
 * ── Why these buttons are plain `<button>`s ────────────────────────────
 *
 * Neither primitive can spell them, and this slice's contract is that nothing
 * moves visually:
 *
 * - `<Button>`'s cva groups emit in the order [layout] [radius + surface]
 *   [disabled] [padding + weight] [ink]. The window pills and history chips
 *   are written the other way round — `px-3 py-1 text-xs font-medium
 *   rounded-full` then the fill — so routing them through the primitive would
 *   need the group order changed, which would move the rendered class
 *   attribute of every other button in the shell.
 * - `<TabsTrigger>` renders `aria-current`, which the window pills and history
 *   chips never had — and should not, since they are not tabs.
 *
 * The SUB-TAB strip is the exception, and is a `<TabsTrigger>` as of #2441.
 * It was an underline row (`border-b-2`, `border-violet-500` under the active
 * label) sitting directly beneath the reskinned section strip on the same
 * screen — the one shape @/components/ui/tabs.tsx exists to retire, two
 * inches below a strip that had already retired it. Restyling it meant giving
 * up the "nothing moves visually" clause for this strip anyway, so it adopts
 * the primitive whole: the same track, the same near-black selected fill, and
 * `aria-current` along with them. Nothing selects on these buttons —
 * `data-lb-sub` appears in no dapp.json check — so the added attribute costs
 * nothing and the strip stops being a second implementation of tabs.
 *
 * That leaves the two violet-filled toggles (the active window pill, the
 * active history chip) as literal `bg-violet-600` inside a `<button>` tag,
 * which is what tests/shell-primitive-adoption.test.js looks for — so this
 * file is on that test's allow-list, for the same reason
 * dev-board/board-frame.tsx is: a segmented toggle's fill is not a primary
 * button's fill.
 *
 * ── Initial render ─────────────────────────────────────────────────────
 *
 * `mounted: false` renders NOTHING — the hand-written shell shipped
 * `#leaderboard-root` empty and hidden, because Kudos is not the default
 * section and `_render()` wrote the interior on the pane's first open. The SSG
 * pass in frontend/scripts/build-shell.mjs reproduces the empty root, and the
 * store's initial value is what makes it do so.
 */

import { Fragment, useRef, type ReactNode } from 'react';

import { Skeleton, SkeletonGroup } from '@/components/ui/skeleton';
import {
  SECTION_TAB_ACTIVE,
  SECTION_TAB_INACTIVE,
  SECTION_TABS_LIST_BASE,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';

import { useScrollFade } from '../../lib/use-scroll-fade';
import { useStoreState } from '../../lib/use-store-state';
import { MessageButton } from '../profile/message-button';
import { kudosPaneStore } from './kudos-pane-store.js';

type Tone = 'emerald' | 'amber' | 'zinc' | 'violet' | 'sky' | 'red';

type Badge = { tone: Tone; label: string; title?: string };

type ChromeView =
  | { kind: 'profile'; who: string; initial: string; canMessage?: boolean }
  | {
      kind: 'tabs';
      subtitle: string;
      subTabs: { key: string; active: boolean; label: string }[];
      winTabs: { key: string; active: boolean; label: string }[];
    };

type PrRow = {
  key: string;
  rank: number;
  title: string;
  author: string;
  appName: string;
  badge: Badge;
  slug: string;
  sessionId: string | number;
  kudos: number;
};

type UserRow = {
  key: string;
  rank: number;
  who: string;
  initial: string;
  meta: { text: string; title?: string }[];
  unmergedNote: string | null;
  mergedKudos: number;
};

type ProfileRow = {
  key: string;
  title: string;
  appName: string;
  badge: Badge;
  when: string;
  extUrl: string | null;
  slug: string;
  sessionId: string | number;
  kudos: number;
};

type MetaBit =
  | { kind: 'text'; text: string }
  | { kind: 'badge'; tone: Tone; text: string; title?: string }
  | { kind: 'italic'; text: string };

type HistoryRow = {
  key: string;
  marker:
    | { kind: 'kudos' }
    | { kind: 'bounty' }
    | { kind: 'pr_vote'; yes: boolean }
    | { kind: 'proposal_vote'; up: boolean };
  title: string;
  meta: MetaBit[];
  when: string;
  slug: string;
};

type MoreView = { loading: boolean } | null;

type BodyView =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'empty'; message: string }
  | { kind: 'prs'; rows: PrRow[] }
  | { kind: 'users'; rows: UserRow[] }
  | {
      kind: 'profile';
      stats: { kudosMerged: string; chips: { label: string; title: string }[] };
      rows: ProfileRow[] | null;
      more: MoreView;
    }
  | {
      kind: 'history';
      chips: { key: string; label: string; on: boolean }[];
      list:
        | { kind: 'loading' }
        | { kind: 'error'; message: string }
        | { kind: 'empty'; message: string }
        | { kind: 'rows'; rows: HistoryRow[] };
      more: MoreView;
    };

const controller = () => (window as { Leaderboard?: any }).Leaderboard;

/** The one badge table. Every `{tone,label}` the module builds reads from it. */
const BADGE = 'px-1.5 py-0.5 rounded text-[10px] font-semibold';

const TONES: Record<Tone, string> = {
  emerald: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  amber: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  zinc: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
  violet: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
  sky: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
  red: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
};

const HINT = 'py-8 text-center text-sm text-zinc-500 dark:text-zinc-400';
const ERROR_HINT = 'py-8 text-center text-sm text-red-700 dark:text-red-400';

/** The list row, shared by all four lists. The profile row adds the cursor. */
const ROW = 'w-full text-left flex items-center gap-3 px-3 py-2.5 rounded-lg '
  + 'border border-zinc-200 dark:border-zinc-800 '
  + 'hover:bg-zinc-50 dark:hover:bg-zinc-900 transition-colors';

const ROW_TITLE = 'text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate';
const ROW_META = 'text-xs text-zinc-500 mt-0.5 flex items-center gap-1.5 flex-wrap dark:text-zinc-400';

const KUDOS_PILL = 'shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full '
  + 'bg-violet-50 dark:bg-violet-900/30 border border-violet-200 dark:border-violet-700 '
  + 'text-violet-700 dark:text-violet-300 text-sm font-semibold';

const MORE_BTN = 'px-4 py-1.5 text-sm font-medium rounded-lg '
  + 'border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 '
  + 'hover:bg-zinc-50 dark:hover:bg-zinc-900';

const CLAP = '\u{1F44F}';

function StatusBadge({ badge }: { badge: Badge }): ReactNode {
  return <span className={`${BADGE} ${TONES[badge.tone]}`} title={badge.title}>{badge.label}</span>;
}

/** The `·` between meta bits. A separate node, so `gap-1.5` spaces it. */
function Dot(): ReactNode {
  return <span className="text-zinc-500 dark:text-zinc-400">·</span>;
}

/**
 * The list's loading state, at the ROW's own geometry.
 *
 * It was the word "Loading…" centred in eight rows of empty space — which
 * says nothing about what is coming and, on a screen whose lists are its
 * whole content, reads as a screen with nothing on it.
 *
 * The wrapper is `ROW` itself, the constant all four of this pane's lists
 * draw with, so the placeholders carry the real border, radius and padding
 * and cannot drift from the rows they stand in for. The three columns are
 * the row's own: the fixed rank lane, the 36px avatar, and the title/meta
 * pair — plus the kudos pill's shape at the right end, because a row whose
 * right edge is empty and then suddenly is not is the jump this exists to
 * avoid.
 *
 * Five rows: enough to fill the fold on a phone, few enough that a short
 * board does not watch placeholders evaporate.
 */
function Loading(): ReactNode {
  return (
    <SkeletonGroup label="Loading the leaderboard" className="space-y-2">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className={ROW}>
          <div className="w-7 flex justify-center">
            <Skeleton shape="muted" className="w-3" />
          </div>
          <Skeleton shape="circle" className="w-9 h-9" />
          <div className="flex-1 min-w-0">
            <Skeleton className={i % 2 ? 'w-24' : 'w-32'} />
            <Skeleton shape="muted" className={`mt-1.5 ${i % 3 ? 'w-2/5' : 'w-1/3'}`} />
          </div>
          <Skeleton shape="block" className="w-12 h-6 rounded-full" />
        </div>
      ))}
    </SkeletonGroup>
  );
}

/**
 * The keyset Load-more control, shared by the profile and history lists.
 * Disabled AND relabelled while a page is in flight, so a double-click cannot
 * queue a second fetch behind the first.
 */
function More({ more }: { more: MoreView }): ReactNode {
  if (!more) return null;
  return (
    <div className="mt-3 text-center">
      <button
        data-lb-more=""
        className={MORE_BTN}
        disabled={more.loading}
        onClick={() => controller()?._loadMore()}
      >
        {more.loading ? 'Loading…' : 'Load more'}
      </button>
    </div>
  );
}

// ── Chrome ─────────────────────────────────────────────────────────────

/**
 * The profile drill-in's header, which replaces the tab chrome entirely while
 * a profile is open.
 *
 * `data-lb-back` is a real anchor (#1036), so a modified click is the
 * browser's to handle — that is what the NavLink guard in front of
 * `preventDefault()` is for. `inline-block` on it is load-bearing: an `<a>` is
 * inline, and an inline element silently drops the `mb-3` the `<button>` this
 * replaced honoured.
 */
function ProfileHeader({ view }: { view: Extract<ChromeView, { kind: 'profile' }> }): ReactNode {
  return (
    <header className="mb-4">
      <a
        data-lb-back=""
        href="#leaderboard/users"
        className="inline-block text-sm font-medium text-violet-700 dark:text-violet-400 hover:underline mb-3"
        onClick={(e) => {
          // `e` is React's SyntheticEvent, so the guard reads the native one
          // out of it — the same NavLink call, one hop further in, exactly as
          // ../apps/browse-detail.tsx does it.
          const nav = (window as { NavLink?: { isNativeClick(e: unknown): boolean } }).NavLink;
          if (nav && nav.isNativeClick(e.nativeEvent)) return;
          e.preventDefault();
          // Real hash navigation so browser/WebView back behaves; the
          // hashchange route clears profileUser via _setSub('users').
          window.location.hash = '#leaderboard/users';
        }}
      >
        ← Top users
      </a>
      <div className="flex items-center gap-3">
        <div className="w-12 h-12 shrink-0 rounded-full bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 flex items-center justify-center font-semibold text-lg">
          {view.initial}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 truncate">
            {`@${view.who}`}
          </h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            All changes this user has proposed, newest first.
          </p>
        </div>
        {/*
            The prototype's person page carries "Message" beside the name.
            Never on your own page (Leaderboard._canMessage decides).
        */}
        {view.canMessage ? <MessageButton username={view.who} /> : null}
      </div>
    </header>
  );
}

// QA 2026-09-24 Q21: on a phone the sub-tabs and the window pills shared one
// row that did not wrap, so each label broke onto two lines inside a 32px
// pill and was cut top and bottom. Now:
//   * every label stays on one line (`whitespace-nowrap`, `shrink-0`);
//   * below `sm` the two groups stack, sub-tabs over window pills, and the
//     sub-tabs tighten to px-3 (the section strip above does the same at
//     px-2), which fits three labels in a 360px column;
//   * narrower still (320px) the sub-strip scrolls sideways like the section
//     strip, with the same edge fade, rather than clipping.
// SECTION_TAB_BASE's face otherwise: h-8, rounded-full, text-sm semibold.
const SUB_TAB = 'inline-flex items-center justify-center h-8 px-3 sm:px-4 rounded-full text-sm font-semibold transition-colors whitespace-nowrap shrink-0';
const SUB_TABS_LIST = `${SECTION_TABS_LIST_BASE} max-w-full overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden`;
const TAB_ROW = 'flex flex-col items-start gap-2 mb-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3';

const WIN_TAB = 'px-3 py-1 text-xs font-medium rounded-full whitespace-nowrap';
const WIN_TAB_INACTIVE = 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 '
  + 'hover:bg-zinc-200 dark:hover:bg-zinc-700';

/**
 * The sub-tab strip, the window pills and the one-line subtitle. No `<h2>` of
 * its own: the Leaderboard screen shell already titles the page and the
 * section tab above says "Kudos".
 */
function TabChrome({ view }: { view: Extract<ChromeView, { kind: 'tabs' }> }): ReactNode {
  const activeSub = view.subTabs.find((t) => t.active)?.key ?? '';
  const subRef = useRef<HTMLDivElement | null>(null);
  const subFade = useScrollFade(subRef, activeSub);
  return (
    <>
      <header className="mb-4">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">{view.subtitle}</p>
      </header>
      {/*
          No rule under this row any more (#2441). The strip separates by
          figure/ground now, and a `border-b` beneath it would be the
          underline reintroduced one element out.
      */}
      <div className={TAB_ROW}>
        <Tabs
          value={view.subTabs.find((t) => t.active)?.key ?? ''}
          onValueChange={(key) => controller()?._setSub(key)}
        >
          <TabsList ref={subRef} className={SUB_TABS_LIST} style={subFade}>
            {view.subTabs.map((t) => (
              <TabsTrigger
                key={t.key}
                value={t.key}
                data-lb-sub={t.key}
                className={SUB_TAB}
                activeClassName={SECTION_TAB_ACTIVE}
                inactiveClassName={SECTION_TAB_INACTIVE}
              >
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="flex shrink-0 gap-2">
          {view.winTabs.map((t) => (
            <button
              key={t.key}
              data-lb-win={t.key}
              className={`${WIN_TAB} ${t.active ? 'bg-violet-600 text-white' : WIN_TAB_INACTIVE}`}
              onClick={() => controller()?._setWindow(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

// ── Body ───────────────────────────────────────────────────────────────

function PrRows({ rows }: { rows: PrRow[] }): ReactNode {
  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <button
          key={row.key}
          data-lb-pr-route={row.slug}
          data-lb-pr-session={row.sessionId}
          className={ROW}
          onClick={() => controller()?._routeToPr(row.slug, row.sessionId)}
        >
          <div className="w-7 text-center text-sm font-mono text-zinc-500 dark:text-zinc-400">{row.rank}</div>
          <div className="flex-1 min-w-0">
            <div className={ROW_TITLE}>{row.title}</div>
            <div className={ROW_META}>
              <StatusBadge badge={row.badge} />
              <span>{`by @${row.author}`}</span>
              <Dot />
              <span>{row.appName}</span>
            </div>
          </div>
          <div className={KUDOS_PILL}>
            <span aria-hidden="true">{CLAP}</span>
            <span>{row.kudos}</span>
          </div>
        </button>
      ))}
    </div>
  );
}

function UserRows({ rows }: { rows: UserRow[] }): ReactNode {
  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <button
          key={row.key}
          data-lb-user={row.who}
          className={ROW}
          onClick={() => controller()?._openUser(row.who)}
        >
          <div className="w-7 text-center text-sm font-mono text-zinc-500 dark:text-zinc-400">{row.rank}</div>
          <div className="w-9 h-9 rounded-full bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 flex items-center justify-center font-semibold text-sm">
            {row.initial}
          </div>
          <div className="flex-1 min-w-0">
            <div className={ROW_TITLE}>{`@${row.who}`}</div>
            <div className={ROW_META}>
              {row.meta.map((bit, i) => (
                <Fragment key={bit.text}>
                  {i > 0 ? <Dot /> : null}
                  <span title={bit.title}>{bit.text}</span>
                </Fragment>
              ))}
            </div>
          </div>
          {row.unmergedNote ? (
            <span
              className="shrink-0 text-[11px] text-amber-800 dark:text-amber-400"
              title="Kudos on changes that aren’t live yet, not counted toward ranking"
            >
              {row.unmergedNote}
            </span>
          ) : null}
          <div className={KUDOS_PILL} title="Kudos earned on live changes">
            <span aria-hidden="true">{CLAP}</span>
            <span>{row.mergedKudos}</span>
          </div>
        </button>
      ))}
    </div>
  );
}

/**
 * A profile PR row is a `div[role=button]`, not a `<button>`, because the
 * GitHub link nests inside it and an `<a>` may not sit inside a `<button>`.
 * That costs the native Enter/Space activation, so the keydown handler puts it
 * back — and the link stops its own click from also routing the row.
 */
function ProfileRows({ rows }: { rows: ProfileRow[] }): ReactNode {
  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <div
          key={row.key}
          role="button"
          tabIndex={0}
          data-lb-pr-route={row.slug}
          data-lb-pr-session={row.sessionId}
          className={`${ROW} cursor-pointer`}
          onClick={() => controller()?._routeToPr(row.slug, row.sessionId)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              controller()?._routeToPr(row.slug, row.sessionId);
            }
          }}
        >
          <div className="flex-1 min-w-0">
            <div className={ROW_TITLE}>{row.title}</div>
            <div className={ROW_META}>
              <StatusBadge badge={row.badge} />
              <span>{row.appName}</span>
              <Dot />
              <span>{row.when}</span>
            </div>
          </div>
          {row.extUrl ? (
            <a
              href={row.extUrl}
              target="_blank"
              rel="noopener"
              data-lb-ext=""
              title="Open on GitHub"
              className="shrink-0 px-1.5 py-0.5 rounded text-sm text-zinc-500 hover:text-violet-600 dark:hover:text-violet-400 dark:text-zinc-400"
              onClick={(e) => e.stopPropagation()}
            >
              <span aria-hidden="true">↗</span>
              <span className="sr-only">Open on GitHub</span>
            </a>
          ) : null}
          <div className={KUDOS_PILL}>
            <span aria-hidden="true">{CLAP}</span>
            <span>{row.kudos}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function ProfileBody({ view }: { view: Extract<BodyView, { kind: 'profile' }> }): ReactNode {
  return (
    <>
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <span
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-violet-50 dark:bg-violet-900/30 border border-violet-200 dark:border-violet-700 text-violet-700 dark:text-violet-300 text-xs font-semibold"
          title="Kudos earned on live changes: the leaderboard ranking score"
        >
          <span aria-hidden="true">{CLAP}</span>
          <span>{view.stats.kudosMerged}</span>
        </span>
        {view.stats.chips.map((chip) => (
          <span
            key={chip.label}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 text-xs font-medium"
            title={chip.title}
          >
            {chip.label}
          </span>
        ))}
      </div>
      {view.rows
        ? <ProfileRows rows={view.rows} />
        : <div className={HINT}>No changes proposed yet.</div>}
      <More more={view.more} />
    </>
  );
}

function Marker({ marker }: { marker: HistoryRow['marker'] }): ReactNode {
  if (marker.kind === 'kudos') {
    return <span className="text-base" aria-hidden="true">{CLAP}</span>;
  }
  if (marker.kind === 'bounty') {
    return (
      <span className="inline-flex items-center gap-1">
        <span className="text-base" aria-hidden="true">{CLAP}</span>
        <StatusBadge badge={{ tone: 'amber', label: 'bounty' }} />
      </span>
    );
  }
  if (marker.kind === 'pr_vote') {
    return marker.yes
      ? <StatusBadge badge={{ tone: 'emerald', label: 'yes' }} />
      : <StatusBadge badge={{ tone: 'red', label: 'no' }} />;
  }
  return marker.up
    ? <span className="text-emerald-700 dark:text-emerald-400 font-bold" aria-hidden="true">▲</span>
    : <span className="text-red-700 dark:text-red-400 font-bold" aria-hidden="true">▼</span>;
}

/**
 * The history row's meta line. Its separator carries its own spaces — the
 * bits butt against it rather than being spaced by the row's `gap-1.5`, which
 * is how the string version joined them.
 */
function HistoryMeta({ bits }: { bits: MetaBit[] }): ReactNode {
  return (
    <>
      {bits.map((bit, i) => (
        <Fragment key={`${bit.kind}|${bit.text}`}>
          {i > 0 ? <span className="text-zinc-500 dark:text-zinc-400">{' · '}</span> : null}
          {bit.kind === 'badge'
            ? <span className={`${BADGE} ${TONES[bit.tone]}`} title={bit.title}>{bit.text}</span>
            : bit.kind === 'italic'
              ? <span className="italic">{bit.text}</span>
              : bit.text}
        </Fragment>
      ))}
    </>
  );
}

function HistoryRows({ rows }: { rows: HistoryRow[] }): ReactNode {
  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <button
          key={row.key}
          data-lb-pr-route={row.slug}
          className={ROW}
          onClick={() => controller()?._routeToPr(row.slug)}
        >
          <div className="w-12 shrink-0 flex items-center justify-center">
            <Marker marker={row.marker} />
          </div>
          <div className="flex-1 min-w-0">
            <div className={ROW_TITLE}>{row.title}</div>
            <div className={ROW_META}><HistoryMeta bits={row.meta} /></div>
          </div>
          <div className="shrink-0 text-xs text-zinc-500 dark:text-zinc-500">{row.when}</div>
        </button>
      ))}
    </div>
  );
}

/**
 * The two filter chips render in EVERY state — they are how you get out of a
 * filter that returned nothing, so a load failure must not take them with it.
 */
function HistoryBody({ view }: { view: Extract<BodyView, { kind: 'history' }> }): ReactNode {
  return (
    <>
      <div className="flex items-center gap-2 mb-3">
        {view.chips.map((chip) => (
          <button
            key={chip.key}
            type="button"
            data-lb-hfilter={chip.key}
            // The on-state is otherwise only a fill colour (#2991).
            aria-pressed={chip.on}
            className={`px-3 py-1 text-xs font-medium rounded-full border ${
              chip.on
                ? 'bg-violet-600 text-white border-violet-600'
                : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 '
                  + 'border-zinc-200 dark:border-zinc-700 hover:bg-zinc-200 dark:hover:bg-zinc-700'
            }`}
            onClick={() => controller()?._toggleHistoryFilter(chip.key)}
          >
            {chip.label}
          </button>
        ))}
      </div>
      {view.list.kind === 'loading' ? <Loading /> : null}
      {view.list.kind === 'error' ? <div className={ERROR_HINT}>{view.list.message}</div> : null}
      {view.list.kind === 'empty' ? <div className={HINT}>{view.list.message}</div> : null}
      {view.list.kind === 'rows' ? <HistoryRows rows={view.list.rows} /> : null}
      <More more={view.more} />
    </>
  );
}

function Body({ view }: { view: BodyView | null }): ReactNode {
  if (!view || view.kind === 'loading') return <Loading />;
  if (view.kind === 'error') return <div className={ERROR_HINT}>{view.message}</div>;
  if (view.kind === 'empty') return <div className={HINT}>{view.message}</div>;
  if (view.kind === 'prs') return <PrRows rows={view.rows} />;
  if (view.kind === 'users') return <UserRows rows={view.rows} />;
  if (view.kind === 'profile') return <ProfileBody view={view} />;
  return <HistoryBody view={view} />;
}

export function KudosPane(): ReactNode {
  const state = useStoreState(kudosPaneStore) as {
    mounted: boolean;
    chrome: ChromeView | null;
    body: BodyView | null;
  };

  // The prerender state, and the state before the pane's first open.
  if (!state.mounted) return null;

  return (
    <>
      {state.chrome?.kind === 'profile' ? <ProfileHeader view={state.chrome} /> : null}
      {state.chrome?.kind === 'tabs' ? <TabChrome view={state.chrome} /> : null}
      <div id="leaderboard-body" className="mt-2">
        <Body view={state.body} />
      </div>
    </>
  );
}
