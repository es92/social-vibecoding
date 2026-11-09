/**
 * #6081: read someone else's words in your own language, on a tap.
 * #6525: in a chat, read them as they appear, without a tap.
 *
 * One small hook, `useTranslate`, asks POST /api/translations for one or two
 * texts (a message, or a request's title and words) in the language the page
 * is read in. The answer is kept in this module for the session, so a
 * re-render or a reopened thread does not ask again; the server keeps it for
 * everyone else. `TranslateNote` is the line under the words: who wrote it in
 * what language, the way back to the original, or why it could not translate.
 *
 * A request's words are asked for only when a person taps, as the spec says.
 * A message in a chat asks for itself when it comes into view: one shared
 * IntersectionObserver watches the rows, and a small queue here spreads their
 * requests out, so scrolling back through a long channel neither floods the
 * route (30 a minute) nor spends the day's translations all at once. A
 * translation the reader did not ask for must never make the chat flicker, so
 * an automatic miss stays quiet: only an answer that has something to show
 * changes the row.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { useMessages } from '../../lib/i18n/react';
import { getLanguage, languageName } from '../../lib/i18n/runtime';

export interface TranslateResult {
  state: 'translated' | 'same' | 'failed';
  text?: string;
  from?: string;
}

export type TranslateState = 'idle' | 'pending' | 'shown' | 'original' | 'same' | 'failed' | 'limit';

/** Whether the words are being read now because a person asked, or on their own. */
export type TranslateOrigin = 'auto' | 'tap';

export interface TranslateView {
  /** What the words are doing right now. */
  state: TranslateState;
  /** The texts to draw: the translation while it is shown, the original otherwise. */
  texts: string[];
  /** The language the model read the source in, when it said. */
  from: string | null;
  /** 'tap' once a person asked for these words; 'auto' until then. */
  origin: TranslateOrigin;
  ask: () => void;
  /** Ask for the translation once, as the words come into view. */
  askAuto: () => boolean;
  toggle: () => void;
}

const ANSWERS = new Map<string, TranslateResult[]>();

/** One answer key: the words and the language they were asked for. */
export function cacheKey(texts: readonly string[], language: string): string {
  return `${language}\u0000${texts.join('\u0000')}`;
}

/*
 * WHAT IS WORTH SENDING. A message made only of emoji, a link or two, or a
 * name has nothing to translate; sending it would spend one of the reader's
 * daily translations to be told it is already in their language.
 */
