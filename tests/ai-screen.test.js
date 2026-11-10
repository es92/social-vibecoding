'use strict';

// The AI tab's main view (#6019 follow-up): frontend/src/features/ai/.
// Plan v3: "what needs you comes first, then your private threads, with a
// lock on the tile, then Up next: what's moving without you, soonest first.
// Ask Homeroom bot opens Main." 29 Oct 2026 (Evan): Needs you (it holds
// other people's threads too), In progress (being worked on), Waiting (on
// someone else; "Up next" until 30 Oct), each the bot's own word where it
// works on the request; and a thread opens on this page. 30 Oct 2026: one
// line a row, grouped by project, with chips to narrow them (./lists.tsx;
// the three projects that need you most and a More for the rest); on a
// phone the list and Main Chat are one drawer; Homeroom bot's status answer
// reads the same lists.
//
// What this pins:
//   1. Needs you's order: the Needs you feed, the bot's plans waiting to be
//      reviewed and the requests it handed back (Needs Reply, Restart
//      build), then private threads; each thread is listed once.
//   2. In progress and Waiting: what goes in each, in what order, and the
//      words each row says, the bot's stages and claims among them.
//   3. The screen's first render is the prerender: hidden, the bot's name,
//      no rows; the lists load in effects, Main is docked only after mount.
//   4. The routes: #homeroom-bot is the page, #homeroom-bot/main and
//      #homeroom-bot/thread/<id> are Main and a thread in its column (1 Nov
//      2026: never the Messages screen); #ai, the old address, lands there,
//      and so does a Messages address of the bot's chat (./door.ts).
//   5. A request, a change or a decision opens beside the list in Main's
//      place (the side panel drawn as the page's column), or on its page
//      with a way back here. 1 Nov 2026: Main Chat is the list's first row;
//      the column is docked from 768px and holds Main or one thread, alone,
//      and the row of whichever it is is lit.
//   6. While the page is up, its lists are read again when a thread they
//      list moves (./live.ts): which socket events count, one read a burst,
//      none while the browser tab is hidden.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const MODEL = 'frontend/src/features/ai/model.ts';
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
// A phrase's nested phrases (a stage's words inside a row's line) are said first.
const words = (p) => message(p.id, {
  ...p.values,
  ...Object.fromEntries(Object.entries(p.nested || {}).map(([k, q]) => [k, words(q)])),
});

const app = { slug: 'garden', name: 'Garden club', icon_url: null, icon_emoji: null };
// 5 Nov 2026: a row carries its stored work state (lib/work-state.ts). The
// tests below name a row by the old shorthand for it, mapped here to the
// stage, why, reason and line it is now.
const WORK = {
  plan: { stage: 'waiting_for_you', why: 'plan' },
  decide: { stage: 'waiting_for_you', why: 'decide' },
  already_works: { stage: 'waiting_for_you', why: 'already_works' },
  build_stopped: { stage: 'stopped', reason: 'build_failed' },
  fix_stopped: { stage: 'stopped', reason: 'fix_stopped' },
  going_live: { stage: 'going_live' },
  fixing: { stage: 'building', line: { code: 'fixing' } },
  revising: { stage: 'building', line: { code: 'revising' } },
  building: { stage: 'building' },
  reading: { stage: 'reading' },
  reading_reply: { stage: 'reading', line: { code: 'reply' } },
  vote: { stage: 'up_for_vote' },
  checking: { stage: 'checking' },
  update_queued: { stage: 'up_for_vote', line: { code: 'update_queued' } },
  build_queued: { stage: 'building', line: { code: 'queued' } },
  held: { stage: 'building', line: { code: 'held_waiting' } },
  held_turn: { stage: 'building', line: { code: 'held_builds' } },
  stalled: { stage: 'stopped', reason: 'stalled' },
  queued: { stage: 'reading', line: { code: 'queued' } },
  retrying_plan: { stage: 'planning', line: { code: 'retry_plan' } },
  on_hold: { stage: 'reading', line: { code: 'on_hold' } },
  not_picked_up: { stage: 'reading', line: { code: 'waiting' } },
  not_read: { stage: 'reading', line: { code: 'waiting' } },
  operator: { stage: 'reading', line: { code: 'waiting' } },
  needs_person: { stage: 'waiting_for_you', why: 'decide' },
  nothing_to_build: { stage: 'waiting_for_you', why: 'needs_detail' },
  awaiting_plan: { stage: 'planning', line: { code: 'planning_with_you' } },
  live: { stage: 'live' },
  closed: { stage: 'closed' },
};
const thread = (threadId, number, what, extra = {}) => {
  const { work: given, ...rest } = extra;
  return {
    threadId, number, kind: 'work', title: `T${threadId}`, app, change: null,
    href: `#app/garden/dev/issues/${number}`, group: 'waiting', at: null,
    work: { why: null, reason: null, line: null, since: null, ...(WORK[what] || { stage: what }), ...(given || {}) },
    ...rest,
  };
};

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
  assert.deepEqual(rows.map((r) => r.pill && message(r.pill.id)), ['Vote', 'Choose a version', 'Needs Reply', 'Vote', 'Review plan', null, null]);
  assert.equal(owedCount(rows), 5, 'the heading counts what asks for you, not your private threads');
  // B17: on a project that is just yours, your yes alone approves it, and
  // the row says so as its card and the project's Needs you do.
  const [solo] = needsYou([{ kind: 'proposal', id: 21, number: 5, title: 'Darker header', app, approve: true }], null);
  assert.equal(message(solo.pill.id), 'Approve');
  const [ruleOnly] = needsYou([{ kind: 'governance', id: 22, number: null, title: 'Rename it', app, approve: true }], null);
  assert.equal(message(ruleOnly.pill.id), 'Vote', 'only a change is approved alone');
  assert.equal(rows[1].title, 'Night theme', 'a ballot is named for the request its changes compete for');
  assert.equal(words(rows[1].sub), 'Garden club · #401');
  assert.equal(rows[1].href, '#app/garden/dev/issues/401', 'and is decided on its page');
  assert.equal(rows[0].href, '#app/garden/dev/changes/403');
  assert.equal(rows[2].href, '#app/garden/dev/issues/390');
  assert.equal(rows[3].href, '#app/garden/dev/governance/14');
  assert.equal(words(rows[3].sub), 'Garden club');
  assert.deepEqual([rows[4].title, words(rows[4].sub), rows[4].href],
    ['A reminder email', 'Garden club · #410 · Waiting for you to OK the plan', '#app/garden/dev/issues/410'],
    'the row says its stage in the words every screen uses');
  // #6210 (3 Nov 2026): its Build it is on the plan on the request's page,
  // so the row opens that page, as a Vote or Needs Reply row for it
  // would. B06's way to Main Chat at the plan is gone.
  assert.equal(rows[4].plan, undefined);
  const index = read('frontend/src/features/ai/index.tsx');
  assert.doesNotMatch(index, /openBotRequest/, 'no row opens Main Chat at a plan');
  assert.match(index, /const openRow = \(row: WorkRow\) => \{\s+markThreadRead\(row\.threadId, row\.app\);\s+if \(row\.rootId\) \{\s+openPrivate\(row\.rootId\);\s+return;\s+\}\s+openPage\(row\.href, row\.app, row\.title, aboutRow\(row\)\);\s+\};/,
    'every other row opens its own page, and opening it clears what is new');
  // Private threads: a lock on the tile, and where they stand.
  assert.deepEqual([rows[5].who, words(rows[5].sub)], ['solo', 'Only you · Not in a community yet']);
  assert.deepEqual([rows[6].who, words(rows[6].sub)], ['me', 'Only you · Garden club · Not posted yet']);
  assert.equal(rows[5].rootId, 91, 'a private thread opens in Main');
  assert.equal(needHref({ kind: 'proposal', id: 1, number: 2, href: '#somewhere' }), '#somewhere', 'a card that says where it goes');
  assert.equal(needsYou(null, null).length, 0);
  assert.equal(needsYou(null, { private: [], next: [], waiting: [], live: [] }).length, 0, 'an older server, with no plans');
});

test('each section groups its rows by project, and a project shows its first few before its own Show more', () => {
  const { needsYou, byProject, GROUP_FIRST } = loadTsx(MODEL);
  const games = { slug: 'games', name: 'Game corner', icon_url: null, icon_emoji: '🎮' };
  const needs = [
    { kind: 'proposal', id: 1, number: 500, title: 'Change 0', app },
    { kind: 'proposal', id: 2, number: 600, title: 'Score board', app: games },
    { kind: 'proposal', id: 3, number: 501, title: 'Change 1', app },
  ];
  const work = {
    private: [{ rootId: 91, title: 'A calendar idea', kind: 'idea', app: null, at: null }],
    needs: [thread(7, 410, 'plan', { group: 'needs' })],
    next: [], waiting: [], live: [thread(8, 411, 'live', { group: 'live', app: games })],
  };
  const rows = needsYou(needs, work);
  const groups = byProject(rows);
  assert.deepEqual(groups.map((g) => [g.app && g.app.slug, g.items.map((r) => r.key)]), [
    ['garden', ['need:proposal:1', 'need:proposal:3', 'plan:7']],
    ['games', ['need:proposal:2']],
    [null, ['private:91']],
  ], 'under each project once, in the order the projects first come; a private idea in no project apart');
  assert.deepEqual({ ...GROUP_FIRST }, { needs: 5, busy: 3, live: 3 }, 'Needs you shows the most: it is what you came for');
  const lists = read('frontend/src/features/ai/lists.tsx');
  // 1 Nov 2026: the row whose chat is in the column is never folded away:
  // past the first rows, it joins them. #6245: only while the group is
  // folded (open ? -1): an opened group keeps every row's own place.
  assert.match(read(MODEL), /const litAt = open \? -1 : items\.findIndex\(\(row\) => row\.lit\);/);
  // #6262: Needs you orders its rows with the new ones first, before the
  // drawn order is held, then folds through the same pure rule (which never
  // hides a fresh row either).
  assert.match(lists, /const ordered = freshStyle \|\| foldFresh \? freshFirst\(lines\) : lines;/);
  assert.match(lists, /const held = hold && holding && drawn\.current \? holdOrder\(ordered, drawn\.current\) : ordered;/,
    'the new first, then the drawn order held');
  assert.match(lists, /const \{ items, shown, hidden \} = groupRows\(dayHeads \? byDay\(g\.items\) : g\.items, first, open, !foldFresh\);/,
    'the group draws through the pure order rule');
  // 6 Nov 2026: the drawn rows carry their day divider, and the fold splits
  // the same drawn list (a day past the fold stays inside it).
  assert.match(lists, /const visible = hidden \? drawn\.slice\(0, shown\) : drawn;/);
  assert.match(lists, /const folded = hidden \? drawn\.slice\(shown\) : \[\];/);
  assert.match(lists, /aria-hidden=\{open \? undefined : true\}\s+inert=\{!open\}/, 'the folded rest is out of reach until it opens');
  assert.match(lists, /\{g\.app \? <SmallTile app=\{g\.app\} size="head" \/> : <LockIcon className="h-4 w-4 shrink-0" aria-hidden="true" \/>\}/);
  assert.equal(message('messages:ai.short.private'), 'Only you', 'the heading over private ideas in no project');
  assert.match(lists, /right: row\.pill \? say\(row\.pill\)! : row\.app \? t\('messages:ai\.short\.private'\) : '',/,
    'B07: a private idea under that heading does not say Only you again on its row');
  // One project picked: its chip names it, so its name is not said again.
  assert.match(lists, /const heads = picked\.length !== 1;/);
});

// #6245 (4 Nov 2026, Evan): pressing a row past a project's first five slid
// it up to sixth place while its page opened, because the group lifted the
// row you are on even when Show more had opened every row.
test('#6245: a row pressed in an opened group keeps its place, and a live refresh cannot slide it', () => {
  const { groupRows, holdOrder, GROUP_FIRST } = loadTsx(MODEL);
  // Eight rows, the seventh is where you are.
  const rows = Array.from({ length: 8 }, (_, i) => ({ key: `need:proposal:${i + 1}`, lit: i === 6 }));
  // Folded: the row you are on still joins the first five (where you are is
  // never hidden), and the rest folds under Show more.
  const folded = groupRows(rows, GROUP_FIRST.needs, false);
  assert.deepEqual(folded.items.map((r) => r.key), [
    'need:proposal:1', 'need:proposal:2', 'need:proposal:3', 'need:proposal:4', 'need:proposal:5',
    'need:proposal:7', 'need:proposal:6', 'need:proposal:8',
  ], 'folded, the row you are on joins the first five');
  assert.deepEqual([folded.shown, folded.hidden], [6, 2]);
  // Opened: every row keeps its own place, so the pressed row stays seventh.
  const open = groupRows(rows, GROUP_FIRST.needs, true);
  assert.deepEqual(open.items.map((r) => r.key), rows.map((r) => r.key), 'opened, the pressed row stays where it was');
  assert.deepEqual([open.shown, open.hidden], [5, 3]);

  // The drawn order holds while the person is on the list: existing rows
  // keep their place, a new one joins below them, and one that left drops.
  const drawn = ['a', 'b', 'c', 'd'];
  assert.deepEqual(
    holdOrder([{ key: 'c' }, { key: 'x' }, { key: 'a' }, { key: 'd' }, { key: 'b' }], drawn).map((r) => r.key),
    ['a', 'b', 'c', 'd', 'x'],
    'the drawn order, then what arrived, in its own order');
  assert.deepEqual(holdOrder([{ key: 'a' }, { key: 'c' }], drawn).map((r) => r.key), ['a', 'c'],
    'a row that no longer needs you goes at once');
  assert.deepEqual(holdOrder([], drawn), [], 'an emptied list holds nothing');

  const lists = read('frontend/src/features/ai/lists.tsx');
  assert.match(lists, /const held = hold && holding && drawn\.current \? holdOrder\(ordered, drawn\.current\) : ordered;/,
    'only Needs you holds its order, only while held');
  assert.match(lists, /onPointerEnter=\{startHold\}\s+onPointerLeave=\{endHold\}/, 'the pointer over the list holds it');
  assert.match(lists, /onFocus=\{\(e\) => \{ if \(!within\(e\.relatedTarget\)\) startHold\(\); \}\}/,
    'a row with keyboard focus holds it too');
  assert.match(lists, /<GroupList lines=\{held\}/, 'and it draws the held order');

  // Rendered folded, the lit row is still the sixth drawn: today's rule.
  const { renderComponent } = require('./lib/render-tsx');
  const eight = Array.from({ length: 8 }, (_, i) => ({
    key: `need:proposal:${i + 1}`,
    title: `Row ${i + 1}`,
    app,
    who: 'all',
    sub: { id: 'messages:ai.row.where', values: { project: 'Garden club', number: i + 1 } },
    pill: { id: 'messages:ai.pill.vote' },
    href: `#app/garden/dev/changes/${i + 1}`,
    rootId: null,
  }));
  const html = renderComponent('frontend/src/features/ai/lists.tsx', 'AiLists', {
    hero: null, main: { open() {}, lit: false, unread: 0 }, ready: true, owed: 8,
    rows: eight, lit: 'page:app/garden/dev/changes/7', progress: [], waiting: [], live: [],
    openRow() {}, openThread() {},
  });
  const shown = html.slice(0, html.indexOf('data-ai-group-rest'));
  assert.ok(shown.indexOf('Row 7') > shown.indexOf('Row 5'), 'folded, the row you are on joins the first five');
  assert.ok(!shown.includes('Row 6') && !shown.includes('Row 8'), 'and the rows below it fold away');
});

// #6262 (4 Nov 2026, Evan): "Hard to tell which threads have unread content."
// A thread somebody has written in since the viewer opened it gets a blue dot
// and a bold title, and Needs you says how many are new: on its own heading,
// on each project's name, in the header and on the filter chips.
test('#6262: threads with something new get a dot, a bold title and a count', () => {
  const { freshCount, freshByProject, freshFirst, groupRows, needsYou, heroWords } = loadTsx(MODEL);
  // Stable: the new ones first, each keeping its own order.
  assert.deepEqual(
    freshFirst([{ key: 'a' }, { key: 'b', fresh: true }, { key: 'c' }, { key: 'd', fresh: true }]).map((r) => r.key),
    ['b', 'd', 'a', 'c']);
  assert.equal(freshCount([{ unread: 0 }, { unread: 2 }, { }, { unread: 1 }]), 2);
  assert.deepEqual(freshByProject([
    { app, unread: 1 }, { app, unread: 0 }, { app: { ...app, slug: 'games' }, unread: 3 },
  ]), { garden: 1, games: 1 }, 'a row counts once, by its project');
  // A fresh row is never folded away under Show more.
  const many = Array.from({ length: 8 }, (_, i) => ({ key: `r${i + 1}`, fresh: i === 6 }));
  const folded = groupRows(many, 5, false);
  assert.deepEqual(folded.items.slice(0, 6).map((r) => r.key), ['r1', 'r2', 'r3', 'r4', 'r5', 'r7']);
  assert.deepEqual([folded.shown, folded.hidden], [6, 2], 'and the rest still folds');

  // A feed item and a plan both carry their thread and what is new in it;
  // a private thread is not a thread of its own here.
  const rows = needsYou([
    { kind: 'proposal', id: 1, number: 500, title: 'New vote', app, threadId: 41, unread: 2 },
    { kind: 'proposal', id: 2, number: 501, title: 'Old vote', app, threadId: 42 },
  ], {
    private: [{ rootId: 9, title: 'An idea', kind: 'idea', app: null, at: null }],
    needs: [thread(7, 410, 'plan', { group: 'needs', unread: 1 })],
    next: [], waiting: [], live: [],
  });
  assert.deepEqual(rows.map((r) => [r.threadId, r.unread]), [[41, 2], [42, 0], [7, 1], [null, 0]]);
  const hero = heroWords(13, 7, 4);
  assert.equal(hero.id, 'messages:ai.hero.bothFresh');
  assert.equal(words(hero), 'Needs you: 13 · <0>4 new</0> · In progress: 7', 'the count sits between the two');
  assert.equal(heroWords(13, 7, 0).id, 'messages:ai.hero.both', 'nothing new says nothing');
  assert.equal(heroWords(13, 0, 2).id, 'messages:ai.hero.needsFresh');

  // Rendered: the dot, the bold title, the Earlier line, both pills and the
  // chip number show; a zero shows nothing.
  const games = { slug: 'games', name: 'Game corner', icon_url: null, icon_emoji: null };
  const line = (key, title, appIn, unread) => ({
    key, title, app: appIn, who: 'all',
    sub: { id: 'messages:ai.row.where', values: { project: appIn.name, number: 1 } },
    pill: { id: 'messages:ai.pill.vote' }, href: `#app/${appIn.slug}/dev/issues/1`, rootId: null,
    threadId: Number(key.replace(/\D/g, '')) + 40, unread,
  });
  const { renderComponent } = require('./lib/render-tsx');
  const html = renderComponent('frontend/src/features/ai/lists.tsx', 'AiLists', {
    hero: null, main: { open() {}, lit: false, unread: 0 }, ready: true, owed: 3,
    rows: [line('need:proposal:1', 'New one', app, 2), line('need:proposal:2', 'Old one', app, 0),
      line('need:proposal:3', 'Other project', games, 1)],
    lit: null, progress: [], waiting: [], live: [], openRow() {}, openThread() {},
  });
  assert.match(html, /data-ai-dot=""/, 'a new row has its dot');
  assert.match(html, /font-bold text-zinc-900 dark:text-zinc-100">New one</, 'and a bold title');
  assert.match(html, /data-ai-earlier=""/, 'Needs you draws the Earlier line');
  assert.ok(html.includes('2 new'), 'the heading pill counts them');
  assert.ok(html.includes('1 new'), 'a project names its own count');
  assert.match(html, /data-ai-chip="garden"[\s\S]*?data-ai-fresh=""/, 'a chip carries its number');
  // Nothing new: no dot, no Earlier line, no pill anywhere.
  const quiet = renderComponent('frontend/src/features/ai/lists.tsx', 'AiLists', {
    hero: null, main: { open() {}, lit: false, unread: 0 }, ready: true, owed: 2,
    rows: [line('need:proposal:1', 'One', app, 0), line('need:proposal:3', 'Two', games, 0)],
    lit: null, progress: [], waiting: [], live: [], openRow() {}, openThread() {},
  });
  assert.ok(!quiet.includes('data-ai-dot'), 'nothing new has no dot');
  assert.ok(!quiet.includes('data-ai-earlier'), 'and no Earlier line');
  assert.ok(!quiet.includes('data-ai-fresh'), 'and no count at all');
});

// #6408 (6 Nov 2026, Evan): Live this week showed 50 of a project's 76 rows
// before Show more, because every "it's live" row was new and #6262 never
// folds a fresh row. New in Live only means a change went live since the
// viewer last looked, so Live folds after its first few whatever is new: its
// rows put the new ones first, and the fold says how many of them it holds.
// Needs you and Waiting & in progress keep the never-fold rule.
test('#6408: Live this week folds after its first few rows whatever is new', () => {
  const { groupRows, GROUP_FIRST } = loadTsx(MODEL);
  // Eight rows, six of them new. Folded to Live's first three, five fold.
  const many = Array.from({ length: 8 }, (_, i) => ({ key: `r${i + 1}`, fresh: i < 6 }));
  const folded = groupRows(many, GROUP_FIRST.live, false, false);
  assert.deepEqual(folded.items.map((r) => r.key), many.map((r) => r.key), 'the order is the one the section gave');
  assert.deepEqual([folded.shown, folded.hidden], [3, 5], 'the first three show; the new rows fold with the rest');
  // The row you are on is still lifted out of the fold, folded.
  const lit = many.map((r, i) => ({ ...r, lit: i === 6 }));
  const withLit = groupRows(lit, GROUP_FIRST.live, false, false);
  assert.deepEqual([withLit.shown, withLit.hidden], [4, 4], 'where you are is never hidden');
  assert.equal(withLit.items[3].key, 'r7');
  // By default #6262 holds: a new row past the first few is never folded
  // away, which is what Needs you and Waiting & in progress draw.
  const held = groupRows(many, GROUP_FIRST.live, false);
  assert.deepEqual([held.shown, held.hidden], [6, 2], 'a fresh row is lifted by default');

  const lists = read('frontend/src/features/ai/lists.tsx');
  assert.match(lists, /const freshHidden = foldFresh \? items\.slice\(shown\)\.filter\(\(line\) => line\.fresh\)\.length : 0;/,
    'the fold counts the new rows it holds');
  assert.match(lists, /<Section list="live" quiet head=\{t\('messages:ai\.live\.title', \{ count: liveLines\.length \}\)\} lines=\{liveLines\}[^>]*foldFresh \/>/,
    'Live this week is the section that folds what is new');
  assert.equal(message('messages:ai.work.showMoreFresh', { count: 73, fresh: 44 }), 'Show 73 more · 44 new');

  // Rendered: a project's eight live rows, six new, show three rows and the
  // fold that holds the other three new ones.
  const live = Array.from({ length: 8 }, (_, i) => thread(30 + i, 410 + i, 'going_live', {
    group: 'live', at: '2026-11-06T10:00:00Z', unread: i < 6 ? 1 : 0,
  }));
  const { renderComponent } = require('./lib/render-tsx');
  const html = renderComponent('frontend/src/features/ai/lists.tsx', 'AiLists', {
    hero: null, main: { open() {}, lit: false, unread: 0 }, ready: true, owed: 0,
    rows: [], lit: null, progress: [], waiting: [], live, openRow() {}, openThread() {},
  });
  const sheet = html.slice(html.indexOf('data-ai-sheet="live"'));
  const shown = sheet.slice(0, sheet.indexOf('data-ai-group-rest'));
  assert.equal((shown.match(/data-ai-line=/g) || []).length, 3, 'three rows before the fold');
  assert.match(sheet, /Show 5 more · 3 new/, 'the fold says how many new rows it holds');
  // None of the folded rows new: the plain words, as every other list says them.
  const older = live.map((t) => ({ ...t, unread: 0 }));
  const calm = renderComponent('frontend/src/features/ai/lists.tsx', 'AiLists', {
    hero: null, main: { open() {}, lit: false, unread: 0 }, ready: true, owed: 0,
    rows: [], lit: null, progress: [], waiting: [], live: older, openRow() {}, openThread() {},
  });
  const calmSheet = calm.slice(calm.indexOf('data-ai-sheet="live"'));
  assert.match(calmSheet, /Show 5 more/, 'nothing new in the fold says only how many');
  assert.ok(!/Show 5 more ·/.test(calmSheet), 'and does not mention new ones');
});


// #6312 (4 Nov 2026, Evan): "Show 11 more" made two rows' blue dots disappear
// the instant it was pressed. Folded, a new row is lifted above the fold, so
// its dot shows. Opened, every row keeps its own order, so a new row past the
// first few sits back in the box the fold clips while it animates, and that
// box's overflow-hidden cut the dot off, 12px outside its row. The box keeps
// the dot's room on the start side: the negative margin moves its clip edge
// out, and the same padding leaves every row exactly where it was.
test('#6312: the fold\'s box keeps the room a new row\'s dot stands in, folded or open', () => {
  const { groupRows, GROUP_FIRST } = loadTsx(MODEL);
  const many = Array.from({ length: 8 }, (_, i) => ({ key: `r${i + 1}`, fresh: i === 6 }));
  // Opened, the fresh row that was lifted goes back into the order, past the
  // first few: the part that folds.
  const opened = groupRows(many, GROUP_FIRST.needs, true);
  assert.deepEqual(opened.items.map((r) => r.key), many.map((r) => r.key), 'every row keeps its own place');
  assert.equal(opened.shown, GROUP_FIRST.needs, 'the first few show');
  assert.ok(opened.items.slice(opened.shown).some((r) => r.fresh), 'and the new one past them is in the folded part');

  const { renderComponent } = require('./lib/render-tsx');
  const LISTS = 'frontend/src/features/ai/lists.tsx';
  const line = (key, title, unread) => ({
    key, title, app, who: 'all', unread,
    sub: { id: 'messages:ai.row.where', values: { project: app.name, number: 1 } },
    pill: { id: 'messages:ai.pill.vote' }, href: '#app/garden/dev/issues/1', rootId: null,
    threadId: Number(key.replace(/\D/g, '')) + 40,
  });
  const html = renderComponent(LISTS, 'AiLists', {
    hero: null, main: { open() {}, lit: false, unread: 0 }, ready: true, owed: 0,
    rows: many.map((r, i) => line(`need:proposal:${i + 1}`, `Row ${i + 1}`, i === 6 ? 1 : 0)),
    lit: null, progress: [], waiting: [], live: [], openRow() {}, openThread() {},
  });
  // Folded, the new row is drawn above the fold, dot and all.
  const folded = html.slice(0, html.indexOf('data-ai-group-rest'));
  assert.ok(folded.includes('Row 7'), 'the new row is lifted above the fold');

  // The box a fold clips: it still clips (the animation needs it), and it
  // carries the dot's room on the start side.
  const groupClip = /data-ai-group-rest=""><div class="([^"]*)">/.exec(html);
  assert.ok(groupClip, 'a project folds its rest away');
  assert.match(groupClip[1], /overflow-hidden/, 'the fold still clips');
  assert.match(groupClip[1], /(?:^| )-ms-4(?: |$)/, 'its clip edge stands past the rows');
  assert.match(groupClip[1], /(?:^| )ps-4(?: |$)/, 'and the same room is padding, so no row moves');

  // The Still waiting fold clips the same way, so it keeps the same room.
  const still = renderComponent(LISTS, 'AiLists', {
    hero: null, main: { open() {}, lit: false, unread: 0 }, ready: true, owed: 0, rows: [],
    progress: [], live: [], openRow() {}, openThread() {},
    waiting: [thread(1, 71, 'vote'), thread(2, 72, 'not_read'), thread(3, 73, 'operator')],
  });
  const stillClip = /data-ai-still-rest=""><div class="([^"]*)">/.exec(still);
  assert.ok(stillClip, 'the still rows fold away under their own head');
  assert.match(stillClip[1], /overflow-hidden/);
  assert.match(stillClip[1], /(?:^| )-ms-4(?: |$)/);
  assert.match(stillClip[1], /(?:^| )ps-4(?: |$)/);

  // The room must stay at least the dot's own offset: 12px out (start-3), so
  // 16px (4) of room, in the same 4px steps.
  const src = read(LISTS);
  const at = Number(/const DOT = '[^']*-start-(\d+)/.exec(src)[1]);
  const room = Number(/ps-(\d+)/.exec(groupClip[1])[1]);
  assert.ok(room >= at, `the fold keeps ${room * 4}px for a dot ${at * 4}px outside its row`);
});

