import { createInstance, type TOptions } from 'i18next';
import { sha256 } from '@noble/hashes/sha2.js';
import { matchLanguage, resolveLanguage, type Catalogs } from './locale';

/**
 * The language runtime, built from one set of catalogs.
 *
 * ./runtime.ts makes the shell's single instance from the build's catalogs;
 * tests make their own from fixture catalogs, which is how a language other
 * than English is exercised while only English ships.
 *
 * English is bundled and is always the fallback: a message a pack does not
 * carry (missing, out of date or malformed at build time) renders in English
 * on its own, and so does everything when a pack cannot be loaded.
 */

/** The notice shown once when the language was picked automatically. */
export type LanguageNotice = { language: string; name: string };
/** What the server's translation cache offers now (GET /api/languages). */
export type LiveCatalogs = Pick<Catalogs, 'languages' | 'manifest'>;
type Save = (value: string | null) => Promise<void>;
/** A choice that has been saved and is owed to the screen. */
type Commit = { id: number; language: string; value: string | null; auto: boolean };

// A choice made on this device while signed out ("Switch to English").
const DEVICE_KEY = 'homeroom:language:device';
// Set once the automatic-language notice has been shown on this device.
const NOTICE_KEY = 'homeroom:language:auto-notice';
// The language last on screen on this device. The head's first-paint hold
// (frontend/src/head.html) reads it before anything paints.
const SHOWN_KEY = 'homeroom:language:shown';
const PENDING_CLASS = 'language-pending';
const PACK_TIMEOUT_MS = 8000;
const RETRY_AFTER_MS = 10000;
// How long a language the build does not ship waits for the server's list
// before the screen settles on what the build has.
const LIVE_WAIT_MS = 1500;
const PACK_URL = /^\/locales\/(?:live\/)?[a-zA-Z-]+\.[a-z-]+\.[a-f0-9]{64}\.json$/;
const HASH = /^[a-f0-9]{64}$/;

/** A list from GET /api/languages that the runtime can use, or null. */
function validLive(value: unknown, namespaces: readonly string[]): LiveCatalogs | null {
  const isRecord = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item);
  if (!isRecord(value) || !isRecord(value.languages) || !isRecord(value.manifest)) return null;
  if (value.languages.en !== 'English' && typeof value.languages.en !== 'string') return null;
  const languages: Record<string, string> = {};
  const manifest: Catalogs['manifest'] = {};
  for (const [tag, name] of Object.entries(value.languages)) {
    if (typeof name !== 'string' || !name.trim()) return null;
    if (tag === 'en') { languages[tag] = name; continue; }
    const packs = value.manifest[tag];
    if (!isRecord(packs)) return null;
    const entries: Record<string, { url: string; hash: string }> = {};
    for (const namespace of namespaces) {
      const entry = packs[namespace];
      if (!isRecord(entry) || typeof entry.url !== 'string' || !PACK_URL.test(entry.url)
          || typeof entry.hash !== 'string' || !HASH.test(entry.hash)) return null;
      entries[namespace] = { url: entry.url, hash: entry.hash };
    }
    languages[tag] = name;
    manifest[tag] = entries;
  }
  return { languages, manifest };
}

function readStored(key: string): string | null {
  try { return localStorage.getItem(key) || null; } catch { return null; }
}
function writeStored(key: string, value: string | null) {
  try {
    if (value) localStorage.setItem(key, value); else localStorage.removeItem(key);
  } catch { /* private mode: the choice lasts for this page */ }
}
function deviceLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  return navigator.languages?.length ? navigator.languages : [navigator.language].filter(Boolean);
}

