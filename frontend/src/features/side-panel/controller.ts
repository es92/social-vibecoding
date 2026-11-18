/**
 * The side panel beside a running app, on a desktop-width window — the TOP
 * document's half (the panel's own document runs ./embedded.ts).
 *
 * ── What it is ─────────────────────────────────────────────────────────
 *
 * While an app runs on its App tab, the pieces of its work — a proposal, an
 * issue, a change — and the conversations a notification points at open in a
 * panel beside it instead of replacing it. The app keeps running next to the
 * panel and is never reloaded. A community's page is never one of them: it is
 * a place of its own, and a link to it replaces the app, full screen
 * (./routes.ts).
 *
 * ── Why the panel is the platform, framed ─────────────────────────────
 *
 * The platform's screens are singletons behind one router: App._showOnlyScreen
 * shows exactly one root, the running app's iframe and that app's Workshop
 * are two tabs of the same #app-view, the discussion renders into ids the
 * legacy chat module owns, and every store is global. Showing the app and one
 * of those pages at once natively would mean re-architecting the router. So
 * the panel is a same-origin <iframe> of the platform itself at
 * `/?panel=1#<route>`, in an embedded mode that draws no chrome (see
 * lib/side-panel-mode.ts and head.html) — the pages it shows are the real
 * pages, at their phone layout, with no second copy of any of them.
 *
 * ── What this file owns ────────────────────────────────────────────────
 *
 *   - WHEN a navigation goes to the panel (`canTake`): an app on screen on its
 *     App tab, a desktop-width window, not chromeless, not the native app,
 *     not inside the panel itself.
 *   - The two chokepoints that catch a navigation BEFORE it lands: a
 *     capture-phase click on a link, and (where the browser has the
 *     Navigation API) a script's `location.hash = …`. Both refuse the
 *     navigation, so the top window's history is untouched — reverting a hash
 *     after the fact leaves a dead Back entry. The JavaScript entry points
 *     (App.openAppTab, the Messages store) call `take` directly.
 *   - The panel's own history: a stack of the pages opened in it, then the
 *     climb to the list a page belongs to (./routes.ts parentRoute). It is kept
 *     HERE rather than in the browser's session history, because an iframe's
 *     entries are the top window's entries too — and Chromium keeps them after
 *     the frame is gone, as Back presses that do nothing.
 *   - Expand (the page, full width, leaving the app — App._syncParkedApp parks
 *     it) and Close (the panel only).
 *   - Dropping the frame when the app leaves the screen by any route:
 *     App._syncPlatformTabs, the one place that decides whether the running
 *     app is on screen, calls `appPresence`.
 *   - The top window's `?side=<route>` (SIDE_PARAM): the page the panel is
 *     showing, kept in the address with replaceState so a reload — or Back
 *     to the app — brings the panel back where it was. Written while the
 *     panel is open, removed when it closes or goes with the app.
 */

import { isEmbeddedPanel } from '../../lib/side-panel-mode';
import { isBotChatRoute } from '../ai/door';
import { stashWorkshopPanelItem, WORKSHOP_SIDE_QUERY } from '../dev-board/workshop/panel-target';
import {
  embeddedAllows,
  frameUrl,
  isPanelRoute,
  isPointer,
  isShellAddress,
  parentRoute,
  routeFromUrl,
  samePage,
  titleFor,
  workshopItemOf,
} from './routes';
import { INITIAL, sidePanelRefs, sidePanelStore } from './store.js';

/**
 * The panel needs room for both: about 480px of app beside
 * `clamp(360px, 36vw, 560px)` of panel. The rail and the app layer switch to
 * their desktop layout at 768px (`md`), where the app would be left 408px;
 * 1024px (`lg`, which app.css already uses) is the first breakpoint at which
 * the app keeps at least 480px — 655px, in fact. Keep in step with the
 * `(min-width: 1024px)` block in public/css/app.css.
 */
export const DESKTOP_QUERY = '(min-width: 1024px)';

/**
 * 1 Nov 2026: beside the Homeroom bot tab's page the panel is the column a
 * thread docks in, which the page draws from 768px (features/ai/), so it
 * takes a page there from 768px too: there is no app beside it to keep
 * 480px for. Keep in step with the `(max-width: 1023.98px)` rule for
 * #platform-side-panel in public/css/app.css.
 */
export const BESIDE_AI_QUERY = '(min-width: 768px)';

