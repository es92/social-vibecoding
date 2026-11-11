/**
 * The guest Home: what a visitor with no account sees first
 * (features/auth/landing.tsx draws it under the story's short hero).
 *
 * ONE HOME, SIGNED OUT (#6361). The same page a member's Home is: one
 * search, Pinned apps (this device's, once it has pinned one; #6433), the
 * communities this device pinned, then Communities, the public directory as
 * picture cards, admin-featured first and then the most people active
 * (../home/communities-to-join.tsx), more as you scroll. A visitor pins an
 * app from the bar while it is open (../auth/landing.tsx), never from a
 * suggested row here. Pins are kept on the device (./device-pins.ts) and
 * move to the account at sign-in. The Featured and All apps sections, their
 * sort and Show more went with it.
 *
 * A card is its picture, its name and one sentence, the project's own
 * description, at most two lines. On the picture a pill says how many
 * people used it lately, as a profile glyph and a number, from MIN_PEOPLE
 * (a zero says nothing; a screen reader hears it in words with the name).
 * Member counts, votes and the last change stay on the project's page.
 *
 * THE WHOLE CARD IS ONE LINK to the project's read-only page
 * (./guest-project.tsx), whose band leads with Try it, then Join, then the
 * community. A card has no buttons of its own (#6433): a visitor's card is
 * its picture, name and sentence, and what a card can do is on the page
 * behind it. There is no Try it and no Pin or Join on one. The name is the link and
 * stretches over the card, so a tap anywhere opens it, a screen reader meets
 * one link per card, and the keyboard's focus ring goes round the whole
 * card. Its href is the clean `/app/<slug>` a search engine can follow
 * (ProjectLink); a plain click stays in the page at `#app/<slug>/workshop`,
 * also where a person lands once they sign in from there. Nothing on a card
 * is locked: the page behind it is readable by anyone. The landing's old
 * grid was taken away because 36 of its 41 tiles were locked
 * (docs/superpowers/specs/2026-09-18-logged-out-screens-design.md); a page
 * to read behind every card is what makes a grid worth having again.
 *
 * WHAT MAKES A TAP LOOK WORTH MAKING: the cards sit up off the page on a
 * soft shadow; a cover with no illustration is the project's icon, larger,
 * on its colour lit from the top left, with a blurred copy of the icon
 * glowing behind it; under a pointer the card rises, the glow brightens and
 * an arrow slides in (the arrow only there and under keyboard focus, so a
 * screen of cards at rest carries no repeated marker); a press gives under
 * the finger; and the picture grows into the project page's band as it
 * opens (./card-morph.ts).
 *
 * Above the grid: the kinds of app the directory has. What an account adds
 * is the hero's to say
 * (features/auth/story.tsx), with its one button: the "Want to join in?"
 * card that said it again partway down is gone (Evan, 22 Oct 2026). Ways in
 * are asked for where somebody wants to do something (the project page's
 * Join, Vote, Ask), never as a wall.
 */

import { guestSearchFrom, withGuestSearch } from './search-history';
import { type AnchorHTMLAttributes, type MouseEvent, type ReactNode, useEffect, useMemo, useState } from 'react';

import { ArrowRightShortIcon, SearchIcon, UserIcon } from '@/components/ui/icons';
import { cn } from '@/lib/utils';

import { useMessages } from '../../lib/i18n/react';
import { useStoreState } from '../../lib/use-store-state';
import { CommunitiesToJoin } from '../home/communities-to-join';
import { CORNER_UNPIN, CommunityTileFace, MinusGlyph } from '../home/pinned-communities';
import { devicePinsStore, loadDevicePins, toggleDevicePin } from './device-pins';
import { useCommunityColor } from '../../lib/community-color';
import { AppIconContent, appIconKind } from '../apps/app-card-view';
import { cardCover, morph, projectHero } from './card-morph';
import { CardPreview } from './card-preview';
import {
  type GuestApp,
  MIN_PEOPLE,
  projectHash,
  projectPath,
} from './guest-data';

