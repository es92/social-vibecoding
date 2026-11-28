'use strict';

// All items as one list (28 Nov 2026): the board's second view, in four
// groups, beside its columns (frontend/src/features/dev-board/list/).
//
// What this pins:
//   1. One row a thread: a request's row gives way to its change's or its
//      session's, and only when that row is on the list. A request worked
//      on in a session nobody else can see keeps its row, so nothing the
//      columns show is missing from the list.
//   2. Needs you is the Homeroom bot tab's own list for the project, each
//      drawn as its board row, then every other vote the board says the
//      viewer can cast. Where the board says no vote is asked, the board
//      wins: its rows are pushed, the tab's lists are read now and then.
//   3. A request Homeroom bot handed to somebody else is Waiting on others;
//      the viewer's own is Needs you even before the tab's lists are read.
//   4. The row's brief carries that hand-back (AppView._workshopBrief).
//   5. Your work, ticked, is drawn from the tab's own row builder, not from
//      rules of this view's own; the list is a view the address can ask for.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');
const { loadAppView, plain } = require('./lib/app-view-vm');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const MODEL = 'frontend/src/features/dev-board/list/model.ts';
const PREFS = 'frontend/src/features/dev-board/list/prefs.ts';
const LIST = 'frontend/src/features/dev-board/list/board-list.tsx';
const WORKSHOP = 'frontend/src/features/dev-board/workshop/workshop.tsx';
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const brief = (over) => ({
  kind: 'change', noun: 'change', n: null, by: 'pat', mine: false, requested: false, category: '', replies: 0,
  linked: [], closed: [], stage: 'worked', at: 0, ago: '', tags: [], vote: null, ...over,
});
const card = (key, attrs, b) => ({ t: 'card', key, card: { key, attrs, title: { text: key } }, brief: brief(b) });
const request = (n, over = {}) => card(`issue:${n}`, { 'data-issue-row': String(n) }, { kind: 'request', noun: 'request', n, stage: 'request', ...over });
const change = (id, n, over = {}) => card(`proposal:${id}`, { 'data-proposal-row': String(id) }, { n, stage: 'vote', ...over });
const session = (id, over = {}) => card(`session:${id}`, { 'data-shared-session-row': String(id) }, { n: null, ...over });
const merged = (id, n, over = {}) => card(`merged:${id}`, { 'data-proposal-row': String(id) }, { kind: 'live', n, stage: 'live', ...over });
const cols = ({ issues = [], inprogress = [], inreview = [], done = [] }) => [
  { key: 'issues', rows: issues }, { key: 'inprogress', rows: inprogress }, { key: 'inreview', rows: inreview }, { key: 'done', rows: done },
];
const keys = (items) => items.map((item) => (item.entry ? item.entry.key : `line:${item.key}`));

test('one row a thread: a request yields to its change or session, and only then', () => {
  const m = loadTsx(MODEL);
  const entries = m.entriesOf(cols({
    issues: [request(21)],
    inprogress: [
      request(18), // its change is up for approval
      request(27), // its session is shared, so the session's row is here
      request(26), // worked on in a session only its maker sees: no other row
      session(9148, { linked: [27] }),
      { t: 'divider', key: 'others', d: { label: 'Others' } },
      { t: 'archived', key: 'archived', rows: [] },
    ],
    inreview: [change(9141, 41, { linked: [18] })],
    done: [merged(9140, 40, { closed: [18] })],
  }));
  assert.deepEqual(entries.map((e) => e.thread), ['r:21', 'r:18', 'r:27', 'r:26', 'r:27', 'r:18', 'c:9140']);
  const kept = m.onePerThread(entries).map((e) => e.key);
  assert.deepEqual(kept, ['issue:21', 'issue:26', 'session:9148', 'proposal:9141', 'merged:9140']);
  // A column's rows that are neither cards nor dividers are kept to be drawn as they are.
  assert.deepEqual(m.restOf(cols({ inprogress: [{ t: 'divider', key: 'd' }, { t: 'archived', key: 'archived', rows: [] }] }), 'inprogress').map((r) => r.t), ['archived']);
});

