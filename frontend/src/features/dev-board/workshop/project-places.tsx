/**
 * #4417: A PROJECT'S PLACES, AS ONE LIST.
 *
 * It replaced the four tabs (Hub · Discussion · Needs you · Workshop, the
 * retired project-band.tsx). The pages first, a line, then the project's
 * channels under their heading:
 *
 *   Hub
 *   Needs you              29
 *   Workshop
 *   ─────────────
 *   CHANNELS
 *   Discussion
 *
 * #general IS THE DISCUSSION (26 Nov 2026): the row that was "# general"
 * opens the Discussion, #general as posts with replies
 * (./hub-discussion.tsx, place `posts`), and stays lit on #general's chat
 * view of the same room (place `discussion`, its "Open as chat"). Its count
 * is #general's unread, and like a channel's it is not drawn while you read
 * it.
 *
 * A topic's channel is not one of these places (#6709): the Hub's Topics
 * card and the channel's own address reach it, and a retired topic stays
 * readable by its links (a merge's card, a `#name` in a message).
 *
 * ITS APP LEADS (18 Oct 2026, `app`): App, above Hub, with the green "still
 * open" dot while it runs in a kept frame, in the tray and the phone's
 * drawer, as in the desktop sidebar (which draws its own, outside this list,
 * so a running app's row can stay when the places fold away). Not for
 * Homeroom's own project, whose app is the platform you are in.
 *
 * A `<nav>` of links, because each entry is somewhere to go: an anchor with
 * the place's own address (./places.ts placeHref), so a new tab opens it
 * too, and a plain press moves the page in place (`onPlace`). The open place
 * carries `aria-current="page"` and the left rail's lit-row treatment
 * (`--lit-tint`, `--lit-ink`). Channels is a `role="group"`
 * labelled by its heading. A count says what it counts: on screen a
 * channel's pill reads "3 unread", its hover text the same (the channel
 * you are reading draws none), and to a screen reader an `sr-only`
 * phrase, "29 to vote", "3 unread". A zero says nothing.
 *
 * Drawn nested under the community's row in the desktop's sidebar of rows
 * (../../nav/rail-communities.tsx, v3), and in the tray behind the place bar
 * (./places-tray.tsx) on a phone or with the sidebar folded, which adds
 * "Switch community" at its foot, and on the phone's drawer. (The section
 * column beside the 76px strip drew it too, until the sidebar started at
 * 768px and no width had the strip.)
 */

import { useId, type MouseEvent, type ReactNode } from 'react';

import { AppWindowIcon, BallotIcon, BoardIcon, ChatIcon, HashIcon, Squares2X2Icon, UserGroupIcon } from '@/components/ui/icons';

import { useMessages } from '../../../lib/i18n/react';
import { listText, t as translate } from '../../../lib/i18n/runtime';
import { capCount } from '../../../lib/count-cap';
import { liveAppLabel, LiveAppDot, useLiveAppSlugs } from '../../app-frame/live-apps';
import { noteResumeOrigin } from '../../nav/resume-motion';
import type { PlacesPayload } from './community-card';
import { channelPlace, isChannelPlace, litPlace, liveTopics, PAGE_PLACES, placeHref, type PlaceKey } from './places';

/** What a place's count says aloud, or null for none (a zero says nothing).
 *  `shown` is the number as displayed (capped as 99+); the plural form
 *  follows the real count. */
export function countPhrase(key: PlaceKey, n: number, shown = String(n)): string | null {
  if (!(n > 0)) return null;
  if (key === 'needs') return translate('project:places.count.toVote', { count: n });
  return translate('project:places.count.unread', { count: n, shown });
}

/** The entries the list draws, in order: what the tests read. Pure. */
export function placeRows(places: PlacesPayload | null | undefined, owed: number): {
  pages: Array<{ key: PlaceKey; label: string; count: number }>;
  general: { key: PlaceKey; label: string; count: number };
  topics: Array<{ key: PlaceKey; label: string; count: number; name: string; icon: string }>;
} {
  const channels = places && Array.isArray(places.channels) ? places.channels : [];
  const general = channels.find((c) => c.kind === 'general');
  return {
    pages: PAGE_PLACES.map((p) => ({ key: p.key, label: translate(p.label), count: p.key === 'needs' ? Math.max(0, Number(owed) || 0) : 0 })),
    general: { key: 'posts', label: translate('project:places.list.discussion'), count: Math.max(0, Number(general?.unread) || 0) },
    topics: liveTopics(places).map((t) => ({
      key: channelPlace(t.handle),
      label: t.handle,
      count: Math.max(0, Number(t.unread) || 0),
      name: t.name,
      icon: t.icon,
    })),
  };
}

function PageGlyph({ k }: { k: PlaceKey }) {
  const cls = 'dev-ws-place-glyph';
  if (k === 'status') return <Squares2X2Icon className={cls} aria-hidden="true" />;
  if (k === 'needs') return <BallotIcon className={cls} aria-hidden="true" />;
  if (k === 'workshop') return <BoardIcon className={cls} aria-hidden="true" />;
  if (k === 'posts') return <ChatIcon className={cls} aria-hidden="true" />;
  return <HashIcon className={`${cls} dev-ws-place-hash`} aria-hidden="true" />;
}

