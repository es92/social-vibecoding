'use strict';

// #3624 stage 2: how much the Homeroom bot works on at once.
//
// Live work (every app but a paused one) is started one issue at a time:
// never two on one app (the bot has one session per app) unless one is a
// follow-up on its own proposal (#3703, below), at most `perPerson` for one
// person, at most `liveAtOnce` in all. Shadow triage, where nothing is live
// (a staging copy), runs in slots of its own. And a pass does not wait for
// the work it starts, so a long build on one app never holds up an answer on
// another.
//
// Run with: node --test tests/homeroom-bot-at-once.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const bot = require('../src/services/homeroom-bot');

const row = (id, appId, personId, extra = {}) => ({
  id, app_id: appId, issue_number: id, priority: 1, reason: 'new', person_id: personId, ...extra,
});

test('pickLive: one per app, at most perPerson for anybody, at most `slots` in all, in queue order', () => {
  const candidates = [
    row(1, 10, 7), row(2, 10, 7), // two on app 10: only the first
    row(3, 11, 7), row(4, 12, 7), // a third app for person 7: over their 2
    row(5, 13, 8), row(6, 14, null), // person 8, and an issue nobody on Homeroom filed
  ];
  const picks = bot.pickLive(candidates, { busyAppIds: [], active: [], slots: 6, perPerson: 2 });
  assert.deepEqual(picks.map((p) => p.id), [1, 3, 5, 6]);
  assert.deepEqual(picks.map((p) => p.person), ['u7', 'u7', 'u8', 'a14'], 'nobody filed it: it counts as its app');

  // What already runs counts: person 7 has one going, app 13 is busy.
  const more = bot.pickLive(candidates, {
    busyAppIds: [13], active: [{ person: 'u7' }], slots: 6, perPerson: 2,
  });
  assert.deepEqual(more.map((p) => p.id), [1, 6]);

  // The platform ceiling.
  assert.deepEqual(bot.pickLive(candidates, { slots: 1, perPerson: 2 }).map((p) => p.id), [1]);
  assert.deepEqual(bot.pickLive(candidates, { slots: 0, perPerson: 2 }), []);
});

/** A pool that answers the loop's queries, with live candidates to start. */
function loopPool({ settings, candidates = [], apps = [], waiting = [] }) {
  const log = [];
  const client = {
    async query(sql) {
      if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ acquired: true }] };
      return { rows: [] };
    },
    release() {},
  };
  const pool = {
    log,
    async connect() { return client; },
    async query(sql, params) {
      const s = String(sql);
      log.push({ s, params });
      if (/SELECT key, value FROM platform_settings/.test(s)) return { rows: settings };
      if (/FROM users WHERE username = \$1/.test(s)) return { rows: [{ id: 77, username: 'homeroom_bot', weekly_limit_cents: 15000 }] };
      if (/SELECT is_synthetic FROM users/.test(s)) return { rows: [{ is_synthetic: true }] };
      if (/COALESCE\(r\.user_id, i\.created_by\) AS person_id/.test(s) && /WHERE q\.started_at IS NULL/.test(s)) {
        // As the query reads: nothing on a backed-off app ($2), and only a
        // follow-up on an app whose session is taken ($5).
        return {
          rows: candidates.filter((c) => !params[1].includes(c.app_id)
            && (c.follow_up_session_id != null || !(params[4] || []).includes(c.app_id))),
        };
      }
      // Live builds waiting their turn (liveBuildCandidates).
      if (/WHERE r\.live_build_waiting_at IS NOT NULL AND r\.mode = 'live'/.test(s)) return { rows: waiting };
      if (/FROM apps WHERE id = ANY\(\$1::int\[\]\)/.test(s)) return { rows: apps.filter((a) => params[0].includes(a.id)) };
      if (/SET started_at = NOW\(\) WHERE id = \$1 AND started_at IS NULL RETURNING id/.test(s)) return { rows: [{ id: params[0] }] };
      return { rows: [] };
    },
  };
  return pool;
}

// Every app but a paused one is live, so these need no setting to be.
const LIVE = ['a1', 'a2', 'a3', 'a4'];
const APPS = LIVE.map((slug, i) => ({ id: 101 + i, slug, name: slug, repo_url: `https://github.com/o/${slug}`, self_hosted: false }));

