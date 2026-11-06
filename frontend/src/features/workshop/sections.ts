/**
 * How a list of your communities is arranged, in one place (#3363).
 *
 * The Communities screen sorted and folded its list here (its list went to
 * Home with One Home, #6361): Public communities, Private communities, Just
 * you; newest first inside each; three shown, then "Show N more". "Your communities"
 * (./community-switcher.tsx, through ./community-scope.ts) lists the same
 * communities in the same newest-first order, reading `orderRows` from here
 * rather than from the screen, which it must not import — and draws the same
 * sections and the same fold (#3519), with `sectionFloor` / `sectionFoldFrom`
 * keeping the community you are on out of any fold.
 *
 * Generic over the row: the screen's rows carry their counts, the panel's do
 * not, and neither the order nor the grouping reads them.
 */

import { t } from '../../lib/i18n/runtime';
import { rankSearch } from '../../lib/search-rank.js';

export type Audience = 'open' | 'invited' | 'solo';

/** What the order and the grouping read off a row. */
export type SectionedRow = {
  audience?: Audience | string;
  last_active_at?: string | null;
  /** A ?demo=1 fixture row (see orderRows). */
  demo?: boolean;
};

/**
 * The three sections, in the order they are drawn, with the words a person
 * sees. `community` / `audience` are internal: AGENTS.md, "Communities own
 * projects". The glyphs say who else is there — a crowd, a lock (you were let
 * in), one person.
 *
 * `label`, `noun` and `count` are message ids
 * (frontend/locales/en/communities.json), read when a section is drawn:
 * `count` is the accessible name of the number beside the heading, and takes
 * the number as `count`.
 */
export const SECTIONS: ReadonlyArray<{ key: Audience; label: string; noun: string; count: string }> = [
  { key: 'open', label: 'communities:sections.open.label', noun: 'communities:sections.open.noun', count: 'communities:sections.open.count' },
  { key: 'invited', label: 'communities:sections.invited.label', noun: 'communities:sections.invited.noun', count: 'communities:sections.invited.count' },
  { key: 'solo', label: 'communities:sections.solo.label', noun: 'communities:sections.solo.noun', count: 'communities:sections.solo.count' },
];

/** How many rows a section shows before "Show N more". */
export const SECTION_LIMIT = 3;

/**
 * How many more rows each press of "Show N more" reveals (#3269). A long
 * section opened all at once turned three rows into thirty, and the next
 * section went off the bottom of the screen; five at a time keeps the list
 * something you read down rather than something you scroll past.
 */
export const SECTION_STEP = 5;

/**
 * The fold for a section of `total` rows with `limit` of them out: how many
 * show, what the fold row says, and the limit a press moves to. Pure, so the
 * three-then-five-then-fewer sequence is tested without a click.
 */
export function sectionFold(total: number, limit: number): { shown: number; label: string | null; next: number } {
  const shown = Math.min(total, Math.max(SECTION_LIMIT, limit));
  if (total <= SECTION_LIMIT) return { shown: total, label: null, next: SECTION_LIMIT };
  const hidden = total - shown;
  if (!hidden) return { shown, label: t('communities:sections.showFewer'), next: SECTION_LIMIT };
  return { shown, label: t('communities:sections.showMore', { count: Math.min(hidden, SECTION_STEP) }), next: shown + SECTION_STEP };
}

/**
 * The number beside a section's heading: how many of its rows the card
 * lists. Folded it reads "3 of 27", so it says what is under it rather than
 * sitting over three rows and a "Show 5 more" (polish N2); with every row
 * out it is the total alone. `count` is the section's own message id for
 * the total's accessible name (SECTIONS).
 */
export function sectionCount(total: number, shown: number, count: string): { text: string; label: string } {
  if (shown >= total) return { text: String(total), label: t(count, { count: total }) };
  return {
    text: t('communities:sections.shownOf', { shown, count: total }),
    label: t('communities:sections.shownOfLabel', { shown, count: total }),
  };
}

/**
 * The fewest rows a section of "Your communities" ever shows (#3519): three,
 * or as many as it takes to reach the community you are on, so no press of
 * "Show fewer" folds away the row with the tick. It was #3363's pickerFloor,
 * for the "Which project?" panel the switcher replaced (#3455).
 */
