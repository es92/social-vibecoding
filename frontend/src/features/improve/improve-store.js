/**
 * The Improve panel's rendered state.
 *
 * The panel replaced the header's App/Dev segmented switch: an app is now just
 * an app, and everything you can do *to* it — file feedback, open a session,
 * reach the board, read the activity feed, get at the repo — lives behind one
 * button. That makes this store the single description of "what can I do to the
 * thing currently on screen", and the panel a pure function of it.
 *
 * ── Why a plain store and not React state ──────────────────────────────
 *
 * Every writer is a classic script. `public/js/app.js` publishes the app
 * lifecycle from `App.ImproveStatus.setAppOpen()`, `public/js/app-view.js`
 * publishes the repo/version/read-only facts once `/api/apps/:slug` resolves,
 * and `frontend/src/features/dev-console/store.ts` publishes whether the
 * terminal row is worth showing. None of them can import from this bundle, so
 * they go through `window.Improve` (./improve-controller.js) and land here.
 *
 * The PANEL itself is fully React-owned — nothing in `public/js/**` writes a
 * node inside it — which is what lets it hold state at all (AGENTS.md's
 * stateful-island rule). This store is that state.
 *
 * ── The initial value is the prerender ─────────────────────────────────
 *
 * `frontend/scripts/build-shell.mjs` renders the island in Node from exactly
 * these values, so they have to describe the CLOSED, EMPTY panel: no target,
 * nothing loaded. Anything that fetches does so from an effect or a
 * controller call, never from render — a first render that disagrees with the
 * prerendered document is a hydration mismatch, and a console error on any
 * route fails proposal checks.
 */

import { createStore } from '../../lib/plain-store.js';
import { t } from '../../lib/i18n/runtime';

/**
 * The Dev screen's board, as an href, in the LAYOUT named.
 *
 * Workshop and Board are one screen in two layouts and the layout IS the
 * route — `/workshop` and `/board`, mapped back to a layout by the alias
 * block in app.js's `restoreFromHash`, which also applies it. So "go to the
 * board" is not a fixed address: `topicBackHref` and `topicWorkshopHref`
 * below (where a topic's back control and its Workshop chip point) both
 * answer it with this one expression.
 *
 * Anything that is not 'kanban' is the Workshop, matching
 * `AppView._getViewMode()`'s own terminal fallback.
 *
 * @param {string} slug
 * @param {string} boardView  'workshop' | 'kanban'
 * @returns {string}
 */
export function boardHref(slug, boardView) {
  return `#app/${slug}/${boardView === 'kanban' ? 'board' : 'workshop'}`;
}

/**
 * Where a Workshop TOPIC's back control goes, or null off a topic route.
 *
 * A topic is an issue, a proposal, a governance vote or a shared session
 * opened full-screen from the Workshop (`#app/<slug>/dev/{issues|proposals|
 * governance|shared}/<id>`, subTab 'topic'). It is still the Workshop's
 * content, so its level up is the board it was opened from, in the layout
 * that was on screen: `boardHref`.
 *
 * #2916 MOVED THAT CONTROL INTO THE PANE. It was the header's chevron; it is
 * the "‹ Workshop" chip at the top of the topic now
 * (../dev-board/topic/topic-back.tsx), and the header draws no back control
 * on these routes (../header/platform-header.tsx). Both read THIS function,
 * so the chip showing and the bar's arrow hiding are one fact rather than two
 * call sites that have to agree: a topic page has exactly one back control.
 *
 * …UNLESS IT WAS OPENED FROM MESSAGES (#3103). A proposal or issue card
 * shared into a conversation opens the same topic route, and its way back is
 * the conversation it was tapped in, not a Workshop the reader never saw.
 * The card records that as it navigates (`Improve.enterTopicFrom`),
 * `Improve.setTab` captures it as `topicOrigin`, and it wins over the board
 * here.
 *
 * @param {{ slug: string|null, tab: string|null, subTab: string|null, boardView: string, topicOrigin?: string|null }} route
 * @returns {string|null}
 */
