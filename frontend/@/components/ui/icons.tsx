import * as React from 'react';

/**
 * The shell's icon set, as named components.
 *
 * ── Why this is NOT `lucide-react` ────────────────────────────────────
 *
 * shadcn's own examples import glyphs from `lucide-react`, and every icon
 * below has a lucide counterpart with the same NAME. It does not have the same
 * PATH. The shell's glyphs are Heroicons v1/v2 outline, hand-picked over
 * several years, and lucide draws them on a different grid with a different
 * stroke rhythm — swapping the set would restyle thirty-odd buttons at once,
 * which is precisely the visual change this migration is not allowed to make.
 * It would also be the first runtime dependency added since step 1, for
 * something the shell already ships inline.
 *
 * So: **every `d` string in this file is transcribed verbatim from the markup
 * it replaces.** If a glyph here ever looks wrong, the fix is to correct the
 * path, never to reach for a package.
 *
 * ── Why three renderers and a table, rather than 25 components ────────
 *
 * The 36 inline `<svg>` blocks this replaces differ in exactly three ways,
 * and the three factories below are those three ways:
 *
 *   `stroked`     — `strokeWidth` on the `<svg>`. Twenty-nine of them.
 *   `strokedPath` — `strokeWidth` on the `<path>`. Five of them, all glyphs
 *                   that predate the others; the rendered result is identical
 *                   but the DOM is not, and a like-for-like conversion keeps
 *                   the DOM.
 *   `filled`      — `fill="currentColor"`, no stroke. One: the GitHub mark.
 *
 * One glyph is written out instead of built: `EllipsisVerticalIcon` is three
 * <circle>s on the 20 grid, and there is no `d` to hand a factory.
 *
 * Everything else — `fill="none"`, `stroke="currentColor"`,
 * `viewBox="0 0 24 24"`, `strokeLinecap`/`strokeLinejoin` on every path — was
 * already identical at all 36 sites, so it lives in the factory.
 *
 * ── Prop order is load-bearing ────────────────────────────────────────
 *
 * React serialises attributes in the order the props are written, and the
 * prerendered public/index.html is compared against the hand-written shell
 * attribute by attribute. `id` and `className` are therefore destructured and
 * rendered FIRST, in that order, with `{...rest}` last — which is the order
 * all 36 call sites already used. `id={undefined}` emits nothing, so the
 * sites without one are unaffected.
 *
 * Size is NOT a variant. Every call site passes its own `className`
 * (`w-4 h-4`, `w-5 h-5`, `w-3.5 h-3.5`, sometimes with `shrink-0` or
 * positioning on top), and a `size` prop would either lose those or have to
 * enumerate them.
 */

export type IconProps = Omit<
  React.SVGProps<SVGSVGElement>,
  'children' | 'viewBox' | 'fill' | 'stroke' | 'd'
>;

function paths(d: string | readonly string[]): readonly string[] {
  return typeof d === 'string' ? [d] : d;
}

/** A 24×24 outline glyph whose stroke width sits on the `<svg>`. */
function stroked(name: string, d: string | readonly string[]) {
  const list = paths(d);
  const Icon = ({ id, className, strokeWidth = '2', ...rest }: IconProps) => (
    <svg
      id={id}
      className={className}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      strokeWidth={strokeWidth}
      {...rest}
    >
      {list.map((entry) => (
        <path key={entry} strokeLinecap="round" strokeLinejoin="round" d={entry} />
      ))}
    </svg>
  );
  Icon.displayName = name;
  return Icon;
}

/** A 24×24 outline glyph whose stroke width sits on the `<path>`. */
function strokedPath(name: string, d: string) {
  const Icon = ({ id, className, ...rest }: IconProps) => (
    <svg id={id} className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" {...rest}>
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d={d} />
    </svg>
  );
  Icon.displayName = name;
  return Icon;
}

/** A 24×24 solid glyph. */
function filled(name: string, d: string) {
  const Icon = ({ id, className, ...rest }: IconProps) => (
    <svg id={id} className={className} fill="currentColor" viewBox="0 0 24 24" {...rest}>
      <path d={d} />
    </svg>
  );
  Icon.displayName = name;
  return Icon;
}

// ── Navigation and chrome ────────────────────────────────────────────────

export const ChevronLeftIcon = strokedPath('ChevronLeftIcon', 'M15 19l-7-7 7-7');

