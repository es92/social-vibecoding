import { SectionHeading, StatusLine } from '@/components/ui/field';
import { Select } from '@/components/ui/select';

/**
 * Platform-level user language preference (issue #757). A single per-user
 * BCP-47 locale apps read as their default language — via the iframe JWT
 * `locale` claim and the bridge's usernode.getUserLocale(). "" (Auto) = unset
 * (NULL in the DB). Saves on change; settings.js wires the handler to
 * POST /api/me/locale and pushes a live `usernode:locale-changed` notification
 * into any open app iframe.
 *
 * #settings-locale is a dapp.json anchor and settings.js reads/writes its
 * `.value`, so it stays a native `<select>` — see @/components/ui/select.
 *
 * #1556: the section is NOT offered by default any more. The platform shell
 * is English-only, so a "Language" row in Preferences reads as a UI language
 * switch and does nothing visible — the value only ever reached APPS. So
 * #settings-language-section ships `hidden` and is the CAPABILITY GATE
 * Settings._visibleSections() reads back (same arrangement as #wallet-section
 * in ./wallet.tsx): Settings._renderLanguageSection reveals it only for a
 * user who ALREADY has a locale saved, so nobody is stranded with a
 * preference they can no longer change or clear. Every read path (the JWT
 * claim, the bridge, the server consumers) is untouched. To re-launch the
 * picker once the shell is translated, drop the `hidden` here and the gate
 * lines in _renderLanguageSection.
 *
 * The rendered `className` on the gate node is a CONSTANT and this pane holds
 * no state, so React never reconciles it away from under settings.js — the
 * same idiom as #wallet-section.
 */
export function LanguageSection() {
  return (
    <div data-settings-section="language" className="hidden">
      <div id="settings-language-section" className="hidden">
        <SectionHeading title="Language">
          Apps on Homeroom use this as their default language, and may offer their own override.
          Homeroom's own screens are English-only for now, so changing this will not translate
          the platform.
        </SectionHeading>
        <Select id="settings-locale" variant="plain">
          <option value="">
            Auto: use device language
          </option>
          <option value="en">
            English
          </option>
          <option value="es">
            Español
          </option>
          <option value="fr">
            Français
          </option>
          <option value="de">
            Deutsch
          </option>
          <option value="id">
            Bahasa Indonesia
          </option>
          <option value="pt-BR">
            Português (Brasil)
          </option>
          <option value="it">
            Italiano
          </option>
          <option value="nl">
            Nederlands
          </option>
          <option value="pl">
            Polski
          </option>
          <option value="tr">
            Türkçe
          </option>
          <option value="ru">
            Русский
          </option>
          <option value="uk">
            Українська
          </option>
          <option value="ar">
            العربية
          </option>
          <option value="hi">
            हिन्दी
          </option>
          <option value="vi">
            Tiếng Việt
          </option>
          <option value="th">
            ไทย
          </option>
          <option value="ja">
            日本語
          </option>
          <option value="ko">
            한국어
          </option>
          <option value="zh-CN">
            中文（简体）
          </option>
          <option value="zh-TW">
            中文（繁體）
          </option>
        </Select>
        <StatusLine id="settings-locale-status" size="xs" />
      </div>
    </div>
  );
}
