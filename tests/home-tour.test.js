// The welcome tour (#2255), which replaces the one-line #home-welcome banner
// (#1561).
//
// The banner stated the two things the launcher never says and then went away
// for good. What it could not do is POINT: "send feedback from the Improve
// button" names a control on another screen, and a new account has no way to
// tell which of the things in front of it that sentence is about. The tour
// dims the page, cuts a hole around the thing each step is about, and puts
// the sentence beside it.
//
// What is pinned here, and why each one is worth a test:
//
//   - THE STEP TABLE. Five steps in the product owner's order (#3240, and
//     #3567's communities step first), with
//     the copy they settled on, and the interaction flags that make the
//     Improve arc real rather than illustrated. The order is the whole
//     design, so a reshuffle should be a deliberate edit to this file too.
//   - ONLY WHEN ASKED (#3240). Nothing opens the tour by itself: Getting
//     started's first row and Settings' Replay ask for it, and a reload
//     under a tour in progress comes back to it.
//   - THE JUMP (#3240). No transitions: a step paints once its target has
//     held still, the dim is one rounded shape, holes stay between the
//     header and the tab bar, and the sidebar rail is not a bottom bar.
//   - THE WALK. Next, Back, Finish and their clamps, over the pure helpers
//     in tour-steps.ts, so the arithmetic is covered without a browser.
//   - THE GEOMETRY. placeCard is the part that can silently put the card off
//     screen; it is pure numbers, so it is EXECUTED here rather than grepped.
//   - PERSISTENCE. Per user id, wrapped, failing toward showing the tour --
//     the three decisions the banner's own test pinned, carried over to the
//     new key. Executed against a localStorage stub, not grepped.
//   - THE STEP ACROSS A RELOAD. The shell reloads itself under a tour in its
//     first seconds on Home (a cold boot from the worker cache switching to
//     the prefetched build, the boot session reconcile), and a tour that only
//     remembered "finished" started over at step 1 every time. The step rides
//     sessionStorage, the auto-start resumes there, and the automatic reload
//     waits for a live tour the way it waits for a draft.
//   - THE FOLLOW. The ring is measured every frame the overlay is up, not for
//     a fixed window after each step: on a phone the Improve sheet keeps
//     moving as its list loads, and a window that closed first left the ring
//     on the row's old position.
//   - THE FIRST RENDER. The island rule: the built document and the first
//     client pass have to agree, so the overlay renders hidden with no
//     measured geometry in it at all.
//   - THE REPLAY. Settings clears the flag, asks, and navigates home.
//   - DONE ON THE ACCOUNT (#3237). A browser that has the flag copies it to
//     the account once, never for an account whose join screen is due; the
//     write tells the Getting started card, whose tour row ticks. Executed
//     against a stubbed App, fetch and storage, not grepped.
//
// Run with: node --test tests/home-tour.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { renderComponent, loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const TOUR_DIR = 'frontend/src/features/home/tour';
const OVERLAY_SRC = read(`${TOUR_DIR}/index.tsx`);
const STEPS_SRC = read(`${TOUR_DIR}/tour-steps.ts`);
const STORAGE_SRC = read(`${TOUR_DIR}/tour-storage.ts`);
const SETTINGS_SECTION_SRC = read('frontend/src/features/settings/sections/tour.tsx');
const SETTINGS_JS = read('frontend/src/features/settings/settings.js');
const TERMS_SRC = read('frontend/src/features/settings/terms-first-run.js');
const HOME_SRC = read('frontend/src/features/home/index.tsx');
const SHELL_SRC = read('frontend/src/Shell.tsx');
const INDEX = read('public/index.html');

// ── the step model and the geometry, executed ──────────────────────────

const steps = loadTsx(`${TOUR_DIR}/tour-steps.ts`);
const spotlight = loadTsx(`${TOUR_DIR}/spotlight.ts`);

test('the six steps are the ones the design settled on, in order', () => {
  assert.equal(steps.TOUR_LENGTH, 6);
  // #3240: the tour runs when asked, from the first row of Home's Getting
  // started card, so it keeps only what nothing else on the first run says:
  // your apps -> the menu -> what is in it (feedback and a new change, one
  // step, one well) -> where to replay it. The welcome, Workshop, Discover
  // and Getting started steps repeated the join screen and the card.
  // #3567 put one stop in front: what a community is, which the join screen
  // asks about without explaining and every later step takes for granted.
  // #4604 put one before the last: Homeroom bot, in Messages, so nobody
  // finishes the tour without meeting it. Replay stays last.
  assert.deepEqual(steps.TOUR_STEPS.map((s) => s.id), [
    'communities', 'apps', 'app-menu', 'menu-actions', 'meet-bot', 'settings',
  ]);
  for (const gone of ['welcome', 'workshop', 'discover', 'getting-started', 'challenges']) {
    assert.ok(!steps.TOUR_STEPS.some((s) => s.id === gone), `${gone} is not a step`);
  }
});

test('each step carries copy, and none of it is an em dash', () => {
  for (const step of steps.TOUR_STEPS) {
    assert.ok(step.title.length > 0, `${step.id} has a title`);
    assert.ok(step.body.length > 12, `${step.id} has body copy`);
    // tests/no-em-dash-in-copy.test.js bans it across frontend/src; this
    // table is all copy, so it is worth saying twice.
    assert.doesNotMatch(`${step.title} ${step.body}`, /—/, `${step.id} is em-dash free`);
  }
});

