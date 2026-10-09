// #4610 / #4572: a person who writes to the Homeroom bot on its own change
// hears back, whatever happens to the turn.
//
// On PR #4582 (change 7490) evan's message in the change's thread got no
// word for 25 minutes while a reply turn ran, and an earlier fix of its
// checks "ran out of time" and was never tried again. A reply turn that
// failed posted nothing and recorded the message as seen, so its one
// automatic retry found "nothing new" and dropped it; a wait said nothing;
// and on the platform's own repository a fix got a third of the clock its
// build had.
//
// These tests pin the pure pieces and drive runTriage down the follow-up path
// with a live app, a promoted bot proposal and stub workers, as
// homeroom-bot-followup.test.js does.
//
// Run with: node --test tests/homeroom-bot-reply-silence.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const bot = require('../src/services/homeroom-bot');
const live = require('../src/services/homeroom-bot-live');
const followup = require('../src/services/homeroom-bot-followup');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const APP = { id: 9, slug: 'rss-reader-4113da', name: 'RSS reader', repo_url: 'https://github.com/usernode-bot/rss-reader-4113da', self_hosted: false };
const PLATFORM = { id: 1, slug: 'usernode-2d5619', repo_url: 'https://github.com/Usernode-Labs/social-vibecoding' };
const BOT = { id: 77, username: 'homeroom_bot' };
const SETTINGS = { mode: 'shadow', turnSeconds: 1200, turnInputTokens: 10_000_000 };
const ANSWERED = '2026-10-09T10:00:00Z';
const ASKED = '2026-10-09T20:56:00Z';
const FAILED_SEEN = '2026-10-09T20:56:30Z';
const ITEM = { id: 31, app_id: 9, issue_number: 24, priority: 2, reason: 'changed', thread_seen_at: FAILED_SEEN };
const HEAD = 'a'.repeat(40);
const ASK = { author: 'evan', body: '@​Homeroom bot inset it even more', createdAt: ASKED };

// A reply turn on this change that failed without answering.
const failedRun = (seen = FAILED_SEEN, extra = {}) => ({
  verdict: 'failed', error: 'budget: wall clock', thread_seen_at: seen, proposal_session_id: 5001, checks_head_sha: null, ...extra,
});
const answeredRun = { verdict: 'revise', error: null, thread_seen_at: ANSWERED, proposal_session_id: 5001, checks_head_sha: null };

// ── The pure pieces ──────────────────────────────────────────────────────

test('replies are read from the last run that answered, past up to two that failed', () => {
  assert.deepEqual(followup.repliesSince([answeredRun], 5001), { sinceAt: ANSWERED, failures: 0, gaveUp: false });
  assert.deepEqual(followup.repliesSince([failedRun(), answeredRun], 5001), { sinceAt: ANSWERED, failures: 1, gaveUp: false },
    'the retry re-reads the message the failed turn did not answer');
  assert.deepEqual(followup.repliesSince([failedRun(), failedRun(), answeredRun], 5001),
    { sinceAt: FAILED_SEEN, failures: 2, gaveUp: true }, 'after two tries at the same messages the newest mark stands, as before');
  assert.deepEqual(followup.repliesSince([failedRun('2026-10-09T21:30:00Z'), failedRun(), failedRun(), answeredRun], 5001),
    { sinceAt: FAILED_SEEN, failures: 1, gaveUp: false },
    'a message after it gave up is a new set with its own retry, read from where the last set stopped');
  assert.deepEqual(followup.repliesSince([failedRun(new Date(FAILED_SEEN)), failedRun(FAILED_SEEN), answeredRun], 5001).gaveUp, true,
    'a mark is a moment, as a Date or a string');
  assert.deepEqual(followup.repliesSince([], 5001), { sinceAt: null, failures: 0, gaveUp: false });
});

