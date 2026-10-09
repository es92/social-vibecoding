'use strict';

// The first session for somebody who arrives on their own: the signed-out
// story (frontend/src/features/auth/story.tsx), its switch
// (src/services/first-session.js), "What do you want to make?"
// (frontend/src/features/first-session/make.tsx), what comes after it
// (./made.tsx) and the maker's tour. Pins the words, the switch's failure
// direction, and the seams to the server.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderComponent, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const DIR = 'frontend/src/features/first-session';
const firstSession = require('../src/services/first-session');

function fakePool(rowsByCall) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      const next = rowsByCall.shift();
      if (next instanceof Error) throw next;
      return { rows: next || [] };
    },
  };
}

test('the story landing is on unless switched off, and on when the setting cannot be read', async () => {
  assert.equal(firstSession.STORY_KEY, 'first_session_story');
  assert.equal(await firstSession.storyLandingEnabled(fakePool([[]])), true, 'no row is the default: on');
  assert.equal(await firstSession.storyLandingEnabled(fakePool([[{ value: 'false' }]])), false);
  assert.equal(await firstSession.storyLandingEnabled(fakePool([new Error('relation does not exist')])), true);
  // A save forgets the cached read.
  const pool = fakePool([[{ value: 'true' }], [], [{ value: 'false' }]]);
  assert.equal(await firstSession.storyLandingEnabled(pool), true);
  await firstSession.setStoryLanding(pool, { enabled: false, actorId: 9 });
  assert.equal(await firstSession.storyLandingEnabled(pool), false);
  assert.deepEqual(pool.calls[1].params.slice(0, 2), ['first_session_story', 'false']);
});

