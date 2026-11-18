/**
 * The first-session tours' steps: real screens, each card pointing at one
 * place (./index.tsx draws them). One short title and one short sentence per
 * card: the card names the place, the screen behind it says the rest (#4044).
 *
 * Two tours, both on Home, and neither takes anybody anywhere while it runs:
 * every card rings its place and leads on with Next. The maker's walk, done,
 * then opens its project's hub (./index.tsx walkDoneLanding).
 *
 *   walk   "1, 2, 3 on Home" (Evan, 15 Oct 2026, the onboarding canvas's
 *          "A tip in the app, then 1, 2, 3 on Home"). A newcomer's first
 *          session hands them their app first, full screen, with one tip
 *          under the Homeroom mark (./app-tip.tsx). The first time Home
 *          shows after that, three cards about their own project: its
 *          tile, Homeroom bot in Messages (with a change they could ask for
 *          in it, when its starter has one), and Communities, where its hub
 *          is (homeWalkSteps). An invited private member gets the same
 *          three: no waitlist card, which they find on Home for themselves
 *          (Evan, 20 Oct 2026).
 *   look   "Look around first" (decision E, #4072): four cards on Home,
 *          where to start a project later and what the tab bar's places are
 *          (lookAroundSteps).
 *
 * The walk replaced three longer tours that walked through the app, its
 * Homeroom menu, ✕, the hub and (for an invited person) #general, pressing
 * each control in turn. The tip says what the menu is for, in the app, and
 * the walk says where everything else is, on Home.
 *
 * Every target is the product's own control or region, found by the
 * selectors the rest of the shell already pins (tests/baselines/
 * shell-markup.json, dapp.json): nothing here draws a picture of the product.
 *
 * The words are read from the catalog (frontend/locales/en/onboarding.json)
 * when a tour's steps are built, never at module load, so they are in the
 * language on screen; ./index.tsx builds them again when it changes.
 */

import { t as translate } from '../../lib/i18n/runtime';

export type TourScreen = 'home' | 'app' | 'hub' | 'discussion' | 'bot';

/**
 * What a step that points at the project's app waits for (#4900,
 * ./tour-wait.ts): `running`, its tile on Home, until a tap on it opens it
 * (the tile's status is no longer "Spinning up..."); `open`, the app on its
 * own screen, until it has opened (its "Opening..." cover gone); `hub`, the
 * project's hub, until it is drawn whole (onboarding run two, 12 Oct 2026:
 * the hub's card stood over Home, then a blank page, then skeleton rows,
 * then a first draft of the hub and the hub itself, 2.35s in all, the ring
 * jumping as it redrew).
 */
export type AppWait = 'running' | 'open' | 'hub';