export function topicBackHref({ slug, tab, subTab, boardView, topicOrigin = null }) {
  if (!(slug && tab === 'dev' && subTab === 'topic')) return null;
  return topicOrigin || boardHref(slug, boardView);
}

/**
 * The name the topic's back chip carries for `href`: the screen it returns
 * to. A card opened from a Messages conversation (#3103) goes back to that
 * conversation, and a chip reading "Workshop" there would promise the wrong
 * screen.
 *
 * #4486: and an item opened from All items (a row's tap on a phone, or "Open
 * as a page" from the panel beside the board) goes back to All items, which
 * is the page the project's Workshop route reopens on (`workshopTab`, the
 * tab AppView._workshopTab remembers), so the chip says so.
 *
 * 29 Oct 2026: and one opened from the Homeroom bot tab's page goes back to
 * that page, named for the bot (`#homeroom-bot`, features/ai/).
 *
 * @param {string|null} href
 * @param {string|null} [workshopTab]
 * @returns {string} "Messages", "Homeroom bot", "Workshop" or "All items", in the language on screen
 */
export function topicBackLabel(href, workshopTab = null) {
  if (backsToMessages(href)) return t('agent:topicBack.messages');
  if (backsToBot(href)) return t('agent:topicBack.bot');
  return workshopTab === 'all' && typeof href === 'string' && /\/workshop$/.test(href)
    ? t('agent:topicBack.allItems')
    : t('agent:topicBack.workshop');
}

/** Whether `href` goes back to a Messages conversation rather than a board. */
function backsToMessages(href) {
  return typeof href === 'string' && href.startsWith('#messages');
}

/** Whether `href` goes back to the Homeroom bot tab's page rather than a board. */
export function backsToBot(href) {
  return typeof href === 'string' && /^#homeroom-bot(\/|$)/.test(href);
}

/**
 * The Workshop chip a topic opened from Messages carries BESIDE its back
 * chip (#3691), or null where there is none.
 *
 * #3103 sent such a card's one chip back to the conversation, which is
 * right, and left the project the card belongs to with no way in from its
 * page. So the page offers both: "‹ Messages", the way back, and
 * "‹ Workshop", the board the chip would have gone to had the card been
 * opened there. A topic opened from the Workshop has one chip, and it is
 * already this one.
 *
 * The header and the native back-swipe keep reading `topicBackHref`: back
 * from the card is still the conversation.
 *
 * A topic opened from the Homeroom bot tab's page carries the same pair,
 * "‹ Homeroom bot" and "‹ Workshop": the way back to the page, and the way
 * into the project the thread is in (29 Oct 2026).
 *
 * @param {{ slug: string|null, tab: string|null, subTab: string|null, boardView: string, topicOrigin?: string|null }} route
 * @returns {string|null}
 */
export function topicWorkshopHref(route) {
  const back = topicBackHref(route);
  if (!back || !(backsToMessages(back) || backsToBot(back))) return null;
  return boardHref(route.slug, route.boardView);
}

/**
 * @typedef {object} ImproveState
 * @property {'app'|'platform'|null} target
 * @property {string|null} slug
 * @property {string} name
 * @property {boolean} selfHosted
 * @property {boolean} restricted
 * @property {string|null} repoUrl
 * @property {string|null} iconUrl
 * @property {string|null} iconEmoji
 * @property {string|null} iconColor  the colour dapp.json sets beside the icon, if any
 * @property {string|null} version
 * @property {boolean} deploying
 * @property {boolean} readOnly
 * @property {boolean} showTerminal
 * @property {boolean} canShare
 * @property {boolean} canReport
 * @property {string|null} topicOrigin
 * @property {'app'|'dev'|'other'} tab
 * @property {boolean} working
 * @property {'idle'|'deploying'|'downloading'|'ready'|'failed'} versionState
 *   Every value Improve.setVersionState() can publish. It read
 *   `'idle'|'deploying'|'stale'` until #2718, which is the vocabulary from
 *   BEFORE that method split 'stale' into downloading / ready / failed — the
 *   three states the panel has branched on ever since, and which this typedef
 *   had never caught up with. Nothing changed about the values; only the
 *   annotation, which had been quietly wrong for as long as a consumer
 *   happened to read the store in a way that widened it to `string`.
 * @property {boolean} appUpdateReady
 * @property {'forum'|'chat'|'topic'|null} subTab
 * @property {'workshop'|'kanban'} boardView
 */

