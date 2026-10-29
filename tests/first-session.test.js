'use strict';

// The first session's walk on Home and its tour engine, and the way an
// invite brings somebody in (frontend/src/features/first-session). The tours
// point at real screens, so what is pinned here is that every step names a
// control or region the shell really has, that the island adds nothing to
// the prerendered document, and the seams that open it: App._followInvite
// asks it, and the invite's standing says when the viewer joined. The tip in
// the app and when the tip and the walk are due: tests/first-session-app-tip.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadTsx, renderComponent, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const DIR = 'frontend/src/features/first-session';
const GC_FORM_SRC = 'frontend/src/features/group-chat/composer.tsx';

test('the walk on Home: three cards, each ringing one place, with Next, and Done on the last', () => {
  const { homeWalkSteps, tileOf } = loadTsx(`${DIR}/tour-steps.ts`);
  const steps = homeWalkSteps({ slug: 'sunday-run-club', name: 'Sunday Run Club' });
  // Evan, 15 Oct 2026 ("1, 2, 3 on Home"): the project's tile, Homeroom bot
  // (in AI since #6019), and Communities, one short title and one short sentence
  // each, and each about the reader's own project ("a more contextual
  // tour", the same day). A project with no example change (one Homeroom
  // bot built, a game, an import) gets the bot card's words without one.
  assert.deepEqual(steps.map((s) => [s.screen, s.target, s.title, s.text]), [
    ['home', '#app-list .app-card[data-slug="sunday-run-club"]', 'Welcome to Homeroom', 'Sunday Run Club lives here, on Home.'],
    ['home', '#platform-tab-ai', 'Homeroom bot', 'It\'s in AI. Ask it to make any changes to Sunday Run Club.'],
    ['home', '#platform-tab-workshop', 'Communities', 'Sunday Run Club\'s hub is here. Invite people and decide what changes.'],
  ]);
  assert.deepEqual(homeWalkSteps({ slug: 'sunday-run-club', name: 'Sunday Run Club', example: null }), steps, 'null is no example');
  // A project made from a ready-made starter: its example change, in
  // curly quotes, on the same card; the cards, places and buttons are the same.
  const best = homeWalkSteps({ slug: 'best-eats', name: 'Best Eats', example: 'add a cheap eats tier' });
  assert.deepEqual(best.map((s) => [s.target, s.title, s.text]), [
    ['#app-list .app-card[data-slug="best-eats"]', 'Welcome to Homeroom', 'Best Eats lives here, on Home.'],
    ['#platform-tab-ai', 'Homeroom bot', 'Ask it for changes, like “add a cheap eats tier”.'],
    ['#platform-tab-workshop', 'Communities', 'Best Eats\'s hub is here. Invite people and decide what changes.'],
  ]);
  const plain = homeWalkSteps({ slug: 'best-eats', name: 'Best Eats' });
  assert.deepEqual(best.map(({ text, ...rest }) => rest), plain.map(({ text, ...rest }) => rest), 'only the words change');
  assert.equal(message('onboarding:firstSession.walk.bot.textExample', { example: 'add a packing list' }), 'Ask it for changes, like “add a packing list”.');
  // A walk that somehow has no name says the slug, never an empty space.
  assert.equal(homeWalkSteps({ slug: 'best-eats' })[0].text, 'best-eats lives here, on Home.');
  assert.equal(steps[0].target, tileOf('sunday-run-club'), 'the tile in Home\'s own grid, never a Discover card');
  // Nobody is taken anywhere: no step is a tap, each rings its place, and
  // the last one ends it.
  assert.deepEqual(steps.map((s) => [!!s.tap, !!s.ringed, !!s.last]), [[false, true, false], [false, true, false], [false, true, true]]);
  // Nothing is pressed, waited for or opened: no "Tap …" link, no menu, no
  // other screen.
  for (const s of steps) {
    for (const f of ['tap', 'press', 'waitsFor', 'inMenu', 'opensNext', 'alongside', 'endsAbove', 'saysWhereItOpens', 'revealWith']) {
      assert.equal(s[f], undefined, `${s.target} ${f}`);
    }
  }
});

// No waitlist card for a private member (Evan, 20 Oct 2026, "they can just
// discover that"): the invited person's walk is the same three cards, and
// the Communities card is its last.
test('a private member\'s walk is the same three cards; no card of any tour says group, shouts or dashes', () => {
  const { homeWalkSteps, lookAroundSteps } = loadTsx(`${DIR}/tour-steps.ts`);
  const three = homeWalkSteps({ slug: 'best-brunch', name: 'Best Brunch' });
  const withExample = homeWalkSteps({ slug: 'best-brunch', name: 'Best Brunch', example: 'add a price range to each place' });
  assert.equal(three.length, 3);
  assert.equal(three[2].target, '#platform-tab-workshop');
  assert.equal(three[2].last, true);
  const src = read(`${DIR}/tour-steps.ts`);
  assert.doesNotMatch(src, /home-waitlist-card|walk\.waitlist|privateMember/);
  const all = JSON.stringify([...three, ...withExample, ...lookAroundSteps()]);
  assert.doesNotMatch(all, /\bgroup\b/i);
  assert.doesNotMatch(all, /!|—/, 'no exclamation marks, no em dashes');
});

// "A more contextual tour" (Evan, 15 Oct 2026): the bot card's example is
// the project's ready-made starter's (services/app-templates.js
// exampleChange), read from GET /api/apps/:slug's `exampleChange` once as
// the walk opens, whoever it is for (a maker, an invited newcomer, a private
// member), and before a screenshot state opens it, so its second card shows
// the example at once. The route's side is tests/app-templates.test.js.
test('the walk asks for its project\'s example change once as it opens, and a screenshot state asks first', () => {
  const { walkExampleOf } = loadTsx(`${DIR}/index.tsx`);
  assert.equal(walkExampleOf({ app: { slug: 'best-eats', exampleChange: 'add a cheap eats tier' } }), 'add a cheap eats tier');
  for (const body of [null, 'x', {}, { app: null }, { app: {} }, { app: { exampleChange: null } }, { app: { exampleChange: '  ' } }, { app: { exampleChange: 42 } }]) {
    assert.equal(walkExampleOf(body), null, JSON.stringify(body));
  }
  const src = read(`${DIR}/index.tsx`);
  // Past the service worker's boot cache, as the made screen reads it, and
  // never a throw: a read that fails is the card without an example.
  assert.match(src, /const res = await fetch\(madeAppUrl\(slug\), \{ credentials: 'same-origin', cache: 'no-store' \}\);\s+return res\.ok \? walkExampleOf\(await res\.json\(\)\) : null;\s+\} catch \{\s+return null;/);
  // The steps carry the project's name and example.
  assert.match(src, /const \{ slug, name, example \} = mode\.info;\s+return homeWalkSteps\(\{ slug, name, example \}\);/);
  // Asked once, for a walk that has not asked yet, and kept only for that walk.
  assert.match(src, /const walkSlug = mode\.kind === 'tour' && mode\.path === 'walk' && mode\.info\.example === undefined \? mode\.info\.slug : null;/);
  assert.match(src, /setMode\(\(prev\) => \(prev\.kind === 'tour' && prev\.path === 'walk' && prev\.info\.slug === walkSlug && prev\.info\.example === undefined\s+\? \{ \.\.\.prev, info: \{ \.\.\.prev\.info, example \} \}\s+: prev\)\);/);
  // `?shot=tour-home`: the first project on Home, its name and its example.
  assert.match(src, /const project = await firstHomeProject\(\);\s+if \(!project\) return;\s+const example = await walkExample\(project\.slug\);\s+open\(\{ \.\.\.project, example \}\);/);
});

// #4225: both paths show where Suggest an improvement lives, inside the app,
// and say what happens to one (run six, 14 Oct 2026: in one short sentence,
// "Homeroom bot starts building it for you."). #4390: the app is shown first,
// then the reader taps the Homeroom mark and the real menu opens, its Suggest
// button pointed at but not pressed (Next, so no suggestion starts), and ✕
// last.
test('a step in the Homeroom menu opens it, closes it when the reader moves on, and is drawn over it', () => {
  const { APP_MENU } = loadTsx(`${DIR}/tour-steps.ts`);
  assert.equal(APP_MENU, '#apps-switcher-sheet');
  assert.match(read('frontend/src/features/app-context/app-context-sheet.tsx'), /id="apps-switcher-sheet"/);
  // The tour opens the menu for that step (Back to it too), closes it when
  // the reader moves on (Skip too), and is drawn over it: on touch the menu
  // is a kit sheet at 9991, whose backdrop sat over the card's Next.
  const src = read(`${DIR}/index.tsx`);
  assert.match(src, /const inMenu = !!step\.inMenu;\s+useEffect\(\(\) => \{\s+if \(!inMenu\) return undefined;\s+if \(!AppContext\.isOpen\(\)\) AppContext\.open\(\);\s+return \(\) => \{ if \(AppContext\.isOpen\(\)\) void AppContext\.close\(\); \};\s+\}, \[inMenu, index\]\);/);
  assert.match(src, /className=\{step\.inMenu \? 'pointer-events-none fixed inset-0 z-\[9995\]' : 'pointer-events-none fixed inset-0 z-\[9000\]'\}/);
  assert.match(src, /\(to < index && !steps\[to\]\.inMenu\)\) enterScreen\(/, 'Back to the menu step stays on the app');
  // A press on the tour, its Next included, is not an outside click that
  // shuts the menu under the step pointing into it.
  const ctx = read('frontend/src/features/app-context/index.tsx');
  assert.match(ctx, /const FIRST_SESSION_TOUR = '\[data-first-session-tour\]';/);
  assert.match(ctx, /tour\?\.contains\(t\) \|\| firstSession\?\.contains\(t\)\)\) return;/);
});

