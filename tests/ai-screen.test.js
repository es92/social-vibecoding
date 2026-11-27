'use strict';

// The AI tab's main view (#6019 follow-up): frontend/src/features/ai/.
// Plan v3: "what needs you comes first, then your private threads, with a
// lock on the tile, then Up next: what's moving without you, soonest first."
// 14 Nov 2026: there is no Main Chat; every conversation with the bot is a
// thread, and New chat (and the phone's Ask bar) starts one. 29 Oct 2026 (Evan): Needs you (it holds
// other people's threads too), In progress (being worked on), Waiting (on
// someone else; "Up next" until 30 Oct), each the bot's own word where it
// works on the request; and a thread opens on this page. 30 Oct 2026: one
// line a row, grouped by project, with chips to narrow them (./lists.tsx;
// the three projects that need you most and a More for the rest); on a
// phone the list and one thread (or a new chat) are one drawer; Homeroom
// bot's status answer reads the same lists.
//
// What this pins:
//   1. Needs you's order: the Needs you feed, the bot's plans waiting to be
//      reviewed and the requests it handed back (Needs reply, Restart
//      build), then private threads; each thread is listed once.
//   2. In progress and Waiting: what goes in each, in what order, and the
//      words each row says, the bot's stages and claims among them.
//   3. The screen's first render is the prerender: hidden, the bot's name,
//      New chat, no rows; the lists load in effects, the column is docked
//      only after mount.
//   4. The routes: #homeroom-bot is the page, #homeroom-bot/thread/<id> a
//      thread in its column (1 Nov 2026: never the Messages screen), and
//      #homeroom-bot/new a new chat; #ai, the old address, lands there, and
//      so do a Messages address of the bot's chat and the old Main Chat
//      address, which the server resolves to a thread (./door.ts, ./where.ts).
//   5. A request, a change or a decision opens beside the list (the side
//      panel drawn as the page's column), or on its page with a way back
//      here. The column is docked from 768px and holds one thread or a new
//      chat, alone, and the row of whichever thread it is is lit.
//   6. While the page is up, its lists are read again when a thread they
//      list moves (./live.ts): which socket events count, one read a burst,
//      none while the browser tab is hidden.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');
const { withWords } = require('./lib/work-words');

const MODEL = 'frontend/src/features/ai/model.ts';
// The fold sizes the lists pass to groupRows, as plain inputs here: it takes any.
const GROUP_FIRST = { needs: 5, busy: 3, live: 3 };
const LINES = 'frontend/src/features/ai/lines.ts';
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
    // 11 Nov 2026: with the words the server sends with it (tests/lib/work-words.js).
    work: withWords({ why: null, reason: null, line: null, since: null, ...(WORK[what] || { stage: what }), ...(given || {}) }),
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
  assert.deepEqual(rows.map((r) => r.pill && message(r.pill.id)), ['Vote', 'Choose a version', 'Needs reply', 'Vote', 'Review plan', null, null]);
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
  // so the row opens that page, as a Vote or Needs reply row for it
  // would. B06's way to Main Chat at the plan is gone.
  assert.equal(rows[4].plan, undefined);
  const index = read('frontend/src/features/ai/index.tsx');
  assert.doesNotMatch(index, /openBotRequest/, 'no row opens Main Chat at a plan');
  // 24 Nov 2026 (mobile 04): a thread somebody named you in opens at the
  // message that named you (group-chat.js revealInThread), on the same page.
  assert.match(index, /const openRow = \(row: WorkRow\) => \{\s+seeOpened\(openedNeed\(row\)\);\s+markThreadRead\(row\.threadId, row\.app, row\.rootId\);\s+if \(row\.rootId\) \{\s+openPrivate\(row\.rootId\);\s+return;\s+\}[\s\S]*?const messageId = row\.named\?\.messageId;\s+const slug = row\.app\?\.slug;\s+if \(messageId && slug\) \(window as any\)\.GroupChat\?\.revealInThread\?\.\(slug, messageId\);\s+if \(openPage\(row\.href, row\.app, row\.title, aboutRow\(row\)\) && messageId && slug\) sidePanel\(\)\?\.revealMessage\?\.\(slug, messageId\);\s+\};/,
    'every other row opens its own page, and opening it clears what is new');
  // Private threads: a lock on the tile, and where they stand.
  assert.deepEqual([rows[5].who, words(rows[5].sub)], ['solo', 'Only you · Not in a community yet']);
  assert.deepEqual([rows[6].who, words(rows[6].sub)], ['me', 'Only you · Garden club · Not posted yet']);
  assert.equal(rows[5].rootId, 91, 'a private thread opens in the column');
  assert.equal(needHref({ kind: 'proposal', id: 1, number: 2, href: '#somewhere' }), '#somewhere', 'a card that says where it goes');
  assert.equal(needsYou(null, null).length, 0);
  assert.equal(needsYou(null, { private: [], next: [], waiting: [], live: [] }).length, 0, 'an older server, with no plans');
});

