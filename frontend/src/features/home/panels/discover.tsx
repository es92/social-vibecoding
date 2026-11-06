/**
 * The Discover card, drawn now only as the featured-illustration editor's
 * preview (../../apps/featured-illustration-editor.tsx).
 *
 * One Home (#6361) took the Discover lane off Home: its directory is
 * Communities to join (../communities-to-join.tsx), and the lane, its rail and
 * its wiring went with it. The card stays because an illustration is still
 * framed and tinted against it: the art box, the tint, the name, the sentence
 * and the builders line, in the shape the lane drew them.
 */

import { type KeyboardEvent, useState } from 'react';

import { CheckIcon, PlusWideIcon } from '@/components/ui/icons';

import { clampFrame } from '../../../lib/illustration-framing';

import type { IconView } from '../grid-store';
import { useMessages } from '../../../lib/i18n/react';
import type { DiscoverTileView } from '../panels-store';
import { cardTint } from './ui';

function home(): any {
  return (typeof window !== 'undefined' ? (window as any).Home : null) || null;
}

/**
 * The card's art block. An uploaded image FILLS it — that is the one case
 * that looks like the design's own artwork — while an emoji or an initial is
 * a glyph centred on the tint, which is the honest rendering of "this app has
 * no art yet" and still gives the card its colour.
 */
function CardArt({ icon }: { icon: IconView }) {
  if (icon.kind === 'image') {
    return (
      <img
        src={icon.src}
        alt=""
        loading="lazy"
        draggable={false}
        className="home-discover-art-img"
      />
    );
  }
  if (icon.kind === 'emoji') {
    return <span className="home-discover-art-emoji" aria-hidden="true">{icon.emoji}</span>;
  }
  return <span className="home-discover-art-letter" aria-hidden="true">{icon.letter}</span>;
}

/**
 * One discovery card.
 *
 * `.app-card` and `data-slug` are the contract with `_wireDiscoveryCards` and
 * with dapp.json's own Discover check, so they stay whatever the card looks
 * like. `home-discover-tile` does NOT stay: it named a 40px tile in a grid,
 * the CSS that sized it is retired with the grid, and a class that says
 * "tile" on a 180px card is a name the next reader has to disbelieve.
 *
 * The blurb and the contributor line are both CONDITIONAL. Most apps declare
 * no description (there is no such column on `apps` — it comes off the
 * manifest snapshot, see HomePanels.appBlurb), and a card with nothing to say
 * says nothing rather than padding itself with filler. The name and the art
 * are the floor.
 */
function IllustrationArt({ tile }: { tile: DiscoverTileView }) {
  const [failed, setFailed] = useState(false);
  const [darkFailed, setDarkFailed] = useState(false);
  const art = tile.illustration;
  if (!art || failed) return <CardArt icon={tile.icon} />;
  // Re-clamped on render, not trusted as stored: the art `cover`s the block,
  // so a zoom under 1 or an offset past the cover limit would open a gutter
  // of tint along one edge. The editor cannot produce one; the API's framing
  // range is wider than the editor's, so the card does not assume it.
  const frame = clampFrame(art);
  const style = { transform: `translate(${frame.x}%, ${frame.y}%) scale(${frame.zoom})` };
  const hasDark = !!art.darkUrl && !darkFailed;
  return <>
    <img src={art.url} alt="" draggable={false}
      className={`home-discover-illustration ${hasDark ? 'illustration-light' : ''}`}
      onError={() => setFailed(true)} style={style} />
    {hasDark ? <img src={art.darkUrl!} alt="" draggable={false}
      className="home-discover-illustration illustration-dark"
      onError={() => setDarkFailed(true)} style={style} /> : null}
  </>;
}

/**
 * Enter/Space on a focused card press it like a tap. The press is a real
 * `click()` on the card, so it goes through the ONE activation path
 * `Home._wireDiscoveryCards` binds (NavLink.wireModified) with every guard it
 * already has: a demo tile or an app that is not running stays inert, and
 * the detail page is where it lands. React only decides WHEN; Home still
 * owns WHAT a press does. A key aimed at the card's own ⊕ or ⋯ button bubbles
 * here too, and is that button's, not the card's — hence the target check.
 */
export function activateOnKey(e: KeyboardEvent<HTMLDivElement>) {
  if (e.defaultPrevented || e.target !== e.currentTarget) return;
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    e.currentTarget.click();
  }
}