/**
 * Whether a link to `route` opens in the panel: a panel page, and not the
 * chat with Homeroom bot, which only its tab draws (features/ai/door.ts) and
 * the router takes there.
 */
function panelTakes(route: string): boolean {
  return isPanelRoute(route) && !isBotChatRoute(route);
}

/**
 * What the page in the panel publishes for its column (#6431): its status
 * pill, exactly as its own bar draws it, and the key its ⋯ lists its rows
 * under in AppView's card menus. The panel's document (./embedded.ts) sends
 * it with the route it was published on, so a pill never shows on a page it
 * was not read from.
 */
export interface PanelHeadReport {
  kind: 'request' | 'change';
  pill: unknown | null;
  menuKey: string | null;
}

/** What the door says of the page it opens in the panel, for the column's header row. */
export interface PanelHint {
  /**
   * The project of the page being opened, as the door names it (the AI
   * tab's list: its row's tile and name). Beside that page the header row
   * draws it as the way to the project (./side-panel.tsx).
   */
  place?: { slug: string; name: string; icon_url?: string | null; icon_emoji?: string | null } | null;
  /**
   * What the page being opened is called, as the door names it (the AI
   * tab's row: a request's or a change's title). Beside that page the header
   * row titles the column with it while the panel is still on that page.
   */
  label?: string | null;
}

/**
 * The class on the panel DOCUMENT's <html> while the panel stands beside
 * the AI tab's page rather than an app. That page draws the panel as its
 * own column, with a × and the project over it (./side-panel.tsx), so
 * the page in it leaves out its own way back (app.css: the topic's
 * "‹ Workshop" chip), which would be a second one to somewhere else.
 */
export const BESIDE_AI_CLASS = 'side-panel-beside-ai';

interface AppLike {
  user?: unknown;
  chromeless?: boolean;
  currentApp?: string | null;
  currentTab?: string;
  embeddedPanel?: boolean;
  _isScreenVisible?: (id: string) => boolean;
  _rootUrl?: (hash?: string) => string;
  _routeFromHash?: () => void;
  navigateHome?: () => void;
  openAppTab?: (slug: string, tab?: string, opts?: unknown) => unknown;
}

interface EmbedLike {
  go?: (route: string) => void;
}

function app(): AppLike | null {
  return typeof window === 'undefined' ? null : ((window as unknown as { App?: AppLike }).App || null);
}

/** The panel document's own bridge, when its frame has booted that far. */
function embed(): EmbedLike | null {
  try {
    const win = sidePanelRefs.frame?.contentWindow as unknown as
      { UsernodeReact?: { sidePanelEmbed?: EmbedLike } } | null;
    return win?.UsernodeReact?.sidePanelEmbed || null;
  } catch {
    return null;
  }
}

// ── The panel's history, and the page it is headed for ─────────────────
//
// `stack` holds the pages opened in the panel before the one on screen, most
// recent last. `desired` is the page the panel should be showing — ahead of
// the document while it boots, equal to it afterwards. `ready` is whether the
// document has booted and can be told where to go.
let stack: string[] = [];
// A panel is a column of recent pages, not an archive: the oldest fall off.
const STACK_CAP = 30;
let desired: string | null = null;
let ready = false;
let reported = '';
/**
 * What the page on screen publishes for its column (#6431): its status pill
 * and the key of its own ⋯ list, with the route it published them on. Null
 * until a page that has them reports (a request's or a change's bar), and
 * cleared wherever `reported` is, so one page's pill never shows on the next.
 */
let head: (PanelHeadReport & { route: string }) | null = null;
// A reload's `?side=` being opened, once the app it stood beside is on screen.
let restoring = false;
// Set while this module navigates the TOP window itself (Expand, or a link the
// panel's document handed up), so the Navigation API intercept below lets it
// through instead of catching its own navigation.
let bypass = false;

function remember(route: string): void {
  // A `#name` channel reference is replaced by the channel it names; coming
  // back to it would only be sent on to that channel again.
  if (isPointer(route)) return;
  stack.push(route);
  if (stack.length > STACK_CAP) stack.splice(0, stack.length - STACK_CAP);
}

function publish(route: string, extra?: Record<string, unknown>): void {
  sidePanelStore.set({
    route,
    title: titleFor(route, reported),
    reported,
    head,
    canBack: stack.length > 0 || !!parentRoute(route),
    ...extra,
  });
  writeAddress(sidePanelStore.get().open ? route : null);
}