/** A project made in the last 30 days wears "New". */
const NEW_FOR_MS = 30 * 24 * 60 * 60 * 1000;

export const SMALL_CAPS_LABEL = 'text-xs font-bold uppercase tracking-[0.06em] text-zinc-500 dark:text-zinc-400';

/**
 * The grid of picture cards (Home's Communities to join, signed in or out):
 * as many 190px columns as fit, never fewer than two (half the width, less
 * half the gap, is the floor).
 */
export const CARD_GRID = 'grid grid-cols-[repeat(auto-fill,minmax(min(190px,calc(50%_-_6px)),1fr))] gap-3';

function isNew(app: GuestApp, now = Date.now()): boolean {
  const t = app.created_at ? Date.parse(app.created_at) : NaN;
  return Number.isFinite(t) && now - t < NEW_FOR_MS;
}

/** The app's icon, in the tile Discover's rows draw (app-card-view.tsx). `className` overrides the size's radius or shadow. */
export function GuestIcon({ app, size = 'md', eager = false, className }: { app: GuestApp; size?: 'sm' | 'md' | 'lg' | 'xl'; eager?: boolean; className?: string }) {
  const box = size === 'xl'
    ? 'w-20 h-20 rounded-[22px] text-4xl shadow-[0_6px_20px_rgba(0,0,0,0.18)]'
    : size === 'lg'
    ? 'w-16 h-16 rounded-2xl text-2xl shadow-[0_4px_14px_rgba(0,0,0,0.16)]'
    : size === 'sm' ? 'w-8 h-8 rounded-lg text-sm' : 'w-11 h-11 rounded-xl text-lg';
  return (
    <span
      className={cn('app-icon-tile shrink-0 overflow-hidden flex items-center justify-center font-bold', box, className)}
      data-icon={appIconKind(app)}
      aria-hidden="true"
    >
      <AppIconContent app={app} eager={eager} />
    </span>
  );
}

/**
 * A project's picture: the one its group chose for its Discover card
 * (`illustration_url`, its dark twin in the dark theme), else its icon large
 * on its own colour (lib/community-color.ts).
 */
export function GuestCover({ app, className, iconSize = 'lg', hero = false }: {
  app: GuestApp;
  className?: string;
  iconSize?: 'lg' | 'xl';
  /** The picture a Discover card grows into as its page opens (./card-morph.ts). */
  hero?: boolean;
}) {
  const color = useCommunityColor({ color: app.icon_color, iconUrl: app.icon_url, iconEmoji: app.icon_emoji, key: app.slug });
  if (app.illustration_url) {
    return (
      <span data-guest-hero={hero ? '' : undefined} className={cn('relative block overflow-hidden bg-zinc-200 dark:bg-zinc-800', className)}>
        <img
          src={app.illustration_url}
          alt=""
          loading="lazy"
          draggable={false}
          className={cn('h-full w-full object-cover', app.illustration_dark_url ? 'dark:hidden' : '')}
        />
        {app.illustration_dark_url ? (
          <img src={app.illustration_dark_url} alt="" loading="lazy" draggable={false} className="hidden h-full w-full object-cover dark:block" />
        ) : null}
      </span>
    );
  }
  return (
    <span data-guest-hero={hero ? '' : undefined} className={cn('relative flex items-center justify-center overflow-hidden', className)} style={{ background: color }}>
      <GuestIcon app={app} size={iconSize} />
    </span>
  );
}

/**
 * A link to a project's page. Its href is the page's clean address
 * (guest-data projectPath), so a crawler reading Discover finds every public
 * project at the address its preview, canonical and sitemap name. A plain
 * click on Discover stays in the page and moves the fragment, as the cards
 * always did (#app/<slug>/workshop, the address signing in returns to); a
 * click that asks for a new tab or window, or one from an address that is
 * already a path, is the browser's, and the server opens the same page.
 */
