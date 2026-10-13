'use strict';

// One request, one story: the chat with Homeroom bot, redrawn.
//
//   1. The activity drawer (frontend/src/features/messages/bot-strip.tsx):
//      its groups (Needs you, Ready to try, In progress, Done today, each
//      request once), each row's state words, number and button, the Activity
//      bar that opens it (closed until opened, remembered per device), and
//      nothing at all with nothing to show.
//   2. The main chat's news (frontend/src/features/messages/bot-news-line.tsx):
//      each request is ONE two-line row, its earlier news folded into its
//      newest; the second line says where it stands now, in the need colour
//      only while it waits on the person; a row opens the request's thread,
//      one from before threads opens in place; the bot's replies, offers and
//      hellos stay messages.
//   3. A request's number in its own colour (bot-request.ts), the same in
//      the drawer, the chat's rows, its thread's header and the bot's words.
//
// Run with: node --test tests/messages-bot-strip.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

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
let seq = 0;
const job = (extra = {}) => {
  seq += 1;
  return {
    key: `plant-pal#${extra.issueNumber || seq}`, appSlug: 'plant-pal', appName: 'Plant Pal', iconUrl: null, iconEmoji: null,
    issueNumber: seq, title: `Request ${seq}`, firstVersion: false, href: null, links: nowhere, earlier: [], ...extra,
  };
};
const working = (extra) => job({ phase: 'building', step: null, of: null, stepName: null, doing: null, since: null, ...extra });
const past = (extra) => job({ id: 1, outcome: 'live', doing: null, at: ago(60), ...extra });
const work = (extra) => ({ now: [], needsYou: [], history: [], ...extra });

function strip() { return loadTsx(STRIP); }
function draw(props) {
  const { BotStripView } = strip();
  return renderToHtml(createElement(BotStripView, { now: NOW, ...props }));
}

// ── 1. The strip ─────────────────────────────────────────────────────────

test('the groups, in order, each request once', () => {
  const { stripGroups } = strip();
  const asked = past({ title: 'Dinner rota', outcome: 'question', cardId: 31, ask: { messageId: 40, kind: 'question', question: 'Which night?' } });
  const stuck = past({ title: 'Print view', outcome: 'build_failed', ask: { messageId: 41, kind: 'build_failed' }, cardId: 32 });
  const quietStop = past({ title: 'Old stop', outcome: 'build_failed' });
  const ready = past({ title: 'Grey out', outcome: 'proposed', ready: { messageId: 50, sessionId: 9, epoch: 0, open: true, approve: true, waiting: null } });
  const building = working({ title: 'Totals', stage: 'building' });
  const held = working({ title: 'Held', stage: 'on_hold' });
  const live = past({ title: 'Went live', outcome: 'live', at: ago(50) });
  const oldLive = past({ title: 'Long ago', outcome: 'live', at: ago(60 * 30) });
  const model = stripGroups(work({
    now: [building, held],
    needsYou: [asked],
    history: [stuck, quietStop, ready, live, oldLive, { ...asked }],
  }), NOW);
  const titles = (rows) => rows.map((row) => row.job.title);
  assert.deepEqual(titles(model.needs), ['Dinner rota', 'Print view', 'Held'], 'a stop with an open ask needs them; one without does not');
  assert.deepEqual(titles(model.ready), ['Grey out']);
  assert.deepEqual(titles(model.progress), ['Totals'], 'on hold is not in progress');
  assert.deepEqual(titles(model.done), ['Went live'], 'done is the last day only');
  // The Needs you button opens the request's thread at what waits.
  assert.deepEqual([model.needs[0].rootId, model.needs[0].focusId], [31, 40]);
  assert.deepEqual(stripGroups(null), { needs: [], ready: [], progress: [], done: [] });
});

