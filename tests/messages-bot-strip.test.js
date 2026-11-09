'use strict';

// One request, one story: the chat with Homeroom bot, redrawn.
//
//   1. Where each request stands (frontend/src/features/messages/bot-strip.tsx),
//      read from the viewer's tracks, each its stored work state
//      (lib/work-state.ts): the groups (Needs you, Ready to try, In progress,
//      Finished today, each request once, by its stage), each row's words,
//      the counts the Messages list's bot row says, and how a request ended.
//      5 Nov 2026 (docs/plans/bot-one-model.md): the activity drawer that
//      drew those groups under the bot chat's header is gone, and with it
//      its Activity bar, its remembered open state and its Try it and
//      Approve; Main Chat holds only the conversation.
//   2. The main chat's news (frontend/src/features/messages/bot-news-line.tsx):
//      each request is ONE row, its earlier news folded into its newest. An
//      open request is two lines with a badge saying what it waits on; a
//      finished one is one line with how it ended, and finished ones in a
//      row fold into "N finished". Every row opens the request's story, a
//      request from before threads on its oldest piece; the bot's replies,
//      offers and hellos stay messages.
//   3. A request's number in its own colour (bot-request.ts), the same in
//      the chat's rows, its thread's header and the bot's words.
//
// Run with: node --test tests/messages-bot-strip.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const STRIP = 'frontend/src/features/messages/bot-strip.tsx';
const NEWS = 'frontend/src/features/messages/bot-news-line.tsx';

globalThis.window = {
  App: { user: { id: 7, username: 'ada' } },
  location: { search: '', hash: '#messages/42' },
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  requestAnimationFrame: (fn) => fn(),
  setTimeout, clearTimeout,
};

const NOW = new Date('2026-10-09T12:00:00Z');
const ago = (minutes) => new Date(NOW.getTime() - minutes * 60000).toISOString();
const nowhere = { request: null, proposal: null, project: null };
// A work state as the server stores it (services/work-state.js).
const at = (stage, extra = {}) => ({ stage, why: null, reason: null, line: null, whoseMove: null, since: null, ...extra });
// One of the viewer's requests, as GET /api/ai/tracks sends it (api.ts normalizeBotTrack).
let seq = 0;
const track = (work, extra = {}) => {
  seq += 1;
  const issueNumber = extra.issueNumber || seq;
  return {
    key: `plant-pal#${issueNumber}`, appSlug: 'plant-pal', appName: 'Plant Pal', iconUrl: null, iconEmoji: null,
    issueNumber, title: `Request ${issueNumber}`, firstVersion: false, work, step: null, waitingOn: null,
    busy: false, try: 1, tryStartedAt: null, tryStarts: [], since: ago(30), rootId: null, askId: null, proposalId: null,
    sessionId: null, links: nowhere, ...extra,
  };
};
const work = (...tracks) => ({ tracks });

function strip() { return loadTsx(STRIP); }

// ── 1. Where each request stands ─────────────────────────────────────────

test('the groups, in order, each request once, by its stage', () => {
  const { stripGroups } = strip();
  const asked = track(at('waiting_for_you', { why: 'question' }), { title: 'Dinner rota' });
  const stuck = track(at('stopped', { reason: 'build_failed' }), { title: 'Print view', cause: 'time' });
  const ready = track(at('up_for_vote'), { title: 'Grey out', step: 'vote' });
  const building = track(at('building'), { title: 'Totals', step: 'build' });
  const held = track(at('building', { line: { code: 'held_waiting' } }), { title: 'Held', held: { limit: 'slots', position: 2, until: null } });
  const live = track(at('live'), { title: 'Went live', step: 'live', since: ago(50) });
  const oldLive = track(at('live'), { title: 'Long ago', step: 'live', since: ago(60 * 30) });
  const model = stripGroups(work(asked, stuck, ready, building, held, live, oldLive, { ...asked, work: at('building') }), NOW);
  const titles = (rows) => rows.map((row) => row.track.title);
  assert.deepEqual(titles(model.needs), ['Dinner rota', 'Print view'], 'what waits for them, and a stop they can start again');
  assert.deepEqual(titles(model.ready), ['Grey out'], 'a change up for a vote');
  assert.deepEqual(titles(model.progress), ['Totals', 'Held'], 'work under way, a hold among it');
  assert.deepEqual(titles(model.done), ['Went live'], 'done is today only');
  assert.deepEqual(model.needs.map((row) => row.state), ['Waiting for your answer', 'It ran out of time']);
  assert.deepEqual(model.ready.map((row) => row.state), ['Up for a vote']);
  assert.deepEqual(model.progress.map((row) => row.state), ['Building', 'Ready to build · Waiting for a slot, 1 request ahead of it']);
  assert.deepEqual(model.done.map((row) => row.state), ['Live']);
  // Each row carries its track: its badge and the chat's news rows read it.
  assert.equal(model.needs[0].track, asked, 'the first of a request\'s tracks is the one drawn');
  assert.equal(model.needs[0].key, asked.key);
  assert.deepEqual(stripGroups(null), { needs: [], ready: [], progress: [], done: [] });
  assert.deepEqual(stripGroups(work()), { needs: [], ready: [], progress: [], done: [] });
});

// #4974: a reply on the request's discussion settles a need. Its work state
// moves on (Homeroom bot reads the reply), so it leaves Needs you, and it is
// not done either: nothing was built from the reply yet.
test('a need settled by a reply leaves Needs you: Homeroom bot reads it, under In progress', () => {
  const { stripGroups } = strip();
  const settled = track(at('reading', { line: { code: 'reply' } }), { title: 'Dinner rota' });
  const waiting = track(at('waiting_for_you', { why: 'needs_detail' }), { title: 'Print view' });
  const model = stripGroups(work(waiting, settled), NOW);
  assert.deepEqual(model.needs.map((row) => row.track.title), ['Print view'], 'the answered one is not asked for any more');
  assert.deepEqual(model.progress.map((row) => [row.track.title, row.state]), [['Dinner rota', 'Reading your reply']]);
  assert.deepEqual(model.done, [], 'and it is not done: nothing was built from the reply yet');
});