export function ProjectLink({ slug, children, ...rest }: { slug: string; children: ReactNode } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'onClick'>) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (location.pathname !== '/') return;
    e.preventDefault();
    // The card's picture grows into the page's band (./card-morph.ts).
    morph(cardCover(slug), () => { location.hash = projectHash(slug); }, () => projectHero(slug));
  };
  return <a href={projectPath(slug)} onClick={onClick} {...rest}>{children}</a>;
}

/**
 * A card's picture: the illustration its group chose, else its icon larger
 * on its colour, lit from the top left, with a blurred copy of the icon
 * glowing behind it in its own colours. The people pill sits in its lower
 * left and, under a pointer or keyboard focus, an arrow in its lower right.
 * A picture may carry an animated preview (`preview_url`), which plays over
 * it under the rules in ./card-preview.tsx; the pills stay on top.
 */
function CardCover({ app, eager }: { app: GuestApp; eager: boolean }) {
  const t = useMessages('auth');
  const color = useCommunityColor({ color: app.icon_color, iconUrl: app.icon_url, iconEmoji: app.icon_emoji, key: app.slug });
  const people = app.active_users || 0;
  return (
    <span
      data-guest-card-cover=""
      className="relative flex aspect-[16/10] w-full items-center justify-center overflow-hidden bg-zinc-200 shadow-[inset_0_-1px_0_var(--app-sheet-line)] dark:bg-zinc-800"
      style={app.illustration_url ? undefined : { background: color }}
    >
      {app.illustration_url ? (
        <>
          <img
            src={app.illustration_url}
            alt=""
            loading={eager ? 'eager' : 'lazy'}
            draggable={false}
            className={cn('absolute inset-0 h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.04] motion-reduce:transition-none motion-reduce:group-hover:scale-100', app.illustration_dark_url ? 'dark:hidden' : '')}
          />
          {app.illustration_dark_url ? (
            <img
              src={app.illustration_dark_url}
              alt=""
              loading={eager ? 'eager' : 'lazy'}
              draggable={false}
              className="absolute inset-0 hidden h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.04] motion-reduce:transition-none motion-reduce:group-hover:scale-100 dark:block"
            />
          ) : null}
          {app.preview_url ? <CardPreview src={app.preview_url} /> : null}
        </>
      ) : (
        <>
          <span aria-hidden="true" className="absolute inset-0 bg-[radial-gradient(120%_90%_at_22%_12%,rgba(255,255,255,0.28),rgba(255,255,255,0)_58%)]" />
          {app.icon_url ? (
            <img
              src={app.icon_url}
              alt=""
              aria-hidden="true"
              loading={eager ? 'eager' : 'lazy'}
              draggable={false}
              className="pointer-events-none absolute left-1/2 top-1/2 h-24 w-24 -translate-x-1/2 -translate-y-1/2 scale-[1.6] rounded-full object-cover opacity-70 blur-[26px] saturate-[1.6] transition duration-300 ease-out group-hover:scale-[2] group-hover:opacity-95 motion-reduce:transition-none"
            />
          ) : null}
          <span className="relative transition-transform duration-300 ease-out group-hover:-translate-y-[3px] group-hover:scale-[1.07] motion-reduce:transition-none motion-reduce:group-hover:translate-y-0 motion-reduce:group-hover:scale-100">
            <GuestIcon app={app} size="lg" eager={eager} className="rounded-[18px] shadow-[0_12px_26px_rgba(0,0,0,0.3),0_0_0_1px_rgba(255,255,255,0.28)]" />
          </span>
        </>
      )}
      {isNew(app) ? (
        <span className="absolute start-2 top-2 rounded-full bg-white px-2 py-0.5 text-xs font-bold text-zinc-950 dark:bg-zinc-900 dark:text-white">
          {t('auth:guest.card.new')}
        </span>
      ) : null}
      {people >= MIN_PEOPLE ? (
        <span
          data-guest-card-people=""
          aria-hidden="true"
          className="absolute bottom-2 start-2 inline-flex h-6 items-center gap-1 rounded-full bg-white/90 ps-1.5 pe-2 text-xs font-[650] tabular-nums text-zinc-800 shadow-[0_1px_3px_rgba(0,0,0,0.14)]"
        >
          <UserIcon className="h-3.5 w-3.5" />
          {people.toLocaleString()}
        </span>
      ) : null}
      <span
        aria-hidden="true"
        className="absolute bottom-2 end-2 flex h-8 w-8 translate-x-[calc(-0.5rem*var(--rtl-sign,1))] items-center justify-center rounded-full bg-white/95 text-zinc-900 opacity-0 shadow-[0_2px_8px_rgba(0,0,0,0.2)] transition duration-150 ease-out group-hover:translate-x-0 group-hover:opacity-100 group-has-[a:focus-visible]:translate-x-0 group-has-[a:focus-visible]:opacity-100 motion-reduce:transition-none"
      >
        <ArrowRightShortIcon className="h-[18px] w-[18px]" />
      </span>
    </span>
  );
}