test('runOnce starts live work and returns without waiting for it; a finished slot hands back what it did not use', async () => {
  bot._resetForTests();
  const settings = [
    { key: bot.KEY_MODE, value: 'shadow' },
    { key: bot.KEY_PER_PERSON, value: '2' },
    { key: bot.KEY_LIVE_AT_ONCE, value: '6' },
  ];
  const candidates = [row(1, 101, 7), row(2, 102, 7), row(3, 103, 7), row(4, 104, 8)];
  const pool = loopPool({ settings, candidates, apps: APPS });
  // Each turn waits at its budget check until the test lets it go, then
  // finds the weekly cap spent: work that started and ended without a turn.
  let release;
  const gate = new Promise((r) => { release = r; });
  const deps = {
    drain: false,
    github: { isEnabled: () => true, async fetchPublicIssues() { return { issues: [] }; } },
    limits: { async checkBudget() { await gate; return { error: true, reason: 'weekly_cap' }; } },
    worker: { async listWorkerVolumes() { return []; } },
  };
  const out = await bot.runOnce(pool, {}, deps);
  assert.equal(out.dispatched, 3, 'person 7 gets two apps, person 8 one');
  assert.equal(out.inFlight, 3, 'and the pass returned while all three were still running');
  const running = bot._inFlightForTests();
  assert.deepEqual(running.map((r) => r.appId).sort(), [101, 102, 104]);
  assert.ok(running.every((r) => r.lane === 'live'));
  assert.deepEqual(pool.log.filter((l) => /SET started_at = NOW\(\) WHERE id = \$1 AND started_at IS NULL/.test(l.s)).map((l) => l.params[0]),
    [1, 2, 4], 'each row is claimed before its work starts');

  release();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(bot._inFlightForTests().length, 0, 'the slots are free again');
  const handedBack = pool.log.filter((l) => /UPDATE homeroom_bot_queue SET started_at = NULL WHERE id = \$1/.test(l.s)).map((l) => l.params[0]);
  assert.deepEqual(handedBack.sort(), [1, 2, 4], 'a row the cap stopped is handed back, not left claimed');

  // The cap stops dispatch until the idle pass, rather than on every completion.
  const again = await bot.runOnce(pool, {}, deps);
  assert.equal(again.paused, 'budget');
  assert.equal(again.dispatched, undefined);
  bot._resetForTests();
});

test('a pass only fills free slots: what runs keeps its app and its person\'s place', async () => {
  bot._resetForTests();
  const settings = [
    { key: bot.KEY_MODE, value: 'shadow' },
    { key: bot.KEY_PER_PERSON, value: '2' },
    { key: bot.KEY_LIVE_AT_ONCE, value: '2' },
  ];
  const candidates = [row(1, 101, 7), row(2, 102, 8), row(3, 103, 9)];
  const pool = loopPool({ settings, candidates, apps: APPS });
  let release;
  const gate = new Promise((r) => { release = r; });
  const deps = {
    drain: false,
    github: { isEnabled: () => true, async fetchPublicIssues() { return { issues: [] }; } },
    limits: { async checkBudget() { await gate; return { error: true }; } },
    worker: { async listWorkerVolumes() { return []; } },
  };
  const first = await bot.runOnce(pool, {}, deps);
  assert.equal(first.dispatched, 2, 'the platform ceiling');
  const second = await bot.runOnce(pool, {}, deps);
  assert.equal(second.dispatched, 0, 'no free slot, nothing new starts');
  release();
  await new Promise((r) => setTimeout(r, 20));
  bot._resetForTests();
});

test('shadow triage runs in its own lane and never takes an app the bot acts on', async () => {
  bot._resetForTests();
  const heads = [];
  const settings = [
    { key: bot.KEY_MODE, value: 'shadow' },
    { key: bot.KEY_PAUSED_APPS, value: '["quiet"]' },
  ];
  const pool = loopPool({ settings });
  const real = pool.query.bind(pool);
  pool.query = async (sql, params) => {
    if (/FROM homeroom_bot_queue q JOIN apps/.test(String(sql))) heads.push(params);
    return real(sql, params);
  };
  const env = process.env.USERNODE_ENV;
  delete process.env.USERNODE_ENV;
  try {
    await bot.runOnce(pool, {}, {
      github: { isEnabled: () => true, async fetchPublicIssues() { return { issues: [] }; } },
      worker: { async listWorkerVolumes() { return []; } },
    });
    assert.ok(heads.length, 'the background lane looked for a batch');
    // Every app but a paused one is live, so every live app is left out
    // ($4/$5: all of them but the paused), and the paused one is left out
    // as paused ($2): nothing is the background lane's.
    assert.deepEqual(heads[0].slice(1), [['quiet'], [], true, ['quiet']], 'with the live apps left out');
    assert.ok(pool.log.some((l) => /AS person_id/.test(l.s) && /WHERE q\.started_at IS NULL/.test(l.s)), 'the live lane reads');

    // A staging copy never acts, so every app is the background lane's.
    process.env.USERNODE_ENV = 'staging';
    heads.length = 0;
    pool.log.length = 0;
    bot._resetForTests();
    await bot.runOnce(pool, {}, {
      github: { isEnabled: () => true, async fetchPublicIssues() { return { issues: [] }; } },
      worker: { async listWorkerVolumes() { return []; } },
    });
    assert.deepEqual(heads[0].slice(1), [['quiet'], [], false, []], 'only a paused app left out');
    assert.ok(!pool.log.some((l) => /AS person_id/.test(l.s) && /WHERE q\.started_at IS NULL/.test(l.s)), 'no live lane at all');
  } finally {
    if (env === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = env;
  }
  bot._resetForTests();
});

test('a row still being worked on is not handed back by the stale-claim sweep', async () => {
  bot._resetForTests();
  const settings = [
    { key: bot.KEY_MODE, value: 'shadow' },
  ];
  const pool = loopPool({ settings, candidates: [row(9, 101, 7)], apps: APPS });
  let release;
  const gate = new Promise((r) => { release = r; });
  const deps = {
    drain: false,
    github: { isEnabled: () => true, async fetchPublicIssues() { return { issues: [] }; } },
    limits: { async checkBudget() { await gate; return { error: true }; } },
    worker: { async listWorkerVolumes() { return []; } },
  };
  await bot.runOnce(pool, {}, deps);
  pool.log.length = 0;
  await bot.runOnce(pool, {}, deps);
  const sweep = pool.log.find((l) => /SET started_at = NULL\s+WHERE started_at IS NOT NULL/.test(l.s));
  assert.match(sweep.s, /AND NOT \(id = ANY\(\$2::int\[\]\)\)/);
  assert.deepEqual(sweep.params[1], [9]);
  release();
  await new Promise((r) => setTimeout(r, 20));
  bot._resetForTests();
});

test('the loop asks for its next pass when work ends, and the tick never waits for work', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/services/homeroom-bot.js'), 'utf8');
  assert.match(src, /const out = await runOnce\(getPool\(config\), config, \{ drain: false \}\);/);
  assert.match(src, /if \(o\.paused !== 'budget' && o\.paused !== 'infra'\) requestPass\(\);/);
});

