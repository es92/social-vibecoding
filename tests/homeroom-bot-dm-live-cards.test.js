'use strict';

// Three things the Homeroom bot's DM said wrong in the Page Turners run-
// through (5 October 2026), and what each says now.
//
//   1. THE READY CARD CATCHES UP. Alex's "Page Turners is ready to try"
//      card still said "It goes live when one more person approves" at
//      12:14, eighteen minutes after the change went live: a card is a
//      message, sent once. The DM's activity read now also says where each
//      ready card's change stands (homeroom-bot-dm.js readyStates): live
//      (with a button that opens the app), going live, closed, or up for
//      approval with who it waits on as it is now. A vote on the change
//      reads the requester's DM again (noteVoted).
//   2. "IT'S LIVE NOW." HAS A WAY IN. Its app card was refused (a group the
//      bot is not in), and the message went out as plain words. It carries
//      its own Open button now (openAppAction), which opens the app the way
//      the shell does (App.openAppTab).
//   3. DURATIONS COUNT THE WORK. Priya's request was filed at 11:10, held
//      for the first version until 11:56, interrupted by a deploy, built
//      again and up for approval at 12:20: its card said "1h so far" and
//      "took 1h 9m". The clock starts when the work did, a restart carries
//      it on, and the wait is said apart (homeroom-bot-activity.js
//      workClock): "took 24m, after waiting 46m for the first version".
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/homeroom-bot-dm-live-cards.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// What the services push, without a socket server: any other call is a no-op.
const noop = (target, value) => new Proxy(target, {
  get: (obj, key) => (key in obj ? obj[key] : (typeof key === 'string' && key !== '__esModule' && key !== 'then' ? () => value : undefined)),
});
const pushedTo = [];
const wsId = require.resolve('../src/services/ws');
require.cache[wsId] = {
  id: wsId, filename: wsId, loaded: true,
  exports: noop({
    pushToUser(id, event) { pushedTo.push([Number(id), event?.type]); return 1; },
  }, 0),
};
const pushId = require.resolve('../src/services/mobile-push');
require.cache[pushId] = {
  id: pushId, filename: pushId, loaded: true,
  exports: noop({}, false),
};

const dm = require('../src/services/homeroom-bot-dm');
const activity = require('../src/services/homeroom-bot-activity');

const READY = 'frontend/src/features/messages/bot-ready.tsx';
const CARD = 'frontend/src/features/messages/bot-activity.tsx';
const API = 'frontend/src/features/messages/api.ts';
const SHARED = 'frontend/src/features/messages/bot-shared.ts';

// ── 3. The work, not the wait ──

const at = (hhmm) => `2026-10-05T${hhmm}:00.000Z`;
const RESTARTED = `interrupted: the turn was lost ${require('../src/services/homeroom-bot').RESTARTED_BUILD_NOTE}`;

