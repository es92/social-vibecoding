'use strict';

// "You're in" and the first-session tour after an invite
// (frontend/src/features/first-session). The tour walks real screens, so
// what is pinned here is that every step names a control or region the
// shell really has, that the island adds nothing to the prerendered
// document, and the seams that open it: App._followInvite asks it, and the
// invite's standing says when the viewer joined.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadTsx, renderComponent, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const DIR = 'frontend/src/features/first-session';
const GC_FORM_SRC = 'frontend/src/features/group-chat/composer.tsx';

test('the invited tour: nine steps, each screen whole or the tap that leads on, ending in Discussion', () => {
  const { invitedSteps, MENU_TEXT, SUGGEST_TEXT } = loadTsx(`${DIR}/tour-steps.ts`);
  const steps = invitedSteps({ slug: 'sunday-run-club', name: 'Sunday Run Club' });
  assert.deepEqual(steps.map((s) => s.screen), ['home', 'app', 'app', 'app', 'app', 'home', 'hub', 'hub', 'discussion']);
  assert.deepEqual(steps.map((s) => (s.tap ? 'tap' : 'look')), ['tap', 'look', 'tap', 'look', 'tap', 'tap', 'look', 'tap', 'look']);
  assert.equal(steps[0].target, '.app-card[data-slug="sunday-run-club"]');
  assert.equal(steps.filter((s) => s.last).length, 1);
  assert.equal(steps[steps.length - 1].last, true);
  assert.deepEqual(steps[steps.length - 1].place, { above: '#gc-form' });
  // One short title and one short sentence per card (#4044, the tour script
  // on the onboarding canvas): the card names the place, the screen behind
  // it says the rest. The people using the app decide, not "the group".
  assert.deepEqual(steps.map((s) => [s.title, s.text, s.tap || null]), [
    ['Sunday Run Club is on your Home', 'Open it any time from here.', 'Tap it'],
    ['Sunday Run Club opens here', 'This is the app your community makes together.', null],
    ['Suggest an improvement', MENU_TEXT, 'Tap the menu'],
    ['Suggest an improvement', SUGGEST_TEXT, null],
    ['✕ takes you back to Home', 'Open Sunday Run Club again from Home any time.', 'Tap ✕'],
    ['You can find Sunday Run Club here', 'Communities lists every community you\'re in.', 'Tap Communities'],
    ['The Sunday Run Club hub', 'The discussion and the app\'s changes are here.', null],
    ['Talk in Discussion', 'Everyone in Sunday Run Club reads it.', 'Tap Discussion'],
    ['Say hi, or share an idea', 'The people using the app decide what goes in.', null],
  ]);
  assert.doesNotMatch(JSON.stringify(steps), /Homeroom bot (builds|turns)/);
});

test('starting a community and joining one share their first seven cards, word for word', () => {
  const { invitedSteps, makerSteps, SUGGEST_TEXT } = loadTsx(`${DIR}/tour-steps.ts`);
  const project = { slug: 'sunday-run-club', name: 'Sunday Run Club', conversationId: 4 };
  assert.deepEqual(makerSteps(project).slice(0, 7), invitedSteps(project).slice(0, 7));
  // Never "group" for the people of a community, on any card of any tour.
  // Suggest an improvement's card (#4225, merged on main) still says "brings
  // it to the group": its words are not part of this check until they change.
  const { lookAroundSteps } = loadTsx(`${DIR}/tour-steps.ts`);
  const all = JSON.stringify([...invitedSteps(project), ...makerSteps(project), ...makerSteps({ ...project, conversationId: null }), ...lookAroundSteps()]).replaceAll(JSON.stringify(SUGGEST_TEXT).slice(1, -1), '');
  assert.doesNotMatch(all, /\bgroup\b/i);
  assert.doesNotMatch(all, /!|\u2014/, 'no exclamation marks, no em dashes');
});

