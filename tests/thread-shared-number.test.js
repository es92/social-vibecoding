'use strict';

// #6019 follow-up, 29 Oct: a change and an unrelated request can share a
// number on a project still on GitHub (Change #6002, Request #6002). The
// Postgres suites (threads-postgres, thread-shared-number-postgres,
// requests-postgres) hold the schema rule, the one-time pass and the reads;
// this holds the page's side: a change's page asks for ITS thread, and the
// AI tab names a change's own numberless thread by the change.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('a change\'s page reads its thread as the change\'s, by its own pull request number', () => {
  const route = read('src/routes/threads.js');
  assert.match(route, /asChange: req\.query\.as === 'change',/);
  const items = read('frontend/src/features/dev-board/topic/thread-items.tsx');
  assert.match(items, /`\/api\/apps\/\$\{encodeURIComponent\(slug\)\}\/threads\/\$\{number\}\$\{asChange \? '\?as=change' : ''\}`/);
  assert.match(items, /useThreadPayload\(slug, number, threadId, controlled, asChange\)/);
  const head = read('frontend/src/features/dev-board/topic/topic-head.tsx');
  assert.match(head, /threadNumber=\{Number\(session\?\.pr_number\) \|\| Number\(linkedIssues\[0\]\) \|\| null\} threadAsChange=\{Number\(session\?\.pr_number\) > 0\}/);
  // #6608: the list reads the project the page was painted for, not the app
  // the viewer has since moved to (pageSlug is only the fallback).
  assert.match(read('frontend/src/features/dev-board/topic/change-head.tsx'),
    /<ThreadItems slug=\{slug\} number=\{threadNumber\} asChange=\{threadAsChange\} here=\{\{ type: 'change', id \}\} menuKey=\{menuKey \|\| null\} \/>/);
});

test('the AI tab names a change\'s own numberless thread by the change', () => {
  const { arrange } = require('../src/services/ai-work');
  const row = {
    id: 9, number: null, kind: 'work', thread_title: null, state: 'open', created_at: '2026-10-29T11:16:00Z',
    slug: 'usernode-2d5619', name: 'Homeroom', request_title: null, request_state: null,
    change_id: 11720, pr_number: 6002, change_status: 'promoted', change_user: 7, change_title: 'SEC-09',
    promoted_at: '2026-10-29T11:18:00Z', voted: true, my_vote: 'yes',
  };
  // Up for a vote and waiting on other people's: Up next (29 Oct 2026); its
  // author has said yes (#6580: until then it is a vote they owe). Its
  // stored work state (services/work-state.js) is the change's own row.
  const states = new Map([['change:11720', {
    stage: 'up_for_vote', why: null, reason: null, line: null, whoseMove: 'group', since: '2026-10-29T11:18:00Z',
    voteOpen: true, requesterId: 7,
  }]]);
  const { waiting } = arrange([row], 7, new Date('2026-10-29T15:00:00Z'), null, states);
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].number, 6002);
  assert.equal(waiting[0].href, '#app/usernode-2d5619/dev/changes/6002');
  assert.equal(waiting[0].title, 'SEC-09');
});

// #6718: a change and another change share a pull request number. A link
// that carries the change's own session id after the number names it, so the
// page never looks the (possibly shared) number up.
test('a change address that carries its own id skips the lookup by the shared number', () => {
  const app = read('public/js/app.js');
  assert.match(app, /id: App\._changeNumber\(parts\[5\]\)/,
    'the router reads the id after the number');
  assert.match(app, /`\/dev\/changes\/\$\{norm\.ref\.pr\}\/\$\{id\}`/,
    'and serializes it back, so a reload keeps it');
  const view = read('public/js/app-view.js');
  const start = view.indexOf('async _renderTopicSubView(content, ref) {');
  const lookup = view.slice(start, view.indexOf('AppView._devTopic = ref.pr', start));
  assert.match(lookup, /ref\.kind === 'proposal' && !ref\.id && ref\.pr/,
    'the number lookup runs only for an address with no id of its own');
  assert.match(lookup, /_sessionIdForChange\(ref\.pr\)/);
});

