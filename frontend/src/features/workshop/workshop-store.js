/**
 * The Needs you page's state (`#workshop-screen`, ./index.tsx).
 *
 * A plain store rather than component state for the same reason Messages
 * has one: the page is entered by the legacy router
 * (`App.navigateToWorkshop`, public/js/app.js), which is a classic script and
 * cannot import from this bundle. It reaches the controller in ./index.tsx by
 * name through `window.UsernodeReact.workshop`, and that controller writes
 * here.
 *
 * ── The initial value IS the prerender ─────────────────────────────────
 *
 * `open: false` renders the page exactly as the shipped document has it:
 * `hidden`, with nothing in it. Nothing is fetched during render — the load
 * runs from the controller's `open()` — so the SSG pass and the first client
 * render agree and hydration is silent. A console error on any route fails
 * proposal checks, which is what makes that a rule rather than a preference.
 *
 * It held the Communities screen's list too (its rows, their load error and
 * which of the list and the feed was up) until One Home (#6361) left the
 * feed alone on the page.
 */

import { createStore } from '../../lib/plain-store.js';

/**
 * @typedef {object} WorkshopState
 * @property {boolean} open   The router has this page on show.
 * @property {Array<object>|null} feed  GET /api/workshop/needs-feed: every
 *   decision owed by the viewer across their projects, newest first, which
 *   the page draws as one feed (#3270). Null until it answers.
 * @property {boolean} feedError  That read failed; the feed says so.
 * @property {boolean} feedCapped  The read stopped at its bound.
 */

/** @type {WorkshopState} */
const INITIAL = {
  open: false,
  feed: null,
  feedError: false,
  feedCapped: false,
};

export const workshopStore = createStore(INITIAL);
