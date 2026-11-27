/**
 * The Settings screen's two navigation hosts, as React (#1191 slice 6,
 * conversion 8).
 *
 * ── What this renders ─────────────────────────────────────────────────
 *
 * `#settings-nav-desktop` — the grouped sidebar: one button per PAGE in a
 * <nav>, the current one marked `aria-current="page"` (which dapp.json
 * selects on). It was a `role="tab"` set with no tablist around it until QA
 * 2026-09-24.
 * `#settings-mobile-menu-host` — the phone's level-1 menu, a LIST of drawer
 * rows: no current marker, a 44px minimum target and a chevron, exactly as
 * the admin console's level-1 menu.
 *
 * Both open with the same FILTER box. A page is a stack of parts since the
 * settings restructure (see SECTIONS in ../settings.js), so "where is
 * Password?" no longer has a row of its own to answer it; typing does. A
 * query swaps the grouped list for a flat list of the pages that match, each
 * naming the parts that did, and choosing one opens that page scrolled to
 * the first matching part.
 *
 * Both are fed by ./settings-nav-store.js, which ../settings.js writes from
 * `_renderNav()`. The grouping is shared (`_groupedSections()`), so the two
 * can never drift into different headings — that was true of the two HTML
 * builders and it stays true of the two descriptor builders.
 *
 * ── Initial render ────────────────────────────────────────────────────
 *
 * Both hosts ship EMPTY in the hand-written shell, and both descriptors start
 * `null`, so the prerendered markup is the two empty elements and nothing
 * else — the filter box included, which renders only beside a descriptor.
 * `Settings.init()` runs from ../index.tsx's layout effect and paints them;
 * no data is fetched during render.
 *
 * ── Why the active row's className comes from the module ──────────────
 *
 * `item.className` is computed in ../settings.js. That is the shaping-stays-
 * in-plain-JS rule (the vm harnesses evaluate that file's real source), and
 * it is also how the string survives the conversion character for character
 * instead of being retyped here. The static classes — group wrappers,
 * headings, menu rows — are this file's, because they never vary. So are the
 * filter's matches: ../settings.js hands over each page's lower-cased terms
 * (`_filterTerms`), and the only work here is comparing them with what the
 * viewer typed.
 *
 * ── Whitespace ────────────────────────────────────────────────────────
 *
 * No `{' '}` anywhere: tests/shell-build.test.js rejects adjacent text
 * children outright (React #418 at hydration). Nothing here needs one — every
 * label is a single expression inside its own element.
 */

import { useEffect, useState } from 'react';
import type { ComponentType, KeyboardEvent, ReactNode, SVGProps } from 'react';

import { GroupedList, ListRow, SectionHeader } from '@/components/ui/grouped-list';
import {
  AppWindowIcon, BellIcon, BookmarkIcon, BookmarkSolidIcon, ChevronDownIcon, ChevronUpIcon, CodeIcon,
  CompassIcon, DescriptionIcon, EyeIcon, GlobeIcon, InfoCircleIcon, LightBulbIcon, LinkIcon, LockIcon,
  PhonePlusIcon, SearchIcon, ShieldCheckIcon, SparklesIcon, SunIcon, TerminalIcon, UserIcon, WalletIcon,
} from '@/components/ui/icons';
import { cn } from '@/lib/utils';

import { RichMessage, useMessages } from '../../lib/i18n/react';
import { useStoreState } from '../../lib/use-store-state';
import { FILTER_SHORTCUT_KEYS, installFilterShortcut } from './filter-shortcut';
import { forgetSearches, loadRecent, recentSearchesStore, rememberSearch, visibleRecent } from './recent-searches.js';
import { settingsNavStore } from './settings-nav-store.js';

interface FilterPart {
  key: string;
  label: string;
  terms: string;
}

/** What ../settings.js's `_filterTerms` attaches to every row, on both hosts. */
interface Filterable {
  key: string;
  label: string;
  terms: string;
  parts: FilterPart[];
}

/**
 * #5995: what a row says at its trailing edge, from ../settings.js's
 * `_navExtras`. `status` is a count in words ("2 linked"), '' when there is
 * nothing to count; `tag` is a small "Beta" label. Never both on one row.
 */
interface RowExtras {
  status: string;
  tag: string;
}

/**
 * #5997: the glyph before a row's name (a name from ../settings.js's ICONS,
 * looked up in NAV_ICONS) and whether the viewer pinned the page. Both are
 * optional, so a descriptor without them renders the row as before.
 */
interface RowLook {
  icon?: string;
  pinned?: boolean;
  /** The key of the page's own group, where an unpin sends it back. */
  home?: string;
}

interface NavItem extends Filterable, RowExtras, RowLook {
  active: boolean;
  className: string;
}

/**
 * `key` is the group's own key (the catalog id's last segment, or `pinned`
 * for #5997's Pinned group) and `folded` whether the viewer folded it. A group
 * without a key draws no fold arrow and its rows no pin controls.
 */
interface NavGroup {
  name: string;
  key?: string;
  folded?: boolean;
  first: boolean;
  items: NavItem[];
}

/** A phone menu row: a page, and the one line under it when its name needs one. */
interface MenuItem extends Filterable, RowExtras, RowLook {
  subtitle: string;
}