test('only a reply turn on this change that said nothing is an unanswered failure', () => {
  assert.equal(followup.unansweredFailure(failedRun(), 5001), true);
  assert.equal(followup.unansweredFailure(failedRun(FAILED_SEEN, { error: 'unparseable: (empty reply)' }), 5001), true);
  assert.equal(followup.unansweredFailure(failedRun(FAILED_SEEN, { error: 'revise: the turn produced no change' }), 5001), false,
    'a revise that moved nothing already said so');
  assert.equal(followup.unansweredFailure(failedRun(FAILED_SEEN, { error: 'checks: its attempt to fix them ran out of time' }), 5001), false);
  assert.equal(followup.unansweredFailure(failedRun(FAILED_SEEN, { checks_head_sha: HEAD }), 5001), false);
  assert.equal(followup.unansweredFailure(failedRun(FAILED_SEEN, { proposal_session_id: 6000 }), 5001), false, 'another change');
  assert.equal(followup.unansweredFailure(answeredRun, 5001), false);
});

test('what it says while it works, waits and fails is short, plain, and has no em dashes', () => {
  assert.equal(followup.workingText(), 'Homeroom bot is working on it…');
  assert.equal(followup.replyFailedText({ why: 'it ran out of time', retrying: true }),
    'Homeroom bot couldn\'t answer this time: it ran out of time. It will try again soon.');
  assert.equal(followup.replyFailedText({ why: 'it ran out of time.', retrying: false }),
    'Homeroom bot couldn\'t answer this time either: it ran out of time. Reply here and it will try again.');
  assert.equal(bot.replyFailedWhy('budget: wall clock'), 'it ran out of time');
  assert.equal(bot.replyFailedWhy('unparseable: (empty reply)'), 'its answer came back unreadable');
  assert.equal(bot.replyFailedWhy('the follow-up turn failed (the agent exited with code 1)'), 'something went wrong while it worked on it');
  for (const why of Object.keys(followup.WAIT_WORDS)) assert.match(followup.waitText(why), /^Homeroom bot saw your message, but /);
  assert.equal(followup.waitText('nope'), null);
  assert.match(followup.checksRetryText(), /ran out of time fixing the failing checks on this change\. It is trying once more\./);
  const texts = [
    followup.workingText(), followup.replyFailedText({ why: 'x' }), followup.checksRetryText({ broken: true, failing: false }),
    ...Object.keys(followup.WAIT_WORDS).map(followup.waitText),
  ];
  for (const t of texts) assert.ok(!/—|PR #|proposal/.test(t), t);
});

test('fixes and replies on the platform\'s own repository get the clock its builds get', () => {
  assert.equal(bot.followUpBudgetMs(PLATFORM, {}, 1200_000), 3600_000);
  assert.equal(bot.followUpBudgetMs(APP, {}, 1200_000), 1200_000, 'any other app keeps its turn');
  assert.equal(bot.followUpBudgetMs(PLATFORM, {}, 1200_000), bot.buildBudgets(PLATFORM, {}, 1200_000).turnBudgetMs);
  const src = read('src/services/homeroom-bot.js');
  assert.match(src, /return runFollowUp\(pool, config, \{[\s\S]{0,300}?turnBudgetMs: followUpBudgetMs\(app, config, turnBudgetMs\)/,
    'runTriage hands the follow-up (and so its checks fix) that clock');
});

test('a reply turn is told the change\'s failing checks, so it can fix them when asked', () => {
  const failing = [{ name: 'Vote card shows', path: '/#p', reason: 'expected "Vote"' }];
  const prompt = followup.followUpPrompt({ seed: 'SEED', replies: [ASK], checks: { failing, total: 41 } });
  assert.match(prompt, /automated checks are failing on its current commit: 1 of 41/);
  assert.match(prompt, /- Vote card shows \(\/#p\):\n {2}expected "Vote"/);
  assert.match(prompt, /choose "revise" and fix it/);
  assert.doesNotMatch(followup.followUpPrompt({ seed: 'SEED', replies: [ASK] }), /automated checks/, 'nothing failing, nothing said');
  assert.match(followup.followUpPrompt({ seed: 'S', replies: [ASK], checks: { failing, total: 41 }, canRevise: false }),
    /say what fails and why/);
});

// ── runTriage, down the follow-up path ───────────────────────────────────

function harness({
  recentRuns = [failedRun(), answeredRun], proposalThread = [ASK], newestByBot = false,
  result = { lastResultText: '```json\n{"action":"answer","reply":"Inset it by 8 more pixels."}\n```', pushOk: true, sha: HEAD },
  routed = null, busy = false,
} = {}) {
  const calls = { queries: [], exec: [], posts: [], onProposal: [], botMessages: [], order: [] };
  const pool = {
    async query(sql, params) {
      const s = String(sql);
      calls.queries.push({ s, params });
      if (/SELECT id, status, pr_number FROM chat_sessions/.test(s)) return { rows: [{ id: 5001, status: 'promoted', pr_number: 4582 }] };
      if (/SELECT id, thread_seen_at FROM homeroom_bot_runs/.test(s)) return { rows: [{ id: 800, thread_seen_at: recentRuns[0]?.thread_seen_at || ANSWERED }] };
      if (/SELECT verdict, error, thread_seen_at, proposal_session_id, checks_head_sha/.test(s)) return { rows: recentRuns };
      if (/SELECT cs\.\*, a\.slug AS app_slug/.test(s)) {
        return { rows: [{ id: 5001, user_id: 77, app_id: 9, status: 'promoted', branch_name: 'dev/homeroom_bot-5001', pr_number: 4582, reviewed_head_sha: HEAD, app_slug: APP.slug, repo_url: APP.repo_url }] };
      }
      if (/COUNT\(\*\)::int AS n FROM homeroom_bot_runs/.test(s)) return { rows: [{ n: 0 }] };
      if (/INSERT INTO homeroom_bot_runs/.test(s)) return { rows: [{ id: 901 }] };
      if (/AS by_bot/.test(s)) return { rows: [{ by_bot: newestByBot, recent: true }] };
      if (/SELECT active_turn FROM chat_sessions/.test(s)) return { rows: [{ active_turn: busy ? { turnId: 'x' } : null }] };
      return { rows: [] };
    },
  };
  const deps = {
    github: {
      isEnabled: () => true,
      getBotUsername: async () => 'usernode-bot',
      async fetchPublicIssue() { return { issue: { number: 24, title: 'Inset the composer', body: 'more inset', state: 'open' } }; },
      async fetchIssueComments() { return { comments: [] }; },
    },
    worker: {
      async ensureWorkerImage() {},
      async ensureWorker() { return 'usernode-worker-5001'; },
      async execInWorker(id, opts) { calls.order.push('turn'); calls.exec.push({ id, opts }); return result; },
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
      async runCodexAttemptLoop({ dispatchOnce }) {
        if (routed) return routed;
        const r = await dispatchOnce({});
        return { result: r, error: null, estimatedCostUsd: 0.01 };
      },
    },
    activeWorkers: new Set(),
    ws: { async sendBotMessage(_pool, _appId, msg) { calls.botMessages.push(msg); return { id: 1 }; } },
    sessionLifecycle: {},
    domain: 'app.onhomeroom.com',
    votes: { async reconcileNativeReviewedHead() { return { enforced: true }; } },
  };
  return { pool, deps, calls };
}

async function run(t, h, item = ITEM) {
  const real = { post: live.post, seen: live.advanceSeen, onProposal: live.postOnProposal, targets: live.mentionTargets };
  t.after(() => Object.assign(live, {
    post: real.post, advanceSeen: real.seen, postOnProposal: real.onProposal, mentionTargets: real.targets,
  }));
  live.post = async (args) => { h.calls.order.push(args.kind); h.calls.posts.push(args); return { githubCreatedAt: '2026-10-09T21:00:00Z' }; };
  live.postOnProposal = async (args) => { h.calls.order.push(args.kind); h.calls.onProposal.push(args); return { postId: 1, thread: true }; };
  live.advanceSeen = async () => ({ advanced: true });
  live.mentionTargets = async () => ['evan'];
  return bot.runTriage(h.pool, {}, { bot: BOT, app: APP, item, mode: 'shadow', settings: SETTINGS, deps: h.deps });
}

const insertOf = (h) => h.calls.queries.find((q) => /INSERT INTO homeroom_bot_runs/.test(q.s));

test('the retry of a failed reply re-reads the message it failed on, and says it is working on it before it answers', async (t) => {
  const h = harness();
  const out = await run(t, h);
  assert.equal(out.verdict, 'answer', 'the message counted as seen by the failed turn is answered now');
  assert.equal(h.calls.exec.length, 1);
  assert.match(h.calls.exec[0].opts.prompt, /inset it even more/);
  const since = h.calls.queries.find((q) => /SELECT verdict, error, thread_seen_at, proposal_session_id, checks_head_sha/.test(q.s));
  assert.deepEqual(since.params, [9, 24]);
  assert.deepEqual(h.calls.order, ['followup_working', 'turn', 'followup_answer'], 'once, as the turn starts, then the answer');
  const working = h.calls.onProposal[0];
  assert.equal(working.sessionId, 5001, 'in the change\'s thread, where the person wrote');
  assert.equal(working.text, 'Homeroom bot is working on it…');
});

test('before: with the failed run\'s mark the same message was "nothing new"; two failed tries still give up', async (t) => {
  const once = harness({ recentRuns: [failedRun(FAILED_SEEN, { proposal_session_id: null })] });
  assert.deepEqual(await run(t, once), { ran: false, reason: 'no_new_replies' });
  const twice = harness({ recentRuns: [failedRun(), failedRun(), answeredRun] });
  assert.deepEqual(await run(t, twice), { ran: false, reason: 'no_new_replies' });
  assert.equal(twice.calls.exec.length + twice.calls.onProposal.length, 0, 'no turn and nothing said');
});

test('a reply turn that ends unreadable says so in the thread, and that it will try again', async (t) => {
  const h = harness({ recentRuns: [answeredRun], result: { lastResultText: 'I looked at it.', pushOk: false } });
  const out = await run(t, h);
  assert.equal(out.verdict, 'failed');
  assert.match(insertOf(h).params[18], /^unparseable: /, 'the record stays on the run');
  assert.equal(insertOf(h).params[12], FAILED_SEEN);
  const note = h.calls.onProposal.find((p) => p.kind === 'followup_failed');
  assert.ok(note, 'it used to post nothing');
  assert.equal(note.sessionId, 5001);
  assert.equal(note.runId, 901);
  assert.equal(note.text, 'Homeroom bot couldn\'t answer this time: its answer came back unreadable. It will try again soon.');
  assert.equal(h.calls.posts.length, 0, 'never a GitHub comment, which would read as new activity');
});

test('the second failure says it stopped trying, and how to start it again', async (t) => {
  const h = harness({ routed: { error: 'turn_failed' } });
  const out = await run(t, h);
  assert.equal(out.verdict, 'failed');
  const note = h.calls.onProposal.find((p) => p.kind === 'followup_failed');
  assert.equal(note.text, 'Homeroom bot couldn\'t answer this time either: something went wrong while it worked on it. Reply here and it will try again.');
});

test('a platform fault keeps its row for the retry and says nothing', async (t) => {
  const h = harness({ routed: { error: 'dispatch: worker went away' } });
  const out = await run(t, h);
  assert.equal(out.reason, 'infra');
  assert.equal(h.calls.onProposal.filter((p) => p.kind === 'followup_failed').length, 0);
});

test('a reply that has to wait for another turn on the change says why, once', async (t) => {
  const h = harness({ busy: true });
  const out = await run(t, h);
  assert.equal(out.reason, 'refused');
  assert.equal(h.calls.exec.length, 0);
  assert.deepEqual(h.calls.onProposal.map((p) => p.kind), ['followup_wait']);
  assert.match(h.calls.onProposal[0].text, /^Homeroom bot saw your message, but another update to this change is running right now\./);
  assert.equal(insertOf(h), undefined, 'a wait is no run');

  const again = harness({ busy: true, newestByBot: true });
  await run(t, again);
  assert.equal(again.calls.onProposal.length, 0, 'the next pass finds its own note the newest word, and says nothing');
});

test('a wait is said only on the bot\'s own change, while a person is waiting there', async () => {
  const posted = [];
  const real = live.postOnProposal;
  live.postOnProposal = async (args) => { posted.push(args); return { postId: 1 }; };
  try {
    const pool = (rows, open = { id: 5001, status: 'promoted' }) => ({
      async query(sql) {
        const s = String(sql);
        if (/SELECT id, status, pr_number FROM chat_sessions/.test(s)) return { rows: open ? [open] : [] };
        if (/AS by_bot/.test(s)) return { rows };
        return { rows: [] };
      },
    });
    const args = { app: APP, issueNumber: 24, bot: BOT, ws: {} };
    assert.equal(await bot.noteFollowUpWait(pool([{ by_bot: false, recent: true }]), { ...args, why: 'allowance' }), true);
    assert.match(posted[0].text, /building time for this request is used up for this week/);
    assert.equal(posted[0].kind, 'followup_wait');
    assert.equal(await bot.noteFollowUpWait(pool([{ by_bot: true, recent: true }]), { ...args, why: 'budget' }), false);
    assert.equal(await bot.noteFollowUpWait(pool([{ by_bot: false, recent: false }]), { ...args, why: 'budget' }), false, 'an old message is nobody waiting');
    assert.equal(await bot.noteFollowUpWait(pool([]), { ...args, why: 'budget' }), false);
    assert.equal(await bot.noteFollowUpWait(pool([{ by_bot: false, recent: true }], null), { ...args, why: 'budget' }), false, 'no change of the bot\'s');
    assert.equal(await bot.noteFollowUpWait(pool([{ by_bot: false, recent: true }], { id: 5001, status: 'merging' }), { ...args, why: 'budget' }), false);
    assert.equal(await bot.noteFollowUpWait(pool([{ by_bot: false, recent: true }]), { ...args, why: 'nope' }), false);
    assert.equal(posted.length, 1);
  } finally {
    live.postOnProposal = real;
  }
  const src = read('src/services/homeroom-bot.js');
  assert.match(src, /if \(liveMode\) await noteFollowUpWait\(pool, \{ app, issueNumber, bot, why: 'budget', ws: liveD\.ws \}\);/);
  assert.match(src, /await noteFollowUpWait\(pool, \{ app, issueNumber, bot, why: 'allowance', ws: liveD\.ws \}\);/);
  assert.match(src, /why: 'paused', sessionId: Number\(sessionId\)/);
});

test('a message on the bot\'s change on a project it is paused on hears why', async () => {
  const posted = [];
  const real = live.postOnProposal;
  live.postOnProposal = async (args) => { posted.push(args); return { postId: 1 }; };
  try {
    const pool = (paused) => ({
      async query(sql) {
        const s = String(sql);
        if (/SELECT cs\.linked_issues, u\.id AS bot_id/.test(s)) return { rows: [{ linked_issues: [24], bot_id: 77, bot_username: 'homeroom_bot', slug: APP.slug }] };
        if (/FROM platform_settings/.test(s)) {
          return { rows: [{ key: 'homeroom_bot_mode', value: 'shadow' }, { key: bot.KEY_PAUSED_APPS, value: JSON.stringify(paused) }] };
        }
        if (/AS by_bot/.test(s)) return { rows: [{ by_bot: false, recent: true }] };
        return { rows: [] };
      },
    });
    await bot.noteProposalActivity(pool([APP.slug]), { appId: 9, sessionId: 5001, deps: { ws: {} } });
    assert.equal(posted.length, 1);
    assert.match(posted[0].text, /it is paused on this project/);
    assert.equal(posted[0].sessionId, 5001);
    await bot.noteProposalActivity(pool([]), { appId: 9, sessionId: 5001, deps: { ws: {} } });
    assert.equal(posted.length, 1, 'not paused: the follow-up answers it');
  } finally {
    live.postOnProposal = real;
  }
});