/** Is the panel beside the AI tab's page, rather than beside an app? */
export function isBesideAi(): boolean {
  const A = app();
  return !!A && typeof A._isScreenVisible === 'function' && A._isScreenVisible('ai-screen');
}

/**
 * Tell the panel's document which it is beside (BESIDE_AI_CLASS). Run as a
 * page is opened, when the document has routed its first page (before the
 * frame is shown) and whenever the screen beside it changes.
 */
function markBeside(): void {
  try {
    sidePanelRefs.frame?.contentDocument?.documentElement?.classList.toggle(BESIDE_AI_CLASS, isBesideAi());
  } catch {
    /* a frame that is going away: the next one is marked when it reports */
  }
}

// ── The panel in the top window's address ───────────────────────────────

/** The top window's query parameter naming the page the panel shows. */
export const SIDE_PARAM = 'side';

function paramKey(part: string): string {
  const key = part.split('=', 1)[0].replace(/\+/g, ' ');
  try { return decodeURIComponent(key); } catch { return key; }
}

/** The panel page a top-window query names, or null. */
export function sideRouteFrom(search: string): string | null {
  const raw = String(search || '').replace(/^\?/, '');
  for (const part of raw ? raw.split('&') : []) {
    if (paramKey(part) !== SIDE_PARAM) continue;
    let value = part.slice(part.indexOf('=') + 1).replace(/\+/g, ' ');
    try { value = decodeURIComponent(value); } catch { return null; }
    return part.includes('=') && embeddedAllows(value) ? value : null;
  }
  return null;
}

/**
 * Put `route` in the top window's address (null takes it out), in place: no
 * history entry, and every other parameter byte for byte, as the router's own
 * App._routeSearch keeps them. The router carries the query across its own
 * navigations, so this only has to follow the panel.
 */
function writeAddress(route: string | null): void {
  if (typeof window === 'undefined' || isEmbeddedPanel()) return;
  try {
    const loc = window.location;
    const raw = String(loc.search || '').replace(/^\?/, '');
    const kept = raw ? raw.split('&').filter((part) => part && paramKey(part) !== SIDE_PARAM) : [];
    if (route) kept.push(`${SIDE_PARAM}=${encodeURIComponent(route).replace(/%2F/gi, '/')}`);
    const search = kept.length ? `?${kept.join('&')}` : '';
    if (search === (loc.search || '')) return;
    window.history.replaceState(window.history.state, '', `${loc.pathname}${search}${loc.hash}`);
  } catch {
    /* an address that cannot be rewritten only loses the panel on reload */
  }
}

/**
 * Plant `route` in the top window's `?side=` parameter WITHOUT opening the
 * panel: the caller is about to navigate the top window to an app, and the
 * router's own appPresence(true) → restoreFromAddress() then opens the panel
 * on this page once the app is on screen. False in the panel's own document
 * (there is no top window to write from there); the write itself is in place,
 * no history entry, exactly as writeAddress keeps it.
 */
export function pend(route: string): boolean {
  if (typeof window === 'undefined' || isEmbeddedPanel()) return false;
  if (!isPanelRoute(route)) return false;
  writeAddress(route);
  return true;
}

/**
 * Take a parameter pend() planted back out — the caller's navigation failed,
 * or the viewer backed out before the app came on screen. The panel's own
 * give-up (restoreFromAddress) covers the reload path; this covers the
 * moment before it.
 */
export function clearPending(): void {
  writeAddress(null);
}

/**
 * The app is on screen and the address names a panel page nobody has opened
 * yet — a reload, or Back to the app: open it. The app's screen is revealed in
 * a transition after the router reports it, so this waits (briefly) for the
 * moment the panel may take a page, and gives up by taking the parameter out.
 */
function restoreFromAddress(): void {
  if (restoring || typeof window === 'undefined' || isEmbeddedPanel()) return;
  if (sidePanelStore.get().frameSrc) return;
  const route = sideRouteFrom(window.location.search);
  if (!route) return;
  restoring = true;
  let tries = 0;
  const attempt = () => {
    if (!restoring) return;
    if (sidePanelStore.get().frameSrc) { restoring = false; return; }
    if (sideRouteFrom(window.location.search) !== route) { restoring = false; return; }
    if (canTake()) {
      restoring = false;
      open(route, null);
      return;
    }
    tries += 1;
    if (tries >= 20) {
      restoring = false;
      writeAddress(null);
      return;
    }
    window.setTimeout(attempt, 100);
  };
  window.setTimeout(attempt, 0);
}

