/**
 * The header title's rendered state (Streamlined Concept groundwork).
 *
 * `#header-title` is on its way to becoming a React-owned control — the
 * Figma "Streamlined Concept" board makes the center of the top bar a
 * tappable "app name ⌄" tab that opens the app-context sheet. A tappable
 * control with a conditional chevron is state, and the stateful-island rule
 * says React may only render state it owns — so the title's text has to
 * arrive as store state rather than a `textContent` write from
 * public/js/app.js.
 *
 * ── Why a plain store and not React state ──────────────────────────────
 *
 * The only writer is `App.setHeaderTitle()` in public/js/app.js — a classic
 * script that cannot import from this bundle. It goes through
 * `window.UsernodeReact.headerTitle` (published in ./mount.ts) and lands
 * here, exactly the improve-store shape.
 *
 * ── The initial value is the prerender ─────────────────────────────────
 *
 * The shipped markup renders this title (see platform-header.tsx), so the two
 * are the same constant — a first client render that disagrees with the
 * prerendered document is a hydration mismatch, and a console error on any
 * route fails proposal checks.
 *
 * IT IS THE PLATFORM'S NAME. It was "dApps", the name this shell carried
 * before the platform had one, and that string is what the service worker's
 * cached document put in the chip on every load until routing replaced it
 * with "Homeroom" — a cached page naming the product something no
 * other surface calls it. The neutral starting point and the right one are
 * the same string, so there is no reason for it to be the wrong one.
 *
 * During the transition (until app-switcher-chip.tsx takes ownership of the
 * subtree) app.js DUAL-WRITES: it publishes here AND still assigns
 * `textContent` directly. The direct write is removed in the same change
 * that makes React render the text.
 */

import { createStore } from '../../lib/plain-store.js';

/**
 * ── The subtitle, and why the chip keeps the app's name ────────────────
 *
 * The Board and the Activity screens used to SET the title: you opened
 * Notes, tapped through to its board, and the chip read "Board". That threw
 * away the one fact the chip exists to carry — which app you are in — to say
 * something the screen underneath was already saying. A control that names
 * where you are should not stop naming the biggest part of where you are.
 *
 * So a destination inside an app publishes a SUBTITLE instead: the chip's
 * primary text stays the app's name and `subtitle` qualifies it. Root screens
 * (Home, Discover, Messages, Settings, a profile) publish no subtitle and the
 * chip renders exactly as before.
 *
 * It is a separate field rather than a formatted string because the two are
 * rendered at different sizes and colours, and because `document.title` wants
 * them joined the other way round — see App.setHeaderTitle.
 *
 * @typedef {object} HeaderTitleState
 * @property {string} text      The visible title — the screen's only h1.
 * @property {string} subtitle  The destination within it, or '' at the root.
 */

/** @type {HeaderTitleState} */
const INITIAL = {
  text: 'Homeroom',
  subtitle: '',
};

export const headerTitleStore = createStore(INITIAL);
