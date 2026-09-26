// #2684: the Homeroom bot, slice 1 — shadow-mode triage.
//
// Pins the pure pieces (verdict parsing, eligibility, settings), the loop's
// lock and mode gates against a mocked pool, the queue refresh against an
// injected GitHub, and — as source text — the properties that make shadow
// mode SHADOW: the triage turn is a scout (no push token), the service
// posts, claims and builds nothing, the loop is leader-only and ships off.
//
// Run with: node --test tests/homeroom-bot.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const bot = require('../src/services/homeroom-bot');
const live = require('../src/services/homeroom-bot-live');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const SRC = read('src/services/homeroom-bot.js');

// ── parseVerdict ─────────────────────────────────────────────────────────

test('parseVerdict reads the LAST fenced JSON block and normalizes its fields', () => {
  const text = [
    'I looked at routes/issues.js and the thread.',
    '```json',
    '{"verdict":"ready","determined":true,"missing_fact":"none"}',
    '```',
    'Actually, on reflection:',
    '```json',
    '{ "verdict": "Question", "determined": false, "missing_fact": "Which screen shows the pins.",',
    '  "question": "Which screen do the pins drift on?", "default": "The route map", "build_note": "ignored" }',
    '```',
  ].join('\n');
  const v = bot.parseVerdict(text);
  assert.equal(v.verdict, 'question');
  assert.equal(v.determined, false);
  assert.equal(v.missingFact, 'Which screen shows the pins.');
  assert.equal(v.question, 'Which screen do the pins drift on?');
  assert.equal(v.questionDefault, 'The route map');
  assert.equal(v.buildNote, null, 'a build note only rides a ready verdict');
  assert.equal(v.reason, null);
});

test('parseVerdict: "none" clears missing_fact, ready keeps its note, person keeps its reason', () => {
  const ready = bot.parseVerdict('```json\n{"verdict":"ready","determined":true,"missing_fact":"None.","build_note":"Edit public/js/map.js: clamp the pin offset on zoom."}\n```');
  assert.equal(ready.verdict, 'ready');
  assert.equal(ready.missingFact, null);
  assert.match(ready.buildNote, /clamp the pin offset/);
  const person = bot.parseVerdict('{"verdict":"person","determined":true,"reason":"Changes the login flow."}');
  assert.equal(person.verdict, 'person', 'bare braces without a fence still parse');
  assert.equal(person.reason, 'Changes the login flow.');
});

test('parseVerdict refuses anything that is not one of the three verdicts', () => {
  assert.equal(bot.parseVerdict(''), null);
  assert.equal(bot.parseVerdict('no json here'), null);
  assert.equal(bot.parseVerdict('```json\n{"verdict":"maybe"}\n```'), null);
  assert.equal(bot.parseVerdict('```json\n{not json}\n```'), null);
  assert.equal(bot.parseVerdict('```json\n[1,2]\n```'), null);
});

// ── classifyIssue ────────────────────────────────────────────────────────

test('classifyIssue: a never-triaged open issue is queued at priority 1 with the newest activity as thread_seen_at', () => {
  const v = bot.classifyIssue({
    issue: { number: 7, state: 'open', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z' },
    threadLastAt: '2026-09-03T12:00:00Z',
  });
  assert.equal(v.eligible, true);
  assert.equal(v.priority, 1);
  assert.equal(v.reason, 'new');
  assert.equal(v.threadSeenAt, '2026-09-03T12:00:00.000Z', 'the platform thread was newer than GitHub');
});

test('classifyIssue: unchanged since the last run is skipped; changed is re-queued at priority 2', () => {
  const issue = { number: 7, state: 'open', updatedAt: '2026-09-02T00:00:00Z' };
  const unchanged = bot.classifyIssue({ issue, lastRun: { thread_seen_at: '2026-09-02T00:00:00Z' } });
  assert.equal(unchanged.eligible, false);
  assert.equal(unchanged.reason, 'unchanged');
  const changed = bot.classifyIssue({
    issue, threadLastAt: '2026-09-05T00:00:00Z', lastRun: { thread_seen_at: '2026-09-02T00:00:00Z' },
  });
  assert.equal(changed.eligible, true);
  assert.equal(changed.priority, 2);
  assert.equal(changed.reason, 'changed');
});

test('classifyIssue: an unchanged issue whose last verdict a cap held says which cap (#3152)', () => {
  const issue = { number: 7, state: 'open', updatedAt: '2026-09-02T00:00:00Z' };
  const lastRun = { thread_seen_at: '2026-09-02T00:00:00Z', cap_suppressed: 'proposals_per_app' };
  const held = bot.classifyIssue({ issue, lastRun });
  assert.equal(held.eligible, false, 'refreshApp, not classifyIssue, decides whether the cap has room');
  assert.equal(held.reason, 'held');
  assert.equal(held.cap, 'proposals_per_app');
  // Something new on the issue re-queues it whatever held it last time.
  const changed = bot.classifyIssue({ issue, threadLastAt: '2026-09-05T00:00:00Z', lastRun });
  assert.equal(changed.reason, 'changed');
});

test('classifyIssue: the bot never competes with a person, and never looks at a closed issue', () => {
  const busy = bot.classifyIssue({ issue: { number: 7, state: 'open' }, busy: true });
  assert.equal(busy.eligible, false);
  assert.equal(busy.reason, 'in_progress');
  const closed = bot.classifyIssue({ issue: { number: 7, state: 'closed' } });
  assert.equal(closed.eligible, false);
  assert.equal(closed.reason, 'closed');
  assert.equal(bot.classifyIssue({ issue: null }).eligible, false);
});

// ── settings ─────────────────────────────────────────────────────────────

test('settings default to off and clamp their numbers', () => {
  const s = bot.parseSettings([]);
  assert.deepEqual(s, {
    mode: 'off', concurrency: 1, batchSize: 100, pausedApps: [], liveApps: [],
    turnSeconds: 20 * 60, turnInputTokens: 10_000_000,
  });
  const t = bot.parseSettings([
    { key: bot.KEY_MODE, value: 'shadow' },
    { key: bot.KEY_CONCURRENCY, value: '99' },
    { key: bot.KEY_BATCH_SIZE, value: '0' },
    { key: bot.KEY_PAUSED_APPS, value: '["a-b", 3, "c"]' },
  ]);
  assert.equal(t.mode, 'shadow');
  assert.equal(t.concurrency, 4, 'clamped to the ceiling');
  assert.equal(t.batchSize, 1, 'clamped to the floor');
  assert.deepEqual(t.pausedApps, ['a-b', 'c']);
  assert.deepEqual(bot.parseSettings([{ key: bot.KEY_PAUSED_APPS, value: 'not json' }]).pausedApps, []);
});

test('validateSettingsPatch refuses live mode and bad values, accepts a real patch', () => {
  assert.equal(bot.validateSettingsPatch({ mode: 'live' }).ok, false, 'live is not in this slice');
  assert.match(bot.validateSettingsPatch({ mode: 'live' }).error, /shadow mode/);
  assert.equal(bot.validateSettingsPatch({ mode: 'loud' }).ok, false);
  assert.equal(bot.validateSettingsPatch({ concurrency: 0 }).ok, false);
  assert.equal(bot.validateSettingsPatch({ batchSize: 501 }).ok, false);
  assert.equal(bot.validateSettingsPatch({ batchSize: 500 }).ok, true, 'the ceiling is 500 (#2684 follow-up: 100 is the default)');
  assert.equal(bot.validateSettingsPatch({ pausedApps: ['Bad Slug'] }).ok, false);
  assert.equal(bot.validateSettingsPatch({ weeklyLimitCents: -1 }).ok, false);
  assert.equal(bot.validateSettingsPatch({}).ok, false, 'nothing to update');
  const ok = bot.validateSettingsPatch({ mode: 'shadow', pausedApps: ['x', 'x', 'y'], weeklyLimitCents: 15000 });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.updates, [[bot.KEY_MODE, 'shadow'], [bot.KEY_PAUSED_APPS, '["x","y"]']]);
  assert.equal(ok.weeklyLimitCents, 15000);
});

test('parseRepo reads owner and repo off a GitHub URL', () => {
  assert.deepEqual(bot.parseRepo('https://github.com/usernode-bot/todo-list-b641de'), { owner: 'usernode-bot', repo: 'todo-list-b641de' });
  assert.deepEqual(bot.parseRepo('https://github.com/Usernode-Labs/social-vibecoding.git'), { owner: 'Usernode-Labs', repo: 'social-vibecoding' });
  assert.equal(bot.parseRepo('https://example.com/x/y'), null);
});

// ── runOnce against a mocked pool ────────────────────────────────────────

function mockPool({ lockAcquired = true, settings = [] } = {}) {
  const log = [];
  const client = {
    async query(sql, params) {
      log.push({ sql: String(sql), params });
      if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ acquired: lockAcquired }] };
      return { rows: [] };
    },
    release() { log.push({ released: true }); },
  };
  const pool = {
    async connect() { return client; },
    async query(sql, params) {
      log.push({ sql: String(sql), params });
      if (/SELECT key, value FROM platform_settings/.test(sql)) return { rows: settings };
      // ensureBotUser runs on every pass that is not `off`, and throws when
      // it cannot find or make the row — so a pass-level test needs it.
      if (/FROM users WHERE username = \$1/.test(sql)) {
        return { rows: [{ id: 77, username: 'homeroom_bot', weekly_limit_cents: 15000 }] };
      }
      if (/SELECT is_synthetic FROM users/.test(sql)) return { rows: [{ is_synthetic: true }] };
      return { rows: [] };
    },
  };
  return { pool, log };
}

test('runOnce: mode off does nothing past reading the settings, and releases the lock', async () => {
  bot._resetForTests();
  const { pool, log } = mockPool({ settings: [{ key: bot.KEY_MODE, value: 'off' }] });
  const out = await bot.runOnce(pool, {});
  assert.equal(out.mode, 'off');
  assert.equal(out.processed, 0);
  assert.equal(out.refreshed, false, 'off means no GitHub reads either');
  assert.ok(log.some((l) => /pg_advisory_unlock/.test(l.sql || '')), 'the lock is released');
  assert.ok(log.some((l) => l.released), 'the client is released');
  assert.ok(!log.some((l) => /FROM apps/.test(l.sql || '')), 'no app scan while off');
});

test('runOnce: another Pod holding the lock means this one skips the pass', async () => {
  bot._resetForTests();
  const { pool, log } = mockPool({ lockAcquired: false, settings: [{ key: bot.KEY_MODE, value: 'shadow' }] });
  const out = await bot.runOnce(pool, {});
  assert.equal(out.busy, true);
  assert.ok(!log.some((l) => /pg_advisory_unlock/.test(l.sql || '')), 'never unlocks a lock it did not take');
  assert.ok(!log.some((l) => /FROM apps/.test(l.sql || '')));
});

// ── The loop is event-driven: wakes ──────────────────────────────────────