export function sectionFloor(rows: Array<{ slug: string }>, current: string | null): number {
  const at = current ? rows.findIndex((row) => row.slug === current) : -1;
  return Math.max(SECTION_LIMIT, at + 1);
}

/**
 * `sectionFold`, collapsing to `floor` rather than to three. With the floor
 * at three (nothing ticked, or the ticked row among the three most recent) it
 * IS `sectionFold`, answer for answer. A section whose floor already shows
 * every row has no fold row at all: a "Show fewer" that could show nothing
 * fewer is a dead control.
 */
export function sectionFoldFrom(total: number, limit: number, floor: number): { shown: number; label: string | null; next: number } {
  if (floor <= SECTION_LIMIT) return sectionFold(total, limit);
  if (total <= floor) return { shown: total, label: null, next: floor };
  const shown = Math.min(total, Math.max(floor, limit));
  const hidden = total - shown;
  if (!hidden) return { shown, label: t('communities:sections.showFewer'), next: floor };
  return { shown, label: t('communities:sections.showMore', { count: Math.min(hidden, SECTION_STEP) }), next: shown + SECTION_STEP };
}

/**
 * The viewer's communities, most recently active first.
 *
 * Exported and pure so tests can drive the ordering without a fetch. A row
 * with no `last_active_at` sorts after every dated one, and two rows the
 * clock cannot tell apart keep the server's order (its activity order):
 * `sort` is stable and this comparator answers 0 for them.
 *
 * A ?demo=1 FIXTURE ROW (`demo: true`, src/routes/apps.js's demoIconApps)
 * LEADS ITS SECTION. The declared checks find those rows on this screen, and
 * a section shows only its three most recent: on a staging clone the
 * viewer's real memberships were all joined when the backfill ran, which is
 * more recent than any fixed fixture time, so the fixture fell behind "Show
 * N more" and the checks found nothing. Real rows never carry the flag.
 */
export function orderRows<T extends SectionedRow>(apps: T[]): T[] {
  const at = (row: T) => {
    const t = row.last_active_at ? Date.parse(row.last_active_at) : NaN;
    return Number.isNaN(t) ? -Infinity : t;
  };
  return apps.slice().sort((a, b) => {
    if (!!a.demo !== !!b.demo) return a.demo ? -1 : 1;
    const x = at(a);
    const y = at(b);
    if (x === y) return 0;
    return y > x ? 1 : -1;
  });
}

/**
 * The rows whose name (or short name, when a row has no name) holds the
 * query, in the list's own order, except that an exact name leads (#5472,
 * #5891, as Home.filterApps ranks Your apps): typing a community's full name should
 * find it first, not below rows that merely contain it. The split is stable,
 * so several exact matches keep their order among themselves and the rest
 * keep theirs. Pure, and shared by the Communities screen's search and the
 * phone drawer's, which reads it from here rather than from the screen
 * (the drawer imports the screen, so that way round would be a cycle), and
 * the switcher's. The rule is lib/search-rank.js, every app search's: any
 * case, Latin accents set aside.
 */
export function matchRows<T extends { name?: string | null; slug: string }>(rows: readonly T[], query: string): T[] {
  return rankSearch(rows, query, (row: T) => [row.name || row.slug]) as T[];
}

/**
 * The rows split into the three sections, each in recency order, empty
 * sections left out. An audience the client does not know is read as 'open'
 * — the server's own default — so a row can never fall out of the screen.
 * `label` and `count` are the section's message ids (see SECTIONS).
 */
export function groupRows<T extends SectionedRow>(rows: T[]): Array<{ key: Audience; label: string; count: string; rows: T[] }> {
  const known = (a: unknown): Audience => (a === 'invited' || a === 'solo' ? a : 'open');
  const ordered = orderRows(rows);
  return SECTIONS
    .map((section) => ({
      key: section.key,
      label: section.label,
      count: section.count,
      rows: ordered.filter((row) => known(row.audience) === section.key),
    }))
    .filter((section) => section.rows.length > 0);
}
