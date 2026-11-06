// Header slim-down: the fork label, the platform version, the kudos
// badge, the trophy and the admin shield all left the header for the slide-out
// drawer. #1101 later added the installed mobile-app version directly to it and
// removed the unrelated per-dApp SHA.
//
// The load-bearing property for the moved slots is that they kept their ids
// while changing parent — renderers across app.js / app-view.js / kudos.js
// resolve them with getElementById. A well-meaning rename or a "tidy up the
// header" edit that re-adds a slot would break the pane silently, so all of it
// is pinned here.
//
// Static-assertion style (cf. tests/theme-mode.test.js): read the
// shipped source files and assert the wiring is present.
//
// Run with: node --test tests/header-status-pane.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { shellMarkup } = require('./lib/shell-markup');

const root = path.join(__dirname, '..');
const html = shellMarkup();
const appJs = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const appViewJs = fs.readFileSync(path.join(root, 'public/js/app-view.js'), 'utf8');
const kudosJs = fs.readFileSync(path.join(root, 'frontend/src/features/leaderboard/kudos.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/css/app.css'), 'utf8');

const header = html.slice(0, html.indexOf('</header>'));
// THE UI OVERHAUL emptied the drawer of everything that was not navigation or
// notifications. These four slots are the load-bearing survivors, and where
// each one now lives is the thing this file pins:
//
//   #platform-version-pill-slot  → Settings' About pane
//   #native-app-version-slot        ([data-settings-section="about"]). Both
//                                   describe the PLATFORM — the deployed web
//                                   build and the installed mobile app — so
//                                   they outlived the app-scoped footer they
//                                   were passing through.
//
//                                   They spent a while IN that footer: the
//                                   anchor here used to be #improve-footer
//                                   while the comment already said "Settings'
//                                   About block", which is the tell. The
//                                   Improve panel says what is HAPPENING to
//                                   the build now — a note while one is being
//                                   made, a reload when one is ready — and the
//                                   revisions themselves are back on the
//                                   screen you consult.
//   #app-fork-badge-slot         → RETIRED with the drawer's reference footer.
//                                  Fork lineage is a fact about an app, and it
//                                  renders on the app's own page from the
//                                  detail descriptor now (#browse-detail-fork,
//                                  features/apps/browse-detail.tsx) rather than
//                                  through a slot a legacy module wrote into.
//   #kudos-budget-slot           → RETIRED with the drawer's status pane. The
//                                  kudos figure lives on the Leaderboard,
//                                  which the home screen's Challenges area
//                                  links to.
//   #ai-budget-slot              → Settings → AI usage & models → Usage
//
// The load-bearing property is unchanged and is why they are pinned at all:
// each kept its id while changing parent, because renderers across app.js /
// app-view.js / kudos.js resolve them with getElementById. A well-meaning
// rename would break the value silently.
const ABOUT_SLOTS = [
  'platform-version-pill-slot',
  'native-app-version-slot',
];