test('a wake on the Pod running the loop records the app and pulls the next pass forward', () => {
  bot._resetForTests();
  // Not running the loop here (no timer, no pass): a wake is a no-op, so the
  // pending set cannot grow on the Pods that never drain it.
  assert.equal(bot.wake({ appId: 9 }), false);
  assert.deepEqual(bot._pendingForTests().apps, []);

  bot._armForTests({});
  assert.equal(bot.wake({ appId: 9 }), true);
  assert.equal(bot.wake({ appId: '9' }), true, 'ids arrive as strings off the bus');
  assert.equal(bot.wake({ appId: 0 }), false);
  assert.equal(bot.wake({}), false);
  const p = bot._pendingForTests();
  assert.deepEqual(p.apps, [9]);
  assert.equal(p.wake, true);
  assert.equal(p.armed, true, 'the idle timer was replaced by an immediate one');

  bot.wake({ all: true });
  assert.equal(bot._pendingForTests().all, true);
  bot._resetForTests();
});

test('noteIssueActivity wakes locally and publishes the same wake for the other Pods', () => {
  bot._resetForTests();
  const wsBus = require('../src/services/ws-bus');
  const published = [];
  const realPublish = wsBus.publish;
  wsBus.publish = (kind, routing, data) => { published.push({ kind, routing, data }); };
  try {
    bot._armForTests({});
    assert.equal(bot.noteIssueActivity({ appId: 9, issueNumber: 12, reason: 'created' }), true);
    assert.equal(bot.noteIssueActivity({ appId: 9, issueNumber: 'x' }), false, 'a bad number is dropped, not published');
    assert.deepEqual(published, [{ kind: bot.BUS_KIND, routing: null, data: { appId: 9, issueNumber: 12, reason: 'created' } }]);
    assert.deepEqual(bot._pendingForTests().apps, [9]);
    // The receiving side: ws._onBusMessage hands the envelope to onBusMessage.
    bot._resetForTests();
    bot._armForTests({});
    assert.equal(bot.onBusMessage({ appId: 4, issueNumber: 1, reason: 'thread' }), true);
    assert.equal(bot.onBusMessage(null), false);
    assert.deepEqual(bot._pendingForTests().apps, [4]);
  } finally {
    wsBus.publish = realPublish;
    bot._resetForTests();
  }
});

test('runOnce: a wake refreshes only the app that changed; the reconcile sweep still covers everything', async () => {
  bot._resetForTests();
  const fetched = [];
  const github = { async fetchPublicIssues(owner, repo) { fetched.push(`${owner}/${repo}`); return { issues: [] }; } };
  const apps = [
    { id: 1, slug: 'a', repo_url: 'https://github.com/o/a' },
    { id: 2, slug: 'b', repo_url: 'https://github.com/o/b' },
  ];
  const { pool } = mockPool({ settings: [{ key: bot.KEY_MODE, value: 'shadow' }] });
  const realQuery = pool.query.bind(pool);
  pool.query = async (sql, params) => {
    if (/FROM apps\s+WHERE status = 'running'/.test(String(sql))) return { rows: apps };
    return realQuery(sql, params);
  };
  let now = 1_000_000;
  const deps = { github, now: () => now };

  // First pass: the reconcile sweep is due (never run), so every app.
  let out = await bot.runOnce(pool, {}, deps);
  assert.equal(out.refreshed, true);
  assert.deepEqual(fetched, ['o/a', 'o/b']);

  // A wake for app 2, inside the sweep interval: only app 2 is read.
  fetched.length = 0;
  now += 1000;
  bot._armForTests({});
  bot.wake({ appId: 2 });
  out = await bot.runOnce(pool, {}, deps);
  assert.equal(out.refreshed, true);
  assert.equal(out.woken, 1);
  assert.deepEqual(fetched, ['o/b']);
  assert.deepEqual(bot._pendingForTests().apps, [], 'the wake was consumed');

  // No wake, inside the interval: nothing is read.
  fetched.length = 0;
  now += 1000;
  out = await bot.runOnce(pool, {}, deps);
  assert.equal(out.refreshed, false);
  assert.deepEqual(fetched, []);

  // The interval elapses: the sweep again.
  fetched.length = 0;
  now += bot.REFRESH_INTERVAL_MS;
  out = await bot.runOnce(pool, {}, deps);
  assert.deepEqual(fetched, ['o/a', 'o/b']);
  bot._resetForTests();
});

test('the wake reaches the bot from every place an issue changes on the platform', () => {
  const ws = read('src/services/ws.js');
  const busCase = ws.slice(ws.indexOf("case 'homeroom_bot':"), ws.indexOf("case 'homeroom_bot':") + 500);
  assert.match(busCase, /require\('\.\/homeroom-bot'\)\.onBusMessage\(payload\)/, 'the bus hands the bot its envelopes');
  const push = ws.slice(ws.indexOf('function pushIssueUpdate(data)'));
  assert.match(push.slice(0, 700), /noteIssueActivityForBot\(data\.appId, data\.issueNumber, data\.action\)/,
    'an edit or an unclaim wakes the bot');
  const handle = ws.slice(ws.indexOf('async function handleMessage(pool, client, msg)'));
  assert.match(handle, /if \(thread && thread\.type === 'issue'\) noteIssueActivityForBot\(client\.appId, thread\.ref, 'thread'\)/,
    'a post on an issue thread wakes the bot');
  const issues = read('src/routes/issues.js');
  assert.match(issues, /noteIssueActivity\(\{ appId: app\.id, issueNumber: githubIssueNumber, reason: 'created' \}\)/,
    'a new request wakes the bot once its GitHub twin exists');
  assert.match(SRC, /const IDLE_PASS_DELAY_MS = 30 \* 1000;/, 'the idle poll is a fallback, not the cadence');
  assert.match(read('src/services/homeroom-bot.js'), /wakeAll\(\);/, 'switching the mode on rebuilds the queue at once');
});


// ── The budget on a turn (#2737) ─────────────────────────────────────────

test('runTriage: the wall clock stops a turn that never finishes, and the row says so', async () => {
  const stopped = [];
  const { pool, deps, calls } = triageHarness({ verdictText: 'never gets here' });
  deps.worker.stopTurn = async (id) => { stopped.push(id); };
  // A dispatch that only settles once the turn is stopped, which is what a
  // hung turn looks like from here.
  deps.sessions.runCodexAttemptLoop = async ({ dispatchOnce }) => {
    await dispatchOnce({ openrouterApiKey: 'k' });
    await new Promise((resolve) => {
      const wait = setInterval(() => { if (stopped.length) { clearInterval(wait); resolve(); } }, 2);
    });
    return { result: { lastResultText: '', inputTokens: 5000, outputTokens: 10 }, error: null, estimatedCostUsd: 0.4 };
  };
  const out = await bot.runTriage(pool, {}, {
    bot: BOT, app: APP, item: ITEM, mode: 'shadow',
    // 30s is the floor the settings clamp to; the timer is what is under
    // test, so it is driven from the setting rather than by waiting.
    settings: { turnSeconds: 30, turnInputTokens: 10_000_000 }, deps,
  });
  assert.deepEqual(stopped, [501], 'the turn is ended through the supported stop path');
  assert.equal(out.budget, 'wall clock');
  assert.equal(out.verdict, 'failed');
  const insert = calls.queries.find((q) => /INSERT INTO homeroom_bot_runs/.test(q.s));
  assert.ok(insert.params.includes('budget: wall clock'), 'the ledger says which limit it hit');
  const requeue = calls.queries.find((q) => /SET started_at = NULL, reason = 'budget_retry'/.test(q.s));
  assert.ok(requeue, 'and it goes back once, at the bottom of the queue');
  assert.ok(!calls.queries.some((q) => /DELETE FROM homeroom_bot_queue/.test(q.s)), 'not dropped on the first stop');
}, { timeout: 20000 });

// ── Only the clock stops a turn; a fresh thread per issue (#3035) ───────

const QUESTION_REPLY = 'Read the map code.\n```json\n{"verdict":"question","determined":false,"missing_fact":"which screen","question":"Which screen?","default":"Route map"}\n```';

// Drive the wall clock without waiting twenty minutes for it: the dispatch
// hangs until the bot stops it, and mocked timers fire the budget at once.
// `kill` is what stopTurn returns, so a test can hold the kill in flight.
async function runToWallClock(t, harness, opts = {}, {
  kill = null, onStopped = null, ctx = {}, result = { lastResultText: '' },
} = {}) {
  const stopped = [];
  let release;
  const hung = new Promise((resolve) => { release = resolve; });
  harness.deps.worker.stopTurn = (id) => { stopped.push(id); release(); return kill || Promise.resolve(); };
  harness.deps.sessions.runCodexAttemptLoop = async ({ dispatchOnce }) => {
    await dispatchOnce({ openrouterApiKey: 'k', ...ctx });
    await hung;
    // A stopped attempt never reaches turn.completed, so the ledger has no
    // cost for it: `estimatedCostUsd` is absent, as it is in production.
    return { result, error: null };
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const running = bot.runTriage(harness.pool, {}, {
    bot: BOT, app: APP, item: ITEM, mode: 'shadow', deps: harness.deps,
    settings: { turnSeconds: 1200, turnInputTokens: 10_000_000 }, ...opts,
  });
  for (let i = 0; i < 500 && !stopped.length; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(1200 * 1000);
  }
  if (onStopped) await onStopped(running);
  return { out: await running, stopped };
}

test('runTriage: a turn over its token limit keeps its verdict, and nothing is stopped', async () => {
  // Between #2870 and #3035 the token check was wired to the stop. Usage
  // only arrives when a turn is over, so it fired on FINISHED turns — every
  // one, since the figure was a conversation's running total — threw the
  // verdict away, and killed the next issue. 13 of 13 turns, zero verdicts.
  const stopped = [];
  const { pool, deps, calls } = triageHarness({
    sessionId: 834,
    result: { lastResultText: QUESTION_REPLY, inputTokens: 2_711_069_602, outputTokens: 262_128 },
  });
  deps.worker.stopTurn = async (id) => { stopped.push(id); };
  const out = await bot.runTriage(pool, {}, {
    bot: BOT, app: APP, item: ITEM, mode: 'shadow',
    settings: { turnSeconds: 3600, turnInputTokens: 10_000_000 }, deps,
  });
  assert.equal(calls.exec[0].opts.onUsage, undefined, 'no usage hook reaches the stop');
  assert.ok(!/onUsage:/.test(SRC), 'the bot passes no usage hook at all');
  assert.deepEqual(stopped, [], 'a finished turn is never killed');
  assert.equal(out.verdict, 'question', 'the verdict the turn reached is kept');
  const insert = calls.queries.find((q) => /INSERT INTO homeroom_bot_runs/.test(q.s));
  assert.equal(insert.params[4], 'question');
  assert.equal(insert.params[19], null, 'and it is not recorded as a budget stop');
  assert.ok(!calls.queries.some((q) => /budget_retry/.test(q.s)), 'nor requeued');
});

test('runTriage: a second budget stop on the same issue drops it instead of looping', async (t) => {
  const harness = triageHarness({ verdictText: 'x', sessionId: 845 });
  const { out } = await runToWallClock(t, harness, { item: { ...ITEM, reason: 'budget_retry' } });
  assert.equal(out.budget, 'wall clock');
  assert.ok(harness.calls.queries.some((q) => /DELETE FROM homeroom_bot_queue/.test(q.s)),
    'the one retry is spent, so the issue is let go rather than retried forever');
  assert.ok(!harness.calls.queries.some((q) => /reason = 'budget_retry'/.test(q.s)));
});

test('a budget stop records WHICH limit tripped, in a column of its own', async (t) => {
  const harness = triageHarness({ verdictText: 'x', sessionId: 856 });
  await runToWallClock(t, harness);
  const insert = harness.calls.queries.find((q) => /INSERT INTO homeroom_bot_runs/.test(q.s));
  assert.match(insert.s, /budget_stop\)/, 'the insert names the column');
  assert.ok(insert.params.includes('wall clock'),
    'the limit is stored as data, not left to be grepped out of the error text');
  assert.ok(insert.params.includes('budget: wall clock'), 'and the error line still reads the same');
});