// ── #3703: a reply on the bot's own proposal ─────────────────────────────
//
// evan asked a question in the discussion of the bot's proposal on his Ear
// Trainer project and heard nothing for eleven minutes: the reply was
// queued at once, but the project's one live slot was building another
// request, and when it freed a newer request was taken first. A follow-up
// runs on the proposal's own session, so it no longer waits for the app's.

const followUp = (id, appId, personId, extra = {}) => row(id, appId, personId, {
  priority: 2, reason: 'changed', follow_up_session_id: 5000 + id, ...extra,
});

test('pickLive: a follow-up on the bot\'s own proposal neither waits for its app nor holds it', () => {
  // The app's session is building another request: the reply still starts.
  let picks = bot.pickLive([followUp(1, 10, 7), row(2, 10, 7)], {
    busyAppIds: [10], active: [{ person: 'u7' }], slots: 6, perPerson: 2,
  });
  assert.deepEqual(picks.map((p) => [p.id, p.followUp]), [[1, true]]);

  // It takes no app: the app's next request can start beside it.
  picks = bot.pickLive([followUp(1, 10, 7), row(2, 10, 8), row(3, 10, 8)], { slots: 6, perPerson: 2 });
  assert.deepEqual(picks.map((p) => [p.id, p.followUp]), [[1, true], [2, false]], 'and still one request per app');

  // It is still one of its person's slots, and one of the platform's.
  assert.deepEqual(bot.pickLive([followUp(1, 10, 7)], {
    active: [{ person: 'u7' }, { person: 'u7' }], slots: 6, perPerson: 2,
  }), []);
  assert.deepEqual(bot.pickLive([followUp(1, 10, 7)], { slots: 0, perPerson: 2 }), []);
  // An app backed off after its session refused a turn starts nothing on
  // that session; a follow-up runs on its proposal's, and has a backoff of
  // its own (followUpsBackedOff), so the app's does not hold it.
  assert.deepEqual(bot.pickLive([row(2, 10, 8)], { blockedAppIds: [10], slots: 6, perPerson: 2 }), []);
  assert.deepEqual(bot.pickLive([followUp(1, 10, 7)], { blockedAppIds: [10], slots: 6, perPerson: 2 }).map((p) => p.id), [1]);
});

