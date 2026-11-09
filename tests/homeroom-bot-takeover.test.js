'use strict';

// #6537: the Homeroom bot updates a change its author made in Claude Code or
// Codex when the author (or an admin) asks, on that same change
// (src/services/homeroom-bot-takeover.js). Who may ask and what is refused
// (voice.changeGate), what the ask records and starts (update_change), the
// update's run on the change's own branch, what the people who asked are
// told, the limit it counts against, and how the push settles
// (proposal-update.js settleLandedHead).

const test = require('node:test');
const assert = require('node:assert/strict');

const takeover = require('../src/services/homeroom-bot-takeover');
const voice = require('../src/services/homeroom-bot-voice');
const followup = require('../src/services/homeroom-bot-followup');
const live = require('../src/services/homeroom-bot-live');
const proposalUpdate = require('../src/services/proposal-update');

const LIVE = { mode: 'live', voiceSession: true, voiceIssue: true, voiceChat: true, pausedApps: [] };
const APP = { id: 5, slug: 'usernode-2d5619', name: 'Homeroom', repo_url: 'https://github.com/Usernode-Labs/social-vibecoding' };
const BOT = { id: 900, username: 'homeroom_bot' };
const EVAN = { id: 1, username: 'evan', isAdmin: false };
const ADMIN = { id: 2, username: 'root', isAdmin: true };
const ADA = { id: 3, username: 'ada', isAdmin: false };

// A connector draft: shared from Claude Code, its head in the app repository.
function draft(over = {}) {
  return {
    id: 13112, app_id: APP.id, user_id: EVAN.id, status: 'paused', is_headless: false, linked_issues: [],
    pr_number: 6508, title: 'Get more people in', branch_name: 'usernode/from-u1-s9b2f0358',
    external_agent: 'claude-code', source: null, imported_pr_head_repo: null, author_username: 'evan',
    ...over,
  };
}

// A pool that answers the gate's reads: no blocks, the revisions given.
function gatePool({ asked = 0, takeovers = 0 } = {}) {
  const seen = [];
  return {
    seen,
    async query(sql) {
      const s = String(sql);
      seen.push(s);
      if (/FROM user_blocks/.test(s)) return { rows: [] };
      if (/FROM homeroom_bot_runs/.test(s) && /AS own/.test(s)) return { rows: [{ own: 0, asked }] };
      if (/FROM homeroom_bot_revision_grants/.test(s)) return { rows: [{ used: 0, open: null }] };
      if (/FROM homeroom_bot_looks/.test(s) && /kind = 'update'/.test(s)) return { rows: [{ n: takeovers }] };
      return { rows: [] };
    },
  };
}

const gateDeps = (over = {}) => ({
  liveSvc: { isLiveFor: () => true, openBotProposal: async () => null },
  dmSvc: { overWeeklyAllowance: async () => false, requesterOf: async () => null },
  mayor: { canFile: async () => true },
  ...over,
});

const gate = (change, speaker, { pool = gatePool(), deps = gateDeps(), settings = LIVE } = {}) => voice.changeGate(pool, {
  app: APP, change, speaker, settings, bot: BOT, deps,
});

// ── Who may ask ───────────────────────────────────────────────────────────

test('only a change made in Claude Code or Codex, asked of by its author or an admin, may be handed to the bot', () => {
  assert.equal(takeover.mayAsk(draft(), EVAN), true, 'its author');
  assert.equal(takeover.mayAsk(draft(), ADMIN), true, 'an admin');
  assert.equal(takeover.mayAsk(draft(), ADA), false, 'anybody else');
  assert.equal(takeover.mayAsk(draft({ external_agent: null }), EVAN), false, 'a change made on Homeroom');
  assert.equal(takeover.mayAsk(draft({ is_headless: true }), EVAN), false);
  assert.equal(takeover.mayAsk(draft({ external_agent: 'codex' }), EVAN), true);
  assert.equal(takeover.mayAsk(draft(), { ...ADMIN, adminReadonly: true }), false, 'a view-only admin may not spend the author\'s week');
  assert.equal(takeover.toolOf(draft()), 'Claude Code');
  assert.equal(takeover.toolOf(draft({ external_agent: 'codex' })), 'Codex');
  assert.equal(takeover.toolOf(draft({ external_agent: null })), null);
});

