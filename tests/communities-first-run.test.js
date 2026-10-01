'use strict';

// A new account's first run on the client (communities, stages 4 and 5):
// the join screen that follows the username and terms steps, the Getting
// started card on Home, and the small mark on a Home tile that says where a
// project lives. The server half (what the screen lists, what answering
// does, what ticks the card's steps) is tests/onboarding-postgres.test.js;
// the tour that runs between them is tests/home-tour.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const GATE = read('frontend/src/features/auth/communities-first-run.js');
const MAIN = read('frontend/src/main.tsx');
const AUTH = read('src/routes/auth.js');
const SIGNUP = read('src/services/email-signup.js');
const SCHEMA = read('src/db/schema.sql');
const CARD_SRC = read('frontend/src/features/home/getting-started.tsx');
const HOME_SRC = read('frontend/src/features/home/index.tsx');
const HOME_JS = read('frontend/src/features/home/home.js');
const GRID_SRC = read('frontend/src/features/home/app-grid.tsx');
const DAPP = JSON.parse(read('dapp.json'));

// ── who is asked ───────────────────────────────────────────────────────

test('only a new account is asked: a flag set at sign-up, false for everyone before it', () => {
  assert.match(SCHEMA,
    /ALTER TABLE users ADD COLUMN IF NOT EXISTS needs_communities_choice BOOLEAN NOT NULL DEFAULT FALSE;/);
  assert.match(SCHEMA, /ALTER TABLE users ADD COLUMN IF NOT EXISTS communities_onboarded_at TIMESTAMPTZ;/);
  assert.match(SCHEMA, /ALTER TABLE users ADD COLUMN IF NOT EXISTS getting_started_closed_at TIMESTAMPTZ;/);
  // No backfill: the default IS the answer for existing accounts, and for
  // the accounts the boot seeds (capture identities), which a NULL-means-new
  // rule would have put behind a blocking step.
  assert.doesNotMatch(SCHEMA, /UPDATE users\s+SET needs_communities_choice/);
  // The same three INSERTs mark a NEW account for the Getting started list
  // that gates its season (2026-10-01): `getting_started_gate`, FALSE for
  // every account made before it, with no backfill either.
  assert.match(SCHEMA,
    /ALTER TABLE users ADD COLUMN IF NOT EXISTS getting_started_gate BOOLEAN NOT NULL DEFAULT FALSE;/);
  assert.match(SCHEMA, /ALTER TABLE users ADD COLUMN IF NOT EXISTS getting_started_unlocked_at TIMESTAMPTZ;/);
  assert.doesNotMatch(SCHEMA, /UPDATE users\s+SET getting_started_gate/);
  assert.match(SIGNUP, /needs_username_choice, needs_communities_choice,\s*\n\s*getting_started_gate\)\s*\n\s*VALUES \(\$1, \$2, \$3, TRUE, NOW\(\), FALSE, FALSE, TRUE, TRUE, TRUE\)/);
  // Every path a PERSON signs up through asks, not only email: the
  // activation-code route and wallet registration set the same flags.
  assert.match(AUTH, /'INSERT INTO users \(username, password, needs_communities_choice, getting_started_gate\) VALUES \(\$1, \$2, TRUE, TRUE\) RETURNING id'/);
  assert.match(AUTH, /wallet_link_token, wallet_link_expires_at,\s*\n\s*needs_communities_choice, getting_started_gate\)\s*\n\s*VALUES \(\$1, \$2, \$3, \$4, \$5, TRUE, TRUE\)/);
  assert.equal((AUTH.match(/INSERT INTO users/g) || []).length, 2, 'no third sign-up path that forgets it');
  // /api/auth/me carries both flags, failing toward no step and no card. The
  // card is for a new account only.
  assert.match(AUTH, /let needsCommunitiesChoice = false;\s*\n\s*let showGettingStarted = false;/);
  assert.match(AUTH, /\(u\.communities_onboarded_at IS NOT NULL\s*\n\s*AND u\.getting_started_closed_at IS NULL\s*\n\s*AND u\.getting_started_gate\) AS show_getting_started/);
  assert.match(AUTH, /\n\s*needsCommunitiesChoice,\n/);
  assert.match(AUTH, /\n\s*showGettingStarted,\n/);
  // And whether the welcome tour is done on this account (#3237), next to
  // them, failing toward "not done" (the browser's own flag still counts).
  assert.match(SCHEMA, /ALTER TABLE users ADD COLUMN IF NOT EXISTS tour_done_at TIMESTAMPTZ;/);
  assert.match(AUTH, /let tourDone = false;/);
  assert.match(AUTH, /\(u\.tour_done_at IS NOT NULL\) AS tour_done,/);
  assert.match(AUTH, /tourDone = rows\[0\]\?\.tour_done === true;/);
  assert.match(AUTH, /\n\s*tourDone,\n/);
});