test('a card counts from when the work began: a hold before it is the wait, a restart carries it on', () => {
  // Priya's: filed (and its card sent) at 11:10, held for the first version.
  // Its first look began at 11:56 and its build was cut short by a deploy;
  // the look that started it again began at 12:01.
  const priya = {
    message_id: 50, app_id: 7, issue_number: 2, slug: 'page-turners', created_at: at('11:10'),
    first_at: at('11:10'), began: at('12:01'), look_at: at('12:01'), started_at: null, run_id: 91,
    earlier_runs: [{ at: at('11:57'), ms: 60 * 1000, restarted: true }],
  };
  assert.deepEqual(activity.workClock(priya), { workedFrom: at('11:56'), waitedFrom: at('11:10') },
    'from the look that began the build the restart cut short, never 11:10 and never 12:01');

  // Still waiting for the restart's look to begin: the stretch goes on.
  assert.deepEqual(activity.workClock({ ...priya, began: at('11:56'), look_at: at('11:56'), run_id: null, earlier_runs: null },
    { stage: 'queued' }), { workedFrom: at('11:56'), waitedFrom: at('11:10') });

  // Filed and still in line: nothing has begun, and the card's time is the wait.
  assert.deepEqual(activity.workClock({ ...priya, began: at('11:10'), look_at: null, run_id: null, earlier_runs: null },
    { stage: 'queued' }), { workedFrom: null, waitedFrom: null });

  // A look after an answer is a new stretch: the hours waiting for it are not work.
  assert.deepEqual(activity.workClock({
    ...priya, first_at: at('10:00'), began: at('14:00'), look_at: at('14:00'),
    earlier_runs: [{ at: at('10:02'), ms: 120 * 1000, restarted: false }],
  }), { workedFrom: at('14:00'), waitedFrom: null }, 'and the wait before it is not said: the card said it needed them');

  // Sent when the look began: from then, and no wait to say.
  assert.deepEqual(activity.workClock({ ...priya, began: at('11:10'), look_at: null, earlier_runs: null }),
    { workedFrom: at('11:10'), waitedFrom: null });
  // A wait under five minutes is not worth words.
  assert.deepEqual(activity.workClock({ ...priya, earlier_runs: null, began: at('11:14'), look_at: at('11:14') }),
    { workedFrom: at('11:14'), waitedFrom: null });
  // Moved under a plan: read from the plan's look, counted from the tap.
  assert.deepEqual(activity.workClock({ ...priya, first_at: at('11:30'), began: at('11:02'), look_at: at('11:02'), earlier_runs: null }),
    { workedFrom: at('11:30'), waitedFrom: null });

  // What the wait was for: the first version, when it went live while the
  // request waited (and the request is not the first version itself).
  const clock = activity.workClock(priya);
  assert.equal(activity.waitedFor(priya, clock, { liveAt: at('11:56'), issueNumber: 1 }), 'first_version');
  assert.equal(activity.waitedFor({ ...priya, issue_number: 1 }, clock, { liveAt: at('11:56'), issueNumber: 1 }), 'turn');
  assert.equal(activity.waitedFor(priya, clock, { liveAt: at('09:00'), issueNumber: 1 }), 'turn', 'live before it was filed');
  assert.equal(activity.waitedFor(priya, clock, null), 'turn');
  assert.equal(activity.waitedFor(priya, { workedFrom: at('11:56'), waitedFrom: null }, null), null);

  const card = activity.cardOf({
    ...priya, verdict: 'ready', proposal_session_id: 40, proposal_status: 'promoted', run_at: at('12:02'), proposal_at: at('12:20'),
  }, null, { firstVersion: { liveAt: at('11:56'), issueNumber: 1 } });
  assert.deepEqual([card.state, card.outcome, card.startedAt, card.workedFrom, card.waitedFor, card.endedAt],
    ['done', 'proposed', at('11:10'), at('11:56'), 'first_version', at('12:20')]);

  // The read hands the clock the card's earlier looks, newest first.
  const service = read('src/services/homeroom-bot-activity.js');
  assert.match(service, /AND r\.created_at >= c\.first_at AND r\.created_at < c\.began\s+ORDER BY r\.id DESC\s+LIMIT \$4/);
});

test('the card says the work\'s time, and the wait apart, in words', () => {
  const { BotActivityCardView, clockFrom, waitedText } = loadTsx(CARD);
  const meta = { kind: 'activity', appSlug: 'page-turners', appName: 'Page Turners', issueNumber: 2, askedText: 'Keep a list of the books we have read' };
  const links = { request: '#app/page-turners/dev/issues/2', proposal: null };
  const building = {
    messageId: 50, state: 'working', startedAt: at('11:10'), workedFrom: at('11:56'), waitedFor: 'first_version', links,
    step: 3, of: 6, stepName: 'Build it', doing: 'building it', outcome: null, endedAt: null, typicalMinutes: { from: 10, to: 25 },
  };
  const draw = (card, now = new Date(at('12:12'))) => renderToHtml(createElement(BotActivityCardView, { meta, card, loaded: true, now }));
  assert.match(draw(building), /<span> · 16m so far, after waiting 46m for the first version<\/span>/, 'not "1h so far"');
  const built = { ...building, state: 'done', outcome: 'proposed', endedAt: at('12:20'), step: null, of: null, doing: null };
  // One request, one story: "Ready to try · waiting for approval".
  assert.match(draw(built), />Waiting for approval<\/span><span> · took 24m, after waiting 46m for the first version<\/span>/,
    'not "took 1h 9m"');
  assert.match(draw({ ...built, waitedFor: 'turn' }), /took 24m, after waiting 46m for its turn</);
  assert.match(draw({ ...built, waitedFor: undefined }), /<span> · took 24m<\/span>/);
  // #4242: built, and its ready card not out yet: being checked, with the spinner, never "waiting for approval".
  const checking = { ...built, outcome: 'checking' };
  assert.match(draw(checking), /Built it\. Checking it before you try it</);
  assert.match(draw(checking), /data-progress-ring-spinning=""/);
  assert.doesNotMatch(draw(checking), /Waiting for approval/);
  // #4227: going live spins too; waiting for approval and a person's look do not.
  // One request, one story: "Approved · going live"; a change a person must
  // look at first stopped ("Stopped: it's built, but a person needs to look").
  assert.match(draw({ ...built, outcome: 'going_live' }), /data-progress-ring-spinning=""[\s\S]*>Approved<[\s\S]*>Going live</);
  assert.doesNotMatch(draw(built), /data-progress-ring-spinning/);
  assert.match(draw({ ...built, outcome: 'needs_look' }), />Stopped<[\s\S]*It’s built, but a person needs to look at it</);
  // Nothing begun yet: its time is the wait, under words that say it waits.
  const queued = { ...building, workedFrom: null, waitedFor: undefined, step: 2, doing: 'waiting for the first version to go live' };
  assert.match(draw(queued, new Date(at('11:40'))), /<span> · 30m so far<\/span>/);
  assert.equal(clockFrom(queued), at('11:10'));
  assert.equal(waitedText({ ...building, workedFrom: at('11:10') }), null, 'no wait at all says nothing');
  for (const html of [draw(building), draw(built)]) assert.doesNotMatch(html, /—/);

  // The client keeps the work's start only as a date, and the wait only as one it knows.
  const { normalizeBotActivity } = loadTsx(API);
  const [kept, odd] = normalizeBotActivity({
    cards: [
      { messageId: 50, state: 'working', startedAt: at('11:10'), workedFrom: at('11:56'), waitedFor: 'first_version', links: {} },
      { messageId: 51, state: 'done', outcome: 'proposed', workedFrom: 'soon', waitedFor: 'lunch', links: {} },
    ],
  });
  assert.deepEqual([kept.workedFrom, kept.waitedFor], [at('11:56'), 'first_version']);
  assert.deepEqual([odd.workedFrom, 'waitedFor' in odd], [null, false]);
});

