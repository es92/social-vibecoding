'use strict';

// The AI tab's main view (#6019 follow-up): frontend/src/features/ai/.
// Plan v3: "what needs you comes first, then your private threads, with a
// lock on the tile, then Up next: what's moving without you, soonest first.
// Ask Homeroom bot opens Main." 29 Oct 2026 (Evan): Needs you (it holds
// other people's threads too), In progress (being worked on), Up next
// (waiting on someone else), each the bot's own word where it works on the
// request; and a thread opens on this page.
//
// What this pins:
//   1. Needs you's order: the Needs you feed, the bot's plans waiting for
//      Build it, then private threads; each thread is listed once.
//   2. In progress and Up next: what goes in each, in what order, and the
//      words each row says, the bot's stages among them.
//   3. The screen's first render is the prerender: hidden, the bot's name,
//      no rows; the lists load in effects, Main is docked only after mount.
//   4. The routes: #homeroom-bot is the page, #homeroom-bot/main and
//      #homeroom-bot/thread/<id> are Main; #ai, the old address, lands there.
//   5. A thread opens beside the list in Main's place (the side panel drawn
//      as the page's column), or on its page with a way back here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const MODEL = 'frontend/src/features/ai/model.ts';
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const words = (p) => message(p.id, p.values);

const app = { slug: 'garden', name: 'Garden club', icon_url: null, icon_emoji: null };
const thread = (threadId, number, what, extra = {}) => ({
  threadId, number, kind: 'work', title: `T${threadId}`, app, change: null,
  href: `#app/garden/dev/issues/${number}`, group: 'waiting', what, at: null, ...extra,
});

test('Needs you: the feed, then the bot\'s plans waiting for Build it, then private threads, each once', () => {
  const { needsYou, needHref, owedCount } = loadTsx(MODEL);
  const needs = [
    { kind: 'proposal', id: 11, number: 403, title: 'Dark mode', app },
    { kind: 'ballot', id: 12, number: 408, title: 'A or B', app, ballot: { number: 401, title: 'Night theme' } },
    { kind: 'question', id: 13, number: 390, title: 'Which camera?', app },
    { kind: 'governance', id: 14, number: null, title: 'Rename it', app },
  ];
  const work = {
    private: [
      { rootId: 91, title: 'A calendar idea', kind: 'idea', app: null, at: null },
      { rootId: 92, title: 'Sort by date', kind: 'draft_request', app, at: null },
    ],
    needs: [
      thread(7, 410, 'plan', { group: 'needs', title: 'A reminder email' }),
      thread(8, 390, 'plan', { group: 'needs', title: 'Photos' }),
    ],
    next: [],
    waiting: [thread(5, 388, 'not_picked_up', { title: 'Print view' })],
    live: [],
  };
  const rows = needsYou(needs, work);
  assert.deepEqual(rows.map((r) => r.key), [
    'need:proposal:11', 'need:ballot:12', 'need:question:13', 'need:governance:14',
    'plan:7',
    'private:91', 'private:92',
  ], '#390 is the question owed above, so its plan is not listed again; nothing waiting on others is here');
  assert.deepEqual(rows.map((r) => r.pill && message(r.pill.id)), ['Vote', 'Pick one', 'Answer', 'Vote', 'Build it', null, null]);
  assert.equal(owedCount(rows), 5, 'the heading counts what asks for you, not your private threads');
  assert.equal(rows[1].title, 'Night theme', 'a ballot is named for the request its changes compete for');
  assert.equal(words(rows[1].sub), 'Garden club · #401');
  assert.equal(rows[1].href, '#app/garden/dev/issues/401', 'and is decided on its page');
  assert.equal(rows[0].href, '#app/garden/dev/changes/403');
  assert.equal(rows[2].href, '#app/garden/dev/issues/390');
  assert.equal(rows[3].href, '#app/garden/dev/governance/14');
  assert.equal(words(rows[3].sub), 'Garden club');
  assert.deepEqual([rows[4].title, words(rows[4].sub), rows[4].href], ['A reminder email', 'Garden club · #410', '#app/garden/dev/issues/410'],
    'a plan opens on its request, where its Build it is');
  // Private threads: a lock on the tile, and where they stand.
  assert.deepEqual([rows[5].who, words(rows[5].sub)], ['solo', 'Only you · Not in a community yet']);
  assert.deepEqual([rows[6].who, words(rows[6].sub)], ['me', 'Only you · Garden club · Not posted yet']);
  assert.equal(rows[5].rootId, 91, 'a private thread opens in Main');
  assert.equal(needHref({ kind: 'proposal', id: 1, number: 2, href: '#somewhere' }), '#somewhere', 'a card that says where it goes');
  assert.equal(needsYou(null, null).length, 0);
  assert.equal(needsYou(null, { private: [], next: [], waiting: [], live: [] }).length, 0, 'an older server, with no plans');
});

