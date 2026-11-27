import { Button } from '@/components/ui/button';
import { SectionHeading, StatusLine } from '@/components/ui/field';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';

import { useMessages } from '../../../lib/i18n/react';
import { pressButton, returnKeyHandler } from '../../../lib/return-to-next';

/**
 * The account's OpenRouter key, which voice input transcribes with. The
 * heading and description are ALSO written at runtime by settings.js
 * `_normalizeOpenRouterCopy()`, so the text here must be that text word for
 * word: #3296's first cut edited only this copy, and the page never showed
 * it. tests/openrouter-harness.test.js holds the two equal. #2568: every
 * account is created with its included company key, so there is nothing to
 * claim and no identity to prove first — #settings-openrouter-included is a
 * STATUS line, not a card with a button. Everyone may still use a personal
 * OpenRouter key instead.
 *
 * Return (#3907: the iOS keyboard's chevrons are gone): in the personal key
 * it runs Test & save, the key's own button.
 */
function saveKey(): void {
  pressButton(document.getElementById('settings-openrouter-save'));
}

export function OpenRouterSection() {
  // Subscribed: settings.js rewrites the heading and the description with
  // the same two messages, and swaps the save button's text from state.
  // React patches only text nodes it still owns, so a new language reaches
  // the rest here and those through settings.js.
  const t = useMessages('settings');
  return (
    <div data-settings-section="openrouter" className="hidden">
      <SectionHeading title={<>OpenRouter</>}>
        {t('settings:openrouter.intro')}
      </SectionHeading>
      {/* One neutral wrapper (looks v2, s61), nothing in the standard look:
          under a look the included key and the personal key are one card,
          each inside it without a card of its own (app.css, SETTINGS). Every
          node inside keeps its id, its place among its siblings and the
          `hidden` settings.js toggles on it. */}
      <div className="ui-card ui-onecard">
      <div id="settings-openrouter-included" className="ui-card ui-pad hidden rounded-lg border border-violet-200 dark:border-violet-900 bg-violet-50 dark:bg-violet-950/30 px-3 py-3 mb-3">
        <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{t('settings:openrouter.included.title')}</div>
        <div id="settings-openrouter-included-status" className="mt-1 text-xs text-zinc-600 dark:text-zinc-400"></div>
      </div>
      <div id="settings-openrouter-key-display" className="ui-card ui-pad hidden rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm font-mono text-zinc-700 dark:text-zinc-300 mb-2">
        sk-or-&hellip;<span id="settings-openrouter-key-last4"></span>
      </div>
      <div id="settings-openrouter-key-info" className="ui-card ui-pad hidden rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-xs mb-2 text-zinc-600 dark:text-zinc-400"></div>
      <div id="settings-openrouter-personal-controls" onKeyDown={returnKeyHandler({ submit: saveKey })}>
        <Label className="px-1 pb-1 text-[15px] font-normal text-zinc-500 dark:text-zinc-500" htmlFor="settings-openrouter-key">
          {t('settings:openrouter.personalKey.label')}
        </Label>
        <div className="ui-card ui-keyrow rounded-2xl bg-white dark:bg-zinc-900 overflow-hidden">
          <div className="px-4 py-3 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-zinc-200 dark:[&:not(:last-child)]:border-zinc-800">
            {/* A field in a flex row beside its button: the width is on the wrapper. */}
            <PasswordInput id="settings-openrouter-key" placeholder="sk-or-..." autoComplete="off" spellCheck={false} enterKeyHint="done" wrapperClassName="flex-1 min-w-0" className="font-mono" box="card" ring="bare" hint="dim" />
          </div>
          <div className="flex gap-2 px-4 py-3">
            <Button id="settings-openrouter-save" layout="shrink" variant="pillAccent" size="pill" className="ui-btn-sm">
              {t('settings:openrouter.personalKey.testAndSave')}
            </Button>
            <Button id="settings-openrouter-remove" layout="hiddenShrink" variant="pillDanger" size="pill" ink="dangerTint" className="ui-btn-sm">
              {t('settings:openrouter.personalKey.remove')}
            </Button>
          </div>
        </div>
      </div>
      </div>
      <StatusLine id="settings-openrouter-status" spacing={3} />
    </div>
  );
}