test('each row says one short thing, in the stage\'s own words: no step numbers, no timings', () => {
  const { stripGroups } = strip();
  const said = (state, extra) => {
    const model = stripGroups(work(track(state, extra)), NOW);
    const [row] = [...model.needs, ...model.ready, ...model.progress, ...model.done];
    return [row.group, row.state];
  };
  // Waiting for you, by why it waits.
  assert.deepEqual(said(at('waiting_for_you', { why: 'question' })), ['needs', 'Waiting for your answer']);
  assert.deepEqual(said(at('waiting_for_you', { why: 'plan' })), ['needs', 'Waiting for you to OK the plan']);
  assert.deepEqual(said(at('waiting_for_you', { why: 'decide' })), ['needs', 'Waiting for you to decide']);
  assert.deepEqual(said(at('waiting_for_you', { why: 'already_works' })), ['needs', 'It may already work: close it?']);
  assert.deepEqual(said(at('waiting_for_you', { why: 'needs_detail' })), ['needs', 'Waiting for more detail from you']);
  assert.deepEqual(said(at('waiting_for_you', { why: 'decide', line: { code: 'reason', text: 'It needs a design call.' } })),
    ['needs', 'Homeroom bot: It needs a design call.'], 'Homeroom bot\'s own reason, where it gave one');
  // Stopped, by what stopped it, and a build by why it did not finish.
  assert.deepEqual(said(at('stopped', { reason: 'build_failed' }), { cause: 'time' }), ['needs', 'It ran out of time']);
  assert.deepEqual(said(at('stopped', { reason: 'build_failed' })), ['needs', 'Stopped: the build didn\'t finish']);
  assert.deepEqual(said(at('stopped', { reason: 'fix_stopped' })), ['needs', 'Stopped: its tests still fail']);
  assert.deepEqual(said(at('stopped', { reason: 'look_failed' })), ['needs', 'Stopped: it couldn\'t be read']);
  assert.deepEqual(said(at('stopped', { reason: 'change_closed' })), ['needs', 'Stopped: its change was closed']);
  assert.deepEqual(said(at('stopped', { reason: 'stalled' })), ['needs', 'Stopped: the build didn\'t start']);
  // Up for a vote says the stage alone.
  assert.deepEqual(said(at('up_for_vote')), ['ready', 'Up for a vote']);
  assert.deepEqual(said(at('up_for_vote', { line: { code: 'update_queued' } })), ['ready', 'Up for a vote']);
  // Under way: the second line, else the stage.
  assert.deepEqual(said(at('reading', { line: { code: 'queued', place: 4 } })), ['progress', 'Number 4 in line']);
  assert.deepEqual(said(at('reading', { line: { code: 'waiting' } })), ['progress', 'Waiting to be read']);
  assert.deepEqual(said(at('reading')), ['progress', 'Reading it']);
  assert.deepEqual(said(at('reading', { line: { code: 'on_hold' } })), ['progress', 'On hold until Monday: this week\'s building time is used up']);
  assert.deepEqual(said(at('planning')), ['progress', 'Planning']);
  assert.deepEqual(said(at('planning', { line: { code: 'retry_plan' } })), ['progress', 'Trying the plan again']);
  assert.deepEqual(said(at('building', { line: { code: 'reviewing', round: 2, of: 3 } })), ['progress', 'Reviewing, round 2 of 3']);
  assert.deepEqual(said(at('building', { line: { code: 'claimed', by: 'maya' } })), ['progress', 'maya is building it']);
  assert.deepEqual(said(at('checking')), ['progress', 'Checking']);
  assert.deepEqual(said(at('checking', { line: { code: 'checks_failing', failing: 2 } })), ['progress', '2 tests failing']);
  assert.deepEqual(said(at('going_live')), ['progress', 'Going live'], 'going live has not ended');
  assert.deepEqual(said(at('going_live', { line: { code: 'first_version' } })), ['progress', 'First version: it goes live without a vote']);
  // Done today, by how it ended.
  assert.deepEqual(said(at('live'), { since: ago(5) }), ['done', 'Live']);
  assert.deepEqual(said(at('closed'), { since: ago(5) }), ['done', 'Closed']);
  // No clock on a row, however long the try has run: its thread says that.
  const [, busy] = said(at('building'), { busy: true, step: 'build', try: 2, tryStartedAt: ago(15) });
  assert.equal(busy, 'Building');
  assert.doesNotMatch(busy, /so far|\d+m\b|step \d|Try \d/);
});

// The drawer's Needs you rows, each with ONE action, and its Ready rows' Try
// it and Approve went with the drawer (5 Nov 2026): a request's acts are on
// its own card and page, and on the Homeroom bot tab.

test('the Messages list\'s bot row counts every request in its group, zero parts left out', () => {
  const { summaryParts, stripGroups } = strip();
  const tracks = [
    ...Array.from({ length: 5 }, () => track(at('waiting_for_you', { why: 'question' }))),
    ...Array.from({ length: 4 }, () => track(at('up_for_vote'), { step: 'vote' })),
    track(at('building'), { step: 'build' }), track(at('planning'), { step: 'plan' }),
    track(at('checking'), { step: 'checks' }), track(at('going_live'), { step: 'live' }),
    track(at('live'), { step: 'live', since: ago(30) }), track(at('closed'), { since: ago(90) }),
  ];
  const model = stripGroups(work(...tracks), NOW);
  assert.deepEqual(summaryParts(model).map((part) => part.text), ['5 need you', '4 ready to try', '4 in progress', '2 finished today'],
    'every request counted, none capped');
  assert.deepEqual(summaryParts(model).map((part) => part.group), ['needs', 'ready', 'progress', 'done']);
  const one = stripGroups(work(track(at('waiting_for_you', { why: 'plan' })), track(at('up_for_vote'))), NOW);
  assert.deepEqual(summaryParts(one).map((part) => part.text), ['1 needs you', '1 ready to try']);
  assert.deepEqual(summaryParts(stripGroups(work(), NOW)), [], 'nothing to say: nothing at all');
  // The row says the first two parts, from the tracks once they are read; its last message until then.
  const screen = read('frontend/src/features/messages/index.tsx');
  assert.match(screen, /if \(!botWork\.work\) return null;\s*const parts = summaryParts\(stripGroups\(botWork\.work\)\);\s*return parts\.length \? parts\.slice\(0, 2\)\.map\(\(part\) => part\.text\)\.join\(' · '\) : null;/);
  assert.match(screen, /useWorkChanged\(!!botConversation\);/, 'read again when a request\'s stage moves, with no timer');
  assert.doesNotMatch(screen, /POLL_MS/);
});