function go(route: string): void {
  const target = embed();
  if (!target || typeof target.go !== 'function') return;
  try {
    target.go(route);
  } catch {
    /* a frame that is going away mid-call: the next open starts a new one */
  }
}

/**
 * May a navigation to a panel page go to the panel right now?
 *
 * Only in the TOP document, only while the Homeroom bot tab's page is up
 * (features/ai/: the panel takes the place of Main, the chat docked beside
 * the list, so a request opened from the list keeps the list), only from
 * 768px, and not in chromeless mode. Everywhere else every one of these
 * links navigates exactly as it always has.
 *
 * NEVER BESIDE A RUNNING APP (18 Nov 2026). A request, a change or a
 * conversation opened while an app ran used to open in this panel beside
 * the app. It was a fourth way to draw a thread, at a third of the window,
 * with two headers stacked over it; such a link now leaves the app and
 * opens the page itself, as a link to a community already did.
 *
 * BESIDE THE HOMEROOM BOT TAB, THE NATIVE APP TOO (1 Nov 2026). Unfolded and
 * held sideways, iPhone Duo draws the tab's page with Main docked, and a
 * request opened from its list took the whole screen instead of the
 * column's place. That page is a root with no back arrow, so the WebView's back swipe
 * is off there already (header/native-back-navigation.ts), and the column's
 * own × is the way back.
 */
export function canTake(): boolean {
  if (typeof window === 'undefined' || isEmbeddedPanel()) return false;
  const A = app();
  if (!A || !A.user || A.chromeless) return false;
  if (typeof A._isScreenVisible !== 'function' || !A._isScreenVisible('ai-screen')) return false;
  try {
    return window.matchMedia(BESIDE_AI_QUERY).matches;
  } catch {
    return false;
  }
}

/**
 * Open `route` in the panel if this is a moment the panel takes it. Returns
 * whether it did, so a caller that asked falls through to its ordinary
 * navigation when it did not.
 */
export function take(route: string, hint?: PanelHint | null): boolean {
  if (!panelTakes(route) || !canTake()) return false;
  open(route, hint || null);
  return true;
}

/** Put `route` in the panel, starting its document if there is none yet. */
export function open(route: string, given?: PanelHint | null): void {
  const s = sidePanelStore.get();
  const { place = null, label = null } = given || {};
  if (!s.frameSrc) {
    stack = [];
    reported = '';
    head = null;
    ready = false;
    desired = route;
    sidePanelStore.set({
      open: true,
      frameSrc: frameUrl(route, window.location.search),
      frameKey: s.frameKey + 1,
      loading: true,
    });
    publish(route, { place, label: label ? { route, text: label } : null });
    return;
  }
  // A panel the viewer had closed starts a fresh history; an open one keeps
  // the page it was on as somewhere to come back to.
  if (!s.open) stack = [];
  else if (s.route && !samePage(s.route, route)) remember(s.route);
  if (!samePage(s.route, route)) { reported = ''; head = null; }
  desired = route;
  sidePanelStore.set({ open: true });
  publish(route, { place, label: label ? { route, text: label } : null });
  markBeside();
  if (ready) go(route);
}

/** Close: the panel only. The frame stays, so reopening is a navigation. */
export function close(): void {
  stack = [];
  if (sidePanelStore.get().open) sidePanelStore.set({ open: false });
  writeAddress(null);
}

/** Drop the panel and its document — the app it stood beside is gone. */
export function drop(): void {
  stack = [];
  desired = null;
  ready = false;
  reported = '';
  head = null;
  // The address is cleared only when there was a panel (or a reload's panel
  // on its way) to clear: the router reports "no app on screen" on its way
  // through boot, before it reaches the app a reloaded address names, and
  // that must not take the panel's page out from under it.
  const pending = restoring;
  restoring = false;
  const s = sidePanelStore.get();
  if (!s.frameSrc && !s.open && !s.route) {
    if (pending) writeAddress(null);
    return;
  }
  writeAddress(null);
  sidePanelStore.set({ ...INITIAL, frameKey: s.frameKey });
}

/**
 * Back: the page opened before this one, and once those are spent, the list
 * this page belongs to — a thread to Messages (a piece of work has none here:
 * its community is never the panel's). The control is hidden when there is
 * neither.
 */
