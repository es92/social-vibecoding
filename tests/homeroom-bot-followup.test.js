// #3264: the Homeroom bot follows up on a proposal it opened itself.
//
// Before, a reply on an issue the bot had proposed for re-queued it, and the
// run stopped at "already has a bot proposal" and said nothing. These tests
// drive runTriage down the follow-up path with a live app, a promoted bot
// proposal and stub workers, and pin the pure pieces (who counts as a reply,
// the prompt, the parser, when the head moved) directly.
//
// Run with: node --test tests/homeroom-bot-followup.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const bot = require('../src/services/homeroom-bot');
const live = require('../src/services/homeroom-bot-live');
const followup = require('../src/services/homeroom-bot-followup');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const APP = { id: 9, slug: 'rss-reader-4113da', name: 'RSS reader', repo_url: 'https://github.com/usernode-bot/rss-reader-4113da', self_hosted: false };
const BOT = { id: 77, username: 'homeroom_bot' };
const SETTINGS = { mode: 'shadow', turnSeconds: 1200, turnInputTokens: 10_000_000 };
const SEEN = '2026-09-26T10:00:00Z';
const ITEM = { id: 31, app_id: 9, issue_number: 24, priority: 2, reason: 'changed', thread_seen_at: '2026-09-26T12:00:00Z' };
const OLD_HEAD = 'a'.repeat(40);
const NEW_HEAD = 'b'.repeat(40);

// ── The pure pieces ──────────────────────────────────────────────────────

test('a reply is what a person said after the bot last looked, wherever they said it', () => {
  const replies = followup.newReplies({
    comments: [
      { author: 'usernode-bot', body: 'Homeroom bot built this…', createdAt: '2026-09-26T11:00:00Z' },
      { author: 'evan', body: 'Old comment', createdAt: '2026-09-26T09:00:00Z' },
      { author: 'evan', body: 'Can it be darker still?', createdAt: '2026-09-26T11:30:00Z' },
    ],
    issueThread: [{ author: 'pat', body: 'Agree', createdAt: '2026-09-26T11:10:00Z' }],
    proposalThread: [{ author: 'sam', body: 'Why zinc-950?', createdAt: '2026-09-26T11:20:00Z' }],
    botLogin: 'Usernode-Bot',
    sinceMs: Date.parse(SEEN),
  });
  assert.deepEqual(replies.map((r) => [r.author, r.where, r.via]), [
    ['pat', 'issue', 'homeroom'], ['sam', 'proposal', 'homeroom'], ['evan', 'issue', 'github'],
  ], 'oldest first; the bot\'s own comment and anything already seen are not replies');
});