test('every step points at a REAL control, and nothing is illustrated', () => {
  const byId = Object.fromEntries(steps.TOUR_STEPS.map((s) => [s.id, s]));
  // Every step has something to point at.
  for (const step of steps.TOUR_STEPS) assert.ok(step.targets.length > 0, `${step.id} points at something`);
  // The whole My apps section, heading included, so the card never sits on
  // the heading the step is about (#3240); the grid is the fallback.
  assert.deepEqual([...byId.apps.targets], ['#home-apps-section', '#app-list']);
  assert.match(byId.apps.body, /people for a private community, a lock for one that is just yours/,
    'the step names the tile marks the grid draws');
  // The way into Settings is the Me tab, whose screen carries
  // #profile-row-settings (#2718).
  assert.deepEqual([...byId.settings.targets], ['#platform-tab-me']);
  // #3567: the Communities tab, whose key and id are still `workshop`.
  assert.deepEqual([...byId.communities.targets], ['#platform-tab-workshop']);
  // #4604: the Messages tab, where the bot's DM is the first row.
  assert.deepEqual([...byId['meet-bot'].targets], ['#platform-tab-messages']);
  assert.equal(byId['meet-bot'].title, 'Meet Homeroom bot');
  assert.match(byId['meet-bot'].body, /build a change, file an idea or fix a bug for you\. Find it in Messages\./);
  assert.match(read('frontend/src/features/nav/tab-bar.tsx'),
    /\{ key: 'messages' as const, label: 'Messages', href: '#messages'/,
    'the tab the step points at is Messages');
  assert.match(read('frontend/src/features/nav/tab-bar.tsx'),
    /\{ key: 'workshop' as const, label: 'Communities', href: '#communities'/,
    'the tab the step points at is the one labelled Communities');
  // THE MENU ARC: the mark that opens it, then the well inside it that holds
  // both of its actions. The mark is on screen on every route, which is what
  // lets this step be the one the arc falls back to. No mock anywhere in the
  // feature.
  assert.deepEqual([...byId['app-menu'].targets], ['#platform-mark-btn']);
  assert.deepEqual([...byId['menu-actions'].targets], ['#improve-quick-actions', '#improve-row-feedback']);
  assert.match(read('frontend/src/features/improve/actions.tsx'), /id="improve-quick-actions"/,
    'the well the step draws around is a real element');
  assert.ok(!byId.improve, 'the Improve row retired with the panel it opened');
  for (const src of [STEPS_SRC, OVERLAY_SRC]) {
    assert.doesNotMatch(src, /\bmock\b/i, 'the inline still life is gone, not hidden');
  }
});

test('the Improve step waits for the menu, and its Next opens the menu rather than skipping it', () => {
  const byId = Object.fromEntries(steps.TOUR_STEPS.map((s) => [s.id, s]));
  assert.equal(byId['app-menu'].advanceOn, 'menu-open');
  assert.equal(steps.IMPROVE_STEP_INDEX, 2);
  // Only the menu step's Next opens the menu; every other Next moves the
  // counter (or finishes, on the last step).
  for (const [i, step] of steps.TOUR_STEPS.entries()) {
    assert.equal(steps.nextOpensMenu(i), step.advanceOn === 'menu-open', `${step.id}'s Next`);
  }
  // Next is on EVERY step now: nothing hides it.
  assert.doesNotMatch(OVERLAY_SRC, /nextRef/);
  assert.doesNotMatch(OVERLAY_SRC, /hasNext|showsNext/);
  // The menu step's Next goes through the controller's own open path, and
  // does NOT move the counter itself: the store watcher below does that,
  // so step 4 can only ever arrive with the menu it points into.
  const goNext = OVERLAY_SRC.slice(OVERLAY_SRC.indexOf('const goNext = useCallback('));
  const body = goNext.slice(0, goNext.indexOf('}, [finish]);'));
  assert.match(body, /if \(nextOpensMenu\(at\)\) void AppContext\.open\(\);\s*else if \(isLastStep\(at\)\) finish\('finish'\);/);
  // The click on the mark is watched, never intercepted: the overlay
  // subscribes to the store and advances on the EDGE into open.
  assert.match(OVERLAY_SRC, /appContextStore\.subscribe\(/);
  assert.match(OVERLAY_SRC, /if \(now && stepAt\(indexRef\.current\)\.advanceOn === 'menu-open'\)/);
  assert.doesNotMatch(OVERLAY_SRC, /addEventListener\('click'/);
});

test("a press on the tour never dismisses the menu it is pointing into", () => {
  // Steps 4 and 5 spotlight rows INSIDE the app's menu, whose desktop
  // popover closes on any click outside it. The tour's card sits outside it,
  // so Next counted as an outside click: the menu shut, the next step (which
  // needs it) fell back to the menu step, and Next on step 4 landed on
  // step 3. The outside-click listener spares the tour's whole overlay.
  const MENU_SRC = read('frontend/src/features/app-context/index.tsx');
  assert.match(MENU_SRC, /const TOUR_ID = 'home-tour';/);
  const onDoc = MENU_SRC.slice(MENU_SRC.indexOf('const onDoc = (event: Event) => {'));
  const body = onDoc.slice(0, onDoc.indexOf('void AppContext.close();'));
  assert.match(body, /const tour = document\.getElementById\(TOUR_ID\);/);
  assert.match(body, /if \(t && \(sheet\?\.contains\(t\) \|\| mark\?\.contains\(t\) \|\| tour\?\.contains\(t\) \|\| firstSession\?\.contains\(t\)\)\) return;/);
  // And the id it spares is the overlay's root, which holds the card, the
  // shades and every button the tour draws.
  assert.match(OVERLAY_SRC, /ref=\{rootRef\}\s*id="home-tour"/);
});

test('the cut-out passes the press through only where pressing is the point', () => {
  const byId = Object.fromEntries(steps.TOUR_STEPS.map((s) => [s.id, s]));
  // ONE step is pressed through: the Improve step, which the viewer completes
  // by opening the menu themselves (or with Next, which opens it the same way).
  assert.equal(byId['app-menu'].interactive, true, 'the menu step lets the real mark be pressed');
  // EVERYTHING ELSE DESCRIBES ITS TARGET. Feedback presents a dialog, New
  // change starts a session, Workshop navigates off Home and the mark opens a
  // menu over the card itself, so a press on any of them walks out of a tour
  // that is only pointing at them. The keyboard has always been shut out of
  // them by the focus move and the Tab handler below, and the pointer agrees.
  // #2718's two new targets arrived carrying the flag and lost it here: a tab
  // and a menu button are the same case as the rows, not an exception to it.
  for (const id of ['communities', 'apps', 'menu-actions', 'meet-bot', 'settings']) {
    assert.equal(byId[id].interactive, undefined, `${id} only describes its target`);
  }
  // The rule stated once more against the table itself, so a step added later
  // cannot quietly become pressable: `interactive` belongs to `advanceOn`.
  for (const step of steps.TOUR_STEPS) {
    if (!step.interactive) continue;
    assert.ok(step.advanceOn, `${step.id} is interactive, so it must be a step the viewer ACTS on`);
  }
  // The root blocks nothing; the four shades block everything around the
  // hole. A box-shadow could not, which is why there are four of them, and
  // since #3240 that is all they do: they are transparent, and the dim is
  // the spotlight's own shadow (see "the dim is one rounded shape").
  assert.match(OVERLAY_SRC, /const ROOT = 'hidden fixed inset-0 z-\[9993\] overflow-hidden pointer-events-none'/);
  assert.match(OVERLAY_SRC, /const SHADE = 'absolute pointer-events-auto';/);
  assert.match(OVERLAY_SRC, /useClassToggle\(spotRef, 'pointer-events-auto', !step\.interactive\)/);
});

test('the panel step knows it needs the panel, and the step after shuts it', () => {
  // ONE, where there were two: Give feedback and New change sit side by side
  // in the menu's action well, so one cut-out draws around both.
  const byId = Object.fromEntries(steps.TOUR_STEPS.map((s) => [s.id, s]));
  assert.equal(byId['menu-actions'].needsPanel, true);
  assert.deepEqual(steps.TOUR_STEPS.filter((s) => s.needsPanel).map((s) => s.id), ['menu-actions']);
  for (const id of ['communities', 'apps', 'app-menu', 'meet-bot', 'settings']) {
    assert.equal(byId[id].needsPanel, undefined, `${id} does not need the menu`);
  }
  assert.equal(byId['app-menu'].needsPanel, undefined,
    'the Improve step needs no panel: its target is a row of the app\'s own '
    + 'menu, which it presents for itself');
  // AND THE STEP AFTER IT SHUTS IT. That step points at the Messages tab
  // (#4604), the last one at the Me tab, and on a phone the menu's sheet is
  // drawn over the tab bar, so the cut-out would be around something the
  // viewer cannot see. Both carry it, so Back never lands under the sheet.
  assert.deepEqual(steps.TOUR_STEPS.filter((s) => s.closesPanel).map((s) => s.id), ['meet-bot', 'settings']);
  // Closed through the controller's own path, never by writing to the
  // panel's DOM, which React owns. Both surfaces, because the steps that
  // carry `closesPanel` spotlight the header and either one drawn over it
  // would hide the thing the cut-out is drawn around.
  assert.match(OVERLAY_SRC, /if \(!stepAt\(index\)\.closesPanel\) return;\s*\n\s*if \(panelOpenNow\(\)\) void Improve\.close\(\);\s*\n\s*if \(appContextStore\.get\(\)\.open\) void AppContext\.close\(\);/);
  assert.doesNotMatch(OVERLAY_SRC, /getElementById\('apps-switcher-sheet'\)\.(?:classList|innerHTML|style)/);
  assert.doesNotMatch(OVERLAY_SRC, /getElementById\('apps-switcher-sheet'\)\.(?:classList|innerHTML|style)/);
});

test('the menu step arrives with the menu shut, and presents nothing', () => {
  // `opensSheet` RETIRED WITH THE PANEL (#2718 review). It existed because the
  // step's target was a ROW INSIDE the menu, which has no box for
  // ./spotlight.ts to find while the menu is closed — so the tour had to
  // present the surface before it could point at anything. The target is the
  // MARK now, on screen on every route, so there is nothing to present.
  assert.ok(!steps.TOUR_STEPS.some((s) => 'opensSheet' in s), 'the flag is gone');
  assert.doesNotMatch(STEPS_SRC, /opensSheet/);
  // What is left is the other half: arriving with the menu already up means
  // the edge into `open` never fires and the step cannot advance.
  const guard = OVERLAY_SRC.slice(
    OVERLAY_SRC.indexOf("if (stepAt(index).advanceOn !== 'menu-open') return;"));
  const body = guard.slice(0, guard.indexOf('}, ['));
  assert.match(body, /if \(panelOpenNow\(\)\) void Improve\.close\(\);/);
});
test('the tour pauses for anything else on screen, and resumes where the rule says', () => {
  // Paused is derived from the two things that mean "not on Home, alone":
  // Home is not the visible screen, or the kit has presented something that
  // is not the Improve panel.
  assert.match(OVERLAY_SRC, /const paused = !homeVisible \|\| otherSurface;/);
  assert.match(OVERLAY_SRC, /const live = open && !paused;/);
  assert.match(OVERLAY_SRC, /useHiddenClass\(rootRef, !live\)/);
  assert.match(OVERLAY_SRC, /const KIT_SURFACES = '\.un-modal, \.un-sheet, \.un-alert'/);
  // …minus the two surfaces the tour drives itself. The app's own menu joined
  // the Improve panel with #2718 and it is load-bearing rather than tidy: on
  // touch that sheet is adopted into a `.un-sheet`, so a tour that paused for
  // it would open the menu on the Improve step and hide itself in the same
  // frame — a presented sheet and no card, on the surface the tour is most
  // often run on.
  // ONE SURFACE NOW, not two: the Improve panel retired and its actions are
  // rows of this one (#2718 review).
  assert.match(OVERLAY_SRC, /const TOUR_OWNED_SURFACES = \['#apps-switcher-sheet'\];/);
  assert.match(OVERLAY_SRC, /if \(!TOUR_OWNED_SURFACES\.some\(\(sel\) => el\.querySelector\(sel\)\)\) return true;/);
  assert.match(OVERLAY_SRC, /new MutationObserver\(read\)/);
  // A panel step with no panel resumes at the Improve step, and only once
  // the flow that took the viewer away has finished (`live`, not `open`).
  const fallback = OVERLAY_SRC.slice(OVERLAY_SRC.indexOf('if (!stepAt(index).needsPanel) return;'));
  const body = fallback.slice(0, fallback.indexOf('}, ['));
  assert.match(body, /if \(panelOpen\) return;/);
  assert.match(body, /setIndex\(IMPROVE_STEP_INDEX\);/);
  assert.match(OVERLAY_SRC, /\}, \[live, index, panelOpen\]\);/);
});

test('Back onto the menu step arrives with the menu shut', () => {
  // Arriving with it already up would be a dead end: the step ends on the menu
  // OPENING and there is no edge left to wait for. It used to also PRESENT a
  // surface, because its target was a row inside one; the target is the mark
  // now, so the chained open retired with `opensSheet` and what is left is the
  // shut.
  const guard = OVERLAY_SRC.slice(
    OVERLAY_SRC.indexOf("if (stepAt(index).advanceOn !== 'menu-open') return;"));
  const body = guard.slice(0, guard.indexOf('}, ['));
  assert.match(body, /if \(panelOpenNow\(\)\) void Improve\.close\(\);/);
  // Back itself is a plain step move; the effect above is what handles the
  // menu, so it covers every way of landing there.
  assert.match(OVERLAY_SRC, /const goBack = useCallback\(\(\) => setIndex\(stepFrom\(indexRef\.current, -1\)\), \[\]\);/);
});

test('Next and Back walk one step, and no step is skipped', () => {
  // `optional` retired with the Getting started step it existed for (#3240):
  // the card is where the tour starts now, so there is no step describing it
  // to step over.
  assert.ok(!steps.TOUR_STEPS.some((s) => 'optional' in s));
  assert.doesNotMatch(STEPS_SRC, /optional\?: boolean/);
  assert.equal(steps.stepFrom(0, 1), 1);
  assert.equal(steps.stepFrom(2, -1), 1);
  assert.equal(steps.stepFrom(0, -1), 0, 'nowhere to go: it stays');
  assert.equal(steps.stepFrom(5, 1), 5);
  assert.match(OVERLAY_SRC, /else setIndex\(stepFrom\(at, 1\)\);/);
  assert.doesNotMatch(OVERLAY_SRC, /targetPresent/);
});
test('Next, Back and Finish cannot walk off either end', () => {
  assert.equal(steps.clampIndex(-3), 0);
  assert.equal(steps.clampIndex(99), 5);
  assert.equal(steps.clampIndex(Number.NaN), 0);
  assert.equal(steps.stepAt(0).id, 'communities');
  assert.equal(steps.stepAt(4).id, 'meet-bot');
  assert.equal(steps.stepAt(5).id, 'settings');
  assert.ok(!steps.isLastStep(4));
  assert.ok(steps.isLastStep(5));
  assert.equal(steps.stepCounter(0), '1 of 6');
  assert.equal(steps.stepCounter(5), '6 of 6');
});

test('the card goes below the hole when it fits, above it when it does not', () => {
  const viewport = { width: 1280, height: 800 };
  const card = { width: 340, height: 200 };

  const below = spotlight.placeCard(viewport, card, {
    top: 100, left: 600, width: 80, height: 40,
  });
  assert.equal(below.top, 152, 'below the hole, one gap down');
  assert.equal(below.left, 470, 'centred on the hole');

  const above = spotlight.placeCard(viewport, card, {
    top: 700, left: 600, width: 80, height: 40,
  });
  assert.equal(above.top, 488, 'no room below, so above');
});

test('the card is always inside the viewport, hole or no hole', () => {
  const viewport = { width: 390, height: 844 };
  const card = { width: spotlight.cardWidth(390), height: 260 };
  assert.equal(card.width, 340, 'a phone still fits the full card');

  // A target hard against the right edge must not push the card off it.
  const clamped = spotlight.placeCard(viewport, card, {
    top: 60, left: 360, width: 26, height: 26,
  });
  assert.ok(clamped.left >= 12 && clamped.left + card.width <= 390 - 12 + 0.5,
    `left ${clamped.left} keeps the card on screen`);

  // No hole: centred.
  const centred = spotlight.placeCard(viewport, card, null);
  assert.equal(centred.left, 25);
  assert.equal(centred.top, 292);
});

test('in the app the card keeps clear of the status bar', () => {
  const viewport = { width: 390, height: 844 };
  const card = { width: 340, height: 160 };
  // A tall target whose START has scrolled off the top, with no room on
  // either side: the card pins to the top edge. (QA 2026-09-24 Q30d: a tall
  // target whose start is ON screen now takes the card at the bottom
  // instead, see the next test, so this one starts above the viewport.)
  const tall = { top: -40, left: 10, width: 370, height: 880 };
  assert.equal(spotlight.placeCard(viewport, card, tall).top, spotlight.VIEWPORT_MARGIN);
  const inset = spotlight.placeCard(viewport, card, tall, 40);
  assert.ok(inset.top >= spotlight.VIEWPORT_MARGIN + 40, 'below the 40px status bar');
  const panel = { top: 0, left: 0, width: 390, height: 844 };
  assert.ok(spotlight.placeCardForPanel(viewport, card, tall, panel, 40).top >= 52);
});

// QA 2026-09-24 Q30d: on a phone, step 7 "Challenges" points at a section
// taller than the screen. The card took the top of it, over the heading and
// the progress it was describing, the ring ran across the tab bar, and on
// step 8 the ring round the Me tab was cut off by the screen's edge.
test('a target taller than the screen keeps its start visible, and its ring on screen', () => {
  const viewport = { width: 390, height: 844 };
  const card = { width: 340, height: 169 };
  const tabs = 70;
  // The Challenges section, heading at 99, running on past the tab bar.
  const section = spotlight.padRect({ top: 99, left: 0, width: 390, height: 900 });
  const hole = spotlight.fitHole(section, viewport, tabs);
  assert.equal(hole.top, 91, 'the start is untouched');
  assert.equal(hole.top + hole.height, 844 - tabs - spotlight.RING_WIDTH, 'the ring stops above the tab bar');
  assert.equal(hole.left, spotlight.RING_WIDTH, 'and inside the left edge');
  assert.equal(hole.left + hole.width, 390 - spotlight.RING_WIDTH, 'and the right one');
  const placed = spotlight.placeCard(viewport, card, hole, 0, tabs);
  assert.equal(placed.top, 844 - tabs - card.height - spotlight.VIEWPORT_MARGIN,
    'the card covers the END of the section, just above the tab bar');
  assert.ok(placed.top > 99 + 80, 'clear of the heading and the progress under it');
  // Step 8: the Me tab, bottom right. The target IS in the bar, so there is
  // no bottom inset, but the hole stays inside the screen's own edges.
  const me = spotlight.fitHole(spotlight.padRect({ top: 788, left: 310, width: 76, height: 56 }), viewport, 0);
  assert.equal(me.left + me.width, 390 - spotlight.RING_WIDTH);
  assert.equal(me.top + me.height, 844 - spotlight.RING_WIDTH);
  assert.equal(me.top, 780);
  // An ordinary target is not moved at all.
  const small = { top: 100, left: 50, width: 200, height: 40 };
  assert.deepEqual(spotlight.fitHole(small, viewport, tabs), small);
});

test('a tall target is scrolled to its start, not centred past it', () => {
  assert.match(OVERLAY_SRC, /if \(rect\.height \+ SPOTLIGHT_PAD \* 2 > band\) \{\s*scrollerOf\(target\)\.scrollBy\(/);
  assert.match(OVERLAY_SRC, /target\.scrollIntoView\(\{ block: 'center', behavior \}\)/);
  // #3240: the hole also stays below the header, unless the target is in it.
  assert.match(OVERLAY_SRC, /hole = fitHole\(padRect\(rect\), viewport, bottomInset, headerBottom\(\)\);/);
  // The tab bar is an inset only for a target that is not one of its tabs.
  assert.match(OVERLAY_SRC, /if \(!bar \|\| \(target && bar\.contains\(target\)\)\) return 0;/);
});

test('the card keeps clear of the status bar, and the tour hands Home back at its top', () => {
  assert.match(OVERLAY_SRC, /--platform-safe-top/, 'the status bar is measured from the shell token');
  assert.match(OVERLAY_SRC, /clearStep\(userId\);[\s\S]{0,200}backToTopOfHome\(\);/);
  // The first-touch wait was for a tour that started by itself under the
  // phone's own post-sign-in dialog. It starts on a press now (#3240).
  assert.doesNotMatch(OVERLAY_SRC, /FIRST_TOUCH_WAIT_MS|whenUserSettled/);
});

test('a narrow viewport shrinks the card rather than overflowing', () => {
  assert.equal(spotlight.cardWidth(320), 296);
  assert.equal(spotlight.cardWidth(1280), 340);
});

test('while the panel is open the card sits BESIDE it, never on it', () => {
  // Desktop: the panel is a right-side sheet, so the card's right edge goes
  // one gap from its left edge and the card lines up with the middle of the
  // highlighted row. A tooltip drawn over the row it describes hides the
  // thing it is pointing at, which is the whole defect this avoids.
  const viewport = { width: 1280, height: 800 };
  const card = { width: 340, height: 200 };
  const panel = { top: 0, left: 860, width: 420, height: 800 };
  const hole = { top: 300, left: 880, width: 380, height: 44 };

  const placed = spotlight.placeCardForPanel(viewport, card, hole, panel);
  assert.equal(placed.left + card.width, panel.left - spotlight.CARD_GAP,
    'the card\'s right edge is one gap from the panel\'s left edge');
  assert.equal(placed.top, 322 - card.height / 2 + 0, 'centred on the row');
  assert.ok(placed.left + card.width <= panel.left, 'no overlap with the panel');
});

test('the beside-the-panel card is still clamped to the viewport', () => {
  const viewport = { width: 1280, height: 800 };
  const card = { width: 340, height: 300 };
  const panel = { top: 0, left: 860, width: 420, height: 800 };

  // A row at the very top of the panel would centre the card off the screen.
  const high = spotlight.placeCardForPanel(viewport, card, {
    top: 4, left: 880, width: 380, height: 44,
  }, panel);
  assert.ok(high.top >= spotlight.VIEWPORT_MARGIN, `top ${high.top} is on screen`);

  // And one at the very bottom would run it off the other end.
  const low = spotlight.placeCardForPanel(viewport, card, {
    top: 770, left: 880, width: 380, height: 44,
  }, panel);
  assert.ok(low.top + card.height <= viewport.height - spotlight.VIEWPORT_MARGIN + 0.5,
    `bottom ${low.top + card.height} is on screen`);
});

test('a full-width panel has no beside, so the card clears the ROW instead', () => {
  // A phone: the panel takes the whole width, so there is nowhere to the left
  // of it. The rule relaxes to the weaker one the design asks for, which is
  // what placeCard already does: below the row when it fits, above it when it
  // does not, and never over it.
  const viewport = { width: 390, height: 844 };
  const card = { width: spotlight.cardWidth(390), height: 200 };
  const panel = { top: 0, left: 0, width: 390, height: 844 };
  assert.equal(spotlight.roomLeftOfPanel(card, panel), false);

  const hole = { top: 200, left: 12, width: 366, height: 44 };
  const placed = spotlight.placeCardForPanel(viewport, card, hole, panel);
  assert.deepEqual(placed, spotlight.placeCard(viewport, card, hole),
    'the fallback is the ordinary placement, not a second arrangement');
  assert.ok(placed.top >= hole.top + hole.height, 'below the row, clear of it');

  // Near the bottom it goes above the row rather than covering it.
  const low = { top: 700, left: 12, width: 366, height: 44 };
  const above = spotlight.placeCardForPanel(viewport, card, low, panel);
  assert.ok(above.top + card.height <= low.top, 'above the row, clear of it');
});

test('roomLeftOfPanel is the whole desktop/narrow decision', () => {
  const card = { width: 340 };
  // 340 + 12 gap + 12 margin = 364 is the least a panel can start at.
  assert.equal(spotlight.roomLeftOfPanel(card, { top: 0, left: 364, width: 100, height: 10 }), true);
  assert.equal(spotlight.roomLeftOfPanel(card, { top: 0, left: 363, width: 100, height: 10 }), false);
  // No panel at all, or no hole, falls straight through to placeCard.
  const viewport = { width: 1280, height: 800 };
  const c = { width: 340, height: 200 };
  const hole = { top: 100, left: 600, width: 80, height: 40 };
  assert.deepEqual(
    spotlight.placeCardForPanel(viewport, c, hole, null),
    spotlight.placeCard(viewport, c, hole),
  );
  assert.deepEqual(
    spotlight.placeCardForPanel(viewport, c, null, { top: 0, left: 860, width: 420, height: 800 }),
    spotlight.placeCard(viewport, c, null),
  );
});

test('only the panel steps consult the panel, and the overlay uses the pair', () => {
  assert.match(OVERLAY_SRC, /const panel = stepAt\(indexRef\.current\)\.needsPanel && panelOpenNow\(\) \? panelBox\(\) : null;/);
  // QA 2026-09-24 Q30d: plus the tab bar's inset, so the card stays above it.
  assert.match(OVERLAY_SRC, /const place = \(at: Box \| null\) => placeCardForPanel\(\s*viewport, \{ width, height: card\.offsetHeight \}, at, panel, safeTopInset\(\), bottomInset,\s*\);/);
  // The panel is measured on the kit's sheet when it has been adopted into
  // one, because that wrapper is the surface the viewer sees.
  const SPOT_SRC = read(`${TOUR_DIR}/spotlight.ts`);
  assert.match(SPOT_SRC, /panel\.closest\('\.un-sheet'\) \?\? panel/);
});

test('the four shades tile the viewport minus the hole', () => {
  const viewport = { width: 1000, height: 800 };
  const [top, right, bottom, left] = spotlight.shadeBoxes(viewport, {
    top: 200, left: 300, width: 100, height: 50,
  });
  assert.deepEqual(top, { top: 0, left: 0, width: 1000, height: 200 });
  assert.deepEqual(right, { top: 200, left: 400, width: 600, height: 50 });
  assert.deepEqual(bottom, { top: 250, left: 0, width: 1000, height: 550 });
  assert.deepEqual(left, { top: 200, left: 0, width: 300, height: 50 });
  // Together they cover everything except the hole, which is what makes the
  // cut-out clickable: the shades are the elements that take pointer events.
  const covered = top.width * top.height + bottom.width * bottom.height
    + right.width * right.height + left.width * left.height;
  assert.equal(covered, 1000 * 800 - 100 * 50);
});

test('with nothing to point at, one shade covers the screen', () => {
  const [top, right, bottom, left] = spotlight.shadeBoxes({ width: 640, height: 480 }, null);
  assert.deepEqual(top, { top: 0, left: 0, width: 640, height: 480 });
  for (const box of [right, bottom, left]) {
    assert.equal(box.width * box.height, 0);
  }
});

test('a target scrolled half off screen still produces sane shades', () => {
  const viewport = { width: 500, height: 400 };
  for (const hole of [
    { top: -40, left: -30, width: 100, height: 60 },
    { top: 380, left: 470, width: 100, height: 60 },
  ]) {
    for (const box of spotlight.shadeBoxes(viewport, hole)) {
      assert.ok(box.width >= 0 && box.height >= 0, `no negative box for ${JSON.stringify(hole)}`);
      assert.ok(box.top >= 0 && box.left >= 0);
    }
  }
});

test('the hole is the target plus breathing room', () => {
  assert.deepEqual(
    spotlight.padRect({ top: 100, left: 50, width: 200, height: 40 }),
    { top: 92, left: 42, width: 216, height: 56 },
  );
});

// ── persistence, executed ──────────────────────────────────────────────

/**
 * tour-storage.ts, bundled and run against a storage of our own.
 *
 * Executed rather than grepped because the interesting cases are the ones a
 * grep cannot see: a second account on the same device, a clear that must
 * touch only one key, and a storage that throws on every access (Safari in
 * private mode, which is the failure the wrapping exists for).
 */
const storageApi = loadTsx(`${TOUR_DIR}/tour-storage.ts`);

function withStorage({ throwing = false } = {}) {
  const backing = new Map();
  const deny = () => { throw new Error('denied'); };
  globalThis.localStorage = throwing ? {
    getItem: deny, setItem: deny, removeItem: deny,
  } : {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => backing.set(k, String(v)),
    removeItem: (k) => backing.delete(k),
  };
  return backing;
}

test('the answer is per account, and never a bare global key', () => {
  const backing = withStorage();
  assert.equal(storageApi.keyFor(null), null);
  assert.equal(storageApi.keyFor(7), 'usernode:home-tour-done:7');
  // No viewer, no tour: there is nobody to welcome and no key to write under.
  assert.equal(storageApi.readDone(null), true);

  assert.equal(storageApi.readDone(7), false);
  storageApi.writeDone(7);
  assert.equal(storageApi.readDone(7), true);
  // A second account on the same device gets its own answer.
  assert.equal(storageApi.readDone(8), false);
  assert.deepEqual([...backing.keys()], ['usernode:home-tour-done:7']);
});

test('Replay clears exactly that account\'s answer', () => {
  withStorage();
  storageApi.writeDone(7);
  storageApi.writeDone(8);
  storageApi.clearDone(7);
  assert.equal(storageApi.readDone(7), false, 'the tour runs again for 7');
  assert.equal(storageApi.readDone(8), true, 'and is still finished for 8');
});

test('storage denied shows the tour rather than silently retiring it', () => {
  withStorage({ throwing: true });
  assert.equal(storageApi.readDone(7), false);
  // Neither write throws out of the module, so a denied storage costs the
  // viewer a repeated tour and nothing else.
  assert.doesNotThrow(() => storageApi.writeDone(7));
  assert.doesNotThrow(() => storageApi.clearDone(7));
});

test('the viewer is read off App.user, which only exists on the client', () => {
  const before = globalThis.window;
  globalThis.window = { App: { user: { id: 42 } } };
  try {
    assert.equal(storageApi.currentUserId(), 42);
    globalThis.window = { App: { user: null } };
    assert.equal(storageApi.currentUserId(), null);
    globalThis.window = {};
    assert.equal(storageApi.currentUserId(), null);
  } finally {
    globalThis.window = before;
  }
});

test('the key is new, so a dismissed banner is not a finished tour', () => {
  assert.match(STORAGE_SRC, /const KEY_PREFIX = 'usernode:home-tour-done:'/);
  assert.doesNotMatch(STORAGE_SRC, /home-welcome-dismissed/);
});

// ── the step across a reload, executed ─────────────────────────────────

function withSessionStorage({ throwing = false } = {}) {
  const backing = new Map();
  const deny = () => { throw new Error('denied'); };
  globalThis.sessionStorage = throwing ? {
    getItem: deny, setItem: deny, removeItem: deny,
  } : {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => backing.set(k, String(v)),
    removeItem: (k) => backing.delete(k),
  };
  return backing;
}

test('the step is kept for the page session, per account', () => {
  const backing = withSessionStorage();
  assert.equal(storageApi.stepKeyFor(null), null);
  assert.equal(storageApi.stepKeyFor(7), 'usernode:home-tour-step:7');
  assert.equal(storageApi.readStep(7), null, 'nothing kept, nothing to resume');
  storageApi.writeStep(7, 3);
  assert.equal(storageApi.readStep(7), 3);
  assert.equal(storageApi.readStep(8), null, 'another account has its own place');
  assert.deepEqual([...backing.keys()], ['usernode:home-tour-step:7']);
  // sessionStorage, never localStorage: a reload keeps the page session and
  // the place in the tour; a new tab or the next launch starts from the top.
  const kept = STORAGE_SRC.slice(STORAGE_SRC.indexOf('const STEP_PREFIX'));
  assert.doesNotMatch(kept, /localStorage/);
  assert.equal((kept.match(/sessionStorage\./g) || []).length, 3);
});

test('finishing clears the kept step, and a bad value is no step at all', () => {
  const backing = withSessionStorage();
  storageApi.writeStep(7, 5);
  storageApi.clearStep(7);
  assert.equal(storageApi.readStep(7), null);
  assert.equal(backing.size, 0);
  for (const bad of ['x', '-1', '2.5', '']) {
    backing.set('usernode:home-tour-step:7', bad);
    assert.equal(storageApi.readStep(7), null, `${JSON.stringify(bad)} is not a step`);
  }
  // No viewer, no key: nothing is written under a bare global name.
  storageApi.writeStep(null, 2);
  assert.equal(backing.has('usernode:home-tour-step:null'), false);
});

test('a storage that throws costs a reload its place and nothing else', () => {
  withSessionStorage({ throwing: true });
  assert.equal(storageApi.readStep(7), null);
  assert.doesNotThrow(() => storageApi.writeStep(7, 1));
  assert.doesNotThrow(() => storageApi.clearStep(7));
});

test('a reload resumes where the viewer was, and a panel step at the Improve step', () => {
  assert.equal(steps.resumeIndex(null), 0, 'nothing kept: from the top');
  assert.equal(steps.resumeIndex(0), 0);
  assert.equal(steps.resumeIndex(1), 1);
  assert.equal(steps.resumeIndex(2), 2, 'the menu step resumes as itself');
  // A fresh document has no Improve panel open, so a panel step cannot be
  // resumed as itself: the arc restarts at "press Improve". ONE step is in
  // the panel now (the well with Give feedback and New change).
  assert.equal(steps.resumeIndex(3), steps.IMPROVE_STEP_INDEX, 'step 4 resumes at the menu');
  // …and the ones that are not in it resume where they are, because the mark
  // and the tabs are on screen in a fresh document.
  assert.equal(steps.resumeIndex(4), 4, 'the Messages tab resumes as itself');
  assert.equal(steps.resumeIndex(5), 5, 'the Me tab resumes as itself');
  // A step kept by the eight-step tour, before #3240, is clamped like every
  // other index.
  assert.equal(steps.resumeIndex(7), 5);
  assert.equal(steps.resumeIndex(99), 5, 'clamped like every other index');
  assert.equal(steps.resumeIndex(Number.NaN), 0);
});

test('the overlay keeps its step while it is up, resumes there, and clears it on finish', () => {
  // Written on every step while open, under the viewer's id.
  // Not on the tour's own screenshot route (#3567), which writes nothing.
  assert.match(OVERLAY_SRC, /if \(!open \|\| userId == null \|\| isTourShot\(\)\) return;\s*writeStep\(userId, index\);\s*\}, \[open, index, userId\]\);/);
  // The reload resume is the one path that resumes; a request starts from
  // the top.
  const start = OVERLAY_SRC.slice(OVERLAY_SRC.indexOf('if (started.current || userId == null) return;'));
  const body = start.slice(0, start.indexOf('}, [userId, start]);'));
  assert.match(body, /const saved = readStep\(userId\);\s*if \(saved == null\) return;/);
  assert.match(body, /start\(resumeIndex\(saved\)\);/);
  const replay = OVERLAY_SRC.slice(OVERLAY_SRC.indexOf('const request = useTourRequest();'));
  assert.match(replay.slice(0, replay.indexOf('}, [request, start]);')), /start\(\);/);
  // Finish and Skip both go through finish(): done is written, here and on
  // the account, the place is cleared, and neither can bring the tour back on
  // the next reload.
  assert.match(OVERLAY_SRC, /writeDone\(userId\);\s*(?:\/\/[^\n]*\n\s*)*void markDoneOnServer\(userId, \{ ended, step: indexRef\.current \}\);\s*clearStep\(userId\);/);
});

test("the shell's automatic reload waits for a tour in progress", () => {
  // The gate the cold-boot switch consults before location.reload(): a live
  // #home-tour is in-progress input, the same as a half-written reply. The
  // visible reload offer stays, as it does for the draft; the detailed
  // switching rules are tests/shell-update-prefetch.test.js's.
  const APP_JS = read('public/js/app.js');
  const gate = APP_JS.slice(APP_JS.indexOf('_hasUnsavedShellInput() {'));
  const body = gate.slice(0, gate.indexOf('\n  }'));
  assert.match(body, /const tour = document\.getElementById\('home-tour'\);\s*if \(tour && !tour\.classList\.contains\('hidden'\)\) return true;/);
  assert.ok(body.indexOf("getElementById('home-tour')") < body.indexOf('querySelectorAll('),
    'checked before the form controls, so a tour with no inputs on the page still holds the reload');
});

// ── the first render ───────────────────────────────────────────────────

test('the first render is the hidden overlay, with nothing measured', () => {
  const html = renderComponent(`${TOUR_DIR}/index.tsx`, 'OnboardingTour');
  assert.match(html, /id="home-tour"/);
  assert.match(html, /class="hidden fixed inset-0/, 'hidden until an effect says otherwise');
  assert.match(html, /id="home-tour-card"/);
  assert.match(html, /id="home-tour-next"/);
  for (const side of ['top', 'right', 'bottom', 'left']) {
    assert.match(html, new RegExp(`id="home-tour-shade-${side}"`));
  }
  // The Skip question ships in the document and starts hidden, like the card
  // itself: nothing is mounted on demand, so React never has to reorder
  // children of a node the kit may have written to.
  assert.match(html, /id="home-tour-confirm" class="hidden"/);
  assert.match(html, /Are you sure\? You can reopen this from Settings\./);
  // Step 1 is what a step-less render shows, on both sides of hydration.
  assert.match(html, /1 of 6/);
  assert.match(html, /Homeroom is made of communities/);
  // No geometry in the markup: the hole and the card position are style
  // writes through refs, and a measured pixel in the prerender would be a
  // hydration mismatch waiting for the first viewport that differs.
  assert.doesNotMatch(html, /style="/);
});

test('the overlay is in the built document, hidden, and the banner is gone', () => {
  assert.ok(INDEX.includes('id="home-tour"'), 'prerendered, like the install strip');
  assert.ok(!INDEX.includes('id="home-welcome"'), 'the banner it replaces is retired');
  assert.ok(!fs.existsSync(path.join(ROOT, 'frontend/src/features/home/welcome-banner.tsx')));
  assert.doesNotMatch(HOME_SRC, /WelcomeBanner/);
  assert.match(SHELL_SRC, /<Island name="OnboardingTour"><OnboardingTour \/><\/Island>/);
});

test('visibility rides refs, never a rendered className', () => {
  // The same contract every island in the shell signs: constant class
  // strings, toggled through lib/legacy-dom.ts.
  for (const call of [
    'useHiddenClass(rootRef, !live)',
    'useHiddenClass(bodyRef, confirming)',
    'useHiddenClass(confirmRef, !confirming)',
  ]) {
    assert.ok(OVERLAY_SRC.includes(call), `${call} is how that node hides`);
  }
  assert.ok(
    OVERLAY_SRC.includes("const ROOT = 'hidden fixed inset-0"),
    'the root class string is a constant with hidden where the prerender has it',
  );
});

// ── when it opens ──────────────────────────────────────────────────────

test('nothing opens the tour on a deterministic capture route', () => {
  const guard = OVERLAY_SRC.slice(OVERLAY_SRC.indexOf('function isDeterministicRoute'));
  const body = guard.slice(0, guard.indexOf('\n}'));
  for (const param of ['shot', 'demo', 'token']) {
    assert.match(body, new RegExp(`params\\.get\\('${param}'\\)`),
      `?${param}= is refused, so the declared checks never meet the overlay`);
  }
  assert.match(OVERLAY_SRC, /if \(isDeterministicRoute\(\)\) return;/);
});

test('?shot=welcome-tour opens the tour at step 1 and writes nothing (#3567)', () => {
  // The one named exception to the rule above, so a declared check can see
  // the tour's first card: the same arrangement as ?shot=join-communities.
  assert.match(OVERLAY_SRC, /const TOUR_SHOT = 'welcome-tour';/);
  const guard = OVERLAY_SRC.slice(OVERLAY_SRC.indexOf('function isTourShot(): boolean {'));
  const body = guard.slice(0, guard.indexOf('\n}'));
  assert.match(body, /if \(isEmbeddedPanel\(\)\) return false;/, 'never in the side panel');
  assert.match(body, /\.get\('shot'\) === TOUR_SHOT/);
  // It opens at the top once Home is up, and claims the document so the
  // resume cannot also fire.
  const open = OVERLAY_SRC.slice(OVERLAY_SRC.indexOf('if (!isTourShot()) return;'));
  const effect = open.slice(0, open.indexOf('}, [start]);'));
  assert.match(effect, /started\.current = true;[\s\S]*await whenHomeVisible\(\);[\s\S]*start\(\);/);
  // Finish and Skip on that route write no "done", here or on the account.
  const finish = OVERLAY_SRC.slice(OVERLAY_SRC.indexOf('const finish = useCallback(('));
  const fbody = finish.slice(0, finish.indexOf('}, [userId]);'));
  assert.ok(fbody.indexOf('if (isTourShot()) {') < fbody.indexOf('writeDone(userId);'),
    'the shot returns before anything is written');
  // The declared check that reaches the communities step is this route.
  const DAPP = JSON.parse(read('dapp.json'));
  const check = DAPP.tests.find((t) => t.path === '/?shot=welcome-tour');
  assert.ok(check, 'dapp.json declares a check on the tour shot');
  assert.match(check.expectSelector, /#home-tour:not\(\.hidden\)/);
  assert.ok(steps.TOUR_STEPS[0].body.toLowerCase().includes(check.expectText.toLowerCase()),
    'and it asserts the communities step\'s own copy');
});

test('the communities step names what the screen names (#3567)', () => {
  // AGENTS.md, "Communities own projects": a community owns projects, and
  // people see it by its audience, in the screen's own words.
  const step = steps.TOUR_STEPS[0];
  assert.equal(step.id, 'communities');
  assert.equal(step.title, 'Communities');
  assert.match(step.body, /communities that build projects together/);
  assert.match(step.body, /propose a change, and the group votes it in/);
  for (const audience of ['Just you', 'a Private community', 'a Public community']) {
    assert.ok(step.body.includes(audience), `names ${audience}`);
  }
  assert.doesNotMatch(step.body, /\bapps?\b/, 'a thing being built is a project');
});

test('nothing opens the tour by itself: a request, or a reload under one in progress', () => {
  // #3240. It used to open on the first sign-in that reached Home, straight
  // after the join screen, which had just said the same things. Every gate
  // that auto-start waited on is gone with it.
  for (const gone of [/whenFirstRunSettled/, /whenSessionRead/, /tourDoneFor/, /isTourDone/,
    /firstRunRev/, /TermsFirstRun/]) {
    assert.doesNotMatch(OVERLAY_SRC, gone);
  }
  // A request (Getting started's first row, Settings' Replay) opens it at
  // once, whatever was finished before, once Home is on screen.
  const replay = OVERLAY_SRC.slice(OVERLAY_SRC.indexOf('const request = useTourRequest();'));
  const asked = replay.slice(0, replay.indexOf('}, [request, start]);'));
  assert.match(asked, /started\.current = true;[\s\S]*await whenHomeVisible\(\);[\s\S]*start\(\);/);
  // The only other way in is a document reloaded under a tour this page
  // session had started: no kept step, nothing opens.
  const resume = OVERLAY_SRC.slice(OVERLAY_SRC.indexOf('if (started.current || userId == null) return;'));
  const body = resume.slice(0, resume.indexOf('}, [userId, start]);'));
  assert.match(body, /if \(isDeterministicRoute\(\)\) return;/);
  assert.match(body, /if \(saved == null\) return;/);
  assert.ok(body.indexOf('await whenHomeVisible()') < body.indexOf('started.current = true;'));
  // Once per document: the resume never stacks a tour on one already up.
  assert.match(body, /if \(cancelled \|\| started\.current \|\| !home\) return;/);
});

test('the terms gate publishes the settled() the join screen waits on', () => {
  assert.match(TERMS_SRC, /settled\(\) \{/);
  assert.match(TERMS_SRC, /_resolve\(\) \{/);
  // Every exit from the gate resolves it, or the tour would wait forever on
  // an account with no published terms to answer.
  const check = TERMS_SRC.slice(TERMS_SRC.indexOf('async _check()'));
  assert.ok((check.match(/TermsFirstRun\._resolve\(\);/g) || []).length >= 5,
    'each early return out of the check resolves the promise');
  // The terms are accepted by continuing now, with no sheet: the write's end resolves it too.
  assert.match(TERMS_SRC, /async _acceptByContinuing\(payload\) \{[\s\S]*?TermsFirstRun\._resolve\(\);\s*\},/);
});

test('Escape behaves like Skip, and focus stays in the card', () => {
  assert.match(OVERLAY_SRC, /if \(event\.key === 'Escape'\)/);
  assert.match(OVERLAY_SRC, /setConfirming\(\(was\) => !was\);/);
  assert.match(OVERLAY_SRC, /if \(event\.key !== 'Tab'\) return;/);
  assert.match(OVERLAY_SRC, /const surface = confirmingRef\.current \? confirmRef\.current : bodyRef\.current;/);
});

test('the overlay follows its target every frame it is up, not for a fixed window', () => {
  // The kit's sheet re-sizes under a list that loads after the panel opens,
  // and a spring on a transform reports nothing: no event, no
  // ResizeObserver. The next frame is the one signal right for all of it.
  const pass = OVERLAY_SRC.slice(OVERLAY_SRC.indexOf('useIsomorphicLayoutEffect(() => {'));
  const body = pass.slice(0, pass.indexOf('}, [live, index, confirming, panelOpen, apply]);'));
  assert.match(body, /let frame = window\.requestAnimationFrame\(function follow\(\) \{\s*apply\(\);\s*frame = window\.requestAnimationFrame\(follow\);/);
  assert.match(body, /return \(\) => window\.cancelAnimationFrame\(frame\);/);
  // The bounded window is gone with the bug it caused: nothing here stops
  // measuring while the overlay is live.
  assert.doesNotMatch(OVERLAY_SRC, /SETTLE_MS|SETTLE_TICK_MS|setInterval\(apply/);
  // A frame that measures the same numbers writes nothing, which is what
  // makes a per-frame measure free: the geometry painted last is kept as one
  // string and compared before any style is touched.
  assert.match(OVERLAY_SRC, /const painted = JSON\.stringify\(\[shown, boxes, placed\]\);\s*if \(painted === paintedRef\.current\) return;/);
  assert.match(body, /if \(!settleRef\.current\) paintedRef\.current = '';/,
    'the first pass after a state change always paints, unless a step is still settling');
});

// ── the jump (#3240) ───────────────────────────────────────────────────

test('nothing in the overlay animates: the box jumps from stop to stop', () => {
  // The shades, the ring and the card carried a 200ms transition that the
  // per-frame measure restarted every frame the target moved, so the box
  // chased the menu for 632ms on Android and the four shades and the ring
  // came apart on their separate curves. None of it is left.
  assert.doesNotMatch(OVERLAY_SRC, /motion-safe:transition|transition-(?:all|\[)|duration-\d/);
  // And the target is brought into view at once, never smoothly: a smooth
  // scroll is a target that keeps moving for 400ms.
  const fn = OVERLAY_SRC.slice(OVERLAY_SRC.indexOf('function bringIntoView(target: HTMLElement): void {'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /const behavior: ScrollBehavior = 'auto';/);
  assert.doesNotMatch(body, /smooth/);
  // A target in the header or the tab bar is on screen already, and centring
  // the mark used to scroll Home by 160px under the box.
  assert.match(body, /if \(barOf\(target\)\) return;/);
});

test('a step paints once its target holds still, and the card waits with it', () => {
  const pass = OVERLAY_SRC.slice(OVERLAY_SRC.indexOf('const apply = useCallback(() => {'));
  const body = pass.slice(0, pass.indexOf('  }, []);'));
  assert.match(OVERLAY_SRC, /const SETTLE_FRAMES = 2;/);
  assert.match(OVERLAY_SRC, /const SETTLE_CAP_MS = 700;/);
  // Two identical, paintable measures in a row, or the cap, and not before.
  assert.match(body, /if \(ready && measured === settle\.last && !targetAnimating\(target\)\) settle\.stable \+= 1;/);
  // Nor while a CSS transition is still moving it or a box it sits in: the
  // desktop menu's ease-out tail moves less than a pixel a frame. Finite ones
  // only, so an endless spinner cannot hold every step to the cap.
  const anim = OVERLAY_SRC.slice(OVERLAY_SRC.indexOf('function targetAnimating('));
  const animBody = anim.slice(0, anim.indexOf('\n}\n'));
  assert.match(animBody, /if \(!\(el instanceof Element\) \|\| !el\.contains\(target\)\) return false;/);
  assert.match(animBody, /return effect\?\.getComputedTiming\(\)\.endTime !== Infinity;/);
  assert.match(body, /const timedOut = performance\.now\(\) - settle\.since >= SETTLE_CAP_MS;/);
  assert.match(body, /if \(settle\.stable < SETTLE_FRAMES && !timedOut\) \{/);
  // A hole too thin to be a highlight is a target still arriving.
  assert.match(body, /const ready = usableHole\(hole\);/);
  assert.match(body, /const shown = ready \? hole : null;/);
  // A settle starts on a STEP change (or a return from a pause), and the
  // card goes transparent for it; the Skip question and the menu opening
  // re-measure without hiding it.
  const effect = OVERLAY_SRC.slice(OVERLAY_SRC.indexOf('const settledForRef = useRef<number | null>(null);'));
  const run = effect.slice(0, effect.indexOf('}, [live, index, confirming, panelOpen, apply]);'));
  assert.match(run, /if \(settledForRef\.current !== index\) \{\s*settledForRef\.current = index;\s*settleRef\.current = \{ since: performance\.now\(\), last: '', stable: 0 \};\s*cardRef\.current\?\.classList\.add\(CARD_SETTLING\);/);
  // The card is transparent, not `invisible`, so focus can still land in it.
  assert.match(OVERLAY_SRC, /const CARD_SETTLING = 'opacity-0';/);
  assert.match(body, /card\.classList\.toggle\(CARD_SETTLING, !cardAt\);/);
});

test('the dim is one rounded shape, and the four shades only block', () => {
  // The four shades were the dim, square-cornered, around a rounded ring:
  // four bright wedges at every hole. The dim is the spotlight's own shadow
  // now, so it has the ring's corners.
  assert.match(OVERLAY_SRC, /const SPOT = 'hidden absolute rounded-xl ring-2 ring-violet-500 dark:ring-violet-400 '\s*\+ 'shadow-\[0_0_0_200vmax_black\] shadow-zinc-950\/60 dark:shadow-zinc-950\/75';/);
  // With no hole to cut, the full-screen top shade takes the dim instead.
  assert.match(OVERLAY_SRC, /const NO_HOLE_DIM = \['bg-zinc-950\/60', 'dark:bg-zinc-950\/75'\] as const;/);
  assert.match(OVERLAY_SRC, /for \(const cls of NO_HOLE_DIM\) top\.classList\.toggle\(cls, !at\);/);
});

test('the sidebar rail is not a bottom tab bar', () => {
  // #3240, the critical one: from 768px up #platform-tabs is the rail down
  // the left edge, and taking it for a bottom bar made the inset 748px on a
  // 1280x800 screen, so steps 2, 4 and 7 drew a blue line and nothing else.
  const laptop = { width: 1280, height: 800 };
  assert.equal(spotlight.bottomBarInset({ top: 52, left: 0, width: 240, height: 748 }, laptop), 0);
  const phone = { width: 390, height: 844 };
  assert.equal(spotlight.bottomBarInset({ top: 761, left: 0, width: 390, height: 83 }, phone), 83);
  assert.equal(spotlight.bottomBarInset({ top: 0, left: 0, width: 0, height: 0 }, phone), 0, 'no bar');
  // With the rail out of it, the Your apps hole on that laptop is the
  // section, not a line.
  const hole = spotlight.fitHole(spotlight.padRect({ top: 72, left: 260, width: 984, height: 276 }), laptop,
    spotlight.bottomBarInset({ top: 52, left: 0, width: 240, height: 748 }, laptop), 52);
  assert.equal(hole.height, 292);
  assert.ok(spotlight.usableHole(hole));
  assert.match(OVERLAY_SRC, /return bottomBarInset\(bar\.getBoundingClientRect\(\), \{ width: window\.innerWidth, height: window\.innerHeight \}\);/);
});

test('holes stay below the header and inside their own bar', () => {
  const viewport = { width: 1280, height: 800 };
  // A target scrolled up under the 52px header: the ring stops at its edge.
  const under = spotlight.fitHole({ top: 10, left: 100, width: 300, height: 200 }, viewport, 0, 52);
  assert.equal(under.top, 52 + spotlight.RING_WIDTH);
  assert.equal(under.top + under.height, 210);
  // A tab keeps its hole inside the bar, with a small pad: the full pad cut
  // into the neighbouring tabs' labels and left a strip of page above the
  // bar undimmed.
  const bar = { top: 761, left: 0, width: 390, height: 83 };
  const me = spotlight.fitHoleIn(spotlight.padRect({ top: 763, left: 312, width: 78, height: 52 }, spotlight.BAR_PAD), bar);
  assert.equal(me.top, 763, 'inside the bar, where the tab starts');
  assert.ok(me.top >= bar.top + spotlight.RING_WIDTH);
  assert.equal(me.left + me.width, 390 - spotlight.RING_WIDTH);
  assert.equal(me.left, 310);
  // A hole squeezed to a line is not painted.
  assert.equal(spotlight.usableHole({ top: 845, left: 0, width: 390, height: 0 }), false);
  assert.equal(spotlight.usableHole({ top: 0, left: 0, width: 300, height: 23 }), false);
  assert.equal(spotlight.usableHole(null), false);
  assert.equal(spotlight.usableHole({ top: 0, left: 0, width: 24, height: 24 }), true);
  // Whole pixels, so sub-pixel jitter is not a new geometry every frame.
  assert.deepEqual(spotlight.roundBox({ top: 643.4, left: 11.6, width: 366.2, height: 48.3 }),
    { top: 643, left: 12, width: 366, height: 49 });
  // The overlay picks the bar's rule for a target in one.
  assert.match(OVERLAY_SRC, /for \(const id of \['platform-header', 'platform-tabs'\]\)/);
  assert.match(OVERLAY_SRC, /hole = fitHoleIn\(padRect\(rect, inTabs \? BAR_PAD : SPOTLIGHT_PAD\), roundBox\(bar\.getBoundingClientRect\(\)\)\);/);
});

test('on a phone, the card clears the whole menu sheet when there is room above it', () => {
  // The card sat on the sheet's title and close button while pointing at the
  // action well below them.
  const viewport = { width: 390, height: 844 };
  const card = { width: spotlight.cardWidth(390), height: 208 };
  const panel = { top: 579, left: 0, width: 390, height: 265 };
  const hole = { top: 650, left: 8, width: 374, height: 64 };
  const placed = spotlight.placeCardForPanel(viewport, card, hole, panel);
  assert.equal(placed.top + card.height, panel.top - spotlight.CARD_GAP);
  // No room above the sheet: back to clearing the row.
  const tall = { top: 150, left: 0, width: 390, height: 694 };
  assert.deepEqual(spotlight.placeCardForPanel(viewport, card, { ...hole, top: 300 }, tall),
    spotlight.placeCard(viewport, card, { ...hole, top: 300 }));
});

// ── the way back in ────────────────────────────────────────────────────

test('Settings offers Replay the tour, and it is a registered section', () => {
  const html = renderComponent('frontend/src/features/settings/sections/tour.tsx', 'TourSection');
  assert.match(html, /data-settings-section="tour"/);
  assert.match(html, /class="hidden"/, 'the pane ships hidden, like its siblings');
  assert.match(html, /id="settings-tour-replay"/);
  assert.match(html, /Replay the tour/);
  // Registered in the menu, a page of its own under Help & about.
  assert.match(SETTINGS_JS, /\{ key: 'tour', label: 'Welcome tour', group: 'Help & about' \}/);
});

test('Replay clears the flag, asks for the tour, then goes to Home', () => {
  const fn = SETTINGS_SECTION_SRC.slice(SETTINGS_SECTION_SRC.indexOf('function replay'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.ok(body.indexOf('clearDone(currentUserId())') < body.indexOf('requestTour()'));
  assert.ok(body.indexOf('requestTour()') < body.indexOf('navigateHome'));
});

test('the replay request survives the chunk boundary between Settings and Home', () => {
  // The settings panes are a lazy chunk and the overlay rides the shell, so
  // the counter lives on window rather than in a module, the same way
  // lib/visibility-store.ts reasons about load order.
  const REQUEST_SRC = read(`${TOUR_DIR}/tour-request.ts`);
  assert.match(REQUEST_SRC, /export const TOUR_REQUEST_KEY = '__usernodeTourRequest'/);
  assert.match(REQUEST_SRC, /store\.count \+= 1;/);
  assert.match(REQUEST_SRC, /useSyncExternalStore\(subscribe, readTourRequest, \(\) => 0\)/);
});

test('the tour never reads or writes the challenge-based onboarding gate', () => {
  for (const src of [STEPS_SRC, STORAGE_SRC, SETTINGS_SECTION_SRC]) {
    assert.doesNotMatch(src, /setupFinished/);
    assert.doesNotMatch(src, /HomePanels/);
  }
  // Communities, stage 5: the tour no longer points at Challenges at all.
  // Its first steps are the Getting started card's, which it points at
  // instead.
  assert.ok(!steps.TOUR_STEPS.some((s) => s.id === 'challenges'));
});

// ── done on the account (#3237), executed ──────────────────────────────

/**
 * tour-done.ts, bundled and run against a stubbed `window.App`, `fetch` and
 * console. The rules are pure functions, so each scenario the request names
 * is played through them the way the overlay plays it, with the overlay's own
 * wiring pinned separately below.
 */
const doneApi = loadTsx(`${TOUR_DIR}/tour-done.ts`);

function withShell({ user = { id: 7 }, fromSnapshot = false, bootSession, fetchImpl } = {}) {
  const before = {
    window: globalThis.window, fetch: globalThis.fetch, warn: console.warn, error: console.error,
  };
  const saved = [];
  const posts = [];
  const warnings = [];
  const errors = [];
  const App = {
    user,
    _sessionFromSnapshot: fromSnapshot,
    saveSessionSnapshot: (u) => saved.push(JSON.parse(JSON.stringify(u))),
  };
  if (bootSession) App.bootSession = bootSession;
  globalThis.window = { App };
  globalThis.fetch = async (url, init) => {
    posts.push({ url, method: init && init.method, credentials: init && init.credentials });
    return fetchImpl ? fetchImpl(url, init) : { ok: true, status: 200 };
  };
  console.warn = (...args) => warnings.push(args);
  console.error = (...args) => errors.push(args);
  const restore = () => {
    globalThis.window = before.window;
    globalThis.fetch = before.fetch;
    console.warn = before.warn;
    console.error = before.error;
  };
  return { App, saved, posts, warnings, errors, restore };
}

test('an answered join screen is never copied back over an account reset (#3190)', () => {
  const { needsBackfill } = doneApi;
  for (const serverDone of [false, true]) {
    for (const localDone of [false, true]) {
      assert.equal(needsBackfill({ serverDone, localDone, joinShownHere: true, joinPending: false }), false,
        'a reset account\'s "done" is never copied back to the account');
    }
  }
  // Nothing decides whether the tour OPENS any more (#3240), so the rules
  // that did are gone.
  assert.equal(doneApi.isTourDone, undefined);
  assert.equal(doneApi.whenSessionRead, undefined);
});

test('a browser with the flag copies it to the account, and only then', () => {
  const { needsBackfill } = doneApi;
  const base = { serverDone: false, localDone: true, joinShownHere: false, joinPending: false };
  assert.equal(needsBackfill(base), true, 'finished here before this shipped: backfill');
  assert.equal(needsBackfill({ ...base, serverDone: true }), false, 'the account already has it');
  assert.equal(needsBackfill({ ...base, localDone: false }), false, 'nothing to copy');
  assert.equal(needsBackfill({ ...base, joinPending: true }), false,
    'a join screen still to come is a reset account: its tour is due again');
});

test('the account\'s answer is read off App.user, for this viewer only', () => {
  const shell = withShell({ user: { id: 7, tourDone: true } });
  try {
    assert.equal(doneApi.serverDone(7), true);
    assert.equal(doneApi.serverDone(8), false, 'another account\'s answer is not this one\'s');
    assert.equal(doneApi.serverDone(null), false);
    shell.App.user = { id: 7 };
    assert.equal(doneApi.serverDone(7), false, 'a /me without the field (an older snapshot) is "not done"');
    shell.App.user = null;
    assert.equal(doneApi.serverDone(7), false);
  } finally { shell.restore(); }
});

test('Finish and Skip record done on the account: one POST, and App.user and the snapshot learn it', async () => {
  const shell = withShell({ user: { id: 7, username: 'ada' } });
  try {
    assert.equal(await doneApi.markDoneOnServer(7), true);
    assert.deepEqual(shell.posts, [{ url: '/api/me/tour-done', method: 'POST', credentials: 'same-origin' }]);
    assert.equal(doneApi.TOUR_DONE_PATH, '/api/me/tour-done');
    assert.equal(shell.App.user.tourDone, true, 'this document knows at once');
    assert.equal(shell.saved.length, 1, 'and the snapshot the next boot starts from carries it');
    assert.equal(shell.saved[0].tourDone, true);
    assert.equal(await doneApi.markDoneOnServer(null), false, 'no viewer, no write');
    assert.equal(shell.posts.length, 1);
  } finally { shell.restore(); }
});

test('a write that lands tells the Getting started card, whose tour row ticks', async () => {
  const shell = withShell({ user: { id: 7 } });
  const events = [];
  const before = { document: globalThis.document, CustomEvent: globalThis.CustomEvent };
  globalThis.CustomEvent = class { constructor(type) { this.type = type; } };
  globalThis.document = { dispatchEvent: (e) => events.push(e.type) };
  try {
    assert.equal(doneApi.TOUR_DONE_EVENT, 'sv:tour-done');
    assert.equal(await doneApi.markDoneOnServer(7), true);
    assert.deepEqual(events, ['sv:tour-done']);
    shell.restore();
    const failed = withShell({ user: { id: 7 }, fetchImpl: () => ({ ok: false, status: 503 }) });
    try {
      assert.equal(await doneApi.markDoneOnServer(7), false);
      assert.deepEqual(events, ['sv:tour-done'], 'nothing to announce when the account does not have it');
    } finally { failed.restore(); }
    // And no document at all is not a throw.
    globalThis.document = undefined;
    const bare = withShell({ user: { id: 7 } });
    try { assert.equal(await doneApi.markDoneOnServer(7), true); } finally { bare.restore(); }
  } finally {
    globalThis.document = before.document;
    globalThis.CustomEvent = before.CustomEvent;
  }
  const CARD = read('frontend/src/features/home/getting-started.tsx');
  assert.match(CARD, /document\.addEventListener\(TOUR_DONE_EVENT, onChange\);/);
});

test('a replay finished on a verified session sets done again, on the account too', async () => {
  // Settings' Replay clears only this browser's flag and asks: the account's
  // "done" does not stop it (the replay path never reads it), and finishing
  // records it on both again.
  const shell = withShell({ user: { id: 7, tourDone: true } });
  try {
    assert.equal(await doneApi.markDoneOnServer(7), true);
    assert.equal(shell.posts.length, 1, 'the write is idempotent server-side, so it is simply sent');
    assert.equal(shell.App.user.tourDone, true);
  } finally { shell.restore(); }
});

test('a failed write never throws and never logs a console.error', async () => {
  for (const fetchImpl of [
    () => { throw new TypeError('Failed to fetch'); },
    () => ({ ok: false, status: 503 }),
    () => ({ ok: false, status: 401 }),
  ]) {
    const shell = withShell({ user: { id: 7 }, fetchImpl });
    try {
      assert.equal(await doneApi.markDoneOnServer(7), false);
      assert.equal(shell.errors.length, 0, 'a console.error fails proposal checks on any route');
      assert.equal(shell.warnings.length, 1, 'a warning at most');
      assert.equal(shell.App.user.tourDone, undefined, 'nothing is claimed that the account does not have');
      assert.equal(shell.saved.length, 0);
    } finally { shell.restore(); }
  }
});

test('a snapshot boot is not rewritten, and is not trusted to backfill', async () => {
  const shell = withShell({ user: { id: 7 }, fromSnapshot: true });
  try {
    assert.equal(doneApi.sessionVerified(7), false,
      'the snapshot\'s user may be an account an admin has since reset');
    assert.equal(await doneApi.markDoneOnServer(7), true);
    assert.equal(shell.App.user.tourDone, true);
    assert.equal(shell.saved.length, 0, 'rewriting it would keep refreshing its age (app.js enterAuthed)');
    shell.App._sessionFromSnapshot = false;
    assert.equal(doneApi.sessionVerified(7), true, 'confirmed: now it is the server\'s user');
    assert.equal(doneApi.sessionVerified(8), false, 'for this viewer only');
  } finally { shell.restore(); }
});

test('the overlay backfills the account once, and forgets this browser\'s "done" after a join screen', () => {
  // A join screen shown here is a new or reset account: this browser's
  // "done" goes, as the reset took the account's, or the backfill would
  // write it straight back on the next load.
  const forget = OVERLAY_SRC.slice(OVERLAY_SRC.indexOf('const forget = () => {'));
  assert.match(forget.slice(0, forget.indexOf('}, [userId]);')),
    /if \(!firstRunShownHere\(\)\) return;\s*clearDone\(userId\);\s*clearStep\(userId\);[\s\S]*document\.addEventListener\('sv:communities-joined', forget\);/);
  // A request never asks whether the tour is done: it opens it now.
  const replay = OVERLAY_SRC.slice(OVERLAY_SRC.indexOf('const request = useTourRequest();'));
  assert.doesNotMatch(replay.slice(0, replay.indexOf('}, [request, start]);')), /tourDoneFor|readDone|serverDone/);
  // The backfill: verified sessions only, looked at again on sv:session, once.
  const back = OVERLAY_SRC.slice(OVERLAY_SRC.indexOf('const backfilledFor = useRef<number | null>(null);'));
  const effect = back.slice(0, back.indexOf('}, [userId]);'));
  assert.match(effect, /if \(userId == null \|\| isDeterministicRoute\(\)\) return;/,
    'never on a capture route, where no POST may land');
  assert.match(effect, /if \(backfilledFor\.current === userId \|\| !sessionVerified\(userId\)\) return;/);
  assert.match(effect, /joinShownHere: firstRunShownHere\(\),\s*joinPending: firstRunPending\(\),/);
  assert.match(effect, /backfilledFor\.current = userId;\s*void markDoneOnServer\(userId, \{ ended: 'backfill' \}\);/);
  assert.match(effect, /document\.addEventListener\('sv:session', check\);/);
  assert.match(effect, /return \(\) => document\.removeEventListener\('sv:session', check\);/);
});