test('the next issue never starts while a kill is still landing', async (t) => {
  // The stop used to be fire-and-forget. The attempt loop resolves as soon
  // as the turn ends, the next issue starts in the same container, and the
  // kill — still landing — took it down one to three seconds in: all 12
  // "collateral" rows in the export sit directly after a stop.
  const harness = triageHarness({ verdictText: '', sessionId: 867 });
  let landKill;
  const kill = new Promise((resolve) => { landKill = resolve; });
  let settled = false;
  const { out } = await runToWallClock(t, harness, {}, {
    kill,
    onStopped: async (running) => {
      running.then(() => { settled = true; });
      for (let i = 0; i < 25; i += 1) await new Promise((resolve) => setImmediate(resolve));
      assert.equal(settled, false, 'the turn is over, but runTriage waits for the kill to land');
      landKill();
    },
  });
  assert.equal(settled, true);
  assert.equal(out.budget, 'wall clock');
});

test('every issue starts a fresh model thread, through the platform\'s own reading of null', async () => {
  // The bot always passed a null thread, and the old test pinned exactly
  // that argument. But the platform reads null as "carry on the saved
  // thread" in two places, and saves the thread back after every turn, so
  // each app's bot session was ONE conversation: the Homeroom app's usage
  // climbed monotonically across every run for three days to 2.7 billion.
  // This harness imitates both of those readings, with a thread already
  // saved on the session, and checks what the dispatch actually resumes.
  const { pool, deps, calls } = triageHarness({ verdictText: QUESTION_REPLY, sessionId: 878 });
  const select = pool.query;
  pool.query = async (sql, params) => {
    const res = await select(sql, params);
    if (/SELECT \* FROM chat_sessions/.test(String(sql))) res.rows[0].agent_thread_id = 'thread-from-the-last-issue';
    return res;
  };
  deps.agentTurn.resolveCodexRuntimeContext = async ({ session, resumeThreadId }) => ({
    openrouterApiKey: 'k',
    resumeThreadId: resumeThreadId || session.agent_thread_id || null,
  });
  deps.sessions.runCodexAttemptLoop = async ({ resumeThreadId, resolveRuntime, dispatchOnce }) => {
    const runtimeContext = await resolveRuntime();
    const thread = resumeThreadId ?? runtimeContext.resumeThreadId ?? null;
    const result = await dispatchOnce({ ...runtimeContext, resumeThreadId: thread, resumeSessionId: thread });
    return { result, error: null, estimatedCostUsd: 0.01 };
  };
  const out = await bot.runTriage(pool, {}, { bot: BOT, app: APP, item: ITEM, mode: 'shadow', deps });
  assert.equal(out.verdict, 'question');
  assert.equal(calls.exec[0].opts.resumeSessionId, null, 'the dispatch resumes nothing');
  assert.equal(calls.exec[0].opts.resumeThreadId, null);
  const start = calls.queries.find((q) => /SET status = 'active'/.test(q.s));
  assert.match(start.s, /agent_thread_id = NULL/, 'and the saved thread is cleared in the row, for every later reader');

  // The imitation is only worth something while it matches the platform.
  assert.match(read('src/services/agent-turn.js'), /resumeThreadId: resumeThreadId \|\| session\.agent_thread_id \|\| null/,
    'if this changes, re-check how a null thread is read before trusting the test above');
  assert.match(read('src/routes/sessions.js'), /resumeThreadId \?\? runtimeContext\.resumeThreadId \?\? null/);
});

test('issues dropped by those spurious stops come back on the next refresh', () => {
  // The issue-level "unchanged since its last run" check counted a
  // collateral kill and a discarded token-stop as a judgement of the issue,
  // so an issue whose last row was one of those was never queued again.
  const q = SRC.slice(SRC.indexOf('async function lastRunsByIssue'), SRC.indexOf('async function refreshApp'));
  assert.match(q, /AND budget_stop IS DISTINCT FROM 'input tokens'/);
  assert.match(q, /AND \(error IS NULL OR error NOT LIKE 'collateral:%'\)/);
  assert.ok(!/spendBudget\('input tokens'\)/.test(SRC), 'and no new token stops are written, so the filter is a one-off recovery');
});

// ── A stopped turn is priced from what its finished requests used (#3038) ──

const PRICING = { available: true, inputPricePerMillion: 0.075, outputPricePerMillion: 0.3 };
const realEstimator = require('../src/services/agent-turn').estimateRequestedModelCost;

test('a turn stopped by the clock is priced from the requests that finished before the stop', async (t) => {
  // The one genuine wall-clock stop in the 2026-09-24 export (#3027, 20.3
  // minutes) recorded $0.00: the agent reports usage only at turn.completed,
  // which a stopped turn never reaches. The relay's per-request lines do
  // survive the kill, and they are priced here exactly as the ledger prices
  // a finished turn.
  const harness = triageHarness({ verdictText: 'x', sessionId: 901 });
  harness.deps.agentTurn.estimateRequestedModelCost = realEstimator;
  const { out } = await runToWallClock(t, harness, {}, {
    ctx: { pricingSnapshot: PRICING },
    result: {
      lastResultText: '',
      relayUsage: { requests: 7, inputTokens: 40_000_000, cachedInputTokens: 36_000_000, outputTokens: 5_000, reasoningOutputTokens: 900 },
    },
  });
  assert.equal(out.budget, 'wall clock');
  const insert = harness.calls.queries.find((q) => /INSERT INTO homeroom_bot_runs/.test(q.s));
  assert.equal(insert.params[14], 3.0015, 'cost: 40M input at $0.075/M plus 5k output at $0.30/M');
  assert.equal(insert.params[15], 40_000_000, 'and the tokens the relay counted');
  assert.equal(insert.params[16], 5_000);
  assert.ok(insert.params.includes('wall clock'), 'still recorded as the stop it was');
  assert.deepEqual(harness.calls.spend, [{ userId: 77, cents: 300.15, opts: { byok: false } }],
    'and it reaches the weekly cap like any other spend');
});

test('the ledger figure wins whenever the agent reported one', async () => {
  // A finished turn has the platform's own figure; the relay's sum is only
  // for the turn that has none, so the two never add up to a double count.
  const { pool, deps, calls } = triageHarness({
    sessionId: 902,
    result: {
      lastResultText: 'Read the map code.\n```json\n{"verdict":"question","determined":false,"missing_fact":"which screen","question":"Which screen?","default":"Route map"}\n```',
      inputTokens: 1000, outputTokens: 50,
      relayUsage: { requests: 3, inputTokens: 999_999, cachedInputTokens: 0, outputTokens: 999, reasoningOutputTokens: 0 },
    },
  });
  deps.agentTurn.estimateRequestedModelCost = realEstimator;
  await bot.runTriage(pool, {}, { bot: BOT, app: APP, item: ITEM, mode: 'shadow', deps });
  const insert = calls.queries.find((q) => /INSERT INTO homeroom_bot_runs/.test(q.s));
  assert.equal(insert.params[14], 0.0123, "the harness's ledger cost, not the relay's");
  assert.equal(insert.params[15], 1000, "and the agent's own tokens");
  assert.deepEqual(calls.spend, [{ userId: 77, cents: 1.23, opts: { byok: false } }], 'debited once');
});

test('with no price to apply, a stopped turn records its tokens and invents no cost', async (t) => {
  const harness = triageHarness({ verdictText: 'x', sessionId: 903 });
  harness.deps.agentTurn.estimateRequestedModelCost = realEstimator;
  await runToWallClock(t, harness, {}, {
    ctx: {},
    result: { lastResultText: '', relayUsage: { requests: 2, inputTokens: 120_000, cachedInputTokens: 0, outputTokens: 800, reasoningOutputTokens: 0 } },
  });
  const insert = harness.calls.queries.find((q) => /INSERT INTO homeroom_bot_runs/.test(q.s));
  assert.equal(insert.params[14], null, 'unknown, not zero');
  assert.equal(insert.params[15], 120_000);
  assert.deepEqual(harness.calls.spend, [], 'nothing to debit');
});

test('relaySpend: no finished request means no figure at all', () => {
  assert.equal(bot.relaySpend(null, PRICING, { estimateRequestedModelCost: realEstimator }), null);
  assert.equal(bot.relaySpend({ requests: 0, inputTokens: 0, outputTokens: 0 }, PRICING, { estimateRequestedModelCost: realEstimator }), null);
  assert.deepEqual(
    bot.relaySpend({ requests: 1, inputTokens: 1_000_000, outputTokens: 0 }, PRICING, { estimateRequestedModelCost: realEstimator }),
    { requests: 1, inputTokens: 1_000_000, outputTokens: 0, costUsd: 0.075 },
  );
});

test('the stopped-run detail says its cost is a floor', () => {
  const ui = read('frontend/src/features/admin/admin-homeroom-bot.tsx');
  assert.match(ui, /Its cost counts the model requests that finished before the stop\./);
  assert.match(ui, /so the real cost is a little higher/);
});

test('the totals count a budget stop separately and stop calling it a failure', () => {
  assert.match(SRC, /COUNT\(\*\) FILTER \(WHERE verdict = 'failed' AND budget_stop IS NULL\)::int AS failed/,
    'a turn we stopped ourselves is not a failure');
  assert.match(SRC, /COUNT\(\*\) FILTER \(WHERE budget_stop IS NOT NULL\)::int AS budget_stopped/);
  assert.match(SRC, /budgetStopped: t\.budget_stopped \|\| 0/);
  const schema = read('src/db/schema.sql');
  assert.match(schema, /ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS budget_stop TEXT;/,
    'added, not backfilled: the rows already recorded keep their error text and a null here');
});

test('the runs query filters to budget stops on one static statement', () => {
  assert.match(SRC, /AND \(NOT \$5::boolean OR r\.budget_stop IS NOT NULL\)/,
    'a nullable parameter, so the SQL lint still sees one static query');
  assert.match(SRC, /r\.budget_stop,/, 'and the column travels with the row');
  assert.match(SRC, /'error', 'budget_stop', 'thread_seen_at',/, 'the export carries it beside the error');
});

// ── What the first day of budget data exposed (#2870) ────────────────────

