/**
 * The bordered block every home panel is drawn in, its section heading, and
 * the links that heading carries.
 *
 * Began as a like-for-like port of `HomePanels._panelShell` /
 * `_leaderboardLink` / `_panelFooter` — same classes, same `data-*`, same
 * order — so the dapp.json checks and the screenshot assertions kept
 * matching. What changed is who owns the
 * listeners: they were eight `querySelectorAll` sweeps in `HomePanels._wire`,
 * re-run after every paint because the paint had just destroyed the nodes they
 * were on, and they are props here.
 *
 * `HomePanels` is read off `window` at call time rather than imported: this
 * file is loaded by the island, the module is loaded by the island, and every
 * read happens inside a handler long after both have evaluated. Importing it
 * would make the module graph circular for no gain.
 */

import type { ReactNode } from 'react';

import { useMessages } from '../../../lib/i18n/react';
import { t as message } from '../../../lib/i18n/runtime';
import type { PanelStamps } from '../panels-store';

export function panels(): any {
  return (typeof window !== 'undefined' ? (window as any).HomePanels : null) || null;
}

/**
 * `data-*` for one block's article, as React props.
 *
 * The names are spelled out rather than built from the keys because Tailwind's
 * neighbour problem applies to attribute names too: a `data-${k}` prop is
 * invisible to anything grepping the source for the selector it serves, and
 * every one of these is selected on from dapp.json.
 */
export function stampProps(stamps: PanelStamps | undefined) {
  if (!stamps) return null;
  const out: Record<string, string> = {};
  if (stamps.featured !== undefined) out['data-featured'] = String(stamps.featured);
  if (stamps.popular !== undefined) out['data-popular'] = String(stamps.popular);
  if (stamps.rows !== undefined) out['data-rows'] = String(stamps.rows);
  return out;
}

/**
 * WHICH TINT a card wears, from a string key.
 *
 * Discover's app cards and Challenges' challenge cards share one five-tint
 * palette (`.home-tint-1` … `-5` in app.css), and the tint is derived from
 * the card's own identity — an app slug, a challenge id — rather than from
 * its POSITION in the lane. Position would repaint the whole row whenever a
 * lane reorders, and an app people recognise by its green card would be blue
 * the next time they looked.
 *
 * Any stable spread will do, so this is the smallest one that is not a
 * pattern: a 32-bit rolling hash, folded to 1..5. It is deterministic across
 * the server prerender and the client, which matters — a tint that differed
 * between them would be a hydration mismatch, which console-errors and fails
 * the proposal checks.
 */
export function tintOf(key: string): string {
  // FNV-1a, which is what a rolling `* 31` hash is not: multiply-then-fold
  // clusters badly over short strings that share a shape (an app slug, a
  // challenge id), and the first draft put four of five demo cards on the
  // same tint. The xor-then-multiply order is the fix, and the final
  // avalanche step is what keeps two slugs differing in one letter apart.
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491);
  h ^= h >>> 13;
  return `home-tint-${(Math.abs(h) % 5) + 1}`;
}

/**
 * THE WHOLE CARD-COLOUR VOCABULARY, as data.
 *
 * Two sets, and the difference between them is who chooses:
 *
 *   TONES are CHOSEN. Twelve tone-50 colours from the HIG-muted palette
 *   (`.home-tone-cream` … `-gray` in app.css), offered in the featured
 *   illustration editor so an author can put their artwork on a colour that
 *   suits it. Named rather than numbered: `blue` survives the palette being
 *   reordered or a thirteenth hue being added, where an index does not, and
 *   the name is what the row is actually called in the palette.
 *
 *   LEGACY_TINTS are HASHED. The five `.home-tint-N` the launcher has always
 *   assigned from a card's own identity (see `tintOf`). They were also, very
 *   briefly, what the editor offered, so a handful of illustrations carry one
 *   as a stored number. They stay valid values — an author who picked one
 *   still sees it — but they are no longer offered.
 *
 * Both sets define the same three custom properties, so a card renders one
 * way whichever it wears. The class strings are complete literals, because
 * Tailwind's extractor is a regex over source text and the CSS here is
 * hand-written for the same reason.
 */
export const TONES = [
  'cream', 'yellow', 'orange', 'coral', 'pink', 'purple',
  'indigo', 'blue', 'teal', 'mint', 'sage', 'gray',
] as const;
export type Tone = (typeof TONES)[number];

export const LEGACY_TINTS = [1, 2, 3, 4, 5] as const;
export type LegacyTint = (typeof LEGACY_TINTS)[number];

const TONE_CLASS: Record<Tone, string> = {
  cream: 'home-tone-cream', yellow: 'home-tone-yellow', orange: 'home-tone-orange',
  coral: 'home-tone-coral', pink: 'home-tone-pink', purple: 'home-tone-purple',
  indigo: 'home-tone-indigo', blue: 'home-tone-blue', teal: 'home-tone-teal',
  mint: 'home-tone-mint', sage: 'home-tone-sage', gray: 'home-tone-gray',
};

