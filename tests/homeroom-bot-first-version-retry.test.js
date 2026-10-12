'use strict';

// A first version whose build did not finish (since Oct 7, 8 of 17 failed:
// restarts, "agent exited with code 1", a time limit):
//
//   - its build turn's work is KEPT: committed and pushed from the worker
//     (worker.keepPartialWork), reviewed as any build is, and proposed when it
//     boots (homeroom-bot-live.js buildAndPropose's keepPartial);
//   - it is TRIED ONCE MORE on its own, from the plan it wrote, with no new
//     read, plan card, Build it or spec turn (homeroom-bot.js buildLive,
//     claimAutoRetry), and its creator is told;
//   - a failed build turn says WHY: the API error notice before the exit code
//     it caused, what it was last doing and its final message, on the run's
//     build_error (failureDetail, recordLiveBuild).
//
// Run with: node --test tests/homeroom-bot-first-version-retry.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const bot = require('../src/services/homeroom-bot');
const live = require('../src/services/homeroom-bot-live');
const dm = require('../src/services/homeroom-bot-dm');
const configs = require('../src/services/bot-configs');

const OPUS = 'anthropic/claude-opus-5.5';
const GLM = 'z-ai/glm-5.3-flash';
const REVIEWER = { model: OPUS, maxRounds: 1, budgetMinutes: 25 };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const API_ERROR = 'API Error: 429 {"error":{"message":"Provider returned error","code":429}}';

const shot = (place, id) => ({ place, artifactId: id, width: 390, height: 844 });
function captureOf(n, { booted = true } = {}) {
  return {
    booted,
    error: booted ? null : 'npm run build failed',
    steps: { boot: { command: 'node server.js', log: 'Error: Cannot find module x' } },
    shots: booted ? [shot('phone-light-populated', `a${n}1`), shot('desktop-light-populated', `a${n}2`)] : [],
    checks: { consoleErrors: { count: 0 } },
    ms: 1000,
  };
}

// buildAndPropose with stub turns. The build turn's result is `buildTurn`;
// every later turn (a review fix) lands. `kept` is what worker.keepPartialWork
// answers (null: the worker has no such step).
function harness({ buildTurn, kept = null, booted = true } = {}) {
  const calls = { turns: [], kept: [], captures: 0, promotions: [], stops: 0, cleared: 0 };
  let n = 0;
  const pool = {
    async query(sql) {
      return /INSERT INTO chat_sessions/.test(String(sql)) ? { rows: [{ id: 5001 }] } : { rows: [], rowCount: 1 };
    },
  };
  const worker = {
    async ensureWorkerImage() {},
    async ensureWorker() { return 'w'; },
    async execInWorker(_id, opts) {
      calls.turns.push({ mode: opts.mode, commitMsg: opts.commitMsg });
      if (opts.mode === 'scout') return { lastResultText: '# Plant log\n\n## User-facing changes\nIt logs plants.' };
      n += 1;
      if (n === 1) return { agentHarness: 'claude', ...buildTurn };
      return { pushOk: true, ahead: 2, sha: 'fix1', lastResultText: 'Fixed.' };
    },
    stopTurn() { calls.stops += 1; return Promise.resolve(); },
    clearPendingStop() { calls.cleared += 1; },
  };
  if (kept) {
    worker.keepPartialWork = async (sessionId, opts) => { calls.kept.push({ sessionId, ...opts }); return kept; };
  }
  const deps = {
    worker,
    sessions: {
      async runCodexAttemptLoop(args) {
        await args.resolveRuntime();
        return { result: await args.dispatchOnce({ resumeSessionId: args.resumeThreadId || null }), estimatedCostUsd: 0.1 };
      },
      async persistScoutPublication() { return { specVersion: 1 }; },
    },
    agentTurn: { async resolveCodexRuntimeContext() { return {}; } },
    sessionLifecycle: { async ensureSessionBranch({ sessionId }) { return { branchName: `b${sessionId}` }; } },
    activeWorkers: new Set(),
    seesImages: true,
    github: { async forceBranchToSha() { return { updated: true }; } },
    captureRound: async () => {
      calls.captures += 1;
      return { ok: true, capture: captureOf(calls.captures, { booted }) };
    },
    reviewDeps: {
      readArtifacts: async (_pool, ids) => new Map(ids.map((id) => [id, { id, content_type: 'image/png', data: PNG }])),
      callReviewer: async () => ({ ok: true, text: JSON.stringify({ verdict: 'ship', issues: [] }), costUsd: 0.2, ms: 10 }),
    },
    votesRouter: { handle(req, res) { calls.promotions.push(req.url); res.json({ ok: true, prNumber: 88 }); } },
  };
  return { pool, deps, calls };
}