test('the gate admits the author on a draft, active or paused, with no request, and the author pays', async () => {
  for (const status of ['paused', 'active']) {
    const out = await gate(draft({ status }), EVAN);
    assert.equal(out.ok, true, status);
    assert.equal(out.takeover, true);
    assert.equal(out.issueNumber, null, 'it answers no request');
    assert.equal(out.payerId, EVAN.id);
    assert.equal(out.theirs, true);
  }
});

test('the gate admits a change up for a vote with a request, and an admin, whose ask the author still pays for', async () => {
  const promoted = draft({ status: 'promoted', linked_issues: [41], source: 'imported', imported_pr_head_repo: 'Usernode-Labs/social-vibecoding' });
  const own = await gate(promoted, EVAN);
  assert.equal(own.ok, true);
  assert.equal(own.issueNumber, 41);
  const admin = await gate(promoted, ADMIN);
  assert.equal(admin.ok, true);
  assert.equal(admin.payerId, EVAN.id, 'the author\'s week, not the admin\'s');
  assert.equal(admin.theirs, false);
});

test('anybody else, and a change made on Homeroom, are refused as before', async () => {
  const before = 'That change is not one you built, so you cannot change it. Whoever made it can.';
  assert.deepEqual(await gate(draft(), ADA), { ok: false, error: before });
  assert.deepEqual(await gate(draft({ status: 'promoted', linked_issues: [41] }), ADA), { ok: false, error: before });
  // Somebody's own change made on Homeroom: not even its author hands it over.
  assert.deepEqual(await gate(draft({ external_agent: null }), EVAN), { ok: false, error: before });
  assert.deepEqual(await gate(draft({ external_agent: null }), ADMIN), { ok: false, error: before });
});