test('each row says one short thing: no step numbers, no timings', () => {
  const { needsRow, readyState, doingWord, stripTitle } = strip();
  const said = (extra) => needsRow(past(extra));
  assert.deepEqual(said({ outcome: 'question', ask: { messageId: 1, kind: 'question', question: 'Which night?' } }), { state: 'Which night?', action: 'messages:bot.strip.action.answer' });
  assert.equal(said({ outcome: 'question' }).state, 'Needs your answer');
  assert.deepEqual(said({ outcome: 'question', ask: { messageId: 1, kind: 'plan' } }), { state: 'Your plan is ready', action: 'messages:bot.strip.action.buildIt' });
  assert.deepEqual(said({ outcome: 'person', ask: { messageId: 1, kind: 'person' } }), { state: 'Needs your decision', action: 'messages:bot.strip.action.decide' });
  assert.deepEqual(said({ outcome: 'build_failed', stopCause: 'time' }), { state: 'Stopped: took too long', action: 'messages:bot.strip.action.tryAgain' });
  assert.equal(said({ outcome: 'build_failed' }).state, 'Stopped');
  assert.deepEqual(said({ outcome: 'blocked' }), { state: 'Can’t build it as written', action: 'messages:bot.strip.action.addDetail' });
  assert.deepEqual(said({ outcome: 'empty' }), { state: 'Nothing to build yet', action: 'messages:bot.strip.action.addDetail' });
  assert.deepEqual(said({ outcome: 'needs_look' }), { state: 'Needs a person to look', action: 'messages:bot.strip.action.open' });
  assert.equal(said({ outcome: 'stopped', ask: { messageId: 1, kind: 'checks' } }).state, 'Needs a person to look');
  assert.equal(needsRow(working({ stage: 'on_hold' })).state, 'On hold until Monday');
  assert.equal(said({ outcome: null, doing: 'waiting for its secrets' }).state, 'Waiting for its secrets');

  assert.equal(readyState(past({ outcome: 'proposed', ready: { approve: true } })), 'Ready for your yes');
  assert.equal(readyState(past({ outcome: 'proposed', ready: { approve: false, waiting: '@ada' } })), 'Waiting for @ada');
  assert.equal(readyState(past({ outcome: 'proposed' })), 'Waiting for approval');

  const words = (stage, phase = 'building') => doingWord(working({ stage, phase }));
  assert.deepEqual(
    [words('building'), words('planning'), words('reading', 'looking'), words('checks'), words('queued', 'queued'), words('revising', 'following_up'), words('merging', 'merging')],
    ['building', 'planning', 'reading', 'testing', 'in the queue', 'following up', 'going live'],
  );
  assert.equal(doingWord(working({ stage: null, phase: 'looking' })), 'reading', 'by its phase when no stage is said');

  assert.equal(stripTitle(job({ title: 'Dark mode', issueNumber: 4 })), 'Dark mode', 'no "Plant Pal #4:" prefix');
  assert.equal(stripTitle(job({ firstVersion: true, title: null })), 'Plant Pal, first version');
  assert.equal(stripTitle(job({ title: null, issueNumber: 9 })), 'Request #9');
});

