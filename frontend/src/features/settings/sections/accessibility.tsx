/**
 * Settings → Accessibility: text size and high contrast (#3969), and
 * whether project cards play their animated previews.
 *
 * A page of one part, right after Appearance in Preferences, so the two
 * reading controls are visible without opening Appearance first. It follows
 * ./theme.tsx in every particular that matters there:
 *
 *  - The persistence lives in the inline `window.Display` block at the top
 *    of frontend/src/head.html — head-blocking, so the stored size and the
 *    contrast attribute land on <html> before first paint. This component
 *    reads and writes through that global and owns nothing but the
 *    highlight.
 *  - It is the second STATEFUL pane (with Theme): nothing in ../settings.js
 *    binds inside it, the segments' onClick and the switch's onChange are
 *    React's, and the active state is derived from storage, which is only
 *    readable on the client.
 *  - The initial render carries no selection: `size` starts null and the
 *    switch starts off, which is exactly the markup the prerender ships.
 *    Reading storage during render would mismatch the prerendered document.
 *  - The segmented track reuses the .theme-seg class strings — app.css keys
 *    the recessed-track / raised-face look off the class, not the track id —
 *    and drops the caret (`--theme-caret-index` belongs to the one control
 *    that has it). No new components, no new colours.
 */

import { useCallback, useState } from 'react';

import { SectionHeading } from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';

import { onPreviewsPref, previewsOn, setPreviewsOn } from '../../../lib/card-previews';
import { useMessages } from '../../../lib/i18n/react';
import { useIsomorphicLayoutEffect, useWindowEvent } from '../../../lib/legacy-dom';
import { radioGroupKeys } from '../../../lib/radio-group';

// Order of the three segments in the DOM, also the storage contract:
// Normal removes the key; Large and Larger store their value.
const TEXT_SIZES = ['normal', 'large', 'larger'] as const;
type TextSize = (typeof TEXT_SIZES)[number];

const SIZE_SEG_CLASS =
  'theme-seg flex-1 basis-0 rounded-md px-1.5 py-1 transition-colors';

const SIZE_LABELS: Record<TextSize, string> = {
  normal: 'settings:accessibility.textSize.normal',
  large: 'settings:accessibility.textSize.large',
  larger: 'settings:accessibility.textSize.larger',
};

/**
 * The Normal / Large / Larger segmented control. Three things re-read the
 * size, like the theme's: a click, Display.onChange (another tab, the
 * storage event), and every entry into this section
 * (`usernode:settings-section`).
 */
function TextSizeControl() {
  const t = useMessages('settings');
  const [size, setSize] = useState<TextSize | null>(null);

  const sync = useCallback(() => {
    const current = window.Display?.getTextSize?.();
    setSize(
      TEXT_SIZES.includes(current as TextSize) ? (current as TextSize) : null,
    );
  }, []);

  useIsomorphicLayoutEffect(() => {
    sync();
    window.Display?.onChange?.(sync);
  }, [sync]);

  useWindowEvent('usernode:settings-section', sync);

  const choose = useCallback(
    (next: TextSize) => {
      window.Display?.setTextSize?.(next);
      sync();
    },
    [sync],
  );
  // One tab stop, and the arrow keys move the pick (#6510).
  const keys = radioGroupKeys(TEXT_SIZES, size, choose);

  return (
    <div
      id="settings-text-size-track"
      role="radiogroup"
      aria-label={t('settings:accessibility.textSize.controlName')}
      onKeyDown={keys.onKeyDown}
      className="relative flex p-0.5 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-xs font-medium"
    >
      {TEXT_SIZES.map((s) => (
        <button
          key={s}
          type="button"
          role="radio"
          aria-checked={size === s ? 'true' : 'false'}
          tabIndex={keys.tabIndex(s)}
          data-text-size-option={s}
          className={size === s ? `${SIZE_SEG_CLASS} theme-seg-active` : SIZE_SEG_CLASS}
          onClick={() => choose(s)}
        >
          {t(SIZE_LABELS[s])}
        </button>
      ))}
    </div>
  );
}

/**
 * The High contrast switch — the same switch-with-explanation row as
 * "Keep sidebar open in apps", minus the desktop-only class: contrast
 * matters at every width. It does not follow the device's own
 * "increase contrast" setting; it is off until turned on.
 */
function HighContrastRow() {
  const t = useMessages('settings');
  const [on, setOn] = useState(false);

  const sync = useCallback(() => setOn(!!window.Display?.getContrast?.()), []);

  useIsomorphicLayoutEffect(() => {
    sync();
    window.Display?.onChange?.(sync);
  }, [sync]);

  useWindowEvent('usernode:settings-section', sync);

  return (
    <div className="mt-6 pt-6 border-t border-zinc-200 dark:border-zinc-800">
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <Switch
          id="settings-high-contrast"
          checked={on}
          onChange={(e) => {
            const next = e.currentTarget.checked;
            window.Display?.setContrast?.(next);
            setOn(next);
          }}
        />
        <span className="text-sm text-zinc-800 dark:text-zinc-200">
          {t('settings:accessibility.contrast.label')}
        </span>
      </label>
      <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-2 leading-relaxed">
        {t('settings:accessibility.contrast.description')}
      </p>
    </div>
  );
}

/**
 * "Play previews": a project card's short, silent loop plays when you point
 * at the card, or on a phone for the card you stop on
 * (../../../lib/card-previews.ts). On by default, kept on this device, and
 * never playing anyway under reduced motion or Data Saver. Like the switch
 * above it, the first render is off and storage is read in an effect, so the
 * prerendered markup matches.
 */
function CardPreviewsRow() {
  const t = useMessages('settings');
  const [on, setOn] = useState(false);

  const sync = useCallback(() => setOn(previewsOn()), []);

  useIsomorphicLayoutEffect(() => {
    sync();
    return onPreviewsPref(sync);
  }, [sync]);

  useWindowEvent('usernode:settings-section', sync);

  return (
    <div className="mt-6 pt-6 border-t border-zinc-200 dark:border-zinc-800">
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <Switch
          id="settings-card-previews"
          checked={on}
          onChange={(e) => {
            const next = e.currentTarget.checked;
            setPreviewsOn(next);
            setOn(next);
          }}
        />
        <span className="text-sm text-zinc-800 dark:text-zinc-200">
          {t('settings:accessibility.previews.label')}
        </span>
      </label>
      <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-2 leading-relaxed">
        {t('settings:accessibility.previews.description')}
      </p>
    </div>
  );
}

export function AccessibilitySection() {
  const t = useMessages('settings');
  return (
    <div data-settings-section="accessibility" className="hidden">
      <div id="settings-accessibility-section">
        <SectionHeading title={t('settings:accessibility.textSize.title')}>
          {t('settings:accessibility.textSize.intro')}
        </SectionHeading>
        <div className="max-w-xs">
          <TextSizeControl />
        </div>
        <HighContrastRow />
        <CardPreviewsRow />
      </div>
    </div>
  );
}