test('a turn stopped on its budget is still debited against the weekly cap', async () => {
  // The three stops in the first day's ledger all recorded $0.0000, because
  // the branch that writes the stop returned above the debit. That is the
  // wrong way round: a twenty-minute turn nobody was ever going to use is
  // exactly the spend a weekly cap exists to notice.
  const stopped = [];
  const { pool, deps, calls } = triageHarness({ verdictText: 'never gets here', sessionId: 611 });
  deps.worker.stopTurn = async (id) => { stopped.push(id); };
  deps.sessions.runCodexAttemptLoop = async ({ dispatchOnce }) => {
    await dispatchOnce({ openrouterApiKey: 'k' });
    await new Promise((resolve) => {
      const wait = setInterval(() => { if (stopped.length) { clearInterval(wait); resolve(); } }, 2);
    });
    return { result: { lastResultText: '', inputTokens: 5000, outputTokens: 10 }, error: null, estimatedCostUsd: 0.4 };
  };
  const out = await bot.runTriage(pool, {}, {
    bot: BOT, app: APP, item: ITEM, mode: 'shadow',
    settings: { turnSeconds: 30, turnInputTokens: 10_000_000 }, deps,
  });
  assert.equal(out.budget, 'wall clock');
  assert.deepEqual(calls.spend, [{ userId: 77, cents: 40, opts: { byok: false } }],
    'what the killed turn spent joins the same pool a completed one does');
  const insert = calls.queries.find((q) => /INSERT INTO homeroom_bot_runs/.test(q.s));
  assert.ok(insert.params.includes(0.4), 'and the ledger row carries the cost instead of a zero');
  assert.ok(insert.params.includes(5000) && insert.params.includes(10),
    'along with whatever usage the dispatch managed to report');
}, { timeout: 20000 });

test('an empty reply moments after a stop on the same session is the stop, not the issue', async () => {
  // Two of the first three budget stops wrote an `(empty reply)` row in the
  // SAME SECOND, on a different issue: stopTurn kills the session's
  // container and an issue dispatched into it concurrently dies with it.
  // That issue had done nothing wrong and lost its triage anyway.
  bot.noteStopped(733);
  const { pool, deps, calls } = triageHarness({ verdictText: '', sessionId: 733 });
  const out = await bot.runTriage(pool, {}, {
    bot: BOT, app: APP, item: ITEM, mode: 'shadow',
    settings: { turnSeconds: 3600, turnInputTokens: 10_000_000 }, deps,
  });
  assert.deepEqual({ ran: out.ran, reason: out.reason }, { ran: false, reason: 'infra' });
  const insert = calls.queries.find((q) => /INSERT INTO homeroom_bot_runs/.test(q.s));
  assert.match(insert.params[18], /collateral: the session was stopped mid-dispatch/,
    'the row says what happened rather than blaming the issue');
  assert.ok(calls.queries.some((q) => /SET started_at = NULL WHERE id = \$1/.test(q.s)),
    'and the issue goes back on the queue');
  assert.ok(!calls.queries.some((q) => /DELETE FROM homeroom_bot_queue/.test(q.s)),
    'never dropped for a timeout that was not its own');
});

test('an empty reply with no stop behind it records WHY it was empty', async () => {
  // 21 of the first 225 runs recorded `(empty reply)` and nothing else,
  // which is not enough to tell a provider refusal from a rate limit from a
  // container that died. The worker already knew; it was being discarded.
  const { pool, deps, calls } = triageHarness({
    sessionId: 744,
    result: {
      lastResultText: '',
      resultSubtype: 'error_during_execution',
      providerStopReason: 'rate_limit',
      agentErrorCode: 'provider_overloaded',
      agentError: '429 Too Many Requests',
      agentExit: 1,
      inputTokens: 4242,
      outputTokens: 0,
    },
  });
  const out = await bot.runTriage(pool, {}, {
    bot: BOT, app: APP, item: ITEM, mode: 'shadow',
    settings: { turnSeconds: 3600, turnInputTokens: 10_000_000 }, deps,
  });
  assert.equal(out.verdict, 'failed');
  const insert = calls.queries.find((q) => /INSERT INTO homeroom_bot_runs/.test(q.s));
  assert.match(insert.params[18], /\(empty reply\)/, 'the old text is still there to search for');
  assert.match(insert.params[18], /rate_limit/);
  assert.match(insert.params[18], /provider_overloaded/);
  assert.match(insert.params[18], /429 Too Many Requests/);
});

test('describeStop reports what is known and admits when nothing is', () => {
  assert.equal(bot.describeStop({}), '[no reason reported]',
    'an honest blank beats an invented cause');
  const line = bot.describeStop({
    resultSubtype: 'error', providerStopReason: 'max_tokens', agentErrorCode: 'ctx',
    markerlessCause: 'exit', agentExit: 2, ccExit: 0, agentError: 'context window',
  });
  assert.match(line, /subtype=error/);
  assert.match(line, /stop=max_tokens/);
  assert.match(line, /markerless=exit/);
  assert.match(line, /agentExit=2/);
  assert.ok(!/ccExit/.test(line), 'a clean exit code is not a reason and is left out');
});

test('the stop window forgets, so a later failure is still the turn own doing', () => {
  bot.noteStopped(9001, 1_000_000);
  assert.equal(bot.wasStoppedRecently(9001, 1_000_000 + bot.STOP_SETTLE_MS - 1), true);
  assert.equal(bot.wasStoppedRecently(9001, 1_000_000 + bot.STOP_SETTLE_MS + 1), false,
    'past the window it is an ordinary empty reply again');
  assert.equal(bot.wasStoppedRecently(9002, 1_000_000), false, 'and it is per session');
});

test('the usage hook reaches BOTH of the worker usage paths', () => {
  // The bug this fixes: the hook was called from applyClaudeResultUsage
  // only — the Claude `result` event — while the bot runs on the
  // Codex/OpenRouter agent, whose usage arrives through a different branch.
  // The token budget was inert in production for its whole first day.
  const w = read('src/services/worker.js');
  assert.match(w, /function notifyUsage\(state\)/, 'one implementation, not two');
  assert.equal((w.match(/\bnotifyUsage\(state\)/g) || []).length, 3,
    'declared once and called from both usage paths');
  const codexBranch = w.slice(w.indexOf("} else if (ev.kind === 'usage')"));
  assert.match(codexBranch.slice(0, 1400), /notifyUsage\(state\)/,
    'the Codex/OpenRouter branch notifies too');
  assert.match(w, /applyClaudeResultUsage[\s\S]{0,1800}?notifyUsage\(state\)/,
    'and so does the Claude result path it always did');

  // And be honest about what that buys on the agent the bot actually runs:
  // this one reports usage once, when the turn is already over.
  const agent = read('src/agents/codex-openrouter.js');
  assert.equal((agent.match(/kind: 'usage'/g) || []).length, 1, 'exactly one usage emission');
  const at = agent.indexOf("kind: 'usage'");
  const guard = agent.lastIndexOf("ev.type === 'turn.completed'", at);
  assert.ok(guard > 0 && guard < at, 'the emission sits under a turn.completed guard');
  assert.ok(!/ev\.type ===/.test(agent.slice(guard + 30, at)),
    'with no other event check between, so it is terminal: on this agent the '
    + 'token limit reports a breach after the fact rather than stopping a turn');
});

test('a turn that finishes over its token budget says so', () => {
  assert.match(SRC, /Triage turn finished over its token budget/,
    'not silently dropped just because it was too late to stop it');
  assert.match(SRC, /!budgetHit && usage\.inputTokens != null && usage\.inputTokens > turnInputTokens/,
    'and only when we did not already stop it ourselves');
});

test('the dashboard says where the token limit actually binds', () => {
  const ui = read('frontend/src/features/admin/admin-homeroom-bot.tsx');
  assert.match(ui, /id="admin-homeroom-bot-turn-tokens-note"/);
  assert.match(ui, /A warning, not a stop\./,
    'a setting that cannot stop a turn should not look like one that can');
  assert.match(ui, /keeps its verdict and the overrun is\s+logged/);
  assert.ok(!/stops an issue after/.test(ui), 'the save message stopped promising a stop too');
});
// ── Refusals and backoff (#2737) ─────────────────────────────────────────

test('runTriage: a busy session is a refusal — no ledger row, no lost queue row, an app that backs off', async () => {
  bot._resetForTests();
  const { pool, deps, calls } = triageHarness({ routed: { error: 'session_busy' } });
  const out = await bot.runTriage(pool, {}, { bot: BOT, app: APP, item: ITEM, mode: 'shadow', deps });
  assert.equal(out.reason, 'refused');
  assert.equal(out.detail, 'session_busy');
  assert.ok(!calls.queries.some((q) => /INSERT INTO homeroom_bot_runs/.test(q.s)),
    'a refusal is not a verdict: 121 of these filled the first day of the ledger');
  assert.ok(!calls.queries.some((q) => /DELETE FROM homeroom_bot_queue/.test(q.s)),
    'and the issue stays queued, because nothing was read');
  const backoff = bot.backoffFor(APP.id);
  assert.ok(backoff, 'the app is backed off');
  assert.equal(backoff.attempts, 1);
  assert.ok(backoff.remainingMs > 60_000 && backoff.remainingMs <= bot.BACKOFF_BASE_MS);
  bot._resetForTests();
});

test('the backoff doubles to an hour and a good turn resets it', () => {
  bot._resetForTests();
  const minutes = [];
  for (let i = 0; i < 8; i += 1) minutes.push(Math.round(bot.noteRefusal(4, 'session_busy', 0).delayMs / 60_000));
  assert.deepEqual(minutes, [2, 4, 8, 16, 32, 60, 60, 60], 'doubling from 2 minutes, capped at an hour');
  assert.ok(bot.backoffFor(4, 0), 'inside the window the app is skipped');
  assert.equal(bot.backoffFor(4, 61 * 60 * 1000), null, 'outside it the app is eligible again');
  bot.clearRefusals(4);
  assert.equal(bot.backoffFor(4, 0), null, 'a turn that got through clears it');
  bot._resetForTests();
});

test('runOnce: an app inside its backoff window is skipped like a paused one', async () => {
  bot._resetForTests();
  const asked = [];
  const { pool } = mockPool({ settings: [{ key: bot.KEY_MODE, value: 'shadow' }] });
  const realQuery = pool.query.bind(pool);
  pool.query = async (sql, params) => {
    if (/FROM homeroom_bot_queue q JOIN apps/.test(String(sql))) { asked.push(params); return { rows: [] }; }
    return realQuery(sql, params);
  };
  bot.noteRefusal(9, 'session_busy');
  const out = await bot.runOnce(pool, {}, { github: { async fetchPublicIssues() { return { issues: [] }; } }, forceRefresh: false });
  assert.equal(out.backedOffApps, 1);
  assert.ok(asked.length, 'the batch query still ran');
  assert.ok(asked[0][0].includes(9), 'with the backed-off app excluded by id');
  bot._resetForTests();
});

// ── Storage and platform faults (#3122) ──────────────────────────────────

const QUOTA_ERROR = 'worker: HTTP-Code: 403\nMessage: Unknown API Status Code!\nBody: "{\\"kind\\":\\"Status\\",\\"status\\":\\"Failure\\",\\"message\\":\\"persistentvolumeclaims \\\\\\"sv-worker-s4670-state\\\\\\" is forbidden: exceeded quota: social-vibecoding, requested: persistentvolumeclaims=1,requests.storage=5Gi, used: persistentvolumeclaims=120,requests.storage=600Gi, limited: persistentvolumeclaims=120,requests.storage=600Gi\\",\\"reason\\":\\"Forbidden\\",\\"code\\":403}"';

