import catalogs from './catalogs.generated.json';
import { saveAccountLocale } from './account';
import { bootWantsLive, createLanguageRuntime } from './core';
import { errorText } from './server-error';
import {
  deviceTimeZone, getTimeZone, saveAccountTimeZone, setTimeZone, subscribeTimeZone, timeZoneLabel, zonedDay,
} from '../time-zone';
import { agoStamp, messageStamp, shortDate } from '../timestamp';
import { capCount } from '../count-cap';

export { errorText };

/**
 * The shell's language runtime: ./core.ts built from this build's catalogs
 * (frontend/locales, through scripts/language-packs.js). Imported once by
 * main.tsx; frontend/locales/README.md says how to use it.
 */
const runtime = createLanguageRuntime(catalogs);

export const {
  i18n, t, htmlText, htmlRich, listText, languageName, registerNamespace, ensureNamespace,
  changeLanguage, applySessionLanguage, getLanguage, getDateLocale, getPreference, getAutoLanguage,
  subscribeAutoLanguage,
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
 * ships. Without it, the build's own catalogs stand. Resolves whether the
 * list could be used — the same question a moved pack asks later, so core.ts
 * calls this again through setLiveRefresh.
 */
async function loadLiveLanguages(): Promise<boolean> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), LIVE_TIMEOUT_MS);
  try {
    // no-cache: a caller asking again is asking because its list is old, and
    // an old answer from a shared cache is exactly what it must not get.
    const response = await fetch('/api/languages', { credentials: 'same-origin', signal: controller.signal, redirect: 'error', cache: 'no-cache' });
    if (!response.ok) return false;
    return runtime.setLiveCatalogs(await response.json());
  } catch {
    // Offline, or a server without the cache: the build's languages stand.
    return false;
  } finally {
    clearTimeout(deadline);
  }
}

if (typeof document !== 'undefined' && typeof location !== 'undefined' && typeof fetch === 'function') {
  runtime.setLiveRefresh(loadLiveLanguages);
  // Request 7165: a page in English does not need the list to boot (47 KB
  // on every load). It is asked for when it is first wanted, below.
  if (bootWantsLive()) runtime.waitForLive(loadLiveLanguages());
  else runtime.deferLive();
}

/**
 * Settings › Language is opening: its list is the server's, so ask for it if
 * this page booted without it, or its last answer could not be used. The
 * pane hears `homeroom:languages-changed` when it arrives.
 */
export function ensureLiveLanguages(): void {
  runtime.ensureLive(true);
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
  t, htmlText, htmlRich, listText, languageName, getLanguage, getPreference, changeLanguage, errorText,
  // #6103: the classic scripts' date formatters read the same rule.
  dateLocale: getDateLocale,
  // #6479: the zone the account picked (undefined for the device's), and the
  // calendar day an instant falls on in it, for GroupChat._stamp.
  timeZone: getTimeZone,
  zonedDay,
  // The shell's one time formatter, lib/timestamp.ts, for the modules that
  // read this global rather than import (app-view.js, build-log.js, the
  // bell's notifications.js, leaderboard.js), so none keeps a copy: the age
  // for a list ("3h ago", a date past a week), the stamp for a conversation
  // ("Nov 24, 5:23 PM"), and the day alone. Read at call time, as `t` is.
  // (timestamp.ts imports `t` from here; it reads it only inside its
  // functions, so the import cycle settles at load.)
  agoStamp, messageStamp, shortDate,
  // A count as a badge shows it, "99+" past 99 (lib/count-cap.ts): the bell's
  // number, its sheet's tab and the browser tab's title read it here.
  capCount,
  // Settings › Language's Time zone list: its labels, Auto's zone, the save.
  timeZoneLabel, deviceTimeZone, saveAccountTimeZone,
  // Settings asks for the server's list of languages when it opens.
  ensureLiveLanguages,
  applySessionLanguage, saveAccountLocale, getLanguages,
};

// A new zone repaints what the legacy modules drew, as a new language does:
// every one of them redraws its times on this event.
subscribeTimeZone(() => {
  if (typeof document === 'undefined' || typeof document.dispatchEvent !== 'function') return;
  document.dispatchEvent(new CustomEvent('homeroom:language-changed', {
    detail: { language: getLanguage(), preference: getPreference(), timeZone: getTimeZone() || null },
  }));
});

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  // Signed in. app.js reports the signed-out case itself (enterAnonymous).
  document.addEventListener('sv:session', (event) => {
    const user = (event as CustomEvent).detail?.user || null;
    // #6479: the account's zone, or the device's when it picked none.
    setTimeZone(user?.timeZone || null);
    void applySessionLanguage(user);
  });
}