interface MenuGroup {
  name: string;
  key?: string;
  folded?: boolean;
  items: MenuItem[];
}

interface NavState {
  desktop: NavGroup[] | null;
  mobile: MenuGroup[] | null;
  visit: number;
}

/** One page that matched the filter, and the parts on it that did. */
interface FilterHit {
  item: Filterable;
  parts: FilterPart[];
}

interface SettingsApi {
  _navClick(key: string): void;
  _setPinned(key: string, on: boolean): void;
  _movePinned(key: string, step: number): void;
  _setGroupFolded(group: string, on: boolean): void;
}

const settingsApi = () => (window as { Settings?: SettingsApi }).Settings;

/** `Settings._navClick` — the single handler both hosts route through. */
const navClick = (key: string) => {
  settingsApi()?._navClick(key);
};

/**
 * #5997: each page's glyph, by the name ../settings.js's ICONS gives it. The
 * shell's own icon set only, so a row's glyph is one the rest of the shell
 * draws too. An unknown name draws nothing.
 */
type Glyph = ComponentType<SVGProps<SVGSVGElement>>;

export const NAV_ICONS: Record<string, Glyph> = {
  user: UserIcon,
  link: LinkIcon,
  shield: ShieldCheckIcon,
  phone: PhonePlusIcon,
  wallet: WalletIcon,
  sparkles: SparklesIcon,
  terminal: TerminalIcon,
  lines: DescriptionIcon,
  sun: SunIcon,
  eye: EyeIcon,
  globe: GlobeIcon,
  bell: BellIcon,
  lock: LockIcon,
  code: CodeIcon,
  compass: CompassIcon,
  window: AppWindowIcon,
  info: InfoCircleIcon,
  bulb: LightBulbIcon,
};

const glyphFor = (name: string | undefined): Glyph | null =>
  (name && Object.prototype.hasOwnProperty.call(NAV_ICONS, name) ? NAV_ICONS[name] : null);

/**
 * The pages whose label, part labels or keywords contain every word of the
 * query, in menu order. A page that matched on its own label lists no parts
 * (the row already says why it is there); one that matched through its parts
 * names them, so "password" answers "Account · Password" rather than a bare
 * "Account" that leaves the viewer guessing.
 */
function filterPages(groups: { items: Filterable[] }[], query: string): FilterHit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits: FilterHit[] = [];
  for (const group of groups) {
    for (const item of group.items) {
      const parts = item.parts.filter((p) => words.every((w) => p.terms.includes(w)));
      const own = words.every((w) => item.terms.includes(w));
      // Words spread across the page label and one part ("account email")
      // still find the page: each word only has to land somewhere on it.
      const anywhere = words.every((w) => item.terms.includes(w) || item.parts.some((p) => p.terms.includes(w)));
      if (!own && !parts.length && !anywhere) continue;
      // Repeating the label of a page's only part ("Usage" under "Usage")
      // says nothing.
      const named = own ? [] : parts.filter((p) => p.label !== item.label);
      hits.push({ item, parts: named });
    }
  }
  return hits;
}

/**
 * The filter's query, emptied on every new visit to the screen (`visit` is
 * Settings._visit). Kept across page switches within a visit, so a viewer
 * can work down a list of results.
 */
function useFilterQuery(visit: number): [string, (q: string) => void] {
  const [query, setQuery] = useState('');
  useEffect(() => { setQuery(''); }, [visit]);
  return [query, setQuery];
}

/**
 * SIGN OUT IS FOUND TOO (5 Oct 2026). It is the button under the menu, not
 * a page, so no page's terms held it, and a search for "Sign out" said "No
 * settings match". The filter offers it as a hit of its own, after the
 * pages, when every word typed starts one of these words ("sign out", "log
 * out", "logout", "sign off"…), three letters at least between them so a
 * stray letter does not offer it. Choosing it presses that button
 * (#settings-logout, whose handler settings.js binds), the one way out.
 */
export const SIGN_OUT_WORDS = ['sign', 'out', 'signout', 'log', 'logout', 'off', 'logoff', 'signoff'];

export function matchesSignOut(query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length || words.join('').length < 3) return false;
  return words.every((w) => SIGN_OUT_WORDS.some((term) => term.startsWith(w)));
}

/** The Sign out hit: the screen's own button, pressed. */
function signOut(setQuery: (q: string) => void) {
  setQuery('');
  (document.getElementById('settings-logout') as HTMLButtonElement | null)?.click();
}

/**
 * What the typed words matched, shown in a hit's label (#5996): each run of
 * the label that one of the words covers is a <mark>. Case-insensitive, as
 * the filter is; a label whose lower-case form changes length (a dotted
 * capital I) is left plain rather than marked at the wrong offsets.
 */
export function highlightRanges(text: string, query: string): [number, number][] {
  const lower = text.toLowerCase();
  if (lower.length !== text.length) return [];
  const covered = new Array<boolean>(text.length).fill(false);
  for (const w of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    for (let at = lower.indexOf(w); at !== -1; at = lower.indexOf(w, at + w.length)) {
      for (let i = at; i < at + w.length; i++) covered[i] = true;
    }
  }
  const ranges: [number, number][] = [];
  covered.forEach((on, i) => {
    if (!on) return;
    const last = ranges[ranges.length - 1];
    if (last && last[1] === i) last[1] = i + 1;
    else ranges.push([i, i + 1]);
  });
  return ranges;
}