const TINT_CLASS: Record<LegacyTint, string> = {
  1: 'home-tint-1', 2: 'home-tint-2', 3: 'home-tint-3', 4: 'home-tint-4', 5: 'home-tint-5',
};

/** Each tone's name as a swatch is labelled: a message id per tone. */
const TONE_LABEL: Record<Tone, string> = {
  cream: 'home:tone.cream',
  yellow: 'home:tone.yellow',
  orange: 'home:tone.orange',
  coral: 'home:tone.coral',
  pink: 'home:tone.pink',
  purple: 'home:tone.purple',
  indigo: 'home:tone.indigo',
  blue: 'home:tone.blue',
  teal: 'home:tone.teal',
  mint: 'home:tone.mint',
  sage: 'home:tone.sage',
  gray: 'home:tone.gray',
};

/** A tone's own name, for a swatch's label. */
export function toneLabel(tone: Tone): string {
  return message(TONE_LABEL[tone]);
}

/**
 * The class for a stored card colour, or null for anything that is neither a
 * tone name nor one of the five legacy tints. Null is the signal to fall back,
 * so an unreadable value paints the card's own default rather than nothing.
 */
export function cardTintClass(value: unknown): string | null {
  if (typeof value === 'string') return TONE_CLASS[value as Tone] || null;
  return LEGACY_TINTS.includes(value as LegacyTint) ? TINT_CLASS[value as LegacyTint] : null;
}

/**
 * What a card actually wears: the colour chosen with its illustration when
 * there is one, otherwise the hash of its own identity. Deliberately one
 * function, because the fallback is the thing that has to match between the
 * server prerender and the client.
 */
export function cardTint(key: string, tint?: unknown): string {
  return cardTintClass(tint) || tintOf(key);
}

/**
 * A home-screen area's LABEL, and the controls that act on the block below it.
 *
 * ── Why the title moved back out of the card ──────────────────────────
 *
 * It lived inside the block's own bar, on the reasoning that N widgets could
 * not share one heading above a section — true while these were draggable grid
 * items and a section could hold several. THE UI OVERHAUL ended that: there is
 * exactly one block per section now, in a fixed order, so the heading has
 * exactly one thing to name.
 *
 * What that bought is the shape the owner's reference screen has: a quiet grey
 * label, then the white card it introduces, repeated down the page. A title
 * printed INSIDE the card competes with the card's own content for the same
 * surface and gives every area a second, smaller header bar; the label outside
 * lets each card be nothing but what it holds.
 *
 * ── …and why the CONTROLS followed it out ─────────────────────────────
 *
 * They did not, at first, and that was worse than leaving the title in. The
 * bar's remaining occupants — Discover's "See all", Challenges' "Open
 * leaderboard", the ⋮ every block carries — are all `shrink-0`, so with the
 * title gone the first row of every card was a strip of white with three
 * quarters of it empty and one link floating at the right. The card opened on
 * chrome instead of on content.
 *
 * A section header with the label left and its one action right is the shape
 * that row was always trying to be, and it is the reference screen's own
 * (name on the left, state on the right). So the heading is a ROW: `label`
 * takes the space, `action` sits at the end of it, and the card underneath
 * holds nothing but the block.
 *
 * NO `id`, deliberately: nothing selects these, and an id would have to be
 * recorded in tests/baselines/shell-markup.json for no one's benefit. The
 * class is `home-area-label` rather than the `home-section-header` this first
 * shipped as — that one is TAKEN (app.css sizes it 12px muted, and the widget
 * strip's caption and the search-results heading are it), and two different
 * labels sharing a class is a rule waiting to be changed for one of them.
 *
 * Sized and coloured as the block titles it replaces (`text-[0.9375rem]`,
 * zinc-500 — the shell's secondary ink), so the type itself is a MOVE rather
 * than a restyle.
 *
 * THE HOMESCREEN DESIGN then restyled it: 16px at weight 550 in the primary ink (a true half-step on the
 * variable system faces iOS, Android and macOS ship; semibold where the
 * face has no 550), the
 * area title rather than a caption, with the area's link beside it at 14px
 * semibold in the brand periwinkle (--brand-ink) and no glyph in front of it.
 * The row's shape is label + link: the ⋮ that used to ride here is gone
 * Section hiding is retired (#1801).
 *
 * THE OWNER'S DECISION, 2 Nov 2026 (overnight UI audit, Y02): Home's labels
 * are the small-caps label every other screen puts over a card, so the shell
 * has one style of section heading, not three. The LABEL takes
 * @/components/ui/grouped-list's SectionHeader literals (12px bold
 * uppercase, tracked 0.06em, muted); the row, its link and the `h2.home-area-
 * label` the declared checks select on stay as they were. The type sits on
 * the label's span, not the h2, so the link beside it (See all, Edit) does
 * not inherit the uppercase or the tracking. No gutter of SectionHeader's:
 * Home's sections carry their own `px-3`, and its `px-4` would indent every
 * label away from the card it heads.
 */
