/**
 * The five steps of the welcome tour, as data.
 *
 * Kept as a plain table with no React in it so the order, the wording, the
 * anchoring and the interaction rules can be asserted without rendering
 * anything (tests/home-tour.test.js). The overlay in ./index.tsx is the only
 * reader.
 *
 * ── Every step points at a REAL control ────────────────────────────────
 *
 * Nothing here is a drawing of the product. The Improve steps used to be the
 * hard case, because Improve, Feedback, New change and Workshop all read as
 * things that live inside an app while the tour stays on Home. They are not:
 * on Home the target is the platform's own self-hosted row
 * (`Home.publishImproveTarget`, #1367), so the real controls are there to be
 * pressed and the tour spotlights them where they are.
 *
 * ── #2718 put a menu in front of that arc, then folded it in ───────────
 *
 * The step pointed at `#improve-btn`, a header pill that is retired. It became
 * a ROW of the app's own menu, opening a panel that held two buttons, a list
 * of sessions and a build notice. Its review retired that panel too: the
 * Workshop had taken the sessions, which left a drawer you opened in order to
 * press one of two buttons. Both buttons and the notice are in the menu now
 * (../../app-context/app-context-sheet.tsx), so the step that taught "press
 * Improve, a panel opens" and the step that taught "the mark opens the menu"
 * were teaching one press. They are one step.
 *
 * That is what `interactive`, `advanceOn` and the two flags below are for:
 *
 *   * `interactive` lets the cut-out pass clicks through to the control it is
 *     drawn around, while the dimmed area keeps blocking them. Exactly ONE
 *     step has it: the menu step, which the viewer completes by pressing the
 *     real mark. Everything else is described, not driven — see "shown, not
 *     pressed" below.
 *   * `advanceOn: 'menu-open'` is a step that ends when the menu opens, which
 *     the overlay learns by subscribing to appContextStore. The press is
 *     never intercepted; the tour only watches. Its Next does not skip the
 *     step: it opens the menu through the controller's own `open()`, the
 *     same thing the mark does, and the watcher advances the tour from
 *     there — so a viewer who reads "press it" as "press Next" still lands
 *     on step 4 with the menu up.
 *   * `needsPanel` marks the steps whose target is inside that menu: Give
 *     feedback and New change. If it is not open they cannot be shown, and
 *     ./index.tsx falls back to the menu step rather than spotlighting
 *     nothing. The name is the one every reader of this file already knows;
 *     what it names is the surface, and the surface moved.
 *   * `closesPanel` shuts the menu through the controller's own
 *     `Improve.close()` — which forwards to AppContext now — before pointing
 *     at something the menu would cover. Never by writing to either subtree,
 *     both of which are React-owned.
 *
 * ── Everything but the menu press is shown, not pressed ────────────────
 *
 * Feedback, New change and Workshop spent a round `interactive`, on the
 * argument that pressing a control is a thing a viewer may do while the tour
 * is pointing at it. In use it is the other way round: every one of them
 * LEAVES the tour. Feedback presents a kit dialog, New change starts a
 * session, and a tab navigates off Home — so a viewer partway through the
 * tour, following a spotlight that reads as an instruction, lands somewhere
 * else with the tour paused behind them. ./index.tsx's pause and
 * fallback rules recover from that, which is not the same as it being a good
 * thing to invite.
 *
 * The keyboard already said as much. The focus move and the Tab handler in
 * ./index.tsx both open up only for a step with `advanceOn`, so no target but
 * the menu's has ever been reachable from a keyboard while its step was up;
 * the cut-out passing a POINTER through was the odd one out. Both halves
 * agree now: the spotlight describes the control, Next moves on, and it is
 * pressable again the moment the tour is done with it.
 *
 * ── `targets`: a LIST, first visible one wins ──────────────────────────
 *
 * A step points at an element that may or may not be on screen, so each one
 * names candidates in preference order and ./spotlight.ts takes the first
 * that is in the document, unhidden and has a box. A step whose list resolves
 * to nothing still runs: the screen dims whole and the card centres.
 */