test('each surviving slot exists exactly once, in its new region', () => {
  const aboutStart = html.indexOf('data-settings-section="about"');
  assert.ok(aboutStart > -1, "Settings' About pane is missing from the shell");
  for (const id of ABOUT_SLOTS) {
    const hits = html.match(new RegExp(`id="${id}"`, 'g')) || [];
    assert.equal(hits.length, 1, `exactly one #${id} in the shell`);
    assert.ok(html.indexOf(`id="${id}"`) > aboutStart,
      `#${id} lives inside Settings' About pane`);
  }
  // The app's own version is the third row of that pane, and the Improve
  // panel's copy of it is gone — one row per fact.
  assert.ok(html.indexOf('id="about-row-app-version"') > aboutStart,
    'the app version row is in the About pane too');
  assert.equal(html.indexOf('id="improve-row-version"'), -1,
    'and the Improve panel no longer carries a duplicate');
  // The fork slot is gone outright, writer included.
  assert.ok(!html.includes('id="app-fork-badge-slot"'),
    'the fork slot is retired — the app page renders lineage from its descriptor');
  assert.ok(!/renderForkBadge\(\) \{/.test(appViewJs),
    'and nothing writes into it any more');

  // The AI-credit slot is a settings part's now: Usage, which leads the page
  // the Anthropic API key part sits on.
  const usage = html.indexOf('data-settings-section="usage"');
  assert.ok(usage > -1, 'the usage settings part is missing');
  assert.ok(html.indexOf('id="ai-budget-slot"') > usage,
    '#ai-budget-slot lives inside the Usage part');

  // And the drawer's status pane is gone outright, meters included.
  for (const id of ['drawer-status-pane', 'drawer-row-kudos', 'kudos-budget-slot',
    'drawer-footer', 'drawer-row-theme']) {
    assert.equal(html.indexOf(`id="${id}"`), -1, `#${id} was retired`);
  }
});

test('none of the moved slots are duplicated in the header', () => {
  for (const id of [...ABOUT_SLOTS, 'ai-budget-slot', 'kudos-budget-slot']) {
    assert.ok(!header.includes(`id="${id}"`), `#${id} has left the header`);
  }
  assert.ok(!header.includes('id="leaderboard-btn"'),
    'the trophy left the header (it is #drawer-row-leaderboard now)');
  assert.ok(!header.includes('id="admin-dashboard-btn"'),
    'the admin shield left the header (it is #drawer-row-admin now)');
});

test('the header keeps navigation + alerting only, hamburger first', () => {
  // THE UI OVERHAUL took four controls out of this group — #app-mode-switch,
  // #feedback-btn, #work-drawer-btn and #dev-console-btn — and put the whole
  // of what they did behind #improve-btn. The hamburger then went too: the
  // board's header leads with the app glyph and the title as ONE switcher
  // cluster, so the bar read back-slot → title → Improve.
  //
  // #2718 retired #improve-btn in turn, and the rule it was an instance of is
  // what survives: the bar ends on the control that opens the menu holding
  // everything those five did. That is the Homeroom mark now.
  const order = ['back-btn', 'header-title', 'platform-mark-btn'];
  let prev = -1;
  for (const id of order) {
    const at = header.indexOf(`id="${id}"`);
    assert.ok(at > -1, `#${id} is still in the header`);
    assert.ok(at > prev, `#${id} comes after the previous header control`);
    prev = at;
  }
  // The retired controls must not creep back in as a second way to do the
  // same things — that split is exactly what the overhaul removed. The
  // hamburger joins them: its rows are the Improve panel's and its badges are
  // the Improve button's.
  assert.ok(!header.includes('id="header-menu-btn"'),
    'the hamburger is gone from the bar');
  // #notifications-btn is deliberately NOT here any more: the Streamlined
  // board gives the bell back its own control in the right group, because the
  // drawer it used to live in is the APP's surface now.
  for (const id of ['app-mode-switch', 'feedback-btn', 'work-drawer-btn',
    'dev-console-btn', 'improve-btn']) {
    assert.equal(header.indexOf(`id="${id}"`), -1,
      `#${id} was retired and must not return to the header`);
  }
});

// ─── The deploy dot ──────────────────────────────────────────────────────

// ─── Badge geometry ──────────────────────────────────────────────────────

test('there is ONE badge in the header, and the Improve corner is a dot', () => {
  // #1610. There used to be two counts here — the bell's red one and
  // #notifications-badge-ai's green one on #improve-btn — and this test
  // diffed their class lists minus the colour token, because two numbers side
  // by side read as one convention only if their geometry matches.
  //
  // There is one number now. The green count moved into the bell (nothing
  // behind #improve-btn could mark a session notification read, so the badge
  // pointed at the one control that could not clear it), and what was left in
  // that corner is a bare pulse: no text, no count, nothing to dismiss — it
  // outlived the button itself and is on the Homeroom mark now (#2718). So
  // the rule this test pins is the SHAPE distinction rather than a geometry
  // equality — a count is a badge on the bell, a live state is a dot.
  const bellBadge = header.match(/<span id="notifications-badge"[^>]*>/);
  assert.ok(bellBadge, '#notifications-badge is on the bell');
  assert.match(bellBadge[0], /-top-1 -end-1/, 'the bell badge is at the top end corner');
  // red-600, not red-500 (QA 2026-09-24 Q20): white 10.4px bold on red-500 is
  // 3.76:1, one step darker is 4.83 and reads as the same red.
  assert.match(bellBadge[0], /bg-red-600/, 'the bell badge stays red, at a shade white text passes on');
  assert.match(bellBadge[0], /data-session-done="0"/,
    'and carries the completed-session attribute the declared check selects on');
  assert.ok(!header.includes('id="notifications-badge-ai"'),
    'the green count is retired, not merely emptied');

  const dot = header.match(/<span id="improve-working-dot"[^>]*>[\s\S]*?<\/span>/);
  assert.ok(dot, '#improve-working-dot is in the bar — on the mark since #2718');
  assert.match(dot[0], /-top-1\.5 -end-1\.5/, 'same corner the count used to hold');
  // #2779 follow-up: the 8px emerald pulse became a small blue spinner, on a
  // disc of the bar's own ground so it reads as cut out of the tile's corner.
  assert.match(dot[0], /w-\[15px\] h-\[15px\] rounded-full bg-zinc-200 text-violet-600 dark:bg-zinc-900 dark:text-violet-400/,
    'badge-sized, in the accent, on the bar\'s own ground');
  assert.match(dot[0], /<svg class="w-3 h-3 animate-spin motion-reduce:animate-none"/,
    'spinning, because it means "right now", and still for anyone who asked for less motion');
  assert.match(dot[0], /\bhidden\b/, 'hidden at rest, which is what the prerender ships');
  assert.equal(dot[0].replace(/<[^>]*>/g, '').trim(), '',
    'and carries no text node — a cue with a count in it is the retired badge');
});

test('the version state is the glyph, not a second dot beside it', () => {
  // THE DOT IS RETIRED. #1412 built it as #improve-version-dot on the Improve
  // button, the Streamlined Concept parked it on the hamburger as
  // #header-menu-deploy-dot, and with the hamburger gone it came back here —
  // by which time the button had grown a LEADING GLYPH that changes for
  // exactly the states the dot coloured: the spinner for deploying and
  // downloading, the arrow-path for ready and failed, off the same
  // `versionState`. Two renderers for one fact, and the smaller one needed a
  // colour lookup to be read at all.
  assert.ok(!html.includes('id="improve-version-dot"'), 'the dot is gone');
  assert.ok(!html.includes('id="header-menu-deploy-dot"'),
    'and so is the hamburger-era copy — this is a retirement, not a move');
  // AND SO IS THE GLYPH THAT REPLACED IT (#2718 review). It led
  // #app-menu-row-improve, which opened the Improve panel; the panel retired
  // and the row with it. What reads `versionState` now is the menu's own
  // update row, which says the state in WORDS rather than colouring a mark —
  // and it is no further away than the glyph was, because the glyph was
  // inside this same closed menu. A cue inside a closed menu is not a cue;
  // neither was the one it replaced, which is why the dots below are the
  // header's whole at-rest budget.
  const actions = fs.readFileSync(
    path.join(root, 'frontend/src/features/improve/actions.tsx'), 'utf8');
  assert.match(actions, /const \{ versionState, deploying, appUpdateReady \} = useStoreState\(improveStore\);/);
  assert.match(actions, /id="improve-update-ready"/, 'the ready state offers the reload');
  assert.doesNotMatch(actions, /VERSION_DOT/, 'and the colour table is long gone');

  // THE TWO LIVE DOTS OUTLIVED THE BUTTON. They are on the mark, which is
  // what the header has where the pill used to be — and it had to be a
  // control that is on screen on every route, because a cue inside a closed
  // menu is not a cue. The COUNTS are still the bell's (#1610).
  const mark = header.match(/<button id="platform-mark-btn"[\s\S]*?<\/button>/)[0];
  assert.match(mark, /<span class="relative shrink-0 inline-flex">/,
    'the mark TILE is the positioning context for the corners — a dot pinned '
    + 'to the button would hang off the disclosure chevron');
  assert.ok(mark.includes('id="improve-working-dot"'),
    'a turn running right now shows as a pulse on the mark');
  assert.ok(mark.includes('id="feedback-queue-dot"'),
    'beside the outbox dot, in the opposite corner');
  const bell = header.match(/<a id="notifications-btn"[^>]*>[\s\S]*?<\/a>/)[0];
  assert.ok(bell.includes('id="notifications-badge"'),
    'the unread badge rides the bell itself');
  assert.ok(!/id="notifications-badge/.test(mark),
    'and never the mark — a number there points at a control that cannot '
    + 'clear it, which is exactly what #1610 fixed');
});


test('the deploy dot is derived from a named state, not sniffed out of the DOM', () => {
  // #1079 chunk B moved it into the React bundle; app.js keeps a forwarder for
  // its call sites. It is ImproveStatus now, in the improve feature — its two
  // publishers are both about the Improve panel's own state, and the drawer
  // it was named after no longer has anything to do with either.
  const headerMenuJs = fs.readFileSync(
    path.join(root, 'frontend/src/features/improve/improve-status.js'), 'utf8');
  assert.match(headerMenuJs, /refreshDeployDot\(\)\s*\{/, 'ImproveStatus.refreshDeployDot is defined');
  const fn = headerMenuJs.slice(headerMenuJs.indexOf('  refreshDeployDot() {'));

  // IT READS A STATE, IT NO LONGER READS THE ROWS.
  //
  // This used to select `#improve-footer .drawer-ver--deploying` / `--stale`:
  // the classes App.renderPlatformVersionPill had just written, read back out
  // of the DOM to recover what that function already knew. The scope had
  // followed the version rows through every move they made
  // (#drawer-footer → the Improve panel's footer → Settings' About block),
  // which is the tell — an indicator on the header button should not care
  // where a row is rendered, and the last of those moves would have killed it
  // silently.
  //
  // The renderer names its state on App.platformUpdateState instead. That is
  // also FINER than the classes were: `--stale` deliberately covered both
  // "downloading the new build" and "the new build is ready", so the dot would
  // not blink off mid-download, and nothing downstream could tell a progress
  // note from a reload offer. They are separate states now, and the dot simply
  // gives both the same colour.
  assert.match(fn.slice(0, 1400), /window\.App\?\.platformUpdateState/,
    'reads the state the renderer named');
  // Comment-stripped: the note beside this code legitimately names both the
  // old scope and the old classes, to say what stopped being an input and
  // why. That history is the useful half of it — the same distinction
  // AGENTS.md draws for the AdminUI registry.
  const code = headerMenuJs.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/#improve-footer/.test(code),
    'and is not scoped to wherever the version rows currently live');
  assert.ok(!/drawer-ver--/.test(code),
    'no rendered class is an input to it any more');

  // It PUBLISHES: #improve-btn is React-owned, so an id lookup plus a
  // classList write would be a mismatch React patches straight back out.
  assert.match(fn.slice(0, 1400), /setVersionState/,
    'the dot is store state, not a class toggled by id');
  assert.ok(!/getElementById\('improve-version-dot'\)/.test(headerMenuJs),
    'nothing resolves the retired dot by id');
  // The platform-revision renderer and the app-open lifecycle both synchronize
  // the dot. dApp deploy pills live on home cards and are out of scope.
  const calls = (appJs.match(/ImproveStatus\.refreshDeployDot\(\)/g) || []).length
    + (headerMenuJs.match(/ImproveStatus\.refreshDeployDot\(\)/g) || []).length;
  assert.ok(calls >= 2,
    `refreshDeployDot is called from the revision renderer and lifecycle (found ${calls})`);
});

// ─── App-scoped row lifecycle ────────────────────────────────────────────

test('the mobile app version row ships hidden', () => {
  const nativeRow = html.match(/<div id="drawer-row-native-app-version"[^>]*>/);
  assert.ok(nativeRow, '#drawer-row-native-app-version exists');
  assert.match(nativeRow[0], /class="hidden /,
    'the mobile app version ships hidden until the native bridge answers');

  // The app-open lifecycle is unchanged — it publishes what the Improve panel
  // and the drawer are ABOUT, which outlived the reference rows entirely.
  assert.match(appJs, /ImproveStatus\.setAppOpen\(true\)/,
    'the app-open lifecycle still drives the header mode switch');
  assert.match(appViewJs, /ImproveStatus\.setAppOpen\(false\)/,
    'and AppView.close() clears it');
});

test('version information contains no particular dApp version', () => {
  assert.doesNotMatch(html, /drawer-row-app-version|app-version-pill-slot|dApp version/);
  assert.doesNotMatch(appViewJs, /\b(?:refreshVersionPill|applyHeaderDeployProgress)\b/,
    'opening a dApp no longer fetches or paints its SHA into the drawer');
  assert.match(html, /Platform version/,
    'the platform build row carries the #1211 "Platform version" label');
  assert.match(html, /Mobile app version/,
    'the semantic version/build is labelled as the installed mobile app');
});

// ─── Status-pane rows are not clickable containers ───────────────────────

test('reference rows are plain divs — the pills carry their own anchors', () => {
  // renderPlatformVersionPill's stale state renders a <button
  // onclick="location.reload()">, and the live state an <a>. Nesting
  // those inside a clickable row would be invalid markup. The rule followed the
  // rows all the way to Settings; #drawer-row-kudos is retired.
  for (const id of ['drawer-row-platform-version',
    'drawer-row-native-app-version', 'drawer-row-ai-budget']) {
    const row = html.match(new RegExp(`<(\\w+) id="${id}"`));
    assert.ok(row, `${id} exists`);
    assert.equal(row[1], 'div', `${id} is a <div>, never an <a>/<button>`);
  }
});

// ─── AI-credit row (#555) ────────────────────────────────────────────────

// Every signed-in user sees their own daily AI allowance. The row ships EMPTY
// because its audience isn't known until the me-scoped fetch answers.
//
// THE UI OVERHAUL moved it out of the drawer's status pane and into Settings →
// Anthropic API key: it is a figure you read while deciding whether to add a
// key, not something you act on from a navigation menu. The settings
// restructure gave it a part of its own, Usage, at the head of the page that
// key sits on. Same module, same slot id — see tests/ai-credit-drawer.test.js
// for the rest of the wiring.
//
// A sibling admin-only "Anthropic credits" row shipped in the same pane
// and was removed again (it could only ever read "Not set up"); the
// balance lives solely in the console's Spend limits section now.

test('the AI-credit row lives in the Usage part', () => {
  const paneStart = html.indexOf('data-settings-section="usage"');
  const id = 'drawer-row-ai-budget';
  const hits = html.match(new RegExp(`id="${id}"`, 'g')) || [];
  assert.equal(hits.length, 1, `exactly one #${id} in the shell`);
  assert.ok(paneStart > -1 && html.indexOf(`id="${id}"`) > paneStart,
    `#${id} lives inside the Usage part`);
  // Its slot is resolved by getElementById, same contract as the older
  // pills — a rename would break the renderer silently.
  assert.equal((html.match(/id="ai-budget-slot"/g) || []).length, 1,
    'exactly one #ai-budget-slot in the shell');
});

test('the Anthropic-credits row is gone from the shell and from renderAdminButton', () => {
  // Removed deliberately — it could only ever read "Not set up" on a
  // deployment with no recorded balance. Guard against it drifting back
  // in through the markup or the admin-visibility helper.
  assert.ok(!/drawer-row-anthropic-credits/.test(html),
    'no #drawer-row-anthropic-credits row in the shell');
  assert.ok(!/anthropic-credits-slot/.test(html),
    'no #anthropic-credits-slot in the shell');
  const fn = appJs.slice(appJs.indexOf('  renderAdminButton() {'));
  const body = fn.slice(0, 800);
  assert.ok(!/anthropic/i.test(body),
    'renderAdminButton owns only the console row now');
  assert.match(body, /App\.user\?\.isAdmin/,
    'still gated on isAdmin — view-only admins are part of the audience');
  assert.ok(!/canAdminWrite/.test(body),
    'never gated on canAdminWrite, which would exclude view-only admins');
});

// ─── CSS: the mobile collapse must no longer hide the moved slots ────────

test('the ≤640px collapse rule no longer hides the drawer slots', () => {
  // There are several max-width:640px blocks in the sheet — isolate the
  // pill-collapse one by its section comment.
  const from = css.indexOf('── Mobile pill collapse ');
  assert.ok(from > -1, 'the Mobile pill collapse section is present');
  const mq = css.slice(css.indexOf('@media (max-width: 640px)', from));
  const block = mq.slice(0, mq.indexOf('\n}\n'));
  assert.ok(!block.includes('#platform-version-pill-slot'),
    'the platform pill renders at every width now — it is in the drawer');
  // The home-card class slot still collapses: those pills DO crowd the
  // app name on a narrow card.
  assert.ok(block.includes('.app-version-pill-slot:not(:has(.app-version-pill--deploying))'),
    'the home-card pill slot still collapses on narrow viewports');
});

test('the drawer constrains a long pill so it cannot widen the 15rem panel', () => {
  // Post-#913 the version rows are .drawer-ver entries in the footer;
  // the width constraint moved onto that class (max-width + ellipsis).
  assert.match(css, /\.drawer-ver \{[^}]*max-width/,
    'version rows in the drawer footer are width-capped');
  assert.match(css, /\.drawer-ver \{[^}]*text-overflow:\s*ellipsis/,
    'and their value truncates rather than overflowing');
});


// The drawer's scroller went with the drawer. What it held is on screens now:
// the account rows in the Profile screen's account group
// (features/profile/account-panel.tsx), the notification list in its own sheet.

// ─── The kudos badge no longer pokes at header layout ────────────────────

test('the kudos badge stopped driving the header title measurement', () => {
  assert.ok(!/HeaderLayout\?\.refresh/.test(kudosJs),
    'the badge left the header long ago — it cannot affect the centred title');
  // The renderer keeps its getElementById contract even though THE UI OVERHAUL
  // retired the drawer row it painted into: it no-ops on a missing slot, and
  // leaving the lookup intact is what lets the figure be re-homed later
  // without touching the module.
  assert.match(kudosJs, /getElementById\('kudos-budget-slot'\)/,
    'and still resolves its slot by the unchanged id');
});