function PlaceLink({ slug, k, label, count, lit, title, extra, onPlace }: {
  slug: string;
  k: PlaceKey;
  label: string;
  count: number;
  lit: boolean;
  title?: string;
  extra?: ReactNode;
  onPlace: (key: PlaceKey) => void;
}) {
  const t = useMessages('project');
  // The channel you are reading draws no count of its own, as the place bar
  // leaves it out of its unread; the count of Needs you stays while you are
  // there (#5447).
  const channel = isChannelPlace(k) || k === 'posts';
  const phrase = channel && lit ? null : countPhrase(k, count);
  // A channel's pill says what it counts ("9 unread", capped as "99+ unread"),
  // its hover text the same; Needs you keeps the bare number.
  const shown = channel ? countPhrase(k, count, capCount(count)) : null;
  const press = (event: MouseEvent<HTMLAnchorElement>) => {
    const nav = (window as unknown as { NavLink?: { isNativeClick?: (e: unknown) => boolean } }).NavLink;
    if (nav?.isNativeClick?.(event)) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    onPlace(k);
  };
  return (
    <a
      className="dev-ws-place"
      href={placeHref(slug, k)}
      data-place={k}
      aria-current={lit ? 'page' : undefined}
      title={title}
      onClick={press}
    >
      <PageGlyph k={k} />
      <span className="dev-ws-place-label">{label}</span>
      {phrase ? (
        <>
          <span className="dev-ws-place-count" data-place-count="" aria-hidden="true" title={shown ?? undefined}>{shown ?? capCount(count)}</span>
          <span className="sr-only">{` ${t('project:places.list.countAloud', { phrase })}`}</span>
        </>
      ) : null}
      {extra}
    </a>
  );
}

/** The project's app, the list's first row: it opens the app, and a running one resumes. */
function AppPlace({ slug, name }: { slug: string; name: string }) {
  const t = useMessages('project');
  const running = useLiveAppSlugs().includes(slug);
  const label = t('project:places.list.appOf', { project: name });
  return (
    <a
      className="dev-ws-place"
      href={`/app/${encodeURIComponent(slug)}`}
      data-place-app=""
      {...(running ? { 'data-live': 'true' } : null)}
      // "Chess app", and that it is still open: the row's words are only "App".
      aria-label={running ? listText([label, liveAppLabel()]) : label}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        const nav = (window as unknown as { NavLink?: { isNativeClick?: (e: unknown) => boolean } }).NavLink;
        if (nav?.isNativeClick?.(event)) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
        event.preventDefault();
        // #3618: a running app grows back out of the row that was pressed.
        if (running) noteResumeOrigin(slug, event.currentTarget.querySelector('.dev-ws-place-glyph') || event.currentTarget);
        (window as unknown as { App?: { openAppTab?: (slug: string, tab: string) => void } }).App?.openAppTab?.(slug, 'app');
      }}
    >
      <AppWindowIcon className="dev-ws-place-glyph" aria-hidden="true" />
      <span className="dev-ws-place-label">{t('project:places.list.app')}</span>
      {running ? <LiveAppDot className="dev-ws-place-live" /> : null}
    </a>
  );
}

export function ProjectPlaces({ slug, name, place, owed, places, filtered = false, app = false, onPlace, onSwitch }: {
  slug: string;
  /** The project's name, which names the list for a screen reader. */
  name: string;
  /** The place on show; a page under one (All items, the plan) lights it. Null lights none (not known yet). */
  place: PlaceKey | null;
  /** Votes waiting on the viewer here (the page's own count). */
  owed: number;
  places: PlacesPayload | null | undefined;
  /** All items' search or filters are on: a dot on the Workshop (#2915). */
  filtered?: boolean;
  /** Lead with the project's App row (the tray, the phone's drawer; never Homeroom's own). */
  app?: boolean;
  onPlace: (key: PlaceKey) => void;
  /** The tray's foot: "Switch community". */
  onSwitch?: (el: HTMLElement | null) => void;
}): ReactNode {
  const t = useMessages('project');
  const id = useId();
  const lit = place ? litPlace(place) : null;
  const rows = placeRows(places, owed);
  const channelsId = `${id}-channels`;
  return (
    <div className="dev-ws-places" data-places={slug}>
      <nav className="dev-ws-places-nav" aria-label={name ? t('project:places.list.name', { project: name }) : t('project:places.list.nameUnnamed')}>
        {app ? <AppPlace slug={slug} name={name || slug} /> : null}
        {rows.pages.map((p) => (
          <PlaceLink
            key={p.key}
            slug={slug}
            k={p.key}
            label={p.label}
            count={p.count}
            lit={lit === p.key}
            onPlace={onPlace}
            extra={p.key === 'workshop' && filtered ? (
              <>
                <span className="dev-ws-filter-dot" data-ws-filtered="" aria-hidden="true" />
                <span className="sr-only">{` ${t('project:places.list.filtered')}`}</span>
              </>
            ) : null}
          />
        ))}
        <div className="dev-ws-places-line" role="separator" />
        <div className="dev-ws-places-group" role="group" aria-labelledby={channelsId} data-places-group="channels">
          <div id={channelsId} className="dev-ws-places-head">{t('project:places.list.channels')}</div>
          <PlaceLink
            slug={slug}
            k={rows.general.key}
            label={rows.general.label}
            count={rows.general.count}
            lit={lit === 'posts'}
            onPlace={onPlace}
          />
        </div>
      </nav>
      {onSwitch ? (
        <div className="dev-ws-places-foot">
          <button
            type="button"
            className="dev-ws-place"
            data-places-switch=""
            onClick={(e) => onSwitch(e.currentTarget)}
          >
            <UserGroupIcon className="dev-ws-place-glyph" aria-hidden="true" />
            <span className="dev-ws-place-label">{t('project:places.list.switchCommunity')}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