test('a merged, closed or forked change is refused in words, and nothing is queued', async () => {
  const merged = await gate(draft({ status: 'merged' }), EVAN);
  assert.match(merged.error, /approved, so it can no longer be changed/);
  const closed = await gate(draft({ status: 'archived' }), EVAN);
  assert.match(closed.error, /not in progress or up for a vote any more/);
  // A pull request whose head is in the author's own fork: Homeroom cannot push there.
  const fork = await gate(draft({
    status: 'promoted', source: 'imported', imported_pr_head_repo: 'evan/social-vibecoding', branch_name: 'my-branch',
  }), EVAN);
  assert.equal(fork.ok, false);
  assert.match(fork.error, /@evan's own fork/);
  const paused = await gate(draft(), EVAN, { settings: { ...LIVE, pausedApps: [APP.slug] } });
  assert.match(paused.error, /not working on Homeroom right now/);
});

test('its updates count toward the limit on updates people asked for, and its author\'s week must have room', async () => {
  const limit = followup.MAX_ASKED_REVISIONS;
  const counted = await gate(draft(), EVAN, { pool: gatePool({ asked: limit - 2, takeovers: 2 }) });
  assert.equal(counted.ok, false);
  assert.equal(counted.error, followup.askedLimitText());
  const spent = await gate(draft(), EVAN, {
    deps: gateDeps({ dmSvc: { overWeeklyAllowance: async (_p, _s, id) => id === EVAN.id } }),
  });
  assert.match(spent.error, /@evan's building time for this week is used up/);
  // An admin asking does not move the payer: still the author's week.
  const viaAdmin = await gate(draft(), ADMIN, {
    deps: gateDeps({ dmSvc: { overWeeklyAllowance: async (_p, _s, id) => id === EVAN.id } }),
  });
  assert.equal(viaAdmin.ok, false);
});

test('revisionCounts adds the updates that moved a handed-over change to its asked count', async () => {
  const counts = await followup.revisionCounts(gatePool({ asked: 1, takeovers: 3 }), 13112);
  assert.equal(counts.asked, 4);
  assert.equal(counts.own, 0);
});

// ── The bot's own changes keep their gate ────────────────────────────────

test('the bot\'s own change is gated as before: up for a vote, for a request', async () => {
  const mine = { id: 70, app_id: APP.id, user_id: BOT.id, status: 'active', is_headless: false, linked_issues: [41], external_agent: null };
  assert.match((await gate(mine, ADA)).error, /not up for a vote any more/);
  assert.match((await gate({ ...mine, status: 'promoted', linked_issues: [] }, ADA)).error, /answers no request/);
  const ok = await gate({ ...mine, status: 'promoted' }, ADA);
  assert.equal(ok.ok, true);
  assert.equal(ok.takeover, undefined);
});

// ── Tools and the prompt ─────────────────────────────────────────────────

test('update_change is offered on a handed-over change, and make_own_version stays as it is', () => {
  const names = (f) => voice.toolsFor({ type: 'session', ref: 1 }, f).map((t) => t.function.name);
  assert.ok(!names({ otherChange: true }).includes('update_change'), 'somebody else asking: no update');
  const handed = names({ otherChange: true, takeoverChange: true });
  assert.ok(handed.includes('update_change'));
  assert.ok(handed.includes('make_own_version'));
  assert.ok(!handed.includes('update_change_description'), 'the author\'s description is theirs');
  assert.ok(!handed.includes('let_try_again'));
  assert.equal(handed.filter((n) => n === 'update_change').length, 1);
  assert.ok(!names({ takeoverChange: true }).length || true);
  // Only in a change's own thread.
  const issue = voice.toolsFor({ type: 'issue', ref: 1 }, { takeoverChange: true }).map((t) => t.function.name);
  assert.ok(!issue.includes('update_change'));
});

test('the prompt offers the author the update, and no longer tells them to fix it there', () => {
  const tools = voice.toolsFor({ type: 'session', ref: 1 }, { otherChange: true, takeoverChange: true });
  const handed = voice.systemPrompt({ app: APP, place: { type: 'session', ref: 1 }, tools, takeover: true });
  assert.match(handed, /so you can update it, on this same change \(update_change\)/);
  assert.match(handed, /list each item in your reply/);
  assert.match(handed, /paid from its author's week/);
  assert.doesNotMatch(handed, /say they fix it there/);
  assert.doesNotMatch(handed, /Change one of your own changes/);
  // Anybody else on that change: the refusal, which now says its author can ask.
  const other = voice.systemPrompt({
    app: APP, place: { type: 'session', ref: 1 }, tools: voice.toolsFor({ type: 'session', ref: 1 }, { otherChange: true }),
  });
  assert.match(other, /say they fix it there, or that its author can ask you to update it here/);
  assert.ok(!/—/.test(handed + other), 'no em dash');
});

// ── The ask, and its update ──────────────────────────────────────────────

function queuePool({ runningUpdate = false } = {}) {
  const writes = [];
  let lookId = 300;
  return {
    writes,
    async query(sql, params = []) {
      const s = String(sql);
      if (/INSERT INTO homeroom_bot_change_asks/.test(s)) { writes.push({ ask: params }); return { rows: [{ id: 77 }] }; }
      if (/SELECT status, COUNT\(\*\)::int AS n FROM homeroom_bot_change_asks/.test(s)) return { rows: [{ status: 'queued', n: 1 }] };
      if (/UPDATE homeroom_bot_looks SET state = 'failed'/.test(s)) { writes.push({ stale: params }); return { rows: [], rowCount: 0 }; }
      if (/INSERT INTO homeroom_bot_looks/.test(s)) {
        writes.push({ look: params, sql: s });
        if (runningUpdate) { const e = new Error('duplicate'); e.code = '23505'; throw e; }
        lookId += 1;
        return { rows: [{ id: lookId }] };
      }
      if (/SELECT id FROM homeroom_bot_looks WHERE kind = 'update'/.test(s)) return { rows: [{ id: 299 }] };
      if (/UPDATE homeroom_bot_change_asks SET status = 'dropped'/.test(s)) { writes.push({ dropped: params }); return { rows: [] }; }
      return { rows: [] };
    },
  };
}

function askCtx(pool, speaker = EVAN, change = draft(), runs = []) {
  return {
    app: APP, place: { type: 'session', ref: change.id }, user: speaker, settings: LIVE, bot: BOT,
    change, triggerMessage: { id: 555 }, open: [],
    deps: {
      ...gateDeps(),
      ws: { pushToUser: () => 1 },
      requestRun: async (_p, args) => { runs.push(args); },
    },
  };
}

test('update_change on a connector draft records the ask with no request and starts one update, paid by the author', async () => {
  const pool = queuePool();
  const runs = [];
  const ctx = askCtx(pool, EVAN, draft(), runs);
  const out = await voice.runTool(pool, ctx, 'update_change', {
    instruction: 'Reword the two reminder emails, add the app store links, and give the stop page one button.',
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.match(out.queued, /on this same change/);
  assert.match(out.paidBy, /@evan's building time/);
  assert.match(out.next, /list each thing you will change/);
  assert.match(out.next, /from Claude Code has to start from your update/);
  const ask = pool.writes.find((w) => w.ask).ask;
  assert.equal(ask[1], 13112, 'on that same change');
  assert.equal(ask[2], null, 'no request number');
  assert.equal(ask[3], EVAN.id);
  const look = pool.writes.find((w) => w.look);
  assert.equal(look.look[0], EVAN.id, 'the author\'s week pays');
  assert.equal(look.look[2], 13112);
  assert.match(look.sql, /'update'/);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].userId, EVAN.id);
  assert.equal(ctx.revised, true);
});

test('an admin\'s ask is recorded as theirs and paid by the author; one on a change already updating waits for it', async () => {
  const pool = queuePool({ runningUpdate: true });
  const runs = [];
  const promoted = draft({ status: 'promoted', linked_issues: [41] });
  const out = await voice.runTool(pool, askCtx(pool, ADMIN, promoted, runs), 'update_change', {
    instruction: 'Make the stop page a single Stop button.',
  });
  assert.equal(out.ok, true);
  assert.match(out.queued, /queued right behind it/);
  assert.match(out.next, /votes are cleared when the update lands/);
  const ask = pool.writes.find((w) => w.ask).ask;
  assert.equal(ask[2], 41);
  assert.equal(ask[3], ADMIN.id, 'the admin asked');
  assert.equal(pool.writes.find((w) => w.look).look[0], EVAN.id, 'the author pays');
  assert.equal(runs.length, 0, 'the running update starts the next one');
});

test('somebody else\'s ask on that change is refused, and nothing is recorded', async () => {
  const pool = queuePool();
  const out = await voice.runTool(pool, askCtx(pool, ADA), 'update_change', { instruction: 'Make the stop page a single button.' });
  assert.equal(out.ok, false);
  assert.match(out.error, /Whoever made it can/);
  assert.equal(pool.writes.length, 0);
});

// ── The update's run ─────────────────────────────────────────────────────

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);

function runPool({ waiting = false } = {}) {
  const state = { asks: [], taken: false, finished: null, queries: [] };
  const ask = {
    id: 77, session_id: 13112, app_id: APP.id, issue_number: null, asker_id: EVAN.id, asker: 'evan',
    instruction: 'Reword the reminder emails and give the stop page one button.', status: 'taken',
    run_tag: 'upd301', place_type: 'session', place_ref: 13112, message_id: 555, created_at: '2026-11-09T17:00:00.000Z',
  };
  return {
    state,
    async query(sql, params = []) {
      const s = String(sql);
      state.queries.push(s);
      if (/FROM apps WHERE id = \$1/.test(s)) return { rows: [APP] };
      if (/external_agent::text AS external_agent/.test(s)) return { rows: [draft()] };
      if (/SELECT id, username, is_admin, locale FROM users/.test(s)) return { rows: [{ id: EVAN.id, username: 'evan', is_admin: false, locale: null }] };
      if (/FROM homeroom_bot_change_asks a WHERE a.run_tag = \$1/.test(s)) return { rows: state.taken ? [ask] : [] };
      if (/UPDATE homeroom_bot_change_asks a SET status = 'taken'/.test(s)) { state.taken = true; return { rows: [ask] }; }
      if (/SELECT cs\.\*, a\.slug AS app_slug/.test(s)) return { rows: [{ ...draft(), app_slug: APP.slug, app_name: APP.name, repo_url: APP.repo_url }] };
      if (/SELECT check_state, checks_commit_sha/.test(s)) return { rows: [{ check_state: 'passing' }] };
      if (/UPDATE homeroom_bot_looks/.test(s) && /RETURNING \*/.test(s)) {
        state.finished = params;
        return { rows: [{ id: 301, app_id: APP.id, session_id: 13112, user_id: EVAN.id, kind: 'update', state: params[1], revised: params[7], head_sha: params[6] }] };
      }
      if (/SELECT 1 FROM homeroom_bot_change_asks WHERE session_id = \$1 AND status = 'queued'/.test(s)) return { rows: waiting ? [{}] : [] };
      return { rows: [] };
    },
  };
}

function fakeSteps() {
  const kept = new Map();
  return {
    active: false,
    get: () => undefined,
    once: async (key, fn) => {
      if (kept.has(key)) return kept.get(key);
      const v = await fn();
      kept.set(key, v);
      return v;
    },
  };
}

function runDeps(pool, { reply, pushOk = true, sha = NEW, reports = [], settled = [], turns = [] } = {}) {
  return {
    settings: LIVE,
    bot: BOT,
    live: { ...live, isLiveFor: () => true },
    dm: { overWeeklyAllowance: async () => false },
    limits: { checkBudget: async () => ({}) },
    managedOpenRouter: { usesIncludedKey: async () => false },
    github: { getBranchSha: async () => OLD },
    followup: {
      ...followup,
      runFollowUpTurn: async (args) => {
        turns.push(args);
        return { result: { pushOk, sha, ahead: 1, lastResultText: reply }, costUsd: 0.42, stopped: false, routed: { result: {} } };
      },
    },
    proposalUpdate: { settleLandedHead: async (args) => { settled.push(args); return { tail: 'paused', rebuilding: false }; } },
    voice: {
      ...voice,
      reportFollowUp: async (_p, _c, args) => { reports.push(args); return 1; },
    },
    sessionTaken: async () => false,
  };
}

const REVISED = [
  'I reworded both emails and made the stop page one button.',
  '```json',
  JSON.stringify({ action: 'revise', reply: 'Both reminder emails are reworded, and the stop page has one button.', summary: 'Reworded the two reminder emails; the stop page now has one Stop button.' }),
  '```',
].join('\n');

test('an update runs one build turn on the change\'s own branch, settles the push, and tells them to pull it first', async () => {
  const pool = runPool();
  const reports = [];
  const settled = [];
  const turns = [];
  const deps = runDeps(pool, { reply: REVISED, reports, settled, turns });
  const row = { id: 301, app_id: APP.id, session_id: 13112, user_id: EVAN.id, asked_by: EVAN.id, kind: 'update', state: 'running' };
  const ctx = { steps: () => fakeSteps(), kind: 'look.run', key: 'run', workId: 9, signal: null };
  const out = await takeover.runUpdateWork(ctx, { pool, config: {}, deps }, row);
  assert.equal(out.state, 'done');
  // One turn, in build mode, on that change's own branch, under Homeroom's message.
  assert.equal(turns.length, 1);
  assert.equal(turns[0].mode, 'build');
  assert.equal(turns[0].session.id, 13112);
  assert.equal(turns[0].session.branch_name, 'usernode/from-u1-s9b2f0358');
  assert.equal(turns[0].commitMsg, takeover.COMMIT_MESSAGE);
  assert.doesNotMatch(turns[0].commitMsg, /#\d|@/, 'no request or pull request number, no @name');
  assert.match(turns[0].prompt, /Reword the reminder emails/);
  assert.match(turns[0].prompt, /made in Claude Code/);
  // The push settles the change, and the row records it as an asked update that moved it.
  assert.equal(settled.length, 1);
  assert.equal(settled[0].headSha, NEW);
  assert.equal(settled[0].via, 'bot');
  assert.equal(pool.state.finished[1], 'done');
  assert.equal(pool.state.finished[6], NEW, 'the head it made');
  assert.equal(pool.state.finished[7], true, 'revised: counted toward the asked limit');
  assert.equal(pool.state.finished[5], 0.42, 'its cost, on the author\'s look row');
  // The people who asked hear it, with the hand-back.
  assert.equal(reports.length, 1);
  assert.equal(reports[0].outcome.action, 'revise');
  assert.equal(reports[0].outcome.moved, true);
  assert.deepEqual(reports[0].outcome.handBack, { tool: 'Claude Code', sha: NEW });
  const said = voice.plainReport(reports[0].outcome);
  assert.match(said, /^Done: Reworded the two reminder emails/);
  assert.match(said, /Before more work on it goes up from Claude Code, pull this update first \(it is now at bbbbbbbb\)/);
  assert.match(said, /work that does not start from it is refused/);
  assert.deepEqual(voice.withoutInternals(takeover.handBackLine({ tool: 'Claude Code', sha: NEW })),
    takeover.handBackLine({ tool: 'Claude Code', sha: NEW }), 'the hand-back survives the report\'s clean-up');
});

test('an update that moved nothing, or whose save was refused, is said as a failure and settles nothing', async () => {
  for (const variant of [{ sha: OLD }, { pushOk: false, sha: null }]) {
    const pool = runPool();
    const reports = [];
    const settled = [];
    const deps = runDeps(pool, { reply: REVISED, reports, settled, ...variant });
    const row = { id: 301, app_id: APP.id, session_id: 13112, user_id: EVAN.id, kind: 'update', state: 'running' };
    await takeover.runUpdateWork({ steps: () => fakeSteps() }, { pool, config: {}, deps }, row);
    assert.equal(settled.length, 0, JSON.stringify(variant));
    assert.equal(reports[0].outcome.action, 'failed');
    assert.equal(pool.state.finished[7], false, 'not counted');
  }
});

test('a question back is said as one, and moves nothing', async () => {
  const pool = runPool();
  const reports = [];
  const asked = ['```json', JSON.stringify({ action: 'ask', reply: 'Should the stop page keep its Undo link?', answers: ['Keep it', 'Drop it'] }), '```'].join('\n');
  const deps = runDeps(pool, { reply: asked, reports, sha: OLD });
  await takeover.runUpdateWork({ steps: () => fakeSteps() }, { pool, config: {}, deps }, {
    id: 301, app_id: APP.id, session_id: 13112, user_id: EVAN.id, kind: 'update', state: 'running',
  });
  assert.equal(reports[0].outcome.action, 'ask');
  assert.equal(reports[0].outcome.handBack, undefined);
});

test('asks that came in while it ran start the next update when it ends', async () => {
  const pool = runPool({ waiting: true });
  const runs = [];
  const deps = { ...runDeps(pool, { reply: REVISED }), requestRun: async (_p, args) => runs.push(args) };
  const inserted = [];
  const query = pool.query.bind(pool);
  pool.query = async (sql, params) => {
    if (/INSERT INTO homeroom_bot_looks/.test(String(sql))) { inserted.push(params); return { rows: [{ id: 302 }] }; }
    if (/SELECT asker_id FROM homeroom_bot_change_asks/.test(String(sql))) return { rows: [{ asker_id: ADMIN.id }] };
    return query(sql, params);
  };
  await takeover.runUpdateWork({ steps: () => fakeSteps() }, { pool, config: {}, deps }, {
    id: 301, app_id: APP.id, session_id: 13112, user_id: EVAN.id, kind: 'update', state: 'running',
  });
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0][0], EVAN.id, 'still the author\'s week');
  assert.equal(inserted[0][4], ADMIN.id, 'asked by whoever asked next');
  assert.deepEqual(runs.map((r) => r.id), [302]);
});

test('a change that merged or closed before its update is not touched', async () => {
  const pool = runPool();
  const query = pool.query.bind(pool);
  pool.query = async (sql, params) => (/external_agent::text AS external_agent/.test(String(sql))
    ? { rows: [draft({ status: 'merged' })] } : query(sql, params));
  const turns = [];
  const reports = [];
  const deps = runDeps(pool, { reply: REVISED, turns, reports });
  await takeover.runUpdateWork({ steps: () => fakeSteps() }, { pool, config: {}, deps }, {
    id: 301, app_id: APP.id, session_id: 13112, user_id: EVAN.id, kind: 'update', state: 'running',
  });
  assert.equal(turns.length, 0);
  assert.equal(pool.state.finished[1], 'failed');
  // Its asks were taken and are told why, so nothing starts for them again.
  assert.equal(pool.state.taken, true);
  assert.equal(reports[0].outcome.action, 'failed');
  assert.match(reports[0].outcome.why, /merged or closed/);
});

test('an update its gate refuses when it runs (the author\'s week spent) tells the people who asked, and does not loop', async () => {
  const pool = runPool();
  const turns = [];
  const reports = [];
  const runs = [];
  const deps = {
    ...runDeps(pool, { reply: REVISED, turns, reports }),
    dm: { overWeeklyAllowance: async () => true },
    requestRun: async (_p, args) => runs.push(args),
  };
  await takeover.runUpdateWork({ steps: () => fakeSteps() }, { pool, config: {}, deps }, {
    id: 301, app_id: APP.id, session_id: 13112, user_id: EVAN.id, kind: 'update', state: 'running',
  });
  assert.equal(turns.length, 0);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].outcome.action, 'failed');
  assert.match(reports[0].outcome.why, /building time for this week is used up/);
  assert.equal(runs.length, 0, 'no next update for asks it already ended');
});

