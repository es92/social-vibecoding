/**
 * #sidebar-toggle — collapse and expand the desktop rail.
 *
 * ── Why the bar needs one at all ───────────────────────────────────────
 *
 * The rail spends 224px of every desktop window, permanently, on five links
 * a reader may know by heart after a day. Every host in the design study that
 * draws a persistent rail also draws a way to fold it — VS Code, Slack,
 * Linear, Notion — and the prototype drew one in the top bar's left corner,
 * which is where every one of those puts it.
 *
 * ── It is a TOGGLE, and says so ────────────────────────────────────────
 *
 * `aria-pressed` carries the state, so the label can stay the ACTION ("Hide
 * sidebar" / "Show sidebar") rather than describing the current arrangement.
 * The glyph does not flip with it, for the reason its own note in
 * @/components/ui/icons.tsx gives: an icon that changes as well makes the
 * reader work out whether it is showing where they are or where the press
 * would take them.
 *
 * ── Where it is, and where it is not ───────────────────────────────────
 *
 * The header's LEFT GROUP, beside the back slot. That slot is empty on a tab
 * root (App._BACK_SLOT) and carries a chevron on a sub-page, and this sits
 * before either — the same corner the prototype and all four of those
 * products use.
 *
 * DESKTOP ONLY, and only where there is a rail to fold — but BOTH of those
 * are app.css's to decide, not this component's. The breakpoint, because a
 * phone's bar is at the foot and folding it would leave a reader with no
 * navigation and no hover to bring it back; and `#platform-tabs.hidden`,
 * because a toggle for a thing that is not there is a dead control. The note
 * on the component below says why neither may be a render-time question.
 *
 * ── Beside a running app it takes the ✕'s place ────────────────────────
 *
 * On a desktop the rail stays docked beside a running app (App._railBesideApp
 * in public/js/app.js), so this is in the app's corner too, and the back
 * slot is empty there: the rail's tabs are the way out, as from any other
 * screen, and folding the rail gives the app the whole window. On a phone,
 * or with Settings' "Keep sidebar open in apps" off, the app covers the rail
 * and the way out is the header's ✕ (#3138), with no toggle beside it.
 *
 * ── Collapsed is the app view's state, reached another way ─────────────
 *
 * Folding the rail puts the shell in the arrangement a full-window app
 * produces — no band reserved, the page full width — plus the hot zone at
 * the left edge ready to peek it back (features/nav/tab-bar.tsx), which a
 * running app never has (#3138). That is
 * why this needs no CSS of its own beyond being hidden on a phone — the
 * layout it asks for is one the stylesheet already draws.
 *
 * ── Pointing at it peeks the folded rail (#2764) ───────────────────────
 *
 * With the rail folded, hovering this button fades the rail in OVER the page,
 * the same overlay the window's left edge summons — nothing reflows, and
 * pressing the button is still what docks it back. The button sits directly
 * above where the rail appears, so it is where the pointer already is when a
 * reader goes looking for the navigation they put away; before this, pointing
 * at it did nothing at all. With the rail open it does not peek: there is
 * nothing to bring back, and a press is about to fold it.
 *
 * The enter/leave pair is ./rail-peek.ts's, shared with the rail and the hot
 * zone so the pointer can cross from here onto the rail inside one grace
 * period. Handlers only — nothing about the markup changes with the peek.
 */

import { SidebarIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { useStoreState } from '../../lib/use-store-state';
import { navStore } from './nav-store.js';
import { clearPeekTimer, enterPeekByMouse, leavePeekByMouse } from './rail-peek';
import { slideRail } from './rail-slide';

// THE SAME DISC the back slot beside it wears — ../header/platform-header.tsx
// hoists its own for the same reason: a class string that spans lines ships
// its newlines into the attribute, and every class here has to stay a
// complete literal for Tailwind's extractor, which is a regex over this text.
//
// No `inline-flex`: app.css owns this control's `display`, because whether it
// exists at all is a question about the VIEWPORT and React does not know the
// viewport. `items-center justify-center` are inert until it does.
//
// NO DISC AT REST (#2798). The periwinkle tint used to sit behind the glyph
// all the time, which made a plain toggle read as a pressed, highlighted
// control. It shows on HOVER now, the same tint and hairline, and the border
// is transparent at rest so the hover does not shift the glyph by a pixel.
const TOGGLE_CLASS = 'platform-sidebar-toggle shrink-0 w-7 h-7 items-center justify-center'
  + ' rounded-full un-touch-target border border-transparent text-[color:var(--brand-ink)]'
  + ' hover:bg-[color:var(--brand-tint)] hover:border-[color:var(--brand-line)]';

export function SidebarToggle() {
  // IT ALWAYS RENDERS, and app.css decides whether it is seen (#2718 review).
  //
  // This read `useVisibility('platform-tabs')` and returned null on a route
  // with no rail, which is the right ANSWER reached the wrong way: the
  // visibility store is published by public/js/app.js — a classic script,
  // which runs before this deferred module hydrates — so the prerender drew
  // the button from the default `true` and the first client render dropped
  // it. React error #418 on every route, and a console error fails every
  // declared check.
  //
  // The markup is therefore constant and `body:has(#platform-tabs.hidden)`
  // hides it, which is a question CSS can answer without being part of
  // hydration. `railOpen` stays a rendered attribute because nothing
  // publishes it before hydration: INITIAL is `true`, and only a press
  // moves it.
  const { railOpen, peek } = useStoreState(navStore);
  const t = useMessages();

  return (
    <button
      id="sidebar-toggle"
      type="button"
      className={TOGGLE_CLASS}
      aria-pressed={railOpen ? 'true' : 'false'}
      aria-controls="platform-tabs"
      aria-label={railOpen ? t('core:rail.hideSidebar') : t('core:rail.showSidebar')}
      // A PRESS ENDS ANY PEEK. Docking the rail makes the peek moot, and
      // left standing it would come straight back as an overlay the moment
      // the next press folded the rail under the same pointer.
      // It slides rather than jumping (N21, ./rail-slide.ts).
      onClick={() => slideRail(() => {
        clearPeekTimer();
        navStore.set({ railOpen: !navStore.get().railOpen, peek: false, peekOut: false });
      })}
      onPointerEnter={railOpen ? undefined : enterPeekByMouse}
      onPointerLeave={peek ? leavePeekByMouse : undefined}
    >
      <SidebarIcon className="w-5 h-5" />
    </button>
  );
}