test('each band is one list, newest first, with no project or day headings, and shows its first few before its own Show more', () => {
  const { needsYou, byProject } = loadTsx(MODEL);
  const { BAND_FIRST, DONE_STEP, newestFirst } = loadTsx(LINES);
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
  // The model still knows each row's project (the look's list groups by it).
  assert.deepEqual(byProject(rows).map((g) => g.app && g.app.slug), ['garden', 'games', null]);
  // 24 Nov 2026 (the three bands): the caps are the band's, not a project's.
  assert.deepEqual({ ...BAND_FIRST }, { needs: 6, busy: 5, done: 5 }, 'Needs you shows the most: it is what you came for');
  assert.equal(DONE_STEP, 20, 'Done\'s Show more adds twenty');
  // Newest first; a row with no time keeps its place after the rest.
  assert.deepEqual(newestFirst([{ k: 'a', at: '2026-11-01T00:00:00Z' }, { k: 'b', at: null }, { k: 'c', at: '2026-11-03T00:00:00Z' }]).map((r) => r.k), ['c', 'a', 'b']);
  const lists = read('frontend/src/features/ai/lists.tsx');
  assert.doesNotMatch(lists, /byProject\(|byDay\(|data-ai-group=\{|data-ai-project-head|data-ai-day=|DayRule|GroupList/, 'no project heads and no day lines');
  // Mobile polish 05 (24 Nov 2026): what is new since your last visit before the rest (tests/ai-new-since.test.js).
  assert.match(lists, /const needs = useHeld\(newFirst\(newestFirst\(needLines\)\)\);/);
  assert.match(lists, /<BandRows lines=\{needs\.held\} first=\{searching \? Infinity : BAND_FIRST\.needs\} since=\{newSince\} \/>/);
  // #7138: In progress stays at its default length: only the row you are on
  // and one that just moved are lifted past the first few.
  assert.match(lists, /<BandRows lines=\{progressLines\} first=\{searching \? Infinity : BAND_FIRST\.busy\} since=\{newSince\} lift="moved" \/>/);
  // 24 Nov 2026 (mobile 04): newest first, your own before the threads you only wrote or were named in.
  assert.match(read(LINES), /const progressLines: Line\[\] = newFirst\(ownFirst\(newestFirst\(kept\(\[/, 'In progress newest first, your own first');
  // 1 Nov 2026: the row whose chat is in the column is never folded away:
  // past the first rows, it joins them. #6245: only while the band is
  // folded (open ? -1): an opened band keeps every row's own place.
  assert.match(read(MODEL), /const litAt = open \? -1 : items\.findIndex\(\(row\) => row\.lit\);/);
  assert.match(lists, /const \{ items, shown, hidden \} = kept \? openRows\(lines, kept\) : groupRows\(lines, first, false, lift\);/,
    'the band draws through the pure order rules: folded, and opened with what was in sight kept');
  assert.equal(message('messages:ai.short.private'), 'Only you', 'a private thread\'s project, in no project');
});

// 19 Nov 2026 (Evan's recording): opening a project's Show more moved the
// rows lifted above the fold (two new ones) down into the part that opens
// from no height, so they vanished, the list jumped up, and they faded back
// in; shutting, the folded rows were gone in a frame or two and left a blank
// band that then closed.
test('a band\'s Show more opens under the rows in sight and shuts without a blank band', () => {
  const { groupRows, openRows } = loadTsx(MODEL);
  // Eight rows, the fourth and fifth are new: folded, they join the first three.
  const rows = Array.from({ length: 8 }, (_, i) => ({ key: `r${i + 1}`, fresh: i === 3 || i === 4 }));
  const folded = groupRows(rows, GROUP_FIRST.busy, false);
  const kept = folded.items.slice(0, folded.shown).map((r) => r.key);
  assert.deepEqual(kept, ['r1', 'r2', 'r3', 'r4', 'r5']);
  // Opened: the rows in sight stay where they were, the rest open under them.
  const open = openRows(rows, kept);
  assert.deepEqual(open.items.map((r) => r.key), ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8']);
  assert.deepEqual([open.shown, open.hidden], [5, 3], 'nothing that was in sight moves into the fold');

  // A lifted row from further down stays lifted while open; the rest keep
  // their own order under it.
  const far = Array.from({ length: 8 }, (_, i) => ({ key: `f${i + 1}`, lit: i === 6 }));
  const farFolded = groupRows(far, GROUP_FIRST.needs, false);
  const farOpen = openRows(far, farFolded.items.slice(0, farFolded.shown).map((r) => r.key));
  assert.deepEqual(farOpen.items.map((r) => r.key), ['f1', 'f2', 'f3', 'f4', 'f5', 'f7', 'f6', 'f8']);
  assert.deepEqual([farOpen.shown, farOpen.hidden], [6, 2]);
  // #6245 still holds: a row pressed while it is open was not in sight when
  // it opened, so it keeps its place.
  const pressed = far.map((r, i) => ({ ...r, lit: i === 7 }));
  assert.deepEqual(openRows(pressed, farOpen.items.slice(0, farOpen.shown).map((r) => r.key)).items.map((r) => r.key),
    ['f1', 'f2', 'f3', 'f4', 'f5', 'f7', 'f6', 'f8'], 'the pressed row stays where it was');
  // A kept row that has gone is skipped, and one that came while open opens below.
  const changed = openRows([...rows.filter((r) => r.key !== 'r2'), { key: 'r9' }], kept);
  assert.deepEqual(changed.items.map((r) => r.key), ['r1', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9']);
  assert.deepEqual([changed.shown, changed.hidden], [4, 4]);

  // #7138: In progress calls groupRows with 'moved'. New rows past the first
  // five stay folded, so the band keeps its default length; a row that moved,
  // and the row you are on, are still lifted above Show more.
  const newer = Array.from({ length: 8 }, (_, i) => ({ key: `n${i + 1}`, isNew: i >= 5 }));
  const quiet = groupRows(newer, 5, false, 'moved');
  assert.deepEqual([quiet.shown, quiet.hidden], [5, 3], 'three new rows past the fold do not grow it');
  assert.deepEqual(quiet.items.map((r) => r.key), ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8'], 'the new ones open with Show more');
  const movedOne = newer.map((r, i) => (i === 6 ? { ...r, moved: true } : r));
  assert.deepEqual([groupRows(movedOne, 5, false, 'moved').shown], [6], 'a row that just moved is still lifted');
  const litOne = newer.map((r, i) => (i === 7 ? { ...r, lit: true } : r));
  assert.deepEqual(groupRows(litOne, 5, false, 'moved').items.slice(0, 6).map((r) => r.key), ['n1', 'n2', 'n3', 'n4', 'n5', 'n8'],
    'the row you are on is still lifted');

  // The band keeps what was in sight when Show more is pressed.
  const lists = read('frontend/src/features/ai/lists.tsx');
  assert.match(lists, /const \[kept, setKept\] = useState<string\[\] \| null>\(null\);/);
  assert.match(lists, /onClick=\{\(\) => setKept\(open \? null : items\.slice\(0, shown\)\.map\(\(line\) => line\.key\)\)\}/);
  // A band's Show more opens and shuts on one curve for the height (24 Nov
  // 2026: the only fold left; Not moving is a row's state now). Opening fades
  // the rows in; shutting keeps them drawn while the clip closes over them,
  // and hides them only at the end.
  assert.match(lists, /const FOLD_OPEN = 'grid-rows-\[1fr\] opacity-100 \[transition:grid-template-rows_300ms_cubic-bezier\(0\.4,0,0\.2,1\),opacity_200ms_ease-out\]';/);
  assert.match(lists, /const FOLD_SHUT = 'grid-rows-\[0fr\] opacity-0 \[transition:grid-template-rows_300ms_cubic-bezier\(0\.4,0,0\.2,1\),opacity_0s_linear_300ms\]';/);
  assert.equal(lists.match(/className=\{`grid motion-reduce:transition-none \$\{open \? FOLD_OPEN : FOLD_SHUT\}`\}/g).length, 1,
    'a band\'s fold, without motion under reduce motion');
  assert.doesNotMatch(lists, /cubic-bezier\(0\.22,1,0\.36,1\)/, 'not the sharp ease-out that emptied a shutting fold at once');
});

// #6245 (4 Nov 2026, Evan): pressing a row past a project's first five slid
// it up to sixth place while its page opened, because the group lifted the
// row you are on even when Show more had opened every row.
test('#6245: a row pressed in an opened group keeps its place, and a live refresh cannot slide it', () => {
  const { groupRows, holdOrder } = loadTsx(MODEL);
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
  assert.match(lists, /const held = holding && drawn\.current \? holdOrder\(lines, drawn\.current\) : lines;/,
    'Needs you holds its order, only while held');
  assert.match(lists, /onPointerEnter: start,\s+onPointerLeave: end,/, 'the pointer over the band holds it');
  assert.match(lists, /onFocus: \(e: React\.FocusEvent\) => \{ if \(!within\(e\.relatedTarget\)\) start\(\); \},/,
    'a row with keyboard focus holds it too');
  assert.match(lists, /data-ai-list="work"\s+\{\.\.\.needs\.handlers\}/, 'on Needs you alone');
  assert.match(lists, /<BandRows lines=\{needs\.held\}/, 'and it draws the held order');

  // Rendered folded, the lit row joins the band's first six (24 Nov 2026).
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
    hero: null, ready: true, owed: 8,
    rows: eight, lit: 'page:app/garden/dev/changes/7', progress: [], waiting: [], live: [],
    openRow() {}, openThread() {},
  });
  const shown = html.slice(0, html.indexOf('data-ai-group-rest'));
  assert.ok(shown.indexOf('Row 7') > shown.indexOf('Row 6'), 'folded, the row you are on joins the first six');
  assert.ok(!shown.includes('Row 8'), 'and the rows below it fold away');
});

// #6262 (4 Nov 2026, Evan): "Hard to tell which threads have unread content."
// A thread somebody has written in since the viewer opened it gets a blue dot
// and a bold title, and Needs you says how many are new: on its own heading,
// on each project's name, in the header and on the filter chips.
test('#6262: threads with something new get a dot and a bold title, and are never folded away', () => {
  const { freshCount, freshByProject, groupRows, needsYou, heroWords } = loadTsx(MODEL);
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
  assert.equal(hero.id, 'messages:ai.hero.threadsBothFresh');
  assert.equal(words(hero), '13 threads need you · <0>4 new</0> · In progress: 7', 'the count sits between the two');
  assert.equal(heroWords(13, 7, 0).id, 'messages:ai.hero.threadsBoth', 'nothing new says nothing');
  assert.equal(heroWords(13, 0, 2).id, 'messages:ai.hero.threadsNeedsFresh');

  // Rendered: the dot and the bold title (24 Nov 2026: the bands carry no
  // Earlier line and no "N new" pills; the head's line is the bands' counts,
  // and the project filter is one control, not a chip a project).
  const games = { slug: 'games', name: 'Game corner', icon_url: null, icon_emoji: null };
  const line = (key, title, appIn, unread) => ({
    key, title, app: appIn, who: 'all',
    sub: { id: 'messages:ai.row.where', values: { project: appIn.name, number: 1 } },
    pill: { id: 'messages:ai.pill.vote' }, href: `#app/${appIn.slug}/dev/issues/1`, rootId: null,
    threadId: Number(key.replace(/\D/g, '')) + 40, unread,
  });
  const { renderComponent } = require('./lib/render-tsx');
  const html = renderComponent('frontend/src/features/ai/lists.tsx', 'AiLists', {
    hero: null, ready: true, owed: 3,
    rows: [line('need:proposal:1', 'New one', app, 2), line('need:proposal:2', 'Old one', app, 0),
      line('need:proposal:3', 'Other project', games, 1)],
    lit: null, progress: [], waiting: [], live: [], openRow() {}, openThread() {},
  });
  assert.match(html, /data-ai-dot=""/, 'a new row has its dot');
  assert.match(html, /font-bold text-zinc-900 dark:text-zinc-100" data-ai-line-title="">New one</, 'and a bold title');
  assert.match(html, /data-ai-line="need" data-ai-fresh=""/, 'the row is marked new');
  assert.ok(!html.includes('data-ai-earlier') && !html.includes(' new<'), 'no Earlier line and no count of new');
  // Nothing new: no dot anywhere.
  const quiet = renderComponent('frontend/src/features/ai/lists.tsx', 'AiLists', {
    hero: null, ready: true, owed: 2,
    rows: [line('need:proposal:1', 'One', app, 0), line('need:proposal:3', 'Two', games, 0)],
    lit: null, progress: [], waiting: [], live: [], openRow() {}, openThread() {},
  });
  assert.ok(!quiet.includes('data-ai-dot'), 'nothing new has no dot');
  assert.ok(!quiet.includes('data-ai-fresh'), 'and no row is marked new');
});

// #6408 (6 Nov 2026, Evan): Live this week showed 50 of a project's 76 rows
// before Show more, because every "it's live" row was new and #6262 never
// folds a fresh row. New in Live only means a change went live since the
// viewer last looked, so Live folds after its first few whatever is new: its
// rows put the new ones first, and the fold says how many of them it holds.
// Needs you and Waiting & in progress keep the never-fold rule.
// 18 Nov 2026: PR 6792 was shared (In progress, being made), then promoted
// with the tab open. Three changes of its author's had just merged, so In
// progress was three Going live rows and PR 6792, now Waiting while its
// checks ran, was Homeroom's fourth row: folded behind Show more until its
// checks failed and it went to Needs you. A row that moves while the page is
// up is not folded away; the page's first read moves nothing.
test('a row that moves while the page is up is not folded away (PR 6792)', () => {
  const { groupRows, movedSince, standingsOf } = loadTsx(MODEL);
  const next = (id, stage) => thread(id, id, stage, { group: 'next' });
  const wait = (id, stage, extra = {}) => thread(id, id, stage, { group: 'waiting', ...extra });
  // 12:02, the first read: two going live, PR 6792 being made, two waiting.
  const before = { progress: [next(6786, 'going_live'), next(6785, 'going_live'), next(6792, 'building')],
    waiting: [wait(6791, 'vote'), wait(6699, 'vote')] };
  assert.equal(movedSince(null, before.progress), before.progress, 'nothing has moved on the first read');
  const seen = standingsOf([...before.progress, ...before.waiting]);
  assert.equal(seen.get(6792), 'next:building');
  // 12:06: #6791 merged and is going live; PR 6792 is promoted and checking.
  const progress = movedSince(seen, [next(6786, 'going_live'), next(6785, 'going_live'), next(6791, 'going_live')]);
  const waiting = movedSince(seen, [wait(6792, 'checking', { work: { line: { code: 'checks_running', minutes: 3 } } }), wait(6699, 'vote')]);
  assert.deepEqual([...progress, ...waiting].map((t) => [t.threadId, !!t.moved]),
    [[6786, false], [6785, false], [6791, true], [6792, true], [6699, false]]);
  // The card draws a project's In progress, then its Waiting (./lines.ts).
  const lines = [...progress, ...waiting].map((t) => ({ key: String(t.threadId), moved: t.moved }));
  const folded = groupRows(lines, GROUP_FIRST.busy, false);
  assert.deepEqual(folded.items.slice(0, folded.shown).map((l) => l.key), ['6786', '6785', '6791', '6792'],
    'PR 6792 stays in sight; only #6699, which did not move, is folded');
  assert.equal(folded.hidden, 1);
  assert.equal(groupRows(lines.map((l) => ({ key: l.key })), GROUP_FIRST.busy, false).hidden, 2, 'it was folded before');
  // A new second line is not a move, and a row that went nowhere is the same row.
  const ticking = [wait(6792, 'checking', { work: { line: { code: 'checks_running', minutes: 1 } } })];
  assert.equal(movedSince(standingsOf(waiting), ticking), ticking);
  assert.equal(movedSince(standingsOf([]), ticking)[0].moved, true, 'a row new to the card has moved into it');
  // The page takes what it first had on each showing and hands both faces the marked rows.
  const index = read('frontend/src/features/ai/index.tsx');
  assert.match(index, /setSeen\(\(had\) => \(had && had\.showing === showings \? had : \{ showing: showings, at: standingsOf\(\[\.\.\.progress, \.\.\.waiting\]\) \}\)\);/);
  assert.equal((index.match(/progress=\{progressDrawn\}\s+waiting=\{waitingDrawn\}/g) || []).length, 1, 'the list');
  assert.match(read('frontend/src/features/ai/lines.ts'), /fresh: \(th\.unread \|\| 0\) > 0,\s+moved: th\.moved === true,/);
});

test('#6408: Live this week folds after its first few rows whatever is new', () => {
  const { groupRows } = loadTsx(MODEL);
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
  const movedRows = many.map((r) => ({ ...r, fresh: false, moved: r.key === 'r8' }));
  assert.deepEqual([groupRows(movedRows, GROUP_FIRST.live, false, false).shown], [3], 'Live folds a moved row too');

  // 24 Nov 2026: Live this week is Done's first rows. Done shows five and
  // folds what is new with the rest (it lifts only the row you are on); its
  // Show more says no count.
  const lists = read('frontend/src/features/ai/lists.tsx');
  assert.match(lists, /: groupRows\(doneLines, doneShown, false, false\);/, 'Done folds what is new like anything else');

  // Rendered: eight live rows, six new, show Done's first five and Show more.
  const live = Array.from({ length: 8 }, (_, i) => thread(30 + i, 410 + i, 'going_live', {
    group: 'live', at: '2026-11-06T10:00:00Z', unread: i < 6 ? 1 : 0,
  }));
  const { renderComponent } = require('./lib/render-tsx');
  const html = renderComponent('frontend/src/features/ai/lists.tsx', 'AiLists', {
    hero: null, ready: true, owed: 0,
    rows: [], lit: null, progress: [], waiting: [], live, openRow() {}, openThread() {},
  });
  const sheet = html.slice(html.indexOf('data-ai-sheet="live"'));
  assert.equal((sheet.match(/data-ai-line=/g) || []).length, 5, 'five rows at rest');
  assert.match(sheet, new RegExp(`data-ai-history-more="">${message('messages:ai.band.showMore')}`), 'then Show more, with no count');
});


// #6312 (4 Nov 2026, Evan): "Show 11 more" made two rows' blue dots disappear
// the instant it was pressed. Folded, a new row is lifted above the fold, so
// its dot shows. Opened, every row keeps its own order, so a new row past the
// first few sits back in the box the fold clips while it animates, and that
// box's overflow-hidden cut the dot off, 12px outside its row. The box keeps
// the dot's room on the start side: the negative margin moves its clip edge
// out, and the same padding leaves every row exactly where it was.
test('#6312: the fold\'s box keeps the room a new row\'s dot stands in, folded or open', () => {
  const { groupRows } = loadTsx(MODEL);
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
    hero: null, ready: true, owed: 0,
    rows: many.map((r, i) => line(`need:proposal:${i + 1}`, `Row ${i + 1}`, i === 6 ? 1 : 0)),
    lit: null, progress: [], waiting: [], live: [], openRow() {}, openThread() {},
  });
  // Folded, the new row is drawn above the fold, dot and all.
  const folded = html.slice(0, html.indexOf('data-ai-group-rest'));
  assert.ok(folded.includes('Row 7'), 'the new row is lifted above the fold');

  // The box a fold clips still clips (the animation needs it). 24 Nov 2026:
  // the dot stands in the row's own leading padding (start-1 inside px-3), so
  // a clip at the row's edge, folded or open, never cuts it off.
  const groupClip = /data-ai-group-rest=""><div class="([^"]*)">/.exec(html);
  assert.ok(groupClip, 'the band folds its rest away');
  assert.match(groupClip[1], /overflow-hidden/, 'the fold still clips');
  const src = read(LISTS);
  assert.match(src, /const DOT = 'absolute start-1 /, 'the dot is 4px in from the row\'s start');
  assert.match(src, /const ROW = `group relative flex [^`]*px-3 /, 'inside its 12px of padding');
  assert.doesNotMatch(src, /data-ai-still-rest/, 'Not moving folds nothing any more: it is a row\'s state');
});

// 6 Nov 2026 (Evan) split each project's rows by day under small caps
// dividers. 24 Nov 2026 (Evan's review, the three bands): "Inside a band there
// are no project heads and no day lines." The model still knows the day (the
// look's list draws it); the bands say it on each row's second line.
test('24 Nov 2026: the bands draw no day lines; each row\'s second line says when, and History keeps no months', () => {
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
    hero: null, ready: true, owed: 3,
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
  // 24 Nov 2026 (the three bands): no project group and no day divider; the
  // rows are newest first, and each row's second line says when.
  assert.doesNotMatch(html, /data-ai-day=|data-ai-group=|data-ai-project-head/, 'no day lines and no project heads');
  assert.ok(needs.indexOf('Today one') < needs.indexOf('Today two') && needs.indexOf('Today two') < needs.indexOf('Yesterday one')
    && needs.indexOf('Yesterday one') < needs.indexOf('Older one'), 'newest first, a day\'s rows in the order they came');
  const lineOf = (title) => {
    const from = needs.indexOf(title);
    return (/data-ai-line-why="">([^<]+)</.exec(needs.slice(from)) || [])[1] || '';
  };
  assert.equal(lineOf('Today one'), message('messages:ai.row.reasonWhen', { reason: message('core:work.stage.upForVote'), when: message('messages:ai.when.today') }),
    'a vote says so, and when: "Up for a vote · today"');
  assert.match(lineOf('Yesterday one'), new RegExp(` · ${message('messages:ai.when.yesterday')}$`));
  assert.match(lineOf('Older one'), /\d/, 'an older day says its date');
  // In progress says since when it has stood where it stands.
  assert.match(busy, new RegExp(message('messages:ai.when.sinceAlone', { day: message('messages:ai.when.today') })
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/^S/, '[Ss]')));

  // History has no card and no months of its own: Done runs on into it.
  const history = {
    rows: [{ key: 'thread:9', threadId: 9, number: 392, title: 'Watering reminders', app, href: '#app/garden/dev/issues/392', at: older, kind: 'change', outcome: 'live', by: 'bot' }],
    next: null, ready: true, loading: false, failed: false, more() {}, retry() {},
  };
  const withHistory = renderComponent(LISTS, 'AiLists', {
    hero: null, ready: true, owed: 0,
    rows: [], progress: [], waiting: [], live: [thread(3, 73, 'live', { at: today })],
    history, openRow() {}, openThread() {}, openHistory() {},
  });
  assert.doesNotMatch(withHistory, /data-ai-sheet="history"|data-ai-history-month|data-ai-day=/);
  const done = withHistory.slice(withHistory.indexOf('data-ai-sheet="live"'));
  assert.ok(done.indexOf('T3') < done.indexOf('Watering reminders'), 'this week first, then History');
});

test('the filter: projects ranked by what needs you most, one control that opens them all (the look keeps its chips)', () => {
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

  // 24 Nov 2026 (the three bands): the standard list's filter is one
  // control on the head card's tools line, All projects at rest, opening the
  // picker; the rail of chips is the look's list's alone (./frame-list.tsx).
  const lists = read('frontend/src/features/ai/lists.tsx');
  assert.doesNotMatch(lists, /data-ai-project-chips|data-ai-chip=|FadeRail role="group" aria-label=\{t\('messages:ai\.filter\.label'\)\}/, 'no chip a project');
  assert.match(lists, /aria-haspopup="dialog"\s+aria-expanded=\{!!more\}\s+aria-label=\{t\('messages:ai\.filter\.button', \{ shown: filterWords \}\)\}/,
    'a menu button, named by what it shows');
  assert.match(lists, /data-ai-project-more=""\s+data-ai-picked=\{picked\.length \? picked\.join\(' '\) : undefined\}/);
  assert.equal(message('messages:ai.filter.allProjects'), 'All projects');
  assert.equal(message('messages:ai.filter.someProjects', { count: 2 }), '2 projects');
  const { renderComponent } = require('./lib/render-tsx');
  const drawn = (picked) => renderComponent('frontend/src/features/ai/lists.tsx', 'AiLists', {
    ready: true, owed: 0, rows, progress: [], waiting: [], live: [], openRow() {}, openThread() {}, picked,
  });
  const filter = (html) => /<button[^>]*data-ai-project-more=""[^>]*>([\s\S]*?)<\/button>/.exec(html)[1];
  assert.match(filter(drawn([])), /All projects/);
  assert.match(filter(drawn(['games'])), /Game corner/, 'one picked: its name');
  assert.match(filter(drawn(['games', 'garden'])), /2 projects/, 'several: how many');
  // The chip primitive's own fade rail (#6660), which Home's kind chips and
  // Done's kind chips use: the first render carries no mask and no edge
  // marks, so a prerender and its hydration match; a caller's spacing wins
  // over the rail's own through `cn`.
  const { renderToHtml, createElement } = require('./lib/render-tsx');
  const { FadeRail, ChipRail: PlainRail } = loadTsx('frontend/@/components/ui/chip.tsx');
  const rail = renderToHtml(createElement(FadeRail, { className: 'px-1 pb-2', 'data-x': 'y' }, 'A'));
  assert.doesNotMatch(rail, /mask-image|WebkitMaskImage|data-fade/, 'nothing fades until an effect has measured the row');
  assert.match(rail, /class="[^"]*\bpx-1 pb-2"/);
  assert.doesNotMatch(rail, /class="[^"]*\bpx-4\b[^"]*"/, 'the caller\'s padding replaces the rail\'s');
  assert.match(rail, /data-x="y"/);
  assert.equal(PlainRail, FadeRail, 'one rail since request 7029: every chip row fades at the end with more');

  const picker = read('frontend/src/features/ai/project-picker.tsx');
  assert.match(picker, /createPortal\(sheet \? <PickerSheet \{\.\.\.props\} \/> : <PickerMenu anchor=\{anchor\} \{\.\.\.props\} \/>, document\.body\)/,
    'a sheet on a phone, a menu under the chip on a wide window; nothing in the prerender');
  assert.match(picker, /type="checkbox"[\s\S]*?checked=\{picked\.includes\(p\.app\.slug\)\}[\s\S]*?onChange=\{\(\) => onToggle\(p\.app\.slug\)\}/, 'a pick applies at once');
  assert.match(picker, /inside: \(target\) => !!target\.closest\('\[data-ai-project-more\]'\)/, 'a press on the filter toggles it rather than closing and reopening');
  // #7126: Show all projects clears the ticks and then closes, so the lists
  // behind show every project again rather than the panel staying as it was.
  assert.match(picker, /onClick=\{\(\) => \{ onClear\(\); onClose\(\); \}\}\s+disabled=\{!picked\.length\}\s+data-ai-pick-all=""/,
    'Show all projects unpicks every project, then closes the panel; with nothing picked it is disabled');
  assert.doesNotMatch(picker, /onClick=\{onClear\}/, 'the press does more than clear, which changed nothing inside the panel');
  assert.equal(message('messages:ai.filter.note.needs', { count: 1 }), '1 needs you');
  assert.equal(message('messages:ai.filter.note.needs', { count: 3 }), '3 need you');
  assert.equal(message('messages:ai.filter.note.live', { count: 2 }), '2 live this week');
  assert.equal(message('messages:ai.filter.group.busy'), 'In progress or waiting');

  // #6675: the menu stays inside the window. Its right edge lines up with the
  // More chip's when there is room; a chip near the window's left edge (a
  // narrow list column, as reported) slides it right to 8px in rather than
  // leaving the search box and project names off screen.
  const { pickerMenuBox } = loadTsx('frontend/src/features/ai/picker-box.ts');
  assert.deepEqual(pickerMenuBox({ right: 900, bottom: 100 }, 1280), { top: 108, left: 540, width: 360 },
    'right edges together under the chip, 8px under it');
  assert.equal(pickerMenuBox({ right: 260, bottom: 100 }, 1280).left, 8, 'a chip near the left edge starts the menu 8px in');
  assert.equal(pickerMenuBox({ right: 1300, bottom: 100 }, 1280).left, 912, 'a chip past the right edge stays 8px in from it');
  assert.deepEqual(pickerMenuBox({ right: 200, bottom: 100 }, 300), { top: 108, left: 8, width: 284 },
    'a window narrower than the menu narrows it to the window less 16px');
  assert.match(picker, /const box = pickerMenuBox\(anchor, window\.innerWidth\);/,
    'the menu measures against the window it is hung in');
  assert.match(picker, /const style = \{ top: `\$\{box\.top\}px`, left: `\$\{box\.left\}px` \};/,
    'placed by its left edge, which the helper has already kept inside the window');
  assert.doesNotMatch(picker, /right:/, 'and never by a right offset, which is what let it hang off the left');
});

test('In progress and Waiting each leave out a thread the feed lists, by its request or its change', () => {
  const { inProgress, upNext } = loadTsx(MODEL);
  const needs = [{ kind: 'proposal', id: 1, number: 6025, title: 'Its change', app }];
  const work = {
    private: [],
    next: [thread(1, 6036, 'fixing', { group: 'next', change: { id: 9, number: 6025 } }), thread(2, 6040, 'building', { group: 'next', by: 'bot' })],
    // Its own thread: a change for no request is numbered by the change.
    waiting: [thread(3, 6025, 'vote', { kind: 'change', change: { id: 10, number: 6025 } }), thread(4, 6038, 'held', { heldBy: 'approvals' })],
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
  // 18 Nov 2026: by the request's number and, apart, the change's (tests/thread-shared-number.test.js).
  assert.deepEqual([...owedKeys(needs)].sort(), ['garden#6038', 'garden#change:6032']);
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
    'Garden club · #7 · Building · Homeroom bot is building it',
    'Garden club · #7 · Building · You\'re building it',
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
  // Phone review #22: the count is threads, across every project, and says so.
  assert.equal(words(heroWords(2, 3)), '2 threads need you · In progress: 3');
  assert.equal(words(heroWords(1, 3)), '1 thread needs you · In progress: 3');
  assert.equal(words(heroWords(0, 3)), 'In progress: 3');
  // Y03: a zero says nothing, and with neither there is no line.
  assert.equal(words(heroWords(2, 0)), '2 threads need you');
  assert.equal(heroWords(0, 0), null);
});

test('the hero counts what the project filter shows (request 6744)', () => {
  const { showsPicked } = loadTsx('frontend/src/features/ai/lines.ts');
  const garden = { slug: 'garden' };
  // All picked nothing: every project shows, and a private row in no project too.
  assert.equal(showsPicked([])(garden), true);
  assert.equal(showsPicked([])(null), true);
  // One project picked: it shows; another project, and a private row in no
  // project, do not, as the lists leave them out.
  assert.equal(showsPicked(['garden'])(garden), true);
  assert.equal(showsPicked(['garden'])({ slug: 'bread' }), false);
  assert.equal(showsPicked(['garden'])(null), false);
  // The lists and the line under the bot's name ask the same rule, so a
  // saved filter's counts cannot disagree with the list below them.
  const lines = read('frontend/src/features/ai/lines.ts');
  assert.match(lines, /const shows = showsPicked\(picked\);/, 'the lists narrow by the shared rule');
  assert.match(lines, /progressShown: progressShown\.length,/, 'the hook reports the in-progress count it shows');
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
    'Going live', 'Building', 'Building', 'Building', 'Building', 'Up for a vote', 'Checking', 'Not started yet', 'Ready to build',
    'Ready to build', 'Ready to build', 'Not started yet', 'Not started yet', 'Stopped: the build didn\'t finish',
  ], 'the stage, in the words every screen uses');
  // Handed back by the bot: Needs reply, Restart build and Retry the fix,
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
    ['decide:7', 'Needs reply', 'Garden club · #410 · Waiting for you to decide'],
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
  // 24 Nov 2026 (the three bands): a Needs you row ends in what you do, as a
  // verb (./lines.ts verbOf); the model's own pill stays the look's word.
  const { verbOf, needReason } = loadTsx(LINES);
  assert.deepEqual(rows.map((r) => message(verbOf(r.pill))), ['Vote', 'Reply', 'Restart build', 'Retry the fix'], 'Needs reply is Reply');
  assert.equal(message(verbOf({ id: 'messages:ai.pill.testsFailing' })), 'Fix it', 'your own change waiting on your fix');
  assert.equal(message(verbOf({ id: 'messages:ai.pill.conflicts' })), 'Fix it');
  assert.equal(message(verbOf(null)), 'Read', 'a private thread Homeroom bot answered');
  assert.equal(words(needReason(needsYou([{ kind: 'proposal', id: 2, number: 601, title: 'Plain', app }], null)[0])), 'Up for a vote',
    'a plain vote\'s reason is its stage');
  // The reason and the time are the wide row's second line (app.css hides
  // it where the list is narrow); the tooltip says the whole line everywhere.
  const lists = read('frontend/src/features/ai/lists.tsx');
  assert.match(lists, /<span className="ai-row-sub block truncate text-xs leading-4 text-zinc-500 dark:text-zinc-400" data-ai-line-why="">\{line\.sub\}<\/span>/);
  assert.match(lists, /const ROW = `group relative flex min-h-\[44px\]/, 'a 44px tap target');
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
  assert.deepEqual(rows.map((r) => r.pill && message(r.pill.id)), ['Confirm it works', 'Confirm it works', 'Needs reply']);
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
  // The glyph is a check, not the raised hand a decision gets: a name the
  // look's list draws (./lines.ts). 24 Nov 2026: the standard list's row
  // leads with its project's tile and ends in the verb.
  assert.match(read('frontend/src/features/ai/lines.ts'), /if \(kind === 'works'\) return 'check';/);
  const { verbOf } = loadTsx(LINES);
  assert.equal(message(verbOf(rows[0].pill)), 'Confirm it works');
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

test('#6158: a Waiting row says what it waits on, and a row nobody is moving says Not moving in In progress', () => {
  const { shortWords, nextWords, notMoving } = loadTsx(MODEL);
  const row = (what, extra = {}) => thread(1, 7, what, extra);
  // Nobody is moving it: not started on, or waiting on somebody else's move.
  assert.deepEqual([
    row('queued'), row('held'), row('needs_person'), row('nothing_to_build'), row('not_picked_up'), row('stalled'), row('vote'),
  ].map(notMoving), [false, false, true, true, true, true, false]);
  assert.equal(words(shortWords(row('not_picked_up', { quietDays: 12 }))), 'Not started yet');
  assert.equal(words(nextWords(row('queued', { work: { line: { code: 'queued', place: 4 } } }))),
    'Garden club · #7 · Not started yet · Number 4 in line');
  // 24 Nov 2026 (the three bands): a thread nobody is moving stays in In
  // progress, its state Not moving, and its reason says where it stopped.
  // Nothing folds it away.
  const { renderComponent } = require('./lib/render-tsx');
  const html = renderComponent('frontend/src/features/ai/lists.tsx', 'AiLists', {
    hero: null, ready: true, rows: [], owed: 0,
    progress: [], live: [], openRow() {}, openThread() {},
    waiting: [thread(1, 71, 'queued', { work: { line: { code: 'queued', place: 2 } } }), thread(2, 72, 'not_read'), thread(3, 73, 'operator')],
  });
  assert.doesNotMatch(html, /data-ai-still/, 'no fold of its own');
  assert.match(html, new RegExp(message('messages:ai.band.progressCount', { count: 3 })), 'the band counts every row');
  assert.equal((html.match(new RegExp(`data-ai-row-end="state">${message('messages:ai.state.notMoving')}<`, 'g')) || []).length, 2,
    'the two nobody is moving say so');
  assert.match(html, /data-ai-row-end="state">Not started yet</, 'the one in line keeps its stage');
  assert.match(html, /Number 2 in line/, 'with its second line');
  assert.equal(message('messages:ai.state.notMoving'), 'Not moving');
});

test('a change waiting only on its before & after screenshots reads "Taking screenshots", with a camera', () => {
  const { shortWords, nextWords, notMoving } = loadTsx(MODEL);
  const { waitGlyph } = loadTsx('frontend/src/features/ai/lines.ts');
  const shots = thread(1, 7, 'checking', { work: { line: { code: 'shots' } } });
  // Its word is its own, not Checking (its tests passed) nor Building
  // (nobody is changing it); its line says the one thing left.
  assert.equal(words(shortWords(shots)), 'Taking screenshots');
  assert.equal(words(nextWords(shots)),
    'Garden club · #7 · Taking screenshots · Tests passed: only the before and after screenshots are left');
  assert.equal(notMoving(shots), false, 'it is moving: it is not folded under Not moving');
  // The camera is for that wait alone: tests still running keep the clock.
  assert.equal(waitGlyph(shots), 'camera');
  assert.equal(waitGlyph(thread(2, 8, 'checking')), 'clock');
  assert.equal(waitGlyph(thread(3, 9, 'checking', { work: { line: { code: 'checks_running', minutes: 4 } } })), 'clock');
  assert.equal(waitGlyph(thread(4, 10, 'queued')), 'clock');
  // 24 Nov 2026: the list's row leads with its project's tile, and ends in the word.
  assert.match(read('frontend/src/features/ai/lines.ts'), /const waitingLine = threadLine\(waitGlyph\);/);
  const { renderComponent } = require('./lib/render-tsx');
  const html = renderComponent('frontend/src/features/ai/lists.tsx', 'AiLists', {
    hero: null, ready: true, rows: [], owed: 0,
    progress: [], live: [], openRow() {}, openThread() {},
    waiting: [shots],
  });
  assert.match(html, /data-ai-row-end="state">Taking screenshots</, 'the state at the row\'s end');
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
  // 13 Nov 2026: once that change is live or closed the thread is History's
  // (the server says so as resultDone, services/ai-work.js ABOUT_CHANGE_END_SQL),
  // so the change is not listed here and again under Live this week.
  const liveChange = thread(6, 6230, 'live', { kind: 'change', app: github });
  const finished = {
    private: [{ rootId: 5, title: 'Plans', kind: 'ask', app: github, state: 'open', about: { kind: 'change', number: 6230 }, resultDone: true }],
    needs: [], next: [], waiting: [], live: [liveChange],
  };
  assert.deepEqual(needsYou(null, finished), [], 'not under Needs you');
  const { liveThisWeek } = loadTsx(MODEL);
  assert.deepEqual(liveThisWeek(finished).map((t) => t.threadId), [6], 'the change is Live this week\'s one row');
  assert.deepEqual(require('../src/services/ai-work').unfiledPrivate(finished.private, new Set()), [], 'nor counted by the server\'s own lists');
  // Older servers send no flag: the row keeps what it said before.
  assert.equal(changeOnGithub(thread(4, 6230, 'vote', { kind: 'change', app })), false);
  // The rendered row's number cell says PR; "#6230" is nowhere on the page.
  const { renderComponent } = require('./lib/render-tsx');
  const html = renderComponent('frontend/src/features/ai/lists.tsx', 'AiLists', {
    hero: null, ready: true, rows: [], owed: 0,
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
  // 11 Nov 2026: each row's words travel with it (services/work-state.js phrasesOf).
  const { phrasesOf } = require('../src/services/work-state');
  const work = (stage, extra = {}) => {
    const w = { stage, why: null, reason: null, line: null, since: at, ...extra };
    return { ...w, words: phrasesOf(w) };
  };
  const promoted = { ...open, change_status: 'promoted', change_user: 9, voted: true, my_vote: 'yes', promoted_at: at };
  assert.deepEqual(aiWork.standing(promoted, ME, now, null, ws('up_for_vote')),
    { group: 'waiting', work: work('up_for_vote'), at, myVote: 'yes' }, 'a vote you have given waits on others');
  assert.equal(aiWork.standing({ ...promoted, voted: false }, ME, now, null, ws('up_for_vote')), null,
    'a vote still owed is the Needs you feed\'s');
  // #6821: their yes is the viewer's fact at any stage, so a change still
  // checking carries it too; that did not change what #6060 holds it under.
  assert.deepEqual(aiWork.standing(promoted, ME, now, null, ws('checking', { line: { code: 'checks_failing', failing: 2 } })),
    { group: 'waiting', work: work('checking', { line: { code: 'checks_failing', failing: 2 } }), at, myVote: 'yes' },
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
  // 24 Nov 2026 (mobile 04): `wrote` tells a writer (or someone named in
  // it) from a voter. A writer's thread is listed at every stage, as their
  // own would be; one they only voted in is listed at none while it is open.
  assert.equal(aiWork.standing({ ...open, own: false, wrote: true }, ME, now, null, decide, { decides: false }).group, 'waiting',
    'one they only wrote in, with no change in flight, waits on that person');
  assert.equal(aiWork.standing({ ...open, own: false, wrote: true, change_status: 'active', change_user: 9 }, ME, now, null, ws('building')).group, 'next',
    'one they only wrote in, being built, is In progress');
  assert.equal(aiWork.standing({ ...open, own: false }, ME, now, null, decide, { decides: false }), null,
    'one they only voted in, with no change in flight, is not listed (it was Not moving)');
  assert.equal(aiWork.standing({ ...open, own: false }, ME, now, null, ws('reading', { line: { code: 'waiting' } })), null,
    'nor one nobody has picked up');
  assert.equal(aiWork.standing({ ...open, own: false, change_status: 'active', change_user: 9 }, ME, now, null, ws('building')), null,
    'one they only voted in, being built, asks nothing of them');
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
  // 11 Nov 2026: with no stored row read, nothing is listed: the stored row
  // is the one source (statesFor makes a missing one first).
  assert.equal(aiWork.standing({ ...promoted, check_state: 'passing', change_id: 4 }, ME, now), null);
  assert.equal(aiWork.standing(open, ME, now), null);
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
  const { handedBack } = require('../src/services/homeroom-bot-progress');
  const looked = { mode: 'live', verdict: 'person', request_closed: false, proposal_status: null };
  assert.equal(require('../src/services/work-state').derive(looked).stage, 'waiting_for_you', 'nothing about it is in progress');
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
  // 24 Nov 2026: the band's count is its rows; its heading's spoken name says it.
  assert.match(read('frontend/src/features/ai/lists.tsx'),
    /spoken=\{needLines\.length\s+\? t\('messages:ai\.work\.titleCount', \{ count: needLines\.length \}\)/,
    'the count is in the heading\'s own words, not a link');
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
  // 24 Nov 2026 (mobile 04): a thread she wrote or was named in is read at
  // every stage; one she only voted in only once a change of it merged.
  assert.match(THREADS_SQL, /AND \(mine\.own OR mine\.wrote OR ch\.status = 'merged' OR ch\.user_id = \$1\)/);
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
  // The column docked beside it only on a wide window, after mount.
  assert.match(src, /const \[wide, setWide\] = useState\(false\);/);
  assert.match(src, /\{docked \? \(\s*<aside\s+id="ai-main-pane"\s+ref=\{mainRef\}\s+className="ai-main-pane"/);
  // #6425: nothing is drawn beside the lists; the chat is mounted only when
  // the column is open, or a thread asked for is still to be put there.
  assert.match(src, /const columnOpen = docked && !!column;/);
  assert.match(src, /const conversationUp = columnOpen \|\| !!at\?\.threadRootId;/);
  // 14 Nov 2026: threads only. Nothing of the conversation's own stream is
  // read, drawn or marked read (messages/store.ts loadThreadsOnly).
  assert.match(src, /<EmbeddedConversation conversationId=\{botId!\} active=\{visible && columnOpen\} at=\{at\} threadsOnly \/>/);
  assert.match(src, /void loadConversations\(\);/, 'and the list of conversations is read, for the tab\'s badge');
  // Ask Homeroom bot opens a new chat; a private thread opens in the column,
  // and before the page knows its width, by its address.
  assert.match(src, /<a\s+href=\{botNewAddress\(null\)\}\s+className="messages-composer-card ai-askbar-card"/);
  assert.match(src, /if \(!\(wide \|\| phone\)\) \{ go\(botTabAddress\(next\)\); return; \}/);
  // What the column shows is read from the store after mount only.
  assert.match(src, /const column: Column = !mounted \|\| !botId \? null/);
  // No Main Chat to count what is new: a thread's row carries its own.
  assert.doesNotMatch(src, /botRow|mainOpen|openMain|at: 'main'/);
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
  // A wide window whose column is not docked (yet, or at all) keeps the bar
  // on the page, clear of the sidebar.
  assert.match(read('public/css/app.css'), /#ai-screen \.ai-askbar \{\s+position: fixed;\s+(\/\*[^*]*\*+([^/*][^*]*\*+)*\/\s+)?inset-inline-start: calc\(var\(--platform-rail-w, 0px\) \+ var\(--platform-gutter, 0px\)\);\s+inset-inline-end: var\(--platform-gutter, 0px\);/);
});

test('the phone\'s Ask bar lifts off the white list on a soft shadow', () => {
  const css = read('public/css/app.css');
  // Asked 21 Nov 2026: a white pill on a mostly white list was easy to miss.
  // The bar keeps its hairline as the first layer, then takes the raised
  // surfaces' soft shadow in the app's own colours.
  const rule = css.match(/\nhtml #ai-screen \.ai-askbar-card \{([^}]*)\}/);
  assert.ok(rule, 'the Ask bar\'s shadow rule exists');
  assert.match(rule[1], /box-shadow: var\(--messages-disc-shadow\),/);
  assert.match(rule[1], /0 2px 6px var\(--app-sheet-shadow-near\)/);
  assert.match(rule[1], /0 8px 24px -4px var\(--app-sheet-shadow-far\)/);
  const focus = css.match(/\nhtml #ai-screen \.ai-askbar-card:focus-within \{([^}]*)\}/);
  assert.ok(focus, 'and a focused bar, with the same shadow');
  assert.match(focus[1], /box-shadow: var\(--messages-disc-shadow\), 0 0 0 2px var\(--accent\),/);
});

test('#homeroom-bot is the page; /thread/<id> is a thread in its column; the old /main is resolved to one; #ai lands there', () => {
  const app = read('public/js/app.js');
  // 1 Nov 2026: every address is the page's, and says where in its chat.
  assert.match(app, /if \(parts\[0\] === 'homeroom-bot'\) \{[\s\S]*?App\.setChromeless\(false\);\s+App\.navigateToAi\(\);\s+(?:\/\/[^\n]*\n\s+)*if \(parts\.length === 1\) \{\s+window\.UsernodeReact\?\.ai\?\.closeColumn\?\.\(\);\s+\}\s+if \(parts\[1\] === 'request' \|\| parts\[1\] === 'change' \|\| parts\[1\] === 'decision'\) \{\s+window\.UsernodeReact\?\.ai\?\.openItem\?\.\('#' \+ parts\.join\('\/'\)\);\s+\}\s+if \(parts\[1\] === 'main' \|\| parts\[1\] === 'old' \|\| parts\[1\] === 'thread' \|\| parts\[1\] === 'm'\) \{\s+const at = parts\[1\] === 'old' \? \{\}\s+: App\._messagesExtras\(parts\[1\] === 'main' \? parts\.slice\(2\) : parts\.slice\(1\)\);\s+if \(at\.threadRootId\) \{\s+window\.UsernodeReact\?\.ai\?\.openAt\?\.\(\{/);
  // 14 Nov 2026: an address with no thread is from before (Main Chat, a
  // message named alone, or an agent chat's `old/agent/<id>`): the tab asks
  // the server which thread it is now.
  assert.match(app, /\} else \{\s+(?:\/\/[^\n]*\n\s+)*window\.UsernodeReact\?\.ai\?\.openOld\?\.\('#' \+ parts\.join\('\/'\)\);\s+\}/);
  assert.doesNotMatch(app, /messages\.openBotThread\(root\)/, 'never the Messages screen');
  assert.match(app, /case 'homeroom-bot':[^\n]*\n\s+case 'ai': return 'ai-screen';/);
  // The old address is an alias: rewritten in place, then routed as the new one.
  assert.match(app, /if \(parts\[0\] === 'ai'\) \{[\s\S]*?history\.replaceState\(null, '', '#homeroom-bot' \+ \(parts\.length > 1 \? '\/' \+ parts\.slice\(1\)\.join\('\/'\) : ''\)\);[\s\S]*?parts\[0\] = 'homeroom-bot';\s+\}\s+if \(parts\[0\] === 'homeroom-bot'\) \{/);
  // A Messages address of the bot's chat is swapped in place for the tab's.
  assert.match(app, /const botTab = validConversation \? window\.UsernodeReact\?\.ai\?\.botTabFromMessages\?\.\(`#\$\{hash\}`\) : null;\s+if \(botTab\) \{\s+try \{ history\.replaceState\(null, '', App\._rootUrl\(botTab\)\); \} catch \(_\) \{ return; \}\s+App\.restoreFromHash\(\);\s+return;\s+\}/);
  assert.match(read('frontend/src/features/nav-drawer/messages-drawer.ts'), /if \(at\.conversationId && at\.bot\) return false;/);
});

test('#7140: a thread beside the list sits on the tab\'s own ground, never a white sheet', () => {
  // The private thread is drawn as cards on the page's ground: the docked
  // column paints nothing round it. Pinned so the panel's white ground cannot
  // come back as the thread's (the second copy of the list that did is
  // covered by tests/side-panel.test.js and tests/thread-one-page.test.js).
  const css = read('public/css/app.css');
  const rule = css.match(/#ai-screen\[data-ai-docked\] \.ai-main-pane:has\(\.dev-private-thread\) \{([^}]*)\}/);
  assert.ok(rule, 'the docked column\'s thread rule exists');
  assert.match(rule[1], /background: none;/);
  assert.match(rule[1], /border: 0;/);
  assert.match(rule[1], /border-radius: 0;/);
  // And the panel's document never mounts the bot page's lists at all.
  const app = read('public/js/app.js');
  assert.match(app, /if \(App\.embeddedPanel\) \{\s+const hash = String\(location\.hash \|\| ''\)\.replace\(\/\^#\/, ''\);\s+const route = \/\^homeroom-bot\(\?:\\\/\|\$\)\/\.test\(hash\) \? hash\.split\('\?'\)\[0\] : 'homeroom-bot';\s+window\.UsernodeReact\?\.sidePanelEmbed\?\.handTop\?\.\(route\);\s+return;\s+\}/);
});

test('the way into the bot\'s chat: each address and each door names a place in it, on its tab', () => {
  const door = loadTsx('frontend/src/features/ai/door.ts');
  const plain = (v) => JSON.parse(JSON.stringify(v));
  // 14 Nov 2026: a place is a thread; with none, the page itself (there is
  // no Main Chat), and a message named alone is `/m/<id>`, whose thread the
  // tab asks the server for.
  assert.equal(door.botTabAddress(null), '#homeroom-bot');
  assert.equal(door.botTabAddress({ threadRootId: 139 }), '#homeroom-bot/thread/139');
  assert.equal(door.botTabAddress({ threadRootId: 139, focusMessageId: 150 }), '#homeroom-bot/thread/139/m/150');
  assert.equal(door.botTabAddress({ focusMessageId: 150 }), '#homeroom-bot/m/150');
  assert.equal(door.botTabAddress({ threadRootId: 139, focusMessageId: 139 }), '#homeroom-bot/thread/139', 'the root is no message to land on in its own thread');
  assert.equal(door.botTabAddress({ threadRootId: -4 }), '#homeroom-bot', 'nothing that is not an id');
  // An address from before names the same place: the chat itself was Main Chat.
  assert.equal(door.BOT_OLD_MAIN, '#homeroom-bot/main');
  assert.equal(door.botOldAddress(null), '#homeroom-bot/main');
  assert.equal(door.botOldAddress({ focusMessageId: 150 }), '#homeroom-bot/m/150');
  assert.equal(door.botOldAddress({ threadRootId: 139 }), '#homeroom-bot/thread/139');
  assert.deepEqual(plain(door.botTabAt('#homeroom-bot/thread/139/m/150')), { threadRootId: 139, focusMessageId: 150 });
  assert.deepEqual(plain(door.botTabAt('#homeroom-bot/main')), { threadRootId: null, focusMessageId: null });
  assert.deepEqual(plain(door.botTabAt('#homeroom-bot/m/150')), { threadRootId: null, focusMessageId: 150 });
  assert.equal(door.botTabAt('#homeroom-bot'), null, 'the page itself: the column as it was');
  // A Messages address of the bot's chat is the same place, by its old address.
  assert.equal(door.botTabFromMessages('#messages/2', 2), '#homeroom-bot/main');
  assert.equal(door.botTabFromMessages('#messages/2/thread/139', 2), '#homeroom-bot/thread/139');
  assert.equal(door.botTabFromMessages('messages/2/thread/139/m/141', 2), '#homeroom-bot/thread/139/m/141');
  assert.equal(door.botTabFromMessages('#messages/2/m/141', 2), '#homeroom-bot/m/141');
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
  // A refresh on `#homeroom-bot/thread/<id>` (or that link in a new tab): on
  // a wide window a thread's ask waits until the page knows the bot's chat,
  // since `showAt` puts the thread in the store by that id and nothing else
  // opens the column. A page and a phone's thread are taken at once.
  assert.match(src, /if \(!ask \|\| ask\.seq === askTaken\.current \|\| !visible \|\| !\(wide \|\| phone\)\) return;\s+if \(ask\.at\?\.threadRootId && !botId && !phone\) return;\s+askTaken\.current = ask\.seq;\s+if \(ask\.close\) closeColumn\(\);\s+else if \(ask\.item\) openItem\(ask\.item\);\s+else if \(ask\.at\) showAt\(ask\.at\);\s+\}, \[ask, visible, wide, phone, botId\]\);/);
  assert.match(src, /if \(botId\) embed\(botId, next, \{ threadsOnly: true \}\);/, 'which is where the waited-for id is used');
  assert.match(src, /const showAt = \(next: BotAt\) => \{\s+if \(!next\.threadRootId\) return;/, 'a place with no thread is nothing to show');
  // The detail an address names (`/thread/<id>/design/<v>`) is reopened after
  // that ask, in the same commit: taken first, the thread's ask would close it.
  const askAt = src.indexOf('askTaken.current = ask.seq;');
  const restoreAt = src.indexOf('const restored = useRef<string | null>(null);');
  assert.ok(askAt > 0 && restoreAt > askAt, 'the detail is restored after the ask is taken');
  assert.match(read('frontend/src/features/ai/door.ts'), /host\.ai = \{ \.\.\.\(host\.ai \|\| \{\}\), openAt: askBotTab,/);
});

test('every door into the bot\'s chat lands on its tab, never the Messages screen', () => {
  const store = read('frontend/src/features/messages/store.ts');
  // open(), openAddress(), the bot doors, a quote and a request's See progress.
  // 14 Nov 2026: a door that only knows the chat opens a new one.
  assert.match(store, /if \(validId\(conversationId\) && conversationId === botConversationId\(\)\) \{ goBotAddress\(botNewAddress\(null\)\); return; \}/);
  assert.match(store, /if \(\/\^#homeroom-bot\(\?:\\\/\|\$\)\/\.test\(href\)\) \{ goBotAddress\(href\); return; \}/);
  assert.match(store, /const botTab = botTabFromMessages\(href, botConversationId\(\)\);\s+if \(botTab\) \{ goBotAddress\(botTab\); return; \}/);
  const openBot = store.slice(store.indexOf('export async function openBot('), store.indexOf('export async function openBotRequest('));
  assert.match(openBot, /goBotAddress\(thread\.href\);/, 'the thread about a change');
  assert.match(openBot, /goBotAddress\(botNewAddress\(\{ project: slug \}\)\);/, 'else a new chat set to its project');
  assert.doesNotMatch(openBot, /\bopen\(id\)|openBotTab\(null\)/);
  assert.match(store, /if \(track\?\.askId && track\.askThreadId\) \{\s+openBotTab\(\{ threadRootId: track\.askThreadId, focusMessageId: track\.askId \}\);/, 'See progress, at its plan\'s thread');
  assert.match(store, /await openBotMessage\(validId\(messageId\) \? Number\(messageId\) : null\);/, 'a quote, in the thread its message is in');
  assert.match(store, /const href = botOldAddress\(\{ threadRootId: state\.route\.threadRootId, focusMessageId: state\.route\.focusMessageId \}\);/, 'a cold Messages link, by the old address the tab resolves');
  assert.match(store, /openBotThread: \(rootId: number\) => \{ openBotTab\(\{ threadRootId: rootId, focusMessageId: null \}\); \},/);
  // A cold link: once the store learns the chat is the bot's, as for a channel.
  assert.match(store, /if \(active\.homeroomBot && active\.kind !== 'channel'\) \{\s+noteBotConversation\(active\.id\);\s+if \(state\.route\.open && !state\.route\.embedded\) \{\s+publish\(\{ active \}\);\s+if \(botToTab\(\)\) return;/);
  assert.match(store, /channelToHub\(\);\s+botToTab\(\);/, 'and when the list lands');
  // From any address the router opened the chat at: the query off, the id as a number.
  const botToTab = store.slice(store.indexOf('function botToTab('), store.indexOf('function resolvePendingChannel('));
  assert.match(botToTab, /const parts = window\.location\.hash\.replace\(\/\^#\/, ''\)\.split\('\?'\)\[0\]\.split\('\/'\);\s+if \(parts\[0\] !== 'messages' \|\| Number\(parts\[1\]\) !== conversationId\) return false;/);
  // Design threads, bell rows and the first session name the tab.
  assert.match(read('src/services/design-threads.js'), /href: `#homeroom-bot\/thread\/\$\{Number\(opened\.messageId\)\}`,/);
  assert.match(read('frontend/src/features/first-session/index.tsx'), /else if \(screen === 'bot' && conversationId\) void openFirstVersion\(slug\);/);
  // The inbox does not list it.
  const { buildInbox } = loadTsx('frontend/src/features/messages/inbox.ts');
  const entries = buildInbox({ conversations: [
    { id: 2, lastActivityAt: '2026-11-01T10:00:00Z', kind: 'direct', homeroomBot: true },
    { id: 3, lastActivityAt: '2026-11-01T09:00:00Z', kind: 'direct' },
  ] });
  assert.deepEqual(entries.map((e) => e.key), ['person:3']);
});

test('the screen renders as the prerender does: hidden, the bot\'s name, New chat, Needs you, the Ask bar, no rows', () => {
  const { renderComponent } = require('./lib/render-tsx');
  const html = renderComponent('frontend/src/features/ai/index.tsx', 'AiScreen', {});
  // (React hoists the bot's picture as an image preload ahead of it.)
  assert.match(html, /^(<link rel="preload" as="image" href="\/brand\/homeroom-mark\.png"\/>)?<main id="ai-screen" class="hidden flex-1 overflow-y-auto platform-safe-scroll" data-page-bounce=""/);
  // A level-1 heading by role, not an <h1>: this render is in the served
  // page while the screen is hidden (request #7166, point 4).
  assert.match(html, /<div role="heading" aria-level="1" class="sr-only">Homeroom bot<\/div>/);
  assert.doesNotMatch(html, /<h1[\s>]/);
  assert.match(html, /Needs you/);
  assert.match(html, /<a href="#homeroom-bot\/new" class="messages-composer-card ai-askbar-card" aria-label="Ask Homeroom bot">/);
  assert.ok(!html.includes('data-ai-line'), 'no rows before the effects read them');
  assert.ok(!html.includes('ai-drawer'), 'and no drawer before mount, on a phone either');
  assert.ok(!html.includes('data-ai-main=""'), 'and the column is not docked before mount');
  // 14 Nov 2026: no Main Chat row. New chat is in the head from the first
  // render, at the end of its line: it needs nothing read. 24 Nov 2026: the
  // search field is on the line under it from the first render too, with no
  // key named (the device is not known until after mount).
  assert.doesNotMatch(html, /data-ai-main-row|data-ai-sheet="main"|Main Chat/);
  assert.match(html, /<button type="button" title="New chat" data-bot-new-thread="" data-ai-new-chat="" class="[^"]*bg-violet-600[^"]*"><svg[^>]*>.*?<\/svg><span>New chat<\/span><\/button><\/section><div class="[^"]*" data-ai-tools="">/s);
  assert.match(html, /data-ai-tools=""><label[^>]*data-ai-search-box=""><svg[^>]*>[\s\S]*?<\/svg><input type="search"[^>]*placeholder="Search threads…"[^>]*data-ai-search=""[^>]*\/><\/label>/);
  assert.doesNotMatch(html, /data-ai-search-key|data-ai-search-toggle/, 'no key named, no toggle');
  assert.match(html, /data-ai-hero=""><img src="\/brand\/homeroom-mark\.png" alt=""/, 'the Homeroom mark leads the line');
  assert.doesNotMatch(html, /data-ai-hero-sub/, 'no counts before the lists are read');
  // Needs you shows its rows' shape from the first render; In progress and
  // Done follow once the lists are read, as the cards they replace did, so
  // the prerendered document stays inside its bound (mount-on-reveal).
  assert.match(html, /data-ai-sheet="open"[\s\S]*data-ai-loading=""/);
  assert.doesNotMatch(html, /data-ai-sheet="(?:busy|live)"/);
  assert.ok(!html.includes('data-ai-lit'), 'nothing is lit before the page knows what its column shows');
});

test('there is no Main Chat row: Needs you leads the lists, a private thread\'s row carries its own new mark, and the thread in the column is the lit row', () => {
  const { renderComponent } = require('./lib/render-tsx');
  const rows = [
    { key: 'private:139', title: 'A weekly email', app: null, who: 'solo', sub: { id: 'messages:ai.row.privateIdea' }, pill: null, href: null, rootId: 139, threadId: null, unread: 0 },
    { key: 'private:730', title: 'A darker header', app: null, who: 'solo', sub: { id: 'messages:ai.row.privateIdea' }, pill: null, href: null, rootId: 730, threadId: null, unread: 0 },
  ];
  const props = (lit = null, list = rows) => ({
    hero: null, lit, ready: true, rows: list, owed: 0, progress: [], waiting: [], live: [], openRow() {}, openThread() {},
  });
  const LISTS = 'frontend/src/features/ai/lists.tsx';
  // 14 Nov 2026: every conversation with the bot is a thread, so the list
  // has no row for the chat itself; the title's sheet is followed by Needs you.
  const none = renderComponent(LISTS, 'AiLists', props());
  assert.doesNotMatch(none, /data-ai-main-row|data-ai-main-unread|data-ai-sheet="main"|Main Chat/);
  assert.match(none, /data-ai-sheet="head">[\s\S]*?<\/div><\/div><div class="[^"]*" data-ai-sheet="open">/, 'Needs you follows the head');
  assert.throws(() => message('messages:ai.main.new', { count: 1 }));
  assert.throws(() => message('messages:store.header.main'));
  const quiet = renderComponent(LISTS, 'AiLists', props('private:730'));
  // The thread in the column is the lit row, where you are, and only it.
  assert.equal((quiet.match(/data-ai-lit=""/g) || []).length, 1);
  assert.match(quiet, /data-ai-line="private" data-ai-lit="" aria-current="true"><span[^>]*>[\s\S]*?A darker header/);
  const src = read(LISTS);
  assert.match(src, /const LIT_ROW = `[^`]*bg-\[color:var\(--lit-tint\)\] text-\[color:var\(--lit-ink\)\] \$\{FOCUS\}`;/, 'the lit tint and ink, as the rail\'s rows are');
  // Phone review #140: a private thread's row is lit whole, its ⋯ inside the tint.
  assert.match(src, /const LIT_ROW_WHOLE = '[^']*rounded-xl bg-\[color:var\(--lit-tint\)\]';/);
  assert.match(src, /const LIT_INK_ROW = `(?![^`]*bg-\[)[^`]*text-\[color:var\(--lit-ink\)\] \$\{FOCUS\}`;/, 'its button keeps the ink and no fill of its own');
  // Mobile 04: lit whole with its Dismiss too.
  assert.match(src, /const whole = !!line\.lit && \(!!done \|\| !!dismiss\);/);
  assert.match(src, /<div className=\{whole \? LIT_ROW_WHOLE : 'flex min-w-0 items-center'\} data-ai-row="" data-ai-line-done=\{done \? '' : undefined\}>/);
  assert.match(src, /<RowButton line=\{line\} inLitRow=\{whole\} \/>/);
  assert.doesNotMatch(src, /MainChatRow|MAIN_LIT|main\.(lit|unread|open)/);
  // 24 Nov 2026: the lit row's title is in the lit ink too (its button's).
  assert.match(quiet, /data-ai-lit=""[^>]*>[\s\S]*?class="ai-row-title [^"]*font-semibold" data-ai-line-title="">A darker header</);
  // A private thread's own new mark (no Main Chat counts it): the server's
  // count on its row, as any thread's (#6262).
  const { needsYou, freshCount } = loadTsx(MODEL);
  const work = { private: [
    { rootId: 139, title: 'A weekly email', kind: 'ask', app: null, at: null, unread: 2 },
    { rootId: 730, title: 'A darker header', kind: 'ask', app: null, at: null },
  ], needs: [], next: [], waiting: [], live: [] };
  const made = needsYou([], work);
  assert.deepEqual(made.map((row) => [row.rootId, row.threadId, row.unread]), [[139, null, 2], [730, null, 0]], 'absent from an older server reads as none');
  assert.equal(freshCount(made), 1);
  assert.match(read(MODEL), /unread: Math\.max\(0, Number\(p\.unread\) \|\| 0\),/);
  const fresh = renderComponent(LISTS, 'AiLists', props(null, made));
  assert.match(fresh, /data-ai-line="private" data-ai-fresh=""/, 'the row is marked new');
  // The page lights what the column shows (./column.ts): a thread, a page
  // (#6218), or nothing while a new chat holds it.
  const index = read('frontend/src/features/ai/index.tsx');
  assert.match(index, /const shown = columnKey\(column\);\s+const lit = shown === 'new' \? null : shown;/);
  // Opening a private thread clears its mark at once, by its first message,
  // until the lists are read again (the thread marks itself read when drawn).
  assert.match(index, /if \(rootId\) setSeenRoots\(\(had\) => \(had\.has\(rootId\) \? had : new Set\(\[\.\.\.had, rootId\]\)\)\);/);
  assert.match(index, /\(row\.threadId && seenThreads\.has\(row\.threadId\)\) \|\| \(!row\.threadId && row\.rootId && seenRoots\.has\(row\.rootId\)\) \? \{ \.\.\.row, unread: 0 \} : row/);
  assert.match(index, /const keep = openRoot && had\.has\(openRoot\) \? \[openRoot\] : \[\];/, 'a reply that lands later is new again');
});

// #6160 (2 Nov 2026): In progress and Waiting were two sections inside the
// Needs you card, under a line each, so on a busy account that card of
// to-dos ran on long past what needed you. They are one quieter card of
// their own now, between Needs you and Live this week, drawn as that is.
test('#6160: In progress is a card of its own between Needs you and Done, every row ending in its quiet state', () => {
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
    hero: null, ready: true, rows: [], owed: 0,
    progress: [], waiting: [], live: [], openRow() {}, openThread() {}, ...extra,
  });
  const html = renderComponent(LISTS, 'AiLists', props({ progress, waiting, live }));

  const open = html.indexOf('data-ai-sheet="open"');
  const busy = html.indexOf('data-ai-sheet="busy"');
  const liveAt = html.indexOf('data-ai-sheet="live"');
  assert.ok(open >= 0 && busy > open && liveAt > busy, 'a card between Needs you and Done');

  // Needs you's card ends where your to-dos end: none of In progress's rows.
  const openSheet = html.slice(open, busy);
  assert.doesNotMatch(openSheet, /data-ai-list="(?:next|up)"/, 'the two sections are gone from Needs you');
  assert.doesNotMatch(openSheet, /data-ai-line="going_live"/);
  assert.match(openSheet, /data-ai-list="work"[^>]*><div class="[^"]*" data-ai-band="">/, 'Needs you keeps its own band');

  // 24 Nov 2026 (the three bands): In progress, a card of its own: its
  // strip, a count of everything in it (work under way and waiting
  // together, the rows nobody is moving among them), and rows that end in a
  // quiet grey state.
  const busySheet = html.slice(busy, liveAt);
  assert.match(busySheet, /data-ai-list="busy"><div class="[^"]*" data-ai-band="">/);
  assert.match(busySheet, new RegExp(message('messages:ai.band.progressCount', { count: 8 })));
  assert.match(busySheet, /data-ai-band-count="">8</, 'the count in the strip');
  assert.equal((busySheet.match(/data-ai-band=""/g) || []).length, 1, 'one strip');
  assert.equal((busySheet.match(/data-ai-row-end="state"/g) || []).length, 8, 'every row ends in its state');
  assert.doesNotMatch(busySheet, /data-ai-row-end="act"/, 'none asks anything of you');
  // One list, no project groups: its first five, then Show 3 more.
  assert.doesNotMatch(busySheet, /data-ai-group=|data-ai-still/);
  assert.match(busySheet, new RegExp(message('messages:ai.work.showMore', { count: 3 })));
  assert.match(busySheet, /data-ai-group-rest=""/);

  // Nothing under way or waiting: the band stays, as all three always do,
  // and says so in one line.
  const empty = renderComponent(LISTS, 'AiLists', props());
  assert.match(empty, /data-ai-sheet="busy"[\s\S]*?data-ai-list="busy"/);
  assert.match(empty, new RegExp(message('messages:ai.band.progressEmpty')));
});

// #6680 (15 Nov 2026): #6153 folded a design thread filed as a request into
// that request's row once the request had one. But the row a person had could
// be a vote in Needs you, which opens the request's page, and the thread had
// no way in. The thread keeps its own "Only you" row now, beside the
// request's, saying where it went; the request's row may still open it.
test('#6680: a design thread filed as (or posted on) a request keeps its own row in Needs you, beside the request\'s', () => {
  const { needsYou, inProgress, upNext, liveThisWeek, filedKey, shortWords } = loadTsx(MODEL);
  const ear = { slug: 'ear-trainer', name: 'Ear Trainer', icon_url: null, icon_emoji: null };
  const design = (rootId, extra = {}) => ({ rootId, title: 'Can you first render the main screen?', kind: 'design', app: ear, at: null, ...extra });
  const request = (threadId, number, what, extra = {}) => thread(threadId, number, what, {
    app: ear, title: `Design: Ear Trainer ${number}`, href: `#app/ear-trainer/dev/issues/${number}`, ...extra,
  });
  const building = request(40, 14, 'building', { group: 'next', by: 'bot' });
  const work = { private: [design(731, { state: 'filed', resultRef: 14 })], needs: [], next: [building], waiting: [], live: [] };

  // The thread keeps its own row, saying where it went, and the request keeps its.
  assert.deepEqual(needsYou([], work).map((r) => [r.key, r.rootId]), [['private:731', 731]]);
  assert.equal(words(needsYou([], work)[0].sub), 'Only you · Ear Trainer · Filed as #14');
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

  // Waiting and Live this week carry the request's thread; the thread stays listed too.
  const later = {
    private: [design(734, { state: 'filed', resultRef: 15 }), design(735, { state: 'posted', resultRef: 16 })],
    needs: [], next: [], waiting: [request(41, 15, 'vote', { myVote: 'yes' })], live: [request(42, 16, 'live', { group: 'live' })],
  };
  assert.deepEqual(needsYou([], later).map((r) => [r.key, r.rootId]), [['private:734', 734], ['private:735', 735]]);
  assert.equal(words(needsYou([], later)[1].sub), 'Only you · Ear Trainer · Posted on #16');
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
  // A vote you owe on its change is the feed's row, by the request's number; the thread is still its own row too.
  const owed = [{ kind: 'proposal', id: 12229, number: 330, title: 'Ear Trainer home', app: ear, request: { number: 14 } }];
  assert.deepEqual(needsYou(owed, work).map((r) => r.key), ['need:proposal:12229', 'private:731']);
  assert.equal(words(needsYou(owed, work)[1].sub), 'Only you · Ear Trainer · Filed as #14');
  assert.deepEqual(inProgress(owed, work), []);
  // Two threads filed as one request: both are listed; the request's row opens the newest.
  const twice = { ...work, private: [design(737, { state: 'posted', resultRef: 14 }), design(731, { state: 'filed', resultRef: 14 })] };
  assert.deepEqual(needsYou([], twice).map((r) => r.key), ['private:737', 'private:731']);
  assert.equal(inProgress([], twice)[0].rootId, 737);
  assert.equal(filedKey(design(738, { state: 'filed', resultRef: 14, app: null })), null, 'a thread in no project is no request\'s');
  assert.equal(filedKey(design(738, { state: 'dropped', resultRef: 14 })), null);
  assert.equal(filedKey(design(738, { state: 'filed', resultRef: 14 })), 'ear-trainer#14');

  // The rows are lit while they are in the column, and the private row is drawn
  // beside the request's own, saying where it went.
  const { renderComponent } = require('./lib/render-tsx');
  const html = renderComponent('frontend/src/features/ai/lists.tsx', 'AiLists', {
    hero: null, lit: 'private:731', ready: true, rows: [], owed: 0,
    progress: [row], waiting: [], live: [], openRow() {}, openThread() {},
  });
  assert.match(html, /data-ai-line="building" data-ai-lit="" aria-current="true">[\s\S]*?Design: Ear Trainer 14/);
  assert.doesNotMatch(html, /data-ai-line="private"/);
  assert.equal((html.match(/data-ai-lit=""/g) || []).length, 1);

  const both = renderComponent('frontend/src/features/ai/lists.tsx', 'AiLists', {
    hero: null, lit: null, ready: true, rows: needsYou(owed, work), owed: 1,
    progress: inProgress([], work), waiting: [], live: [], openRow() {}, openThread() {},
  });
  assert.match(both, /title="Only you · Ear Trainer · Filed as #14"[^>]*data-ai-line="private"/);
  assert.match(both, /data-ai-line="building"[\s\S]*?Design: Ear Trainer 14/);

  // Homeroom bot's own my_work answer (services/ai-work.js listsOf) still
  // names the request alone; #6680 changes the tab's rows, not this answer.
  const aiWork = require('../src/services/ai-work');
  const lists = aiWork.listsOf([], work, { botUsername: 'homeroom_bot' });
  assert.deepEqual(lists.needsYou, [], 'no private thread in the bot\'s own answer');
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

  // The row in Done (24 Nov 2026): the title, the hover text, and at its end
  // the word History says for a thread marked done, with no tick; it opens
  // the thread, and is lit while that is in the column.
  const { renderComponent } = require('./lib/render-tsx');
  const solo = { rootId: 806, title: 'An app for our garden plot rota', kind: 'idea', app: null, at: null, state: 'done', doneAt: '2026-11-02T12:00:00Z' };
  const html = renderComponent('frontend/src/features/ai/lists.tsx', 'AiLists', {
    hero: null, lit: 'private:801', ready: true, rows: [], owed: 0,
    progress: [], waiting: [], live: liveThisWeek({ ...work, private: [...work.private, solo] }, now), openRow() {}, openThread() {},
  });
  const doneSheet = html.slice(html.indexOf('data-ai-sheet="live"'));
  assert.match(doneSheet, /Closed 801/);
  assert.match(doneSheet, /Garden club · Private thread · Closed/, 'its project, in front of "Private thread · Closed"');
  assert.match(doneSheet, /data-ai-line="closed" data-ai-lit="" aria-current="true"/, 'lit while its thread is in the column');
  const rowOf = (title) => doneSheet.slice(doneSheet.lastIndexOf('<button', doneSheet.indexOf(title)), doneSheet.indexOf('</button>', doneSheet.indexOf(title)));
  assert.match(rowOf('Closed 801'), new RegExp(`data-ai-row-end="word">${message('messages:ai.history.done')}<`), 'History\'s word');
  assert.doesNotMatch(rowOf('Closed 801'), /data-ai-row-end="tick"/, 'and no tick: it did not go live');
  assert.match(rowOf('Closed 801'), /data-ai-line-number="">Only you</, 'a private thread is Only you where a number would be');
  assert.match(rowOf('An app for our garden plot rota'), /M12 15v2m-6 4h12/, 'one in no project wears the lock for its tile');
  assert.match(rowOf('An app for our garden plot rota'), />Only you</, 'and Only you for its project');
});

test('the column from 768px: one thread, or a new chat, alone under its own head; a page the panel holds gives the lists back when it closes', () => {
  const src = read('frontend/src/features/ai/index.tsx');
  assert.match(src, /const WIDE = '\(min-width: 768px\)';/);
  // No bar of the column's own: a thread and a new chat bring their heads.
  assert.doesNotMatch(src, /ai-main-head|data-ai-main-head|data-ai-main-close|ai-main-title/);
  assert.match(src, /data-ai-column=\{columnOpen && threadUp \? \(blank \? 'new' : 'thread'\) : undefined\}/);
  // The column is a thread, a new chat or a page: nothing else, so nothing
  // is open beside the lists until one of them is asked for.
  assert.match(src, /: panelRoute \? \{ at: 'page', route: panelRoute \}\s+: blank \? \{ at: 'new' \}\s+: openRoot \? \{ at: 'thread', rootId: openRoot \} : null;/);
  assert.match(src, /: phone \? \(level === 1 \? \(openRoot \? \{ at: 'thread', rootId: openRoot \} : blank \? \{ at: 'new' \} : null\) : null\)/);
  // A thread asked for: the panel gives the column back, a new chat goes.
  // 1 Nov 2026 (C1): and a design's preview goes, unless it is that thread's.
  assert.match(src, /const showAt = \(next: BotAt\) => \{\s+if \(!next\.threadRootId\) return;\s+sidePanel\(\)\?\.close\?\.\(\);\s+closeNewThread\(\);\s+if \(!detail \|\| detail\.kind === 'design'\) \{\s+if \(next\.threadRootId !== detail\?\.ref\.rootId\) putAway\(\);\s+\}\s+setAt\(\{ \.\.\.next \}\);\s+(?:\/\/[^\n]*\n\s+)*if \(botId\) embed\(botId, next, \{ threadsOnly: true \}\);\s+if \(phone\) setLevel\(1\);\s+\};/);
  // Mobile 04: openPage says whether the column took the page, so Reply can
  // hand its message to the column's own document.
  assert.match(src, /openPage\(row\.href, row\.app, row\.title, aboutRow\(row\)\)/);
  assert.match(src, /const took = openPublic\(href, app, title\);\s+if \(took\) underPanel\(\);\s+return took;/);
  // 3 Nov 2026: the address is the column's, written by one effect (#6215).
  assert.match(src, /const underPanel = \(\) => \{\s+closeNewThread\(\);\s+if \(openRoot\) closeThread\(\);\s+\};/);
  // The panel takes a page beside this page from 768px too.
  const controller = read('frontend/src/features/side-panel/controller.ts');
  assert.match(controller, /export const BESIDE_AI_QUERY = '\(min-width: 768px\)';/);
  assert.match(controller, /return window\.matchMedia\(BESIDE_AI_QUERY\)\.matches;/);
  const css = read('public/css/app.css');
  assert.match(css, /@media \(max-width: 1023\.98px\) \{[^}]*?\*\/\s+body:not\(:has\(#ai-screen:not\(\.hidden\)\)\) #platform-side-panel \{\s+display: none;\s+\}\s+\}\s+@media \(max-width: 767\.98px\) \{\s+#platform-side-panel \{\s+display: none;\s+\}\s+\}/);
  assert.match(css, /@media \(max-width: 1023\.98px\) \{\s+body:has\(#ai-screen:not\(\.hidden\)\) \{ --ai-list-min: 280px; \}\s+\}/);
  assert.doesNotMatch(css, /\.ai-main-head|data-main-chat/, 'Main Chat\'s head and its hidden stream went with it');
});

test('the tab\'s bare address closes what is open beside the lists (#6425)', () => {
  // Pressing the tab, or Back to `#homeroom-bot`, asks the page to close the
  // column; a link to a thread or an item still opens it.
  const app = read('public/js/app.js');
  assert.match(app, /if \(parts\.length === 1\) \{\s+window\.UsernodeReact\?\.ai\?\.closeColumn\?\.\(\);\s+\}/);
  const door = read('frontend/src/features/ai/door.ts');
  // Except the second pass of a link to a new chat, whose own address the
  // page has since replaced with the bare tab's (tests/ai-where.test.js).
  assert.match(door, /export function askBotClose\(\): void \{\s+if \(asked\?\.fresh && typeof window !== 'undefined'\s+&& isNewChatEcho\([^\n]+\)\) return;\s+seq \+= 1;\s+asked = \{ at: null, item: null, close: true, seq \};/);
  assert.match(door, /closeColumn: askBotClose/);
  const src = read('frontend/src/features/ai/index.tsx');
  assert.match(src, /if \(ask\.close\) closeColumn\(\);/);
  assert.match(src, /if \(ask\.item\) openItem\(ask\.item\);\s+else if \(ask\.at\) showAt\(ask\.at\);/);
});

test('a thread opens on this page: beside the list in its column, or on its page with a way back here', () => {
  const src = read('frontend/src/features/ai/index.tsx');
  assert.match(src, /<aside\s+id="ai-main-pane"\s+ref=\{mainRef\}\s+className="ai-main-pane"\s+data-ai-main=""/);
  // The column has no name of its own (it was Main Chat's): a thread says
  // "Only you can see this thread" in its own head.
  assert.doesNotMatch(src, /aria-labelledby|messages:ai\.main\.|messages:store\.header\.main/);
  assert.throws(() => message('messages:ai.main.sub'));
  assert.equal(message('messages:ai.thread.sub'), 'Only you can see this thread');
  // The panel takes it wherever it can (a wide window), with the row's project and title; its page otherwise.
  assert.match(src, /if \(sidePanel\(\)\?\.take\?\.\(href\.replace\(\/\^#\/, ''\), \{ place: app, label \}\)\) return true;/);
  assert.match(src, /if \(isTopicHref\(href\)\) improve\(\)\?\.enterTopicFrom\?\.\(BOT_PAGE\);\s+go\(href\);/,
    'a topic page opened from here goes back here');
  assert.match(src, /const BOT_PAGE = BOT_TAB;/);
  assert.equal(loadTsx('frontend/src/features/ai/door.ts').BOT_TAB, '#homeroom-bot');
  // #6153: a request filed from a private thread opens that thread first.
  assert.match(src, /const openThread = \(th: AiThread\) => \{(\s+\/\/[^\n]*)*\s+seeOpened\(openedThread\(th\)\);\s+markThreadRead\(th\.threadId, th\.app, th\.rootId\);(\s+\/\/[^\n]*)*\s+if \(th\.rootId\) \{\s+openPrivate\(th\.rootId\);\s+return;\s+\}\s+openPage\(th\.href, th\.app, th\.title, aboutRow\(th\)\);/,
    'In progress, Waiting and Live this week');
  assert.match(src, /if \(openPage\(row\.href, row\.app, row\.title, aboutRow\(row\)\) && messageId && slug\) sidePanel\(\)\?\.revealMessage\?\.\(slug, messageId\);\s+\};/, 'and Needs you');
  const { isTopicHref } = loadTsx(MODEL);
  assert.equal(isTopicHref('#app/garden/dev/issues/12'), true);
  assert.equal(isTopicHref('#app/garden/dev/changes/12'), true);
  assert.equal(isTopicHref('#app/garden/dev/changes/12/987'), true, '#6718: a change link carries its own id');
  assert.equal(isTopicHref('#app/garden/dev/governance/3'), true);
  assert.equal(isTopicHref('#app/garden/workshop'), false, 'a Workshop is no topic: the origin would wait for the next one');
  // A private thread is the column's: the panel gives its place back first (showAt).
  assert.match(src, /const openPrivate = \(rootId: number\) => \{\s+const next = \{ threadRootId: rootId, focusMessageId: null \};[\s\S]{0,160}showAt\(next\);\s+\};/);
  assert.match(src, /const openRow = \(row: WorkRow\) => \{\s+seeOpened\(openedNeed\(row\)\);\s+markThreadRead\(row\.threadId, row\.app, row\.rootId\);\s+if \(row\.rootId\) \{\s+openPrivate\(row\.rootId\);\s+return;\s+\}/);
  // The panel may stand beside the AI tab's page, and stays while it is up.
  const controller = read('frontend/src/features/side-panel/controller.ts');
  // 18 Nov 2026: only there; it no longer stands beside a running app.
  assert.match(controller, /if \(typeof A\._isScreenVisible !== 'function' \|\| !A\._isScreenVisible\('ai-screen'\)\) return false;/);
  assert.match(read('public/js/app.js'), /appPresence\?\.\(screen === 'ai-screen' && !App\.chromeless\)/);
  // Opened from here on its page, it is still this tab's.
  const app = read('public/js/app.js');
  assert.match(app, /_isBotTopic\(\) \{\s+if \(!\(App\.currentTab === 'dev' && App\.currentSubTab === 'topic'\)\) return false;\s+const origin = window\.Improve\?\.topicOrigin\?\.\(\);/);
  assert.match(app, /\(App\._isBotTopic\(\) \? 'ai' : 'workshop'\)/, 'it keeps Homeroom bot lit');
});

test('on a phone the list and one thread (or a new chat) are one drawer, as Messages\' are; a request opens on its page', () => {
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
  // Only threads: no page in a frame (Evan, 30 Oct: "the Messages approach").
  assert.ok(!drawer.includes('<iframe'), 'a request is never drawn in the drawer');
  assert.match(src, /setAt\(\{ \.\.\.next \}\);\s+(?:\/\/[^\n]*\n\s+)*if \(botId\) embed\(botId, next, \{ threadsOnly: true \}\);\s+if \(phone\) setLevel\(1\);/, 'a row slides the column in, at it');
  assert.match(src, /onClick=\{\(e\) => \{ if \(phone\) \{ e\.preventDefault\(\); openNewChat\(\); \} \}\}/, 'and the Ask bar slides a new chat in');
  // One header: the platform's, which names the tab; a thread draws its own head.
  // One look (25 Nov 2026): a new chat in the pane is named by that header (./new-chat-bar.ts).
  assert.ok(!drawer.includes('ai-drawer-head'));
  assert.match(drawer, /<NewChatInBar\.Provider value>\s+<EmbeddedConversation conversationId=\{botId\} active=\{active\} at=\{at\} threadsOnly onBack=\{onBack\} \/>\s+<\/NewChatInBar\.Provider>/);
  assert.match(src, /canOpen=\{threadUp\}\s+pane=\{<ThreadPane botId=\{botId\} active=\{visible\} at=\{at\} onBack=\{toList\} \/>\}/);
  assert.match(src, /data-ai-drawer=\{phone \? level : undefined\}/);
  assert.match(drawer, /const PHONE_QUERY = '\(max-width: 767\.98px\)';/);
});

test('on a phone the list is always the whole screen, and its second level is a thread or a new chat, never empty (14 Nov 2026)', () => {
  const drawer = read('frontend/src/features/ai/phone-drawer.tsx');
  const src = read('frontend/src/features/ai/index.tsx');
  assert.match(drawer, /export const FULL_AT: readonly \[number, number\] = \[0, 1\];/, 'the column rests a whole screen to the right');
  assert.match(drawer, /const at = FULL_AT;/);
  assert.ok(!drawer.includes('OPENED_KEY'), 'no per-device switch into a drawer that peeks');
  assert.match(drawer, /const offset = drag \?\? at\[level\];/, 'rest, drag and landing all read the one table');
  // One look (25 Nov 2026): the bar's words follow the pan and settle where it lands.
  assert.match(drawer, /const lands = landingIn\(at, p\.from, now, \(e\.clientX - p\.x\) \* dirSign\(\)\) as 0 \| 1;\s+onPan\?\.\(null, lands\);\s+onLevel\(lands\);/);
  // There is no Main Chat to its right: with no thread and no new chat the
  // list does not pan toward an empty level, and the page slides back to the
  // list once the thread or the new chat closes.
  assert.match(drawer, /if \(level === 0 && !canOpen\) return;/);
  assert.match(src, /if \(phone && level === 1 && !threadUp && !at\?\.threadRootId\) setLevel\(0\);/, 'a thread asked for before the chat is known is on its way, not gone');
  // The platform header is the tab's plain one at both levels: the header's
  // "Main Chat" and its arrow went with Main Chat, and so did their store.
  assert.doesNotMatch(src, /publishBotDrawer|registerBotBack|bot-drawer/);
  assert.doesNotMatch(drawer, /botDepth|bot-drawer/);
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'frontend/src/features/nav-drawer/bot-drawer.ts')));
  const header = read('frontend/src/features/nav-drawer/header-drawer.tsx');
  assert.match(header, /return on \? 'communities' : messages \? 'messages' : null;/);
  assert.doesNotMatch(header, /mode === 'bot'|toBot/);
  const css = read('public/css/app.css');
  assert.match(css, /\.ai-drawer:not\(\[data-peek\]\) \.ai-drawer-list \{ width: 100%; \}/);
  assert.match(css, /\.ai-drawer:not\(\[data-peek\]\) \.ai-drawer-thread \{ inset-inline-start: 100%; \}/);
  assert.throws(() => message('core:header.drawer.toBot'));
  assert.equal(message('messages:ai.drawer.back'), 'Back to the list', 'a thread\'s own arrow');
});

test('what a row opened in the column rides along into a new chat\'s box, and nowhere else', () => {
  const src = read('frontend/src/features/ai/index.tsx');
  // #6212 (3 Nov 2026) attached it to Main Chat's box as the column moved.
  // 14 Nov 2026: there is no Main Chat. The page keeps what the row opened
  // and hands it to New chat, which draws it as a chip in its own box.
  assert.doesNotMatch(src, /attachmentFor|messages-object-selected|messages-object-cleared/);
  assert.match(src, /opened\.current = route \? \{ route, about \} : null;/);
  assert.match(src, /const about = route \? \(opened\.current\?\.route === route \? opened\.current\.about : null\) \|\| aboutRoute\(route\) : null;\s+if \(about\) return \{ project: about\.appSlug, builder: 'homeroom', object: about \};/);
  assert.doesNotMatch(read('frontend/src/features/ai/column.ts'), /attachmentFor|ColumnHow/);
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
  // The page starts on the lists alone; a row, New chat or a link opens the
  // column, and its own × (a thread's, the new chat's, the panel's) or the
  // tab pressed puts it away again.
  assert.doesNotMatch(index, /mainOpen|setMainOpen|at: 'main'/, 'no Main Chat to stand open beside the lists');
  assert.match(index, /const columnOpen = docked && !!column;/);
  assert.match(index, /const closeColumn = \(\) => \{\s+if \(phone\) \{ setLevel\(0\); setAt\(null\); return; \}\s+if \(!docked\) return;\s+sidePanel\(\)\?\.close\?\.\(\);\s+closeNewThread\(\);\s+if \(openRoot\) closeThread\(\);\s+putAway\(\);\s+setAt\(null\);\s+\};/,
    'on a phone the tab pressed slides the list back');
  assert.doesNotMatch(index, /backTo/, 'no chip to name what the page goes back to');
  assert.match(index, /data-ai-open=\{columnOpen \? '' : undefined\}/);
  assert.doesNotMatch(index, /data-ai-main-close/);
  assert.throws(() => message('messages:ai.main.close'));
  const controller = read('frontend/src/features/side-panel/controller.ts');
  assert.match(controller, /export const BESIDE_AI_CLASS = 'side-panel-beside-ai';/);
  assert.match(controller, /classList\.toggle\(BESIDE_AI_CLASS, isBesideAi\(\)\)/);
  assert.match(controller, /const \{ place = null, label = null \} = given \|\| \{\};/, 'the project and the title are this document\'s to draw');
  const css = read('public/css/app.css');
  // 18 Nov 2026: the panel's own controls from beside a running app (Back,
  // the title, Expand, Close) are gone with that panel, not just hidden here;
  // its left edge stays, the handle Main's edge is too.
  assert.doesNotMatch(css, /#side-panel-(back|title|expand|close)\b/);
  assert.match(read('frontend/src/features/side-panel/side-panel.tsx'), /<SidePanelDivider/);
  assert.match(css, /body:has\(#ai-screen:not\(\.hidden\)\) \.side-panel :is\(\.side-panel-ai-close, \.side-panel-place, \.side-panel-more\) \{ display: inline-flex; \}/);
  assert.match(css, /\.side-panel-head > :is\(\.side-panel-ai-close, \.side-panel-place, \.side-panel-more\) \{ display: none; \}/, 'and nowhere else');
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
  assert.match(css, new RegExp(`${scope} \\.dev-request,\\n#ai-screen \\.dev-private-thread \\{\\s*/\\*[^*]*\\*/\\s*--thread-gutter: 12px;\\s*max-width: none;\\s*margin-inline: 0;\\s*padding-inline: 0;\\s*\\}`),
    'the page drops its 780px cap and centred 12px side margins');
  assert.match(css, new RegExp(`${scope} \\.dev-request-sheet,\\n#ai-screen \\.dev-private-thread > \\.dev-request-sheet \\{[^}]*background: transparent;[^}]*backdrop-filter: none;`),
    'the sheet takes the column\'s surface instead of painting its own fill and frost');
  assert.match(css, new RegExp(`${scope} \\.dev-request-sheet,\\n#ai-screen \\.dev-private-thread > \\.dev-request-sheet \\{[^}]*box-shadow: none;`),
    'and lifts no shadow off it');
  assert.match(css, new RegExp(`${scope} :is\\(\\.dev-request-bar, \\.dev-request-scroll\\),\\n#ai-screen \\.dev-private-thread > \\.dev-request-sheet > :is\\(\\.dev-request-bar, \\.dev-request-scroll\\) \\{\\s*padding-inline: var\\(--thread-gutter\\);\\s*\\}`),
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
  assert.match(css, /--dc-sheet-solid: #fffff5;/, 'light: the list\'s card colour');
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

test('the column is held inside the window, and the panel takes its place at its width', () => {
  const css = read('public/css/app.css');
  // A width chosen beside an app on a wide monitor must not run Main under
  // the rail; with none chosen, Main takes the room the list does not need
  // (30 Oct 2026). Since 3 Nov 2026 that is all of it: the 720px cap is gone
  // (a 1720px window left a band between the list and Main), the 400px floor
  // stays, and Main reads its own chosen width, not the side panel's. The
  // room is the page's usable box, the window less the rail and the Duo's
  // column, declared once on body (1 Nov 2026; tests/usable-box.test.js pins
  // how it is made).
  assert.match(css, /body:has\(#ai-screen:not\(\.hidden\)\) \{\s+--ai-room: var\(--platform-usable-w\);\s+--ai-list-min: var\(--list-pane-w\);\s+--ai-main-auto: max\(400px, calc\(var\(--ai-room\) - var\(--list-pane-w\)\)\);\s+--ai-main-w: max\(var\(--ai-main-floor, 320px\), min\(var\(--ai-main-chosen-w, var\(--ai-main-auto\)\), calc\(var\(--ai-room\) - var\(--ai-list-min\)\)\)\);\s+\}/);
  // 24 Nov 2026: the thread takes the spare room. Beside the lists the
  // column is never narrower than the room less the list's 42rem, so the
  // list never floats between two empty bands; a preview's columns, the
  // frame's looks and a phone keep the column's own 320px.
  assert.match(css, /@media \(min-width: 768px\) \{\s+body:has\(#ai-screen:not\(\.hidden\):not\(\[data-ai-preview\]\)\) \{\s+--ai-list-max: 42rem;\s+--ai-main-floor: max\(320px, calc\(var\(--ai-room\) - var\(--ai-list-max\)\)\);\s+\}\s+\}/,
    'the column is floored at the room less the list\'s own measure, beside the lists only');
  // 9 Nov 2026 (#6495): the bot tab's list is the Messages inbox's list while
  // something is open beside it, so the two pages share one measure and the
  // open column gets the room the list lets go. Defined once, read by both.
  // #6520: the bot tab's list then fills the room beside the open column, up
  // to the page's own 672px and centred in it, rather than staying the
  // inbox's 22rem against the rail with bare background beside it.
  assert.match(css, /:root \{ --list-pane-w: 22rem; \}/, 'one list width, defined once');
  // Desktop polish 09 (24 Nov 2026): Messages' list can be dragged to a width
  // of its own, `--messages-list-chosen-w`; with none chosen it reads this
  // measure, and the bot tab's list is not touched.
  assert.match(css, /\.messages-list-pane \{\s+position: relative;\s+flex: 0 0 var\(--messages-list-chosen-w, var\(--list-pane-w\)\);\s+width: var\(--messages-list-chosen-w, var\(--list-pane-w\)\);/, 'the inbox reads it');
  assert.match(css, /#ai-screen\[data-ai-docked\]\[data-ai-open\] \.ai-screen-body \{\s+width: 100%;\s+max-width: var\(--ai-list-max, 42rem\);\s+margin-inline: auto;\s+\}/,
    'and the bot tab\'s list fills the room beside the open column, up to 672px, centred in it');
  assert.doesNotMatch(css, /--side-panel-chosen-w/, 'one width no longer sizes both columns');
  // A wider Main holds its words to the 720px it used to be, so plan cards
  // and replies keep a readable line; below that the gutter is the part's own.
  assert.match(css, /#ai-screen \.ai-main-pane \.messages-layout\[data-bot-threads\] :is\(\.chat-transcript, \.chat-status, \.chat-composer-bar\):not\(\.dev-request \*\) \{\s+padding-inline: max\(0px, calc\(\(100% - 720px\) \/ 2\)\);\s+\}/,
    'a thread\'s transcript, status line and composer are centred inside a wide column');
  assert.match(css, /#ai-screen \.ai-main-pane \.messages-layout\[data-bot-threads\] \.chat-composer-bar:not\(\.dev-request \*\) \{\s+padding-inline: max\(12px, calc\(\(100% - 720px\) \/ 2\)\);\s+\}/,
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
  // A thread alone in the column has its own head, which pads by the Duo's column (1 Nov 2026).
  // Phone review #70 (23 Nov 2026): and New chat's head, whose ✕ sat under the Wi-Fi ring held sideways.
  assert.match(css, /#ai-screen \.ai-main-pane \.messages-thread-header\[data-reply-head="alone"\],\n[^\n]*\n[^\n]*\n#ai-screen \.ai-main-pane \[data-bot-new-thread-pane\] > \.messages-thread-header \{\s+padding-inline-end: calc\(16px \+ var\(--ai-edge, 0px\)\);\s+\}/,
    'a thread\'s title and New chat\'s ✕ stop beside the column, not under the clock');
  assert.match(read('frontend/src/features/messages/index.tsx'), /<header className="messages-thread-header" data-reply-head=\{alone \? 'alone' : undefined\}>/);
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
  assert.match(src, /<aside\s+id="ai-main-pane"\s+ref=\{mainRef\}\s+className="ai-main-pane"[^>]*>\s+<SidePanelDivider\s+panelRef=\{mainRef\}\s+shown=\{columnOpen\}\s+id="ai-main-divider"\s+controls="ai-main-pane"\s+widthKey=\{threadWidthKey\}\s+probe=\{threeFits \? threadProbe : undefined\}\s+watch=\{threeFits \? previewRef : undefined\}\s+collapsed=\{oneUp\}\s+onCollapse=\{snaps \? \(\) => setListClosed\(true\) : undefined\}\s+onRestore=\{snaps \? \(\) => setListClosed\(false\) : undefined\}\s+\/>/,
    'and the edge is the way the list hides and comes back (#6963)');
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
  const mobileGutter = /@media \(max-width: 1023\.98px\) \{\s*body:has\(#ai-screen:not\(\.hidden\):not\(\[data-ai-list-closed\]\)\) :is\(#side-panel-divider, #ai-main-divider\) \{\s*--divider-at: calc\(var\(--ai-main-w\) \+ var\(--ai-edge, 0px\) \+ 8px\);\s*\}\s*\}/;
  assert.match(css, mobileGutter, 'below 1024px the handle sits halfway across the gap');
  assert.doesNotMatch(css.replace(mobileGutter, ''), /--divider-at:[^;]*\+ 8px/,
    'no other edge sits in the gutter any more');
  // The preview's own divider, not drawn where the preview is the whole screen.
  assert.match(src, /\{layout === 'full' \? null : \(\s+<SidePanelDivider\s+panelRef=\{previewRef\}\s+shown=\{columnOpen\}\s+id="ai-preview-divider"\s+controls="ai-preview-pane"\s+widthKey=\{AI_PREVIEW_WIDTH_KEY\}\s+probe=\{previewProbe\}/);
  // The thread's edge keeps the three columns' width, bound and preview while
  // they fit, the list shown or put away (24 Nov 2026).
  assert.match(src, /const threeFits = previewHere && fits === 'three';/);
  assert.match(src, /const fits = detailLayout\('bot', \{ phone, wide: three \}\);/);
  assert.match(src, /const endAt = inlineStartOf\(box\);/, 'the thread is measured to where the preview begins');
  assert.match(src, /neighbourMin: listMin \+ Math\.max\(0, roomEnd - endAt\), endAt/,
    'and its bound keeps the preview as it is drawn, the room app.css leaves the thread');
  // That room keeps app.css's 480px list beside the preview, not the 22rem
  // `--ai-list-min` the probe reads: the handle stops where the thread is
  // drawn to stop, and the snap is measured from there.
  assert.match(src, /const THREE_LIST_MIN = 480;/);
  assert.match(src, /const listMin = Math\.max\(probe\.neighbourMin \?\? 0, THREE_LIST_MIN\);/);
  assert.match(css, /calc\(var\(--ai-room\) - 480px - var\(--ai-preview-w\)\)/, 'the 480px app.css holds the list to');
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
  assert.match(src, /slot: visible && threeFits && pageInColumn\s+\? \{ widthKey: AI_PREVIEW_COLUMN_WIDTH_KEY, probe: threadProbe, watch: previewRef \}\s+: null,/);
  // The panel reads it, and falls back to its own defaults with no slot.
  const panel = read('frontend/src/features/side-panel/side-panel.tsx');
  assert.match(panel, /const edges = useStoreState\(panelEdgeStore\);\s+const edge = edges\.slot;/);
  assert.match(panel, /<SidePanelDivider\s+panelRef=\{rootRef\}\s+shown=\{s\.open && !!s\.frameSrc\}\s+widthKey=\{edge\?\.widthKey\}\s+probe=\{edge\?\.probe\}\s+watch=\{edge\?\.watch\}\s+collapsed=\{snap\?\.collapsed\}\s+onCollapse=\{snap\?\.onCollapse\}\s+onRestore=\{snap\?\.onRestore\}\s+\/>/);
  // The prerender is the panel as it was: no slot until the page sets one.
  const { panelEdgeStore } = loadTsx('frontend/src/features/side-panel/edge-store.ts');
  assert.equal(panelEdgeStore.get().slot, null);
  assert.equal(panelEdgeStore.get().snap, null);
});

test('the tab says Homeroom bot: a wide seat on a phone, two lines in the Duo column', () => {
  assert.equal(message('core:tabs.ai'), 'Homeroom bot');
  const css = read('public/css/app.css');
  // Five seats, Home · Communities · Homeroom bot · Messages · You (the
  // Communities tab is back; One Home, #6361, had drawn four). The bot's
  // holds the longest word, so it is the widest; Communities next, then
  // Messages, so a lit Messages pill still clears the bot's name (overnight
  // audit M01).
  assert.match(css, /#platform-tabs \{ grid-template-columns: 1fr 1\.25fr 1\.4fr 1\.15fr 1fr; \}/,
    'Homeroom bot, third, takes the wide seat');
  assert.match(css, /#platform-tabs \{ grid-template-columns: 1fr 1\.2fr 1\.35fr 1\.15fr 1fr; \}/, 'a little less on the smallest phones');
  assert.match(css, /:is\(#platform-tab-workshop, #platform-tab-ai\) \.platform-tab-label \{\s+letter-spacing: -\.02em;\s+overflow: visible;\s+text-overflow: clip;\s+\}/,
    'tightened and let out of the cell rather than cut');
  // The Duo column draws icons only (18 Nov 2026), so the bot's name is not
  // set on two lines there any more: it is the tab's name, clipped.
  assert.doesNotMatch(css, /html\[data-side-strip\] #platform-tab-ai \.platform-tab-label \{/,
    'the Duo column: no words drawn, so no two-line name');
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
  // #6595: the page open in the column adds its own project to that set.
  // 11 Nov 2026: and a work_state push is drawn in place first (applyWorkState).
  assert.match(src, /useLiveLists\(\(\) => setMoved\(\(n\) => n \+ 1\), visible, \{ projects: shownProjects, botId \}, applyPush\);/);
  assert.match(src, /setWork\(\(now\) => applyWorkState\(now, null, push\)\.work\);\s+setNeeds\(\(now\) => applyWorkState\(null, now, push\)\.needs\);/);
  assert.match(live, /if \(isWorkStatePush\(event\)\) latest\.current\.apply\?\.\(event\);/);
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
// row and the address are read from it.
test('one column state: where each row goes, the row it lights and its address', () => {
  const column = loadTsx('frontend/src/features/ai/column.ts');
  const plain = (v) => JSON.parse(JSON.stringify(v));
  // Every row goes to its own place: a private thread, else its page (a ▷ plan row too).
  assert.deepEqual(plain(column.rowColumn({ rootId: 139, href: '#app/garden/dev/issues/4' })), { at: 'thread', rootId: 139 });
  assert.deepEqual(plain(column.rowColumn({ rootId: null, href: '#app/garden/dev/issues/410' })), { at: 'page', route: 'app/garden/dev/issues/410' });
  assert.equal(column.rowColumn({ rootId: null, href: null }), null);
  // A row is lit by the column it opens.
  assert.equal(column.rowKey({ href: '#app/garden/dev/issues/410' }), column.columnKey({ at: 'page', route: 'app/garden/dev/issues/410' }));
  assert.equal(column.columnKey({ at: 'thread', rootId: 7 }), 'private:7');
  assert.equal(column.columnKey({ at: 'new' }), 'new');
  assert.equal(column.columnKey(null), null);
  // The address names what is open (#6215); a reload reopens it.
  assert.equal(column.columnAddress({ at: 'new' }), '#homeroom-bot', 'a new chat is the tab itself: nothing is saved yet');
  assert.equal(column.columnAddress({ at: 'thread', rootId: 139 }), '#homeroom-bot/thread/139');
  assert.equal(column.columnAddress({ at: 'page', route: 'app/usernode-2d5619/dev/issues/6214' }), '#homeroom-bot/request/usernode-2d5619/6214');
  assert.equal(column.columnAddress({ at: 'page', route: 'app/garden/dev/changes/2151' }), '#homeroom-bot/change/garden/2151');
  assert.equal(column.columnAddress({ at: 'page', route: 'app/garden/dev/governance/7' }), '#homeroom-bot/decision/garden/7');
  assert.equal(column.columnAddress({ at: 'page', route: 'app/garden/workshop' }), '#homeroom-bot', 'a page that is no item is the tab');
  assert.equal(column.columnAddress(null), '#homeroom-bot', 'the lists alone, on a phone or a desktop');
  // 14 Nov 2026: there is no Main Chat for the column to be, and so no
  // attachment in its box to move as the column moves (#6212's attachmentFor).
  assert.equal(column.attachmentFor, undefined);
  assert.doesNotMatch(read('frontend/src/features/ai/column.ts'), /at: 'main'/);
  // The page reads it once; nothing else keeps a copy.
  const src = read('frontend/src/features/ai/index.tsx');
  assert.match(src, /: panelRoute \? \{ at: 'page', route: panelRoute \}/);
  // 5 Nov 2026: the column's address carries the filter the chips set
  // (./filter-address.ts), and the chips write it back in place: two writers,
  // the column's and the filter's, besides its definition. 24 Nov 2026
  // (#7103): Waiting on you writes its own address when it opens and the
  // bare tab's when All threads closes it. 25 Nov 2026 (#7157): In progress
  // is its sibling and does the same, one resting state a list.
  assert.match(src, /const base = href !== BOT_TAB \? href/);
  assert.match(src, /: waitingOpen \? waitingAddress\(\)/);
  assert.match(src, /: progressOpen \? progressAddress\(\)/);
  assert.match(src, /showAddress\(withFilter\(base, \{ projects: filterRef\.current\.picked, kind: filterRef\.current\.historyKind \}\)\);/);
  assert.match(src, /showAddress\(withFilter\(window\.location\.hash, \{ projects: next\.picked, kind: next\.historyKind \}\)\);/);
  assert.match(src, /showAddress\(waitingAddress\(picked\)\);/);
  assert.match(src, /showAddress\(progressAddress\(picked\)\);/);
  assert.match(src, /showAddress\(withFilter\('#homeroom-bot', \{ projects: picked \}\)\);/);
  assert.equal((src.match(/showAddress\(/g) || []).length, 7, 'the column\'s writer, the filter\'s, and Waiting on you\'s and In progress\'s open and close, besides its definition');
  assert.match(read('frontend/src/features/ai/lines.ts'), /lit: !!lit && rowKey\(row\) === lit,/);
  assert.match(read('frontend/src/features/ai/lines.ts'), /lit: !!lit && rowKey\(th\) === lit,/);
});

test('#6218: the row whose page is open beside the list is lit, and no other', () => {
  const { renderComponent } = require('./lib/render-tsx');
  const LISTS = 'frontend/src/features/ai/lists.tsx';
  const props = (extra = {}) => ({
    hero: null, ready: true, rows: [], owed: 0,
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
  // A new chat opened beside it carries the request the row opened, not the change.
  const { aboutRow } = loadTsx('frontend/src/features/ai/index.tsx');
  assert.deepEqual(JSON.parse(JSON.stringify(aboutRow(row))),
    { type: 'issue', appSlug: 'garden', issueNumber: 6215, title: 'Show the reason' });
});

test('an item in the bot page\'s column has an address of its own, and its own page as the fallback (#6215)', () => {
  const door = loadTsx('frontend/src/features/ai/door.ts');
  const plain = (v) => JSON.parse(JSON.stringify(v));
  assert.deepEqual(plain(door.botItemAt('#homeroom-bot/request/usernode-2d5619/6214')), { kind: 'request', slug: 'usernode-2d5619', number: 6214 });
  assert.deepEqual(plain(door.botItemAt('#ai/change/usernode-2d5619/2151')), { kind: 'change', slug: 'usernode-2d5619', number: 2151 });
  assert.equal(door.botItemAt('#homeroom-bot/thread/5'), null, 'a chat place is not an item');
  assert.equal(door.botItemRoute({ kind: 'decision', slug: 'garden', number: 7 }), 'app/garden/dev/governance/7');
  assert.equal(door.pageLinkFor('app/usernode-2d5619/dev/issues/6214'), '/app/usernode-2d5619/dev/issues/6214');
  // #6718: a change's address carries its own id after the number, and the
  // page link keeps it so Expand opens that change.
  assert.equal(door.pageLinkFor('app/usernode-2d5619/dev/changes/2151/4223'), '/app/usernode-2d5619/dev/changes/2151/4223');
  assert.deepEqual(plain(door.botItemFromRoute('app/usernode-2d5619/dev/changes/2151/4223')),
    { kind: 'change', slug: 'usernode-2d5619', number: 2151 },
    'the number the column names is the one people see');
  assert.equal(door.botTabAt('#homeroom-bot/request/usernode-2d5619/6214'), null);
  const src = read('frontend/src/features/ai/index.tsx');
  assert.match(src, /if \(sidePanel\(\)\?\.take\?\.\(route, \{ place: appFromLists\(item\.slug\), label: null \}\)\) \{ underPanel\(\); return; \}/);
  assert.match(src, /improve\(\)\?\.enterTopicFrom\?\.\(BOT_PAGE\);\s+window\.location\.replace\(`#\$\{route\}`\);/,
    'a replace, not a push, so Back does not bounce to it again');
  assert.match(read('frontend/src/features/ai/door.ts'), /openItem: \(hash: string\) => \{ const item = botItemAt\(hash\); if \(item\) askBotItem\(item\); \}/);
  // A request reopened from its address is what a new chat opened beside it carries.
  const { aboutRoute } = loadTsx('frontend/src/features/ai/index.tsx');
  assert.deepEqual(plain(aboutRoute('app/garden/dev/issues/12')), { type: 'issue', appSlug: 'garden', issueNumber: 12, title: null });
  assert.equal(aboutRoute('app/garden/dev/governance/3'), null);
});

// #6398 (6 Nov 2026, Evan: "offer a search icon here, next to the plus, to
// search through your threads"). A round search button beside New chat opens
// a box under the heading; every list narrows to the threads whose title,
// number ("6011" or "#6011") or project name contains what was typed, a
// section with no match folds away, and one short note says when nothing
// matched at all.
test('#6398: the search narrows every list by title, number or project, and says when nothing matches', () => {
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
    hero: null, ready: true, owed: 2,
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

  // No search: every row, nothing folded away.
  const plain = html({ query: '' });
  for (const title of ['make the migration', 'Dark mode', 'reuse image scan', 'Seed the garden', 'Ship the seed']) {
    assert.ok(plain.includes(title), title);
  }

  // A title keeps only the row that says it; the sections with no match fold away.
  const byTitle = html({ query: 'migration' });
  assert.match(byTitle, /make the migration job cheaper/);
  assert.doesNotMatch(byTitle, /Dark mode|reuse image scan|Seed the garden|Ship the seed/, 'only the matching row');
  assert.doesNotMatch(byTitle, /data-ai-list="busy"/, 'In progress has no match, so its card is gone');
  assert.doesNotMatch(byTitle, /data-ai-list="live"/, 'nor Done');
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

  // A match past a band's first few is drawn, not folded: with no search
  // the seventh row waits behind Show more, and with one it is on the page.
  const many = Array.from({ length: 7 }, (_, i) => need(`need:proposal:${i + 1}`, `Release note ${i + 1}`, app, 500 + i));
  const folded = renderComponent(LISTS, 'AiLists', { ...all, rows: many, progress: [], waiting: [], live: [], owed: 7 });
  assert.match(folded, /data-ai-group-rest=""/, 'the rest of a band folds away with no search');
  const matched = renderComponent(LISTS, 'AiLists', { ...all, rows: many, progress: [], waiting: [], live: [], owed: 7, query: 'release note' });
  assert.doesNotMatch(matched, /data-ai-group-rest=""/, 'every match shows, with no fold over it');
  assert.match(matched, /Release note 7/);

  // Nothing matches: one short note in place of every list. With no search
  // of the messages (this caller hands the lists none) it speaks of threads.
  const none = html({ query: 'zzz' });
  assert.match(none, /<div class="[^"]*" data-ai-search-empty=""><p class="[^"]*">No threads match “zzz”<\/p><\/div>/);
  assert.ok(none.includes(message('messages:ai.search.noneThreads', { query: 'zzz' })));
  assert.doesNotMatch(none, /data-ai-list="(?:work|busy|live|history|found)"/, 'every card folds away');

  // Before the lists are read, the skeleton stays and no note is shown.
  const loading = html({ query: 'zzz', ready: false });
  assert.match(loading, /data-ai-loading=""/);
  assert.doesNotMatch(loading, /data-ai-search-empty/);

  // The box (index.tsx; 24 Nov 2026, the three bands): always on the head
  // card's tools line, with the app's magnifying glass; what it says is what
  // the bands narrow to.
  const src = read('frontend/src/features/ai/index.tsx');
  assert.doesNotMatch(src, /data-ai-search-toggle/, 'no button opens it: it is there');
  assert.match(src, /const asked = query;/);
  assert.match(src, /search=\{searchField\}\s+query=\{asked\}/, 'the box\'s text is passed to the bands');
  const box = src.slice(src.indexOf('const searchField = ('), src.indexOf('</label>', src.indexOf('const searchField = (')));
  assert.match(box, /<SearchIcon className="h-4 w-4 shrink-0" aria-hidden="true" \/>/);
  assert.match(box, /placeholder=\{t\('messages:ai\.search\.placeholder'\)\}\s+aria-label=\{t\('messages:ai\.search\.label'\)\}/, 'named for what it does');
  assert.match(box, /data-ai-search=""/);
  assert.equal(message('messages:ai.search.placeholder'), 'Search threads…');
  // On a computer it names Ctrl+K (⌘K on a Mac), which puts the cursor in it
  // while the tab is showing (./search-shortcut.ts); never in the prerender.
  assert.match(box, /searchHint === 'none' \? null : \(\s+<kbd className="ai-search-key /);
  const key = loadTsx('frontend/src/features/ai/search-shortcut.ts');
  assert.equal(key.botSearchAnswer({ key: 'k', ctrlKey: true }, { showing: true, dialog: false, commentMode: false }), 'focus');
  assert.equal(key.botSearchAnswer({ key: 'k', metaKey: true }, { showing: true, dialog: false, commentMode: false }), 'focus');
  assert.equal(key.botSearchAnswer({ key: 'k', ctrlKey: true }, { showing: false, dialog: false, commentMode: false }), null, 'only while the tab shows');
  assert.equal(key.botSearchAnswer({ key: 'k', ctrlKey: true }, { showing: true, dialog: true, commentMode: false }), null, 'not over a dialog');
  assert.equal(key.botSearchAnswer({ key: 'k', ctrlKey: true, shiftKey: true }, { showing: true, dialog: false, commentMode: false }), null);
  assert.equal(key.botSearchAnswer({ key: 'k' }, { showing: true, dialog: false, commentMode: false }), null, 'a plain k is typing');
  assert.equal(key.botSearchAnswer({ key: 'k', ctrlKey: true, defaultPrevented: true }, { showing: true, dialog: false, commentMode: false }), null);
  assert.match(src, /installBotSearchShortcut\(\(\) => \(visible \? searchRef\.current : null\)\)/);
  assert.equal(message('messages:ai.search.label'), 'Search threads and messages');
  assert.equal(message('messages:ai.search.none', { query: 'releases' }), 'Nothing in your threads or messages matches “releases”');
  assert.equal(message('messages:ai.search.noneThreads', { query: 'releases' }), 'No threads match “releases”');
});

// 13 Nov 2026: a tester typed "improve" and was told no thread matched,
// although they had written "I want to improve my app." to the bot. The
// search also reads what was said in the person's chat with Homeroom bot
// and its threads (GET /api/ai/search, ./search.ts), and lists the messages
// that match under the threads that do, each a link to that message.
test('the search lists the messages that match under the threads, each a link to its message with the found words marked', () => {
  const { renderComponent } = require('./lib/render-tsx');
  const LISTS = 'frontend/src/features/ai/lists.tsx';
  const all = {
    hero: null, ready: true, owed: 0,
    rows: [], progress: [thread(3, 6011, 'building', { app, title: 'Improve the release notes', href: '#app/garden/dev/issues/6011' })],
    waiting: [], live: [], openRow() {}, openThread() {},
  };
  const year = new Date().getFullYear();
  const hit = (over) => ({
    messageId: 71, rootId: null, threadTitle: null, mine: true,
    snippet: 'I want to improve my app.', ranges: [[10, 17]], at: `${year}-11-03T12:00:00.000Z`, ...over,
  });
  const answered = (q, rows, more = false) => ({ q, rows, more, state: 'answered' });
  const html = (extra) => renderComponent(LISTS, 'AiLists', { ...all, ...extra });

  // Nothing of it without a search: the prerender, and the page at rest.
  const rest = html({ query: '', found: answered('improve', [hit()]) });
  assert.doesNotMatch(rest, /data-ai-list="found"|<mark/, 'no search, no found messages, whatever was answered before');

  // A thread and two messages match: the thread's card first, then the
  // messages' own card under its own heading, one row each.
  const found = answered('improve', [
    hit(),
    hit({ messageId: 88, rootId: 60, threadTitle: 'A calendar for the garden', mine: false, snippet: '…so we could improve it later', ranges: [[13, 20]] }),
  ]);
  const both = html({ query: 'improve', found });
  assert.ok(both.indexOf('data-ai-list="busy"') > 0 && both.indexOf('data-ai-list="busy"') < both.indexOf('data-ai-list="found"'), 'the messages come after the matching threads');
  assert.equal(message('messages:ai.search.messages', { count: 2 }), 'In your messages · 2');
  const card = both.slice(both.indexOf('data-ai-sheet="found"'));
  assert.match(card, /<h3 [^>]*>[\s\S]*?In your messages[\s\S]*?<span class="sr-only">In your messages · 2<\/span><\/h3>/, 'a band\'s strip, as the other cards wear (24 Nov 2026)');
  const rows = [...card.matchAll(/<a href="([^"]+)" class="([^"]*)" title="([^"]*)" aria-label="([^"]*)" data-ai-found="(chat|thread)">(.*?)<\/a>/g)];
  assert.equal(rows.length, 2, 'one row a message, each a real link');
  const [chat, inThread] = rows;
  // A thread: the thread at that message. One whose thread the answer does
  // not name (14 Nov 2026: every message is in one; an older answer) is the
  // message alone, and the tab asks the server which thread it is in.
  assert.equal(chat[1], '#homeroom-bot/m/71');
  assert.equal(chat[5], 'chat');
  assert.equal(inThread[1], '#homeroom-bot/thread/60/m/88');
  assert.equal(inThread[5], 'thread');
  // The found words are a <mark>, the rest plain text.
  assert.match(chat[6], /I want to <mark class="[^"]*">improve<\/mark> my app\./);
  assert.match(inThread[6], /…so we could <mark class="[^"]*">improve<\/mark> it later/);
  const mark = /<mark class="([^"]*)">/.exec(chat[6])[1];
  assert.match(mark, /bg-\[color:var\(--accent-tint\)\]/, 'the mark is tinted by a token, which follows the theme');
  assert.doesNotMatch(mark, /#[0-9a-f]{3,8}\b|yellow/i, 'no literal colour');
  // Where it is and its day, and the link's whole name.
  const day = new Date(`${year}-11-03T12:00:00.000Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  assert.equal(message('messages:ai.search.inChat'), 'Your chat with Homeroom bot');
  assert.ok(chat[6].includes('>Your chat with Homeroom bot<'), 'a message in the chat itself says so');
  assert.ok(inThread[6].includes('>A calendar for the garden<'), 'a message in a thread names the thread');
  assert.ok(chat[6].includes(`>${day}<`), 'its day');
  assert.equal(chat[4], `You: I want to improve my app. · Your chat with Homeroom bot · ${day}`);
  assert.equal(inThread[4], `Homeroom bot: …so we could improve it later · A calendar for the garden · ${day}`);
  assert.equal(chat[3], chat[4], 'the tooltip says the same');
  // The row is the list's own quiet one-line row, with a tap's height.
  const src = read(LISTS);
  assert.match(src, /function FoundRow[\s\S]*?className=\{FOUND_ROW\}/);
  assert.ok(chat[2].includes('min-h-[44px]') && chat[2].includes('md:min-h-[36px]'));
  assert.doesNotMatch(card, /data-ai-found-more/, 'nothing about more matches when these are all');

  // Only messages match: no thread card, no "nothing matches" note.
  const onlyMessages = html({ query: 'my app', found: answered('my app', [hit({ ranges: [[18, 24]] })]) });
  assert.doesNotMatch(onlyMessages, /data-ai-list="(?:work|busy|live|history)"/);
  assert.doesNotMatch(onlyMessages, /data-ai-search-empty/, 'a message matched, so the page does not say nothing did');
  assert.match(onlyMessages, /data-ai-list="found"/);

  // More matched than the rows sent: one line under them says so.
  const capped = html({ query: 'improve', found: answered('improve', [hit()], true) });
  assert.ok(capped.includes(`data-ai-found-more="">${message('messages:ai.search.more')}<`));
  assert.equal(message('messages:ai.search.more'), 'These are the newest matches. Type more to narrow them down.');

  // The note that nothing matched waits for the messages' answer.
  const waiting = html({ query: 'zzz', found: null });
  assert.doesNotMatch(waiting, /data-ai-search-empty|data-ai-list="found"/, 'nothing new is drawn while the messages are being read');
  const earlier = html({ query: 'zzz', found: answered('zz', []) });
  assert.doesNotMatch(earlier, /data-ai-search-empty/, 'an answer to an earlier query is not this one\'s');
  const nothing = html({ query: ' zzz ', found: answered('zzz', []) });
  assert.match(nothing, /data-ai-search-empty=""><p class="[^"]*">Nothing in your threads or messages matches “zzz”<\/p>/);
  // The last answer stays drawn while the next one is read, so the list does not blink.
  const stale = html({ query: 'improve m', found: answered('improve', [hit()]) });
  assert.match(stale, /data-ai-list="found"/);
  assert.doesNotMatch(stale, /data-ai-search-empty/);

  // One character is too short to ask the server: the note speaks of threads only.
  const short = html({ query: 'z', found: { q: 'z', rows: [], more: false, state: 'unasked' } });
  assert.match(short, /data-ai-search-empty=""><p class="[^"]*">No threads match “z”<\/p>/);

  // The messages could not be read: said plainly, with Try again; the threads still answer.
  const failed = html({ query: 'improve', found: { q: 'improve', rows: [], more: false, state: 'failed' } });
  assert.match(failed, /data-ai-list="busy"/, 'the threads are still searched');
  assert.match(failed, /data-ai-search-failed="" role="status"><p class="[^"]*">Your messages could not be searched\.<\/p><button type="button"[^>]*data-ai-search-retry="">Try again<\/button>/);
  assert.doesNotMatch(failed, /data-ai-search-empty/);
  const failedBare = html({ query: 'zzz', found: { q: 'zzz', rows: [], more: false, state: 'failed' } });
  assert.match(failedBare, /No threads match “zzz”/, 'no thread matched; the messages are not claimed');
  assert.match(failedBare, /data-ai-search-failed=""/);

  // The page (index.tsx) asks only for what the open box says, and hands both faces the answer.
  const page = read('frontend/src/features/ai/index.tsx');
  assert.match(page, /const search = useBotSearch\(asked, \{/);
  assert.equal((page.match(/found=\{search\.found\}/g) || []).length, 1, 'the list');
  assert.equal((page.match(/onFoundRetry=\{search\.retry\}/g) || []).length, 1);
});

// #6738: a person searched "improve", opened a message from the results, and
// the message glowed for about two seconds and then looked like any other.
// The words a result was opened by stay marked in that message while it is
// read, until the search is cleared or changed.
test('#6738: the words a result was opened by stay marked in the message it opens', () => {
  const plain = (v) => JSON.parse(JSON.stringify(v));
  const store = loadTsx('frontend/src/features/ai/search-mark.ts');
  assert.equal(store.currentSearchMark(), null, 'nothing marked at rest');
  store.setSearchMark({ messageId: 71, q: 'improve' });
  assert.deepEqual(plain(store.currentSearchMark()), { messageId: 71, q: 'improve' });
  store.setSearchMark({ messageId: 'seventy-one', q: 'improve' });
  assert.equal(store.currentSearchMark(), null, 'an id that is not one marks nothing');
  store.setSearchMark({ messageId: 71, q: '' });
  assert.equal(store.currentSearchMark(), null, 'no query, no marks');
  store.setSearchMark({ messageId: 71, q: 'improve' });
  store.clearSearchMark();
  assert.equal(store.currentSearchMark(), null, 'cleared when the search moves on');

  // A found row's press marks the message before it follows its address, so
  // the message is drawn already marked; a press left to the browser sets none.
  const seen = [];
  const { followFound } = loadTsx('frontend/src/features/ai/found.tsx', {
    stubs: {
      './door': { goBotAddress: (href) => seen.push(['go', href]) },
      './search-mark': { setSearchMark: (mark) => seen.push(['mark', mark]) },
    },
  });
  const press = (over) => ({
    defaultPrevented: false, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
    preventDefault() { this.defaultPrevented = true; }, ...over,
  });
  followFound(press(), '#homeroom-bot/thread/60/m/88', { messageId: 88, q: 'improve' });
  assert.deepEqual(seen, [['mark', { messageId: 88, q: 'improve' }], ['go', '#homeroom-bot/thread/60/m/88']]);
  seen.length = 0;
  followFound(press({ metaKey: true }), '#elsewhere', { messageId: 88, q: 'improve' });
  assert.deepEqual(seen, [], 'a new tab is the browser\'s, and marks nothing');

  // The list hands the row's message and query to that press.
  for (const face of ['frontend/src/features/ai/lists.tsx']) {
    assert.match(read(face), /onClick=\{\(e\) => followFound\(e, line\.href, \{ messageId: line\.messageId, q: line\.q \}\)\}/, face);
  }
  assert.match(read('frontend/src/features/ai/lines.ts'), /messageId: row\.messageId,\s*q: found\.q,/,
    'the line carries the message its link opens, and the query the answer was for');

  // The page clears the mark when the box is closed, emptied or says
  // something else; the box is not in the address, so nothing outlives it.
  assert.match(read('frontend/src/features/ai/index.tsx'),
    /const marked = cleanQuery\(asked\);\s*useEffect\(\(\) => \{\s*const mark = currentSearchMark\(\);\s*if \(mark && mark\.q !== marked\) clearSearchMark\(\);\s*\}, \[marked\]\);/);

  // The row reads the mark by its own id, so only the opened message is
  // marked, and hands it to its words and their translation.
  const row = read('frontend/src/features/messages/message-row.tsx');
  assert.match(row, /const marks = useSearchMark\(message\.id\);/);
  assert.match(row, /<MessageMarkdown content=\{message\.content\} channels=\{channels\} appSlug=\{botMeta\(message\)\?\.appSlug\} requestColors=\{!!botMeta\(message\)\} marks=\{marks\} \/>;/);
  assert.match(row, /<BotHeadWords head=\{head\} objects=\{message\.objects\} channels=\{channels\} draft=\{draft\} marks=\{marks\} \/>/);
  assert.match(row, /<MessageMarkdown content=\{translation\.texts\[0\]\} channels=\{channels\} appSlug=\{botMeta\(message\)\?\.appSlug\} requestColors=\{!!botMeta\(message\)\} marks=\{marks\} \/>/);
  assert.match(read('frontend/src/features/messages/bot-head-card.tsx'),
    /<MessageMarkdown content=\{text\} channels=\{channels\} appSlug=\{head\.appSlug\} marks=\{marks\} \/>/,
    'the bot\'s words before and after its card are marked too');
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

test('10 Nov 2026: `#homeroom-bot/new` is New chat pressed for you, and may name the project and who works on it', () => {
  const door = loadTsx('frontend/src/features/ai/door.ts');
  const plain = (v) => JSON.parse(JSON.stringify(v));
  assert.equal(door.botNewAddress(null), '#homeroom-bot/new');
  assert.equal(door.botNewAddress({ project: 'run-club-1a2b3c', builder: 'claude-code' }), '#homeroom-bot/new?project=run-club-1a2b3c&with=claude-code');
  assert.equal(door.botNewAddress({ project: 'run-club-1a2b3c', builder: 'homeroom' }), '#homeroom-bot/new?project=run-club-1a2b3c', 'Homeroom bot is the default and is not said');
  assert.equal(door.botNewAddress({ project: 'Not A Slug!', builder: 'someone-else' }), '#homeroom-bot/new', 'only a slug the platform mints and a builder it knows');
  assert.deepEqual(plain(door.botNewAt('#homeroom-bot/new?project=run-club-1a2b3c&with=chatgpt')), { project: 'run-club-1a2b3c', builder: 'chatgpt' });
  assert.deepEqual(plain(door.botNewAt('#homeroom-bot/new')), { project: null, builder: 'homeroom' });
  assert.deepEqual(plain(door.botNewAt('#homeroom-bot/new?project=..%2Fx&with=root')), { project: null, builder: 'homeroom' }, 'an address is anybody\'s to write');
  assert.equal(door.botNewAt('#homeroom-bot/thread/5'), null);
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
  assert.match(src, /const named = ask\.fresh;\n\s+const own = named\.project \? null : newChatPreset\(\);\n\s+openBlank\(\);\n\s+startNewThread\(botId, own \? \{ \.\.\.own, builder: named\.builder \} : named\);/,
    'the same two halves New chat runs, with what the address named; one that names no project takes the page\'s');
  const thread = read('frontend/src/features/messages/new-thread.tsx');
  assert.match(thread, /export function startNewThread\(conversationId: number, fresh\?: NewThreadPreset \| null\): void \{\n\s+if \(!conversationId\) return;\n\s+closeThread\(\);\n\s+const held = takeCarried\(\);/, 'what a door carried for it is taken here');
  assert.match(thread, /const \[project, setProject\] = useState\(\(\) => preset\?\.project \|\| ''\);/);
  assert.match(thread, /const \[builder, setBuilder\] = useState<Builder>\(\(\) => preset\?\.builder \|\| 'homeroom'\);/);
});

test('#6595: pageProject reads the project off a page route, and only there', () => {
  const column = loadTsx('frontend/src/features/ai/column.ts');
  assert.equal(column.pageProject('app/garden/dev/issues/6580'), 'garden');
  assert.equal(column.pageProject('/app/garden/dev/changes/12'), 'garden');
  assert.equal(column.pageProject('app/garden?project=x'), 'garden');
  assert.equal(column.pageProject('homeroom-bot'), null, 'the tab itself');
  assert.equal(column.pageProject('app'), null);
  assert.equal(column.pageProject('messages/12'), null);
  assert.equal(column.pageProject(null), null);
  // The page open in the column is added to what the lists are re-read for,
  // so a project that moved there is not missed when it is not listed.
  const index = read('frontend/src/features/ai/index.tsx');
  assert.match(index, /column\?\.at === 'page' \? pageProject\(column\.route\)/);
  assert.match(index, /useLiveLists\(\(\) => setMoved\(\(n\) => n \+ 1\), visible, \{ projects: shownProjects, botId \}, applyPush\)/);
});

// #6600: after Homeroom bot took over the person's change and its last try
// failed, the row says so and offers Ask again, not Fix it.
test('#6600: a takeover that failed says the bot could not fix it, with Ask again', () => {
  const { needsYou } = loadTsx(MODEL);
  const work = {
    private: [],
    needs: [thread(7, 410, 'fixing', {
      group: 'needs', kind: 'change', title: 'Show the reason', fixYours: true, botFixFailed: true,
      work: { stage: 'checking', line: { code: 'bot_fix_failed' } },
    })],
    next: [], waiting: [], live: [],
  };
  const [row] = needsYou(null, work);
  assert.equal(row.key, 'bot_fix_failed:7');
  assert.equal(message(row.pill.id), 'Ask again');
  assert.equal(words(row.sub), "Garden club · #410 · Homeroom bot couldn't fix it");
  assert.equal(message(row.why.id), "Homeroom bot couldn't fix it. Ask it again, or fix it yourself");
  assert.equal(row.href, '#app/garden/dev/issues/410', 'the change, where the bot can be asked again');
  // On GitHub the change's number is written PR, not #.
  const onGithub = { ...app, changesOnGithub: true };
  const [pr] = needsYou(null, { ...work, needs: [{ ...work.needs[0], app: onGithub }] });
  assert.equal(words(pr.sub), "Garden club · PR 410 · Homeroom bot couldn't fix it");
});

// #6714: a press on the AI tab from a project's page carries that project
// into the tab's address, so its filter offers it and starts on it
// (../frontend/src/features/ai/filter-address.ts).
test('#6714: the AI tab\'s address from a project\'s page is narrowed to that project', () => {
  const a = loadTsx('frontend/src/features/ai/filter-address.ts');
  assert.equal(a.botTabAddress('garden'), '#homeroom-bot?project=garden');
  assert.deepEqual(a.projectsOf(a.botTabAddress('garden')), ['garden'], 'the filter reads it back');
  assert.equal(a.botTabAddress(null), '#homeroom-bot', 'nowhere in particular is All');
  assert.equal(a.botTabAddress(undefined), '#homeroom-bot');
  assert.equal(a.botTabAddress(''), '#homeroom-bot');
  assert.equal(a.botTabAddress('not a slug'), '#homeroom-bot', 'never anything but a slug');
});

// #6838: on a phone the list stays the width of the screen and never slides
// sideways. The badge's spoken label (sr-only, absolute) used to escape the
// chip rail's clip on a chip scrolled past its end, because neither the badge
// nor the rail was positioned: the nearest positioned ancestor was the drawer
// list itself, so the label widened the list and `overflow-y: auto` gave it a
// sideways scroll. The badge now holds its own label, and the list clips
// sideways overflow as a guard. The chip rail keeps its own sideways scroll.
test('#6838: the list scrolls up and down only; a row never pushes past its band', () => {
  const lists = read('frontend/src/features/ai/lists.tsx');
  const css = read('public/css/app.css');
  const rule = css.slice(css.indexOf('.ai-drawer-list {'));
  const block = rule.slice(0, rule.indexOf('}'));
  assert.match(block, /overflow-x: hidden;/, 'the phone list can never be dragged sideways');
  assert.match(block, /overflow-y: auto;/, 'it still scrolls up and down');
  assert.match(block, /touch-action: pan-y;/, 'a sideways swipe is not a pan');
  // 24 Nov 2026 (the three bands): no chip rail; a row's title truncates (or
  // takes two lines where the list is narrow) and its pill never wraps.
  assert.doesNotMatch(lists, /overflow-x-auto/, 'nothing of the list\'s own scrolls sideways');
  // The row's word is the one tag now (@/components/ui/state-tag, app.css
  // `.one-tag`), which never wraps: `white-space: nowrap` on the shared part.
  assert.match(lists, /<StateTag state="needs" data-ai-row-end="act">/);
  assert.match(css, /html:root \.one-tag \{[^}]*flex: none;[^}]*white-space: nowrap;/);
  assert.match(lists, /className=\{`ai-row-title block truncate /);
  assert.match(css, /#ai-screen \.ai-lists \.ai-row-title \{\n  display: -webkit-box;\n  -webkit-box-orient: vertical;\n  -webkit-line-clamp: 2;/);
  assert.match(lists, /<KindRail role="group"/, 'Done\'s kind chips ride the shared rail, which scrolls inside itself');
});

// T2.10 (19 Nov 2026): a hand-back's pill says what it waits on, from the
// cause the server stored (services/bot-stop-cause.js), never "Needs reply"
// to a requester whose decision it is not.
test('T2.10: a person verdict\'s pill says who or what it waits on', () => {
  const { needsYou } = loadTsx(MODEL);
  const decide = (n, cause) => thread(n, 500 + n, 'decide', { group: 'needs', work: { cause } });
  const rows = needsYou([], {
    private: [], next: [], live: [], waiting: [],
    needs: [decide(1, 'requester'), decide(2, 'others'), decide(3, 'platform'), decide(4, 'other_project'),
      decide(5, 'wrong_project'), decide(6, 'close'), decide(7, 'operator_work')],
  });
  assert.deepEqual(rows.map((r) => message(r.pill.id)), [
    'Needs reply', 'See who decides', 'Move it', 'Move it', 'Close it', 'Close it', 'Take a look',
  ]);
  const { normalizeWorkState } = loadTsx('frontend/src/lib/work-state.ts');
  assert.equal(normalizeWorkState({ stage: 'waiting_for_you', why: 'decide', cause: 'others' }).cause, 'others', 'the client keeps the cause');
});

// ── The thread list hidden (#6963) ──────────────────────────────────────
//
// Dragging the divider past the list's floor on a wide screen puts the page
// in one pane: the list is hidden, the thread takes the room, and a button
// first in the thread's head — or the edge itself — brings it back. The
// choice is this device's and holds across threads and reloads.

test('the list hidden: one store, this device\'s, and only the bot page\'s column offers the way back', () => {
  const mem = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k),
    },
  };
  const { setListClosed, setDocked, isListClosed, showsListButton } = loadTsx('frontend/src/features/ai/list-closed.ts');
  const read2 = (get) => get();
  assert.equal(typeof loadTsx('frontend/src/features/ai/list-closed.ts').useShowListButton, 'function',
    'the page draws it through a hook, whose server snapshot is the split (the prerender)');
  // The split is what a first visit gets, before and after mount.
  assert.equal(read2(isListClosed), false);
  assert.equal(read2(showsListButton), false);
  // Hidden, but with no page docked: no button anywhere.
  setListClosed(true);
  assert.equal(mem.get('usernode_ai_list_closed_v1'), '1', 'remembered on this device');
  assert.equal(read2(showsListButton), false);
  setDocked(true);
  assert.equal(read2(showsListButton), true, 'the bot page\'s column offers it');
  // A phone, or a preview in a window too narrow for three columns, publishes
  // itself as not docked.
  setDocked(false);
  assert.equal(read2(showsListButton), false);
  assert.equal(read2(isListClosed), true, 'the choice is kept for when it is docked again');
  setDocked(true);
  setListClosed(false);
  assert.equal(mem.has('usernode_ai_list_closed_v1'), false, 'a split writes nothing');
  assert.equal(read2(showsListButton), false);
  delete globalThis.window;
});

test('the list put away beside a preview (24 Nov 2026): halves where three columns fit, nothing else changes', () => {
  const { listLayout } = loadTsx('frontend/src/features/ai/list-closed.ts');
  const at = (o) => listLayout({ closed: false, open: true, preview: false, fits: 'three', phone: false, ...o });
  // No preview: as it was. The bar snaps, and the choice is one pane.
  assert.deepEqual(at({}), { snaps: true, oneUp: false, layout: 'three' });
  assert.deepEqual(at({ closed: true }), { snaps: true, oneUp: true, layout: 'three' });
  assert.deepEqual(at({ closed: true, fits: 'halves' }), { snaps: true, oneUp: true, layout: 'halves' },
    'a narrower window with no preview hides the list as it did');
  // A preview where three columns fit: the bar snaps there too, and the list
  // put away leaves the thread and the preview in halves.
  assert.deepEqual(at({ preview: true }), { snaps: true, oneUp: false, layout: 'three' });
  assert.deepEqual(at({ preview: true, closed: true }), { snaps: true, oneUp: true, layout: 'halves' },
    'list, thread and preview become thread and preview');
  // A window whose width already makes halves: no list to hide or restore.
  assert.deepEqual(at({ preview: true, fits: 'halves' }), { snaps: false, oneUp: false, layout: 'halves' });
  assert.deepEqual(at({ preview: true, fits: 'halves', closed: true }), { snaps: false, oneUp: false, layout: 'halves' },
    'the choice is kept and changes nothing there');
  // A phone and a closed column are untouched by the choice.
  assert.deepEqual(at({ preview: true, closed: true, fits: 'full', phone: true }), { snaps: false, oneUp: false, layout: 'full' });
  assert.deepEqual(at({ closed: true, phone: true, fits: 'full' }), { snaps: true, oneUp: false, layout: 'full' });
  assert.deepEqual(at({ closed: true, open: false }), { snaps: true, oneUp: false, layout: 'three' });

  // The thread's edge stays drawn on the pane's own edge while the list is
  // put away, and the side panel's does as the column beside a page.
  const css = read('public/css/app.css');
  assert.match(css, /#ai-screen\[data-ai-preview="halves"\]\[data-ai-list-closed\] \.ai-main-pane > \.side-panel-divider \{ display: block; \}/);
  assert.match(css, /body:has\(#ai-screen\[data-ai-preview="halves"\]\[data-ai-list-closed\]:not\(\.hidden\)\) #side-panel-divider \{ display: block; \}/);
  assert.match(css, /body:has\(#ai-screen:not\(\.hidden\)\) #ai-screen\[data-ai-preview="halves"\]\[data-ai-list-closed\] #ai-main-divider,\nbody:has\(#ai-screen\[data-ai-preview="halves"\]\[data-ai-list-closed\]:not\(\.hidden\)\) #side-panel-divider \{\n  --divider-at: calc\(var\(--ai-col-w\) \+ var\(--ai-preview-w\) \+ var\(--ai-edge, 0px\)\);\n\}/);
  // A narrower window's halves still draws neither.
  assert.match(css, /#ai-screen:not\(\[data-ai-preview="three"\]\)\[data-ai-preview\] \.ai-main-pane > \.side-panel-divider \{ display: none; \}/);
  assert.match(css, /body:has\(#ai-screen\[data-ai-preview="halves"\]:not\(\.hidden\)\) #side-panel-divider \{\n\s+display: none;\n\}/);
});

test('the list put away: one pane, or beside a preview the thread and the preview in halves, where three columns fit', () => {
  const index = read('frontend/src/features/ai/index.tsx');
  assert.match(index, /import \{ listLayout, setDocked, setListClosed, useListClosed \} from '\.\/list-closed';/);
  assert.match(index, /const listClosed = useListClosed\(\);\s+const \{ snaps, oneUp, layout \} = listLayout\(\{ closed: listClosed, open: columnOpen, preview: previewHere, fits, phone \}\);/,
    'one reading of the choice, the column and the window');
  assert.match(index, /setDocked\(docked && snaps && !phone\)/, 'the button is offered wherever the list\'s bar snaps');
  assert.match(index, /data-ai-list-closed=\{oneUp \? '' : undefined\}/);
  assert.match(index, /onCollapse=\{snaps \? \(\) => setListClosed\(true\) : undefined\}/);
  assert.match(index, /onRestore=\{snaps \? \(\) => setListClosed\(false\) : undefined\}/);
  assert.match(index, /collapsed=\{oneUp\}/, 'the edge knows the list is hidden');
  // Opening another thread touches neither: nothing clears the choice.
  assert.doesNotMatch(index, /setListClosed\(false\)[\s\S]{0,80}(openRoot|at\?\.threadRootId|columnKey)/,
    'switching threads leaves the one-pane choice alone');
});

test('the way back to the list: a round head button first in a thread\'s head and a new chat\'s', () => {
  const messages = read('frontend/src/features/messages/index.tsx');
  // One button node, drawn by both heads the thread can have: the compact
  // sheet the bot tab draws it as (#6863) and the plain header elsewhere.
  // It is the list's own glyph — never the rail's SidebarIcon, which is the
  // Messages screen's full-width toggle (messages-full-width.test.js).
  assert.match(messages,
    /const showList = useShowListButton\(\);\s+const showListButton = alone && !onBack && showList \? \(\s+<button type="button" className="messages-thread-action messages-thread-back" data-reply-show-list=""\s+aria-label=\{t\('messages:ai\.list\.show'\)\} title=\{t\('messages:ai\.list\.show'\)\}\s+onClick=\{\(\) => setListClosed\(false\)\}>\s+<ListBulletIcon aria-hidden="true" \/>/,
    'the same small round head button as the thread\'s ✕, named by its tooltip');
  const bar = messages.slice(messages.indexOf('<ThreadHeadCard\n              attrs={{ \'data-reply-head\': \'alone\' }}'));
  assert.match(bar.slice(0, 600), /lead=\{showListButton\}/,
    'the compact sheet the bot tab draws a private thread as leads its head with it');
  const header = messages.slice(messages.indexOf('<header className="messages-thread-header" data-reply-head={alone ? \'alone\' : undefined}>'));
  assert.match(header.slice(0, 400), /\{showListButton\}/,
    'and so does the plain header, before any other head button');
  assert.ok(header.indexOf('{showListButton}') < header.indexOf('data-reply-back'),
    'first in the head');
  const fresh = read('frontend/src/features/messages/new-thread.tsx');
  const freshHead = fresh.slice(fresh.indexOf('<header className="messages-thread-header">'));
  assert.match(freshHead.slice(0, 600),
    /\{showList \? \(\s+<button type="button" className="messages-thread-action messages-thread-back" data-reply-show-list=""[^]*?onClick=\{\(\) => setListClosed\(false\)\}/,
    'a new chat, under its own head, has it too');
  assert.ok(freshHead.indexOf('data-reply-show-list') < freshHead.indexOf('messages-thread-name'),
    'first in the head');
  assert.equal(message('messages:ai.list.show'), 'Show thread list');
  assert.equal(message('agent:sidePanel.listHidden'), 'Thread list hidden');
});

test('the one-pane rule: the list is not drawn and the pane takes the whole room', () => {
  const css = read('public/css/app.css');
  // 24 Nov 2026: the pane stops 16px short of the rail (the list's own card
  // margin, folded away), so the thread's card sits 28px from the rail and
  // the bar has a gap to sit in.
  assert.match(css, /#ai-screen\[data-ai-docked\]\[data-ai-open\]\[data-ai-list-closed\] \{\n  --ai-main-w: calc\(var\(--ai-room\) - var\(--ai-edge, 0px\) - 16px\);\n\}/,
    'the pane and its edge stop 16px after the rail, as `--ai-main-w` is what both read');
  assert.match(css, /#ai-screen\[data-ai-docked\]\[data-ai-open\]\[data-ai-list-closed\] \.ai-screen-body \{ display: none; \}/,
    'and the list is out of the page');
  assert.match(css, /body:has\(#ai-screen\[data-ai-docked\]\[data-ai-open\]\[data-ai-list-closed\]:not\(\.hidden\)\) \{\n  --ai-main-w: calc\(var\(--ai-room\) - var\(--ai-edge, 0px\) - 16px\);\n\}/,
    'a page in Main\'s place, which reads the width from body, takes the room too and leaves the same gap');
  // Beside a preview (halves) the thread gives up the same 16px, and the
  // preview at its widest stops 16px sooner so the thread keeps its 320px.
  assert.match(css, /body:has\(#ai-screen\[data-ai-preview="halves"\]\[data-ai-list-closed\]:not\(\.hidden\)\) \{\n  --ai-preview-w: max\(320px, min\(var\(--ai-preview-chosen-w, calc\(var\(--ai-room\) \/ 2\)\), calc\(var\(--ai-room\) - 16px - 320px\)\)\);\n  --ai-col-w: calc\(var\(--ai-room\) - 16px - var\(--ai-preview-w\)\);\n\}/,
    'halves with the list put away leave the gap too');
  // The bar sits in the middle of that 28px gap, (16px - 12px) / 2 off the
  // pane's edge towards the rail, at every width (unindented: no media block)
  // and in every look, Main's and the side panel's alike; #6447's 8px
  // towards the list is the list's.
  assert.match(css, /\nbody:has\(#ai-screen\[data-ai-list-closed\]:not\(\.hidden\)\) :is\(#ai-main-divider, #side-panel-divider\) \{\n  inset-inline-end: calc\(var\(--divider-at, var\(--side-panel-w\)\) - var\(--divider-w\) \/ 2 \+ \(16px - 12px\) \/ 2\);\n\}/,
    'the bar in the folded list\'s gap');
  const placed = css.indexOf('\nbody:has(#ai-screen[data-ai-list-closed]:not(.hidden)) :is(#ai-main-divider, #side-panel-divider) {');
  assert.ok(placed > css.indexOf('THE BOT TAB\'S OTHER TWO GRIPS'), 'after the grips placed in their gaps, which it does not touch');
});

test('a page in the column hands the panel\'s own edge the one-pane wiring (#6973)', () => {
  // The divider people drag beside a request, change or decision page is the
  // side panel's, not Main's: the AI page writes the same collapsed/restore
  // callbacks into the edge store, and only while a page is the column.
  const index = read('frontend/src/features/ai/index.tsx');
  assert.match(index,
    /panelEdgeStore\.set\(\{\s+snap: visible && pageInColumn && snaps && !phone\s+\? \{ collapsed: oneUp, onCollapse: \(\) => setListClosed\(true\), onRestore: \(\) => setListClosed\(false\) \}\s+: null,\s+\}\);/,
    'a page, not a phone, and no preview unless three columns fit; and it never writes the slot');
  assert.match(index, /return \(\) => \{ panelEdgeStore\.set\(\{ snap: null \}\); \};/,
    'cleared when the page is not the column');
  assert.match(index, /const \{ snaps, oneUp, layout \} = listLayout\(/,
    'the same choice the thread column uses');
  const { panelEdgeStore } = loadTsx('frontend/src/features/side-panel/edge-store.ts');
  assert.equal(panelEdgeStore.get().snap, null, 'the prerender has no wiring');
  assert.match(read('frontend/src/features/side-panel/side-panel.tsx'),
    /collapsed=\{snap\?\.collapsed\}\s+onCollapse=\{snap\?\.onCollapse\}\s+onRestore=\{snap\?\.onRestore\}/,
    'its own divider reads it');
});

test('phone review #5 and #11: leaving the page holds the thread\'s detail, and a layout switch keeps the thread', () => {
  const page = read('frontend/src/features/ai/index.tsx');
  // #5: a request's or a change's page draws whatever the detail store holds,
  // so the artifact a thread showed is held for it when the page is left.
  assert.match(page, /if \(!visible\) \{\s+ownerWas\.current = null;\s+const entry = detailEntry\(\);\s+if \(!entry\?\.owner \|\| entry\.kind === 'preview'\) return;/);
  assert.match(page, /if \(entry\.owner === was \|\| ofThisChat\) holdDetail\(entry\.owner\);/);
  // #11: one reading of both widths, so the drawer and the docked column swap
  // in one render and never both mount a chat …
  assert.match(page, /function useWidths\(\): \{ phone: boolean; wide: boolean \}/);
  assert.match(page, /const \{ phone, wide \} = useWidths\(\);/);
  assert.doesNotMatch(page, /usePhone\(\)/);
  assert.match(read('frontend/src/features/ai/phone-drawer.tsx'), /export const PHONE_QUERY = '\(max-width: 767\.98px\)';/);
  // … and the thread open before the switch is asked for again in the layout
  // arrived at, slid in on a phone, the lists kept where they were scrolled.
  assert.match(page, /if \(openRoot\) \{\s+const next = \{ threadRootId: openRoot, focusMessageId: null \};\s+setAt\(next\);\s+embed\(botId, next, \{ threadsOnly: true \}\);\s+if \(layoutNow === 'phone'\) setLevel\(1\);/);
  assert.match(page, /const scroller = layoutNow === 'phone' \? screen\.querySelector<HTMLElement>\('\.ai-drawer-list'\) : screen;/);
});

test('phone review #117: the drawer\'s thread has no edge line and its head clears the top bar', () => {
  const css = read('public/css/app.css');
  const rule = css.match(/\n\.ai-drawer-thread \{[^}]*\}/)[0];
  assert.doesNotMatch(rule, /border-inline-start/);
  assert.match(css, /\.ai-drawer-pane \{ flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; padding-top: 14px; \}/);
});
