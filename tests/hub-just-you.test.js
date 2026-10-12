'use strict';

// The hub of a project nobody else is in yet
// (frontend/src/features/dev-board/workshop/).
//
// Evan, testing on his phone on 5 Oct 2026, of a brand-new "Just you"
// project whose first version Homeroom bot was still building: "The initial
// hub if no one has joined is really sad. It should come with a short
// description, made the build stage, etc." It read only "Just you", Open app
// and the ⋯, "Nothing more to vote on.", the Share it card, and "Your work ·
// No work in progress."
//
// Now:
//
//   - the hero has a description even when dapp.json has none yet: the first
//     sentence of the description it was made from (server half pinned in
//     tests/hub-just-you-postgres.test.js);
//   - a First version card under the hero says where Homeroom bot's build
//     stands, in the build line the made screen and the App tab draw
//     ("Building it", #4053: never "Step 4 of 7: Build it", which read as an
//     instruction), and opens the bot's chat when the bot waits on its maker;
//   - "Nothing more to vote on." is a zero nobody else could change, so a
//     project nobody else is in leaves it out;
//   - an empty Your work says how to change something there, or leaves the
//     hub while the first version or the start-here banner already says
//     what is next;
//   - a project with people in it is drawn as before.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const HUB = 'frontend/src/features/dev-board/workshop/hub-cards.tsx';
const CARD = 'frontend/src/features/dev-board/workshop/community-card.tsx';
const LANDER = read('frontend/src/features/dev-board/workshop/workshop.tsx');

const hub = loadTsx(HUB);

const community = (over = {}) => ({
  slug: 'geneva-hikes',
  name: 'Geneva hike planner',
  description: 'Plan hikes around Geneva with friends',
  member_count: 1,
  is_member: true,
  is_creator: true,
  audience: 'solo',
  audience_label: 'Just you',
  members: [{ id: 7, username: 'evan' }],
  channel: null,
  activity: null,
  can_manage: true,
  audience_change: null,
  approval: { policy: 'anyone', approvals_required: null, electorate: 1, required: 1 },
  first_version: null,
  ...over,
});

const building = (over = {}) => ({
  step: 4, of: 7, line: 'building', ready: false, mine: true, creator: 'evan',
  waits_on: null, conversation_id: 41, session_id: null, ...over,
});

const card = (fv) => renderToHtml(createElement(hub.FirstVersionCard, {
  slug: 'geneva-hikes', data: community({ first_version: fv }),
}));

test('a just-you project being built: the thumbnail and its build line, and no step count or build time', () => {
  const html = card(building());
  assert.match(html, /^<section class="dev-ws-strip dev-ws-hub-first" data-ws-first-version="building"><div class="dev-ws-hub-first-row"><div data-thumb-row=""/,
    'the project\'s thumbnail drawn small (#4045)');
  assert.match(html, />Geneva hike planner<\/span>/, 'its name');
  assert.match(html, /<span role="status" data-build-line="building"[^>]*>.*>Building it<\/span><\/span>/,
    'the made screen\'s and the App tab\'s words, with a spinner');
  assert.match(html, /animate-spin/);
  // #4053: no "Step 4 of 7" and no ring counting it: step numbers stay in
  // Homeroom bot's chat. Evan, 5 Oct 2026: no average build time either.
  // #4045: no "First version" heading: the thumbnail is what it is.
  assert.doesNotMatch(html, /First version|Step \d of|<svg[^>]*width="38"|4\/7|minute|usually/);
  assert.doesNotMatch(html, /data-ws-first-version-action|data-ws-first-version-plan|Go to chat|See the change/,
    'nothing to press while nothing waits on anyone');
  assert.equal(hub.firstVersionLine(building({ step: 1, line: 'planning' })), 'planning');
  assert.equal(hub.firstVersionLine(building({ line: null })), 'planning', 'a record without its line');
  assert.equal(hub.firstVersionLine(building({ line: null, ready: true })), 'ready');
  assert.equal(hub.firstVersionStep, undefined);
  assert.equal(hub.firstVersionNote, undefined, 'one line, said once');
  const src = read(HUB);
  assert.doesNotMatch(src.slice(src.indexOf('export const FIRST_VERSION_POLL_MS'), src.indexOf('export const owesVote')),
    /typical_minutes|\$\{minutes\}|usually in about|ProgressRing/, 'and nothing reads one');
});