// ── 2. "It's live now." gets a way in ──

test('the live news carries its own button to open the app, as the shell opens one', async (t) => {
  assert.deepEqual(dm.openAppAction({ slug: 'page-turners', appName: 'Page Turners' }), {
    id: 'open_app', label: 'Open Page Turners', style: 'primary', type: 'open', target: '#app/page-turners/app',
  });
  assert.equal(dm.openAppAction({ slug: 'a b', appName: 'A b' }).target, '#app/a%20b/app');
  assert.equal(dm.openAppAction({ slug: 'x', appName: 'y'.repeat(80) }).label.length <= 46, true, 'a long name is cut');
  // Its words point at the button, card or no card.
  const line = '**Page Turners**, its first version';
  // One story (contract 2.2): "Your first version is live."
  assert.equal(dm.mergedText({ line, appName: 'Page Turners', live: true }), `${line}\n\nYour first version is live. Open Page Turners to try it.`);
  const merged = read('src/services/homeroom-bot-dm.js');
  const fn = merged.slice(merged.indexOf('async function noteProposalMerged('), merged.indexOf('// ── A person writing to the bot'));
  assert.match(fn, /const open = platform \? null : openAppAction\(\{ slug: run\.slug, appName: context\.appName \}\);/);
  // #4231: a new project's first version also offers its community and inviting people.
  assert.match(fn, /const actions = open \? \[open, \.\.\.\(context\.firstVersion \? firstLiveActions\(\{ slug: run\.slug \}\) : \[\]\)\] : \[\];/);
  assert.match(fn, /\.\.\.\(actions\.length \? \{ actions \} : \{\}\),/);
  assert.deepEqual(dm.firstLiveActions({ slug: 'page turners' }), [
    { id: 'open_community', label: 'Open community', style: 'secondary', type: 'open', target: '#app/page%20turners/workshop' },
    { id: 'invite_people', label: 'Invite people', style: 'secondary', type: 'invite' },
  ]);
  assert.deepEqual(dm.firstLiveActions({ slug: '' }), []);
  assert.doesNotMatch(fn, /withoutCards/, 'nothing it says depends on a card arriving');

  // The client: an `open` button on a project's App tab opens it with
  // App.openAppTab, as the app's icon does; anything else, or no router, by address.
  const { appTabSlug, openAppTarget } = loadTsx(SHARED);
  assert.equal(appTabSlug('#app/page-turners/app'), 'page-turners');
  assert.equal(appTabSlug('#app/a%20b/app'), 'a b');
  assert.equal(appTabSlug('#app/page-turners/dev/issues/2'), null);
  assert.equal(appTabSlug('#app/%E0%A4%A/app'), null);
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'window');
  t.after(() => { if (saved) Object.defineProperty(globalThis, 'window', saved); else delete globalThis.window; });
  const opened = [];
  globalThis.window = { App: { openAppTab: (slug, tab) => opened.push([slug, tab]) }, location: { hash: '#messages/5' } };
  openAppTarget('#app/page-turners/app');
  assert.deepEqual(opened, [['page-turners', 'app']]);
  assert.equal(window.location.hash, '#messages/5', 'the router moves, not the address by hand');
  openAppTarget('#app/page-turners/dev/issues/2');
  assert.equal(window.location.hash, '#app/page-turners/dev/issues/2');
  openAppTarget('https://example.test/');
  assert.equal(window.location.hash, '#app/page-turners/dev/issues/2', 'never off the platform');
  globalThis.window = { location: { hash: '' } };
  openAppTarget('#app/page-turners/app');
  assert.equal(window.location.hash, '#app/page-turners/app', 'no router: the address');
  // #4231: the community page is a door to its hub, so it lands on the hub.
  const landed = [];
  globalThis.window = { AppView: { _landOnHub: (slug) => landed.push(slug) }, location: { hash: '' } };
  openAppTarget('#app/page-turners/workshop');
  assert.deepEqual([landed, window.location.hash], [['page-turners'], '#app/page-turners/workshop']);

  const store = read('frontend/src/features/messages/store.ts');
  assert.match(store, /if \(action\.type === 'open'\) \{\n\s+openAppTarget\(action\.target\);\n\s+return;\n\s+\}/);
});