test('a long queue of votes folds to three, so the plans and private threads still show', () => {
  const { needsYou, foldWork, NEEDS_FIRST, WORK_FIRST } = loadTsx(MODEL);
  const needs = Array.from({ length: 9 }, (_, i) => ({ kind: 'proposal', id: i + 1, number: 500 + i, title: `Change ${i}`, app }));
  const work = {
    private: [
      { rootId: 91, title: 'A calendar idea', kind: 'idea', app: null, at: null },
      { rootId: 92, title: 'Sort by date', kind: 'draft_request', app, at: null },
    ],
    needs: [thread(7, 410, 'plan', { group: 'needs' })],
    next: [],
    waiting: [],
    live: [],
  };
  const rows = needsYou(needs, work);
  assert.equal(NEEDS_FIRST, 3);
  assert.deepEqual(foldWork(rows).map((r) => r.key), [
    'need:proposal:1', 'need:proposal:2', 'need:proposal:3',
    'plan:7', 'private:91', 'private:92',
  ], 'the heading counts the other six and Show more opens them');
  assert.equal(rows.length, 12, 'Show more still opens every row, in order');
  const many = { ...work, private: Array.from({ length: 12 }, (_, i) => ({ rootId: 100 + i, title: `Idea ${i}`, kind: 'idea', app: null, at: null })) };
  assert.equal(foldWork(needsYou(needs, many)).length, WORK_FIRST, 'and the fold is never longer than the first eight');
});

test('In progress and Up next each leave out a thread the feed lists, by its request or its change', () => {
  const { inProgress, upNext } = loadTsx(MODEL);
  const needs = [{ kind: 'proposal', id: 1, number: 6025, title: 'Its change', app }];
  const work = {
    private: [],
    next: [thread(1, 6036, 'fixing', { group: 'next', change: { id: 9, number: 6025 } }), thread(2, 6040, 'building', { group: 'next', by: 'bot' })],
    waiting: [thread(3, 6025, 'vote'), thread(4, 6038, 'held', { heldBy: 'approvals' })],
    live: [],
  };
  assert.deepEqual(inProgress(needs, work).map((t) => t.threadId), [2], 'its change #6025 is owed: once, in Needs you');
  assert.deepEqual(upNext(needs, work).map((t) => t.threadId), [4]);
  assert.deepEqual(upNext(null, work).map((t) => t.threadId), [3, 4]);
});

// 30 Oct 2026: the tab said "#6032" for the change Homeroom bot called
// request #6038 in Main. A change for a request goes by the request's number,
// opens on the change's own page, and still leaves out the request's thread.
test('a vote on a change for a request names the request\'s number, and opens on the change', () => {
  const { needsYou, upNext, owedKeys } = loadTsx(MODEL);
  const needs = [{ kind: 'proposal', id: 1, number: 6032, title: 'Spell out the approval rules', app, request: { number: 6038, title: 'Rule changes' } }];
  const [row] = needsYou(needs, null);
  assert.equal(words(row.sub), 'Garden club · #6038');
  assert.equal(row.href, '#app/garden/dev/changes/6032');
  assert.deepEqual([...owedKeys(needs)].sort(), ['garden#6032', 'garden#6038']);
  const work = { private: [], next: [], waiting: [thread(3, 6038, 'vote', { change: { id: 9, number: 6032 } })], live: [] };
  assert.deepEqual(upNext(needs, work), [], 'once, in Needs you');
  const [plain] = needsYou([{ kind: 'proposal', id: 2, number: 6050, title: 'No request', app }], null);
  assert.equal(words(plain.sub), 'Garden club · #6050', 'a change for no request keeps its own number');
});