// ── the join screen ────────────────────────────────────────────────────

test('the join screen comes after the username and terms steps, and before Home and its card', () => {
  assert.ok(MAIN.indexOf("import './features/auth/username-first-run.js';")
    < MAIN.indexOf("import './features/auth/communities-first-run.js';"));
  assert.match(GATE, /window\.App\.user\.needsCommunitiesChoice !== true/);
  // It waits on terms, which waits on the username step.
  assert.match(GATE, /const terms = window\.TermsFirstRun;[\s\S]{0,120}await terms\.settled\(\);/);
  assert.ok(GATE.indexOf('await CommunitiesFirstRun._afterEarlierSteps();')
    < GATE.indexOf("fetch('/api/me/join-suggestions'"), 'terms first, then the list');
  // It publishes itself on window, where the tour reads whether a join
  // screen is due or was shown here (the tour no longer waits on it: it
  // starts from the card, #3240).
  assert.match(GATE, /window\.CommunitiesFirstRun = CommunitiesFirstRun;/);
  assert.match(read('frontend/src/features/home/tour/index.tsx'),
    /\(window as unknown as \{ CommunitiesFirstRun\?: FirstRunGate \}\)\.CommunitiesFirstRun;/);
});

test('it never lands on a capture route, and has one screenshot state of its own', () => {
  assert.match(GATE, /const SHOT = 'join-communities';/);
  assert.match(GATE, /params\.get\('shot'\) \|\| params\.get\('demo'\) \|\| params\.get\('token'\)/);
  assert.ok(GATE.indexOf("params.get('shot') === SHOT") < GATE.indexOf("params.get('token')"),
    'the one opt-in is read before the skip');
  // The fixture writes nothing.
  assert.match(GATE, /if \(opts && opts\.demo\) \{ status\.textContent = ''; return; \}/);
});