test('the bot starts its worker on temporary storage, never a volume', async () => {
  // Every issue starts a fresh thread (#3036), so nothing on the worker has
  // to outlive the turn; a 5Gi volume per app is what filled the quota.
  const { pool, deps, calls } = triageHarness({ verdictText: 'x', sessionId: 910 });
  await bot.runTriage(pool, {}, { bot: BOT, app: APP, item: ITEM, mode: 'shadow', deps });
  assert.equal(calls.ensured[0].opts.temporary, true);
});

test('summarizeFault says which quota is full instead of printing the Kubernetes body', () => {
  assert.equal(bot.summarizeFault(QUOTA_ERROR), 'the worker storage quota is full');
  assert.equal(bot.summarizeFault('worker: pods "x" is forbidden: exceeded quota: ns, requested: pods=1'), 'a worker quota is full');
  assert.equal(bot.summarizeFault('credential_required'), 'credential_required');
  assert.equal(bot.summarizeFault('a\n  b'), 'a b', 'whitespace collapses');
  assert.ok(bot.summarizeFault('x'.repeat(500)).length <= 161, 'and anything else is clipped');
});

test('a platform fault backs off the whole bot, doubling to an hour, until a turn runs', () => {
  bot._resetForTests();
  const t0 = 1_000_000;
  assert.equal(bot.faultBackoff(t0), null);
  const delays = [];
  for (let i = 0; i < 7; i += 1) delays.push(bot.noteFault(QUOTA_ERROR, t0).delayMs);
  assert.deepEqual(delays, [2, 4, 8, 16, 32, 60, 60].map((m) => m * 60 * 1000));
  const live = bot.faultBackoff(t0 + 1000);
  assert.equal(live.error, 'the worker storage quota is full');
  assert.equal(live.remainingMs, 60 * 60 * 1000 - 1000);
  bot.clearFault();
  assert.equal(bot.faultBackoff(t0 + 1000), null);
  bot._resetForTests();
});

test('a retry that hits the same fault is logged but writes no second row', async () => {
  // 60 rows in 70 minutes while the quota was full: one per retry, every 30s.
  bot._resetForTests();
  bot.noteFault(QUOTA_ERROR);
  const { pool, deps, calls } = triageHarness({ verdictText: 'x', sessionId: 911 });
  deps.worker.ensureWorker = async () => { throw new Error(QUOTA_ERROR.replace(/^worker: /, '')); };
  const out = await bot.runTriage(pool, {}, { bot: BOT, app: APP, item: ITEM, mode: 'shadow', deps });
  assert.equal(out.reason, 'infra');
  assert.ok(!calls.queries.some((q) => /INSERT INTO homeroom_bot_runs/.test(q.s)), 'no second row for the same fault');
  assert.ok(calls.queries.some((q) => /SET started_at = NULL WHERE id = \$1/.test(q.s)), 'the issue is still handed back');

  // A DIFFERENT fault in the same streak is news, and gets its row.
  const other = triageHarness({ verdictText: 'x', sessionId: 912 });
  other.deps.worker.ensureWorker = async () => { throw new Error('image pull failed'); };
  await bot.runTriage(other.pool, {}, { bot: BOT, app: APP, item: ITEM, mode: 'shadow', deps: other.deps });
  assert.ok(other.calls.queries.some((q) => /INSERT INTO homeroom_bot_runs/.test(q.s)));
  bot._resetForTests();
});

test('runOnce: inside a fault backoff it refreshes but dispatches nothing, and says when it retries', async () => {
  // A wake pulls the next pass forward to zero; without this gate it would
  // restart the storm the backoff exists to stop.
  bot._resetForTests();
  bot.noteFault(QUOTA_ERROR);
  const { pool } = mockPool({ settings: [{ key: bot.KEY_MODE, value: 'shadow' }] });
  let batched = false;
  const realQuery = pool.query.bind(pool);
  pool.query = async (sql, params) => {
    if (/FROM homeroom_bot_queue q JOIN apps/.test(String(sql))) batched = true;
    return realQuery(sql, params);
  };
  const out = await bot.runOnce(pool, {}, {
    github: { async fetchPublicIssues() { return { issues: [] }; } }, forceRefresh: true,
    worker: { async listWorkerVolumes() { return []; } },
  });
  assert.equal(out.refreshed, true, 'the queue still refreshes');
  assert.equal(batched, false, 'no batch is taken');
  assert.equal(out.paused, 'infra');
  assert.equal(out.detail, 'the worker storage quota is full');
  assert.ok(out.retryInMs > 0 && out.retryInMs <= 2 * 60 * 1000);
  bot._resetForTests();
});

test('runOnce: a triage that throws is recorded as failed and its claimed row is dropped', async () => {
  // runTriage claims its row before its first GitHub read. A throw used to
  // leave the row claimed with nothing recorded, so the issue was never tried
  // again (rss-reader #24: a "looking" post, then silence).
  bot._resetForTests();
  const { pool } = mockPool({ settings: [{ key: bot.KEY_MODE, value: 'shadow' }] });
  const writes = [];
  let heads = 0;
  let items = 0;
  const realQuery = pool.query.bind(pool);
  pool.query = async (sql, params) => {
    const s = String(sql);
    if (/FROM homeroom_bot_queue q JOIN apps/.test(s)) return { rows: heads++ === 0 ? [{ app_id: 9 }] : [] };
    if (/SELECT id, slug, name, repo_url, self_hosted FROM apps WHERE id = \$1/.test(s)) return { rows: [APP] };
    if (/FROM homeroom_bot_queue\s+WHERE app_id = \$1 AND started_at IS NULL/.test(s)) return { rows: items++ === 0 ? [ITEM] : [] };
    if (/INSERT INTO homeroom_bot_runs|DELETE FROM homeroom_bot_queue|UPDATE homeroom_bot_queue/.test(s)) writes.push({ s, params });
    if (/INSERT INTO homeroom_bot_runs/.test(s)) return { rows: [{ id: 901 }] };
    return realQuery(sql, params);
  };
  const before = Date.now();
  const out = await bot.runOnce(pool, {}, {
    github: {
      isEnabled: () => true,
      async fetchPublicIssues() { return { issues: [] }; },
      async fetchPublicIssue() { throw new TypeError('botUsername.toLowerCase is not a function'); },
    },
    limits: { async checkBudget() { return { ok: true }; } },
    worker: { async listWorkerVolumes() { return []; } },
    forceRefresh: true,
  });
  assert.equal(out.processed, 0);
  assert.ok(writes.some((w) => /UPDATE homeroom_bot_queue SET started_at = NOW\(\) WHERE id = \$1/.test(w.s) && w.params[0] === ITEM.id),
    'the triage claimed its row before it threw');
  const run = writes.find((w) => /INSERT INTO homeroom_bot_runs/.test(w.s));
  assert.ok(run, 'the failure is recorded, so the dashboard shows it');
  assert.equal(run.params[0], APP.id);
  assert.equal(run.params[1], ITEM.issue_number);
  assert.equal(run.params[4], 'failed');
  assert.equal(run.params[18], 'threw: botUsername.toLowerCase is not a function');
  assert.ok(Date.parse(run.params[12]) >= before,
    'what it has seen is now, so its own post just before the throw is not read as a change');
  assert.ok(writes.some((w) => /DELETE FROM homeroom_bot_queue WHERE id = \$1/.test(w.s) && w.params[0] === ITEM.id),
    'the claimed row is dropped, not left claimed forever');
  bot._resetForTests();
});

test('runOnce: each pass frees rows an unfinished pass claimed, past one turn\'s budget', async () => {
  bot._resetForTests();
  const { pool, log } = mockPool({ settings: [
    { key: bot.KEY_MODE, value: 'shadow' }, { key: bot.KEY_TURN_SECONDS, value: '900' },
  ] });
  const out = await bot.runOnce(pool, {}, {
    github: { async fetchPublicIssues() { return { issues: [] }; } },
    worker: { async listWorkerVolumes() { return []; } },
  });
  const release = log.find((l) => /UPDATE homeroom_bot_queue SET started_at = NULL\s+WHERE started_at IS NOT NULL AND started_at < NOW\(\) - make_interval\(secs => \$1\)/.test(l.sql || ''));
  assert.ok(release, 'claims left by a pass that died (a restart mid-turn) are released');
  assert.deepEqual(release.params, [900 + 600], 'one turn\'s budget plus a ten-minute margin: nothing live is that old');
  assert.equal(out.releasedClaims, 0);
  const off = mockPool({ settings: [{ key: bot.KEY_MODE, value: 'off' }] });
  await bot.runOnce(off.pool, {});
  assert.ok(!off.log.some((l) => /SET started_at = NULL/.test(l.sql || '')), 'off touches nothing');
  bot._resetForTests();
});

test('the loop waits out a fault backoff instead of the 30-second idle', () => {
  assert.match(SRC, /if \(out\.paused === 'infra' && out\.retryInMs > 0\) delay = Math\.max\(IDLE_PASS_DELAY_MS, out\.retryInMs\);/);
  assert.match(SRC, /if \(r\.ran\) \{ processed \+= 1; clearFault\(\); \}/, 'a turn that ran ends the streak');
});

test('releaseBotVolumes frees only the bot\'s own volumes whose worker is gone', async () => {
  const destroyed = [];
  const volumes = [
    { sessionId: 4670, attached: false, terminating: false }, // bot, idle: freed
    { sessionId: 4685, attached: true, terminating: false }, // bot, warm worker: kept
    { sessionId: 4961, attached: false, terminating: true }, // bot, already going
    { sessionId: 5000, attached: false, terminating: false }, // a person's: never
    { sessionId: 4700, attached: false, terminating: false }, // bot, delete fails: logged
  ];
  const asked = [];
  const pool = {
    async query(sql, params) {
      asked.push(params);
      return { rows: params[1].filter((id) => [4670, 4685, 4961, 4700].includes(id)).map((id) => ({ id })) };
    },
  };
  const worker = {
    async listWorkerVolumes() { return volumes; },
    async destroyCcVolume(id) { if (id === 4700) throw new Error('boom'); destroyed.push(id); },
  };
  const freed = await bot.releaseBotVolumes(pool, BOT, { worker });
  assert.deepEqual(freed, [4670]);
  assert.deepEqual(destroyed, [4670]);
  assert.equal(asked[0][0], 77, 'scoped to the bot user');
  assert.deepEqual(asked[0][1].sort(), [4670, 4700, 5000], 'only detached, settled volumes are even considered');
  assert.deepEqual(await bot.releaseBotVolumes(pool, BOT, { worker: {} }), [], 'a Docker host has nothing to free');
});

test('the dashboard says when the bot will try again after a fault', () => {
  const ui = read('frontend/src/features/admin/admin-homeroom-bot.tsx');
  assert.match(ui, /, trying again at \$\{retryAt\(payload\.loop\)\}/);
  assert.match(ui, /retryInMs\?: number \| null;/);
});

// ── A turn record nothing owns (#2737) ───────────────────────────────────