// #4225: both paths show where Suggest an improvement lives, inside the app,
// and say honestly what happens to one: not a feedback box, the bot starts on
// it or brings it to the group. #4390: the app is shown first, then the
// reader taps the Homeroom mark and the real menu opens, its Suggest button
// pointed at but not pressed (Next, so no suggestion starts), and ✕ last.
test('the invited and maker tours open the Homeroom menu for Suggest an improvement, after the app and before ✕', () => {
  const { invitedSteps, makerSteps, MENU_TEXT, SUGGEST_TEXT, APP_MENU } = loadTsx(`${DIR}/tour-steps.ts`);
  assert.equal(APP_MENU, '#apps-switcher-sheet');
  for (const steps of [
    invitedSteps({ slug: 'x', name: 'X' }),
    makerSteps({ slug: 'x', name: 'X', conversationId: 5 }),
    makerSteps({ slug: 'x', name: 'X', conversationId: null }),
  ]) {
    const at = steps.findIndex((s) => s.target === '#platform-mark-btn');
    assert.equal(at, 2, 'on the app screen, after the card that shows it');
    assert.equal(steps[at - 1].target, '#app-view');
    assert.deepEqual(steps[at], { screen: 'app', target: '#platform-mark-btn', title: 'Suggest an improvement', text: MENU_TEXT, tap: 'Tap the menu' });
    assert.deepEqual(steps[at + 1], { screen: 'app', target: '#improve-row-feedback', inMenu: true, ringed: true, title: 'Suggest an improvement', text: SUGGEST_TEXT });
    assert.deepEqual(steps[at + 2], { screen: 'app', target: '#back-btn', title: '✕ takes you back to Home', text: 'Open X again from Home any time.', tap: 'Tap ✕' });
    assert.equal(steps.filter((s) => s.inMenu).length, 1, 'only the Suggest button\'s step is in the menu');
  }
  // The button the step points at is the menu's own, always drawn in it.
  assert.match(read('frontend/src/features/improve/actions.tsx'), /id="improve-row-feedback"/);
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
  assert.match(SUGGEST_TEXT, /doesn't vanish into a feedback box/);
  assert.match(SUGGEST_TEXT, /Homeroom bot starts building it for you, or brings it to the group, and you can follow along\./);
  assert.doesNotMatch(SUGGEST_TEXT, /—/);
});

// Every selector a step names: what it cuts out, what it draws alongside,
// the bars it stops above and the control it presses.
const SELECTOR_FIELDS = ['target', 'alongside', 'endsAbove', 'press'];
const idsNamed = (steps) => [...new Set(steps
  .flatMap((s) => SELECTOR_FIELDS.flatMap((f) => (s[f] ? s[f].split(',') : [])))
  .map((t) => t.trim())
  .filter((t) => t.startsWith('#'))
  .map((t) => t.slice(1)))].sort();

test('every id the tour points at is one the shell ships', () => {
  const { invitedSteps, makerSteps, lookAroundSteps } = loadTsx(`${DIR}/tour-steps.ts`);
  const baseline = JSON.parse(read('tests/baselines/shell-markup.json'));
  const ids = new Set(baseline.ids || []);
  assert.deepEqual(idsNamed(invitedSteps({ slug: 'x', name: 'X' })), [
    'app-content', 'app-view', 'back-btn', 'gc-form', 'gc-messages', 'improve-row-feedback', 'platform-header', 'platform-mark-btn', 'platform-parked', 'platform-tab-workshop', 'platform-tabs',
  ]);
  assert.deepEqual(idsNamed(makerSteps({ slug: 'x', name: 'X', conversationId: 5 })), [
    'app-content', 'app-view', 'back-btn', 'improve-row-feedback', 'platform-header', 'platform-mark-btn', 'platform-parked', 'platform-tab-messages', 'platform-tab-workshop', 'platform-tabs',
  ]);
  assert.deepEqual(idsNamed(lookAroundSteps()), ['home-create-tile', 'platform-tab-discover', 'platform-tab-messages', 'platform-tab-workshop']);
  // Home's New project tile is React's, one element, and dapp.json's checks
  // select it by this id.
  assert.match(read('frontend/src/features/home/create-tile.tsx'), /id="home-create-tile"/);
  assert.ok(read('dapp.json').includes('#home-create-tile'));
  // The shell's own ids, from its pinned inventory.
  for (const id of ['app-content', 'app-view', 'back-btn', 'platform-header']) assert.ok(ids.has(id), `#${id} is in the shell's id inventory`);
  // The Homeroom mark, the header's menu button, is React's (#4225's step).
  assert.equal((read('frontend/src/features/header/platform-mark.tsx').match(/id="platform-mark-btn"/g) || []).length, 1);
  // The tab bar and the Resume strip on it are React's, each one element.
  assert.equal((read('frontend/src/features/nav/tab-bar.tsx').match(/id="platform-tabs"/g) || []).length, 1);
  assert.equal((read('frontend/src/features/nav/parked-strip.tsx').match(/id="platform-parked"/g) || []).length, 1);
  // The tab bar draws its tabs' ids from their keys, and dapp.json's checks
  // select the Communities tab by this one.
  assert.ok(read('dapp.json').includes('#platform-tab-workshop'));
  // The rest are drawn by the screens the tour opens.
  assert.match(read('frontend/src/features/dev-board/workshop/project-band.tsx'), /data-ws-tab-btn/);
  assert.match(read('frontend/src/features/group-chat/general-chat.tsx'), /id="gc-messages"/);
  assert.match(read(GC_FORM_SRC), /form: 'gc-form',/);
});

test('the Communities, Messages and Discover steps point at the bar\'s own tabs, the same elements on a phone and the rail', () => {
  const { invitedSteps, makerSteps, lookAroundSteps } = loadTsx(`${DIR}/tour-steps.ts`);
  assert.equal(invitedSteps({ slug: 'x', name: 'X' })[5].target, '#platform-tab-workshop');
  const maker = makerSteps({ slug: 'x', name: 'X', conversationId: 5 });
  assert.equal(maker[5].target, '#platform-tab-workshop');
  assert.equal(maker[7].target, '#platform-tab-messages');
  assert.deepEqual(lookAroundSteps().slice(1).map((s) => s.target), ['#platform-tab-discover', '#platform-tab-workshop', '#platform-tab-messages']);
  // One <a> per tab, its id drawn from its key, inside the one #platform-tabs
  // that app.css lays out as the phone's bottom bar or, from 768px, the rail.
  const bar = read('frontend/src/features/nav/tab-bar.tsx');
  assert.match(bar, /\{ key: 'workshop' as const, label: 'Communities', href: '#communities', Icon: UserGroupIcon \}/);
  assert.match(bar, /\{ key: 'messages' as const, label: 'Messages', href: '#messages', Icon: ChatIcon \}/);
  assert.match(bar, /\{ key: 'discover' as const, label: 'Discover', href: '#apps', Icon: SearchIcon \}/);
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
  assert.match(src, /useLayoutEffect\(\(\) => \{\s+setMeasured\(measure\(index, step\)\);\s+\}, \[index, step\]\);/);
  // The per-frame follow tags what it measures with the step, and survives a
  // frame that throws rather than leaving the ring where it was.
  assert.match(src, /const m = measure\(at, stepRef\.current\);\s+(?:\/\/[^\n]*\n\s*)*const key = `\$\{at\}:\$\{boxKey\(m\.box\)\}:\$\{boxKey\(m\.press\)\}:\$\{m\.instead \? 1 : 0\}`;\s+if \(key !== last\) \{ last = key; setMeasured\(m\); \}/,
    'the per-frame follow keeps the words with the box: the plan arriving in the chat moves no box');
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

// The tour a NEW user sees, on a phone: "What do you want to make?", Make it,
// then "Invite people later" (or "Go to the Homeroom app") on the made screen
// starts the maker's path. Homeroom bot builds a new user's project, so it has
// its chat and all nine steps; no step is skipped on a phone. The card counts
// them "1 of 9" to "9 of 9": the app shown whole, then #4225's Suggest in its
// Homeroom menu, then ✕ ringed alone (#4390).
test('a new user\'s tour, numbered as its card numbers it, with what each step cuts out', () => {
  const { makerSteps, SCREEN_HEADER, BOTTOM_BARS, BOT_CHAT_HEADER, BOT_CHAT_MESSAGES } = loadTsx(`${DIR}/tour-steps.ts`);
  assert.equal(SCREEN_HEADER, '#platform-header');
  assert.equal(BOTTOM_BARS, '#platform-parked, #platform-tabs');
  const steps = makerSteps({ slug: 'film', name: 'Friday Film Crew', conversationId: 12 });
  const shape = (s) => ({
    screen: s.screen, target: s.target, alongside: s.alongside, endsAbove: s.endsAbove, press: s.press, tap: s.tap, title: s.title,
  });
  assert.deepEqual(steps.map(shape), [
    { screen: 'home', target: '.app-card[data-slug="film"]', alongside: undefined, endsAbove: undefined, press: undefined, tap: 'Tap it', title: 'Friday Film Crew is on your Home' },
    // 2: the app screen whole, its header included, nothing ringed.
    { screen: 'app', target: '#app-view', alongside: SCREEN_HEADER, endsAbove: undefined, press: undefined, tap: undefined, title: 'Friday Film Crew opens here' },
    // 3: the Homeroom mark, tapped: Suggest an improvement is behind it (#4225).
    { screen: 'app', target: '#platform-mark-btn', alongside: undefined, endsAbove: undefined, press: undefined, tap: 'Tap the menu', title: 'Suggest an improvement' },
    // 4: the menu it opens, its Suggest button ringed, not pressed.
    { screen: 'app', target: '#improve-row-feedback', alongside: undefined, endsAbove: undefined, press: undefined, tap: undefined, title: 'Suggest an improvement' },
    // 5: ✕ alone, ringed.
    { screen: 'app', target: '#back-btn', alongside: undefined, endsAbove: undefined, press: undefined, tap: 'Tap ✕', title: '✕ takes you back to Home' },
    { screen: 'home', target: '#platform-tab-workshop', alongside: undefined, endsAbove: undefined, press: undefined, tap: 'Tap Communities', title: 'You can find Friday Film Crew here' },
    // 7: the hub whole, with its header, down to the tab bar.
    { screen: 'hub', target: '#app-content', alongside: SCREEN_HEADER, endsAbove: BOTTOM_BARS, press: undefined, tap: undefined, title: 'The Friday Film Crew hub' },
    { screen: 'hub', target: '#platform-tab-messages', alongside: undefined, endsAbove: undefined, press: undefined, tap: 'Tap Messages', title: 'Homeroom bot is in Messages' },
    // 9: the chat with Homeroom bot, with the header over it.
    { screen: 'bot', target: `${BOT_CHAT_HEADER}, ${BOT_CHAT_MESSAGES}`, alongside: SCREEN_HEADER, endsAbove: undefined, press: undefined, tap: undefined, title: 'Homeroom bot is working on Friday Film Crew' },
  ]);
  // Why go to Messages: Homeroom bot is there, and it makes this app with you
  // (#4183; the owner, 8 October 2026).
  assert.equal(steps[7].text, 'It makes Friday Film Crew with you. You can always find it here.');
  // The invited path's app and hub steps are the same cut-outs.
  const { invitedSteps } = loadTsx(`${DIR}/tour-steps.ts`);
  const invited = invitedSteps({ slug: 'film', name: 'Friday Film Crew' });
  for (const at of [1, 2, 3, 4]) assert.deepEqual(invited[at], steps[at]);
  assert.deepEqual(['target', 'alongside', 'endsAbove'].map((f) => invited[6][f]), ['#app-content', SCREEN_HEADER, BOTTOM_BARS]);
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

test('2, 7 and 9 of 9 cut out their screen with its header: the whole app, the hub down to the tab bar, the bot\'s chat', () => {
  const { measure, holeFor, aroundBox } = loadTsx(`${DIR}/index.tsx`);
  const { makerSteps, BOT_CHAT_HEADER, BOT_CHAT_MESSAGES } = loadTsx(`${DIR}/tour-steps.ts`);
  const steps = makerSteps({ slug: 'film', name: 'Friday Film Crew', conversationId: 12 });
  // A 390x844 phone in the iOS app: the header's top padding is the status
  // bar's 47px inset, so its box starts at the top of the screen.
  const phone = { width: 390, height: 844 };
  const header = { left: 0, top: 0, width: 390, height: 99 };
  const screen = { left: 0, top: 91, width: 390, height: 753 };
  const tabs = { left: 0, top: 754, width: 390, height: 90 };
  const whole = { left: 0, top: 0, width: 390, height: 844 };

  // 2 of 9: the app screen and its header, the whole screen, with nothing
  // ringed in it (#4390: ✕ has a step of its own now).
  const backBtn = { left: 16, top: 55, width: 28, height: 28 };
  const app = withBoxes({ '#platform-header': header, '#app-view': screen, '#back-btn': backBtn }, () => measure(1, steps[1]));
  assert.deepEqual(app, { step: 1, box: whole, press: whole });
  assert.deepEqual(holeFor(app.box, phone, 0), whole, 'runs to the screen\'s edges, with no line of dim round it');
  // Not on the app screen yet: no cut-out (the header alone is not one), so
  // the screen dims whole and the step opens its screen itself.
  assert.deepEqual(withBoxes({ '#platform-header': header, '#back-btn': backBtn }, () => measure(1, steps[1])), { step: 1, box: null, press: null });

  // 5 of 9: ✕ alone, ringed, and all of it pressable.
  const close = withBoxes({ '#platform-header': header, '#app-view': screen, '#back-btn': backBtn }, () => measure(4, steps[4]));
  assert.deepEqual(close, { step: 4, box: backBtn, press: backBtn });
  const ring = holeFor(close.press, phone);
  assert.deepEqual(ring, { left: 10, top: 49, width: 40, height: 40 });
  assert.deepEqual(aroundBox(holeFor(close.box, phone), ring), []);

  // 7 of 9: the hub and its header, its padded foot meeting the tab bar.
  const hub = withBoxes({ '#platform-header': header, '#app-content': screen, '#platform-tabs': tabs }, () => measure(6, steps[6]));
  assert.deepEqual(hub.box, { left: 0, top: 0, width: 390, height: 748 });
  assert.deepEqual(holeFor(hub.box, phone, 0), { left: 0, top: 0, width: 390, height: 754 });
  // With the app you left on the bar, it stops above that strip too.
  const parked = { left: 8, top: 702, width: 374, height: 52 };
  const hubParked = withBoxes({ '#platform-header': header, '#app-content': screen, '#platform-tabs': tabs, '#platform-parked': parked }, () => measure(6, steps[6]));
  assert.equal(holeFor(hubParked.box, phone, 0).height, 702);
  // From 768px up the bar is the rail beside the screen, and takes nothing off.
  const wide = withBoxes({
    '#platform-header': { left: 0, top: 0, width: 1280, height: 60 },
    '#app-content': { left: 224, top: 52, width: 1056, height: 748 },
    '#platform-tabs': { left: 0, top: 60, width: 224, height: 740 },
  }, () => measure(6, steps[6]));
  assert.deepEqual(wide.box, { left: 0, top: 0, width: 1280, height: 800 });

  // 9 of 9: the header over the conversation's own header and messages.
  const chat = withBoxes({
    '#platform-header': header,
    [BOT_CHAT_HEADER]: { left: 0, top: 91, width: 390, height: 70 },
    [BOT_CHAT_MESSAGES]: { left: 0, top: 161, width: 390, height: 520 },
    '#platform-tabs': tabs,
  }, () => measure(8, steps[8]));
  assert.deepEqual(chat.box, { left: 0, top: 0, width: 390, height: 681 });
  assert.equal(chat.instead, false, 'no plan in the chat yet');

  // A tap step with no `press` rings its whole cut-out, as before, and
  // leaves all of it pressable.
  const tab = { left: 211, top: 756, width: 90, height: 56 };
  const communities = withBoxes({ '#platform-tab-workshop': tab }, () => measure(5, steps[5]));
  assert.deepEqual(communities, { step: 5, box: tab, press: tab });
  const tabHole = holeFor(communities.box, phone);
  assert.deepEqual(aroundBox(tabHole, holeFor(communities.press, phone)), []);

  const src = read(`${DIR}/index.tsx`);
  assert.match(src, /const pointed = !!\(step\.tap \|\| step\.ringed\);/);
  assert.match(src, /const hole = box && holeFor\(box, viewport, pointed && !step\.press \? RING : 0\);/);
  assert.match(src, /const ring = hole && pointed && pressBox \? holeFor\(pressBox, viewport\) : null;/);
  // Only a tap step leaves its ring pressable; a step that only points at a
  // control ("Look around first") covers it, so a press stays in the tour.
  assert.match(src, /const covers = hole \? \(ring && step\.tap \? aroundBox\(hole, ring\) : \[hole\]\) : \[\];/);
  assert.match(src, /\{covers\.map\(\(cover, i\) => <div key=\{i\} className="pointer-events-auto fixed" style=\{cover\} \/>\)\}/);
});

// "Make 'tap to open it' also clickable (and the other steps like it) in the
// tutorial, don't change the styling tho, I like it blue. Maybe just a tap
// state, but not a button." (Evan, 5 October 2026)
test('the blue hint on a tap step presses the step\'s own control, and still looks like the words it was', () => {
  const { pressTarget, pressOf, Tour } = loadTsx(`${DIR}/index.tsx`);
  const { makerSteps } = loadTsx(`${DIR}/tour-steps.ts`);
  const steps = makerSteps({ slug: 'film', name: 'Friday Film Crew', conversationId: 12 });
  // The control it presses is the one the step's watcher waits for.
  assert.deepEqual(steps.filter((s) => s.tap).map(pressOf), [
    '.app-card[data-slug="film"]', '#platform-mark-btn', '#back-btn', '#platform-tab-workshop', '#platform-tab-messages',
  ]);

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
  const had = { window: Object.hasOwn(globalThis, 'window'), document: Object.hasOwn(globalThis, 'document') };
  const before = { window: globalThis.window, document: globalThis.document };
  globalThis.window = { innerWidth: 390, innerHeight: 844 };
  globalThis.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
  let html;
  try {
    html = renderToHtml(createElement(Tour, { info: { slug: 'film', name: 'Friday Film Crew', conversationId: 12 }, steps, onEnd() {} }));
  } finally {
    for (const k of ['window', 'document']) { if (had[k]) globalThis[k] = before[k]; else delete globalThis[k]; }
  }
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
  assert.match(app, /toast\(DEAD\[result\.reason\] \|\| 'Could not join\. Try again\.', true\); return; \}\s+joinedHere = true;/);
  // Join pressed on the link's page, then a password sign-in: no second ask.
  assert.match(app, /pressed = sessionStorage\.getItem\('usernode:invite-join'\) === `\/invite\/\$\{token\}`;\s+sessionStorage\.removeItem\('usernode:invite-join'\);/);
  assert.match(app, /const ok = pressed \? true : window\.ConfirmModal \? await ConfirmModal\.show\(\{/);
  const sheet = read('frontend/src/features/auth/sign-in-sheet.tsx');
  assert.match(sheet, /onClick=\{\(\) => \{ if \(followInvite\) rememberInviteJoin\(\); onClose\(\); \}\}/);
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
  // communities_onboarded_at stays NULL, so the Getting started card, which
  // needs it, stays out of their first session too.
  assert.doesNotMatch(invites, /communities_onboarded_at = NOW\(\)/);
});

test("You're in says that you joined, and shows the community: its app and its people (#4052)", () => {
  const src = read(`${DIR}/index.tsx`);
  // The welcome, what the community makes, who is in it, and the button.
  // The story was told once, on the invite page; the tour teaches the rest.
  assert.match(src, /<h1 id="first-session-title"[^>]*>\s+\{`Welcome to \$\{info\.name\}`\}/);
  assert.doesNotMatch(src, /Welcome, \$\{who\}|You joined/);
  assert.match(src, /\{`Go to \$\{info\.name\}`\}/);
  const youreIn = src.slice(src.indexOf('export function YoureIn('), src.indexOf('export type Mode ='));
  assert.ok(youreIn.length > 200, 'YoureIn is found');
  assert.doesNotMatch(youreIn, /How it works|group|Have a look|On Homeroom|You're in, |JoinedPicture|!`|!'/);
  // The Homeroom logo bar, like every first-run screen (owner, 7 October).
  assert.match(src, /<Wordmark className="h-6 w-auto text-zinc-950 dark:text-white" \/>/);
  // Its first version still on its way is still handed to the tour.
  assert.match(read('public/js/app.js'), /building: !!standing\.building,/);
});

// ── First-session run-through, 5 October 2026 ──────────────────────────

test('the App step shows the app on both paths, ✕ has its own card, and the hub needs no possessive', () => {
  const { invitedSteps, makerSteps, hubTitle } = loadTsx(`${DIR}/tour-steps.ts`);
  // #4044: the app opens full screen. #4390: its card says what the app is,
  // with Next, and ✕ is a card of its own after the menu's. Where the first
  // version stands is the screen's to say, the same way everywhere (#4043,
  // #4053), so the card no longer reads it.
  for (const steps of [
    invitedSteps({ slug: 'page-turners', name: 'Page Turners' }),
    makerSteps({ slug: 'page-turners', name: 'Page Turners', conversationId: 3 }),
  ]) {
    assert.deepEqual([steps[1].screen, steps[1].target, steps[1].press, steps[1].tap, steps[1].title, steps[1].text],
      ['app', '#app-view', undefined, undefined, 'Page Turners opens here', 'This is the app your community makes together.']);
    assert.deepEqual([steps[4].screen, steps[4].target, steps[4].tap, steps[4].title, steps[4].text],
      ['app', '#back-btn', 'Tap ✕', '✕ takes you back to Home', 'Open Page Turners again from Home any time.']);
    assert.equal(steps.some((s) => /being built|ready to try|Close it with/.test(`${s.title} ${s.text}`)), false);
  }
  // "Page Turners's hub": named without the possessive, on both paths.
  assert.equal(hubTitle('Page Turners'), 'The Page Turners hub');
  assert.equal(invitedSteps({ slug: 'p', name: 'Page Turners' })[6].title, 'The Page Turners hub');
  assert.equal(makerSteps({ slug: 'p', name: 'Page Turners', conversationId: 3 })[6].title, 'The Page Turners hub');
  const all = JSON.stringify([
    ...invitedSteps({ slug: 'p', name: 'Page Turners' }),
    ...makerSteps({ slug: 'p', name: 'Page Turners', conversationId: 3 }),
  ]);
  assert.doesNotMatch(all, /Turners's|\u2014/);
});

test('"You\'re in" reads where the first version stands, and hands it to the tour', () => {
  const { firstVersionStage } = loadTsx(`${DIR}/index.tsx`);
  assert.equal(firstVersionStage({ app: { first_version: { building: true, step: 3, of: 7, ready: false } } }), 'building');
  assert.equal(firstVersionStage({ app: { first_version: { building: true, step: 6, of: 7, ready: true } } }), 'ready');
  assert.equal(firstVersionStage({ app: { first_version: null } }), null);
  assert.equal(firstVersionStage(null), null);
  const src = read(`${DIR}/index.tsx`);
  // The App tab's own read, past the service worker's cache, in an effect.
  assert.match(src, /fetch\(madeAppUrl\(info\.slug\), \{ credentials: 'same-origin', cache: 'no-store' \}\)/);
  assert.match(src, /\.then\(\(body\) => \{ if \(live && body\) stage\.current = firstVersionStage\(body\); \}\)/);
  assert.match(src, /onClick=\{\(\) => onGo\(stage\.current\)\}/);
  assert.match(src, /setMode\(\{ kind: 'tour', info: \{ \.\.\.mode\.info, firstVersion \}, path: 'invited' \}\);/);
});

test('"You\'re in" reads who is in the community itself, and the picture is no longer handed over', () => {
  const src = read(`${DIR}/index.tsx`);
  // The hub's own read, in an effect, unless a screenshot state brought them:
  // every member (owner, 7 October), how many, and what the app is.
  assert.match(src, /if \(info\.shot \|\| info\.people\) return undefined;/);
  assert.match(src, /fetch\(`\/api\/apps\/\$\{encodeURIComponent\(info\.slug\)\}\/community\?members=all`, \{ credentials: 'same-origin' \}\)/);
  assert.match(src, /setMembers\(body \? membersOf\(body\.members\) : \[\]\);/);
  assert.match(src, /setCount\(Number\(body\.member_count\) \|\| null\);\s+setDescription\(/);
  assert.match(read('src/routes/apps.js'), /communities\.listMembers\(pool, app\.id, req\.query\.members === 'all' \? 200 : 8\)/);
  // While that is read, the list's place breathes; a read that fails shows no list.
  assert.match(src, /<SkeletonGroup label="Loading who is in it"/);
  assert.match(src, /\.catch\(\(\) => \{ if \(live\) setMembers\(\[\]\); \}\);/);
  // The inviter's row comes first: both ways in hand over their username.
  assert.match(read('public/js/app.js'), /inviter: standing\.inviter \|\| null,\s+inviterName: standing\.inviterName \|\| standing\.inviter \|\| null,/);
  assert.match(read('src/services/collab-invites.js'), /inviter: row\.inviter \|\| null,\s+inviterName: row\.inviter_display_name/);
  assert.equal(fs.existsSync(path.join(ROOT, DIR, 'joined-picture.tsx')), false, 'the picture under the welcome is gone');
  // Neither way in hands over a picture or a description any more.
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

test('welcome() hands the held frame to a private member\'s app, and the follow\'s ending leaves it there', () => {
  const src = read(`${DIR}/index.tsx`);
  const welcome = src.slice(src.indexOf('welcome(info: FirstSessionInfo): boolean {'), src.indexOf('goHome('));
  // Marked as handed on BEFORE the navigation starts, so the endHold that
  // App._followInvite's finally runs right after welcome() returns is a no-op.
  const mark = welcome.indexOf("setMode((prev) => (prev.kind === 'held' ? { kind: 'held', app: slug } : prev));");
  const nav = welcome.indexOf("legacy().App?.navigateToApp?.(slug, 'app')");
  assert.ok(mark > -1 && nav > mark, 'marked, then navigated');
  assert.match(welcome, /void appDrawn\(going\)\.then\(\(\) => setMode\(\(prev\) => \(prev\.kind === 'held' && prev\.app === slug \? \{ kind: 'none' \} : prev\)\)\);/);
  // Nothing takes the frame down before the navigation in this branch.
  assert.doesNotMatch(welcome.slice(0, nav), /kind: 'none'/);
});

test('"You\'re in", drawn: the welcome, the app, everyone in it, and the button fixed at the foot', () => {
  const saved = global.window;
  // addEventListener: the island imports lib/back-stack.ts (the Create
  // door's back press, tests/create-front-door.test.js), which listens for
  // popstate on whatever window it finds when it loads.
  global.window = { App: { user: { username: 'priya', displayName: 'Priya' } }, addEventListener() {} };
  try {
    const { YoureIn, membersOf, rosterOrder, inviterOf, peopleCount } = loadTsx(`${DIR}/index.tsx`);
    const info = {
      slug: 'page-turners', name: 'Page Turners', iconEmoji: '📚', inviter: 'alex', inviterName: 'Alex', inviterMadeIt: true, building: true,
      description: 'What we read next',
      people: [{ username: 'sam', name: 'Sam' }, { username: 'priya', name: null }, { username: 'alex', name: 'Alex' }], memberCount: 3,
    };
    for (const newAccount of [true, false]) {
      const html = renderToHtml(createElement(YoureIn, { info: { ...info, newAccount }, onGo() {} }));
      assert.match(html, />Welcome to Page Turners</);
      assert.doesNotMatch(html, /Welcome, Priya|You joined/);
      assert.match(html, />Go to Page Turners</);
      // Top to bottom: the welcome, the title, the app's thumbnail, how many,
      // the inviter's row first, then the rest, and the button in the foot.
      const order = [
        'Welcome to Page Turners', 'data-featured-card="ready"', 'What we read next', '>3 people<',
        'data-first-session-member="alex"', 'data-first-session-member="sam"', 'data-first-session-member="priya"',
        'data-first-session-foot', 'Go to Page Turners',
      ].map((t) => html.indexOf(t));
      assert.ok(order.every((i) => i >= 0), JSON.stringify(order));
      assert.deepEqual([...order].sort((x, y) => x - y), order);
      // Each row: a face, the name, and who they are to you, 15 over 13.
      assert.match(html, /data-first-session-member="alex"[\s\S]*?>A<\/span>[\s\S]*?text-\[0\.9375rem\][^>]*>Alex<\/div>[\s\S]*?text-\[0\.8125rem\][^>]*>Invited you</);
      assert.match(html, /data-first-session-member="priya"[\s\S]*?>priya<\/div>[\s\S]*?>You</);
      assert.match(html, /data-first-session-member="sam"[\s\S]*?>Sam<\/div>[\s\S]*?>@sam</);
      assert.doesNotMatch(html, /How it works|group|data-build-line|first-session-picture|data-people-row|!/);
    }
    // With no signed-in name, the heading is the same: "Welcome to <name>".
    global.window = { App: { user: null } };
    assert.match(renderToHtml(createElement(YoureIn, { info, onGo() {} })), />Welcome to Page Turners</);
    // The read's members, cleaned, every one of them.
    assert.deepEqual(membersOf([{ username: 'a', display_name: 'Ann' }, { username: ' ' }, null, { username: 'a' }, { username: 'b' }]),
      [{ username: 'a', name: 'Ann' }, { username: 'b', name: null }]);
    assert.equal(membersOf(Array.from({ length: 12 }, (_, i) => ({ username: `u${i}` }))).length, 12, 'no cap at five');
    // The inviter by username, else by the name they were shown under.
    const list = membersOf([{ username: 'maker' }, { username: 'new' }, { username: 'alex', display_name: 'Alex' }]);
    assert.equal(inviterOf(list, 'alex', 'Alex'), 'alex');
    assert.equal(inviterOf(list, null, 'Alex'), 'alex');
    assert.equal(inviterOf(list, 'gone', 'Gone'), null);
    assert.deepEqual(rosterOrder(list, 'alex').map((m) => m.username), ['alex', 'maker', 'new']);
    assert.deepEqual(rosterOrder(list, null).map((m) => m.username), ['maker', 'new', 'alex']);
    assert.deepEqual([peopleCount(1), peopleCount(8)], ['1 person', '8 people']);
    // The list scrolls; the button does not.
    const src = read(`${DIR}/index.tsx`);
    assert.match(src, /<div data-first-session-foot="" className="mx-auto w-full max-w-sm shrink-0 /);
    assert.match(src, /<GroupedList className="mx-0">/);
  } finally {
    global.window = saved;
  }
});

test('"You\'re in"\'s screenshot states: made-up data, no request, and Go to only closes them', () => {
  const { youreInShot, shotWelcome } = loadTsx(`${DIR}/index.tsx`);
  const saved = global.location;
  try {
    for (const [search, shot] of [['?shot=youre-in', 'youre-in'], ['?shot=youre-in-many', 'youre-in-many'], ['?shot=invite-page', null], ['', null]]) {
      global.location = { pathname: '/', search };
      assert.equal(youreInShot(), shot, search);
    }
  } finally {
    if (saved === undefined) delete global.location; else global.location = saved;
  }
  const two = shotWelcome('youre-in', 'priya');
  assert.equal(two.shot, true);
  assert.deepEqual(two.people.map((p) => p.username), ['maya', 'priya']);
  assert.equal(two.memberCount, 2);
  assert.equal(two.inviter, 'maya');
  const many = shotWelcome('youre-in-many', 'priya');
  assert.equal(many.people.length, 8, 'everyone, more than fits above the button');
  assert.equal(many.memberCount, 8);
  const src = read(`${DIR}/index.tsx`);
  assert.match(src, /if \(mode\.info\.shot\) \{ setMode\(\{ kind: 'none' \}\); return; \}/);
  assert.match(src, /if \(info\.shot\) return undefined;\s+let live = true;\s+fetch\(madeAppUrl/);
});

// ── The three tours (#4044, #4045, #4072) ──────────────────────────────

test('"Look around first" has its own four cards on Home, each pointing at one place, with Next', () => {
  const { lookAroundSteps } = loadTsx(`${DIR}/tour-steps.ts`);
  const steps = lookAroundSteps();
  assert.deepEqual(steps.map((s) => [s.screen, s.target, s.title, s.text]), [
    ['home', '#home-create-tile', 'Make something any time', 'New project starts a community and its app.'],
    ['home', '#platform-tab-discover', 'Find apps in Discover', 'Open any app, or join its community.'],
    ['home', '#platform-tab-workshop', 'Communities you join show up here', 'Each one has its own hub and discussion.'],
    ['home', '#platform-tab-messages', 'Homeroom bot is in Messages', 'It makes apps with you. You can always find it here.'],
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

test('the maker\'s tour ends on the plan: "working on it" until it is in the chat, then how to answer it', () => {
  const { makerSteps, PLAN_WAITING } = loadTsx(`${DIR}/tour-steps.ts`);
  const { measure, wordsFor } = loadTsx(`${DIR}/index.tsx`);
  const last = makerSteps({ slug: 'run', name: 'Sunday Run Club', conversationId: 9 }).at(-1);
  assert.equal(last.last, true);
  assert.deepEqual([last.title, last.text], ['Homeroom bot is working on Sunday Run Club', 'It\'ll let you know here when there\'s something to look at.']);
  assert.deepEqual(last.instead, {
    when: PLAN_WAITING, title: 'Homeroom bot has a plan for you', text: 'Answer it here: tap Build it, or tell it what to change.',
  });
  // Nothing before a plan waits says one is ready (requests #4391, #4393).
  assert.doesNotMatch(`${last.title} ${last.text}`, /plan/i);
  // The open plan card in the chat with the bot, by the state its view draws.
  assert.equal(PLAN_WAITING, '.messages-thread-direct [data-bot-plan="open"]');
  assert.match(read('frontend/src/features/messages/bot-plan-view.tsx'), /data-bot-plan=\{shown\}/);
  assert.match(read('frontend/src/features/messages/bot-plan-view.tsx'), /data-bot-plan-build=""\s+onClick=\{\(\) => \{ setBuiltHere\(true\); onBuild\?\.\(picked\); \}\}\s*>Build it<\/button>/);
  // Read with the cut-out each frame, so the words change when the plan comes.
  const doc = (planShown) => ({
    querySelectorAll: (sel) => (sel === PLAN_WAITING && planShown
      ? [{ getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 400 }) }] : []),
  });
  const had = Object.hasOwn(globalThis, 'document');
  const before = globalThis.document;
  try {
    globalThis.document = doc(false);
    const waiting = measure(5, last);
    assert.equal(waiting.instead, false);
    assert.deepEqual(wordsFor(last, waiting, 5), { title: last.title, text: last.text });
    globalThis.document = doc(true);
    const plan = measure(5, last);
    assert.equal(plan.instead, true);
    assert.deepEqual(wordsFor(last, plan, 5), { title: 'Homeroom bot has a plan for you', text: 'Answer it here: tap Build it, or tell it what to change.' });
    // Only for the step it was measured for.
    assert.deepEqual(wordsFor(last, plan, 4), { title: last.title, text: last.text });
  } finally {
    if (had) globalThis.document = before; else delete globalThis.document;
  }
  // The card covers the chat while it is up: nothing asks for the plan's
  // answer before the tour ends (decision C).
  assert.equal(last.tap, undefined);
  assert.equal(last.ringed, undefined);
  const src = read(`${DIR}/index.tsx`);
  assert.match(src, /const words = wordsFor\(step, measured, index\);/);
  assert.match(src, /\{words\.title\}<\/p>/);
  // A plan that arrives while the card is already up switches its words: the
  // frame loop measures every frame and keeps a new reading whenever
  // `instead` flips, even though no box moved.
  assert.match(src, /const m = measure\(at, stepRef\.current\);/);
  assert.match(src, /const key = `\$\{at\}:\$\{boxKey\(m\.box\)\}:\$\{boxKey\(m\.press\)\}:\$\{m\.instead \? 1 : 0\}`;\s*if \(key !== last\) \{ last = key; setMeasured\(m\); \}/);
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
  assert.deepEqual(tourShot('?shot=tour-make'), { path: 'maker', start: 0 });
  assert.deepEqual(tourShot('?shot=tour-join&step=5'), { path: 'invited', start: 4 });
  assert.deepEqual(tourShot('?shot=tour-look&step=3'), { path: 'look', start: 2 });
  assert.deepEqual(tourShot('?shot=tour-look&step=x'), { path: 'look', start: 0 });
  assert.deepEqual(tourShot('?shot=tour-private&step=4'), { path: 'private', start: 3 });
  assert.equal(tourShot('?shot=first-version'), null);
  assert.equal(tourShot(''), null);
  const src = read(`${DIR}/index.tsx`);
  // Over the first project on the viewer's Home, and making ends in their
  // chat with Homeroom bot when they have one.
  assert.match(src, /document\.querySelector\('#app-list \.app-card\[data-slug\]'\)/);
  assert.match(src, /const bot = \(body\.conversations \|\| \[\]\)\.find\(\(c\) => c\.kind === 'direct' && c\.homeroomBot === true\);/);
  // Once the shell is signed in; it opens over nothing else.
  assert.match(src, /const shot = tourShot\(window\.location\.search\);/);
  assert.match(src, /prev\.kind === 'none' \? \{ kind: 'tour', info, path: shot\.path, start: shot\.start \} : prev/);
  // Opened part-way, the tour opens that card's own screen; the count is
  // clamped to the tour.
  assert.match(src, /useState\(\(\) => Math\.max\(0, Math\.min\(start, steps\.length - 1\)\)\)/);
  assert.match(src, /if \(index > 0\) enterScreen\(steps\[index\]\.screen, info\.slug, info\.conversationId\);/);
  // No answer, no seen mark: the shot path never records.
  const opener = src.slice(src.indexOf('async function firstHomeProject'), src.indexOf('// Set by the signed-out story\'s sheet'));
  assert.doesNotMatch(opener, /recordLookAround|markSeen|noteAnswered|method: 'POST'/);
});

// The owner, 6 October 2026: each step scrolls its target into view before
// ringing it. On a Home whose collapsed grid is full, the New project tile is
// held back behind "Show all N apps" (home.js createHidden): the step presses
// that first, as a finger would.
test('each step brings its target into view before ringing it, drawing a held-back tile first', () => {
  const { outOfBand, bringIntoView } = loadTsx(`${DIR}/index.tsx`);
  const { lookAroundSteps } = loadTsx(`${DIR}/tour-steps.ts`);
  const band = { top: 99, bottom: 754 };
  assert.equal(outOfBand({ left: 16, top: 300, width: 80, height: 100 }, band), false, 'in the band: left where it is');
  assert.equal(outOfBand({ left: 16, top: 900, width: 80, height: 100 }, band), true, 'below the tab bar');
  assert.equal(outOfBand({ left: 16, top: 40, width: 80, height: 100 }, band), true, 'under the top bar');
  assert.equal(outOfBand({ left: 0, top: 0, width: 390, height: 800 }, band), false, 'a whole screen is not scrolled to');

  const first = lookAroundSteps()[0];
  assert.equal(first.revealWith, '#home-apps-more-btn');
  assert.match(read('frontend/src/features/home/apps-more.tsx'), /id="home-apps-more-btn"[\s\S]*home\._appsExpanded = true;\s+home\.render\(\);/);
  assert.match(read('frontend/src/features/home/home.js'), /create = createHidden \? null : \{/);

  const withDoc = (doc, fn) => {
    const had = Object.hasOwn(globalThis, 'document');
    const before = globalThis.document;
    globalThis.document = doc;
    try { return fn(); } finally { if (had) globalThis.document = before; else delete globalThis.document; }
  };
  const phone = { width: 390, height: 844 };
  // Held back: the expander is pressed, and nothing is done yet.
  let pressed = 0;
  const expander = { getBoundingClientRect: () => ({ width: 300, height: 30 }), click() { pressed += 1; } };
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
test('the App tab\'s card says where the app opens, and carries the attribute that hides the screen\'s own line', () => {
  const { makerSteps, invitedSteps, lookAroundSteps, privateSteps } = loadTsx(`${DIR}/tour-steps.ts`);
  const project = { slug: 'film', name: 'Friday Film Crew', conversationId: 12 };
  for (const steps of [makerSteps(project), invitedSteps(project), privateSteps(project)]) {
    assert.deepEqual(steps.map((s) => !!s.saysWhereItOpens), steps.map((s, i) => i === 1));
    assert.equal(steps[1].screen, 'app');
    assert.equal(steps[1].title, 'Friday Film Crew opens here');
  }
  assert.ok(lookAroundSteps().every((s) => !s.saysWhereItOpens));
  const src = read(`${DIR}/index.tsx`);
  assert.match(src, /role="dialog"\s+aria-labelledby="first-session-tour-title"\s+data-tour-says-where-it-opens=\{step\.saysWhereItOpens \? '' : undefined\}/);
});
