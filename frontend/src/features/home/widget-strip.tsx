/**
 * `#home-widget-strip-section` — the iOS in-app strip above the launcher
 * grid, mirroring the pinned grid the homescreen widget renders.
 *
 * ── What moved and what did not ───────────────────────────────────────
 *
 * The markup is React's; the GESTURE is not. `Home._wireWidgetStrip(el)` still
 * owns the reorder attachment — either the native kit's `attachReorder` (in
 * displacement mode, because the list model's Y-only ghost is degenerate for
 * a one-row tile strip) or the per-tile pointer fallback. Those attach
 * listeners to nodes; they write no markup, so they are not a second writer,
 * and calling them from an effect here is the same split `app-grid.tsx` makes
 * for the canvas.
 *
 * What the conversion does retire is the three button wirings that used to
 * ride along with it — Done, the ⓘ help toggle, and each tile's ✕ — which had
 * to be re-attached on every paint because the paint replaced the nodes they
 * were on. They are props on elements React keeps.
 *
 * `Home._widgetSectionVisible` and `_widgetHelpVisible` stay module state on
 * `Home`, not component state: the strip is repainted by `Home.render()` from
 * a dozen places (a WS app event, a bridge registry refresh, an optimistic
 * remove), and those two flags have to survive every one of them.
 */

import { useEffect, useRef } from 'react';

import { CheckIcon, InfoCircleIcon } from '@/components/ui/icons';

import { useStoreState } from '../../lib/use-store-state';
import { chromeStore, type WidgetStripState, type WidgetTileView } from './chrome-store';
import type { IconView } from './grid-store';

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).Home : null) || null;
}

const HINT_WITH_TILES = 'Drag tiles to reorder. Drag cards from Your apps here to add them.';
const HINT_EMPTY = 'Drag a card from Your apps here (or use its menu) to add it to the '
  + 'Homeroom widget on your home screen.';

function TileIcon({ icon }: { icon: IconView }) {
  if (icon.kind === 'image') {
    return (
      <img
        src={icon.src}
        alt=""
        loading="lazy"
        draggable={false}
        className="w-full h-full rounded-lg object-cover"
      />
    );
  }
  if (icon.kind === 'emoji') {
    return <span className="text-xl leading-none" aria-hidden="true">{icon.emoji}</span>;
  }
  return <>{icon.letter}</>;
}

/**
 * One pinned shortcut. Exported because tests/home-card-icon.test.js renders
 * it directly: the "every tile call site tags its icon kind" rule spans the
 * home card and this tile, and it was executed coverage before the conversion.
 */
export function WidgetTile({ tile }: { tile: WidgetTileView }) {
  return (
    <div
      // touch-pan-y + select-none for the same reason as app cards: keep
      // vertical scroll native until the tile drag actually claims the
      // gesture (see Home._onWidgetTilePointerDown).
      className="widget-tile app-card-draggable touch-pan-y relative flex flex-col items-center gap-1 w-16 cursor-grab"
      data-wid={tile.id}
      data-wslug={tile.slug || undefined}
    >
      <div
        className="app-icon-tile w-10 h-10 rounded-lg overflow-hidden flex items-center justify-center font-bold text-base"
        data-icon={tile.icon.kind}
      >
        <TileIcon icon={tile.icon} />
      </div>
      <span className="text-[0.65rem] leading-tight truncate w-full text-center">{tile.name}</span>
      <button
        type="button"
        className="widget-remove-btn absolute -top-1.5 right-0 w-5 h-5 flex items-center justify-center rounded-full bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-600 shadow-sm text-[0.6rem] text-zinc-500 dark:text-zinc-300 hover:text-red-500"
        data-wid={tile.id}
        title="Remove from widget"
        aria-label={`Remove ${tile.name} from widget`}
        onClick={(e) => {
          e.stopPropagation();
          controller()?._removeWidgetItem?.(tile.id);
        }}
      >
        ✕
      </button>
    </div>
  );
}

/**
 * The strip's CONTENTS, as a pure function of its view model — everything the
 * retired `Home.renderWidgetSection()` returned, and nothing the store or the
 * gesture needs. `null` is what its `return ''` meant.
 *
 * Split out from the store-connected `WidgetStrip` below so the section's
 * rules stay executable coverage: tests/home-card-menu.test.js renders this
 * against a `Home.widgetSectionView()` it built by hand, which is the same
 * pair of calls the browser makes.
 */