/** The tighter back chevron used in the mobile Messages thread header. */
export const ChevronLeftInsetIcon = stroked('ChevronLeftInsetIcon', 'M15 18l-6-6 6-6');

export const ChevronRightIcon = stroked('ChevronRightIcon', 'M9 5l7 7-7 7');

// Heroicons v1 outline view-grid — the drawer's "Your apps" row (owner
// review round 2: the section header is a nav item of its own).
export const Squares2X2Icon = stroked('Squares2X2Icon', 'M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z');

/**
 * An app WINDOW — a framed rectangle with a title bar (#1367).
 *
 * The "App" segment of the App/Feed/Kanban toggle, sitting beside BoardIcon
 * (kanban columns) and ListLinesIcon (a feed). Those two draw what their view
 * looks like, so this one does too: the running app in its frame, which is the
 * one of the three that is not a view OF the development work.
 */
export const AppWindowIcon = stroked('AppWindowIcon', [
  'M4 6a1 1 0 011-1h14a1 1 0 011 1v12a1 1 0 01-1 1H5a1 1 0 01-1-1V6z',
  'M4 9.5h16',
]);

/**
 * The pencil with a spark — "back to building" on a session screen while its
 * preview is up (Streamlined Concept: the Figma bar names lucide's
 * pencil-sparkles; this is the shell's own transcription of that idea — the
 * composer's pencil body plus a four-point spark in the freed corner).
 */
export const PencilSparklesIcon = stroked('PencilSparklesIcon', [
  'M16.5 6.5a2.12 2.12 0 0 1 3 3L9 20l-4 1 1-4z',
  'M6 3l.75 1.75L8.5 5.5l-1.75.75L6 8l-.75-1.75L3.5 5.5l1.75-.75z',
]);

export const ArrowRightIcon = stroked('ArrowRightIcon', 'M14 5l7 7m0 0l-7 7m7-7H3');

/**
 * The SHORT right arrow, drawn on a tighter inset than ArrowRightIcon. Not a
 * duplicate: this one is the go-into-the-app arrow on #browse-detail-open,
 * where it sits beside a word inside a pill and the long arrow's 3→21 span
 * would crowd the label. Two spellings on purpose, each with one caller.
 */
export const ArrowRightShortIcon = stroked('ArrowRightShortIcon', 'M13 7l5 5m0 0l-5 5m5-5H6');

export const XIcon = stroked('XIcon', 'M6 18L18 6M6 6l12 12');

/**
 * The dev composer's send mark (Streamlined Concept). Its button is a 44px
 * circle now rather than a rectangle carrying the word "Send", so the arrow
 * IS the label — drawn on the full 24 grid, like PlusWideIcon and for the
 * same reason: it is the content of a round control, not a glyph beside a
 * word.
 */
export const ArrowUpIcon = stroked('ArrowUpIcon', 'M12 19V5M5 12l7-7 7 7');

export const Bars3Icon = stroked('Bars3Icon', 'M4 6h16M4 12h16M4 18h16');

export const PlusIcon = stroked('PlusIcon', 'M12 5v14M5 12h14');

/**
 * The plus that spans the whole 24 grid rather than PlusIcon's inset one, and
 * is always drawn at a heavier stroke. Three sites want the bolder mark
 * because it is the CONTENT of a small round badge or an empty tile rather
 * than a label's leading glyph: the home card menu's Add control, Discover's
 * add badge, and the Create app tile.
 *
 * Two of those still live in HTML strings (features/home/home.js's card menu)
 * — this export is the source of truth for that duplicate.
 */
export const PlusWideIcon = stroked('PlusWideIcon', 'M12 4v16m8-8H4');

/**
 * The disclosure caret the home panels' expand toggle rotates — and
 * (Streamlined Concept) the header title tab's "name ⌄" caret.
 */
export const ChevronDownIcon = stroked('ChevronDownIcon', 'M19 9l-7 7-7-7');

export const HomeIcon = strokedPath(
  'HomeIcon',
  'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1h-2z',
);

export const SearchIcon = stroked('SearchIcon', 'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z');

// ── Status and account ───────────────────────────────────────────────────

export const BellIcon = stroked(
  'BellIcon',
  'M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9',
);

export const UserIcon = stroked(
  'UserIcon',
  'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z',
);