const MARK = 'bg-transparent text-zinc-900 dark:text-white font-semibold';

function Highlighted({ text, query }: { text: string; query: string }) {
  const ranges = highlightRanges(text, query);
  if (!ranges.length) return <>{text}</>;
  const out: ReactNode[] = [];
  let from = 0;
  for (const [start, end] of ranges) {
    if (start > from) out.push(text.slice(from, start));
    out.push(<mark key={start} className={MARK}>{text.slice(start, end)}</mark>);
    from = end;
  }
  if (from < text.length) out.push(text.slice(from));
  return <>{out}</>;
}

/** A hit's matched parts, joined as the row's second line. */
function PartLabels({ parts, query }: { parts: FilterPart[]; query: string }) {
  return (
    <>
      {parts.map((p, i) => (
        <span key={p.key}>
          {i ? ' · ' : ''}
          <Highlighted text={p.label} query={query} />
        </span>
      ))}
    </>
  );
}

/**
 * The two settings a no-match line suggests (#5996): Language and Theme,
 * what people most often come looking for. Their labels are read from the
 * menu itself, so the suggestion is always a real name in the viewer's
 * language and always finds something when chosen.
 */
const SUGGESTED_PARTS = ['language', 'theme'];

function suggestions(groups: { items: Filterable[] }[]): string[] {
  const labels: string[] = [];
  for (const key of SUGGESTED_PARTS) {
    for (const group of groups) {
      for (const item of group.items) {
        const part = item.parts.find((p) => p.key === key);
        if (part && !labels.includes(part.label)) labels.push(part.label);
      }
    }
  }
  return labels.length === SUGGESTED_PARTS.length ? labels : [];
}

/** Where choosing a hit goes: the first matching part, else the page. */
const hitTarget = (hit: FilterHit) => (hit.parts[0] ? hit.parts[0].key : hit.item.key);

/**
 * Choosing a hit opens it and empties the box. The filter is a way to a page,
 * not a view of its own: once the page is open, the menu goes back to the
 * grouped list with that page marked current, so the viewer can see where
 * they landed instead of a results list that marks nothing.
 *
 * What was typed is remembered as a recent search first (#5996): choosing a
 * result, by a click or Enter, is the moment a search was worth something.
 * Sign out is not a search result in that sense and is not remembered.
 */
function choose(hit: FilterHit, setQuery: (q: string) => void, query: string) {
  rememberSearch(query);
  setQuery('');
  navClick(hitTarget(hit));
}

/**
 * The filter field, identical on both hosts apart from its id (both hosts are
 * in the document at phone width, so the ids must differ). Enter opens the
 * first hit; Escape clears. A `search` input, so the platform's own clear
 * control and the "search" keyboard return key come for free. Ctrl+K (⌘K) or
 * / puts the cursor here while Settings is open (./filter-shortcut.ts, #5996);
 * nothing on screen says so, the box tells screen readers.
 */