test('the groups: the tab\'s Needs you first, then the board\'s own votes, hand-backs, and the rest', () => {
  const m = loadTsx(MODEL);
  const entries = m.entriesOf(cols({
    issues: [
      request(21),
      request(25, { mine: true, waits: { why: 'plan', who: 'me' } }),
      request(34, { waits: { why: 'plan', who: 'pat' } }),
      request(35, { waits: { why: 'stopped', who: 'kai' } }),
    ],
    inprogress: [request(18), session(9148, { linked: [27] })],
    inreview: [
      change(9141, 41, { linked: [18], vote: { yes: 1, need: 3, ask: true } }),
      change(9143, 43, { linked: [22], mine: true, vote: { yes: 1, need: 3, ask: false } }),
      change(9144, 44, { vote: { yes: 1, need: 3, ask: true } }),
      change(9147, 47, { vote: { yes: 2, need: 3, ask: false } }),
    ],
    done: [merged(9140, 40)],
  }));
  const needs = [
    // A vote in a thread of the viewer's: the request's page, drawn as its change's row.
    { key: 'need:proposal:9141', thread: m.threadOfHref('#app/garden/dev/issues/18', 'garden', entries), vote: true, line: 'L-vote' },
    // The viewer's own request, waiting on their go-ahead.
    { key: 'plan:81025', thread: 'r:25', vote: false, line: 'L-plan' },
    // A private thread: no row on the board.
    { key: 'private:7', thread: null, vote: false, line: 'L-private' },
    // The tab still lists a vote the board says was cast a moment ago.
    { key: 'need:proposal:9147', thread: m.threadOfHref('#app/garden/dev/changes/47', 'garden', entries), vote: true, line: 'L-stale' },
  ];
  const g = m.groupAll({ entries, needs });
  assert.deepEqual(keys(g.needs), ['proposal:9141', 'issue:25', 'line:private:7', 'proposal:9144']);
  assert.deepEqual(g.needs.map((item) => item.end.kind), ['line', 'line', 'line', 'vote']);
  assert.equal(g.needs[0].line, 'L-vote');
  assert.deepEqual(keys(g.others), ['issue:34', 'issue:35']);
  assert.deepEqual(g.others.map((item) => item.end), [
    { kind: 'waits', why: 'plan', who: 'pat' }, { kind: 'waits', why: 'stopped', who: 'kai' },
  ]);
  assert.deepEqual(keys(g.making), ['session:9148']);
  assert.deepEqual(keys(g.review), ['proposal:9143', 'proposal:9147']);
  assert.deepEqual(keys(g.backlog), ['issue:21']);
  assert.deepEqual(keys(g.done), ['merged:9140']);
  assert.equal(m.progressCount(g), 4);
  // Every row the columns hold is in exactly one group, but for a request its change stands for.
  const drawn = [...g.needs, ...g.others, ...g.making, ...g.review, ...g.backlog, ...g.done].filter((item) => item.entry).map((item) => item.entry.key);
  assert.deepEqual(drawn.slice().sort(), m.onePerThread(entries).map((e) => e.key).sort());

  // With the filter bar narrowing the board, a need with no row waits for it to clear.
  assert.deepEqual(keys(m.groupAll({ entries, needs, filtering: true }).needs), ['proposal:9141', 'issue:25', 'proposal:9144']);
  // Before the tab's lists are read, the viewer's own hand-back is still Needs you's.
  const early = m.groupAll({ entries, needs: null });
  assert.deepEqual(keys(early.needs), ['issue:25', 'proposal:9141', 'proposal:9144']);
  assert.deepEqual(early.needs[0].end, { kind: 'yours', why: 'plan' });
  // Read, and the tab does not list it: the board does not decide what is the viewer's.
  assert.deepEqual(keys(m.groupAll({ entries, needs: [] }).needs), ['proposal:9141', 'proposal:9144']);
});