// ── 1. The ready card, as it stands now ──

const META = {
  kind: 'proposal', appName: 'Page Turners', appSlug: 'page-turners', askedText: 'Our little book club',
  ready: { group: true, last: false, waitingOn: ['priya_t1006', 'mo_t1006'], more: 0, missing: 2, needed: 2 },
  actions: dm.readyActions({ sessionId: 40, epoch: 0, approve: true }), status: 'open', sessionId: 40, epoch: 0, firstVersion: true,
};
const OPEN = { id: 'open_app', label: 'Open Page Turners', style: 'primary', type: 'open', target: '#app/page-turners/app' };

test('the card is drawn as its change stands now: live, going live, closed, or who it waits on now', () => {
  const { ReadyCardView, readyCardState, readyNow } = loadTsx(READY);
  const approvedMeta = {
    ...META, status: 'answered', chosen: 'approve',
    goesLive: { soon: false, at: null, missing: 1, waitingOn: ['priya_t1006', 'mo_t1006'], more: 0 },
  };
  // Where it stands now wins over what the card was sent saying...
  assert.equal(readyCardState({ meta: approvedMeta, fresh: { messageId: 1, state: 'live', actions: [OPEN] } }), 'live');
  assert.equal(readyCardState({ meta: META, fresh: { messageId: 1, state: 'going_live', actions: [] } }), 'going_live');
  assert.equal(readyCardState({ meta: META, fresh: { messageId: 1, state: 'closed', actions: [] } }), 'withdrawn');
  // ...but a card a newer version replaced stays that, and points at it.
  assert.equal(readyCardState({ meta: { ...META, status: 'closed', updated: true }, fresh: { messageId: 1, state: 'live', actions: [] } }), 'updated');
  // Approved here, on another device, or as read now.
  assert.equal(readyCardState({ meta: approvedMeta }), 'approved');
  assert.equal(readyCardState({ meta: META, approved: true }), 'approved');
  const yesIn = { messageId: 1, state: 'open', actions: [], approval: { missing: 1, needed: 2, last: false, approved: true, waitingOn: ['priya_t1006', 'mo_t1006'], more: 0 } };
  assert.equal(readyCardState({ meta: META, fresh: yesIn }), 'approved');
  assert.equal(readyCardState({ meta: META }), 'open');
  assert.equal(readyCardState({ meta: META, stale: true }), 'stale');

  const draw = (props) => renderToHtml(createElement(ReadyCardView, { meta: META, state: 'open', actions: META.actions, ...props }));
  // 12:14 on 5 October, read now: live. #4228: no Open of its own, the
  // news right under it carries the one.
  const live = draw({ meta: approvedMeta, state: 'live', actions: [], fresh: { messageId: 1, state: 'live', actions: [] } });
  assert.match(live, /data-bot-ready="live"/);
  assert.match(live, />It’s live\.</);
  assert.doesNotMatch(live, /data-bot-ready-action|Open Page Turners/);
  assert.doesNotMatch(live, /data-progress-ring-spinning/, 'live is done: its check');
  // #4227: going live, and approved with only going live left, spin.
  assert.match(draw({ state: 'going_live', actions: [] }), /data-progress-ring-spinning=""/);
  assert.doesNotMatch(live, /goes live when|Approve<|Try it</, 'no promise about a change already live, and nothing left to approve');
  assert.match(draw({ state: 'going_live', actions: [] }), />It’s approved and going live now\.</);
  assert.match(draw({ state: 'withdrawn', actions: [] }), />This change was closed without going live\.</);

  // Up for approval: who it waits on as it stands now, not as it was sent.
  assert.match(draw(), /Needs 2 approvals from you, @priya_t1006 or @mo_t1006/, 'as sent');
  const priyaSaidYes = { messageId: 1, state: 'open', actions: [], approval: { missing: 1, needed: 2, last: true, approved: false, waitingOn: ['mo_t1006'], more: 0 } };
  assert.doesNotMatch(draw({ fresh: priyaSaidYes }), /data-bot-ready-waiting/, 'his Yes is the last one it needs now: no list');
  const oneIn = { ...priyaSaidYes, approval: { ...priyaSaidYes.approval, last: false, waitingOn: ['priya_t1006', 'mo_t1006'] } };
  assert.match(draw({ fresh: oneIn }), /Needs one more approval from you, @priya_t1006 or @mo_t1006/);
  assert.deepEqual(readyNow(META.ready, oneIn), { ...META.ready, missing: 1, needed: 2, last: false });
  assert.equal(readyNow(META.ready, null), META.ready);

  // Approved: what happens next as read now, over what the vote said then.
  const soon = { ...yesIn, goesLive: { soon: true, at: null, missing: 0, waitingOn: [], more: 0 } };
  assert.match(draw({ meta: approvedMeta, state: 'approved', actions: [], fresh: soon }), />You approved it\. It goes live in a minute or two\.</);
  assert.match(draw({ meta: approvedMeta, state: 'approved', actions: [], fresh: soon }), /data-progress-ring-spinning=""/);
  assert.doesNotMatch(draw({ meta: approvedMeta, state: 'approved', actions: [] }), /data-progress-ring-spinning/, 'still waiting on others: nothing under way');
  assert.match(draw({ meta: approvedMeta, state: 'approved', actions: [] }),
    />You approved it\. It goes live after one more approval from @priya_t1006 or @mo_t1006\.</, 'nothing read yet: as it was');
  for (const html of [live, draw({ state: 'going_live', actions: [] }), draw({ state: 'withdrawn', actions: [] })]) {
    assert.doesNotMatch(html, /propos|merg|vote|—/i);
  }

  // The card reads its change from the DM's activity read; live, it has no buttons (#4228).
  const card = read(READY);
  assert.match(card, /const fresh = snap\.ready\.get\(message\.id\) \|\| null;/);
  assert.match(card, /: state === 'stale' \? all\.filter\([^\n]+\)\n\s+: \[\];/);
  assert.doesNotMatch(card, /openAppTarget/);
});