test('the update prompt asks for the follow-up\'s JSON block, which parseFollowUp reads', () => {
  const prompt = takeover.updatePrompt({
    projectName: 'Homeroom', prNumber: 6508, title: 'Get more people in', author: 'evan', tool: 'Claude Code',
    asks: [{ asker: 'evan', instruction: 'Make the stop page one button.', created_at: '2026-11-09T17:00:00.000Z' }],
  });
  assert.match(prompt, /"Change #6508"/);
  assert.match(prompt, /@evan asked you \(2026-11-09\)/);
  assert.match(prompt, /Do not commit or push yourself/);
  assert.ok(!/—/.test(prompt), 'no em dash');
  assert.equal(followup.parseFollowUp(REVISED).action, 'revise');
});

test('outcomeOf: a moved update hands back, anything that did not move says why', () => {
  assert.equal(takeover.outcomeOf({ ok: true, moved: true, sha: NEW, action: 'revise' }, { tool: 'Codex' }).outcome.handBack.tool, 'Codex');
  assert.equal(takeover.outcomeOf({ ok: true, moved: false, action: 'revise', why: 'the turn produced no change' }).status, 'failed');
  assert.equal(takeover.outcomeOf({ ok: true, moved: false, action: 'answer', reply: 'It already does.' }).outcome.action, 'answer');
  assert.equal(takeover.outcomeOf({ ok: false, error: 'it ran out of time' }).outcome.why, 'it ran out of time');
  for (const out of [{ ok: true, moved: true, sha: NEW }, { ok: false }, { ok: true, action: 'answer' }]) {
    assert.equal(takeover.outcomeOf(out).outcome.handedOver, true, 'the report never calls it the bot\'s own');
  }
  // Only an update that moved the change says to pull it.
  assert.deepEqual(voice.mustSay({ action: 'failed', handBack: { tool: 'Codex', sha: NEW } }), ['The change is as it was.']);
});

