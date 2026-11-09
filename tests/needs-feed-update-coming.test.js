'use strict';

// #6282 (4 Nov 2026): a change with an update on its way asks for no vote.
//
// The shared predicate (homeroom-bot-progress.js updateComingSql) and the
// windows it reads are pinned against the bot's own constants; standing()
// puts the change under In progress as Updating (a turn runs, or the bot
// holds an ask it took) or under Waiting as Update queued (an ask waits its
// turn); the AI tab's two words and the Votes card's held button are read
// here too. The feed itself, against a real database, is
// tests/needs-feed-update-coming-postgres.test.js.
//
// Run with: node --test tests/needs-feed-update-coming.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const progress = require('../src/services/homeroom-bot-progress');
const { standing, arrange } = require('../src/services/ai-work');

test('#6348: an update stops holding once its change has a newer head', () => {
  // A turn marker older than a turn may run is one that died without
  // releasing it; the longest turn is src/workflow/turn/machine.ts MAX_TURN_MS.
  const machine = read('src/workflow/turn/machine.ts');
  const hours = Number(machine.match(/export const MAX_TURN_MS = (\d+) \* 60 \* 60 \* 1000;/)[1]);
  assert.equal(hours, 6);
  assert.equal(progress.UPDATE_TURN_HOURS, hours);
  // Both clauses name the head the ask was made against...
  const coming = progress.updateComingSql('cs');
  const asked = progress.updateAskSql('cs');
  for (const sql of [coming, asked]) {
    assert.match(sql, /asked_head_sha/);
    // ...and compare it with the change's current head: reviewed for a native
    // change, the PR head for an imported one.
    assert.match(sql, /reviewed_head_sha/);
    assert.match(sql, /imported_pr_head_sha/);
  }
  // The turn clause counts one only while it could still be running.
  assert.match(coming, /startedAt/);
  assert.match(coming, /make_interval\(hours => 6\)/);
  // recordAsk records the head the ask was made against.
  const voice = read('src/services/homeroom-bot-voice.js');
  const insert = voice.slice(voice.indexOf('INSERT INTO homeroom_bot_change_asks'));
  assert.match(insert.slice(0, insert.indexOf('RETURNING id')), /asked_head_sha/);
  assert.match(insert.slice(0, insert.indexOf('RETURNING id')), /reviewed_head_sha/);
});

test('#6282: the update-in-flight windows are the bot\'s own', () => {
  assert.equal(progress.UPDATE_TAKEN_HOURS, 3);
  assert.equal(progress.UPDATE_QUEUED_DAYS, 7);
  // homeroom-bot-voice.js owns STALE_ASK_HOURS: an ask taken longer ago than
  // this is put back to queued, so it must stop holding the vote with it.
  const voice = read('src/services/homeroom-bot-voice.js');
  assert.match(voice, /const STALE_ASK_HOURS = (\d+);/);
  assert.equal(progress.UPDATE_TAKEN_HOURS, Number(voice.match(/const STALE_ASK_HOURS = (\d+);/)[1]));
  // homeroom-bot.js sweepStrandedAsks reads queued asks younger than a week.
  assert.match(read('src/services/homeroom-bot.js'), /created_at > NOW\(\) - INTERVAL '7 days'/);
  assert.equal(progress.UPDATE_QUEUED_DAYS, 7);
});

// ── standing(): where an update on its way puts the change ──────────────
const NOW = new Date('2026-11-04T12:00:00Z');
const row = (over = {}) => ({
  state: 'open', kind: 'request', number: 6250, request_state: 'open',
  request_at: '2026-11-04T09:00:00Z', created_at: '2026-11-04T09:00:00Z',
  change_status: 'promoted', change_id: 42, change_user: 9, check_state: 'passing',
  voted: false, my_vote: null, by_agent: false, own: false,
  promoted_at: '2026-11-04T10:00:00Z', last_activity_at: '2026-11-04T11:00:00Z',
  ...over,
});
const ASK = 'drop the second credit line';