test('a plan or a question waiting on its maker: one button that says so, and no line above it (#4045)', () => {
  // The owner, 6 Oct 2026: a card with a button hides its build line, so
  // "Your plan is ready to review" is not said again over "Review the plan".
  // The project's own line sits under its name instead.
  const plan = card(building({ step: 3, line: 'plan', waits_on: 'plan' }));
  assert.match(plan, /data-ws-first-version="plan"/);
  assert.doesNotMatch(plan, /data-build-line|Your plan is ready to review/);
  assert.doesNotMatch(plan, /Plan hikes around Geneva/, 'the project\'s one line is the hub\'s people row\'s, said once');
  assert.match(plan, /<button type="button" data-ws-first-version-action="review" class="w-full rounded-full bg-violet-600[^"]*">Review the plan<\/button><\/section>$/,
    'the accent, a whole row: it is the one thing on the hub that waits on them');
  const question = card(building({ step: 2, line: 'question', waits_on: 'question' }));
  assert.match(question, /data-ws-first-version="question"/);
  assert.doesNotMatch(question, /data-build-line|Homeroom bot has a question for you/);
  assert.match(question, /data-ws-first-version-action="answer"[^>]*>Answer the question<\/button>/);
  assert.equal(hub.firstVersionAction(building({ waits_on: 'plan' })), 'review');
  assert.equal(hub.firstVersionAction(building({ waits_on: 'question' })), 'answer');
  // The chat is theirs: their DM when the record names it, else the bot's door.
  const src = read(HUB);
  assert.match(src, /if \(action === 'review' \|\| action === 'answer'\) \{\s*if \(fv\.conversation_id\) openConversation\(fv\.conversation_id\);\s*else void openBot\(\);/);
  assert.match(src, /import \{ open as openConversation, openBot \} from '\.\.\/\.\.\/messages\/store';/);
});

test('#4391/#4393: while the first-session tour runs, no Review the plan: the bot is working on it', () => {
  const tour = loadTsx('frontend/src/features/first-session/tour-running.ts');
  tour.setTourRunning(true);
  try {
    const plan = card(building({ step: 3, line: 'plan', waits_on: 'plan' }));
    assert.match(plan, /data-ws-first-version="working"/);
    assert.match(plan, /data-build-line="working"[^>]*>.*animate-spin.*Homeroom bot is working on it/, 'the build line, with its spinner');
    assert.doesNotMatch(plan, /data-ws-first-version-action|Review the plan|plan is ready/);
    // Only the plan is held: a question and the build itself are as they were.
    assert.match(card(building({ step: 2, line: 'question', waits_on: 'question' })), /data-ws-first-version-action="answer"/);
    assert.match(card(building()), /data-build-line="building"/);
  } finally {
    tour.setTourRunning(false);
  }
  // Once the tour ends, exactly as before.
  assert.match(card(building({ step: 3, line: 'plan', waits_on: 'plan' })), /data-ws-first-version-action="review"[^>]*>Review the plan<\/button>/);
});

test('ready to try: Try it, with no line above it; live in its first week: Open app', () => {
  const html = card(building({ step: 6, line: 'ready', ready: true, session_id: 990003 }));
  assert.match(html, /data-ws-first-version="ready"/);
  assert.doesNotMatch(html, /data-build-line|See the change/);
  assert.match(html, /data-ws-first-version-action="try"[^>]*>Try it<\/button>/);
  assert.match(read(HUB), /\(window as any\)\.AppView\?\.tryFirstVersion\?\.\(slug, fv\.session_id\);/,
    'the version to try, as its message in Homeroom bot\'s chat opens it');
  const unread = card(building({ step: 6, line: 'ready', ready: true, session_id: null }));
  assert.doesNotMatch(unread, /data-ws-first-version-action/, 'no change to open when the read of it failed');
  assert.match(unread, /data-build-line="ready"[^>]*>.*Ready to try/, 'so the line says it');
  const live = card(building({ step: null, of: null, line: 'live', mine: false, conversation_id: null }));
  assert.match(live, /data-ws-first-version="live"/);
  assert.match(live, /<button type="button" class="dev-ws-open-app dev-ws-hub-first-open" data-ws-first-version-action="open">Open app<\/button>/);
  assert.doesNotMatch(live, /data-build-line/);
  assert.match(read(HUB), /\(window as any\)\.App\?\.openAppTab\?\.\(slug, 'app'\);/);
});