test('each In progress and Up next row says what it waits on, in the bot\'s words where it is the bot\'s', () => {
  const { nextWords, heroWords } = loadTsx(MODEL);
  const row = (what, extra = {}) => ({ threadId: 1, number: 7, app, what, ...extra });
  assert.deepEqual([
    row('going_live'), row('merging'), row('fixing'), row('revising'), row('reading'),
    row('building', { by: 'bot' }), row('building', { by: 'you' }), row('building', { by: 'someone' }),
  ].map((r) => words(nextWords(r))), [
    'Garden club · #7 · Going live', 'Garden club · #7 · Merging',
    'Garden club · #7 · Homeroom bot is fixing what its tests found',
    'Garden club · #7 · Homeroom bot is following up on the replies',
    'Garden club · #7 · Homeroom bot is reading it',
    'Garden club · #7 · Homeroom bot is building it', 'Garden club · #7 · You\'re building it',
    'Garden club · #7 · Being built',
  ]);
  assert.deepEqual([
    row('vote', { myVote: 'yes' }), row('vote', { myVote: 'no' }), row('vote', { myVote: null }),
    row('fix_queued'), row('followup_queued'), row('build_queued'),
    row('held', { heldBy: 'approvals' }), row('held', { heldBy: 'daily' }), row('stalled'),
    row('queued'), row('on_hold'),
    row('not_picked_up'), row('not_picked_up', { quietDays: 10 }), row('not_picked_up', { number: null }),
  ].map((r) => words(nextWords(r))), [
    'Garden club · #7 · Waiting for votes · you voted Yes', 'Garden club · #7 · Waiting for votes · you voted No',
    'Garden club · #7 · Waiting for votes',
    'Garden club · #7 · A test failed · waiting for a free builder to fix it',
    'Garden club · #7 · Waiting for a free builder to follow up on the replies',
    'Garden club · #7 · Ready to build · waiting its turn',
    'Garden club · #7 · Ready to build · waits until a change up for a vote is decided',
    'Garden club · #7 · Ready to build · held by today\'s limit on this project',
    'Garden club · #7 · Ready to build · its build has not started',
    'Garden club · #7 · Waiting for a free builder',
    'Garden club · #7 · On hold until Monday',
    'Garden club · #7 · Nobody is building it yet',
    'Garden club · #7 · Nobody is building it yet · quiet 10 days',
    'Garden club · Nobody is building it yet',
  ], 'a row with no number (a decision) says no "#"');
  // 30 Oct 2026: a decision up for a vote waits for votes, not a builder.
  assert.deepEqual([
    row('decision', { number: null, myVote: null }), row('decision', { number: null, myVote: 'yes' }),
    row('decision', { number: null, myVote: 'no' }),
  ].map((r) => words(nextWords(r))), [
    'Garden club · Waiting for votes', 'Garden club · Waiting for votes · you voted Yes',
    'Garden club · Waiting for votes · you voted No',
  ]);
  assert.equal(message('messages:ai.next.title'), 'In progress');
  assert.equal(message('messages:ai.up.title'), 'Up next');
  assert.equal(words(heroWords(2, 3)), 'Needs you: 2 · In progress: 3');
  assert.equal(words(heroWords(0, 3)), 'In progress: 3');
});

