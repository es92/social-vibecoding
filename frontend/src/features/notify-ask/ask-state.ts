/**
 * What the notification ask reads and writes (see ./decide.ts for the rules).
 *
 * Four reads, each made from an effect, never during a render:
 *   - the account's answers: GET /api/me/notification-asks, once per page
 *     and again after each answer;
 *   - the phone's permission, in the Homeroom app:
 *     NativeChrome.notifyAskPermission (public/js/native-chrome.js);
 *   - where the app can be got: GET /api/public/mobile-app;
 *   - this device: a phone (a store link) or a computer (a code to scan).
 * One write: POST /api/me/notification-asks, with the answer.
 *
 * And one rule that is not the account's but the page's: one card per
 * moment (claimAsk), so a moment drawn in two places asks once.
 */

import { detectMobileOs, storeLabel, type MobileOs, type StoreUrls } from '../mobile-install/detect';
import {
  decideNotifyAsk,
  type AskAnswer,
  type AskPlan,
  type AskState,
  type AskSurface,
  type NotifyMoment,
  type OsPermission,
} from './decide';

interface NativePermission {
  isNative?: boolean;
  platform?: string | null;
  permission?: OsPermission;
  canRequest?: boolean;
  canOpenSettings?: boolean;
}

interface NotifyAskHost {
  NativeChrome?: {
    notifyAskPermission?(): Promise<NativePermission>;
    notifyWhenReady?(): Promise<{ outcome?: string; settings?: boolean }>;
  };
  usernode?: { isNative?: boolean; openNotificationSettings?(): Promise<unknown> };
  UITelemetry?: {
    attempt?(event: string, fields: Record<string, unknown>): unknown;
    outcome?(attempt: unknown, outcome: string, fields?: Record<string, unknown>): void;
  };
}

function host(): NotifyAskHost {
  return window as unknown as NotifyAskHost;
}

let answers: Promise<AskState | null> | null = null;

function asState(body: unknown): AskState | null {
  const b = body as Partial<AskState> | null;
  if (!b || !Array.isArray(b.asks)) return null;
  return { asks: b.asks, phone: b.phone === true, email: b.email === true };
}

/** The account's answers, read once per page (null: signed out, or unread). */
export function readAskState(): Promise<AskState | null> {
  if (!answers) {
    answers = fetch('/api/me/notification-asks', { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : null))
      .then(asState)
      .catch(() => null);
    // An unread answer is read again next time rather than kept.
    void answers.then((state) => { if (!state) answers = null; });
  }
  return answers;
}

/** Record an answer. Best effort: an unrecorded answer is asked again next page. */
export async function recordAsk(surface: AskSurface, moment: NotifyMoment, answer: AskAnswer): Promise<void> {
  try {
    const res = await fetch('/api/me/notification-asks', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ surface, moment, answer }),
    });
    const state = res.ok ? asState(await res.json()) : null;
    answers = state ? Promise.resolve(state) : null;
  } catch (err) {
    console.warn('[notify-ask] answer not recorded:', err);
    answers = null;
  }
}

let storeUrls: Promise<StoreUrls | null> | null = null;

function readStoreUrls(): Promise<StoreUrls | null> {
  if (!storeUrls) {
    storeUrls = fetch('/api/public/mobile-app')
      .then((res) => (res.ok ? res.json() : null))
      .then((body: StoreUrls | null) => (body && typeof body === 'object' ? body : null))
      .catch(() => null);
  }
  return storeUrls;
}

/** Only an http(s) link is ever an href: the URLs are an admin's free text. */
function safeUrl(raw: string | null | undefined): string | null {
  const value = (raw || '').trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? value : null;
  } catch {
    return null;
  }
}

/** One store to send a person to: its link and what to call it (a message id). */
export interface StoreLink { os: MobileOs; url: string; label: string }

/**
 * Where this device gets the app. On a phone, its own store's link; on a
 * computer, every store there is, for the sheet's code to scan
 * (`/get-app`, which sends the phone that scans it to its own store).
 *
 * A TestFlight invite counts here, unlike in the install banner: the ask
 * is made only to people who are already in, and the "You're in" email
 * sends them to that same TestFlight link. Its label says it is TestFlight.
 */