test('somebody else reading it while its plan waits: Planning it, and See the plan when they joined (#4074)', () => {
  const plan = { bullets: ['A trail list', 'Who is coming'], questions: [{ question: 'How long?', suggested: 'Half a day' }] };
  const member = card(building({ mine: false, creator: 'ada', conversation_id: null, step: 3, line: 'plan-member', plan }));
  assert.match(member, /data-build-line="plan-member"[^>]*>.*Planning it/, 'a quiet link beside the line, so the line stays');
  assert.match(member, /<button type="button" class="dev-ws-hub-first-see un-touch-target" data-ws-first-version-plan="">See the plan<\/button><\/div><\/section>$/);
  assert.doesNotMatch(member, /data-ws-first-version-action|--accent/);
  const outsider = card(building({ mine: false, creator: 'ada', conversation_id: null, step: 3, line: 'plan-member', plan: null }));
  assert.doesNotMatch(outsider, /See the plan/, 'not a member: no plan to see');
  assert.match(LANDER, /onSeePlan=\{\(\) => openTab\('plan'\)\}/);
});

test('the line is the server\'s for this viewer, and its words are the build line\'s, never written on the hub', () => {
  const src = read(HUB);
  const body = src.slice(src.indexOf('export const FIRST_VERSION_POLL_MS'), src.indexOf('export const owesVote'));
  assert.match(body, /return buildLineOf\(fv\.line\) \|\| \(fv\.ready \? 'ready' : 'planning'\);/);
  assert.match(body, /<ThumbRow\s+name=\{data\?\.name \|\| slug\}\s+colorKey=\{slug\}\s+emoji=\{emoji\}\s+line=\{button \? null : line\}\s+\/>/);
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const name of ['Homeroom bot is planning it', 'Your plan is ready to review', 'Planning it', 'Building it', 'Testing it', 'Ready to try', 'Step ']) {
    for (const quote of ["'", '"', '`', '>']) {
      assert.ok(!code.includes(`${quote}${name}`), `no line written in the hub's code: ${quote}${name}`);
    }
  }
  const route = read('src/routes/apps.js');
  assert.match(route, /line: state\.line \|\| null,/);
  assert.match(route, /const state = await botDm\.firstVersionState\(pool, app\.id, \{ viewerId: req\.user\?\.id \?\? null \}\);\s*firstVersion = hubFirstVersion\(state, req\.user\?\.id \?\? null, \{ member: !!membership\?\.is_member \}\);/,
    'read for this viewer, as GET /api/apps/:slug reads it for the App tab');
});

test('nothing being built, or no record yet: no card', () => {
  assert.equal(card(null), '');
  assert.equal(renderToHtml(createElement(hub.FirstVersionCard, { slug: 'geneva-hikes', data: null })), '');
  // While it is on screen it reads the record again, as the App tab and the
  // made screen read theirs: no event marks each step.
  const src = read(HUB);
  const body = src.slice(src.indexOf('export function FirstVersionCard('), src.indexOf('export const owesVote'));
  assert.match(body, /window\.setInterval\(\(\) => \{\s*if \(document\.visibilityState !== 'visible'\) return;\s*if \(!ref\.current \|\| !ref\.current\.getClientRects\(\)\.length\) return;\s*void reloadCommunity\(slug\);\s*\}, FIRST_VERSION_POLL_MS\);/);
  assert.match(body, /return \(\) => window\.clearInterval\(timer\);/);
  assert.equal(hub.FIRST_VERSION_POLL_MS, 15000);
});

