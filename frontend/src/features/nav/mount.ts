/**
 * The legacy → React seam for the platform tab bar.
 *
 * Same shape as ../header/mount.ts: install the flush, publish the setter on
 * the bridge. The one writer is `App._syncPlatformTabs()` in
 * public/js/app.js, which runs inside `PlatformUI.transition`'s callback —
 * the kit captures the outgoing page from whatever that callback did to the
 * DOM before it returned, so a store notification that lands in a later task
 * would animate a bar that still lit the previous tab. `setFlush(flushSync)`
 * is what keeps the update inside that window.
 */

import { flushSync } from 'react-dom';

import { knownApp, withKnownName } from './app-names';
import { navStore, tabForScreen } from './nav-store.js';
import { parkedStore, setParked, setRunningApp } from './parked-store.js';
import { SIDEBAR_ROWS_QUERY } from './sidebar-rows';
import { forgetPin, loadPins, pinApp, pinDropStore, pinStatus, pinnedAppsStore, readPinnedApps } from './pinned-apps-store.js';
import { forgetRecentApp, readRecentApps, recentAppsStore, rememberRecentApp } from './recent-apps-store.js';
import {
  collapseIntoResume, RESUME_MOTION_MS, resumeHandleFor, takeResumeOrigin,
} from './resume-motion';

navStore.setFlush(flushSync);
// Same reason as the tab's: App.navigateToApp clears the strip inside
// PlatformUI.transition's reveal callback, and the kit captures the incoming
// page from what that callback did before it returned.
parkedStore.setFlush(flushSync);
recentAppsStore.setFlush(flushSync);
pinnedAppsStore.setFlush(flushSync);
// The "Pin here" slot must appear and clear inside the same task as the drag
// events that name it (features/home/home.js), for the same reason as the
// tab's flush above.
pinDropStore.setFlush(flushSync);

export { navStore, parkedStore };

// The desktop rail is the layout (./sidebar-rows.ts): from 768px up, where a
// screen may light a tab of its own (nav-store.js RAIL_TAB_FOR_SCREEN; none
// does since One Home retired Discover's, #6361). Asked
// when a screen is revealed, which is after hydration, so the lit tab is not
// part of the prerender's question. Unreadable answers the phone.
function railLayout(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia(SIDEBAR_ROWS_QUERY).matches;
  } catch {
    return false;
  }
}

// Whether the router named the lit tab itself (setScreen's tabOverride): a
// window resized across 768px then leaves it alone.
let tabNamed = false;

