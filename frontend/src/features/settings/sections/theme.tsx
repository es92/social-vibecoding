/**
 * Settings → Theme: Light / Dark / System.
 *
 * THE UI OVERHAUL moved this out of the hamburger drawer, where it had been
 * the first row. The drawer is navigation plus notifications now; a live
 * control that changes how the whole product looks is a SETTING, and it is the
 * first one — the section a bare #settings resolves to (Settings
 * .DEFAULT_SECTION), because it is the setting most people come looking for
 * and the only one that needs no explanation.
 *
 * ── What did NOT move ─────────────────────────────────────────────────
 *
 * The persistence. All of it still lives in the inline `window.Theme` block at
 * the top of frontend/src/head.html — head-blocking, so the stored mode is
 * applied before first paint. This component reads and writes through that
 * global and owns nothing but the highlight.
 *
 * The track's id is unchanged too (#drawer-theme-track) and so are the class
 * strings, because `app.css` keys the segmented track off exactly those.
 * Renaming it to match the new home would have been a restyle of the one
 * control the overhaul is not changing the look of. The sliding caret that
 * sat under the chosen segment (#drawer-theme-caret-track,
 * #drawer-theme-caret) is gone: overnight UI audit D10, the owner's decision
 * of 2 Nov 2026. The lit segment says which one is chosen.
 *
 * ── Unlike every other section here, this one is STATEFUL ─────────────
 *
 * ./index.tsx's header explains why the panes are static: settings.js binds
 * every control by id, once, and a React re-render of a pane would silently
 * stop those listeners firing. Nothing in settings.js binds anything inside
 * this track — the segments' onClick is React's — so it is the one pane that
 * may hold state, and it needs to: the active segment is derived from
 * `Theme.get()`, which is only readable on the client.
 */

import { useCallback, useState } from 'react';

import { SectionHeading } from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';

import { useMessages } from '../../../lib/i18n/react';
import { useIsomorphicLayoutEffect, useWindowEvent } from '../../../lib/legacy-dom';

// Order of the three segments in the DOM.
const THEME_MODES = ['light', 'dark', 'system'] as const;
type ThemeMode = (typeof THEME_MODES)[number];

const THEME_SEG_CLASS =
  'theme-seg flex-1 basis-0 rounded-md px-1.5 py-1 transition-colors';

const THEME_LABELS: Record<ThemeMode, string> = {
  light: 'settings:theme.mode.light',
  dark: 'settings:theme.mode.dark',
  system: 'settings:theme.mode.system',
};

/**
 * The Light / Dark / System segmented control — App.HeaderMenu's
 * _renderThemeButtons(), as state.
 *
 * `mode` starts null, which renders EXACTLY the markup the hand-written shell
 * shipped: no `theme-seg-active` and `aria-checked="false"` on all three.
 * Theme.get() is only readable on the
 * client (the inline head block owns it), so reading it during render would
 * mismatch the prerender; the layout effect below fills it in on the first
 * client pass instead.
 *
 * Three things re-read the mode: a click on a segment, Theme.onChange
 * (another tab, the OS sunset switch), and every entry into this section
 * (`usernode:settings-section`, dispatched by settings.js where the drawer's
 * `usernode:header-menu-open` used to be). The last one covers a value that
 * changed while the viewer was elsewhere in Settings.
 */
function ThemeControl() {
  const t = useMessages('settings');
  const [mode, setMode] = useState<ThemeMode | null>(null);

  const sync = useCallback(() => {
    const current = window.Theme?.get?.();
    setMode(
      THEME_MODES.includes(current as ThemeMode) ? (current as ThemeMode) : null,
    );
  }, []);

  useIsomorphicLayoutEffect(() => {
    sync();
    // Storage/OS-driven changes (other tab, OS sunset switch) re-highlight too.
    window.Theme?.onChange?.(sync);
  }, [sync]);

  // Reflect the current mode on every entry into this section — covers
  // cross-tab changes and explicit values that happen to match the OS.
  useWindowEvent('usernode:settings-section', sync);

  // Sets the mode and re-highlights in place, so the viewer can see the
  // recolor and switch again without leaving the section.
  const choose = useCallback(
    (next: ThemeMode) => {
      window.Theme?.set?.(next);
      sync();
    },
    [sync],
  );

  return (
    <div
      id="drawer-theme-track"
      role="radiogroup"
      aria-label={t('settings:theme.controlName')}
      className="relative flex p-0.5 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-xs font-medium"
    >
      {THEME_MODES.map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={mode === m ? 'true' : 'false'}
          data-theme-mode={m}
          className={mode === m ? `${THEME_SEG_CLASS} theme-seg-active` : THEME_SEG_CLASS}
          onClick={() => choose(m)}
        >
          {t(THEME_LABELS[m])}
        </button>
      ))}
    </div>
  );
}

// The key App._railPinned reads (public/js/app.js). Read here too so the
// switch can show the stored value before App exists, and written through
// App.setRailPinned so the router re-decides at once. ON unless '0' is
// stored: nothing stored is the default, and a '1' from when this was
// opt-in still reads as on.
export const RAIL_PINNED_KEY = 'usernode:rail-pinned';

function readRailPinned(): boolean {
  try {
    return window.localStorage.getItem(RAIL_PINNED_KEY) !== '0';
  } catch {
    return true;
  }
}

export function writeRailPinned(on: boolean): void {
  if (window.App?.setRailPinned) {
    window.App.setRailPinned(on);
    return;
  }
  try {
    if (on) window.localStorage.removeItem(RAIL_PINNED_KEY);
    else window.localStorage.setItem(RAIL_PINNED_KEY, '0');
  } catch { /* unwritable storage: the switch does not stick */ }
}

/**
 * "Keep sidebar open in apps" (#3319) — the desktop rail stays docked beside
 * a running app, with the sidebar toggle where the app's ✕ was. ON by
 * default; off gives the app the whole window and its ✕ back.
 *
 * DESKTOP ONLY, and the class string says so (`hidden md:block`): below
 * 768px the bar is the phone's bottom bar, which an app always covers.
 *
 * `pinned` starts true, which is the prerender (a checked switch, the
 * default), and the stored value arrives in an effect — localStorage is
 * client-only, and reading it during render would be a hydration mismatch
 * for anyone who had turned it off. Re-read on every entry into this
 * section, like the theme.
 */
function RailPinnedRow() {
  const t = useMessages('settings');
  const [pinned, setPinned] = useState(true);
  const sync = useCallback(() => setPinned(readRailPinned()), []);
  useIsomorphicLayoutEffect(() => { sync(); }, [sync]);
  useWindowEvent('usernode:settings-section', sync);

  return (
    <div className="hidden md:block mt-6 pt-6 border-t border-zinc-200 dark:border-zinc-800">
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <Switch
          id="settings-rail-pinned"
          checked={pinned}
          onChange={(e) => {
            const next = e.currentTarget.checked;
            writeRailPinned(next);
            setPinned(next);
          }}
        />
        <span className="text-sm text-zinc-800 dark:text-zinc-200">
          {t('settings:theme.railPinned.label')}
        </span>
      </label>
      <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-2 leading-relaxed">
        {t('settings:theme.railPinned.description')}
      </p>
    </div>
  );
}

export function ThemeSection() {
  const t = useMessages('settings');
  return (
    <div data-settings-section="theme" className="hidden">
      <div id="settings-theme-section">
        <SectionHeading title={t('settings:theme.title')}>
          {t('settings:theme.intro')}
        </SectionHeading>
        <div className="max-w-xs">
          <ThemeControl />
        </div>
        <RailPinnedRow />
      </div>
    </div>
  );
}
