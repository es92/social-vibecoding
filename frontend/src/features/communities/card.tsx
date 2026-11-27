/**
 * A COMMUNITY'S CARD ("New, lighter", approved 20 Nov 2026), wherever a
 * community is drawn as a card: the Communities page's Pinned (here), and
 * Featured and Communities to join on Home, the Communities page and the
 * visitor's landing (../guest/guest-discover.tsx `Card`).
 *
 *   picture   first, edge to edge, 16:9, cover, not shaded: the picture its
 *             group chose (its dark twin in the dark theme).
 *   icon      the community's own icon (its image, else its emoji or initial
 *             on a white tile), standing mostly below the picture with its
 *             top over the picture's lower edge, on a thin light outline.
 *   beside it the name over how many members, in words.
 *   then      what it says it is, two lines at most, and this week, in
 *             words at every width (phone review S3, 23 Nov 2026): "33
 *             active · 5 changes live this week", "6 active this week", or
 *             nothing when both are zero. A line too long for its card wraps
 *             between the two parts. It stands at the card's foot, so every
 *             card of a row has it on the same line.
 *
 * THE CARD WITH NO PICTURE (decided 23 Nov 2026, phone review #39, #66,
 * #134, S10) draws its ICON AS THE PICTURE: the band shows the icon large
 * and centred (64px, 16px corners, a soft shadow; an emoji or initial on a
 * white tile) on a soft wash of the icon's main colour, or of one of the
 * brand's tints, chosen from the slug, where the icon has little colour or
 * is an emoji or a letter (lib/community-color.ts `useIconMainColor`,
 * `bandWash`). Nothing is beside the name then: it starts at the card's
 * left edge, the members under it, and the rest as above. A picture that
 * does not load falls back to this card. No stock background is drawn on
 * any card.
 *
 * THE COMPACT CARD is the same card with its picture taken off: the icon
 * smaller beside the name, and under the name its week in two plain lines
 * (the Communities page's Joined; approved 23 Nov 2026, "F, without the
 * little people icons"): "34 members, 6 active this week" in grey, then
 * "6 changes live this week" after a tick in the link's blue. A quiet
 * community is "16 members" alone, and the second line is drawn only when
 * something went live. No faces, no description. A narrow card wraps the
 * first line between its two facts, never inside one.
 *
 * Everything here is markup with fixed class names; the sizes, inks, edges
 * and corners are app.css's (`.cm-card`, "A COMMUNITY'S CARD"), read from
 * `--cm-*` tokens each look sets, so a look draws the same card in its own
 * colours. The root (a link, or an article with a stretched link) is the
 * caller's, so each place keeps its own ids, `data-*` and behaviour.
 */
import { type CSSProperties, type ReactNode, useEffect, useState } from 'react';

import { CheckIcon, HeartIcon, PlusIcon } from '@/components/ui/icons';
import { StateTag } from '@/components/ui/state-tag';

import { bandWash, useIconMainColor } from '../../lib/community-color';
import { RichMessage, useMessages } from '../../lib/i18n/react';
import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { useMinWidth } from '../../lib/use-min-width';
import { capCount } from '../../lib/count-cap';
import { sizedPicture } from '../apps/app-card.js';
import { shownCardHearts, shownPlays } from '../popularity/popularity';
import { AppIconContent, appIconKind } from '../apps/app-card-view';
import {
  CORNER, CORNER_PIN, CORNER_UNPIN, MinusGlyph, VOTES, WIGGLE, openHub,
} from '../home/pinned-communities';

/** What a card draws of a community. A number left out says nothing. */
export interface CardCommunity {
  slug: string;
  name: string;
  iconUrl?: string | null;
  iconEmoji?: string | null;
  /** The colour dapp.json sets beside the icon, if any: the band's wash when there is no picture. */
  iconColor?: string | null;
  /** The picture its group chose for its card, and that picture's dark twin. */
  pictureUrl?: string | null;
  pictureDarkUrl?: string | null;
  members?: number | null;
  /** What it says it is (dapp.json's description). */
  description?: string | null;
  /** People who took part in the last seven days, and changes that went live in them. */
  activeWeek?: number | null;
  liveWeek?: number | null;
  /**
   * How many times its app was played or opened, one per person per day, and
   * how many accounts gave it a heart (../popularity/popularity.ts). `played`:
   * the app is a game, so the count is plays; anything else is opened.
   */
  plays?: number | null;
  hearts?: number | null;
  played?: boolean;
}