test('#6282: a change being updated is In progress, never the vote it would owe', () => {
  const at = '2026-11-04T11:00:00.000Z';
  const revising = { stage: 'building', why: null, reason: null, line: { code: 'revising' }, since: at };
  const queued = { stage: 'up_for_vote', why: null, reason: null, line: { code: 'update_queued' }, since: at };
  // The viewer (7) still owes the vote the feed would have asked for.
  assert.deepEqual(standing(row({ update_coming: 'running', update_ask: ASK }), 7, NOW), {
    group: 'next', work: revising, at, ask: ASK,
  });
  // A turn with nobody's ask behind it says only that it is updating.
  assert.deepEqual(standing(row({ update_coming: 'running', update_ask: null }), 7, NOW), { group: 'next', work: revising, at });
  // An ask waiting its turn is Waiting, Update queued.
  assert.deepEqual(standing(row({ update_coming: 'queued', update_ask: ASK }), 7, NOW), {
    group: 'waiting', work: queued, at, ask: ASK,
  });
  // With no update coming it is the Needs you feed's again (nothing here).
  assert.equal(standing(row({ update_coming: null }), 7, NOW), null);
  // The stored state says the same (services/work-state.js derive).
  const { derive } = require('../src/services/work-state');
  const facts = { app_id: 1, issue_number: 6250, mode: 'live', verdict: 'ready', build_ok: true, run_at: '2026-11-04T09:00:00Z',
    proposal_session_id: 42, proposal_status: 'promoted', check_state: 'passing', proposal_at: '2026-11-04T10:00:00Z' };
  assert.deepEqual([derive({ ...facts, update_coming: 'running' }).stage, derive({ ...facts, update_coming: 'running' }).line],
    ['building', { code: 'revising' }]);
  assert.deepEqual(derive({ ...facts, update_coming: 'queued' }).line, { code: 'update_queued' });

  // #6545: a change whose tests failed, with Homeroom bot's fix queued, is
  // Checking, not Up for a vote. Only a running update overrides that.
  const failingFix = { ...facts, check_state: 'failing', failed_checks: 4,
    queue_id: 9, enqueued_at: '2026-11-04T11:30:00Z', queue_reason: 'checks_failing' };
  const waiting = derive({ ...failingFix, update_coming: 'queued' });
  assert.deepEqual([waiting.stage, waiting.line], ['checking', { code: 'checks_failing', failing: 4 }]);
  const running = derive({ ...failingFix, update_coming: 'running' });
  assert.deepEqual([running.stage, running.line], ['building', { code: 'revising' }]);
  // The AI tab's fallback (services/ai-work.js fallbackState) agrees. With no
  // stored work state, a failing change with a queued update reads Checking.
  const fallback = standing(row({ check_state: 'failing', update_coming: 'queued' }), 7, NOW);
  assert.deepEqual([fallback.work.stage, fallback.work.line], ['checking', { code: 'checks_failing' }]);
  assert.equal(fallback.group, 'waiting');
});

test('#6282: the ask is one line of at most 80 characters', () => {
  const long = 'drop the second credit line and make the first one say what it is for, then reword the note above';
  const stand = standing(row({ update_coming: 'running', update_ask: long }), 7, NOW);
  assert.equal(stand.ask.length, 80);
  assert.ok(stand.ask.endsWith('…'));
  // Whitespace folds, so the tooltip stays one line.
  assert.equal(standing(row({ update_coming: 'running', update_ask: '  drop\nthe   second  ' }), 7, NOW).ask,
    'drop the second');
});

test('#6282: it is listed for who would vote and for its own people, not a voter from the thread', () => {
  const update = { update_coming: 'running', update_ask: ASK };
  const stage = (r) => r && `${r.work.stage}:${r.work.line?.code}`;
  // Its author (7) asked for it: In progress, even having voted.
  assert.equal(stage(standing(row({ ...update, change_user: 7 }), 7, NOW)), 'building:revising');
  assert.equal(stage(standing(row({ ...update, change_user: 7, voted: true, my_vote: 'yes' }), 7, NOW)), 'building:revising');
  // Someone who only follows it (own) sees it too.
  assert.equal(stage(standing(row({ ...update, own: true, voted: true }), 7, NOW)), 'building:revising');
  // Somebody who already voted and only wrote in the thread gets no row.
  assert.equal(standing(row({ ...update, voted: true, my_vote: 'yes' }), 7, NOW), null);
});