export function appLinks(urls: StoreUrls | null, os: MobileOs | null): StoreLink[] {
  if (!urls) return [];
  const all: MobileOs[] = os ? [os] : ['ios', 'android'];
  const links: StoreLink[] = [];
  for (const which of all) {
    const url = safeUrl(urls[which]);
    if (url) links.push({ os: which, url, label: storeLabel(which, url) });
  }
  return links;
}

export interface AskContext {
  plan: AskPlan;
  native: NativePermission;
  /** On the web: this device's phone OS, or null on a computer. */
  os: MobileOs | null;
  links: StoreLink[];
}

/** Everything the ask needs, and whether to ask. Never throws. */
export async function planAsk(moment: NotifyMoment): Promise<AskContext> {
  const h = host();
  const isNative = !!(h.usernode && h.usernode.isNative === true);
  const [state, native, urls] = await Promise.all([
    readAskState(),
    isNative && h.NativeChrome && typeof h.NativeChrome.notifyAskPermission === 'function'
      ? h.NativeChrome.notifyAskPermission().catch((): NativePermission => ({ isNative: true, canRequest: false }))
      : Promise.resolve({ isNative } as NativePermission),
    isNative ? Promise.resolve(null) : readStoreUrls(),
  ]);
  const os = isNative ? null : detectMobileOs(navigator.userAgent, navigator.maxTouchPoints || 0);
  const links = appLinks(urls, os);
  const plan = decideNotifyAsk({
    moment,
    state,
    native: isNative,
    permission: native.permission ?? null,
    canRequest: native.canRequest === true,
    appToGet: links.length > 0,
  });
  return { plan, native, os, links };
}

/**
 * The OS prompt, in the Homeroom app (NativeChrome.notifyWhenReady: the
 * platform's own prompt, then push registration and this phone's Activity
 * notifications on). Resolves granted, and whether a refusal can be undone
 * from the OS settings page.
 */
export async function askOs(): Promise<{ granted: boolean; settings: boolean }> {
  const chrome = host().NativeChrome;
  if (!chrome || typeof chrome.notifyWhenReady !== 'function') return { granted: false, settings: false };
  try {
    const answer = await chrome.notifyWhenReady();
    return { granted: answer?.outcome === 'granted', settings: answer?.outcome === 'denied' && answer?.settings === true };
  } catch {
    return { granted: false, settings: false };
  }
}

/** The OS settings page for Homeroom's notifications (a refusal's way back). */
export function openNotificationSettings(): void {
  void host().usernode?.openNotificationSettings?.()?.catch?.(() => {});
}

/**
 * services/ui-telemetry.js push_permission, as the made screen's ask counts
 * it, on the `notify_ask` screen: success, failure (refused), cancelled (Not
 * now).
 */
export function askTelemetry(): { done(outcome: string, fields?: Record<string, unknown>): void } {
  const telemetry = host().UITelemetry;
  const attempt = telemetry && typeof telemetry.attempt === 'function'
    ? telemetry.attempt('push_permission', { screen: 'notify_ask' }) : null;
  return {
    done(outcome, fields) {
      if (attempt && telemetry && typeof telemetry.outcome === 'function') telemetry.outcome(attempt, outcome, fields);
    },
  };
}

const held = new Set<NotifyMoment>();

/**
 * One card per moment: the first to claim a moment holds it until it lets
 * go, so a moment drawn in two places at once (two composers) asks once.
 * Per moment, not per page: the shell keeps every screen mounted while it is
 * hidden, so a page-wide hold let a project hub's card, left on a hidden
 * screen, silence "Hear when they answer?" in Messages. Resolves a release
 * function, or null when this moment's card is up elsewhere.
 */
export function claimAsk(moment: NotifyMoment): (() => void) | null {
  if (held.has(moment)) return null;
  held.add(moment);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.delete(moment);
  };
}

/** Tests only: forget what this page has read and claimed. */
export function resetAskStateForTests(): void {
  answers = null;
  storeUrls = null;
  held.clear();
}