export function DiscoverCard({ tile, preview = false, previewTheme }: { tile: DiscoverTileView; preview?: boolean; previewTheme?: 'light' | 'dark' }) {
  // The corner control is one pill with three jobs, picked by what the viewer
  // already is: neither joined nor pinned, it is the real join; a member
  // already, it is either the quiet "Joined" (and a tap asks the leave
  // confirm) or a plain pin to My apps for the member whose community is not
  // on Home yet. data-added stays stamped either way — the shot state and
  // the checks read it — but the pill's own state machine is data-join.
  const join = !tile.joined ? 'join' : tile.added ? 'joined' : 'add';
  const t = useMessages('home');
  return (
    <div
      // The tint saved with the illustration when its author picked one, and
      // the hash of the slug when they did not — see `cardTint`. Both branches
      // are pure functions of props, so the prerender and the client agree.
      className={`app-card home-discover-card ${cardTint(tile.slug, tile.illustration?.tint)} relative flex flex-col cursor-pointer`}
      data-preview-theme={preview ? previewTheme : undefined}
      data-slug={tile.slug}
      data-status={tile.status}
      {...(tile.demo ? { 'data-demo': 'true' } : null)}
      // A card that opens something IS a button (#1918, #2988). Everything
      // here comes AFTER `data-slug`: tests read the card's open tag as
      // `class="…" data-slug=…`. The preview in the illustration editor is a
      // picture of a card, not a card, so it stays out of the tab order.
      {...(preview ? null : {
        role: 'button',
        tabIndex: 0,
        'aria-label': tile.name,
        onKeyDown: activateOnKey,
      })}
    >
      <div className="home-discover-art relative">
        <IllustrationArt key={`${tile.illustration?.url}:${tile.illustration?.darkUrl}`} tile={tile} />
        <button
          type="button"
          disabled={preview}
          tabIndex={preview ? -1 : undefined}
          className={`card-add-btn absolute top-1.5 end-1.5 inline-flex items-center gap-1 h-7 px-2.5 rounded-full border shadow-sm transition-colors un-touch-target ${
            join === 'joined'
              ? 'bg-white dark:bg-zinc-800 border-transparent text-zinc-600 dark:text-zinc-300'
              : 'bg-white dark:bg-zinc-800 border-zinc-200 dark:border-zinc-600 text-violet-700 dark:text-violet-400 hover:border-violet-400'
          }`}
          data-slug={tile.slug}
          data-added={String(tile.added)}
          data-join={join}
          aria-pressed={join === 'joined'}
          title={join === 'join'
            ? t('home:discover.card.joinTip')
            : join === 'joined'
              ? t('home:discover.card.joinedTip')
              : t('home:discover.card.addTip')}
          aria-label={join === 'join'
            ? t('home:discover.card.joinNamed', { app: tile.name })
            : join === 'joined'
              ? t('home:discover.card.joinedNamed', { app: tile.name })
              : t('home:discover.card.addNamed', { app: tile.name })}
        >
          {join === 'joined'
            ? <CheckIcon className="w-3.5 h-3.5 shrink-0" strokeWidth="3" aria-hidden="true" />
            : <PlusWideIcon className="w-3.5 h-3.5 shrink-0" strokeWidth="3" aria-hidden="true" />}
          <span aria-hidden="true">
            {join === 'join'
              ? t('home:discover.card.join')
              : join === 'joined'
                ? t('home:discover.card.joined')
                : t('home:discover.card.add')}
          </span>
        </button>
      </div>
      <div className="flex flex-col gap-0.5 px-2.5 pt-2 pb-2.5">
        {/*
            UP TO TWO LINES, then "…". The single line this name carried was
            for a 55px grid track, and its `truncate whitespace-nowrap` still
            cut long community names mid-word on a 180px card ("Community
            Tier …"). The clamp in `.home-discover-name` gives a long name a
            second line before it gives up, and `overflow-wrap: anywhere`
            keeps a run-without-spaces name from overflowing the card.
        */}
        <span className="home-discover-name text-[15px] font-semibold leading-tight text-zinc-900 dark:text-zinc-100">
          {tile.name}
        </span>
        {tile.blurb ? (
          <span className="home-discover-blurb text-[12px] leading-snug text-zinc-600 dark:text-zinc-400">
            {tile.blurb}
          </span>
        ) : tile.meta ? (
          <span className="home-discover-facts truncate text-[12px] leading-snug text-zinc-600 dark:text-zinc-400">
            {tile.meta}
          </span>
        ) : null}
        {/* zinc-600, the blurb's ink (QA 2026-09-24 Q20): zinc-500 is under
            4.5:1 on two of the five pastel tints (4.39 and 4.36). */}
        {tile.contributors ? (
          <span className="home-discover-meta pt-0.5 text-[12px] leading-none text-zinc-600 dark:text-zinc-400">
            {t('home:discover.card.contributors', { count: tile.contributors })}
          </span>
        ) : null}
      </div>
    </div>
  );
}