test('clearStaleTurn: clears an old record with no container, and never a live one', async () => {
  const cleared = [];
  const mk = (activeTurn, containers) => ({
    pool: { async query() { return { rows: [{ active_turn: activeTurn }] }; } },
    worker: {
      async listOrphanWorkers() { return containers; },
      async clearActiveTurn(id) { cleared.push(id); },
    },
  });
  const OLD = { startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), turnUuid: 'u', logicalTurnId: 'l' };
  const NEW = { startedAt: new Date().toISOString(), turnUuid: 'u', logicalTurnId: 'l' };

  let h = mk(null, []);
  assert.equal(await bot.clearStaleTurn(h.pool, { id: 501 }, { worker: h.worker, maxAgeMs: 1000 }), null, 'nothing set');

  h = mk(NEW, []);
  assert.equal(await bot.clearStaleTurn(h.pool, { id: 501 }, { worker: h.worker, maxAgeMs: 20 * 60 * 1000 }), null,
    'a turn younger than the budget is still running');

  h = mk(OLD, [{ name: 'usernode-worker-501', sessionId: 501, state: 'running' }]);
  assert.equal(await bot.clearStaleTurn(h.pool, { id: 501 }, { worker: h.worker, maxAgeMs: 1000 }), null,
    'a container still owns it, so it is not ours to clear');
  assert.deepEqual(cleared, []);

  h = mk(OLD, [{ name: 'usernode-worker-777', sessionId: 777, state: 'running' }]);
  const out = await bot.clearStaleTurn(h.pool, { id: 501 }, { worker: h.worker, maxAgeMs: 1000 });
  assert.ok(out && out.ageMs > 0, 'old, and nothing owns it');
  assert.deepEqual(cleared, [501]);
});

// ── The fourth verdict (#2737) ───────────────────────────────────────────

test('parseVerdict accepts empty, and it shares the question tripwire', () => {
  const parsed = bot.parseVerdict('```json\n{"verdict":"empty","determined":false,"missing_fact":"none","reason":"A test issue with no request in it; close it."}\n```');
  assert.equal(parsed.verdict, 'empty');
  assert.equal(parsed.reason, 'A test issue with no request in it; close it.');
  assert.deepEqual([...bot.TRIPWIRE_VERDICTS], ['question', 'empty'],
    'both are a demand on somebody attention, so they share one daily allowance');
  assert.ok(bot.VERDICTS.includes('empty'));
  const schema = read('src/db/schema.sql');
  assert.match(schema, /CHECK \(verdict IN \('question', 'ready', 'person', 'empty', 'failed'\)\)/);
  assert.match(schema, /ALTER TABLE homeroom_bot_runs DROP CONSTRAINT IF EXISTS homeroom_bot_runs_verdict_check/,
    'and a database that predates it is widened on boot');
});

// ── refreshApp against an injected GitHub ────────────────────────────────

test('refreshApp queues eligible issues, skips busy and unchanged ones, and drops stale rows', async () => {
  const inserts = [];
  let deleted = null;
  const pool = {
    async query(sql, params) {
      const s = String(sql);
      if (/FROM issue_claims/.test(s)) return { rows: [{ n: 3 }] };            // #3 has a live human claim
      if (/UNNEST\(cs\.linked_issues\)/.test(s)) return { rows: [{ n: 4 }] }; // #4 has a human session
      if (/headless_issue_number AS n/.test(s)) return { rows: [] };
      if (/created_from_issue_number AS n/.test(s)) return { rows: [] };
      if (/FROM chat_messages/.test(s)) return { rows: [{ n: 2, last_at: '2026-09-10T00:00:00Z' }] };
      if (/FROM homeroom_bot_runs/.test(s)) return { rows: [{ issue_number: 2, thread_seen_at: '2026-09-10T00:00:00Z' }, { issue_number: 5, thread_seen_at: '2026-09-01T00:00:00Z' }] };
      if (/INSERT INTO homeroom_bot_queue/.test(s)) { inserts.push(params); return { rows: [] }; }
      if (/DELETE FROM homeroom_bot_queue/.test(s)) { deleted = params; return { rowCount: 2, rows: [] }; }
      throw new Error(`unexpected query: ${s.slice(0, 60)}`);
    },
  };
  const github = {
    async fetchPublicIssues() {
      return {
        issues: [
          { number: 1, state: 'open', updatedAt: '2026-09-01T00:00:00Z' }, // new
          { number: 2, state: 'open', updatedAt: '2026-09-01T00:00:00Z' }, // unchanged since last run
          { number: 3, state: 'open', updatedAt: '2026-09-01T00:00:00Z' }, // claimed by a person
          { number: 4, state: 'open', updatedAt: '2026-09-01T00:00:00Z' }, // a person's session
          { number: 5, state: 'open', updatedAt: '2026-09-08T00:00:00Z' }, // changed since last run
        ],
      };
    },
  };
  const out = await bot.refreshApp(pool, { id: 9, slug: 'todo', repo_url: 'https://github.com/usernode-bot/todo' }, { github });
  assert.equal(out.queued, 2);
  assert.deepEqual(inserts.map((p) => [p[1], p[2], p[3]]), [[1, 1, 'new'], [5, 2, 'changed']]);
  assert.deepEqual(deleted, [9, [1, 5]], 'everything else queued for this app is dropped');
  assert.equal(out.removed, 2);
});

function heldPool({ inserts }) {
  // #10 and #11 were held by the proposals cap (#10 first), #12 by the
  // question tripwire, #13 is unchanged and was never held.
  return {
    async query(sql, params) {
      const s = String(sql);
      if (/FROM issue_claims|UNNEST\(cs\.linked_issues\)|headless_issue_number AS n|created_from_issue_number AS n|FROM chat_messages/.test(s)) return { rows: [] };
      if (/FROM homeroom_bot_runs/.test(s)) {
        return { rows: [
          { issue_number: 10, thread_seen_at: '2026-09-02T00:00:00Z', cap_suppressed: 'proposals_per_app', created_at: '2026-09-03T00:00:00Z' },
          { issue_number: 11, thread_seen_at: '2026-09-02T00:00:00Z', cap_suppressed: 'proposals_per_app', created_at: '2026-09-04T00:00:00Z' },
          { issue_number: 12, thread_seen_at: '2026-09-02T00:00:00Z', cap_suppressed: 'question_tripwire', created_at: '2026-09-04T00:00:00Z' },
          { issue_number: 13, thread_seen_at: '2026-09-02T00:00:00Z', cap_suppressed: null, created_at: '2026-09-03T00:00:00Z' },
        ] };
      }
      if (/INSERT INTO homeroom_bot_queue/.test(s)) { inserts.push(params); return { rows: [] }; }
      if (/DELETE FROM homeroom_bot_queue/.test(s)) return { rowCount: 0, rows: [] };
      throw new Error(`unexpected query: ${s.slice(0, 60)}`);
    },
  };
}
const HELD_GITHUB = {
  async fetchPublicIssues() {
    // Listed newest first, as GitHub does: the refresh must still take the
    // OLDEST hold when there is room for only one.
    return { issues: [13, 12, 11, 10].map((number) => ({ number, state: 'open', updatedAt: '2026-09-01T00:00:00Z' })) };
  },
};
const HELD_APP = { id: 9, slug: 'rss-reader-4113da', repo_url: 'https://github.com/usernode-bot/rss-reader' };

test('refreshApp brings back held issues once their cap has room, oldest first, no more than fit (#3152)', async () => {
  const inserts = [];
  await bot.refreshApp(heldPool({ inserts }), HELD_APP, {
    github: HELD_GITHUB, capRoom: { proposals_per_app: 1, question_tripwire: 0 },
  });
  assert.deepEqual(inserts.map((p) => [p[1], p[2], p[3]]), [[10, 2, 'cap_freed']],
    'one merged proposal frees one slot: the oldest held build comes back, the question tripwire is still full');

  inserts.length = 0;
  await bot.refreshApp(heldPool({ inserts }), HELD_APP, {
    github: HELD_GITHUB, capRoom: { proposals_per_app: 2, question_tripwire: 3 },
  });
  assert.deepEqual(inserts.map((p) => p[1]).sort(), [10, 11, 12], 'an unchanged issue nothing held stays out');
});

test('refreshApp leaves held issues alone on a shadow app', async () => {
  const inserts = [];
  const out = await bot.refreshApp(heldPool({ inserts }), HELD_APP, { github: HELD_GITHUB });
  assert.equal(out.queued, 0, 'no capRoom, no retries: in shadow a hold is only a number on the dashboard');
});

test('capRoomFor counts the same two things the live check does', async () => {
  const pool = {
    async query(sql) {
      const s = String(sql);
      if (/FROM chat_sessions/.test(s)) return { rows: [{ cnt: 1 }] };
      if (/FROM homeroom_bot_runs/.test(s)) return { rows: [{ cnt: 12 }] };
      throw new Error(`unexpected query: ${s.slice(0, 60)}`);
    },
  };
  assert.deepEqual(await bot.capRoomFor(pool, { id: 77 }, 9), { proposals_per_app: 1, question_tripwire: 0 });
  const tripwire = SRC.slice(SRC.indexOf('async function tripwireCount'), SRC.indexOf('async function capRoomFor'));
  assert.match(tripwire, /AND cap_suppressed IS NULL/,
    'a held question is not a posted one; counting it would let every retry keep the window full');
  const refresh = SRC.slice(SRC.indexOf('async function refreshQueue'), SRC.indexOf('async function nextBatch'));
  assert.equal((refresh.match(/deps\.bot && live\.isLiveFor\(settings, app\)/g) || []).length, 2,
    'both the timed refresh and a wake ask for room, and only on a live app');
  assert.match(SRC, /refreshQueue\(pool, settings, \{ \.\.\.deps, bot \}\)/);
  assert.match(SRC, /refreshApps\(pool, settings, targeted, \{ \.\.\.deps, bot \}\)/);
});

test('refreshApp treats a degraded GitHub read as "no answer", not "no issues"', async () => {
  let touched = false;
  const pool = { async query() { touched = true; return { rows: [] }; } };
  const github = { async fetchPublicIssues() { return { issues: [], note: 'rate limited' }; } };
  const out = await bot.refreshApp(pool, { id: 1, slug: 'x', repo_url: 'https://github.com/a/b' }, { github });
  assert.equal(out.skipped, 'github_unavailable');
  assert.equal(touched, false, 'a failed read must not empty the queue');
});

// ── What makes shadow mode shadow (source pins) ─────────────────────────