test('a follow-up refused a turn backs off that follow-up alone, not its app', () => {
  bot._resetForTests();
  const now = Date.parse('2026-10-03T12:00:00Z');
  const first = bot.noteFollowUpRefusal(10, 5, 'session_busy', now);
  assert.equal(first.attempts, 1);
  assert.deepEqual(bot.followUpsBackedOff(now + 1000), ['10:5']);
  assert.equal(bot.noteFollowUpRefusal(10, 5, 'session_busy', now).delayMs, first.delayMs * 2, 'doubling, as an app\'s does');
  bot.clearFollowUpRefusals(10, 5);
  assert.deepEqual(bot.followUpsBackedOff(now + 1000), []);
  bot.noteFollowUpRefusal(10, 6, 'session_busy', now);
  assert.deepEqual(bot.followUpsBackedOff(now + 61 * 60 * 1000), [], 'and past its window it is dropped');
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src/services/homeroom-bot.js'), 'utf8');
  assert.match(src, /const \{ attempts, delayMs \} = followUpTurn\n\s+\? noteFollowUpRefusal\(app\.id, issueNumber, error\)\n\s+: noteRefusal\(app\.id, error\);/);
  assert.match(src, /followUpTurn = true;\n\s+return runFollowUp\(/);
});

test('the live queue reads which rows are follow-ups, lets only them past a busy app, and takes them first', async () => {
  const asked = [];
  const pool = { async query(sql, params) { asked.push({ s: String(sql), params }); return { rows: [] }; } };
  await bot.liveCandidates(pool, {
    liveSlugs: ['a1'], excludeAppIds: [103], busyAppIds: [101], botId: 77, pausedApps: [], excludeFollowUps: ['101:5'],
  });
  const { s, params } = asked[0];
  // The last two are a scope's every-app flag and what it leaves out
  // (live.liveScope): a bare list of slugs is just those apps.
  assert.deepEqual(params, [['a1'], [103], [], 200, [101], 77, ['101:5'], 7, false, []]);
  // Plant Pal #1 and #3: a request whose live build waits or runs is read
  // once that build ends, whatever queued it.
  assert.match(s, /AND NOT EXISTS \(\s+SELECT 1 FROM homeroom_bot_runs b\s+WHERE b\.app_id = q\.app_id AND b\.issue_number = q\.issue_number/);
  // The bot's own proposal on the issue, still up for a vote: what runTriage
  // follows up on (live.openBotProposal, runFollowUp).
  assert.match(s, /cs\.user_id = \$6\s+AND q\.issue_number = ANY\(cs\.linked_issues\)\s+AND cs\.status = 'promoted' AND cs\.is_headless = FALSE/);
  assert.match(s, /fu\.id AS follow_up_session_id/);
  assert.match(s, /AND \(fu\.id IS NOT NULL OR NOT \(q\.app_id = ANY\(\$2::int\[\]\)\)\)/, 'a backed-off app: follow-ups only');
  assert.match(s, /AND \(fu\.id IS NULL OR NOT \(\(q\.app_id::text \|\| ':' \|\| q\.issue_number::text\) = ANY\(\$7::text\[\]\)\)\)/,
    'and a follow-up backed off on its own: not that one');
  assert.match(s, /AND \(fu\.id IS NOT NULL OR NOT \(q\.app_id = ANY\(\$5::int\[\]\)\)\)/, 'a busy app: follow-ups only');
  assert.match(s, /ORDER BY \(q\.priority = 0\) DESC, \(fu\.id IS NOT NULL\) DESC, q\.priority, q\.enqueued_at/,
    'a Run now first, then a reply on the bot\'s proposal, then the rest in their order');
});

test('a reply on the bot\'s proposal starts while another request builds on the same app', async () => {
  bot._resetForTests();
  const settings = [
    { key: bot.KEY_MODE, value: 'shadow' },
    { key: bot.KEY_PER_PERSON, value: '2' },
    { key: bot.KEY_LIVE_AT_ONCE, value: '6' },
  ];
  const candidates = [row(1, 101, 7)];
  const pool = loopPool({ settings, candidates, apps: APPS });
  let release;
  const gate = new Promise((r) => { release = r; });
  const deps = {
    drain: false,
    github: { isEnabled: () => true, async fetchPublicIssues() { return { issues: [] }; } },
    limits: { async checkBudget() { await gate; return { error: true }; } },
    worker: { async listWorkerVolumes() { return []; } },
  };
  const first = await bot.runOnce(pool, {}, deps);
  assert.equal(first.dispatched, 1, 'a request on app 101 holds its session');

  // Then the person replies in the discussion of the bot's proposal there.
  candidates.push(followUp(2, 101, 7), row(3, 101, 8));
  pool.log.length = 0;
  const second = await bot.runOnce(pool, {}, deps);
  assert.equal(second.dispatched, 1, 'the reply starts; the other request still waits for the app');
  const running = bot._inFlightForTests().sort((a, b) => a.itemId - b.itemId);
  assert.deepEqual(running.map((r) => [r.appId, r.itemId, r.followUp]), [[101, 1, false], [101, 2, true]]);
  const asked = pool.log.find((l) => /AS follow_up_session_id/.test(l.s));
  assert.deepEqual(asked.params[4], [101], 'the app whose session is taken');
  assert.equal(asked.params[5], 77, 'the bot\'s own proposals');

  release();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(bot._inFlightForTests().length, 0);
  bot._resetForTests();
});

test('when live work ends, the next pass reads its app again, so a reply sent meanwhile is not left for the sweep', async () => {
  bot._resetForTests();
  const settings = [
    { key: bot.KEY_MODE, value: 'shadow' },
  ];
  const pool = loopPool({ settings, candidates: [row(1, 102, 7)], apps: APPS });
  let release;
  const gate = new Promise((r) => { release = r; });
  const fetched = [];
  const deps = {
    drain: false,
    github: {
      isEnabled: () => true,
      async fetchPublicIssues(owner, repo) { fetched.push(repo); return { issues: [] }; },
    },
    limits: { async checkBudget() { await gate; return { error: true }; } },
    worker: { async listWorkerVolumes() { return []; } },
  };
  await bot.runOnce(pool, {}, deps);
  assert.deepEqual(bot._pendingForTests().apps, [], 'nothing to read again while it runs');
  release();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(bot._pendingForTests().apps, [102], 'the app it ran on');

  // The next pass (inside the refresh interval) refreshes just that app.
  pool.query = ((real) => async (sql, params) => {
    if (/FROM apps\s+WHERE status = 'running'/.test(String(sql))) return { rows: [APPS[1]] };
    return real(sql, params);
  })(pool.query.bind(pool));
  const next = await bot.runOnce(pool, {}, { ...deps, now: () => Date.now() });
  assert.equal(next.woken, 1);
  assert.ok(fetched.includes('a2'), 'its requests were read again');
  assert.deepEqual(bot._pendingForTests().apps, []);
  bot._resetForTests();
});

test('a row started as a follow-up whose proposal has gone is handed back untouched', async () => {
  bot._resetForTests();
  const settings = [
    { key: bot.KEY_MODE, value: 'shadow' },
  ];
  const pool = loopPool({ settings, candidates: [followUp(4, 103, 7)], apps: APPS });
  const deps = {
    drain: false,
    github: {
      isEnabled: () => true,
      async fetchPublicIssues() { return { issues: [] }; },
      async fetchPublicIssue() { return { issue: { number: 4, title: 'x', state: 'open' } }; },
    },
    limits: { async checkBudget() { return { ok: true }; } },
    worker: { async listWorkerVolumes() { return []; } },
    dm: { async recordRequester() { return null; } },
    ws: {}, sessionLifecycle: {}, domain: 'app.onhomeroom.com',
  };
  // The proposal merged between the pick and the run: openBotProposal finds none.
  const out = await bot.runOnce(pool, {}, deps);
  assert.equal(out.dispatched, 1);
  await new Promise((r) => setTimeout(r, 20));
  const handedBack = pool.log.filter((l) => /UPDATE homeroom_bot_queue SET started_at = NULL WHERE id = \$1/.test(l.s));
  assert.deepEqual(handedBack.map((l) => l.params[0]), [4], 'to be taken in the app\'s own turn');
  assert.ok(!pool.log.some((l) => /INSERT INTO homeroom_bot_runs|DELETE FROM homeroom_bot_queue/.test(l.s)), 'no run recorded, nothing consumed');
  assert.ok(!pool.log.some((l) => /FROM chat_sessions\s+WHERE user_id = \$1 AND app_id = \$2 AND status IN \('active', 'paused'\)/.test(l.s)),
    'and the app\'s own session, which another request may be using, untouched');
  assert.ok(pool.log.some((l) => /SELECT id, status, pr_number FROM chat_sessions/.test(l.s)), 'it did look for the proposal');
  bot._resetForTests();
});


// ── A project's next request is read while its build runs ───────────────
//
// A live ready verdict used to be built inside the turn that read it, so
// the project's one slot was held for the whole build (up to 50 minutes,
// 110 on the platform's repository) and every other request on it waited
// unread. Now the build waits on its run and gets a slot of its own,
// `build:<runId>`: up to BUILDS_PER_PROJECT builds per project at a time,
// each on a session and branch of its own, reading beside them.

const waitingBuild = (id, appId, issueNumber, personId) => ({
  id, app_id: appId, issue_number: issueNumber, build_note: 'build it', person_id: personId,
});

test('three builds per project at once: Homeroom\'s own requests stopped waiting in a line', () => {
  assert.equal(bot.BUILDS_PER_PROJECT, 3);
});

test('pickLiveBuilds: up to perProject builds per project, counting those running, perPerson and slots counted', () => {
  const rows = [
    waitingBuild(900, 10, 1, 7), waitingBuild(901, 10, 2, 8), waitingBuild(902, 10, 5, 9), waitingBuild(903, 10, 6, 9),
    waitingBuild(904, 11, 3, 8), waitingBuild(905, 12, 4, 7),
  ];
  assert.deepEqual(bot.pickLiveBuilds(rows, { slots: 9, perPerson: 2 }).map((p) => p.id), [900, 901, 902, 904, 905],
    'three on project 10 at once; its fourth waits');
  assert.deepEqual(bot.pickLiveBuilds(rows, { buildingAppIds: [10, 10], slots: 9, perPerson: 2 }).map((p) => p.id), [900, 904, 905],
    'each build already under way counts against its project');
  assert.deepEqual(bot.pickLiveBuilds(rows, { buildingAppIds: [10, 10, 10], slots: 9, perPerson: 2 }).map((p) => p.id), [904, 905],
    'a project with three under way starts no fourth');
  assert.deepEqual(bot.pickLiveBuilds(rows, { slots: 9, perPerson: 2, perProject: 1 }).map((p) => p.id), [900, 904, 905],
    'perProject is the limit it reads');
  assert.deepEqual(bot.pickLiveBuilds(rows, { active: [{ person: 'u7' }, { person: 'u7' }], slots: 9, perPerson: 2 }).map((p) => p.id),
    [901, 902, 903, 904], 'what runs for a person counts, reading or building: #1 waits, so #6 is project 10\'s third');
  assert.deepEqual(bot.pickLiveBuilds(rows, { slots: 9, perPerson: 1 }).map((p) => p.id), [900, 901, 902],
    'and perPerson still holds across projects');
  assert.deepEqual(bot.pickLiveBuilds(rows, { slots: 1, perPerson: 2 }).map((p) => p.id), [900]);
});

test('a project\'s next request is read while its builds run, three of them at once', async () => {
  bot._resetForTests();
  const settings = [
    { key: bot.KEY_MODE, value: 'shadow' },
    { key: bot.KEY_PER_PERSON, value: '3' },
    { key: bot.KEY_LIVE_AT_ONCE, value: '8' },
  ];
  const pool = loopPool({
    settings,
    candidates: [row(2, 101, 7)],
    apps: APPS,
    waiting: [
      waitingBuild(900, 101, 1, 7), waitingBuild(901, 101, 3, 8), waitingBuild(903, 101, 5, 9),
      waitingBuild(904, 101, 6, 9), waitingBuild(902, 102, 4, 8),
    ],
  });
  let release;
  const gate = new Promise((r) => { release = r; });
  const deps = {
    drain: false,
    github: {
      isEnabled: () => true,
      async fetchPublicIssues() { return { issues: [] }; },
      // The builds wait here, then find their requests closed.
      async fetchPublicIssue() { await gate; return { issue: { state: 'closed' } }; },
    },
    // The budget has room: builds check it before they start too, now.
    limits: { async checkBudget() { return { ok: true }; } },
    worker: { async listWorkerVolumes() { return []; } },
    dm: { async overWeeklyAllowance() { return false; }, async requesterOf() { return null; } },
  };
  const out = await bot.runOnce(pool, {}, deps);
  const running = bot._inFlightForTests();
  const builds = running.filter((e) => e.build);
  assert.deepEqual(builds.map((e) => [e.appId, e.runId]).sort((a, b) => a[1] - b[1]), [[101, 900], [101, 901], [102, 902], [101, 903]],
    'three builds on a1 at once, each in a slot of its own: #6 waits for one of them');
  assert.ok(builds.every((e) => e.lane === 'live'));
  const reads = running.filter((e) => !e.build);
  assert.deepEqual(reads.map((e) => [e.appId, e.issueNumber]), [[101, 2]], 'a1\'s next request is read beside its builds');
  assert.equal(out.dispatched, 5);

  release();
  await new Promise((r) => setTimeout(r, 20));
  const skipped = pool.log.filter((l) => /SET live_build_waiting_at = NULL, build_ok = FALSE, build_error = \$2/.test(l.s));
  assert.deepEqual(skipped.map((l) => l.params[0]).sort((a, b) => a - b), [900, 901, 902, 903],
    'a request closed while its build waited is not built');
  assert.ok(skipped.every((l) => l.params[1] === 'skipped: the request was closed before its build started'));
  bot._resetForTests();
});

// One ready run, one build. A run reads as waiting until its build links its
// session (buildLive's onSession), several awaits after the build took its
// slot, and each pass's `seen` is its own: since #4544 let a project build
// three at once, the pass the next wake started took the same run again
// (homestead #31 and #32, two builds ~300 ms apart; kasirku #7, three).
test('two passes racing on one ready run start one build: its slot is taken until that build ends', async () => {
  bot._resetForTests();
  const settings = [
    { key: bot.KEY_MODE, value: 'shadow' },
    { key: bot.KEY_PER_PERSON, value: '3' },
    { key: bot.KEY_LIVE_AT_ONCE, value: '8' },
  ];
  // Every pass reads run 900 as waiting: its build has not linked a session.
  const pool = loopPool({ settings, apps: APPS, waiting: [waitingBuild(900, 101, 31, 7)] });
  let release;
  const gate = new Promise((r) => { release = r; });
  const builds = [];
  const deps = {
    drain: false,
    github: {
      isEnabled: () => true,
      async fetchPublicIssues() { return { issues: [] }; },
      // Where a build is when the next pass starts: reading its request,
      // which it then finds closed.
      async fetchPublicIssue(_o, _r, n) { builds.push(n); await gate; return { issue: { state: 'closed' } }; },
    },
    limits: { async checkBudget() { return { ok: true }; } },
    worker: { async listWorkerVolumes() { return []; } },
    dm: { async overWeeklyAllowance() { return false; }, async requesterOf() { return null; } },
  };
  const first = await bot.runOnce(pool, {}, deps);
  assert.equal(first.dispatched, 1);
  // The wake its verdict sent and the read slot that ended: passes back to
  // back, each with a `seen` of its own.
  const second = await bot.runOnce(pool, {}, deps);
  const third = await bot.runOnce(pool, {}, deps);
  assert.deepEqual([second.dispatched, third.dispatched], [0, 0], 'the run\'s build already has its slot');
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(builds, [31], 'one build of the run, not two or three');
  assert.deepEqual(bot._inFlightForTests().map((e) => [e.runId, e.build]), [[900, true]]);

  release();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(bot._inFlightForTests().length, 0, 'the slot frees when the build ends, whatever it came to');
  const skipped = pool.log.filter((l) => /SET live_build_waiting_at = NULL, build_ok = FALSE, build_error = \$2/.test(l.s));
  assert.deepEqual(skipped.map((l) => l.params[0]), [900], 'its outcome recorded once');
  // Never held for good: a run that still waits once its slot is free is
  // picked again.
  const after = await bot.runOnce(pool, {}, deps);
  assert.equal(after.dispatched, 1);
  await new Promise((r) => setTimeout(r, 20));
  bot._resetForTests();
});

test('a waiting build whose request the bot already proposed is not built (Plant Pal #1, #3)', async () => {
  const log = [];
  const pool = {
    async query(sql, params) {
      const s = String(sql);
      log.push({ s, params });
      if (/FROM chat_sessions/.test(s) && /AND \(status IN \('promoted', 'merging'\) OR \(status = 'merged' AND merged_at >= \$4::timestamptz\)\)/.test(s)) {
        return { rows: [{ id: 6190 }] };
      }
      return { rows: [] };
    },
  };
  const github = { isEnabled: () => true, async fetchPublicIssue() { return { issue: { number: 1, state: 'open' } }; } };
  const run = { id: 777, issue_number: 1, build_note: 'build it', created_at: '2026-10-03T16:55:03Z' };
  const app = { id: 2034, slug: 'plant-pal-1ad9b5', repo_url: 'https://github.com/usernode-bot/plant-pal-1ad9b5' };
  const out = await bot.buildOne(pool, {}, { bot: { id: 330 }, app, run, settings: {}, deps: { github } });
  assert.deepEqual(out, { ran: false, reason: 'has_proposal' });
  const looked = log.find((l) => /FROM chat_sessions/.test(l.s));
  assert.deepEqual(looked.params, [2034, 330, 1, '2026-10-03T16:55:03Z'], 'the bot\'s own, on this request, since this verdict');
  assert.match(looked.s, /user_id = \$2 AND \$3 = ANY\(linked_issues\) AND is_headless = FALSE/);
  const skipped = log.find((l) => /SET live_build_waiting_at = NULL, build_ok = FALSE, build_error = \$2/.test(l.s));
  assert.deepEqual(skipped.params, [777, 'skipped: the request already has a proposal (6190)'],
    'recorded as skipped, which the cards and the tray read as stopped');
  assert.ok(!log.some((l) => /build_session_id = \$2/.test(l.s)), 'and nothing was built');

  // Unread, it is not built either: it keeps waiting for the next pass.
  const failing = {
    async query(sql) {
      if (/FROM chat_sessions/.test(String(sql))) throw new Error('connection lost');
      log.push({ s: String(sql) });
      return { rows: [] };
    },
  };
  log.length = 0;
  assert.deepEqual(await bot.buildOne(failing, {}, { bot: { id: 330 }, app, run, settings: {}, deps: { github } }),
    { ran: false, reason: 'infra', detail: 'proposal_unreadable' });
  assert.ok(!log.some((l) => /live_build_waiting_at = NULL/.test(l.s)), 'still waiting');
});

test('a waiting build is not built while another build of its request is under way', async () => {
  const log = [];
  const pool = {
    async query(sql, params) {
      const s = String(sql);
      log.push({ s, params });
      // Another run's build of the request, its session open (requestBuilding).
      if (/JOIN chat_sessions bs ON bs\.id = b\.build_session_id/.test(s)) return { rows: [{ id: 7450 }] };
      return { rows: [] };
    },
  };
  const github = { isEnabled: () => true, async fetchPublicIssue() { return { issue: { number: 31, state: 'open' } }; } };
  const run = { id: 1268, issue_number: 31, build_note: 'build it', created_at: '2026-10-09T17:20:00Z' };
  const app = { id: 3120, slug: 'homestead', repo_url: 'https://github.com/usernode-bot/homestead' };
  const out = await bot.buildOne(pool, {}, { bot: { id: 330 }, app, run, settings: {}, deps: { github } });
  assert.deepEqual(out, { ran: false, reason: 'being_built' });
  const looked = log.find((l) => /JOIN chat_sessions bs ON bs\.id = b\.build_session_id/.test(l.s));
  assert.deepEqual(looked.params.slice(0, 3), [3120, 31, 1268], 'another run of this request, not this one');
  assert.equal(looked.params[4], null, 'one under way at all: this one has not started');
  assert.match(looked.s, /bs\.status IN \('active', 'paused'\)/, 'open: active in a turn, paused between them');
  assert.match(looked.s, /b\.build_ok IS NULL AND b\.proposal_session_id IS NULL/, 'its outcome not in yet');
  const skipped = log.find((l) => /SET live_build_waiting_at = NULL, build_ok = FALSE, build_error = \$2/.test(l.s));
  assert.deepEqual(skipped.params, [1268, 'skipped: the request is already being built (7450)'], 'a skip, read as stopped');
  assert.ok(!log.some((l) => /build_session_id = \$2/.test(l.s)), 'and nothing was built');
});

test('a ready verdict waits on its run, and only for a build of the same project', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/services/homeroom-bot.js'), 'utf8');
  const act = src.slice(src.indexOf('async function actOnVerdict('), src.indexOf('async function queueLiveBuild('));
  assert.match(act, /await queueLiveBuild\(pool, \{ runId, appId: app\.id \}\);\n\s+acted = 'build_queued';/);
  assert.doesNotMatch(act, /buildAndPropose/, 'never built inside the turn that read it');
  // A newer verdict on the issue replaces a build still waiting.
  assert.match(src, /SET live_build_waiting_at = NULL, build_error = 'superseded: a later verdict on the same issue'/);
  // A build's slot is not the app's: reading goes on beside it.
  assert.match(src, /const sessionTaken = running\.filter\(\(e\) => !e\.followUp && !e\.build\)\.map\(\(e\) => Number\(e\.appId\)\);/);
  // Once its session exists, restart recovery owns it.
  assert.match(src, /SET build_session_id = \$2, live_build_waiting_at = NULL WHERE id = \$1/);
});

test('a live build restart recovery finishes holds its project\'s build slot until it ends', async () => {
  bot._resetForTests();
  const pool = { async query(sql) {
    if (/FROM homeroom_bot_runs\s+WHERE build_session_id = \$1 AND build_at IS NOT NULL/.test(String(sql))) return { rows: [] };
    if (/WHERE r\.build_session_id = \$1 AND r\.mode = 'live' AND r\.build_ok IS NULL/.test(String(sql))) {
      return { rows: [{ id: 950, app_id: 101, issue_number: 6, person_id: 7 }] };
    }
    return { rows: [] };
  } };
  let finish;
  const recovery = new Promise((r) => { finish = r; });
  const held = bot.holdSlotDuringRecovery(pool, 6001, recovery);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(bot._inFlightForTests().map((e) => [e.appId, e.build, e.runId, e.recovered]), [[101, true, 950, true]]);
  finish('proposed');
  assert.equal(await held, 'proposed');
  assert.deepEqual(bot._inFlightForTests(), [], 'freed when it ends');
  bot._resetForTests();
});

test('Run now never starts a second turn on a request already being worked on', async () => {
  const asked = [];
  const pool = { async query(sql, params) {
    asked.push(String(sql));
    if (/SELECT id, slug FROM apps WHERE slug = \$1/.test(String(sql))) return { rows: [{ id: 101, slug: 'a1' }] };
    if (/INSERT INTO homeroom_bot_queue/.test(String(sql))) return { rows: [] };
    return { rows: [] };
  } };
  const out = await bot.enqueueNow(pool, { slug: 'a1', issueNumber: 5, actorId: 1 });
  assert.deepEqual(out, { ok: true, running: true, item: null });
  const insert = asked.find((s) => /INSERT INTO homeroom_bot_queue/.test(s));
  assert.doesNotMatch(insert, /started_at = NULL/, 'its claim is never cleared');
  assert.match(insert, /WHERE homeroom_bot_queue\.started_at IS NULL/);
  const route = require('node:fs').readFileSync(require.resolve('../src/routes/admin.js'), 'utf8');
  assert.match(route, /res\.status\(202\)\.json\(\{ item: result\.item, \.\.\.\(result\.running \? \{ running: true \} : \{\}\) \}\);/);
});

test('a spent weekly budget holds builds waiting their turn too, and their people hear it once', async () => {
  bot._resetForTests();
  const settings = [
    { key: bot.KEY_MODE, value: 'shadow' },
    { key: bot.KEY_PER_PERSON, value: '3' },
    { key: bot.KEY_LIVE_AT_ONCE, value: '6' },
  ];
  // Two builds waiting and nothing to read: before, the budget was checked
  // before a read only, so these started on a spent budget.
  const pool = loopPool({ settings, apps: APPS, waiting: [waitingBuild(900, 101, 1, 7), waitingBuild(902, 102, 4, 8)] });
  const told = [];
  const deps = {
    drain: false,
    github: { isEnabled: () => true, async fetchPublicIssues() { return { issues: [] }; } },
    limits: { async checkBudget() { return { error: 'Weekly limit reached', reason: 'weekly_limit' }; } },
    worker: { async listWorkerVolumes() { return []; } },
    dm: {
      async overWeeklyAllowance() { return false; },
      async requesterOf() { return null; },
      async notePausedForWeek(_pool, { userId }) { told.push(userId); return { messageId: 1 }; },
    },
  };
  const out = await bot.runOnce(pool, {}, deps);
  assert.equal(out.dispatched, 0, 'no build starts');
  assert.equal(bot._inFlightForTests().length, 0);
  assert.deepEqual(told.sort(), [7, 8], 'each person whose build was next is told (the DM keeps it to once a week)');
  const again = await bot.runOnce(pool, {}, deps);
  assert.equal(again.paused, 'budget', 'and the loop stays paused until the idle pass looks again');
  bot._resetForTests();
});

test('a budget that runs out for another reason pauses without telling anybody it is for the week', async () => {
  bot._resetForTests();
  const settings = [
    { key: bot.KEY_MODE, value: 'shadow' },
  ];
  const pool = loopPool({ settings, apps: APPS, waiting: [waitingBuild(900, 101, 1, 7)] });
  const told = [];
  const out = await bot.runOnce(pool, {}, {
    drain: false,
    github: { isEnabled: () => true, async fetchPublicIssues() { return { issues: [] }; } },
    limits: { async checkBudget() { return { error: 'Global daily limit reached', reason: 'global_limit' }; } },
    worker: { async listWorkerVolumes() { return []; } },
    dm: { async overWeeklyAllowance() { return false; }, async notePausedForWeek(_p, { userId }) { told.push(userId); } },
  });
  assert.equal(out.dispatched, 0);
  assert.deepEqual(told, []);
  bot._resetForTests();
});