export const WalletIcon = stroked(
  'WalletIcon',
  'M21 12a2.25 2.25 0 00-2.25-2.25H15a3 3 0 11-6 0H5.25A2.25 2.25 0 003 12m18 0v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 9m18 0V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v3',
);

export const TrophyIcon = stroked(
  'TrophyIcon',
  'M16 11V3H8v8M5 7H3v4a2 2 0 002 2h3M19 7h2v4a2 2 0 01-2 2h-3M8 15a4 4 0 008 0h-8z M12 15v3m-3 3h6',
);

/**
 * The bare tick. Every "added / done" affordance on the platform draws this
 * one path — the home launcher's Added badge, the home panels' checklist, the
 * app view's step list — and the browse row's Add button is the first of them
 * to render from the module. Its callers differ only in `strokeWidth`, which
 * is why this is a `stroked` glyph rather than a `strokedPath` one.
 */
export const CheckIcon = stroked('CheckIcon', 'M5 13l4 4L19 7');

// ── The dev chat's banner glyphs ─────────────────────────────────────────
//
// Five ports, moved here from inline `<svg>`s in `renderChatView`'s four
// banner templates when that strip converted. Each is the heroicons 24-outline
// path the templates carried; none is a redraw, and none of the four glyphs
// above is the same shape — `CheckIcon` and `PlusWideIcon` are the shell's own
// smaller-box spellings, and swapping either in would have been a visual
// change on a strip this slice does not otherwise touch.
export const CheckLongIcon = stroked('CheckLongIcon', 'M4.5 12.75l6 6 9-13.5');
export const PlusThinIcon = stroked('PlusThinIcon', 'M12 4.5v15m7.5-7.5h-15');
export const ClockIcon = stroked('ClockIcon', 'M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z');
export const UserCircleIcon = stroked(
  'UserCircleIcon',
  'M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z'
);
export const WarningTriangleIcon = stroked(
  'WarningTriangleIcon',
  'M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.732 0 2.814-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z'
);

// Five more ports, from `renderChatView`'s composer and `_renderSavedDrafts`'
// three row actions, moved here when that block converted. Each is the path
// the template carried, unchanged.
//
// Their FRAME is normalised onto `stroked`, which is a real DOM difference
// and a deliberate one: the templates wrote `stroke-linecap` and
// `stroke-linejoin` on the `<svg>`, this factory writes them on each `<path>`.
// Both inherit, so nothing draws differently — and the alternative is a
// fourth renderer whose only job is to hold five glyphs' attribute placement.
// Size still comes from `width`/`height` attributes, which is how the
// composer wrote them (every other call site in the shell uses a class).
export const PaperclipIcon = stroked(
  'PaperclipIcon',
  'M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48'
);
export const SaveDraftIcon = stroked('SaveDraftIcon', [
  'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z',
  'M17 21v-8H7v8',
  'M7 3v5h8',
]);
export const DraftSendIcon = stroked('DraftSendIcon', ['M22 2 11 13', 'M22 2 15 22l-4-9-9-4z']);
export const DraftEditIcon = stroked('DraftEditIcon', [
  'M12 20h9',
  'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z',
]);
export const DraftTrashIcon = stroked('DraftTrashIcon', [
  'M3 6h18',
  'M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2',
  'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6',
]);

/**
 * The spinning arc, as the sync banner draws it.
 *
 * Not a `stroked()` glyph: it is a faint ring with a bright quarter-arc laid
 * over it — a `<circle>` and a FILLED `<path>`, two different kinds of child —
 * so the helpers above cannot express it. The colour and the size come from
 * `className`, like every other icon here; `animate-spin` is the caller's, so
 * a still frame of it can be rendered where a capture would otherwise be
 * non-deterministic.
 */
export const SpinnerArcIcon = ({ id, className, ...rest }: IconProps) => (
  <svg id={id} className={className} fill="none" viewBox="0 0 24 24" {...rest}>
    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"></path>
  </svg>
);
SpinnerArcIcon.displayName = 'SpinnerArcIcon';

/**
 * A trophy on a plinth — the door to the Leaderboard screen, drawn on the
 * 24 grid at a finer weight than TrophyIcon's blockier mark. TrophyIcon was
 * the hamburger drawer's row glyph; this is the one the home screen's
 * Challenges bar and its standings footer carry, and the two are genuinely
 * different drawings rather than two spellings of one.
 */