test('the client keeps a ready card\'s state only as one it knows, and only the live card\'s Open button', () => {
  const { normalizeBotReadyNow } = loadTsx(API);
  const read = normalizeBotReadyNow({
    ready: [
      { messageId: 61, state: 'live', actions: [OPEN, { id: 'x', label: 'Elsewhere', type: 'open', target: 'https://example.test' }] },
      { messageId: 62, state: 'open', actions: [OPEN], approval: { missing: 1, needed: 2, last: false, approved: true, waitingOn: ['ada', 7, ''], more: -2 }, goesLive: { soon: true } },
      { messageId: 63, state: 'going_live' },
      { messageId: 64, state: 'merged' },
      { state: 'live' },
      { messageId: 65, state: 'open', approval: { missing: 'one' } },
    ],
  });
  assert.deepEqual(read.map((r) => r.messageId), [61, 62, 63, 65], 'an unknown state, or no message, is dropped');
  assert.deepEqual(read[0].actions, [OPEN], 'only an in-app Open');
  assert.deepEqual(read[1], {
    messageId: 62, state: 'open', actions: [],
    approval: { missing: 1, needed: 2, last: false, approved: true, waitingOn: ['ada'], more: 0 },
    goesLive: { soon: true, at: null, missing: 0, waitingOn: [], more: 0 },
  });
  assert.equal('approval' in read[3], false, 'counts that are not counts are not drawn');
  assert.deepEqual(normalizeBotReadyNow(null), []);
});

test('a vote on one of the bot\'s changes reads its requester\'s DM again', () => {
  const votes = read('src/routes/votes.js');
  const route = votes.slice(votes.indexOf('const goesLive = vote === \'yes\''), votes.indexOf('const voteLabel = session.pr_title'));
  assert.ok(route.indexOf('if (reasonOnly) {') < route.indexOf('noteVoted(pool, session.id'), 'after a real change of vote only');
  // One story: with who voted and how, so a yes is a quiet line in the request's thread.
  assert.match(route, /void require\('\.\.\/services\/homeroom-bot-dm'\)\.noteVoted\(pool, session\.id, \{ voter: req\.user, vote \}\);/);
  const store = read('frontend/src/features/messages/bot-activity-store.ts');
  assert.match(store, /ready: new Map\(ready\.map\(\(entry\) => \[entry\.messageId, entry\]\)\),/);
});