test('a page address names the thread the board keys its rows by', () => {
  const m = loadTsx(MODEL);
  const entries = m.entriesOf(cols({ inreview: [change(9141, 41, { linked: [18] }), change(9150, 50)] }));
  assert.equal(m.threadOfHref('#app/garden/dev/issues/18', 'garden', entries), 'r:18');
  assert.equal(m.threadOfHref('#app/garden/dev/changes/41', 'garden', entries), 'r:18');
  assert.equal(m.threadOfHref('#app/garden/dev/changes/50', 'garden', entries), 'c:9150');
  assert.equal(m.threadOfHref('#app/garden/dev/governance/7', 'garden', entries), 'g:7');
  assert.equal(m.threadOfHref('#app/other/dev/issues/18', 'garden', entries), null);
  assert.equal(m.threadOfHref('#app/garden/workshop', 'garden', entries), null);
});

test('a request row says when Homeroom bot handed it to a person', () => {
  const AppView = loadAppView();
  const issue = (over) => ({
    number: 25, title: 'Share a bed', state: 'open', user: 'pat', created_by_username: 'pat', labels: [],
    createdAt: '2026-11-01T10:00:00Z', updatedAt: '2026-11-01T10:00:00Z', ...over,
  });
  const standing = (stage, why) => ({ stage, why, line: null, whoseMove: 'requester', since: null, mine: false });
  assert.deepEqual(plain(AppView._workshopBrief('issue', issue({ standing: standing('waiting_for_you', 'plan') }), null).waits), { why: 'plan', who: 'pat' });
  assert.deepEqual(plain(AppView._workshopBrief('issue', issue({ standing: standing('stopped', null) }), null).waits), { why: 'stopped', who: 'pat' });
  assert.equal(AppView._workshopBrief('issue', issue({ standing: standing('building', null) }), null).waits, undefined);
  assert.equal(AppView._workshopBrief('issue', issue({}), null).waits, undefined);
});

test('the list is a view the address can ask for, and the board is the default', () => {
  const p = loadTsx(PREFS);
  assert.equal(p.viewAsked('?ws=all&board=list'), 'list');
  assert.equal(p.viewAsked('?board=board'), 'board');
  assert.equal(p.viewAsked('?board=cards'), null);
  assert.equal(p.viewAsked(''), null);
  assert.deepEqual(p.DEFAULT_PREFS, { view: 'board', yours: false, othersOpen: false });
});

test('Your work is the Homeroom bot tab\'s own lists, and the page offers both views', () => {
  const list = read(LIST);
  // The tab's reads, rules and row builder, not rules of this view's own.
  assert.match(list, /import \{ forgetDesk, readDesk \} from '\.\.\/\.\.\/ai\/desk';/);
  assert.match(list, /import \{ useAiLines, verbOf, type Line \} from '\.\.\/\.\.\/ai\/lines';/);
  assert.match(list, /picked: \[slug\]/);
  assert.match(list, /lines\.needLines\.map\(lineRow\)/);
  assert.match(list, /lines\.progressLines\.map\(lineRow\)/);
  assert.match(list, /lines\.doneLines\.map\(lineRow\)/);

  const workshop = read(WORKSHOP);
  assert.match(workshop, /<BoardList slug=\{slug \|\| ''\} openKey=\{sideKey\} onOpen=\{openItem\} openRef=\{openRefBeside\} \/>/);
  assert.match(workshop, /data-board-view-option="board"/);
  assert.match(workshop, /data-board-view-option="list"/);
  // The columns' strip belongs to the columns.
  assert.match(workshop, /\{group === 'stage' && !listView \? <StageStrip \/> : null\}/);

  assert.equal(message('project:boardList.view.list'), 'List');
  assert.equal(message('project:boardList.yours.label'), 'Only your work');
  assert.equal(message('project:boardList.group.others'), 'Waiting on others');

  // An item opened beside the list is drawn as the Homeroom bot tab draws one: no box of its own.
  const css = read('public/css/app.css');
  assert.match(css, /body:has\(\.dev-ws\[data-ws-view="list"\]\) > \.dev-ws-side:not\(\.dev-ws-side-empty\) \{\s*inset-inline-end: 0; bottom: 0;\s*border-radius: 0; background: transparent; background-color: transparent; box-shadow: none;/);
});