export const TrophyOutlineIcon = stroked(
  'TrophyOutlineIcon',
  'M16.5 18.75h-9m9 0a3 3 0 013 3h-15a3 3 0 013-3m9 0v-3.375c0-.621-.503-1.125-1.125-1.125h-.871M7.5 18.75v-3.375c0-.621.504-1.125 1.125-1.125h.872m5.007 0H9.497m5.007 0a7.454 7.454 0 01-.982-3.172M9.497 14.25a7.454 7.454 0 00.981-3.172M5.25 4.236c-.982.143-1.954.317-2.916.52A6.003 6.003 0 007.73 9.728M5.25 4.236V4.5c0 2.108.966 3.99 2.48 5.228M5.25 4.236V2.721C7.456 2.41 9.71 2.25 12 2.25c2.291 0 4.545.16 6.75.47v1.516M7.73 9.728a6.726 6.726 0 002.748 1.35m8.272-7.322c.983.143 1.954.317 2.916.52a6.003 6.003 0 01-5.395 4.972m0 0a6.726 6.726 0 01-2.749 1.35m0 0a6.772 6.772 0 01-3.044 0',
);

export const ShieldCheckIcon = stroked(
  'ShieldCheckIcon',
  'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z',
);

export const LockIcon = stroked(
  'LockIcon',
  'M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z',
);

export const KeyIcon = stroked(
  'KeyIcon',
  'M15.75 5.25a3 3 0 0 1 3 3m3 0a6 6 0 0 1-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1 1 21.75 8.25Z',
);

// ── Conversation ─────────────────────────────────────────────────────────

/** The chat glyph in the header — a rounded speech bubble with an ellipsis. */
export const ChatIcon = stroked(
  'ChatIcon',
  'M8 10h.01M12 10h.01M16 10h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z',
);

/** The Messages drawer glyph, whose tail sits outside the bubble. */
export const ChatBubbleTailIcon = stroked(
  'ChatBubbleTailIcon',
  'M8 10h.01M12 10h.01M16 10h.01M21 12a8 8 0 01-8 8H7l-4 2 1.3-4A9 9 0 1121 12z',
);

/**
 * A speech bubble with a tick inside — the Workshop's "Needs you" tab.
 *
 * THE ONE GLYPH IN THIS FILE THAT IS NOT TRANSCRIBED WHOLE. The outline is:
 * it is the bubble half of `ChatIcon`'s path, character for character, with
 * that glyph's three dot subpaths dropped — so the shape sits on the same
 * grid and carries the same stroke rhythm as everything around it, and the
 * two are not the same `d` string. The tick inside is drawn here, because no
 * Heroicon pairs the two and the pairing is the whole point: the tab is where
 * you answer, and neither half says that alone. A bubble says "messages",
 * which is one tab over; a bare tick says "done", which is the state AFTER
 * the tab has been used.
 *
 * The tick is NOT `CheckIcon`'s or `CheckLongIcon`'s path: both are drawn to
 * fill their own 24 box, and neither fits inside a bubble that occupies most
 * of one. If this glyph ever looks wrong, correct the tick — the bubble half
 * must keep tracking `ChatIcon`.
 */
export const SpeechCheckIcon = stroked('SpeechCheckIcon', [
  'M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z',
  'M8.6 11.8l2.4 2.4 4.4-4.9',
]);

/**
 * The Needs-you feed's rail. A ballot going into its box for Vote —
 * a bare tick reads as "done" and a thumb reads as "like", and this control
 * opens the question rather than answering it. A raised hand for taking an
 * unclaimed issue, sparkles for asking the model, and play for trying the
 * staging build, which is the closest thing a proposal has to a clip.
 */