test('the server: a vote you have given waits on others (Up next), and the bot\'s stage decides where its requests go', () => {
  const aiWork = require('../src/services/ai-work');
  const now = new Date('2026-10-29T12:00:00Z');
  const at = '2026-10-29T10:00:00.000Z';
  const ME = 5;
  const open = { state: 'open', own: true, request_state: 'open', request_at: at, created_at: at };
  assert.deepEqual(aiWork.standing({ ...open, change_status: 'promoted', change_user: 9, voted: true, my_vote: 'yes', promoted_at: at }, ME, now),
    { group: 'waiting', what: 'vote', at, myVote: 'yes' });
  const bot = (stage, extra = {}) => aiWork.standing(open, ME, now, null, { stage, since: at, ...extra });
  assert.deepEqual(bot('plan'), { group: 'needs', what: 'plan', at }, 'a plan waiting for Build it is Needs you\'s');
  assert.equal(bot('question'), null, 'the bot\'s question is the feed\'s Answer');
  assert.deepEqual(bot('held', { capSuppressed: 'proposals_per_app' }), { group: 'waiting', what: 'held', at, heldBy: 'approvals' },
    'held back until a change up for a vote is decided, as the bot says in Main');
  assert.equal(bot('held', { capSuppressed: 'daily_notes' }).heldBy, 'daily');
  assert.deepEqual(bot('build_queued'), { group: 'waiting', what: 'build_queued', at });
  assert.deepEqual(bot('queued'), { group: 'waiting', what: 'queued', at }, 'not "Not picked up yet": it is in the bot\'s queue');
  assert.deepEqual(bot('reading'), { group: 'next', what: 'reading', at });
  assert.deepEqual(bot('planning'), { group: 'next', what: 'building', by: 'bot', at });
  assert.deepEqual(bot('fix_queued'), { group: 'waiting', what: 'fix_queued', at });
  assert.deepEqual(bot('fixing'), { group: 'next', what: 'fixing', at });
  assert.deepEqual(aiWork.standing({ ...open, change_status: 'merging', merged_at: at }, ME, now, null, { stage: 'merging' }),
    { group: 'next', what: 'merging', at }, 'where its change says it, the change speaks');
  assert.equal(aiWork.standing({ ...open, state: 'closed' }, ME, now, null, { stage: 'plan' }), null, 'never on a closed thread');
  assert.deepEqual(aiWork.standing(open, ME, now), { group: 'waiting', what: 'not_picked_up', at, quietDays: 0 },
    'nobody building it, and not the bot\'s');
  // A decision up for a vote waits for votes; one whose vote is owed is the feed's.
  const decision = { state: 'open', own: true, kind: 'decision', number: null, created_at: at, decision_status: 'open' };
  assert.deepEqual(aiWork.standing({ ...decision, decision_mine: true }, ME, now), { group: 'waiting', what: 'decision', at, myVote: null });
  assert.deepEqual(aiWork.standing({ ...decision, decision_vote: 'yes' }, ME, now), { group: 'waiting', what: 'decision', at, myVote: 'yes' });
  assert.equal(aiWork.standing(decision, ME, now), null, 'a vote she owes is Needs you\'s');
  assert.equal(aiWork.standing({ ...decision, own: false, decision_vote: 'yes' }, ME, now), null, 'one she only voted on');
  assert.equal(aiWork.standing({ ...decision, decision_mine: true, decision_status: 'applied' }, ME, now), null, 'decided');
  // Every stage the bot words a request at (homeroom-bot-progress.js
  // STEP_OF_STAGE) has a list here, but those its change says as well.
  const progress = read('src/services/homeroom-bot-progress.js');
  const block = progress.slice(progress.indexOf('const STEP_OF_STAGE = Object.freeze({'));
  const stages = [...block.slice(0, block.indexOf('});')).matchAll(/^\s+(\w+): '/gm)].map((m) => m[1]);
  assert.ok(stages.length > 15, 'the stages were read');
  for (const stage of stages) {
    if (['setting_up', 'checks', 'checks_failed', 'vote', 'merging'].includes(stage)) continue;
    assert.ok(Object.prototype.hasOwnProperty.call(aiWork.BOT_STANDING, stage), `the bot's stage ${stage} has a list`);
  }
});

test('the server arranges Up next nearest to live first, and matches the bot\'s stages by request', () => {
  const aiWork = require('../src/services/ai-work');
  const now = new Date('2026-10-29T12:00:00Z');
  const row = (id, number, extra = {}) => ({
    id, number, kind: 'work', state: 'open', own: true, slug: 'garden', name: 'Garden club',
    request_title: `R${number}`, request_state: 'open', request_at: `2026-10-2${id}T00:00:00Z`, created_at: '2026-10-20T00:00:00Z', ...extra,
  });
  const bots = new Map([
    ['garden#6014', { stage: 'held', since: '2026-10-29T01:00:00Z', capSuppressed: 'proposals_per_app' }],
    ['garden#6002', { stage: 'plan', since: '2026-10-29T02:00:00Z' }],
  ]);
  const lists = aiWork.arrange([
    row(1, 6038),
    row(2, 6014),
    row(3, 6002),
    row(4, 6025, { change_status: 'promoted', change_user: 9, voted: true, my_vote: 'yes', promoted_at: '2026-10-29T03:00:00Z', change_id: 1, pr_number: 6025 }),
  ], 5, now, null, bots);
  assert.deepEqual(lists.needs.map((t) => t.number), [6002], 'the plan waiting for Build it');
  assert.deepEqual(lists.waiting.map((t) => `${t.number}:${t.what}`), ['6025:vote', '6014:held', '6038:not_picked_up']);
  assert.deepEqual(lists.next, []);
});

test('Needs you here is the threads you are in, counted in the label\'s ink, with no link to every vote', () => {
  const src = read('frontend/src/features/ai/index.tsx');
  assert.match(src, /readJson<\{ items\?: NeedItem\[\] \}>\(`\/api\/workshop\/needs-feed\?in=threads\$\{qs \? '&demo=1' : ''\}`\)/);
  assert.match(src, /<SecHead>\s+\{owed \? t\('messages:ai\.work\.titleCount', \{ count: owed \}\) : t\('messages:ai\.work\.title'\)\}\s+<\/SecHead>/,
    'the count is in the label\'s own words and ink, not the accent a link wears');
  assert.ok(!src.includes('ws=needs#communities'), 'All votes is gone');
  assert.equal(message('messages:ai.work.title'), 'Needs you');
  assert.equal(message('messages:ai.work.titleCount', { count: 5 }), 'Needs you · 5');
  const route = read('src/routes/workshop-overview.js');
  assert.match(route, /pool\.query\(req\.query\.in === 'threads' \? NEEDS_FEED_IN_THREADS_SQL : NEEDS_FEED_SQL, \[/);
  const { NEEDS_FEED_SQL, NEEDS_FEED_IN_THREADS_SQL } = require('../src/routes/workshop-overview');
  assert.match(NEEDS_FEED_IN_THREADS_SQL, /AND \(o\.kind = 'question'\s+OR \(o\.thread_id IN \(SELECT mine\.thread_id FROM/, 'the bot\'s questions to you show wherever they are');
  assert.match(NEEDS_FEED_IN_THREADS_SQL, /f\.muted_at IS NOT NULL/, 'not a thread you muted');
  assert.ok(!NEEDS_FEED_SQL.includes('thread_followers f'), 'Communities › Needs you keeps every decision owed');
  // The most rows are not spent on threads that are never listed, and Live
  // this week has its own, apart from the rest, their own first (30 Oct 2026).
  const { THREADS_SQL } = require('../src/services/ai-work');
  assert.match(THREADS_SQL, /AND \(mine\.own OR ch\.status IS NULL OR ch\.status = 'merged' OR ch\.user_id = \$1\)/);
  assert.match(THREADS_SQL, /AND \(t\.state = 'open' OR \(t\.closed_at > NOW\(\) - make_interval\(days => \$5\) AND ch\.status = 'merged'\)\)/,
    'a closed thread is read only for its merged change');
  assert.match(THREADS_SQL, /PARTITION BY COALESCE\(ch\.status = 'merged', FALSE\)\s+ORDER BY mine\.own DESC,/);
  assert.match(THREADS_SQL, /\) listed\s+WHERE place <= \$4/);
  // The feed names a change's request, which the rows above go by.
  const { shapeNeedsFeed } = require('../src/routes/workshop-overview');
  const base = { kind: 'proposal', id: 1, title: 'Its change', number: 6032, slug: 'garden', name: 'Garden club' };
  assert.deepEqual(shapeNeedsFeed([{ ...base, ballot_for: { number: 6038, title: 'Rule changes' } }])[0].request,
    { number: 6038, title: 'Rule changes' });
  assert.equal(shapeNeedsFeed([base])[0].request, undefined, 'a change for no request has none');
});

test('the first render is the prerender: hidden, the bot\'s name, no rows; lists in effects', () => {
  const src = read('frontend/src/features/ai/index.tsx');
  assert.match(src, /id="ai-screen"\s+className="hidden flex-1 overflow-y-auto platform-safe-scroll"/);
  assert.match(src, /useVisibilityHiddenClass\(screenRef, 'ai-screen', false\);/);
  // Data only once the screen is shown to somebody signed in.
  assert.match(src, /if \(!visible \|\| typeof window === 'undefined' \|\| !\(window as any\)\.App\?\.user\) return undefined;/);
  assert.match(src, /readJson<AiWork>\(`\/api\/ai\/work\$\{qs\}`\)/);
  // Main docked beside it only on a wide window, after mount.
  assert.match(src, /const \[wide, setWide\] = useState\(false\);/);
  assert.match(src, /\{docked \? \(\s*<aside id="ai-main-pane" ref=\{mainRef\} className="ai-main-pane"/);
  assert.match(src, /<EmbeddedConversation conversationId=\{botId!\} active=\{visible\} at=\{at\} \/>/);
  // Ask Homeroom bot opens Main; a private thread opens in it.
  assert.match(src, /<a href="#homeroom-bot\/main" className="messages-composer-card ai-askbar-card"/);
  assert.match(src, /else go\(`#homeroom-bot\/thread\/\$\{row\.rootId\}`\);/);
});

test('a page drawn before sign-in is confirmed asks again once it is, and its Ask bar starts at the rail', () => {
  const src = read('frontend/src/features/ai/index.tsx');
  // app.js announces the signed-in viewer with sv:session, on a saved-session
  // boot and again once the server confirms it; both reads and the docked
  // chat go again then, instead of staying empty until a reload.
  assert.match(src, /const again = \(\) => setSession\(\(n\) => n \+ 1\);\s+document\.addEventListener\('sv:session', again\);\s+return \(\) => document\.removeEventListener\('sv:session', again\);/);
  assert.match(src, /return \(\) => \{ live = false; \};\s+\}, \[visible, session\]\);/);
  assert.match(src, /\}, \[visible, wide, botId, session\]\);/);
  assert.match(read('public/js/app.js'), /document\.dispatchEvent\(new CustomEvent\('sv:session', \{\s+detail: \{ user: App\.user, verifiedSession: true \},/,
    'the confirmation it waits for');
  // A wide window whose Main is not docked (yet, or at all) keeps the bar
  // on the page, clear of the sidebar.
  assert.match(read('public/css/app.css'), /#ai-screen \.ai-askbar \{\s+position: fixed;\s+(\/\*[^*]*\*+([^/*][^*]*\*+)*\/\s+)?left: calc\(var\(--platform-rail-w, 0px\) \+ var\(--platform-gutter, 0px\)\);\s+right: var\(--platform-gutter, 0px\);/);
});

test('#homeroom-bot is the page; /main and /thread/<id> are Main, on the Messages screen; #ai lands there', () => {
  const app = read('public/js/app.js');
  assert.match(app, /if \(parts\[1\] !== 'main' && parts\[1\] !== 'thread'\) \{\s+App\.navigateToAi\(\);\s+return;\s+\}/);
  assert.match(app, /case 'homeroom-bot':\s+case 'ai': return \['main', 'thread'\]\.includes\(frag\.split\('\/'\)\[1\]\)\s+\? 'messages-screen'[^\n]*\n\s+: 'ai-screen';/);
  // The old address is an alias: rewritten in place, then routed as the new one.
  assert.match(app, /if \(parts\[0\] === 'ai'\) \{[\s\S]*?history\.replaceState\(null, '', '#homeroom-bot' \+ \(parts\.length > 1 \? '\/' \+ parts\.slice\(1\)\.join\('\/'\) : ''\)\);[\s\S]*?parts\[0\] = 'homeroom-bot';\s+\}\s+if \(parts\[0\] === 'homeroom-bot'\) \{/);
  const store = read('frontend/src/features/messages/store.ts');
  // Main's arrow goes back to the page, and the inbox's drawer is not its.
  assert.match(store, /if \(botOnShow\(\) && !\(isMobile\(\) && state\.route\.threadRootId\)\) \{\s+app\.setBackIcon\?\.\('arrow', '#homeroom-bot'\);/);
  assert.match(read('frontend/src/features/nav-drawer/messages-drawer.ts'), /if \(at\.conversationId && at\.bot\) return false;/);
});

test('the screen renders as the prerender does: hidden, the bot\'s name, Needs you, the Ask bar, no rows', () => {
  const { renderComponent } = require('./lib/render-tsx');
  const html = renderComponent('frontend/src/features/ai/index.tsx', 'AiScreen', {});
  // (React hoists the bot's picture as an image preload ahead of it.)
  assert.match(html, /^(<link rel="preload" as="image" href="\/brand\/homeroom-mark\.png"\/>)?<main id="ai-screen" class="hidden flex-1 overflow-y-auto platform-safe-scroll" data-page-bounce=""/);
  assert.match(html, /<h1 class="[^"]*">Homeroom bot<\/h1>/);
  assert.match(html, /Needs you/);
  assert.match(html, /<a href="#homeroom-bot\/main" class="messages-composer-card ai-askbar-card" aria-label="Ask Homeroom bot">/);
  assert.ok(!html.includes('data-ai-row'), 'no rows before the effects read them');
  assert.ok(!html.includes('data-ai-main'), 'and Main is not docked before mount');
});

test('a thread opens on this page: beside the list in Main\'s place, or on its page with a way back here', () => {
  const src = read('frontend/src/features/ai/index.tsx');
  assert.match(src, /<aside id="ai-main-pane" ref=\{mainRef\} className="ai-main-pane" aria-labelledby="ai-main-title" data-ai-main="">\s+<SidePanelDivider [^>]*\/>\s+<header className="ai-main-head" data-ai-main-head="">/);
  assert.match(src, /<span id="ai-main-title"[^>]*>\s+\{t\('messages:store\.header\.main'\)\}/);
  assert.match(src, /\{t\('messages:ai\.main\.sub'\)\}/);
  assert.equal(message('messages:ai.main.sub'), 'Your chat with Homeroom bot. Only you can see it.');
  // The panel takes it wherever it can (a wide window), with the row's project; its page otherwise.
  assert.match(src, /if \(sidePanel\(\)\?\.take\?\.\(href\.replace\(\/\^#\/, ''\), \{ place: app \}\)\) return;/);
  assert.match(src, /if \(isTopicHref\(href\)\) improve\(\)\?\.enterTopicFrom\?\.\(BOT_PAGE\);\s+go\(href\);/,
    'a topic page opened from here goes back here');
  assert.match(src, /const BOT_PAGE = '#homeroom-bot';/);
  assert.equal((src.match(/onClick=\{\(\) => openPublic\(row\.href, row\.app\)\}/g) || []).length, 2, 'In progress and Up next, and Live this week');
  assert.match(src, /openPublic\(row\.href, row\.app\);\s+\};/, 'and Needs you');
  const { isTopicHref } = loadTsx(MODEL);
  assert.equal(isTopicHref('#app/garden/dev/issues/12'), true);
  assert.equal(isTopicHref('#app/garden/dev/changes/12'), true);
  assert.equal(isTopicHref('#app/garden/dev/governance/3'), true);
  assert.equal(isTopicHref('#app/garden/workshop'), false, 'a Workshop is no topic: the origin would wait for the next one');
  // A private thread is Main's: the panel gives its place back first.
  assert.match(src, /sidePanel\(\)\?\.close\?\.\(\);\s+setAt\(\{ threadRootId: row\.rootId, focusMessageId: null \}\);/);
  // The panel may stand beside the AI tab's page, and stays while it is up.
  const controller = read('frontend/src/features/side-panel/controller.ts');
  assert.match(controller, /const besideAi = typeof A\._isScreenVisible === 'function' && A\._isScreenVisible\('ai-screen'\);/);
  assert.match(read('public/js/app.js'), /appPresence\?\.\(\(inApp \|\| screen === 'ai-screen'\) && !App\.chromeless\)/);
  // Opened from here on its page, it is still this tab's.
  const app = read('public/js/app.js');
  assert.match(app, /_isBotTopic\(\) \{\s+if \(!\(App\.currentTab === 'dev' && App\.currentSubTab === 'topic'\)\) return false;\s+const origin = window\.Improve\?\.topicOrigin\?\.\(\);/);
  assert.match(app, /\(App\._isMessagesThread\(\) \? 'messages' : App\._isBotTopic\(\) \? 'ai' : 'workshop'\)/, 'it keeps Homeroom bot lit');
});

test('beside this page the panel is the page\'s own column: ‹ Main and the project, no Expand, Close or Back', () => {
  const panel = read('frontend/src/features/side-panel/side-panel.tsx');
  assert.match(panel, /<button\s+type="button"\s+className="side-panel-main dev-topic-back un-touch-target"\s+aria-label=\{t\('agent:sidePanel\.mainLabel'\)\}\s+onClick=\{\(\) => controller\.close\(\)\}\s+>/,
    '‹ Main gives Main its place back, in the topic\'s own chip');
  assert.match(panel, /<PanelPlace route=\{s\.route\} place=\{s\.place\} reported=\{s\.reported\} \/>/);
  assert.match(panel, /href=\{`#app\/\$\{encodeURIComponent\(slug\)\}\/workshop`\}/, 'the project, as a door to its page');
  assert.match(panel, /\(window as any\)\.AppView\?\._landOnHub\?\.\(slug\)/, 'which opens on its Hub');
  assert.equal(message('agent:sidePanel.main'), 'Main');
  const controller = read('frontend/src/features/side-panel/controller.ts');
  assert.match(controller, /export const BESIDE_AI_CLASS = 'side-panel-beside-ai';/);
  assert.match(controller, /classList\.toggle\(BESIDE_AI_CLASS, isBesideAi\(\)\)/);
  assert.match(controller, /const \{ place = null, \.\.\.rest \} = given \|\| \{\};/, 'the project is this document\'s, not the page\'s hint');
  const css = read('public/css/app.css');
  assert.match(css, /body:has\(#ai-screen:not\(\.hidden\)\) \.side-panel :is\(#side-panel-back, #side-panel-title, #side-panel-expand, #side-panel-close\) \{\s+display: none;\s+\}/,
    'the panel\'s controls go, but not its left edge, the handle Main\'s edge is too');
  assert.match(css, /body:has\(#ai-screen:not\(\.hidden\)\) \.side-panel :is\(\.side-panel-main, \.side-panel-place\) \{ display: inline-flex; \}/);
  assert.match(css, /\.side-panel-head > :is\(\.side-panel-main, \.side-panel-place\) \{ display: none; \}/, 'and beside an app, as it was');
  assert.match(css, /html\.in-side-panel\.side-panel-beside-ai :is\(\.dev-topic-backs, \.dev-topic-back\) \{ display: none; \}/,
    'and the page in it leaves out its own "‹ Workshop"');
});

test('Main\'s column is held inside the window, and the panel takes its place at its width', () => {
  const css = read('public/css/app.css');
  // A width chosen beside an app on a wide monitor must not run Main under
  // the rail; with none chosen, Main takes the room the list does not need
  // (30 Oct 2026), 400px to 720px.
  assert.match(css, /body:has\(#ai-screen:not\(\.hidden\)\) \{\s+--ai-main-auto: clamp\(400px, calc\(100vw - var\(--platform-rail-w, 0px\) - 720px\), 720px\);\s+--ai-main-w: max\(320px, min\(var\(--side-panel-chosen-w, var\(--ai-main-auto\)\), calc\(100vw - var\(--platform-rail-w, 0px\) - 480px\)\)\);\s+\}/);
  assert.match(css, /#ai-screen\[data-ai-docked\] \{ padding-right: var\(--ai-main-w\); \}/);
  assert.match(css, /#ai-screen \.ai-main-pane \{[^}]*width: var\(--ai-main-w\);/);
  assert.match(css, /#ai-screen \.ai-main-pane > \.messages-layout \{ flex: 1 1 auto; height: auto; min-height: 0; \}/);
  assert.match(css, /html\[data-side-panel\] #ai-screen \.ai-main-pane \{ display: none; \}/);
  assert.match(css, /@media \(min-width: 1024px\) \{\s+html\[data-side-panel\] #ai-screen \{ padding-right: var\(--ai-main-w\); \}\s+\}/);
  assert.match(css, /body:has\(#ai-screen:not\(\.hidden\)\) \.side-panel \{\s+width: var\(--ai-main-w\);/, 'so the list does not move');
  // 30 Oct 2026: Main's left edge is the side panel's handle, and sets the same width.
  const src = read('frontend/src/features/ai/index.tsx');
  assert.match(src, /import \{ SidePanelDivider \} from '\.\.\/side-panel\/side-panel';/);
  assert.match(src, /<aside id="ai-main-pane" ref=\{mainRef\} className="ai-main-pane"[^>]*>\s+<SidePanelDivider panelRef=\{mainRef\} shown=\{docked\} id="ai-main-divider" controls="ai-main-pane" \/>/);
  assert.match(read('frontend/src/features/side-panel/side-panel.tsx'), /export function SidePanelDivider\(\{\s+panelRef,\s+shown,\s+id = 'side-panel-divider',\s+controls = 'platform-side-panel',/);
});

test('the tab says Homeroom bot: a wide seat on a phone, two lines in the Duo column', () => {
  assert.equal(message('core:tabs.ai'), 'Homeroom bot');
  const css = read('public/css/app.css');
  // Measured in the bar's font: 79px of label in an 83-87px seat at 375-390, 76 in 80 at 360.
  assert.match(css, /#platform-tabs \{ grid-template-columns: 1fr 1\.3fr 1\.3fr 1fr 1fr; \}/,
    'Communities, second, and Homeroom bot, third, take the wide seats');
  assert.match(css, /#platform-tabs \{ grid-template-columns: 1fr 1\.2fr 1\.2fr 1fr 1fr; \}/, 'a little less on the smallest phones');
  assert.match(css, /:is\(#platform-tab-workshop, #platform-tab-ai\) \.platform-tab-label \{\s+letter-spacing: -\.02em;\s+overflow: visible;\s+text-overflow: clip;\s+\}/,
    'tightened and let out of the cell rather than cut');
  assert.match(css, /html\[data-side-strip\] #platform-tab-ai \.platform-tab-label \{\s+font-size: 9\.5px;\s+letter-spacing: -\.02em;\s+line-height: 1\.05;\s+white-space: normal;\s+text-align: center;\s+\}/,
    'the Duo column: "Homeroom" over "bot"');
});
