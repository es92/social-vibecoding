/**
 * #platform-tabs — which of the five places you are in, as state.
 *
 * ── Why the shell grew a tab bar ───────────────────────────────────────
 *
 * Every destination that is not inside an app used to be reachable only
 * through the app chip's menu: Home, Workshop, Discover, Challenges,
 * Messages, Profile, Settings, one list, one tap away but behind a sheet.
 * That is the shape a mini-app HOST uses for a mini-app's own options, and
 * #1443's charter said so in as many words — "one control names where you
 * are, and its menu lists everywhere you can go". The charter was right
 * about the app's options and wrong about the platform's: the hosts it was
 * modelled on (WeChat, Telegram, Discord, Slack, Teams) all keep a flat
 * per-mini-app menu AND a permanent bar of the host's own sections, and the
 * deeper rows of that menu link OUT to those sections, filtered. There was
 * no bar here for them to link out to.
 *
 * So the platform's own places move to a tab bar and the menu keeps the
 * app's. This store is that bar's half of the split: `tab` is the section
 * the router has landed on, published by app.js on every screen swap.
 *
 * ── Why a plain store, written through a bridge ────────────────────────
 *
 * The only writer is `App._showOnlyScreen()` in public/js/app.js, a classic
 * script that cannot import from this bundle. It goes through
 * `window.UsernodeReact.nav` (published in ./mount.ts) and lands here —
 * exactly the shape ../header/back-button-store.js uses, and for the same
 * reason: the bar's appearance is React's to render, so the legacy side
 * publishes a fact rather than writing a class.
 *
 * THE BAR'S VISIBILITY IS NOT HERE. It goes through
 * ../../lib/visibility-store.ts with the rest of the shell's chrome, because
 * `App.setChromeless()` can publish it BEFORE this bundle has evaluated — a
 * cold load of `#app/<slug>/app` does exactly that — and the visibility store
 * is the one that survives being written that early. See ./tab-bar.tsx.
 *
 * ── The initial value is the prerender ─────────────────────────────────
 *
 * `tab: null` renders five tabs with no `aria-current` on any of them, which
 * is precisely what frontend/scripts/build-shell.mjs emits: the prerender
 * has no route. A first client render that disagrees with the prerendered
 * document is a hydration mismatch, and a console error on any route fails
 * proposal checks. Nothing writes this store before hydration — the bridge
 * it is written through is installed by this bundle, and app.js's router
 * runs on DOMContentLoaded, after — so the first render reads INITIAL and
 * the route arrives as an ordinary update.
 */

import { createStore } from '../../lib/plain-store.js';

/**
 * @typedef {'home'|'discover'|'messages'|'workshop'|'me'} TabKey
 */

/**
 * Screen root id → the tab that owns it.
 *
 * FIVE TABS, TEN ROOTS: the bar names sections, not screens, so several
 * roots share a tab. An agent session is a conversation, so it lights
 * Messages; Leaderboard, Settings and Admin are all things about YOU or your account,
 * so they light Me. `#app-view` is absent on purpose — an app is not one of
 * the platform's places, so the rail beside a running app (on a desktop;
 * a phone's bar is hidden there) lights nothing.
 *
 * @type {Readonly<Record<string, TabKey>>}
 */
export const TAB_FOR_SCREEN = Object.freeze({
  'home-screen': 'home',
  'browse-screen': 'discover',
  'messages-screen': 'messages',
  'agent-session-screen': 'messages',
  'workshop-screen': 'workshop',
  'profile-screen': 'me',
  'leaderboard-screen': 'me',
  'settings-screen': 'me',
  'admin-screen': 'me',
  'profile-proposals-screen': 'me',
});