export const BallotIcon = stroked('BallotIcon', [
  'M9 3.75H6.912a2.25 2.25 0 00-2.15 1.588L2.35 13.177a2.25 2.25 0 00-.1.661V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18v-4.162c0-.224-.034-.447-.1-.661L19.24 5.338a2.25 2.25 0 00-2.15-1.588H15',
  'M2.25 13.5h3.86a2.25 2.25 0 012.012 1.244l.256.512a2.25 2.25 0 002.013 1.244h3.218a2.25 2.25 0 002.013-1.244l.256-.512a2.25 2.25 0 012.013-1.244h3.859',
  'M12 3v8.25m0 0l-3-3m3 3l3-3',
]);
export const HandRaisedIcon = stroked(
  'HandRaisedIcon',
  'M10.05 4.575a1.575 1.575 0 10-3.15 0v3m3.15-3v-1.5a1.575 1.575 0 013.15 0v1.5m-3.15 0l.075 5.925m3.075.75V4.575m0 0a1.575 1.575 0 013.15 0V15M6.9 7.575a1.575 1.575 0 10-3.15 0v8.175a6.75 6.75 0 006.75 6.75h2.018a5.25 5.25 0 003.712-1.537l1.732-1.732a5.25 5.25 0 001.538-3.712l.003-2.024a.668.668 0 01.198-.471 1.575 1.575 0 10-2.228-2.228 3.818 3.818 0 00-1.12 2.687M6.9 7.575V12m6.27 4.318A4.49 4.49 0 0116.35 15m.002 0h-.002',
);
export const SparklesIcon = stroked(
  'SparklesIcon',
  'M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z',
);
export const PlayIcon = stroked(
  'PlayIcon',
  'M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z',
);
export const ChevronUpIcon = stroked('ChevronUpIcon', 'M5 15l7-7 7 7');

export const ThumbsUpIcon = stroked(
  'ThumbsUpIcon',
  'M14 10h4.764a2 2 0 011.789 2.894l-3.5 7A2 2 0 0115.263 21h-4.017c-.163 0-.326-.02-.485-.06L7 20m7-10V5a2 2 0 00-2-2h-.095c-.5 0-.905.405-.905.905 0 .714-.211 1.412-.608 2.006L7 11v9m7-10h-2M7 20H5a2 2 0 01-2-2v-6a2 2 0 012-2h2.5',
);

export const ShareIcon = stroked(
  'ShareIcon',
  'M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z',
);

export const PaperClipIcon = stroked(
  'PaperClipIcon',
  'M21.4 11.6l-8.5 8.5a6 6 0 01-8.5-8.5l9-9a4 4 0 015.7 5.7l-9 9a2 2 0 01-2.8-2.8l8.4-8.4',
);

export const ArrowUpTrayIcon = stroked(
  'ArrowUpTrayIcon',
  'M12 3v12m0-12l-4 4m4-4l4 4M5 13v7h14v-7',
);

export const SendIcon = stroked(
  'SendIcon',
  'M4 4l17 8-17 8 3-8-3-8zm3 8h14',
);

export const UserGroupIcon = stroked(
  'UserGroupIcon',
  'M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zm8-1a3 3 0 010 6m4 5v-2a4 4 0 00-3-3.9',
);

// ── Tooling ──────────────────────────────────────────────────────────────

/**
 * Board columns — the Dev screen's Kanban tab, and the Improve panel's row
 * that opens it.
 *
 * Transcribed verbatim from `VIEW_ICON_PATHS.kanban` in
 * features/dev-board/board-frame.tsx, which is where this glyph has been drawn
 * since the board shipped. THE UI OVERHAUL gave it a second call site (the
 * Improve panel), and a second inline copy of a path is exactly the drift this
 * module exists to prevent — so it became an export rather than a duplicate.
 */
export const BoardIcon = stroked('BoardIcon', 'M4 5h4v14H4zM10 5h4v9h-4zM16 5h4v6h-4z');

/**
 * A NEWSPAPER — the Activity row and screen.
 *
 * The Figma board names this slot `lucide/newspaper`, and the glyph is right:
 * Activity is the project's record of what happened, not a chat. The path is
 * the shell's own set's Heroicons v1 outline newspaper rather than lucide's,
 * for the reason in this file's header — one grid, one stroke rhythm.
 */
export const NewspaperIcon = stroked(
  'NewspaperIcon',
  'M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V7m2 13a2 2 0 002-2V9a2 2 0 00-2-2h-2m-4-3H9M7 16h6M7 8h6v4H7V8z',
);

/**
 * Three equal rules — the Dev screen's Feed tab, and the Improve panel's row
 * that opens it.
 *
 * The same path `VIEW_ICON_PATHS.list` drew for the retired List view, kept
 * deliberately: Feed IS that surface, refocused on recent activity, and giving
 * it a new glyph would have said "something else lives here now" to everyone
 * who already knew where to look.
 *
 * Identical to Bars3Icon's path, which is not a mistake — the hamburger and a
 * list of rules are the same three lines. Two names, because the call sites
 * mean different things and a `Bars3Icon` in a Feed row would read as a bug.
 */