test('"Nothing more to vote on." is a zero on a project nobody else is in', () => {
  const { NothingToVote, hubAlone } = hub;
  assert.equal(renderToHtml(createElement(NothingToVote, { unclaimed: 0, onOpen: () => {}, alone: true })), '');
  const one = renderToHtml(createElement(NothingToVote, { unclaimed: 1, onOpen: () => {}, alone: true }));
  assert.match(one, /^<p class="dev-ws-week-note" data-ws-hub-needs-none=""><button[^>]*data-ws-hub-needs-requests="">1 request nobody has picked up<\/button><\/p>$/,
    'a request still waiting is still the way to it');
  // A project with people in it: as it was (#3408).
  assert.equal(renderToHtml(createElement(NothingToVote, { unclaimed: 0, onOpen: () => {} })),
    '<p class="dev-ws-week-note" data-ws-hub-needs-none="">Nothing more to vote on.</p>');
  assert.equal(hubAlone(community()), true, 'Just you');
  assert.equal(hubAlone(community({ audience: 'open', audience_label: 'Public community', member_count: 1 })), true,
    'a public community nobody has joined yet');
  assert.equal(hubAlone(community({ audience: 'invited', audience_label: 'Private community', member_count: 2 })), false);
  assert.equal(hubAlone(community({ audience: 'open', member_count: 12 })), false);
  assert.equal(hubAlone(null), false, 'nothing is taken off the hub before the read answers');
});