export type TourStep = {
  screen: TourScreen;
  /** Selector(s); several are drawn as one cut-out around all of them. */
  target: string;
  /**
   * Drawn into the same cut-out once the target is on screen: the top bar
   * over a screen (SCREEN_HEADER). It never stands in for the target, so a
   * screen that has not opened still dims whole and opens itself.
   */
  alongside?: string;
  /**
   * Bars the cut-out stops above (BOTTOM_BARS): every screen runs on under
   * the phone's tab bar, so a cut-out of the screen took the bar in with it.
   * Only a bar lying across the cut-out's foot counts; the rail beside the
   * screen from 768px up takes nothing off.
   */
  endsAbove?: string;
  /**
   * A tap step whose cut-out shows more than its control: the control itself,
   * the one press that leads on. It is what is ringed, and the only part of
   * the cut-out a press reaches. Without it, the target is the control.
   */
  press?: string;
  title: string;
  text: string;
  /**
   * A step the reader finishes by pressing its control: the hint shown instead
   * of Next. The hint presses that control too (./index.tsx pressTarget).
   */
  tap?: string;
  /**
   * Where the card goes: under the target or over it (auto), at the foot of
   * the screen, just above or below another element, or clear of a surface
   * whole (`{ clear }`: over it with a gap where a card fits, else under it;
   * ./card-placement.ts clearOf).
   */
  place?: 'auto' | 'bottom' | { above: string } | { below: string } | { clear: string };
  /** Pressing the target lands on a list; open the next step's screen itself (the bot's chat, not the inbox). */
  opensNext?: boolean;
  /**
   * A step that points at one control without asking for the press ("Look
   * around first": Next leads on). The control is ringed as a tap step's is,
   * and covered like the rest of the cut-out, so a press on it does not take
   * the reader out of the tour.
   */
  ringed?: boolean;
  /**
   * A control that draws the target when the screen holds it back, pressed
   * once if the target is not there: Home's "Show all N apps", behind which
   * a full collapsed grid keeps the New project tile (home.js createHidden).
   * The product's own handler draws it, as a finger on it would.
   */
  revealWith?: string;
  /**
   * The card's words say where the app opens ("<project> opens here"), so
   * the App tab's own "It opens here when it's ready." hides while the card
   * is up: the card carries `data-tour-says-where-it-opens`, which that line
   * reads (features/app-frame/app-status.tsx).
   */
  saysWhereItOpens?: boolean;
  /**
   * A step that points at the app itself waits for it to be ready (AppWait),
   * so no card stands over a tile that cannot be opened yet or over the app's
   * loading screen (onboarding run, 12 Oct 2026, #4900). Meanwhile its card
   * says the app is getting ready, with Skip and Back; it waits at most
   * ./tour-wait.ts TOUR_WAIT_MAX_MS, then shows as it always did.
   */
  waitsFor?: AppWait;
  /**
   * A step inside the Homeroom menu (APP_MENU): the tour opens the menu
   * while the step is up, Back to it included, and closes it once the reader
   * moves on, Skip included (./index.tsx). The tour is drawn over the menu
   * then, which on touch is a kit sheet above the tour's usual layer.
   */
  inMenu?: boolean;
  /**
   * The tour's last card. A last tap step ends the tour when its control is
   * pressed, and the press goes on to the control.
   */
  last?: boolean;
};

/**
 * The platform's top bar, drawn with the screen under it (TourStep.alongside).
 * Its top padding is the status bar's inset, so its box starts at the top of
 * the screen inside the iOS app's WebView too.
 */
export const SCREEN_HEADER = '#platform-header';

/**
 * What sits along the foot of a platform screen: the tab bar, and the app you
 * left (the Resume strip) on top of it. "The whole screen, minus the tab
 * bar" stops above both (TourStep.endsAbove).
 */
export const BOTTOM_BARS = '#platform-parked, #platform-tabs';

/** The menu the Homeroom mark opens (../app-context/app-context-sheet.tsx). */
export const APP_MENU = '#apps-switcher-sheet';

/**
 * Where a project's first version stands, as its App tab shows it
 * (GET /api/apps/:slug `first_version`; public/js/app-view.js
 * _firstVersionView): Homeroom bot still building it, built and waiting for
 * approval, or neither (null: the app is what there is). The made screen
 * hands it on (./made.tsx madeStage): an app that is not live yet is not
 * opened for its maker, who goes to Home and its walk instead.
 */
export type FirstVersionStage = 'building' | 'ready' | null;

/** The project's tile in Home's own grid (#app-list), never a card of the same app elsewhere on Home. */
export function tileOf(slug: string): string {
  return `#app-list .app-card[data-slug="${slug}"]`;
}

/**
 * The Communities tab (features/nav/tab-bar.tsx), the same element on a
 * phone's bar and on the sidebar from 768px up: its page lists the reader's
 * communities, the walk's project's among them, each a tile that opens its
 * hub. The walk pointed at that community's own tile on Home while Home
 * listed them (One Home, #6361).
 */
export const COMMUNITIES_TAB = '#platform-tab-workshop';

/** Home's New project control: the grid's last tile, or the filled button beside search in a look that draws one. */
export const NEW_PROJECT = '#home-create-tile, #home-new-project-top';