test('the options carry the switch, and the admin switches it beside the invite setting', () => {
  assert.match(read('src/routes/public-api.js'), /story_landing: await firstSession\.storyLandingEnabled\(pool\),/);
  const admin = read('src/routes/topochain/admin/waitlist.js');
  assert.match(admin, /router\.get\('\/api\/v4\/admin\/story-landing',/);
  assert.match(admin, /router\.put\('\/api\/v4\/admin\/story-landing', adminWriteGate,/);
  const screen = read('frontend/src/features/admin/topochain/waitlist.tsx');
  assert.match(screen, /\{showAnalytics \? <WaitlistAnalyticsPanel onClose=\{\(\) => setShowAnalytics\(false\)\} \/> : null\}\s+<StoryLandingPanel \/>/);
  assert.match(screen, /id="admin-topo-wl-story-enabled"/);
});

test('making something, or looking around, answers the join screen without the Getting started card; starting answers nothing', async () => {
  const pool = fakePool([[], [], []]);
  await firstSession.answerJoinScreen(pool, 7, 'made');
  assert.match(pool.calls[0].sql, /SET needs_communities_choice = FALSE,/);
  assert.match(pool.calls[0].sql, /WHERE id = \$1 AND needs_communities_choice = TRUE/);
  assert.doesNotMatch(pool.calls[0].sql, /communities_onboarded_at/);
  // join_answer is still how the question reached them; the answer is beside it.
  assert.match(pool.calls[0].sql, /'join_answer', COALESCE\(getting_started_seen->>'first_session', \$2::text\),\s+'first_session_answer', \$2::text\)/);
  assert.deepEqual(pool.calls[0].params, [7, 'made']);
  await firstSession.answerJoinScreenByLookingAround(pool, 9);
  assert.deepEqual(pool.calls[1].params, [9, 'looked_around']);
  // #4039: "Look around first" is its own outcome in the admin Journey,
  // written with the answer in one statement, so once and only then; Make
  // it is already app_created with from 'first-session'.
  assert.match(pool.calls[1].sql, /RETURNING id, getting_started_seen->>'first_session' AS via\s+\)\s+INSERT INTO events \(user_id, event_type, metadata\)\s+SELECT a\.id, 'first_session_looked_around', jsonb_build_object\('via', a\.via\)\s+FROM answered a\s+WHERE \$2::text = 'looked_around'/);
  assert.equal(require('../src/services/events').EVENT_TYPES.FIRST_SESSION_LOOKED_AROUND, 'first_session_looked_around');
  // Being shown the question is recorded once, and leaves it owed.
  await firstSession.recordStart(pool, 7, 'story');
  assert.doesNotMatch(pool.calls[2].sql, /needs_communities_choice = FALSE/);
  assert.match(pool.calls[2].sql, /WHERE id = \$1 AND needs_communities_choice = TRUE\s+AND getting_started_seen->>'first_session' IS NULL/);
  assert.deepEqual(pool.calls[2].params, [7, 'story']);
  assert.match(read('src/routes/apps.js'), /if \(req\.body\.from === 'first-session'\) \{\s+await require\('\.\.\/services\/first-session'\)\.answerJoinScreenByMaking\(pool, req\.user\.id\)/);
  const routes = read('src/routes/onboarding.js');
  assert.match(routes, /router\.post\('\/api\/me\/first-session\/started', drainGuard, sameOriginBrowserOnly,/);
  assert.match(routes, /await firstSession\.recordStart\(pool, req\.user\.id, via\);/);
  assert.match(routes, /router\.post\('\/api\/me\/first-session\/look-around', drainGuard, sameOriginBrowserOnly,/);
  assert.match(routes, /await firstSession\.answerJoinScreenByLookingAround\(pool, req\.user\.id\);/);
  // A provider's sign-up from the story records the start the same way.
  assert.match(read('src/routes/sign-in-providers.js'), /if \(state\.started_from === 'story'\) await firstSession\.recordStart\(pool, result\.userId, 'story'\);/);
  // Recorded before the account is let in, so it is open to one still waiting;
  // the answer is not (the make screen is only ever shown with access).
  const gate = read('src/middleware/auth.js');
  assert.match(gate, /'\/api\/me\/first-session\/started',\s+\];/);
  assert.doesNotMatch(gate, /first-session\/look-around/);
});

test('an account that signs in some other way is asked what to make in the join screen\'s place', () => {
  // The server: only for an account still due the join screen, while the story is on.
  const auth = read('src/routes/auth.js');
  assert.match(auth, /if \(needsCommunitiesChoice\) storyFirstSession = await firstSession\.asksWhatToMake\(pool, req\.user\.id\);/);
  assert.match(auth, /needsCommunitiesChoice,\s+\/\/[^\n]*\n(?:\s+\/\/[^\n]*\n)*\s+storyFirstSession,/);
  // The join step hands over to the island, recording itself as 'sign_in'.
  const join = read('frontend/src/features/auth/communities-first-run.js');
  assert.match(join, /if \(window\.App\.user\.storyFirstSession === true && firstSession\) \{\s+CommunitiesFirstRun\._openFirstSession\(firstSession\);\s+return;/);
  assert.match(join, /body: JSON\.stringify\(\{ via: 'sign_in' \}\),/);
  // Opening it leaves the account's flag as the server said: only an answer clears it.
  const open = join.slice(join.indexOf('_openFirstSession(firstSession) {'), join.indexOf('_showFromSnapshot() {'));
  assert.match(open, /CommunitiesFirstRun\._answered = true;\s+firstSession\.make\(\);\s+CommunitiesFirstRun\._recordFirstSession\(\);\s+CommunitiesFirstRun\._resolve\(\);/);
  assert.doesNotMatch(open, /needsCommunitiesChoice = false/);
  // It comes before the suggestions are fetched, so the join screen is never drawn first.
  assert.ok(join.indexOf('CommunitiesFirstRun._openFirstSession(firstSession);') < join.indexOf("fetch('/api/me/join-suggestions'"));
  assert.match(read('src/routes/onboarding.js'), /const via = req\.body && req\.body\.via === 'sign_in' \? 'sign_in' : 'story';/);
  // The island opens it once, whichever of the two asks first, and draws it
  // at once when asked from the shell's own start (sv:authed, or the join
  // step in that tick), so Home is never painted before it.
  const island = read(`${DIR}/index.tsx`);
  assert.match(island, /const open = \(\) => setMode\(\(prev\) => \(prev\.kind === 'none' \? \{ kind: 'make' \} : prev\)\);\s+if \(now\) flushSync\(open\);\s+else open\(\);/);
  assert.match(island, /make\(\): boolean \{\s+try \{ sessionStorage\.removeItem\(MAKE_FLAG\); \} catch \{[^}]*\}\s+openMake\(setMode, true\);/);
  // No phone step waits in front of it any more (#4378): the flag opens it.
  assert.match(island, /if \(!flagged\) return;\s+try \{ sessionStorage\.removeItem\(MAKE_FLAG\); \} catch \{[^}]*\}\s+openMake\(setMode, now\);/);
  // From the mount's own check it is an ordinary update: React is mid-effect
  // there and cannot draw synchronously.
  assert.match(island, /if \(legacy\(\)\.App\?\.user\) check\(false\);\s+const onAuthed = \(\) => check\(true\);/);
});

test('the route records which way the first session was reached', async () => {
  const pool = fakePool([[]]);
  await firstSession.recordStart(pool, 8, 'sign_in');
  assert.deepEqual(pool.calls[0].params, [8, 'sign_in']);
});

test('the landing: the story in place of the pitch unless switched off, for nobody signed in and no invite', () => {
  const landing = read('frontend/src/features/auth/landing.tsx');
  // The default, so it is drawn before the options arrive, and when they fail.
  assert.match(landing, /const storyOn = waitlistPayload\?\.story_landing !== false && !onInvitePath && !session;/);
  assert.match(landing, /useState\(\s+\(\) => typeof location !== 'undefined' && !!inviteTokenFrom\(location\.pathname\),\s+\);/);
  assert.match(landing, /const pitchHidden = madeForYou \|\| storyOn \|\| invitePending;/);
  assert.match(landing, /<Story primaryClass=\{PRIMARY_PILL\} onStart=\{\(\) => setSheet\('start'\)\} onSignIn=\{\(\) => setSheet\('signin'\)\} \/>/);
  // A new account from its sheet is asked what to make, not which communities to join.
  assert.match(landing, /sessionStorage\.setItem\('usernode:first-session:make', '1'\)/);
  assert.match(landing, /fetch\('\/api\/me\/first-session\/started', \{ method: 'POST', credentials: 'same-origin' \}\)/);
  const story = read('frontend/src/features/auth/story.tsx');
  // No waitlist ask and no "learn more" link on it.
  assert.doesNotMatch(story, /Join the waitlist|Learn more about Homeroom/i);
});

// #4037, decisions A and B on the onboarding canvas, and the owner's review of
// 8 October (C1-story): "Welcome to Homeroom" over the picture, one headline,
// "For example" over the make screen's three examples (Evan's, #4354; their
// rows are pinned by the templates test below), "Get started", then "Already
// have an account? Sign in". Nothing under the button says what a new account
// waits for.
test('the story: label, headline, "For example" and the three examples, "Get started", then Sign in', () => {
  const html = renderComponent('frontend/src/features/auth/story.tsx', 'Story', { primaryClass: 'pill', onStart() {}, onSignIn() {} });
  // Each row: its emoji (the tier list draws a chart, no text), title and line.
  const TEMPLATE_ROWS = loadTsx(`${DIR}/examples.ts`).TEMPLATES.flatMap((t) => (t.chart ? [t.title, t.line] : [t.emoji, t.title, t.line]));
  const text = html.replace(/<[^>]+>/g, '\n').split('\n').map((t) => t.trim()).filter(Boolean)
    .map((t) => t.replace(/&#x27;/g, "'"));
  assert.deepEqual(text, [
    'Welcome to Homeroom',
    'On Homeroom, communities make apps together.',
    'For example',
    ...TEMPLATE_ROWS,
    'Get started',
    'Already have an account?',
    'Sign in',
  ]);
  assert.match(html, /<a href="#signup" data-landing-story-start="" class="pill">Get started<\/a>/);
  assert.match(html, /Already have an account\? <a href="#login" data-landing-story-signin=""/);
  assert.match(html, /<a href="#login" data-landing-story-signin=""[^>]*>Sign in<\/a>/);
  // In a phone browser too, the story fills the screen and its foot is at the foot.
  const css = read('public/css/app.css');
  assert.match(css, /html\[data-browser-scroller="auth-landing-scroll"\] #auth-landing-scroll:has\(> \* > \[data-landing-story\]\) \{\s+flex: 1 0 auto;\s+display: flex;\s+flex-direction: column;\s+\}/);
  assert.match(css, /html\[data-browser-scroller="auth-landing-scroll"\] #auth-landing-scroll > :has\(> \[data-landing-story\]\) \{\s+flex: 1 0 auto;\s+width: 100%;\s+\}/);
  for (const gone of [/Make an account/, /spot on the waitlist/, /Anyone using an app/, /What groups make/, /What communities make/]) {
    assert.doesNotMatch(html, gone);
  }
});

// Evan, 8 Oct 2026: the three examples became sentences to finish, each a
// whole description in a tap or two with the part that makes it theirs left
// to them. The same three on the story and the make screen.
test('three templates, the same on the story and the make screen, each a whole starting point', () => {
  const { TEMPLATES, OWN, sentence, suggestedName, firstChoice, descriptionOf } = loadTsx(`${DIR}/examples.ts`);
  assert.deepEqual(TEMPLATES.map((t) => t.key), ['tier', 'game', 'organizer']);
  for (const t of TEMPLATES) {
    for (const k of ['emoji', 'title', 'line', 'short', 'head', 'note']) assert.ok(t[k], `${t.key}.${k}`);
    assert.ok(t.note.length <= 280, `${t.key} note fits a link's note`);
    for (const c of t.choices) {
      const s = sentence(t, c.key, t.finish ? c.example : '');
      assert.ok(!s.blank && s.text.length >= 10, `${t.key}/${c.key} is a whole description`);
      assert.ok(c.name, `${t.key}/${c.key} suggests a name`);
      assert.ok(descriptionOf(t, c.key).length <= 90, `${t.key}/${c.key} description fits DESCRIPTION_MAX`);
    }
    assert.doesNotMatch(JSON.stringify(t), /—/, `${t.key}: no em dash`);
  }
  // The tier list: one tap is a whole description.
  const [tier, game, organizer] = TEMPLATES;
  assert.equal(firstChoice(tier), 'restaurants');
  assert.equal(sentence(tier, 'hikes', '').text, 'A tier list for our favorite hikes. Anyone can add items, everyone sorts them, and we can see where they land.');
  assert.deepEqual(tier.choices.map((c) => c.name), ['Restaurant Tier List', 'Hiking Tier List', 'City Tier List', 'Game Tier List']);
  assert.equal(sentence(tier, OWN, '').blank, true, 'Your own waits for their words');
  assert.equal(sentence(tier, OWN, '  taco   spots ').text, 'A tier list for our favorite taco spots. Anyone can add items, everyone sorts them, and we can see where they land.');
  assert.equal(suggestedName(tier, OWN, 'taco spots'), 'Taco Spots Tier List');
  // The game: always finished in their own words, and Your own comes first.
  assert.equal(game.finish, true);
  assert.equal(firstChoice(game), OWN);
  assert.equal(sentence(game, 'board', '').blank, true, 'a starter still waits for the rest');
  assert.equal(sentence(game, 'board', 'we roll dice').text, 'A new game we build together. For the first version, a board game where we roll dice.');
  assert.equal(sentence(game, OWN, 'a drawing game where one of us draws and everyone guesses!').text, 'A new game we build together. For the first version, a drawing game where one of us draws and everyone guesses!');
  assert.equal(suggestedName(game, OWN, 'a card game'), '', 'their own game is theirs to name');
  assert.equal(suggestedName(game, 'trivia', ''), 'Trivia Night');
  // The organizer: each choice says what it keeps.
  assert.deepEqual(organizer.choices.map((c) => [c.label, c.name]), [['Groceries', 'Grocery List'], ['Chores', 'Chore List'], ['Shared library', 'Lending Library'], ['Potlucks', 'Potluck Planner']]);
  // (What the ready-made chore list does: it sends no nudge.)
  assert.equal(sentence(organizer, 'chores', '').text, 'An app to organize our chores: who\'s on what this week, and whose turn it is next.');
  assert.equal(sentence(organizer, 'library', '').text, 'An app to organize our shared library: what we can borrow, who has it now, and who\'s asking for it next.');
  assert.equal(suggestedName(organizer, OWN, 'camping gear'), 'Camping Gear List');
  // The story says the same three, the tier list drawn as a tier list.
  const story = renderComponent('frontend/src/features/auth/story.tsx', 'Story', { primaryClass: 'pill', onStart() {}, onSignIn() {} });
  for (const t of TEMPLATES) assert.ok(story.includes(`>${t.title}<`) && story.includes(`>${t.line}<`), t.key);
  assert.match(story, /data-tier-chart=""/);
});

test('"Make it" makes a private community through the dialog\'s own route', () => {
  const make = read(`${DIR}/make.tsx`);
  // The dialog's own request (../dialogs/post-create-app.ts), not a copy of it.
  assert.match(make, /import \{ deviceTimeZone, postCreateApp \} from '\.\.\/dialogs\/post-create-app';/);
  assert.match(make, /const reply = await postCreateApp\(\{/);
  assert.doesNotMatch(make, /fetch\('\/api\/apps'/);
  // A description for Homeroom bot to build from, or a ready-made app to make (below).
  assert.match(make, /audience: 'invited',\s+\.\.\.\(ready \? \{ template: ready\.template \} : \{ brief: text\.trim\(\), \.\.\.\(starter \? \{ template: starter\.template \} : \{\}\) \}\),/,
    'a ready-made app has nothing to build; a game preset sends its starter beside the brief');
  // `from` is the door: 'first-session', or 'create' from the Create button.
  assert.match(make, /from: entry,/);
  assert.match(make, /export type MakeEntry = 'first-session' \| 'create';/);
  assert.match(make, /entry = 'first-session'/, 'the first session is the default door');
  assert.match(make, /export const BRIEF_MIN = 10;/);
  assert.equal(require('../src/services/homeroom-bot-dm').MIN_BRIEF_CHARS, 10, 'the server\'s floor');
  for (const words of ['What do you want to make?', 'What should it do?', 'What should we call it?', 'It\'s your group\'s name too. You can change it later.', 'Look around first']) {
    assert.ok(make.includes(words), words);
  }
});

// Evan, 8 Oct 2026: every choice that needs no typing makes one of
// Homeroom's ready-made apps (services/app-templates.js), so there is no
// first version to wait for. Your own words, and every game, still go to
// Homeroom bot.
test('a choice that needs no typing makes a ready-made app, with nothing for Homeroom bot to build', () => {
  const { TEMPLATES, OWN, readyMadeOf } = loadTsx(`${DIR}/examples.ts`);
  const appTemplates = require('../src/services/app-templates');
  const [tier, game, organizer] = TEMPLATES;
  const made = [...tier.choices, ...organizer.choices].map((c) => c.template);
  assert.deepEqual(made, appTemplates.READY_IDS, 'every no-typing choice, and only those, is a ready-made app');
  for (const c of game.choices) assert.equal(readyMadeOf(game, c.key), null, `${c.key}: a game is always built`);
  assert.equal(readyMadeOf(tier, OWN), null, 'their own words are built');
  assert.equal(readyMadeOf(organizer, OWN), null);
  assert.deepEqual(readyMadeOf(tier, 'hikes'), { template: 'tier-list-hikes', emoji: '📊' });
  // Its icon is the ready-made app's own, so the made screen and the tile agree.
  for (const t of [tier, organizer]) {
    for (const c of t.choices) assert.equal(readyMadeOf(t, c.key).emoji, appTemplates.get(c.template).icon, c.key);
  }

  const src = read(`${DIR}/make.tsx`);
  // Only while the sentence is drawn as it is: written out, it is theirs to build.
  assert.match(src, /const ready = templated && example \? readyMadeOf\(example, choice\) : null;/);
  assert.match(src, /emoji: ready \? ready\.emoji : example \? example\.emoji : null,/);
  assert.match(src, /\.\.\.\(ready \? \{ readyMade: true \} : \{\}\),/);
  // The sentence says so, quietly, under its choices.
  const make = loadTsx(`${DIR}/make.tsx`);
  assert.equal(make.READY_LINE, 'Ready-made: nothing to build, so it is ready as soon as it is set up.');
  assert.match(src, /\{readyMadeOf\(template, choice\) \? <p data-make-ready="" className=\{HINT\}>\{READY_LINE\}<\/p> : null\}/);
});

// Evan, 8 Oct 2026: each game preset starts its project from a game
// starter (services/app-templates.js `kind: 'game'`), a working multiplayer
// game Homeroom bot builds the maker's own idea on, instead of an empty page.
// Unlike a ready-made app, the brief still goes to the bot.
test('a game preset starts from a working game starter, and its brief is still built', () => {
  const { TEMPLATES, OWN, readyMadeOf, starterOf } = loadTsx(`${DIR}/examples.ts`);
  const appTemplates = require('../src/services/app-templates');
  const game = TEMPLATES.find((t) => t.key === 'game');
  assert.deepEqual(game.choices.map((c) => c.starter), ['game-board', 'game-space', 'game-blocks', 'game-trivia']);
  for (const c of game.choices) {
    const s = starterOf(game, c.key);
    assert.equal(s.template, c.starter);
    assert.ok(appTemplates.botStarter(s.template), `${c.key}: a starter the bot builds on`);
    assert.equal(appTemplates.isReadyMade(s.template), false, `${c.key}: never ready-made`);
    assert.equal(readyMadeOf(game, c.key), null);
    assert.ok(s.starts && !/\u2014/.test(s.starts), `${c.key}: says what it starts from`);
  }
  assert.equal(starterOf(game, OWN), null, 'their own game idea starts from the empty scaffold');
  for (const t of TEMPLATES.filter((x) => x.key !== 'game')) {
    for (const c of t.choices) assert.equal(starterOf(t, c.key), null, `${c.key}: no game starter`);
  }
  const make = loadTsx(`${DIR}/make.tsx`);
  assert.equal(make.starterLine('a dice race'), 'Starts from a game that already works, a dice race, and Homeroom bot builds your idea on it.');
  const src = read(`${DIR}/make.tsx`);
  // Only while the sentence is drawn as it is, like a ready-made app.
  assert.match(src, /const starter = templated && example \? starterOf\(example, choice\) : null;/);
  assert.match(src, /\{starterOf\(template, choice\) \? <p data-make-starter="" className=\{HINT\}>\{starterLine\(starterOf\(template, choice\)!\.starts\)\}<\/p> : null\}/);
});

// #4384: the make screen no longer says, under Make it, that what you write
// and the code are public on GitHub (#4174 added that line). The other
// "public on GitHub" lines (import, visibility, fork, settings) stay.
test('nothing under Make it says what you write is public on GitHub', () => {
  const make = loadTsx(`${DIR}/make.tsx`);
  assert.equal(make.MAKE_PUBLIC_LINE, undefined);
  for (const props of [
    { who: 'Jordan', onMade() {}, onLookAround() {} },
    { who: 'Jordan', entry: 'create', onMade() {}, onClose() {} },
  ]) {
    const html = renderComponent(`${DIR}/make.tsx`, 'MakeScreen', props);
    assert.ok(html.includes('>Make it</button>'), `the screen is drawn (${props.entry || 'first-session'})`);
    assert.doesNotMatch(html, /data-make-public|public on GitHub/);
  }
});

// Production run, iOS app, 5 Oct 2026: the keyboard's next chevron did not
// move from the description to the name; "Make it" looked disabled until a
// name was typed, beside a placeholder that read like a name already given;
// and with the keyboard up the screen scrolled "Start from an example" up
// behind the status bar.

test('"Make it" looks pale only while making: a press with an answer missing goes to that field and says what it needs', () => {
  const make = loadTsx(`${DIR}/make.tsx`);
  assert.equal(make.missingAnswer('', ''), 'brief');
  assert.equal(make.missingAnswer('too short', 'Page Turners'), 'brief', 'under BRIEF_MIN');
  assert.equal(make.missingAnswer('Our little book club, meeting monthly', '   '), 'name');
  assert.equal(make.missingAnswer('Our little book club, meeting monthly', 'Page Turners'), null);
  assert.equal(make.neededLine('brief', ''), 'Say what it should do first.');
  assert.equal(make.neededLine('brief', 'a club'), 'Say a little more about what it should do.');
  assert.equal(make.neededLine('name', 'Our little book club'), 'Give it a name to make it. You can change it later.');
  assert.equal(make.neededLine(null, ''), null);
  // A template's blank: their own words in it, or the rest of the game's sentence.
  assert.equal(make.neededLine('blank', 'A tier list for our favorite '), 'Fill in the blank first.');
  assert.equal(make.neededLine('blank', 'A new game we build together. ', true), 'Finish the sentence first.');
  for (const line of ['Say what it should do first.', 'Give it a name to make it. You can change it later.', 'Fill in the blank first.', 'Finish the sentence first.']) {
    assert.doesNotMatch(line, /\u2014/, 'no em dash');
  }
  const src = read(`${DIR}/make.tsx`);
  // Pale while making, or at the allowance's limit (the server would refuse
  // it), never for a missing answer.
  assert.match(src, /disabled=\{busy \|\| quotaBlocks\}/, 'never disabled for a missing answer');
  assert.doesNotMatch(src, /disabled=\{!valid/);
  // (preventScroll since 5 Oct 2026: the keyboard surface reveals the field, with Make it.)
  // The caret goes to what is missing: the name, a template's blank, or the plain box.
  assert.match(src, /const gap: Missing = templated && said\?\.blank \? 'blank' : missingAnswer\(text, name\);\s+if \(gap\) \{\s+setMissing\(gap\);\s+\(gap === 'name' \? nameRef\.current : templated \? wordsField\(\) : briefRef\.current\)\?\.focus\(\{ preventScroll: true \}\);\s+return;\s+\}/);
  assert.match(src, /\{missing === 'name'\s+\? <p id="first-session-name-hint" role="alert" className=\{NEEDED\}>\{needed\}<\/p>/);
  // The placeholder reads as an example, not as a name already given.
  assert.match(src, /placeholder="For example, Hiking Tier List"/);
  assert.doesNotMatch(src, /placeholder="Hiking Tier List"/);
  // Drawn: the button is live before anything is typed.
  const html = renderComponent(`${DIR}/make.tsx`, 'MakeScreen', { who: 'Jordan', onMade() {}, onLookAround() {} });
  const button = /<button[^>]*type="submit"[^>]*>/.exec(html)[0];
  assert.doesNotMatch(button, /\sdisabled(?:=|[\s>])/, 'no disabled attribute');
  assert.match(html, />Make it<\/button>/);
});

test('the description and the name are one sequence: Return says next and goes on, then makes it', () => {
  const src = read(`${DIR}/make.tsx`);
  const html = renderComponent(`${DIR}/make.tsx`, 'MakeScreen', { who: '', onMade() {}, onLookAround() {} });
  // In the one form, the description first and the name straight after it.
  const form = html.slice(html.indexOf('<form'), html.indexOf('</form>'));
  const fields = [...form.matchAll(/<(textarea|input)\b[^>]*>/g)].map((m) => m[0]);
  assert.equal(fields.length, 2);
  assert.match(fields[0], /^<textarea[^>]*id="first-session-brief"/);
  assert.match(fields[0], /enterKeyHint="next"/i);
  assert.match(fields[1], /^<input[^>]*id="first-session-name"/);
  assert.match(fields[1], /enterKeyHint="go"/i);
  assert.match(form, /<button[^>]*type="submit"/, 'Return in the name submits the form');
  // Return in the description moves on; Shift+Return and an IME's Return do not.
  assert.match(src, /if \(e\.key !== 'Enter' \|\| e\.shiftKey \|\| e\.nativeEvent\.isComposing\) return;\s+e\.preventDefault\(\);\s+nameRef\.current\?\.focus\(\{ preventScroll: true \}\);/);
  assert.match(src, /ref=\{nameRef\}\s+id="first-session-name"/);
});

test('with the keyboard up nothing scrolls under the status bar: the bar stays, the form scrolls under it, inside the visible band', () => {
  const src = read(`${DIR}/make.tsx`);
  const html = renderComponent(`${DIR}/make.tsx`, 'MakeScreen', { who: 'Jordan', onMade() {}, onLookAround() {} });
  const root = /<div role="dialog"[^>]*>/.exec(html)[0];
  assert.match(root, /class="platform-kb-surface fixed inset-0 z-\[9000\] flex flex-col /);
  assert.doesNotMatch(root, /overflow/, 'the screen itself does not scroll from the top of the glass');
  // The bar (with the status bar's inset) comes first, then the scroller holding the form.
  const bar = html.indexOf('pt-[env(safe-area-inset-top)]');
  const scroller = html.indexOf('data-first-session-make-scroll=""');
  assert.ok(bar > -1 && scroller > bar && html.indexOf('<form') > scroller);
  assert.match(html, /<div data-first-session-make-scroll="" class="flex min-h-0 grow flex-col overflow-y-auto">\s*<form/);
  // 5 Oct 2026 (iOS Safari): the screen is a keyboard surface, padded into
  // the band of the page that is visible while the keys are up (app.css
  // `.platform-kb-surface`), and its fields are lib/keyboard-surface.ts's: a
  // tap focuses without iOS's pan, and the focused field is revealed inside
  // the scroller with Make it under it when they fit. The scroller is what
  // the surface reveals in; the bar is above it, outside it.
  assert.match(src, /import \{ useKeyboardSurface \} from '\.\.\/\.\.\/lib\/keyboard-surface';/);
  assert.match(src, /useKeyboardSurface\(scrollerRef\);/);
  assert.doesNotMatch(src, /useComposerKeyboard/, 'one owner of the fields\' taps: the surface, not the kit\'s chat avoidance too');
  // #4597: the caret goes in from code only where the sign-in sheet would
  // put one (a desktop, or keys already up), so on a phone the screen opens
  // whole after the account step instead of under the keyboard.
  assert.match(src, /import \{ mayFocusByCodeNow \} from '\.\.\/auth\/sign-in-sheet';/);
  assert.match(src, /useEffect\(\(\) => \{ if \(mayFocusByCodeNow\(\)\) briefRef\.current\?\.focus\(\{ preventScroll: true \}\); \}, \[\]\);/);
  // The bar holds the whole mark under the status bar's inset (on a notched
  // phone the mark used to hang 12px out of a 52px box), so what scrolls
  // stops below it.
  // (`relative`: from Create, its ✕ sits at the bar's leading edge.)
  // (#4195: from Create under the platform header, the bar is only the ✕.)
  assert.match(src, /<div className=\{underHeader \? `relative h-12 shrink-0 \$\{motion\}` : `relative flex h-\[max\(52px,calc\(env\(safe-area-inset-top\)\+32px\)\)\] shrink-0 items-center justify-center pt-\[env\(safe-area-inset-top\)\] \$\{motion\}`\}>/);
  // The scroller's class string is constant.
  assert.match(src, /<div ref=\{scrollerRef\} data-first-session-make-scroll="" className="flex min-h-0 grow flex-col overflow-y-auto">/);
  // #3894's arrival is untouched: the bar and the form still rise in.
  assert.match(src, /className=\{`mx-auto flex w-full max-w-sm grow flex-col px-4 pb-\[max\(34px,env\(safe-area-inset-bottom\)\)\] \$\{motion\}`\}/);
});

// Evan, 5 Oct 2026: a chosen example stayed chosen after he started writing
// his own description over it. Since 8 Oct 2026 the starting points are
// templates: a sentence is the template's until it is written out and
// changed, and the name follows the choice until they type one.
test('a template fills in the description and the name; words of their own let go of it, and the name stays theirs', () => {
  const src = read(`${DIR}/make.tsx`);
  // The plain box's onChange marks Your own idea the moment its words are not
  // the template's written out.
  assert.match(src, /onChange=\{\(e\) => \{\s+const next = e\.target\.value;\s+setBrief\(next\);\s+(?:\/\/[^\n]*\n\s+)+if \(picked !== OWN_IDEA && next !== written\) \{\s+setPicked\(OWN_IDEA\);\s+setWritten\(null\);\s+\}/);
  // A tile is marked from `picked` alone, so it is unmarked with it.
  assert.match(src, /const on = picked === t;/);
  assert.match(src, /aria-pressed=\{on\}/);
  // Make it sends the template's description only while it is still picked.
  assert.match(src, /const example = template;/);
  assert.match(src, /\.\.\.\(example \? \{ description: descriptionOf\(example, choice\) \} : \{\}\),/);
  // The name field is not cleared by letting go of the template.
  const onChange = src.slice(src.indexOf('const next = e.target.value;'), src.indexOf('placeholder="A map of'));
  assert.doesNotMatch(onChange, /setName\(/);

  // Executed against a React it can step by hand: tap a template, change its
  // choice, write it out and type over it.
  let slots = [];
  let at = 0;
  const real = require(require.resolve('react', { paths: [path.join(ROOT, 'frontend')] }));
  const React = {
    ...real,
    useState(init) {
      const k = at++;
      if (!(k in slots)) slots[k] = typeof init === 'function' ? init() : init;
      return [slots[k], (v) => { slots[k] = typeof v === 'function' ? v(slots[k]) : v; }];
    },
    useRef(init) { const k = at++; if (!(k in slots)) slots[k] = { current: init }; return slots[k]; },
    useCallback(fn) { at++; return fn; },
    useEffect() { at++; },
    useLayoutEffect() { at++; },
    // The allowance row's store (dialogs/app-allowance.tsx, which Make it reads for its limit).
    useSyncExternalStore(subscribe, get) { at++; return get(); },
  };
  const { MakeScreen } = loadTsx(`${DIR}/make.tsx`, { stubs: { react: React } });
  const draw = () => { at = 0; return MakeScreen({ who: 'Jordan', onMade() {}, onLookAround() {} }); };
  const find = (node, test, out = []) => {
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) { node.forEach((n) => find(n, test, out)); return out; }
    if (node.props && test(node)) out.push(node);
    if (node.props) find(node.props.children, test, out);
    return out;
  };
  const tiles = (tree) => find(tree, (n) => n.props['data-first-session-example'] !== undefined);
  const pressed = (tree) => tiles(tree).filter((c) => c.props['aria-pressed']).map((c) => c.props['data-first-session-example']);
  const chips = (tree) => find(tree, (n) => n.props['data-make-choice'] !== undefined);
  const writeOut = (tree) => find(tree, (n) => n.props['data-make-write-out'] !== undefined)[0];
  const brief = (tree) => find(tree, (n) => n.props.id === 'first-session-brief')[0];
  const words = (tree) => find(tree, (n) => n.props.id === 'make-words')[0];
  const nameField = (tree) => find(tree, (n) => n.props.id === 'first-session-name')[0];
  let tree = draw();
  assert.deepEqual(tiles(tree).map((c) => c.props['data-first-session-example']), ['tier', 'game', 'organizer', 'idea'], 'four tiles, Your own idea last');
  assert.deepEqual(pressed(tree), [], 'none picked yet');
  assert.ok(brief(tree), 'it opens on the plain box');
  // One tap on the tier list: its first choice, a whole description, a name.
  tiles(tree)[0].props.onClick();
  tree = draw();
  assert.deepEqual(pressed(tree), ['tier']);
  assert.equal(brief(tree), undefined, 'the sentence stands in for the plain box');
  assert.deepEqual(chips(tree).map((c) => c.props['data-make-choice']), ['restaurants', 'hikes', 'cities', 'games', 'own']);
  assert.equal(nameField(tree).props.value, 'Restaurant Tier List');
  chips(tree)[1].props.onClick();
  tree = draw();
  assert.equal(chips(tree).find((c) => c.props.selected).props['data-make-choice'], 'hikes');
  assert.equal(nameField(tree).props.value, 'Hiking Tier List', 'the name follows the choice');
  // Your own… puts a field for their words in the blank, and names it after them.
  chips(tree)[4].props.onClick();
  tree = draw();
  assert.equal(words(tree).type, 'input');
  words(tree).props.onChange({ target: { value: 'taco spots' } });
  tree = draw();
  assert.equal(nameField(tree).props.value, 'Taco Spots Tier List');
  // A name they typed stays when the choice changes.
  nameField(tree).props.onChange({ target: { value: 'Trail Talk' } });
  tree = draw();
  chips(tree)[2].props.onClick();
  tree = draw();
  assert.equal(nameField(tree).props.value, 'Trail Talk');
  // Written out, the template is still picked until the words change.
  writeOut(tree).props.onClick();
  tree = draw();
  assert.match(brief(tree).props.value, /^A tier list for our favorite cities\. /);
  assert.deepEqual(pressed(tree), ['tier']);
  brief(tree).props.onChange({ target: { value: brief(tree).props.value } });
  tree = draw();
  assert.deepEqual(pressed(tree), ['tier'], 'the same words are not their own');
  brief(tree).props.onChange({ target: { value: `${brief(tree).props.value} And a map of them.` } });
  tree = draw();
  assert.deepEqual(pressed(tree), ['idea'], 'their own words: Your own idea');
  assert.equal(nameField(tree).props.value, 'Trail Talk', 'the name stays theirs');

  // The game starts on Your own, with a box for the rest and nothing to write out.
  slots = [];
  tree = draw();
  tiles(tree)[1].props.onClick();
  tree = draw();
  assert.deepEqual(chips(tree).map((c) => c.props['data-make-choice']), ['own', 'board', 'shooter', 'blocks', 'trivia']);
  assert.equal(chips(tree)[0].props.selected, true);
  assert.equal(words(tree).type, 'textarea');
  assert.equal(words(tree).props.placeholder, 'For example, a drawing game where one of us draws and everyone guesses');
  assert.equal(writeOut(tree), undefined);
  assert.equal(nameField(tree).props.value, '', 'their own game is theirs to name');
  chips(tree)[1].props.onClick();
  tree = draw();
  assert.equal(nameField(tree).props.value, 'Board Game Night');
  assert.equal(words(tree).props.placeholder, 'For example, we roll dice and race each other around the board');
  // Your own idea: the plain box again, and a suggested name goes with the template.
  tiles(tree)[3].props.onClick();
  tree = draw();
  assert.deepEqual(pressed(tree), ['idea']);
  assert.ok(brief(tree));
  assert.equal(nameField(tree).props.value, '');
});

test('the game\'s box reads as a field to type in, and the tiles are two by two', () => {
  const src = read(`${DIR}/make.tsx`);
  // A field, plainly: white, ringed in the accent while it is empty, with a
  // label above it. The blank's words are tinted; the box is not.
  assert.match(src, /Finish it in your own words/);
  assert.match(src, /className=\{`\$\{WORDS_BOX\} \$\{words\.trim\(\) \? WORDS_FILLED : WORDS_EMPTY\}`\}/);
  assert.match(src, /const WORDS_EMPTY = 'shadow-\[inset_0_0_0_2px_var\(--accent\),/);
  assert.match(src, /placeholder=\{`For example, \$\{boxExample\}`\}/);
  assert.match(src, /<div className="grid grid-cols-2 gap-2" role="group" aria-label="Ideas">/);
  // The choices are the shell's chip, and wrap.
  assert.match(src, /import \{ Chip \} from '@\/components\/ui\/chip';/);
  assert.match(src, /<div className="mb-1 mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Choices">/);
});

test('the make screen sends the device\'s time zone with Make it, so the sketch\'s today is the maker\'s', () => {
  const make = loadTsx(`${DIR}/make.tsx`);
  const zone = make.deviceTimeZone();
  assert.ok(zone === null || (typeof zone === 'string' && zone.length > 0));
  assert.match(read(`${DIR}/make.tsx`), /from: entry,\s+\/\/[^\n]*\n\s+\.\.\.\(timeZone \? \{ timeZone \} : \{\}\),/);
});

test('after Make it: the build line, then one invite, and the second button says where it goes', () => {
  const made = loadTsx(`${DIR}/made.tsx`);
  // #4053: the server's build line for this reader, never "Step 2 of 7".
  assert.equal(made.madeLine({ step: 2, of: 7, line: 'planning' }, true), 'planning');
  assert.equal(made.madeLine({ step: 4, of: 7, line: 'building' }, true), 'building');
  assert.equal(made.madeLine({ ready: true }, true), 'ready', 'a record without its line');
  assert.equal(made.madeLine({ step: 2, of: 7, line: 'Read the description' }, true), 'planning', 'never words it does not know');
  assert.equal(made.madeLine(null, true), 'planning', 'nothing read yet, or being set up');
  assert.equal(made.madeLine(null, true, true), 'live', 'gone once it was read as on its way: merged');
  assert.equal(made.madeLine({ line: 'building' }, false), null, 'nobody builds it: no line');
  const src = read(`${DIR}/made.tsx`);
  // The first session's second button: on to the tour (continueLabel).
  assert.equal(made.continueLabel('first-session', false, 'Page Turners'), 'Invite people later');
  assert.equal(made.continueLabel('first-session', true, 'Page Turners'), 'Start the tour');
  assert.match(src, /\{continueLabel\(entry, true, made\.name\)\}/);
  assert.match(src, /\{continueLabel\(entry, false, made\.name\)\}/);
  // The note is said to be the first message.
  assert.match(src, /body: JSON\.stringify\(\{ days: LINK_DAYS, maxUses: LINK_USES, note: note\.trim\(\) \|\| null \}\)/);
  // Every link's default, the first one's too: a link lets somebody new
  // straight in as a private member now, so a forwarded one stops on its own.
  const invitesService = require('../src/services/community-invites');
  assert.match(src, /const LINK_DAYS = 7;\s+const LINK_USES = 25;/);
  assert.deepEqual([invitesService.DEFAULT_DAYS, invitesService.DEFAULT_USES], [7, 25]);
  assert.match(src, /Anyone with the link can join for the next 7 days, up to 25 people\./);
  // Evan, 5 October 2026: the first invite is a link and nothing else. No
  // invite by username (somebody brand new knows nobody on Homeroom yet), and
  // no joining-rule line ("With one other person using it, a change goes
  // live when you both say yes, …"): both stay in the project's own invite
  // pane (features/app-context/invite-pane.tsx).
  assert.doesNotMatch(src, /joiningRule|setRule|Invite by username|\/invites`/);
  const sheet = renderToHtml(createElement(made.InviteSheet, {
    made: { slug: 'page-turners', name: 'Page Turners', emoji: '📚', description: null, example: null, conversationId: 3 },
    me: 'alex', onClose() {}, onSent() {},
  }));
  // Copy link, and Share link where the device has a share sheet (#4180,
  // tests/first-session-copy-link.test.js).
  assert.match(sheet, />Copy link</);
  assert.doesNotMatch(sheet, /username|say yes|goes live/i);
  assert.match(read('frontend/src/features/app-context/invite-pane.tsx'), /joiningRule/, 'the project\'s own pane keeps the rule');
  assert.match(src, /When you share, your note also goes in the group chat as your first message\./);
  assert.match(src, /fetch\(`\/api\/apps\/\$\{encodeURIComponent\(made\.slug\)\}\/messages`/);
  const invites = require('../src/services/community-invites');
  assert.equal(invites.LIMITS.maxDays, 30);
  assert.equal(invites.LIMITS.maxUses, 100);
});

test('the maker\'s tour ends in Homeroom bot\'s chat when it builds for them, and on the hub when not', () => {
  const { makerSteps } = loadTsx(`${DIR}/tour-steps.ts`);
  const withBot = makerSteps({ slug: 'film', name: 'Friday Film Crew', conversationId: 12 });
  assert.deepEqual(withBot.map((s) => s.screen), ['home', 'app', 'app', 'app', 'app', 'home', 'hub', 'hub', 'bot']);
  assert.equal(withBot[7].target, '#platform-tab-messages');
  assert.equal(withBot[7].opensNext, true);
  assert.equal(withBot[8].last, true);
  const without = makerSteps({ slug: 'film', name: 'Friday Film Crew', conversationId: null });
  assert.deepEqual(without.map((s) => s.screen), ['home', 'app', 'app', 'app', 'app', 'home', 'hub']);
  assert.equal(without[6].last, true);
  const index = read(`${DIR}/index.tsx`);
  assert.match(index, /else if \(screen === 'bot' && conversationId\) window\.location\.hash = `#messages\/\$\{conversationId\}`;/);
});

// 5 October 2026 (Evan, on his phone): 7 of 7 cut the bot's messages out of
// the dim and left the conversation's header ("Homeroom bot AI · <Project>
// needs you", the clock and ⋯) under it, and the newest card began part-way
// down, with bullets and no "Here's my plan for …". He read it as the chat
// missing its header.
test('the maker\'s last step shows the chat with Homeroom bot whole: its header with its messages, the plan\'s buttons clear of the card', () => {
  const { makerSteps, BOT_CHAT_HEADER, BOT_CHAT_MESSAGES } = loadTsx(`${DIR}/tour-steps.ts`);
  const steps = makerSteps({ slug: 'film', name: 'Friday Film Crew', conversationId: 12 });
  const chat = steps[8];
  assert.equal(chat.title, 'Homeroom bot is working on Friday Film Crew');
  assert.equal(BOT_CHAT_HEADER, '.messages-thread-direct > .messages-thread-header');
  assert.equal(BOT_CHAT_MESSAGES, '.messages-thread-direct > .messages-thread-scroll');
  // One cut-out round both (index.tsx targetBox draws a selector list as one box).
  assert.deepEqual(chat.target.split(',').map((s) => s.trim()), [BOT_CHAT_HEADER, BOT_CHAT_MESSAGES]);
  // The owner's planned-vs-built review, 6 October 2026: at the foot of the
  // screen the card covered the Build it it names. It sits under the chat's
  // header, and (7 October) the newest card begins just under it, so the
  // plan's title and first lines are never under the card.
  assert.deepEqual(chat.newestBelowCard, { scroller: BOT_CHAT_MESSAGES, rows: 'article.messages-message' });
  assert.deepEqual(chat.place, { below: BOT_CHAT_HEADER });
  assert.equal(chat.text, 'It\'ll let you know here when there\'s something to look at.');
  // And the platform's top bar over them, as one cut-out (Evan, 5 Oct 2026:
  // "include the header on step 7 also").
  assert.equal(chat.alongside, '#platform-header');
  assert.equal(chat.endsAbove, undefined, 'the transcript ends at the composer, above the tab bar');
  // The other steps' targets (the app screen whole, then the menu and ✕ on
  // it: tests/first-session.test.js), and only this one moves a transcript.
  assert.deepEqual(steps.slice(0, 8).map((s) => s.target), [
    '.app-card[data-slug="film"]', '#app-view', '#platform-mark-btn', '#improve-row-feedback', '#back-btn', '#platform-tab-workshop', '#app-content', '#platform-tab-messages',
  ]);
  assert.ok(steps.every((s) => !s.press), 'no cut-out rings a control inside a wider one');
  assert.deepEqual(steps.map((s) => !!s.newestBelowCard), [false, false, false, false, false, false, false, false, true]);
  // The Messages screen draws what it names: a direct conversation's section,
  // whose first child is its header (none when embedded in a hub, which the
  // bot's chat never is), its scroller, and an <article> per message.
  const messages = read('frontend/src/features/messages/index.tsx');
  assert.match(messages, /const kind = snap\.active\?\.kind \|\| 'direct';/);
  assert.match(messages, /<section className=\{`flex messages-thread-pane platform-kb-column dc-lift dc-lift-session messages-thread-\$\{kind\}[^`]*`\}[^>]*>\s*\{embedded \? null : <ThreadHeader \/>\}/);
  assert.match(messages, /function ThreadHeader\(\) \{[\s\S]*?return \(\s*<header className="messages-thread-header">/);
  assert.match(messages, /<div ref=\{scroller\} className="messages-thread-scroll platform-safe-scroll" aria-live="polite">/);
  assert.match(read('frontend/src/features/messages/message-row.tsx'),
    /<article id=\{`messages-message-\$\{message\.id\}`\} data-message-id=\{message\.id\} className=\{`messages-message group /);
});

test('the newest card begins just under the coach card: its title and first lines are never under it', () => {
  const { scrollToBelow, showNewestBelow } = loadTsx(`${DIR}/index.tsx`);
  assert.equal(scrollToBelow(300, 400), 92, 'below the card: on, until it begins 8px under it');
  assert.equal(scrollToBelow(300, 150), -158, 'under the card: back');
  assert.equal(scrollToBelow(300, 308), 0);
  assert.equal(scrollToBelow(300, 308.4), 0, 'whole pixels');

  const box = (top, height = 40) => ({ getBoundingClientRect: () => ({ top, height }) });
  const transcript = ({ top = 120, height = 500, scrollTop = 900, rows = [] } = {}) => {
    const el = { scrollTop, ...box(top, height), querySelectorAll: (sel) => { el.asked = sel; return rows; } };
    return el;
  };
  const rootOf = (...scrollers) => ({ querySelectorAll: (sel) => { rootOf.asked = sel; return scrollers; } });
  const spec = { scroller: '.messages-thread-direct > .messages-thread-scroll', rows: 'article.messages-message' };

  // The chat opened at its foot: the plan card, newest, begins at 150, under
  // the coach card (its foot at 290): it goes back 148px, to begin at 298.
  const hidden = transcript({ height: 0, rows: [box(400)] });
  const shown = transcript({ rows: [box(60), box(150, 330)] });
  assert.equal(showNewestBelow(spec, 290, rootOf(hidden, shown)), true);
  assert.equal(rootOf.asked, spec.scroller);
  assert.equal(shown.asked, spec.rows);
  assert.equal(shown.scrollTop, 900 - 148, 'the visible transcript, not one drawn nowhere');
  assert.equal(hidden.scrollTop, 900);
  // Already in place, nothing loaded yet, or no transcript at all: nothing moves.
  const placed = transcript({ rows: [box(298, 100)] });
  assert.equal(showNewestBelow(spec, 290, rootOf(placed)), false);
  assert.equal(placed.scrollTop, 900);
  assert.equal(showNewestBelow(spec, 290, rootOf(transcript())), false);
  assert.equal(showNewestBelow(spec, 290, rootOf()), false);

  // Each frame, under the card as it is drawn, before the cut-out is
  // measured, and it holds when the rows arrive after the step lands.
  const src = read(`${DIR}/index.tsx`);
  assert.match(src, /const reveal = stepRef\.current\.newestBelowCard;\s+const card = reveal \? document\.querySelector\(CARD_SELECTOR\)\?\.getBoundingClientRect\(\) : null;\s+if \(reveal && card && card\.height\) showNewestBelow\(reveal, card\.bottom\);\s+const m = measure\(at, stepRef\.current\);/);
  assert.match(src, /const CARD_SELECTOR = '\[role="dialog"\]\[aria-labelledby="first-session-tour-title"\]';/);
  assert.match(src, /role="dialog"\s+aria-labelledby="first-session-tour-title"/);
});

test('the admin Journey page says which first session answered the join screen', () => {
  assert.match(read('src/services/journey.js'),
    /note: seen\.join_answer \? `not asked: \$\{seen\.join_answer\}` : 'not asked', weak: true/);
});

// #4040: what somebody answered on the waitlist opens the make screen on
// Your own idea with that answer in the box. Evan's screen is otherwise
// untouched.

test('a waitlist answer opens the make screen on Your own idea, filled in, with one quiet line under the box', () => {
  const make = loadTsx(`${DIR}/make.tsx`);
  assert.equal(make.WAITLIST_IDEA_LINE, 'Filled in from your waitlist answer.');
  const idea = 'A tracker for my run club, so we can see who keeps up';
  const base = { who: 'Jordan', onMade() {}, onLookAround() {} };
  const html = renderComponent(`${DIR}/make.tsx`, 'MakeScreen', { ...base, idea });
  // Your own idea is the picked tile, and no template is.
  assert.match(html, /<button[^>]*aria-pressed="true"[^>]*data-first-session-example="idea"/);
  assert.equal((html.match(/aria-pressed="true"/g) || []).length, 1);
  // The plain box holds the answer.
  assert.match(html, new RegExp(`<textarea[^>]*id="first-session-brief"[^>]*>${idea}</textarea>`));
  // One quiet line directly under it: small, muted (the screen's HINT).
  const line = /<p data-make-waitlist-idea="" class="([^"]*)">([^<]*)<\/p>/.exec(html);
  assert.ok(line, 'the line is drawn');
  assert.equal(line[2], make.WAITLIST_IDEA_LINE);
  assert.match(line[1], /\btext-xs\b/);
  assert.match(line[1], /\btext-zinc-500\b/);
  assert.doesNotMatch(line[1], /red-|amber-|font-(semi)?bold/);
  assert.ok(html.indexOf('data-make-waitlist-idea') > html.indexOf('</textarea>'));
  assert.ok(html.indexOf('data-make-waitlist-idea') < html.indexOf('first-session-name'), 'before the name field');

  // Without one (none, null, blank, or from Create's door) it is Evan's screen.
  const plain = renderComponent(`${DIR}/make.tsx`, 'MakeScreen', base);
  for (const props of [{ ...base, idea: null }, { ...base, idea: '   ' }]) {
    assert.equal(renderComponent(`${DIR}/make.tsx`, 'MakeScreen', props), plain);
  }
  assert.doesNotMatch(plain, /aria-pressed="true"/);
  assert.doesNotMatch(plain, /data-make-waitlist-idea|waitlist answer/);
  assert.match(plain, /<textarea[^>]*id="first-session-brief"[^>]*><\/textarea>/);

  // A filled description reaches Make it as a typed one does: the plain box is
  // the description (`text`), and with a name nothing is missing.
  assert.equal(make.missingAnswer(idea, 'Run Club'), null);
  assert.equal(make.missingAnswer(idea, ''), 'name');
  assert.match(read(`${DIR}/make.tsx`), /const text = templated && said \? said\.text : brief;/);
});

test('the line goes once the words are changed, and a template can still be picked', () => {
  const idea = 'A tracker for my run club, so we can see who keeps up';
  let slots = [];
  let at = 0;
  const real = require(require.resolve('react', { paths: [path.join(ROOT, 'frontend')] }));
  const React = {
    ...real,
    useState(init) {
      const k = at++;
      if (!(k in slots)) slots[k] = typeof init === 'function' ? init() : init;
      return [slots[k], (v) => { slots[k] = typeof v === 'function' ? v(slots[k]) : v; }];
    },
    useRef(init) { const k = at++; if (!(k in slots)) slots[k] = { current: init }; return slots[k]; },
    useCallback(fn) { at++; return fn; },
    useEffect() { at++; },
    useLayoutEffect() { at++; },
    useSyncExternalStore(subscribe, get) { at++; return get(); },
  };
  const { MakeScreen } = loadTsx(`${DIR}/make.tsx`, { stubs: { react: React } });
  const draw = () => { at = 0; return MakeScreen({ who: 'Jordan', onMade() {}, onLookAround() {}, idea }); };
  const find = (node, test, out = []) => {
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) { node.forEach((n) => find(n, test, out)); return out; }
    if (test(node)) out.push(node);
    find(node.props && node.props.children, test, out);
    return out;
  };
  const line = () => find(draw(), (n) => n.props && 'data-make-waitlist-idea' in n.props);
  const box = () => find(draw(), (n) => n.type === 'textarea' && n.props.id === 'first-session-brief')[0];
  assert.equal(line().length, 1);
  assert.equal(box().props.value, idea);
  // Typing over it: the line has nothing to say any more, and it stays Your own idea.
  box().props.onChange({ target: { value: `${idea} and a leaderboard` } });
  assert.equal(line().length, 0);
  assert.equal(box().props.value, `${idea} and a leaderboard`);
  // Clearing it is allowed.
  box().props.onChange({ target: { value: '' } });
  assert.equal(box().props.value, '');
  assert.equal(line().length, 0);
  // A template still picks as it does: one tap, a whole description.
  const tile = find(draw(), (n) => n.type === 'button' && n.props['data-first-session-example'] && n.props['data-first-session-example'] !== 'idea')[0];
  tile.props.onClick();
  assert.equal(find(draw(), (n) => n.props && n.props['data-make-sentence']).length, 1);
  assert.equal(line().length, 0);
});

test('the make screen takes the idea from the signed-in user, or from a ?shot= state, and the Create door never does', () => {
  const src = read(`${DIR}/index.tsx`);
  assert.match(src, /idea=\{shot \? shot\.idea : legacy\(\)\.App\?\.user\?\.waitlistIdea \?\? null\}/);
  const create = src.slice(src.indexOf("if (mode.kind === 'make' && mode.entry === 'create')"), src.indexOf("if (mode.kind === 'make') {"));
  assert.match(create, /who=\{viewerName\(\)\}/);
  assert.doesNotMatch(create, /idea=/);
  const island = loadTsx(`${DIR}/index.tsx`);
  assert.deepEqual(Object.keys(island.MAKE_SHOTS), ['make', 'make-waitlist']);
  assert.equal(island.makeShot('?shot=make').idea, null);
  assert.match(island.makeShot('?shot=make-waitlist').idea, /run club/);
  assert.equal(island.makeShot('?shot=first-version'), null);
  assert.equal(island.makeShot('?shot=toString'), null);
  assert.equal(island.makeShot(''), null);
});

test('the waitlist answer is read for the account\'s linked row only, and /me sends it only while the question is owed', async () => {
  const pool = fakePool([[{ idea: 'A map of our swimming spots' }], [{ idea: null }], [], new Error('no table')]);
  assert.equal(await firstSession.waitlistIdea(pool, 7), 'A map of our swimming spots');
  assert.match(pool.calls[0].sql, /answers->'group'->>'need'/);
  assert.match(pool.calls[0].sql, /WHERE linked_user_id = \$1/);
  assert.deepEqual(pool.calls[0].params, [7]);
  assert.equal(await firstSession.waitlistIdea(pool, 7), null, 'an empty answer');
  assert.equal(await firstSession.waitlistIdea(pool, 7), null, 'no linked row');
  assert.equal(await firstSession.waitlistIdea(pool, 7), null, 'a failed read never throws');
  assert.match(read('src/routes/auth.js'), /if \(storyFirstSession\) waitlistIdea = await firstSession\.waitlistIdea\(pool, req\.user\.id\);/);
  assert.match(read('src/routes/auth.js'), /storyFirstSession,\s+\/\/[^\n]*\n\s+\/\/[^\n]*\n\s+waitlistIdea,/);
});