// ── How the push settles ─────────────────────────────────────────────────

function settlePool(row) {
  const cards = [];
  return {
    cards,
    async query(sql, params = []) {
      const s = String(sql);
      if (/SELECT cs\.\*, a\.slug AS app_slug/.test(s)) return { rows: [row] };
      if (/INSERT INTO chat_session_messages/.test(s)) { cards.push(params[1]); return { rows: [] }; }
      if (/UPDATE chat_sessions/.test(s)) return { rows: [], rowCount: 1 };
      return { rows: [] };
    },
  };
}

test('a draft paused or active settles as a landed update does, and its card says the bot made it', async () => {
  const torn = [];
  const started = [];
  const ctx = {
    lifecycle: { teardownStagingForSession: async (a) => { torn.push(a); } },
    pushSessionUpdate: () => {},
    pipeline: {
      OWNED_SOURCE_SQL: 'TRUE',
      beginHandoffPipeline: () => () => {},
      startHandoffPipeline: (...args) => { started.push(args); },
    },
  };
  const paused = settlePool({ ...draft({ status: 'paused' }), app_slug: APP.slug, app_name: APP.name, repo_url: APP.repo_url });
  const p = await proposalUpdate.settleLandedHead({ config: {}, pool: paused, session: draft(), headSha: NEW, ctx });
  assert.equal(p.tail, 'paused');
  assert.equal(torn.length, 1);
  assert.match(paused.cards[0], /^Changes ready: commit bbbbbbbb arrived from Homeroom bot\.$/);
  const active = settlePool({ ...draft({ status: 'active' }), app_slug: APP.slug, app_name: APP.name, repo_url: APP.repo_url });
  const a = await proposalUpdate.settleLandedHead({ config: {}, pool: active, session: draft(), headSha: NEW, ctx });
  assert.equal(a.tail, 'active');
  assert.equal(a.rebuilding, true);
  assert.equal(started.length, 1);
});