/** @type {ImproveState} */
const INITIAL = {
  /*
   * `open` AND `adopted` USED TO LEAD THIS LIST, and they retired with the
   * surface they described (#2718 review). They were the Improve panel's
   * presentation — is it up, and is it up as a KIT sheet — and the panel is
   * gone: its two actions, its build notice and its view strip are rows of
   * the app-context sheet, whose own store holds those two flags for the one
   * surface that has them. Left here they would have been read by
   * `Improve.toggle()` and `Improve.dismissForNav()` and written by nobody.
   */
  /**
   * What Improve is ABOUT.
   *
   * `null` means there is nothing improvable on screen, so the controls that
   * act on it have no subject.
   */
  target: null,
  /**
   * The target's slug — the open app's, or the platform's own self-hosted row
   * while home is on screen (#1367, published by Home.publishImproveTarget).
   */
  slug: null,
  /**
   * Which half of the open app is on screen: its App tab or its Dev area.
   *
   * Republished from `App.switchTab()` — the one place `App.currentTab` is
   * assigned — because the App/Feed/Kanban toggle (#1367) has to render which
   * one is active, and a control that reflects state needs that state to be
   * reactive. THE UI OVERHAUL deleted the `.app-mode-seg` repaint that used to
   * sit in switchTab for exactly this reason, noting "there is no control in
   * the header reflecting which tab is active any more"; there is again, so
   * the fact is published as store state rather than repainted by hand.
   *
   * #1406 added a third value, 'other': a platform screen that is neither half
   * of an app — settings, profile, messages. Those screens now keep the improve
   * button and the view selector, and none of the selector's three segments is
   * where you are, so the control has to be able to say "none of these" rather
   * than claiming the one it would otherwise default to.
   *
   * 'app' in the initial value because that is `App.currentTab`'s own initial
   * value, so the prerender and the first client render agree.
   */
  tab: 'app',
  /** Display name for the header line. */
  name: '',
  /** True when the target is the platform's own self-hosted row. */
  selfHosted: false,
  /**
   * The target is Homeroom, for a viewer who is NOT served its self-hosted
   * row (SELF_APP_PUBLIC_VOTING off, not an admin). The platform they are
   * standing in is still the menu's subject — feedback on it and About it
   * work for everyone — but its workshop and discussion answer 404, so the
   * rows that go there are hidden rather than left leading nowhere.
   * Published by ../app-context/platform-target.js through Home.
   */
  restricted: false,
  /** `appData.repo_url`, or null — gates the About pane's Code row (GitHub's, or the git host's). */
  repoUrl: null,
  /** The open app's own artwork, for the header cluster's 28px tile. Both
      fields, because the resolver is icon_url → icon_emoji → letter and an
      app that set an emoji must not fall through to its initial. */
  iconUrl: null,
  iconEmoji: null,
  /** The project's colour when its dapp.json sets one (`icon.color`); null
      means the page derives one from the icon (lib/community-color.ts). */
  iconColor: null,
  /** Short commit sha for the version row, or null while unknown. */
  version: null,
  /** Whether a deploy is in flight for the target — renders as a pill. */
  deploying: false,
  /** `AppView.readOnly` — hides the two write actions for a non-collaborator. */
  readOnly: false,
  /** Whether the developer terminal is meaningful right now (an iframe is up). */
  showTerminal: false,
  /** Whether the target is running and has a URL, i.e. whether Share works. */
  canShare: false,
  /** Report eligibility from the app API; unknown targets cannot be reported. */
  canReport: false,
  // `sessions`, `otherSessions`, `loadingSessions` and `sessionsLoaded` held
  // the cross-app list of the viewer's changes in flight. Its last surface,
  // Messages' Agents section, went on 16 Nov 2026, and the list with it.

  // ── The indicators the store carries with the panel shut ─────────────
  //
  // These used to be painted onto other controls by classic modules that
  // resolved a span by id and wrote `classList` / `textContent` into it.
  // Their nodes are React-owned now, so they are state here and the component
  // renders them — the same reason #feedback-queue-dot goes through the
  // visibility store rather than being toggled by id.
  //
  // Neither was ever derived from a loaded session list: both have to be
  // true with nothing open. They come from sources that run at boot instead —
  // SessionState's live entries and the platform version pill.
  //
  // There used to be a third and a fourth, `sessionUnread` / `sessionDone`:
  // the unread session count Notifications._renderBadge published so the
  // header's Improve button could render it. #1610 retired both. The count is
  // on the bell now, because the bell's list is the only surface that can mark
  // a session notification read, and a number on a control that cannot clear
  // it is what sent the reporter back to press Improve a second time.

  /**
   * A dev session the viewer can see is mid-turn. Drives #improve-working-dot,
   * so "something is running" is legible without opening anything — which is
   * why that dot followed the control it sat on rather than going with it when
   * #2718 retired #improve-btn: it is on the Homeroom mark now
   * (../header/platform-mark.tsx), the one thing on screen on every route.
   * From `SessionState.anyActive()`.
   */
  working: false,
  /**
   * The platform version row's state, mirrored onto the hamburger's dot:
   * amber while a deploy is in flight, violet once the platform has rolled
   * past the SHA this tab loaded against.
   */
  versionState: 'idle',
  /**
   * A build of THIS app landed while the app was on screen (its
   * app_redeploy_status broadcast ended without failing) and the frame is
   * still showing the build before it. Drives the button's arrow glyph and
   * the panel's reload row; cleared by the reload, by a new build starting,
   * and by a change of target.
   */
  appUpdateReady: false,
  /**
   * Which dev sub-view is on screen ('forum' | 'chat' | 'topic'), or null
   * off the Dev half. Republished with `tab` from App.switchTab.
   */
  subTab: null,
  /**
   * WHICH LAYOUT THE DEV SCREEN IS IN — 'workshop' or 'kanban'.
   *
   * Read by the header's back arrow on the sub-views that are reached FROM
   * the board: a topic (an issue, a proposal, a governance proposal, a shared
   * session) and the general chat. Those pointed unconditionally at
   * `#app/<slug>/board`, which sent a viewer who had opened a card from the
   * Workshop to the Kanban board instead of back where they were — and,
   * because that route APPLIES its layout, quietly rewrote their stored
   * preference to kanban on the way.
   *
   * Republished with `tab` and `subTab` from App.switchTab, so it names the
   * layout that was on screen when the sub-view was entered. It is a MIRROR
   * of `AppView._getViewMode()`, which stays the source of truth; the initial
   * value here is that function's own fallback rather than a stored one,
   * because a store INITIAL is what the prerender renders.
   */
  boardView: 'workshop',
  /**
   * WHERE THE OPEN TOPIC WAS ENTERED FROM, as an href, when that was not its
   * board — or null (#3103). Only a door that knows says so: a shared card
   * in a Messages conversation records the conversation's address before it
   * navigates (`Improve.enterTopicFrom`). `topicBackHref` prefers it to the
   * board. Kept across re-publishes of the topic route, cleared by any other
   * route and by leaving the app view (App._showOnlyScreen).
   */
  topicOrigin: null,
};

export const improveStore = createStore(INITIAL);
