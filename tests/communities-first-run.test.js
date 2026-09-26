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
  assert.match(SIGNUP, /needs_username_choice, needs_communities_choice\)\s*\n\s*VALUES \(\$1, \$2, \$3, TRUE, NOW\(\), FALSE, FALSE, TRUE, TRUE\)/);
  // Every path a PERSON signs up through asks, not only email: the
  // activation-code route and wallet registration set the same flag.
  assert.match(AUTH, /'INSERT INTO users \(username, password, needs_communities_choice\) VALUES \(\$1, \$2, TRUE\) RETURNING id'/);
  assert.match(AUTH, /wallet_link_token, wallet_link_expires_at,\s*\n\s*needs_communities_choice\)\s*\n\s*VALUES \(\$1, \$2, \$3, \$4, \$5, TRUE\)/);
  assert.equal((AUTH.match(/INSERT INTO users/g) || []).length, 2, 'no third sign-up path that forgets it');
  // /api/auth/me carries both flags, failing toward no step and no card.
  assert.match(AUTH, /let needsCommunitiesChoice = false;\s*\n\s*let showGettingStarted = false;/);
  assert.match(AUTH, /\(u\.communities_onboarded_at IS NOT NULL\s*\n\s*AND u\.getting_started_closed_at IS NULL\) AS show_getting_started/);
  assert.match(AUTH, /\n\s*needsCommunitiesChoice,\n/);
  assert.match(AUTH, /\n\s*showGettingStarted,\n/);
});

// ── the join screen ────────────────────────────────────────────────────