export const ListLinesIcon = stroked('ListLinesIcon', 'M4 6h16M4 12h16M4 18h16');

export const TerminalIcon = stroked(
  'TerminalIcon',
  'M8 9l3 3-3 3m5 0h3M4 6h16a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1V7a1 1 0 011-1z',
);

export const CogIcon = stroked('CogIcon', [
  'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z',
  'M15 12a3 3 0 11-6 0 3 3 0 016 0z',
]);

export const SunIcon = stroked(
  'SunIcon',
  'M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z',
);

/**
 * An ⓘ in a circle — a help affordance beside a heading, not a status. The
 * home screen's widget strip uses it for "how do I add this to my home
 * screen?"; it is the only glyph in the set drawn as a filled counter inside a
 * ring, which is what keeps it from reading as an error or a warning.
 */
export const InfoCircleIcon = stroked(
  'InfoCircleIcon',
  'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
);

export const LightBulbIcon = stroked(
  'LightBulbIcon',
  'M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z',
);

// Heroicons' arrow-path: the "there is a new build, reload onto it" glyph on
// the Improve button, and the only rotational arrow in the set — ArrowRightIcon
// and its short twin are directional, not cyclic.
export const ArrowPathIcon = stroked(
  'ArrowPathIcon',
  'M16.023 9.348h4.992V4.356m-4.992 4.992l3.181-3.183a8.25 8.25 0 00-13.803 3.7M4.031 9.865v4.99m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7',
);

export const CameraIcon = stroked('CameraIcon', [
  'M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z',
  'M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0z',
]);

export const PhotoIcon = stroked(
  'PhotoIcon',
  'M3 16.5l5.25-5.25a2.25 2.25 0 013.182 0L15 14.818m-1.5-1.5 1.068-1.068a2.25 2.25 0 013.182 0L21 15.5m-18 3.75h18A2.25 2.25 0 0023.25 17V6.75A2.25 2.25 0 0021 4.5H3A2.25 2.25 0 00.75 6.75V17A2.25 2.25 0 003 19.25z',
);

/**
 * #1280: saving a message. The outline/solid PAIR is the point — this is the
 * only glyph in the set that has to render two states, and hollow-versus-
 * filled says which one at 12px, where an opacity difference does not.
 *
 * Heroicons v2 (24 outline / 24 solid) like the rest of the file, drawn for
 * `strokeWidth="1.5"` — both call sites pass it, rather than the default '2'
 * this file's older v1 glyphs want.
 *
 * These two paths used to be inlined in public/js/group-chat.js as well —
 * the one duplication in the set, because the message's save button was
 * rendered by a classic script that cannot import this module. The transcript
 * is React and that button is `<RowActions>`, so the copy is gone and this is
 * the only place either glyph is drawn.
 */
export const BookmarkIcon = stroked(
  'BookmarkIcon',
  'M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z',
);

export const BookmarkSolidIcon = filled(
  'BookmarkSolidIcon',
  'M6.32 2.577a49.255 49.255 0 0 1 11.36 0c1.497.174 2.57 1.46 2.57 2.93V21a.75.75 0 0 1-1.085.67L12 18.089l-7.165 3.583A.75.75 0 0 1 3.75 21V5.507c0-1.47 1.073-2.756 2.57-2.93Z',
);

/**
 * The ⋮ overflow control — three filled dots on the 20 grid, not the 24 one.
 *
 * It is written out rather than built by `filled()` because it is the only
 * glyph in the set drawn from <circle>s: three round dots on a 24 grid have to
 * be described as three arcs each, and the path data for that is unreadable
 * next to `cx`/`cy`/`r`. The 20 viewBox is the reason the radii are whole
 * numbers.
 */
export const EllipsisVerticalIcon = ({ id, className, ...rest }: IconProps) => (
  <svg id={id} className={className} viewBox="0 0 20 20" fill="currentColor" {...rest}>
    <circle cx="10" cy="4.2" r="1.6" />
    <circle cx="10" cy="10" r="1.6" />
    <circle cx="10" cy="15.8" r="1.6" />
  </svg>
);
EllipsisVerticalIcon.displayName = 'EllipsisVerticalIcon';