// ── Against the full PostgreSQL schema ──

test('Page Turners, read as it stands: the ready card after each Yes and after the merge, and Priya\'s card timed from its work',
  { timeout: 180000 }, async (t) => {
    let pg;
    try { pg = require('pg'); } catch { t.skip('the pg driver is not installed'); return; }
    const admin = new pg.Pool({ connectionString: DSN, connectionTimeoutMillis: 2000, max: 1 });
    try { await admin.query('SELECT 1'); } catch (err) {
      await admin.end();
      if (process.env.TEST_DATABASE_URL) throw err;
      t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
      return;
    }
    const name = `hrbot_live_cards_${crypto.randomBytes(6).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(DSN); url.pathname = `/${name}`;
    const pool = new pg.Pool({ connectionString: String(url), max: 6 });
    pool.on('error', () => {});
    t.after(async () => {
      await pool.end().catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {});
      await admin.end().catch(() => {});
    });
    await pool.query(read('src/db/schema.sql'));
    const governance = require('../src/services/governance');

    const user = async (username, synthetic = false) => (await pool.query(
      `INSERT INTO users (username, password, has_platform_access, is_synthetic) VALUES ($1, 'x', TRUE, $2)
       RETURNING id, username, is_synthetic AS "isSynthetic", has_platform_access AS "hasPlatformAccess"`,
      [username, synthetic],
    )).rows[0];
    const bot = await user('homeroom_bot', true);
    const alex = await user('alex_t1005');
    const priya = await user('priya_t1006');
    const mo = await user('mo_t1006');
    const lee = await user('lee');
    const set = (key, value) => pool.query(
      `INSERT INTO platform_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value],
    );
    await set('homeroom_bot_mode', 'live');
    const { rows: [inserted] } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility, repo_url)
       VALUES ('Page Turners', 'page-turners', 'running', $1, 'private', 'private', 'https://github.com/usernode-bot/page-turners')
       RETURNING id`,
      [alex.id],
    );
    const app = (await pool.query('SELECT id, slug, name, community_id FROM apps WHERE id = $1', [inserted.id])).rows[0];
    for (const m of [alex, priya, mo]) {
      await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [app.community_id, m.id]);
      await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`, [app.id, m.id]);
      await pool.query(
        `INSERT INTO app_activity (app_id, user_id, date, seconds_spent) VALUES ($1, $2, CURRENT_DATE, 120) ON CONFLICT DO NOTHING`,
        [app.id, m.id],
      );
    }
    governance.invalidateGovernance(app.id);

    // The first version: Alex's, up for approval and ready to try.
    const { rows: [first] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, session_title, promoted_at, check_state, linked_issues)
       VALUES ($1, $2, 'bot-page-turners-1', 'promoted', 'First version', NOW(), 'passing', '{1}') RETURNING id`,
      [app.id, bot.id],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_first_versions (app_id, user_id, brief, status, issue_number, filed_at)
       VALUES ($1, $2, 'Our little book club', 'filed', 1, NOW())`,
      [app.id, alex.id],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title, first_version, asked_text) VALUES
         ($1, 1, $2, 'First version', TRUE, 'Our little book club'),
         ($1, 2, $3, 'Books we have read', FALSE, 'Could it also keep a list of the books we have already read')`,
      [app.id, alex.id, priya.id],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, proposal_session_id, build_ok)
       VALUES ($1, 1, 'live', 'ready', $2, TRUE)`,
      [app.id, first.id],
    );
    await dm.noteChangeReady(pool, first.id, { bot, domain: 'app.example.test' });
    const { rows: [sent] } = await pool.query(
      `SELECT m.id, m.metadata->'homeroomBot' AS meta FROM homeroom_bot_dm_messages d JOIN conversation_messages m ON m.id = d.message_id
        WHERE d.user_id = $1 AND d.kind = 'proposal'`,
      [alex.id],
    );
    assert.ok(sent?.meta?.ready, 'Alex has his ready card');
    const needed = sent.meta.ready.needed;
    assert.ok(needed >= 2, 'a group of three needs more than his Yes');
    const ready = async (who = alex) => dm.readyStates(pool, { user: { id: who.id } });
    const yes = (who) => pool.query(`INSERT INTO pr_votes (session_id, user_id, vote, approval_epoch) VALUES ($1, $2, 'yes', 0)`, [first.id, who.id]);

    await t.test('up for approval: who it waits on, as it stands', async () => {
      const [now] = await ready();
      assert.equal(now.messageId, Number(sent.id));
      assert.equal(now.state, 'open');
      assert.deepEqual([now.approval.missing, now.approval.needed, now.approval.approved], [needed, needed, false]);
      assert.deepEqual(now.approval.waitingOn.sort(), [mo.username, priya.username]);
      assert.equal('goesLive' in now, false, 'nothing about what happens next before his Yes');
    });

    await t.test('after his Yes, and then Priya\'s: what happens next moves with them', async () => {
      await yes(alex);
      await dm.noteApproved(pool, first.id, alex.id);
      const [mine] = await ready();
      assert.equal(mine.approval.approved, true);
      assert.equal(mine.approval.missing, needed - 1);
      assert.equal(mine.goesLive.soon, false);
      assert.equal(mine.goesLive.missing, needed - 1);
      // Priya says Yes elsewhere: Alex's DM is told to read again, and his card says so.
      pushedTo.length = 0;
      await yes(priya);
      assert.equal(await dm.noteVoted(pool, first.id), alex.id, 'whoever asked for it');
      assert.deepEqual(pushedTo, [[alex.id, 'homeroom_bot_work_changed']]);
      const [after] = await ready();
      if (needed === 2) assert.ok(after.goesLive.soon || after.goesLive.missing === 0, 'two of three: it has the approvals it needs');
      else assert.equal(after.goesLive.missing, needed - 2);
      assert.equal(after.approval.missing, Math.max(needed - 2, 0));
      assert.equal(await dm.noteVoted(pool, 999999), null, 'one indexed read for a change that is not the bot\'s');
    });

    await t.test('merged: the card says it is live, with no button of its own (#4228)', async () => {
      await pool.query(`UPDATE chat_sessions SET status = 'merged', merged_at = $2 WHERE id = $1`, [first.id, at('11:56')]);
      const [live] = await ready();
      assert.deepEqual(live, { messageId: Number(sent.id), state: 'live', actions: [] });
      const read = await activity.cardsFor(pool, { user: { id: alex.id }, deps: {} });
      assert.deepEqual(read.ready, [live], 'the DM\'s activity read carries it');
      // Being merged, and closed without going live.
      await pool.query(`UPDATE chat_sessions SET status = 'merging' WHERE id = $1`, [first.id]);
      assert.equal((await ready())[0].state, 'going_live');
      await pool.query(`UPDATE chat_sessions SET status = 'closed' WHERE id = $1`, [first.id]);
      assert.equal((await ready())[0].state, 'closed');
      await pool.query(`UPDATE chat_sessions SET status = 'merged' WHERE id = $1`, [first.id]);
    });

    await t.test('only the reader\'s own cards, on a project they can still view', async () => {
      assert.deepEqual(await ready(priya), [], 'Alex\'s card is not Priya\'s');
      assert.deepEqual(await ready(lee), []);
      await pool.query('DELETE FROM app_collaborators WHERE app_id = $1 AND user_id = $2', [app.id, alex.id]);
      await pool.query('DELETE FROM community_members WHERE community_id = $1 AND user_id = $2', [app.community_id, alex.id]);
      await pool.query('UPDATE apps SET created_by = $2 WHERE id = $1', [app.id, priya.id]);
      assert.deepEqual(await ready(), [], 'a project he can no longer view says nothing');
      await pool.query('UPDATE apps SET created_by = $2 WHERE id = $1', [app.id, alex.id]);
      await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member')`, [app.id, alex.id]);
      await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [app.community_id, alex.id]);
      assert.equal((await ready()).length, 1);
    });

    await t.test('Priya\'s card counts from 11:56, through the restart, and says it waited for the first version', async () => {
      const settings = await require('../src/services/homeroom-bot').readSettings(pool);
      const { rows: [queued] } = await pool.query(
        `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason) VALUES ($1, 2, 1, 'new') RETURNING id`, [app.id],
      );
      const filed = await activity.startCard(pool, { inDm: true,
        app, issueNumber: 2, bot, jobKey: Number(queued.id), filed: true, settings,
        requester: {
          userId: priya.id, username: priya.username, hasPlatformAccess: true, issueTitle: 'Books we have read', firstVersion: false, askedText: 'Keep a list',
        },
      });
      assert.ok(filed?.messageId, 'her card, sent when she filed it');
      await pool.query('UPDATE homeroom_bot_dm_messages SET created_at = $2 WHERE message_id = $1', [filed.messageId, at('11:10')]);
      // Filed and waiting: nothing has begun.
      const waiting = (await activity.cardsFor(pool, { user: { id: priya.id }, settings })).cards.find((c) => c.messageId === filed.messageId);
      assert.deepEqual([waiting.state, waiting.workedFrom], ['working', null]);
      assert.equal(waiting.startedAt, at('11:10'));

      // 11:56 the first look; its build, cut short by the deploy; 12:01 the look again.
      await pool.query('DELETE FROM homeroom_bot_queue WHERE id = $1', [queued.id]);
      await pool.query(
        `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_ok, build_error, created_at, duration_ms)
         VALUES ($1, 2, 'live', 'ready', FALSE, $2, $3, 60000)`,
        [app.id, RESTARTED, at('11:57')],
      );
      await dm.setQuestionState(pool, filed.messageId, { lookAt: at('12:01') }, { userId: priya.id });
      const { rows: [build] } = await pool.query(
        `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, session_title, created_at, active_turn)
         VALUES ($1, $2, 'bot-page-turners-2', 'active', 'Books we have read', $3, '{"mode":"build"}') RETURNING id`,
        [app.id, bot.id, at('12:03')],
      );
      const { rows: [again] } = await pool.query(
        `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_session_id, created_at, duration_ms)
         VALUES ($1, 2, 'live', 'ready', $2, $3, 60000) RETURNING id`,
        [app.id, build.id, at('12:02')],
      );
      const building = (await activity.cardsFor(pool, { user: { id: priya.id }, settings })).cards.find((c) => c.messageId === filed.messageId);
      assert.deepEqual([building.state, building.stage, building.workedFrom, building.waitedFor],
        ['working', 'building', at('11:56'), 'first_version'], 'never from 11:10, never again from 12:01');

      // Up for approval at 12:20: it took 24 minutes, after 46 waiting.
      await pool.query(`UPDATE chat_sessions SET status = 'promoted', promoted_at = $2 WHERE id = $1`, [build.id, at('12:20')]);
      await pool.query('UPDATE homeroom_bot_runs SET proposal_session_id = $2, build_ok = TRUE WHERE id = $1', [again.id, build.id]);
      const built = (await activity.cardsFor(pool, { user: { id: priya.id }, settings })).cards.find((c) => c.messageId === filed.messageId);
      assert.deepEqual([built.state, built.outcome, built.startedAt, built.workedFrom, built.endedAt, built.waitedFor],
        ['done', 'checking', at('11:10'), at('11:56'), at('12:20'), 'first_version'], '#4242: no ready card has gone out to her yet');
    });
  });