test('a Needs you row has ONE button; a Ready row Try it and, when their yes counts, Approve', () => {
  const html = draw({
    remembered: true,
    work: work({
      needsYou: [past({ title: 'Dinner rota', outcome: 'question', cardId: 31, ask: { messageId: 40, kind: 'question', question: 'Which night?' } })],
      history: [
        past({ title: 'Grey out', outcome: 'proposed', ready: { messageId: 50, sessionId: 9, epoch: 0, open: true, approve: true, waiting: null } }),
        past({ title: 'Counts', outcome: 'proposed', ready: { messageId: null, sessionId: null, epoch: 0, open: true, approve: false, waiting: '@ada' } }),
      ],
    }),
  });
  const needs = html.slice(html.indexOf('data-bot-strip-group="needs"'), html.indexOf('data-bot-strip-group="ready"'));
  assert.equal((needs.match(/<button /g) || []).length, 1, 'one button on the row');
  assert.match(needs, /<button type="button" class="[^"]*bg-violet-600[^"]*" data-bot-strip-act="open">Answer<\/button>/);
  assert.match(needs, /Which night\?/);
  const ready = html.slice(html.indexOf('data-bot-strip-group="ready"'));
  assert.match(ready, /data-bot-strip-act="try">Try it<\/button><button type="button" class="[^"]*bg-violet-600[^"]*" data-bot-strip-act="approve">Approve<\/button>/);
  assert.equal((ready.match(/data-bot-strip-act="approve"/g) || []).length, 1, 'Approve only where their yes counts');
  assert.match(ready, /Waiting for @ada/);
  // Reused, not copied: the ready card's Try it and the vote endpoint it approves with.
  const source = read(STRIP);
  assert.match(source, /import \{ tryChange \} from '\.\/bot-ready';/);
  assert.match(source, /api\.approveChange\(sessionId, ready\?\.epoch \?\? null\)/);
  assert.match(source, /openThreadAt\(row\.rootId, row\.focusId\)/);
  // Opening a request closes the drawer; Try it and Approve leave it open.
  assert.match(source, /const onOpen = \(row: StripRow\) => \{ choose\(false\); openRow\(row\); \};/);
  assert.match(source, /data-bot-strip-act="try" onClick=\{tryIt\}/);
});