export function createLanguageRuntime(catalogs: Catalogs) {
  // What is offered: the build's catalogs, until the server's translation
  // cache says what it has now (setLiveCatalogs).
  let languages: Record<string, string> = { ...catalogs.languages };
  let manifest: Catalogs['manifest'] = catalogs.manifest;
  let shipped = Object.keys(languages);
  let languageList: readonly { tag: string; name: string }[] = Object.freeze(
    Object.entries(languages).map(([tag, name]) => ({ tag, name })),
  );
  const languageListeners = new Set<() => void>();
  // The server's list on its way: a language only it has is waited for, briefly.
  let liveWait: Promise<void> | null = null;
  let liveSettled = true;
  // The last session answer, so a list that arrives late can show what it adds.
  let lastSession: { id?: string | number; locale?: string | null } | null | undefined;
  const i18n = createInstance();
  // Hydrate the English build-time document synchronously. A language is
  // activated after hydration; hydrated DOM is never translated behind
  // React's back, and a form is never rebuilt just to change its labels.
  void i18n.init({
    lng: 'en', fallbackLng: 'en', load: 'currentOnly',
    // Which languages may show is decided here (resolveLanguage over
    // `shipped`), and the server's list can add one after this is made.
    supportedLngs: false,
    ns: catalogs.namespaces, defaultNS: 'core', keySeparator: false,
    resources: { en: catalogs.english }, initAsync: false,
    interpolation: { escapeValue: false },
    react: { useSuspense: false, bindI18n: 'languageChanged loaded', bindI18nStore: 'added' },
  });

  const requests = new Map<string, Promise<void>>();
  const requestedNamespaces = new Set<string>(['core']);
  const scheduled = new Set<string>();
  const retryAfter = new Map<string, number>();
  const noticeListeners = new Set<() => void>();
  let activeLanguage = 'en';
  let preference: string | null = null;
  let signedIn = false;
  let notice: LanguageNotice | null = null;
  // How a choice reaches the screen, and what keeps the two from parting:
  //   clock          numbers every attempt, and each time the screen follows one.
  //   newestChoice   the choice the person made last. An older one that has
  //                  not saved yet gives way to it, and is no longer news.
  //   choices        the choices still on their way.
  //   committed      the newest choice that WAS saved and is not on screen yet.
  //                  Only a NEWER choice still on its way can replace it, so
  //                  it waits for those and never for an older one.
  //   newestSession  the latest answer about who is signed in.
  //   shown          the clock when the screen last followed an attempt.
  //   epoch          moves on when the person does (sign-out, another account),
  //                  so a choice still being saved for the last one is not
  //                  shown here.
  let clock = 0;
  let newestChoice = 0;
  const choices = new Set<number>();
  let committed: Commit | null = null;
  let newestSession = 0;
  let shown = 0;
  let epoch = 0;
  let account: string | null = null;
  let saveQueue: Promise<unknown> = Promise.resolve();

  function languageName(language: string): string {
    if (languages[language]) return languages[language];
    try {
      return new Intl.DisplayNames([language], { type: 'language' }).of(language) || language;
    } catch { return language; }
  }

  async function fetchPack(language: string, namespace: string): Promise<void> {
    if (language === 'en' || i18n.hasResourceBundle(language, namespace)) return;
    const entry = manifest[language]?.[namespace];
    if (!entry) throw new Error('Unknown language pack');
    const key = `${language}:${namespace}`;
    const requested = requests.get(key);
    if (requested) return requested;
    const request = (async () => {
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), PACK_TIMEOUT_MS);
      try {
        const response = await fetch(entry.url, {
          credentials: 'same-origin', signal: controller.signal, redirect: 'error',
        });
        if (!response.ok) throw new Error('Language pack unavailable');
        const bytes = await response.arrayBuffer();
        // HTTP previews and self-hosted installations do not expose
        // SubtleCrypto. The exact bytes are still verified there; integrity
        // is never skipped.
        const subtle = globalThis.crypto?.subtle;
        const digest = subtle
          ? await subtle.digest('SHA-256', bytes)
          : sha256(new Uint8Array(bytes));
        const actual = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
        if (actual !== entry.hash) throw new Error('Language pack does not match this build');
        const messages = JSON.parse(new TextDecoder().decode(bytes));
        if (!messages || Array.isArray(messages) || typeof messages !== 'object'
            || Object.values(messages).some((value) => typeof value !== 'string')) {
          throw new Error('Invalid language pack');
        }
        const showing = language === activeLanguage;
        i18n.addResourceBundle(language, namespace, messages, true, true, { silent: !showing });
        // React readers hear the store. A legacy reader repaints on this
        // event, and its first read of this namespace was English: tell it the
        // text for the language on screen is here. A pack loaded ahead of a
        // switch is announced by the switch itself (activate), once.
        if (showing) announce(namespace);
      } finally { clearTimeout(deadline); }
    })();
    requests.set(key, request);
    try { await request; } finally { requests.delete(key); }
  }

  /** What legacy modules repaint on: the language switched, or its text arrived. */
  function announce(namespace?: string): void {
    if (typeof document === 'undefined') return;
    document.dispatchEvent(new CustomEvent('homeroom:language-changed', {
      detail: { language: activeLanguage, preference, ...(namespace ? { namespace } : {}) },
    }));
  }

  async function ensureNamespace(namespace: string): Promise<void> {
    if (!catalogs.namespaces.includes(namespace)) throw new Error('Unknown message namespace');
    requestedNamespaces.add(namespace);
    const language = activeLanguage;
    await fetchPack(language, namespace);
    // A navigation may race a switch. Supply the namespace to the new
    // language too, rather than leaving that screen in English.
    if (language !== activeLanguage) await fetchPack(activeLanguage, namespace);
  }

  /** Called by every reader, so a screen's pack is fetched when it first renders. */
  function registerNamespace(namespace: string): void {
    if (!catalogs.namespaces.includes(namespace)) return;
    requestedNamespaces.add(namespace);
    if (activeLanguage === 'en' || typeof document === 'undefined'
        || i18n.hasResourceBundle(activeLanguage, namespace) || scheduled.has(namespace)) return;
    const key = `${activeLanguage}:${namespace}`;
    if ((retryAfter.get(key) || 0) > Date.now()) return;
    scheduled.add(namespace);
    queueMicrotask(() => {
      void ensureNamespace(namespace)
        .catch(() => { retryAfter.set(key, Date.now() + RETRY_AFTER_MS); })
        .finally(() => scheduled.delete(namespace));
    });
  }

  function t(key: string, options?: TOptions): string {
    registerNamespace(key.includes(':') ? key.split(':')[0] : 'core');
    return String(i18n.t(key, options));
  }

  /** HTML-building legacy owners must not receive unescaped user parameters. */
  function htmlText(key: string, options?: TOptions): string {
    return t(key, options).replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[character]!));
  }

  /**
   * A whole message with markup inside it, for an owner that builds HTML as a
   * string. The catalog holds numbered tags (`Read <0>the terms</0>.`); `wrap`
   * supplies the element for each number as a function of its (already
   * escaped) inner HTML. Everything else, parameters included, is escaped, so
   * neither a translation nor a value can add markup of its own. A tag with
   * no wrapper keeps its text and loses the tag.
   */
  function htmlRich(key: string, values: Record<string, string | number | null | undefined> = {},
    wrap: ((inner: string) => string)[] = []): string {
    const escape = (text: string) => text.replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[character]!));
    // Leave {{parameters}} in place: they are substituted after the tags are
    // parsed, so a value that looks like a tag stays text (as in RichMessage).
    const text = t(key, {
      count: typeof values.count === 'number' ? values.count : undefined,
      interpolation: { prefix: '[[unused:', suffix: ']]' },
    } as TOptions);
    const stack: { index: number; html: string }[] = [{ index: -1, html: '' }];
    for (const token of text.split(/(<\/?\d+>|{{\s*\w+\s*}})/g)) {
      const open = /^<(\d+)>$/.exec(token);
      const close = /^<\/(\d+)>$/.exec(token);
      const parameter = /^{{\s*(\w+)\s*}}$/.exec(token);
      const top = stack[stack.length - 1];
      if (open) stack.push({ index: Number(open[1]), html: '' });
      else if (close && stack.length > 1 && top.index === Number(close[1])) {
        stack.pop();
        const wrapper = wrap[top.index];
        stack[stack.length - 1].html += wrapper ? wrapper(top.html) : top.html;
      } else if (parameter) top.html += escape(String(values[parameter[1]] ?? ''));
      else top.html += escape(token);
    }
    // An unclosed tag keeps what it held.
    return stack.map((group) => group.html).join('');
  }

  /**
   * Independent facts said one after another, as an accessible name gives
   * them ("App: Recipe Box, still open, unread"). Each part is a whole
   * message of its own. What joins two of them is a message too
   * (`core:list.pair`), so a language can use its own punctuation.
   */
  function listText(parts: readonly (string | null | undefined | false)[]): string {
    const said = parts.filter((part): part is string => typeof part === 'string' && part !== '');
    if (!i18n.exists('core:list.pair')) return said.join(', ');
    if (!said.length) return '';
    return said.reduce((first, second) => t('core:list.pair', { first, second }));
  }

  async function prepareLanguage(value: string | null): Promise<{ language: string; auto: boolean }> {
    let resolved = resolveLanguage(value, deviceLanguages(), shipped);
    // The language wanted first (the saved choice, else the device's first)
    // is not one this build ships, and the server's list may still add it:
    // wait for it a moment rather than show another and switch. Somebody
    // whose first language ships never waits.
    const wanted = typeof value === 'string' && value ? value : deviceLanguages()[0];
    if (wanted && !matchLanguage(wanted, shipped) && liveWait && !liveSettled) {
      await Promise.race([liveWait, new Promise((resolve) => { setTimeout(resolve, LIVE_WAIT_MS); })]);
      resolved = resolveLanguage(value, deviceLanguages(), shipped);
    }
    let seen = 0;
    // A screen may register a namespace while these load.
    while (seen !== requestedNamespaces.size) {
      const namespaces = [...requestedNamespaces];
      seen = namespaces.length;
      await Promise.all(namespaces.map((namespace) => fetchPack(resolved.language, namespace)));
    }
    return resolved;
  }

  function setNotice(next: LanguageNotice | null) {
    if (notice === next) return;
    notice = next;
    for (const listener of noticeListeners) listener();
  }

  async function activate(language: string, value: string | null, auto: boolean): Promise<void> {
    const changed = activeLanguage !== language;
    activeLanguage = language;
    preference = value;
    await i18n.changeLanguage(language);
    if (typeof document !== 'undefined' && document.documentElement.lang !== language) {
      document.documentElement.lang = language;
    }
    if (changed) announce();
    // The language is on screen: lift the head's hold, and remember it so
    // the next load holds (or does not) for the right language.
    writeStored(SHOWN_KEY, language);
    if (typeof document !== 'undefined') document.documentElement.classList?.remove(PENDING_CLASS);
    // Once per device, the first time the language was picked for the person
    // rather than by them. Shown, it is spent, whatever they do with it.
    if (auto && language !== 'en') {
      if (!readStored(NOTICE_KEY)) {
        writeStored(NOTICE_KEY, language);
        setNotice({ language, name: languageName(language) });
      }
    } else {
      setNotice(null);
    }
  }

  /**
   * The screen follows the last choice that was saved. Called whenever a
   * choice ends, however it ends: unless a newer choice is still on its way,
   * what was saved goes on screen now. An older choice, still loading or
   * about to fail, is never waited for. Returns the choice it showed, or 0.
   */
  async function showCommitted(): Promise<number> {
    if (!committed) return 0;
    for (const id of choices) if (id > committed.id) return 0;
    const next = committed;
    committed = null;
    shown = ++clock;
    await activate(next.language, next.value, next.auto);
    return next.id;
  }

  /**
   * Load first, save next, activate last.
   *
   * Resolves true when this choice is what the screen shows. Resolves false
   * when it gave way to a newer choice, whatever then became of it: once the
   * person has chosen again, this one failing is not news, and the newer
   * choice reports for itself. Rejects only when the newest choice could not
   * be loaded or saved; the screen is then left as it was or, if an earlier
   * choice had been saved meanwhile, on that one.
   */
  async function changeLanguage(value: string | null, save?: Save): Promise<boolean> {
    const id = ++clock;
    newestChoice = id;
    const startedIn = epoch;
    // Chosen again since, or the person this was for has gone.
    const gaveWay = () => id !== newestChoice || startedIn !== epoch;
    choices.add(id);
    const attempt = async (): Promise<void> => {
      const { language, auto } = await prepareLanguage(value);
      if (gaveWay()) return;
      if (save) {
        // Writes are serialized, so a slow old save can never overwrite the
        // newest account preference, and one that is no longer the newest
        // when its turn comes is not sent at all.
        const operation = saveQueue.catch(() => {}).then(async () => {
          if (gaveWay()) return false;
          await save(value);
          return true;
        });
        saveQueue = operation;
        if (!(await operation)) return;
      }
      // It was saved, so it stands even if a newer choice has been made
      // since: that one may still fail. Unless it was saved for someone who
      // has since signed out or changed account.
      if (startedIn !== epoch) return;
      // An account choice replaces one made on this device while signed out.
      writeStored(DEVICE_KEY, save ? null : value);
      committed = { id, language, value, auto };
    };
    let failure: { error: unknown } | null = null;
    try {
      await attempt();
    } catch (error) {
      failure = { error };
    }
    choices.delete(id);
    const shownNow = await showCommitted();
    if (failure && !gaveWay()) throw failure.error;
    return shownNow === id;
  }

  /** The session resolved: `user` signed in, or null for the sign-in screens. */
  async function applySessionLanguage(user: { id?: string | number; locale?: string | null } | null): Promise<void> {
    lastSession = user;
    const next = user ? String(user.id ?? '') : null;
    if (next !== account) {
      account = next;
      epoch += 1;
      committed = null;
    }
    signedIn = !!user;
    const value = user?.locale || readStored(DEVICE_KEY);
    const id = ++clock;
    newestSession = id;
    let resolved: { language: string; auto: boolean };
    try {
      resolved = await prepareLanguage(value);
    } catch {
      // English is always available. A pack that cannot be loaded never
      // leaves sign-in or the shell without text.
      resolved = { language: 'en', auto: false };
    }
    // A newer answer replaces this one. So does a choice shown while this was
    // loading: it was saved after the preference this answer carries was read.
    if (id !== newestSession || shown > id) return;
    shown = ++clock;
    await activate(resolved.language, value, resolved.auto);
  }

  /**
   * The server's list (GET /api/languages): the languages its translation
   * cache covers well enough now, and where their packs are. Replaces the
   * build's; a pack already loaded stays. A language it adds that this
   * session wants is shown. Resolves whether the list could be used.
   */
  function setLiveCatalogs(value: unknown): boolean {
    const live = validLive(value, catalogs.namespaces);
    if (!live) return false;
    languages = live.languages;
    manifest = live.manifest;
    shipped = Object.keys(languages);
    languageList = Object.freeze(Object.entries(languages).map(([tag, name]) => ({ tag, name })));
    for (const listener of languageListeners) listener();
    if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('homeroom:languages-changed'));
    if (lastSession !== undefined) {
      const wanted = resolveLanguage(lastSession?.locale || readStored(DEVICE_KEY), deviceLanguages(), shipped).language;
      if (wanted !== activeLanguage) void applySessionLanguage(lastSession);
    }
    return true;
  }

  /** The server's list is on its way (`request` settles once it is used or given up). */
  function waitForLive(request: Promise<unknown>): void {
    liveSettled = false;
    liveWait = request.then(() => {}, () => {}).finally(() => { liveSettled = true; });
  }

  return {
    i18n,
    t,
    htmlText,
    htmlRich,
    listText,
    languageName,
    registerNamespace,
    ensureNamespace,
    changeLanguage,
    applySessionLanguage,
    getLanguage: () => activeLanguage,
    getPreference: () => preference,
    isSignedIn: () => signedIn,
    getNotice: () => notice,
    subscribeNotice(listener: () => void) {
      noticeListeners.add(listener);
      return () => { noticeListeners.delete(listener); };
    },
    dismissNotice: () => setNotice(null),
    setLiveCatalogs,
    waitForLive,
    /** The languages offered now, English first, each under its own name. */
    getLanguages: () => languageList,
    subscribeLanguages(listener: () => void) {
      languageListeners.add(listener);
      return () => { languageListeners.delete(listener); };
    },
  };
}

export type LanguageRuntime = ReturnType<typeof createLanguageRuntime>;
