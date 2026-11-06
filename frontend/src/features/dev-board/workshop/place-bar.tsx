/**
 * #4417: THE PLACE BAR, where the four tabs were.
 *
 * On a phone, one bar under the header in the community's colour
 * (`--community-tint`), continuing it, as the band of tabs did: the tray's
 * button (./places-tray.tsx), then the name of the place you are on, with a
 * # for a channel —
 *
 *   [▤•]  # homeroom-bot
 *
 * The button says whether the tray is open (`aria-expanded`), and carries a
 * dot, with an `sr-only` phrase, while something in the project waits for
 * you: votes owed, or unread in a channel you are not reading.
 *
 * On a wide window the list is nested under the community's row in the
 * sidebar (../../nav/rail-communities.tsx), so the bar is the page's title
 * row that names the place, in the page's own ink, with no button (app.css).
 *
 * It keeps the band's box (`.dev-ws-tabs.dev-ws-band` > `.dev-ws-tabtrack`,
 * `data-ws-band`): it is what pins under the header, and what the pinned
 * pane head and the pull to refresh are measured against (workshop.tsx).
 */

import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react';

import { SidebarIcon } from '@/components/ui/icons';

import { useMessages } from '../../../lib/i18n/react';
import { listText, t as translate } from '../../../lib/i18n/runtime';
import { useStoreState } from '../../../lib/use-store-state';
import { drawerStore } from '../../nav-drawer/drawer-store';
import { navStore } from '../../nav/nav-store.js';
import { placeHandle, placeName, type PlaceKey } from './places';
import { livePlace, placeStore, toggleTray } from './place-store';

/** What waits for you, aloud: "29 to vote, 4 unread", or null for nothing. Pure. */
export function waitingPhrase(owed: number, unread: number): string | null {
  const parts: string[] = [];
  if (owed > 0) parts.push(translate('project:places.bar.toVote', { count: owed }));
  if (unread > 0) parts.push(translate('project:places.bar.unread', { count: unread }));
  return parts.length ? listText(parts) : null;
}

/**
 * The tray's button, the one thing the bar and the merged header share
 * (#4703): the same class strings, the same aria, the dot and its sr-only
 * phrase. The bar renders it unchanged; the header renders it with an extra
 * class (app.css sizes it to the header's 28px row there).
 */
export function PlacesButton({ name, open, trayId, waiting, onToggle, buttonRef, className }: {
  /** The project's name: the button is "<name>'s places". */
  name: string;
  open: boolean;
  /** The open tray's id, for aria-controls. */
  trayId?: string;
  waiting: string | null;
  onToggle: () => void;
  buttonRef?: Ref<HTMLButtonElement>;
  /** An extra class beside `.dev-ws-places-btn`, for where it is drawn. */
  className?: string;
}): ReactNode {
  const t = useMessages('project');
  return (
    <button
      ref={buttonRef}
      type="button"
      className={className ? `dev-ws-places-btn ${className}` : 'dev-ws-places-btn'}
      data-places-btn=""
      aria-label={name ? t('project:places.bar.button', { project: name }) : t('project:places.bar.buttonUnnamed')}
      aria-expanded={open}
      aria-controls={open && trayId ? trayId : undefined}
      onClick={onToggle}
    >
      <SidebarIcon className="dev-ws-places-btn-glyph" aria-hidden="true" />
      {waiting ? (
        <>
          <span className="dev-ws-places-dot" data-places-waiting="" aria-hidden="true" />
          <span className="sr-only">{` ${t('project:places.bar.waitingAloud', { waiting })}`}</span>
        </>
      ) : null}
    </button>
  );
}

/**
 * #4703: whether the window is phone-narrow, where the merged header carries
 * the place bar's contents. Settled in an effect with `false` as the initial
 * value, so the prerendered document and the first client render agree on
 * nothing drawn (the same contract header-title.tsx's flags keep), and the
 * button arrives one tick later on a phone.
 */