test('the drawer lists every request in its group, a row each with its number; In progress and Done today too', () => {
  const asks = Array.from({ length: 5 }, (_, i) => past({ title: `Ask ${i}`, outcome: 'question' }));
  const readies = Array.from({ length: 4 }, (_, i) => past({ title: `Ready ${i}`, outcome: 'proposed' }));
  const total = working({ title: 'Show a total under the list', stage: 'building' });
  const html = draw({
    remembered: true,
    work: work({
      needsYou: asks,
      history: [...readies, past({ title: 'Live one', outcome: 'live', at: ago(30) }), past({ title: 'Live two', outcome: 'going_live', at: ago(90) })],
      now: [total, working({ title: 'Add a search box', stage: 'planning' }), working({ title: 'C' }), working({ title: 'D' })],
    }),
  });
  assert.equal((html.match(/data-bot-strip-row="needs"/g) || []).length, 5, 'no "+N more": the drawer scrolls');
  assert.equal((html.match(/data-bot-strip-row="ready"/g) || []).length, 4);
  assert.equal((html.match(/data-bot-strip-row="progress"/g) || []).length, 4, 'In progress is a row each');
  assert.equal((html.match(/data-bot-strip-row="done"/g) || []).length, 2, 'Done today is listed');
  assert.doesNotMatch(html, /data-bot-strip-more/);
  assert.match(html, new RegExp(`data-request-tag="${total.issueNumber}">#${total.issueNumber}</span><span class="truncate[^"]*">Show a total under the list</span>`), 'its number, then its title');
  assert.match(html, /first-letter:uppercase[^"]*" data-bot-strip-state="">building</, 'what it is doing, capitalised on screen');
  assert.match(html, /class="[^"]*uppercase[^"]*">Done today</);
  assert.match(html, /5 need you<\/span>[\s\S]*4 ready to try[\s\S]*4 in progress[\s\S]*2 done today/);
});

test('the Activity bar: zero parts left out, the need part in the need colour with its numbers, and a chevron', () => {
  const { summaryParts, stripGroups } = strip();
  const one = stripGroups(work({ needsYou: [past({ outcome: 'question' })], history: [past({ outcome: 'proposed' })] }), NOW);
  assert.deepEqual(summaryParts(one).map((part) => part.text), ['1 needs you', '1 ready to try']);
  const asked = past({ outcome: 'question', issueNumber: 18 });
  const html = draw({ work: work({ needsYou: [asked], now: [working({})] }) });
  assert.match(html, /^<section class="relative z-20 shrink-0" aria-label="Your requests" data-bot-strip="closed"><button type="button" class="[^"]*" aria-expanded="false" data-bot-strip-toggle=""><span class="[^"]*">Activity<\/span>/);
  assert.match(html, /<span class="text-amber-700 dark:text-amber-400" data-bot-strip-count="needs">1 needs you<\/span><span class="ml-1 inline-flex gap-1 align-\[1px\]"><span class="[^"]*" style="--req-h:265" data-request-tag="18">#18<\/span><\/span><\/span><span><span aria-hidden="true"> · <\/span><span data-bot-strip-count="progress">1 in progress<\/span>/);
  assert.match(html, /<svg [^>]*aria-hidden="true"[^>]*>/, 'the chevron, from the icon set');
  assert.doesNotMatch(html, /data-bot-strip-drawer/, 'closed: the bar alone');
  const open = draw({ work: work({ needsYou: [asked] }), remembered: true });
  assert.match(open, /data-bot-strip="open"[\s\S]*aria-expanded="true"[\s\S]*data-bot-strip-scrim=""[\s\S]*data-bot-strip-drawer=""/, 'open: the dimmed chat and the drawer over it');
  assert.match(open, /class="[^"]*uppercase[^"]*text-amber-700[^"]*">Needs you</, 'its eyebrow in the need colour');
  assert.match(read(STRIP), /import \{ ChevronDownIcon \} from '@\/components\/ui\/icons';/);
});

test('the drawer starts closed whatever waits; open is remembered on the device; with nothing, nothing', () => {
  const busy = work({ needsYou: [past({ outcome: 'question' })] });
  assert.match(draw({ work: busy }), /data-bot-strip="closed"/, 'closed: the bar says what waits');
  assert.match(draw({ work: busy, remembered: true }), /data-bot-strip="open"/, 'left open, remembered');
  assert.match(draw({ work: busy, remembered: false }), /data-bot-strip="closed"/);
  assert.equal(draw({ work: work({}) }), '', 'nothing to show: nothing at all');
  assert.equal(draw({ work: null }), '', 'nothing until the first read');
  // Remembered per device, in localStorage, never trusted to be there.
  const source = read(STRIP);
  assert.match(source, /const HIDDEN_KEY = 'homeroom:botDrawer:open';/);
  assert.match(source, /try \{\s*const value = window\.localStorage\.getItem\(HIDDEN_KEY\);[\s\S]*?\} catch \{\s*return null;\s*\}/);
  assert.match(source, /try \{ window\.localStorage\.setItem\(HIDDEN_KEY, open \? '1' : '0'\); \} catch/);
});

test('the strip is pinned under the bot chat\'s header and its sub-line says what the bot is for', () => {
  const screen = read('frontend/src/features/messages/index.tsx');
  assert.match(screen, /\{embedded \? null : <ThreadHeader \/>\}\s*(?:\{\/\*[^\n]*\*\/\}\s*)?\{botDm && !embedded \? <BotStrip \/> : null\}/);
  assert.doesNotMatch(screen, /BotWorkPanel|BotWorkButton|BotWorkStatusLine/);
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

test('each row says where its request stands under its title, in the need colour while it waits on them', () => {
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
  ];
  // Before the tray's first read (as here), a row says what its message rang as.
  for (const [meta, words, need] of cases) {
    const html = line(botMessage(meta));
    const label = JSON.stringify(meta);
    assert.match(html, /<span class="flex min-w-0 items-center gap-1\.5"><span class="[^"]*" style="--req-h:322" data-request-tag="4">#4<\/span><strong class="[^"]*">Dark mode<\/strong><\/span>/, label);
    assert.match(html, new RegExp(`<span class="truncate text-\\[13px\\] leading-\\[18px\\] first-letter:uppercase ${need ? 'text-amber-700 dark:text-amber-400' : 'text-zinc-500 dark:text-zinc-400'}" data-bot-news-words="">${words}</span>`), label);
  }
  // A first version has no number to wear.
  assert.doesNotMatch(line(botMessage({ kind: 'merged', firstVersion: true })), /data-request-tag/);
});

test('with the tray read, a row says where its request stands NOW: amber only while it waits; an ask that moved on, in the past', () => {
  const { newsStatus } = loadTsx(NEWS);
  const { trayNow } = strip();
  const meta = (extra) => ({ appName: 'Plant Pal', appSlug: 'plant-pal', issueNumber: 4, kind: 'question', ...extra });
  const tray = trayNow(work({
    needsYou: [past({ issueNumber: 4, outcome: 'question', ask: { messageId: 1, kind: 'question', question: 'Which night?' } })],
    history: [past({ issueNumber: 6, outcome: 'proposed', ready: { approve: true } })],
    now: [working({ issueNumber: 7, stage: 'building' })],
  }));
  assert.deepEqual(newsStatus(meta({}), tray), { text: 'Which night?', need: true }, 'still waiting: the drawer\'s words, amber');
  assert.deepEqual(newsStatus(meta({ issueNumber: 6, kind: 'question' }), tray), { text: 'Ready for your yes', need: false }, 'moved on: where it is now');
  assert.deepEqual(newsStatus(meta({ issueNumber: 7, kind: 'activity' }), tray), { text: 'building', need: false });
  assert.deepEqual(newsStatus(meta({ issueNumber: 9, kind: 'question' }), tray), { text: 'Asked you a question', need: false }, 'gone from the tray: an ask, in the past');
  assert.deepEqual(newsStatus(meta({ issueNumber: 9, kind: 'plan' }), tray), { text: 'Sent you a plan', need: false });
  assert.deepEqual(newsStatus(meta({ issueNumber: 9, kind: 'build_failed' }), tray), { text: 'Stopped', need: false }, 'never amber once it no longer waits');
  assert.deepEqual(newsStatus(meta({ issueNumber: 9, kind: 'question' }), null), { text: 'Needs your answer', need: true }, 'before the first read: as it rang');
  assert.deepEqual(newsStatus(meta({ appName: 'Other', issueNumber: 4 }), tray), { text: 'Asked you a question', need: false }, 'a number is matched within its project');
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
  const html = renderToHtml(createElement(loadTsx(NEWS).BotNewsLine, { message: a2, earlier: [a1], updates: 5, full: () => createElement('p', null, 'FULL') }));
  assert.match(html, new RegExp(`<span id="messages-message-${a1.id}" aria-hidden="true"></span>`));
  assert.match(html, /data-bot-thread-link="\d+"> · 5 updates ›<\/span>/);
  const screen = read('frontend/src/features/messages/index.tsx');
  assert.match(screen, /const newsFold = botDm \? foldBotNews\(snap\.messages, \(message\) => isMovedActivity\(message\) \|\| plans\.hidden\.has\(message\.id\)\) : null;/);
  assert.match(screen, /const updates = root\?\.thread\?\.replyCount \|\| \(earlier\.length \? earlier\.length \+ 1 : 0\);/);
  assert.match(screen, /focused=\{flashId === message\.id \|\| earlier\.some\(\(item\) => item\.id === flashId\)\}/);
  assert.match(screen, /\{\[\.\.\.earlier, message\]\.map\(\(item\) => \(\s*<MessageRow/, 'opened in place, every card it holds');
});

test('a line keeps the message\'s id and opens its thread; one from before threads opens in place', () => {
  const { newsThread, newsTitle } = loadTsx(NEWS);
  const moment = botMessage({ kind: 'question', requestTitle: 'Dinner rota', alsoInChat: true, threadRootId: 31 }, { threadRootId: 31 });
  const html = line(moment);
  assert.match(html, new RegExp(`^<article id="messages-message-${moment.id}" data-message-id="${moment.id}" class="messages-bot-news px-4 py-1" data-bot-news="question">`));
  assert.match(html, /data-bot-news-open="thread"/);
  assert.match(html, />Dinner rota<\/strong>/, 'the request\'s own title first');
  assert.equal(newsThread(moment), 31);
  // A card with its thread opens that thread, and says how many updates it holds.
  const card = botMessage({ kind: 'activity' }, { thread: { replyCount: 5, lastReplyAt: null, participants: [], lastReply: null } });
  assert.equal(newsThread(card), card.id);
  assert.match(line(card), /I’ve started on it<span class="text-violet-700 dark:text-violet-300" data-bot-thread-link="\d+"> · 5 updates ›<\/span><\/span>/);
  // An old card, from before threads: no thread to open, so it opens in place.
  const old = botMessage({ kind: 'proposal' });
  assert.equal(newsThread(old), null);
  assert.match(line(old), /aria-expanded="false" data-bot-news-open="inline"/);
  const source = read(NEWS);
  assert.match(source, /if \(open\) return <>\{full\(\)\}<\/>;/, 'opened, it is the whole message as it was drawn');
  assert.match(source, /if \(rootId\) openThreadAt\(rootId, message\.threadRootId \? message\.id : null\);\s*else setOpen\(true\);/);
  assert.equal(newsTitle({ kind: 'merged', appName: 'Plant Pal', issueNumber: 1, firstVersion: true }), 'Plant Pal, first version');
  assert.equal(newsTitle({ kind: 'merged', appName: 'Plant Pal', issueNumber: 9 }), 'Request #9');
});

test('a line wears the project\'s icon the strip has, else its initial', () => {
  const { newsIcon } = loadTsx(NEWS);
  const job = (appSlug, iconUrl, iconEmoji, appName = 'Project') => ({ appSlug, appName, iconUrl, iconEmoji });
  const work = {
    now: [job('plants', null, null)],
    needsYou: [job(null, null, '🧪', 'Staging demo app')],
    history: [job('plants', null, '🌱'), job('rota', '/app-icons/7', null)],
  };
  assert.deepEqual(newsIcon(work, 'plants'), { iconUrl: null, iconEmoji: '🌱' }, 'the first entry with artwork, wherever it is');
  assert.deepEqual(newsIcon(work, 'rota'), { iconUrl: '/app-icons/7', iconEmoji: null });
  assert.deepEqual(newsIcon(work, 'elsewhere'), { iconUrl: null, iconEmoji: null });
  assert.deepEqual(newsIcon(null, 'plants'), { iconUrl: null, iconEmoji: null }, 'before the tray loads: the initial');
  assert.deepEqual(newsIcon(work, null, 'Staging demo app'), { iconUrl: null, iconEmoji: '🧪' }, 'a project with no slug, by its name');
  assert.deepEqual(newsIcon(work, null, 'Project'), { iconUrl: null, iconEmoji: null }, 'a name never matches a project that has a slug');
  assert.match(read(NEWS), /iconUrl=\{icon\.iconUrl\} emoji=\{meta\.appEmoji \|\| icon\.iconEmoji\}/);
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
  assert.match(screen, /if \(botDm && isBotNews\(message\)\) \{[\s\S]{0,400}?rows\.push\(<BotNewsLine/);
});

test('the thread pane opens at the message a Needs you button names, and flashes it', () => {
  const store = read('frontend/src/features/messages/store.ts');
  assert.match(store, /export function openThreadAt\(rootId: number \| null \| undefined, focusId: number \| null \| undefined = null\): void \{/);
  assert.match(store, /publish\(\{ threadFocusId: validId\(focusId\) && focusId !== rootId \? focusId : null \}\);\s*openThread\(rootId\);/);
  const screen = read('frontend/src/features/messages/index.tsx');
  const pane = screen.slice(screen.indexOf('function ReplyThreadPanel()'), screen.indexOf('function AppReplyThreadPanel('));
  assert.match(pane, /const wanted = snap\.threadFocusId \|\| snap\.route\.focusMessageId \|\| null;/);
  assert.match(pane, /el\.querySelector<HTMLElement>\(`\[id="messages-message-\$\{wanted\}"\]`\)/, 'its own row, not the line in the chat beside it');
  assert.match(pane, /focused=\{flashId === message\.id\}/);
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