export function back(): void {
  const s = sidePanelStore.get();
  if (!s.open || !s.route) return;
  const target = stack.pop() || parentRoute(s.route);
  if (!target) {
    publish(s.route);
    return;
  }
  reported = '';
  head = null;
  desired = target;
  publish(target);
  if (ready) go(target);
}

/**
 * Navigate the top window to `route` with its ordinary routing, as a real
 * history entry. Pushed and routed here rather than by assigning the hash, so
 * it runs once and at once instead of on a later hashchange.
 */
function navigateTop(route: string): void {
  const A = app();
  if (!A) return;
  bypass = true;
  try {
    if (!route) {
      A.navigateHome?.();
      return;
    }
    const url = typeof A._rootUrl === 'function' ? A._rootUrl(`#${route}`) : `/#${route}`;
    window.history.pushState(null, '', url);
    A._routeFromHash?.();
  } finally {
    bypass = false;
  }
}

/**
 * Expand: the page, full width. That leaves the app — which parks it in the
 * recent-app strip, so Resume brings it back (App._syncParkedApp) — and the
 * router's own leave drops the panel in the same transition
 * (App._syncPlatformTabs → appPresence). The drop below covers a route that,
 * for whatever reason, did not take the app off screen.
 */
export function expand(): void {
  const route = sidePanelStore.get().route;
  if (route) navigateTop(route);
  if (sidePanelStore.get().open || sidePanelStore.get().frameSrc) drop();
}

/**
 * Open in workshop (#6380): the project's Workshop, with this request, change
 * or decision in the panel beside its list, the way its own row opens it
 * there (frontend/src/features/dev-board/workshop/). The item is left for the
 * Workshop tab (../dev-board/workshop/panel-target.ts), which takes it as
 * it shows.
 *
 * A window too narrow for that panel would land on a Workshop with nothing
 * open, so it opens the item's own page instead — what Expand does, with its
 * "‹ Workshop" chip to get back. Either way the column goes with the page it
 * was showing, as it does on Expand.
 */
export function openInWorkshop(): void {
  const route = sidePanelStore.get().route;
  const item = route ? workshopItemOf(route) : null;
  if (!item) return;
  const narrow = typeof window.matchMedia === 'function' && !window.matchMedia(WORKSHOP_SIDE_QUERY).matches;
  if (narrow) {
    expand();
    return;
  }
  stashWorkshopPanelItem(item.slug, { ref: item.ref, pr: item.pr });
  try { (window as any).AppView?._landOnTab?.(item.slug, 'workshop'); } catch { /* the page's own tab */ }
  navigateTop(`app/${encodeURIComponent(item.slug)}/workshop`);
  if (sidePanelStore.get().open || sidePanelStore.get().frameSrc) drop();
}

/**
 * The router's word on whether the running app is still on screen, from
 * App._syncPlatformTabs — every route out of an app passes through it: the
 * header's close, a tab, the peeked rail, Back, Expand, chromeless, the
 * signed-out shell. Switching straight to ANOTHER app keeps the answer true,
 * and keeps the panel.
 */
export function appPresence(inApp: boolean): void {
  if (!inApp) drop();
  else {
    restoreFromAddress();
    // The app and the AI tab's page both keep the panel: from one to the
    // other, its page puts its own way back away or out again.
    markBeside();
  }
}

/** Is the panel on screen (the viewer has it open)? */
export function isOpen(): boolean {
  const s = sidePanelStore.get();
  return !!(s.open && s.frameSrc);
}

// ── What the panel's document tells this one (./embedded.ts) ───────────

/** Its first page is routed: show it, or send it where the viewer went since. */
function embeddedReady(route: string, title: string): void {
  const s = sidePanelStore.get();
  if (!s.frameSrc) return;
  ready = true;
  reported = title || '';
  // Before the frame is shown, so its page never draws a way back it is
  // about to put away.
  markBeside();
  sidePanelStore.set({ loading: false });
  if (desired && !samePage(desired, route)) {
    reported = '';
    head = null;
    publish(desired);
    go(desired);
    return;
  }
  if (route) {
    desired = route;
    publish(route);
  }
}

/**
 * It moved, or retitled. `push` is a navigation the viewer made INSIDE the
 * panel, which Back comes back from; anything else is the same page settling
 * (a canonical address, a title that loaded).
 */