test('the triage turn is a read-only scout: no build mode, no push, no posting, no claims', () => {
  const dispatch = SRC.slice(SRC.indexOf('async function runTriage'), SRC.indexOf('// ── The work loop'));
  assert.match(dispatch, /mode: 'scout'/, 'the ledger loop runs in scout mode');
  // The container exec carries the token half of the budget between the
  // mode and the prompt now (#2737), and #2870's note on where that limit
  // actually binds sits with it, so the pin allows what sits between.
  assert.match(dispatch, /mode: 'scout',[\s\S]{0,1200}?\n\s*prompt,/, 'so does the container exec');
  assert.ok(!/mode: 'build'/.test(dispatch), 'never a build turn');
  assert.ok(!/telemetryComponent: 'coding_agent_build'/.test(dispatch));
  for (const forbidden of ['createIssueComment', 'claimIssueForUser', 'sendSystemMessage', 'createNotification', '/promote', 'clone-headless', 'linked_issues = ']) {
    assert.ok(!SRC.includes(forbidden), `shadow mode never reaches ${forbidden}`);
  }
  // The runner blanks the push token in scout mode — the structural half of
  // "nothing is built".
  const runner = read('worker/run-codex-agent.sh');
  assert.match(runner, /if \[ "\$MODE" = "scout" \] \|\| \[ "\$MODE" = "evidence" \]; then\s*\n\s*WORKER_JWT=""/);
});

test('the bot session is not work on any issue: is_headless FALSE, empty linked_issues, paused at rest', () => {
  const insert = SRC.slice(SRC.indexOf('INSERT INTO chat_sessions'), SRC.indexOf('RETURNING *', SRC.indexOf('INSERT INTO chat_sessions')));
  assert.match(insert, /'paused', FALSE, '\{\}'/);
  assert.match(SRC, /SET status = 'paused', last_activity_at = NOW\(\)/, 'back to paused after every turn');
  // Defence in depth on the board's two derivations, and the global cap.
  const issues = read('src/routes/issues.js');
  assert.equal((issues.match(/AND u\.is_synthetic IS NOT TRUE/g) || []).length, 2,
    'headless and in_progress derivations both skip synthetic authors');
  const sessions = read('src/routes/sessions.js');
  const capClause = "AND user_id NOT IN (SELECT id FROM users WHERE is_synthetic = TRUE)";
  assert.equal((sessions.match(new RegExp(capClause.replace(/[()]/g, '\\$&'), 'g')) || []).length, 5,
    'every global-cap count leaves synthetic sessions out');
});

test('the loop is leader-only, locked, ships off, and its spend joins the shared weekly pool', () => {
  const server = read('server.js');
  const leader = server.slice(server.indexOf('async function becomeLeader()'));
  assert.match(leader, /require\('\.\/src\/services\/homeroom-bot'\)\.start\(config\)/);
  assert.match(SRC, /pg_try_advisory_lock\(\$1, \$2\)/);
  assert.match(read('src/services/advisory-locks.js'), /HOMEROOM_BOT_LOCK = 991012/);
  const schema = read('src/db/schema.sql');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS homeroom_bot_queue/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS homeroom_bot_runs/);
  assert.match(schema, /\('homeroom_bot_mode', 'off'\)/, 'the setting seeds off');
  assert.ok(schema.indexOf('homeroom_bot_runs') < schema.indexOf('CREATE TABLE IF NOT EXISTS preview_operations'),
    'preview_operations stays the last block in schema.sql');
  assert.match(SRC, /limits\.checkBudget\(pool, bot\.id\)/, 'gated by the weekly cap before every turn');
  assert.match(SRC, /usesIncludedKey\(pool, bot\.id\)/);
  assert.match(SRC, /limits\.recordSpend\(pool, bot\.id/, 'debited into llm_usage like any included-key turn');
  assert.match(read('src/services/llm-telemetry.js'), /'homeroom_bot_triage'/);
  assert.equal(typeof bot.start, 'function');
  assert.equal(typeof bot.stop, 'function');
});

test('the triage prompt ends with the JSON contract parseVerdict reads', () => {
  const prompt = read('src/prompts/homeroom-bot-triage.md');
  assert.match(prompt, /"verdict": "question" \| "empty" \| "ready" \| "person"/);
  assert.match(prompt, /"missing_fact"/);
  assert.match(prompt, /do not edit, create, commit or push/i);
  assert.match(prompt, /exactly ONE question/i);
  // #2737. The fourth verdict, and the line that keeps it off a terse but
  // real bug report — the failure mode that would make it unusable.
  assert.match(prompt, /`empty` — there is NOTHING HERE/);
  assert.match(prompt, /NOT whether the request is short/);
  assert.match(prompt, /never an `empty`/);
});

test('the triage prompt asks about what is not in the repository instead of searching for it', () => {
  // rss-reader #24, 2026-09-25: "a dark colour closer to the platform's
  // background". The model hunted the app's repository for the platform's
  // colour: 183 reads, over 50 of the same lines of index.html, 15 fresh
  // starts, no words and no verdict, until the 20-minute wall clock.
  const prompt = read('src/prompts/homeroom-bot-triage.md');
  assert.match(prompt, /It depends on something that neither this repository nor the platform conventions answer: a value of the Homeroom platform the conventions do not state/,
    'what the platform leaves unstated, other services and taste are reasons to ask');
  assert.match(prompt, /"darker", "nicer", "like the platform"/);
  assert.match(prompt, /Nothing you can read answers these, so do not search for them\. Ask\./);
  assert.match(prompt, /If one or two targeted searches for the obvious names do not find it, it is not in the repository: ask instead of searching further\./,
    '"the repository can answer it" has a limit');
  assert.match(prompt, /Do not read a file or line range you have already read/);
  assert.match(prompt, /List or search the whole repository at most once/);
  assert.match(prompt, /still unsure after about ten reads, you have your answer: it is a `question`/);
  assert.match(prompt, /a turn that ends without the JSON block below has decided nothing/);
  // The counter-rules still stand, so it does not over-ask what the code says.
  assert.match(prompt, /Never ask something the repository or the platform conventions can answer/);
  assert.match(prompt, /Never ask when a sensible default exists/);
});