// 6 Nov 2026 (Evan): "in Needs you and Waiting & in progress, keep the
// project groups, and inside each group split the rows by day with the small
// caps dividers and a thin rule ... Leave History's month headings as they
// are." A project's rows are split by the reader's own calendar day: Today,
// Yesterday, then the weekday and date. Nothing else grows a day heading.
test('6 Nov 2026: Needs you and Waiting & in progress split each project by day, History keeps its months', () => {
  const { dayKey, byDay } = loadTsx(MODEL);
  // Noon, so the test's own clock cannot turn a day into its neighbour.
  const at = (daysAgo) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - daysAgo); return d.toISOString(); };
  const today = at(0);
  const yesterday = at(1);
  const older = at(9);
  assert.notEqual(dayKey(today), dayKey(yesterday), 'a day apart is a different day');
  assert.equal(dayKey(null), '', 'no moment, no day');
  assert.deepEqual([dayKey(today).length, dayKey(today).split('-').length], [10, 3], 'the key is YYYY-MM-DD');
  // A day's rows are one run: newest day first, the order within a day kept.
  assert.deepEqual(byDay([{ k: 'a', at: today }, { k: 'b', at: yesterday }, { k: 'c', at: today }, { k: 'd', at: null }])
    .map((r) => r.k), ['a', 'c', 'b', 'd'], 'Today, then Yesterday, then the undated row');

  const { renderComponent } = require('./lib/render-tsx');
  const LISTS = 'frontend/src/features/ai/lists.tsx';
  const line = (key, title, when) => ({
    key, title, app, who: 'all', at: when, unread: 0, threadId: null,
    sub: { id: 'messages:ai.row.where', values: { project: app.name, number: 1 } },
    pill: { id: 'messages:ai.pill.vote' }, href: '#app/garden/dev/issues/1', rootId: null,
  });
  const html = renderComponent(LISTS, 'AiLists', {
    hero: null, main: { open() {}, lit: false, unread: 0 }, ready: true, owed: 3,
    rows: [line('need:proposal:1', 'Today one', today), line('need:proposal:3', 'Yesterday one', yesterday),
      line('need:proposal:2', 'Today two', today), line('need:proposal:4', 'Older one', older)],
    lit: null,
    progress: [thread(1, 71, 'vote', { at: today, group: 'next' }), thread(2, 72, 'building', { at: yesterday, group: 'next' })],
    waiting: [], live: [],
    openRow() {}, openThread() {},
  });
  const sheet = (name) => html.slice(html.indexOf(`data-ai-sheet="${name}"`), html.indexOf('data-ai-sheet="', html.indexOf(`data-ai-sheet="${name}"`) + 1));
  const needs = sheet('open');
  const busy = sheet('busy');
  // Inside the project group, one divider each day, in the order the rows come.
  assert.ok(needs.indexOf('data-ai-group="garden"') < needs.indexOf('data-ai-day='), 'the day sits inside the project group');
  assert.equal((needs.match(/data-ai-day="/g) || []).length, 3, 'Today, Yesterday and the older day, once each');
  assert.ok(needs.indexOf(message('messages:ai.short.today')) < needs.indexOf('Today one'));
  assert.ok(needs.indexOf('Today one') < needs.indexOf('Today two'), 'the day\'s rows are one run, whatever order they came in');
  assert.ok(needs.indexOf('Today two') < needs.indexOf(message('messages:ai.short.yesterday')), 'a second row of the same day adds no divider');
  assert.ok(needs.indexOf(message('messages:ai.short.yesterday')) < needs.indexOf('Yesterday one'));
  assert.ok(needs.indexOf('Yesterday one') < needs.indexOf('Older one'));
  const label = (key) => {
    const found = new RegExp(`data-ai-day="${key}"><span[^>]*>([^<]+)</span>`).exec(needs);
    return found ? found[1] : '';
  };
  assert.equal(label(dayKey(today)), message('messages:ai.short.today'));
  assert.equal(label(dayKey(yesterday)), message('messages:ai.short.yesterday'));
  assert.match(label(dayKey(older)), /\d/, 'an older day says its date');
  // Waiting & in progress splits the same way, under its own project group.
  assert.match(busy, /data-ai-group="garden"/);
  assert.equal((busy.match(/data-ai-day="/g) || []).length, 2);
  assert.ok(busy.indexOf(message('messages:ai.short.today')) < busy.indexOf(message('messages:ai.short.yesterday')));

  // History keeps its month headings, and Live this week keeps none of these.
  const history = {
    rows: [{ key: 'thread:9', threadId: 9, number: 392, title: 'Watering reminders', app, href: '#app/garden/dev/issues/392', at: older, kind: 'change', outcome: 'live', by: 'bot' }],
    next: null, ready: true, loading: false, failed: false, more() {}, retry() {},
  };
  const withHistory = renderComponent(LISTS, 'AiLists', {
    hero: null, main: { open() {}, lit: false, unread: 0 }, ready: true, owed: 0,
    rows: [], progress: [], waiting: [], live: [thread(3, 73, 'live', { at: today })],
    history, openRow() {}, openThread() {}, openHistory() {},
  });
  const historySheet = withHistory.slice(withHistory.indexOf('data-ai-sheet="history"'));
  assert.match(historySheet, /data-ai-history-month="/, 'History still groups by month');
  assert.doesNotMatch(historySheet, /data-ai-day=/, 'and grows no day divider');
  const liveSheet = withHistory.slice(withHistory.indexOf('data-ai-sheet="live"'), withHistory.indexOf('data-ai-sheet="history"'));
  assert.doesNotMatch(liveSheet, /data-ai-day=/, 'Live this week keeps its day on the right');
});

test('the filter: the three projects that need you most as chips, then any picked past them, and More for every project', () => {
  const { needsYou, rankProjects, railProjects, RAIL_PROJECTS } = loadTsx(MODEL);
  const at = (slug, name) => ({ slug, name, icon_url: null, icon_emoji: null });
  const [garden, games, run, birds, zines] = [
    at('garden', 'Garden club'), at('games', 'Game corner'), at('run', 'Run club'), at('birds', 'Bird count'), at('zines', 'Zines'),
  ];
  const rows = needsYou([
    { kind: 'proposal', id: 1, number: 500, title: 'One', app: games },
    { kind: 'proposal', id: 2, number: 501, title: 'Two', app: garden },
    { kind: 'proposal', id: 3, number: 502, title: 'Three', app: garden },
  ], { private: [], next: [], waiting: [], live: [] });
  const ranked = rankProjects(rows,
    [thread(1, 10, 'building', { group: 'next', app: run }), thread(2, 11, 'building', { group: 'next', app: games })],
    [thread(3, 12, 'vote', { app: zines })],
    [thread(4, 13, 'live', { group: 'live', app: birds }), thread(5, 14, 'live', { group: 'live', app: birds })]);
  assert.deepEqual(ranked.map((p) => [p.app.slug, p.needs, p.progress, p.waiting, p.live]), [
    ['garden', 2, 0, 0, 0],
    ['games', 1, 1, 0, 0],
    ['run', 0, 1, 0, 0],
    ['zines', 0, 0, 1, 0],
    ['birds', 0, 0, 0, 2],
  ], 'what needs you most first, then what is under way, then waiting, then only live; once each');
  assert.equal(RAIL_PROJECTS, 3);
  assert.deepEqual(railProjects(ranked, []).map((a) => a.slug), ['garden', 'games', 'run'], 'three chips');
  assert.deepEqual(railProjects(ranked, ['birds', 'games']).map((a) => a.slug), ['birds', 'garden', 'games', 'run'],
    'a project picked from More joins the rail beside All, so the filter is on screen even on a phone; the first three keep their places');
  const tied = rankProjects([], [], [], [thread(6, 15, 'live', { group: 'live', app: zines }), thread(7, 16, 'live', { group: 'live', app: birds })]);
  assert.deepEqual(tied.map((p) => p.app.slug), ['birds', 'zines'], 'a tie goes by name');

  const lists = read('frontend/src/features/ai/lists.tsx');
  assert.match(lists, /<FadeRail role="group" aria-label=\{t\('messages:ai\.filter\.label'\)\} data-ai-project-chips="" className="min-w-0 flex-1">/);
  assert.match(lists, /\{rail\.map\(\(app\) => \(/, 'the rail draws the chips railProjects gives it');
  // More stands outside the rail, so a narrow rail never scrolls it away,
  // and it is a menu button, not a toggle.
  assert.match(lists, /<\/FadeRail>\s*\{past > 0 \? \(\s*<Chip/);
  assert.match(lists, /aria-pressed=\{undefined\}\s+aria-haspopup="dialog"\s+aria-expanded=\{!!more\}/);
  assert.match(lists, /\{t\('messages:ai\.filter\.more', \{ count: past \}\)\}/);
  assert.equal(message('messages:ai.filter.more', { count: 28 }), '28 more');

  const picker = read('frontend/src/features/ai/project-picker.tsx');
  assert.match(picker, /createPortal\(sheet \? <PickerSheet \{\.\.\.props\} \/> : <PickerMenu anchor=\{anchor\} \{\.\.\.props\} \/>, document\.body\)/,
    'a sheet on a phone, a menu under the chip on a wide window; nothing in the prerender');
  assert.match(picker, /type="checkbox"[\s\S]*?checked=\{picked\.includes\(p\.app\.slug\)\}[\s\S]*?onChange=\{\(\) => onToggle\(p\.app\.slug\)\}/, 'a pick applies at once');
  assert.match(picker, /e\.target\.closest\('\[data-ai-project-more\]'\)/, 'a press on More toggles it rather than closing and reopening');
  assert.equal(message('messages:ai.filter.note.needs', { count: 1 }), '1 needs you');
  assert.equal(message('messages:ai.filter.note.needs', { count: 3 }), '3 need you');
  assert.equal(message('messages:ai.filter.note.live', { count: 2 }), '2 live this week');
  assert.equal(message('messages:ai.filter.group.busy'), 'In progress or waiting');
});

test('In progress and Waiting each leave out a thread the feed lists, by its request or its change', () => {
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
// and opens on the request's page, where it is decided (#6227: its own change
// address lands there anyway, and lit no row beside the list), and still
// leaves out the request's thread.
test('a vote on a change for a request names the request\'s number, and opens on its page', () => {
  const { needsYou, upNext, owedKeys } = loadTsx(MODEL);
  const needs = [{ kind: 'proposal', id: 1, number: 6032, title: 'Spell out the approval rules', app, request: { number: 6038, title: 'Rule changes' } }];
  const [row] = needsYou(needs, null);
  assert.equal(words(row.sub), 'Garden club · #6038');
  assert.equal(row.href, '#app/garden/dev/issues/6038');
  assert.deepEqual([...owedKeys(needs)].sort(), ['garden#6032', 'garden#6038']);
  const work = { private: [], next: [], waiting: [thread(3, 6038, 'vote', { change: { id: 9, number: 6032 } })], live: [] };
  assert.deepEqual(upNext(needs, work), [], 'once, in Needs you');
  const [plain] = needsYou([{ kind: 'proposal', id: 2, number: 6050, title: 'No request', app }], null);
  assert.equal(words(plain.sub), 'Garden club · #6050', 'a change for no request keeps its own number');
});

test('each In progress and Waiting row says its stage and its second line, in the words every screen uses', () => {
  const { nextWords, heroWords } = loadTsx(MODEL);
  const row = (what, extra = {}) => thread(1, 7, what, { group: 'next', ...extra });
  assert.deepEqual([
    row('going_live'), row('fixing'), row('revising'), row('reading'), row('reading_reply'),
    row('building', { by: 'bot' }), row('building', { by: 'you' }),
    row('building', { by: 'someone', work: { line: { code: 'claimed', by: 'snait' } } }),
  ].map((r) => words(nextWords(r))), [
    'Garden club · #7 · Going live',
    'Garden club · #7 · Building · Fixing what its tests found',
    'Garden club · #7 · Building · Updating the change',
    'Garden club · #7 · Reading it',
    'Garden club · #7 · Reading it · Reading your reply',
    'Garden club · #7 · Building', 'Garden club · #7 · Building',
    'Garden club · #7 · Building · snait is building it',
  ], 'a claim with no change yet names who has it');
  const waits = (what, extra = {}) => thread(1, 7, what, extra);
  assert.deepEqual([
    waits('vote'), waits('checking'), waits('checking', { work: { line: { code: 'checks_failing', failing: 2 } } }),
    waits('update_queued'), waits('build_queued'), waits('held'), waits('held_turn'), waits('stalled'),
    waits('queued', { work: { line: { code: 'queued', place: 4 } } }), waits('on_hold'), waits('not_picked_up'),
    waits('needs_person'), waits('needs_person', { work: { line: { code: 'reason', text: 'A person must choose.' } } }),
    waits('nothing_to_build'),
  ].map((r) => words(nextWords(r))), [
    'Garden club · #7 · Up for a vote',
    'Garden club · #7 · Checking',
    'Garden club · #7 · Checking · 2 tests failing',
    'Garden club · #7 · Up for a vote · An update is on its way',
    'Garden club · #7 · Ready to build · Waiting its turn',
    'Garden club · #7 · Ready to build · Waiting for changes up for a vote to be decided',
    'Garden club · #7 · Ready to build · Waiting for one of the project\'s builds to finish',
    'Garden club · #7 · Stopped: the build didn\'t start',
    'Garden club · #7 · Not started yet · Number 4 in line',
    'Garden club · #7 · Not started yet · On hold until Monday: this week\'s building time is used up',
    'Garden club · #7 · Not started yet · Waiting to be read',
    'Garden club · #7 · Waiting for a decision',
    'Garden club · #7 · Waiting for a decision · Homeroom bot: A person must choose.',
    'Garden club · #7 · Waiting for more detail',
  ], 'what waits on somebody else is said as they read it, not as the requester does');
  // A decision up for a vote has no number.
  assert.equal(words(nextWords(thread(1, null, 'vote', { kind: 'decision' }))), 'Garden club · Up for a vote');
  assert.equal(message('messages:ai.busy.title', { count: 2 }), 'Waiting & in progress · 2');
  assert.equal(words(heroWords(2, 3)), 'Needs you: 2 · In progress: 3');
  assert.equal(words(heroWords(0, 3)), 'In progress: 3');
  // Y03: a zero says nothing, and with neither there is no line.
  assert.equal(words(heroWords(2, 0)), 'Needs you: 2');
  assert.equal(heroWords(0, 0), null);
});

test('a row\'s one word on the right, and on a phone the reason where it is news', () => {
  const { shortWords, whyOf, threadWhy, needsYou, upNext } = loadTsx(MODEL);
  const row = (what, extra = {}) => thread(1, 7, what, extra);
  assert.deepEqual([
    row('going_live'), row('building', { by: 'bot' }), row('building', { by: 'you' }),
    row('building', { by: 'someone', work: { line: { code: 'claimed', by: 'snait' } } }),
    row('building', { by: 'someone' }), row('vote'), row('checking'), row('queued'), row('build_queued'),
    row('held'), row('held_turn'), row('on_hold'), row('not_picked_up'), row('build_stopped'),
  ].map((r) => words(shortWords(r))), [
    'Going live', 'Homeroom bot', 'You', 'snait', 'Building', 'Up for a vote', 'Checking', 'Not started yet', 'Ready to build',
    'Ready to build', 'Ready to build', 'Not started yet', 'Not started yet', 'Stopped: the build didn\'t finish',
  ], 'the stage, in the words every screen uses; who is building it where that is the news');
  // Handed back by the bot: Needs Reply, Restart build and Retry the fix,
  // each saying its stage.
  const work = {
    private: [], next: [], live: [],
    needs: [thread(7, 410, 'decide', { group: 'needs' }), thread(8, 411, 'build_stopped', { group: 'needs' }), thread(10, 413, 'fix_stopped', { group: 'needs' })],
    waiting: [thread(9, 412, 'held')],
  };
  const bots = [{ kind: 'proposal', id: 1, number: 600, title: 'Its change', app, author: 'homeroom_bot' }];
  const rows = needsYou(bots, work);
  assert.deepEqual(rows.map((r) => [r.key, r.pill && message(r.pill.id), words(r.sub)]), [
    ['need:proposal:1', 'Vote', 'Garden club · #600 · Your vote helps free a build slot'],
    ['decide:7', 'Needs Reply', 'Garden club · #410 · Waiting for you to decide'],
    ['stopped:8', 'Restart build', 'Garden club · #411 · Stopped: the build didn\'t finish'],
    ['fix_stopped:10', 'Retry the fix', 'Garden club · #413 · Stopped: its tests still fail'],
  ]);
  assert.deepEqual(rows.map((r) => whyOf(r) && words(whyOf(r))), [
    'Your vote helps free a build slot', 'Waiting for you to decide', 'Stopped: the build didn\'t finish',
    'Stopped: its tests still fail',
  ], 'a phone shows the stage under the title, where nothing hovers');
  // The fallback: a kind no pill names says what to do.
  const [unknown] = needsYou([{ kind: 'mystery', id: 3, number: 602, title: 'Odd one', app }], null);
  assert.equal(message(unknown.pill.id), 'Take a look');
  assert.equal(whyOf(needsYou([{ kind: 'proposal', id: 2, number: 601, title: 'Plain', app }], null)[0]), null, 'a plain vote says no more than its pill');
  const [held] = upNext(bots, work);
  assert.equal(held.yourVotes, 1);
  assert.equal(words(threadWhy(held)), 'A vote you owe can free its slot');
  assert.equal(words(threadWhy(row('queued', { work: { line: { code: 'queued', place: 2 } } }))), 'Number 2 in line', 'the second line');
  assert.equal(words(threadWhy(row('vote', { myVote: 'yes' }))), 'You voted Yes');
  assert.equal(threadWhy(row('vote')), null, 'a stage with no second line has none');
  const lists = read('frontend/src/features/ai/lists.tsx');
  assert.match(lists, /<span className="block truncate text-xs leading-4 text-zinc-500 dark:text-zinc-400 md:hidden" aria-hidden="true" data-ai-line-why="">\{line\.why\}<\/span>/,
    'the reason is a phone\'s second line; the tooltip says it everywhere');
  assert.match(lists, /const ROW = 'flex w-full min-h-\[44px\] md:min-h-\[36px\]/, 'a phone\'s 44px tap target');
});

test('#6306: a request the bot found already works says so, and offers Confirm it works', () => {
  const { needsYou, whyOf } = loadTsx(MODEL);
  const said = (text) => ({ work: { line: { code: 'reason', text } } });
  const work = {
    private: [], next: [], live: [],
    needs: [
      thread(7, 410, 'already_works', { group: 'needs', ...said('Visitors get the lobby and play as a guest.') }),
      thread(8, 411, 'already_works', { group: 'needs' }),
      thread(9, 412, 'decide', { group: 'needs', ...said('It changes who can sign in') }),
    ],
    waiting: [],
  };
  const rows = needsYou([], work);
  assert.deepEqual(rows.map((r) => r.key), ['works:7', 'works:8', 'decide:9']);
  assert.deepEqual(rows.map((r) => r.pill && message(r.pill.id)), ['Confirm it works', 'Confirm it works', 'Needs Reply']);
  assert.deepEqual(rows.map((r) => words(r.sub)), [
    'Garden club · #410 · It may already work: close it? · Homeroom bot: Visitors get the lobby and play as a guest.',
    'Garden club · #411 · It may already work: close it?',
    'Garden club · #412 · Waiting for you to decide · Homeroom bot: It changes who can sign in',
  ]);
  assert.deepEqual(rows.map((r) => whyOf(r) && words(whyOf(r))), [
    'Homeroom bot: Visitors get the lobby and play as a guest.',
    'It may already work: close it?',
    'Homeroom bot: It changes who can sign in',
  ], 'the bot\'s own reason, where it gave one');
  assert.equal(rows[0].href, '#app/garden/dev/issues/410', 'the row opens the request, where Propose to close lives');
  // The glyph is a check, not the raised hand a decision gets.
  const lists = read('frontend/src/features/ai/lists.tsx');
  assert.match(lists, /if \(kind === 'works'\) return <CheckIcon className=\{G\} \/>;/);
});

test('#6306: the chat names already-done requests as working, not as decisions', () => {
  const aiWork = require('../src/services/ai-work');
  const garden = { slug: 'garden', name: 'Garden club' };
  const lists = aiWork.listsOf([], {
    private: [], next: [], waiting: [], live: [],
    needs: [
      { threadId: 1, number: 410, kind: 'work', title: 'Work for people who aren\'t signed in', app: garden, group: 'needs',
        work: { stage: 'waiting_for_you', why: 'already_works', line: { code: 'reason', text: 'Visitors get the lobby and play as a guest.' } } },
      { threadId: 2, number: 412, kind: 'work', title: 'Rebuild the map editor', app: garden, group: 'needs',
        work: { stage: 'waiting_for_you', why: 'decide', line: { code: 'reason', text: 'It changes who can sign in' } } },
    ],
  });
  assert.deepEqual(lists.needsYou.map((r) => r.says), [
    'It may already work: close it? · Homeroom bot: Visitors get the lobby and play as a guest.',
    'Waiting for you to decide · Homeroom bot: It changes who can sign in',
  ], 'the same stage words the page shows, in English');
  assert.doesNotMatch(lists.needsYou[0].says, /decide/);
});

test('#6158: a Waiting row says what it waits on, and the rows nobody is moving fold under "Not moving"', () => {
  const { shortWords, nextWords, notMoving } = loadTsx(MODEL);
  const row = (what, extra = {}) => thread(1, 7, what, extra);
  // Nobody is moving it: not started on, or waiting on somebody else's move.
  assert.deepEqual([
    row('queued'), row('held'), row('needs_person'), row('nothing_to_build'), row('not_picked_up'), row('stalled'), row('vote'),
  ].map(notMoving), [false, false, true, true, true, true, false]);
  assert.equal(words(shortWords(row('not_picked_up', { quietDays: 12 }))), 'Not started yet');
  assert.equal(words(nextWords(row('queued', { work: { line: { code: 'queued', place: 4 } } }))),
    'Garden club · #7 · Not started yet · Number 4 in line');
  // The part is folded, with its count, over the rows that are not moving;
  // the ones that are moving stay in the section above it.
  const { renderComponent } = require('./lib/render-tsx');
  const html = renderComponent('frontend/src/features/ai/lists.tsx', 'AiLists', {
    hero: null, main: { open() {}, lit: false, unread: 0 }, ready: true, rows: [], owed: 0,
    progress: [], live: [], openRow() {}, openThread() {},
    waiting: [thread(1, 71, 'queued', { work: { line: { code: 'queued', place: 2 } } }), thread(2, 72, 'not_read'), thread(3, 73, 'operator')],
  });
  assert.match(html, /data-ai-still=""/, 'the folded head');
  assert.match(html, /Not moving · 2/, 'its count is only the rows nobody is moving');
  assert.match(html, /data-ai-still-rest=""/, 'and a fold of its own');
  assert.match(html, /aria-expanded="false"/, 'closed until pressed');
  // #6160 moved these rows to the card of their own, whose head counts the
  // whole card: the rows moving and the rows folded under Not moving.
  assert.match(html, /Waiting &amp; in progress · 3/, 'the card\'s head still counts every row');
  assert.match(html, /Number 2 in line/, 'the moving rows lead the list');
  const src = read('frontend/src/features/ai/lists.tsx');
  assert.match(src, /const stillShown = stillOpen \|\| !!still\?\.lines\.some\(\(l\) => l\.lit\);/, 'a row where you are opens it');
  assert.match(src, /onClick=\{\(\) => setStillOpen\(\(o\) => !o\)\}/, 'and a press toggles it');
});

test('#6237: a change on a GitHub-hosted project is "PR N" on the bot tab\'s rows and tooltips', () => {
  const { nextWords, changeOnGithub, prWord, needsYou } = loadTsx(MODEL);
  const github = { ...app, changesOnGithub: true };
  // A change-led thread: its number is GitHub's pull request number.
  const change = thread(1, 6230, 'vote', { kind: 'change', app: github });
  assert.equal(changeOnGithub(change), true);
  assert.equal(words(nextWords(change)), 'Garden club · PR 6230 · Up for a vote');
  // The same project on Homeroom's git host shares one counter and keeps '#'.
  const hosted = thread(2, 6230, 'vote', { kind: 'change', app });
  assert.equal(changeOnGithub(hosted), false);
  assert.equal(words(nextWords(hosted)), 'Garden club · #6230 · Up for a vote');
  // A request on the same GitHub project keeps '#N': it is not a change.
  const request = thread(3, 6230, 'vote', { kind: 'request', app: github });
  assert.equal(words(nextWords(request)), 'Garden club · #6230 · Up for a vote');
  // The number cell and the live row's tooltip have their PR twins.
  assert.equal(message('messages:ai.live.numberPr', { number: 6230 }), 'PR 6230');
  assert.equal(message(prWord('messages:ai.live.row', true), { project: 'Garden club', number: 6230 }),
    'Garden club · PR 6230 · Live');
  // A private thread about a change says PR too, on a GitHub project.
  const rows = needsYou(null, {
    private: [{ rootId: 5, title: 'Plans', kind: 'idea', app: github, about: { kind: 'change', number: 6230 } }],
    next: [], waiting: [], live: [],
  });
  assert.equal(rows[0].sub.id, 'messages:ai.row.privateAboutChangePr');
  assert.equal(words(rows[0].sub), 'Only you · Garden club · About change PR 6230');
  // Older servers send no flag: the row keeps what it said before.
  assert.equal(changeOnGithub(thread(4, 6230, 'vote', { kind: 'change', app })), false);
  // The rendered row's number cell says PR; "#6230" is nowhere on the page.
  const { renderComponent } = require('./lib/render-tsx');
  const html = renderComponent('frontend/src/features/ai/lists.tsx', 'AiLists', {
    hero: null, main: { open() {}, lit: false, unread: 0 }, ready: true, rows: [], owed: 0,
    progress: [], waiting: [change], live: [], openRow() {}, openThread() {},
  });
  assert.match(html, />PR 6230</, 'the number cell');
  assert.doesNotMatch(html, />#6230</);
});

test('the server: a row\'s list is its stored work state, read for the viewer', () => {
  const aiWork = require('../src/services/ai-work');
  const now = new Date('2026-10-29T12:00:00Z');
  const at = '2026-10-29T10:00:00.000Z';
  const ME = 5;
  const open = { state: 'open', own: true, number: 7, request_id: 1, request_state: 'open', request_at: at, created_at: at };
  const ws = (stage, extra = {}) => ({ stage, why: null, reason: null, line: null, since: at, requesterId: null, ...extra });
  const work = (stage, extra = {}) => ({ stage, why: null, reason: null, line: null, since: at, ...extra });
  const promoted = { ...open, change_status: 'promoted', change_user: 9, voted: true, my_vote: 'yes', promoted_at: at };
  assert.deepEqual(aiWork.standing(promoted, ME, now, null, ws('up_for_vote')),
    { group: 'waiting', work: work('up_for_vote'), at, myVote: 'yes' }, 'a vote you have given waits on others');
  assert.equal(aiWork.standing({ ...promoted, voted: false }, ME, now, null, ws('up_for_vote')), null,
    'a vote still owed is the Needs you feed\'s');
  assert.deepEqual(aiWork.standing(promoted, ME, now, null, ws('checking', { line: { code: 'checks_failing', failing: 2 } })),
    { group: 'waiting', work: work('checking', { line: { code: 'checks_failing', failing: 2 } }), at },
    '#6060: checks that have not passed hold it, and say so');
  const mine = (stage, extra = {}) => aiWork.standing(open, ME, now, null, ws(stage, { requesterId: ME, ...extra }));
  assert.deepEqual(mine('waiting_for_you', { why: 'plan' }), { group: 'needs', work: work('waiting_for_you', { why: 'plan' }), at },
    'a plan waiting for Build it is Needs you\'s');
  assert.equal(mine('waiting_for_you', { why: 'question' }), null, 'the bot\'s question is the feed\'s Answer');
  assert.equal(mine('stopped', { reason: 'build_failed' }).group, 'needs', 'its build stopped: Restart build');
  assert.equal(mine('building', { line: { code: 'held_waiting' } }).group, 'waiting', 'held back until a change up for a vote is decided');
  assert.equal(mine('reading', { line: { code: 'queued', place: 3 } }).group, 'waiting', 'in the bot\'s line');
  assert.equal(mine('reading').group, 'next', 'being read');
  assert.equal(mine('planning').group, 'next', 'being planned');
  assert.equal(mine('building', { line: { code: 'fixing' } }).group, 'next', 'being fixed');
  assert.equal(mine('going_live').group, 'next');
  assert.equal(aiWork.standing({ ...open, state: 'closed' }, ME, now, null, ws('going_live')).group, 'next',
    'a merged request stays in progress until its release is live');
  assert.equal(aiWork.standing({ ...open, state: 'closed', own: false }, ME, now, null, ws('going_live')), null,
    'going live still belongs only to the people whose work it is');
  assert.equal(aiWork.standing({ ...open, state: 'closed', own: false, change_user: ME }, ME, now, null, ws('going_live')).group, 'next',
    'the builder also keeps a closed request going live');
  assert.equal(aiWork.standing({ ...open, state: 'closed' }, ME, now, null, ws('waiting_for_you', { why: 'plan', requesterId: ME })), null,
    'never on a closed thread');
  assert.equal(aiWork.standing(open, ME, now, null, ws('closed')), null, 'nor a closed request');
  // Handed back to a person: Needs you when the viewer decides, Waiting for anyone else following it.
  const decide = ws('waiting_for_you', { why: 'decide', line: { code: 'reason', text: 'A person must choose.' } });
  assert.equal(aiWork.standing(open, ME, now, null, decide, { decides: true }).group, 'needs');
  assert.equal(aiWork.standing(open, ME, now, null, decide, { decides: false }).group, 'waiting');
  assert.equal(aiWork.standing({ ...open, own: false }, ME, now, null, decide, { decides: false }).group, 'waiting',
    'one they only wrote in, with no change in flight, waits on that person');
  assert.equal(aiWork.standing({ ...open, own: false, change_status: 'active', change_user: 9 }, ME, now, null, ws('building')), null,
    'one they only wrote in, being built, asks nothing of them');
  // Who is building it is the viewer's to read.
  assert.equal(aiWork.standing({ ...open, change_status: 'active', change_user: 3 }, ME, now, 3, ws('building')).by, 'bot');
  assert.equal(aiWork.standing({ ...open, change_status: 'active', change_user: ME }, ME, now, 3, ws('building')).by, 'you');
  assert.equal(aiWork.standing({ ...open, claimed_by: 'aw_me', claimed_mine: true }, ME, now, null,
    ws('building', { line: { code: 'claimed', by: 'aw_me' } })).by, 'you', 'their own claim');
  // #6282: an update on its way carries what was asked for.
  assert.equal(aiWork.standing({ ...promoted, update_ask: 'Bigger\nbuttons' }, ME, now, null,
    ws('up_for_vote', { line: { code: 'update_queued' } })).ask, 'Bigger buttons');
  // A request nobody has started on for a week says how long.
  const old = { ...open, request_at: '2026-10-17T10:00:00.000Z' };
  assert.equal(aiWork.standing(old, ME, now, null, ws('reading', { line: { code: 'waiting' } })).quietDays, 12);
  // Live for a week, for anyone in the thread.
  const live = { ...open, own: false, change_status: 'merged', change_id: 4, merged_at: at, live_at: at };
  assert.deepEqual(aiWork.standing(live, ME, now, null, ws('live')),
    { group: 'live', work: work('live'), at, mergedAt: at, changeId: 4 });
  assert.equal(aiWork.standing({ ...live, live_at: '2026-10-01T00:00:00.000Z' }, ME, now, null, ws('live', { since: '2026-10-01T00:00:00.000Z' })), null,
    'a week on, it is history');
  // With no stored row yet (a read that failed), the change says it.
  assert.equal(aiWork.standing({ ...promoted, check_state: 'passing', change_id: 4 }, ME, now).work.stage, 'up_for_vote');
  assert.equal(aiWork.standing(open, ME, now).work.stage, 'reading');
  // A decision up for a vote waits for votes; one whose vote is owed is the feed's.
  const decision = { state: 'open', own: true, kind: 'decision', number: null, created_at: at, decision_status: 'open' };
  assert.deepEqual(aiWork.standing({ ...decision, decision_mine: true }, ME, now),
    { group: 'waiting', work: work('up_for_vote'), at, myVote: null });
  assert.equal(aiWork.standing({ ...decision, decision_vote: 'yes' }, ME, now).myVote, 'yes');
  assert.equal(aiWork.standing(decision, ME, now), null, 'a vote she owes is Needs you\'s');
  assert.equal(aiWork.standing({ ...decision, own: false, decision_vote: 'yes' }, ME, now), null, 'one she only voted on');
  assert.equal(aiWork.standing({ ...decision, decision_mine: true, decision_status: 'applied' }, ME, now), null, 'decided');
});

test('the server arranges Waiting nearest to live first, and matches the stored states by request', () => {
  const aiWork = require('../src/services/ai-work');
  const now = new Date('2026-10-29T12:00:00Z');
  const row = (id, number, extra = {}) => ({
    id, number, request_id: id, kind: 'work', state: 'open', own: true, slug: 'garden', name: 'Garden club',
    request_title: `R${number}`, request_state: 'open', request_at: `2026-10-2${id}T00:00:00Z`, created_at: '2026-10-20T00:00:00Z', ...extra,
  });
  const ws = (stage, extra = {}) => ({ stage, why: null, reason: null, line: null, since: null, requesterId: 5, ...extra });
  const states = new Map([
    ['garden#6038', ws('reading', { line: { code: 'waiting' } })],
    ['garden#6014', ws('building', { line: { code: 'held_waiting' }, since: '2026-10-29T01:00:00Z' })],
    ['garden#6002', ws('waiting_for_you', { why: 'plan', since: '2026-10-29T02:00:00Z' })],
    ['garden#6025', ws('up_for_vote', { since: '2026-10-29T03:00:00Z' })],
    ['garden#6026', ws('checking', { since: '2026-10-29T04:00:00Z' })],
  ]);
  const lists = aiWork.arrange([
    row(1, 6038),
    row(2, 6014),
    row(3, 6002),
    row(4, 6025, { change_status: 'promoted', change_user: 9, voted: true, my_vote: 'yes', change_id: 1, pr_number: 6025 }),
    // #6060: a change still waiting for its checks sorts with the votes, ahead of held.
    row(5, 6026, { change_status: 'promoted', change_user: 9, voted: true, my_vote: 'yes', change_id: 2, pr_number: 6026 }),
  ], 5, now, null, states);
  assert.deepEqual(lists.needs.map((t) => t.number), [6002], 'the plan waiting for Build it');
  assert.deepEqual(lists.waiting.map((t) => `${t.number}:${t.work.stage}`),
    ['6025:up_for_vote', '6026:checking', '6014:building', '6038:reading']);
  assert.deepEqual(lists.next, []);
});

test('a request the bot handed back is one its records say it left for a person, or whose build stopped', () => {
  const { handedBack, stageOf } = require('../src/services/homeroom-bot-progress');
  const looked = { mode: 'live', verdict: 'person', request_closed: false, proposal_status: null };
  assert.equal(stageOf(looked), null, 'nothing about it is in progress');
  assert.equal(handedBack(looked), 'decide');
  assert.equal(handedBack({ ...looked, verdict: 'ready', build_ok: false, build_error: 'turn timed out' }), 'build_stopped');
  assert.equal(handedBack({ ...looked, verdict: 'ready', build_ok: false, build_error: 'skipped: answered meanwhile' }), null, 'a skip did not stop');
  assert.equal(handedBack({ ...looked, verdict: 'ready', build_ok: false, build_error: 'blocked: needs a key' }), null, 'nor one that asks for detail');
  assert.equal(handedBack({ ...looked, request_closed: true }), null, 'never on a closed request');
  assert.equal(handedBack({ ...looked, proposal_status: 'promoted' }), null, 'nor with a change of it up');
  assert.equal(handedBack({ ...looked, mode: 'shadow' }), null, 'only its acted-on looks');
  assert.equal(handedBack({ ...looked, verdict: 'empty' }), null);
  // #6306: a look that found the ask already there only waits to be closed.
  assert.equal(handedBack({ ...looked, run_already_done: true }), 'already_works');
  assert.equal(handedBack({ ...looked, verdict: 'empty', run_already_done: true }), 'already_works');
  assert.equal(handedBack({ ...looked, verdict: 'ready', run_already_done: true }), null, 'a ready verdict is unchanged');
  // The stored work state reads it the same way (services/work-state.js derive).
  const { derive } = require('../src/services/work-state');
  assert.deepEqual([derive(looked).stage, derive(looked).why], ['waiting_for_you', 'decide']);
  assert.deepEqual([derive({ ...looked, run_already_done: true }).why], ['already_works']);
  const stopped = derive({ ...looked, verdict: 'ready', build_ok: false, build_error: 'turn timed out' });
  assert.deepEqual([stopped.stage, stopped.reason], ['stopped', 'build_failed']);
});

test('B03: a first version being built is In progress, never Waiting · Nobody yet', () => {
  const aiWork = require('../src/services/ai-work');
  const states = new Map([['flat-chores#1', { stage: 'building', why: null, reason: null, line: null, since: '2026-11-01T22:00:00Z', requesterId: 5 }]]);
  const row = {
    id: 60, kind: 'request', slug: 'flat-chores', name: 'Flat Chores', number: 1, request_id: 60, request_title: 'First version of Flat Chores',
    state: 'open', request_state: 'open', own: true, created_at: '2026-11-01T21:50:00Z',
  };
  const lists = aiWork.arrange([row], 5, new Date('2026-11-01T22:08:00Z'), null, states);
  assert.deepEqual(lists.next.map((t) => [t.number, t.work.stage, t.by]), [[1, 'building', 'bot']]);
  assert.equal(lists.waiting.length, 0, 'not Waiting · Nobody yet');
});

test('Homeroom bot answers "where do things stand?" from the lists this page draws', () => {
  const aiWork = require('../src/services/ai-work');
  const games = { slug: 'games', name: 'Game corner' };
  const needs = [
    { kind: 'proposal', id: 1, number: 6032, title: 'Spell out the rules', app, author: 'homeroom_bot', request: { number: 6038 } },
    { kind: 'ballot', id: 2, number: 6040, title: 'A or B', app, ballot: { number: 6039, title: 'Night theme' } },
  ];
  const work = {
    private: [{ rootId: 9, title: 'A calendar idea', app: null }],
    needs: [thread(1, 6010, 'decide', { group: 'needs', title: 'Points table' }), thread(2, 6038, 'plan', { group: 'needs' })],
    next: [thread(3, 6020, 'building', { group: 'next', by: 'someone', work: { line: { code: 'claimed', by: 'snait' } }, title: 'Sound toggle', app: games })],
    waiting: [thread(4, 6014, 'held', { title: 'Export' }), thread(5, 6039, 'vote', { title: 'Owed already' })],
    live: [thread(6, 6001, 'live', { group: 'live', title: 'Pause button' })],
  };
  const lists = aiWork.listsOf(needs, work, { botUsername: 'homeroom_bot' });
  assert.deepEqual(lists.needsYou.map((r) => [r.number || null, r.title, r.says]), [
    [6038, 'Spell out the rules', 'waits for their vote'],
    [6039, 'Night theme', 'waits for them to pick one of its changes'],
    [6010, 'Points table', 'Waiting for you to decide'],
    [null, 'A calendar idea', 'their private thread with Homeroom bot, not posted yet'],
  ], 'the feed\'s cards by their requests\' numbers, then what the bot handed back; #6038\'s plan is the vote above');
  assert.deepEqual(lists.inProgress.map((r) => [r.projectName, r.says]), [['Game corner', 'Building · snait is building it']]);
  assert.deepEqual(lists.waiting.map((r) => r.says),
    ['Ready to build · Waiting for changes up for a vote to be decided; a vote they owe on Homeroom bot\'s changes can free its slot'],
    'the vote owed on #6039 is Needs you\'s alone');
  assert.deepEqual(lists.liveThisWeek.map((r) => r.says), ['Live']);
  assert.deepEqual(lists.counts, { needsYou: 3, inProgress: 1, waiting: 1, liveThisWeek: 1 }, 'the headings\' counts: a private thread asks nothing');
  // my_work carries them, and the prompt says to answer from them.
  const mayor = read('src/services/homeroom-bot-mayor.js');
  assert.match(mayor, /onYourPage = await \(deps\.aiWork \|\| require\('\.\/ai-work'\)\)\.pageLists\(pool, \{/);
  assert.match(mayor, /call my_work and answer from its onYourPage:/);
  assert.match(mayor, /myWork\(pool, \{ userId: user\.id, user, settings, config: ctx\.config, deps \}\)/);
  // The feed is read the way its route reads it.
  assert.match(read('src/services/ai-work.js'), /feed\(pool, \{ user, showSelfHosted, inThreads: true \}\)/);
});

test('Needs you here is the threads you are in, counted in the label\'s ink, with no link to every vote', () => {
  const src = read('frontend/src/features/ai/index.tsx');
  assert.match(src, /readJson<\{ items\?: NeedItem\[\] \}>\(`\/api\/workshop\/needs-feed\?in=threads\$\{qs \? '&demo=1' : ''\}`, init\)/);
  assert.match(read('frontend/src/features/ai/lists.tsx'),
    /head=\{owedShown \? t\('messages:ai\.work\.titleCount', \{ count: owedShown \}\) : t\('messages:ai\.work\.title'\)\}/,
    'the count is in the label\'s own words, not a link');
  assert.ok(!src.includes('ws=needs#communities'), 'All votes is gone');
  assert.equal(message('messages:ai.work.title'), 'Needs you');
  assert.equal(message('messages:ai.work.titleCount', { count: 5 }), 'Needs you · 5');
  const route = read('src/routes/workshop-overview.js');
  assert.match(route, /inThreads: req\.query\.in === 'threads',/);
  assert.match(route, /pool\.query\(inThreads \? NEEDS_FEED_IN_THREADS_SQL : NEEDS_FEED_SQL, \[/);
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
  // A claim this week names who has it (homeroom-bot.js CLAIM_TTL_DAYS).
  assert.match(THREADS_SQL, /ic\.claimed_at > NOW\(\) - make_interval\(days => 7\)/);
  assert.match(THREADS_SQL, /cl\.username AS claimed_by, cl\.mine AS claimed_mine,/);
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
  assert.match(src, /readJson<AiWork>\(`\/api\/ai\/work\$\{qs\}`, init\)/);
  // Main docked beside it only on a wide window, after mount.
  assert.match(src, /const \[wide, setWide\] = useState\(false\);/);
  assert.match(src, /\{docked \? \(\s*<aside\s+id="ai-main-pane"\s+ref=\{mainRef\}\s+className="ai-main-pane"/);
  // #6425: nothing is drawn beside the lists; the chat is mounted only when
  // the column is open, or a thread asked for is still to be put there.
  assert.match(src, /const columnOpen = docked && !!column;/);
  assert.match(src, /const conversationUp = columnOpen \|\| !!at\?\.threadRootId;/);
  assert.match(src, /<EmbeddedConversation conversationId=\{botId!\} active=\{visible && columnOpen\} at=\{at\} mainChat \/>/);
  assert.match(src, /void loadConversations\(\);/, 'and the list is read, so Main\'s row says what is new while it is closed');
  // Ask Homeroom bot opens Main; a private thread opens in the column, and
  // before the page knows its width, by its address.
  assert.match(src, /<a\s+href="#homeroom-bot\/main"\s+className="messages-composer-card ai-askbar-card"/);
  assert.match(src, /if \(!\(wide \|\| phone\)\) \{ go\(botTabAddress\(next\)\); return; \}/);
  // What the column shows is read from the store after mount only.
  assert.match(src, /const column: Column = !mounted \|\| !botId \? null/);
  assert.match(src, /const botRow = mounted \? snap\.conversations\.find/);
});

test('a page drawn before sign-in is confirmed asks again once it is, and its Ask bar starts at the rail', () => {
  const src = read('frontend/src/features/ai/index.tsx');
  // app.js announces the signed-in viewer with sv:session, on a saved-session
  // boot and again once the server confirms it; both reads and the docked
  // chat go again then, instead of staying empty until a reload.
  assert.match(src, /const again = \(\) => setSession\(\(n\) => n \+ 1\);\s+document\.addEventListener\('sv:session', again\);\s+return \(\) => document\.removeEventListener\('sv:session', again\);/);
  assert.match(src, /return \(\) => \{ live = false; clearTimeout\(early\); \};\s+\}, \[visible, session, moved\]\);/);
  assert.match(src, /\}, \[visible, wide, phone, botId, session\]\);/);
  assert.match(read('public/js/app.js'), /document\.dispatchEvent\(new CustomEvent\('sv:session', \{\s+detail: \{ user: App\.user, verifiedSession: true \},/,
    'the confirmation it waits for');
  // A wide window whose Main is not docked (yet, or at all) keeps the bar
  // on the page, clear of the sidebar.
  assert.match(read('public/css/app.css'), /#ai-screen \.ai-askbar \{\s+position: fixed;\s+(\/\*[^*]*\*+([^/*][^*]*\*+)*\/\s+)?inset-inline-start: calc\(var\(--platform-rail-w, 0px\) \+ var\(--platform-gutter, 0px\)\);\s+inset-inline-end: var\(--platform-gutter, 0px\);/);
});

test('#homeroom-bot is the page; /main and /thread/<id> are Main and a thread in its column; #ai lands there', () => {
  const app = read('public/js/app.js');
  // 1 Nov 2026: every address is the page's, and says where in its chat.
  assert.match(app, /if \(parts\[0\] === 'homeroom-bot'\) \{[\s\S]*?App\.setChromeless\(false\);\s+App\.navigateToAi\(\);\s+(?:\/\/[^\n]*\n\s+)*if \(parts\.length === 1\) \{\s+window\.UsernodeReact\?\.ai\?\.closeColumn\?\.\(\);\s+\}\s+if \(parts\[1\] === 'request' \|\| parts\[1\] === 'change' \|\| parts\[1\] === 'decision'\) \{\s+window\.UsernodeReact\?\.ai\?\.openItem\?\.\('#' \+ parts\.join\('\/'\)\);\s+\}\s+if \(parts\[1\] === 'main' \|\| parts\[1\] === 'thread' \|\| parts\[1\] === 'm'\) \{\s+const at = App\._messagesExtras\(parts\[1\] === 'main' \? parts\.slice\(2\) : parts\.slice\(1\)\);\s+window\.UsernodeReact\?\.ai\?\.openAt\?\.\(\{/);
  assert.doesNotMatch(app, /messages\.openBotThread\(root\)/, 'never the Messages screen');
  assert.match(app, /case 'homeroom-bot':[^\n]*\n\s+case 'ai': return 'ai-screen';/);
  // The old address is an alias: rewritten in place, then routed as the new one.
  assert.match(app, /if \(parts\[0\] === 'ai'\) \{[\s\S]*?history\.replaceState\(null, '', '#homeroom-bot' \+ \(parts\.length > 1 \? '\/' \+ parts\.slice\(1\)\.join\('\/'\) : ''\)\);[\s\S]*?parts\[0\] = 'homeroom-bot';\s+\}\s+if \(parts\[0\] === 'homeroom-bot'\) \{/);
  // A Messages address of the bot's chat is swapped in place for the tab's.
  assert.match(app, /const botTab = validConversation \? window\.UsernodeReact\?\.ai\?\.botTabFromMessages\?\.\(`#\$\{hash\}`\) : null;\s+if \(botTab\) \{\s+try \{ history\.replaceState\(null, '', App\._rootUrl\(botTab\)\); \} catch \(_\) \{ return; \}\s+App\.restoreFromHash\(\);\s+return;\s+\}/);
  assert.match(read('frontend/src/features/nav-drawer/messages-drawer.ts'), /if \(at\.conversationId && at\.bot\) return false;/);
});

test('the way into the bot\'s chat: each address and each door names a place in it, on its tab', () => {
  const door = loadTsx('frontend/src/features/ai/door.ts');
  const plain = (v) => JSON.parse(JSON.stringify(v));
  assert.equal(door.botTabAddress(null), '#homeroom-bot/main');
  assert.equal(door.botTabAddress({ threadRootId: 139 }), '#homeroom-bot/thread/139');
  assert.equal(door.botTabAddress({ threadRootId: 139, focusMessageId: 150 }), '#homeroom-bot/thread/139/m/150');
  assert.equal(door.botTabAddress({ focusMessageId: 150 }), '#homeroom-bot/main/m/150');
  assert.equal(door.botTabAddress({ threadRootId: 139, focusMessageId: 139 }), '#homeroom-bot/thread/139', 'the root is no message to land on in its own thread');
  assert.equal(door.botTabAddress({ threadRootId: -4 }), '#homeroom-bot/main', 'nothing that is not an id');
  assert.deepEqual(plain(door.botTabAt('#homeroom-bot/thread/139/m/150')), { threadRootId: 139, focusMessageId: 150 });
  assert.deepEqual(plain(door.botTabAt('#homeroom-bot/main')), { threadRootId: null, focusMessageId: null });
  assert.deepEqual(plain(door.botTabAt('#homeroom-bot/m/150')), { threadRootId: null, focusMessageId: 150 });
  assert.equal(door.botTabAt('#homeroom-bot'), null, 'the page itself: the column as it was');
  // A Messages address of the bot's chat is the same place, by its old address.
  assert.equal(door.botTabFromMessages('#messages/2', 2), '#homeroom-bot/main');
  assert.equal(door.botTabFromMessages('#messages/2/thread/139', 2), '#homeroom-bot/thread/139');
  assert.equal(door.botTabFromMessages('messages/2/thread/139/m/141', 2), '#homeroom-bot/thread/139/m/141');
  assert.equal(door.botTabFromMessages('#messages/2/m/141', 2), '#homeroom-bot/main/m/141');
  assert.equal(door.botTabFromMessages('#messages/3/thread/139', 2), null, 'any other chat is Messages\'');
  assert.equal(door.botTabFromMessages('#messages/2', null), null, 'nor while which chat is the bot\'s is not known');
  assert.equal(door.botTabFromMessages('#messages/app/garden', 2), null);
  // The side panel never draws it: its tab does.
  assert.equal(door.isBotChatRoute('messages/2/thread/139', 2), true);
  assert.equal(door.isBotChatRoute('messages/20', 2), false);
  assert.equal(door.isBotChatRoute('app/garden/dev/issues/4', 2), false);
  const controller = read('frontend/src/features/side-panel/controller.ts');
  for (const site of ['export function take(', 'export function onClickCapture(', 'export function onNavigate(']) {
    const body = controller.slice(controller.indexOf(site), controller.indexOf(site) + 2000);
    assert.match(body, /if \(!panelTakes\(route\) \|\| !canTake\(\)\)/, site);
  }
  // The page takes the router's ask once, in its column.
  const src = read('frontend/src/features/ai/index.tsx');
  assert.match(src, /if \(!ask \|\| ask\.seq === askTaken\.current \|\| !visible \|\| !\(wide \|\| phone\)\) return;\s+askTaken\.current = ask\.seq;\s+how\.current = 'row';\s+if \(ask\.close\) closeColumn\(\);\s+else if \(ask\.item\) openItem\(ask\.item\);\s+else if \(ask\.at\) showAt\(ask\.at\);/);
  assert.match(read('frontend/src/features/ai/door.ts'), /host\.ai = \{ \.\.\.\(host\.ai \|\| \{\}\), openAt: askBotTab,/);
});

test('every door into the bot\'s chat lands on its tab, never the Messages screen', () => {
  const store = read('frontend/src/features/messages/store.ts');
  // open(), openAddress(), the bot doors, a quote and a request's See progress.
  assert.match(store, /if \(validId\(conversationId\) && conversationId === botConversationId\(\)\) \{ openBotTab\(null\); return; \}/);
  assert.match(store, /if \(\/\^#homeroom-bot\(\?:\\\/\|\$\)\/\.test\(href\)\) \{ goBotAddress\(href\); return; \}/);
  assert.match(store, /const botTab = botTabFromMessages\(href, botConversationId\(\)\);\s+if \(botTab\) \{ goBotAddress\(botTab\); return; \}/);
  const openBot = store.slice(store.indexOf('export async function openBot('), store.indexOf('export async function openBotRequest('));
  assert.match(openBot, /openBotTab\(null\);/);
  assert.doesNotMatch(openBot, /\bopen\(id\)/);
  assert.match(store, /if \(at\) openBotTab\(\{ threadRootId: null, focusMessageId: at \}\);/, 'See progress, at the request\'s message');
  assert.match(store, /openBotThread: \(rootId: number\) => \{ openBotTab\(\{ threadRootId: rootId, focusMessageId: null \}\); \},/);
  // A cold link: once the store learns the chat is the bot's, as for a channel.
  assert.match(store, /if \(active\.homeroomBot && active\.kind !== 'channel'\) \{\s+noteBotConversation\(active\.id\);\s+if \(state\.route\.open && !state\.route\.embedded\) \{\s+publish\(\{ active \}\);\s+if \(botToTab\(\)\) return;/);
  assert.match(store, /channelToHub\(\);\s+botToTab\(\);/, 'and when the list lands');
  // Design threads, bell rows and the first session name the tab.
  assert.match(read('src/services/design-threads.js'), /href: `#homeroom-bot\/thread\/\$\{Number\(opened\.messageId\)\}`,/);
  assert.match(read('frontend/src/features/first-session/index.tsx'), /else if \(screen === 'bot' && conversationId\) window\.location\.hash = '#homeroom-bot\/main';/);
  // The inbox does not list it.
  const { buildInbox } = loadTsx('frontend/src/features/messages/inbox.ts');
  const entries = buildInbox({ conversations: [
    { id: 2, lastActivityAt: '2026-11-01T10:00:00Z', kind: 'direct', homeroomBot: true },
    { id: 3, lastActivityAt: '2026-11-01T09:00:00Z', kind: 'direct' },
  ] });
  assert.deepEqual(entries.map((e) => e.key), ['person:3']);
});

test('the screen renders as the prerender does: hidden, the bot\'s name, Needs you, the Ask bar, no rows', () => {
  const { renderComponent } = require('./lib/render-tsx');
  const html = renderComponent('frontend/src/features/ai/index.tsx', 'AiScreen', {});
  // (React hoists the bot's picture as an image preload ahead of it.)
  assert.match(html, /^(<link rel="preload" as="image" href="\/brand\/homeroom-mark\.png"\/>)?<main id="ai-screen" class="hidden flex-1 overflow-y-auto platform-safe-scroll" data-page-bounce=""/);
  assert.match(html, /<h1 class="[^"]*">Homeroom bot<\/h1>/);
  assert.match(html, /Needs you/);
  assert.match(html, /<a href="#homeroom-bot\/main" class="messages-composer-card ai-askbar-card" aria-label="Ask Homeroom bot">/);
  assert.ok(!html.includes('data-ai-line'), 'no rows before the effects read them');
  assert.ok(!html.includes('ai-drawer'), 'and no drawer before mount, on a phone either');
  assert.ok(!html.includes('data-ai-main=""'), 'and Main is not docked before mount');
  // 1 Nov 2026: Main Chat is the list's first row, from the first render, lit only once mounted.
  assert.match(html, /<div class="[^"]*" data-ai-sheet="main"><button type="button" class="[^"]*" data-ai-main-row=""><img [^>]*\/><span class="[^"]*">Main Chat<\/span><\/button><\/div>/);
  assert.ok(!html.includes('data-ai-lit'), 'nothing is lit before the page knows what its column shows');
});

test('Main Chat is the list\'s first row: the bot\'s mark, its name, what is new in words, lit while in the column', () => {
  const { renderComponent } = require('./lib/render-tsx');
  const rows = [
    { key: 'private:139', title: 'A weekly email', app: null, who: 'solo', sub: { id: 'messages:ai.row.privateIdea' }, pill: null, href: null, rootId: 139 },
    { key: 'private:730', title: 'A darker header', app: null, who: 'solo', sub: { id: 'messages:ai.row.privateIdea' }, pill: null, href: null, rootId: 730 },
  ];
  const props = (main, lit = null) => ({
    hero: null, main: { open() {}, ...main }, lit, ready: true, rows, owed: 0, progress: [], waiting: [], live: [], openRow() {}, openThread() {},
  });
  const LISTS = 'frontend/src/features/ai/lists.tsx';
  const lit = renderComponent(LISTS, 'AiLists', props({ lit: true, unread: 2 }));
  // First, before Needs you; its unread count in words.
  assert.ok(lit.indexOf('data-ai-main-row') < lit.indexOf('data-ai-list="work"'), 'the first row');
  assert.match(lit, /data-ai-main-row="" data-ai-lit="" aria-current="true">/);
  assert.match(lit, /<span class="[^"]*" data-ai-main-unread="">2 new<\/span>/);
  assert.equal(message('messages:ai.main.new', { count: 1 }), '1 new');
  const quiet = renderComponent(LISTS, 'AiLists', props({ lit: false, unread: 0 }, 'private:730'));
  assert.doesNotMatch(quiet, /data-ai-main-row="" data-ai-lit/, 'Main is not lit while a thread is in the column');
  assert.doesNotMatch(quiet, /data-ai-main-unread/, 'and nothing new says nothing');
  // The thread in the column is the lit row, where you are, and only it.
  assert.equal((quiet.match(/data-ai-lit=""/g) || []).length, 1);
  assert.match(quiet, /data-ai-line="private" data-ai-lit="" aria-current="true"><span[^>]*>[\s\S]*?A darker header/);
  // #6424: the lit card itself is tinted, and the row inside it draws no
  // smaller box with its own corners, so no uneven ring shows round the blue.
  const litSheet = lit.match(/<div class="([^"]*)" data-ai-sheet="main"><button type="button" class="([^"]*)"/);
  assert.ok(litSheet, 'Main Chat\'s card is first');
  assert.match(litSheet[1], /bg-\[color:var\(--lit-tint\)\]/, 'the open chat\'s card takes the lit tint');
  assert.doesNotMatch(litSheet[2], /rounded-md|--lit-tint/, 'and its row draws no tinted box of its own');
  const quietSheet = quiet.match(/<div class="([^"]*)" data-ai-sheet="main"/);
  assert.ok(quietSheet, 'Main Chat\'s card');
  assert.match(quietSheet[1], /bg-\[color:var\(--dc-sheet-solid\)\]/, 'unlit, the card is the plane fill as before');
  const src = read(LISTS);
  assert.match(src, /const LIT_ROW = '[^']*bg-\[color:var\(--lit-tint\)\] text-\[color:var\(--lit-ink\)\]';/, 'the lit tint and ink, as the rail\'s rows are');
  // The page lights what the column shows (./column.ts): Main, a thread, a
  // page (#6218), or nothing while a blank thread holds it.
  assert.match(read('frontend/src/features/ai/index.tsx'), /const shown = columnKey\(column\);\s+const lit = shown === 'new' \? null : shown;/);
});

// #6160 (2 Nov 2026): In progress and Waiting were two sections inside the
// Needs you card, under a line each, so on a busy account that card of
// to-dos ran on long past what needed you. They are one quieter card of
// their own now, between Needs you and Live this week, drawn as that is.
test('#6160: Waiting & in progress is a card of its own between Needs you and Live this week, quieter rows, work under way first', () => {
  const { renderComponent } = require('./lib/render-tsx');
  const LISTS = 'frontend/src/features/ai/lists.tsx';
  const bakery = { slug: 'bakery', name: 'Bakery orders', icon_url: null, icon_emoji: null };
  const row = (threadId, a, what, extra = {}) => ({
    ...thread(threadId, 100 + threadId, what, { group: 'next', ...extra }),
    title: `${a.name} ${what} ${threadId}`, app: a, href: `#app/${a.slug}/dev/issues/${100 + threadId}`,
  });
  // Under way first, then what waits: two projects, one with more rows than
  // it shows before its own Show more.
  const progress = [row(1, app, 'going_live'), row(2, bakery, 'building', { by: 'bot' })];
  const waiting = [
    row(3, app, 'vote'), row(4, bakery, 'not_picked_up'),
    row(5, app, 'checking'), row(6, bakery, 'held'),
    row(7, app, 'queued'), row(8, app, 'not_picked_up'),
  ];
  const live = [{ ...row(9, app, 'live'), group: 'live' }];
  const props = (extra = {}) => ({
    hero: null, main: { open() {}, lit: false, unread: 0 }, ready: true, rows: [], owed: 0,
    progress: [], waiting: [], live: [], openRow() {}, openThread() {}, ...extra,
  });
  const html = renderComponent(LISTS, 'AiLists', props({ progress, waiting, live }));

  const open = html.indexOf('data-ai-sheet="open"');
  const busy = html.indexOf('data-ai-sheet="busy"');
  const liveAt = html.indexOf('data-ai-sheet="live"');
  assert.ok(open >= 0 && busy > open && liveAt > busy, 'a sheet between Needs you and Live this week');

  // Needs you's card ends where your to-dos end: no In progress or Waiting
  // section, no lines, and none of their rows.
  const openSheet = html.slice(open, busy);
  assert.doesNotMatch(openSheet, /data-ai-list="(?:next|up)"/, 'the two sections are gone from Needs you');
  assert.doesNotMatch(openSheet, /data-ai-line="going_live"/);
  assert.match(openSheet, /data-ai-list="work"[^>]*><div class="[^"]*" data-ai-band="">/, 'Needs you keeps its own band');

  // A card like Live this week: its own band, the quieter rows, and a count
  // of everything in it, work under way and waiting together.
  const busySheet = html.slice(busy, liveAt);
  assert.match(busySheet, /data-ai-list="busy"><div class="[^"]*" data-ai-band="">/);
  assert.match(busySheet, /Waiting &amp; in progress · 8/);
  assert.match(busySheet, /class="flex w-full min-h-\[40px\] md:min-h-\[32px\][^"]*"[^>]*data-ai-line="going_live"/, 'the quiet row');
  assert.match(busySheet, /text-\[13px\] leading-5 text-zinc-600 dark:text-zinc-400/, 'the quiet title');
  assert.equal((busySheet.match(/data-ai-band=""/g) || []).length, 1, 'one band, as Live this week has');

  // One list, grouped by project: under way before waiting, and each
  // project's rows under its own name.
  const garden = busySheet.slice(busySheet.indexOf('data-ai-group="garden"'), busySheet.indexOf('data-ai-group="bakery"'));
  assert.ok(garden.indexOf('data-ai-line="going_live"') < garden.indexOf('data-ai-line="up_for_vote"'), 'work under way comes first');
  assert.match(garden, />Garden club</, 'under its project\'s name');
  // Four of the garden's rows are moving: three, then its own Show more for
  // the last. Its two not picked up rows fold under Not moving below.
  assert.match(garden, /Show 1 more/);
  assert.match(garden, /data-ai-group-rest=""/);
  assert.match(busySheet, /Not moving · 2/);
  // The bakery's two moving rows show whole.
  assert.doesNotMatch(busySheet.slice(busySheet.indexOf('data-ai-group="bakery"')), /data-ai-group-rest=""/);

  // Nothing under way or waiting, no card, as Live this week has none.
  const empty = renderComponent(LISTS, 'AiLists', props());
  assert.doesNotMatch(empty, /data-ai-sheet="busy"/);
  assert.doesNotMatch(empty, /data-ai-list="busy"/);
});

// #6153 (2 Nov 2026): a design thread filed as request #14 was listed twice,
// in Needs you as "Only you" and under In progress as #14, with nothing
// tying the two together. It is the request's row now, which opens it.
test('#6153: a design thread filed as a request is the request\'s row, which opens the thread; never a second "Only you" row', () => {
  const { needsYou, inProgress, upNext, liveThisWeek, filedKey, shortWords } = loadTsx(MODEL);
  const ear = { slug: 'ear-trainer', name: 'Ear Trainer', icon_url: null, icon_emoji: null };
  const design = (rootId, extra = {}) => ({ rootId, title: 'Can you first render the main screen?', kind: 'design', app: ear, at: null, ...extra });
  const request = (threadId, number, what, extra = {}) => thread(threadId, number, what, {
    app: ear, title: `Design: Ear Trainer ${number}`, href: `#app/ear-trainer/dev/issues/${number}`, ...extra,
  });
  const building = request(40, 14, 'building', { group: 'next', by: 'bot' });
  const work = { private: [design(731, { state: 'filed', resultRef: 14 })], needs: [], next: [building], waiting: [], live: [] };

  assert.deepEqual(needsYou([], work).map((r) => r.key), [], 'no private: row in Needs you');
  const [row, ...more] = inProgress([], work);
  assert.equal(more.length, 0, 'one row, the request\'s');
  assert.deepEqual([row.threadId, row.number, row.rootId, row.href], [40, 14, 731, '#app/ear-trainer/dev/issues/14'],
    'carrying the thread it was filed from');
  assert.deepEqual(shortWords(row), shortWords(building), 'its right side is the track\'s word, as it was');
  assert.notEqual(words(shortWords(row)), message('messages:ai.short.private'));
  assert.equal(building.rootId, undefined, 'the work it came from is left as it was');

  // A design thread that went nowhere yet is unchanged: its own row, Only you.
  const open = { ...work, private: [design(732, { state: 'open' })] };
  assert.deepEqual(needsYou([], open).map((r) => [r.key, r.rootId, r.pill]), [['private:732', 732, null]]);
  assert.equal(inProgress([], open)[0].rootId, undefined);
  assert.equal(inProgress([], { ...work, private: [design(733)] })[0].rootId, undefined, 'nor one from an older server, which says nothing of where it went');

  // Waiting and Live this week carry it the same; posted on a request as its plan, too.
  const later = {
    private: [design(734, { state: 'filed', resultRef: 15 }), design(735, { state: 'posted', resultRef: 16 })],
    needs: [], next: [], waiting: [request(41, 15, 'vote', { myVote: 'yes' })], live: [request(42, 16, 'live', { group: 'live' })],
  };
  assert.deepEqual(needsYou([], later).map((r) => r.key), []);
  assert.deepEqual(upNext([], later).map((t) => [t.number, t.rootId]), [[15, 734]]);
  assert.deepEqual(liveThisWeek(later).map((t) => [t.number, t.rootId]), [[16, 735]]);
  assert.deepEqual(liveThisWeek(null), []);

  // A request in no list (closed, live long ago): the thread stays reachable as it was.
  const gone = { private: [design(736, { state: 'filed', resultRef: 9 })], needs: [], next: [building], waiting: [], live: [] };
  assert.deepEqual(needsYou([], gone).map((r) => [r.key, r.rootId]), [['private:736', 736]]);
  // #6250: a kept thread says where it went, in the row's own words.
  assert.equal(words(needsYou([], gone)[0].sub), 'Only you · Ear Trainer · Filed as #9');
  const posted = { private: [design(737, { state: 'posted', resultRef: 8 })], needs: [], next: [building], waiting: [], live: [] };
  assert.equal(words(needsYou([], posted)[0].sub), 'Only you · Ear Trainer · Posted on #8');
  const putAway = { private: [design(738, { state: 'dropped' })], needs: [], next: [building], waiting: [], live: [] };
  assert.equal(words(needsYou([], putAway)[0].sub), 'Only you · Ear Trainer · Put away');
  const done = { private: [design(739, { state: 'done' })], needs: [], next: [building], waiting: [], live: [] };
  assert.deepEqual(needsYou([], done), [], 'a done thread is the only one left out');
  // An open thread in a project keeps today's line.
  const stillOpen = { private: [design(740, { state: 'open' })], needs: [], next: [building], waiting: [], live: [] };
  assert.equal(words(needsYou([], stillOpen)[0].sub), 'Only you · Ear Trainer · Not posted yet');
  // A vote you owe on its change is the feed's row, by the request's number: still one row.
  const owed = [{ kind: 'proposal', id: 12229, number: 330, title: 'Ear Trainer home', app: ear, request: { number: 14 } }];
  assert.deepEqual(needsYou(owed, work).map((r) => r.key), ['need:proposal:12229']);
  assert.deepEqual(inProgress(owed, work), []);
  // Two threads filed as one request: the newest is its row; the other is still listed.
  const twice = { ...work, private: [design(737, { state: 'posted', resultRef: 14 }), design(731, { state: 'filed', resultRef: 14 })] };
  assert.deepEqual(needsYou([], twice).map((r) => r.key), ['private:731']);
  assert.equal(inProgress([], twice)[0].rootId, 737);
  assert.equal(filedKey(design(738, { state: 'filed', resultRef: 14, app: null })), null, 'a thread in no project is no request\'s');
  assert.equal(filedKey(design(738, { state: 'dropped', resultRef: 14 })), null);
  assert.equal(filedKey(design(738, { state: 'filed', resultRef: 14 })), 'ear-trainer#14');

  // The row opens the thread (index.tsx openThread), and is lit while it is in the column.
  const { renderComponent } = require('./lib/render-tsx');
  const html = renderComponent('frontend/src/features/ai/lists.tsx', 'AiLists', {
    hero: null, main: { open() {}, lit: false, unread: 0 }, lit: 'private:731', ready: true, rows: [], owed: 0,
    progress: [row], waiting: [], live: [], openRow() {}, openThread() {},
  });
  assert.match(html, /data-ai-line="building" data-ai-lit="" aria-current="true">[\s\S]*?Design: Ear Trainer 14/);
  assert.doesNotMatch(html, /data-ai-line="private"/);
  assert.equal((html.match(/data-ai-lit=""/g) || []).length, 1);

  // Homeroom bot's answer reads the same lists: one row there too.
  const aiWork = require('../src/services/ai-work');
  const lists = aiWork.listsOf([], work, { botUsername: 'homeroom_bot' });
  assert.deepEqual(lists.needsYou, [], 'no private thread in Needs you');
  assert.deepEqual(lists.inProgress.map((r) => r.number), [14]);
  assert.equal(lists.counts.needsYou, 0);
  const kept = aiWork.listsOf([], gone, { botUsername: 'homeroom_bot' });
  assert.deepEqual(kept.needsYou.map((r) => r.says), ['their private thread with Homeroom bot, filed as #9']);
  assert.equal(kept.counts.needsYou, 0, 'a private thread asks nothing');
  assert.deepEqual(aiWork.listsOf([], posted, { botUsername: 'homeroom_bot' }).needsYou.map((r) => r.says),
    ['their private thread with Homeroom bot, posted on #8']);
  assert.deepEqual(aiWork.listsOf([], putAway, { botUsername: 'homeroom_bot' }).needsYou.map((r) => r.says),
    ['their private thread with Homeroom bot, put away']);
  // And the server says where each went (ai-work.js shapePrivate, PRIVATE_SQL).
  assert.match(aiWork.PRIVATE_SQL, /SELECT m\.id AS root_id, m\.content, m\.created_at, p\.kind, p\.state, p\.result_ref,/);
  const shaped = aiWork.shapePrivate({ root_id: 731, content: 'I opened a design thread.', kind: 'design', design_title: 'Ear Trainer home', state: 'filed', result_ref: 14, slug: 'ear-trainer', name: 'Ear Trainer' });
  assert.deepEqual([shaped.state, shaped.resultRef, shaped.title], ['filed', 14, 'Ear Trainer home']);
  const bare = aiWork.shapePrivate({ root_id: 9, content: 'An idea', created_at: null });
  assert.deepEqual([bare.state, bare.resultRef], [undefined, undefined], 'a thread with no row says nothing of where it went');
});

// #6271 (4 Nov 2026): marking a private thread done took it out of every
// list, so it could not be found again. It stays under Live this week for a
// week, with its lock and the day it closed, and still opens the thread.
test('#6271: a private thread marked done this week is Live this week\'s, and only for a week', () => {
  const { liveThisWeek, needsYou } = loadTsx(MODEL);
  const now = Date.parse('2026-11-04T12:00:00Z');
  const done = (rootId, doneAt, extra = {}) => ({
    rootId, title: `Closed ${rootId}`, kind: 'idea', app, at: null, state: 'done', doneAt, ...extra,
  });
  const work = {
    private: [
      done(801, '2026-11-03T12:00:00Z'),
      done(802, '2026-10-25T12:00:00Z'),
      // Its filed request has a live row: that row stays the one row.
      done(803, '2026-11-02T12:00:00Z', { resultRef: 21 }),
      done(804, '2026-11-04T09:00:00Z'),
      // An open one is not a closed row.
      { rootId: 805, title: 'Still open', kind: 'idea', app, at: null, state: 'open' },
    ],
    needs: [],
    next: [],
    waiting: [],
    live: [thread(21, 21, 'live', { group: 'live', app })],
  };
  const rows = liveThisWeek(work, now);
  const closed = rows.filter((t) => t.work.stage === 'closed');
  assert.deepEqual(closed.map((t) => [t.rootId, t.at]), [
    [804, '2026-11-04T09:00:00Z'],
    [801, '2026-11-03T12:00:00Z'],
  ], 'the last week\'s closed threads, newest closed first; the older one, the folded one and the open one are not');
  const row = closed.find((t) => t.rootId === 801);
  assert.deepEqual([row.threadId, row.number, row.kind, row.group, row.rootId, row.href], [0, null, 'private', 'live', 801, ''],
    'a live row that opens its thread, with no number');
  assert.ok(rows.findIndex((t) => t.work.stage === 'live') < rows.findIndex((t) => t.work.stage === 'closed'),
    'after the project\'s live requests');
  assert.deepEqual(needsYou([], work).map((r) => r.key), ['private:805'], 'a done thread is never Needs you\'s; the open one still is');

  // The row in the list: the lock, the title, and the hover text, opening the thread.
  const { renderComponent } = require('./lib/render-tsx');
  const solo = { rootId: 806, title: 'An app for our garden plot rota', kind: 'idea', app: null, at: null, state: 'done', doneAt: '2026-11-02T12:00:00Z' };
  const html = renderComponent('frontend/src/features/ai/lists.tsx', 'AiLists', {
    hero: null, main: { open() {}, lit: false, unread: 0 }, lit: 'private:801', ready: true, rows: [], owed: 0,
    progress: [], waiting: [], live: liveThisWeek({ ...work, private: [...work.private, solo] }, now), openRow() {}, openThread() {},
  });
  assert.match(html, /data-ai-line="closed"[^>]*[\s\S]*?M12 15v2m-6 4h12/, 'drawn with the lock glyph');
  assert.match(html, /Closed 801/);
  assert.match(html, /Garden club · Private thread · Closed/, 'its project, in front of "Private thread · Closed"');
  assert.match(html, /Private thread · Closed/);
  assert.match(html, /data-ai-line="closed" data-ai-lit="" aria-current="true"/, 'lit while its thread is in the column');
  assert.match(html, /data-ai-group="none"[\s\S]*?An app for our garden plot rota/, 'one with no project is under Only you');
  assert.ok(html.indexOf('data-ai-line="live"') < html.indexOf('data-ai-line="closed"'), 'under the project after its live row');
});

test('the column from 768px: Main, or one thread alone under its own head; a page the panel holds puts Main back under it', () => {
  const src = read('frontend/src/features/ai/index.tsx');
  assert.match(src, /const WIDE = '\(min-width: 768px\)';/);
  // Main's bar only over Main; a thread or a blank one has its own head.
  assert.match(src, /\{threadUp \? null : \(\s*<header className="ai-main-head" data-ai-main-head="">/);
  assert.match(src, /data-ai-column=\{columnOpen \? \(threadUp \? 'thread' : 'main'\) : undefined\}/);
  // A place in the chat: the panel gives the column back, a blank thread goes, Main closes a thread.
  // 1 Nov 2026 (C1): and a design's preview goes, unless it is that thread's.
  assert.match(src, /const showAt = \(next: BotAt\) => \{\s+sidePanel\(\)\?\.close\?\.\(\);\s+closeNewThread\(\);\s+if \(!detail \|\| detail\.kind === 'design'\) \{\s+if \(!next\.threadRootId \|\| next\.threadRootId !== detail\?\.ref\.rootId\) closeDetail\(\);\s+\}\s+if \(!next\.threadRootId && openRoot\) closeThread\(\);\s+setAt\(\{ \.\.\.next \}\);\s+(?:\/\/[^\n]*\n\s+)*if \(botId && next\.threadRootId\) embed\(botId, next\);\s+(?:\/\/[^\n]*\n\s+)*setMainOpen\(!next\.threadRootId \|\| column\?\.at === 'main'\);\s+if \(phone\) setLevel\(1\);\s+\};/);
  assert.match(src, /openPage\(row\.href, row\.app, row\.title, aboutRow\(row\)\);/);
  assert.match(src, /if \(openPublic\(href, app, title\)\) underPanel\(\);/);
  // 3 Nov 2026: the address is the column's, written by one effect (#6215).
  assert.match(src, /const underPanel = \(\) => \{\s+closeNewThread\(\);\s+if \(openRoot\) closeThread\(\);\s+\};/);
  // The panel takes a page beside this page from 768px too.
  const controller = read('frontend/src/features/side-panel/controller.ts');
  assert.match(controller, /export const BESIDE_AI_QUERY = '\(min-width: 768px\)';/);
  assert.match(controller, /return window\.matchMedia\(besideApp \? DESKTOP_QUERY : BESIDE_AI_QUERY\)\.matches;/);
  const css = read('public/css/app.css');
  assert.match(css, /@media \(max-width: 1023\.98px\) \{[^}]*?\*\/\s+body:not\(:has\(#ai-screen:not\(\.hidden\)\)\) #platform-side-panel \{\s+display: none;\s+\}\s+\}\s+@media \(max-width: 767\.98px\) \{\s+#platform-side-panel \{\s+display: none;\s+\}\s+\}/);
  assert.match(css, /@media \(max-width: 1023\.98px\) \{\s+body:has\(#ai-screen:not\(\.hidden\)\) \{ --ai-list-min: 280px; \}\s+\}/);
});

test('the tab\'s bare address closes what is open beside the lists (#6425)', () => {
  // Pressing the tab, or Back to `#homeroom-bot`, asks the page to close the
  // column; a link to Main, a thread or an item still opens it.
  const app = read('public/js/app.js');
  assert.match(app, /if \(parts\.length === 1\) \{\s+window\.UsernodeReact\?\.ai\?\.closeColumn\?\.\(\);\s+\}/);
  const door = read('frontend/src/features/ai/door.ts');
  assert.match(door, /export function askBotClose\(\): void \{\s+seq \+= 1;\s+asked = \{ at: null, item: null, close: true, seq \};/);
  assert.match(door, /closeColumn: askBotClose/);
  const src = read('frontend/src/features/ai/index.tsx');
  assert.match(src, /if \(ask\.close\) closeColumn\(\);/);
  assert.match(src, /if \(ask\.item\) openItem\(ask\.item\);\s+else if \(ask\.at\) showAt\(ask\.at\);/);
});

test('a thread opens on this page: beside the list in Main\'s place, or on its page with a way back here', () => {
  const src = read('frontend/src/features/ai/index.tsx');
  assert.match(src, /<aside\s+id="ai-main-pane"\s+ref=\{mainRef\}\s+className="ai-main-pane"\s+aria-labelledby=\{threadUp \? undefined : 'ai-main-title'\}\s+data-ai-main=""/);
  assert.match(src, /<span id="ai-main-title"[^>]*>\s+\{t\('messages:store\.header\.main'\)\}/);
  assert.match(src, /\{t\('messages:ai\.main\.sub'\)\}/);
  assert.equal(message('messages:ai.main.sub'), 'Only you can see this chat');
  assert.equal(message('messages:store.header.main'), 'Main Chat', 'Main Chat, over it, in Messages and in the drawer alike');
  // The panel takes it wherever it can (a wide window), with the row's project and title; its page otherwise.
  assert.match(src, /if \(sidePanel\(\)\?\.take\?\.\(href\.replace\(\/\^#\/, ''\), \{ place: app, label \}\)\) return true;/);
  assert.match(src, /if \(isTopicHref\(href\)\) improve\(\)\?\.enterTopicFrom\?\.\(BOT_PAGE\);\s+go\(href\);/,
    'a topic page opened from here goes back here');
  assert.match(src, /const BOT_PAGE = BOT_TAB;/);
  assert.equal(loadTsx('frontend/src/features/ai/door.ts').BOT_TAB, '#homeroom-bot');
  // #6153: a request filed from a private thread opens that thread first.
  assert.match(src, /const openThread = \(th: AiThread\) => \{(\s+\/\/[^\n]*)*\s+markThreadRead\(th\.threadId, th\.app\);(\s+\/\/[^\n]*)*\s+if \(th\.rootId\) \{\s+openPrivate\(th\.rootId\);\s+return;\s+\}\s+openPage\(th\.href, th\.app, th\.title, aboutRow\(th\)\);/,
    'In progress, Waiting and Live this week');
  assert.match(src, /openPage\(row\.href, row\.app, row\.title, aboutRow\(row\)\);\s+\};/, 'and Needs you');
  const { isTopicHref } = loadTsx(MODEL);
  assert.equal(isTopicHref('#app/garden/dev/issues/12'), true);
  assert.equal(isTopicHref('#app/garden/dev/changes/12'), true);
  assert.equal(isTopicHref('#app/garden/dev/governance/3'), true);
  assert.equal(isTopicHref('#app/garden/workshop'), false, 'a Workshop is no topic: the origin would wait for the next one');
  // A private thread is the column's: the panel gives its place back first (showAt).
  assert.match(src, /const openPrivate = \(rootId: number\) => \{\s+const next = \{ threadRootId: rootId, focusMessageId: null \};[\s\S]{0,160}showAt\(next\);\s+\};/);
  assert.match(src, /const openRow = \(row: WorkRow\) => \{\s+markThreadRead\(row\.threadId, row\.app\);\s+if \(row\.rootId\) \{\s+openPrivate\(row\.rootId\);\s+return;\s+\}/);
  // The panel may stand beside the AI tab's page, and stays while it is up.
  const controller = read('frontend/src/features/side-panel/controller.ts');
  assert.match(controller, /const besideAi = typeof A\._isScreenVisible === 'function' && A\._isScreenVisible\('ai-screen'\);/);
  assert.match(read('public/js/app.js'), /appPresence\?\.\(\(inApp \|\| screen === 'ai-screen'\) && !App\.chromeless\)/);
  // Opened from here on its page, it is still this tab's.
  const app = read('public/js/app.js');
  assert.match(app, /_isBotTopic\(\) \{\s+if \(!\(App\.currentTab === 'dev' && App\.currentSubTab === 'topic'\)\) return false;\s+const origin = window\.Improve\?\.topicOrigin\?\.\(\);/);
  assert.match(app, /\(App\._isMessagesThread\(\) \? 'messages' : App\._isBotTopic\(\) \? 'ai' : 'workshop'\)/, 'it keeps Homeroom bot lit');
});

test('on a phone the list and Main Chat are one drawer, as Messages\' are; a request opens on its page', () => {
  const src = read('frontend/src/features/ai/index.tsx');
  const drawer = read('frontend/src/features/ai/phone-drawer.tsx');
  // Messages' own slide and landing rule.
  assert.match(drawer, /import \{ isPan, landingIn, SLIDE_EASE, SLIDE_MS \} from '\.\.\/nav-drawer\/drawer-math';/);
  assert.match(drawer, /transition: still \? 'none' : `transform \$\{SLIDE_MS\}ms \$\{SLIDE_EASE\}`/);
  assert.match(drawer, /const still = drag != null \|\| reducedMotion\(\);/, 'none under Reduce Motion');
  // The level not in view is out of reach, not only out of sight.
  assert.match(drawer, /<div className="ai-drawer-list" inert=\{level === 1\} aria-hidden=\{level === 1 \? true : undefined\}>\{list\}<\/div>/);
  assert.match(drawer, /<div className="ai-drawer-pane" inert=\{level === 0\} aria-hidden=\{level === 0 \? true : undefined\}>\{pane\}<\/div>/);
  assert.ok(!drawer.includes('ai-drawer-peek'), 'nothing peeks beside the list (3 Nov 2026)');
  // Only Main Chat: no page in a frame (Evan, 30 Oct: "the Messages approach").
  assert.ok(!drawer.includes('<iframe'), 'a request is never drawn in the drawer');
  assert.match(src, /setAt\(\{ \.\.\.next \}\);\s+(?:\/\/[^\n]*\n\s+)*if \(botId && next\.threadRootId\) embed\(botId, next\);[\s\S]{0,220}?setMainOpen\([^;]*\);\s+if \(phone\) setLevel\(1\);/, 'a row slides the column in, at it');
  assert.match(src, /onClick=\{\(e\) => \{ if \(phone\) \{ e\.preventDefault\(\); openMain\(\); \} \}\}/, 'and so does the Ask bar');
  // Main Chat draws no bar of its own: the platform header names it (3 Nov 2026).
  assert.ok(!drawer.includes('ai-drawer-head'), 'one header: the platform\'s');
  assert.match(drawer, /return botId \? <EmbeddedConversation conversationId=\{botId\} active=\{active\} at=\{at\} mainChat onBack=\{onBack\} \/> : null;/);
  assert.match(src, /pane=\{<MainPane botId=\{botId\} active=\{visible\} at=\{at\} onBack=\{toList\} \/>\}/);
  assert.match(src, /data-ai-drawer=\{phone \? level : undefined\}/);
  assert.match(drawer, /const PHONE_QUERY = '\(max-width: 767\.98px\)';/);
});

test('on a phone the list is always the whole screen, and Main Chat\'s name and arrow are the platform header\'s (3 Nov 2026)', () => {
  const drawer = read('frontend/src/features/ai/phone-drawer.tsx');
  const src = read('frontend/src/features/ai/index.tsx');
  assert.match(drawer, /export const FULL_AT: readonly \[number, number\] = \[0, 1\];/, 'the column rests a whole screen to the right');
  assert.match(drawer, /const at = FULL_AT;/);
  assert.ok(!drawer.includes('OPENED_KEY'), 'no per-device switch into a drawer that peeks');
  assert.match(drawer, /const offset = drag \?\? at\[level\];/, 'rest, drag and landing all read the one table');
  assert.match(drawer, /const lands = landingIn\(at, p\.from, now, \(e\.clientX - p\.x\) \* dirSign\(\)\) as 0 \| 1;\s+botDepth\.slide\(lands\);\s+onLevel\(lands\);/);
  // The header moves with the strip.
  assert.match(drawer, /useEffect\(\(\) => \{ botDepth\.slide\(level\); \}, \[level\]\);/);
  assert.match(drawer, /setDrag\(next\);\s+botDepth\.set\(next\);/);
  // The screen says when the header is Main Chat's: a phone, on show, no private thread.
  assert.match(src, /publishBotDrawer\(\{ on: phone && visible && !threadUp, level, title: mainTitle, sub: mainSub \}\);/);
  assert.match(src, /useEffect\(\(\) => registerBotBack\(\(\) => toListRef\.current\(\)\), \[\]\);/);
  const store = read('frontend/src/features/nav-drawer/bot-drawer.ts');
  assert.match(store, /export const botDepth = createDepthChannel\(0, 1\);/);
  const header = read('frontend/src/features/nav-drawer/header-drawer.tsx');
  assert.match(header, /return on \? 'communities' : messages \? 'messages' : bot \? 'bot' : null;/);
  assert.match(header, /if \(mode === 'bot'\) return <BackDisc mode=\{mode\} label=\{t\('core:header\.drawer\.toBot'\)\} onBack=\{botBack\} \/>;/);
  const css = read('public/css/app.css');
  assert.match(css, /\.ai-drawer:not\(\[data-peek\]\) \.ai-drawer-list \{ width: 100%; \}/);
  assert.match(css, /\.ai-drawer:not\(\[data-peek\]\) \.ai-drawer-thread \{ inset-inline-start: 100%; \}/);
  assert.equal(message('core:header.drawer.toBot'), 'Back to the list');
});

test('what a row opens rides along in Main Chat\'s composer, and only there', () => {
  const src = read('frontend/src/features/ai/index.tsx');
  // #6212 (3 Nov 2026): what the column shows decides it (./column.ts attachmentFor).
  assert.match(src, /const what = attachmentFor\(before, column, was\);/);
  assert.match(src, /window\.dispatchEvent\(new CustomEvent\('usernode:messages-object-selected', \{\s+detail: \{ \.\.\.about, conversationId: botId, source: 'list' \},\s+\}\)\);/);
  assert.match(src, /\} else if \(what === 'clear'\) \{\s+window\.dispatchEvent\(new CustomEvent\('usernode:messages-object-cleared', \{ detail: \{ conversationId: botId \} \}\)\);/);
  const composer = read('frontend/src/features/messages/composer.tsx');
  assert.match(composer, /const \{ conversationId: to, source, \.\.\.object \} = detail;\s+if \(to != null && to !== conversationId\) return;/,
    'a composer under another conversation, mounted under a hidden screen, keeps what it had');
  const { aboutRow } = loadTsx('frontend/src/features/ai/index.tsx');
  assert.deepEqual(aboutRow({ href: '#app/garden/dev/issues/12', title: 'Dark mode', app }), { type: 'issue', appSlug: 'garden', issueNumber: 12, title: 'Dark mode' });
  assert.deepEqual(aboutRow({ key: 'need:governance:4', href: '#app/garden/dev/governance/4', title: 'Rename', app }),
    { type: 'governance', appSlug: 'garden', proposalId: 4, title: 'Rename' });
  assert.equal(aboutRow({ href: '#app/garden/workshop', title: 'x', app }), null, 'a Workshop is no item');
});

test('beside this page the panel is the page\'s own column: its × and the project, no Expand, Close or Back', () => {
  const panel = read('frontend/src/features/side-panel/side-panel.tsx');
  // #6431: the heading takes the page's own head too — its status pill.
  // 6 Nov 2026 (#6425): the × closes the page, in the place the "‹ Main Chat"
  // chip held: the round disc the panel's own Close draws, after the heading
  // and its ⋯.
  assert.match(panel, /className=\{`side-panel-ai-close \$\{DISC\}`\}/);
  assert.match(panel, /aria-label=\{t\('agent:sidePanel\.close'\)\}\s+title=\{t\('agent:sidePanel\.close'\)\}\s+onClick=\{\(\) => controller\.close\(\)\}/);
  assert.doesNotMatch(panel, /side-panel-main|sidePanel\.mainLabel|sidePanel\.threadLabel/,
    'the ‹ Main Chat / ‹ Thread chip is gone');
  assert.ok(panel.indexOf('<PanelMore route={s.route} />') < panel.indexOf('side-panel-ai-close'),
    'at the row\'s end, after ⋯');
  assert.match(panel, /<PanelHeading route=\{s\.route\} place=\{s\.place\} reported=\{s\.reported\} label=\{s\.label\} head=\{s\.head\} \/>/);
  assert.match(panel, /href=\{`#app\/\$\{encodeURIComponent\(slug\)\}\/workshop`\}/, 'the project, as a door to its page');
  assert.match(panel, /\(window as any\)\.AppView\?\._landOnHub\?\.\(slug\)/, 'which opens on its Hub');
  assert.equal(message('agent:sidePanel.close'), 'Close panel');
  const index = read('frontend/src/features/ai/index.tsx');
  // The page starts on the lists alone; Main Chat's row, or a link to it,
  // opens it, and × puts it away again.
  assert.match(index, /const \[mainOpen, setMainOpen\] = useState\(false\);/);
  assert.match(index, /: mainOpen \? \{ at: 'main' \} : null;/);
  assert.match(index, /const columnOpen = docked && !!column;/);
  assert.match(index, /const closeColumn = \(\) => \{\s+if \(!docked\) return;\s+sidePanel\(\)\?\.close\?\.\(\);\s+closeNewThread\(\);\s+if \(openRoot\) closeThread\(\);\s+closeDetail\(\);\s+setMainOpen\(false\);\s+setAt\(null\);\s+\};/);
  assert.doesNotMatch(index, /backTo/, 'no chip to name what the page goes back to');
  assert.match(index, /data-ai-open=\{columnOpen \? '' : undefined\}/);
  assert.match(index, /data-ai-main-close=""/);
  assert.equal(message('messages:ai.main.close'), 'Close Main Chat');
  const controller = read('frontend/src/features/side-panel/controller.ts');
  assert.match(controller, /export const BESIDE_AI_CLASS = 'side-panel-beside-ai';/);
  assert.match(controller, /classList\.toggle\(BESIDE_AI_CLASS, isBesideAi\(\)\)/);
  assert.match(controller, /const \{ place = null, label = null, \.\.\.rest \} = given \|\| \{\};/, 'the project and the title are this document\'s, not the page\'s hint');
  const css = read('public/css/app.css');
  assert.match(css, /body:has\(#ai-screen:not\(\.hidden\)\) \.side-panel :is\(#side-panel-back, #side-panel-title, #side-panel-expand, #side-panel-close\) \{\s+display: none;\s+\}/,
    'the panel\'s controls go, but not its left edge, the handle Main\'s edge is too');
  assert.match(css, /body:has\(#ai-screen:not\(\.hidden\)\) \.side-panel :is\(\.side-panel-ai-close, \.side-panel-place, \.side-panel-more\) \{ display: inline-flex; \}/);
  assert.match(css, /\.side-panel-head > :is\(\.side-panel-ai-close, \.side-panel-place, \.side-panel-more\) \{ display: none; \}/, 'and beside an app, as it was');
  assert.match(css, /html\.in-side-panel\.side-panel-beside-ai :is\(\.dev-topic-backs, \.dev-topic-back\) \{ display: none; \}/,
    'and the page in it leaves out its own "‹ Workshop"');
});

test('a request opened beside the bot list fills the column, not a box inside it (3 Nov 2026)', () => {
  const css = read('public/css/app.css');
  // One rule set, both panels: the AI column's document and the Workshop's
  // own side panel draw the same request page.
  const scope = ':is\\(html\\.in-side-panel\\.side-panel-beside-ai, \\.dev-ws-side\\)';
  assert.match(css, new RegExp(`${scope} #dev-topic-thread \\{\\s*padding-top: 0;\\s*\\}`),
    'the host drops its 12px top shoulder');
  assert.match(css, new RegExp(`${scope} \\.dev-request \\{\\s*max-width: none;\\s*margin-inline: 0;\\s*padding-inline: 0;\\s*\\}`),
    'the page drops its 780px cap and centred 12px side margins');
  assert.match(css, new RegExp(`${scope} \\.dev-request-sheet \\{[^}]*background: transparent;[^}]*backdrop-filter: none;`),
    'the sheet takes the column\'s surface instead of painting its own fill and frost');
  assert.match(css, new RegExp(`${scope} \\.dev-request-sheet \\{[^}]*box-shadow: none;`),
    'and lifts no shadow off it');
  assert.match(css, new RegExp(`${scope} :is\\(\\.dev-request-bar, \\.dev-request-scroll\\) \\{\\s*padding-inline: 12px;\\s*\\}`),
    'the 12px the wrapper gave the content stays on the bar and the transcript');
});

test('beside the bot page a request or a change lies on Main Chat\'s surface (#6432)', () => {
  const css = read('public/css/app.css');
  // The column is one sheet as Main is (30 Oct 2026), but the panel document
  // still painted the route wallpaper on its body, sized to the column: a
  // second star and grain showed through the request (6 Nov 2026). The page
  // now lies on the same plane colour as Main's pane and the list's cards,
  // and the intended declaration is the one the top document's own wallpaper
  // rule and the brand skin cannot outrank.
  assert.match(css, /html\.in-side-panel\.side-panel-beside-ai body \{\s+background: var\(--dc-sheet-solid\) !important;\s+\}/,
    'the beside-ai body paints the plane colour, which clears the wallpaper image too');
  assert.match(css, /html\.in-side-panel\.side-panel-beside-ai body::before \{\s+background: none !important;\s+\}/,
    'and the phone browser\'s fixed wallpaper layer is gone behind it');
  // The claim that the colour matches Main in both themes: the token is the
  // one composite, and Main's pane is the ground the thread pane sits over.
  assert.match(css, /--dc-sheet-solid: #faf9f2;/, 'light: the list\'s card colour');
  assert.match(css, /--dc-sheet-solid: #17181d;/, 'dark: the same composite over the dark ground');
  assert.match(css, /#ai-screen \.ai-main-pane \{[^}]*background: var\(--home-ground\);/,
    'the surface it must match is Main\'s pane');
  // Everywhere else the wallpaper stays: the full page (the top document has
  // no `in-side-panel`) and the Workshop's own panel are not named here.
  assert.match(css, /\n  background: var\(--home-wallpaper\);\n\}/,
    'the route wallpaper is still painted on the plain page');
  assert.doesNotMatch(css, /(?:^|\n)(?:body|\.dev-ws-side[^\n]*body) \{[^}]*--dc-sheet-solid/,
    'no plain body rule, and nothing in the Workshop\'s panel, paints the plane colour');
});

test('beside the bot page a request or a change has one header, so its own bar is not drawn (#6431)', () => {
  const css = read('public/css/app.css');
  // The column's heading carries the page's status pill and everything its ⋯
  // holds (side-panel.tsx), so the page's own bar — which repeated the number,
  // the pill, a category and a second ⋯ — is hidden outright.
  assert.match(css, /html\.in-side-panel\.side-panel-beside-ai \.dev-request-bar \{ display: none; \}/,
    'the bar goes, for a request and a change alike');
  assert.match(css, /html\.in-side-panel\.side-panel-beside-ai \.dev-request-bar :is\(\[data-request-kicker\], \.dev-request-bar-title, \[data-request-category\], \[data-change-category\]\) \{ display: none; \}/,
    'nothing of it is drawn through, both categories and a change\'s number included');
  assert.doesNotMatch(css, /\.side-panel-beside-ai \.dev-request-bar:not\(:has\(/,
    'the "only when it has nothing left" rule it replaces is gone');
  // Everywhere else the page keeps its bar: the full page and the Workshop's
  // own side panel are the top document, and the column's heading is not there.
  assert.doesNotMatch(css, /:is\(html\.in-side-panel\.side-panel-beside-ai, \.dev-ws-side\) \.dev-request-bar \{ display: none; \}/,
    'the Workshop\'s panel is untouched');
});

test('Main\'s column is held inside the window, and the panel takes its place at its width', () => {
  const css = read('public/css/app.css');
  // A width chosen beside an app on a wide monitor must not run Main under
  // the rail; with none chosen, Main takes the room the list does not need
  // (30 Oct 2026). Since 3 Nov 2026 that is all of it: the 720px cap is gone
  // (a 1720px window left a band between the list and Main), the 400px floor
  // stays, and Main reads its own chosen width, not the side panel's. The
  // room is the page's usable box, the window less the rail and the Duo's
  // column, declared once on body (1 Nov 2026; tests/usable-box.test.js pins
  // how it is made).
  assert.match(css, /body:has\(#ai-screen:not\(\.hidden\)\) \{\s+--ai-room: var\(--platform-usable-w\);\s+--ai-list-min: var\(--list-pane-w\);\s+--ai-main-auto: max\(400px, calc\(var\(--ai-room\) - var\(--list-pane-w\)\)\);\s+--ai-main-w: max\(320px, min\(var\(--ai-main-chosen-w, var\(--ai-main-auto\)\), calc\(var\(--ai-room\) - var\(--ai-list-min\)\)\)\);\s+\}/);
  // 9 Nov 2026 (#6495): the bot tab's list is the Messages inbox's list while
  // something is open beside it, so the two pages share one measure and the
  // open column gets the room the list lets go. Defined once, read by both.
  // #6520: the bot tab's list then fills the room beside the open column, up
  // to the page's own 672px and centred in it, rather than staying the
  // inbox's 22rem against the rail with bare background beside it.
  assert.match(css, /:root \{ --list-pane-w: 22rem; \}/, 'one list width, defined once');
  assert.match(css, /\.messages-list-pane \{\s+flex: 0 0 var\(--list-pane-w\);\s+width: var\(--list-pane-w\);/, 'the inbox reads it');
  assert.match(css, /#ai-screen\[data-ai-docked\]\[data-ai-open\] \.ai-screen-body \{\s+width: 100%;\s+max-width: 42rem;\s+margin-inline: auto;\s+\}/,
    'and the bot tab\'s list fills the room beside the open column, up to 672px, centred in it');
  assert.doesNotMatch(css, /--side-panel-chosen-w/, 'one width no longer sizes both columns');
  // A wider Main holds its words to the 720px it used to be, so plan cards
  // and replies keep a readable line; below that the gutter is the part's own.
  assert.match(css, /#ai-screen \.ai-main-pane \.messages-layout\[data-main-chat\] :is\(\.chat-transcript, \.chat-status, \.chat-composer-bar\) \{\s+padding-inline: max\(0px, calc\(\(100% - 720px\) \/ 2\)\);\s+\}/,
    'Main\'s transcript, status line and composer are centred inside a wide column');
  assert.match(css, /#ai-screen \.ai-main-pane \.messages-layout\[data-main-chat\] \.chat-composer-bar \{\s+padding-inline: max\(12px, calc\(\(100% - 720px\) \/ 2\)\);\s+\}/,
    'and never narrow its own 12px gutter');
  // 6 Nov 2026 (#6425): the lane is kept only while a column is open.
  assert.match(css, /#ai-screen\[data-ai-docked\]\[data-ai-open\] \{ padding-inline-end: var\(--ai-main-w\); \}/);
  assert.match(css, /#ai-screen:not\(\[data-ai-open\]\) \.ai-main-pane \{ display: none; \}/, 'and the column is not drawn beside the lists alone');
  // 1 Nov 2026, iPhone Duo held sideways (951px, an 84px column of system
  // chrome on the right that the body pads out): the room is beside the
  // column, so its width is not counted twice. The columns pinned to the
  // right edge run their ground under the column to the screen's edge, as
  // the header does: stopped at the column, Main ended in a hard edge beside
  // bare wallpaper. Their heads pad their contents by the column, where the
  // clock, camera and Wi-Fi sit; below them the chat and the panel's page
  // run under it (padded, they left a band of another colour). A design's
  // preview pads it, its ✕ at its top. Off the Duo both are 0.
  assert.match(css, /html\[data-side-strip="right"\] body:has\(#ai-screen:not\(\.hidden\)\) \{\s+--ai-edge: var\(--platform-strip-w, 0px\);\s+\}/);
  assert.match(css, /#ai-screen \.ai-main-pane \{[^}]*inset-inline-end: 0;[^}]*width: calc\(var\(--ai-main-w\) \+ var\(--ai-edge, 0px\)\);/);
  assert.match(css, /#ai-screen \.ai-main-head \{[^}]*padding-block: 12px; padding-inline: 18px calc\(18px \+ var\(--ai-edge, 0px\)\);/, 'its name stops beside the column, its hairline runs under it');
  // A thread in Main Chat's place has its own head, which pads by the column too (1 Nov 2026).
  assert.match(css, /#ai-screen \.ai-main-pane \.messages-thread-header\[data-reply-head="main"\] \{\s+padding-inline-end: calc\(16px \+ var\(--ai-edge, 0px\)\);\s+\}/,
    'a thread\'s title stops beside the column, not under the clock');
  assert.match(read('frontend/src/features/messages/index.tsx'), /<header className="messages-thread-header" data-reply-head=\{inMain \? 'main' : undefined\}>/);
  assert.doesNotMatch(css, /\.messages-layout \{[^}]*padding-inline-end: var\(--ai-edge/, 'the chat runs under the column, below its head');
  assert.match(css, /#ai-screen \.ai-preview-pane \{[^}]*inset-inline-end: 0;[^}]*width: calc\(var\(--ai-preview-w\) \+ var\(--ai-edge, 0px\)\);\s+padding-inline-end: var\(--ai-edge, 0px\);/);
  assert.match(css, /body:has\(#ai-screen:not\(\.hidden\)\) \.side-panel \{\s+width: calc\(var\(--ai-main-w\) \+ var\(--ai-edge, 0px\)\);/);
  assert.match(css, /body:has\(#ai-screen:not\(\.hidden\)\) \.side-panel-head \{[^}]*padding-block: 12px; padding-inline: 18px calc\(18px \+ var\(--ai-edge, 0px\)\);/);
  // Only a notch (an iPhone held sideways, THE NOTCH) pads the chat and the
  // panel's page: its island is halfway down, not plain screen.
  const unNotched = css.replace(/html:not\(\[data-side-strip\]\):not\(\[data-side-corner\]\)[^{]*\{[^}]*\}/g, '');
  assert.doesNotMatch(unNotched, /\.side-panel-body \{[^}]*var\(--ai-edge/, 'and so does the page in the side panel');
  assert.match(css, /html:not\(\[data-side-strip\]\):not\(\[data-side-corner\]\) #ai-screen \.ai-main-pane > \.messages-layout,\nhtml:not\(\[data-side-strip\]\):not\(\[data-side-corner\]\) body:has\(#ai-screen:not\(\.hidden\)\) \.side-panel-body \{\n  padding-inline-end: var\(--ai-edge, 0px\);/);
  // In the Homeroom app the panel stands here too (canTake), and a reply
  // typed in its own document had the keyboard over its box: it ends above
  // the keyboard the kit measures from the screen.
  assert.match(css, /html\.un-kb body:has\(#ai-screen:not\(\.hidden\)\) \.side-panel \{ bottom: var\(--un-kb-inset, 0px\); \}/);
  assert.match(css, /#ai-screen:is\(\[data-ai-preview="three"\], \[data-ai-preview="halves"\]\) \.ai-main-pane \{\s+width: var\(--ai-col-w\);\s+inset-inline-end: calc\(var\(--ai-preview-w\) \+ var\(--ai-edge, 0px\)\);/);
  assert.match(css, /body:has\(#ai-screen\[data-ai-preview="halves"\]:not\(\.hidden\)\) \{\s+--ai-preview-w: max\(320px, min\(var\(--ai-preview-chosen-w, calc\(var\(--ai-room\) \/ 2\)\), calc\(var\(--ai-room\) - 320px\)\)\);\s+--ai-col-w: calc\(var\(--ai-room\) - var\(--ai-preview-w\)\);/,
    'halves until the preview\'s edge is dragged, the thread the rest');
  const page = css.slice(css.indexOf('body:has(#ai-screen:not(.hidden)) {'), css.indexOf('/* A phone: the whole of the page, over the drawer'));
  assert.equal((page.match(/100vw/g) || []).length, 0,
    'no width here is taken from the window: the room is the page\'s usable box, and every other is taken from the room');
  // With Main docked it is the far edge and has no gutter, so the rail's is
  // dropped too: the list's cards sit 16px (their own margin) from both.
  assert.match(css, /#ai-screen\[data-ai-docked\] \{ padding-inline-start: var\(--platform-rail-w, 0px\); \}/);
  assert.match(css, /#ai-screen \.ai-main-pane \{[^}]*width: calc\(var\(--ai-main-w\) \+ var\(--ai-edge, 0px\)\);/);
  assert.match(css, /#ai-screen \.ai-main-pane > \.messages-layout \{ flex: 1 1 auto; height: auto; min-height: 0; \}/);
  assert.match(css, /html\[data-side-panel\] #ai-screen \.ai-main-pane \{ display: none; \}/);
  assert.match(css, /@media \(min-width: 768px\) \{\s+html\[data-side-panel\] #ai-screen \{ padding-inline-end: var\(--ai-main-w\); \}\s+\}/);
  assert.match(css, /body:has\(#ai-screen:not\(\.hidden\)\) \.side-panel \{\s+width: calc\(var\(--ai-main-w\) \+ var\(--ai-edge, 0px\)\);/, 'so the list does not move');
  // 30 Oct 2026: Main's left edge is the side panel's handle; since 3 Nov
  // 2026 it sets Main's own width under its own key.
  const src = read('frontend/src/features/ai/index.tsx');
  assert.match(src, /import \{ SidePanelDivider \} from '\.\.\/side-panel\/side-panel';/);
  assert.match(src, /import \{\n\s+AI_MAIN_WIDTH_KEY,\n\s+AI_PREVIEW_COLUMN_WIDTH_KEY,\n\s+AI_PREVIEW_WIDTH_KEY,[^}]*\} from '\.\.\/side-panel\/resize';/);
  assert.match(src, /<aside\s+id="ai-main-pane"\s+ref=\{mainRef\}\s+className="ai-main-pane"[^>]*>\s+<SidePanelDivider\s+panelRef=\{mainRef\}\s+shown=\{columnOpen\}\s+id="ai-main-divider"\s+controls="ai-main-pane"\s+widthKey=\{threeUp \? AI_PREVIEW_COLUMN_WIDTH_KEY : AI_MAIN_WIDTH_KEY\}\s+probe=\{threeUp \? threadProbe : undefined\}\s+watch=\{threeUp \? previewRef : undefined\}\s+\/>/);
  assert.match(read('frontend/src/features/side-panel/side-panel.tsx'), /export function SidePanelDivider\(\{\s+panelRef,\s+shown,\s+id = 'side-panel-divider',\s+controls = 'platform-side-panel',\s+widthKey,/);
});

test('a preview beside the thread: both edges drag, each the width of the column after it (#6359)', () => {
  const css = read('public/css/app.css');
  const src = read('frontend/src/features/ai/index.tsx');
  // The thread's edge was hidden while a preview was open; now only in halves,
  // where the list has stepped aside.
  assert.doesNotMatch(css, /#ai-screen\[data-ai-preview\] \.ai-main-pane > \.side-panel-divider \{ display: none; \}/);
  assert.match(css, /#ai-screen:not\(\[data-ai-preview="three"\]\)\[data-ai-preview\] \.ai-main-pane > \.side-panel-divider \{ display: none; \}/);
  assert.doesNotMatch(css, /its edge is no\s+handle then/);
  // The chosen widths are honoured, held to every column's floor.
  assert.match(css, /--ai-preview-w: max\(360px, min\(var\(--ai-preview-chosen-w, var\(--ai-preview-auto\)\), calc\(var\(--ai-room\) - 800px\)\)\);/);
  assert.match(css, /--ai-col-w: max\(320px, min\(var\(--ai-col-chosen-w, /);
  // Each handle sits on its own line, the pane's hairline it drags (#6397).
  assert.match(css, /body:has\(#ai-screen:not\(\.hidden\)\) #ai-screen\[data-ai-preview="three"\] #ai-main-divider \{\s+--divider-at: calc\(var\(--ai-col-w\) \+ var\(--ai-preview-w\) \+ var\(--ai-edge, 0px\)\);/);
  assert.match(css, /#ai-preview-divider \{\s+--divider-at: calc\(var\(--ai-preview-w\) \+ var\(--ai-edge, 0px\)\);/);
  // #6447: below 1024px the two sheets are close enough that the list's 16px
  // gutter is the gap you see, so the handle is centred in it. That media
  // block is the one edge that adds 8px; every other edge stays on its pane's
  // hairline.
  const mobileGutter = /@media \(max-width: 1023\.98px\) \{\s*body:has\(#ai-screen:not\(\.hidden\)\) :is\(#side-panel-divider, #ai-main-divider\) \{\s*--divider-at: calc\(var\(--ai-main-w\) \+ var\(--ai-edge, 0px\) \+ 8px\);\s*\}\s*\}/;
  assert.match(css, mobileGutter, 'below 1024px the handle sits halfway across the gap');
  assert.doesNotMatch(css.replace(mobileGutter, ''), /--divider-at:[^;]*\+ 8px/,
    'no other edge sits in the gutter any more');
  // The preview's own divider, not drawn where the preview is the whole screen.
  assert.match(src, /\{layout === 'full' \? null : \(\s+<SidePanelDivider\s+panelRef=\{previewRef\}\s+shown=\{columnOpen\}\s+id="ai-preview-divider"\s+controls="ai-preview-pane"\s+widthKey=\{AI_PREVIEW_WIDTH_KEY\}\s+probe=\{previewProbe\}/);
  assert.match(src, /const threeUp = detailHere && layout === 'three';/);
  assert.match(src, /const endAt = inlineStartOf\(box\);/, 'the thread is measured to where the preview begins');
  assert.match(src, /neighbourMin: \(probe\.neighbourMin \?\? 0\) \+ Math\.max\(0, roomEnd - endAt\), endAt/,
    'and its bound keeps the preview as it is drawn, the room app.css leaves the thread');
  assert.match(read('frontend/src/features/side-panel/side-panel.tsx'), /new ResizeObserver\(\(\) => settle\(\)\)/,
    'read again when the preview is resized');
  assert.match(read('frontend/src/features/side-panel/side-panel.tsx'), /probe: measure = probeLayout,/);
});

test('a plan opened from a request in the side panel is a third column, not a sheet over it (#6394)', () => {
  const css = read('public/css/app.css');
  // The three columns' widths are declared on body so the side panel — an
  // island beside #ai-screen, not inside it — reads the same figures; the
  // screen inherits them and still pads its own list.
  assert.match(css, /body:has\(#ai-screen\[data-ai-preview="three"\]:not\(\.hidden\)\) \{\n\s+--ai-preview-auto:/);
  assert.match(css, /#ai-screen\[data-ai-preview="three"\] \{\n\s+padding-inline-end: calc\(var\(--ai-col-w\) \+ var\(--ai-preview-w\)\);\n\}/);
  // While a page is in the panel, the list keeps what the two columns leave.
  assert.match(css, /html\[data-side-panel\] #ai-screen\[data-ai-preview="three"\] \{\n\s+padding-inline-end: calc\(var\(--ai-col-w\) \+ var\(--ai-preview-w\)\);\n\}/);
  // The panel itself is the middle column: the thread's width, ending where
  // the preview begins (in three and in halves alike).
  assert.match(css, /body:has\(#ai-screen:is\(\[data-ai-preview="three"\], \[data-ai-preview="halves"\]\):not\(\.hidden\)\) \.side-panel \{\n\s+width: var\(--ai-col-w\);\n\s+inset-inline-end: calc\(var\(--ai-preview-w\) \+ var\(--ai-edge, 0px\)\);\n\}/);
  // Its edge is the thread's edge in three, and is not drawn in halves,
  // where the preview's own handle is the one that drags.
  assert.match(css, /body:has\(#ai-screen\[data-ai-preview="three"\]:not\(\.hidden\)\) #side-panel-divider \{\n\s+--divider-at: calc\(var\(--ai-col-w\) \+ var\(--ai-preview-w\) \+ var\(--ai-edge, 0px\)\);\n\}/);
  assert.match(css, /body:has\(#ai-screen\[data-ai-preview="halves"\]:not\(\.hidden\)\) #side-panel-divider \{\n\s+display: none;\n\}/);
  // The page tells the panel's own island which edge it is: the thread's
  // width key, the thread's probe to the preview, and the preview to watch.
  const src = read('frontend/src/features/ai/index.tsx');
  assert.match(src, /import \{ panelEdgeStore \} from '\.\.\/side-panel\/edge-store';/);
  assert.match(src, /const pageInColumn = column\?\.at === 'page';/);
  assert.match(src, /slot: visible && threeUp && pageInColumn\s+\? \{ widthKey: AI_PREVIEW_COLUMN_WIDTH_KEY, probe: threadProbe, watch: previewRef \}\s+: null,/);
  // The panel reads it, and falls back to its own defaults with no slot.
  const panel = read('frontend/src/features/side-panel/side-panel.tsx');
  assert.match(panel, /const edge = useStoreState\(panelEdgeStore\)\.slot;/);
  assert.match(panel, /<SidePanelDivider\s+panelRef=\{rootRef\}\s+shown=\{s\.open && !!s\.frameSrc\}\s+widthKey=\{edge\?\.widthKey\}\s+probe=\{edge\?\.probe\}\s+watch=\{edge\?\.watch\}\s+\/>/);
  // The prerender is the panel as it was: no slot until the page sets one.
  const { panelEdgeStore } = loadTsx('frontend/src/features/side-panel/edge-store.ts');
  assert.equal(panelEdgeStore.get().slot, null);
});

test('the tab says Homeroom bot: a wide seat on a phone, two lines in the Duo column', () => {
  assert.equal(message('core:tabs.ai'), 'Homeroom bot');
  const css = read('public/css/app.css');
  // One Home (#6361): four seats, Home · Homeroom bot · Messages · You. The
  // bot's holds the longest word, so it is the widest; Messages next, so a
  // lit Messages pill still clears the bot's name (overnight audit M01).
  assert.match(css, /#platform-tabs \{ grid-template-columns: 1fr 1\.4fr 1\.15fr 1fr; \}/,
    'Homeroom bot, second, takes the wide seat');
  assert.match(css, /#platform-tabs \{ grid-template-columns: 1fr 1\.35fr 1\.15fr 1fr; \}/, 'a little less on the smallest phones');
  assert.match(css, /:is\(#platform-tab-workshop, #platform-tab-ai\) \.platform-tab-label \{\s+letter-spacing: -\.02em;\s+overflow: visible;\s+text-overflow: clip;\s+\}/,
    'tightened and let out of the cell rather than cut');
  assert.match(css, /html\[data-side-strip\] #platform-tab-ai \.platform-tab-label \{\s+font-size: 9\.5px;\s+letter-spacing: -\.02em;\s+line-height: 1\.05;\s+white-space: normal;\s+text-align: center;\s+\}/,
    'the Duo column: "Homeroom" over "bot"');
});

const LIVE = 'frontend/src/features/ai/live.ts';

test('the lists are read again for an event that moves a thread they list, and only for one', () => {
  const { movesLists } = loadTsx(LIVE);
  const showing = { projects: new Set(['garden']), botId: 77 };
  const moves = (event) => movesLists(event, showing);
  // A change or a request in a project the lists show.
  assert.equal(moves({ type: 'vote_update', appSlug: 'garden', sessionId: 4 }), true);
  assert.equal(moves({ type: 'session_update', appSlug: 'garden', action: 'promoted' }), true);
  assert.equal(moves({ type: 'issue_update', appSlug: 'garden', action: 'closed' }), true);
  assert.equal(moves({ type: 'app_version_changed', appSlug: 'garden', sha: 'abc' }), true, 'a merge going live');
  assert.equal(moves({ type: 'vote_update' }), true, 'one that names no project could be about any');
  // …and not in one they do not show: those go to everyone who may view it.
  assert.equal(moves({ type: 'vote_update', appSlug: 'bread', sessionId: 4 }), false);
  assert.equal(moves({ type: 'issue_update', appSlug: 'bread' }), false);
  // A change's own banners move no row.
  for (const action of ['behind_main', 'freshness', 'sync_status', 'staging_ready']) {
    assert.equal(moves({ type: 'session_update', appSlug: 'garden', action }), false, action);
  }
  // Yours alone, from any project: something asked of you, or answered.
  assert.equal(moves({ type: 'notification_new', notification: {} }), true);
  assert.equal(moves({ type: 'notifications_changed' }), true);
  // Main Chat's messages: a private thread comes and goes with them.
  assert.equal(moves({ type: 'conversation_message_created', conversationId: 77, threadRootId: 5 }), true);
  assert.equal(moves({ type: 'conversation_message_updated', conversation_id: '77' }), true);
  assert.equal(moves({ type: 'conversation_message_created', conversationId: 12 }), false, 'another conversation');
  assert.equal(movesLists({ type: 'conversation_message_created', conversationId: 77 }, { projects: new Set(), botId: null }), false);
  // Nothing else on the socket.
  for (const type of ['session_state', 'session_event', 'kudos_update', 'conversation_typing', 'budget_updated', 'homeroom_bot_work_changed']) {
    assert.equal(moves({ type, appSlug: 'garden', conversationId: 77 }), false, type);
  }
  assert.equal(moves(null), false);
});

test('a correction the service worker makes to one of the lists\' reads is theirs', () => {
  const { isListRead } = loadTsx(LIVE);
  const at = (p) => isListRead(new URL(p, 'https://homeroom.test'));
  assert.equal(at('/api/ai/work'), true);
  assert.equal(at('/api/ai/work?demo=1'), true);
  assert.equal(at('/api/workshop/needs-feed?in=threads'), true);
  assert.equal(at('/api/workshop/needs-feed?in=threads&demo=1'), true);
  assert.equal(at('/api/workshop/needs-feed'), false, 'the Communities screen\'s feed');
  assert.equal(at('/api/workshop/counts'), false);
});

test('one read a burst, a few seconds apart at least, and none while the browser tab is hidden', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const { pacedReads, GATHER_MS, GAP_MS } = loadTsx(LIVE);
  assert.ok(GATHER_MS > 0 && GAP_MS > GATHER_MS);
  let hidden = false;
  let reads = 0;
  const paced = pacedReads(() => { reads += 1; }, () => hidden);

  // Showing the page just read: the first burst waits out the gap from it.
  paced.ask();
  paced.ask();
  t.mock.timers.tick(GAP_MS - 1);
  assert.equal(reads, 0);
  t.mock.timers.tick(1);
  assert.equal(reads, 1, 'the burst is one read');

  // Long after: a burst is gathered for GATHER_MS, then read once.
  t.mock.timers.tick(GAP_MS * 3);
  paced.ask();
  t.mock.timers.tick(GATHER_MS / 2);
  paced.ask();
  paced.ask();
  t.mock.timers.tick(GATHER_MS / 2);
  assert.equal(reads, 2);
  t.mock.timers.tick(GAP_MS * 3);
  assert.equal(reads, 2, 'and nothing more was asked');

  // Hidden: nothing is read, and what was asked is read when the tab is back.
  hidden = true;
  paced.ask();
  t.mock.timers.tick(GAP_MS);
  assert.equal(reads, 2);
  paced.seen();
  t.mock.timers.tick(GAP_MS);
  assert.equal(reads, 2, 'still hidden');
  hidden = false;
  paced.seen();
  t.mock.timers.tick(GATHER_MS);
  assert.equal(reads, 3);
  paced.seen();
  t.mock.timers.tick(GAP_MS);
  assert.equal(reads, 3, 'a tab coming back with nothing owed reads nothing');

  // The page going stops what was asked.
  paced.ask();
  paced.stop();
  t.mock.timers.tick(GAP_MS * 2);
  assert.equal(reads, 3);
});

test('the page listens while it is shown: the socket through app.js, the bot\'s work, and live reads', () => {
  const live = read(LIVE);
  // app.js hands it every events-socket message, ahead of its own switch.
  assert.match(read('public/js/app.js'), /const data = JSON\.parse\(event\.data\);\s+(\/\/[^\n]*\n\s+)*window\.UsernodeReact\?\.aiScreen\?\.handleEvent\?\.\(data\);\s+switch \(data\.type\) \{/);
  assert.match(live, /bridge\.aiScreen = \{ handleEvent \};/);
  // Only while the page is shown, and all of it let go when it is not.
  assert.match(live, /if \(!visible \|\| typeof window === 'undefined'\) return undefined;/);
  assert.match(live, /listeners\.add\(onEvent\);\s+window\.addEventListener\(WORK_CHANGED_EVENT, reads\.ask\);\s+document\.addEventListener\('visibilitychange', reads\.seen\);\s+const unwatch = watch\(reads\.ask, \{ reads: isListRead \}\);/);
  assert.match(live, /reads\.stop\(\);\s+listeners\.delete\(onEvent\);\s+window\.removeEventListener\(WORK_CHANGED_EVENT, reads\.ask\);\s+document\.removeEventListener\('visibilitychange', reads\.seen\);\s+unwatch\(\);/);
  // The page: each read it is asked for is the showing's read again, past
  // the worker's saved copy after the first, keeping the lists on a failure.
  const src = read('frontend/src/features/ai/index.tsx');
  assert.match(src, /useLiveLists\(\(\) => setMoved\(\(n\) => n \+ 1\), visible, \{ projects, botId \}\);/);
  assert.match(src, /const init = again \? FRESH : undefined;/);
  assert.match(src, /readJson<AiWork>\(`\/api\/ai\/work\$\{qs\}`, init\)/);
  // A failed read keeps what is drawn (offline test, 2 Nov 2026: and with
  // nothing drawn, the kept copy or a word of why; tests/messages-offline-kept.test.js).
  assert.match(src, /if \(drawn\.current\.work\) return null;/);
  assert.match(src, /if \(drawn\.current\.needs\) return null;/);
});

// #6147 (2 Nov 2026): at 1918px the right column (Main Chat or a thread, its
// Preview pane and its divider) began 8px up into the header and was painted
// over its rounded lower edge, while the list's first card began 8px below
// it. All three now start on the line the list's card and the Workshop's side
// panel do: the header's bottom plus 8px.
test('#6147: the right column, its preview and its divider start 8px below the header, like the Workshop\'s side panel', () => {
  const css = read('public/css/app.css');
  const below = String.raw`top: calc\(var\(--browser-banner-h, 0px\) \+ var\(--platform-header-h\) \+ var\(--platform-safe-top, 0px\) \+ \.5rem\);`;
  for (const selector of [String.raw`#ai-screen \.ai-main-pane \{`, String.raw`#ai-screen \.ai-preview-pane \{`, String.raw`#ai-main-divider \{`]) {
    const rule = new RegExp(`${selector}[^}]*?${below}`);
    assert.match(css, rule, selector);
  }
  assert.doesNotMatch(css, /#ai-screen \.(ai-main-pane|ai-preview-pane) \{[^}]*- \.5rem\);/, 'none rides up into the header');
  assert.doesNotMatch(css, /#ai-main-divider \{[^}]*- \.5rem\);/);
  assert.match(css, /\.dev-ws-side \{[^}]*top: calc\(var\(--browser-banner-h, 0px\) \+ var\(--platform-header-h, 3\.25rem\) \+ var\(--platform-safe-top, 0px\) \+ 8px\);/,
    'the Workshop\'s side panel, the line it matches');
});

// #6207/#6210/#6212/#6215/#6218 (3 Nov 2026): what the column beside the
// list shows is one answer (frontend/src/features/ai/column.ts), and the lit
// row, the address and Main's attachment are all read from it.
test('one column state: where each row goes, the row it lights, its address and Main\'s attachment', () => {
  const column = loadTsx('frontend/src/features/ai/column.ts');
  const plain = (v) => JSON.parse(JSON.stringify(v));
  // Every row goes to its own place: a private thread, else its page (a ▷ plan row too).
  assert.deepEqual(plain(column.rowColumn({ rootId: 139, href: '#app/garden/dev/issues/4' })), { at: 'thread', rootId: 139 });
  assert.deepEqual(plain(column.rowColumn({ rootId: null, href: '#app/garden/dev/issues/410' })), { at: 'page', route: 'app/garden/dev/issues/410' });
  assert.equal(column.rowColumn({ rootId: null, href: null }), null);
  // A row is lit by the column it opens.
  assert.equal(column.rowKey({ href: '#app/garden/dev/issues/410' }), column.columnKey({ at: 'page', route: 'app/garden/dev/issues/410' }));
  assert.equal(column.columnKey({ at: 'main' }), 'main');
  assert.equal(column.columnKey({ at: 'thread', rootId: 7 }), 'private:7');
  assert.equal(column.columnKey(null), null);
  // The address names what is open (#6215); a reload reopens it.
  assert.equal(column.columnAddress({ at: 'main' }), '#homeroom-bot/main');
  assert.equal(column.columnAddress({ at: 'thread', rootId: 139 }), '#homeroom-bot/thread/139');
  assert.equal(column.columnAddress({ at: 'page', route: 'app/usernode-2d5619/dev/issues/6214' }), '#homeroom-bot/request/usernode-2d5619/6214');
  assert.equal(column.columnAddress({ at: 'page', route: 'app/garden/dev/changes/2151' }), '#homeroom-bot/change/garden/2151');
  assert.equal(column.columnAddress({ at: 'page', route: 'app/garden/dev/governance/7' }), '#homeroom-bot/decision/garden/7');
  assert.equal(column.columnAddress({ at: 'page', route: 'app/garden/workshop' }), '#homeroom-bot', 'a page that is no item is the tab');
  assert.equal(column.columnAddress(null), '#homeroom-bot', 'the lists alone, on a phone or a desktop');
  // #6425: a close to nothing leaves Main's attachment as it was.
  assert.equal(column.attachmentFor({ at: 'page', route: 'app/garden/dev/issues/6149' }, null, 'back'), 'none');
  // #6212: the attachment follows what you are looking at.
  const decide = { at: 'page', route: 'app/garden/dev/governance/5813' };
  const plan = { at: 'page', route: 'app/garden/dev/issues/6149' };
  assert.equal(column.attachmentFor(decide, plan, 'row'), 'attach', 'Decide row then a ▷ row: the plan\'s request, never #5813');
  assert.equal(column.attachmentFor(decide, { at: 'main' }, 'back'), 'keep', '‹ Main Chat from the page keeps it');
  assert.equal(column.attachmentFor(decide, { at: 'main' }, 'row'), 'clear', 'the Main Chat row clears it');
  assert.equal(column.attachmentFor(decide, { at: 'thread', rootId: 3 }, 'row'), 'clear', 'a private thread clears it');
  assert.equal(column.attachmentFor({ at: 'main' }, { at: 'main' }, 'row'), 'none');
  // The composer never lets the list take off an item the person chose (#6212).
  assert.match(read('frontend/src/features/messages/composer.tsx'), /if \(objectFrom\.current !== 'list'\) return;/);
  // The page reads it once; nothing else keeps a copy.
  const src = read('frontend/src/features/ai/index.tsx');
  assert.match(src, /: panelRoute \? \{ at: 'page', route: panelRoute \}/);
  // 5 Nov 2026: the column's address carries the filter the chips set
  // (./filter-address.ts), and the chips write it back in place: two writers,
  // the column's and the filter's, besides its definition.
  assert.match(src, /showAddress\(withFilter\(columnAddress\(columnShown\), \{ projects: filterRef\.current\.picked, kind: filterRef\.current\.historyKind \}\)\);/);
  assert.match(src, /showAddress\(withFilter\(window\.location\.hash, \{ projects: next\.picked, kind: next\.historyKind \}\)\);/);
  assert.equal((src.match(/showAddress\(/g) || []).length, 3, 'the column\'s writer and the filter\'s, besides its definition');
  assert.match(read('frontend/src/features/ai/lists.tsx'), /lit: !!lit && rowKey\(row\) === lit,/);
  assert.match(read('frontend/src/features/ai/lists.tsx'), /lit: !!lit && rowKey\(th\) === lit,/);
});

test('#6218: the row whose page is open beside the list is lit, and Main Chat is not', () => {
  const { renderComponent } = require('./lib/render-tsx');
  const LISTS = 'frontend/src/features/ai/lists.tsx';
  const props = (extra = {}) => ({
    hero: null, main: { open() {}, lit: false, unread: 0 }, ready: true, rows: [], owed: 0,
    progress: [], waiting: [], live: [], openRow() {}, openThread() {}, ...extra,
  });
  const need = {
    key: 'need:proposal:6212', title: 'Show the reason beside each credit', app,
    who: 'all', sub: { id: 'messages:ai.row.where', values: { project: 'Garden club', number: 6212 } },
    pill: null, href: '#app/garden/dev/issues/6212', rootId: null,
  };
  const needs = renderComponent(LISTS, 'AiLists', props({ rows: [need], lit: 'page:app/garden/dev/issues/6212' }));
  assert.equal((needs.match(/data-ai-lit=""/g) || []).length, 1, 'one row, the open page\'s own');
  assert.match(needs, /data-ai-line="need" data-ai-lit="" aria-current="true">[\s\S]*?Show the reason beside each credit/);
  const waiting = thread(7, 6212, 'vote');
  const live = thread(8, 6213, 'live', { group: 'live' });
  const busy = renderComponent(LISTS, 'AiLists', props({ waiting: [waiting], live: [live], lit: 'page:app/garden/dev/issues/6213' }));
  assert.match(busy, /data-ai-line="live" data-ai-lit="" aria-current="true">/);
  assert.equal((busy.match(/data-ai-lit=""/g) || []).length, 1);
  const none = renderComponent(LISTS, 'AiLists', props({ rows: [need], lit: 'page:app/garden/dev/issues/9999' }));
  assert.ok(!none.includes('data-ai-lit'), 'no row names the open page');
});

// #6227 (3 Nov 2026): a Vote row lights while its change's request page is
// open beside the list. A change built for a request has no page of its own
// (one page per thread): its own address lands on the request's page, so a
// row lit by the change's route never matched the column. The row opens the
// request's page instead, and the two numbers can differ (#6215's change was
// PR #6216), so matching numbers would not do either.
test('#6227: a Vote row opens and lights its change\'s request page, whatever its own number', () => {
  const { needHref, needsYou } = loadTsx(MODEL);
  const column = loadTsx('frontend/src/features/ai/column.ts');
  const need = { kind: 'proposal', id: 1, number: 6216, request: { number: 6215, title: 'Show the reason' }, title: 'Show the reason', app };
  const [row] = needsYou([need], null);
  assert.equal(needHref({ ...need, request: { number: 6215 } }), '#app/garden/dev/issues/6215',
    'the request\'s page, where the change is decided, never its own change address');
  assert.equal(row.href, '#app/garden/dev/issues/6215');
  const open = { at: 'page', route: 'app/garden/dev/issues/6215' };
  assert.equal(column.rowKey(row), column.columnKey(open), 'so the row is lit while that page is open beside the list');
  assert.equal(column.columnAddress(open), '#homeroom-bot/request/garden/6215', 'and a reload reopens the page and lights it again');
  // A change with no request keeps its own page, as today.
  const [own] = needsYou([{ kind: 'proposal', id: 2, number: 403, title: 'Dark mode', app }], null);
  assert.equal(own.href, '#app/garden/dev/changes/403');
  assert.equal(column.rowKey(own), column.columnKey({ at: 'page', route: 'app/garden/dev/changes/403' }));
  // An older server that names no request keeps today's change address too.
  assert.equal(needHref({ kind: 'proposal', id: 3, number: 6216, app }), '#app/garden/dev/changes/6216');
  // A ballot is still decided on its request's page, unchanged.
  assert.equal(needHref({ kind: 'ballot', id: 4, number: 408, ballot: { number: 401 }, app }), '#app/garden/dev/issues/401');
  // Main's composer attaches the request the row opened, not the change.
  const { aboutRow } = loadTsx('frontend/src/features/ai/index.tsx');
  assert.deepEqual(JSON.parse(JSON.stringify(aboutRow(row))),
    { type: 'issue', appSlug: 'garden', issueNumber: 6215, title: 'Show the reason' });
});

test('an item in the bot page\'s column has an address of its own, and its own page as the fallback (#6215)', () => {
  const door = loadTsx('frontend/src/features/ai/door.ts');
  const plain = (v) => JSON.parse(JSON.stringify(v));
  assert.deepEqual(plain(door.botItemAt('#homeroom-bot/request/usernode-2d5619/6214')), { kind: 'request', slug: 'usernode-2d5619', number: 6214 });
  assert.deepEqual(plain(door.botItemAt('#ai/change/usernode-2d5619/2151')), { kind: 'change', slug: 'usernode-2d5619', number: 2151 });
  assert.equal(door.botItemAt('#homeroom-bot/main'), null, 'a chat place is not an item');
  assert.equal(door.botItemRoute({ kind: 'decision', slug: 'garden', number: 7 }), 'app/garden/dev/governance/7');
  assert.equal(door.pageLinkFor('app/usernode-2d5619/dev/issues/6214'), '/app/usernode-2d5619/dev/issues/6214');
  assert.equal(door.botTabAt('#homeroom-bot/request/usernode-2d5619/6214'), null);
  const src = read('frontend/src/features/ai/index.tsx');
  assert.match(src, /if \(sidePanel\(\)\?\.take\?\.\(route, \{ place: appFromLists\(item\.slug\), label: null \}\)\) \{ underPanel\(\); return; \}/);
  assert.match(src, /improve\(\)\?\.enterTopicFrom\?\.\(BOT_PAGE\);\s+window\.location\.replace\(`#\$\{route\}`\);/,
    'a replace, not a push, so Back does not bounce to it again');
  assert.match(read('frontend/src/features/ai/door.ts'), /openItem: \(hash: string\) => \{ const item = botItemAt\(hash\); if \(item\) askBotItem\(item\); \}/);
  // A request reopened from its address is attached to Main once the chat has loaded.
  const { aboutRoute } = loadTsx('frontend/src/features/ai/index.tsx');
  assert.deepEqual(plain(aboutRoute('app/garden/dev/issues/12')), { type: 'issue', appSlug: 'garden', issueNumber: 12, title: null });
  assert.equal(aboutRoute('app/garden/dev/governance/3'), null);
});

// #6398 (6 Nov 2026, Evan: "offer a search icon here, next to the plus, to
// search through your threads"). A round search button beside the plus opens
// a box under the heading; every list narrows to the threads whose title,
// number ("6011" or "#6011") or project name contains what was typed, a
// section with no match folds away, Main Chat steps aside, and one short note
// says when nothing matched at all.
test('#6398: the search narrows every list by title, number or project, hides Main Chat, and says when nothing matches', () => {
  const { renderComponent } = require('./lib/render-tsx');
  const LISTS = 'frontend/src/features/ai/lists.tsx';
  const games = { slug: 'games', name: 'Game corner', icon_url: null, icon_emoji: null };
  const need = (key, title, a, number) => ({
    key, title, app: a, who: 'all', unread: 0,
    sub: { id: 'messages:ai.row.where', values: { project: a.name, number } },
    pill: { id: 'messages:ai.pill.vote' }, href: `#app/${a.slug}/dev/issues/${number}`, rootId: null,
    threadId: number,
  });
  const at = (threadId, number, what, a, title, group = 'next') => thread(threadId, number, what, {
    app: a, title, group, href: `#app/${a.slug}/dev/issues/${number}`,
  });
  const all = {
    hero: null, main: { open() {}, lit: false, unread: 0 }, ready: true, owed: 2,
    rows: [
      need('need:proposal:1', 'Releases: make the migration job cheaper', app, 6010),
      need('need:proposal:2', 'Dark mode', games, 403),
    ],
    progress: [at(3, 6011, 'building', app, 'Releases: reuse image scan results safely')],
    waiting: [at(4, 6012, 'vote', games, 'Seed the garden')],
    live: [at(5, 777, 'live', games, 'Ship the seed catalogue', 'live')],
    openRow() {}, openThread() {},
  };
  const html = (extra) => renderComponent(LISTS, 'AiLists', { ...all, ...extra });

  // No search: every row, Main Chat first, nothing folded away.
  const plain = html({ query: '' });
  assert.match(plain, /data-ai-main-row=""/, 'Main Chat is drawn with an empty search');
  for (const title of ['make the migration', 'Dark mode', 'reuse image scan', 'Seed the garden', 'Ship the seed']) {
    assert.ok(plain.includes(title), title);
  }

  // A title keeps only the row that says it; the sections with no match fold away.
  const byTitle = html({ query: 'migration' });
  assert.match(byTitle, /make the migration job cheaper/);
  assert.doesNotMatch(byTitle, /Dark mode|reuse image scan|Seed the garden|Ship the seed/, 'only the matching row');
  assert.doesNotMatch(byTitle, /data-ai-main-row/, 'Main Chat steps aside while you search');
  assert.doesNotMatch(byTitle, /data-ai-list="busy"/, 'In progress & waiting has no match, so its card is gone');
  assert.doesNotMatch(byTitle, /data-ai-list="live"/, 'nor Live this week');
  assert.equal(message('messages:ai.work.titleCount', { count: 1 }), 'Needs you · 1');
  assert.match(byTitle, /Needs you · 1/, 'the Needs you count over its rows is its matches');

  // A number matches with or without the #, as the row shows it.
  for (const query of ['6011', '#6011']) {
    const byNumber = html({ query });
    assert.match(byNumber, /reuse image scan results safely/, query);
    assert.doesNotMatch(byNumber, /make the migration|Dark mode|Seed the garden|Ship the seed/, query);
  }

  // A project's name keeps every row of it, in whatever list.
  const byProject = html({ query: 'game corner' });
  assert.match(byProject, /Dark mode/);
  assert.match(byProject, /Seed the garden/);
  assert.match(byProject, /Ship the seed/);
  assert.doesNotMatch(byProject, /make the migration|reuse image scan/);

  // A match past a project's first few is drawn, not folded: with no search
  // the seventh row waits behind Show more, and with one it is on the page.
  const many = Array.from({ length: 7 }, (_, i) => need(`need:proposal:${i + 1}`, `Release note ${i + 1}`, app, 500 + i));
  const folded = renderComponent(LISTS, 'AiLists', { ...all, rows: many, progress: [], waiting: [], live: [], owed: 7 });
  assert.match(folded, /data-ai-group-rest=""/, 'the rest of a project folds away with no search');
  const matched = renderComponent(LISTS, 'AiLists', { ...all, rows: many, progress: [], waiting: [], live: [], owed: 7, query: 'release note' });
  assert.doesNotMatch(matched, /data-ai-group-rest=""/, 'every match shows, with no fold over it');
  assert.match(matched, /Release note 7/);

  // Nothing matches: one short note in place of every list.
  const none = html({ query: 'zzz' });
  assert.match(none, /<div class="[^"]*" data-ai-search-empty=""><p class="[^"]*">No threads match “zzz”<\/p><\/div>/);
  assert.ok(none.includes(message('messages:ai.search.none', { query: 'zzz' })));
  assert.doesNotMatch(none, /data-ai-list="(?:work|busy|live|history)"/, 'every card folds away');
  assert.doesNotMatch(none, /data-ai-main-row/, 'and Main Chat is hidden');

  // Before the lists are read, the skeleton stays and no note is shown.
  const loading = html({ query: 'zzz', ready: false });
  assert.match(loading, /data-ai-loading=""/);
  assert.doesNotMatch(loading, /data-ai-search-empty/);

  // The button and the box (index.tsx): the search button sits beside the
  // plus, with the app's magnifying glass, and the box's text is what the
  // lists narrow to.
  const src = read('frontend/src/features/ai/index.tsx');
  const toggle = src.indexOf('data-ai-search-toggle=""');
  assert.ok(toggle > 0 && toggle < src.indexOf('<NewThreadButton'), 'the search button is beside the plus, before it');
  const button = src.slice(src.lastIndexOf('<button', toggle), src.indexOf('</button>', toggle));
  assert.match(button, /aria-label=\{t\('messages:ai\.search\.open'\)\}/, 'it is named for what it does');
  assert.match(button, /<SearchIcon aria-hidden="true" \/>/);
  assert.match(button, /h-10 w-10[^"]*rounded-full/, 'the plus\'s own round button');
  assert.match(src, /query=\{searchOpen \? query : ''\}/, 'the box\'s text is passed to the lists');
  assert.match(src, /data-ai-search=""/, 'the box the More projects panel has');
  assert.equal(message('messages:ai.search.open'), 'Search your threads');
  assert.equal(message('messages:ai.search.label'), 'Search your threads');
  assert.equal(message('messages:ai.search.none', { query: 'releases' }), 'No threads match “releases”');
});

// #6389: the person's own change, made through a coding agent, whose votes
// are in and whose tests fail or which conflicts with main. It says what it
// waits on in place of Vote, and the phone's second line says both when both.
test('#6389: Needs you says what your own change waits on instead of Vote', () => {
  const { needsYou, whyOf } = loadTsx(MODEL);
  const plain = (v) => JSON.parse(JSON.stringify(v));
  const app = { slug: 'usernode', name: 'Homeroom' };
  const item = (waitingOn) => ({ kind: 'proposal', id: 6358, number: 6358, title: 'Guard apps', app, waitingOn, agent: 'claude-code' });
  const [checks] = needsYou([item(['checks'])], null);
  assert.deepEqual(plain(checks.pill), { id: 'messages:ai.pill.testsFailing' });
  assert.equal(checks.sub.id, 'messages:ai.row.waitsOnFixTests');
  assert.equal(whyOf(checks).id, 'messages:ai.why.fixTests');
  const [both] = needsYou([item(['checks', 'conflict'])], null);
  assert.deepEqual(plain(both.pill), { id: 'messages:ai.pill.testsFailing' });
  assert.equal(both.sub.id, 'messages:ai.row.waitsOnFixBoth');
  assert.equal(whyOf(both).id, 'messages:ai.why.fixBoth');
  const [conflict] = needsYou([item(['conflict'])], null);
  assert.deepEqual(plain(conflict.pill), { id: 'messages:ai.pill.conflicts' });
  assert.equal(conflict.sub.id, 'messages:ai.row.waitsOnFixConflict');
  assert.equal(whyOf(conflict).id, 'messages:ai.why.fixConflict');
  // A plain change for a vote still says Vote, and says nothing more.
  const [plainVote] = needsYou([{ kind: 'proposal', id: 2, number: 601, title: 'Plain', app }], null);
  assert.deepEqual(plain(plainVote.pill), { id: 'messages:ai.pill.vote' });
  assert.equal(whyOf(plainVote), null);
});

test('10 Nov 2026: `#homeroom-bot/new` is the "+" pressed for you, and may name the project and who works on it', () => {
  const door = loadTsx('frontend/src/features/ai/door.ts');
  const plain = (v) => JSON.parse(JSON.stringify(v));
  assert.equal(door.botNewAddress(null), '#homeroom-bot/new');
  assert.equal(door.botNewAddress({ project: 'run-club-1a2b3c', builder: 'claude-code' }), '#homeroom-bot/new?project=run-club-1a2b3c&with=claude-code');
  assert.equal(door.botNewAddress({ project: 'run-club-1a2b3c', builder: 'homeroom' }), '#homeroom-bot/new?project=run-club-1a2b3c', 'Homeroom bot is the default and is not said');
  assert.equal(door.botNewAddress({ project: 'Not A Slug!', builder: 'someone-else' }), '#homeroom-bot/new', 'only a slug the platform mints and a builder it knows');
  assert.deepEqual(plain(door.botNewAt('#homeroom-bot/new?project=run-club-1a2b3c&with=chatgpt')), { project: 'run-club-1a2b3c', builder: 'chatgpt' });
  assert.deepEqual(plain(door.botNewAt('#homeroom-bot/new')), { project: null, builder: 'homeroom' });
  assert.deepEqual(plain(door.botNewAt('#homeroom-bot/new?project=..%2Fx&with=root')), { project: null, builder: 'homeroom' }, 'an address is anybody\'s to write');
  assert.equal(door.botNewAt('#homeroom-bot/main'), null);
  assert.equal(door.botNewAt('#homeroom-bot/new/extra'), null);
  assert.equal(door.botTabAt('#homeroom-bot/new?project=run-club-1a2b3c'), null, 'not a place in the chat');
  assert.deepEqual([...door.BOT_NEW_BUILDERS], [...loadTsx('frontend/src/features/messages/thread-builder.tsx', { stubs: { './api': {} } }).BUILDERS], 'the builders a thread knows');
  // The router hands the address to the page, which takes it once the chat it opens beside is known.
  const app = read('public/js/app.js');
  assert.match(app, /if \(parts\[1\] === 'new'\) \{\s+window\.UsernodeReact\?\.ai\?\.openNew\?\.\('#' \+ parts\.join\('\/'\) \+ \(fragQuery \? '\?' \+ fragQuery : ''\)\);\s+\}/);
  const doorSrc = read('frontend/src/features/ai/door.ts');
  assert.match(doorSrc, /openNew: \(hash: string\) => \{ const fresh = botNewAt\(hash\); if \(fresh\) askBotNew\(fresh\); \}/);
  const src = read('frontend/src/features/ai/index.tsx');
  assert.match(src, /if \(!ask\?\.fresh \|\| ask\.seq === freshTaken\.current \|\| !visible \|\| !\(wide \|\| phone\) \|\| !botId\) return;\n\s+freshTaken\.current = ask\.seq;/, 'it waits for the chat, and is not marked taken until then');
  assert.match(src, /openBlank\(\);\n\s+startNewThread\(botId, ask\.fresh\);/, 'the same two halves the "+" runs, with what the address named');
  const thread = read('frontend/src/features/messages/new-thread.tsx');
  assert.match(thread, /export function startNewThread\(conversationId: number, fresh\?: NewThreadPreset \| null\): void \{\n\s+if \(!conversationId\) return;\n\s+closeThread\(\);\n\s+preset = fresh \|\| null;/, 'the "+" itself clears what an earlier door named');
  assert.match(thread, /const \[project, setProject\] = useState\(\(\) => preset\?\.project \|\| ''\);/);
  assert.match(thread, /const \[builder, setBuilder\] = useState<Builder>\(\(\) => preset\?\.builder \|\| 'homeroom'\);/);
});