const count = (n: number | null | undefined) => Math.max(0, Math.floor(Number(n) || 0));

/**
 * The width a card's picture is asked for (request #7165, point 5): a phone's
 * card is at most about 170px wide, so 512 is sharp at 3x; a wide screen's
 * first row can be several hundred, so it takes the next size up. Read when
 * the card draws: cards come from data loaded after the first render.
 */
function cardPictureWidth(): number {
  return typeof window !== 'undefined' && window.innerWidth >= 768 ? 1024 : 512;
}

/** What goes over a picture: drawn as it is, or asked whether the picture itself is shown (a preview loop plays only over one). */
export type PictureOverlay = ReactNode | ((picture: boolean) => ReactNode);

/**
 * The card's picture, or, where it has none or it does not load, its icon
 * as the picture on its wash (the card with no picture, in the header).
 * `attrs` and `children` are the caller's: the hooks a card-to-page morph
 * finds, a "New" pill, a preview loop that plays over the picture. `face`
 * is drawn on the band's icon (a count, the edit discs) and `faceClass`
 * moves it, as they are on the small icon of a card with a picture;
 * `onPicture` hears whether the picture is the one shown.
 */
export function CommunityPicture({ community, eager = false, attrs, children, face, faceClass, onPicture }: {
  community: CardCommunity;
  eager?: boolean;
  attrs?: Record<string, string | undefined>;
  children?: PictureOverlay;
  face?: ReactNode;
  faceClass?: string;
  onPicture?: (picture: boolean) => void;
}) {
  // Asked for at the card's size, not the whole stored file (up to 1 MB).
  const width = cardPictureWidth();
  const url = sizedPicture(community.pictureUrl, width) as string | null | undefined;
  const dark = sizedPicture(community.pictureDarkUrl, width) as string | null | undefined;
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [url, dark]);
  const picture = !!url && !failed;
  useEffect(() => { onPicture?.(picture); }, [picture]); // eslint-disable-line react-hooks/exhaustive-deps
  // The icon's colour is read only where it is drawn: a card with a picture asks for nothing.
  const main = useIconMainColor(picture ? null : { color: community.iconColor, iconUrl: community.iconUrl, iconEmoji: community.iconEmoji, key: community.slug });
  const wash = picture ? null : bandWash(community.slug, main);
  return (
    <span className="cm-card-pic" {...wash?.attrs} style={wash?.style as CSSProperties | undefined} {...attrs}>
      {picture ? (
        <>
          <img
            src={url!}
            alt=""
            loading={eager ? 'eager' : 'lazy'}
            decoding={eager ? undefined : 'async'}
            draggable={false}
            onError={() => setFailed(true)}
            className={dark ? 'cm-card-img dark:hidden' : 'cm-card-img'}
          />
          {dark ? (
            <img src={dark} alt="" loading={eager ? 'eager' : 'lazy'} decoding={eager ? undefined : 'async'} draggable={false} onError={() => setFailed(true)} className="cm-card-img hidden dark:block" />
          ) : null}
        </>
      ) : (
        <span className={faceClass ? `cm-band-face ${faceClass}` : 'cm-band-face'}>
          <CommunityIcon community={community} eager={eager} band />
          {face}
        </span>
      )}
      {typeof children === 'function' ? children(picture) : children}
    </span>
  );
}

/** The community's own icon: its image, else its emoji or its initial on a white tile. `band`: the large one a card with no picture draws as its picture. */
export function CommunityIcon({ community, eager = false, band = false }: { community: CardCommunity; eager?: boolean; band?: boolean }) {
  const app = { slug: community.slug, name: community.name, icon_url: community.iconUrl || null, icon_emoji: community.iconEmoji || null };
  return (
    <span className={band ? 'cm-band-icon' : 'cm-card-icon'} data-icon={appIconKind(app)} aria-hidden="true">
      <AppIconContent app={app} eager={eager} />
    </span>
  );
}