function FilterField({ id, query, setQuery, hits, signOutHit }: {
  id: string;
  query: string;
  setQuery: (q: string) => void;
  hits: FilterHit[];
  signOutHit: boolean;
}) {
  const t = useMessages('settings');
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && hits[0]) {
      e.preventDefault();
      choose(hits[0], setQuery, query);
    } else if (e.key === 'Enter' && signOutHit) {
      // Sign out is the only hit: Enter presses it, as it opens a page.
      e.preventDefault();
      signOut(setQuery);
    } else if (e.key === 'Escape' && query) {
      e.preventDefault();
      setQuery('');
    }
  };
  // THE SHELL'S SEARCH FIELD (overnight audit W05, 1 Nov 2026): the white
  // pill with its glyph that Messages and the Communities screen draw
  // (`.messages-search` in app.css), not the grey boxed form field, which
  // read as disabled and was the one search in the shell without a glyph.
  // `settings-filter` drops the list's own margins; the hosts space it.
  return (
    <div className="messages-search settings-filter">
      <SearchIcon className="messages-search-glyph w-5 h-5" aria-hidden="true" />
      <input
        id={id}
        type="search"
        className="messages-search-input"
        data-settings-filter=""
        aria-label={t('settings:nav.filter.field')}
        placeholder={t('settings:nav.filter.field')}
        autoComplete="off"
        spellCheck={false}
        aria-keyshortcuts={FILTER_SHORTCUT_KEYS}
        value={query}
        onChange={(e) => setQuery(e.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}

const TRY_BUTTON = 'ui-link font-medium text-violet-600 dark:text-violet-400 hover:underline';
// Recent searches' Clear (#5996): the suggestions' blue text button, small.
const RECENT_CLEAR = 'ui-link shrink-0 text-xs font-medium text-violet-600 dark:text-violet-400 hover:underline';

/**
 * What both hosts show when nothing matches: the line saying so, and under
 * it two settings to try (#5996), each a button that fills the box with its
 * name.
 */
function NoMatch({ query, setQuery, groups, className }: {
  query: string;
  setQuery: (q: string) => void;
  groups: { items: Filterable[] }[];
  className: string;
}) {
  const t = useMessages('settings');
  const [first, second] = suggestions(groups);
  return (
    <div data-settings-filter-empty="" role="status" className={className}>
      <p>{t('settings:nav.filter.noMatch', { query: query.trim() })}</p>
      {first ? (
        <p data-settings-filter-try="" className="mt-1">
          <RichMessage
            id="settings:nav.filter.try"
            values={{ first, second }}
            components={[
              <button type="button" className={TRY_BUTTON} onClick={() => setQuery(first)} />,
              <button type="button" className={TRY_BUTTON} onClick={() => setQuery(second)} />,
            ]}
          />
        </p>
      ) : null}
    </div>
  );
}

/**
 * The device's recent searches (#5996), read into ./recent-searches.js's
 * store from an effect on every visit (never during render: the store starts
 * empty, so the prerender is the empty hosts it always was).
 */
function useRecentSearches(visit: number): string[] {
  useEffect(() => { loadRecent(); }, [visit]);
  return visibleRecent(useStoreState(recentSearchesStore)) as string[];
}

/**
 * While the box is empty, the last few searches (#5996), newest first, under
 * "Recent searches" with a Clear button. Choosing one types it into the box
 * again and shows its results; it does not jump to a page, because the
 * settings may have changed since. A row shows exactly what was typed, as
 * text (React escapes it), never translated.
 */
export function RecentSearches({ items, setQuery, variant }: {
  items: string[];
  setQuery: (q: string) => void;
  variant: 'desktop' | 'mobile';
}) {
  const t = useMessages('settings');
  if (!items.length) return null;
  const desktop = variant === 'desktop';
  // The chosen row unmounts as the results replace the block, so the cursor
  // goes to the box first: a keyboard user stays where the search is.
  const replay = (q: string) => {
    (document.getElementById(desktop ? 'settings-filter-desktop' : 'settings-filter-mobile') as HTMLInputElement | null)?.focus();
    setQuery(q);
  };
  return (
    <div data-settings-recent="" className={desktop ? 'mb-1' : 'mb-5'}>
      <div className={desktop ? 'flex items-baseline justify-between gap-2 pe-3' : 'flex items-baseline justify-between gap-2 pe-4'}>
        <SectionHeader className={desktop ? NAV_HEADING : 'ui-cap px-4 pb-1.5'}>{t('settings:nav.filter.recent.heading')}</SectionHeader>
        <button
          type="button"
          data-settings-recent-clear=""
          className={RECENT_CLEAR}
          aria-label={t('settings:nav.filter.recent.clearAria')}
          onClick={forgetSearches}
        >
          {t('settings:nav.filter.recent.clear')}
        </button>
      </div>
      {desktop ? (
        <div className="ui-card">
          {items.map((q) => (
            <ListRow
              key={q}
              as="button"
              inset="text"
              data-settings-recent-item=""
              className={NAV_HIT}
              titleClassName="font-normal"
              title={q}
              chevron={false}
              aria-label={t('settings:nav.filter.recent.again', { query: q })}
              onClick={() => replay(q)}
            />
          ))}
        </div>
      ) : (
        <GroupedList className="mx-0">
          {items.map((q) => (
            <ListRow
              key={q}
              as="button"
              inset="text"
              data-settings-recent-item=""
              className={MENU_ROW}
              titleClassName="font-normal"
              title={q}
              chevron={false}
              aria-label={t('settings:nav.filter.recent.again', { query: q })}
              onClick={() => replay(q)}
            />
          ))}
        </GroupedList>
      )}
    </div>
  );
}

/** Carried over verbatim from the retired _navItemsHtml / _mobileMenuHtml. */
const GROUP_SPACED = 'mt-4 pt-3 border-t border-zinc-200 dark:border-zinc-800';
// The widget language labels a group in SENTENCE CASE at reading size, not as
// a small-caps micro-caption — same treatment as SectionHeader in
// @/components/ui/grouped-list.tsx, which is what the deck's grouped lists use.
// The settings screen was already grouped-list shaped, so this is the last
// thing that made it read as the old vocabulary.
const NAV_HEADING = 'ui-cap px-3 pb-1';
const MENU_ROW = 'settings-menu-row min-h-[44px] py-2 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800/60 transition-colors';
// The sidebar's filter hits and recent searches: the shared row, at the
// sidebar's own inset and with its hover ground. Its lines are the row's,
// the matched parts the second one, as on a phone.
const NAV_HIT = 'settings-nav-item rounded-lg px-3 py-2 transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800';
// The Sign out hit: a hit row in the button's own red, an action and not a page.
const NAV_SIGN_OUT = 'settings-nav-item rounded-lg px-3 py-2 transition-colors hover:bg-red-500/10';
const SIGN_OUT_TITLE = 'font-normal text-red-700 dark:text-red-400';
// #5995: a row's count, in muted words; a settled state gets no colour.
const NAV_STATUS = 'shrink-0 text-xs font-normal text-zinc-500 dark:text-zinc-400';
const MENU_STATUS = 'shrink-0 text-[0.8125rem] text-zinc-500 dark:text-zinc-400';

/**
 * A phone menu row's second line: its count first ("9 connected"), then the
 * line that says what is behind it, joined by a middle dot. Nothing when the
 * row has neither. The count is a span of its own so the declared checks and
 * tests still find `data-settings-nav-status`.
 */
function menuSubtitle(item: MenuItem): ReactNode {
  if (!item.status) return item.subtitle || undefined;
  return (
    <>
      <span data-settings-nav-status="">{item.status}</span>
      {item.subtitle ? <span>{` · ${item.subtitle}`}</span> : null}
    </>
  );
}
// The "Beta" label: a small grey pill, no accent (colour is for actions).
const BETA_TAG = 'ui-pill shrink-0 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-semibold leading-4 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300';

/** A row's trailing words or tag, or nothing. */
function RowTrailing({ extras, statusClassName }: { extras: RowExtras; statusClassName: string }) {
  if (extras.tag) return <span data-settings-nav-tag="" className={BETA_TAG}>{extras.tag}</span>;
  if (extras.status) return <span data-settings-nav-status="" className={statusClassName}>{extras.status}</span>;
  return null;
}

/**
 * One sidebar row: the shared row, as a button. Navigation, not a tab set
 * (QA 2026-09-24 Q20): a tab needs a tablist parent, and these rows sit in a
 * <nav> between group headings, which no tablist may hold. They are the
 * section links of that <nav>, so the current one says so with aria-current.
 *
 * No chevron (the page opens beside the list, not after it) and no hairline
 * of the row's own: the sidebar draws one between its pinnable rows
 * (app.css, `[data-settings-row] + [data-settings-row]`), and a row there
 * is never its wrapper's last child, so the row's would draw on every one.
 */
function NavRow({ item }: { item: NavItem }) {
  // #5997: the glyph takes the row's own colour (currentColor), so the
  // current page's glyph is in the "where you are" ink with its name.
  const Glyph = glyphFor(item.icon);
  return (
    <ListRow
      as="button"
      inset="none"
      aria-current={item.active ? 'page' : undefined}
      data-settings-nav={item.key}
      className={item.className}
      leading={Glyph ? <Glyph className="h-4 w-4 shrink-0" aria-hidden="true" /> : undefined}
      title={item.label}
      trailing={<RowTrailing extras={item} statusClassName={NAV_STATUS} />}
      chevron={false}
      onClick={() => navClick(item.key)}
    />
  );
}

/**
 * #5997: after a pin, an unpin or a move the row is drawn somewhere else (a
 * different group, or a different place in Pinned), and React may have moved
 * or remade the very button that was pressed. Put the keyboard back on the
 * same control of the same row, or on its pin when that control is now
 * greyed out, so a keyboard user can press "Move up" again and again.
 *
 * A row unpinned into a FOLDED group is not drawn at all, so the keyboard
 * goes to that group's fold arrow, the closest thing to where the row went
 * (one press opens the group on it). Focus never falls to the page.
 */
export function refocus(hostId: string, key: string, control: string, home?: string) {
  requestAnimationFrame(() => {
    const host = document.getElementById(hostId);
    if (!host) return;
    const row = host.querySelector(`[data-settings-row="${key}"]`);
    const el = (row && (
      row.querySelector<HTMLElement>(`[data-settings-control="${control}"]:not(:disabled)`)
      || row.querySelector<HTMLElement>('[data-settings-control="pin"]')
    )) || (home ? host.querySelector<HTMLElement>(`[data-settings-group-fold="${home}"]`) : null)
      || host.querySelector<HTMLElement>('[data-settings-group-fold]');
    el?.focus();
  });
}

const CONTROL = 'flex shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-200/70 hover:text-zinc-900 disabled:pointer-events-none disabled:opacity-35 dark:text-zinc-400 dark:hover:bg-zinc-700/60 dark:hover:text-zinc-100';
const CONTROL_DESKTOP = 'h-6 w-6';
// 44 by 44 on a phone: the shell's minimum tap target.
const CONTROL_PHONE = 'h-11 w-11';
const CONTROL_GLYPH_DESKTOP = 'h-3.5 w-3.5';
const CONTROL_GLYPH_PHONE = 'h-5 w-5';

/**
 * #5997: a row's pin, and on a pinned row its up and down arrows. Siblings of
 * the row's own button (a button may not hold another). `place` is the row's
 * index among the pinned rows and `count` how many there are, so the top
 * row's up arrow and the bottom row's down arrow are greyed out.
 */
function RowControls({ item, place, count, hostId, phone }: {
  item: Filterable & RowLook;
  place: number;
  count: number;
  hostId: string;
  phone: boolean;
}) {
  const t = useMessages('settings');
  const size = phone ? CONTROL_PHONE : CONTROL_DESKTOP;
  const glyph = phone ? CONTROL_GLYPH_PHONE : CONTROL_GLYPH_DESKTOP;
  const page = item.label;
  const move = (step: number, control: string) => {
    settingsApi()?._movePinned(item.key, step);
    refocus(hostId, item.key, control, item.home);
  };
  const pin = () => {
    settingsApi()?._setPinned(item.key, !item.pinned);
    refocus(hostId, item.key, 'pin', item.home);
  };
  const pinLabel = item.pinned ? t('settings:nav.pin.remove', { page }) : t('settings:nav.pin.add', { page });
  const PinGlyph = item.pinned ? BookmarkSolidIcon : BookmarkIcon;
  return (
    <>
      {item.pinned ? (
        <>
          <button
            type="button"
            data-settings-control="up"
            className={cn(CONTROL, size)}
            aria-label={t('settings:nav.pin.up', { page })}
            title={t('settings:nav.pin.up', { page })}
            disabled={place <= 0}
            onClick={() => move(-1, 'up')}
          >
            <ChevronUpIcon className={glyph} aria-hidden="true" />
          </button>
          <button
            type="button"
            data-settings-control="down"
            className={cn(CONTROL, size)}
            aria-label={t('settings:nav.pin.down', { page })}
            title={t('settings:nav.pin.down', { page })}
            disabled={place >= count - 1}
            onClick={() => move(1, 'down')}
          >
            <ChevronDownIcon className={glyph} aria-hidden="true" />
          </button>
        </>
      ) : null}
      <button
        type="button"
        data-settings-control="pin"
        data-settings-pin={item.pinned ? 'on' : 'off'}
        className={cn(CONTROL, size)}
        aria-label={pinLabel}
        title={pinLabel}
        onClick={pin}
      >
        <PinGlyph className={glyph} aria-hidden="true" />
      </button>
    </>
  );
}

/**
 * #5997: folding a group down to its heading, and opening it again. The same
 * down chevron Messages' foldable headings use, turned sideways while folded.
 *
 * On the sidebar it is a small arrow beside the heading. On a phone the whole
 * heading is the button, at least 44px tall
 * and the full width, so the target is never a 36px arrow.
 */
function GroupHeading({ group, className, phone }: {
  group: { name: string; key?: string; folded?: boolean };
  className: string;
  phone: boolean;
}) {
  const t = useMessages('settings');
  if (!group.key || group.key === 'pinned') return <SectionHeader className={className}>{group.name}</SectionHeader>;
  const label = group.folded
    ? t('settings:nav.fold.show', { group: group.name })
    : t('settings:nav.fold.hide', { group: group.name });
  const fold = {
    type: 'button' as const,
    'data-settings-group-fold': group.key,
    'aria-expanded': !group.folded,
    'aria-label': label,
    title: label,
    onClick: () => settingsApi()?._setGroupFolded(group.key as string, !group.folded),
  };
  const chevron = (size: string) => (
    <ChevronDownIcon className={cn(size, 'shrink-0 transition-transform', group.folded && '-rotate-90')} aria-hidden="true" />
  );
  if (phone) {
    return (
      <SectionHeader className={cn(className, 'pb-0 pt-2')}>
        <button {...fold} className={PHONE_FOLD}>
          <span className="min-w-0 flex-1 truncate">{group.name}</span>
          {chevron('h-5 w-5')}
        </button>
      </SectionHeader>
    );
  }
  return (
    <div className="flex items-end">
      <SectionHeader className={cn('min-w-0 flex-1', className)}>{group.name}</SectionHeader>
      <button {...fold} className={cn(CONTROL, 'mb-0.5 me-1 h-6 w-6')}>{chevron('h-3.5 w-3.5')}</button>
    </div>
  );
}

// The phone heading's button: it keeps the heading's small caps (a button
// does not inherit text-transform) and puts the words on the heading's line.
const PHONE_FOLD = 'flex min-h-[44px] w-full items-end gap-2 pb-1.5 text-start uppercase tracking-[0.06em] text-zinc-500 dark:text-zinc-400';

// The sidebar's pin strip: over the row's trailing edge, on the plane colour
// so a long name runs under it, shown while the row is pointed at or holds
// the keyboard (always, on a screen with no pointer that hovers).
const NAV_CONTROLS = 'settings-nav-controls absolute end-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded-md bg-[color:var(--dc-sheet-solid)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100';

/**
 * The desktop sidebar. `className` is NOT rendered on the <nav> — it is a
 * constant on the element below because nothing writes classes to this node
 * at runtime, but the host element itself is rendered here rather than in
 * ../index.tsx so the whole subtree has one owner.
 */
export function SettingsNavDesktop() {
  const t = useMessages('settings');
  const { desktop, visit } = useStoreState(settingsNavStore) as NavState;
  const [query, setQuery] = useFilterQuery(visit);
  const recent = useRecentSearches(visit);
  // One listener for the screen: this host is always mounted, on every width.
  useEffect(() => installFilterShortcut({ doc: document }), []);
  const groups = desktop || [];
  const hits = filterPages(groups, query);
  const signOutHit = matchesSignOut(query);
  const filtering = query.trim() !== '';
  return (
    <nav id="settings-nav-desktop" aria-label={t('settings:nav.sectionsName')} className="space-y-1">
      {/* Held at the sheet's top while the rows scroll under it: opaque plane
          colour, so they do not show through. `-mt-2.5 pt-2.5` spends the
          sheet's own top padding, so the field sits flush. */}
      {desktop ? (
        <div className="ui-search sticky top-0 z-10 -mt-2.5 pt-2.5 pb-3 bg-[color:var(--dc-sheet-solid)]">
          <FilterField id="settings-filter-desktop" query={query} setQuery={setQuery} hits={hits} signOutHit={signOutHit} />
        </div>
      ) : null}
      {filtering ? (
        <div className="ui-card" data-settings-filter-results="">
          {hits.map((hit) => (
            <ListRow
              key={hit.item.key}
              as="button"
              inset="text"
              data-settings-nav={hit.item.key}
              className={NAV_HIT}
              titleClassName="font-normal"
              title={<Highlighted text={hit.item.label} query={query} />}
              subtitle={hit.parts.length ? <PartLabels parts={hit.parts} query={query} /> : undefined}
              chevron={false}
              onClick={() => choose(hit, setQuery, query)}
            />
          ))}
          {signOutHit ? (
            <ListRow
              as="button"
              inset="text"
              data-settings-sign-out=""
              className={NAV_SIGN_OUT}
              titleClassName={SIGN_OUT_TITLE}
              title={t('settings:nav.filter.signOut')}
              chevron={false}
              onClick={() => signOut(setQuery)}
            />
          ) : null}
          {hits.length || signOutHit ? null : (
            <NoMatch query={query} setQuery={setQuery} groups={groups} className="px-3 py-2 text-sm text-zinc-500 dark:text-zinc-400" />
          )}
        </div>
      ) : (
        <>
          {desktop ? <RecentSearches items={recent} setQuery={setQuery} variant="desktop" /> : null}
          {groups.map((group) => (
            <div key={group.key || group.name} className={group.first ? '' : GROUP_SPACED}>
              <GroupHeading group={group} className={NAV_HEADING} phone={false} />
              {/* #5997: a folded group keeps the page you are on, so the sidebar
                  never loses your place. */}
              {/* One neutral wrapper round a group's rows: nothing in the
                  standard look, the kit's card under one of the frame's
                  looks (looks.json "wear": card). */}
              <div className="ui-card">
                {(group.folded ? group.items.filter((item) => item.active) : group.items).map((item, place) => (
                  group.key ? (
                    <div key={item.key} className="group relative" data-settings-row={item.key}>
                      <NavRow item={item} />
                      <span className={NAV_CONTROLS}>
                        <RowControls item={item} place={place} count={group.items.length} hostId="settings-nav-desktop" phone={false} />
                      </span>
                    </div>
                  ) : <NavRow key={item.key} item={item} />
                ))}
              </div>
            </div>
          ))}
        </>
      )}
    </nav>
  );
}

/**
 * The phone's level-1 menu. Empty on desktop — `lg:hidden` on the host is
 * what hides it there, and `mobile: null` is what keeps it empty; both, so
 * that a viewport change without a repaint still cannot show two navs.
 */
export function SettingsMobileMenu() {
  const t = useMessages('settings');
  const { mobile, visit } = useStoreState(settingsNavStore) as NavState;
  const [query, setQuery] = useFilterQuery(visit);
  const recent = useRecentSearches(visit);
  const groups = mobile || [];
  const hits = filterPages(groups, query);
  const signOutHit = matchesSignOut(query);
  const filtering = query.trim() !== '';
  return (
    <div id="settings-mobile-menu-host" className="lg:hidden">
      {mobile ? (
        <div className="ui-search px-1 pb-4">
          <FilterField id="settings-filter-mobile" query={query} setQuery={setQuery} hits={hits} signOutHit={signOutHit} />
        </div>
      ) : null}
      {filtering ? (
        <div className="mb-5" data-settings-filter-results="">
          {hits.length || signOutHit ? (
            <GroupedList className="mx-0">
              {hits.map((hit) => (
                <ListRow
                  key={hit.item.key}
                  as="button"
                  inset="text"
                  data-settings-nav={hit.item.key}
                  className={MENU_ROW}
                  titleClassName="font-normal"
                  title={<Highlighted text={hit.item.label} query={query} />}
                  subtitle={hit.parts.length ? <PartLabels parts={hit.parts} query={query} /> : undefined}
                  onClick={() => choose(hit, setQuery, query)}
                />
              ))}
              {signOutHit ? (
                <ListRow
                  as="button"
                  inset="text"
                  data-settings-sign-out=""
                  className={MENU_ROW}
                  titleClassName={SIGN_OUT_TITLE}
                  title={t('settings:nav.filter.signOut')}
                  chevron={false}
                  onClick={() => signOut(setQuery)}
                />
              ) : null}
            </GroupedList>
          ) : (
            <NoMatch query={query} setQuery={setQuery} groups={groups} className="px-4 text-[15px] text-zinc-500 dark:text-zinc-400" />
          )}
        </div>
      ) : (
        <>
          {mobile ? <RecentSearches items={recent} setQuery={setQuery} variant="mobile" /> : null}
          {groups.map((group) => (
            <div key={group.key || group.name} className="mb-5">
              <GroupHeading group={group} className="ui-cap px-4 pb-1.5" phone />
              {/* #5997: a folded group is its heading alone. */}
              {group.folded ? null : (
              <GroupedList className="mx-0">
                {group.items.map((item) => {
                  const Glyph = glyphFor(item.icon);
                  return (
                  <ListRow
                    key={item.key}
                    as="button"
                    // The row is the whole width of the card, so its press
                    // fill (ListRow's `active:` ground) runs edge to edge and
                    // the card's radius clips it (phone review S9). It used
                    // to share a wrapper with the pin, which cut the fill
                    // short of the bookmark and a few points in from the
                    // card's edge.
                    inset="text"
                    data-settings-nav={item.key}
                    data-settings-row={group.key ? item.key : undefined}
                    className={MENU_ROW}
                    // #5997: the page's glyph, in the row's muted grey.
                    leading={Glyph ? <Glyph className="h-5 w-5 shrink-0 text-zinc-500 dark:text-zinc-400" aria-hidden="true" /> : undefined}
                    // The row's name at the list rows' own weight, as on the
                    // You page (phone review #62): these are the same rows,
                    // each a page with a line under it.
                    title={item.label}
                    // #5995: how much is set up ("2 linked") and, for the few
                    // rows whose name does not say what is behind it, one
                    // muted line (Settings.SUBTITLES). Both UNDER the name
                    // (phone review #62): beside it, the count, the chevron
                    // and a bookmark left the name about 105pt and cut it.
                    subtitle={menuSubtitle(item)}
                    // A "Beta" label is the one thing left on the trailing
                    // edge, before the chevron.
                    trailing={item.tag ? <RowTrailing extras={item} statusClassName={MENU_STATUS} /> : undefined}
                    onClick={() => navClick(item.key)}
                  />
                  );
                })}
              </GroupedList>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

/**
 * THE PAGE'S OWN NAME at the head of the pane (overnight audit W05, 1 Nov
 * 2026), from lg up, where the sidebar is beside it. (Under one of the
 * frame's looks it is drawn for every page and at every width, as the kit's
 * 22px sub-heading: app.css, SETTINGS.) A page of several parts
 * (Account is Profile, Sign-in and Delete account) opened under the first
 * part's heading, so "Account" was lit in the list while the pane said
 * "Profile", and three headings of the same large size stood in one page.
 * Now the page is named once, large, and its parts' headings step down
 * (app.css `.settings-page-title`). Drawn only for a page of several parts:
 * a one-part page's own heading already is its name. Below lg the header
 * names the page (Settings._syncChrome), so this stays hidden there.
 *
 * Nothing until the nav's first paint, which is the prerender's empty pane.
 */
export function SettingsPageTitle() {
  const { desktop } = useStoreState(settingsNavStore) as NavState;
  let label = '';
  for (const group of desktop || []) {
    const hit = group.items.find((item) => item.active);
    if (hit) { label = hit.label; break; }
  }
  if (!label) return null;
  return <h2 className="settings-page-title" data-settings-page-title="">{label}</h2>;
}

/**
 * THE PAGE'S BOOKMARK ON A PHONE (phone review #62, 23 Nov 2026). Each row of
 * the phone's menu used to carry its own 44px bookmark (and a pinned row two
 * arrows), which with the count and the chevron left the row's name about
 * 105pt. The bookmark is on the page it pins instead, at the page's top
 * right: "Pin to the top", or "Pinned" once it is, and on a pinned page the
 * two arrows that move it among the pinned pages. Below lg only; the sidebar
 * keeps its row controls. Nothing until the nav's first paint, and nothing
 * for a page outside a group that pins (the descriptor's `key`).
 */
const PAGE_PIN = 'flex min-h-[44px] items-center gap-1.5 rounded-full px-3 text-[0.8125rem] font-medium text-zinc-600 hover:bg-zinc-200/70 dark:text-zinc-300 dark:hover:bg-zinc-700/60';

export function SettingsPagePin() {
  const t = useMessages('settings');
  const { desktop } = useStoreState(settingsNavStore) as NavState;
  let found: { item: NavItem; group: NavGroup; place: number } | null = null;
  for (const group of desktop || []) {
    const place = group.items.findIndex((item) => item.active);
    if (place >= 0) { found = { item: group.items[place], group, place }; break; }
  }
  if (!found || !found.group.key) return null;
  const { item, group, place } = found;
  const page = item.label;
  const PinGlyph = item.pinned ? BookmarkSolidIcon : BookmarkIcon;
  const label = item.pinned ? t('settings:nav.pin.remove', { page }) : t('settings:nav.pin.add', { page });
  return (
    <div className="settings-page-pin lg:hidden -mt-1 mb-2 flex items-center justify-end gap-1" data-settings-row={item.key} data-settings-page-pin="">
      {item.pinned ? (
        <>
          <button
            type="button"
            data-settings-control="up"
            className={cn(CONTROL, CONTROL_PHONE)}
            aria-label={t('settings:nav.pin.up', { page })}
            title={t('settings:nav.pin.up', { page })}
            disabled={place <= 0}
            onClick={() => settingsApi()?._movePinned(item.key, -1)}
          >
            <ChevronUpIcon className={CONTROL_GLYPH_PHONE} aria-hidden="true" />
          </button>
          <button
            type="button"
            data-settings-control="down"
            className={cn(CONTROL, CONTROL_PHONE)}
            aria-label={t('settings:nav.pin.down', { page })}
            title={t('settings:nav.pin.down', { page })}
            disabled={place >= group.items.length - 1}
            onClick={() => settingsApi()?._movePinned(item.key, 1)}
          >
            <ChevronDownIcon className={CONTROL_GLYPH_PHONE} aria-hidden="true" />
          </button>
        </>
      ) : null}
      <button
        type="button"
        data-settings-control="pin"
        data-settings-pin={item.pinned ? 'on' : 'off'}
        className={PAGE_PIN}
        aria-label={label}
        aria-pressed={!!item.pinned}
        onClick={() => settingsApi()?._setPinned(item.key, !item.pinned)}
      >
        <PinGlyph className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>{item.pinned ? t('settings:nav.pin.pageRemove') : t('settings:nav.pin.pageAdd')}</span>
      </button>
    </div>
  );
}
