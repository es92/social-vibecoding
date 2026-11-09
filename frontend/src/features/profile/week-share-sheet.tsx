/**
 * `#profile-week-share-sheet` — "Share your week", opened from the This week
 * card on your own profile (#6464).
 *
 * The card shows the week; this card shares it. Every figure the week has is
 * a switch, the preview is the exact words that leave, and the two actions
 * are the device's own share menu and a clipboard copy. Sharing awards
 * nothing: no points, no counter, no limit, and nothing is written anywhere.
 * Which figures are ticked is local to this card and is not saved.
 *
 * The same presentation as ./app-slots-sheet.tsx, for the same reasons:
 * rendered inside #profile-root while `weekShareOpen` is set, and handed to
 * the native kit's MODAL by lib/kit-surface.ts. With no kit the card simply
 * stays where React put it, at the top of the screen. The root and card class
 * strings are constants (the kit writes onto them), and the card is brought
 * home in the layout-effect cleanup, before React removes it.
 */

import { useRef, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useMessages } from '../../lib/i18n/react';
import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { adoptKitSurface, type KitAdoption } from '../../lib/kit-surface';
import { Profile } from './profile.js';
import { shareText } from './profile-store.js';

/** The no-kit card chrome, on the node the kit flags. Constant. */
const ROOT_CLASS = 'rounded-2xl bg-white dark:bg-zinc-900 mb-5';

/** The lifted card. Constant. */
const CARD_CLASS = 'flex flex-col px-4 pb-5';

// × as a character: this is text, not HTML source.
const TIMES = '×';

export interface WeekShareItem {
  key: string;
  label: string;
}

export function WeekShareSheet({ items, link }: { items: WeekShareItem[]; link: string | null }): ReactNode {
  const t = useMessages('profile');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Every figure starts on; the choice is this card's alone and is not saved.
  const [selected, setSelected] = useState<string[]>(() => items.map((item) => item.key));
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle');

  // Hand the card to the native kit, exactly once, and put it back before
  // React ever tries to remove it. Same shape as ./app-slots-sheet.tsx.
  useIsomorphicLayoutEffect(() => {
    const contentEl = panelRef.current;
    const flagEl = rootRef.current;
    if (!contentEl || !flagEl) return;
    let adoption: KitAdoption | null = null;
    adoption = adoptKitSurface({
      kind: 'modal',
      contentEl,
      adoptedOn: flagEl,
      home: 'placeholder',
      gate: 'kit',
      onDismiss: () => {
        if (!adoption) return;
        adoption = null;
        Profile._dismissWeekShare();
      },
    });
    return () => {
      if (!adoption) return;
      const handle = adoption;
      adoption = null;
      handle.release();
    };
  }, []);

  const chosen = items.filter((item) => selected.includes(item.key));
  const text = shareText(items, selected, link);
  const nothingChosen = chosen.length === 0;
  // The OS share menu is not on every device; where it is absent, Copy is the
  // only action offered.
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  const toggle = (key: string, on: boolean) => {
    setCopied('idle');
    setSelected((keys) => (on ? [...keys, key] : keys.filter((k) => k !== key)));
  };

  // Both actions run inside the click that asked for them: phones only allow
  // the share sheet and the clipboard from a user gesture.
  const onShare = async () => {
    if (nothingChosen || !canShare) return;
    try {
      // Every line already carries the profile's address, so the share menu
      // is not handed a second one.
      await navigator.share({ text });
    } catch (err) {
      // Closing the share menu is not an error to report.
      if (err && (err as { name?: string }).name === 'AbortError') return;
    }
  };

  const onCopy = async () => {
    if (nothingChosen) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied('done');
    } catch (_) {
      setCopied('failed');
    }
  };

  return (
    <div id="profile-week-share-root" ref={rootRef} className={ROOT_CLASS}>
      <div id="profile-week-share-sheet" ref={panelRef} className={CARD_CLASS}>
        <div className="flex items-center justify-between gap-3 pt-3">
          <h2 className="text-lg font-bold">{t('profile:weekShare.title')}</h2>
          <Button
            id="profile-week-share-close"
            variant="neutral"
            size="sm"
            ink="neutral"
            aria-label={t('profile:weekShare.close')}
            onClick={() => Profile._dismissWeekShare()}
          >
            {TIMES}
          </Button>
        </div>
        <p className="mt-1 text-[13px] text-zinc-500 dark:text-zinc-400">{t('profile:weekShare.note')}</p>
        <div className="mt-3 flex flex-col gap-2.5">
          {items.map((item) => (
            <label key={item.key} className="flex items-center gap-2 cursor-pointer select-none">
              <Switch
                id={`profile-week-share-${item.key}`}
                checked={selected.includes(item.key)}
                onChange={(event) => toggle(item.key, event.target.checked)}
              />
              <span className="text-sm text-zinc-800 dark:text-zinc-200">{item.label}</span>
            </label>
          ))}
        </div>
        <div className="mt-3.5 text-[13px] text-zinc-500 dark:text-zinc-400">{t('profile:weekShare.preview')}</div>
        <div className="mt-1 rounded-2xl bg-[color:var(--dc-sheet-solid)] px-3 py-3 text-sm whitespace-pre-line">
          {text}
        </div>
        <div className="mt-4 flex gap-2">
          {canShare ? (
            <Button
              id="profile-week-share-send"
              variant="default"
              size="sm"
              layout="flex"
              disabled={nothingChosen}
              onClick={() => { void onShare(); }}
            >
              {t('profile:weekShare.share')}
            </Button>
          ) : null}
          <Button
            id="profile-week-share-copy"
            variant="neutral"
            size="sm"
            ink="neutral"
            layout="flex"
            disabled={nothingChosen}
            onClick={() => { void onCopy(); }}
          >
            {t('profile:weekShare.copy')}
          </Button>
        </div>
        {copied === 'done' ? (
          <p className="mt-2 text-[13px] text-emerald-700 dark:text-emerald-400">{t('profile:weekShare.copied')}</p>
        ) : null}
        {copied === 'failed' ? (
          <p className="mt-2 text-[13px] text-red-700 dark:text-red-400">{t('profile:weekShare.copyFailed')}</p>
        ) : null}
      </div>
    </div>
  );
}