test('#6282: a more particular stage of the bot\'s still wins', () => {
  const at = '2026-11-04T11:30:00Z';
  // Fixing its tests says something more particular than an update.
  const fixing = { stage: 'building', why: null, reason: null, line: { code: 'fixing' }, since: at, requesterId: 7 };
  assert.equal(standing(row({ update_coming: 'running', update_ask: ASK, change_user: 7 }), 7, NOW, 99, fixing).work.line.code, 'fixing');
  // The stored state keeps the bot's own stage over an update (derive applies one only to a vote or its checks).
  const { derive } = require('../src/services/work-state');
  const facts = { app_id: 1, issue_number: 6250, mode: 'live', verdict: 'ready', build_ok: true, run_at: '2026-11-04T09:00:00Z',
    proposal_session_id: 42, proposal_status: 'promoted', check_state: 'failing', fix_queue_id: null };
  assert.notEqual(derive({ ...facts, update_coming: null }).line?.code, 'revising');
});

test('#6282: an update sorts with the work being fixed, and a queued one with the votes', () => {
  const base = {
    state: 'open', kind: 'request', request_state: 'open', slug: 'garden', name: 'Garden',
    icon_url: null, icon_emoji: null, repo_url: null,
    request_at: '2026-11-04T09:00:00Z', created_at: '2026-11-04T09:00:00Z',
  };
  const owed = (number, extra) => ({
    ...base, number, change_status: 'promoted', change_id: number, change_user: 9,
    check_state: 'passing', voted: false, by_agent: false, own: false,
    promoted_at: '2026-11-04T10:00:00Z', ...extra,
  });
  const ws = (stage, line) => ({ stage, why: null, reason: null, line, since: '2026-11-04T08:00:00Z', requesterId: 7 });
  const states = new Map([
    ['garden#1', ws('building', { code: 'fixing' })],
    ['garden#3', ws('reading', { code: 'queued', place: 1 })],
  ]);
  const lists = arrange([
    owed(2, { update_coming: 'running', update_ask: ASK, last_activity_at: '2026-11-04T11:00:00Z' }),
    { ...base, number: 1, request_id: 1, own: true },
    owed(4, { update_coming: 'queued', update_ask: ASK, last_activity_at: '2026-11-04T11:00:00Z' }),
    { ...base, number: 3, request_id: 3, own: true },
  ], 7, NOW, 99, states);
  const code = (r) => [r.number, r.work.line?.code];
  assert.deepEqual(lists.next.map(code), [[1, 'fixing'], [2, 'revising']]);
  assert.deepEqual(lists.waiting.map(code), [[4, 'update_queued'], [3, 'queued']], 'an update waits nearer to live than a read in line');
});

test('#6282: the AI tab says an update on its way in the stage words, with what was asked', () => {
  const { nextWords, shortWords, threadWhy } = loadTsx('frontend/src/features/ai/model.ts');
  const words = (p) => message(p.id, {
    ...p.values,
    ...Object.fromEntries(Object.entries(p.nested || {}).map(([k, q]) => [k, words(q)])),
  });
  const app = { slug: 'garden', name: 'Garden', icon_url: null, icon_emoji: null };
  const thread = (work, extra = {}) => ({
    threadId: 1, number: 12, kind: 'change', title: 'Bigger buttons', app, change: { id: 42, number: 12 },
    href: '#app/garden/dev/changes/12', group: 'next', work, at: null, ...extra,
  });
  const revising = { stage: 'building', line: { code: 'revising' } };
  const queued = { stage: 'up_for_vote', line: { code: 'update_queued' } };
  assert.equal(words(nextWords(thread(revising, { ask: ASK }))), 'Garden · #12 · Building · Updating the change');
  assert.equal(words(nextWords(thread(queued))), 'Garden · #12 · Up for a vote · An update is on its way');
  assert.equal(words(threadWhy(thread(revising, { ask: ASK }))), `Asked: ${ASK}`, 'what was asked is its second line');
  // On GitHub the change's number is written PR, not #.
  const onGithub = { ...app, changesOnGithub: true };
  assert.equal(words(nextWords(thread(revising, { app: onGithub }))), 'Garden · PR 12 · Building · Updating the change');
  assert.equal(words(nextWords(thread(queued, { app: onGithub }))), 'Garden · PR 12 · Up for a vote · An update is on its way');
  assert.equal(words(shortWords(thread(revising))), 'Building');
  assert.equal(words(shortWords(thread(queued))), 'Up for a vote');
});

