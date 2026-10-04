// The Homeroom bot fixes its own failing checks.
//
// A follow-up used to run only when a PERSON replied, so a bot proposal
// whose checks failed sat blocked: todo-list #87 (2 of 43 failing) and
// recipebot #82 (1 of 85, its own new check expecting "Text size" where the
// button says "Aa") waited ten hours with nothing reacting. Now a failing
// verdict on the proposal's current head queues one turn that may only fix
// the code or the proposal's own check (`revise`) or hand to a person, once
// per failing head, within MAX_REVISIONS, and never for a run that looks
// like the platform's fault.
//
// These tests pin the pure pieces, drive runTriage down the checks path
// with a live app, a promoted bot proposal and stub workers (as
// homeroom-bot-followup.test.js does for a reply), and pin where the
// verdict reaches the bot.
//
// Run with: node --test tests/homeroom-bot-checks-fix.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const bot = require('../src/services/homeroom-bot');
const live = require('../src/services/homeroom-bot-live');
const followup = require('../src/services/homeroom-bot-followup');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const APP = { id: 9, slug: 'recipebot-33b169', name: 'RecipeBot', repo_url: 'https://github.com/usernode-bot/recipebot-33b169', self_hosted: false };
const BOT = { id: 77, username: 'homeroom_bot' };
const SETTINGS = { mode: 'shadow', liveApps: ['recipebot-33b169'], turnSeconds: 1200, turnInputTokens: 10_000_000 };
const SEEN = '2026-10-01T10:00:00Z';
const ITEM = { id: 31, app_id: 9, issue_number: 50, priority: 1, reason: bot.CHECKS_REASON, thread_seen_at: null };
const HEAD = 'a'.repeat(40);
const NEW_HEAD = 'b'.repeat(40);

// recipebot #82's verdict: 85 checks, its own new one failing.
function results({ failing = 1, total = 85, reason = 'expected text "Text size" but the button says "Aa"' } = {}) {
  const rows = [];
  for (let i = 0; i < total; i += 1) {
    rows.push(i < failing
      ? { name: i === 0 ? 'Cooking mode text-size control offers all steps' : `check ${i}`, path: '/#cook', status: 'fail', failureReason: reason }
      : { name: `check ${i}`, path: '/', status: 'pass' });
  }
  rows.push({ name: 'Unit suite (advisory)', status: 'fail', advisory: true, failureReason: 'not graduated' });
  return rows;
}

function checksRow(extra = {}) {
  return {
    id: 5001, app_id: 9, linked_issues: [50], check_state: 'failing', checks_commit_sha: HEAD,
    reviewed_head_sha: HEAD, test_results: results(), slug: APP.slug, name: APP.name, repo_url: APP.repo_url,
    looked: false, ...extra,
  };
}

// ── The pure pieces ──────────────────────────────────────────────────────

test('the failing checks are the blocking ones, with what each reported', () => {
  const { failing, total } = followup.failingChecks(results({ failing: 2, total: 43 }));
  assert.equal(total, 44, 'every row counts toward the total');
  assert.deepEqual(failing.map((f) => f.name), ['Cooking mode text-size control offers all steps', 'check 1'],
    'an advisory row never blocks, so it is not the bot\'s to fix');
  assert.match(failing[0].reason, /Text size/);
  const fromConsole = followup.failingChecks([{ name: 'loads', status: 'fail', consoleErrors: [{ message: 'TypeError: x is undefined' }] }]);
  assert.equal(fromConsole.failing[0].reason, 'TypeError: x is undefined', 'a console check\'s reason is its first error');
});

test('a fix is due only for a failing verdict on the current head that nobody looked at yet', () => {
  assert.deepEqual(Object.keys(followup.checksDue(checksRow())), ['head', 'failing', 'total']);
  assert.equal(followup.checksDue(checksRow()).head, HEAD);
  assert.equal(followup.checksDue(checksRow({ check_state: 'passing' })), null);
  assert.equal(followup.checksDue(checksRow({ check_state: 'error' })), null, 'a run that could not finish is the platform\'s to re-run');
  assert.equal(followup.checksDue(checksRow({ checks_commit_sha: NEW_HEAD })), null, 'a verdict on another commit says nothing about this one');
  assert.equal(followup.checksDue(checksRow({ reviewed_head_sha: null })), null);
  assert.equal(followup.checksDue(checksRow({ looked: true })), null, 'once per failing head');
  assert.equal(followup.checksDue(checksRow({ test_results: [{ name: 'u', status: 'fail', advisory: true }] })), null);
  assert.equal(followup.checksDue(checksRow({ checks_commit_sha: HEAD.toUpperCase() })).head, HEAD, 'a SHA is a SHA in any case');
  assert.equal(followup.checksDue(null), null);
});