// ── #4238: a new project's first version, said in its channel ──

test('#4238: a first version is announced once in the project\'s channel, by the bot, with its Open button', async () => {
  assert.equal(dm.firstVersionText({ appName: 'Page Turners', live: true }),
    'I\'ve made the first version of Page Turners! Let me know if you need anything else.');
  assert.equal(dm.firstVersionText({ appName: 'Page Turners', live: false }),
    'I\'ve made the first version of Page Turners! It will be ready to open in a few minutes. Let me know if you need anything else.');
  const sent = [];
  const ws = { async sendFirstVersionMessage(_pool, appId, msg) { sent.push([appId, msg]); return { id: 1 }; } };
  const bot = { id: 42, username: 'homeroom_bot' };
  const run = { app_id: 7, slug: 'page-turners', name: 'Page Turners' };
  assert.deepEqual(await dm.announceFirstVersion({}, run, { live: true, deps: { ws, bot } }), { id: 1 });
  assert.deepEqual(sent, [[7, {
    user: bot,
    content: 'I\'ve made the first version of Page Turners! Let me know if you need anything else.',
    metadata: { appSlug: 'page-turners', actions: [dm.openAppAction({ slug: 'page-turners', appName: 'Page Turners' })] },
  }]]);
  // It never stops the DM: a failure is logged and answered with null.
  const broken = { async sendFirstVersionMessage() { throw new Error('db down'); } };
  assert.equal(await dm.announceFirstVersion({}, run, { deps: { ws: broken, bot } }), null);

  // Only a first version, and never the platform's own app.
  const merged = read('src/services/homeroom-bot-dm.js');
  const fn = merged.slice(merged.indexOf('async function noteProposalMerged('), merged.indexOf('// ── A person writing to the bot'));
  assert.match(fn, /if \(requester\?\.firstVersion && !platform\) await announceFirstVersion\(pool, run, \{ live, deps \}\);/);
  assert.ok(fn.indexOf('announceFirstVersion(') < fn.indexOf('if (!requester || !hasBot(settings, requester)) return null;'),
    'said in the channel whether or not the maker gets the DM');
});