export interface TourStep {
  /** Stable id, used for keys and for the tests that pin the order. */
  id: string;
  /** The card's heading. */
  title: string;
  /** The card's body copy. One short paragraph, plain language. */
  body: string;
  /** Candidate selectors for the spotlight, in preference order. */
  targets: readonly string[];
  /** The cut-out passes clicks through to the control it is drawn around. */
  interactive?: boolean;
  /** The step ends when the menu opens; its Next opens the menu. */
  advanceOn?: 'menu-open';
  /** The target is inside the Improve panel, so the panel has to be open. */
  needsPanel?: boolean;
  /** Shut the Improve panel and the app's menu on the way in. */
  closesPanel?: boolean;
}

/*
 * ── #3240: four stops, and only when asked ─────────────────────────────
 *
 * The tour used to start by itself right after "What communities do you want
 * to join?" (../../auth/communities-first-run.js), and the two said the same
 * things back to back: a welcome, then Discover, then where communities live.
 * It starts only when asked now, from the first row of Home's Getting started
 * card (../getting-started.tsx) or from Settings, and it keeps the four stops
 * nothing else on the first run covers: the shortcuts on Home, the mark that
 * opens the menu inside every app, the two actions in that menu, and where to
 * find the tour again. Welcome, Workshop, Discover and Getting started left:
 * the join screen and the card already say each of them, and the card is the
 * thing the viewer has just pressed.
 */
/*
 * ── #3567: a fifth stop, first: what a community is ─────────────────────
 *
 * The join screen asks which communities to join and never says what one
 * does, and the four stops above take it for granted: Shortcuts names a
 * private community's mark, Ask for a change posts a request "the members"
 * vote on. So the tour opens on the idea everything after it rests on:
 * communities build projects together, by proposing changes and voting them
 * in. It names the three audiences the way the screen does (AGENTS.md,
 * "Communities own projects"): Just you, a Private community, a Public
 * community. It points at the Communities tab, which is where the ones you
 * are in live, and like every step but the menu's it describes its target
 * rather than asking for a press: the tab navigates off Home.
 */
export const TOUR_STEPS: readonly TourStep[] = [
  {
    // The Communities tab: the bottom bar on a phone, the rail from 768px
    // up. Its key and id are still `workshop` (../../nav/tab-bar.tsx); the
    // word on it is Communities wherever it is (#3709), and its glyph is the
    // community it is on, which is why the copy says "here" rather than
    // describing what the tab shows.
    id: 'communities',
    title: 'Communities',
    body: 'Homeroom is made of communities that build projects together. Anyone in one can propose a change, and the group votes it in. A community is Just you, a Private community or a Public community. Yours are here.',
    targets: ['#platform-tab-workshop'],
  },
  {
    // The Shortcuts section, heading and grid together, so the card never
    // sits on the heading the step is about. `#app-list` is the fallback
    // for a section that has not rendered its box yet.
    id: 'apps',
    title: 'Shortcuts',
    body: 'The apps you keep close. A small mark says where each one lives: people for a private community, a lock for one that is just yours. The last tile starts a new project.',
    targets: ['#home-apps-section', '#app-list'],
  },
  {
    // ONE STEP, WHERE THERE WERE TWO (#2718 review). The arc was "press the
    // Improve row, the panel opens, here are its rows" and separately "the
    // mark opens the app's menu". The panel is retired and its two actions
    // are rows of that menu, so both steps were teaching the same press.
    //
    // The step still ends on the menu opening, whoever opens it: the
    // viewer's press on the mark, or Next, which opens the menu the same
    // way rather than skipping past it — the next step points INSIDE the
    // menu, so a Next that only moved the counter would land on nothing.
    id: 'app-menu',
    title: 'The Homeroom menu',
    body: 'Inside any app, this mark opens its menu. Tap it, or tap Next to open it.',
    targets: ['#platform-mark-btn'],
    interactive: true,
    advanceOn: 'menu-open',
  },
  {
    // The menu's one button, Ask for a change, in its well
    // (`#improve-quick-actions`, ../../improve/actions.tsx). It was Give
    // feedback and New change side by side, and people found both
    // confusing; the step says what the button does and where making the
    // change yourself went. B8: the request goes to Homeroom bot, which
    // builds it (or, where it does not build, it goes to the group), and
    // making it yourself is Build it yourself.
    id: 'menu-actions',
    title: 'Ask for a change',
    body: 'Tell Homeroom bot what should change. It builds it for you, or passes it to the group as a request. To build it yourself with a coding agent, tap Build it yourself.',
    targets: ['#improve-quick-actions', '#improve-row-feedback'],
    needsPanel: true,
  },
  {
    // THE STEP THAT LEAVES THE MENU: the step before it points inside the
    // menu, and the tab this one points at is behind it on a phone.
    //
    // `#app-switcher-btn` until #2718, which retired the chip. Settings is a
    // row of the Profile screen the Me tab lands on, so the tab is where this
    // step points — the control that gets you there, rather than the sheet
    // that used to list it. The copy said "under Me" until #2760 named that
    // tab after the signed-in user, so it names the place instead of a label
    // the tab no longer shows.
    id: 'settings',
    title: 'Replay this any time',
    body: 'You can replay this tour any time from Settings, on your profile.',
    targets: ['#platform-tab-me'],
    closesPanel: true,
  },
];

