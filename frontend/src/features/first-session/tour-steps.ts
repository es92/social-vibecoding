/**
 * The first-session tours' steps: real screens, one screen whole and then the
 * tap that leads on (./index.tsx draws them). One short title and one short
 * sentence per card: the card names the place, the screen behind it says the
 * rest (#4044, the tour script on the onboarding canvas).
 *
 * Three tours. Starting a community and joining one share their first seven
 * cards, word for word: the project on Home, the project opened, Suggest an
 * improvement in its Homeroom menu, ✕ back to Home, where to find it under
 * Communities, and its hub. The maker's ends
 * on the plan in Homeroom bot's chat, which waits there until the tour is
 * over (decision C); the invited one ends in Discussion. "Look around first"
 * has its own four cards on Home (decision E, #4072): where to start a
 * project later, and what the tab bar's places are. A private member, let in
 * by an invite link before the waitlist let them in, gets the maker's walk
 * through the project, three cards reworded for someone invited, then
 * Homeroom bot and the waitlist, the first time they reach Home (#4080,
 * #4398, privateSteps).
 *
 * Every target is the product's own control or region, found by the
 * selectors the rest of the shell already pins (tests/baselines/
 * shell-markup.json, dapp.json): nothing here draws a picture of the product.
 */

export type TourScreen = 'home' | 'app' | 'hub' | 'discussion' | 'bot';

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
  /** Where the card goes: under the target or over it (auto), at the foot of the screen, or just above or below another element. */
  place?: 'auto' | 'bottom' | { above: string } | { below: string };
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
   * What the card says instead while `when` is on screen: the maker's last
   * step, once the plan it waits for has come into the chat.
   */
  instead?: { when: string; title: string; text: string };
  /**
   * A control that draws the target when the screen holds it back, pressed
   * once if the target is not there: Home's "Show all N apps", behind which
   * a full collapsed grid keeps the New project tile (home.js createHidden).
   * The product's own handler draws it, as a finger on it would.
   */
  revealWith?: string;
  /**
   * A transcript in the cut-out: the newest of its `rows` begins just under
   * the coach card (./index.tsx showNewestBelow), so the plan's title and
   * first lines are never under the card, and as much of the rest as the
   * screen holds, its Build it included, shows below them.
   */
  newestBelowCard?: { scroller: string; rows: string };
  /**
   * The card's words say where the app opens ("<project> opens here"), so
   * the App tab's own "It opens here when it's ready." hides while the card
   * is up: the card carries `data-tour-says-where-it-opens`, which that line
   * reads (features/app-frame/app-status.tsx).
   */
  saysWhereItOpens?: boolean;
  /**
   * A step inside the Homeroom menu (APP_MENU): the tour opens the menu
   * while the step is up, Back to it included, and closes it once the reader
   * moves on, Skip included (./index.tsx). The tour is drawn over the menu
   * then, which on touch is a kit sheet above the tour's usual layer.
   */
  inMenu?: boolean;
  last?: boolean;
};

/**
 * The maker's last step: their chat with Homeroom bot, its header (the bot's
 * name and what it is doing for them) with its messages under it, as one
 * cut-out. It used to be the messages alone, under a dimmed header, and its
 * newest card began part-way down: "the chat with Homeroom bot is missing the
 * header" (Evan, on his phone, 5 October 2026). The conversation's own
 * section scopes both, so no other pane's header or transcript is measured.
 * The platform's top bar above them is drawn in too (SCREEN_HEADER).
 */
export const BOT_CHAT_HEADER = '.messages-thread-direct > .messages-thread-header';
export const BOT_CHAT_MESSAGES = '.messages-thread-direct > .messages-thread-scroll';

/**
 * The platform's top bar, drawn with the screen under it (TourStep.alongside).
 * Its top padding is the status bar's inset, so its box starts at the top of
 * the screen inside the iOS app's WebView too. The steps that show a screen
 * whole cut it out with that screen: "include the header", on the app's
 * close step, the hub and the chat with Homeroom bot (Evan, on his phone,
 * 5 October 2026).
 */
export const SCREEN_HEADER = '#platform-header';

/**
 * What sits along the foot of a platform screen: the tab bar, and the app you
 * left (the Resume strip) on top of it. "The whole screen, minus the tab
 * bar" stops above both (TourStep.endsAbove).
 */
export const BOTTOM_BARS = '#platform-parked, #platform-tabs';


/**
 * The plan waiting for its maker's Build it, in the chat with Homeroom bot
 * (../messages/bot-plan-view.tsx draws `data-bot-plan` with its state). The
 * conversation's own section scopes it, so the App tab's copy of the card
 * never counts.
 */
export const PLAN_WAITING = '.messages-thread-direct [data-bot-plan="open"]';