// 18 Nov 2026: PR 6792 (change 13917) was shared through the connector,
// promoted a minute later, and was on none of the Homeroom bot tab's lists
// for the four minutes its checks ran. It came back as Fix it once they had
// failed. Meanwhile the author owed a vote on PR 6779, the change built for
// REQUEST #6792. The tab leaves out a row the Needs you feed already lists,
// and matched the two by number alone, so PR 6792's own row read as the
// vote on #6792 and was dropped.
const HOMEROOM = { slug: 'usernode-2d5619', name: 'Homeroom', icon_url: null, icon_emoji: null, changesOnGithub: true };
const EVAN = 1;
const AT = '2026-11-18T12:05:00Z';

test('a shared change that is promoted is Waiting while its checks run, and Fix it once they fail', () => {
  const workState = require('../src/services/work-state');
  const { arrange } = require('../src/services/ai-work');
  const now = new Date(AT);
  const head = 'b'.repeat(40);
  const facts = {
    id: 13917, user_id: EVAN, shared_at: '2026-11-18T11:59:00Z', created_at: '2026-11-18T11:58:00Z',
    last_activity_at: '2026-11-18T11:59:00Z', integration_block_reasons: [],
  };
  // Shared: still being made, with no thread (no pull request) to be listed in.
  assert.equal(workState.deriveChange({ ...facts, status: 'active' }, { now }).stage, 'building');
  const promoted = {
    ...facts, status: 'promoted', promoted_at: '2026-11-18T12:03:00Z', check_state: 'pending', check_phase: 'testing',
    checks_at: '2026-11-18T12:03:30Z', reviewed_head_sha: head, checks_commit_sha: head,
  };
  // The row refresh stores for it (work_states), as statesFor reads it back.
  const stored = (derived) => ({ ...derived, requesterId: EVAN, voteOpen: workState.voteOpenOf(derived) });
  const checking = stored(workState.deriveChange(promoted, { now }));
  assert.equal(checking.stage, 'checking');
  // Its own thread has no number: request #6792 already holds that number.
  const row = {
    id: 501, app_id: 2, own: true, number: null, kind: 'work', thread_title: null, state: 'open', created_at: '2026-11-18T12:03:00Z',
    slug: HOMEROOM.slug, name: HOMEROOM.name, repo_url: 'https://github.com/Usernode-Labs/social-vibecoding',
    request_id: null, request_title: null, change_id: 13917, pr_number: 6792, change_status: 'promoted', change_user: EVAN,
    change_title: 'Before/after shots', promoted_at: '2026-11-18T12:03:00Z', last_activity_at: '2026-11-18T12:03:00Z',
    voted: false, my_vote: null, check_state: 'pending', needs_fix: false,
  };
  const listed = arrange([row], EVAN, now, null, new Map([['change:13917', checking]]));
  assert.deepEqual(listed.waiting.map((t) => [t.threadId, t.kind, t.number, t.change.number, t.work.stage]),
    [[501, 'change', 6792, 6792, 'checking']], 'Waiting, while its checks run');
  assert.deepEqual([listed.needs.length, listed.next.length], [0, 0]);
  const failing = stored(workState.deriveChange({ ...promoted, check_state: 'failing', check_phase: 'done' }, { now }));
  assert.deepEqual([failing.stage, failing.line?.code], ['checking', 'checks_failing']);
  const fixIt = arrange([{ ...row, check_state: 'failing', needs_fix: true }], EVAN, now, null, new Map([['change:13917', failing]]));
  assert.deepEqual(fixIt.needs.map((t) => [t.threadId, t.fixYours]), [[501, true]], 'Fix it, once they failed');
  assert.equal(fixIt.waiting.length, 0);
});