/**
 * The line at the card's foot, in words at every width (phone review S3, 23
 * Nov 2026: a glyph and a bare number needed a legend). This week: "33
 * active", a dot, "5 changes live this week" in the link's blue; "6 active
 * this week" alone when nothing went live; nothing at all for a quiet week.
 *
 * HEARTS AND PLAYS lead it where a card has them (../popularity/): a red
 * heart and how many accounts gave one (the one glyph on the line: a heart
 * beside a number needs no legend, and a screen reader is given the words),
 * then "6,930 plays", or "opens" for an app that is not a game. The plays
 * stand where "33 active" stood, so a card says one thing about use, not
 * two: "58 · 6,930 plays · 5 changes live this week". A count too small to
 * read as busy says nothing (shownPlays, shownCardHearts), and a card with
 * no plays to show keeps its active count.
 *
 * A line too long for its card wraps between its parts, and the dot is
 * drawn before each part where a wrapped line's first one is cut off
 * (app.css), so no line starts with it.
 */
export function CommunityWeek({ active, live, plays, hearts, played = true }: {
  active?: number | null;
  live?: number | null;
  plays?: number | null;
  hearts?: number | null;
  played?: boolean;
}) {
  const t = useMessages('home');
  const p = shownPlays(plays);
  const h = shownCardHearts(hearts);
  const a = p ? 0 : count(active);
  const l = count(live);
  if (!a && !l && !p && !h) return null;
  const people = a ? t(l ? 'home:communities.activeShort' : 'home:communities.activeWeek', { count: a, formatted: a.toLocaleString() }) : null;
  const uses = p
    ? played
      ? t('home:communities.plays', { count: p, formatted: p.toLocaleString() })
      : t('home:communities.opens', { count: p, formatted: p.toLocaleString() })
    : null;
  const changes = l ? t('home:communities.liveThisWeek', { count: l, formatted: l.toLocaleString() }) : null;
  return (
    <span className="cm-card-week" data-cm-week="">
      <span className="cm-week-in">
        {h ? (
          <span className="inline-flex items-center gap-1" data-cm-hearts={String(h)}>
            <HeartIcon className="h-[13px] w-[13px] shrink-0 fill-current text-rose-600 dark:text-rose-400" aria-hidden="true" />
            <b className="font-semibold text-[color:var(--cm-ink)]" aria-hidden="true">{h.toLocaleString()}</b>
            <span className="sr-only">{t('home:communities.hearts', { count: h, formatted: h.toLocaleString() })}</span>
          </span>
        ) : null}
        {uses ? <span data-cm-plays={String(p)}>{uses}</span> : null}
        {people ? <span>{people}</span> : null}
        {changes ? <span className="cm-week-live">{changes}</span> : null}
      </span>
    </span>
  );
}

/**
 * The name over how many members, beside the icon (or alone, on a card with
 * no picture). `name` replaces the plain name (a card whose name is its
 * link). `week` is the compact card's: the members line says who was active
 * this week too, and a second line what went live (see the header). A zero
 * says nothing.
 */
function CardId({ community, name, week = false }: { community: CardCommunity; name?: ReactNode; week?: boolean }) {
  const t = useMessages('home');
  const members = count(community.members);
  const active = week ? count(community.activeWeek) : 0;
  const live = week ? count(community.liveWeek) : 0;
  const membersText = t('home:communities.members', { count: members, formatted: members.toLocaleString() });
  return (
    <span className="cm-card-id">
      {name ?? <span className="cm-card-name">{community.name}</span>}
      {members ? (
        <span className="cm-card-members" data-cm-members="">
          {active ? (
            <RichMessage
              id="home:communities.compactMembersActive"
              values={{ count: active, formatted: active.toLocaleString(), members: membersText }}
              components={[<span className="cm-card-fact" />, <span className="cm-card-fact" />]}
            />
          ) : membersText}
        </span>
      ) : null}
      {live ? (
        <span className="cm-card-live" data-cm-live="">
          <CheckIcon className="cm-card-live-tick" aria-hidden="true" />
          <span className="cm-card-fact">{t('home:communities.compactLive', { count: live, formatted: live.toLocaleString() })}</span>
        </span>
      ) : null}
    </span>
  );
}