test('the triage prompt sends platform questions to the conventions tool, not to the repository', () => {
  const prompt = read('src/prompts/homeroom-bot-triage.md');
  assert.match(prompt, /are served by the `get_platform_conventions` tool: call it with no arguments for the essentials and an index of its sections, then with a section's slug to read just that section\./);
  assert.match(prompt, /That is the same document an app's notes tell an agent to fetch from the Homeroom site: use the tool, do not fetch the site\./,
    'the app\'s notes send an agent to the platform site for this document');
  assert.match(prompt, /A question about the platform is answered there, not in the app's repository: look it up with the tool/);
});

// ── runTriage with every dependency injected ─────────────────────────────

function triageHarness({ verdictText, routed = null, budgetError = null, sessionId = 501, result = null } = {}) {
  const calls = { queries: [], exec: [], spend: [], ensured: [] };
  const pool = {
    async query(sql, params) {
      const s = String(sql);
      calls.queries.push({ s, params });
      if (/SELECT \* FROM chat_sessions/.test(s)) {
        return { rows: [{ id: sessionId, user_id: 77, app_id: 9, branch_name: 'main', agent_backend: 'codex_openrouter', agent_model: 'z-ai/glm-5.3-flash' }] };
      }
      if (/INSERT INTO homeroom_bot_runs/.test(s)) return { rows: [{ id: 900 }] };
      if (/COUNT\(\*\)::int AS cnt FROM chat_sessions/.test(s)) return { rows: [{ cnt: 0 }] };
      if (/COUNT\(\*\)::int AS cnt FROM homeroom_bot_runs/.test(s)) return { rows: [{ cnt: 0 }] };
      return { rows: [] };
    },
  };
  const deps = {
    github: {
      isEnabled: () => true,
      getBotUsername: async () => 'usernode-bot',
      async fetchPublicIssue() { return { issue: { number: 12, title: 'Pins drift', body: 'They drift on zoom.', state: 'open' } }; },
      async fetchIssueComments() { return { comments: [] }; },
    },
    worker: {
      async ensureWorkerImage() {},
      async ensureWorker(id, opts) { calls.ensured.push({ id, opts }); return `usernode-worker-${sessionId}`; },
      async execInWorker(id, opts) { calls.exec.push({ id, opts }); return result || { lastResultText: verdictText, inputTokens: 1000, outputTokens: 50 }; },
      isInFlight: () => false,
      async clearActiveTurn() {},
    },
    agentTurn: { async resolveCodexRuntimeContext() { return { openrouterApiKey: 'k', agentBackend: 'codex_openrouter', agentModel: 'z-ai/glm-5.3-flash' }; } },
    limits: {
      async checkBudget() { return budgetError ? { error: budgetError, reason: 'weekly_limit' } : { ok: true }; },
      async recordSpend(_pool, userId, cents, opts) { calls.spend.push({ userId, cents, opts }); },
    },
    threadContext: { async loadIssueThread() { return { messages: [{ author: 'pat', body: 'It is the route map.', createdAt: '2026-09-20T00:00:00Z' }] }; } },
    managedOpenRouter: { async usesIncludedKey() { return true; } },
    sessions: {
      buildHeadlessSeed: (n, issue) => `Please work on GitHub issue #${n}: "${issue.title}".`,
      async runCodexAttemptLoop({ dispatchOnce, mode, telemetryComponent, resumeThreadId }) {
        calls.loop = { mode, telemetryComponent, resumeThreadId };
        if (routed) return routed;
        const result = await dispatchOnce({ openrouterApiKey: 'k', turnUuid: 't1', logicalTurnId: 'l1', attemptNumber: 1 });
        return { result, error: null, logicalTurnId: 'l1', estimatedCostUsd: 0.0123 };
      },
    },
    activeWorkers: new Set(),
  };
  return { pool, deps, calls };
}

const APP = { id: 9, slug: 'todo', name: 'Todo', repo_url: 'https://github.com/usernode-bot/todo', self_hosted: false };
const ITEM = { id: 31, app_id: 9, issue_number: 12, priority: 1, reason: 'new', thread_seen_at: '2026-09-20T00:00:00Z' };
const BOT = { id: 77, username: 'homeroom_bot' };

test('runTriage: one scout turn, a fresh thread, a recorded verdict, a debited cost, a consumed queue row', async () => {
  const { pool, deps, calls } = triageHarness({
    verdictText: 'Read the map code.\n```json\n{"verdict":"question","determined":false,"missing_fact":"which screen","question":"Which screen?","default":"Route map"}\n```',
  });
  const out = await bot.runTriage(pool, {}, { bot: BOT, app: APP, item: ITEM, mode: 'shadow', deps });
  assert.deepEqual({ ran: out.ran, verdict: out.verdict, runId: out.runId }, { ran: true, verdict: 'question', runId: 900 });
  assert.equal(calls.loop.mode, 'scout');
  assert.equal(calls.loop.resumeThreadId, null,
    'the argument only: whether the thread is fresh is tested through the platform\'s reading of null (#3035)');
  assert.equal(calls.loop.telemetryComponent, 'homeroom_bot_triage');
  assert.equal(calls.exec.length, 1);
  assert.equal(calls.exec[0].opts.mode, 'scout');
  assert.match(calls.exec[0].opts.prompt, /Please work on GitHub issue #12/);
  assert.match(calls.exec[0].opts.prompt, /END YOUR REPLY WITH EXACTLY ONE fenced JSON block/);
  assert.equal(calls.exec[0].opts.resumeSessionId, null);
  assert.equal(calls.ensured[0].opts.branchName, 'main');
  assert.deepEqual(calls.spend, [{ userId: 77, cents: 1.23, opts: { byok: false } }], 'included-key spend joins the weekly pool');
  const insert = calls.queries.find((q) => /INSERT INTO homeroom_bot_runs/.test(q.s));
  assert.equal(insert.params[4], 'question');
  assert.equal(insert.params[7], 'Which screen?');
  assert.equal(insert.params[8], 'Route map');
  assert.equal(insert.params[14], 0.0123);
  assert.ok(calls.queries.some((q) => /DELETE FROM homeroom_bot_queue WHERE id = \$1/.test(q.s) && q.params[0] === 31));
  const statuses = calls.queries.filter((q) => /UPDATE chat_sessions SET status/.test(q.s)).map((q) => q.s.match(/status = '(\w+)'/)[1]);
  assert.deepEqual(statuses, ['active', 'paused'], 'active only while the turn runs');
  assert.equal(deps.activeWorkers.size, 0, 'released after the turn');
});

test('runTriage: an issue carrying the bot\'s own GitHub comment triages instead of throwing', async () => {
  // github.getBotUsername() is async. Passed unawaited, the Promise reached
  // the real seed, and tagging a GitHub comment threw "botUsername.toLowerCase
  // is not a function". A live run posts its "looking" comment on GitHub
  // before it triages, so every live run died there (rss-reader #24).
  const { pool, deps, calls } = triageHarness({
    verdictText: '```json\n{"verdict":"question","determined":false,"missing_fact":"which colour","question":"Which dark colour?","default":"The platform background"}\n```',
  });
  deps.sessions.buildHeadlessSeed = require('../src/routes/sessions').buildHeadlessSeed;
  deps.github.getBotUsername = async () => 'usernode-bot';
  deps.github.fetchIssueComments = async () => ({ comments: [
    { author: 'usernode-bot', body: 'Homeroom bot is looking at this request.', createdAt: '2026-09-25T19:53:03Z' },
    { author: 'alice', body: 'Darker, like the platform.', createdAt: '2026-09-25T19:54:00Z' },
  ] });
  const out = await bot.runTriage(pool, {}, { bot: BOT, app: APP, item: ITEM, mode: 'shadow', deps });
  assert.deepEqual({ ran: out.ran, verdict: out.verdict }, { ran: true, verdict: 'question' });
  const prompt = calls.exec[0].opts.prompt;
  assert.match(prompt, /\[bot — earlier proposal questions, 2026-09-25, github\] Homeroom bot is looking at this request\./,
    'its own comment is recognised as the bot\'s');
  assert.match(prompt, /\[alice, 2026-09-25, github\] Darker, like the platform\./, 'a person\'s comment is not');
});

test('runTriage: the request comes first; the platform reference follows, small, with the conventions a tool call away (#24)', async () => {
  // Put first and inline (#3161), 150 KB of conventions buried the task on
  // rss-reader #24 (2026-09-26): once the model took the whole message for a
  // conventions document; once every request carried 50k tokens, the context
  // crossed the compaction limit after 86 reads, and the model's own summary
  // lost the task. The reference now follows the request, fenced, and names
  // the tool that serves the conventions a section at a time.
  const { pool, deps, calls } = triageHarness({
    verdictText: '```json\n{"verdict":"ready","determined":true,"missing_fact":"none","build_note":"x"}\n```',
  });
  await bot.runTriage(pool, {}, { bot: BOT, app: APP, item: ITEM, mode: 'shadow', deps });
  const prompt = calls.exec[0].opts.prompt;
  const at = (re) => prompt.search(re);
  const order = [
    /^Please work on GitHub issue #12/,
    /You are the Homeroom bot, triaging ONE request/,
    /"verdict": "question" \| "empty" \| "ready" \| "person",\n/,
    /==== PLATFORM REFERENCE \(for looking things up; not the request\) ====/,
    /Call `get_platform_conventions` with no arguments for the essentials and an index of its sections, then with a section's slug to read just that section\./,
    /==== UI DESIGN/,
    /you read text, not images/,
    /==== END UI DESIGN ====/,
    /==== END PLATFORM REFERENCE ====/,
    /That is the end of the reference\. Now answer the triage request above, for issue #12/,
  ].map((re) => [re, at(re)]);
  for (const [re, where] of order) assert.ok(where >= 0, `present: ${re}`);
  for (let i = 1; i < order.length; i += 1) {
    assert.ok(order[i - 1][1] < order[i][1], `${order[i - 1][0]} before ${order[i][0]}`);
  }
  assert.match(prompt, /nothing in this reference is a task\./);
  assert.doesNotMatch(prompt, /==== PLATFORM CONVENTIONS \(authoritative\) ====/, 'the conventions are not inline');
  assert.ok(prompt.length < 20000, `a triage prompt stays small: ${prompt.length} chars`);
  // The last thing the model reads is the one format parseVerdict accepts.
  assert.match(prompt, /END YOUR REPLY WITH EXACTLY ONE fenced JSON block in this format, and nothing after it:\n\{"verdict": "question" \| "empty" \| "ready" \| "person", "determined": true \| false, "missing_fact": "\.\.\.", "question": "\.\.\.", "default": "\.\.\.", "build_note": "\.\.\.", "reason": "\.\.\."\}$/);
});

test('the bot\'s GitHub login resolves to a string, or to null when it cannot be read', async () => {
  assert.equal(await live.botUsernameOf({ getBotUsername: async () => 'usernode-bot' }), 'usernode-bot');
  assert.equal(await live.botUsernameOf({ getBotUsername: () => 'usernode-bot' }), 'usernode-bot');
  assert.equal(await live.botUsernameOf({ getBotUsername: async () => { throw new Error('no installation'); } }), null);
  assert.equal(await live.botUsernameOf({ getBotUsername: () => { throw new Error('no installation'); } }), null);
  assert.equal(await live.botUsernameOf({}), null);
  assert.doesNotMatch(read('src/services/homeroom-bot.js'), /github\.getBotUsername\(\)/,
    'every read goes through botUsernameOf, which awaits it');
  assert.doesNotMatch(read('src/services/homeroom-bot-live.js'), /String\(github\.getBotUsername/);
});

test('runTriage: an unusable reply is a failed run that consumes the row; the weekly cap stops the pass', async () => {
  const bad = triageHarness({ verdictText: 'I could not decide.' });
  const out = await bot.runTriage(bad.pool, {}, { bot: BOT, app: APP, item: ITEM, mode: 'shadow', deps: bad.deps });
  assert.equal(out.verdict, 'failed');
  const insert = bad.calls.queries.find((q) => /INSERT INTO homeroom_bot_runs/.test(q.s));
  assert.equal(insert.params[4], 'failed');
  assert.match(insert.params[18], /unparseable/);
  assert.ok(bad.calls.queries.some((q) => /DELETE FROM homeroom_bot_queue/.test(q.s)), 'not retried until the thread changes');

  const capped = triageHarness({ verdictText: 'x', budgetError: 'Weekly limit reached' });
  const paused = await bot.runTriage(capped.pool, {}, { bot: BOT, app: APP, item: ITEM, mode: 'shadow', deps: capped.deps });
  assert.deepEqual({ ran: paused.ran, reason: paused.reason }, { ran: false, reason: 'budget' });
  assert.equal(capped.calls.exec.length, 0, 'no turn is dispatched over the cap');
  assert.ok(!capped.calls.queries.some((q) => /homeroom_bot_queue/.test(q.s)), 'the queue is left alone');
});

test('runTriage: a platform fault is recorded, hands the row back, and stops the pass', async () => {
  const h = triageHarness({ routed: { error: 'credential_required', logicalTurnId: 'l1' } });
  const out = await bot.runTriage(h.pool, {}, { bot: BOT, app: APP, item: ITEM, mode: 'shadow', deps: h.deps });
  assert.deepEqual({ ran: out.ran, reason: out.reason, detail: out.detail }, { ran: false, reason: 'infra', detail: 'credential_required' });
  assert.ok(h.calls.queries.some((q) => /UPDATE homeroom_bot_queue SET started_at = NULL/.test(q.s)), 'the row goes back to the queue');
  assert.ok(!h.calls.queries.some((q) => /DELETE FROM homeroom_bot_queue/.test(q.s)));
});

// ── Live on one app (#3146) ──────────────────────────────────────────────

test('runTriage on a live app: announces the first look, posts the question, records a live run', async () => {
  const { pool, deps, calls } = triageHarness({
    sessionId: 920,
    verdictText: 'Read the feed code.\n```json\n{"verdict":"question","determined":false,"missing_fact":"which feed","question":"Which feed?","default":"All of them"}\n```',
  });
  const posts = [];
  const realQuery = pool.query;
  pool.query = async (sql, params) => {
    if (/INSERT INTO homeroom_bot_posts/.test(String(sql))) { posts.push(params[3]); return { rows: [{ id: posts.length }] }; }
    return realQuery(sql, params);
  };
  const comments = [];
  deps.github.createIssueComment = async (owner, repo, n, body) => {
    comments.push(body);
    return { id: comments.length, created_at: new Date(Date.now() + 1000).toISOString() };
  };
  const thread = [];
  deps.ws = { async sendSystemMessage(_p, appId, content, msgType, metadata, scope) { thread.push({ content, msgType, scope }); return { id: thread.length }; } };
  deps.sessionLifecycle = {};
  deps.domain = 'app.onhomeroom.com';
  const out = await bot.runTriage(pool, {}, {
    bot: BOT, app: APP, item: ITEM, mode: 'shadow', deps,
    settings: { mode: 'shadow', liveApps: [APP.slug], turnSeconds: 1200, turnInputTokens: 10_000_000 },
  });
  assert.equal(out.verdict, 'question');
  assert.equal(out.acted, 'question');
  assert.deepEqual(posts, ['looking', 'question'], 'the first look, then the verdict');
  assert.match(comments[0], /Homeroom bot is looking at this request/);
  assert.match(comments[1], /Which feed\?/);
  assert.ok(thread.every((m) => m.msgType === 'system' && m.scope.type === 'issue' && m.scope.ref === 12));
  const insert = calls.queries.find((q) => /INSERT INTO homeroom_bot_runs/.test(q.s));
  assert.equal(insert.params[3], 'live', 'the ledger says which runs spoke');
  assert.ok(calls.queries.some((q) => /UPDATE homeroom_bot_runs\s+SET thread_seen_at = GREATEST/.test(q.s)),
    'and what it has seen moves past its own comments');
});

test('runTriage on an app not in the live list stays silent', async () => {
  const { pool, deps, calls } = triageHarness({
    sessionId: 921,
    verdictText: 'x\n```json\n{"verdict":"question","determined":false,"missing_fact":"a","question":"Which?","default":"b"}\n```',
  });
  deps.github.createIssueComment = async () => { throw new Error('must not post'); };
  const out = await bot.runTriage(pool, {}, {
    bot: BOT, app: APP, item: ITEM, mode: 'shadow', deps,
    settings: { mode: 'shadow', liveApps: ['some-other-app'], turnSeconds: 1200, turnInputTokens: 10_000_000 },
  });
  assert.equal(out.acted, undefined);
  assert.ok(!calls.queries.some((q) => /homeroom_bot_posts/.test(q.s)));
  const insert = calls.queries.find((q) => /INSERT INTO homeroom_bot_runs/.test(q.s));
  assert.equal(insert.params[3], 'shadow');
});
