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
  assert.deepEqual(s, { mode: 'off', concurrency: 1, batchSize: 100, pausedApps: [] });
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
  assert.match(dispatch, /mode: 'scout',\s*\n\s*prompt,/, 'so does the container exec');
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
  assert.match(prompt, /"verdict": "question" \| "ready" \| "person"/);
  assert.match(prompt, /"missing_fact"/);
  assert.match(prompt, /do not edit, create, commit or push/i);
  assert.match(prompt, /exactly ONE question/i);
});

// ── runTriage with every dependency injected ─────────────────────────────

function triageHarness({ verdictText, routed = null, budgetError = null } = {}) {
  const calls = { queries: [], exec: [], spend: [], ensured: [] };
  const pool = {
    async query(sql, params) {
      const s = String(sql);
      calls.queries.push({ s, params });
      if (/SELECT \* FROM chat_sessions/.test(s)) {
        return { rows: [{ id: 501, user_id: 77, app_id: 9, branch_name: 'main', agent_backend: 'codex_openrouter', agent_model: 'z-ai/glm-5.3-flash' }] };
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
      getBotUsername: () => 'usernode-bot',
      async fetchPublicIssue() { return { issue: { number: 12, title: 'Pins drift', body: 'They drift on zoom.', state: 'open' } }; },
      async fetchIssueComments() { return { comments: [] }; },
    },
    worker: {
      async ensureWorkerImage() {},
      async ensureWorker(id, opts) { calls.ensured.push({ id, opts }); return 'usernode-worker-501'; },
      async execInWorker(id, opts) { calls.exec.push({ id, opts }); return { lastResultText: verdictText, inputTokens: 1000, outputTokens: 50 }; },
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
  assert.equal(calls.loop.resumeThreadId, null, 'every issue starts a fresh model thread');
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