/**
 * The Dev card's ⋯ trigger — three dots on a HORIZONTAL row, in a 20×20 box.
 *
 * Its own component rather than a `stroked` entry for the same reason
 * `EllipsisVerticalIcon` above is: circles, not a path, and a viewBox that
 * matches the pill it sits in rather than the 24×24 outline grid.
 */
export const EllipsisHorizontalIcon = ({ id, className, ...rest }: IconProps) => (
  <svg id={id} className={className} viewBox="0 0 20 20" fill="currentColor" {...rest}>
    <circle cx="4" cy="10" r="1.6" />
    <circle cx="10" cy="10" r="1.6" />
    <circle cx="16" cy="10" r="1.6" />
  </svg>
);
EllipsisHorizontalIcon.displayName = 'EllipsisHorizontalIcon';

/**
 * "Open the staging preview" — the eye, and the same eye struck through.
 *
 * The two `d` strings are named constants rather than inline attributes for
 * one reason: tests/shell-icon-set.test.js reads this module's path data as
 * the QUOTED literals in it, and compares the prerendered document against
 * that set. Inline `d="…"` on the element is invisible to it, which read as
 * a re-inlined glyph the moment the eye started shipping in the document
 * (#1606 put it on every password field). The rendered output is unchanged.
 */
const EYE_OUTLINE = 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z';
const EYE_SLASH = 'M4 20 20 4';

export const EyeIcon = ({ id, className, strokeWidth = '2', ...rest }: IconProps) => (
  <svg id={id} className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} {...rest}>
    <path strokeLinecap="round" strokeLinejoin="round" d={EYE_OUTLINE} />
    <circle cx="12" cy="12" r="2.75" />
  </svg>
);
EyeIcon.displayName = 'EyeIcon';

export const EyeOffIcon = ({ id, className, strokeWidth = '2', ...rest }: IconProps) => (
  <svg id={id} className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} {...rest}>
    <path strokeLinecap="round" strokeLinejoin="round" d={EYE_OUTLINE} />
    <circle cx="12" cy="12" r="2.75" />
    <path strokeLinecap="round" d={EYE_SLASH} />
  </svg>
);
EyeOffIcon.displayName = 'EyeOffIcon';

/** The author-only inline title edit: a pencil over a document corner. */
export const PencilSquareIcon = stroked(
  'PencilSquareIcon',
  'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z',
);

export const GitHubIcon = filled(
  'GitHubIcon',
  'M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z',
);

/**
 * The dev card's fold mark: which SIZE the item is at (card/fold.tsx
 * FoldMark). Two chevrons pointing apart, and a bar between them that the
 * closed state scales away — one glyph, three paths, each classed so app.css
 * can move them apart on the open card (`.dev-fold-mark`), which is why it
 * is written out rather than built: a factory's single path could not be
 * stretched in parts. The `d` strings are named literals for the same
 * reason the eye's are — tests/shell-icon-set.test.js reads this module's
 * path data as its quoted literals.
 */
const FOLD_TOP = 'M8.25 9L12 5.25 15.75 9';
const FOLD_BAR = 'M12 5.5v13';
const FOLD_BOTTOM = 'M8.25 15L12 18.75 15.75 15';

export const FoldMarkIcon = ({ id, className, ...rest }: IconProps) => (
  <svg id={id} className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...rest}>
    <path className="dev-fold-top" d={FOLD_TOP} />
    <path className="dev-fold-bar" d={FOLD_BAR} />
    <path className="dev-fold-bottom" d={FOLD_BOTTOM} />
  </svg>
);
FoldMarkIcon.displayName = 'FoldMarkIcon';

/**
 * The escape hatch, for the two call sites that pick their `d` out of a table
 * at render time rather than naming a glyph: the dev board's view switcher
 * (`VIEW_ICON_PATHS[mode]`) and the app card's visibility chip
 * (`VIS_CHIP_PATHS[vis.icon]`, whose table app-card.js also interpolates into
 * the string renderer, so the path data has to stay there). Same `stroked`
 * shape as everything above.
 */
export const Glyph = ({
  id,
  className,
  d,
  strokeWidth = '2',
  ...rest
}: IconProps & { d: string }) => (
  <svg
    id={id}
    className={className}
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    strokeWidth={strokeWidth}
    {...rest}
  >
    <path strokeLinecap="round" strokeLinejoin="round" d={d} />
  </svg>
);
Glyph.displayName = 'Glyph';