// Every selector a step names: what it cuts out, what it draws alongside,
// the bars it stops above and the control it presses.
const SELECTOR_FIELDS = ['target', 'alongside', 'endsAbove', 'press'];
const idsNamed = (steps) => [...new Set(steps
  .flatMap((s) => SELECTOR_FIELDS.flatMap((f) => (s[f] ? s[f].split(',') : [])))
  .map((t) => t.trim())
  .map((t) => /^#([\w-]+)/.exec(t))
  .filter(Boolean)
  .map((m) => m[1]))].sort();

test('every id the tour points at is one the shell ships', () => {
  const { homeWalkSteps, lookAroundSteps } = loadTsx(`${DIR}/tour-steps.ts`);
  assert.deepEqual(idsNamed(homeWalkSteps({ slug: 'x' })), ['app-list', 'platform-tab-ai', 'platform-tab-workshop']);
  assert.deepEqual(idsNamed(lookAroundSteps()), ['home-create-tile', 'home-discover-section', 'platform-tab-ai', 'platform-tab-workshop']);
  // #6019: Home's Discover section is React's, one element.
  assert.equal((read('frontend/src/features/home/panels/sections.tsx').match(/id="home-discover-section"/g) || []).length, 1);
  // Home's New project tile is React's, one element, and dapp.json's checks
  // select it by this id.
  assert.match(read('frontend/src/features/home/create-tile.tsx'), /id="home-create-tile"/);
  assert.ok(read('dapp.json').includes('#home-create-tile'));
  // Home's own grid, the tile's home (React's; the Discover rail's cards are
  // `.app-card`s too, outside it).
  assert.equal((read('frontend/src/features/home/app-grid.tsx').match(/^\s+id="app-list"$/gm) || []).length, 1);
  // The waitlist card is React's own section.
  assert.equal((read('frontend/src/features/home/waitlist-card.tsx').match(/<section id="home-waitlist-card"/g) || []).length, 1);
  // The Homeroom mark, the header's menu button the tip points at, is React's.
  assert.equal((read('frontend/src/features/header/platform-mark.tsx').match(/id="platform-mark-btn"/g) || []).length, 1);
  // The tab bar and the Resume strip on it are React's, each one element.
  assert.equal((read('frontend/src/features/nav/tab-bar.tsx').match(/id="platform-tabs"/g) || []).length, 1);
  assert.equal((read('frontend/src/features/nav/parked-strip.tsx').match(/id="platform-parked"/g) || []).length, 1);
  // The tab bar draws its tabs' ids from their keys, and dapp.json's checks
  // select the Communities tab by this one.
  assert.ok(read('dapp.json').includes('#platform-tab-workshop'));
});

test('the Communities and AI steps point at the bar\'s own tabs, the same elements on a phone and the rail; Discover at Home\'s section', () => {
  const { homeWalkSteps, lookAroundSteps } = loadTsx(`${DIR}/tour-steps.ts`);
  assert.deepEqual(homeWalkSteps({ slug: 'x' }).slice(1).map((s) => s.target), ['#platform-tab-ai', '#platform-tab-workshop']);
  assert.deepEqual(lookAroundSteps().slice(1).map((s) => s.target), ['#home-discover-section', '#platform-tab-workshop', '#platform-tab-ai']);
  // One <a> per tab, its id drawn from its key, inside the one #platform-tabs
  // that app.css lays out as the phone's bottom bar or, from 768px, the rail.
  const bar = read('frontend/src/features/nav/tab-bar.tsx');
  assert.match(bar, /\{ key: 'workshop' as const, label: 'core:tabs\.communities', href: '#communities', Icon: UserGroupIcon \}/);
  assert.match(bar, /\{ key: 'messages' as const, label: 'core:tabs\.messages', href: '#messages', Icon: ChatIcon \}/);
  assert.match(bar, /\{ key: 'ai' as const, label: 'core:tabs\.ai', href: '#ai', Icon: HomeroomBotIcon \}/);
  assert.deepEqual(['communities', 'messages', 'ai'].map((tab) => message(`core:tabs.${tab}`)),
    ['Communities', 'Messages', 'Homeroom bot']);
  assert.match(bar, /id=\{`platform-tab-\$\{key\}`\}/);
  assert.equal((bar.match(/id="platform-tabs"/g) || []).length, 1);
});

test('a step draws only its own target, measured before its card is painted', () => {
  const { boxForStep, pressForStep } = loadTsx(`${DIR}/index.tsx`);
  // 4 of 7 (the tour then) on a 375x812 browser drew its ring round step
  // 3's ✕, at the header's top-left, over Home's Homeroom logo: the card had moved on and
  // the box had not. A box counts only for the step it was measured for.
  const backBtn = { left: 16, top: 36, width: 28, height: 28 };
  assert.equal(boxForStep({ step: 2, box: backBtn }, 3), null);
  assert.deepEqual(boxForStep({ step: 3, box: backBtn }, 3), backBtn);
  // The control a step rings is measured with it, and counts only for it too.
  const appScreen = { left: 0, top: 0, width: 375, height: 812 };
  assert.equal(pressForStep({ step: 2, box: appScreen, press: backBtn }, 3), null);
  assert.deepEqual(pressForStep({ step: 3, box: appScreen, press: backBtn }, 3), backBtn);
  const src = read(`${DIR}/index.tsx`);
  assert.match(src, /const box = boxForStep\(measured, index\);\s+const pressBox = pressForStep\(measured, index\);/);
  // Measured in a layout effect when the step changes, so the first paint of
  // a step is its own target (or no ring at all), never the last one's.
  // Into a step in the menu from the step before it, that step's ring is kept
  // until the menu's sheet has settled (Evan, 10 Oct 2026: the ring rode up
  // with the sheet); any other step is measured at once.
  assert.match(src, /useLayoutEffect\(\(\) => \{\s+const before = measuredRef\.current;\s+if \(step\.inMenu && before\.step === index - 1 && before\.box\) \{\s+settleRef\.current = \{ at: index, since: performance\.now\(\), key: '', still: 0 \};\s+setSettling\(true\);\s+setMeasured\(\{ \.\.\.before, step: index \}\);\s+return;\s+\}\s+settleRef\.current = null;\s+setSettling\(false\);\s+setMeasured\(measure\(index, step\)\);\s+\}, \[index, step\]\);/);
  // It moves once, when the target has held still on screen (or the cap has
  // passed), over 200ms, and the card shows only then.
  assert.match(src, /if \(settle\.still >= SETTLE_FRAMES \|\| performance\.now\(\) - settle\.since > SETTLE_CAP_MS\) \{\s+settleRef\.current = null;\s+last = key;\s+setMoving\(true\);\s+setSettling\(false\);\s+setMeasured\(m\);/);
  assert.match(src, /const MOVE = 'motion-safe:transition-\[left,top,width,height\] motion-safe:duration-200 motion-safe:ease-out';/);
  // The per-frame follow tags what it measures with the step, and survives a
  // frame that throws rather than leaving the ring where it was.
  assert.match(src, /const m = measure\(at, stepRef\.current\);\s+const key = `\$\{at\}:\$\{boxKey\(m\.box\)\}:\$\{boxKey\(m\.press\)\}`;\s+const settle = settleRef\.current;\s+if \(settle && settle\.at === at\) \{[\s\S]{0,900}?\} else if \(key !== last\) \{ last = key; setMeasured\(m\); \}/);
  assert.match(src, /\} catch \{ \/\* measured again next frame \*\/ \}\s+raf = requestAnimationFrame\(tick\);/);
  assert.doesNotMatch(src, /setBox\(/);
});

test('the ring round a tab on the phone\'s bar stays on the screen', () => {
  const { holeFor } = loadTsx(`${DIR}/index.tsx`);
  const phone = { width: 375, height: 812 };
  // The Communities tab as the built shell lays it out at 375x812.
  const tab = { left: 211.734375, top: 756, width: 90.015625, height: 56 };
  const hole = holeFor(tab, phone);
  assert.equal(hole.left, tab.left - 6);
  assert.equal(hole.top, 750);
  // The padded box ran 6px past the bottom edge, and the ring with it; it
  // stops 3px (the ring's width) short of the edge now.
  assert.equal(hole.top + hole.height, 809);
  // A target clear of every edge keeps its full padding.
  assert.deepEqual(holeFor({ left: 100, top: 100, width: 50, height: 20 }, phone), { left: 94, top: 94, width: 62, height: 32 });
  // And one in the top-left corner keeps its ring on screen too.
  assert.deepEqual(holeFor({ left: 0, top: 0, width: 28, height: 28 }, phone), { left: 3, top: 3, width: 31, height: 31 });
});

// The walk a NEW user sees on their first Home after their app (Evan, 15 Oct
// 2026): each card numbered by small circles, "1 2 3", its own filled, in
// place of "1 of 3"; Skip and Next, no Back, and Done on the last card.
/** A tour's first paint (no effects), on a 390x844 phone with nothing measured. */
function drawTour(props) {
  const { Tour } = loadTsx(`${DIR}/index.tsx`);
  const had = { window: Object.hasOwn(globalThis, 'window'), document: Object.hasOwn(globalThis, 'document') };
  const before = { window: globalThis.window, document: globalThis.document };
  globalThis.window = { innerWidth: 390, innerHeight: 844 };
  globalThis.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
  try {
    return renderToHtml(createElement(Tour, { info: { slug: 'film', name: 'Friday Film Crew' }, onEnd() {}, ...props }));
  } finally {
    for (const k of ['window', 'document']) { if (had[k]) globalThis[k] = before[k]; else delete globalThis[k]; }
  }
}

test('the walk\'s cards: numbered circles for the counter, Skip and Next, no Back, and where it goes on the last', () => {
  const { homeWalkSteps } = loadTsx(`${DIR}/tour-steps.ts`);
  const steps = homeWalkSteps({ slug: 'film', name: 'Friday Film Crew' });
  const first = drawTour({ steps, numbered: true });
  assert.match(first, /data-first-session-tour="1"/);
  assert.match(first, /<ol data-first-session-steps="" aria-label="Step 1 of 3" class="mb-1\.5 flex items-center gap-1\.5">/);
  assert.equal((first.match(/<li /g) || []).length, 3, 'one circle per card');
  // This card's circle is filled in the ink that marks where you are; the
  // others are outlined.
  assert.match(first, /<li aria-current="step" class="flex h-5 w-5 items-center justify-center rounded-full bg-\[color:var\(--lit-ink\)\] text-\[11px\] font-bold leading-none text-white dark:text-zinc-950">1<\/li>/);
  assert.match(first, /<li class="flex h-5 w-5 items-center justify-center rounded-full text-\[11px\] font-bold leading-none text-zinc-500 [^"]*">2<\/li>/);
  assert.doesNotMatch(first, />1 of 3</, 'no counter');
  assert.match(first, />Welcome to Homeroom</);
  assert.match(first, />Friday Film Crew lives here, on Home\.</);
  assert.match(first, />Skip</);
  assert.match(first, />Next</);
  assert.doesNotMatch(first, />Back<|>Done<|>Go to community<|data-first-session-tap/);
  // The second card: still no Back.
  assert.doesNotMatch(drawTour({ steps, numbered: true, start: 1 }), />Back</);
  // The last says where it goes, and nothing else: the walk ends on the
  // project's hub under the Communities tab (walkDoneLanding), so the button
  // says so rather than "Done" and a page that changes without a reason.
  const last = drawTour({ steps, numbered: true, start: 2 });
  assert.match(last, /aria-label="Step 3 of 3"/);
  assert.match(last, /<li aria-current="step" [^>]*>3<\/li>/);
  assert.match(last, />Go to community</);
  assert.doesNotMatch(last, />Done<|>Skip<|>Back<|>Next<|>Got it<|data-first-session-tap/);
  // An invited private member's is the same (Evan, 20 Oct 2026): three
  // circles, and Go to community on the last.
  const invited = drawTour({ info: { slug: 'film', privateMember: true }, steps: homeWalkSteps({ slug: 'film' }), numbered: true, start: 2 });
  assert.equal((invited.match(/<li /g) || []).length, 3);
  assert.match(invited, />Go to community</);
  assert.doesNotMatch(invited, />Done</);
  // Only the walk is numbered this way; "Look around first" keeps its counter.
  const src = read(`${DIR}/index.tsx`);
  assert.match(src, /numbered=\{mode\.path === 'walk'\}/);
  assert.match(src, /\{index > 0 && !numbered \? \(/);
  assert.match(src, /\{step\.last \? \(numbered \? t\('onboarding:firstSession\.walk\.goToCommunity'\) : t\('onboarding:firstSession\.tour\.gotIt'\)\) : t\('onboarding:firstSession\.tour\.next'\)\}/);
  // `end` lands every walk done on its hub, a private member's too.
  assert.match(src, /const hub = how === 'done' && mode\.kind === 'tour' && mode\.path === 'walk' \? mode\.info\.slug : null;/);
});

/** A document of fixed boxes, by selector, for as long as `fn` runs. */
function withBoxes(boxes, fn) {
  const doc = {
    querySelectorAll: (selectors) => selectors.split(',').map((s) => s.trim())
      .flatMap((s) => (boxes[s] ? [boxes[s]] : []))
      .map((b) => ({ getBoundingClientRect: () => ({ ...b, right: b.left + b.width, bottom: b.top + b.height }) })),
  };
  const had = Object.hasOwn(globalThis, 'document');
  const before = globalThis.document;
  globalThis.document = doc;
  try { return fn(); } finally { if (had) globalThis.document = before; else delete globalThis.document; }
}

// The engine's cut-outs, over a step of each shape it draws (no tour has
// these since the walk replaced the tours that walked through the app, its
// hub and its menu; the engine still draws them).
const OPEN = '[data-open-app]';
const SCREEN_STEPS = (() => {
  const { SCREEN_HEADER, BOTTOM_BARS } = loadTsx(`${DIR}/tour-steps.ts`);
  return {
    app: { screen: 'app', target: '#app-view', alongside: SCREEN_HEADER, title: 'The app', text: 'Whole.', place: 'bottom' },
    close: { screen: 'app', target: '#back-btn', title: 'Close', text: 'Back to Home.', tap: 'Tap ✕' },
    tab: { screen: 'home', target: '#platform-tab-workshop', title: 'Communities', text: 'Here.', tap: 'Tap Communities' },
    hub: { screen: 'hub', target: '#app-content', alongside: SCREEN_HEADER, endsAbove: BOTTOM_BARS, press: OPEN, title: 'The hub', text: 'Open it.', place: 'bottom', tap: 'Tap Open app', last: true },
  };
})();

test('a screen\'s cut-out takes its header in and stops above the tab bar; a tap step rings its control', () => {
  const { measure, holeFor, aroundBox } = loadTsx(`${DIR}/index.tsx`);
  const steps = SCREEN_STEPS;
  // A 390x844 phone in the iOS app: the header's top padding is the status
  // bar's 47px inset, so its box starts at the top of the screen.
  const phone = { width: 390, height: 844 };
  const header = { left: 0, top: 0, width: 390, height: 99 };
  const screen = { left: 0, top: 91, width: 390, height: 753 };
  const tabs = { left: 0, top: 754, width: 390, height: 90 };
  const whole = { left: 0, top: 0, width: 390, height: 844 };

  // The app screen and its header, the whole screen, with nothing ringed in it.
  const backBtn = { left: 16, top: 55, width: 28, height: 28 };
  const app = withBoxes({ '#platform-header': header, '#app-view': screen, '#back-btn': backBtn }, () => measure(1, steps.app));
  assert.deepEqual(app, { step: 1, box: whole, press: whole });
  assert.deepEqual(holeFor(app.box, phone, 0), whole, 'runs to the screen\'s edges, with no line of dim round it');
  // Not on the app screen yet: no cut-out (the header alone is not one), so
  // the screen dims whole and the step opens its screen itself.
  assert.deepEqual(withBoxes({ '#platform-header': header, '#back-btn': backBtn }, () => measure(1, steps.app)), { step: 1, box: null, press: null });

  // ✕ alone, ringed, and all of it pressable.
  const close = withBoxes({ '#platform-header': header, '#app-view': screen, '#back-btn': backBtn }, () => measure(4, steps.close));
  assert.deepEqual(close, { step: 4, box: backBtn, press: backBtn });
  const ring = holeFor(close.press, phone);
  assert.deepEqual(ring, { left: 10, top: 49, width: 40, height: 40 });
  assert.deepEqual(aroundBox(holeFor(close.box, phone), ring), []);

  // A hub and its header, its padded foot meeting the tab bar, and its
  // `press` ringed, the only part of it a press reaches.
  const openApp = { left: 262, top: 112, width: 112, height: 36 };
  const hub = withBoxes({ '#platform-header': header, '#app-content': screen, '#platform-tabs': tabs, [OPEN]: openApp }, () => measure(7, steps.hub));
  assert.deepEqual(hub, { step: 7, box: { left: 0, top: 0, width: 390, height: 748 }, press: openApp });
  const hubHole = holeFor(hub.box, phone, 0);
  assert.deepEqual(hubHole, { left: 0, top: 0, width: 390, height: 754 });
  const openRing = holeFor(hub.press, phone);
  assert.deepEqual(openRing, { left: 256, top: 106, width: 124, height: 48 });
  assert.ok(aroundBox(hubHole, openRing).length > 0, 'the rest of the hub is covered');
  // With the app you left on the bar, it stops above that strip too.
  const parked = { left: 8, top: 702, width: 374, height: 52 };
  const hubParked = withBoxes({ '#platform-header': header, '#app-content': screen, '#platform-tabs': tabs, '#platform-parked': parked }, () => measure(7, steps.hub));
  assert.equal(holeFor(hubParked.box, phone, 0).height, 702);
  // From 768px up the bar is the rail beside the screen, and takes nothing off.
  const wide = withBoxes({
    '#platform-header': { left: 0, top: 0, width: 1280, height: 60 },
    '#app-content': { left: 224, top: 52, width: 1056, height: 748 },
    '#platform-tabs': { left: 0, top: 60, width: 224, height: 740 },
  }, () => measure(7, steps.hub));
  assert.deepEqual(wide.box, { left: 0, top: 0, width: 1280, height: 800 });

  // A tap step with no `press` rings its whole cut-out, and leaves all of it
  // pressable.
  const tab = { left: 211, top: 756, width: 90, height: 56 };
  const communities = withBoxes({ '#platform-tab-workshop': tab }, () => measure(6, steps.tab));
  assert.deepEqual(communities, { step: 6, box: tab, press: tab });
  const tabHole = holeFor(communities.box, phone);
  assert.deepEqual(aroundBox(tabHole, holeFor(communities.press, phone)), []);

  const src = read(`${DIR}/index.tsx`);
  assert.match(src, /const pointed = !!\(step\.tap \|\| step\.ringed\);/);
  assert.match(src, /const hole = box && !dimAll && holeFor\(box, viewport, pointed && !step\.press \? RING : 0\);/);
  assert.match(src, /const ring = hole && pointed && pressBox && !waiting \? holeFor\(pressBox, viewport\) : null;/);
  // Only a tap step leaves its ring pressable; a step that only points at a
  // control (the walk, "Look around first") covers it, so a press stays in
  // the tour.
  assert.match(src, /const covers = hole \? \(ring && step\.tap \? aroundBox\(hole, ring\) : \[hole\]\) : \[\];/);
  assert.match(src, /\{covers\.map\(\(cover, i\) => <div key=\{i\} className="pointer-events-auto fixed" style=\{cover\} \/>\)\}/);
});

// "Make 'tap to open it' also clickable (and the other steps like it) in the
// tutorial, don't change the styling tho, I like it blue. Maybe just a tap
// state, but not a button." (Evan, 5 October 2026)
test('the blue hint on a tap step presses the step\'s own control, and still looks like the words it was', () => {
  const { pressTarget, pressOf } = loadTsx(`${DIR}/index.tsx`);
  const steps = [
    { screen: 'home', target: '#app-list .app-card[data-slug="film"]', title: 'Friday Film Crew is on your Home', text: 'Open it from here.', tap: 'Tap it' },
    SCREEN_STEPS.close,
    SCREEN_STEPS.hub,
  ];
  // The control it presses is the one the step's watcher waits for.
  assert.deepEqual(steps.filter((s) => s.tap).map(pressOf), ['#app-list .app-card[data-slug="film"]', '#back-btn', OPEN]);

  // It presses the first one on screen, as a finger would, and nothing else.
  const control = (width) => {
    const el = { clicks: 0, getBoundingClientRect: () => ({ width, height: width ? 40 : 0 }), click() { el.clicks += 1; } };
    return el;
  };
  const offscreen = control(0);
  const shown = control(80);
  const later = control(80);
  const root = { querySelectorAll: (sel) => { root.asked = sel; return [offscreen, shown, later]; } };
  assert.equal(pressTarget('#back-btn', root), true);
  assert.equal(root.asked, '#back-btn');
  assert.deepEqual([offscreen.clicks, shown.clicks, later.clicks], [0, 1, 0]);
  assert.equal(pressTarget('#back-btn', { querySelectorAll: () => [offscreen] }), false, 'nothing on screen, nothing pressed');
  assert.equal(offscreen.clicks, 0);

  // Drawn: a real button, so a keyboard reaches it, named by its words, in
  // the blue it was, with a pressed state and no fill, edge or underline.
  const html = drawTour({ steps });
  const hint = html.match(/<button type="button" data-first-session-tap="" class="([^"]+)">Tap it<\/button>/);
  assert.ok(hint, 'the hint is a button whose name is its words');
  assert.equal(hint[1], 'py-1.5 text-[13px] font-semibold text-violet-700 transition-opacity active:opacity-60 dark:text-violet-400');
  assert.doesNotMatch(hint[1], /\b(bg-|border|ring|rounded|underline|shadow)/);

  // Pressed, it goes the one way a press on the control goes: the watcher
  // that moves the tour on matches the same control the hint presses.
  const src = read(`${DIR}/index.tsx`);
  assert.match(src, /onClick=\{\(\) => \{ pressTarget\(pressOf\(step\)\); \}\}/);
  assert.match(src, /const hit = Array\.from\(document\.querySelectorAll\(pressOf\(step\)\)\)\.some\(\(el\) => el\.contains\(t\)\);/);
  assert.match(src, /document\.addEventListener\('click', onClick, true\);/);
});

test('the island renders nothing until it is opened, so the prerender is unchanged', () => {
  const html = renderComponent(`${DIR}/index.tsx`, 'FirstSession');
  assert.equal(html, '');
  const shell = read('frontend/src/Shell.tsx');
  assert.match(shell, /<Island name="FirstSession"><FirstSession \/><\/Island>/);
  const src = read(`${DIR}/index.tsx`);
  // Shown once per account and project, and it says when it will not show.
  assert.match(src, /if \(!info \|\| !info\.slug \|\| seen\(info\.slug\)\) return false;/);
  // The layer lets presses through to the cut-out's own control.
  // Over the Homeroom menu for the step that points into it (TourStep.inMenu).
  assert.match(src, /className=\{step\.inMenu \? 'pointer-events-none fixed inset-0 z-\[9995\]' : 'pointer-events-none fixed inset-0 z-\[9000\]'\}/);
});

test('the Communities tab opens on the project the tour is about', () => {
  const src = read(`${DIR}/index.tsx`);
  assert.match(src, /const path = App\?\._workshopViewPath\?\.\(`\/app\/\$\{encodeURIComponent\(slug\)\}\/workshop`\);/);
  assert.match(src, /localStorage\.setItem\(key, JSON\.stringify\(\{ slug, path \}\)\)/);
  const app = read('public/js/app.js');
  assert.match(app, /_WORKSHOP_VIEW_KEY: 'usernode_workshop_view_v1',/);
});

test('App._followInvite welcomes somebody the link has just let in, and lands anyone else as before', () => {
  const app = read('public/js/app.js');
  // Just let in and not welcomed: where a Join lands (#3700). A member
  // reopening an old link: the hub, as before.
  assert.match(app, /const fresh = standing\.joinedAt && Date\.now\(\) - Date\.parse\(standing\.joinedAt\) < 30 \* 60 \* 1000;\s+if \(fresh && welcome\(standing, standing\.slug\)\) return;\s+(?:\/\/[^\n]*\n\s*)*if \(fresh\) \{ await App\._landJoined\(standing\.slug\); return; \}\s+openHub\(standing\.slug\);/);
  // Signed in before following it: an account that was already there,
  // unless the join's answer says it is a test account on its first sign-in.
  assert.match(app, /if \(welcome\(\{ \.\.\.standing, newAccount: result\.newAccount === true \}, result\.slug\)\) return;\s+await App\._landJoined\(result\.slug\);/);
  const invites = read('src/services/community-invites.js');
  assert.match(invites, /joinedAt: appliedAt instanceof Date \? appliedAt\.toISOString\(\) : \(appliedAt \|\| null\),\s+newAccount,/);
});

test('somebody an invite is bringing in is asked to join it once, and not what to make meanwhile', () => {
  const app = read('public/js/app.js');
  // The follow publishes whether it brought them in.
  assert.match(app, /async _followInvite\(token\) \{\s*App\._markNavigationVia\?\.\('handed'\);[\s\S]{0,400}App\._inviteFollow = new Promise\(\(resolve\) => \{ settle = resolve; \}\);\s+try \{/);
  // Unless the project's page took the link (#3700): its Join settles it.
  assert.match(app, /\} finally \{\s+if \(!deferred\) settle\(joinedHere\);\s+(?:\/\/[^\n]*\n\s*)*if \(held\) App\._endWelcomeHold\(\);\s+\}\s+\},/);
  assert.match(app, /if \(standing\.mine === 'joined' && standing\.slug\) \{\s+joinedHere = true;/);
  assert.match(app, /toast\(PlatformI18n\.t\(DEAD\[result\.reason\] \|\| 'shell:invite\.couldNotJoin'\), true\); return; \}\s+joinedHere = true;/);
  assert.equal(message('shell:invite.couldNotJoin'), 'Could not join. Try again.');
  // Join pressed on the link's page, then a password sign-in: no second ask.
  assert.match(app, /pressed = sessionStorage\.getItem\('usernode:invite-join'\) === `\/invite\/\$\{token\}`;\s+sessionStorage\.removeItem\('usernode:invite-join'\);/);
  assert.match(app, /const ok = pressed \? true : window\.ConfirmModal \? await ConfirmModal\.show\(\{/);
  const sheet = read('frontend/src/features/auth/sign-in-sheet.tsx');
  // The reset stays in the sheet (#5258), so the password sign-in after it is what remembers the Join.
  assert.match(sheet, /if \(followInvite\) rememberInviteJoin\(\);\s+await finish\('existing'\);/);
  assert.match(sheet, /sessionStorage\.setItem\('usernode:invite-join', location\.pathname\.replace\(\/\\\/\$\/, ''\)\);/);
  // The join step waits for the follow before it asks anything.
  const join = read('frontend/src/features/auth/communities-first-run.js');
  assert.match(join, /if \(await CommunitiesFirstRun\._joinedByInvite\(\)\) \{\s+CommunitiesFirstRun\._answered = true;/);
  assert.ok(join.indexOf('await CommunitiesFirstRun._joinedByInvite()') < join.indexOf('window.App.user.storyFirstSession === true'),
    'the invite is settled before the first session is offered');
  assert.match(join, /try \{ return \(await app\._inviteFollow\) === true; \} catch \(_\) \{ return false; \}/);
});

test('a join from the confirm reads Home\'s challenges again before the welcome opens on Home', () => {
  // Home painted its challenges before the confirm and caches them for a
  // minute, while the redeem counts "Join a community" before it answers
  // (routes/community-invites.js scoreOnJoin). The invited tour's first
  // screen is Home, where the cached read said Not started beside the
  // community just joined (first-session run-through, 2026-10-04).
  const app = read('public/js/app.js');
  const follow = app.slice(app.indexOf('async _followInvite(token) {'), app.indexOf('_deepLinkTarget() {'));
  assert.match(follow, /if \(!joined\.ok \|\| !result\.ok\) \{[^\n]*return; \}\s+joinedHere = true;\s+(?:\/\/[^\n]*\n\s*)*if \(result\.status === 'joined'\) window\.HomePanels\?\.ensureLoaded\?\.\(\{ force: true \}\);\s+if \(result\.slug\) \{\s+if \(welcome\(/,
    'after a join that went through, and before the welcome or the hub');
  const route = read('src/routes/community-invites.js');
  assert.match(route, /if \(result\.status === 'joined'\) await challengeScorer\.scoreOnJoin\(pool, config\);\s+(?:\/\/[^\n]*\n\s*)*const newAccount = result\.status === 'joined' && await testAccounts\.onFirstRun\(pool, req\.user\.id\);\s+return res\.json\(\{ \.\.\.result, newAccount \}\);/,
    'the credit is written before the answer the refresh follows');
  const panels = read('frontend/src/features/home/home-panels.js');
  assert.match(panels, /ensureLoaded\(opts\) \{\s+const force = !!\(opts && opts\.force\);/, 'force skips the minute-long cache');
});

test('a link answers the join screen for the person it brings in', () => {
  const invites = read('src/services/community-invites.js');
  assert.match(invites, /SET needs_communities_choice = FALSE,\s+getting_started_seen = COALESCE\(getting_started_seen, '\{\}'::jsonb\)\s+\|\| jsonb_build_object\('join_answer', 'invite'\)\s+WHERE id = \$1 AND needs_communities_choice = TRUE/);
  // communities_onboarded_at stays NULL: it records the join screen itself.
  // Nothing on Home waits on it: the Getting started card and its gate
  // stopped needing it in #4601, and are gone since #4635.
  assert.doesNotMatch(invites, /communities_onboarded_at = NOW\(\)/);
  const onboarding = read('src/services/onboarding.js');
  assert.doesNotMatch(onboarding, /function cardShows|getting_started_closed_at IS NULL/);
});

test('"You\'re in" is gone: an invite opens the app itself, owes the tip, and the walk only to somebody new', () => {
  const src = read(`${DIR}/index.tsx`);
  const mod = loadTsx(`${DIR}/index.tsx`);
  for (const gone of ['YoureIn', 'youreInShot', 'shotWelcome', 'membersOf', 'rosterOrder', 'inviterOf', 'peopleCount', 'firstVersionStage']) {
    assert.equal(mod[gone], undefined, gone);
  }
  assert.doesNotMatch(src, /kind: 'welcome'|<YoureIn|You're in, /);
  const catalog = JSON.parse(read('frontend/locales/en/onboarding.json'));
  for (const key of ['welcome.title', 'welcome.goTo', 'welcome.loadingPeople', 'welcome.member.you', 'welcome.member.invitedYou']) {
    assert.equal(catalog[`firstSession.${key}`], undefined, key);
  }
  // The held frame's own words stay.
  assert.equal(message('onboarding:firstSession.welcome.opening'), 'Opening your invite');
  // welcome(): the app, full screen, for everybody the link has let in; the
  // tip for all of them, with who sent the link; the walk only for somebody
  // new to Homeroom (a private member, or an account the link's sign-up
  // made). An account that was here before gets the tip alone.
  const welcome = src.slice(src.indexOf('welcome(info: FirstSessionInfo): boolean {'), src.indexOf('goHome('));
  assert.match(welcome, /if \(!info \|\| !info\.slug \|\| seen\(info\.slug\)\) return false;\s+markSeen\(info\.slug\);/);
  assert.match(welcome, /oweTip\(uid, \{ slug, name, who: 'invited', inviter: info\.inviterName \|\| null \}\);/);
  assert.match(welcome, /walkOwed = \(privateMember \|\| !!info\.newAccount\) && oweWalk\(uid, \{ slug, name, privateMember \}\);\s+if \(walkOwed\) app\?\._noteHomeWalk\?\.\('owed'\);/);
  assert.match(welcome, /const going = app\?\.navigateToApp\?\.\(slug, 'app'\);/);
  // Home is under the app for somebody owed the walk, so Back and the ✕ lead
  // to it: a public community's link is joined on its hub, which was under
  // the app before (the owner's run-through, 20 Oct 2026).
  assert.match(welcome, /rememberCommunity\(slug\);[\s\S]{0,240}if \(walkOwed\) app\?\._homeUnderApp\?\.\(\);[\s\S]*const going = app\?\.navigateToApp/);
  const under = read('public/js/app.js').slice(read('public/js/app.js').indexOf('_homeUnderApp() {'));
  assert.match(under.slice(0, 300), /const home = App\._rootUrl\(''\);\s+try \{\s+if \(`\$\{location\.pathname\}\$\{location\.search\}\$\{location\.hash\}` !== home\) history\.replaceState\(null, '', home\);/,
    'the page under it is replaced with Home, not pushed: Back is one step');
  // Both ways in hand over who sent it, by the name they go by.
  assert.match(read('public/js/app.js'), /inviter: standing\.inviter \|\| null,\s+inviterName: standing\.inviterName \|\| standing\.inviter \|\| null,/);
  assert.match(read('public/js/app.js'), /newAccount: !!standing\.newAccount,/);
  assert.match(read('src/services/collab-invites.js'), /inviter: row\.inviter \|\| null,\s+inviterName: row\.inviter_display_name/);
});

// ── First-session run-through, 5 October 2026 ──────────────────────────

test('neither way in hands over a picture or a description: the app is what they see', () => {
  assert.equal(fs.existsSync(path.join(ROOT, DIR, 'joined-picture.tsx')), false, 'the picture under the welcome is gone');
  const app = read('public/js/app.js');
  assert.doesNotMatch(app, /description: project\.description \|\| null,\s+picture: project\.picture \|\| null,/);
  const collab = read('src/services/collab-invites.js');
  assert.doesNotMatch(collab, /memberPicture|pictureFor/);
  assert.equal(require('../src/services/community-invites').memberPicture, undefined);
});

test('the people row: up to five faces, then +N, each in the colour the shell gives that name', () => {
  const { PeopleRow, peopleOf, moreThan, PEOPLE_FACES } = loadTsx(`${DIR}/people-faces.tsx`);
  const { swatchFor } = loadTsx('frontend/src/features/messages/format.tsx');
  assert.equal(PEOPLE_FACES, 5);
  const names = ['maya', 'priya', 'sam', 'jordan', 'ada', 'lee', 'kim'];
  assert.deepEqual(peopleOf(names.map((username) => ({ username, id: 1 }))).map((p) => p.username), names.slice(0, 5));
  assert.deepEqual(peopleOf([{ username: ' ' }, null, 'x', { username: 'ok' }]), [{ username: 'ok' }]);
  assert.deepEqual(peopleOf(null), []);
  assert.equal(moreThan(5, 8), 3);
  assert.equal(moreThan(2, 2), 0);
  assert.equal(moreThan(2, null), 0);
  const many = renderToHtml(createElement(PeopleRow, { people: peopleOf(names.map((username) => ({ username }))), count: 8, size: 'lg' }));
  assert.equal((many.match(/h-10 w-10/g) || []).length, 6, 'five faces and the +N');
  assert.match(many, /data-people-more=""[^>]*>\+3</);
  assert.match(many, /class="sr-only">8 people</);
  assert.match(many, new RegExp(`background:${swatchFor('maya')}">M<`));
  const two = renderToHtml(createElement(PeopleRow, { people: [{ username: 'maya' }, { username: 'priya' }], count: 2, size: 'lg' }));
  assert.doesNotMatch(two, /data-people-more/);
  assert.match(two, /class="sr-only">2 people</);
  assert.equal(renderToHtml(createElement(PeopleRow, { people: [] })), '', 'no faces, nothing');
});

// ── No Home between the invite's sheet and "You're in" ─────────────────
//
// Evan, 5 October 2026: joining from an invite (its page, Join, the sheet)
// showed Home for a moment before "You joined Geneva hike planner / You're
// in", while the shell read the link's standing. App._followInvite now asks
// the island for the welcome's frame in the tick the signed-in shell starts,
// before it draws Home, as the make screen's hand-off does (#3894).

const TOKEN = 'AAAAAAAAAAAAAAAAAAAAAA';

/** App._followInvite (and _endWelcomeHold) from app.js, against stand-ins. */
function followHarness({ fromLanding = true, landed = null, pressed = false, standing }) {
  const app = read('public/js/app.js');
  const methods = app.slice(app.indexOf('  async _followInvite(token) {'), app.indexOf('\n  _deepLinkTarget() {'));
  const events = [];
  let answer = null;
  const sandbox = {
    console, Promise, setTimeout, clearTimeout, Date, JSON, encodeURIComponent,
    location: { pathname: `/invite/${TOKEN}`, search: '' },
    history: { replaceState() { events.push('address'); } },
    sessionStorage: {
      store: { 'usernode:invite-join': pressed ? `/invite/${TOKEN}` : null, 'usernode:invite-landing': landed },
      getItem(key) { return this.store[key] ?? null; },
      removeItem(key) { this.store[key] = null; },
    },
    fetch: (url) => {
      events.push(url.endsWith('/redeem') ? 'redeem' : 'standing');
      if (url.endsWith('/redeem')) {
        return Promise.resolve({ status: 200, ok: true, json: async () => ({ ok: true, status: 'joined', slug: 'geneva', name: 'Geneva hike planner', newAccount: false }) });
      }
      return new Promise((resolve) => { answer = () => resolve({ status: 200, json: async () => standing }); });
    },
  };
  sandbox.window = sandbox;
  sandbox.UsernodeReact = {
    firstSession: {
      holdWelcome() { events.push('hold'); return true; },
      endHold() { events.push('endHold'); },
      welcome(info) { events.push(`welcome:${info.slug}`); return true; },
    },
  };
  sandbox.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  const App = vm.runInNewContext(`({ ${methods} })`, sandbox);
  Object.assign(App, {
    INVITE_LANDING_KEY: 'usernode:invite-landing',
    _markNavigationVia() {},
    _rootUrl: () => '/',
    restoreFromHash() { events.push('home'); },
    navigateToApp(slug) { events.push(`hub:${slug}`); },
    _inviteSessionEnded() { events.push('ended'); },
    _sessionFromSnapshot: false,
    _inviteLandingToken: fromLanding ? TOKEN : null,
  });
  sandbox.App = App;
  return { App, events, answer: () => answer(), sessionStorage: sandbox.sessionStorage };
}

const JOINED = {
  live: true, mine: 'joined', slug: 'geneva', joinedAt: new Date().toISOString(),
  project: { name: 'Geneva hike planner', iconEmoji: '🥾' }, inviterName: 'Evan', inviterMadeIt: true, newAccount: true,
};

test('a sign-in from the invite\'s page holds "You\'re in"\'s frame up before the shell draws Home', async () => {
  const run = followHarness({ standing: JOINED });
  const done = run.App._followInvite(TOKEN);
  // Synchronously, in the tick the signed-in shell starts: the frame, then
  // the address and Home under it.
  assert.deepEqual(run.events, ['hold', 'address', 'home'], 'held before Home is drawn');
  await Promise.resolve();
  run.answer();
  await done;
  assert.ok(run.events.indexOf('welcome:geneva') > run.events.indexOf('home'), 'the welcome fills the frame once the standing is read');
  assert.equal(run.App._inviteLandingToken, null, 'the landing\'s mark is spent');
});

test('the held frame goes for every other ending, and before a confirm', async () => {
  // Already a member: the hub, and the frame goes.
  const member = followHarness({ standing: { ...JOINED, joinedAt: '2026-01-01T00:00:00.000Z' } });
  let done = member.App._followInvite(TOKEN);
  await Promise.resolve();
  member.answer();
  await done;
  assert.deepEqual(member.events.filter((e) => e !== 'address'), ['hold', 'home', 'standing', 'hub:geneva', 'endHold']);

  // Not in yet and Join not pressed on the page: the frame goes before the
  // confirm is asked, never over it.
  const ask = followHarness({ standing: { live: true, mine: null, slug: null, project: { name: 'Geneva hike planner' } } });
  done = ask.App._followInvite(TOKEN);
  await Promise.resolve();
  ask.answer();
  await done;
  assert.ok(ask.events.indexOf('endHold') > -1 && ask.events.indexOf('endHold') < ask.events.indexOf('redeem'), ask.events.join(' '));

  // Join pressed, then a password sign-in: no confirm, the welcome.
  const pressed = followHarness({ pressed: true, standing: { live: true, mine: null, slug: null, project: { name: 'Geneva hike planner' } } });
  done = pressed.App._followInvite(TOKEN);
  await Promise.resolve();
  pressed.answer();
  await done;
  assert.ok(pressed.events.indexOf('welcome:geneva') > pressed.events.indexOf('redeem'));
  assert.ok(pressed.events.indexOf('endHold') === -1 || pressed.events.indexOf('endHold') > pressed.events.indexOf('welcome:geneva'),
    'nothing takes the frame down before the welcome is in it');

  // A link opened by somebody already signed in: nothing is held.
  const opened = followHarness({ fromLanding: false, standing: JOINED });
  done = opened.App._followInvite(TOKEN);
  assert.deepEqual(opened.events, ['address', 'home']);
  await Promise.resolve();
  opened.answer();
  await done;
  assert.equal(opened.events.includes('hold'), false);
});

test('the island draws the held frame at once, and only the frame goes when the follow ends otherwise', () => {
  const src = read(`${DIR}/index.tsx`);
  assert.match(src, /holdWelcome\(\): boolean \{\s+let held = false;\s+flushSync\(\(\) => setMode\(\(prev\) => \{/);
  assert.match(src, /endHold\(\): void \{\s+setMode\(\(prev\) => \(prev\.kind === 'held' && !prev\.app \? \{ kind: 'none' \} : prev\)\);/);
  assert.match(src, /if \(mode\.kind === 'held'\) return <WelcomeHeld \/>;/);
  // The landing marks the link it showed signed out.
  const app = read('public/js/app.js');
  assert.match(app, /App\._inviteLandingToken = inviteToken;\s+try \{ sessionStorage\.setItem\(App\.INVITE_LANDING_KEY, inviteToken\); \} catch \(_\) \{ \/\* this document only \*\/ \}\s+AuthScreens\.rememberDeepLink\(location\.pathname\);\s+AuthScreens\.show\('landing'\);/);
  // The frame is "You're in"'s own ground, so the welcome arrives on it.
  const { WelcomeHeld } = loadTsx(`${DIR}/index.tsx`);
  const { renderToHtml, createElement } = require('./lib/render-tsx');
  const html = renderToHtml(createElement(WelcomeHeld));
  assert.match(html, /data-first-session-welcome="held"/);
  assert.match(html, /class="fixed inset-0 z-\[9000\] flex flex-col text-zinc-900/);
  assert.match(html, /data-first-session-scroll="" class="min-h-0 flex-1 overflow-y-auto"/);
  assert.doesNotMatch(html, /data-first-session-foot/, 'the held frame has no button');
  assert.match(html, /background:var\(--home-wallpaper, #f4f2e4\)/);
  assert.match(html, /role="status">Opening your invite</);
});

// #4215: a sign-in from the invite's page does not always finish in the
// document that showed it. The move onto the live build reloads it after the
// code step, and a provider's trip comes back in a new one; the landing's
// mark rides this tab's sessionStorage so that boot is held too.
test('a sign-in that reloads after the code step is still held: the landing\'s mark survives in sessionStorage', async () => {
  const run = followHarness({ fromLanding: false, landed: TOKEN, standing: JOINED });
  const done = run.App._followInvite(TOKEN);
  assert.deepEqual(run.events, ['hold', 'address', 'home'], 'held before Home is drawn');
  assert.equal(run.sessionStorage.getItem('usernode:invite-landing'), null, 'the stored mark is spent at once');
  await Promise.resolve();
  run.answer();
  await done;
  assert.ok(run.events.includes('welcome:geneva'));

  // A mark left by another link's landing holds nothing.
  const other = followHarness({ fromLanding: false, landed: 'BBBBBBBBBBBBBBBBBBBBBB', standing: JOINED });
  const otherDone = other.App._followInvite(TOKEN);
  assert.deepEqual(other.events, ['address', 'home']);
  await Promise.resolve();
  other.answer();
  await otherDone;
  assert.equal(other.events.includes('hold'), false);

  // The landing writes the mark where finishLogin's reload cannot drop it,
  // under the key the follow reads.
  const app = read('public/js/app.js');
  assert.match(app, /INVITE_LANDING_KEY: 'usernode:invite-landing',/);
  const follow = app.slice(app.indexOf('  async _followInvite(token) {'), app.indexOf('    const island = window.UsernodeReact && window.UsernodeReact.firstSession;\n      held ='));
  assert.match(follow, /landed = sessionStorage\.getItem\(App\.INVITE_LANDING_KEY\);\s+sessionStorage\.removeItem\(App\.INVITE_LANDING_KEY\);/);
  assert.match(follow, /const fromLanding = App\._inviteLandingToken === token \|\| landed === token;/);
});

/** A stand-in shell for appDrawn: which screens are up, frame by frame. */
function drawnHarness(screens, opts = {}) {
  const frames = [];
  const savedRaf = global.requestAnimationFrame;
  global.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
  const host = {
    App: { _isScreenVisible: (id) => !!screens[id] },
    UsernameFirstRun: opts.asking ? { _publicAsk: Promise.resolve(true) } : {},
  };
  const step = () => { const fn = frames.shift(); if (fn) fn(); };
  return { host, step, frames, restore: () => { global.requestAnimationFrame = savedRaf; } };
}

test('a private member\'s held frame goes only once the app is the screen, never onto Home', async () => {
  const { appDrawn, APP_DRAWN_MAX_MS } = loadTsx(`${DIR}/index.tsx`);
  const flush = () => new Promise((r) => setImmediate(r));

  // Revealed in the same tick (a phone, a username already chosen): at once.
  let h = drawnHarness({ 'app-view': true });
  try {
    let resolved = false;
    appDrawn(new Promise(() => {}), h.host).then(() => { resolved = true; });
    await flush();
    assert.equal(resolved, true);
  } finally { h.restore(); }

  // A provisional handle's navigation reads the app's audience first: the
  // frame stays over Home through the read, and through the zoom out of
  // Home's tile, and goes when Home does.
  const screens = { 'home-screen': true };
  h = drawnHarness(screens);
  try {
    let settle;
    let resolved = false;
    appDrawn(new Promise((r) => { settle = r; }), h.host).then(() => { resolved = true; });
    h.step(); await flush();
    assert.equal(resolved, false, 'Home only, the audience still being read');
    screens['app-view'] = true;
    h.step(); await flush();
    assert.equal(resolved, false, 'the app growing out of Home\'s tile');
    settle(); await flush();
    h.step(); await flush();
    assert.equal(resolved, false, 'the navigation settled mid-zoom, Home still under it');
    screens['home-screen'] = false;
    h.step(); await flush();
    assert.equal(resolved, true, 'the app alone');
  } finally { h.restore(); }

  // A navigation that ends somewhere else ("Not now" goes Home) lets it go.
  h = drawnHarness({ 'home-screen': true });
  try {
    let resolved = false;
    appDrawn(Promise.resolve(false), h.host).then(() => { resolved = true; });
    await flush();
    h.step(); await flush();
    assert.equal(resolved, true);
  } finally { h.restore(); }

  // Asking for a username: the sheet is not drawn under the frame.
  h = drawnHarness({ 'home-screen': true }, { asking: true });
  try {
    let resolved = false;
    appDrawn(new Promise(() => {}), h.host).then(() => { resolved = true; });
    await flush();
    assert.equal(resolved, true);
  } finally { h.restore(); }

  // Bounded: a navigation that never settles cannot keep the frame up.
  h = drawnHarness({ 'home-screen': true });
  try {
    let clock = 0;
    let resolved = false;
    appDrawn(new Promise(() => {}), h.host, () => clock).then(() => { resolved = true; });
    h.step(); await flush();
    assert.equal(resolved, false);
    clock = APP_DRAWN_MAX_MS + 1;
    h.step(); await flush();
    assert.equal(resolved, true);
  } finally { h.restore(); }
});

test('welcome() hands the held frame to the app, and the follow\'s ending leaves it there', () => {
  const src = read(`${DIR}/index.tsx`);
  const welcome = src.slice(src.indexOf('welcome(info: FirstSessionInfo): boolean {'), src.indexOf('goHome('));
  // Marked as handed on BEFORE the navigation starts, so the endHold that
  // App._followInvite's finally runs right after welcome() returns is a no-op.
  const mark = welcome.indexOf("setMode((prev) => (prev.kind === 'held' ? { kind: 'held', app: slug } : prev));");
  const nav = welcome.indexOf("app?.navigateToApp?.(slug, 'app')");
  assert.ok(mark > -1 && nav > mark, 'marked, then navigated');
  assert.match(welcome, /void appDrawn\(going\)\.then\(\(\) => setMode\(\(prev\) => \(prev\.kind === 'held' && prev\.app === slug \? \{ kind: 'none' \} : prev\)\)\);/);
  // Nothing takes the frame down before the navigation.
  assert.doesNotMatch(welcome.slice(0, nav), /kind: 'none'/);
  // For everybody now, not only a private member.
  assert.doesNotMatch(welcome, /if \(legacy\(\)\.App\?\.user\?\.privateMember\) \{/);
});

test('the tip\'s screenshot states: over the first project on Home, made-up words, nothing written', () => {
  const { tipShot, SHOT_INVITER } = loadTsx(`${DIR}/index.tsx`);
  assert.equal(tipShot('?shot=app-tip'), 'maker');
  assert.equal(tipShot('?shot=app-tip-invited'), 'invited');
  for (const search of ['?shot=youre-in', '?shot=youre-in-many', '?shot=tour-home', '']) assert.equal(tipShot(search), null, search);
  assert.equal(SHOT_INVITER, 'Maya');
  const src = read(`${DIR}/index.tsx`);
  const opener = src.slice(src.indexOf('async function openTipShot'), src.indexOf("// Set by the signed-out story's sheet"));
  assert.match(opener, /await appDrawn\(legacy\(\)\.App\?\.navigateToApp\?\.\(project\.slug, 'app'\)\);/);
  assert.match(opener, /setTip\(\{ \.\.\.project, who, inviter: who === 'invited' \? SHOT_INVITER : null, shot: true \}\);/);
  assert.doesNotMatch(opener, /oweTip|noteTipShown|markSeen|method: 'POST'/);
  assert.doesNotMatch(src, /youreInShot|shotWelcome|'youre-in'/);
});

// ── The three tours (#4044, #4045, #4072) ──────────────────────────────

test('"Look around first" has its own four cards on Home, each pointing at one place, with Next', () => {
  const { lookAroundSteps } = loadTsx(`${DIR}/tour-steps.ts`);
  const steps = lookAroundSteps();
  assert.deepEqual(steps.map((s) => [s.screen, s.target, s.title, s.text]), [
    ['home', '#home-create-tile', 'Make something any time', 'New project starts a community and its app.'],
    ['home', '#home-discover-section', 'Find apps in Discover', 'Open any app, or join its community.'],
    ['home', '#platform-tab-workshop', 'Communities you join show up here', 'Each one has its own hub and discussion.'],
    ['home', '#platform-tab-ai', 'Homeroom bot is in AI', 'It makes apps with you. You can always find it here.'],
  ]);
  // Nobody is taken anywhere: no step is a tap, each rings its place, and
  // the last one ends it.
  assert.deepEqual(steps.map((s) => [!!s.tap, !!s.ringed, !!s.last]), [
    [false, true, false], [false, true, false], [false, true, false], [false, true, true],
  ]);
  // The make screen's "Look around first" answers the question, goes Home and
  // opens it (decision E); it used to leave Home with nothing explained.
  const src = read(`${DIR}/index.tsx`);
  assert.match(src, /if \(mode\.path === 'look'\) return lookAroundSteps\(\);/);
  assert.match(src, /legacy\(\)\.App\?\.navigateHome\?\.\(\);\s+setMode\(\{ kind: 'tour', info: LOOK_AROUND_INFO, path: 'look' \}\);/);
});

test('the look-around tour\'s first card, drawn: Next leads on, never a tap hint', () => {
  const { Tour } = loadTsx(`${DIR}/index.tsx`);
  const { lookAroundSteps } = loadTsx(`${DIR}/tour-steps.ts`);
  // Drawn once the target is measured: Next, never a tap hint, and Back
  // from the second card.
  const had = { window: Object.hasOwn(globalThis, 'window'), document: Object.hasOwn(globalThis, 'document') };
  const before = { window: globalThis.window, document: globalThis.document };
  globalThis.window = { innerWidth: 390, innerHeight: 844 };
  globalThis.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
  let html;
  try {
    html = renderToHtml(createElement(Tour, { info: { slug: '', name: '' }, steps: lookAroundSteps(), onEnd() {} }));
  } finally {
    for (const k of ['window', 'document']) { if (had[k]) globalThis[k] = before[k]; else delete globalThis[k]; }
  }
  assert.match(html, /data-first-session-tour="1"/);
  assert.match(html, />1 of 4</);
  assert.match(html, />Make something any time</);
  assert.match(html, />Next</);
  assert.doesNotMatch(html, /data-first-session-tap/);
});

function withDocBelow(fn, el) {
  const had = Object.hasOwn(globalThis, 'document');
  const before = globalThis.document;
  globalThis.document = { querySelector: () => el, querySelectorAll: () => [el] };
  try { return fn(); } finally { if (had) globalThis.document = before; else delete globalThis.document; }
}

test('every card sits clear of the tab bar: 20px above it near the foot, under what it points at near the top', () => {
  const { cardPlacement, footTop } = loadTsx(`${DIR}/index.tsx`);
  const phone = { width: 390, height: 844 };
  const bar = { left: 0, top: 764, width: 390, height: 80 };
  // The foot is the phone's bar, or the Resume strip on it; never the rail.
  assert.equal(footTop([bar], phone), 764);
  assert.equal(footTop([bar, { left: 8, top: 712, width: 374, height: 52 }], phone), 712);
  assert.equal(footTop([{ left: 0, top: 60, width: 224, height: 740 }], { width: 1280, height: 800 }), 800);
  assert.equal(footTop([], phone), 844);
  const withDoc = (fn) => {
    const had = Object.hasOwn(globalThis, 'document');
    const before = globalThis.document;
    globalThis.document = { querySelector: () => null, querySelectorAll: () => [] };
    try { return fn(); } finally { if (had) globalThis.document = before; else delete globalThis.document; }
  };
  withDoc(() => {
    // A tab on the bar: the card's foot 20px above the bar's top.
    const tab = { left: 160, top: 766, width: 72, height: 56 };
    assert.equal(cardPlacement(tab, { target: '#platform-tab-messages' }, phone, 764).bottom, 100);
    // A whole screen down to the bar (the hub): the same place.
    assert.equal(cardPlacement({ left: 0, top: 0, width: 390, height: 758 }, { target: '#app-content', place: 'bottom' }, phone, 764).bottom, 100);
    // Nothing measured yet: the same, never over the bar.
    assert.equal(cardPlacement(null, { target: '#x' }, phone, 764).bottom, 100);
    // The app, full screen, has no bar: 20px above the screen's edge and its home indicator.
    assert.match(cardPlacement({ left: 0, top: 0, width: 390, height: 844 }, { target: '#app-view', place: 'bottom' }, phone, 844).bottom,
      /^calc\(20px \+ var\(--platform-safe-bottom/);
    // Something near the top (the app on Home, the Discussion tab): under it.
    assert.match(cardPlacement({ left: 16, top: 160, width: 104, height: 124 }, { target: '.app-card' }, phone, 764).top, /^max\(302px, /);
  });
  // The plan in Homeroom bot's chat: the card under the chat's header, so
  // the plan's Build it, at the transcript's foot, stays clear of it.
  const header = { getBoundingClientRect: () => ({ left: 0, top: 99, width: 390, height: 70, right: 390, bottom: 169 }) };
  withDocBelow(() => {
    assert.match(cardPlacement({ left: 0, top: 0, width: 390, height: 681 }, { target: '#x', place: { below: '.messages-thread-header' } }, phone, 764).top, /^max\(181px, /);
  }, header);
});

// The maker's tour ended in Homeroom bot's chat, its card's words changing
// when the plan came in. It ends on the hub now (Evan, 10 Oct 2026), and the
// app it opens offers the plan, so each card says its own words.
test('each card says its own words, and nothing on it waits for a plan', () => {
  const src = read(`${DIR}/index.tsx`);
  assert.match(src, /<p id="first-session-tour-title" className="[^"]+">\{step\.title\}<\/p>/);
  assert.match(src, /\{step\.text\}<\/p>/);
  assert.doesNotMatch(src, /wordsFor|showNewestBelow|step\.instead|newestBelowCard/);
  assert.doesNotMatch(read(`${DIR}/tour-steps.ts`), /PLAN_WAITING|BOT_CHAT_|newestBelowCard|instead\?:/);
});

test('#4391/#4393: the tour says it is running while it is up, so nothing else asks for the plan', () => {
  const src = read(`${DIR}/index.tsx`);
  assert.match(src, /useEffect\(\(\) => \{\s*setTourRunning\(true\);\s*return \(\) => setTourRunning\(false\);\s*\}, \[\]\);/);
  const store = loadTsx(`${DIR}/tour-running.ts`);
  assert.equal(store.tourRunning(), false);
  let calls = 0;
  const off = store.subscribeTourRunning(() => { calls += 1; });
  store.setTourRunning(true);
  store.setTourRunning(true);
  assert.equal(store.tourRunning(), true);
  store.setTourRunning(false);
  off();
  store.setTourRunning(true);
  store.setTourRunning(false);
  assert.equal(calls, 2, 'told once per change, and not after unsubscribing');
  // One flag for every copy of the module (a lazy chunk bundles its own).
  assert.equal(globalThis[store.TOUR_RUNNING_KEY].running, false);
});

// Only a brand-new account's first session reaches a tour, so each has a
// screenshot state the before/after shots can open, part-way with &step=N
// (the owner's ruling for first-run screens, 6 October 2026).
test('each tour has a screenshot state, opened at any card, over a real project, writing nothing', () => {
  const { tourShot } = loadTsx(`${DIR}/index.tsx`);
  assert.deepEqual(tourShot('?shot=tour-home'), { path: 'walk', start: 0 });
  assert.deepEqual(tourShot('?shot=tour-home&step=3'), { path: 'walk', start: 2 });
  assert.deepEqual(tourShot('?shot=tour-look&step=3'), { path: 'look', start: 2 });
  assert.deepEqual(tourShot('?shot=tour-look&step=x'), { path: 'look', start: 0 });
  // The old tours' states are gone with them.
  for (const old of ['tour-make', 'tour-join', 'tour-private', 'tour-home-private', 'first-version', 'toString', '']) assert.equal(tourShot(`?shot=${old}`), null, old);
  const src = read(`${DIR}/index.tsx`);
  // Over the first project on the viewer's Home.
  assert.match(src, /document\.querySelector\('#app-list \.app-card\[data-slug\]'\)/);
  // Once the shell is signed in; it opens over nothing else.
  assert.match(src, /const shot = tourShot\(window\.location\.search\);/);
  assert.match(src, /prev\.kind === 'none' \? \{ kind: 'tour', info, path: shot\.path, start: shot\.start \} : prev/);
  // With that project's name and, if its starter has one, its example
  // change, asked before it opens (a read: nothing is written).
  assert.match(src, /const example = await walkExample\(project\.slug\);\s+open\(\{ \.\.\.project, example \}\);/);
  // Opened part-way, the tour opens that card's own screen; the count is
  // clamped to the tour.
  assert.match(src, /useState\(\(\) => Math\.max\(0, Math\.min\(start, steps\.length - 1\)\)\)/);
  assert.match(src, /if \(index > 0\) enterScreen\(steps\[index\]\.screen, info\.slug, info\.conversationId\);/);
  // No answer, no seen mark, no walk owed or run: the shot path never records.
  const opener = src.slice(src.indexOf('async function firstHomeProject'), src.indexOf('async function openTipShot'));
  assert.doesNotMatch(opener, /recordLookAround|markSeen|noteAnswered|noteWalkRun|oweWalk|rememberCommunity|method: 'POST'/);
});

// The owner, 6 October 2026: each step scrolls its target into view before
// ringing it. On a Home whose collapsed grid is full, the New project tile
// used to be held back behind "Show all N apps" (home.js createHidden) and
// the step pressed the expander first, as a finger would; since #4757 the
// Show-all line carries a compact New project entry, so the step finds its
// target directly. revealWith stays for a target the screen truly lacks.
test('each step brings its target into view before ringing it, finding a held-back tile on the Show-all line', () => {
  const { outOfBand, bringIntoView } = loadTsx(`${DIR}/index.tsx`);
  const { lookAroundSteps } = loadTsx(`${DIR}/tour-steps.ts`);
  const band = { top: 99, bottom: 754 };
  assert.equal(outOfBand({ left: 16, top: 300, width: 80, height: 100 }, band), false, 'in the band: left where it is');
  assert.equal(outOfBand({ left: 16, top: 900, width: 80, height: 100 }, band), true, 'below the tab bar');
  assert.equal(outOfBand({ left: 16, top: 40, width: 80, height: 100 }, band), true, 'under the top bar');
  assert.equal(outOfBand({ left: 0, top: 0, width: 390, height: 800 }, band), false, 'a whole screen is not scrolled to');

  const first = lookAroundSteps()[0];
  // Kept as the fallback for a target the screen truly lacks; with the
  // compact entry (#4757) a held-back tile is found directly, pressing
  // nothing, so a folded grid no longer has to be unfolded first.
  assert.equal(first.revealWith, '#home-apps-more-btn');
  assert.match(read('frontend/src/features/home/apps-more.tsx'), /id="home-apps-more-btn"[\s\S]*home\._appsExpanded = true;\s+home\.render\(\);/);
  assert.match(read('frontend/src/features/home/home.js'), /heldBack: createHidden,/);
  assert.match(read('frontend/src/features/home/create-tile.tsx'), /id="home-create-tile"/);

  const withDoc = (doc, fn) => {
    const had = Object.hasOwn(globalThis, 'document');
    const before = globalThis.document;
    globalThis.document = doc;
    try { return fn(); } finally { if (had) globalThis.document = before; else delete globalThis.document; }
  };
  const phone = { width: 390, height: 844 };
  // Held back (#4757): the compact New project entry sits on the Show-all
  // line, so the step finds its target directly and presses nothing.
  let pressed = 0;
  const expander = { getBoundingClientRect: () => ({ width: 300, height: 30 }), click() { pressed += 1; } };
  const compact = {
    getBoundingClientRect: () => ({ left: 16, top: 700, width: 120, height: 30 }),
    closest: () => null,
  };
  const found = withDoc({
    querySelectorAll: (sel) => (sel === '#home-create-tile' ? [compact]
      : sel === '#home-apps-more-btn' ? [expander] : []),
    getElementById: () => ({ getBoundingClientRect: () => ({ height: 99, bottom: 99 }) }),
  }, () => bringIntoView(first, phone));
  assert.deepEqual([found, pressed], [true, 0], 'on the Show-all line already: no unfolding');
  // A target the screen truly lacks: the expander is pressed, and nothing is
  // done yet.
  const held = withDoc({
    querySelectorAll: (sel) => (sel === '#home-apps-more-btn' ? [expander] : []),
    getElementById: () => null,
  }, () => bringIntoView(first, phone));
  assert.deepEqual([held, pressed], [false, 1]);
  // Drawn below the fold: scrolled into the middle, at once.
  const scrolled = [];
  const tile = {
    getBoundingClientRect: () => ({ left: 16, top: 1200, width: 104, height: 124, bottom: 1324 }),
    closest: () => null,
    scrollIntoView: (opts) => scrolled.push(opts),
  };
  const done = withDoc({
    querySelectorAll: (sel) => (sel === '#home-create-tile' ? [tile] : []),
    getElementById: () => ({ getBoundingClientRect: () => ({ height: 99, bottom: 99 }) }),
  }, () => bringIntoView(first, phone));
  assert.equal(done, true);
  assert.deepEqual(scrolled, [{ block: 'center', behavior: 'auto' }]);
  // A tab on the bar is always in view: never scrolled.
  const tab = { ...tile, closest: () => ({}), scrollIntoView: () => scrolled.push('tab') };
  withDoc({ querySelectorAll: () => [tab], getElementById: () => null }, () => bringIntoView(lookAroundSteps()[1], phone));
  assert.equal(scrolled.length, 1);

  // Once per step, from the per-frame follow, before the cut-out is measured;
  // the reveal press is tried once, half a second in.
  const src = read(`${DIR}/index.tsx`);
  assert.match(src, /if \(shown !== at && tries < 240\) \{[\s\S]*?const asked = tries === 30 \? step : \{ target: step\.target \};\s+if \(bringIntoView\(asked, \{ width: window\.innerWidth, height: window\.innerHeight \}\)\) shown = at;/);
  assert.ok(src.indexOf('bringIntoView(asked') < src.indexOf('const m = measure(at, stepRef.current);'));
});

// PR 1's App tab line "It opens here when it's ready." hides while a tour card
// that says where the app opens is up: one carrying
// `data-tour-says-where-it-opens` (features/app-frame/app-status.tsx). The
// card on the App tab, "<project> opens here", is the only one that says it.
test('no tour card says where the app opens now; the engine still carries the attribute for one that would', () => {
  const { homeWalkSteps, lookAroundSteps } = loadTsx(`${DIR}/tour-steps.ts`);
  for (const steps of [homeWalkSteps({ slug: 'film' }), lookAroundSteps()]) {
    assert.ok(steps.every((s) => !s.saysWhereItOpens));
  }
  const src = read(`${DIR}/index.tsx`);
  assert.match(src, /role="dialog"\s+aria-labelledby="first-session-tour-title"\s+data-tour-says-where-it-opens=\{step\.saysWhereItOpens \? '' : undefined\}/);
});

// #4900, onboarding run, 12 Oct 2026 (iPhone 17): the tour's first card asked
// a newcomer to tap a tile still "Spinning up…", which a tap does nothing on,
// and its second, "Restaurant Tier List opens here", stood over the app's
// "Opening…" cover. The two steps that point at the app wait for it.
test('#4900: no card of the walk waits for the app: it points at the tile and opens nothing', () => {
  const { homeWalkSteps, lookAroundSteps } = loadTsx(`${DIR}/tour-steps.ts`);
  for (const steps of [homeWalkSteps({ slug: 'film' }), lookAroundSteps()]) {
    assert.ok(steps.every((s) => !s.waitsFor));
  }
  // The engine's waiting card keeps its words, for a step that waits.
  assert.equal(message('onboarding:firstSession.tour.wait.title', { app: 'Restaurant Tier List' }), 'Getting Restaurant Tier List ready…');
  assert.equal(message('onboarding:firstSession.tour.wait.text'), 'The tour goes on as soon as it’s ready.');
});

test('onboarding run two: the tour dims as one rounded shape, waits for the hub drawn whole, and leaves the menu once it has closed', () => {
  const src = read(`${DIR}/index.tsx`);
  const { dimStyle, HOLE_RADIUS } = loadTsx(`${DIR}/index.tsx`);
  // One box the size of the cut-out whose shadow is the dim, rounded as the
  // ring is round a control, square round a screen; the strips that take
  // the presses outside it are clear.
  const hole = { left: 10, top: 20, width: 100, height: 50 };
  assert.deepEqual(dimStyle(hole, true), { left: 10, top: 20, width: 100, height: 50, borderRadius: 16, boxShadow: '0 0 0 200vmax rgba(9,9,12,0.6)' });
  assert.equal(dimStyle(hole, false).borderRadius, 0);
  assert.equal(HOLE_RADIUS, 16);
  assert.match(src, /const SHADE = 'pointer-events-auto fixed';\n/);
  assert.match(src, /<div aria-hidden="true" data-first-session-dim="" className=\{gliding \|\| moving \? DIM_GLIDE : DIM\} style=\{dimStyle\(hole, pointed\)\} \/>/);
  assert.match(src, /const DIM_GLIDE = 'pointer-events-none fixed motion-safe:transition-\[left,top,width,height\] motion-safe:duration-200 motion-safe:ease-out';/);
  // It eases only for a step's own move (onboarding run three): within a
  // step it follows its target at once, so it never chases one.
  assert.match(src, /const DIM = 'pointer-events-none fixed';/);
  assert.match(src, /setGliding\(true\);\s+const t = window\.setTimeout\(\(\) => setGliding\(false\), GLIDE_MS\);[\s\S]*?\}, \[index\]\);/);
  // The hub's card waits for the hub drawn whole, with all of the page dimmed meanwhile.
  // Leaving the menu the page is dimmed whole: its target slides away with the sheet.
  assert.match(src, /const dimAll = \(waiting && step\.waitsFor === 'hub'\) \|\| leavingMenu;/);
  const { appReady } = loadTsx(`${DIR}/tour-wait.ts`);
  const page = (found) => ({ querySelectorAll: (sel) => {
    assert.equal(sel, '#app-content [data-ws-community], #app-content [data-ws-community-pending]');
    return found ? [{}] : [];
  } });
  assert.equal(appReady('hub', 'film', page(false)), false, 'a blank page, or the skeleton');
  assert.equal(appReady('hub', 'film', page(true)), true, 'the hero, with its community read or refused');
  // Out of a step in the menu, the menu closes first, the card hidden and the layer over it.
  assert.match(src, /if \(steps\[index\]\.inMenu && !steps\[to\]\.inMenu && AppContext\.isOpen\(\)\) \{\s+setLeavingMenu\(true\);\s+void Promise\.resolve\(AppContext\.close\(\)\)\.catch\(\(\) => \{\}\)\.then\(\(\) => \{\s+setLeavingMenu\(false\);\s+move\(\);/);
  // A first visit is noted for the home-screen strip, never from Create:
  // the tip in the app counts as one of its screens.
  assert.match(src, /if \(mode\.kind === 'none' && !tip\) return;[\s\S]{0,160}noteFirstSessionVisit\(\);\n  \}, \[mode, tip\]\);/);
});

test('onboarding runs two and three: under the tour a page swaps in place, so nothing draws over its card', () => {
  const ui = read('public/js/platform-ui.js');
  // The tour has the last word on the motion: underTour wraps everything
  // else, markZoom (the zooming screen's flag) included.
  assert.match(ui, /un\.transition\(fn, PlatformUI\.underTour\(PlatformUI\.phoneMotion\(PlatformUI\.markZoom\(opts \|\| \{ type: 'none' \}\)\)\)\);/);
  const body = ui.slice(ui.indexOf('    underTour(opts) {'));
  const underTour = new Function(`const globalThis = this; return function ${body.slice(4, body.indexOf('\n    },') + 6)}`);
  const run = (running, type) => underTour.call({ __usernodeFirstSessionTourRunning: running == null ? undefined : { running } })({ type });
  assert.equal(run(true, 'fade').type, 'none');
  assert.equal(run(true, 'push').type, 'none');
  assert.equal(run(true, 'zoom-in').type, 'zoom-in', 'the tile the tour asks for, opening, keeps its motion');
  assert.equal(run(true, 'zoom-out').type, 'none', 'closing pins the app over the tour: it cuts to Home instead (onboarding run three)');
  assert.equal(run(false, 'zoom-out').type, 'zoom-out', 'with no tour up, closing zooms as it always did');
  assert.equal(run(false, 'fade').type, 'fade');
  assert.equal(run(null, 'pop').type, 'pop');
  const { TOUR_RUNNING_KEY } = loadTsx(`${DIR}/tour-running.ts`);
  assert.equal(TOUR_RUNNING_KEY, '__usernodeFirstSessionTourRunning');
});

test('onboarding run two: the hub draws once, holding its skeleton while its community record is on its way', () => {
  const card = read('frontend/src/features/dev-board/workshop/community-card.tsx');
  assert.match(card, /export function communityPending\(slug: string\): boolean \{\s+return !!slug && !communities\.has\(slug\) && inflight\.has\(slug\);\s+\}/);
  // Asked for before the first paint, so the draft never paints.
  assert.match(card, /useLayoutEffect\(\(\) => \{\s+if \(!slug \|\| inflight\.has\(slug\)\) return;\s+void reloadCommunity\(slug\);\s+if \(!communities\.has\(slug\)\) bump\(\);\s+\}, \[slug\]\);/);
  // A refused read lets the skeleton go too.
  assert.match(card, /\} else if \(!communities\.has\(slug\)\) \{\s+\/\/ [^\n]*\n\s+for \(const listener of \[\.\.\.listeners\]\) listener\(\);/);
  const workshop = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  assert.match(workshop, /const pending = v\.loading \|\| communityPending\(v\.slug \|\| ''\);/);
  assert.match(workshop, /return <div ref=\{hostRef\}><CardSkeleton n=\{4\} label=\{t\('project:page\.loading'\)\} \/><\/div>;/);
  // Polish board #3: the hub holds its OWN shape, under the page's bar, and
  // draws its cards only once the record and the board are in.
  assert.match(workshop, /\{tab === 'status' && pending \? <HubSkeleton others=\{hubSkeletonOthers\(slug\)\} \/> : null\}/);
  assert.match(workshop, /\{tab === 'status' \? \(pending \? null : \(/);
});

test('#4900: what a waiting step waits for: a tile a tap opens, and an app past its loading screens', () => {
  const wait = loadTsx(`${DIR}/tour-wait.ts`);
  const { tileSettled, viewLoading, appOpened, appReady, WAIT_GRACE_MS, TOUR_WAIT_MAX_MS, WAIT_CHECK_MS, WAIT_POLL_MS } = wait;
  // A tile opens once its app runs (home.js appView `clickable`); a setup
  // that stopped is not loading either.
  assert.deepEqual(['creating', 'running', 'error', 'awaiting_secrets', '', null, undefined].map(tileSettled),
    [false, true, true, true, false, false, false]);
  const tiles = (...statuses) => ({
    querySelectorAll: (sel) => {
      assert.equal(sel, '#app-list .app-card[data-slug="film"]', 'the step\'s own tile');
      return statuses.map((status) => ({ getAttribute: (name) => (name === 'data-status' ? status : null) }));
    },
  });
  assert.equal(appReady('running', 'film', tiles('creating')), false, '"Spinning up…"');
  assert.equal(appReady('running', 'film', tiles('running')), true);
  assert.equal(appReady('running', 'film', tiles()), false, 'not on Home yet');
  const index = read('frontend/src/features/home/home.js');
  assert.match(index, /clickable: isRunning \|\| isAwaiting,/, 'a tile opens only once its app runs');
  assert.match(read('frontend/src/features/home/app-grid.tsx'), /data-status=\{app\.status\}/);

  // The app on its screen: its frame, until its launch cover goes ("Opening…").
  const checking = message('changes:appStatus.checking');
  assert.equal(checking, 'Opening…');
  const frame = (over) => ({ slug: 'film', active: true, cover: null, ...over });
  assert.equal(appOpened('film', frame({ cover: { out: false } }), null, checking), false, 'its launch cover is up');
  assert.equal(appOpened('film', frame({ cover: { out: true } }), null, checking), true, 'fading out');
  assert.equal(appOpened('film', frame(), null, checking), true, 'the app itself');
  // Without its frame, the App tab's own screens: loading ones wait, the rest do not.
  const parked = frame({ active: false });
  assert.equal(appOpened('film', parked, null, checking), false, 'nothing drawn yet');
  assert.equal(appOpened('film', frame({ slug: 'other' }), null, checking), false, 'another app\'s frame');
  const views = {
    spinningUp: { dot: 'creating', message: 'App is spinning up...', detail: null, action: null },
    checking: { dot: null, message: checking, detail: null, action: null },
    firstVersion: { dot: null, message: 'Friday Film Crew', detail: null, tourSays: true, action: null },
    secrets: { dot: 'creating', message: 'Awaiting required secrets.', detail: 'KEY', action: { key: 'secrets' } },
    failed: { dot: 'error', message: 'App failed to start', detail: null, action: null },
    sample: { dot: null, message: 'Preview sample app.', detail: null, action: null },
  };
  assert.deepEqual(Object.fromEntries(Object.entries(views).map(([k, v]) => [k, viewLoading(v, checking)])), {
    spinningUp: true, checking: true, firstVersion: false, secrets: false, failed: false, sample: false,
  });
  assert.equal(appOpened('film', parked, views.firstVersion, checking), true, 'the first version being built is the screen the card is for');
  assert.equal(appOpened('film', parked, views.checking, checking), false);
  // Those are the App tab's own words and fields (public/js/app-view.js).
  const appView = read('public/js/app-view.js');
  assert.match(appView, /_firstVersionCheckingView\(\) \{\s+return \{ dot: null, message: PlatformI18n\.t\('changes:appStatus\.checking'\), detail: null, action: null \};/);
  assert.match(appView, /return \{ dot: 'creating', message: PlatformI18n\.t\('changes:appStatus\.spinningUp'\), detail: null, action: null \};/);
  assert.match(appView, /tourSays: true,/);
  const src = read(`${DIR}/tour-wait.ts`);
  assert.match(src, /return appOpened\(slug, appFrameStore\.get\(\), view, translate\('changes:appStatus\.checking'\)\);/);

  // Never a dead end: a moment with no card, then the card that says so, and
  // at most a minute before the step shows anyway.
  assert.equal(WAIT_CHECK_MS, 150);
  assert.equal(WAIT_GRACE_MS, 2500);
  assert.ok(WAIT_GRACE_MS > 2000, 'longer than the app\'s own reveal cap (AppView.LAUNCH_REVEAL_CAP_MS)');
  assert.match(appView, /LAUNCH_REVEAL_CAP_MS: 2000,/);
  assert.equal(TOUR_WAIT_MAX_MS, 60000);
  assert.equal(WAIT_POLL_MS, 2000);
});

test('#4900: the tour waits for the app before the step is painted, with Skip and Back, and never moves on from a press meanwhile', () => {
  const src = read(`${DIR}/index.tsx`);
  // Decided before paint, from what the step waits for.
  assert.match(src, /useLayoutEffect\(\(\) => \{\s+setWait\(step\.waitsFor && !appReady\(step\.waitsFor, info\.slug\) \? 'held' : null\);\s+\}, \[index, step, info\.slug\]\);/);
  // Looked at again, said after a moment, and given up on after the cap.
  assert.match(src, /if \(appReady\(kind, slug\)\) setWait\(null\);/);
  assert.match(src, /const say = window\.setTimeout\(\(\) => setWait\(\(w\) => \(w === 'held' \? 'shown' : w\)\), WAIT_GRACE_MS\);/);
  assert.match(src, /const cap = window\.setTimeout\(\(\) => setWait\(null\), TOUR_WAIT_MAX_MS\);/);
  // A tile Home has not caught up on: the server is asked, and Home read again.
  assert.match(src, /if \(live && tileSettled\(madeAppOf\(body\)\?\.status\) && !appReady\('running', slug\)\) legacy\(\)\.Home\?\.load\?\.\(\);/);
  // Nothing ringed, the whole cut-out covered, and no tap moves it on.
  assert.match(src, /if \(!step\.tap \|\| waiting\) return undefined;/);
  assert.match(src, /const covers = hole \? \(ring && step\.tap \? aroundBox\(hole, ring\) : \[hole\]\) : \[\];/);
  // Hidden for the moment, then the card: getting ready, Skip, and Back.
  assert.match(src, /data-first-session-tour-wait=\{wait \|\| undefined\}\s+className=\{settling \|\| wait === 'held' \|\| leavingMenu\s+\? 'pointer-events-none [^']*opacity-0/);
  const body = src.slice(src.indexOf('{waiting ? ('), src.indexOf('<p id="first-session-tour-title" className="mt-0.5 text-[17px] font-semibold leading-snug">{step.title}</p>'));
  assert.ok(body.length > 200, 'the waiting card is findable');
  assert.match(body, /t\('onboarding:firstSession\.tour\.wait\.title', \{ app: info\.name \}\)/);
  assert.match(body, /t\('onboarding:firstSession\.tour\.wait\.text'\)/);
  assert.match(body, /onClick=\{skip\}/);
  assert.match(body, /onClick=\{\(\) => go\(index - 1\)\}/);
  assert.doesNotMatch(body, /pressTarget|go\(index \+ 1\)|data-first-session-tap/, 'nothing that leads on while it waits');
  // At the foot, not beside a tile that cannot be opened yet.
  assert.match(src, /const card = cardPlacement\(waiting \? null : box, step, viewport\);/);
  // Drawn before any effect runs (the server render, a test), the step is as it was.
  const html = drawTour({ steps: [{ screen: 'home', target: '#app-list .app-card[data-slug="film"]', waitsFor: 'running', title: 'Friday Film Crew is on your Home', text: 'Open it from here.', tap: 'Tap it' }] });
  assert.doesNotMatch(html, /data-first-session-tour-wait/);
  assert.match(html, />Tap it<\/button>/);
});

// #5528 for the maker's walk (newcomer run, 20 Oct 2026): the Home tour ended
// on Communities, and the walk ended where it started, on Home. Done on its
// last card, the Communities tab's, opens that tab on the project's hub; an
// invited private member's walk as well (Evan, 20 Oct 2026).
test('the walk, done, opens the Communities tab on its project\'s hub; skipped, it stays on Home', () => {
  const src = read(`${DIR}/index.tsx`);
  // The tour says how it ended; the walk's end reads it.
  assert.match(src, /noteMoment\(info\.slug, 'tour_ended', \{ step: indexRef\.current \+ 1, steps: steps\.length, how \}\);\s+\}\s+endTour\(how\);/);
  assert.match(src, /const hub = how === 'done' && mode\.kind === 'tour' && mode\.path === 'walk' \? mode\.info\.slug : null;\s+setMode\(\{ kind: 'none' \}\);\s+if \(hub\) walkDoneLanding\(hub\);/);

  const { walkDoneLanding } = loadTsx(`${DIR}/index.tsx`);
  const before = { window: globalThis.window, localStorage: globalThis.localStorage };
  const calls = [];
  const stored = new Map();
  globalThis.localStorage = { setItem: (k, v) => stored.set(k, v), getItem: (k) => stored.get(k) ?? null, removeItem: (k) => stored.delete(k) };
  const harness = (resumes) => {
    calls.length = 0;
    stored.clear();
    globalThis.window = {
      App: {
        _WORKSHOP_VIEW_KEY: 'usernode:workshop-view',
        _workshopViewPath: (url) => url,
        _publishCommunityScope: (slug) => calls.push(['scope', slug]),
        resumeWorkshopView: () => { calls.push(['resume', stored.get('usernode:workshop-view')]); return resumes; },
        navigateToApp: (slug, tab) => calls.push(['navigate', slug, tab]),
      },
      AppView: { _landOnHub: (slug) => calls.push(['hub', slug]) },
    };
  };
  try {
    // As a press on the tab would, once the tab remembers the project.
    harness(true);
    walkDoneLanding('city-tier-list');
    assert.deepEqual(calls, [
      ['scope', 'city-tier-list'],
      ['hub', 'city-tier-list'],
      ['resume', JSON.stringify({ slug: 'city-tier-list', path: '/app/city-tier-list/workshop' })],
    ]);
    // A tab that cannot resume it: straight to the hub.
    harness(false);
    walkDoneLanding('city-tier-list');
    assert.deepEqual(calls.slice(-2), [['hub', 'city-tier-list'], ['navigate', 'city-tier-list', 'dev']]);
  } finally {
    globalThis.window = before.window;
    globalThis.localStorage = before.localStorage;
  }
});