/**
 * The big card's insides, inside the caller's root (`.cm-card`). `face` is
 * drawn on the icon (a count, the edit discs) and `faceClass` moves it (the
 * edit wiggle): the small icon under a picture, or the band's icon on a
 * card with no picture, which has nothing beside its name. `picture` goes
 * over the picture.
 */
export function CommunityCardContent({ community, eager = false, name, face, faceClass, picture, pictureAttrs, aboutAttrs }: {
  community: CardCommunity;
  eager?: boolean;
  name?: ReactNode;
  face?: ReactNode;
  faceClass?: string;
  picture?: PictureOverlay;
  pictureAttrs?: Record<string, string | undefined>;
  /** Hooks on the sentence (a card on Discover keeps its `data-guest-card-about`). */
  aboutAttrs?: Record<string, string | undefined>;
}) {
  const about = (community.description || '').trim();
  // Whether the picture is shown: it can stop being, when it does not load.
  const [shown, setShown] = useState(!!community.pictureUrl);
  return (
    <>
      <CommunityPicture
        community={community}
        eager={eager}
        attrs={pictureAttrs}
        face={shown ? undefined : face}
        faceClass={faceClass}
        onPicture={setShown}
      >
        {picture}
      </CommunityPicture>
      <span className="cm-card-body" data-cm-bare={shown ? undefined : ''}>
        <span className="cm-card-head">
          {shown ? (
            <span className={faceClass ? `cm-card-face ${faceClass}` : 'cm-card-face'}>
              <CommunityIcon community={community} eager={eager} />
              {face}
            </span>
          ) : null}
          <CardId community={community} name={name} />
        </span>
        {about ? <span className="cm-card-desc" data-cm-desc="" {...aboutAttrs}>{about}</span> : null}
        <CommunityWeek active={community.activeWeek} live={community.liveWeek} plays={community.plays} hearts={community.hearts} played={community.played} />
      </span>
    </>
  );
}

/** The compact card's insides: the icon beside the name and its week (the members, who was active, what went live), no picture. */
export function CommunityCardCompactContent({ community, name, face, faceClass }: {
  community: CardCommunity;
  /** Replaces the plain name (the name with the votes waiting as a tag beside it). */
  name?: ReactNode;
  face?: ReactNode;
  faceClass?: string;
}) {
  return (
    <span className="cm-card-head">
      <span className={faceClass ? `cm-card-face ${faceClass}` : 'cm-card-face'}>
        <CommunityIcon community={community} />
        {face}
      </span>
      <CardId community={community} name={name} week />
    </span>
  );
}

/**
 * A community on the Communities page as a card (../communities/index.tsx):
 * the big card for one you pinned, the compact one for one you joined. It
 * is the tile it replaces in all it does: one link to the community's hub
 * (the door rule), its `data-home-community` hooks, the votes waiting on
 * the icon's corner with their words for a screen reader, and, while the
 * page is edited, the − that unpins it (the icon wiggles) or the + that
 * pins it.
 *
 * `voteTag` (the standard look, ONE LOOK of 25 Nov 2026): the votes waiting
 * are a tag beside the name, in words ("2 to vote"), not a count on the
 * icon's corner, and the words a screen reader had are the tag's own.
 */