if (typeof window !== 'undefined') {
  // A WINDOW RESIZED ACROSS 768px with such a screen open moves its light:
  // from its own tab on the rail to its tab on the phone's bar, and back.
  // App.js moves the header's back slot at the same width
  // (_watchRailBreakpoint).
  try {
    window.matchMedia?.(SIDEBAR_ROWS_QUERY).addEventListener?.('change', () => {
      const { screen, tab } = navStore.get();
      if (!screen || tabNamed) return;
      const next = tabForScreen(screen, railLayout());
      if (next !== tab) navStore.set({ tab: next });
    });
  } catch { /* no matchMedia: nothing to follow */ }
  // A community left drops its pin on the account, so it goes from the
  // sidebar too (Home.MEMBERSHIP_EVENT, dispatched once the leave landed).
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('sv:membership-changed', (event) => {
      const detail = (event as CustomEvent<{ slug?: string; joined?: boolean }>).detail;
      if (detail && detail.slug && !detail.joined) forgetPin(detail.slug, navStore.get().viewer);
    });
  }
  const host = window as unknown as { UsernodeReact?: Record<string, unknown> };
  const bridge = (host.UsernodeReact ||= {});
  bridge.nav = {
    /**
     * Light the tab that owns `screenId`, or none at all.
     *
     * It takes the SCREEN, not the tab, because the router knows which root
     * it revealed and should not also have to know which of the five
     * sections owns it — that mapping is ./nav-store.js's TAB_FOR_SCREEN,
     * and keeping it on this side means a screen added later is one entry in
     * one map rather than a second list to remember in app.js.
     *
     * An unrecognised id (an app view, an auth screen, the empty string
     * before the first swap) lights nothing, which is also the prerender.
     *
     * @param screenId A root from App.SCREEN_IDS, or null/'' for none.
     * @param tabOverride Which tab to light, for the one screen the map
     *   cannot answer for. `#app-view` is TWO screens behind one id — the
     *   running app, which lights nothing, and the platform's Workshop for
     *   that app, which is the Workshop section seen through one app and
     *   lights it. TAB_FOR_SCREEN cannot express that: it is a map from
     *   screen to tab, and tests/header-back-home.test.js derives the back
     *   slot from it on the rule that a screen in that map is a tab ROOT and
     *   shows no back control — which the app view, with its ✕, is not.
     */
    setScreen(screenId: string | null, tabOverride?: string | null) {
      const screen = screenId || null;
      // `peek: false` on every screen CHANGE, because that is what a peek is
      // FOR: you reveal the rail over an app to leave it, and the thing you
      // tapped has now happened. Leaving it set would hand the next screen an
      // overlay rail on top of its own.
      //
      // ON A CHANGE, and not on every call. Re-asserting the screen you are
      // already on is not navigation, and clearing the peek there makes any
      // such call yank the rail out from under the pointer that summoned it.
      // Found with a harness that re-asserted the current screen on a 100ms
      // timer: the rail flickered at exactly that rate, on and off, because
      // each tick cleared a peek the pointer immediately re-established.
      // Nothing in the shipped router does that today, which is the whole
      // reason to fix it here rather than trust that nothing ever will.
      const changed = navStore.get().screen !== screen;
      tabNamed = !!tabOverride;
      navStore.set({
        screen,
        tab: tabOverride || (screen ? tabForScreen(screen, railLayout()) : null),
        ...(changed ? { peek: false, peekOut: false } : null),
      });
    },
    /**
     * For a classic-script caller. The shipped writer is the Messages store,
     * which is in this bundle and sets `messages` on the nav store itself
     * (../messages/store.ts syncTabBadge, #2794).
     *
     * @param count Conversations with something unread. Clamped at zero so a
     *   caller that subtracts its way negative cannot render "-1 unread".
     */
    setMessages(count: number) {
      const n = Number(count);
      navStore.set({ messages: Number.isFinite(n) && n > 0 ? Math.floor(n) : 0 });
    },
    /**
     * Name the fifth tab after the signed-in user (#2760), or put it back to
     * "Me" with null.
     *
     * The one writer is `App._syncViewer()` in public/js/app.js, called
     * wherever `App.user` is assigned and from the sweep both username
     * writers run after changing it. Trimmed, and anything that is not a
     * non-empty string clears it, so a user object that has not loaded its
     * username yet leaves the tab saying "Me" rather than saying nothing.
     *
     * @param name The username, or null/'' for nobody.
     */
    setViewer(name: string | null) {
      const viewer = typeof name === 'string' ? name.trim() : '';
      // A different account (or none) is a different Recents (#2802): the
      // list is read back for whoever is signed in now, and for nobody it
      // is empty. Nothing to do while the name has not changed.
      if ((viewer || null) !== navStore.get().viewer) {
        recentAppsStore.set({ apps: readRecentApps(viewer || null) });
        // Same rule for the sidebar's pinned communities (#5323): the pins are the
        // account's own choices, drawn at once from this device's copy and
        // then read from the account for whoever is signed in now (a
        // device's own pins from before are sent up once on the way) — and
        // any drag half-way to the "Pin here" slot belongs to the gesture
        // nobody is making any more.
        pinnedAppsStore.set({ apps: readPinnedApps(viewer || null) });
        pinDropStore.set({ drop: null });
        void loadPins(viewer || null);
      }
      navStore.set({ viewer: viewer || null });
    },
    /**
     * Whether the viewer is a private member (nav-store.js): the one writer
     * is `App._syncViewer()`, beside setViewer.
     */
    setPrivateMember(on: boolean) {
      if (!!on !== navStore.get().privateMember) navStore.set({ privateMember: !!on });
    },
    /**
     * Whether the verified-identity rule holds the viewer to it
     * (nav-store.js): written by `App._syncViewer()`, and cleared by the
     * phone sheets once a number is linked.
     */
    setIdentityNeeded(on: boolean) {
      if (!!on !== navStore.get().identityNeeded) navStore.set({ identityNeeded: !!on });
    },
    /**
     * Offer `app` above the tab bar until it is resumed or dismissed, or
     * clear the offer with null.
     *
     * It takes the app's DISPLAY DATA and not just its slug, because the
     * strip's whole promise is to be instant: a handle that has to fetch a
     * name and an icon before it can draw is a handle that appears after you
     * have given up looking for it. The caller has all four to hand — app.js
     * captures them while the app is on screen (`App._runningApp`, from the
     * record the app view loaded or the launcher's cached row) and parks that
     * capture on the way out, because every way out has cleared both records
     * by the time the screen swap runs (#2762).
     *
     * @param app `{ slug, name, iconUrl, iconEmoji }`, or null to clear.
     *
     * A capture with no record behind it (offline, a cold start has none)
     * names the app by its slug. That stand-in never replaces the name this
     * device remembers (./app-names.ts): it is named from there first, so
     * neither the strip nor the apps you left are written down as a slug.
     */
    park(app: {
      slug?: string; name?: string; iconUrl?: string | null; iconEmoji?: string | null;
    } | null) {
      const parked = app && app.slug ? withKnownName({
        slug: app.slug,
        name: app.name || app.slug,
        iconUrl: app.iconUrl || null,
        iconEmoji: app.iconEmoji || null,
      }) : null;
      // The desktop rail's Recents keeps every app you left, with when
      // (#2802). A park with null is the router clearing the strip because
      // you went back into the app; it is still recent, so nothing is removed.
      if (parked) rememberRecentApp(parked, navStore.get().viewer);
      setParked(parked);
    },
    /**
     * The app on screen now, or null when there is none (iPhone Duo's side
     * strip draws it among the tabs, lit; ./side-apps.tsx). Same display data
     * as `park`, captured at the same moment.
     */
    running(app: {
      slug?: string; name?: string; iconUrl?: string | null; iconEmoji?: string | null;
    } | null) {
      setRunningApp(app && app.slug ? withKnownName({ slug: app.slug, name: app.name || app.slug, iconUrl: app.iconUrl || null, iconEmoji: app.iconEmoji || null }) : null);
    },
    /**
     * The name and face this device remembers for `slug`, with whether it is
     * the platform's own row, or null (./app-names.ts). For the router, which
     * names the App tab's header from the launcher's cached row and has none
     * when no list of apps has loaded (`App._rememberedAppRecord`).
     */
    knownApp(slug: string) {
      return knownApp(slug);
    },
    /**
     * #3618: the app you just left shrinks into its Resume control, from
     * `from` (where the app was drawn, measured before it was hidden). A
     * no-op when that control is not on screen or motion is reduced. The
     * caller parks the app first, so the control is already drawn — every
     * store above flushes synchronously. See ./resume-motion.ts.
     */
    collapse(app: { slug?: string; name?: string; iconUrl?: string | null; iconEmoji?: string | null } | null,
      from?: { left: number; top: number; width: number; height: number } | null) {
      if (!app || !app.slug) return false;
      // Named like the control it shrinks into (./app-names.ts).
      return collapseIntoResume(withKnownName({
        slug: app.slug, name: app.name || app.slug, iconUrl: app.iconUrl || null, iconEmoji: app.iconEmoji || null,
      }), from);
    },
    /** #3618: the Resume control for `slug` on screen now, or null. */
    resumeHandle(slug: string) {
      return resumeHandleFor(slug);
    },
    /** #3618: the Resume control just pressed for `slug`, once, or null. */
    takeResumeOrigin(slug: string) {
      return takeResumeOrigin(slug);
    },
    /** #3618: how long the collapse and the expand take. */
    resumeMotionMs: RESUME_MOTION_MS,
    /** A blocked app must disappear from both desktop Recents and mobile Resume. */
    forget(slug: string) {
      if (parkedStore.get().app?.slug === slug) setParked(null);
      forgetRecentApp(slug, navStore.get().viewer);
    },
    /**
     * What a drop of `slug` on the sidebar's "Pin here" slot would do (#5323):
     * the pinned list answers, so the slot can say "Already pinned" or
     * "Unpin one first" before the drop is refused. Caller: Home's drag
     * recognizer (features/home/home.js).
     */
    pinStatus(slug: string) {
      return pinStatus(slug);
    },
    /**
     * Pin `app`'s community to the sidebar (#5323), as the account signed in
     * now. Takes the app's display data, so the sidebar draws the new pin without
     * fetching anything. Returns whether it pinned (an app already pinned,
     * or a full list, is refused).
     */
    pinApp(app: { slug?: string; name?: string; iconUrl?: string | null; iconEmoji?: string | null }) {
      return pinApp(app, navStore.get().viewer);
    },
    /**
     * The sidebar's drag state while a My apps tile is in the air (#5323):
     * 'idle' on lift, 'ok' / 'already' / 'full' while over the slot, null
     * when the gesture is over. Caller: Home's drag recognizer.
     */
    setPinDrop(state: 'idle' | 'ok' | 'already' | 'full' | null) {
      pinDropStore.set({ drop: state ?? null });
    },
  };
}