test('a vote owed on the change for request #6792 leaves PR 6792 listed: a request and a change never share a key', () => {
  const { loadTsx } = require('./lib/render-tsx');
  const { withWords } = require('./lib/work-words');
  const { upNext, inProgress, needsYou, liveThisWeek, owedKeys } = loadTsx('frontend/src/features/ai/model.ts');
  const row = (threadId, kind, number, change, stage, extra = {}) => ({
    threadId, number, kind, title: `T${threadId}`, app: HOMEROOM, change, href: '#', group: 'waiting', at: AT,
    work: withWords({ stage, why: null, reason: null, line: null, since: AT }), ...extra,
  });
  // PR 6779 (change 13898), built for request #6792, up for a vote the author owes.
  const vote = { kind: 'proposal', id: 13898, number: 6779, title: 'Show what each server answer cost', app: HOMEROOM,
    request: { number: 6792, title: 'Performance 3/10' } };
  assert.deepEqual([...owedKeys([vote])].sort(), ['usernode-2d5619#6792', 'usernode-2d5619#change:6779']);
  const pr6792 = row(501, 'change', 6792, { id: 13917, number: 6792 }, 'checking');
  const request6792 = row(502, 'work', 6792, { id: 13898, number: 6779 }, 'up_for_vote');
  const work = { private: [], needs: [], next: [], waiting: [pr6792, request6792], live: [] };
  assert.deepEqual(upNext([vote], work).map((t) => t.threadId), [501],
    'PR 6792 is listed; request #6792\'s thread is the vote in Needs you, once');
  const fixing = { ...pr6792, group: 'needs', fixYours: true };
  assert.deepEqual(needsYou([vote], { ...work, waiting: [], needs: [fixing] }).map((r) => r.key),
    ['need:proposal:13898', 'fix_yours:501'], 'and its Fix it is listed beside that vote');
  assert.deepEqual(inProgress([vote], { ...work, waiting: [], next: [{ ...pr6792, group: 'next' }] }).map((t) => t.threadId), [501]);
  // The other way round: a vote owed on PR 6792 leaves request #6792 alone.
  const voteOn6792 = { kind: 'proposal', id: 13917, number: 6792, title: 'Before/after shots', app: HOMEROOM };
  const quiet = row(503, 'work', 6792, null, 'reading');
  assert.deepEqual(upNext([voteOn6792], { ...work, waiting: [quiet] }).map((t) => t.threadId), [503]);
  assert.deepEqual(upNext([voteOn6792], { ...work, waiting: [pr6792] }), [], 'while PR 6792\'s own row is the vote');
  // A private thread filed as request #6792 belongs to that request's row, never to PR 6792's.
  const filed = { rootId: 77, title: 'Server timing', kind: 'design', app: HOMEROOM, at: AT, state: 'filed', resultRef: 6792 };
  const both = upNext([], { ...work, private: [filed] });
  assert.deepEqual(both.map((t) => [t.threadId, t.rootId]), [[501, undefined], [502, 77]]);
  // Done this week, it is Live this week's unless request #6792 has a row of its own.
  const done = { ...filed, state: 'done', doneAt: AT };
  const live = (waiting) => liveThisWeek({ ...work, waiting, private: [done] }, new Date(AT).getTime()).map((t) => t.rootId);
  assert.deepEqual(live([pr6792]), [77], 'PR 6792 is not request #6792');
  assert.deepEqual(live([request6792]), [], 'request #6792\'s row is that thread\'s row');
});

test('Homeroom bot\'s own lists keep a request\'s number and a change\'s apart too', () => {
  const { listsOf, unfiledPrivate } = require('../src/services/ai-work');
  const vote = { kind: 'proposal', id: 13898, number: 6779, title: 'Show what each server answer cost', app: HOMEROOM,
    request: { number: 6792 } };
  const row = (threadId, kind, number, change, stage, title) => ({
    threadId, number, kind, title, app: HOMEROOM, change, href: '#', group: 'waiting', at: AT,
    work: { stage, why: null, reason: null, line: null, since: AT },
  });
  const work = {
    private: [],
    needs: [],
    next: [],
    waiting: [row(501, 'change', 6792, { id: 13917, number: 6792 }, 'checking', 'Before/after shots'),
      row(502, 'work', 6792, { id: 13898, number: 6779 }, 'up_for_vote', 'Performance 3/10')],
    live: [],
  };
  const lists = listsOf([vote], work);
  assert.deepEqual(lists.waiting.map((r) => [r.number, r.title]), [[6792, 'Before/after shots']]);
  assert.equal(lists.counts.waiting, 1);
  // A private thread filed as request #6792 is folded into that request's row, not PR 6792's.
  const filed = { rootId: 77, title: 'Server timing', app: HOMEROOM, state: 'filed', resultRef: 6792 };
  assert.deepEqual(listsOf([], { ...work, waiting: [work.waiting[0]], private: [filed] }).needsYou.map((r) => r.title),
    ['Server timing'], 'PR 6792 is not request #6792');
  assert.deepEqual(unfiledPrivate([filed], new Set(['usernode-2d5619#6792'])), [], 'request #6792\'s row is');
});