/**
 * A card. Its name is its one link, stretched over the whole card, so the
 * picture, the sentence and the gaps between them all open the project's
 * page, and nothing is a link inside a link. The name's own box is 44px
 * tall (`py-3`) with `-my-3` taking the padding back out of the card, so a
 * finger has a real target while the card looks exactly as it did.
 */
export function Card({ app, eager, featured = false, footer }: {
  app: GuestApp;
  eager: boolean;
  featured?: boolean;
  /** One Home (#6361): a row under the words, raised over the card's link so
      its buttons (the signed-in Join) take their own taps. A visitor's card
      has no footer row (#6433). */
  footer?: ReactNode;
}) {
  const t = useMessages('auth');
  const people = app.active_users || 0;
  return (
    <article
      data-guest-card={featured ? undefined : app.slug}
      data-guest-featured={featured ? app.slug : undefined}
      className="group relative flex min-w-0 flex-col overflow-hidden rounded-[20px] bg-white shadow-[inset_0_0_0_1px_var(--app-sheet-line),0_1px_2px_rgba(0,0,0,0.05),0_10px_22px_-12px_rgba(0,0,0,0.22)] transition-[transform,box-shadow] duration-150 ease-out hover:-translate-y-1 hover:shadow-[inset_0_0_0_1px_var(--app-sheet-line),0_2px_4px_rgba(0,0,0,0.05),0_22px_36px_-14px_rgba(0,0,0,0.34)] active:scale-[0.97] active:duration-75 has-[a:focus-visible]:outline has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-[3px] has-[a:focus-visible]:outline-violet-600 motion-reduce:transition-none motion-reduce:hover:translate-y-0 motion-reduce:active:scale-100 dark:bg-zinc-900 dark:has-[a:focus-visible]:outline-violet-400"
    >
      <CardCover app={app} eager={eager} />
      <span className="flex flex-1 flex-col px-3 pb-3.5 pt-2.5">
        {/* The pill on the picture is hidden from a screen reader, which
            hears its number in words with the name instead. */}
        <ProjectLink
          slug={app.slug}
          data-guest-card-link=""
          aria-label={people >= MIN_PEOPLE ? t('auth:guest.card.peopleLabel', { name: app.name, count: people }) : undefined}
          className="block truncate text-[15px] font-[650] leading-5 text-zinc-900 outline-none -my-3 py-3 after:absolute after:inset-0 after:z-[1] after:rounded-[20px] after:content-[''] dark:text-zinc-100"
        >
          {app.name}
        </ProjectLink>
        {app.description ? (
          // No `block` beside line-clamp-2: it comes later in the stylesheet,
          // undid the clamp's display and let the text run to four lines
          // (#5851), so cards in a row grew apart.
          <span data-guest-card-about="" className="mt-0.5 line-clamp-2 text-[13px] leading-[18px] text-zinc-500 dark:text-zinc-400">
            {app.description}
          </span>
        ) : null}
        {footer ? <span className="relative z-[2] mt-2.5 flex items-center gap-2" data-guest-card-footer="">{footer}</span> : null}
      </span>
    </article>
  );
}