test('the join screen comes after the username and terms steps, and before the tour', () => {
  assert.ok(MAIN.indexOf("import './features/auth/username-first-run.js';")
    < MAIN.indexOf("import './features/auth/communities-first-run.js';"));
  assert.match(GATE, /window\.App\.user\.needsCommunitiesChoice !== true/);
  // It waits on terms, which waits on the username step.
  assert.match(GATE, /const terms = window\.TermsFirstRun;[\s\S]{0,120}await terms\.settled\(\);/);
  assert.ok(GATE.indexOf('await CommunitiesFirstRun._afterEarlierSteps();')
    < GATE.indexOf("fetch('/api/me/join-suggestions'"), 'terms first, then the list');
  // It publishes the settled() the tour waits on.
  assert.match(GATE, /window\.CommunitiesFirstRun = CommunitiesFirstRun;/);
  assert.match(read('frontend/src/features/home/tour/index.tsx'), /host\.CommunitiesFirstRun/);
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
  assert.match(GATE, /'You can join or leave any time from Discover, and start your own group or community once you are in\.'/);
  // A row with no description of its own is just its name: no empty line.
  assert.match(GATE, /if \(c\.detail\) \{\s*\n\s*text\.appendChild\(el\('div', 'mt-0\.5 line-clamp-2/);
  // In the screen's order, so the first one ticked is the card's.
  assert.match(GATE, /join: list\.map\(\(c\) => c\.slug\)\.filter\(\(s\) => picked\.has\(s\)\)/);
  // Skip is an answer: it posts `{ skip: true }` through the same path.
  assert.match(GATE, /'Skip for now'\);\s*\n\s*skip\.type = 'button';\s*\n\s*skip\.setAttribute\('data-join-communities-skip', ''\);/);
  assert.match(GATE, /skip\.addEventListener\('click', \(\) => \{ void answer\(\{ skip: true \}\); \}\);/);
  assert.ok(GATE.indexOf("panel.appendChild(save);") < GATE.indexOf("panel.appendChild(skip);"),
    'under the Join button, not beside it');
  // Home re-reads its pins and the card appears.
  assert.match(GATE, /new CustomEvent\('sv:communities-joined'/);
  assert.match(GATE, /window\.App\.user\.showGettingStarted = true;/);
  const code = GATE.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
  assert.doesNotMatch(code, /console\.error/, 'a console error on any route fails proposal checks');
  assert.doesNotMatch(code, /—/, 'no em dash in the copy');
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

test('the card counts, records the two visits it asks for, and closes for good', () => {
  const card = loadTsx('frontend/src/features/home/getting-started.tsx');
  assert.equal(card.counterText({ done: 1, total: 3 }), '1 of 3');
  assert.equal(card.counterText({ done: 3, total: 3 }), 'All done');
  assert.equal(card.seenKeyFor({ href: '#workshop' }), 'workshop');
  assert.equal(card.seenKeyFor({ href: '#apps' }), 'discover');
  assert.equal(card.seenKeyFor({ href: '#messages/app/x' }), null, 'a message leaves its own row');
  assert.match(CARD_SRC, /void post\('\/api\/me\/getting-started\/close'\)/);
  assert.match(CARD_SRC, /void post\('\/api\/me\/getting-started\/seen', \{ step: seen \}\)/);
  // The fixture is three steps, one done, the shape the declared check reads.
  assert.deepEqual(card.SHOT_MODEL.steps.map((s) => [s.id, s.done]),
    [['say-hi', true], ['vote', false], ['explore', false]]);
  assert.doesNotMatch(CARD_SRC.replace(/\/\*[\s\S]*?\*\//g, ''), /—/);
});

// ── the tile mark (stage 4) ────────────────────────────────────────────

test('a Home tile says where it lives: people for a group, a lock for just you, nothing for a community', () => {
  assert.match(HOME_JS,
    /audience: app\.audience === 'invited' \|\| app\.audience === 'solo' \? app\.audience : 'open',/);
  assert.match(GRID_SRC, /\{app\.audience !== 'open' \? \(/);
  assert.match(GRID_SRC, /data-stage=\{app\.audience\}/);
  assert.match(GRID_SRC, /\? <UserGroupIcon className="w-3 h-3" aria-hidden="true" \/>\s*\n\s*: <LockIcon className="w-3 h-3" aria-hidden="true" \/>/);
  assert.match(GRID_SRC, /title=\{app\.audience === 'invited' \? 'Group' : 'Just you'\}/);
});

// ── declared checks ────────────────────────────────────────────────────

test('both screens have a declared check on their own screenshot state', () => {
  const join = DAPP.tests.find((t) => t.id === 'auth.join-communities-first-run');
  assert.equal(join.path, '/?shot=join-communities');
  assert.equal(join.expectText, 'Join 2 communities');
  assert.equal(join.visual, true);
  assert.match(join.expectSelector, /\[data-join-communities-save\]\[data-picked="2"\] \+ \[data-join-communities-skip\]$/,
    'the Skip sits right under the Join button');
  const card = DAPP.tests.find((t) => t.id === 'home.getting-started-card');
  assert.equal(card.path, '/?shot=getting-started');
  assert.match(card.expectSelector, /\[data-getting-started="1\/3"\]/);
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
  assert.match(fn, /SET needs_communities_choice = TRUE,\s*\n\s*communities_onboarded_at = NULL,\s*\n\s*getting_started_closed_at = NULL,\s*\n\s*getting_started_seen = NULL/);
  assert.doesNotMatch(fn, /community_members|app_favorites|user_terms_consents|username =/,
    'memberships, Home tiles, terms and the username stay');
  // Beside Reset password in the row's ⋯ menu, behind a confirm.
  const USERS = read('frontend/src/features/admin/admin-users.tsx');
  assert.ok(USERS.indexOf('Reset password</button>') < USERS.indexOf('Reset first run</button>'));
  assert.match(USERS, /className="admin-reset-first-run-btn /);
  assert.match(USERS, /fetch\(`\/api\/admin\/users\/\$\{user\.id\}\/reset-first-run`, \{ method: 'POST' \}\)/);
  assert.match(USERS, /title: `Reset \$\{user\.username\}'s first run\?`/);
});

test('a join screen shown in this browser starts the tour over', () => {
  const TOUR = read('frontend/src/features/home/tour/index.tsx');
  // The gate says so, and never for the ?shot= fixture.
  assert.match(GATE, /shownHere\(\) \{\s*\n\s*return CommunitiesFirstRun\._shownHere === true;/);
  assert.match(GATE, /if \(!\(opts && opts\.demo\)\) CommunitiesFirstRun\._shownHere = true;/);
  // A finished tour waits for a pending join screen instead of giving up...
  assert.match(TOUR, /if \(readDone\(userId\) && !firstRunPending\(\) && !firstRunShownHere\(\)\) return;/);
  // ...and once it has been shown here, "done" is cleared before the re-read.
  const start = TOUR.slice(TOUR.indexOf('if (started.current || userId == null) return;'));
  const body = start.slice(0, start.indexOf('}, [userId, start, firstRunRev]);'));
  assert.match(body, /if \(firstRunShownHere\(\)\) \{\s*\n\s*clearDone\(userId\);\s*\n\s*clearStep\(userId\);\s*\n\s*\}/);
  assert.ok(body.indexOf('clearDone(userId)') < body.lastIndexOf('if (readDone(userId)) return;'));
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
  // after its first look.
  const TOUR = read('frontend/src/features/home/tour/index.tsx');
  assert.match(TOUR, /document\.addEventListener\('sv:communities-joined', bump\);/);
  assert.match(TOUR, /\}, \[userId, start, firstRunRev\]\);/);
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
