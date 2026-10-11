/**
 * #4666: WHO CAN CHANGE IT, AS YOU MAKE A PROJECT.
 *
 * A new project starts on You or the group (src/services/create-options.js),
 * and while it is just its maker every preset behaves the same, so making a
 * project asks nothing: it says the rule in one line under the description
 * and the name (features/first-session/make.tsx), with Change,
 *
 *   "Who can change it: You or the group"   Change
 *
 * and Change opens the four presets alone, with how each plays out, and the
 * reminder that it can be changed later on the project's page. A pick is
 * only the screen's until Make it sends it as the new project's own
 * `governance` block, so nothing is proposed. The invite sheet that follows
 * says nothing about it (owner, 11 Oct 2026: said once, where the project is
 * made); afterwards it is the Who can see & change it sheet's.
 *
 * The presets sheet is drawn through a portal on <body>: the make screen's
 * form rises on a transform, which would trap a fixed overlay inside it.
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import { Button } from '@/components/ui/button';
import { SectionHeader } from '@/components/ui/grouped-list';
import { ShieldCheckIcon, XIcon } from '@/components/ui/icons';

import { RichMessage, useMessages } from '../../lib/i18n/react';
import { t as translate } from '../../lib/i18n/runtime';
import { presetName, type PresetKey } from './model';
import { PlaysOut, PresetTiles, type Viewer } from './parts';

function PresetsSheet({ now, viewer, onPick, onClose }: {
  now: PresetKey;
  viewer: Viewer;
  onPick: (key: PresetKey) => void;
  onClose: () => void;
}) {
  const t = useMessages('onboarding');
  const [picked, setPicked] = useState<PresetKey>(now);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const r = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(r);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  const changed = picked !== now;
  return (
    <div className="fixed inset-0 z-[9002]" data-make-rule-sheet="">
      <div aria-hidden="true" onClick={onClose}
        className={`absolute inset-0 bg-[color:var(--pane-scrim)] transition-opacity duration-200 ${shown ? 'opacity-100' : 'opacity-0'}`} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="make-rule-sheet-title"
        className={`absolute inset-x-0 bottom-0 mx-auto max-h-[92%] max-w-lg overflow-y-auto rounded-t-[20px] bg-[color:var(--dc-sheet-solid)] px-4 pb-[max(2rem,env(safe-area-inset-bottom))] pt-2 text-left transition-transform duration-200 ease-out ${shown ? 'translate-y-0' : 'translate-y-full'}`}
      >
        <div className="mx-auto h-1.5 w-10 rounded-full bg-zinc-300 dark:bg-zinc-700" aria-hidden="true" />
        <div className="mt-3 flex items-center gap-3">
          <h2 id="make-rule-sheet-title" className="min-w-0 flex-1 text-[17px] font-semibold">{t('onboarding:firstSession.make.rule.title')}</h2>
          <button type="button" onClick={onClose} aria-label={t('onboarding:firstSession.make.rule.close')}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
            <XIcon className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <p className="mt-1 text-[14px] text-zinc-500 dark:text-zinc-400">{t('onboarding:firstSession.make.rule.intro')}</p>
        <div className="mt-4">
          <PresetTiles picked={picked} now={now} viewer={viewer} onPick={setPicked} labelId="make-rule-sheet-title" />
        </div>
        <SectionHeader className="px-1 pb-1.5 pt-4">{t('onboarding:firstSession.make.rule.plays')}</SectionHeader>
        <PlaysOut preset={picked} viewer={viewer} />
        <Button type="button" layout="full" variant="pillAccent" size="pillLg" ink="solidLate" className="mt-4 flex items-center justify-center"
          data-make-rule-done=""
          onClick={() => (changed ? onPick(picked) : onClose())}>
          {changed ? t('onboarding:firstSession.make.rule.use', { preset: presetName(picked, viewer) }) : t('onboarding:firstSession.make.rule.done')}
        </Button>
      </div>
    </div>
  );
}

/**
 * The Make it step's line, under the description and the name: who can
 * change the project it is about to make, and Change. `preset` is the
 * screen's own pick (You or the group until another is chosen); `who` is the
 * maker, who is its creator once it is made.
 */
export function MakeRuleLine({ preset, onPick, who }: { preset: PresetKey; onPick: (key: PresetKey) => void; who: string }) {
  const t = useMessages('onboarding');
  const [open, setOpen] = useState(false);
  const viewer: Viewer = { isCreator: true, creator: who || null, other: translate('dialogs:whoDecides.someone') };
  return (
    <>
      <p data-make-rule={preset} className="mt-3 flex items-center gap-2 px-1 text-[13px] leading-[1.4] text-zinc-600 dark:text-zinc-300">
        <ShieldCheckIcon className="h-4 w-4 shrink-0 text-zinc-500 dark:text-zinc-400" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">
          <RichMessage
            id="onboarding:firstSession.make.rule.line"
            values={{ preset: presetName(preset, viewer) }}
            components={[<b className="font-semibold text-zinc-900 dark:text-zinc-100" />]}
          />
        </span>
        <button type="button" onClick={() => setOpen(true)} data-make-rule-change=""
          className="shrink-0 font-semibold text-violet-700 dark:text-violet-400">
          {t('onboarding:firstSession.make.rule.change')}
        </button>
      </p>
      {open && typeof document !== 'undefined'
        ? createPortal(
          <PresetsSheet now={preset} viewer={viewer} onPick={(key) => { onPick(key); setOpen(false); }} onClose={() => setOpen(false)} />,
          document.body,
        )
        : null}
    </>
  );
}