function embeddedNavigated(route: string, title: string, push: boolean): void {
  const s = sidePanelStore.get();
  if (!s.frameSrc || !ready || !route) return;
  if (push && s.route && !samePage(s.route, route)) remember(s.route);
  reported = title || '';
  desired = route;
  publish(route);
}

/**
 * The panel never runs an app. Its document hands an app's App tab up here:
 * the app beside the panel is the one that is asked for (nothing to do), or
 * another app, which REPLACES the running one — and the panel stays.
 */
function embeddedOpenApp(slug: string): void {
  window.setTimeout(() => {
    const A = app();
    if (!A || !slug) return;
    if (A.currentApp === slug && A.currentTab === 'app') return;
    A.openAppTab?.(slug, 'app');
  }, 0);
}

/**
 * A link inside the panel to somewhere the panel does not go — a profile, a
 * tab, Settings: the top window goes there, which leaves the app (and so
 * drops the panel), exactly as following it from the app's own menu would.
 * On the top window's own turn of the event loop, never inside the call from
 * the frame that is about to be removed.
 */
function embeddedLeave(route: string): void {
  window.setTimeout(() => navigateTop(route), 0);
}

/** A `history.back()` inside the panel's document is the panel's Back. */
function embeddedBack(): void {
  window.setTimeout(back, 0);
}

/**
 * The page on screen publishes what its column draws (#6431): its status pill
 * and its own ⋯ key. Taken only while the document can report at all, and
 * null for a page that has neither (a decision, a private thread), so the
 * column's heading falls back to what it drew before.
 */
function embeddedHead(route: string, report: PanelHeadReport | null): void {
  const s = sidePanelStore.get();
  if (!ready || !s.frameSrc || !route) return;
  head = report && (report.kind === 'request' || report.kind === 'change')
    ? { kind: report.kind, pill: report.pill || null, menuKey: report.menuKey || null, route }
    : null;
  sidePanelStore.set({ head });
}

/** The panel document's AppView, or null while its frame is elsewhere or gone. */
function frameAppView(): any {
  try {
    return (sidePanelRefs.frame?.contentWindow as unknown as { AppView?: unknown } | null)?.AppView || null;
  } catch {
    return null;
  }
}

/** The ⋯ key of the page ON SCREEN, when the head it published is that page's. */
function headMenuKey(): string | null {
  const s = sidePanelStore.get();
  if (!head || !head.menuKey || !samePage(head.route, s.route)) return null;
  return head.menuKey;
}

/** One of the page's own ⋯ rows, as the column's menu lists it. */
export interface PanelMenuRow {
  label: string;
  title: string | null;
  disabled: boolean;
}

/**
 * The page's own ⋯ rows (#6431), read from its AppView when the menu opens —
 * the same list its own ⋯ would show, so a page that has moved on since (Notify
 * me become Mute) says so the next time the menu is drawn. The rows stay in
 * the page: this one only lists them.
 */
export function panelMenuRows(): PanelMenuRow[] {
  const key = headMenuKey();
  const av = key ? frameAppView() : null;
  if (!av || typeof av._cardMenuItems !== 'function') return [];
  try {
    const list = av._cardMenuItems(key, null);
    return (Array.isArray(list) ? list : [])
      .map((it: any) => ({
        label: String((it && it.label) || ''),
        title: it && it.title ? String(it.title) : null,
        disabled: !!(it && (it.disabled || typeof it.act !== 'function')),
      }))
      .filter((row) => !!row.label);
  } catch {
    return [];
  }
}

/**
 * Run one of the page's rows IN the page (#6431). The list is read again, so a
 * row that changed while the menu was open acts on the row whose label was
 * pressed rather than on its neighbour (`AppView._cardMenuRowItem`), exactly as
 * the page's own ⋯ does.
 */
export function runPanelMenuRow(index: number, label: string, event?: Event | null): void {
  const key = headMenuKey();
  const av = key ? frameAppView() : null;
  if (!av || typeof av._cardMenuItems !== 'function') return;
  try {
    const list = av._cardMenuItems(key, null);
    const it = typeof av._cardMenuRowItem === 'function'
      ? av._cardMenuRowItem(list, index, label)
      : (Array.isArray(list) ? list[index] : null);
    if (!it || typeof it.act !== 'function' || it.disabled) return;
    // The page's own menu stamps the click that ran a row, so the popover the
    // row opens is not dismissed inside that same dispatch (app-view.js
    // `_menuActEvent`). The click here is the column's, which the frame's
    // document never sees, so the popover it opens stays up either way.
    av._menuActEvent = event || null;
    it.act();
  } catch {
    /* the row owns its errors */
  }
}