/**
 * The app screen's Suggest steps, the same on the invited and maker paths
 * (request #4225, reordered by #4390): the Homeroom mark at the top of the
 * app, which the reader taps, then the real menu it opens with its "Suggest
 * an improvement" button pointed at but not pressed, so no suggestion
 * starts. The copy is honest about what happens to a suggestion: Homeroom
 * bot does not always build it, and sometimes brings it to the group as a
 * request instead.
 */
export const MENU_TEXT = 'Every app has this menu. Tap it.';
export const SUGGEST_TEXT = 'It doesn\'t vanish into a feedback box: Homeroom bot starts building it for you, or brings it to the group, and you can follow along.';

/** The menu the Homeroom mark opens (../app-context/app-context-sheet.tsx). */
export const APP_MENU = '#apps-switcher-sheet';

function suggestSteps(): TourStep[] {
  return [
    {
      screen: 'app',
      target: '#platform-mark-btn',
      title: 'Suggest an improvement',
      text: MENU_TEXT,
      tap: 'Tap the menu',
    },
    {
      screen: 'app',
      target: '#improve-row-feedback',
      inMenu: true,
      ringed: true,
      title: 'Suggest an improvement',
      text: SUGGEST_TEXT,
    },
  ];
}

/**
 * Where a project's first version stands, as its App tab shows it
 * (GET /api/apps/:slug `first_version`; public/js/app-view.js
 * _firstVersionView): Homeroom bot still building it, built and waiting for
 * approval, or neither (null: the app is what there is). "You're in" reads it
 * (./index.tsx firstVersionStage); the cards no longer do, since the screen
 * behind the app's card says it (#4043, #4053).
 */
export type FirstVersionStage = 'building' | 'ready' | null;

export type TourProject = {
  slug: string;
  name: string;
  conversationId?: number | null;
};

/**
 * The project's hub, named without a possessive: "Page Turners's hub" was
 * what a name ending in s read as (first-session run-through, 5 October 2026).
 */
export function hubTitle(name: string): string {
  return `The ${name} hub`;
}

/**
 * The cards both paths open with, word for word (the tour script on the
 * onboarding canvas): the project on Home; the project opened, the app
 * screen whole with its top bar; Suggest an improvement (#4225, #4390), the
 * Homeroom mark tapped and the menu it opens; ✕, ringed alone, back to Home
 * (#4044: "focus the step on the ✕"); the Communities tab, naming the
 * project instead of "its hub and its group chat"; and the hub, by what is
 * on it (#4045). The Communities tab is ONE element, the phone's bottom bar
 * below 768px and the rail above it (features/nav/tab-bar.tsx; its key is
 * still `workshop`).
 */
function sharedSteps(slug: string, name: string): TourStep[] {
  return [
    {
      screen: 'home',
      target: `.app-card[data-slug="${slug}"]`,
      title: `${name} is on your Home`,
      text: 'Open it any time from here.',
      tap: 'Tap it',
    },
    {
      // `#app-view` holds both halves of the screen, the build's progress
      // (#app-content) and the running app (#app-frame-host), and the top
      // bar over it is drawn in too.
      screen: 'app',
      target: '#app-view',
      alongside: SCREEN_HEADER,
      title: `${name} opens here`,
      text: 'This is the app your community makes together.',
      saysWhereItOpens: true,
      place: 'bottom',
    },
    ...suggestSteps(),
    {
      screen: 'app',
      target: '#back-btn',
      title: '✕ takes you back to Home',
      text: `Open ${name} again from Home any time.`,
      tap: 'Tap ✕',
    },
    {
      screen: 'home',
      target: '#platform-tab-workshop',
      title: `You can find ${name} here`,
      text: 'Communities lists every community you\'re in.',
      tap: 'Tap Communities',
    },
    {
      // The hub whole: its top bar over it, down to the tab bar.
      screen: 'hub',
      target: '#app-content',
      alongside: SCREEN_HEADER,
      endsAbove: BOTTOM_BARS,
      title: hubTitle(name),
      text: 'The discussion and the app\'s changes are here.',
      place: 'bottom',
    },
  ];
}

/** Joining a community: nine steps, ending in its Discussion, where the people already are. */
export function invitedSteps({ slug, name }: TourProject): TourStep[] {
  return [
    ...sharedSteps(slug, name),
    {
      screen: 'hub',
      target: '[data-ws-tab-btn="discussion"]',
      title: 'Talk in Discussion',
      text: `Everyone in ${name} reads it.`,
      tap: 'Tap Discussion',
    },
    {
      screen: 'discussion',
      target: '#gc-messages, #gc-form',
      title: 'Say hi, or share an idea',
      text: 'The people using the app decide what goes in.',
      place: { above: '#gc-form' },
      last: true,
    },
  ];
}