test('one filled button that says what it will do, and a quiet Skip for now', () => {
  assert.match(GATE, /PlatformUI\.modal\(\{ contentEl: panel, dismissible: false \}\)/);
  assert.match(GATE, /n === 0 \? 'Pick at least one'/);
  assert.match(GATE, /`Join \$\{n\} \$\{n === 1 \? 'community' : 'communities'\}`/);
  // A welcome and what the place is, then the question.
  assert.ok(GATE.indexOf("'Welcome to Homeroom!'") > 0);
  assert.match(GATE, /'Homeroom is a place where communities build the apps they use together\.'/);
  assert.ok(GATE.indexOf("'Welcome to Homeroom!'") < GATE.indexOf("'What communities do you want to join?'"));
  assert.match(GATE, /'You can join or leave any time from Discover, and start your own private or public community once you are in\.'/);
  // A row with no description of its own is just its name: no empty line.
  assert.match(GATE, /if \(c\.detail\) \{\s*\n\s*text\.appendChild\(el\('div', 'mt-0\.5 line-clamp-2/);
  // In the screen's order, so the first one ticked is the card's.
  assert.match(GATE, /join: list\.map\(\(c\) => c\.slug\)\.filter\(\(s\) => picked\.has\(s\)\)/);
  // Skip is an answer: it posts `{ skip: true }` through the same path.
  assert.match(GATE, /'Skip for now'\);\s*\n\s*skip\.type = 'button';\s*\n\s*skip\.setAttribute\('data-join-communities-skip', ''\);/);
  assert.match(GATE, /skip\.addEventListener\('click', \(\) => \{ void answer\(\{ skip: true \}\); \}\);/);
  // Both in the screen's foot since #3563 (the test below), Skip after Join.
  assert.ok(GATE.indexOf("foot.appendChild(save);") < GATE.indexOf("foot.appendChild(skip);"),
    'under the Join button, not beside it');
  // Home re-reads its pins and the card appears.
  assert.match(GATE, /new CustomEvent\('sv:communities-joined'/);
  assert.match(GATE, /window\.App\.user\.showGettingStarted = true;/);
  const code = GATE.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
  assert.doesNotMatch(code, /console\.error/, 'a console error on any route fails proposal checks');
  assert.doesNotMatch(code, /—/, 'no em dash in the copy');
});

// #3563: on a short screen (Safari with its bars showing, a 667px or 568px
// phone) the column ran past the kit card's bottom edge, Join cut in half
// and Skip under it, and the rows were a scroller of their own that took
// the swipe meant for the card. The screen is a body that scrolls and a foot
// that does not, inside a card laid out as a column.
test('Join and Skip stay on screen however short it is: the body scrolls, the foot does not', () => {
  // The body holds the welcome, the question, the rows and the line under
  // them, and is the one thing that scrolls, down to a floor.
  assert.match(GATE, /const panel = el\('div', 'flex min-h-0 flex-col px-4 pb-5'\);/);
  assert.match(GATE, /const scroller = el\('div', 'min-h-\[7\.5rem\] overflow-y-auto overscroll-y-contain'\);/);
  assert.ok(GATE.indexOf('panel.appendChild(scroller);') < GATE.indexOf('panel.appendChild(foot);'),
    'the foot is under the body');
  for (const part of ["'Welcome to Homeroom!'", 'scroller.appendChild(group);', "'You can join or leave any time"]) {
    const at = GATE.indexOf(part);
    assert.ok(at > 0 && GATE.lastIndexOf('scroller.appendChild(', at) > GATE.lastIndexOf('foot.appendChild(', at),
      `${part} is in the body`);
  }
  // The rows are not a scroller of their own any more.
  const group = GATE.match(/const group = el\('div', '([^']*)'\);/)[1];
  assert.doesNotMatch(group, /overflow|max-h/);
  assert.match(group, /^rounded-\[20px\] shadow-\[inset_0_0_0_1px_var\(--app-sheet-line\)\]/);
  // The foot: the error line, Join, Skip, and never shrinks.
  assert.match(GATE, /const foot = el\('div',\s*\n\s*'shrink-0 border-t border-transparent data-\[more\]:border-\[color:var\(--app-sheet-line\)\]'\);/);
  assert.match(GATE, /foot\.appendChild\(status\);[\s\S]*foot\.appendChild\(save\);[\s\S]*foot\.appendChild\(skip\);/);
  // The kit's card is a column, so the body can be told what is left. Only
  // the modal: the fallback sheet scrolls by itself.
  const modal = GATE.slice(GATE.indexOf("sheet = PlatformUI.modal({ contentEl: panel, dismissible: false });"),
    GATE.indexOf("if (!sheet && window.PlatformUI && typeof PlatformUI.sheet === 'function')"));
  assert.match(modal, /sheet\.el\.style\.display = 'flex';\s*\n\s*sheet\.el\.style\.flexDirection = 'column';/);
  // The hairline over the foot: on while there is more body below it,
  // re-read on scroll and on resize, and the watcher goes with the screen.
  assert.match(GATE, /foot\.toggleAttribute\('data-more',\s*\n\s*scroller\.scrollHeight - scroller\.clientHeight - scroller\.scrollTop > 1\);/);
  assert.match(GATE, /scroller\.addEventListener\('scroll', edge, \{ passive: true \}\);/);
  assert.match(GATE, /watch = new ResizeObserver\(edge\);\s*\n\s*watch\.observe\(scroller\);/);
  assert.match(GATE, /CommunitiesFirstRun\._answered = true;\s*\n\s*if \(watch\) watch\.disconnect\(\);/);
});

// ── the Getting started card ───────────────────────────────────────────

test('the card ships as an empty hidden section, and draws nothing until the server says so', () => {
  const html = renderComponent('frontend/src/features/home/getting-started.tsx', 'GettingStarted');
  assert.equal(html,
    '<section id="home-getting-started" class="hidden px-3 pb-2 pt-3" aria-label="Getting started"></section>');
  assert.match(CARD_SRC, /useHiddenClass\(rootRef, !model\);/);
  assert.match(CARD_SRC, /showGettingStarted === true/);
  assert.match(CARD_SRC, /fetch\('\/api\/me\/getting-started'/);
  // It sits on top of Home, above the widget strip and Your apps.
  assert.ok(HOME_SRC.indexOf('<GettingStarted />') < HOME_SRC.indexOf('<WidgetStrip />'));
  assert.ok(HOME_SRC.indexOf('<GettingStarted />') < HOME_SRC.indexOf('<section id="home-apps-section"'));
});

// 2026-10-01 (evan's "one list"): the card is the tour plus the season's
// First challenges, ticked from their credits. It counts steps and points,
// says what finishing unlocks, highlights the next step, and offers its close
// button only once everything is done. The two recorded visits it used to
// tick from (`/seen`) are gone with the steps that needed them.
test('the card counts steps and points, says what finishing unlocks, and closes only when done', () => {
  const card = loadTsx('frontend/src/features/home/getting-started.tsx');
  assert.equal(card.counterText({ done: 1, total: 5, earned_points: 500 }), '1 of 5 done · 500 pts earned');
  assert.equal(card.counterText({ done: 0, total: 5, earned_points: 0 }), '0 of 5 done', 'zero says nothing');
  assert.equal(card.counterText({ done: 5, total: 5, earned_points: 1500 }), '5 of 5 done · 1,500 pts earned');
  const unlocks = (count) => ({ count, names: [] });
  assert.equal(card.unlockText({ done: 1, total: 5, complete: false, unlocks: unlocks(6) }),
    'Finish all 5 to unlock 6 more challenges');
  assert.equal(card.unlockText({ done: 3, total: 5, complete: false, unlocks: unlocks(6) }),
    'Two more steps unlock 6 more challenges');
  assert.equal(card.unlockText({ done: 4, total: 5, complete: false, unlocks: unlocks(1) }),
    'One more step unlocks 1 more challenge');
  assert.equal(card.unlockText({ done: 1, total: 5, complete: false, unlocks: unlocks(0) }), null,
    'nothing locked, nothing to say');
  assert.equal(card.unlockText({ done: 5, total: 5, complete: true, unlocks: unlocks(6) }), null);
  assert.equal(card.unlockedLabel(6), '6 challenges unlocked');
  assert.equal(card.unlockedLabel(1), '1 challenge unlocked');
  assert.equal(card.unlockedLabel(0), null);
  // The right side: what a challenge pays, or once done what it paid. A bare
  // number gets " pts", prose is drawn as written, the tour has none.
  assert.deepEqual({ ...card.rewardText({ kind: 'challenge', done: false, reward: '500 pts', earned_points: 0 }) },
    { text: '500 pts', earned: false });
  assert.deepEqual({ ...card.rewardText({ kind: 'challenge', done: false, reward: '1500', earned_points: 0 }) },
    { text: '1500 pts', earned: false });
  assert.deepEqual({ ...card.rewardText({ kind: 'challenge', done: true, reward: '500 pts', earned_points: 500 }) },
    { text: '+500 pts', earned: true });
  assert.equal(card.rewardText({ kind: 'challenge', done: true, reward: 'Unlocks rewards', earned_points: 0 }), null);
  assert.equal(card.rewardText({ kind: 'tour', done: false, reward: null, earned_points: 0 }), null);
  // The next step is the first not done, whatever its position.
  assert.equal(card.nextStepId(card.SHOT_MODELS['getting-started']), 'tour');
  assert.equal(card.nextStepId(card.SHOT_MODELS['getting-started-halfway']), 'challenge-43');
  assert.equal(card.nextStepId(card.SHOT_MODELS['getting-started-done']), null);
  // Close: only the done state draws it, and only off a fixture does it post.
  assert.match(CARD_SRC, /<Header title="Getting started" model=\{model\} onClose=\{null\} \/>/);
  assert.match(CARD_SRC, /<Header title="You’re all set" model=\{model\} onClose=\{onClose\} \/>/);
  assert.match(CARD_SRC, /if \(!isShot\(shot\(\)\)\) void post\('\/api\/me\/getting-started\/close'\);/);
  assert.doesNotMatch(CARD_SRC, /getting-started\/seen|seenKeyFor/, 'no recorded visits any more');
  // The fixtures: just joined (1 of 5, Join ticked, the tour next), three in,
  // and all set. The first is the declared check's.
  assert.deepEqual(card.SHOT_MODEL.steps.map((s) => [s.kind, s.done]),
    [['tour', false], ['challenge', true], ['challenge', false], ['challenge', false], ['challenge', false]]);
  assert.deepEqual([card.SHOT_MODEL.done, card.SHOT_MODEL.total, card.SHOT_MODEL.earned_points], [1, 5, 500]);
  assert.equal(card.SHOT_MODELS['getting-started-halfway'].done, 3);
  assert.equal(card.SHOT_MODELS['getting-started-done'].complete, true);
  assert.equal(card.SHOT_MODELS['getting-started-done'].unlocks.count, 5);
  assert.doesNotMatch(CARD_SRC.replace(/\/\*[\s\S]*?\*\//g, ''), /—/);
});

test('the card draws the type and colour rules: 15 over 13, the lit tint on the next step, reward amber and earned green', () => {
  // The next row sits on `--lit-tint`, where you are; the accent ring marks it.
  assert.match(CARD_SRC, /const NEXT_ROW = 'bg-\[var\(--lit-tint\)\]';/);
  assert.match(CARD_SRC, /rounded-full border-2 border-violet-600 dark:border-violet-400/);
  // The challenge cards' reward amber and earned green, verbatim.
  assert.match(CARD_SRC, /text-amber-800 dark:text-amber-300/);
  assert.match(CARD_SRC, /text-emerald-700 dark:text-emerald-400/);
  // The done state's label over its list is small caps.
  assert.match(CARD_SRC, /text-xs font-bold uppercase tracking-\[0\.06em\] text-zinc-500 dark:text-zinc-400" data-getting-started-unlocked=/);
  // Rows come from ListRow (15/650 over 13), and the card is the plane card.
  assert.match(CARD_SRC, /<GroupedList\s*\n\s*tone="plane"/);
  assert.doesNotMatch(CARD_SRC, /\b(gray|indigo)-\d/);
});

// ── the tile mark (stage 4) ────────────────────────────────────────────

test('a Home tile says where it lives: people for a private community, a lock for just you, nothing for a public one', () => {
  assert.match(HOME_JS,
    /audience: app\.audience === 'invited' \|\| app\.audience === 'solo' \? app\.audience : 'open',/);
  assert.match(GRID_SRC, /\{app\.audience !== 'open' \? \(/);
  assert.match(GRID_SRC, /data-stage=\{app\.audience\}/);
  assert.match(GRID_SRC, /\? <UserGroupIcon className="w-3 h-3" aria-hidden="true" \/>\s*\n\s*: <LockIcon className="w-3 h-3" aria-hidden="true" \/>/);
  assert.match(GRID_SRC, /title=\{app\.audience === 'invited' \? 'Private community' : 'Just you'\}/);
});

// ── declared checks ────────────────────────────────────────────────────

test('both screens have a declared check on their own screenshot state', () => {
  const join = DAPP.tests.find((t) => t.id === 'auth.join-communities-first-run');
  assert.equal(join.path, '/?shot=join-communities');
  assert.equal(join.expectText, 'Join 2 communities');
  assert.equal(join.visual, true);
  assert.match(join.expectSelector, /\[data-join-communities-save\]\[data-picked="2"\] \+ \[data-join-communities-skip\]$/,
    'the Skip sits right under the Join button');
  // Rewritten in place for the one list (2026-10-01): just joined, so 1 of
  // 5, the tour next, a First challenge done after it and one still to do,
  // and the foot saying what finishing unlocks.
  const card = DAPP.tests.find((t) => t.id === 'home.getting-started-card');
  assert.equal(card.path, '/?shot=getting-started');
  assert.match(card.expectSelector, /\[data-getting-started="1\/5"\] \[data-getting-started-step="tour"\]\[data-next\] ~ \[data-getting-started-step="challenge"\]\[data-done="true"\] ~ /);
  assert.equal(card.expectText, 'Finish all 5 to unlock 5 more challenges');
  for (const t of [join, card]) assert.ok(t.expectSelector.length <= 256);
});

// ── Reset first run (admin) ────────────────────────────────────────────

test('an admin can reset an account\'s first run, from the user menu', () => {
  const ADMIN = read('src/routes/admin.js');
  const route = ADMIN.slice(ADMIN.indexOf("router.post('/api/admin/users/:id/reset-first-run'"));
  assert.ok(route.length > 0, 'the route exists');
  assert.match(route.slice(0, 200), /requireAdminWrite/, 'full admins only, like Reset password');
  assert.match(route.slice(0, 800), /const user = await onboarding\.resetFirstRun\(pool, userId\);/);
  // It resets the first run and nothing the account owns.
  const svc = read('src/services/onboarding.js');
  const fn = svc.slice(svc.indexOf('async function resetFirstRun('), svc.indexOf('/** The card\'s close button. */'));
  assert.match(fn, /SET needs_communities_choice = TRUE,\s*\n\s*communities_onboarded_at = NULL,\s*\n\s*getting_started_closed_at = NULL,\s*\n\s*getting_started_seen = NULL,\s*\n\s*tour_done_at = NULL,/,
    'and the tour, which the account keeps now (#3237), so it follows the join screen on every device');
  // And it puts the account on the Getting started list as a new account
  // (2026-10-01), the gate closed again: how an admin tries the first run.
  assert.match(fn, /tour_done_at = NULL,\s*\n\s*getting_started_gate = TRUE,\s*\n\s*getting_started_unlocked_at = NULL\n/);
  assert.doesNotMatch(fn, /community_members|app_favorites|user_terms_consents|username =/,
    'memberships, Home tiles, terms and the username stay');
  // Beside Reset password in the row's ⋯ menu, behind a confirm.
  const USERS = read('frontend/src/features/admin/admin-users.tsx');
  assert.ok(USERS.indexOf('Reset password</button>') < USERS.indexOf('Reset first run</button>'));
  assert.match(USERS, /className="admin-reset-first-run-btn /);
  assert.match(USERS, /fetch\(`\/api\/admin\/users\/\$\{user\.id\}\/reset-first-run`, \{ method: 'POST' \}\)/);
  assert.match(USERS, /title: `Reset \$\{user\.username\}'s first run\?`/);
});

test('a join screen shown in this browser forgets its "done", so the card offers the tour again', () => {
  const TOUR = read('frontend/src/features/home/tour/index.tsx');
  // The gate says so, and never for the ?shot= fixture.
  assert.match(GATE, /shownHere\(\) \{\s*\n\s*return CommunitiesFirstRun\._shownHere === true;/);
  assert.match(GATE, /if \(!\(opts && opts\.demo\)\) CommunitiesFirstRun\._shownHere = true;/);
  // The tour no longer starts by itself after the screen (#3240): the reset
  // cleared the account's "done", the card's tour row reads that, and this
  // browser's copy is cleared too, or the backfill would put it back.
  assert.doesNotMatch(TOUR, /tourDoneFor|whenFirstRunSettled/);
  const forget = TOUR.slice(TOUR.indexOf('const forget = () => {'));
  assert.match(forget.slice(0, forget.indexOf('}, [userId]);')),
    /if \(!firstRunShownHere\(\)\) return;\s*\n\s*clearDone\(userId\);\s*\n\s*clearStep\(userId\);/);
  // And never copied back over an account whose join screen is due.
  assert.match(TOUR, /joinShownHere: firstRunShownHere\(\),\s*\n\s*joinPending: firstRunPending\(\),/);
});

test('the card offers the tour as its first row, with a Start button until it is done', () => {
  // Server: the first step, ticked from the account's tour_done_at.
  const svc = read('src/services/onboarding.js');
  const fn = svc.slice(svc.indexOf('async function gettingStarted('), svc.indexOf('/**\n * An admin\'s "Reset first run"'));
  // Only for a new account (2026-10-01) that has answered the join screen.
  assert.match(fn, /SELECT communities_onboarded_at, getting_started_closed_at, getting_started_gate,\s*\n\s*tour_done_at/);
  assert.match(fn, /const show = !!\(u && u\.getting_started_gate && u\.communities_onboarded_at && !u\.getting_started_closed_at\);/);
  assert.match(fn, /const steps = \[\{[\s\S]*?id: 'tour',\s*kind: 'tour',\s*title: TOUR_STEP\.title,\s*detail: TOUR_STEP\.detail,\s*done: tourDone,\s*href: null,/);
  assert.match(svc, /title: 'Take the 1-minute tour',\s*\n\s*detail: 'See how Homeroom works\.',/);
  // Client: a row that is not a button, holding one; pressed, it asks for the
  // tour the way Settings' Replay does, and the tour's own write reloads it.
  assert.match(CARD_SRC, /step\.kind === 'tour' && !step\.done\) \{/);
  assert.match(CARD_SRC, /chevron=\{false\}/);
  assert.match(CARD_SRC, /variant="pillAccent"/);
  assert.match(CARD_SRC, /data-getting-started-tour-start=""/);
  assert.match(CARD_SRC, /if \(step\.kind === 'tour'\) \{\s*requestTour\(\);\s*return;\s*\}/);
  assert.match(CARD_SRC, /document\.addEventListener\(TOUR_DONE_EVENT, onChange\);/);
});

// A browser that has signed in before boots from the session snapshot, and
// every first-run gate skips an unverified session. The join screen used to
// stay skipped: only the terms ask was re-offered once the session was
// confirmed, so an account whose first run an admin reset saw nothing until
// it signed out and in again.
test('the join screen is re-offered once a snapshot boot confirms the session', () => {
  const APP_JS = read('public/js/app.js');
  const reconcile = APP_JS.slice(APP_JS.indexOf('async _reconcileSession('), APP_JS.indexOf('// ── Staged boot'));
  const terms = reconcile.indexOf('window.TermsFirstRun?.maybePrompt?.()');
  const join = reconcile.indexOf('window.CommunitiesFirstRun?.maybePrompt?.()');
  assert.ok(terms > 0 && join > terms, 'right after the terms ask, which it then waits for');
  assert.ok(reconcile.indexOf('App.user = user;') < join, 'with the confirmed user, not the snapshot');
  // The gate still skips the unverified boot itself.
  assert.match(GATE, /if \(window\.App && window\.App\._sessionFromSnapshot\) \{\s*\n\s*CommunitiesFirstRun\._resolve\(\);\s*\n\s*return;/);
  // It waits for a terms ask in flight or on screen, capped.
  assert.match(GATE, /for \(let i = 0; terms && \(terms\._inFlight \|\| terms\._presented\) && i < 2400; i \+= 1\) \{/);
  // The tour looks again once the screen is answered, which on this path is
  // after its first look, and forgets this browser's "done" then.
  const TOUR = read('frontend/src/features/home/tour/index.tsx');
  assert.match(TOUR, /document\.addEventListener\('sv:communities-joined', forget\);/);
  // And the card reads the confirmed session's showGettingStarted.
  assert.match(CARD_SRC, /document\.addEventListener\('sv:session', onChange\);/);
  assert.match(APP_JS, /document\.dispatchEvent\(new CustomEvent\('sv:session', \{/);
});

test('what the join screen says under each name', () => {
  const { suggestionDetail } = require('../src/services/onboarding');
  assert.equal(suggestionDetail({ self_hosted: true, description: 'ignored' }), 'Contribute to the Homeroom platform');
  assert.equal(suggestionDetail({ invited_by: 'ada', description: 'ignored' }), 'Invited by @ada');
  assert.equal(suggestionDetail({ description: 'A garden\n\nfor   everyone.' }), 'A garden for everyone.');
  assert.equal(suggestionDetail({ description: null }), '');
  assert.equal(suggestionDetail({ member_count: 40, audience: 'open' }), '', 'no "Community · N members"');
  // A starter line stands in until the community writes its own, and never
  // over it.
  assert.equal(suggestionDetail({ slug: 'gym-tracker-9de81f', description: null }), 'Log your workouts');
  assert.equal(suggestionDetail({ slug: 'gym-tracker-9de81f', description: '  ' }), 'Log your workouts');
  assert.equal(suggestionDetail({ slug: 'gym-tracker-9de81f', description: 'Lift, log, repeat.' }), 'Lift, log, repeat.');
  assert.equal(suggestionDetail({ slug: 'gym-tracker-9de81f', invited_by: 'ada' }), 'Invited by @ada');
  const { STARTER_DETAILS } = require('../src/services/onboarding');
  for (const [slug, line] of Object.entries(STARTER_DETAILS)) {
    const words = line.split(' ').length;
    assert.ok(words >= 2 && words <= 4, `${slug}: a starter line is a few words, not a sentence ("${line}")`);
    assert.doesNotMatch(line, /\.$/, `${slug}: no full stop on a few words`);
  }
  const long = suggestionDetail({ description: 'word '.repeat(60) });
  assert.ok(long.length <= 100 && long.endsWith('…'), 'two lines at most on a phone');
});

// The member count came back as a figure of its own at each row's end, a
// people glyph and a short number before the tick, beside the line under the
// name rather than in place of it (the line test above). Run for real: the
// module in a sandbox with just enough of a document to build one row's
// count.
function loadGate() {
  const vm = require('node:vm');
  const node = (tag) => ({
    tag, className: '', textContent: '', attrs: {}, children: [],
    setAttribute(k, v) { this.attrs[k] = String(v); },
    appendChild(child) { this.children.push(child); return child; },
  });
  const document = {
    createElement: node,
    createElementNS: (_ns, tag) => node(tag),
    addEventListener() {},
  };
  const window = { document };
  vm.runInNewContext(GATE, { window, document, console, URLSearchParams, location: { search: '' } });
  const el = (tag, cls, text) => {
    const n = node(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  return { gate: window.CommunitiesFirstRun, el };
}

test('each row ends in its member count, before the tick', () => {
  const { gate, el } = loadGate();
  // Short enough to sit beside the tick, rounded down so it never claims a
  // member the community does not have.
  const counts = { 1: '1', 999: '999', 1000: '1k', 1284: '1.2k', 2300: '2.3k', 9999: '9.9k',
    12345: '12k', 999999: '999k', 1000000: '1m', 2300000: '2.3m' };
  for (const [n, shown] of Object.entries(counts)) assert.equal(gate._count(Number(n)), shown, `${n}`);

  const row = gate._members({ member_count: 1284 }, el);
  assert.equal(row.attrs['data-join-community-members'], '1284');
  assert.match(row.className, /\bshrink-0\b/, 'the name truncates, never the count');
  assert.match(row.className, /\btabular-nums\b/);
  assert.match(row.className, /\btext-zinc-500 dark:text-zinc-400\b/, 'the secondary ink, as under the name');
  const [svg, figure, spoken] = row.children;
  assert.equal(svg.tag, 'svg');
  assert.equal(svg.attrs['aria-hidden'], 'true');
  assert.equal(figure.textContent, '1.2k');
  assert.equal(figure.attrs['aria-hidden'], 'true');
  // A screen reader hears the whole number as part of the checkbox's name.
  assert.equal(spoken.className, 'sr-only');
  assert.equal(spoken.textContent, '1,284 members');
  assert.equal(gate._members({ member_count: 1 }, el).children[2].textContent, '1 member');

  // No count, or none yet: no figure, not a "0".
  for (const c of [{}, { member_count: 0 }, { member_count: null }, { member_count: 'n/a' }]) {
    assert.equal(gate._members(c, el), null, JSON.stringify(c));
  }

  // The glyph is the shell's own UserGroupIcon, path for path.
  const icons = read('frontend/@/components/ui/icons.tsx');
  const group = icons.match(/export const UserGroupIcon = stroked\(\s*'UserGroupIcon',\s*'([^']+)'/)[1];
  assert.equal(svg.children[0].attrs.d, group);

  // Between the text and the tick, and only when there is one.
  assert.match(GATE, /row\.appendChild\(text\);\s*\n\s*if \(members\) row\.appendChild\(members\);\s*\n\s*row\.appendChild\(tick\);/);
  // The server already sends it, and the screenshot fixture shows it.
  assert.match(read('src/services/onboarding.js'), /member_count: Number\(row\.member_count\) \|\| 0,/);
  const fixture = GATE.slice(GATE.indexOf('const SHOT_LIST = ['), GATE.indexOf('];', GATE.indexOf('const SHOT_LIST = [')));
  assert.equal((fixture.match(/slug: '/g) || []).length, (fixture.match(/member_count: \d+/g) || []).length,
    'every fixture row has a count');
});