export const TOUR_LENGTH = TOUR_STEPS.length;

/**
 * The step the menu arc falls back to.
 *
 * It is THE step on Home in that arc: the one whose target is on screen
 * whatever else is or is not open. A viewer who closes the menu, or who comes
 * back from a feedback draft or a new change, lands here and is asked to
 * press the mark again.
 *
 * Derived rather than written down, so the table stays the one source of the
 * order: it is the step with `advanceOn`.
 */
export const IMPROVE_STEP_INDEX = TOUR_STEPS.findIndex(
  (step) => step.advanceOn === 'menu-open',
);

/** Clamp an index onto the table, so no caller can walk off either end. */
export function clampIndex(index: number): number {
  if (!Number.isFinite(index)) return 0;
  return Math.max(0, Math.min(TOUR_LENGTH - 1, Math.trunc(index)));
}

/**
 * The step Next (`dir` 1) or Back (`dir` -1) lands on from `at`: the
 * neighbour, or where it is when there is nowhere to go.
 */
export function stepFrom(at: number, dir: 1 | -1): number {
  return clampIndex(clampIndex(at) + dir);
}

/**
 * The step a tour in progress comes back at after the page reloads.
 *
 * Nothing saved, nothing to resume: the top. A panel step cannot resume as
 * itself, because a fresh document has no Improve panel open, so it lands on
 * the Improve step, which is the rule ./index.tsx already applies to a viewer
 * who shut the panel. Every other step resumes where it was.
 */
export function resumeIndex(saved: number | null): number {
  if (saved == null) return 0;
  const index = clampIndex(saved);
  return TOUR_STEPS[index].needsPanel ? IMPROVE_STEP_INDEX : index;
}

export function stepAt(index: number): TourStep {
  return TOUR_STEPS[clampIndex(index)];
}

export function isLastStep(index: number): boolean {
  return clampIndex(index) === TOUR_LENGTH - 1;
}

/** True on the step whose Next opens the menu instead of moving the counter. */
export function nextOpensMenu(index: number): boolean {
  return stepAt(index).advanceOn === 'menu-open';
}

/** The counter the card prints, e.g. "3 of 5". */
export function stepCounter(index: number): string {
  return `${clampIndex(index) + 1} of ${TOUR_LENGTH}`;
}