/**
 * The project a walk is about: its slug (the tile), its name, the change
 * its Homeroom bot card offers as an example, and whether its reader is a
 * private member (the waitlist card).
 */
export type HomeWalkProject = {
  slug: string;
  /** What the cards call it ("Best Brunch lives here, on Home."); the slug when it has none. */
  name?: string;
  /**
   * A change somebody could ask for in this app ("add a cheap eats tier"):
   * its ready-made starter's (GET /api/apps/:slug `exampleChange`,
   * services/app-templates.js). None for any other project, or before it is
   * known: the card then says where Homeroom bot is instead.
   */
  example?: string | null;
};

/**
 * The walk on Home (see the header): three cards, each ringing its place,
 * with Next, and Go to community on the last. Nothing is
 * pressed: the tile is pointed at, not opened. Each card is about the
 * reader's own project (Evan, 15 Oct 2026, "a more contextual tour"): where
 * it lives, a change they could ask Homeroom bot for in it, and its hub.
 */
export function homeWalkSteps({ slug, name, example = null }: HomeWalkProject): TourStep[] {
  const app = name || slug;
  const steps: TourStep[] = [
    {
      screen: 'home',
      // Home's own grid only: the Discover rail's cards are `.app-card`s
      // with a slug too (onboarding run three, 12 Oct 2026).
      target: tileOf(slug),
      ringed: true,
      title: translate('onboarding:firstSession.walk.home.title'),
      text: translate('onboarding:firstSession.walk.home.text', { app }),
    },
    {
      // The tab bar's own tabs, the same elements on a phone's bar and on
      // the rail from 768px up (features/nav/tab-bar.tsx).
      screen: 'home',
      // #6019: the Homeroom bot's chat is the AI tab.
      target: '#platform-tab-ai',
      ringed: true,
      title: translate('onboarding:firstSession.walk.bot.title'),
      text: example
        ? translate('onboarding:firstSession.walk.bot.textExample', { example })
        : translate('onboarding:firstSession.walk.bot.text', { app }),
    },
    {
      // The Communities tab: its page lists the project's community, pinned
      // for its maker (and for a joiner) by the server.
      screen: 'home',
      target: COMMUNITIES_TAB,
      ringed: true,
      title: translate('onboarding:firstSession.walk.communities.title'),
      text: translate('onboarding:firstSession.walk.communities.text', { app }),
    },
  ];
  steps[steps.length - 1] = { ...steps[steps.length - 1], last: true };
  return steps;
}

/**
 * "Look around first" (decision E, #4072): it used to land on Home with
 * nothing explained. Four cards on Home, each pointing at one place and
 * leading on with Next, so nobody is taken anywhere: New project, where a
 * community and its app start whenever they want one, then the communities
 * to join under it, then the Communities tab, whose page is where the ones
 * you join go; and last the AI tab.
 */
export function lookAroundSteps(): TourStep[] {
  return [
    {
      screen: 'home',
      target: NEW_PROJECT,
      ringed: true,
      title: translate('onboarding:firstSession.tour.look.make.title'),
      text: translate('onboarding:firstSession.tour.look.make.text'),
    },
    {
      screen: 'home',
      // One Home (#6361): Discover's directory is Home's Communities to join.
      target: '#home-join-section',
      ringed: true,
      title: translate('onboarding:firstSession.tour.look.discover.title'),
      text: translate('onboarding:firstSession.tour.look.discover.text'),
    },
    {
      screen: 'home',
      // Joining pins a community on the Communities tab's page.
      target: COMMUNITIES_TAB,
      ringed: true,
      title: translate('onboarding:firstSession.tour.look.communities.title'),
      text: translate('onboarding:firstSession.tour.look.communities.text'),
    },
    {
      screen: 'home',
      // #6019: the Homeroom bot's chat is the AI tab.
      target: '#platform-tab-ai',
      ringed: true,
      title: translate('onboarding:firstSession.tour.look.bot.title'),
      text: translate('onboarding:firstSession.tour.look.bot.text'),
      last: true,
    },
  ];
}