export const embeddedApi = {
  ready: embeddedReady,
  navigated: embeddedNavigated,
  head: embeddedHead,
  openApp: embeddedOpenApp,
  leave: embeddedLeave,
  back: embeddedBack,
};

// ── The two chokepoints ──────────────────────────────────────────────────

/**
 * A plain click on a link to a panel page, in the top document. Capture phase
 * on `window`, so it runs before any handler below it and before the browser
 * follows the link: `preventDefault` here is what keeps the top window's
 * history untouched. Propagation is NOT stopped — the mark menu's rows still
 * dismiss their sheet in their own handler — and NavLink-bound handlers see
 * `defaultPrevented` and stand down (NavLink.isNativeClick).
 *
 * Modified clicks (a new tab or window) and links with a target or a download
 * are the browser's, exactly as before.
 */
export function onClickCapture(e: MouseEvent): void {
  if (e.defaultPrevented || e.button !== 0) return;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const origin = window.location.origin;
  const target = e.target as Element | null;
  const a = (target && typeof target.closest === 'function'
    ? target.closest('a[href]') : null) as HTMLAnchorElement | null;
  if (!a) return;
  // THE HEADER'S ✕ LEAVES THE APP, whatever it names. It goes back to the
  // page the app was opened from (App.closeApp), and its href names that page
  // for a modified click — a thread or a Workshop card as often as not, which
  // is a panel page. Taken here, closing the app would open that page BESIDE
  // it instead. The rail's tabs and the ✕ are the two ways out (#2854).
  // The app menu's "Go to community" is a third, and needs nothing here: a
  // community's page is never the panel's (./routes.ts), so its link is
  // followed full width like any other.
  if (a.id === 'back-btn' || a.id === 'app-menu-row-workshop') return;
  if (a.target && a.target !== '_self') return;
  if (a.hasAttribute('download')) return;
  if (!isShellAddress(a.href, origin)) return;
  const route = routeFromUrl(a.href);
  if (!panelTakes(route) || !canTake()) return;
  e.preventDefault();
  open(route, null);
}

interface NavigateEventLike {
  navigationType?: string;
  hashChange?: boolean;
  cancelable?: boolean;
  downloadRequest?: string | null;
  formData?: unknown;
  destination?: { url?: string };
  preventDefault(): void;
}

/**
 * A script's `location.hash = '#…'` to a panel page, where the browser has
 * the Navigation API: refused before it lands, and opened in the panel. Only
 * PUSHES, never a traversal — the browser's Back to a page the viewer was on
 * before opening the app is not "following a link", it is leaving the app.
 */
export function onNavigate(e: NavigateEventLike): void {
  if (bypass) return;
  if (e.navigationType !== 'push' || !e.hashChange || !e.cancelable) return;
  if (e.downloadRequest || e.formData) return;
  const url = e.destination && e.destination.url;
  if (!url) return;
  const route = routeFromUrl(url);
  if (!panelTakes(route) || !canTake()) return;
  e.preventDefault();
  open(route, null);
}

/** Install both chokepoints. The top document only. */
export function installIntercepts(win: Window): void {
  if (isEmbeddedPanel()) return;
  win.addEventListener('click', onClickCapture, true);
  const nav = (win as unknown as {
    navigation?: { addEventListener?: (type: string, fn: (e: NavigateEventLike) => void) => void };
  }).navigation;
  if (nav && typeof nav.addEventListener === 'function') {
    nav.addEventListener('navigate', onNavigate);
  }
}

/** The bridge: window.UsernodeReact.sidePanel (see ./mount.ts). */
export const SidePanel = {
  canTake,
  take,
  open,
  close,
  drop,
  back,
  expand,
  openInWorkshop,
  appPresence,
  isOpen,
  panelMenuRows,
  runPanelMenuRow,
  pend,
  clearPending,
  embedded: embeddedApi,
};

/** For tests: forget everything between cases. */
export function _resetForTests(): void {
  stack = [];
  desired = null;
  ready = false;
  reported = '';
  head = null;
  bypass = false;
  restoring = false;
  sidePanelStore.set({ ...INITIAL });
  sidePanelRefs.frame = null;
}