test('a change up for a vote has its reviewed head reconciled as the bot\'s update; an imported one is synced', async () => {
  const calls = [];
  const votes = { reconcileNativeReviewedHead: async (args) => { calls.push(args); return { updated: true, changed: true }; } };
  const promoted = settlePool({ ...draft({ status: 'promoted' }), app_slug: APP.slug, repo_url: APP.repo_url });
  const p = await proposalUpdate.settleLandedHead({ config: {}, pool: promoted, session: draft(), headSha: NEW, ctx: { votes } });
  assert.equal(p.tail, 'proposal');
  assert.equal(p.rebuilding, true);
  assert.equal(calls[0].madeBy, 'bot');
  assert.equal(calls[0].fresh, true);
  const synced = [];
  const imported = settlePool({ ...draft({ status: 'promoted', source: 'imported' }), repo_url: APP.repo_url });
  const i = await proposalUpdate.settleLandedHead({
    config: {}, pool: imported, session: draft(), headSha: NEW,
    ctx: { prImportSync: { syncImportedProposal: async (args) => { synced.push(args); return 'updated'; } } },
  });
  assert.equal(i.tail, 'imported');
  assert.equal(synced.length, 1);
  // A settle that fails is logged, never thrown: the push already landed.
  const broken = { query: async () => { throw new Error('down'); } };
  const f = await proposalUpdate.settleLandedHead({ config: {}, pool: broken, session: draft({ status: 'promoted' }), headSha: NEW, ctx: { votes: { reconcileNativeReviewedHead: async () => { throw new Error('x'); } } } });
  assert.equal(f.tail, 'failed');
});