export function usePhoneHeader(): boolean {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767.98px)');
    const apply = () => setPhone(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);
  return phone;
}

/**
 * #4703: THE MERGED HEADER'S PLACES BUTTON. On a phone, while a project page
 * for this project is mounted, the platform header opens the same tray the
 * place bar's button does: the page owns the tray (workshop.tsx) and
 * published the toggle here; the header only draws the button and calls it.
 * The band's own button is hidden on a phone (app.css), so this is the one
 * a person sees.
 *
 * It also asks #5168's question: is the app view the screen on show? The
 * header carries this button on every route, and a project page stays
 * mounted behind the other tabs, so the mounted check alone passed on
 * Discover, Home, Messages and Profile and the button drew there — a tray
 * for a project that is not on screen. navStore answers it the way
 * header-title.tsx's `inApp` does.
 */
export function HeaderPlace({ slug, name }: { slug: string | null; name: string }): ReactNode {
  const phone = usePhoneHeader();
  const { screen } = useStoreState(navStore);
  const { slug: mounted, owed, unread, tray } = useStoreState(placeStore);
  // On a phone the Hub's rows lead to the places now (../../nav-drawer/), and
  // the header draws its grid or its arrow here instead (header-drawer.tsx
  // DrawerBack).
  const { on: drawerOn } = useStoreState(drawerStore);
  const button = useRef<HTMLButtonElement | null>(null);
  if (drawerOn) return null;
  if (!phone || !slug || mounted !== slug || screen !== 'app-view') return null;
  return (
    <PlacesButton
      name={name}
      open={tray}
      waiting={waitingPhrase(owed, unread)}
      onToggle={() => toggleTray(button.current)}
      buttonRef={button}
      className="header-places-btn"
    />
  );
}

/**
 * #4703: THE PLACE'S NAME in the merged header, beside the switcher — the
 * words the place bar's title showed ("Workshop", "# homeroom-bot"), hidden
 * from screen readers because the heading they sit in is already named.
 * Drawn while the mounted page is this route's project; `slug` is the
 * route's, from the header's own store. It carries no width query of its
 * own (#3271's rule for the header): app.css shows it only on a phone,
 * where the place bar's second row is gone.
 */
export function HeaderPlaceName({ slug }: { slug: string | null }): ReactNode {
  const { slug: mounted, place } = useStoreState(placeStore);
  if (!slug || mounted !== slug) return null;
  // #5683: never a channel from another community beside this one's name.
  const shown = livePlace(slug, place);
  const handle = placeHandle(shown);
  return (
    <span className="header-place-name" data-header-place="" aria-hidden="true">
      {handle ? <span className="dev-ws-place-title-hash">#</span> : null}
      {handle || placeName(shown)}
    </span>
  );
}

export function PlaceBar({ name, place, owed, unread, open, trayId, onToggle, barRef, buttonRef }: {
  /** The project's name: the button is "<name>'s places". */
  name: string;
  place: PlaceKey;
  owed: number;
  /** Unread across the project's channels, less the one on screen. */
  unread: number;
  open: boolean;
  trayId: string;
  onToggle: () => void;
  barRef?: (el: HTMLElement | null) => void;
  buttonRef?: Ref<HTMLButtonElement>;
}): ReactNode {
  const handle = placeHandle(place);
  const waiting = waitingPhrase(owed, unread);
  return (
    <div ref={barRef} className="dev-ws-tabs dev-ws-band dev-ws-placebar" data-ws-band="" data-place-bar={place}>
      <div className="dev-ws-tabtrack">
        <PlacesButton name={name} open={open} trayId={trayId} waiting={waiting} onToggle={onToggle} buttonRef={buttonRef} />
        <h2 className="dev-ws-place-title" data-place-title="">
          {handle ? <span className="dev-ws-place-title-hash">#</span> : null}
          {handle || placeName(place)}
        </h2>
      </div>
    </div>
  );
}