test('Your work on a project nobody else is in: how to change something, or nothing', () => {
  const { ForYouCard, hubWorkEmpty } = hub;
  const is = (over) => hubWorkEmpty({ alone: true, building: false, startHere: false, readOnly: false, bot: false, ...over });
  assert.equal(is({ alone: false, building: true, startHere: true }), 'plain', 'a project with people in it keeps #3489');
  assert.equal(is({ building: true }), null, 'its first version being built already says what is next');
  assert.equal(is({ startHere: true }), null, 'so does the start-here banner');
  assert.equal(is({ readOnly: true }), null, 'and a read-only viewer has nothing to start');
  assert.equal(is({ bot: true }), 'bot');
  assert.equal(is({}), 'menu');
  // #4045: in a project's first week an empty Your work is left out, with
  // people in it or not; it shows once there is some.
  assert.equal(is({ firstWeek: true }), null);
  assert.equal(is({ alone: false, firstWeek: true }), null);

  // The For you card's Your work row says so in those words.
  const row = (empty, mine = { viewer: true, bot: empty === 'bot', count: 0, shown: 3, rows: [] }) => renderToHtml(createElement(ForYouCard, {
    slug: 'geneva-hikes', name: 'Geneva hike planner', queue: [], mine, workEmpty: empty, alone: true,
    data: community(), canPost: true, onNeeds: () => {}, onWork: () => {}, onDiscussion: () => {},
  }));
  assert.equal(row(null), '', 'nothing to say: no row, and with no vote line nor discussion, no card');
  const bot = row('bot');
  assert.match(bot, /<button type="button" class="[^"]*dev-ws-foryou-row[^"]*" data-ws-mine-card="" data-ws-mine-open="bot">/,
    'the row opens the chat where Homeroom bot builds for you');
  assert.match(bot, /<span data-ws-mine-empty="bot">Nothing in progress\. To change something, tell Homeroom bot\.<\/span>/);
  assert.match(read(HUB), /onClick=\{toBot \? \(\) => \{ void openBot\(\); \} : onOpen\}/);
  const menu = row('menu');
  assert.match(menu, /data-ws-mine-open="workshop"/);
  assert.match(menu, /<span data-ws-mine-empty="menu">Nothing in progress\. Press <span class="font-medium text-violet-700 dark:text-violet-400">⋯<\/span> to suggest an improvement\.<\/span>/);
  // A project with people in it: as it was, for the declared check that
  // reads "No work in progress." on Homeroom's own hub.
  const plain = row('plain');
  assert.match(plain, /<span data-ws-mine-empty="">No work in progress\.<\/span>/);
  const declared = JSON.parse(read('dapp.json')).tests
    .find((t) => t.name === 'Hub: Your work stays when nothing is in progress, and says so (#3489)');
  assert.equal(declared.expectText, 'No work in progress.');
  assert.match(declared.path, /#app\/usernode-2d5619\/workshop$/, 'on Homeroom\'s own hub, which has people in it');
  assert.equal(declared.expectSelector,
    '#dev-workshop .dev-ws[data-ws-tab="status"] > .dev-ws-tabbody > [data-ws-hub-for-you] > .dev-ws-foryou > button[data-ws-mine-card] [data-ws-mine-empty=""]',
    'For you\'s Your work row, saying so');
});

test('the Share it card says what an invite is for while it is being built', () => {
  const { shareItLine } = loadTsx(CARD);
  assert.equal(shareItLine(true), 'Invite people to follow along while it’s being built, or make it public so anyone can join.');
  assert.equal(shareItLine(false), 'Invite people to make it a private community, or make it public so anyone can join.');
  assert.match(read(CARD), /<p className="dev-ws-strip-text">\{shareItLine\(!!data\.first_version && !data\.first_version\.ready\)\}<\/p>/);
});

test('the hub puts the first version under the hero, and stands the start-here prompt down while the bot builds', () => {
  const hubTab = LANDER.slice(LANDER.indexOf("{tab === 'status' ? ("), LANDER.indexOf("{tab === 'discussion' ? ("));
  const at = (x) => hubTab.indexOf(x);
  assert.ok(at('<CommunityCard') >= 0 && at('<CommunityCard') < at('<FirstVersionCard')
    && at('<FirstVersionCard') < at('{startHere ? <StartHereBanner ') && at('<FirstVersionCard') < at('<ForYouCard'),
    'right under the hero, ahead of everything else on the hub');
  assert.match(hubTab, /\{slug \? \(\s*<FirstVersionCard slug=\{slug\} data=\{community\} emoji=\{app\.iconEmoji \|\| null\} onSeePlan=\{\(\) => openTab\('plan'\)\} \/>\s*\) : null\}/);
  // Before its description is filed the board is empty too, and "The first
  // change is yours to start" told its maker to start the bot's change.
  assert.match(LANDER, /const building = !!\(community && community\.first_version\);\s*const startHere = !!\(v\.dashboard && v\.dashboard\.open === 0 && !v\.dashboard\.everShipped\) && !building;/);
  assert.match(hubTab, /\{v\.emptyNote && !building \? \(/, 'nor the no-items note');
  assert.match(LANDER, /const alone = hubAlone\(community\);[\s\S]{0,400}const weekOne = !!\(community && community\.first_week\);\s*const workEmpty = hubWorkEmpty\(\{\s*alone, building, startHere, readOnly: !!actions\.readOnly, bot: !!\(v\.mine && v\.mine\.bot\), firstWeek: weekOne,\s*\}\);/);
  // For you takes both: Needs you's quiet line leaves out its zero on a
  // project nobody else is in or in its first week, and Your work says what
  // hubWorkEmpty says.
  assert.match(hubTab, /<ForYouCard[\s\S]{0,200}mine=\{v\.mine\}\s+workEmpty=\{workEmpty\}\s+alone=\{alone \|\| weekOne\}/);
  assert.match(read(HUB), /: <NothingToVote unclaimed=\{claims\} onOpen=\{onWork\} alone=\{alone\} \/>\}/);
  assert.match(read(HUB), /if \(!cards\.length && !\(mine\?\.viewer && empty\)\) return null;/, 'Your work for a signed-in viewer, with work or with something to say');
  // The thumbnail's row is app.css's, beside the hub's doors.
  assert.match(read('public/css/app.css'), /\.dev-ws-hub-first-row \{ display: flex; align-items: center; gap: 10px; min-width: 0; \}/);
});

test('the server cuts the bot\'s state to what the hub says, and hands the maker\'s chat to the maker alone', () => {
  const { hubFirstVersion } = require('../src/routes/apps');
  const state = {
    userId: 7, creator: 'evan', conversationId: 41, step: 3, of: 7, line: 'plan',
    question: false, ready: false, plan: { bullets: ['A trail list'], actionId: 5 },
  };
  assert.deepEqual(hubFirstVersion(state, 7, { member: true }), {
    step: 3, of: 7, line: 'plan', ready: false, mine: true, creator: 'evan',
    waits_on: 'plan', conversation_id: 41, session_id: null, plan: null,
  }, 'the line as the state says it for this viewer, and no build time; its maker answers it in their chat');
  assert.deepEqual(hubFirstVersion({ ...state, line: 'plan-member' }, 9), {
    step: 3, of: 7, line: 'plan-member', ready: false, mine: false, creator: 'evan',
    waits_on: null, conversation_id: null, session_id: null, plan: null,
  }, 'nobody else is told what it waits on from its maker, or handed their chat');
  // #4074: a MEMBER who did not start it reads the plan, read only: what it
  // will do and each question's suggested answer. No ids, no other answers.
  const asked = { ...state, line: 'plan-member', plan: {
    bullets: ['A trail list', '', 'Who is coming'],
    questions: [{ question: 'How long?', answers: ['Half a day', 'A whole day'] }, { question: '', answers: ['x'] }],
    actionId: 5, messageId: 6, conversationId: 41,
  } };
  assert.deepEqual(hubFirstVersion(asked, 9, { member: true }).plan, {
    bullets: ['A trail list', 'Who is coming'],
    questions: [{ question: 'How long?', suggested: 'Half a day' }],
  });
  // #4396: once its maker chose it (Build it), the plan chosen, cut the
  // same way, while it is built and tested.
  const chosen = { ...state, line: 'building', step: 4, plan: undefined, chosenPlan: {
    bullets: ['A trail list', 'Who is coming'], questions: [{ question: 'How long?', answers: ['Half a day', 'A whole day'] }],
  } };
  assert.deepEqual(hubFirstVersion(chosen, 9, { member: true }).plan, {
    bullets: ['A trail list', 'Who is coming'],
    questions: [{ question: 'How long?', suggested: 'Half a day' }],
  });
  assert.equal(hubFirstVersion(chosen, 9).plan, null, 'not a member: none, while it builds either');
  assert.equal(hubFirstVersion({ ...chosen, ready: true }, 9, { member: true }).plan, null, 'ready: none');
  assert.equal(hubFirstVersion(asked, 9).plan, null, 'not a member: none');
  assert.equal(hubFirstVersion({ ...asked, ready: true }, 9, { member: true }).plan, null, 'once built: none');
  assert.doesNotMatch(JSON.stringify(hubFirstVersion(asked, 9, { member: true })), /actionId|messageId|"conversationId"|A whole day/);
  assert.doesNotMatch(read('src/routes/apps.js').slice(read('src/routes/apps.js').indexOf('function hubFirstVersion('),
    read('src/routes/apps.js').indexOf('function isPlatformRepo(')), /typical/i, 'no build time in the hub\'s cut');
  assert.equal(hubFirstVersion({ ...state, plan: undefined, question: true }, 7).waits_on, 'question');
  const ready = hubFirstVersion({ ...state, plan: undefined, ready: true, step: 6, line: 'ready', approval: { sessionId: 31 } }, 9);
  assert.deepEqual([ready.ready, ready.session_id, ready.waits_on], [true, 31, null]);
  assert.equal(hubFirstVersion(null, 7), null);
});

test('#4074: the plan, read only, for the people who joined: what it will do, who decides, and the way to Discussion', () => {
  const page = loadTsx('frontend/src/features/dev-board/workshop/plan-page.tsx');
  const plan = { bullets: ['A trail list', 'Who is coming'], questions: [{ question: 'How long?', suggested: 'Half a day' }] };
  const data = community({
    name: 'Geneva hike planner', is_creator: false, audience: 'invited', audience_label: 'Private community', member_count: 3,
    first_version: building({ mine: false, creator: 'ada', conversation_id: null, step: 3, line: 'plan-member', plan }),
  });
  const html = renderToHtml(createElement(page.PlanPage, { name: 'Geneva hike planner', data, onBack: () => {}, onDiscussion: () => {} }));
  assert.match(html, /<section class="dev-ws-plan" data-ws-plan-page="">/);
  assert.match(html, /aria-label="Back to Hub"/, 'a page under the Hub, with its way back');
  assert.match(html, /Homeroom bot <span class="dev-ws-plan-ai">AI<\/span>/);
  // The 7 Oct plan card ruling: the title first, then the step as one line, no bar.
  assert.match(html, /<h2 class="dev-ws-plan-title">My plan for Geneva hike planner<\/h2><p class="dev-ws-plan-step" data-ws-plan-step="">Step 3 of 7<\/p>/);
  assert.doesNotMatch(html, /dev-ws-plan-bar|width:/);
  // The owner, 7 Oct: no bullets; each line is a row of a grouped list.
  assert.match(html, /<div class="[^"]*rounded-\[20px\][^"]*" role="list" aria-label="Plan for Geneva hike planner" data-ws-plan-lines=""><div role="listitem" class="dev-ws-plan-row">A trail list<\/div><div role="listitem" class="dev-ws-plan-row">Who is coming<\/div><\/div>/);
  assert.doesNotMatch(html, /<ul|<li>/);
  assert.match(read('public/css/app.css'), /\.dev-ws-plan-row \{\s*position: relative; padding: 12px 16px;\s*font-size: 15px; line-height: 22px;/);
  assert.match(html, /<p class="dev-ws-plan-qq">How long\?<\/p><p class="dev-ws-plan-qa" data-ws-plan-suggested="">Half a day<\/p>/,
    'each question with its suggested answer, as text');
  assert.match(html, /data-ws-plan-who="">ada decides on this plan\.<\/p>/);
  assert.match(html, /data-ws-plan-discussion="">Talk about it in #general<\/button>/);
  assert.doesNotMatch(html, /Build it|Change something|data-bot-answer|aria-pressed/, 'nothing here answers it: only its maker does');
  assert.equal(page.decidesLine(null), 'The person who started it decides on this plan.');
  assert.equal(page.planStep(null, 7), null);
  assert.equal(renderToHtml(createElement(page.PlanPage, {
    name: 'x', data: community({ first_version: building() }), onBack: () => {}, onDiscussion: () => {},
  })), '', 'no plan to read (built, or not a member): nothing, and it goes back to the Hub');
  const src = read('frontend/src/features/dev-board/workshop/plan-page.tsx');
  assert.match(src, /const gone = !!data && !plan;\s*useEffect\(\(\) => \{\s*if \(gone\) onBack\(\);/);
  assert.match(LANDER, /\{tab === 'plan' \? \(\s*<PlanPage\s+name=\{community\?\.name \|\| app\.name \|\| slug\}\s+data=\{community\}\s+onBack=\{\(\) => openTab\('status'\)\}\s+onDiscussion=\{\(\) => openTab\('discussion'\)\}\s+\/>\s*\) : null\}/);
});

test('#4045: `?shot=hub-first-week` draws a made-up first week for the before/after shots', () => {
  const shot = loadTsx('frontend/src/features/dev-board/workshop/hub-shot.ts');
  assert.equal(shot.hubShot('?shot=hub-first-week'), 'creator');
  assert.equal(shot.hubShot('?shot=hub-first-week-member&ws=plan'), 'member');
  assert.equal(shot.hubShot('?shot=hub-first-week-question'), 'question');
  assert.equal(shot.hubShot('?shot=hub-first-week-link'), 'link');
  assert.equal(shot.hubShot('?shot=first-version'), null);
  assert.equal(shot.hubShot(''), null);
  const creator = shot.hubShotPayload('garden', 'creator', 0);
  assert.equal(creator.slug, 'garden', 'for whatever project the address names');
  assert.equal(creator.first_week, true);
  assert.deepEqual([creator.first_version.line, creator.first_version.waits_on, creator.is_creator, creator.can_manage], ['plan', 'plan', true, true]);
  assert.equal(creator.first_version.plan, null, 'its maker answers it in their chat');
  const member = shot.hubShotPayload('garden', 'member', 0);
  assert.deepEqual([member.first_version.line, member.first_version.waits_on, member.is_creator, member.is_member], ['plan-member', null, false, true]);
  assert.equal(member.first_version.plan.bullets.length, 4);
  assert.equal(member.first_version.plan.questions[0].suggested, 'Each runner picks their own goal');
  assert.equal(shot.hubShotPayload('garden', 'question', 0).first_version.waits_on, 'question');
  // A link is out and nobody else is in: Just you, with the link's seats.
  const link = shot.hubShotPayload('garden', 'link', 0);
  assert.deepEqual([link.audience, link.member_count, link.members.length, link.invite_link, link.is_creator], ['solo', 1, 1, true, true]);
  assert.equal(creator.invite_link, false);
  assert.equal(creator.channel.post_url, null, 'nothing behind it to post to');
  // The hub's one read answers it in place of the server's.
  assert.match(read(CARD), /const shot = hubShot\(\);\s*if \(shot\) return hubShotPayload\(slug, shot\);/);
  // The card, the plan page and the hero draw it like any other first week.
  const html = renderToHtml(createElement(hub.FirstVersionCard, { slug: 'garden', data: member }));
  assert.match(html, /data-ws-first-version-plan="">See the plan</);
});
