import catalogs from './catalogs.generated.json';
import { saveAccountLocale } from './account';
import { createLanguageRuntime } from './core';

/**
 * The shell's language runtime: ./core.ts built from this build's catalogs
 * (frontend/locales, through scripts/language-packs.js). Imported once by
 * main.tsx; frontend/locales/README.md says how to use it.
 */
const runtime = createLanguageRuntime(catalogs);

export const {
  i18n, t, htmlText, htmlRich, listText, languageName, registerNamespace, ensureNamespace,
  changeLanguage, applySessionLanguage, getLanguage, getPreference,
  getNotice, subscribeNotice, dismissNotice, getLanguages, subscribeLanguages,
} = runtime;

/**
 * The languages this build's own catalogs ship, in config order, with their
 * own names: what Settings lists before the server's list arrives, and all it
 * lists without one. getLanguages() is what is offered now.
 */
export const shippedLanguages: readonly { tag: string; name: string }[] = Object.freeze(
  Object.entries(catalogs.languages).map(([tag, name]) => ({ tag, name })),
);

const LIVE_TIMEOUT_MS = 8000;

/**
 * What the server's translation cache offers now (GET /api/languages): a
 * language translated since this build, and newer packs for the ones it
 * ships. Without it, the build's own catalogs stand.
 */
async function loadLiveLanguages(): Promise<void> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), LIVE_TIMEOUT_MS);
  try {
    const response = await fetch('/api/languages', { credentials: 'same-origin', signal: controller.signal, redirect: 'error' });
    if (!response.ok) return;
    runtime.setLiveCatalogs(await response.json());
  } catch {
    // Offline, or a server without the cache: the build's languages stand.
  } finally {
    clearTimeout(deadline);
  }
}

if (typeof document !== 'undefined' && typeof location !== 'undefined' && typeof fetch === 'function') {
  runtime.waitForLive(loadLiveLanguages());
}

/** The notice's way back: English, saved where this person's choice lives. */
export function switchToEnglish(): Promise<boolean> {
  return changeLanguage('en', runtime.isSignedIn()
    ? async (value) => { await saveAccountLocale(value); }
    : undefined);
}

// The legacy modules' adapter. Translate at render time, never at module
// initialization, and repaint on `homeroom:language-changed`.
(globalThis as unknown as { PlatformI18n: unknown }).PlatformI18n = {
  t, htmlText, htmlRich, listText, languageName, getLanguage, getPreference, changeLanguage,
  applySessionLanguage, saveAccountLocale, getLanguages,
};

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  // Signed in. app.js reports the signed-out case itself (enterAnonymous).
  document.addEventListener('sv:session', (event) => {
    void applySessionLanguage((event as CustomEvent).detail?.user || null);
  });
}