/**
 * "Try it", where the app has a view for somebody with no account, else a
 * way to read about it. An app that answers a visitor with no credential at
 * all opens in the landing's own viewer, inside Homeroom; one that answers a
 * guest opens at its own address, where the app host gives the visitor a
 * guest's view, the "You're looking around" strip and "Make an account to
 * continue" (src/services/edge-gate.js, public/usernode-bridge.js).
 */
export function TryLink({ app, className, onOpenInside, inside = false, children }: {
  app: GuestApp;
  className: string;
  onOpenInside: (app: GuestApp) => void;
  /** Open it in the landing's viewer whatever it needs: the visitor is signed in (a waitlisted account). */
  inside?: boolean;
  children: ReactNode;
}) {
  return (
    <a
      href={app.url}
      data-guest-try={app.slug}
      className={className}
      onClick={(e) => {
        if (inside || app.requires_login === false) {
          e.preventDefault();
          onOpenInside(app);
        }
      }}
    >
      {children}
    </a>
  );
}

export function GuestDiscover({ apps, failed, hero, onRetry, signedIn = false, onIntent, onOpenInside }: {
  /** The public directory, or null while it loads. */
  apps: GuestApp[] | null;
  /** The directory could not be read. */
  failed: boolean;
  /** The story's short version, above everything (features/auth/story.tsx). */
  hero: ReactNode;
  /** Read the directory again, from the line that says it could not be. */
  onRetry?: () => void;
  /**
   * An account still on the waitlist is looking (landing.tsx): every public
   * app opens for it, signed in, and joining waits until it is let in.
   */
  signedIn?: boolean;
  /** ONE HOME (#6361): Join on a card asks to sign up, titled for the project. */
  onIntent?: (intent: { kind: 'join'; app: GuestApp }) => void;
  /** Open an app in the landing's own viewer (TryLink). */
  onOpenInside?: (app: GuestApp) => void;
}) {
  // ONE HOME (#6361): THE SAME HOME, SIGNED OUT. Under the story: one search,
  // Pinned apps (this device's, shown once it has pinned one; #6433 took the
  // suggested row and its + away), the communities this device pinned, then
  // Communities, the directory's picture cards. Pins are kept on the device
  // (./device-pins.ts) and move to the account at sign-in. The Featured and
  // All apps sections, their sort control and Show more went with it.
  const t = useMessages('auth');
  const th = useMessages('home');
  const [query, setQuery] = useState('');
  // The project page replaces this component. Keep the query on the Home
  // history entry so Back restores this visit, independently of other tabs.
  useEffect(() => {
    const restore = () => setQuery(guestSearchFrom(window.history.state));
    restore();
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);
  const changeQuery = (value: string) => {
    setQuery(value);
    try { window.history.replaceState(withGuestSearch(window.history.state, value), ''); } catch { /* History unavailable: search still works. */ }
  };

  const device = useStoreStateLocal();
  useEffect(() => { loadDevicePins(); }, []);

  const all = apps || [];
  const bySlug = useMemo(() => new Map(all.map((a) => [a.slug, a])), [all]);
  const q = query.trim();
  const matches = (app: GuestApp) => !q || [app.name, app.slug, app.description].some((f) => typeof f === 'string' && f.toLowerCase().includes(q.toLowerCase()));
  const pinnedApps = device.apps.map((s) => bySlug.get(s)).filter((a): a is GuestApp => !!a && matches(a));
  const pinnedCommunities = device.communities.map((s) => bySlug.get(s)).filter((a): a is GuestApp => !!a && matches(a));
  const open = onOpenInside || (() => {});

  const appTile = (app: GuestApp) => (
    <span key={app.slug} className="relative flex min-w-0 flex-col items-center gap-1.5 py-1 text-center" data-guest-pinned-app={app.slug}>
      <TryLink app={app} className="flex min-w-0 flex-col items-center gap-1.5 no-underline" onOpenInside={open} inside={signedIn}>
        <GuestIcon app={app} size="md" />
        <span className="max-w-full line-clamp-2 break-words text-[12.5px] font-semibold leading-[15px] text-zinc-800 dark:text-zinc-200">{app.name}</span>
      </TryLink>
      {/* #6389: the control's box is 44px so a finger finds it; the drawn
          badge stays 24px, centred where it was, so nothing about the tile
          looks different. */}
      <button
        type="button"
        className="absolute -top-4 -end-1.5 w-11 h-11 flex items-center justify-center"
        aria-label={th('home:guest.unpinApp', { app: app.name })}
        onClick={() => { toggleDevicePin('apps', app.slug); }}
      >
        <span className={`w-6 h-6 rounded-full flex items-center justify-center shadow-[0_0_0_2px_var(--dc-sheet-solid)] ${CORNER_UNPIN}`}>
          <MinusGlyph />
        </span>
      </button>
    </span>
  );

  return (
    <div data-guest-discover="" className="flex flex-col gap-5">
      {hero}
      <div className="flex flex-col gap-2 px-4">
        <label className="flex h-11 items-center gap-2 rounded-[14px] bg-white px-3.5 text-zinc-400 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900 dark:text-zinc-500">
          <SearchIcon className="h-[18px] w-[18px] shrink-0" />
          <input
            type="search"
            data-guest-search=""
            value={query}
            onChange={(e) => changeQuery(e.target.value)}
            placeholder={th('home:search.placeholder')}
            aria-label={th('home:search.label')}
            className="h-11 min-w-0 flex-1 bg-transparent text-base text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100 dark:placeholder:text-zinc-500"
          />
        </label>

        {pinnedApps.length ? (
          <section data-guest-pinned-apps="">
            <h2 className={`${SMALL_CAPS_LABEL} pt-4 pb-1.5`}>{th('home:grid.heading')}</h2>
            <div className="grid grid-cols-4 gap-x-1 gap-y-4 pt-2">
              {pinnedApps.map((a) => appTile(a))}
            </div>
          </section>
        ) : null}

        {pinnedCommunities.length ? (
          <section data-guest-pinned-communities="">
            <h2 className={`${SMALL_CAPS_LABEL} pt-4 pb-1.5`}>{th('home:communities.heading')}</h2>
            <div className="grid grid-cols-4 gap-x-1 gap-y-4 pt-2">
              {pinnedCommunities.map((app) => (
                <ProjectLink key={app.slug} slug={app.slug} className="flex min-w-0 flex-col items-center gap-1.5 rounded-2xl py-1 text-center no-underline" data-guest-pinned-community={app.slug}>
                  <CommunityTileFace slug={app.slug} name={app.name || app.slug} iconUrl={app.icon_url || null} iconEmoji={app.icon_emoji || null} iconColor={app.icon_color || null} />
                  <span className="max-w-full line-clamp-2 break-words text-[12.5px] font-semibold leading-[15px] text-zinc-800 dark:text-zinc-200">{app.name}</span>
                </ProjectLink>
              ))}
            </div>
          </section>
        ) : null}
      </div>

      {failed ? (
        <div className="flex flex-col items-center gap-3 px-4 py-6">
          <p className="text-center text-[15px] text-zinc-500 dark:text-zinc-400">{t('auth:guest.loadFailed')}</p>
          {onRetry ? (
            <button
              type="button"
              data-guest-retry=""
              className="min-h-11 self-center rounded-full bg-white px-5 text-[15px] font-semibold text-zinc-900 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
              onClick={onRetry}
            >
              {t('auth:guest.retry')}
            </button>
          ) : null}
        </div>
      ) : (
        <div className="px-1">
          <CommunitiesToJoin
            apps={apps}
            exclude={EMPTY}
            signedIn={false}
            query={q}
            onJoin={(app) => { onIntent?.({ kind: 'join', app }); }}
          />
        </div>
      )}
    </div>
  );
}

const EMPTY: ReadonlySet<string> = new Set();

function useStoreStateLocal() {
  return useStoreState(devicePinsStore);
}