export function WidgetStripBody({ strip }: { strip: WidgetStripState }) {
  if (!strip.active) return null;
  return (
    <>
      <div className="home-section-header flex items-center justify-between">
        <span className="flex items-center gap-1.5">
          {'Homeroom widget'}
          <button
            type="button"
            id="widget-section-help"
            className="w-4 h-4 flex items-center justify-center rounded-full text-zinc-500 dark:text-zinc-500 hover:text-violet-500 dark:hover:text-violet-400 transition-colors"
            title="How to add the widget to your home screen"
            aria-label="How to add the widget to your home screen"
            aria-expanded={strip.helpVisible}
            onClick={(e) => {
              e.stopPropagation();
              const home = controller();
              if (!home) return;
              home._widgetHelpVisible = !home._widgetHelpVisible;
              home.render();
            }}
          >
            <InfoCircleIcon className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </span>
        <button
          type="button"
          id="widget-section-close"
          className="flex items-center gap-1 text-xs font-normal normal-case tracking-normal text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors"
          title="Close the widget section"
          aria-label="Close the widget section"
          onClick={(e) => {
            e.stopPropagation();
            const home = controller();
            if (!home) return;
            // "Done" hides the section again. State on the device is
            // untouched — "Add/Edit in Homeroom widget" brings it back.
            home._widgetSectionVisible = false;
            home._widgetHelpVisible = false;
            home.render();
          }}
        >
          {'Done'}
          <CheckIcon className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      </div>
      <div
        id="widget-strip"
        className="flex flex-wrap items-start gap-3 rounded-xl border border-dashed border-zinc-300 dark:border-zinc-600 p-3 transition-colors"
      >
        {strip.helpVisible ? (
          <div
            id="widget-help-panel"
            className="w-full text-[0.7rem] leading-relaxed text-zinc-600 dark:text-zinc-300 rounded-lg bg-violet-500/5 dark:bg-violet-500/10 border border-violet-500/20 px-3 py-2"
          >
            <span className="font-medium">Add the widget to your home screen:</span>
            {' touch and hold an empty area of your iPhone home screen, tap '}
            <span className="font-medium">Edit</span>
            {' → '}
            <span className="font-medium">Add Widget</span>
            {' (or the '}
            <span className="font-medium">+</span>
            {'), search for '}
            <span className="font-medium">Homeroom</span>
            {', pick a size and tap '}
            <span className="font-medium">Add Widget</span>
            {'. The apps below appear on it automatically.'}
          </div>
        ) : null}
        {strip.tiles.map((tile) => <WidgetTile key={tile.id} tile={tile} />)}
        <div
          className={`widget-strip-hint w-full text-[0.7rem] text-zinc-500 dark:text-zinc-400 ${
            strip.tiles.length ? '' : 'py-3 text-center'
          }`}
        >
          {strip.tiles.length ? HINT_WITH_TILES : HINT_EMPTY}
        </div>
      </div>
    </>
  );
}

export function WidgetStrip() {
  const { strip } = useStoreState(chromeStore);
  const sectionRef = useRef<HTMLElement | null>(null);

  // Re-attach the reorder recognizer whenever the tiles it measures change,
  // and detach on unmount so a remount cannot leave two fighting for the same
  // gesture — the same lifecycle app-grid.tsx gives the canvas recognizer.
  useEffect(() => {
    const el = sectionRef.current;
    const home = controller();
    if (!strip.active || !el || !home) return undefined;
    home._wireWidgetStrip?.(el);
    return () => {
      const handle = home._widgetReorderHandle;
      if (handle) { try { handle.detach(); } catch { /* already gone */ } }
      home._widgetReorderHandle = null;
    };
  }, [strip.active, strip.tiles.length, strip.tiles.map((t) => t.id).join(',')]);

  return (
    <section
      ref={sectionRef}
      id="home-widget-strip-section"
      className={strip.active ? 'px-3 pt-2' : 'hidden px-3 pt-2'}
    >
      <WidgetStripBody strip={strip} />
    </section>
  );
}
