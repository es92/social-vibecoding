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
const { message } = require('./lib/platform-i18n');

// A test that steps MakeScreen by hand, against a React whose hooks it counts,
// gives the component its English this way: the real hook (useMessages) reads
// React's context, which only a renderer provides.
const ENGLISH_HOOK = { useMessages: () => message, RichMessage: () => null, Message: () => null };

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

test('making something, or looking around, answers the join screen; starting answers nothing', async () => {
  const pool = fakePool([[], [], [{ id: 1 }], []]);
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
  // Sign-up test, 19 Oct 2026: and the newcomer is owed Homeroom bot's hello,
  // the tour's, to their DM machine (the walk on Home points at it).
  assert.match(pool.calls[2].sql, /INSERT INTO wf_events \(machine, key, app_id, type, payload, source, actor, request_key, caused_by\)/);
  assert.deepEqual(pool.calls[2].params.slice(0, 5), ['bot-dm', 'person:9', null, 'Greet', JSON.stringify({ userId: 9, kind: 'tour', appId: null })]);
  // Being shown the question is recorded once, and leaves it owed.
  await firstSession.recordStart(pool, 7, 'story');
  assert.doesNotMatch(pool.calls[3].sql, /needs_communities_choice = FALSE/);
  assert.match(pool.calls[3].sql, /WHERE id = \$1 AND needs_communities_choice = TRUE\s+AND getting_started_seen->>'first_session' IS NULL/);
  assert.deepEqual(pool.calls[3].params, [7, 'story']);
  // Make it is answered from POST /api/apps, which says whether making the
  // project greets them already (below).
  assert.match(read('src/routes/apps.js'), /if \(req\.body\.from === 'first-session'\) \{\s+await require\('\.\.\/services\/first-session'\)\.answerJoinScreenByMaking\(pool, req\.user\.id, \{ greet: !readyMade && !homeroomBot \}\)/);
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
  assert.match(landing, /useState\(\s+\(\) => typeof location !== 'undefined' && onInviteLink\(location\.pathname\),\s+\);/);
  assert.match(landing, /const pitchHidden = madeForYou \|\| deadInvite \|\| storyOn \|\| invitePending;/);
  // Polish N10: the email line's "Sign in" opens the same sheet titled Sign in.
  // The story heads the guest Discover now, in its short version
  // (features/guest, tests/guest-discover.test.js), with the same two ways in.
  assert.match(landing, /<Story\s+compact\s+primaryClass=\{PRIMARY_PILL\}\s+welcomeEmail=\{releaseEmail\}\s+onStart=\{\(\) => setSheet\('start'\)\}\s+onSignIn=\{\(\) => setSheet\('signin'\)\}\s+actions=\{<SignUpButtons /);
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
// rows are pinned by the templates test below), then one "Continue" (#5251,
// the navigation review: no separate Sign in, the email decides) and the line
// under it; the waves pill that followed is gone (#5376, Evan, 17 Oct 2026).
test('the story: label, headline, "For example" and the three examples, then one Continue and the email line', () => {
  const html = renderComponent('frontend/src/features/auth/story.tsx', 'Story', { primaryClass: 'pill', onStart() {} });
  // Each row: its emoji (the tier list draws a chart, no text), title and line.
  const TEMPLATE_ROWS = loadTsx(`${DIR}/examples.ts`).FRONT.flatMap((t) => (t.chart ? [message(t.title), message(t.line)] : [t.emoji, message(t.title), message(t.line)]));
  const text = html.replace(/<[^>]+>/g, '\n').split('\n').map((t) => t.trim()).filter(Boolean)
    .map((t) => t.replace(/&#x27;/g, "'"));
  assert.deepEqual(text, [
    'Welcome to Homeroom',
    'On Homeroom, communities make apps together.',
    'For example',
    ...TEMPLATE_ROWS,
    message('auth:story.continue'),
    'Sign in',
    'or join with your email.',
  ]);
  assert.match(html, /<a href="#signup" data-landing-story-start="" class="pill">Continue<\/a>/);
  // Polish N10: the line is still one sentence, and its "Sign in" is a link.
  assert.match(html, /<p data-landing-story-how=""[^>]*><a href="#login" data-landing-story-signin="" class="[^"]*">Sign in<\/a> or join with your email\.<\/p><\/div>/);
  assert.doesNotMatch(html, /Already have an account|Get started|data-landing-story-waves|in waves/);
  // In a phone browser too, the story fills the screen and its foot is at the foot.
  const css = read('public/css/app.css');
  // Polish N10: one level-1 heading. The covered platform header leaves the
  // accessibility tree while the landing shows (its own bar is not an h1).
  assert.match(css, /body:has\(#auth-landing-screen:not\(\.hidden\)\) #platform-header \{\s*visibility: hidden;\s*\}/);
  assert.match(css, /html\[data-browser-scroller="auth-landing-scroll"\] #auth-landing-scroll:has\(> \* > \[data-landing-story\]\) \{\s+flex: 1 0 auto;\s+display: flex;\s+flex-direction: column;\s+\}/);
  assert.match(css, /html\[data-browser-scroller="auth-landing-scroll"\] #auth-landing-scroll > :has\(> \[data-landing-story\]\) \{\s+flex: 1 0 auto;\s+width: 100%;\s+\}/);
  for (const gone of [/Make an account/, /spot on the waitlist/, /Anyone using an app/, /What groups make/, /What communities make/]) {
    assert.doesNotMatch(html, gone);
  }
});

// Evan, 8 Oct 2026: the three examples became sentences to finish, each a
// whole description in a tap or two with the part that makes it theirs left
// to them. Evan, 15 Oct 2026: the front three are a tier list, a game and
// an organizer, the same on the story and the make screen; a poll, find a
// time, a sign-up sheet and a group challenge are behind "Something else…".
test('the front three on the story and the make screen, the rest behind Something else, each a whole starting point', () => {
  const { TEMPLATES, FRONT, FRONT_KEYS, MORE, OWN, sentence, suggestedName, firstChoice, descriptionOf } = loadTsx(`${DIR}/examples.ts`);
  assert.deepEqual(TEMPLATES.map((t) => t.key), ['tier', 'poll', 'game', 'organizer', 'findtime', 'signup', 'challenge']);
  assert.deepEqual([...FRONT_KEYS], ['tier', 'game', 'organizer'], 'one list of the front three, for a test of what shows first');
  assert.deepEqual(FRONT.map((t) => t.key), ['tier', 'game', 'organizer']);
  assert.deepEqual(MORE.map((t) => t.key), ['poll', 'findtime', 'signup', 'challenge'], 'the rest, in the catalog\'s order');
  for (const t of TEMPLATES) {
    // What a person reads is a message id (frontend/locales/en/onboarding.json);
    // the sentence's head is the catalog's, up to its blank.
    for (const k of ['title', 'line', 'short', 'note']) assert.ok(message(t[k]), `${t.key}.${k}`);
    assert.ok(t.emoji, `${t.key}.emoji`);
    assert.ok(sentence(t, OWN, '').head, `${t.key}.head`);
    assert.ok(message(t.note).length <= 280, `${t.key} note fits a link's note`);
    for (const c of t.choices) {
      const s = sentence(t, c.key, t.finish ? 'we roll dice and race each other around the board' : '');
      assert.ok(!s.blank && s.text.length >= 10, `${t.key}/${c.key} is a whole description`);
      assert.ok(message(c.name), `${t.key}/${c.key} suggests a name`);
      assert.ok(descriptionOf(t, c.key).length <= 90, `${t.key}/${c.key} description fits DESCRIPTION_MAX`);
    }
    const words = [t.title, t.line, t.short, t.note, t.own.sentence, t.own.example, t.own.description,
      ...t.choices.flatMap((c) => [c.label, c.sentence, c.name, c.description, ...(c.example ? [c.example] : [])])]
      .map((id) => message(id, { words: '' }));
    assert.doesNotMatch(JSON.stringify(words), /—/, `${t.key}: no em dash`);
  }
  // The tier list: one tap is a whole description.
  const [tier, poll, game, organizer, findtime, signup, challenge] = TEMPLATES;
  assert.equal(firstChoice(tier), 'restaurants');
  assert.equal(sentence(tier, 'hikes', '').text, 'A tier list for our favorite hikes. Anyone can add items, everyone sorts them, and we can see where they land.');
  assert.deepEqual(tier.choices.map((c) => message(c.name)), ['Restaurant Tier List', 'Hiking Tier List', 'City Tier List', 'Game Tier List']);
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
  assert.deepEqual(organizer.choices.map((c) => [message(c.label), message(c.name)]), [['Groceries', 'Grocery List'], ['Chores', 'Chore List'], ['Shared library', 'Lending Library'], ['Study timer', 'Study Timer']],
    'its potluck moved to the sign-up sheet');
  // (What the ready-made chore list does: it sends no nudge.)
  assert.equal(sentence(organizer, 'chores', '').text, 'An app to organize our chores: who\'s on what this week, and whose turn it is next.');
  assert.equal(sentence(organizer, 'library', '').text, 'An app to organize our shared library: what we can borrow, who has it now, and who\'s asking for it next.');
  assert.equal(suggestedName(organizer, OWN, 'camping gear'), 'Camping Gear List');
  // Poll the group: where to eat, what to spend on, movie night.
  assert.equal(message(poll.short), 'Poll the group');
  assert.equal(firstChoice(poll), 'dinner');
  assert.equal(sentence(poll, 'dinner', '').text, 'An app for us to decide where to eat: anyone can suggest options, everyone votes, and we see what wins.');
  assert.deepEqual(poll.choices.map((c) => [message(c.label), message(c.name)]), [['Where to eat', 'Dinner Decider'], ['What to spend on', 'Spending Poll'], ['Movie night', 'Movie Night Poll']]);
  assert.equal(suggestedName(poll, OWN, 'where to go'), '', 'their own question is theirs to name');
  // Find a time, a sign-up sheet (the potluck is here now) and a challenge.
  assert.equal(sentence(findtime, 'bookclub', '').text, 'An app to find a time for our book club to meet: everyone marks when they\'re free, and we see what works.');
  assert.deepEqual(findtime.choices.map((c) => message(c.label)), ['Book club', 'Game night', 'Trip']);
  assert.deepEqual(signup.choices.map((c) => [message(c.label), message(c.name)]), [['Potluck', 'Potluck Planner'], ['Volunteer shifts', 'Volunteer Sign-ups'], ['Who\'s coming', 'Who\'s Coming']]);
  assert.equal(sentence(challenge, 'miles', '').text, 'A challenge for our group: who logs the most miles this month, with a leaderboard.');
  assert.deepEqual(challenge.choices.map((c) => message(c.label)), ['Miles', 'Steps', 'Books']);
  assert.equal(suggestedName(challenge, OWN, 'push-ups'), 'Push-ups Challenge');
  // The story says the front three, the tier list drawn as a tier list, and
  // nothing from behind Something else.
  const story = renderComponent('frontend/src/features/auth/story.tsx', 'Story', { primaryClass: 'pill', onStart() {} });
  for (const t of FRONT) assert.ok(story.includes(`>${message(t.title)}<`) && story.includes(`>${message(t.line)}<`), t.key);
  for (const t of MORE) assert.ok(!story.includes(`>${message(t.title)}<`), `${t.key} is not on the story`);
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
  for (const [id, words] of [
    ['onboarding:firstSession.make.title', 'What do you want to make?'],
    ['onboarding:firstSession.make.titleHello', 'Hi {{name}}, what do you want to make?'],
    ['onboarding:firstSession.make.briefLabel', 'What should it do?'],
    ['onboarding:firstSession.make.nameLabel', 'What should we call it?'],
    ['onboarding:firstSession.make.lookAround', 'Not sure yet? <0>Look around first</0>'],
  ]) {
    assert.ok(make.includes(`'${id}'`) || make.includes(`"${id}"`), words);
    assert.equal(message(id), words);
  }
});

// Evan, 8 Oct 2026: every choice that needs no typing makes one of
// Homeroom's ready-made apps (services/app-templates.js), so there is no
// first version to wait for. Your own words, and every game, still go to
// Homeroom bot.
test('a choice that needs no typing makes a ready-made app, with nothing for Homeroom bot to build', () => {
  const { TEMPLATES, OWN, readyMadeOf } = loadTsx(`${DIR}/examples.ts`);
  const appTemplates = require('../src/services/app-templates');
  const game = TEMPLATES.find((t) => t.key === 'game');
  const ready = TEMPLATES.filter((t) => t !== game);
  const made = ready.flatMap((t) => t.choices).map((c) => c.template);
  assert.deepEqual(made, appTemplates.READY_IDS, 'every no-typing choice, and only those, is a ready-made app');
  for (const c of game.choices) assert.equal(readyMadeOf(game, c.key), null, `${c.key}: a game is always built`);
  for (const t of ready) assert.equal(readyMadeOf(t, OWN), null, `${t.key}: their own words are built`);
  assert.deepEqual(readyMadeOf(TEMPLATES[0], 'hikes'), { template: 'tier-list-hikes', emoji: '📊' });
  assert.deepEqual(readyMadeOf(TEMPLATES.find((t) => t.key === 'signup'), 'potluck'), { template: 'potluck-planner', emoji: '🍲' }, 'a potluck is still the potluck planner');
  // Its icon is the ready-made app's own, so the made screen and the tile agree.
  for (const t of ready) {
    for (const c of t.choices) assert.equal(readyMadeOf(t, c.key).emoji, appTemplates.get(c.template).icon, c.key);
  }

  const src = read(`${DIR}/make.tsx`);
  // Only while the sentence is drawn as it is: written out, it is theirs to build.
  assert.match(src, /const ready = templated && example \? readyMadeOf\(example, choice\) : null;/);
  assert.match(src, /emoji: ready \? ready\.emoji : example \? example\.emoji : null,/);
  assert.match(src, /\.\.\.\(ready \? \{ readyMade: true \} : \{\}\),/);
  // Nothing under its choices says so (Evan, 10 Oct 2026): the line read as
  // fine print on a screen that is about the idea. Since 15 Oct one line
  // above Who can change it says Instant or Custom (pinned at the end).
  const make = loadTsx(`${DIR}/make.tsx`);
  assert.equal(make.READY_LINE, undefined);
  assert.doesNotMatch(src, /data-make-ready|Ready-made:|firstSession\.make\.readyMade/);
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
  }
  assert.equal(starterOf(game, OWN), null, 'their own game idea starts from the empty scaffold');
  for (const t of TEMPLATES.filter((x) => x.key !== 'game')) {
    for (const c of t.choices) assert.equal(starterOf(t, c.key), null, `${c.key}: no game starter`);
  }
  const make = loadTsx(`${DIR}/make.tsx`);
  const src = read(`${DIR}/make.tsx`);
  // Only while the sentence is drawn as it is, like a ready-made app.
  assert.match(src, /const starter = templated && example \? starterOf\(example, choice\) : null;/);
  // And, like it, nothing under the choices says so (Evan, 10 Oct 2026).
  assert.equal(make.starterLine, undefined);
  assert.doesNotMatch(src, /data-make-starter|Starts from a game|starterLine/);
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

test('"Make it" waits while making or dictating: a press with an answer missing goes to that field and says what it needs', () => {
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
  // Pale while making, dictating, or at the allowance's limit (the server would refuse
  // it), never for a missing answer.
  assert.match(src, /disabled=\{dictating \|\| busy \|\| quotaBlocks\}/, 'never disabled for a missing answer');
  assert.doesNotMatch(src, /disabled=\{!valid/);
  // (preventScroll since 5 Oct 2026: the keyboard surface reveals the field, with Make it.)
  // The caret goes to what is missing: the name, a template's blank, or the plain box.
  assert.match(src, /const gap: Missing = templated && said\?\.blank \? 'blank' : missingAnswer\(text, name\);\s+if \(gap\) \{\s+setMissing\(gap\);\s+\(gap === 'name' \? nameRef\.current : templated \? wordsField\(\) : briefRef\.current\)\?\.focus\(\{ preventScroll: true \}\);\s+return;\s+\}/);
  assert.match(src, /\{missing === 'name' \? <p id="first-session-name-hint" role="alert" className=\{NEEDED\}>\{needed\}<\/p> : null\}/);
  // No standing hint under the name (Evan, 10 Oct 2026): "What should we
  // call it?" says it. The line only appears when a name is missing, and
  // the field points at it only then.
  assert.match(src, /aria-describedby=\{missing === 'name' \? 'first-session-name-hint' : undefined\}/);
  for (const file of ['make.tsx', 'import-repo.tsx']) {
    assert.doesNotMatch(read(`${DIR}/${file}`), /group's name too/, file);
  }
  assert.match(read(`${DIR}/import-repo.tsx`), /aria-describedby=\{missing === 'name' \? 'make-import-name-hint' : undefined\}/);
  // The placeholder reads as an example, not as a name already given.
  // An example of the picked idea's kind (Evan, 10 Oct 2026: a game, and
  // an idea of their own, were offered "Hiking Tier List").
  assert.match(src, /placeholder=\{t\(template \? template\.namePlaceholder : 'onboarding:firstSession\.make\.namePlaceholderOwn'\)\}/);
  const { TEMPLATES } = loadTsx(`${DIR}/examples.ts`);
  const placeholderOf = (key) => message(TEMPLATES.find((x) => x.key === key).namePlaceholder);
  assert.equal(placeholderOf('tier'), 'For example, Hiking Tier List');
  assert.equal(placeholderOf('game'), 'For example, My Game');
  assert.equal(placeholderOf('organizer'), 'For example, Camping Gear List');
  assert.equal(message('onboarding:firstSession.make.namePlaceholderOwn'), 'For example, My New App');
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
  assert.match(src, /import \{ revealScrollTop, useKeyboardSurface \} from '\.\.\/\.\.\/lib\/keyboard-surface';/);
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
  assert.match(src, /className=\{`mx-auto flex w-full max-w-sm grow flex-col px-4 pb-\[max\(34px,env\(safe-area-inset-bottom\)\)\] md:max-w-xl \$\{motion\}`\}/);
});

// Evan, 5 Oct 2026: a chosen example stayed chosen after he started writing
// his own description over it. Since 8 Oct 2026 the starting points are
// templates: a sentence is the template's until it is written out and
// changed, and the name follows the choice until they type one.
test('a template fills in the description and the name; words of their own let go of it, and the name stays theirs', (t) => {
  const src = read(`${DIR}/make.tsx`);
  // The plain box's onChange marks Your own idea the moment its words are not
  // the template's written out.
  assert.match(src, /onChange=\{\(e\) => \{\s+const next = e\.target\.value;\s+setBrief\(next\);\s+(?:\/\/[^\n]*\n\s+)+if \(picked !== OWN_IDEA && next !== written\) \{\s+setPicked\(OWN_IDEA\);\s+setWritten\(null\);\s+\}/);
  // A tile is marked from `picked` alone, so it is unmarked with it.
  assert.match(src, /const on = picked === example;/);
  assert.match(src, /aria-pressed=\{on\}/);
  // Make it sends the template's description only while it is still picked:
  // a ready-made app's as its description, a game's or Your own words' as
  // the card's fallback tagline (the model writes the description from what
  // they typed; tests/app-sketch.test.js).
  assert.match(src, /const example = template;/);
  assert.match(src, /\.\.\.\(example \? \{ \[ready \? 'description' : 'taglineFallback'\]: descriptionOf\(example, choice\) \} : \{\}\),/);
  // The name field is not cleared by letting go of the template.
  const onChange = src.slice(src.indexOf('const next = e.target.value;'), src.indexOf("placeholder={t('onboarding:firstSession.make.briefPlaceholder')}"));
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
  // The sheet goes on <body> through a portal: drawn in place here, so its
  // element is in the tree to find (its rows are found by drawing it).
  const { MakeScreen } = loadTsx(`${DIR}/make.tsx`, { stubs: { react: React, 'react-dom': { createPortal: (el) => el }, '../../lib/i18n/react': ENGLISH_HOOK } });
  const hadDocument = 'document' in globalThis;
  if (!hadDocument) globalThis.document = { body: {} };
  t.after(() => { if (!hadDocument) delete globalThis.document; });
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
  // "Something else…" (./more-sheet.tsx): the sheet, and its rows as it draws them.
  const sheet = (tree) => find(tree, (n) => n.props.onPickIdea !== undefined)[0];
  const sheetRows = (tree) => { const s = sheet(tree); return find(s.type(s.props), (n) => n.props['data-make-more'] !== undefined); };
  let tree = draw();
  assert.deepEqual(tiles(tree).map((c) => c.props['data-first-session-example']), ['tier', 'game', 'organizer', 'more'], 'the front three, then Something else');
  assert.deepEqual(pressed(tree), [], 'none picked yet');
  assert.equal(sheet(tree), undefined, 'the sheet is shut');
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
  assert.deepEqual(pressed(tree), ['idea'], 'their own words: Your own idea, which takes the fourth tile');
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
  // Your own idea, from Something else: the plain box again, and a suggested
  // name goes with the template.
  tiles(tree)[3].props.onClick();
  tree = draw();
  assert.ok(sheet(tree), 'the fourth tile opens the sheet');
  assert.deepEqual(sheetRows(tree).map((r) => r.props['data-make-more']), ['idea', 'poll', 'findtime', 'signup', 'challenge'], 'Your own idea first, then the rest');
  sheet(tree).props.onPickIdea();
  tree = draw();
  assert.equal(sheet(tree), undefined, 'a pick shuts it');
  assert.deepEqual(pressed(tree), ['idea']);
  assert.ok(brief(tree));
  assert.equal(nameField(tree).props.value, '');
  // A starting point from the sheet takes the fourth tile over, and the
  // tile opens the sheet again.
  tiles(tree)[3].props.onClick();
  tree = draw();
  sheetRows(tree).find((r) => r.props['data-make-more'] === 'signup').props.onClick();
  tree = draw();
  assert.equal(sheet(tree), undefined);
  assert.deepEqual(tiles(tree).map((c) => c.props['data-first-session-example']), ['tier', 'game', 'organizer', 'signup']);
  assert.deepEqual(pressed(tree), ['signup']);
  assert.deepEqual(chips(tree).map((c) => c.props['data-make-choice']), ['potluck', 'shifts', 'rsvp', 'own']);
  assert.equal(nameField(tree).props.value, 'Potluck Planner');
  tiles(tree)[3].props.onClick();
  tree = draw();
  assert.equal(sheet(tree).props.picked.key, 'signup', 'the sheet marks what holds the tile');
  sheet(tree).props.onClose();
  tree = draw();
  assert.equal(sheet(tree), undefined);
  assert.deepEqual(pressed(tree), ['signup'], 'shutting it keeps the pick');
});

test('the game\'s box reads as a field to type in, and the tiles are two by two', () => {
  const src = read(`${DIR}/make.tsx`);
  // A field, plainly: white, ringed in the accent while it is empty, with a
  // label above it. The blank's words are tinted; the box is not.
  assert.match(src, /\{t\('onboarding:firstSession\.make\.finishLabel'\)\}/);
  assert.equal(message('onboarding:firstSession.make.finishLabel'), 'Finish it in your own words');
  assert.match(src, /className=\{`\$\{WORDS_BOX\} \$\{words\.trim\(\) \? WORDS_FILLED : WORDS_EMPTY\}`\}/);
  assert.match(src, /const WORDS_EMPTY = 'shadow-\[inset_0_0_0_2px_var\(--accent\),/);
  // The box's example is one whole message, "For example, …".
  assert.match(src, /placeholder=\{t\(boxExample\)\}/);
  assert.equal(message('onboarding:firstSession.template.game.board.example'), 'For example, we roll dice and race each other around the board');
  assert.equal(message('onboarding:firstSession.template.game.own.example'), 'For example, a drawing game where one of us draws and everyone guesses');
  assert.match(src, /<div className="grid grid-cols-2 gap-2" role="group" aria-label=\{t\('onboarding:firstSession\.make\.ideasLabel'\)\}>/);
  assert.equal(message('onboarding:firstSession.make.ideasLabel'), 'Ideas');
  // The choices are the shell's chip, and wrap.
  assert.match(src, /import \{ Chip \} from '@\/components\/ui\/chip';/);
  assert.match(src, /<div className="mb-1 mt-3 flex flex-wrap gap-1.5" role="group" aria-label=\{t\('onboarding:firstSession\.make\.choicesLabel'\)\}>/);
  assert.equal(message('onboarding:firstSession.make.choicesLabel'), 'Choices');
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
  // The first session's second button: the app itself once an invite is
  // out, or Home while Homeroom bot still builds it (continueLabel).
  assert.equal(made.continueLabel('first-session', false, 'Page Turners'), 'Invite people later');
  assert.equal(made.continueLabel('first-session', true, 'Page Turners'), 'Go to app');
  assert.equal(made.continueLabel('first-session', true, 'Page Turners', true), 'Continue');
  assert.match(src, /\{continueLabel\(entry, true, made\.name, stage !== null\)\}/);
  assert.match(src, /\{continueLabel\(entry, false, made\.name\)\}/);
  // The note is said to be the first message.
  assert.match(src, /body: JSON\.stringify\(\{ days: LINK_DAYS, maxUses: LINK_USES, note: note\.trim\(\) \|\| null \}\)/);
  // Every link's default, the first one's too: a link lets somebody new
  // straight in as a private member now, so a forwarded one stops on its own.
  const invitesService = require('../src/services/community-invites');
  assert.match(src, /const LINK_DAYS = 7;\s+const LINK_USES = 25;/);
  assert.deepEqual([invitesService.DEFAULT_DAYS, invitesService.DEFAULT_USES], [7, 25]);
  assert.match(src, /\{t\('onboarding:firstSession\.invite\.limits'\)\}/);
  assert.equal(message('onboarding:firstSession.invite.limits'), 'Anyone with the link can join for the next 7 days, up to 25 people.');
  // Evan, 5 October 2026: the first invite is a link and nothing else. No
  // invite by username (somebody brand new knows nobody on Homeroom yet), and
  // no joining-rule line ("With one other person using it, a change goes
  // live when you both say yes, …"). The project's own invite pane dropped
  // the rule line too (#4599).
  assert.doesNotMatch(src, /joiningRule|setRule|Invite by username|\/invites`/);
  const sheet = renderToHtml(createElement(made.InviteSheet, {
    made: { slug: 'page-turners', name: 'Page Turners', emoji: '📚', description: null, example: null, conversationId: 3 },
    me: 'alex', onClose() {}, onSent() {},
  }));
  // Copy link, and Share link where the device has a share sheet (#4180,
  // tests/first-session-copy-link.test.js).
  assert.match(sheet, />Copy link</);
  assert.doesNotMatch(sheet, /username|say yes|goes live/i);
  assert.match(src, /\{t\('onboarding:firstSession\.invite\.noteHint'\)\}/);
  assert.match(sheet, /When you share, your note also goes in the group chat as your first message\./);
  assert.match(src, /fetch\(`\/api\/apps\/\$\{encodeURIComponent\(made\.slug\)\}\/messages`/);
  const invites = require('../src/services/community-invites');
  assert.equal(invites.LIMITS.maxDays, 30);
  assert.equal(invites.LIMITS.maxUses, 100);
});

test('Make it stays reachable: a pick brings it into view, and pressing it holds the form where it is (onboarding run two)', () => {
  const src = read(`${DIR}/make.tsx`);
  // A pick with the keys down reveals the description and Make it together,
  // with the keyboard surface's own arithmetic, to the foot of what Safari
  // draws of a fixed box (innerHeight).
  assert.match(src, /if \(picks\.current\+\+ === 0\) return undefined;/, 'not on opening');
  assert.match(src, /if \(!scroller \|\| document\.documentElement\.classList\.contains\(KB_OPEN_CLASS\)\) return;/, 'the keyboard surface reveals with the keys up');
  assert.match(src, /viewBottom: Math\.min\(view\.bottom, window\.innerHeight\),/);
  assert.match(src, /\}, \[picked, choice, written\]\);/);
  const html = renderComponent(`${DIR}/make.tsx`, 'MakeScreen', { who: 'Jordan', onMade() {}, onLookAround() {} });
  assert.match(html, /<div data-make-brief="" class="mt-4 overflow-hidden rounded-2xl /);
  assert.match(html, /<button type="submit" data-make-submit=""/);
  // Room after the form only while it makes, so the keys going down leave
  // the scroller where it was.
  assert.doesNotMatch(html, /data-make-hold/);
  assert.match(src, /\{busy \? <div aria-hidden="true" data-make-hold="" className="h-\[60vh\] shrink-0" \/> : null\}/);
});

// #5266 (navigation review, 20 Oct 2026): someone who has just been let in
// gets a Welcome line under the question, the column is wider from a tablet
// up, and the spacer that pushed Make it to the foot of the window is gone.
test('the first session says Welcome, and Make it follows the rule line (#5266)', () => {
  const src = read(`${DIR}/make.tsx`);
  const first = renderComponent(`${DIR}/make.tsx`, 'MakeScreen', { who: 'Jordan', onMade() {}, onLookAround() {} });
  const create = renderComponent(`${DIR}/make.tsx`, 'MakeScreen', { who: 'Jordan', entry: 'create', onMade() {}, onClose() {} });
  // The line is a sentence under the one title, in the import form's own style.
  const welcome = `<p data-make-welcome="" class="mt-2.5 text-pretty text-[16px] leading-[22px] text-zinc-500 dark:text-zinc-400">${message('onboarding:firstSession.make.welcome')}</p>`;
  assert.ok(first.includes(`</h1>${welcome}</div>`), 'under the question, before Start from an idea');
  assert.ok(first.indexOf('data-make-welcome') < first.indexOf('Start from an idea'));
  // Not from Create: New project is a returning maker's, not a first arrival.
  assert.doesNotMatch(create, /data-make-welcome|Welcome to Homeroom/);

  // Wider on a computer, and only there: phones keep the 384px column, and
  // the import form shares the frame so the two do not change width.
  assert.match(src, /const formClass = `mx-auto flex w-full max-w-sm grow flex-col px-4 pb-\[max\(34px,env\(safe-area-inset-bottom\)\)\] md:max-w-xl \$\{motion\}`;/);
  assert.match(src, /className=\{`mx-auto flex w-full max-w-sm grow flex-col px-4 pb-\[max\(34px,env\(safe-area-inset-bottom\)\)\] md:max-w-xl \$\{motion\}`\}/);
  assert.match(src, /<div className="grid grid-cols-2 gap-2"/, 'the four ideas stay two by two');

  // Make it follows the rule line: no spacer grows between them.
  const ruleAt = src.indexOf('<MakeRuleLine preset={rule} onPick={setRule} who={who} />');
  const submitAt = src.indexOf('type="submit"');
  assert.ok(ruleAt > 0 && ruleAt < submitAt);
  assert.doesNotMatch(src.slice(ruleAt, submitAt), /className="grow"/);
  assert.doesNotMatch(src, /<div className="grow" \/>/);
  // Room after the form is still held while it makes.
  assert.match(src, /\{busy \? <div aria-hidden="true" data-make-hold="" className="h-\[60vh\] shrink-0" \/> : null\}/);
});

// Evan, 10 Oct 2026: "let's just have them open the app". 15 Oct 2026: the
// made screen's way on opens it, full screen, once it runs; the walk on Home
// follows the first time Home shows after it. One still being built goes to
// Home and its walk at once, and opens on its build later, which takes its
// maker to the bot's chat when a plan waits for them.
test('the maker\'s way on after Make it: the app itself once it runs, Home and the walk while it is built', () => {
  const index = read(`${DIR}/index.tsx`);
  assert.doesNotMatch(index, /makerSteps|path: 'maker'/);
  assert.match(index, /setMode\(\{ kind: 'none' \}\);\s+enterScreen\('app', slug\);/);
  assert.match(index, /setMode\(\{ kind: 'tour', info: \{ slug, name \}, path: 'walk', moments: true \}\);/);
  // The app opens on its own screen, as a tap on its tile does.
  assert.match(index, /else if \(screen === 'app'\) App\.navigateToApp\?\.\(slug, 'app'\);/);
  // A first version being built takes its maker to the chat from the App tab:
  // Review the plan while one waits, else a quiet Open Homeroom bot.
  assert.match(read('public/js/app-view.js'),
    /label: thumb\.buildLine === 'plan' \? PlatformI18n\.t\('changes:firstVersion\.reviewPlan'\) : PlatformI18n\.t\('changes:firstVersion\.openBot'\),/);
  // Create's Go to chat still opens the chat by address.
  assert.match(index, /else if \(screen === 'bot' && conversationId\) window\.location\.hash = `#messages\/\$\{conversationId\}`;/);
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
  assert.equal(message(make.WAITLIST_IDEA_LINE), 'Filled in from your waitlist answer.');
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
  assert.equal(line[2], message(make.WAITLIST_IDEA_LINE));
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
  const { MakeScreen } = loadTsx(`${DIR}/make.tsx`, { stubs: { react: React, '../../lib/i18n/react': ENGLISH_HOOK } });
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

test('runs six and seven: a long description scrolls inside its own box, under its label, hidden at its top edge', () => {
  // Newcomer run six (14 Oct 2026, iPhone Safari, keyboard up): about 200
  // characters scrolled the description's text up to the label's own bottom
  // edge, and the line cut off there read as text passing under "What should
  // it do?". Both fields keep 8px between label and writing; while the
  // description is scrolled from its top, its top line fades out.
  const make = loadTsx(`${DIR}/make.tsx`);
  // Run seven (14 Oct 2026): the gap became a margin, outside the
  // description's scroll box, and the fade hides the box's top 6px outright.
  assert.equal(make.BRIEF_FADE, '[mask-image:linear-gradient(to_bottom,transparent_6px,#000_24px)]');
  assert.equal(make.briefFades({ scrollTop: 0 }), false, 'at its top, the first line drawn whole');
  assert.equal(make.briefFades({ scrollTop: 13 }), true);
  assert.equal(make.briefFades(null), false);
  const html = renderComponent(`${DIR}/make.tsx`, 'MakeScreen', { who: '', onMade() {}, onLookAround() {} });
  const brief = html.match(/<textarea[^>]*id="first-session-brief"[^>]*>/)[0];
  const name = html.match(/<input[^>]*id="first-session-name"[^>]*>/)[0];
  const classOf = (tag) => tag.match(/class="([^"]*)"/)[1].split(' ');
  for (const [field, tag] of [['brief', brief], ['name', name]]) {
    const cls = classOf(tag);
    assert.ok(cls.includes('pb-1'), field);
    assert.ok(!cls.includes('py-1'), field);
    assert.ok(!cls.includes(make.BRIEF_FADE), `${field}: no fade unscrolled`);
  }
  // 8px under its label: the name as padding, the description as a margin,
  // so its box's clip edge sits 8px under the label and its scrolled text
  // never rises to the label's edge. Its first line starts where it did.
  assert.ok(classOf(name).includes('pt-2') && !classOf(name).includes('mt-2'), 'name: 8px of padding');
  assert.ok(classOf(brief).includes('mt-2') && classOf(brief).includes('pt-0'), 'brief: 8px of margin');
  assert.ok(!classOf(brief).includes('pt-2'), 'brief: no padding inside its scroll box');
  // Read on its scroll, and after every render (a box swapped in, or a
  // shorter description, can land it back at its top with no scroll event).
  const src = read(`${DIR}/make.tsx`);
  assert.match(src, /const \[briefScrolled, setBriefScrolled\] = useState\(false\);\s+useEffect\(\(\) => \{ setBriefScrolled\(briefFades\(briefRef\.current\)\); \}\);/);
  assert.match(src, /onScroll=\{\(e\) => setBriefScrolled\(briefFades\(e\.currentTarget\)\)\}/);
  assert.match(src, /className=\{`\$\{BRIEF_INPUT\}\$\{briefScrolled \? ` \$\{BRIEF_FADE\}` : ''\} resize-none leading-\[22px\]`\}/);
  // A box of its own under the label, which stays where it is.
  assert.match(html, /<label for="first-session-brief" class="block text-\[13px\] text-zinc-500 dark:text-zinc-400">What should it do\?<\/label><textarea/);
  assert.match(brief, /rows="3"/);
  assert.ok(classOf(brief).includes('resize-none'));
});

// INSTANT OR CUSTOM (Evan, 15 Oct 2026): one line above Who can change it
// says what Make it will do. A ready-made app (Make it's own `readyMadeOf`
// test while the sentence is still the template's) is Instant; anything
// Homeroom bot builds is Custom; with nothing picked or typed there is none.
test('Make it says whether it is instant or custom: the rule, the exact copy, and nothing before a pick', () => {
  const make = loadTsx(`${DIR}/make.tsx`);
  const { TEMPLATES, OWN, readyMadeOf } = loadTsx(`${DIR}/examples.ts`);
  const game = TEMPLATES.find((t) => t.key === 'game');

  // Nothing picked and nothing typed: no line.
  assert.equal(make.makeSpeed(null, '', null, ''), null);
  assert.equal(make.makeSpeed(null, '', null, '   \n'), null, 'blank space is nothing typed');
  // Every choice that makes a ready-made app, drawn as the template's: instant.
  for (const t of TEMPLATES.filter((x) => x !== game)) {
    for (const c of t.choices) {
      assert.ok(readyMadeOf(t, c.key), `${t.key}/${c.key} is ready-made`);
      assert.equal(make.makeSpeed(t, c.key, null, ''), 'instant', `${t.key}/${c.key}`);
      // Write it yourself: the plain box, which Homeroom bot builds.
      const out = 'A tier list for our favorite hikes. ';
      assert.equal(make.makeSpeed(t, c.key, out, out), 'custom', `${t.key}/${c.key} written out`);
    }
    // Your own… in its blank, with or without their words yet.
    assert.equal(make.makeSpeed(t, OWN, null, ''), 'custom', `${t.key}: Your own…`);
  }
  // Every game chip, and the game's own Your own…: built on, so custom.
  for (const key of [OWN, ...game.choices.map((c) => c.key)]) {
    assert.equal(make.makeSpeed(game, key, null, ''), 'custom', `game/${key}`);
  }
  // Their own words, and Your own idea picked before a word is typed.
  assert.equal(make.makeSpeed(make.OWN_IDEA, '', null, 'A tracker for my run club'), 'custom');
  assert.equal(make.makeSpeed(make.OWN_IDEA, '', null, ''), 'custom');

  // The exact copy, the first word bold.
  assert.deepEqual({ ...make.SPEED_LINE }, {
    instant: 'onboarding:firstSession.make.speed.instant',
    custom: 'onboarding:firstSession.make.speed.custom',
  });
  assert.equal(message(make.SPEED_LINE.instant), '<0>Instant</0> · ready to use in about a minute');
  assert.equal(message(make.SPEED_LINE.custom), '<0>Custom</0> · Homeroom bot builds it in 20 to 30 min');
  const catalog = JSON.parse(read('frontend/locales/en/onboarding.json'));
  for (const id of Object.values(make.SPEED_LINE)) {
    const entry = catalog[id.slice('onboarding:'.length)];
    assert.ok(entry && entry.description, `${id} has a description`);
    assert.match(entry.description, /<0>…<\/0> is bold/);
  }

  // Drawn: none as the screen opens, and Custom, sparkle first, for a
  // waitlist answer in the plain box. Muted zinc, 14px, no colour of its own.
  const base = { who: 'Jordan', onMade() {}, onLookAround() {} };
  const plain = renderComponent(`${DIR}/make.tsx`, 'MakeScreen', base);
  assert.doesNotMatch(plain, /data-make-speed/);
  const html = renderComponent(`${DIR}/make.tsx`, 'MakeScreen', { ...base, idea: 'A tracker for my run club, so we can see who keeps up' });
  const line = /<p data-make-speed="custom" class="([^"]*)">(.*?)<\/p>/.exec(html);
  assert.ok(line, 'the line is drawn');
  assert.match(line[1], /\btext-\[14px\]/);
  assert.match(line[1], /\btext-zinc-600\b/);
  assert.doesNotMatch(line[1], /violet|accent|red-|amber-|green-|emerald-/);
  assert.match(line[2], /^<svg [^>]*aria-hidden="true"[^>]*>.*<\/svg><span[^>]*><b class="font-semibold text-zinc-900 dark:text-zinc-100">Custom<\/b> · Homeroom bot builds it in 20 to 30 min<\/span>$/);
  const icons = read('frontend/@/components/ui/icons.tsx');
  const pathOf = (name) => new RegExp(`export const ${name} = stroked\\(\\s*'${name}',\\s*'([^']+)'`).exec(icons)[1];
  assert.ok(line[2].includes(`d="${pathOf('SparklesIcon')}"`), 'the sparkle');
  assert.ok(!line[2].includes(`d="${pathOf('BoltIcon')}"`), 'not the bolt');
  // Above Who can change it, under the name.
  const src = read(`${DIR}/make.tsx`);
  const nameHint = src.indexOf("{missing === 'name' ? <p id=\"first-session-name-hint\"");
  const speedAt = src.indexOf('<p data-make-speed={speed}');
  const ruleAt = src.indexOf('<MakeRuleLine preset={rule} onPick={setRule} who={who} />');
  assert.ok(nameHint > 0 && nameHint < speedAt && speedAt < ruleAt, 'under the name, just above Who can change it');
  assert.ok(html.indexOf('data-make-speed') < html.indexOf('data-make-rule='), 'drawn above the rule line');
  assert.match(src, /const speed = makeSpeed\(picked, choice, written, brief\);/);
});

test('the instant or custom line follows each pick and keystroke', (t) => {
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
  const { MakeScreen } = loadTsx(`${DIR}/make.tsx`, { stubs: { react: React, 'react-dom': { createPortal: (el) => el }, '../../lib/i18n/react': ENGLISH_HOOK } });
  const hadDocument = 'document' in globalThis;
  if (!hadDocument) globalThis.document = { body: {} };
  t.after(() => { if (!hadDocument) delete globalThis.document; });
  const draw = () => { at = 0; return MakeScreen({ who: 'Jordan', onMade() {}, onLookAround() {} }); };
  const find = (node, test, out = []) => {
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) { node.forEach((n) => find(n, test, out)); return out; }
    if (node.props && test(node)) out.push(node);
    if (node.props) find(node.props.children, test, out);
    return out;
  };
  const tiles = (tree) => find(tree, (n) => n.props['data-first-session-example'] !== undefined);
  const chip = (tree, key) => find(tree, (n) => n.props['data-make-choice'] === key)[0];
  const brief = (tree) => find(tree, (n) => n.props.id === 'first-session-brief')[0];
  const words = (tree) => find(tree, (n) => n.props.id === 'make-words')[0];
  const sheet = (tree) => find(tree, (n) => n.props.onPickIdea !== undefined)[0];
  // What the line says: its kind, its icon and its message, or null.
  const said = (tree) => {
    const line = find(tree, (n) => n.props['data-make-speed'] !== undefined)[0];
    if (!line) return null;
    const icon = find(line.props.children, (n) => typeof n.type === 'function' && /Icon$/.test(n.type.displayName || ''))[0];
    const rich = find(line.props.children, (n) => typeof n.props.id === 'string')[0];
    return [line.props['data-make-speed'], icon.type.displayName, rich.props.id];
  };
  const INSTANT = ['instant', 'BoltIcon', 'onboarding:firstSession.make.speed.instant'];
  const CUSTOM = ['custom', 'SparklesIcon', 'onboarding:firstSession.make.speed.custom'];

  let tree = draw();
  assert.equal(said(tree), null, 'nothing chosen: no line');
  // A ready-made chip: the tier list's first choice, then another.
  tiles(tree)[0].props.onClick();
  tree = draw();
  assert.deepEqual(said(tree), INSTANT, 'tier list, restaurants');
  chip(tree, 'hikes').props.onClick();
  tree = draw();
  assert.deepEqual(said(tree), INSTANT, 'tier list, hikes');
  // Your own…: their words in the blank are built.
  chip(tree, 'own').props.onClick();
  tree = draw();
  assert.deepEqual(said(tree), CUSTOM, 'Your own…, before a word');
  words(tree).props.onChange({ target: { value: 'taco spots' } });
  tree = draw();
  assert.deepEqual(said(tree), CUSTOM, 'Your own…, with their words');
  chip(tree, 'cities').props.onClick();
  tree = draw();
  assert.deepEqual(said(tree), INSTANT, 'back to a ready-made chip');
  // Write it yourself: the plain box, built by Homeroom bot.
  find(tree, (n) => n.props['data-make-write-out'] !== undefined)[0].props.onClick();
  tree = draw();
  assert.deepEqual(said(tree), CUSTOM, 'written out');
  brief(tree).props.onChange({ target: { value: `${brief(tree).props.value} And a map of them.` } });
  tree = draw();
  assert.deepEqual(said(tree), CUSTOM, 'their own words');
  // The game: always built, whichever chip.
  tiles(tree)[1].props.onClick();
  tree = draw();
  assert.deepEqual(said(tree), CUSTOM, 'the game, on Your own');
  for (const key of ['board', 'shooter', 'blocks', 'trivia']) {
    chip(tree, key).props.onClick();
    tree = draw();
    assert.deepEqual(said(tree), CUSTOM, `game/${key}`);
  }
  // The organizer, picked: ready-made again.
  tiles(tree)[2].props.onClick();
  tree = draw();
  assert.deepEqual(said(tree), INSTANT, 'organizer, groceries');
  // Your own idea, from Something else.
  tiles(tree)[3].props.onClick();
  tree = draw();
  sheet(tree).props.onPickIdea();
  tree = draw();
  assert.deepEqual(said(tree), CUSTOM, 'Your own idea');

  // From a fresh screen, typing alone is enough.
  slots = [];
  tree = draw();
  assert.equal(said(tree), null);
  brief(tree).props.onChange({ target: { value: 'A' } });
  tree = draw();
  assert.deepEqual(said(tree), CUSTOM, 'their own words, as they type');
});

test('the first session\'s answer owes Homeroom bot\'s hello, unless making the project greets them as its maker', async () => {
  // Sign-up test, 19 Oct 2026: Messages was empty for anybody who did not
  // make a project the bot builds. Looking around, a project with no
  // description and an import owe the tour's hello now.
  const made = fakePool([[], [{ id: 1 }]]);
  await firstSession.answerJoinScreenByMaking(made, 11);
  assert.deepEqual(made.calls.map((c) => c.params[0]), [11, 'bot-dm']);
  assert.equal(made.calls[1].params[3], 'Greet');
  assert.deepEqual(JSON.parse(made.calls[1].params[4]), { userId: 11, kind: 'tour', appId: null });
  // A ready-made app or a description the bot builds greets them as its
  // maker: no tour's hello is owed beside it (a ready-made app's would race
  // its maker's, both work of the same DM machine).
  const greeted = fakePool([[]]);
  await firstSession.answerJoinScreenByMaking(greeted, 12, { greet: false });
  assert.equal(greeted.calls.length, 1);
  assert.match(greeted.calls[0].sql, /SET needs_communities_choice = FALSE,/);
  // Best-effort: a hello that cannot be owed never fails the answer.
  const down = fakePool([[], new Error('connection reset')]);
  await firstSession.answerJoinScreenByLookingAround(down, 13);
  assert.equal(down.calls.length, 2);
  // POST /api/apps owes a ready-made app's maker their hello before the
  // answer, and the answer owes none beside it.
  const route = read('src/routes/apps.js');
  const create = route.slice(route.indexOf("router.post('/api/apps', "));
  const maker = create.indexOf("greet(pool, { userId: req.user.id, kind: 'maker', appId: appRow.id })");
  assert.ok(maker > 0, 'a ready-made app\'s maker is greeted');
  assert.match(create, /if \(readyMade\) \{\n\s+await require\('\.\.\/workflow\/platform\.ts'\)\.greet\(pool, \{ userId: req\.user\.id, kind: 'maker', appId: appRow\.id \}\)\n\s+\.catch\(/);
  assert.ok(maker < create.indexOf('answerJoinScreenByMaking('), 'owed first');
});