export function SectionHeading({ children, action }: {
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <h2 className="home-area-label flex items-center gap-2 pt-4 pb-1.5 leading-tight">
      <span className="min-w-0 flex-1 truncate whitespace-nowrap text-xs font-bold uppercase tracking-[0.06em] text-zinc-500 dark:text-zinc-400">{children}</span>
      {action}
    </h2>
  );
}

/**
 * Discover's one destination — the `#apps` directory.
 *
 * Lifted out of DiscoverPanel with the rest of the block's chrome, so the
 * section heading can render it beside the label. Same id, same classes, same
 * hash navigation: `#home-browse-btn` is selected on from dapp.json.
 */
export function BrowseLink() {
  const t = useMessages('home');
  return (
    <button
      type="button"
      id="home-browse-btn"
      className="home-panel-browse shrink-0 flex items-center gap-1 text-[14px] font-semibold text-[color:var(--accent)] hover:underline whitespace-nowrap un-touch-target"
      title={t('home:discover.browseAll.tip')}
      aria-label={t('home:discover.browseAll.label')}
      onClick={(e) => {
        e.stopPropagation();
        // Through the hash, so the browse screen gets a real history entry and
        // the OS back gesture returns here.
        window.location.hash = '#apps';
      }}
    >
      <span className="whitespace-nowrap">{t('home:discover.browseAll.text')}</span>
    </button>
  );
}

/**
 * The bordered block: its body, and nothing else.
 *
 * IT HAS NO TITLE BAR ANY MORE. The bar held the block's title until the
 * heading moved out above the card, and then its controls followed (see
 * `SectionHeading`) — so the card begins on its own content. `.home-panel-bar`
 * is gone with it, along with the `user-select` and cursor rules app.css kept
 * for a strip that was once a drag handle.
 *
 * The footer went too: it held Challenges' "See all N challenges" toggle,
 * and "See all" is a link in that section's heading now. So did the
 * `expanded` flag and its `home-panel--expanded` class, with the in-place
 * expansion they drew.
 */
export function PanelShell({
  panelKey, stamps, plate = 'card', children,
}: {
  panelKey: string;
  stamps?: PanelStamps;
  /**
   * WHAT THE BLOCK SITS ON. Two answers:
   *
   *   'card'  — the white plate the blocks have always had.
   *   'none'  — no plate at all. Discover's cards ARE the surface, and a
   *             box around a row of tinted cards is a second frame around
   *             things that already have one. It is also what lets the rail
   *             bleed to both screen edges. Challenges draws on the page
   *             ground too, as the ITERATION 03 board's Home screen does:
   *             its cards and group headers are surfaces of their own.
   *
   * There was a third, 'soft' (a translucent `.home-challenges-plate`), for
   * Challenges alone. It went when that block went flat.
   *
   * `home-panel-card` rides with 'card' only: it is the name of the plate,
   * and tests/home-panels-render.test.js asserts the pairing.
   */
  plate?: 'card' | 'none';
  children: ReactNode;
}) {
  const plateClass = plate === 'card'
    ? ' home-panel-card rounded-2xl bg-white dark:bg-zinc-900 overflow-hidden'
    : '';
  return (
    <article
      className={`home-panel${plateClass}`}
      data-panel={panelKey}
      {...stampProps(stamps)}
    >
      {children}
    </article>
  );
}

/**
 * THE AREA'S WAY IN: "See all", at the right end of the Challenges heading,
 * to the Challenges tab of the Leaderboard screen. It replaced two controls
 * (the Semi design, 2026-10-16): the heading's "Open challenges" (#980,
 * #1916), and the footer's "See all N challenges" / "Show less", which grew
 * the block in place. The block now shows a short pick, and everything else
 * is on the tab.
 *
 * A REAL LINK, `<a href="#leaderboard/challenges">`: it goes somewhere, so
 * it is announced as a link, opens in a new tab on a modified click, and its
 * hash navigation gives the tab a history entry the device's back gesture
 * returns from. The visible "See all" leans on the heading beside it, so the
 * accessible name says what it is all of ("See all challenges") and starts
 * with the visible words, which keeps a voice command that reads them
 * working. Drawn as `BrowseLink` is, the other section heading's link on this
 * screen, with no glyph, so the two line up.
 *
 * ChallengesSectionView renders it only when the view says `seeAll`: never
 * while loading, and not under "No challenges right now", where there is
 * nothing behind it.
 */
export function SeeAllLink() {
  const t = useMessages('home');
  return (
    <a
      href="#leaderboard/challenges"
      className="home-panel-see-all shrink-0 flex items-center gap-1 text-[14px] font-semibold text-[color:var(--accent)] hover:underline whitespace-nowrap un-touch-target"
      aria-label={t('home:challenges.seeAll.label')}
    >
      <span className="whitespace-nowrap">{t('home:challenges.seeAll.text')}</span>
    </a>
  );
}