/**
 * A PRIVATE MEMBER's tour (users.private_member_since): an invite link let
 * them into a community's app before they were let in, and they reach the
 * rest of Homeroom only through the mark menu's "Go to Homeroom" (#4080).
 * The first time they do, nine cards (request #4398): the maker's walk
 * through the project (sharedSteps), with three cards reworded for someone
 * who was invited rather than someone who made it (the app opened, Suggest
 * an improvement in its menu, and the hub), then Homeroom bot and the
 * waitlist card that is how they make apps of their own. The ✕ step has its
 * control because goHome notes the Home visit before the tour starts
 * (App._privateNoClose turns false), so the app has its ✕ again.
 */
export function privateSteps({ slug, name }: TourProject): TourStep[] {
  const [home, app, menu, suggest, close, communities, hub] = sharedSteps(slug, name);
  return [
    home,
    { ...app, text: 'You and everyone in its community use it, and make it better together.' },
    menu,
    { ...suggest, text: `Got an idea for ${name}? Suggest it here. Homeroom bot builds it, or brings it to the group, and you can follow along.` },
    close,
    communities,
    { ...hub, text: 'Talk with the group here, and vote on what changes.' },
    {
      screen: 'hub',
      target: '#platform-tab-messages',
      ringed: true,
      // What the bot is for, then where it is (#4397); the maker's and "Look
      // around first" tours keep their own card.
      title: 'Meet Homeroom bot',
      text: `Tell it what ${name} should do next, and it builds it for the group to try. It's always here in Messages.`,
    },
    {
      // The card's own heading says what it is for ("Make and share your
      // own apps"); this card says where, and what the card does.
      screen: 'home',
      target: '#home-waitlist-card',
      ringed: true,
      title: 'Your own apps start here',
      text: 'Join the waitlist to get your spot.',
      last: true,
    },
  ];
}

/**
 * Starting a community, after "Invite people later" or "Go to the Homeroom
 * app": the same first seven cards, then Messages, ending on the plan in
 * Homeroom bot's chat (when the project has one: the bot builds for this
 * account), and otherwise on the hub. The plan waits there for Build it, and
 * nothing asks for it before the tour ends (decision C): the last card says
 * the bot is working on it until a plan is in the chat, and how to answer it
 * once it is. Nothing else in the tour names the plan (./tour-running.ts).
 */
export function makerSteps({ slug, name, conversationId }: TourProject): TourStep[] {
  const steps = sharedSteps(slug, name);
  if (!conversationId) {
    steps[steps.length - 1] = { ...steps[steps.length - 1], last: true };
    return steps;
  }
  steps.push(
    {
      screen: 'hub',
      target: '#platform-tab-messages',
      title: 'Homeroom bot is in Messages',
      text: `It makes ${name} with you. You can always find it here.`,
      tap: 'Tap Messages',
      opensNext: true,
    },
    {
      screen: 'bot',
      target: `${BOT_CHAT_HEADER}, ${BOT_CHAT_MESSAGES}`,
      alongside: SCREEN_HEADER,
      // The card at the top, under the chat's header, and the plan just
      // under the card: at the foot of the screen the card covered the very
      // buttons it names, and over the plan's top it covered its title and
      // first lines (the owner, 6 and 7 October 2026).
      newestBelowCard: { scroller: BOT_CHAT_MESSAGES, rows: 'article.messages-message' },
      // Until a plan waits, nothing on the card says there is one coming:
      // the bot may ask a question first (requests #4391, #4393).
      title: `Homeroom bot is working on ${name}`,
      text: 'It\'ll let you know here when there\'s something to look at.',
      instead: {
        when: PLAN_WAITING,
        title: 'Homeroom bot has a plan for you',
        text: 'Answer it here: tap Build it, or tell it what to change.',
      },
      place: { below: BOT_CHAT_HEADER },
      last: true,
    },
  );
  return steps;
}

/**
 * "Look around first" (decision E, #4072): it used to land on Home with
 * nothing explained. Four cards on Home, each pointing at one place and
 * leading on with Next, so nobody is taken anywhere: New project, where a
 * community and its app start whenever they want one, then the tab bar's
 * Discover, Communities and Messages.
 */
export function lookAroundSteps(): TourStep[] {
  return [
    {
      screen: 'home',
      target: '#home-create-tile',
      revealWith: '#home-apps-more-btn',
      ringed: true,
      title: 'Make something any time',
      text: 'New project starts a community and its app.',
    },
    {
      screen: 'home',
      target: '#platform-tab-discover',
      ringed: true,
      title: 'Find apps in Discover',
      text: 'Open any app, or join its community.',
    },
    {
      screen: 'home',
      target: '#platform-tab-workshop',
      ringed: true,
      title: 'Communities you join show up here',
      text: 'Each one has its own hub and discussion.',
    },
    {
      screen: 'home',
      target: '#platform-tab-messages',
      ringed: true,
      title: 'Homeroom bot is in Messages',
      text: 'It makes apps with you. You can always find it here.',
      last: true,
    },
  ];
}