// ── the Votes card ──────────────────────────────────────────────────────
function avContext() {
  const noop = () => {};
  const c = {
    console, App: { user: { id: 7, username: 'ada' }, currentApp: 'garden', currentTab: 'dev',
      _appUrl: (slug, tab, ref) => `#app/${slug}/${tab}/issues/${ref?.id}` },
    relTime: () => 'just now',
    document: { getElementById: () => null, querySelector: () => null, addEventListener: noop },
    localStorage: { getItem: () => null }, addEventListener: noop,
    setTimeout, clearTimeout, setInterval, clearInterval,
    location: { search: '', hash: '' }, URLSearchParams,
  };
  c.window = c;
  c.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  vm.createContext(c);
  for (const p of ['public/js/merge-status.js', 'public/js/app-view.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, p), 'utf8'), c);
  }
  vm.runInContext('globalThis.av = AppView', c);
  c.av.appData = { slug: 'garden', can_collaborate: true };
  c.av._proposalsCtx = { majority: 2, activeUsers: 5, locked: false };
  return c.av;
}

test('#6282: the Votes card says an update is coming and takes no vote', () => {
  const av = avContext();
  const item = {
    id: 42, status: 'promoted', user_id: 9, my_vote: null, check_state: 'passing',
    update_coming: 'running',
  };
  const card = { pill: { state: { key: 'needs_vote', yes: 1, no: 0, majority: 2 } } };
  const held = av._changeVotesView(item, card);
  assert.equal(held.hold, true);
  assert.notEqual(held.tone, 'ask');
  assert.equal(held.note[0], message('changes:page.votes.note.updateComing'));
  // The tally and who can vote stay as they were.
  assert.equal(held.label, 'Votes: 1 of 2 yes');
  assert.ok(held.note.some((line) => /Any of the 5 members/.test(line)));
  // With no update coming, it asks as it always did.
  const open = av._changeVotesView({ ...item, update_coming: null }, card);
  assert.equal(open.hold, undefined);
  assert.equal(open.tone, 'ask');
});

test('#6282: the Votes card offers no button while it is held', () => {
  const { ChangeGates } = loadTsx('frontend/src/features/dev-board/topic/change-head.tsx');
  const card = {
    actions: [
      { key: 'vote-yes', cls: 'gc-vote-btn-yes', label: 'Yes' },
      { key: 'vote-no', cls: 'gc-vote-btn-no', label: 'No' },
    ],
    rail: {},
  };
  const view = (hold) => ({
    number: 12, status: null, category: null, author: 'ada', at: null, time: '', timeTitle: '',
    via: null, thanks: false,
    votes: {
      name: 'Votes', figure: 'Needs 1 more yes', tone: hold ? 'muted' : 'ask', done: false,
      segments: [{ weight: 1, pct: 0, state: 'moving' }], label: '1 of 2',
      note: [hold ? 'An update is coming: votes cast now are cleared when it lands.' : 'Any of the 5 members can give it.'],
      ...(hold ? { hold: true } : {}),
    },
    testing: {
      name: 'Testing', figure: 'Checks passed', tone: 'done', done: true,
      segments: [{ weight: 1, pct: 100, state: 'done' }], label: 'Checks passed', note: [],
    },
    shots: { state: 'none', html: '', line: null },
  });
  const html = (hold) => renderToHtml(createElement(ChangeGates, { id: 42, card, v: view(hold) }));
  assert.doesNotMatch(html(true), /dev-vote-btn/);
  assert.match(html(true), /An update is coming/);
  assert.match(html(false), /dev-vote-btn/);
});