/**
 * @typedef {object} NavState
 * @property {string|null} screen  The screen root the router last revealed —
 *   the RAW id, `app-view` included, and null on the signed-out screens.
 *   The tab bar does not read it; the header does, because "am I inside an
 *   app" is the question that decides whether its left slot is a close
 *   button and whether the app's tile is beside its name. Keeping the fact
 *   here rather than deriving it from `tab` is the difference between "no
 *   section" and "a section the bar has no tab for": both read `tab: null`.
 * @property {TabKey|null} tab  The section that screen belongs to, or null
 *   before the first screen swap of the session — which is also what the
 *   prerendered document shows.
 * @property {number} messages  Unread conversations, for the Messages tab's
 *   badge. Zero renders no badge element at all, which is the prerender.
 * @property {number} communities  Channels of your communities with unread
 *   messages (#general among them, as Homeroom's), for the Communities tab's
 *   badge. Written by the Messages store, which already loads both lists.
 * @property {string|null} viewer  The signed-in user's username, which the
 *   fifth tab shows in place of "Me" (#2760), or null while nobody is known.
 *   Null is the prerender: the document is built in Node with no session, so
 *   it can only ever say "Me", and the first client render has to agree with
 *   it. Nothing writes this before hydration. The session snapshot's name
 *   is applied in the same task, right after hydration and before the first
 *   paint (lib/shell-snapshot-apply.ts applyNavSnapshot), and app.js
 *   publishes the verified one from App.enterAuthed: both are ordinary
 *   updates, like `tab`.
 */

/**
 * @typedef {object} PeekState
 * @property {boolean} peek  The FOLDED rail is showing over the page because
 *   the pointer is at the window's left edge or on #sidebar-toggle (#2718,
 *   #2764, desktop only; never from the edge over a running app, #3138). It is not the
 *   same fact as `platform-tabs` visibility or `railOpen` and must not be
 *   folded into either: the screens reserve no band for it, and this is a
 *   temporary overlay on top of that answer.
 * @property {boolean} peekOut  The peeked rail is FADING AWAY (#2795): the
 *   pointer left and the grace period ran out, and `peek` stays true for
 *   the ~200ms of the fade so the element is still there to fade. Only ever
 *   true while `peek` is; ./rail-peek.ts sets and clears it.
 * @property {boolean} railOpen  The viewer has the desktop rail expanded.
 * @property {boolean} identityNeeded  The verified-identity rule holds the
 *   viewer to it (GET /api/auth/me `identityNeeded`): Home's "Verify your
 *   account" card reads it (../home/verify-card.tsx). FALSE is the
 *   prerender; App._syncViewer publishes it after boot.
 * @property {boolean} privateMember  The viewer is a private member (an invite
 *   link let them in before they were let in off the waitlist): the mark menu
 *   and Home read it (../app-context, ../home/waitlist-card.tsx). FALSE is
 *   the prerender; App._syncViewer publishes it after boot.
 *   True is the prerender; see the note on INITIAL for why this is separate
 *   from the visibility store and why it is not remembered across loads.
 */

/** @type {NavState & PeekState} */
const INITIAL = {
  screen: null,
  tab: null,
  messages: 0,
  communities: 0,
  viewer: null,
  privateMember: false,
  identityNeeded: false,
  peek: false,
  peekOut: false,
  /*
      IS THE DESKTOP RAIL EXPANDED — the sidebar toggle's own state (#2718
      review).

      TRUE IS THE PRERENDER, which is what makes it safe to hold here at all:
      the shipped document has the bar visible, so the first client render
      agrees with it and hydration is silent. A collapsed rail is always
      something the viewer did.

      IT IS NOT THE VISIBILITY STORE, deliberately. `platform-tabs` there
      answers "does this ROUTE have a rail" and the router publishes it — an
      app says no, the signed-out shell says no. This answers "does the viewer
      want it", and the two compose: the bar is hidden when either says so,
      which is one line in the island and no coordination between the two
      publishers. Folding this into the visibility store instead would mean
      the next screen swap silently re-expanded a rail somebody had collapsed.

      SESSION-ONLY, not remembered across loads. A rail that came back
      collapsed on a fresh document would leave a first-time reader hunting
      for navigation that is one hover away but invisible — and the peek makes
      collapsing cheap enough that re-doing it costs nothing.
  */
  railOpen: true,
};

export const navStore = createStore(INITIAL);

/**
 * The tab a screen root belongs to, or null for a root with no tab.
 *
 * Exported rather than inlined because public/js/app.js does not read this
 * map — it publishes the screen id and lets ./mount.ts resolve it — and
 * tests/nav-tab-bar.test.js checks the resolution against App.SCREEN_IDS so
 * a screen added later cannot quietly fall through to "no tab".
 *
 * @param {string} screenId
 * @returns {TabKey|null}
 */
export function tabForScreen(screenId) {
  return TAB_FOR_SCREEN[screenId] || null;
}