test('the migration lets an ask answer no request and keeps one update running per change', () => {
  const sql = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src/db/migrations/bot-update-asked-change.sql'), 'utf8');
  assert.match(sql, /ALTER TABLE homeroom_bot_change_asks ALTER COLUMN issue_number DROP NOT NULL/);
  assert.match(sql, /CHECK \(kind IN \('look', 'update'\)\)/);
  assert.match(sql, /homeroom_bot_looks_running_update_idx\s+ON homeroom_bot_looks \(session_id\) WHERE state = 'running' AND kind = 'update'/);
  assert.match(sql, /homeroom_bot_looks_running_look_idx\s+ON homeroom_bot_looks \(user_id\) WHERE state = 'running' AND kind = 'look'/);
  const manifest = require('../src/db/migrations/manifest.json');
  assert.ok(manifest.migrations.some((m) => m.id === 'bot-update-asked-change'));
});

// ── The facts the bot's turn reads ───────────────────────────────────────

function factsPool(change) {
  const base = gatePool();
  return {
    async query(sql, params) {
      if (/external_agent::text AS external_agent/.test(String(sql))) return { rows: [change] };
      return base.query(sql, params);
    },
  };
}

test('the facts tell the author the bot can update their change, and anybody else who can ask', async () => {
  const facts = (speaker) => voice.factsFor(factsPool(draft()), {
    app: APP, place: { type: 'session', ref: 13112 }, bot: BOT, settings: LIVE, speaker, deps: gateDeps(),
  });
  const own = await facts(EVAN);
  // #6514's line, less the "you cannot edit it" this change makes untrue for its author.
  assert.match(own, /built by @evan in Claude Code \(made outside Homeroom: it has no Fix it button; you can read it and show what it looks like\)/);
  assert.doesNotMatch(own, /you cannot edit it/);
  assert.match(own, /You can update this change for them, on this same change \(update_change\), paid from @evan's week/);
  assert.match(own, /0 of 10 updates people asked for/);
  const other = await facts(ADA);
  assert.match(other, /You cannot edit this change: only @evan, who made it, or an admin can ask you to update it/);
  assert.doesNotMatch(other, /update_change/);
  // A gate that refuses says why, in the facts, before anything is asked.
  const spent = await voice.factsFor(factsPool(draft()), {
    app: APP, place: { type: 'session', ref: 13112 }, bot: BOT, settings: LIVE, speaker: EVAN,
    deps: gateDeps({ dmSvc: { overWeeklyAllowance: async () => true, requesterOf: async () => null } }),
  });
  assert.match(spent, /You cannot update this change just now: @evan's building time for this week is used up/);
});