const CODE_BLOCK = /```[\s\S]*?```/g;
const INLINE_CODE = /`[^`]*`/g;
const URL = /https?:\/\/\S+|\bwww\.\S+/gi;
const MENTION = /(^|\s)@[A-Za-z0-9_.-]+/g;
const NUMBER_REF = /(^|\s)#\d+\b/g;

export function worthAsking(text: string): boolean {
  if (!text) return false;
  const words = text
    .replace(CODE_BLOCK, ' ')
    .replace(INLINE_CODE, ' ')
    .replace(URL, ' ')
    .replace(MENTION, ' ')
    .replace(NUMBER_REF, ' ');
  return /\p{L}/u.test(words);
}

/**
 * The route's two answers that are not a reading: it said no more today, or
 * it could not. Anything else is one result per text.
 */
type TranslateAnswer =
  | { status: 'ok'; results: TranslateResult[] }
  | { status: 'limit' }
  | { status: 'failed' };

/**
 * One request to POST /api/translations, shared by a tap and an automatic ask.
 * An automatic ask says so (`auto: true`): where a tap gets an error status
 * for a bound that stopped it, the page translating as you read gets a quiet
 * per-text failure instead. A non-2xx answer is a line in the browser's
 * console, and a chat that cannot translate must not appear to be broken.
 */
async function requestTranslation(
  texts: readonly string[],
  language: string,
  { auto = false }: { auto?: boolean } = {},
): Promise<TranslateAnswer> {
  try {
    const response = await fetch('/api/translations', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(auto ? { texts, language, auto: true } : { texts, language }),
    });
    if (response.status === 429) return { status: 'limit' };
    if (!response.ok) return { status: 'failed' };
    const data = await response.json();
    const results = Array.isArray(data?.results) && data.results.length === texts.length
      ? data.results as TranslateResult[]
      : texts.map(() => ({ state: 'failed' as const }));
    return { status: 'ok', results };
  } catch {
    return { status: 'failed' };
  }
}

/*
 * THE AUTOMATIC QUEUE (#6525). Only rows that scrolled into view ask, at most
 * 2 requests are on their way at once, and no more than 20 are started in any
 * 60 seconds — under the route's 30 a minute, and a day's worth of history is
 * not spent by one scroll. A 429 means the reader's day is done: what is
 * waiting is dropped (a row asks again when it next comes into view) and
 * nothing starts for a minute.
 */
const AUTO_MAX_IN_FLIGHT = 2;
const AUTO_MAX_PER_MINUTE = 20;
const AUTO_WINDOW_MS = 60_000;
const AUTO_PAUSE_MS = 60_000;

interface AutoJob {
  run: () => Promise<void>;
  /** The queue never got to it; the row may ask again next time it is seen. */
  drop: () => void;
}

const autoQueue: AutoJob[] = [];
let autoInFlight = 0;
let autoStarted: number[] = [];
let autoPausedUntil = 0;
let autoResume: ReturnType<typeof setTimeout> | null = null;

function pumpAutoQueue(): void {
  const now = Date.now();
  if (now < autoPausedUntil) {
    scheduleAutoResume(autoPausedUntil - now);
    return;
  }
  autoStarted = autoStarted.filter((at) => now - at < AUTO_WINDOW_MS);
  while (autoQueue.length && autoInFlight < AUTO_MAX_IN_FLIGHT && autoStarted.length < AUTO_MAX_PER_MINUTE) {
    const job = autoQueue.shift() as AutoJob;
    autoStarted.push(now);
    autoInFlight += 1;
    void (async () => {
      try { await job.run(); } finally {
        autoInFlight -= 1;
        pumpAutoQueue();
      }
    })();
  }
  // Held back by the minute's allowance: start again when the oldest leaves it.
  if (autoQueue.length && autoStarted.length >= AUTO_MAX_PER_MINUTE) {
    const wait = AUTO_WINDOW_MS - (now - autoStarted[0]) + 1;
    if (wait > 0) scheduleAutoResume(wait);
  }
}

function scheduleAutoResume(ms: number): void {
  if (autoResume !== null) return;
  autoResume = setTimeout(() => {
    autoResume = null;
    pumpAutoQueue();
  }, ms);
  // A waiting timer must not hold a test process open.
  (autoResume as unknown as { unref?: () => void }).unref?.();
}

/** The day's translations are spent: drop what waits, and stop asking for a minute. */
function pauseAutoQueue(): void {
  autoPausedUntil = Date.now() + AUTO_PAUSE_MS;
  const dropped = autoQueue.splice(0);
  for (const job of dropped) job.drop();
  scheduleAutoResume(AUTO_PAUSE_MS);
}

/**
 * Put one request on the queue. False means the queue is paused and nothing
 * was taken on: the row should ask again when it next comes into view.
 */
function enqueueAuto(job: AutoJob): boolean {
  if (Date.now() < autoPausedUntil) return false;
  autoQueue.push(job);
  pumpAutoQueue();
  return true;
}

/*
 * ONE OBSERVER FOR EVERY ROW. A long channel can draw hundreds of rows, and
 * an observer each would be hundreds of observers; this one watches them all
 * with a 200px margin, near enough that a row is translated before it is
 * read. A row is asked for once; `ask` answers false when the queue dropped
 * it, and then the row stays watched so scrolling it back in tries again.
 */
const AUTO_ROOT_MARGIN = '200px 0px';

let autoObserver: IntersectionObserver | null = null;
const autoAskers = new WeakMap<Element, () => boolean>();

function sharedAutoObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver !== 'function') return null;
  if (!autoObserver) {
    autoObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const ask = autoAskers.get(entry.target);
        if (!ask) { autoObserver?.unobserve(entry.target); continue; }
        if (ask()) {
          autoAskers.delete(entry.target);
          autoObserver?.unobserve(entry.target);
        }
      }
    }, { rootMargin: AUTO_ROOT_MARGIN });
  }
  return autoObserver;
}

/**
 * Ask for `el`'s translation the first time it comes into view. Returns the
 * way to stop watching it.
 */
export function observeAutoTranslate(el: Element, ask: () => boolean): () => void {
  const observer = sharedAutoObserver();
  if (!observer) return () => {};
  autoAskers.set(el, ask);
  observer.observe(el);
  return () => {
    autoAskers.delete(el);
    observer.unobserve(el);
  };
}

/**
 * What a set of answers means for the line under the words, before the
 * reader's own Show original/Show translation is taken into account. A mixed
 * answer (a title already in the language, words translated) is shown: the
 * parts already in the language stay as written.
 */
export function viewOf(results: TranslateResult[] | null, texts: readonly string[]): {
  state: Exclude<TranslateState, 'pending' | 'original' | 'limit'>;
  texts: string[];
  from: string | null;
} {
  if (!results || !results.length) return { state: 'idle', texts: texts.slice(), from: null };
  const translated = results.filter((result) => result.state === 'translated' && typeof result.text === 'string');
  if (translated.length) {
    return {
      state: 'shown',
      texts: results.map((result, index) => (result.state === 'translated' && typeof result.text === 'string'
        ? result.text : texts[index])),
      from: translated.find((result) => result.from)?.from || null,
    };
  }
  if (results.every((result) => result.state === 'same')) return { state: 'same', texts: texts.slice(), from: null };
  return { state: 'failed', texts: texts.slice(), from: null };
}

/** The source language's name in the reader's language, or null when unknown. */
export function sourceName(tag: string | null): string | null {
  if (!tag) return null;
  try { return new Intl.DisplayNames([getLanguage()], { type: 'language' }).of(tag) || null; } catch { return null; }
}

export function useTranslate(texts: readonly string[], { enabled = true, auto = false }: { enabled?: boolean; auto?: boolean } = {}): TranslateView {
  // A new array of the same words is the same text; an edit is a new key.
  const joined = texts.join('\u0000');
  const [results, setResults] = useState<TranslateResult[] | null>(null);
  const [pending, setPending] = useState(false);
  const [limited, setLimited] = useState(false);
  const [original, setOriginal] = useState(false);
  const [origin, setOrigin] = useState<TranslateOrigin>('auto');
  const fetching = useRef(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  // An edited message or request is a new text, so it starts over.
  useEffect(() => {
    setResults(null);
    setPending(false);
    setLimited(false);
    setOriginal(false);
    setOrigin('auto');
  }, [joined]);
  // The automatic ask happens at most once for one text: the observer may
  // call this more than once as a dropped row is scrolled back in.
  const askedAuto = useRef<string | null>(null);
  useEffect(() => { askedAuto.current = null; }, [joined]);

  const ask = useCallback(() => {
    if (!enabled || pending || fetching.current) return;
    setOrigin('tap');
    const language = getLanguage();
    const key = cacheKey(texts, language);
    const known = ANSWERS.get(key);
    if (known) { setResults(known); setOriginal(false); return; }
    fetching.current = true;
    setPending(true);
    setLimited(false);
    void (async () => {
      try {
        const answer = await requestTranslation(texts, language);
        if (answer.status === 'limit') {
          pauseAutoQueue();
          if (alive.current) { setLimited(true); setPending(false); }
          return;
        }
        if (answer.status === 'failed') {
          if (alive.current) { setResults(texts.map(() => ({ state: 'failed' as const }))); setPending(false); }
          return;
        }
        ANSWERS.set(key, answer.results);
        if (alive.current) { setResults(answer.results); setPending(false); }
      } finally {
        fetching.current = false;
      }
    })();
  }, [enabled, pending, joined]);

  /**
   * Ask for these words by themselves. An answer already known is applied at
   * once; anything else joins the queue. Nothing a person did not ask for
   * makes the row say it is translating, or that it could not: only words
   * there are to show change the view.
   */
  const askAuto = useCallback((): boolean => {
    if (!enabled || !auto) return true;
    const language = getLanguage();
    const key = cacheKey(texts, language);
    if (askedAuto.current === key) return true;

    const show = (answers: TranslateResult[]) => {
      ANSWERS.set(key, answers);
      // Same language, or a failure: the words stay as written, quietly.
      if (viewOf(answers, texts).state !== 'shown') return;
      if (alive.current) { setResults(answers); setOriginal(false); }
    };

    const known = ANSWERS.get(key);
    if (known) {
      askedAuto.current = key;
      show(known);
      return true;
    }

    askedAuto.current = key;
    const taken = enqueueAuto({
      run: async () => {
        const answer = await requestTranslation(texts, language, { auto: true });
        if (answer.status === 'limit') { pauseAutoQueue(); return; }
        if (answer.status === 'ok') show(answer.results);
      },
      drop: () => { if (askedAuto.current === key) askedAuto.current = null; },
    });
    if (!taken) { askedAuto.current = null; return false; }
    return true;
  }, [enabled, auto, joined]);

  const toggle = useCallback(() => { setOriginal((on) => !on); }, []);

  const base = viewOf(results, texts);
  const state: TranslateState = pending ? 'pending'
    : limited ? 'limit'
      : base.state === 'shown' ? (original ? 'original' : 'shown')
        : base.state;

  return {
    state,
    texts: base.state === 'shown' && !original ? base.texts : texts.slice(),
    from: base.from,
    origin,
    ask,
    askAuto,
    toggle,
  };
}

/** The line under the words: how to go back and forth, or why there is nothing to show. */
export function TranslateNote({ view, className = '' }: {
  view: Pick<TranslateView, 'state' | 'from' | 'toggle'>;
  className?: string;
}) {
  const t = useMessages('messages');
  if (view.state === 'idle') return null;
  if (view.state === 'pending') {
    return <div className={`text-xs text-zinc-500 dark:text-zinc-400 ${className}`} role="status">{t('messages:translate.pending')}</div>;
  }
  if (view.state === 'failed') {
    return <div className={`text-xs text-zinc-500 dark:text-zinc-400 ${className}`} role="status">{t('messages:translate.failed')}</div>;
  }
  if (view.state === 'limit') {
    return <div className={`text-xs text-zinc-500 dark:text-zinc-400 ${className}`} role="status">{t('messages:translate.limit')}</div>;
  }
  if (view.state === 'same') {
    return <div className={`text-xs text-zinc-500 dark:text-zinc-400 ${className}`} role="status">{t('messages:translate.same', { language: languageName(getLanguage()) })}</div>;
  }
  const shown = view.state === 'shown';
  const from = sourceName(view.from);
  return (
    <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400 ${className}`}>
      <span>{from ? t('messages:translate.from', { language: from }) : t('messages:translate.translated')}</span>
      <span aria-hidden="true">·</span>
      <button
        type="button"
        className="font-semibold text-violet-700 hover:underline dark:text-violet-300"
        onClick={view.toggle}
      >
        {shown ? t('messages:translate.showOriginal') : t('messages:translate.showTranslation')}
      </button>
    </div>
  );
}