// #5373: the per-project "The bot's slots on …" links that hung under the
// drawer's Finished today are gone, and so is the drawer (5 Nov 2026); the
// slots page still opens from a held request's own card (./bot-track.tsx).
test('the strip has no slots links of its own: a hold is In progress, and its card opens the slots', () => {
  const { stripGroups } = strip();
  const model = stripGroups(work(
    track(at('building'), { issueNumber: 12, step: 'build' }),
    track(at('up_for_vote'), { issueNumber: 13, step: 'vote' }),
    track(at('building', { line: { code: 'held_waiting' } }), { issueNumber: 14, held: { limit: 'slots', position: 2, until: null } }),
    track(at('building', { line: { code: 'held_builds' } }), { issueNumber: 15, held: { limit: 'builds', position: 1, until: null } }),
  ), NOW);
  // #5392: a hold is in progress; there is no On hold group.
  assert.deepEqual(model.progress.map((row) => row.track.issueNumber), [12, 14, 15], 'the building one and the held ones');
  assert.deepEqual(Object.keys(model), ['needs', 'ready', 'progress', 'done']);
  assert.equal(model.progress[1].state, 'Ready to build · Waiting for a slot, 1 request ahead of it', 'a hold says it is ready to build, and what it waits for');
  assert.equal(model.progress[2].state, 'Ready to build · Next in line to be built');
  const source = read(STRIP);
  assert.doesNotMatch(source, /data-bot-strip-slots|bot\.strip\.slots|openSlots\(/);
  assert.equal(JSON.parse(read('frontend/locales/en/messages.json'))['bot.strip.slots'], undefined, 'the link\'s words are gone from the catalog');
  // The held request's card keeps its own slots button.
  assert.match(read('frontend/src/features/messages/bot-track.tsx'), /data-bot-track-slots/);
});

test('the bot chat\'s header has no drawer under it: Main Chat holds only the conversation', () => {
  const screen = read('frontend/src/features/messages/index.tsx');
  assert.match(screen, /\{embedded \? null : <ThreadHeader \/>\}/);
  assert.doesNotMatch(screen, /<BotStrip\b|BotWorkPanel|BotWorkButton|BotWorkStatusLine/);
  assert.match(screen, /\{botDm \? <BotWorkSync conversationId=\{conversationId\} newsKey=\{newestBotMessageId\(snap\.messages\)\} \/> : null\}/,
    'the chat still reads its requests\' tracks, for its news rows');
  const source = read(STRIP);
  assert.doesNotMatch(source, /export function BotStrip|data-bot-strip=|homeroom:botDrawer|localStorage|useDismiss/,
    'no drawer, no Activity bar, no remembered open state');
  for (const gone of ['bot.strip.name', 'bot.strip.activity', 'bot.strip.group.needs', 'bot.strip.action.approve', 'bot.strip.approveStale']) {
    assert.equal(JSON.parse(read('frontend/locales/en/messages.json'))[gone], undefined, `${gone} went with the drawer`);
  }
});


// ── 2. The main chat's news ──────────────────────────────────────────────

const BOT = { id: 2, username: 'homeroom_bot', bot: true, displayName: 'Homeroom bot' };
let mid = 100;
function botMessage(meta, over = {}) {
  mid += 1;
  return {
    id: mid, conversationId: 42, sender: BOT, createdAt: ago(5), content: 'words', reply: null, reactions: [], attachments: [], objects: [],
    deleted: false, metadata: { homeroomBot: { appName: 'Plant Pal', appSlug: 'plant-pal', issueNumber: 4, issueTitle: 'Dark mode', ...meta } }, ...over,
  };
}
function line(message) {
  const { BotNewsLine } = loadTsx(NEWS);
  return renderToHtml(createElement(BotNewsLine, { message, full: () => createElement('p', null, 'FULL') }));
}

test('each row says where its request stands under its title, in grey: the need colour is its badge\'s', () => {
  const cases = [
    [{ kind: 'question' }, 'Needs your answer', true],
    [{ kind: 'followup_ask' }, 'Needs your answer', true],
    [{ kind: 'plan' }, 'Plan is ready', true],
    [{ kind: 'person' }, 'Needs your decision', true],
    [{ kind: 'blocked' }, 'Needs more detail', true],
    [{ kind: 'empty' }, 'Needs more detail', true],
    [{ kind: 'proposal' }, 'Ready to try', false],
    [{ kind: 'build_failed' }, 'Stopped', true],
    [{ kind: 'checks' }, 'Stopped', true],
    [{ kind: 'needs_look' }, 'Stopped', true],
    [{ kind: 'followup_failed' }, 'Stopped', true],
    [{ kind: 'first_version_failed' }, 'Stopped', true],
    [{ kind: 'allowance' }, 'On hold until Monday', false],
    [{ kind: 'paused' }, 'On hold until Monday', false],
    [{ kind: 'merged' }, 'Live', false],
    [{ kind: 'activity' }, 'I’ve started on it', false],
    // The moment it rang as wins over its kind.
    [{ kind: 'question', moment: 'needs_you', said: 'plan' }, 'Plan is ready', true],
    [{ kind: 'note', moment: 'stopped', said: 'build_time' }, 'Stopped', true],
    [{ kind: 'note', moment: 'live', said: 'live' }, 'Live', false],
    [{ kind: 'note', moment: 'ready', said: 'ready_group' }, 'Ready to try', false],
    [{ kind: 'note', moment: 'on_hold', said: 'allowance' }, 'On hold until Monday', false],
    // #6156: held for votes on the bot's other changes, and held for its turn, read apart.
    [{ kind: 'held_proposals_per_app' }, 'Waiting for votes on other changes', false],
    [{ kind: 'held_builds_per_app' }, 'Waiting its turn to be built', false],
    [{ kind: 'note', moment: 'on_hold', said: 'slots' }, 'Waiting for votes on other changes', false],
    [{ kind: 'note', moment: 'on_hold', said: 'builds' }, 'Waiting its turn to be built', false],
  ];
  // Before the tracks' first read (as here), a row says what its message rang as.
  for (const [meta, words, need] of cases) {
    const html = line(botMessage(meta));
    const label = JSON.stringify(meta);
    assert.match(html, /<span class="flex min-w-0 items-center gap-1\.5"><span class="[^"]*" style="--req-h:322" data-request-tag="4">#4<\/span><strong class="[^"]*">Dark mode<\/strong><\/span>/, label);
    assert.match(html, new RegExp(`<span class="truncate text-\\[13px\\] leading-\\[18px\\] text-zinc-500 first-letter:uppercase dark:text-zinc-400" data-bot-news-words="">${words}</span>`), label);
    assert.match(html, new RegExp(`data-bot-news-state="${need ? 'needs' : 'open'}"`), label);
    assert.doesNotMatch(html, /text-amber-700/, `${label}: words in amber read as an error`);
  }
  // A first version has no number to wear.
  assert.doesNotMatch(line(botMessage({ kind: 'merged', firstVersion: true })), /data-request-tag/);
});

test('with the tracks read, a row says where its request stands NOW: amber only while it waits; an ask that moved on, in the past', () => {
  const { newsStatus } = loadTsx(NEWS);
  const { trayNow, trayEnded } = strip();
  const meta = (extra) => ({ appName: 'Plant Pal', appSlug: 'plant-pal', issueNumber: 4, kind: 'question', ...extra });
  const tracks = work(
    track(at('waiting_for_you', { why: 'question' }), { issueNumber: 4 }),
    track(at('up_for_vote'), { issueNumber: 6, step: 'vote' }),
    track(at('building'), { issueNumber: 7, step: 'build' }),
  );
  const now = trayNow(tracks);
  const said = (status) => ({ text: status.text, need: status.need, settled: status.settled, ended: status.ended });
  assert.deepEqual(said(newsStatus(meta({}), now)), { text: 'Waiting for your answer', need: true, settled: false, ended: null }, 'still waiting: its stage\'s words');
  assert.equal(newsStatus(meta({}), now).row.group, 'needs', 'its badge reads the row');
  assert.deepEqual(said(newsStatus(meta({ issueNumber: 6, kind: 'question' }), now)), { text: 'Up for a vote', need: false, settled: false, ended: null }, 'moved on: where it is now');
  assert.deepEqual(said(newsStatus(meta({ issueNumber: 7, kind: 'activity' }), now)), { text: 'Building', need: false, settled: false, ended: null });
  assert.deepEqual(said(newsStatus(meta({ issueNumber: 9, kind: 'question' }), now)), { text: 'Asked you a question', need: false, settled: true, ended: null }, 'no track for it: settled, an ask in the past');
  assert.deepEqual(said(newsStatus(meta({ issueNumber: 9, kind: 'plan' }), now)), { text: 'Sent you a plan', need: false, settled: true, ended: null });
  assert.equal(newsStatus(meta({ issueNumber: 9, kind: 'proposal' }), now).text, 'Was ready to try');
  assert.deepEqual(said(newsStatus(meta({ issueNumber: 9, kind: 'build_failed' }), now)), { text: 'Stopped', need: false, settled: true, ended: 'build_failed' }, 'never a need once it no longer waits; its ending from its news');
  assert.equal(newsStatus(meta({ issueNumber: 9, kind: 'merged' }), now).ended, 'live');
  assert.deepEqual(said(newsStatus(meta({ issueNumber: 9, kind: 'question' }), null)), { text: 'Needs your answer', need: true, settled: false, ended: null }, 'before the first read: as it rang, nothing settled');
  assert.deepEqual(said(newsStatus(meta({ appName: 'Other', issueNumber: 4 }), now)), { text: 'Asked you a question', need: false, settled: true, ended: null }, 'a number is matched within its project');
  // How it ended comes from its track, at any age, before its news.
  const old = work(
    track(at('closed'), { issueNumber: 9, since: ago(60 * 48) }),
    track(at('live'), { issueNumber: 10, step: 'live', since: ago(60 * 30) }),
    track(at('closed'), { issueNumber: 12, since: ago(60 * 30), doneBy: { username: 'ben', prNumber: 4822 } }),
  );
  const ends = trayEnded(old);
  assert.equal(newsStatus(meta({ issueNumber: 9, kind: 'proposal' }), trayNow(old), ends).ended, 'closed');
  assert.equal(newsStatus(meta({ issueNumber: 10, kind: 'proposal' }), trayNow(old), ends).ended, 'live');
  assert.equal(newsStatus(meta({ issueNumber: 12, kind: 'proposal' }), trayNow(old), ends).ended, 'done_elsewhere', 'shipped by somebody else\'s change');
  // trayNow counts "today" by the device's own clock.
  const today = work(track(at('live'), { issueNumber: 11, step: 'live', since: new Date().toISOString() }));
  assert.deepEqual(said(newsStatus(meta({ issueNumber: 11, kind: 'merged' }), trayNow(today), trayEnded(today))), { text: 'Live', need: false, settled: true, ended: 'live' }, 'done today is settled too');
  // A stop waits on the person: an open row, never settled, its badge the need one.
  const stopped = work(track(at('stopped', { reason: 'build_failed' }), { issueNumber: 13, cause: 'no_start' }));
  assert.deepEqual(said(newsStatus(meta({ issueNumber: 13, kind: 'build_failed' }), trayNow(stopped), trayEnded(stopped))),
    { text: 'Its build couldn\'t start', need: true, settled: false, ended: null });
});

test('how a track ended, in the endings the chat\'s small squares draw', () => {
  const { trackEnding, endedWords } = strip();
  const ending = (state, extra = {}) => trackEnding({ work: state, ...extra });
  assert.deepEqual(
    ['live', 'going_live', 'closed'].map((stage) => ending(at(stage))),
    ['live', 'going_live', 'closed'],
  );
  assert.equal(ending(at('closed'), { doneBy: { username: 'ben', prNumber: null } }), 'done_elsewhere');
  assert.equal(ending(at('stopped', { reason: 'build_failed' })), 'build_failed', 'a build that went wrong');
  assert.equal(ending(at('stopped', { reason: 'look_failed' })), 'failed');
  for (const reason of ['fix_stopped', 'change_closed', 'stalled']) assert.equal(ending(at('stopped', { reason })), 'stopped', reason);
  for (const stage of ['reading', 'planning', 'waiting_for_you', 'building', 'checking', 'up_for_vote']) {
    assert.equal(ending(at(stage)), null, `${stage} has not ended`);
  }
  // In words: the ending's own word, and a build that went wrong says why with it.
  const failed = track(at('stopped', { reason: 'build_failed' }), { cause: 'time' });
  assert.equal(endedWords('build_failed', failed, 'Stopped'), 'Couldn’t build · It ran out of time', 'the dot joins two whole sentences');
  assert.equal(endedWords('build_failed', null, 'Stopped'), 'Couldn’t build', 'no track: the ending\'s word alone');
  assert.equal(endedWords('live', failed, 'Stopped'), 'Live');
  assert.equal(endedWords('done_elsewhere', null, 'x'), message('messages:bot.final.doneElsewhere'));
  assert.equal(endedWords(null, failed, 'What it last said'), 'What it last said', 'no record of how it ended: the words it last said');
});

test('one request, one row: a request\'s earlier news folds into its newest, which counts the updates', () => {
  const { foldBotNews } = loadTsx(NEWS);
  const a1 = botMessage({ kind: 'activity', issueNumber: 18 });
  const other = botMessage({ kind: 'proposal', issueNumber: 11 });
  const a2 = botMessage({ kind: 'question', issueNumber: 18 }, { threadRootId: a1.id });
  const first = botMessage({ kind: 'plan', firstVersion: true, issueNumber: undefined, appName: 'Plants' });
  const live = botMessage({ kind: 'merged', firstVersion: true, issueNumber: undefined, appName: 'plants' });
  const chat = botMessage({ kind: 'chat', issueNumber: 18 });
  const moved = botMessage({ kind: 'activity', issueNumber: 30 });
  const after = botMessage({ kind: 'question', issueNumber: 30 });
  const fold = foldBotNews([a1, other, a2, first, chat, live, moved, after], (message) => message === after);
  assert.deepEqual([...fold.hidden].sort(), [a1.id, first.id].sort(), 'the earlier pieces; the newest is drawn');
  assert.deepEqual(fold.earlier.get(a2.id).map((m) => m.id), [a1.id]);
  assert.deepEqual(fold.earlier.get(live.id).map((m) => m.id), [first.id], 'a first version is one request, by the name the person sees');
  assert.equal(fold.earlier.has(other.id), false, 'a request told once is left as it is');
  assert.equal(fold.hidden.has(moved.id), false, 'a row the stream does not draw never takes another\'s place');
  assert.equal(fold.hidden.has(chat.id), false, 'conversation is never folded');
  // The row drawn carries the ids of what folded into it, so a link to one lands there.
  const html = renderToHtml(createElement(loadTsx(NEWS).BotNewsLine, { message: a2, earlier: [a1], updates: 5 }));
  assert.match(html, new RegExp(`<span id="messages-message-${a1.id}" aria-hidden="true"></span>`));
  assert.match(html, /<span class="text-zinc-400 dark:text-zinc-500" data-bot-thread-link="\d+"> · 5 updates<\/span>/, 'grey: the row\'s chevron says it opens');
  const screen = read('frontend/src/features/messages/index.tsx');
  assert.match(screen, /const newsFold = botDm \? foldBotNews\(snap\.messages, \(message\) => isMovedActivity\(message\) \|\| plans\.hidden\.has\(message\.id\) \|\| asking\(message\)\) : null;/);
  assert.match(screen, /const updates = root\?\.thread\?\.replyCount \|\| \(earlier\.length \? earlier\.length \+ 1 : 0\);/);
  assert.match(screen, /const focused = flashId === message\.id \|\| earlier\.some\(\(item\) => item\.id === flashId\);/);
});

test('every line opens its request\'s page the same way; news naming no page, its thread or its oldest piece', () => {
  const { newsThread, newsTitle } = loadTsx(NEWS);
  const moment = botMessage({ kind: 'question', requestTitle: 'Dinner rota', alsoInChat: true, threadRootId: 31 }, { threadRootId: 31 });
  const html = line(moment);
  assert.match(html, new RegExp(`^<article id="messages-message-${moment.id}" data-message-id="${moment.id}" class="messages-bot-news px-4 py-1" data-bot-news="question">`));
  assert.match(html, /data-bot-news-open="thread"/);
  assert.match(html, />Dinner rota<\/strong>/, 'the request\'s own title first');
  assert.match(html, /<svg class="h-4 w-4 shrink-0 text-zinc-400 dark:text-zinc-500[^"]*"[^>]*aria-hidden="true"><path [^>]*d="M9 5l7 7-7 7"><\/path><\/svg><\/button><\/article>$/, 'a chevron says it opens');
  assert.equal(newsThread(moment), 31);
  // A card with its thread opens that thread, and says how many updates it holds.
  const card = botMessage({ kind: 'activity' }, { thread: { replyCount: 5, lastReplyAt: null, participants: [], lastReply: null } });
  assert.equal(newsThread(card), card.id);
  assert.match(line(card), /I’ve started on it<span class="text-zinc-400 dark:text-zinc-500" data-bot-thread-link="\d+"> · 5 updates<\/span><\/span>/);
  // An old card, from before threads: no thread of its own, so its story
  // opens on its oldest piece, in the same pane. Nothing opens in place.
  const old = botMessage({ kind: 'proposal' });
  assert.equal(newsThread(old), null);
  assert.match(line(old), /data-bot-news-open="thread"/);
  assert.doesNotMatch(line(old), /data-bot-news-open="inline"/);
  const source = read(NEWS);
  // 31 Oct 2026: the request's own page (./bot-request-page.test.js).
  assert.match(source, /if \(page\) openRequestPage\(page, message\.conversationId\);/);
  assert.match(source, /const rootId = newsThread\(message\) \?\? \(earlier\[0\]\?\.id \|\| message\.id\);/);
  assert.match(source, /else openThreadAt\(rootId, rootId === message\.id \? null : message\.id\);/);
  assert.doesNotMatch(source, /else setOpen\(true\)|full\(\)/, 'nothing opens in place');
  assert.equal(newsTitle({ kind: 'merged', appName: 'Plant Pal', issueNumber: 1, firstVersion: true }), 'Plant Pal, first version');
  assert.equal(newsTitle({ kind: 'merged', appName: 'Plant Pal', issueNumber: 9 }), 'Request #9');
});

test('a story from before threads: its oldest piece, then the pieces after it in the pane', () => {
  const { storyRootIn, requestKey } = loadTsx('frontend/src/features/messages/bot-request.ts');
  const key = requestKey({ appName: 'Plant Pal', issueNumber: 4 });
  const first = botMessage({ kind: 'blocked' });
  const chat = botMessage({ kind: 'chat' });
  const second = botMessage({ kind: 'proposal' });
  const elsewhere = botMessage({ kind: 'blocked', issueNumber: 5 });
  assert.equal(storyRootIn([chat, first, elsewhere, second], key), first.id, 'its oldest piece of news');
  const card = botMessage({ kind: 'activity', issueNumber: 4 }, { thread: { replyCount: 2, lastReplyAt: null, participants: [], lastReply: null } });
  assert.equal(storyRootIn([first, card, second], key), card.id, 'a request that has a thread opens it');
  const moment = botMessage({ kind: 'question', issueNumber: 4 }, { threadRootId: 77 });
  assert.equal(storyRootIn([first, moment], key), 77);
  assert.equal(storyRootIn([chat, elsewhere], key), null, 'nothing about it in the chat');
  assert.equal(storyRootIn([first], null), null);
  // The pane draws the pieces after its root, whole, before the replies.
  const screen = read('frontend/src/features/messages/index.tsx');
  const pane = screen.slice(screen.indexOf('function ReplyThreadPanel('), screen.indexOf('function AppReplyThreadPanel('));
  assert.ok(pane.length > 1000);
  assert.match(pane, /const storyKey = botChat && root && !cardId && isBotNews\(root\) \? requestKey\(root\.metadata\?\.homeroomBot \|\| \{\}\) : null;/);
  assert.match(pane, /item\.id > root\.id && !item\.threadRootId && !item\.thread && isBotNews\(item\) && requestKey\(item\.metadata\?\.homeroomBot \|\| \{\}\) === storyKey/);
  assert.match(pane, /\{pieces\.map\(\(item\) => <MessageRow key=\{item\.clientKey \|\| item\.id\} message=\{\{ \.\.\.item, thread: null, threadRootId: rootId \}\}/);
});

test('a line wears the project\'s icon its requests\' tracks have, else its initial', () => {
  const { newsIcon } = loadTsx(NEWS);
  const icon = (appSlug, iconUrl, iconEmoji, appName = 'Project') => track(at('building'), { appSlug, appName, iconUrl, iconEmoji });
  const tracks = work(icon('plants', null, null), icon(null, null, '🧪', 'Staging demo app'), icon('plants', null, '🌱'), icon('rota', '/app-icons/7', null));
  assert.deepEqual(newsIcon(tracks, 'plants'), { iconUrl: null, iconEmoji: '🌱' }, 'the first track with artwork, wherever it is');
  assert.deepEqual(newsIcon(tracks, 'rota'), { iconUrl: '/app-icons/7', iconEmoji: null });
  assert.deepEqual(newsIcon(tracks, 'elsewhere'), { iconUrl: null, iconEmoji: null });
  assert.deepEqual(newsIcon(null, 'plants'), { iconUrl: null, iconEmoji: null }, 'before the tracks are read: the initial');
  assert.deepEqual(newsIcon(tracks, null, 'Staging demo app'), { iconUrl: null, iconEmoji: '🧪' }, 'a project with no slug, by its name');
  assert.deepEqual(newsIcon(tracks, null, 'Project'), { iconUrl: null, iconEmoji: null }, 'a name never matches a project that has a slug');
  assert.match(read(NEWS), /iconUrl=\{icon\.iconUrl\} emoji=\{meta\.appEmoji \|\| icon\.iconEmoji\}/);
  assert.match(read('frontend/src/features/messages/bot-shared.ts'), /for \(const job of work\.tracks\) \{/, 'read from the tracks alone');
});

test('the bot\'s replies, offers, hellos and words about no request stay messages', () => {
  const { isBotNews } = loadTsx(NEWS);
  assert.equal(isBotNews(botMessage({ kind: 'question' })), true);
  assert.equal(isBotNews(botMessage({ kind: 'activity', issueNumber: undefined })), true, 'a card is news');
  assert.equal(isBotNews(botMessage({ kind: 'merged', issueNumber: 1, firstVersion: true })), true);
  for (const kind of ['chat', 'ack', 'reply', 'confirm', 'hello', 'welcome']) {
    assert.equal(isBotNews(botMessage({ kind })), false, kind);
  }
  assert.equal(isBotNews(botMessage({ kind: 'question', moment: 'reply' })), false, 'a reply is a reply');
  assert.equal(isBotNews(botMessage({ kind: 'note', issueNumber: undefined })), false, 'about no request');
  assert.equal(isBotNews({ ...botMessage({ kind: 'question' }), sender: { id: 7, username: 'ada' } }), false, 'the person\'s own messages are theirs');
  assert.equal(isBotNews(botMessage({ kind: 'question' }, { deleted: true })), false);
  // The transcript asks for the line in the bot's chat alone, before any other row.
  const screen = read('frontend/src/features/messages/index.tsx');
  assert.match(screen, /if \(botDm && isBotNews\(message\) && !asks\) \{[\s\S]{0,700}?rows\.push\(<BotNewsLine/);
});

test('the thread pane opens at the message a line names, and flashes it', () => {
  const store = read('frontend/src/features/messages/store.ts');
  assert.match(store, /export function openThreadAt\(rootId: number \| null \| undefined, focusId: number \| null \| undefined = null\): void \{/);
  assert.match(store, /publish\(\{ threadFocusId: validId\(focusId\) && focusId !== rootId \? focusId : null \}\);\s*openThread\(rootId\);/);
  const screen = read('frontend/src/features/messages/index.tsx');
  const pane = screen.slice(screen.indexOf('function ReplyThreadPanel('), screen.indexOf('function AppReplyThreadPanel('));
  assert.ok(pane.length > 1000);
  assert.match(pane, /const wanted = snap\.threadFocusId \|\| snap\.route\.focusMessageId \|\| null;/);
  assert.match(pane, /el\.querySelector<HTMLElement>\(`\[id="messages-message-\$\{wanted\}"\]`\)/, 'its own row, not the line in the chat beside it');
  assert.match(pane, /focused=\{flashId === message\.id\}/);
});

test('every open row wears a badge: amber with what to do, blue when up for a vote, a clock on a hold, grey and turning while the bot works', () => {
  const { OpenState, stripGroups } = strip();
  const model = stripGroups(work(
    track(at('waiting_for_you', { why: 'question' })),
    track(at('waiting_for_you', { why: 'needs_detail' })),
    track(at('waiting_for_you', { why: 'decide' })),
    track(at('stopped', { reason: 'build_failed' })),
    track(at('stopped', { reason: 'fix_stopped' })),
    track(at('up_for_vote'), { step: 'vote' }),
    track(at('building'), { step: 'build', busy: true }),
    track(at('building', { line: { code: 'queued', place: 3 } }), { step: 'build', busy: false }),
    track(at('building', { line: { code: 'held_waiting' } }), { held: { limit: 'slots', position: 1, until: null } }),
    track(at('reading', { line: { code: 'queued', place: 2 } })),
  ), NOW);
  const badge = (row) => renderToHtml(createElement(OpenState, { row }));
  assert.equal(model.needs.length, 5);
  for (const row of model.needs) {
    assert.match(badge(row), /^<span class="flex h-\[22px\] w-\[22px\] shrink-0 items-center justify-center rounded-\[6px\] bg-amber-100 text-amber-700 dark:bg-amber-900\/50 dark:text-amber-300" aria-hidden="true" data-bot-badge="needs"><svg /);
  }
  const glyphs = new Set(model.needs.map(badge));
  assert.equal(glyphs.size, 5, 'the glyph says what to do: answer, add detail, decide, start it again, look at its tests');
  assert.match(badge(model.ready[0]), /bg-violet-100 text-violet-700[^"]*" aria-hidden="true" data-bot-badge="ready"/);
  const [building, queuedBuild, held, queued] = model.progress;
  assert.match(badge(building), /bg-zinc-200\/80 text-zinc-600[^"]*" aria-hidden="true" data-bot-badge="progress"><svg [^>]*class="h-3\.5 w-3\.5 animate-spin \[animation-duration:2\.4s\]"/);
  assert.doesNotMatch(badge(queuedBuild), /animate-spin/, 'a build waiting its turn is still, never turning');
  assert.match(badge(held), /bg-zinc-200\/80 text-amber-600[^"]*" aria-hidden="true" data-bot-badge="progress">/, 'a hold is waiting, never finished');
  assert.doesNotMatch(badge(held), /animate-spin/, 'and never turning');
  assert.doesNotMatch(badge(queued), /animate-spin/, 'nobody is at it yet');
  const source = read(STRIP);
  assert.match(source, /question: \{ icon: ChatIcon, stroke: '2' \}/);
  assert.match(source, /needs_detail: \{ icon: PencilSquareIcon, stroke: '2' \}/);
  assert.match(source, /decide: \{ icon: UserIcon, stroke: '1\.75' \}/);
  assert.match(source, /stopped: \{ icon: ArrowPathIcon, stroke: '2' \}/);
  assert.match(source, /checks: \{ icon: EyeIcon, stroke: '2' \}/);
  // The badge leads a chat row.
  assert.match(read(NEWS), /\{status\.row \? <OpenState row=\{status\.row\} \/> : null\}/);
});

test('a finished request says how it ended: a grey square, its glyph in colour, its words for a reader', () => {
  const { FinalState } = strip();
  const ended = (outcome, fallback = 'Asked you a question') => renderToHtml(createElement(FinalState, { outcome, fallback }));
  const cases = [
    ['live', 'Live', 'text-emerald-600'], ['going_live', 'Going live', 'text-emerald-600'],
    ['closed', 'Closed', 'text-zinc-600'], ['person', 'Handed to a person', 'text-zinc-600'],
    ['stopped', 'Stopped', 'text-zinc-600'], ['held', 'Held back', 'text-zinc-600'],
    ['build_failed', 'Couldn’t build', 'text-red-600'], ['failed', 'Couldn’t build', 'text-red-600'],
  ];
  for (const [outcome, words, ink] of cases) {
    const html = ended(outcome);
    assert.match(html, new RegExp(`^<span class="contents" data-bot-final="${outcome}"><span class="flex h-\\[22px\\] w-\\[22px\\] shrink-0 items-center justify-center rounded-\\[6px\\] bg-zinc-200/80 ${ink} [^"]*" title="${words}" data-bot-badge="${outcome}"><svg `), outcome);
    assert.match(html, new RegExp(`<span class="sr-only">${words}</span>`), outcome);
  }
  assert.match(ended(null), /title="Asked you a question"/, 'no record of how it ended: the words it last said');
  assert.match(read(STRIP), /person: \{ key: 'messages:bot\.final\.person', tone: 'ended', icon: UserIcon, stroke: '1\.75' \}/, 'the bot stepped back: a person');
});

test('a finished request is ONE line: the project\'s small tile, how it ended, its number and title', () => {
  const { SettledLine } = strip();
  const html = renderToHtml(createElement('div', null, createElement(SettledLine, {
    name: 'Plant Pal', slug: 'plant-pal', iconUrl: null, emoji: null, number: 4, title: 'Dark mode', outcome: 'live', fallback: 'Live',
  })));
  assert.match(html, /^<div><span class="flex w-9 shrink-0 justify-end"><span class="[^"]*h-\[22px\] w-\[22px\][^"]*"[^>]*data-bot-tile="">P<\/span><\/span><span class="flex min-w-0 flex-1 items-center gap-1\.5"><span class="contents" data-bot-final="live">[\s\S]*data-request-tag="4">#4<\/span><span class="min-w-0 flex-1 truncate text-\[14px\] font-medium leading-5 text-zinc-700 dark:text-zinc-300">Dark mode<\/span><\/span><\/div>$/, 'the small tile at the end of the big tile\'s column, beside its badge');
  // Polish N15: the title grows and the status gives way, capped at 40%
  // and right-aligned whatever the title's length.
  const worded = renderToHtml(createElement('div', null, createElement(SettledLine, {
    name: 'Plant Pal', slug: 'plant-pal', iconUrl: null, emoji: null, number: 4, title: 'Fix scrolling', outcome: 'taken', fallback: 'Taken', words: 'Somebody else took it on',
  })));
  assert.match(worded, /<span class="min-w-0 flex-1 truncate[^"]*">Fix scrolling<\/span><span class="min-w-0 max-w-\[40%\] truncate text-end [^"]*" data-bot-settled-words="">Somebody else took it on<\/span>/);
  const nested = renderToHtml(createElement('div', null, createElement(SettledLine, {
    name: 'Plant Pal', slug: 'plant-pal', iconUrl: null, emoji: null, number: 4, title: 'Dark mode', outcome: 'live', fallback: 'Live', nested: true,
  })));
  assert.match(nested, /^<div><span class="flex shrink-0">/, 'inside an opened run: no column to keep');
  const source = read(NEWS);
  assert.match(source, /\{status\.settled \? \(\s*<button[\s\S]*?data-bot-news-state="settled"[\s\S]*?<SettledLine/);
  assert.doesNotMatch(source, /grayscale/, 'finished is said by its ending, not by greying the row');
});

test('finished requests in a row fold into words, "N finished · N couldn\'t build"; open, whole rows under it', () => {
  // The run reads the viewer's tracks (./bot-work.tsx); hand the bundle a
  // read with none (tests/lib/render-tsx.js stubs).
  const tray = work();
  const { SettledRun } = loadTsx(NEWS, {
    stubs: {
      './bot-work': {
        useBotWork: () => ({ work: tray, failed: false }),
        loadBotWork() {}, newestBotMessageId: () => null, BotWorkSync: () => null, useWorkChanged() {},
        WORK_CHANGED_EVENT: 'homeroom_bot_work_changed', jobName: () => '', jobTitle: () => '',
      },
    },
  });
  const items = [botMessage({ kind: 'merged', issueNumber: 21 }), botMessage({ kind: 'build_failed', issueNumber: 22 }), botMessage({ kind: 'merged', issueNumber: 23 })]
    .map((message) => ({ message, earlier: [], updates: null, focused: false }));
  items[1].earlier = [botMessage({ kind: 'activity', issueNumber: 22 })];
  const html = renderToHtml(createElement(SettledRun, { items }));
  // 16 Oct 2026: a row of its own, with its own tile, so it never reads as
  // part of the row above it.
  assert.match(html, new RegExp(`^<div class="messages-bot-news messages-bot-settled-run pb-1 pt-2" data-bot-settled-run="3" data-bot-settled-first="${items[0].message.id}">`));
  assert.match(html, /<span class="flex h-9 w-9 shrink-0 [^"]*" aria-hidden="true" data-bot-settled-tile="">/, 'its own tile, in the tile column');
  for (const m of [items[0].message, items[1].message, items[1].earlier[0], items[2].message]) {
    assert.match(html, new RegExp(`<span id="messages-message-${m.id}" aria-hidden="true"></span>`), 'a link to a folded row lands on the line');
  }
  // #5392: the parts are words, each with what it counts; no strip of squares.
  assert.match(html, /aria-expanded="false" data-bot-settled-toggle=""><span data-bot-settled-count="finished">2 finished<\/span><span aria-hidden="true"> · <\/span><span data-bot-settled-count="failed">1 couldn’t build<\/span><svg /, 'the words first, and the line is the control');
  assert.doesNotMatch(html, /data-bot-settled-badges|data-bot-settled-badge=/);
  assert.doesNotMatch(html, /data-bot-final=/, 'the badges are gone from the line');
  assert.doesNotMatch(html, /<article /, 'folded: no rows');
  // A run of failures alone says only what went wrong.
  const onlyFailed = [botMessage({ kind: 'build_failed', issueNumber: 24 }), botMessage({ kind: 'first_version_failed', issueNumber: 25 })]
    .map((message) => ({ message, earlier: [], updates: null, focused: false }));
  const failedHtml = renderToHtml(createElement(SettledRun, { items: onlyFailed }));
  assert.match(failedHtml, /data-bot-settled-count="failed">2 couldn’t build<\/span>/);
  assert.doesNotMatch(failedHtml, /data-bot-settled-count="finished"/, 'zero parts are left out');
  const opened = renderToHtml(createElement(SettledRun, { items: items.map((item, index) => ({ ...item, focused: index === 0 })) }));
  assert.match(opened, /data-bot-settled-rows="">/, 'opened: whole rows under it');
  assert.match(opened, /data-bot-settled-words="">Live<\/span>/, 'an opened row says how it ended, in words after its title');
  const source = read(NEWS);
  assert.doesNotMatch(source, /RUN_BADGES/, 'no strip of squares to cap');
  assert.match(source, /data-bot-settled-count="failed"/);
  assert.match(source, /<div className="mt-1 flex flex-col" data-bot-settled-rows="">/, 'opened: whole rows under it');
  assert.match(source, /<BotNewsLine key=\{item\.message\.clientKey \|\| item\.message\.id\} message=\{item\.message\} earlier=\{item\.earlier\} updates=\{item\.updates\} focused=\{item\.focused\} \/>/);
  assert.match(source, /useEffect\(\(\) => \{ if \(focused\) setOpen\(true\); \}, \[focused\]\);/, 'a link into it opens it');
  // The transcript collects finished rows and draws two or more as one run.
  const screen = read('frontend/src/features/messages/index.tsx');
  assert.match(screen, /const settled = botDm && isBotNews\(message\) && !asks && !!newsStatusOf\(message, botWork\)\?\.settled;/);
  assert.match(screen, /if \(!settled \|\| \(day && day !== previousDay\) \|\| \(lineAt !== null && message\.id >= lineAt && !lineDrawn\)\) flushRun\(\);/, 'an open row, a new day or the "New" line ends a run');
  assert.match(screen, /if \(settledRun\.length === 1\) \{[\s\S]*?rows\.push\(<BotNewsLine[\s\S]*?\} else if \(settledRun\.length\) \{\s*rows\.push\(<SettledRun /, 'one alone stays a row');
  assert.match(screen, /if \(settled\) \{ settledRun\.push\(\{ message, earlier, updates, focused \}\); continue; \}/);
  assert.match(screen, /\n  flushRun\(\);\n  return \(/);
});

test('pressing "N finished" leaves it where it is on screen', () => {
  const screen = read('frontend/src/features/messages/index.tsx');
  assert.match(screen, /const holdPlace = \(el: HTMLElement\) => \{\s*pinned\.current = false;\s*const top = el\.getBoundingClientRect\(\)\.top;\s*return \(\) => \{\s*const box = scroller\.current;\s*const moved = el\.getBoundingClientRect\(\)\.top - top;\s*if \(box && moved\) box\.scrollTop \+= moved;/, 'not following the newest line for that press, and put back after the draw');
  assert.match(screen, /<SettledRun key=\{`settled-\$\{settledRun\[0\]\.message\.id\}`\} items=\{settledRun\} holdPlace=\{holdPlace\} \/>/);
  const source = read(NEWS);
  assert.match(source, /useIsomorphicLayoutEffect\(\(\) => \{\s*putBack\.current\?\.\(\);\s*putBack\.current = null;\s*\}, \[open\]\);/);
  assert.match(source, /if \(count\.current && holdPlace\) putBack\.current = holdPlace\(count\.current\);\s*setOpen\(!open\);/);
});

// Finished today, the drawer's folded group, went with the drawer (5 Nov
// 2026); a finished request's line in the chat says how it ended (below).

// ── #5392: one reading of the bot's work, grouped once ───────────────────

test('"today" is the local day: what ended since midnight, not the last 24 hours', () => {
  const { startOfDay, stripGroups } = strip();
  // NOW is midday; the day began at midnight on this device.
  const midnight = startOfDay(NOW).getTime();
  const yesterday = new Date(midnight - 10 * 60000).toISOString(); // 23:50 the day before
  const early = new Date(midnight + 5 * 60000).toISOString(); // 00:05 today
  const model = stripGroups(work(
    track(at('live'), { issueNumber: 1, step: 'live', since: yesterday }),
    track(at('live'), { issueNumber: 2, step: 'live', since: early }),
    track(at('closed'), { issueNumber: 3, since: early }),
    track(at('closed'), { issueNumber: 4, since: early, doneBy: { username: 'ben', prNumber: 4822 } }),
    track(at('live'), { issueNumber: 5, step: 'live', since: 'not a moment' }),
    track(at('stopped', { reason: 'build_failed' }), { issueNumber: 6, since: early }),
  ), NOW);
  assert.deepEqual(model.done.map((row) => row.track.issueNumber), [2, 3, 4], '23:50 yesterday is not finished today; 00:05 today is; no parsable since stays out');
  // Each says how it ended, in the ending's own word.
  assert.deepEqual(model.done.map((row) => row.state), ['Live', 'Closed', 'Done another way']);
  assert.deepEqual(model.needs.map((row) => row.track.issueNumber), [6], 'a stop waits for them to start it again, under Needs you');
});

test('a change up for a vote is Ready to try, whoever\'s yes it waits for', () => {
  const { stripGroups, summaryParts } = strip();
  const model = stripGroups(work(
    track(at('up_for_vote', { whoseMove: 'group' }), { issueNumber: 30, step: 'vote', waitingOn: 'group' }),
    track(at('up_for_vote'), { issueNumber: 31, step: 'vote' }),
  ), NOW);
  assert.deepEqual(model.ready.map((row) => row.track.issueNumber), [30, 31]);
  assert.deepEqual(model.ready.map((row) => row.state), ['Up for a vote', 'Up for a vote']);
  assert.deepEqual(model.needs, [], 'a vote is the group\'s to give, never a need of the requester\'s');
  assert.deepEqual(summaryParts(model).map((part) => part.text), ['2 ready to try']);
  // The drawer's Try it and Approve went with it (5 Nov 2026): the change's
  // ready card in the chat keeps both (./bot-ready.tsx).
  assert.doesNotMatch(read(STRIP), /tryChange|approveChange|noteApprovedHere/);
});

test('a hold and a change going live are In progress, never finished; the counts, in order', () => {
  const { stripGroups, summaryParts } = strip();
  const model = stripGroups(work(
    track(at('building', { line: { code: 'held_waiting' } }), { issueNumber: 40, held: { limit: 'slots', position: 1, until: null } }),
    track(at('reading', { line: { code: 'on_hold' } }), { issueNumber: 41, held: { limit: 'allowance', position: null, until: '2026-10-19T09:00:00Z' } }),
    track(at('going_live'), { issueNumber: 42, step: 'live', since: ago(5) }),
    track(at('waiting_for_you', { why: 'plan' }), { issueNumber: 43, step: 'plan', askId: 44 }),
  ), NOW);
  assert.deepEqual(model.progress.map((row) => row.track.issueNumber), [40, 41, 42], 'none of it has ended');
  assert.equal(model.progress[0].state, 'Ready to build · Next in line for a slot', 'the stage\'s word leads, then what it waits for');
  assert.match(model.progress[1].state, /^On hold until .+: this week's building time is used up$/, 'the allowance line says on hold, and until when');
  assert.equal(model.progress[2].state, 'Going live');
  assert.deepEqual(model.done, [], 'going live has not ended');
  const parts = summaryParts(model).map((part) => part.text);
  assert.deepEqual(parts, ['1 needs you', '3 in progress'], 'the groups in order, zero ones left out');
  assert.equal(parts.slice(0, 2).join(' · '), '1 needs you · 3 in progress', 'the row shows the first two parts');
});

test('a finished row wears its ending in words after its mark; a failed one says what went wrong', () => {
  const { SettledLine } = strip();
  const words = (outcome, withWords) => renderToHtml(createElement('div', null, createElement(SettledLine, {
    name: 'Plant Pal', slug: 'plant-pal', iconUrl: null, emoji: null, number: 51, title: 'Dark mode', outcome, fallback: 'Stopped', ...withWords,
  })));
  assert.match(words('build_failed', { words: 'Couldn’t build · Its build didn\'t finish' }), /data-bot-settled-words="">Couldn’t build · /, 'the words after the title');
  assert.doesNotMatch(words('live', { words: null }), /data-bot-settled-words/, 'no words, no span');
  assert.match(words('live', { words: 'Live' }), /data-bot-settled-words="">Live<\/span>/);
});

// ── 3. A request's number, in its own colour ─────────────────────────────

test('a request\'s number wears one of eight hues, neighbours apart, never the need amber or the action blue', () => {
  const { requestHue, requestKey } = loadTsx('frontend/src/features/messages/bot-request.ts');
  const hues = Array.from({ length: 8 }, (_, i) => requestHue(10 + i));
  assert.equal(new Set(hues).size, 8, 'any eight in a row all differ');
  assert.equal(requestHue(9), requestHue(17), 'eight apart share one');
  for (const hue of hues) {
    assert.ok(!(hue >= 25 && hue <= 60), `${hue} is not amber`);
    assert.ok(!(hue >= 195 && hue <= 240), `${hue} is not the action blue`);
  }
  assert.equal(requestKey({ appName: 'Plant Pal', issueNumber: 4 }), 'plant pal|4');
  assert.equal(requestKey({ appSlug: 'plant-pal', issueNumber: 4 }), 'plant-pal|4', 'the slug only when there is no name');
  assert.equal(requestKey({ appName: 'Plant Pal', firstVersion: true, issueNumber: 1 }), 'plant pal|first');
  assert.equal(requestKey({ appName: 'Plant Pal' }), null, 'no number: no request');
  assert.equal(requestKey({ issueNumber: 4 }), null, 'no project: no request');
});

test('the thread\'s header and the bot\'s own words wear the number\'s colour too', () => {
  const screen = read('frontend/src/features/messages/index.tsx');
  assert.match(screen, /\{request && !request\.firstVersion \? <RequestTag number=\{request\.number\} size="head" \/> : null\}/);
  const format = read('frontend/src/features/messages/format.tsx');
  assert.match(format, /if \(requestColors\) \{\s*for \(const chip of root\.querySelectorAll<HTMLElement>\('\.gc-ref-issue\[data-ref-number\]'\)\) \{[\s\S]*?chip\.classList\.add\('gc-ref-request'\);\s*chip\.style\.setProperty\('--req-h', String\(requestHue\(n\)\)\);/);
  const css = read('public/css/app.css');
  assert.match(css, /html \.messages-markdown \.gc-ref-issue\.gc-ref-request \{ color: hsl\(var\(--req-h\) 70% 26%\); background: hsl\(var\(--req-h\) 80% 92%\);/);
  assert.match(css, /html\.dark \.messages-markdown \.gc-ref-issue\.gc-ref-request \{ color: hsl\(var\(--req-h\) 80% 82%\); background: hsl\(var\(--req-h\) 35% 25%\); \}/);
  // The tag's own ink is the same four values, so the two never drift apart.
  assert.match(read(STRIP), /bg-\[hsl\(var\(--req-h\)_80%_92%\)\] text-\[hsl\(var\(--req-h\)_70%_26%\)\] dark:bg-\[hsl\(var\(--req-h\)_35%_25%\)\] dark:text-\[hsl\(var\(--req-h\)_80%_82%\)\]/);
});

// Polish board #22 (19 Oct 2026) pinned the Activity drawer's dismiss rules
// (a press outside, Escape, focus back to its bar); the drawer is gone.
