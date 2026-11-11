import { SectionHeading, StatusLine } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import { useMessages } from '../../../lib/i18n/react';
import { shippedLanguages } from '../../../lib/i18n/runtime';

/**
 * The language preference: one per-user BCP-47 locale, "" (Auto) = unset
 * (NULL in the DB). It is the language Homeroom's own screens use, among the
 * languages that ship (lib/i18n), and the default apps read through the iframe
 * JWT `locale` claim and the bridge's usernode.getUserLocale() (issue #757).
 * settings.js saves on change, through the language runtime, which also pushes
 * `usernode:locale-changed` into any open app iframe.
 *
 * The choices are Auto and the languages this build's catalogs ship (English
 * alone when none is committed), then the ones the server's translation cache
 * covers well enough (GET /api/languages, `minimumCoverage` in
 * frontend/locales/config.json), which Settings._appendLiveLanguages adds once
 * they arrive. A locale saved when this picker listed more, or through the
 * API, is added as an option by Settings._renderLanguageSection, so it stays
 * visible and changeable rather than reading as "Auto". The intro says so
 * (#6511): it once said Homeroom's screens were English only.
 *
 * #settings-locale is a dapp.json anchor and settings.js reads/writes its
 * `.value`, so it stays a native `<select>` — see @/components/ui/select.
 *
 * Offered to everyone. #1556 had hidden it from anyone without a saved locale,
 * because a "Language" row that could not change the screen read as a broken
 * switch; the text below now says what it does. #settings-language-section is
 * kept as the id the baseline and settings.js know.
 *
 * This pane holds no state, so React never reconciles the option settings.js
 * adds away from under it.
 */
export function LanguageSection() {
  // Subscribed, although settings.js adds an option here for a saved language
  // that no longer ships: a new language changes only this pane's own text
  // nodes, and React leaves a node it did not create where it is.
  const t = useMessages('settings');
  return (
    <div data-settings-section="language" className="hidden">
      <div id="settings-language-section">
        <SectionHeading title={t('settings:language.title')}>
          {t('settings:language.intro')}
        </SectionHeading>
        <Select id="settings-locale" variant="plain">
          <option value="">
            {t('settings:language.auto')}
          </option>
          {shippedLanguages.map(({ tag, name }) => (
            <option key={tag} value={tag}>
              {name}
            </option>
          ))}
        </Select>
        <StatusLine id="settings-locale-status" size="xs" />
      </div>
    </div>
  );
}