export function CommunityPageCard({ community, votes, editing, compact = false, voteTag = false, onUnpin, onPin }: {
  community: CardCommunity;
  votes: number;
  editing: boolean;
  compact?: boolean;
  voteTag?: boolean;
  onUnpin?: () => void;
  onPin?: () => void;
}) {
  const t = useMessages('home');
  const tc = useMessages('communities');
  const { slug, name } = community;
  const tagged = voteTag && votes > 0 && !editing;
  const named = tagged ? (
    <span className="cm-card-name-row">
      <span className="cm-card-name">{name}</span>
      <StateTag state="needs" className="cm-card-votes" data-home-community-votes={String(votes)}>{tc('communities:row.toVote', { count: votes })}</StateTag>
    </span>
  ) : undefined;
  const face = (
    <>
      {votes > 0 && !editing && !voteTag ? <span className={VOTES} data-home-community-votes={String(votes)} aria-hidden="true">{capCount(votes)}</span> : null}
      {editing && onUnpin ? (
        <button
          type="button"
          className={`${CORNER} -start-1.5 ${CORNER_UNPIN}`}
          aria-label={t('home:communities.unpinNamed', { community: name })}
          onClick={(event) => { event.preventDefault(); event.stopPropagation(); onUnpin(); }}
        >
          <MinusGlyph />
        </button>
      ) : null}
      {onPin ? (
        <button
          type="button"
          className={`${CORNER} -end-1.5 ${CORNER_PIN}`}
          aria-label={t('home:communities.pinNamed', { community: name })}
          onClick={(event) => { event.preventDefault(); event.stopPropagation(); onPin(); }}
        >
          <PlusIcon className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      ) : null}
    </>
  );
  const faceClass = editing ? WIGGLE : undefined;
  return (
    <a
      href={`/app/${encodeURIComponent(slug)}/workshop`}
      className="cm-card"
      data-cm-size={compact ? 'compact' : undefined}
      data-home-community={slug}
      data-home-community-pinned=""
      onClick={(event) => { if (editing) { event.preventDefault(); return; } openHub(event, slug); }}
    >
      {compact
        ? <CommunityCardCompactContent community={community} name={named} face={face} faceClass={faceClass} />
        : <CommunityCardContent community={community} name={named} face={face} faceClass={faceClass} />}
      {votes > 0 && !tagged ? <span className="sr-only">{tc('communities:row.toVote', { count: votes })}</span> : null}
    </a>
  );
}

/**
 * A card held in place while what it shows is read: the card's own ground,
 * its picture's shape and about as tall as its words, so the page does not
 * move when the cards land. `lead` holds the larger card's place.
 */
export function CommunityCardSkeleton({ lead = false }: { lead?: boolean }) {
  return (
    <span className="cm-card cm-card-skel" data-cm-size={lead ? 'lead' : undefined} aria-hidden="true">
      <span className="cm-card-pic" />
      <span className="cm-card-skel-body" />
    </span>
  );
}

/** The most featured communities the larger first row holds. */
export const LEAD_MAX = 3;

/**
 * HOW MANY FEATURED COMMUNITIES ARE DRAWN LARGER, in a first row of their
 * own (asked 20 Nov 2026: "first row of featured larger everywhere"): one
 * fewer than a row of the cards under it holds, so each is wider than they
 * are, three at most and two at least; on a phone (under 640px), one, the
 * whole width. How many a row holds is read off the grid itself: `probe` is
 * an empty grid of the same kind (`data-cm-grid="join"`), whose columns the
 * CSS decides (the caller hands it over from a ref callback, so a probe
 * drawn anew is measured anew), read again whenever its width changes.
 * Before it is measured (and in a prerender) the answer is the most.
 */
export function useLeadCount(probe: HTMLElement | null): number {
  const wide = useMinWidth(640);
  const [cols, setCols] = useState(LEAD_MAX + 1);
  useIsomorphicLayoutEffect(() => {
    const el = probe;
    if (!el || typeof window === 'undefined') return undefined;
    const measure = () => {
      const tracks = getComputedStyle(el).gridTemplateColumns.split(' ').filter((track) => /^[\d.]+px$/.test(track)).length;
      if (tracks) setCols(tracks);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [probe]);
  return wide ? Math.max(2, Math.min(LEAD_MAX, cols - 1)) : 1;
}

/** A row of the public directory (GET /api/public/apps) as the card draws it. */
export function communityFromDirectory(app: {
  slug: string; name: string; icon_url?: string | null; icon_emoji?: string | null; icon_color?: string | null;
  illustration_url?: string | null; illustration_dark_url?: string | null; member_count?: number;
  description?: string | null; active_users?: number; merged_week?: number;
  plays?: number; hearts?: number; category?: string | null;
}): CardCommunity {
  return {
    slug: app.slug,
    name: app.name,
    iconUrl: app.icon_url,
    iconEmoji: app.icon_emoji,
    iconColor: app.icon_color,
    pictureUrl: app.illustration_url,
    pictureDarkUrl: app.illustration_dark_url,
    members: app.member_count,
    description: app.description,
    activeWeek: app.active_users,
    liveWeek: app.merged_week,
    plays: app.plays,
    hearts: app.hearts,
    played: app.category === 'games',
  };
}