const ARGS = {
  config: { dataEncryptionKey: 'k' }, bot: { id: 77, username: 'homeroom_bot' }, app: { id: 9, slug: 'pulse' },
  repo: { owner: 'o', repo: 'r' }, issueNumber: 1, issue: { title: 'Plant log' }, seed: 'ISSUE #1: a plant log',
  buildNote: 'x', turnBudgetMs: 60_000, firstVersion: true, model: GLM, specModel: OPUS,
};
// An OpenRouter 429 once Claude Code's retries are spent: it exits 0, and
// run-cc.sh exits 1 for it.
const FAILED = { ccExit: 0, exitCode: 1, pushOk: false, ahead: 0, sha: '', lastResultText: API_ERROR };

// ── 1. Partial work is kept, reviewed and proposed ──────────────────────

test('a live first version whose build turn failed proposes the work it pushed once its review sees it boot', async () => {
  const h = harness({ buildTurn: FAILED, kept: { pushed: true, sha: 'part1', commits: 1 } });
  const out = await live.buildAndPropose({
    pool: h.pool, deps: h.deps, ...ARGS, propose: true, keepPartial: true,
    review: { reviewer: REVIEWER, owner: { botRunId: 900 } },
  });
  assert.equal(out.ok, true, out.error);
  assert.deepEqual(h.calls.kept, [{ sessionId: 5001, branchName: 'b5001', commitMsg: 'Homeroom bot: #1 Plant log' }],
    'the session\'s own branch, committed as the build would have been');
  assert.ok(h.calls.cleared >= 1, 'no stop left pending for the review\'s turns');
  assert.ok(h.calls.captures >= 1, 'the kept work was captured');
  assert.equal(out.review.round0.sha, 'part1', 'the review starts from the kept commit');
  assert.deepEqual(h.calls.promotions, ['/api/sessions/5001/promote'], 'and it is proposed');
  assert.equal(out.prNumber, 88);
  assert.match(out.partial.reason, /^the build turn failed \(it ended on an API error: API Error: 429/);
  assert.equal(out.partial.commits, 1);

  // Recorded on the run: built, from partial work.
  const queries = [];
  await bot.announceBuilt({
    pool: { async query(sql, params) { queries.push({ sql: String(sql), params }); return { rows: [], rowCount: 1 }; } },
    ws: null, app: ARGS.app, bot: ARGS.bot, issueNumber: 1, runId: 900, built: out, domain: 'app.example',
    say: async () => {},
  });
  const recorded = queries.find((q) => /SET build_ok = \$2, build_error = \$3/.test(q.sql));
  assert.equal(recorded.params[1], true);
  assert.match(recorded.params[2], /^finished from partial work \(the build turn failed \(it ended on an API error/);
});

test('a build turn that ran past its time limit keeps its work the same way', async () => {
  const h = harness({ buildTurn: FAILED, kept: { pushed: true, sha: 'part1', commits: 1 } });
  // The clock runs out at once: the turn is stopped.
  h.deps.worker.execInWorker = async (_id, opts) => {
    h.calls.turns.push({ mode: opts.mode });
    if (opts.mode === 'scout') return { lastResultText: '# Plant log\n\n## User-facing changes\nIt logs plants.' };
    if (h.calls.turns.filter((t) => t.mode === 'build').length === 1) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { agentHarness: 'claude', pushOk: false, ahead: 0 };
    }
    return { pushOk: true, ahead: 2, sha: 'fix1' };
  };
  const out = await live.buildAndPropose({
    pool: h.pool, deps: h.deps, ...ARGS, turnBudgetMs: 5, propose: false, keepPartial: true,
    review: { reviewer: REVIEWER, owner: { botRunId: 900 } },
  });
  assert.equal(out.ok, true, out.error);
  assert.equal(h.calls.stops, 1);
  assert.equal(out.partial.reason, 'the build ran past its time limit');
});

test('kept work that never boots fails as before, and so does a build with nothing to keep', async () => {
  const broken = harness({ buildTurn: FAILED, kept: { pushed: true, sha: 'part1', commits: 1 }, booted: false });
  const out = await live.buildAndPropose({
    pool: broken.pool, deps: broken.deps, ...ARGS, propose: true, keepPartial: true,
    review: { reviewer: REVIEWER, owner: { botRunId: 900 } },
  });
  assert.equal(out.ok, false);
  assert.match(out.error, /; the work it pushed did not boot$/);
  assert.deepEqual(broken.calls.promotions, [], 'nothing is put up for a vote');

  const empty = harness({ buildTurn: FAILED, kept: { pushed: false, reason: 'nothing differs from main' } });
  const none = await live.buildAndPropose({
    pool: empty.pool, deps: empty.deps, ...ARGS, propose: true, keepPartial: true,
    review: { reviewer: REVIEWER, owner: { botRunId: 900 } },
  });
  assert.equal(none.ok, false);
  assert.match(none.error, /^the build turn failed \(it ended on an API error: API Error: 429/);
  assert.equal(empty.calls.captures, 0, 'nothing to review');
});

test('anything but a live first version keeps nothing from a failed turn', async () => {
  for (const over of [{ keepPartial: false }, { keepPartial: true, review: null }]) {
    const h = harness({ buildTurn: FAILED, kept: { pushed: true, sha: 'part1', commits: 1 } });
    // eslint-disable-next-line no-await-in-loop
    const out = await live.buildAndPropose({
      pool: h.pool, deps: h.deps, ...ARGS, propose: true, review: { reviewer: REVIEWER, owner: { botRunId: 900 } }, ...over,
    });
    assert.equal(out.ok, false);
    assert.deepEqual(h.calls.kept, [], JSON.stringify(over));
    assert.deepEqual(h.calls.promotions, []);
  }
});

// ── 2. One automatic retry, from the plan ───────────────────────────────

function liveArgs(over = {}) {
  const queries = [];
  const pool = {
    async query(sql, params) {
      const text = String(sql);
      queries.push([text, params]);
      if (/SET build_retry = jsonb_build_object/.test(text)) return { rows: over.claimRefused ? [] : [{ id: 900 }] };
      if (/RETURNING id/.test(text) && /homeroom_bot_run_snapshots/.test(text)) return { rows: [{ id: 321 }] };
      return { rows: [] };
    },
  };
  return {
    queries,
    args: {
      pool, config: {}, bot: { id: 77, username: 'homeroom_bot' }, app: { id: 9, slug: 'plant-log' }, repo: { owner: 'o', repo: 'r' },
      issueNumber: 1, issue: { title: 'Plant Log' }, parsed: { verdict: 'ready', buildNote: 'x' }, runId: 900,
      seed: 's', seedReadAt: '2026-10-12T10:00:00Z', postedAt: [], turnBudgetMs: 1000, model: 'stage/build', specModel: 'stage/spec',
      firstVersion: true,
      deps: {
        github: { getBotUsername: async () => 'usernode-bot', async fetchIssueComments() { return { comments: [] }; }, async getBranchSha() { return 'b'.repeat(40); } },
        ws: {}, threadContext: { async loadIssueThread() { return { messages: [] }; } },
        limits: { async recordSpend() {}, async checkBudget() { return {}; } },
        managedOpenRouter: { async usesIncludedKey() { return false; } }, domain: 'x',
        dm: { async requesterOf() { return null; } },
      },
    },
  };
}

function stubLive(t, results) {
  const real = {
    buildAndPropose: live.buildAndPropose, post: live.post,
    currentVersion: configs.currentVersion, spawnSideBuilds: configs.spawnSideBuilds, finishLive: configs.finishLive,
  };
  const seen = {
    builds: [], posts: [], finished: [],
    // A fresh build of the same stubs: what the next builds come to.
    again(next) { results.splice(0, results.length, ...next); this.builds = []; this.posts = []; },
  };
  configs.currentVersion = async () => null;
  configs.finishLive = async (_pool, a) => { seen.finished.push(a); return true; };
  live.post = async (p) => { seen.posts.push({ kind: p.kind, text: p.text, dm: p.dm || null }); return {}; };
  live.buildAndPropose = async (a) => { seen.builds.push(a); return results.shift(); };
  t.after(() => {
    Object.assign(live, { buildAndPropose: real.buildAndPropose, post: real.post });
    Object.assign(configs, { currentVersion: real.currentVersion, spawnSideBuilds: real.spawnSideBuilds, finishLive: real.finishLive });
  });
  return seen;
}

const FIRST_FAILED = {
  ok: false, sessionId: 5001, error: 'the build turn failed (the agent exited with code 1); it last said: Stopped.',
  specMd: '# Plant log\n\n## User-facing changes\nIt logs plants.', specVersion: 1, costUsd: 1.25,
};

test('a first version that did not finish is built once more from its plan, and its creator is told', async (t) => {
  const seen = stubLive(t, [{ ...FIRST_FAILED }, { ok: true, sessionId: 5002, prNumber: 7, costUsd: 0.5 }]);
  const { args, queries } = liveArgs();
  const acted = await bot.buildLive(args);
  assert.equal(acted, 'proposed');
  assert.equal(seen.builds.length, 2, 'one retry');
  const [first, retry] = seen.builds;
  assert.equal(first.presetSpec, null);
  assert.equal(first.keepPartial, true, 'a first version keeps a failed turn\'s work');
  assert.equal(retry.presetSpec, FIRST_FAILED.specMd, 'built from the plan it wrote: no new spec turn');
  assert.equal(retry.onSpec, null, 'the plan is not posted again');
  assert.equal(retry.firstVersion, true);
  assert.equal(typeof retry.onSession, 'function', 'the retry links its own session to the run');
  // The run gave up the failed session's link, kept its plan, and is marked retried.
  const claim = queries.find(([sql]) => /SET build_retry = jsonb_build_object/.test(sql));
  assert.ok(claim);
  assert.deepEqual([claim[1][0], claim[1][2], claim[1][4], claim[1][5]], [900, 5001, FIRST_FAILED.specMd, 1]);
  assert.match(claim[0], /build_session_id = NULL, live_build_waiting_at = NOW\(\)/);
  assert.match(claim[0], /NOT EXISTS \(\s*SELECT 1 FROM homeroom_bot_runs o\s+WHERE o\.app_id = \$2 AND o\.issue_number = r\.issue_number AND o\.build_retry IS NOT NULL/,
    'once per first version');
  // Said where the build's start is said, and in the creator's DM.
  const told = seen.posts.find((p) => p.dm?.retry);
  assert.equal(told.kind, 'spec');
  assert.equal(told.text, live.retryCommentText());
  assert.ok(seen.posts.indexOf(told) < seen.posts.findIndex((p) => p.kind === 'proposal'));
  // Recorded: proposed, after a retry, with both tries' cost.
  const recorded = queries.find(([sql]) => /SET build_ok = \$2, build_error = \$3/.test(sql));
  assert.equal(recorded[1][1], true);
  assert.match(recorded[1][2], /^tried once more after: the build turn failed \(the agent exited with code 1\)/);
  assert.equal(recorded[1][6], 1.75);
});

test('a second failure ends as today, with Try again; and only once per first version', async (t) => {
  const seen = stubLive(t, [{ ...FIRST_FAILED }, { ok: false, sessionId: 5002, error: 'the build ran past its time limit', specMd: FIRST_FAILED.specMd }]);
  const { args, queries } = liveArgs();
  assert.equal(await bot.buildLive(args), 'build_failed');
  assert.equal(seen.builds.length, 2, 'no third try');
  assert.equal(queries.filter(([sql]) => /SET build_retry = jsonb_build_object/.test(sql)).length, 1);
  const failed = seen.posts.filter((p) => p.kind === 'build_failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].dm.reason, 'the build ran past its time limit');

  // Another first version of the request was already retried: the claim is refused.
  seen.again([{ ...FIRST_FAILED }]);
  const again = seen;
  const refused = liveArgs({ claimRefused: true });
  assert.equal(await bot.buildLive(refused.args), 'build_failed');
  assert.equal(again.builds.length, 1);
  assert.ok(!again.posts.some((p) => p.dm?.retry));
});

test('no retry for a skip, an impossible request, a lost claim, a build only not proposed, partial work, a later change, or no plan', async (t) => {
  const cases = [
    { ...FIRST_FAILED, skipped: 'skipped: the request was closed' },
    { ...FIRST_FAILED, blocked: 'it cannot be done' },
    { ...FIRST_FAILED, notProposed: true },
    { ...FIRST_FAILED, partial: { reason: 'x' } },
    { ...FIRST_FAILED, specMd: undefined },
    { ...FIRST_FAILED, ok: true },
  ];
  for (const c of cases) assert.equal(bot.autoRetryable(c), false, JSON.stringify(Object.keys(c)));
  assert.equal(bot.autoRetryable(FIRST_FAILED), true);

  const seen = stubLive(t, [{ ...FIRST_FAILED }]);
  const { args, queries } = liveArgs();
  await bot.buildLive({ ...args, firstVersion: false });
  assert.equal(seen.builds.length, 1, 'a later change is not retried');
  assert.equal(seen.builds[0].keepPartial, undefined);
  assert.ok(!queries.some(([sql]) => /build_retry/.test(sql)));
});

test('a build from a preset plan runs no spec turn', async () => {
  const h = harness({ buildTurn: { pushOk: true, ahead: 1, sha: 'sha1', lastResultText: 'Built.' } });
  const out = await live.buildAndPropose({
    pool: h.pool, deps: h.deps, ...ARGS, propose: false, presetSpec: '# Plant log\n\n## User-facing changes\nIt logs plants.',
  });
  assert.equal(out.ok, true, out.error);
  assert.deepEqual(h.calls.turns.map((x) => x.mode), ['build'], 'the build alone');
});

test('the creator hears it is trying once more as a message of its own, not only on the card', () => {
  const context = { appName: 'Plant Log', appSlug: 'plant-log', issueNumber: 1, issueTitle: 'Plant Log', firstVersion: true };
  // One story: a quiet line in its request's thread, as every step is.
  assert.match(dm.dmText('spec', { building: true, retry: true }, context),
    /My first try didn't finish, so I'm trying once more from the same plan\.$/);
  assert.match(dm.dmText('spec', { building: true }, context), /I'm building the first version now\./);
  assert.equal(dm.cardOnly('spec', { retry: true }), true);
  assert.equal(dm.cardOnly('spec', {}), true);
  assert.match(live.retryCommentText(), /trying once more from the same plan/);
});

// ── 3. Why a build turn failed ───────────────────────────────────────────

test('a failed build turn says why: the API error before the exit code, its last activity and its final message', () => {
  // The notice run-cc.sh exits 1 after is the reason, not the exit code.
  assert.equal(live.failedClaudeTurn({ agentHarness: 'claude', exitCode: 1, lastResultText: API_ERROR }), `it ended on an API error: ${API_ERROR}`);
  assert.equal(live.failedClaudeTurn({ agentHarness: 'claude', exitCode: 1, lastResultText: 'Edited app.js.' }), 'the agent exited with code 1');

  const progress = { suffix: () => '; last activity: Running npm test' };
  const reason = `the build turn failed (it ended on an API error: ${API_ERROR})`;
  assert.equal(live.failureDetail({ progress, result: { lastResultText: API_ERROR }, reason }), '; last activity: Running npm test',
    'the notice the reason quotes is not said twice');
  assert.equal(live.failureDetail({ progress, result: { lastResultText: 'I could not\nfinish the  board.' }, reason: 'x' }),
    '; last activity: Running npm test; it last said: I could not finish the board.');
  assert.equal(live.failureDetail({}), '');
  // Secrets in what it said are redacted.
  // Assembled here, so the file holds nothing shaped like a key.
  const fakeKey = ['sk', 'or', 'v1', '0123456789abcdef'.repeat(4)].join('-');
  assert.ok(!live.failureDetail({ result: { lastResultText: `token ${fakeKey}` } }).includes(fakeKey));
});

test('the plain words read the reason alone, never what the agent last said', () => {
  const words = (reason) => dm.buildFailedWords(reason, 'this', 'me');
  assert.equal(words('the build turn failed (the agent exited with code 1); it last said: the dev server would not start'),
    words('the build turn failed (the agent exited with code 1)'));
  assert.equal(words('the build ran past its time limit; last activity: Restarted the server'), words('the build ran past its time limit'));
});

test('the run keeps the detail, and the connector shows it whole', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/services/bench/connector-data'), 'utf8');
  assert.match(src, /error: r\.build_error \? clipText\(r\.build_error, 600\) : null/);
});