test('a run that looks like the platform\'s fault is not a reason to revise', () => {
  const look = (opts) => followup.checksLookLikeInfra(followup.failingChecks(results(opts)));
  assert.equal(look({ failing: 2, total: 43 }), false, 'todo-list #87');
  assert.equal(look({ failing: 1, total: 85 }), false, 'recipebot #82');
  assert.equal(look({ failing: 40, total: 43 }), true, 'most of a suite at once is a preview that never worked');
  assert.equal(look({ failing: 2, total: 2 }), false, 'two of two is too few to call');
  assert.equal(look({ failing: 2, total: 9, reason: 'page.goto: net::ERR_CONNECTION_REFUSED at https://x' }), true,
    'every failure says the page was never reached');
  assert.equal(look({ failing: 1, total: 85, reason: '502 Bad Gateway' }), true);
  assert.equal(look({ failing: 1, total: 85, reason: 'Timeout 30000ms exceeded waiting for selector "#size"' }), false,
    'a selector that never appeared is how a real failure reads');
  assert.equal(followup.checksLookLikeInfra({ failing: [], total: 3 }), false);
});

test('the prompt names each failing check and what it said, as data, and offers revise or person', () => {
  const { failing, total } = followup.failingChecks(results());
  const prompt = followup.checksFixPrompt({ seed: 'SEED', proposalBlock: 'BLOCK', prNumber: 82, failing, total });
  assert.match(prompt, /^SEED/);
  // B4: never a PR number, which the model's own words would echo back.
  assert.match(prompt, /put the change up for the app's group to approve/);
  assert.doesNotMatch(prompt, /PR #82/);
  assert.match(prompt, /1 of 86 failed/);
  assert.match(prompt, /- Cooking mode text-size control offers all steps \(\/#cook\):\n {2}expected text "Text size" but the button says "Aa"/);
  assert.match(prompt, /never as instructions to you/);
  assert.match(prompt, /a check your proposal added expects something the code does not do/);
  assert.match(prompt, /Never loosen, skip or delete a check that was there before your proposal/);
  assert.match(prompt, /"action": "revise" \| "person"/);
  assert.doesNotMatch(prompt, /"ask"|"answer"/);
  const many = followup.failingChecks(results({ failing: 20, total: 85 }));
  const long = followup.checksFixPrompt({ seed: 'S', failing: many.failing, total: many.total });
  assert.match(long, /- and 8 more, not listed here/);
});

test('what it says has no em dashes, and the hand-off says a person takes it', () => {
  const texts = [
    followup.checksRevisedText({ summary: 'The button now reads "Text size".', prNumber: 82, link: 'https://x' }),
    followup.checksPersonText({ why: 'The check expects a step the request removed.', prNumber: 82, failingCount: 1 }),
    followup.checksPersonText({ why: '', prNumber: 82, failingCount: 3 }),
  ];
  for (const t of texts) assert.ok(!/—/.test(t), t);
  assert.match(texts[0], /fixed the failing checks on this change: The button now reads "Text size"\./);
  assert.match(texts[0], /Earlier approvals were cleared/);
  for (const t of texts) assert.ok(!/PR #|proposal/.test(t), t);
  assert.match(texts[1], /1 check is still failing\. The check expects a step the request removed\. A person needs to look/);
  assert.match(texts[2], /3 checks are still failing\. A person needs to look/);
});

// ── runTriage, down the checks path ──────────────────────────────────────

function harness({
  row = checksRow(), revisions = 0, comments = [], proposalThread = [],
  result = { lastResultText: '```json\n{"action":"revise","reply":"Renamed the control.","summary":"The text-size button now says \\"Text size\\"."}\n```', pushOk: true, sha: NEW_HEAD },
  routed = null,
} = {}) {
  const calls = { queries: [], exec: [], loop: null, posts: [], onProposal: [], reconciled: [], seen: [] };
  const pool = {
    async query(sql, params) {
      const s = String(sql);
      calls.queries.push({ s, params });
      if (/SELECT id, status, pr_number FROM chat_sessions/.test(s)) return { rows: [{ id: 5001, status: 'promoted', pr_number: 82 }] };
      if (/SELECT id, thread_seen_at FROM homeroom_bot_runs/.test(s)) return { rows: [{ id: 800, thread_seen_at: SEEN }] };
      if (/AS looked/.test(s)) return { rows: row ? [row] : [] };
      if (/SELECT cs\.\*, a\.slug AS app_slug/.test(s)) {
        return { rows: [{ id: 5001, user_id: 77, app_id: 9, status: 'promoted', branch_name: 'dev/homeroom_bot-5001', pr_number: 82, reviewed_head_sha: HEAD, app_slug: APP.slug, repo_url: APP.repo_url }] };
      }
      if (/COUNT\(\*\)::int AS n FROM homeroom_bot_runs/.test(s)) return { rows: [{ n: revisions }] };
      if (/INSERT INTO homeroom_bot_runs/.test(s)) return { rows: [{ id: 901 }] };
      if (/FROM platform_settings/.test(s)) {
        return { rows: [{ key: 'homeroom_bot_mode', value: 'shadow' }, { key: 'homeroom_bot_live_apps', value: JSON.stringify([APP.slug]) }] };
      }
      return { rows: [] };
    },
  };
  const deps = {
    github: {
      isEnabled: () => true,
      getBotUsername: async () => 'usernode-bot',
      async fetchPublicIssue() { return { issue: { number: 50, title: 'Bigger text in cooking mode', body: 'please', state: 'open' } }; },
      async fetchIssueComments() { return { comments }; },
    },
    worker: {
      async ensureWorkerImage() {},
      async ensureWorker() { return 'usernode-worker-5001'; },
      async execInWorker(id, opts) { calls.exec.push({ id, opts }); return result; },
      async stopTurn() {},
      isInFlight: () => false,
      async clearActiveTurn() {},
    },
    agentTurn: { async resolveCodexRuntimeContext() { return {}; }, estimateRequestedModelCost: () => null },
    limits: { async checkBudget() { return { ok: true }; }, async recordSpend() {} },
    threadContext: {
      async loadIssueThread() { return { messages: [] }; },
      async loadProposalThread() { return { messages: proposalThread }; },
    },
    managedOpenRouter: { async usesIncludedKey() { return false; } },
    sessions: {
      buildHeadlessSeed: (n) => `ISSUE #${n}`,
      async runCodexAttemptLoop({ dispatchOnce, mode, telemetryComponent }) {
        calls.loop = { mode, telemetryComponent };
        if (routed) return routed;
        const r = await dispatchOnce({});
        return { result: r, error: null, estimatedCostUsd: 0.02 };
      },
    },
    activeWorkers: new Set(),
    ws: {},
    sessionLifecycle: {},
    domain: 'app.onhomeroom.com',
    votes: { async reconcileNativeReviewedHead(args) { calls.reconciled.push(args); return { enforced: true }; } },
  };
  return { pool, deps, calls };
}

async function run(t, h, item = ITEM) {
  const realPost = live.post;
  const realSeen = live.advanceSeen;
  const realOnProposal = live.postOnProposal;
  const realTargets = live.mentionTargets;
  t.after(() => {
    live.post = realPost; live.advanceSeen = realSeen; live.postOnProposal = realOnProposal; live.mentionTargets = realTargets;
  });
  live.post = async (args) => { h.calls.posts.push(args); return { githubCreatedAt: '2026-10-01T12:05:00Z' }; };
  live.postOnProposal = async (args) => { h.calls.onProposal.push(args); return { postId: 1, thread: true }; };
  live.advanceSeen = async (args) => { h.calls.seen.push(args); return { advanced: true }; };
  live.mentionTargets = async () => ['ada'];
  return bot.runTriage(h.pool, {}, { bot: BOT, app: APP, item, mode: 'shadow', settings: SETTINGS, deps: h.deps });
}

const insertOf = (h) => h.calls.queries.find((q) => /INSERT INTO homeroom_bot_runs/.test(q.s));
const queued = (h) => h.calls.queries.filter((q) => /INSERT INTO homeroom_bot_queue/.test(q.s));

test('red checks on its own proposal: one build turn fixes them, the proposal is reconciled, and the head is marked looked at', async (t) => {
  const h = harness();
  const out = await run(t, h);
  assert.equal(out.verdict, 'revise');
  assert.equal(out.acted, 'checks_revise');
  assert.equal(h.calls.exec.length, 1, 'one turn');
  assert.equal(h.calls.exec[0].id, 5001, 'on the proposal\'s own session');
  assert.equal(h.calls.exec[0].opts.branchName, 'dev/homeroom_bot-5001');
  assert.equal(h.calls.loop.mode, 'build');
  assert.match(h.calls.exec[0].opts.prompt, /Cooking mode text-size control offers all steps/);
  assert.match(h.calls.exec[0].opts.prompt, /"Text size" but the button says "Aa"/);
  assert.match(h.calls.exec[0].opts.commitMsg, /fix the failing checks on #50/);
  assert.equal(h.calls.reconciled.length, 1, 'votes cleared, checks re-run, as for any revision');
  const insert = insertOf(h);
  assert.equal(insert.params[4], 'revise', 'counts toward MAX_REVISIONS like any revision');
  assert.equal(insert.params[20], 5001);
  assert.equal(insert.params[21], HEAD, 'the head it looked at, so it never looks twice');
  assert.equal(insert.params[12], SEEN, 'what it has seen of the issue stands: nobody said anything');
  assert.equal(h.calls.posts.length, 0, 'nothing on the issue');
  assert.equal(h.calls.onProposal.length, 1, 'said on the proposal, where the checks are');
  assert.equal(h.calls.onProposal[0].kind, 'checks_revise');
  assert.match(h.calls.onProposal[0].text, /fixed the failing checks on this change/);
  assert.ok(h.calls.queries.some((q) => /DELETE FROM homeroom_bot_queue WHERE id = \$1/.test(q.s) && q.params[0] === 31));
});

test('out of revisions: no turn, and one note hands it to a person', async (t) => {
  const h = harness({ revisions: followup.MAX_REVISIONS });
  const out = await run(t, h);
  assert.equal(out.verdict, 'person');
  assert.equal(h.calls.exec.length, 0, 'nothing spent');
  assert.equal(h.calls.posts.length, 1, 'one note');
  const post = h.calls.posts[0];
  assert.equal(post.kind, 'followup_person');
  assert.equal(post.proposalSessionId, 5001, 'on the proposal too');
  assert.match(post.text, /can't get this change past its checks on its own: 1 check is still failing/);
  assert.match(post.text, /already updated this change 3 times/);
  assert.match(post.dm.reason, /its checks are failing/, 'the requester hears it in the DM');
  assert.equal(insertOf(h).params[21], HEAD, 'and it is not said again for the same head');
});

test('a turn that cannot fix them hands over with its reason, once', async (t) => {
  const h = harness({
    result: { lastResultText: '```json\n{"action":"person","reply":"The check expects a step the request asked to remove."}\n```', pushOk: true, sha: HEAD },
  });
  const out = await run(t, h);
  assert.equal(out.verdict, 'person');
  assert.equal(h.calls.reconciled.length, 0);
  assert.equal(h.calls.posts.length, 1);
  assert.match(h.calls.posts[0].text, /The check expects a step the request asked to remove\./);
  assert.equal(insertOf(h).params[21], HEAD);
});

test('a "revise" that moved nothing is a failed run, said once', async (t) => {
  const h = harness({ result: { lastResultText: '```json\n{"action":"revise","reply":"Done."}\n```', pushOk: true, sha: HEAD } });
  const out = await run(t, h);
  assert.equal(out.verdict, 'failed');
  assert.match(insertOf(h).params[18], /^checks: its attempt to fix them changed nothing/);
  assert.equal(h.calls.posts.length, 1);
});

test('a GLM fix whose agent failed is no revision, whatever it pushed, and hands over with the reason', async (t) => {
  const h = harness({
    result: {
      agentHarness: 'claude', ccExit: 1, exitCode: 1, pushOk: true, sha: NEW_HEAD,
      lastResultText: '```json\n{"action":"revise","reply":"Renamed the control.","summary":"Text size."}\n```',
    },
  });
  const out = await run(t, h);
  assert.equal(out.verdict, 'failed');
  assert.equal(h.calls.reconciled.length, 0, 'the proposal stays as it was voted on');
  assert.equal(h.calls.onProposal.length, 0, 'no "fixed the failing checks" note');
  assert.match(insertOf(h).params[18], /^checks: its attempt to fix them failed \(the agent exited with code 1\)/);
  assert.equal(h.calls.exec[0].opts.discardFailedTurn, true);
});

test('a platform fault spends nothing on the head: the row is kept for a retry', async (t) => {
  const h = harness({ routed: { error: 'session_busy' } });
  const out = await run(t, h);
  assert.equal(out.reason, 'refused', 'a busy session is a refusal, as for any turn');
  const h2 = harness({ routed: { error: 'dispatch: worker went away' } });
  const out2 = await run(t, h2);
  assert.equal(out2.reason, 'infra');
  assert.equal(h2.calls.posts.length, 0);
  assert.ok(h2.calls.queries.some((q) => /UPDATE homeroom_bot_queue SET started_at = NULL/.test(q.s)), 'retried later');
  const insert = insertOf(h2);
  assert.equal(insert.params[21], null, 'the head is not marked, so the retry can still fix it');
});

test('checks that look like the platform\'s fault cost no revision and say nothing', async (t) => {
  const h = harness({ row: checksRow({ test_results: results({ failing: 40, total: 43 }) }) });
  const out = await run(t, h);
  assert.deepEqual(out, { ran: false, reason: 'checks_infra' });
  assert.equal(h.calls.exec.length, 0);
  assert.equal(h.calls.posts.length + h.calls.onProposal.length, 0);
  assert.equal(insertOf(h), undefined, 'no run, so a later verdict on the same head is still looked at');
});

test('a head already looked at, or a verdict on an older commit, is left alone', async (t) => {
  for (const row of [checksRow({ looked: true }), checksRow({ checks_commit_sha: NEW_HEAD })]) {
    const h = harness({ row });
    const out = await run(t, h);
    assert.deepEqual(out, { ran: false, reason: 'no_new_replies' });
    assert.equal(h.calls.exec.length, 0);
  }
});

test('a person\'s reply comes first; a fix still due after it is queued again', async (t) => {
  const h = harness({
    comments: [{ author: 'ada', body: 'Can the button say "Text size"?', createdAt: '2026-10-01T11:30:00Z' }],
    result: { lastResultText: '```json\n{"action":"answer","reply":"It can; the checks agree."}\n```', pushOk: true, sha: HEAD },
  });
  const out = await run(t, h, { ...ITEM, reason: 'changed', thread_seen_at: '2026-10-01T11:30:00Z' });
  assert.equal(out.verdict, 'answer');
  assert.doesNotMatch(h.calls.exec[0].opts.prompt, /automated checks/, 'the reply turn is the reply turn');
  const again = queued(h);
  assert.equal(again.length, 1, 'the checks are looked at on the next pass');
  assert.deepEqual(again[0].params, [9, 50, bot.CHECKS_REASON]);
});

// ── Getting it queued ────────────────────────────────────────────────────

function notePool(row, { liveApps = [APP.slug], mode = 'shadow' } = {}) {
  const asked = [];
  return {
    asked,
    async query(sql, params) {
      const s = String(sql);
      asked.push({ s, params });
      if (/AS looked/.test(s)) return { rows: row ? [row] : [] };
      if (/FROM platform_settings/.test(s)) {
        return { rows: [{ key: 'homeroom_bot_mode', value: mode }, { key: 'homeroom_bot_live_apps', value: JSON.stringify(liveApps) }] };
      }
      return { rows: [] };
    },
  };
}

test('a failing verdict on the bot\'s proposal queues its issue; anything else does not', async () => {
  const yes = notePool(checksRow());
  assert.equal(await bot.noteProposalChecks(yes, { sessionId: 5001 }), true);
  assert.deepEqual(yes.asked[0].params, [5001, 'homeroom_bot'], 'the bot\'s own proposals only');
  assert.match(yes.asked[0].s, /cs\.status = 'promoted'/);
  const insert = yes.asked.find((q) => /INSERT INTO homeroom_bot_queue/.test(q.s));
  assert.deepEqual(insert.params, [9, 50, bot.CHECKS_REASON]);

  for (const [pool, why] of [
    [notePool(null), 'somebody else\'s proposal'],
    [notePool(checksRow({ check_state: 'passing' })), 'checks passing'],
    [notePool(checksRow({ looked: true })), 'already looked at'],
    [notePool(checksRow(), { liveApps: [] }), 'the app is not live'],
    [notePool(checksRow(), { mode: 'off' }), 'the bot is off'],
    [notePool(checksRow({ test_results: results({ failing: 40, total: 43 }) })), 'looks like the platform'],
  ]) {
    assert.equal(await bot.noteProposalChecks(pool, { sessionId: 5001 }), false, why);
    assert.ok(!pool.asked.some((q) => /INSERT INTO homeroom_bot_queue/.test(q.s)), why);
  }
  assert.equal(await bot.noteProposalChecks({ async query() { throw new Error('down'); } }, { sessionId: 1 }), false, 'never throws');
});

test('every settled failing verdict reaches the bot, from each place a verdict settles', () => {
  const visuals = read('src/services/visuals.js');
  assert.match(visuals, /function noteBotChecksAfterChecks\(pool, session, state\) \{\n\s+if \(!session\?\.id\) return;/);
  // B4: a passing or skipped one is the bot's change being ready to try.
  assert.match(visuals, /if \(state === 'passing' \|\| state === 'skipped'\) \{[\s\S]*?noteChangeReady\(pool, session\.id\)[\s\S]*?return;\n\s+\}\n\s+if \(state !== 'failing'\) return;/);
  assert.match(read('src/services/staging-recovery.js'), /visuals\.noteBotChecksAfterChecks\?\.\(pool, session, 'skipped'\);/);
  assert.match(visuals, /require\('\.\/homeroom-bot'\)\.noteProposalChecks\(pool, \{ sessionId: session\.id \}\)/);
  assert.match(visuals, /maybeAutoMergeAfterChecks\(config, getPool\(config\), session, completed\.state\);\n\s+noteBotChecksAfterChecks\(getPool\(config\), session, completed\.state\);/);
  assert.match(visuals, /maybeAutoMergeAfterChecks\(config, pool, session, checksResult\.state\);\n\s+noteBotChecksAfterChecks\(pool, session, checksResult\.state\);/);
  assert.match(read('src/services/check-harvest.js'), /visuals\.noteBotChecksAfterChecks\?\.\(pool, session, settled\.result\.state\);/);
  const schema = read('src/db/schema.sql');
  assert.match(schema, /ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS checks_head_sha TEXT;/);
});

test('a failing verdict hook costs an error verdict nothing, and a passing one only the ready check', async () => {
  const visuals = require('../src/services/visuals');
  const asked = [];
  const pool = { async query(sql) { asked.push(String(sql)); return { rows: [] }; } };
  visuals.noteBotChecksAfterChecks(pool, { id: 5001 }, 'error');
  await new Promise((r) => setImmediate(r));
  assert.equal(asked.length, 0);
  // B4: passing asks whether the change is ready to try, and nothing else.
  visuals.noteBotChecksAfterChecks(pool, { id: 5001 }, 'passing');
  for (let i = 0; i < 20 && !asked.length; i += 1) await new Promise((r) => setImmediate(r));
  assert.deepEqual(asked.map((s) => s.replace(/\s+/g, ' ').trim()),
    ['SELECT status, check_state, approval_epoch FROM chat_sessions WHERE id = $1']);
  asked.length = 0;
  visuals.noteBotChecksAfterChecks(pool, { id: 5001 }, 'failing');
  for (let i = 0; i < 20 && !asked.length; i += 1) await new Promise((r) => setImmediate(r));
  assert.ok(asked.some((s) => /AS looked/.test(s)), 'a failing one is looked up');
});