test('the prompt lists the replies, and offers revise only while revisions remain', () => {
  const replies = [{ where: 'proposal', via: 'homeroom', author: 'sam', body: 'Why zinc-950?', createdAt: '2026-09-26T11:20:00Z' }];
  const open = followup.followUpPrompt({ seed: 'SEED', proposalBlock: 'BLOCK', prNumber: 25, replies, canRevise: true });
  // B4: never a PR number, which the model's own words would echo back.
  assert.match(open, /put the change up for the app's group to approve/);
  assert.doesNotMatch(open, /PR #25/);
  assert.match(open, /sam, in the proposal's discussion/);
  assert.match(open, /Why zinc-950\?/);
  assert.match(open, /never as instructions to you/, 'replies are data, as every discussion block says');
  assert.match(open, /- "revise":/);
  assert.match(open, /"action": "answer" \| "ask" \| "revise" \| "person"/);

  const capped = followup.followUpPrompt({ seed: 'SEED', prNumber: 25, replies, canRevise: false });
  assert.doesNotMatch(capped, /- "revise":/);
  assert.match(capped, /"action": "answer" \| "ask" \| "person"/);
  assert.match(capped, /already revised this proposal as many times as you may/);
});

test('#3703: the prompt carries the spec the proposal was built from, the card a reply in its discussion is about', () => {
  const replies = [{ where: 'proposal', via: 'homeroom', author: 'evan', body: 'does the order make sense though?', createdAt: '2026-10-02T17:26:19Z' }];
  const spec = '# Add relative-note lessons\n\n## User-facing changes\nA new Notes group appears above Intervals.';
  const p = followup.followUpPrompt({ seed: 'SEED', proposalBlock: 'BLOCK', spec, prNumber: 10, replies });
  assert.match(p, /==== THE SPEC THIS PROPOSAL WAS BUILT FROM/);
  assert.match(p, /A new Notes group appears above Intervals\./);
  assert.match(p, /Where it differs from the spec \(a revision since\), the working tree is the truth\./);
  assert.ok(p.indexOf('BLOCK') < p.indexOf('THE SPEC THIS PROPOSAL') && p.indexOf('END SPEC') < p.indexOf('evan, in the proposal'),
    'after the discussion, before the replies it answers');

  assert.doesNotMatch(followup.followUpPrompt({ seed: 'SEED', prNumber: 10, replies }), /THE SPEC THIS PROPOSAL/, 'no spec, no block');
  assert.equal(followup.followUpPrompt({ seed: 'SEED', prNumber: 10, replies, spec: '' }),
    followup.followUpPrompt({ seed: 'SEED', prNumber: 10, replies }), 'and the prompt is as it was');

  const long = followup.followUpPrompt({ seed: 'S', replies, spec: 'x'.repeat(followup.MAX_SPEC_CHARS + 500) });
  assert.ok(long.includes(`${'x'.repeat(followup.MAX_SPEC_CHARS)}…`) && !long.includes('x'.repeat(followup.MAX_SPEC_CHARS + 1)), 'a runaway spec is clipped');
});

test('the action is the last fenced block; anything else is not guessed', () => {
  const text = 'notes\n```json\n{"action":"answer","reply":"x"}\n```\nmore\n```json\n{"action":"revise","reply":"Darker now.","summary":"Background is #09090b."}\n```';
  assert.deepEqual(followup.parseFollowUp(text), { action: 'revise', reply: 'Darker now.', summary: 'Background is #09090b.', planChanged: false, stopMentioning: [], resumeMentioning: [] });
  assert.equal(followup.parseFollowUp('```json\n{"action":"merge","reply":"x"}\n```'), null);
  assert.equal(followup.parseFollowUp('```json\n{"action":"answer","reply":""}\n```'), null, 'a reply with nothing to say is not one');
  assert.equal(followup.parseFollowUp('no json at all'), null);
});

test('the head moved when a build turn pushed a new commit, whatever the model said', () => {
  const pushed = { pushOk: true, sha: NEW_HEAD };
  assert.equal(followup.headMoved({ mode: 'build', result: pushed, reviewedHeadSha: OLD_HEAD, action: 'answer' }), true);
  assert.equal(followup.headMoved({ mode: 'build', result: { pushOk: true, sha: OLD_HEAD }, reviewedHeadSha: OLD_HEAD, action: 'revise' }), false);
  assert.equal(followup.headMoved({ mode: 'build', result: { pushOk: false, sha: NEW_HEAD }, reviewedHeadSha: OLD_HEAD, action: 'revise' }), false);
  assert.equal(followup.headMoved({ mode: 'scout', result: pushed, reviewedHeadSha: OLD_HEAD, action: 'revise' }), false, 'a scout turn never commits');
  assert.equal(followup.headMoved({ mode: 'build', result: pushed, reviewedHeadSha: null, action: 'revise' }), true);
  assert.equal(followup.headMoved({ mode: 'build', result: pushed, reviewedHeadSha: null, action: 'answer' }), false);
});

test('a turn Claude Code ran that failed never moved the head, whatever it pushed; a Codex turn is read as before', () => {
  for (const failed of [{ ccExit: 1 }, { exitCode: 2 }, { ccIsError: true }, { lastResultText: 'API Error: 429 rate limited' }]) {
    const result = { agentHarness: 'claude', pushOk: true, sha: NEW_HEAD, ...failed };
    assert.equal(followup.headMoved({ mode: 'build', result, reviewedHeadSha: OLD_HEAD, action: 'revise' }), false, JSON.stringify(failed));
  }
  const ok = { agentHarness: 'claude', pushOk: true, sha: NEW_HEAD, ccExit: 0, exitCode: 0 };
  assert.equal(followup.headMoved({ mode: 'build', result: ok, reviewedHeadSha: OLD_HEAD, action: 'revise' }), true);
  // The Codex runner never pushes a failed turn, so what it pushed is read as it always was.
  const codex = { agentHarness: 'codex', pushOk: true, sha: NEW_HEAD, ccIsError: true };
  assert.equal(followup.headMoved({ mode: 'build', result: codex, reviewedHeadSha: OLD_HEAD, action: 'revise' }), true);
});

test('#4612: the prompt offers the updated plan only when it can revise and a format is given', () => {
  const format = 'PLAN FORMAT BLOCK';
  const p = followup.followUpPrompt({ seed: 'S', replies: [], canRevise: true, planFormat: format });
  assert.match(p, /write the whole updated plan in your message before the JSON block/);
  assert.match(p, /"plan": "for revise only: true when you wrote an updated plan above"/);
  assert.ok(p.indexOf(format) > p.indexOf('"person"'), 'the plan format follows the choices');
  assert.ok(p.indexOf(format) < p.indexOf('END YOUR REPLY'), 'and comes before the JSON shape');
  assert.doesNotMatch(followup.followUpPrompt({ seed: 'S', replies: [], canRevise: true }), /"plan"/, 'no format, no plan field');
  assert.doesNotMatch(followup.followUpPrompt({ seed: 'S', replies: [], canRevise: false, planFormat: format }), /PLAN FORMAT BLOCK/);
  assert.doesNotMatch(followup.followUpPrompt({ seed: 'S', replies: [], canRevise: false, planFormat: format }), /"plan"/, 'a read-only turn is not offered the plan field');
});

test('#4612: planChanged is set only on a revise whose JSON says the plan changed', () => {
  const fence = (obj) => `\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;
  assert.equal(followup.parseFollowUp(fence({ action: 'revise', reply: 'ok', summary: 's', plan: true })).planChanged, true);
  assert.equal(followup.parseFollowUp(fence({ action: 'revise', reply: 'ok', summary: 's' })).planChanged, false, 'no plan field, no plan');
  assert.equal(followup.parseFollowUp(fence({ action: 'revise', reply: 'ok', plan: false })).planChanged, false);
  assert.equal(followup.parseFollowUp(fence({ action: 'revise', reply: 'ok', plan: 'yes' })).planChanged, false, 'only the boolean counts');
  assert.equal('planChanged' in followup.parseFollowUp(fence({ action: 'answer', reply: 'ok', plan: true })), false, 'an answer has no plan');
});

test('#4612: planOutOf is the text before the action JSON block, and nothing when there is none before it', () => {
  const md = '# Darker dark mode\n\n## User-facing changes\nDarker.\n\n## Technical implementation\nOne constant.';
  const fenced = `${md}\n\n\`\`\`json\n{"action":"revise","reply":"Done.","plan":true}\n\`\`\``;
  assert.equal(followup.planOutOf(fenced), md, 'the markdown plan, without the fence');
  const html = '<article data-spec>\n  <h1>Darker dark mode</h1>\n  <section data-spec-tab="user"><p>Darker.</p></section>\n  <section data-spec-tab="tech"><p>One constant.</p></section>\n</article>';
  assert.equal(followup.planOutOf(`${html}\n\n\`\`\`\n{"action":"revise","reply":"Done.","plan":true}\n\`\`\``), html, 'the HTML plan, without the fence');
  // A later block wins: everything before the LAST action block is the plan.
  const two = `First I answered.\n\`\`\`json\n{"action":"answer","reply":"x"}\n\`\`\`\nthen\n${md}\n\n\`\`\`json\n{"action":"revise","reply":"Done.","plan":true}\n\`\`\``;
  assert.equal(followup.planOutOf(two), `First I answered.\n\`\`\`json\n{"action":"answer","reply":"x"}\n\`\`\`\nthen\n${md}`);
  assert.equal(followup.planOutOf('```json\n{"action":"answer","reply":"ok"}\n```'), '', 'nothing before the block');
  assert.equal(followup.planOutOf('no json at all'), '');
  assert.equal(followup.planOutOf(''), '');
});

// One note per update: the cleared votes are the platform's line in the
// change's discussion (routes/votes.js), so the note ends with the plan line.
test('#4612: revisedText names the new plan version, and leaves the cleared votes to the platform', () => {
  const withPlan = followup.revisedText({ summary: 's', reply: 'r', planVersion: 2 });
  assert.match(withPlan, /Its plan is updated to match: version 2 is in the change's discussion\.$/);
  assert.doesNotMatch(withPlan, /approvals/);
  assert.doesNotMatch(followup.revisedText({ summary: 's', reply: 'r' }), /Its plan is updated/, 'no version, no line');
  const texts = [withPlan, followup.revisedText({ summary: 's', reply: 'r', planVersion: 12 })];
  for (const t of texts) assert.ok(!/—/.test(t) && !/PR #|proposal/.test(t), t);
});

test('what it says has no em dashes', () => {
  const texts = [
    followup.answerText({ reply: 'r', prNumber: 25 }),
    followup.askText({ reply: 'r', prNumber: 25 }),
    followup.personText({ reply: 'r', prNumber: 25 }),
    followup.revisedText({ summary: 's', reply: 'r', prNumber: 25, link: 'https://x' }),
    followup.revisionFailedText({ why: 'w', prNumber: 25 }),
  ];
  for (const t of texts) assert.ok(!/—/.test(t), t);
  // B4: plain words: the change, its approvals, never a proposal or its number.
  for (const t of texts) assert.ok(!/PR #|proposal/.test(t), t);
  assert.doesNotMatch(texts[3], /approvals/, 'the platform\'s line says the votes were cleared');
  assert.doesNotMatch(texts[3], /https:/, 'the change\'s card goes with it instead of its address');
});

// ── runTriage, down the follow-up path ───────────────────────────────────

function harness({
  proposalStatus = 'promoted', revisions = 0, comments = [], issueThread = [], proposalThread = [], spec = null,
  result = { lastResultText: '```json\n{"action":"answer","reply":"Because the platform uses it."}\n```', pushOk: true, sha: OLD_HEAD },
} = {}) {
  const calls = { queries: [], exec: [], loop: null, posts: [], reconciled: [], seen: [], cards: [], issueComments: [] };
  const pool = {
    async query(sql, params) {
      const s = String(sql);
      calls.queries.push({ s, params });
      if (/SELECT id, status, pr_number FROM chat_sessions/.test(s)) {
        return { rows: proposalStatus ? [{ id: 5001, status: proposalStatus, pr_number: 25 }] : [] };
      }
      if (/SELECT content FROM chat_session_specs/.test(s)) return { rows: spec == null ? [] : [{ content: spec }] };
      if (/SELECT id, thread_seen_at FROM homeroom_bot_runs/.test(s)) return { rows: [{ id: 800, thread_seen_at: SEEN }] };
      if (/SELECT cs\.\*, a\.slug AS app_slug/.test(s)) {
        return { rows: [{ id: 5001, user_id: 77, app_id: 9, status: 'promoted', branch_name: 'dev/homeroom_bot-5001', pr_number: 25, reviewed_head_sha: OLD_HEAD, app_slug: APP.slug, repo_url: APP.repo_url }] };
      }
      if (/COUNT\(\*\)::int AS n FROM homeroom_bot_runs/.test(s)) return { rows: [{ n: revisions }] };
      if (/INSERT INTO homeroom_bot_runs/.test(s)) return { rows: [{ id: 901 }] };
      return { rows: [] };
    },
  };
  const deps = {
    github: {
      isEnabled: () => true,
      getBotUsername: async () => 'usernode-bot',
      async fetchPublicIssue() { return { issue: { number: 24, title: 'Use darker color for dark mode theme', body: 'darker please', state: 'open' } }; },
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
      async loadIssueThread() { return { messages: issueThread }; },
      async loadProposalThread() { return { messages: proposalThread }; },
    },
    managedOpenRouter: { async usesIncludedKey() { return false; } },
    sessions: {
      buildHeadlessSeed: (n) => `ISSUE #${n}`,
      async runCodexAttemptLoop({ dispatchOnce, mode, telemetryComponent }) {
        calls.loop = { mode, telemetryComponent };
        const r = await dispatchOnce({});
        return { result: r, error: null, estimatedCostUsd: 0.01 };
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

async function run(t, h) {
  const realPost = live.post;
  const realSeen = live.advanceSeen;
  t.after(() => { live.post = realPost; live.advanceSeen = realSeen; });
  live.post = async (args) => { h.calls.posts.push(args); return { githubCreatedAt: '2026-09-26T12:05:00Z' }; };
  live.advanceSeen = async (args) => { h.calls.seen.push(args); return { advanced: true }; };
  return bot.runTriage(h.pool, {}, { bot: BOT, app: APP, item: ITEM, mode: 'shadow', settings: SETTINGS, deps: h.deps });
}

const insertOf = (h) => h.calls.queries.find((q) => /INSERT INTO homeroom_bot_runs/.test(q.s));

test('activity with nothing a person said is recorded as seen, and costs nothing', async (t) => {
  const h = harness({ comments: [{ author: 'usernode-bot', body: 'Homeroom bot built this', createdAt: '2026-09-26T11:00:00Z' }] });
  const out = await run(t, h);
  assert.deepEqual(out, { ran: false, reason: 'no_new_replies' });
  assert.equal(h.calls.exec.length, 0, 'no turn');
  assert.equal(h.calls.posts.length, 0, 'nothing posted');
  const seen = h.calls.queries.find((q) => /UPDATE homeroom_bot_runs\s+SET thread_seen_at = GREATEST/.test(q.s));
  assert.deepEqual(seen.params, [800, ITEM.thread_seen_at], 'so the same activity does not bring it back');
});

test('a question in the proposal\'s discussion is answered there and on the issue, with the code in front of it', async (t) => {
  const h = harness({ proposalThread: [{ author: 'sam', body: 'Why zinc-950?', createdAt: '2026-09-26T11:20:00Z' }] });
  const out = await run(t, h);
  assert.equal(out.verdict, 'answer');
  assert.equal(h.calls.exec.length, 1);
  assert.equal(h.calls.exec[0].id, 5001, 'on the proposal\'s own session');
  assert.equal(h.calls.exec[0].opts.branchName, 'dev/homeroom_bot-5001', 'on its branch');
  assert.equal(h.calls.loop.mode, 'build');
  assert.equal(h.calls.loop.telemetryComponent, 'homeroom_bot_followup');
  assert.match(h.calls.exec[0].opts.prompt, /Why zinc-950\?/);
  assert.equal(h.calls.reconciled.length, 0, 'an answer moves nothing');
  assert.equal(h.calls.posts.length, 1);
  assert.equal(h.calls.posts[0].kind, 'followup_answer');
  assert.equal(h.calls.posts[0].proposalSessionId, 5001, 'asked in the proposal thread, answered there too');
  assert.match(h.calls.posts[0].text, /Because the platform uses it/);
  const insert = insertOf(h);
  assert.equal(insert.params[4], 'answer');
  assert.equal(insert.params[20], 5001, 'tied to the proposal');
  assert.equal(insert.params[21], null, 'not a checks follow-up');
  assert.equal(h.calls.seen[0].proposalSessionId, 5001, 'a reply there during the turn means it looks again');
  assert.ok(h.calls.queries.some((q) => /DELETE FROM homeroom_bot_queue WHERE id = \$1/.test(q.s) && q.params[0] === 31));
});

test('#3703: a question under the spec card is answered with that spec in front of the bot', async (t) => {
  const h = harness({
    proposalThread: [
      { author: 'evan', body: 'does the order make sense though? Its the same as "intervals"', createdAt: '2026-09-26T11:20:00Z' },
      { author: 'evan', body: '@homeroom_bot', createdAt: '2026-09-26T11:20:12Z' },
    ],
    spec: '# Add relative-note lessons that span different keys\n\nNotes comes before Intervals.',
  });
  const out = await run(t, h);
  assert.equal(out.verdict, 'answer');
  const read = h.calls.queries.find((q) => /SELECT content FROM chat_session_specs/.test(q.s));
  assert.deepEqual(read.params, [5001], 'the proposal\'s own spec');
  assert.match(read.s, /ORDER BY version DESC LIMIT 1/, 'its newest version, the one the card opens');
  assert.match(h.calls.exec[0].opts.prompt, /Notes comes before Intervals\./);
  assert.match(h.calls.exec[0].opts.prompt, /@homeroom_bot/);
  assert.equal(h.calls.posts[0].proposalSessionId, 5001, 'answered in the thread it was asked in');
});

test('#3703: without a spec (or when it cannot be read) the follow-up still runs', async (t) => {
  const h = harness({ proposalThread: [{ author: 'sam', body: 'Why zinc-950?', createdAt: '2026-09-26T11:20:00Z' }] });
  const realQuery = h.pool.query;
  h.pool.query = async (sql, params) => {
    if (/FROM chat_session_specs/.test(String(sql))) throw new Error('boom');
    return realQuery(sql, params);
  };
  const out = await run(t, h);
  assert.equal(out.verdict, 'answer');
  assert.doesNotMatch(h.calls.exec[0].opts.prompt, /THE SPEC THIS PROPOSAL/);
});

test('#3703: a row started as a follow-up beside other work never falls through to triage', async (t) => {
  // The bot's proposal merged (or the app was paused) between the
  // pick and the run: the app's own session may be busy with another
  // request, so the row touches nothing and goes back to the queue.
  const comments = [{ author: 'evan', body: 'x', createdAt: '2026-09-26T11:30:00Z' }];
  const realPost = live.post;
  t.after(() => { live.post = realPost; });
  for (const settings of [SETTINGS, { ...SETTINGS, pausedApps: [APP.slug] }]) {
    const h = harness({ proposalStatus: null, comments });
    live.post = async (args) => { h.calls.posts.push(args); return {}; };
    const out = await bot.runTriage(h.pool, {}, {
      bot: BOT, app: APP, item: { ...ITEM, followUp: true }, mode: 'shadow', settings, deps: h.deps,
    });
    assert.deepEqual(out, { ran: false, reason: bot.NOT_FOLLOW_UP });
    assert.equal(h.calls.exec.length, 0, 'no turn');
    assert.equal(h.calls.posts.length, 0, 'no "looking" post');
    assert.ok(!h.calls.queries.some((q) => /INSERT INTO homeroom_bot_runs|DELETE FROM homeroom_bot_queue|status IN \('active', 'paused'\)/.test(q.s)));
  }
});

test('a clear change is made on the proposal, and the proposal is reconciled like any revision', async (t) => {
  const h = harness({
    comments: [{ author: 'evan', body: 'Make it #000 instead', createdAt: '2026-09-26T11:30:00Z' }],
    result: { lastResultText: '```json\n{"action":"revise","reply":"Done.","summary":"The dark background is now #000."}\n```', pushOk: true, sha: NEW_HEAD },
  });
  const out = await run(t, h);
  assert.equal(out.verdict, 'revise');
  assert.equal(h.calls.reconciled.length, 1);
  assert.equal(h.calls.reconciled[0].fresh, true, 'reads the head it just pushed');
  assert.equal(h.calls.reconciled[0].notify, true, 'the thread says the votes were cleared');
  assert.equal(h.calls.reconciled[0].session.id, 5001);
  assert.equal(h.calls.posts[0].kind, 'followup_revise');
  assert.equal(h.calls.posts[0].proposalSessionId, null, 'asked on the issue, answered on the issue');
  assert.match(h.calls.posts[0].text, /The dark background is now #000\./);
  // B4: the change's card in the thread, in place of its address.
  assert.doesNotMatch(h.calls.posts[0].text, /https:/);
  assert.equal(h.calls.posts[0].msgType, 'vote');
  assert.equal(h.calls.posts[0].metadata.vote.sessionId, 5001);
  const insert = insertOf(h);
  assert.equal(insert.params[4], 'revise');
  assert.equal(insert.params[9], 'The dark background is now #000.', 'build_note says what changed');
});

test('#4612: a revise that says the plan changed publishes the next spec version, the card and the issue copy', async (t) => {
  const plan = '<article data-spec>\n  <h1>Darker dark mode</h1>\n  <section data-spec-tab="user"><p>The dark background is #000.</p></section>\n  <section data-spec-tab="tech"><p>One constant in the theme module.</p></section>\n</article>';
  const h = harness({
    comments: [{ author: 'evan', body: 'Make it #000', createdAt: '2026-09-26T11:30:00Z' }],
    result: {
      lastResultText: `${plan}\n\n\`\`\`json\n{"action":"revise","reply":"Done.","summary":"The dark background is now #000.","plan":true}\n\`\`\``,
      pushOk: true, sha: NEW_HEAD,
    },
  });
  const specCalls = [];
  h.deps.sessions.persistScoutPublication = async (args) => { specCalls.push(args); return { specVersion: 2 }; };
  h.deps.github.createIssueComment = async (owner, repo, number, body) => {
    h.calls.issueComments.push({ owner, repo, number, body });
    return { created_at: '2026-09-26T12:06:00Z' };
  };
  h.deps.ws = {
    // Only the spec card is a sendBotMessage here: the "working" note goes
    // through postThreadNote, which also lands here when the reply was not
    // in the proposal's thread.
    async sendBotMessage(pool, appId, msg) { if (msg?.msgType === 'spec_share') h.calls.cards.push(msg); return { id: 1 }; },
  };
  const out = await run(t, h);
  assert.equal(out.verdict, 'revise', 'an unreadable plan never blocks the revise, and a readable one does not either');
  // Stored as the next numbered version of the proposal's session.
  assert.equal(specCalls.length, 1);
  assert.equal(specCalls[0].sessionId, 5001);
  assert.equal(specCalls[0].hadSpec, true, 'the transcript says the plan was revised');
  assert.match(specCalls[0].content, /Darker dark mode/);
  assert.match(specCalls[0].content, /#000/);
  assert.match(specCalls[0].contentHtml, /<article data-spec>/, 'stored as an HTML document with its markdown copy');
  // The numbering itself: the version row is MAX(version)+1 on its session.
  assert.match(read('src/routes/sessions.js'),
    /COALESCE\(\(SELECT MAX\(version\) FROM chat_session_specs WHERE session_id = \$1\), 0\) \+ 1/,
    'the next version is MAX(version)+1, so old cards stay');
  // Shared with the group, then the card in the change's discussion.
  const share = h.calls.queries.find((q) => /UPDATE chat_session_specs SET shared_to_group_at/.test(q.s));
  assert.deepEqual(share.params, [5001, 2]);
  assert.equal(h.calls.cards.length, 1);
  assert.equal(h.calls.cards[0].content, '📋 Plan v2: Darker dark mode, updated for this change.');
  assert.equal(h.calls.cards[0].msgType, 'spec_share');
  assert.deepEqual(h.calls.cards[0].thread, { type: 'session', ref: 5001 });
  assert.equal(h.calls.cards[0].metadata.specShare.version, 2, 'the transcript shows it as v2, beside the v1 card');
  // And its copy on the GitHub issue, in the same collapsed block.
  assert.equal(h.calls.issueComments.length, 1);
  assert.equal(h.calls.issueComments[0].number, 24);
  assert.match(h.calls.issueComments[0].body, /^Homeroom bot updated the plan for this change to match \(version 2\)\./);
  assert.match(h.calls.issueComments[0].body, /<details><summary>The plan<\/summary>/);
  assert.match(h.calls.issueComments[0].body, /Darker dark mode/);
  // The update message names the version; the bot has seen its own comment.
  assert.match(h.calls.posts[0].text, /Its plan is updated to match: version 2 is in the change's discussion\./);
  assert.ok(h.calls.seen[0].postedAt.includes('2026-09-26T12:06:00Z'), 'its own issue comment counts as seen');
});

test('#4612: a revise that leaves the plan alone publishes no version', async (t) => {
  const h = harness({
    comments: [{ author: 'evan', body: 'Make it #000', createdAt: '2026-09-26T11:30:00Z' }],
    result: {
      lastResultText: '```json\n{"action":"revise","reply":"Done.","summary":"The dark background is now #000."}\n```',
      pushOk: true, sha: NEW_HEAD,
    },
  });
  const specCalls = [];
  h.deps.sessions.persistScoutPublication = async (args) => { specCalls.push(args); return { specVersion: 2 }; };
  h.deps.github.createIssueComment = async () => { throw new Error('nothing should be posted'); };
  h.deps.ws = { async sendBotMessage() { throw new Error('no card should be posted'); } };
  const out = await run(t, h);
  assert.equal(out.verdict, 'revise');
  assert.equal(specCalls.length, 0, 'no version stored');
  assert.equal(h.calls.queries.some((q) => /UPDATE chat_session_specs SET shared_to_group_at|INSERT INTO chat_session_specs/.test(q.s)), false, 'no spec SQL runs');
  assert.doesNotMatch(h.calls.posts[0].text, /Its plan is updated/, 'no version line');
});

test('#4612: a plan the turn could not produce is not published, and the revise still lands', async (t) => {
  const h = harness({
    comments: [{ author: 'evan', body: 'Make it #000', createdAt: '2026-09-26T11:30:00Z' }],
    result: {
      lastResultText: 'I could not write the plan.\n```json\n{"action":"revise","reply":"Done.","summary":"The dark background is now #000.","plan":true}\n```',
      pushOk: true, sha: NEW_HEAD,
    },
  });
  const specCalls = [];
  h.deps.sessions.persistScoutPublication = async (args) => { specCalls.push(args); return { specVersion: 2 }; };
  const out = await run(t, h);
  assert.equal(out.verdict, 'revise', 'the revision is recorded');
  assert.equal(specCalls.length, 0, 'a fragment is not stored as a version');
  assert.equal(h.calls.posts[0].kind, 'followup_revise');
  assert.doesNotMatch(h.calls.posts[0].text, /Its plan is updated/);
});

test('#4612: a plan on a turn whose head did not move is ignored, as the failed revise is', async (t) => {
  const h = harness({
    comments: [{ author: 'evan', body: 'Make it #000', createdAt: '2026-09-26T11:30:00Z' }],
    result: {
      lastResultText: '<article data-spec>\n<h1>x</h1>\n</article>\n```json\n{"action":"revise","reply":"Done.","plan":true}\n```',
      pushOk: true, sha: OLD_HEAD,
    },
  });
  const specCalls = [];
  h.deps.sessions.persistScoutPublication = async (args) => { specCalls.push(args); return { specVersion: 2 }; };
  const out = await run(t, h);
  assert.equal(out.verdict, 'failed');
  assert.equal(specCalls.length, 0, 'no version stored');
  assert.equal(h.calls.posts[0].kind, 'followup_failed');
});

test('a turn that changed files while "answering" is still a revision, and is reconciled', async (t) => {
  const h = harness({
    comments: [{ author: 'evan', body: 'thoughts?', createdAt: '2026-09-26T11:30:00Z' }],
    result: { lastResultText: '```json\n{"action":"answer","reply":"Tweaked it."}\n```', pushOk: true, sha: NEW_HEAD },
  });
  const out = await run(t, h);
  assert.equal(out.verdict, 'revise', 'the pushed head is the truth, not the label');
  assert.equal(h.calls.reconciled.length, 1, 'votes on the old head must not keep counting');
});

test('"revise" that pushed nothing is a failure, said plainly, and nothing is reconciled', async (t) => {
  const h = harness({
    comments: [{ author: 'evan', body: 'Make it #000', createdAt: '2026-09-26T11:30:00Z' }],
    result: { lastResultText: '```json\n{"action":"revise","reply":"Done."}\n```', pushOk: true, sha: OLD_HEAD },
  });
  const out = await run(t, h);
  assert.equal(out.verdict, 'failed');
  assert.equal(h.calls.reconciled.length, 0);
  assert.match(insertOf(h).params[18], /^revise: the turn produced no change/);
  assert.equal(h.calls.posts[0].kind, 'followup_failed');
  // 5 Oct 2026: plain words and how to start it again, never the run's record
  // (tests/homeroom-bot-revision-failed.test.js).
  assert.equal(h.calls.posts[0].text, 'Homeroom bot couldn\'t update this change: it ended up with no changes to show. '
    + 'The change is as it was. Reply here (or on the GitHub issue) and it will try again.');
  // The requester hears it in their DM, with the change's card; the record goes with it to be read, never quoted.
  assert.deepEqual(h.calls.posts[0].dm, {
    reason: 'the turn produced no change', canRevise: true, sessionId: 5001,
    // #4367: the change has PR #25, so its link goes by that number.
    link: live.proposalLink('app.onhomeroom.com', APP.slug, 5001, 25),
  });
});

test('a GLM follow-up whose agent failed is no revision: its push is never reconciled, and it asked for none', async (t) => {
  const h = harness({
    comments: [{ author: 'evan', body: 'Make it #000', createdAt: '2026-09-26T11:30:00Z' }],
    // What run-cc.sh printed for a failed turn before it learned to discard
    // one: the partial work committed and pushed onto the proposal's branch.
    result: {
      agentHarness: 'claude', ccExit: 1, exitCode: 1, pushOk: true, sha: NEW_HEAD,
      lastResultText: '```json\n{"action":"revise","reply":"Done.","summary":"Darker."}\n```',
    },
  });
  const out = await run(t, h);
  assert.equal(out.verdict, 'failed');
  assert.equal(h.calls.reconciled.length, 0, 'the proposal stays as it was voted on');
  assert.equal(insertOf(h).params[18], 'revise: the turn failed (the agent exited with code 1), so its change was not kept');
  assert.equal(h.calls.posts[0].kind, 'followup_failed');
  assert.equal(h.calls.posts[0].text, 'Homeroom bot couldn\'t update this change: something went wrong during the update. '
    + 'The change is as it was. Reply here (or on the GitHub issue) and it will try again.');
  assert.doesNotMatch(h.calls.posts[0].text, /exited|code 1|not kept|turn/, 'the run\'s record stays on the run');
  assert.equal(h.calls.exec[0].opts.discardFailedTurn, true, 'run-cc.sh is asked to commit and push nothing from a failed turn');

  // With no answer at all, the failure is the reason, not "unparseable".
  const silent = harness({
    comments: [{ author: 'evan', body: 'Make it #000', createdAt: '2026-09-26T11:30:00Z' }],
    result: { agentHarness: 'claude', ccExit: 1, exitCode: 1, pushOk: false, sha: null, lastResultText: '' },
  });
  const out2 = await run(t, silent);
  assert.equal(out2.verdict, 'failed');
  assert.equal(insertOf(silent).params[18], 'the follow-up turn failed (the agent exited with code 1)');
  assert.equal(silent.calls.reconciled.length, 0);
});

test('a GLM follow-up that ended on an API error with exit 0 is no revision, whatever it pushed', async (t) => {
  const notice = 'API Error: 429 {"error":{"message":"Provider returned error","code":429}}';
  // Pushed anyway (a runner that did not discard it): never reconciled.
  const h = harness({
    comments: [{ author: 'evan', body: 'Make it #000', createdAt: '2026-09-26T11:30:00Z' }],
    result: { agentHarness: 'claude', ccExit: 0, exitCode: 0, pushOk: true, sha: NEW_HEAD, lastResultText: notice },
  });
  const out = await run(t, h);
  assert.equal(out.verdict, 'failed');
  assert.equal(h.calls.reconciled.length, 0, 'the proposal stays as it was voted on');
  assert.equal(insertOf(h).params[18], 'the follow-up turn failed (it ended on an API error: '
    + 'API Error: 429 {"error":{"message":"Provider returned error","code":429}})');
  // Discarded by run-cc.sh, as it now is: the same, and the reason is named.
  const discarded = harness({
    comments: [{ author: 'evan', body: 'Make it #000', createdAt: '2026-09-26T11:30:00Z' }],
    result: { agentHarness: 'claude', ccExit: 0, exitCode: 1, pushOk: false, sha: null, lastResultText: notice },
  });
  const out2 = await run(t, discarded);
  assert.equal(out2.verdict, 'failed');
  assert.equal(discarded.calls.reconciled.length, 0);
  // The notice, read before the exit code run-cc.sh gave it.
  assert.equal(insertOf(discarded).params[18], 'the follow-up turn failed (it ended on an API error: '
    + 'API Error: 429 {"error":{"message":"Provider returned error","code":429}})');
});

test('a Codex follow-up whose agent failed fails exactly as it did', async (t) => {
  const h = harness({
    comments: [{ author: 'evan', body: 'Make it #000', createdAt: '2026-09-26T11:30:00Z' }],
    // The Codex runner's own result for a failed turn: nothing pushed.
    result: {
      agentHarness: 'codex', ccExit: 1, agentExit: 1, exitCode: 1, pushOk: false, sha: null,
      lastResultText: '```json\n{"action":"revise","reply":"Done."}\n```',
    },
  });
  const out = await run(t, h);
  assert.equal(out.verdict, 'failed');
  assert.equal(h.calls.reconciled.length, 0);
  assert.equal(insertOf(h).params[18], 'revise: its change could not be pushed', 'the message it always had');
});

test('after MAX_REVISIONS the turn runs read-only, and can only hand over', async (t) => {
  const h = harness({
    revisions: followup.MAX_REVISIONS,
    comments: [{ author: 'evan', body: 'One more tweak', createdAt: '2026-09-26T11:30:00Z' }],
    result: { lastResultText: '```json\n{"action":"person","reply":"They want another change; a person should take this over."}\n```', pushOk: false, sha: OLD_HEAD },
  });
  const out = await run(t, h);
  assert.equal(h.calls.loop.mode, 'scout', 'no commit, no push');
  assert.doesNotMatch(h.calls.exec[0].opts.prompt, /- "revise":/);
  assert.equal(out.verdict, 'person');
  assert.equal(h.calls.posts[0].kind, 'followup_person');
  assert.equal(followup.MAX_REVISIONS, 3);
});

test('a "revise" after MAX_REVISIONS changes nothing, and says a reply would not either', async (t) => {
  const h = harness({
    revisions: followup.MAX_REVISIONS,
    comments: [{ author: 'evan', body: 'One more tweak', createdAt: '2026-09-26T11:30:00Z' }],
    result: { lastResultText: '```json\n{"action":"revise","reply":"Done."}\n```', pushOk: false, sha: OLD_HEAD },
  });
  const out = await run(t, h);
  assert.equal(out.verdict, 'failed');
  assert.equal(h.calls.posts[0].kind, 'followup_failed');
  assert.equal(h.calls.posts[0].text, 'Homeroom bot couldn\'t update this change: it has already updated it as many times as it may '
    + 'on its own, so a person needs to make this one. The change is as it was.');
  assert.doesNotMatch(h.calls.posts[0].text, /try again/, 'a reply would not get it updated');
  assert.equal(h.calls.posts[0].dm.canRevise, false);
});

test('a proposal that is merging is left alone', async (t) => {
  const h = harness({ proposalStatus: 'merging', comments: [{ author: 'evan', body: 'x', createdAt: '2026-09-26T11:30:00Z' }] });
  const out = await run(t, h);
  assert.deepEqual(out, { ran: false, reason: 'has_proposal' });
  assert.equal(h.calls.exec.length, 0);
});

// ── With the bot's voice on (homeroom-bot-voice.js) ──────────────────────

function voiceStub(asks, { gaveUp = [] } = {}) {
  const calls = { reports: [], finished: [], released: [] };
  return {
    calls,
    voiceOn: () => true,
    async takeAsks() { return asks; },
    async asksOf() { return []; },
    async releaseAsks(p, args) { calls.released.push(args); return gaveUp; },
    async finishAsks(p, args) { calls.finished.push(args); },
    async asksWaiting() { return false; },
    async dropAsks() {},
    async reportFollowUp(p, c, args) { calls.reports.push(args); return 1; },
  };
}
const ASK = {
  id: 4, asker: 'evan', asker_id: 3, instruction: 'Make the header blue on every page', source: 'thread',
  place_type: 'session', place_ref: 5001, message_id: 77, created_at: '2026-09-26T11:25:00Z',
};

test('voice on: the turn takes what was asked as asks, and the voice tells who asked; nothing is said twice', async (t) => {
  const h = harness({
    proposalThread: [{ author: 'sam', body: 'Why zinc-950?', createdAt: '2026-09-26T11:20:00Z' }],
    result: { lastResultText: '```json\n{"action":"revise","reply":"Done.","summary":"The header is blue on every page."}\n```', pushOk: true, sha: NEW_HEAD },
  });
  h.deps.voice = voiceStub([ASK]);
  const out = await run(t, h);
  assert.equal(out.verdict, 'revise');
  assert.match(h.calls.exec[0].opts.prompt, /evan, asked you for a change in the proposal's discussion/);
  assert.match(h.calls.exec[0].opts.prompt, /Make the header blue on every page/);
  assert.doesNotMatch(h.calls.exec[0].opts.prompt, /- sam, in the proposal's discussion/,
    'a question there was the voice\'s to answer: it is context, not a reply to act on');
  assert.equal(h.calls.posts.length, 1, 'recorded, and relayed to the requester\'s card');
  assert.equal(h.calls.posts[0].skipIssueThread, true, 'not said again in the request\'s thread');
  assert.equal(h.calls.posts[0].skipGithub, false, 'an update is a milestone GitHub hears');
  assert.equal(h.calls.posts[0].proposalSessionId, null, 'nothing in the change\'s discussion from here');
  const { reports, finished } = h.deps.voice.calls;
  assert.equal(reports.length, 1);
  assert.equal(reports[0].outcome.action, 'revise');
  assert.equal(reports[0].outcome.moved, true);
  assert.equal(reports[0].outcome.summary, 'The header is blue on every page.');
  assert.deepEqual(reports[0].asks, [ASK]);
  assert.equal(finished.length, 1);
  assert.equal(finished[0].runId, 901);
});

test('voice on: an answer to an ask goes nowhere but where it was asked, and no "working on it" note', async (t) => {
  const h = harness({});
  h.deps.voice = voiceStub([ASK]);
  const notes = [];
  h.deps.ws = { async sendBotMessage(p, appId, m) { notes.push(m); return { id: 1 }; } };
  const out = await run(t, h);
  assert.equal(out.verdict, 'answer');
  assert.equal(h.calls.posts[0].skipGithub, true, 'GitHub hears no conversation');
  assert.equal(h.calls.posts[0].skipIssueThread, true);
  assert.equal(notes.length, 0, 'the voice said it was queued; the turn says nothing of its own');
  assert.equal(h.deps.voice.calls.reports[0].outcome.action, 'answer');
  assert.equal(h.deps.voice.calls.reports[0].outcome.reply, 'Because the platform uses it.');
});

test('voice on: a failed turn puts its asks back, and the ones that gave up hear so from the voice', async (t) => {
  const h = harness({ result: { lastResultText: '```json\n{"action":"revise","reply":"Done."}\n```', pushOk: true, sha: OLD_HEAD } });
  h.deps.voice = voiceStub([ASK], { gaveUp: [ASK] });
  const out = await run(t, h);
  assert.equal(out.verdict, 'failed');
  assert.equal(h.calls.posts.length, 0, 'no fixed note: the voice tells them');
  assert.deepEqual(h.deps.voice.calls.released.map((r) => r.refund), [false], 'a real try');
  const report = h.deps.voice.calls.reports[0];
  assert.equal(report.outcome.action, 'failed');
  assert.equal(report.outcome.why, 'something went wrong while it worked on it');
});

// ── Getting it queued ────────────────────────────────────────────────────

test('on a live app, a person\'s message in the bot proposal\'s thread is activity on its issue', async () => {
  const inserts = [];
  const pool = {
    async query(sql, params) {
      const s = String(sql);
      if (/FROM issue_claims|UNNEST\(cs\.linked_issues\) AS n\s+FROM chat_sessions cs JOIN users|headless_issue_number AS n|created_from_issue_number AS n/.test(s)) return { rows: [] };
      if (/CROSS JOIN LATERAL UNNEST\(cs\.linked_issues\)/.test(s)) {
        assert.deepEqual(params, [9, 77], 'the bot\'s own proposals on this app');
        return { rows: [{ n: 24, last_at: '2026-09-26T11:20:00Z' }] };
      }
      if (/FROM chat_messages/.test(s)) return { rows: [] };
      if (/FROM homeroom_bot_runs/.test(s)) return { rows: [{ issue_number: 24, thread_seen_at: SEEN, created_at: SEEN }] };
      if (/INSERT INTO homeroom_bot_queue/.test(s)) { inserts.push(params); return { rows: [] }; }
      if (/DELETE FROM homeroom_bot_queue/.test(s)) return { rowCount: 0, rows: [] };
      return { rows: [] };
    },
  };
  const github = { async fetchPublicIssues() { return { issues: [{ number: 24, state: 'open', updatedAt: SEEN }] }; } };
  await bot.refreshApp(pool, APP, { github, bot: BOT, capRoom: { proposals_per_app: 1, question_tripwire: 5 } });
  assert.deepEqual(inserts.map((p) => [p[1], p[3]]), [[24, 'changed']]);

  inserts.length = 0;
  await bot.refreshApp(pool, APP, { github, bot: BOT });
  assert.equal(inserts.length, 0, 'a shadow app never follows up');
});

test('a message in the bot\'s proposal thread wakes it; any other proposal\'s does not', async () => {
  const asked = [];
  const pool = (rows) => ({ async query(sql, params) { asked.push({ s: String(sql), params }); return { rows }; } });
  assert.equal(await bot.noteProposalActivity(pool([{ linked_issues: [24] }]), { appId: 9, sessionId: 5001 }), true);
  assert.deepEqual(asked[0].params, [5001, 9, 'homeroom_bot']);
  assert.match(asked[0].s, /cs\.status = 'promoted'/);
  assert.equal(await bot.noteProposalActivity(pool([]), { appId: 9, sessionId: 6000 }), false);
  const ws = read('src/services/ws.js');
  assert.match(ws, /if \(thread && thread\.type === 'session'\) noteProposalActivityForBot\(pool, client\.appId, thread\.ref\);/);
});

test('the bot\'s replies in a proposal thread come from its own user, and are never read as a person\'s', () => {
  // #3288: its posts are ordinary messages now, so the guard is who wrote
  // them, not what kind of row they are.
  const src = read('src/services/homeroom-bot-live.js');
  assert.match(src, /inThread\(own, \{ type: 'session', ref: Number\(proposalSessionId\) \}, null, 'system'\)/);
  assert.match(src, /ws\.sendBotMessage\(pool, app\.id, \{ user: sender, content, metadata: meta, thread \}\)/);
  const q = read('src/services/homeroom-bot.js');
  const activity = q.slice(q.indexOf('async function proposalThreadActivityByIssue'), q.indexOf('function latestOf'));
  assert.match(activity, /m\.msg_type = 'message'/);
  assert.match(activity, /cs\.status = 'promoted'/);
  assert.match(activity, /author\.is_synthetic IS NOT TRUE/, 'the bot\'s own reply there does not re-queue it');
});


test('#3767: a revision that changed what the proposal does names it again, and builds with the design guidance', () => {
  const prompt = followup.followUpPrompt({
    seed: 'SEED', replies: [{ author: 'ada', where: 'proposal', createdAt: '2026-10-03T10:00:00Z', body: 'drop the size options' }],
    canRevise: true, design: 'DESIGN BLOCK',
  });
  assert.match(prompt, /give it a new `title` that says what it does now/);
  assert.match(prompt, /"title": "for revise only, when what the proposal does changed: its new short title"/);
  assert.ok(prompt.indexOf('DESIGN BLOCK') > prompt.indexOf('"person"'), 'the guidance follows the choices');
  assert.ok(prompt.indexOf('DESIGN BLOCK') < prompt.indexOf('END YOUR REPLY'), 'and comes before the format');
  // No revision allowed: no design guidance to follow.
  assert.doesNotMatch(followup.followUpPrompt({ seed: 'SEED', replies: [], canRevise: false, design: 'DESIGN BLOCK' }), /DESIGN BLOCK/);

  const fence = (obj) => `done\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;
  assert.equal(followup.parseFollowUp(fence({ action: 'revise', reply: 'ok', summary: 's', title: '  Each lesson   runs its full list ' })).title,
    'Each lesson runs its full list');
  assert.equal(followup.parseFollowUp(fence({ action: 'revise', reply: 'ok', summary: 's' })).title, undefined, 'the old name stays');
  assert.equal(followup.parseFollowUp(fence({ action: 'answer', reply: 'ok', title: 'Not a revision' })).title, undefined);
  assert.equal(followup.parseFollowUp(fence({ action: 'revise', reply: 'ok', title: 'x' })).title, undefined, 'too short to be a name');

  const live = require('../src/services/homeroom-bot-live');
  const design = live.revisionDesignText({ readsImages: true });
  assert.match(design, /^IF YOUR CHANGE TOUCHES WHAT PEOPLE SEE/);
  assert.match(design, /that visual check is EXPECTED, not optional/);
  assert.match(design, /take screenshots \(`browser_take_screenshot`\)/);
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/services/homeroom-bot.js'), 'utf8');
  assert.match(src, /if \(moved && parsed\?\.title\) await renameRevised\(/, 'renamed only when the revision landed');
  assert.match(src, /require\('\.\/proposal-update'\)\.applyProposedTitle\(\{/, 'through the seam a person\'s revision uses');
});
